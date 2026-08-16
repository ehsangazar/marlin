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
