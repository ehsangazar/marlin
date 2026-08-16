//! Git, by shelling out to the user's own `git`.
//!
//! Deliberately not libgit2. `.gitignore` precedence, `core.fsmonitor`,
//! worktrees, submodules and the user's own config are all things real git gets
//! exactly right and a reimplementation gets subtly differently. **A source
//! control panel that disagrees with the terminal one inch below it is worse
//! than no panel.**

use std::path::Path;
use std::process::Command;

use anyhow::{anyhow, Result};
use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
pub struct GitFile {
    pub name: String,
    pub path: String,
    /// M, A, D, R or C for conflicted.
    pub status: String,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct GitStatus {
    pub is_repo: bool,
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    pub staged: Vec<GitFile>,
    pub changes: Vec<GitFile>,
    pub conflicts: Vec<GitFile>,
}

fn git(cwd: &str, args: &[&str]) -> Result<String> {
    let out = Command::new("git").current_dir(cwd).args(args).output()?;
    if !out.status.success() {
        return Err(anyhow!(String::from_utf8_lossy(&out.stderr).to_string()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn base(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string())
}

/// One `git status` per call. Debouncing and back-off live on the caller: this
/// is the expensive thing and it must never run on a timer.
pub fn status(cwd: &str) -> Result<GitStatus> {
    let mut st = GitStatus::default();

    if git(cwd, &["rev-parse", "--is-inside-work-tree"]).is_err() {
        return Ok(st);
    }
    st.is_repo = true;

    let raw = git(cwd, &["status", "--porcelain=v2", "--branch", "--untracked-files=normal"])?;

    for line in raw.lines() {
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            st.branch = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            // "+2 -0"
            for tok in rest.split_whitespace() {
                if let Some(v) = tok.strip_prefix('+') {
                    st.ahead = v.parse().unwrap_or(0);
                } else if let Some(v) = tok.strip_prefix('-') {
                    st.behind = v.parse().unwrap_or(0);
                }
            }
        } else if let Some(rest) = line.strip_prefix("u ") {
            // Unmerged. Path is the last field.
            if let Some(p) = rest.split_whitespace().last() {
                st.conflicts.push(GitFile {
                    name: base(p),
                    path: p.to_string(),
                    status: "C".into(),
                });
            }
        } else if let Some(rest) = line.strip_prefix("1 ") {
            // "<XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>"
            let mut it = rest.split_whitespace();
            let xy = it.next().unwrap_or("..");
            let p = rest.split_whitespace().nth(7).unwrap_or("");
            if p.is_empty() {
                continue;
            }
            push_xy(&mut st, xy, p);
        } else if let Some(rest) = line.strip_prefix("2 ") {
            // Renamed or copied: path comes before a tab-separated original.
            let xy = rest.split_whitespace().next().unwrap_or("..");
            let p = rest
                .split_whitespace()
                .nth(8)
                .unwrap_or("")
                .split('\t')
                .next()
                .unwrap_or("");
            if p.is_empty() {
                continue;
            }
            push_xy(&mut st, xy, p);
        } else if let Some(p) = line.strip_prefix("? ") {
            st.changes.push(GitFile {
                name: base(p),
                path: p.to_string(),
                status: "U".into(),
            });
        }
    }

    Ok(st)
}

/// X is the index (staged) status, Y the working tree. A file can be in both
/// lists at once, and showing it twice is correct rather than a bug: those are
/// two different sets of changes.
fn push_xy(st: &mut GitStatus, xy: &str, path: &str) {
    let mut ch = xy.chars();
    let x = ch.next().unwrap_or('.');
    let y = ch.next().unwrap_or('.');

    if x != '.' {
        st.staged.push(GitFile {
            name: base(path),
            path: path.to_string(),
            status: x.to_string(),
        });
    }
    if y != '.' {
        st.changes.push(GitFile {
            name: base(path),
            path: path.to_string(),
            status: y.to_string(),
        });
    }
}

pub fn diff(cwd: &str, path: &str, staged: bool) -> Result<String> {
    let mut args = vec!["diff", "--no-color"];
    if staged {
        args.push("--staged");
    }
    args.push("--");
    args.push(path);
    let out = git(cwd, &args)?;
    if out.trim().is_empty() && !staged {
        // Untracked files have no diff; show the file as all additions.
        return git(cwd, &["diff", "--no-color", "--no-index", "/dev/null", path])
            .or_else(|_| Ok(String::new()));
    }
    Ok(out)
}

pub fn stage(cwd: &str, path: &str) -> Result<()> {
    git(cwd, &["add", "--", path]).map(|_| ())
}

pub fn unstage(cwd: &str, path: &str) -> Result<()> {
    git(cwd, &["restore", "--staged", "--", path]).map(|_| ())
}

pub fn discard(cwd: &str, path: &str) -> Result<()> {
    git(cwd, &["restore", "--", path]).map(|_| ())
}

#[derive(Serialize, Clone, Debug)]
pub struct RepoStatus {
    pub name: String,
    pub path: String,
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    pub changes: u32,
    pub conflicts: u32,
}

/// Status for every repository one level under `root`.
///
/// This is N subprocesses, so it is deliberately **not** on a timer: it runs on
/// a `cd` or an explicit refresh and nothing else. They run in parallel because
/// nine repositories serially is nine round trips of latency for something the
/// eye reads as one list.
pub fn workspace(root: &str) -> Vec<RepoStatus> {
    let mut dirs: Vec<(String, String)> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(root) {
        for e in rd.flatten() {
            if !e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            if e.path().join(".git").exists() {
                dirs.push((
                    e.file_name().to_string_lossy().to_string(),
                    e.path().to_string_lossy().to_string(),
                ));
            }
        }
    }
    dirs.sort();

    let mut out: Vec<RepoStatus> = std::thread::scope(|s| {
        let handles: Vec<_> = dirs
            .iter()
            .map(|(name, path)| {
                s.spawn(move || {
                    let st = status(path).unwrap_or_default();
                    RepoStatus {
                        name: name.clone(),
                        path: path.clone(),
                        branch: st.branch,
                        ahead: st.ahead,
                        behind: st.behind,
                        // A file changed in both the index and the worktree is
                        // one file to a human, so count paths rather than rows.
                        changes: {
                            let mut seen: Vec<&str> = st
                                .staged
                                .iter()
                                .chain(st.changes.iter())
                                .map(|f| f.path.as_str())
                                .collect();
                            seen.sort_unstable();
                            seen.dedup();
                            seen.len() as u32
                        },
                        conflicts: st.conflicts.len() as u32,
                    }
                })
            })
            .collect();
        handles.into_iter().filter_map(|h| h.join().ok()).collect()
    });
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

#[cfg(test)]
mod tests {
    /// Not a unit test of pure logic. The parsing was never the risky part; the
    /// risky part is whether the scan finds real repositories on a real disk,
    /// which is what silently returned nothing.
    ///
    /// So: a real directory and a real `git`, but a temporary one it builds
    /// itself. Pointing the default at `..` made the result depend on how the
    /// person running it happens to arrange their projects folder, which is a
    /// test that passes or fails for reasons that have nothing to do with the
    /// code.
    #[test]
    fn scans_a_directory_of_repositories() {
        let root = std::env::temp_dir().join(format!("marlin-scan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for name in ["alpha", "beta"] {
            let dir = root.join(name);
            std::fs::create_dir_all(&dir).unwrap();
            let ok = std::process::Command::new("git")
                .args(["init", "-q"])
                .current_dir(&dir)
                .status()
                .expect("git must be installed to run this test")
                .success();
            assert!(ok, "could not create a repository to scan");
        }
        // A plain directory alongside them, so "finds repositories" cannot pass
        // by finding everything.
        std::fs::create_dir_all(root.join("just-a-folder")).unwrap();

        let repos = super::workspace(&root.to_string_lossy());
        let _ = std::fs::remove_dir_all(&root);

        let names: Vec<&str> = repos.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, ["alpha", "beta"], "the scan found {names:?}");
    }
}
