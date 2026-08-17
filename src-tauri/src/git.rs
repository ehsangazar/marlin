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
pub struct Branch {
    pub name: String,
    pub current: bool,
    /// A remote-tracking ref such as `origin/main`, which is read-only until it
    /// is checked out as a local branch.
    pub remote: bool,
    /// Empty when the branch tracks nothing.
    pub upstream: String,
    pub ahead: u32,
    pub behind: u32,
    pub subject: String,
    /// Relative, as git prints it: "3 days ago".
    pub when: String,
}

/// Every branch, local and remote-tracking, in two `for-each-ref` calls rather
/// than one call per branch.
///
/// Remote refs are listed but marked, because checking one out is a different
/// operation with a different result: it creates a local branch that tracks it.
/// The caller shows them apart and calls `checkout_remote` for them, so nothing
/// detaches HEAD or invents a branch as a side effect of a click.
pub fn branches(cwd: &str) -> Result<Vec<Branch>> {
    // Unit separator between fields and record separator between refs: a commit
    // subject can hold anything, tabs and pipes included, so the delimiter has
    // to be something a human cannot type by accident.
    let fmt = "%(refname:short)\x1f%(HEAD)\x1f%(upstream:short)\x1f%(upstream:track)\x1f%(committerdate:relative)\x1f%(subject)\x1e";
    let out = git(
        cwd,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            &format!("--format={fmt}"),
            "refs/heads",
        ],
    )?;

    let mut list = parse_refs(&out, false);

    // Remote-tracking refs, same call against a different namespace. A failure
    // here is not a failure of the list: a repository with no remote is normal.
    if let Ok(out) = git(
        cwd,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            &format!("--format={fmt}"),
            "refs/remotes",
        ],
    ) {
        list.extend(parse_refs(&out, true));
    }
    Ok(list)
}

/// Check out a remote branch by making a local one that tracks it.
///
/// `--track` names the local branch after the ref without its remote, so
/// `origin/feature/x` becomes `feature/x` tracking `origin/feature/x`, which is
/// what every other git front end does and what the next `git push` expects. If
/// a local branch of that name already exists git refuses, and that refusal is
/// the right answer: switching to the existing one is a different intent.
pub fn checkout_remote(cwd: &str, rev: &str) -> Result<()> {
    git(cwd, &["checkout", "--track", rev]).map(|_| ())
}

/// Refresh the remote-tracking refs, and drop the ones whose branches are gone.
///
/// Prompting is turned off rather than left to chance: a fetch that decides to
/// ask for a password or an SSH passphrase has nowhere to ask, and would sit
/// there holding the thread open until the app is killed. Failing with git's
/// own message is the recoverable version of that.
pub fn fetch(cwd: &str) -> Result<()> {
    let out = Command::new("git")
        .current_dir(cwd)
        .args(["fetch", "--all", "--prune"])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes")
        .output()?;
    if !out.status.success() {
        return Err(anyhow!(String::from_utf8_lossy(&out.stderr).to_string()));
    }
    Ok(())
}

/// The records `branches` asks `for-each-ref` for, split back apart.
///
/// Separate from the call that produces them so it can be tested against real
/// git output with no repository to run in. Every bug this has had was here.
fn parse_refs(out: &str, remote: bool) -> Vec<Branch> {
    let mut list = Vec::new();
    for rec in out.split('\x1e') {
        let rec = rec.trim_matches(['\n', '\r']);
        if rec.is_empty() {
            continue;
        }
        let f: Vec<&str> = rec.split('\x1f').collect();
        if f.len() < 6 {
            continue;
        }
        // `refs/remotes/origin/HEAD` is a symbolic ref to whichever branch the
        // remote calls default: the same branch under a second name, and
        // checking it out detaches HEAD. Its short name is the bare remote,
        // `origin`, not `origin/HEAD`, so the test is for a name with no branch
        // part in it.
        if remote && (!f[0].contains('/') || f[0].ends_with("/HEAD")) {
            continue;
        }
        let (ahead, behind) = if remote { (0, 0) } else { track(f[3]) };
        list.push(Branch {
            name: f[0].to_string(),
            current: !remote && f[1].trim() == "*",
            remote,
            upstream: if remote { String::new() } else { f[2].to_string() },
            ahead,
            behind,
            subject: f[5].to_string(),
            when: f[4].to_string(),
        });
    }
    list
}

/// `[ahead 2, behind 1]`, which is also `[gone]` and also empty.
fn track(s: &str) -> (u32, u32) {
    let num = |key: &str| -> u32 {
        s.find(key)
            .map(|i| {
                s[i + key.len()..]
                    .chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect::<String>()
                    .parse()
                    .unwrap_or(0)
            })
            .unwrap_or(0)
    };
    (num("ahead "), num("behind "))
}

pub fn checkout(cwd: &str, branch: &str) -> Result<()> {
    git(cwd, &["checkout", branch]).map(|_| ())
}

pub fn create_branch(cwd: &str, name: &str) -> Result<()> {
    git(cwd, &["checkout", "-b", name]).map(|_| ())
}

/// `-d` refuses to drop work that is not merged anywhere, which is the whole
/// point of it. `force` is `-D`, and is only ever reached by someone reading
/// that refusal and answering it.
pub fn delete_branch(cwd: &str, branch: &str, force: bool) -> Result<()> {
    git(cwd, &["branch", if force { "-D" } else { "-d" }, branch]).map(|_| ())
}

/// What this branch has that HEAD does not.
///
/// Three dots, so the comparison is against the point the two branches last
/// agreed rather than against the tip of HEAD. Two dots would report every
/// commit made on the current branch since the split as a deletion on the other
/// one, which is a diff nobody asked about.
pub fn branch_files(cwd: &str, rev: &str) -> Result<Vec<GitFile>> {
    let out = git(
        cwd,
        &["diff", "--name-status", "--no-color", &format!("HEAD...{rev}")],
    )?;
    Ok(parse_name_status(&out))
}

/// `M\tpath`, and `R100\told\tnew` for a rename, where the last field is the
/// path that exists on the other side.
fn parse_name_status(out: &str) -> Vec<GitFile> {
    let mut files = Vec::new();
    for line in out.lines() {
        let mut parts = line.split('\t');
        let Some(status) = parts.next() else { continue };
        let Some(path) = parts.next_back() else { continue };
        if path.is_empty() || status.is_empty() {
            continue;
        }
        files.push(GitFile {
            name: base(path),
            path: path.to_string(),
            status: status.chars().next().unwrap_or('M').to_string(),
        });
    }
    files
}

pub fn rev_diff(cwd: &str, rev: &str, path: &str) -> Result<String> {
    git(
        cwd,
        &["diff", "--no-color", &format!("HEAD...{rev}"), "--", path],
    )
}

#[derive(Serialize, Clone, Debug)]
pub struct Head {
    pub path: String,
    pub branch: String,
}

/// The branch of each of these directories, for the ones that are repositories.
///
/// This reads `.git/HEAD` rather than running git, because it is called with
/// every directory in a listing and N subprocesses per keystroke of navigation
/// is exactly the cost this file exists to avoid. A detached HEAD holds a raw
/// sha and is reported as "detached": it is still a repository, and leaving it
/// out would hide a folder's changes in the one state where you most want to
/// know about them.
pub fn heads(paths: Vec<String>) -> Vec<Head> {
    let mut out = Vec::new();
    for p in paths {
        let dot = Path::new(&p).join(".git");
        // A worktree or a submodule has a `.git` file pointing at the real one.
        let git_dir = if dot.is_file() {
            match std::fs::read_to_string(&dot) {
                Ok(s) => match s.trim().strip_prefix("gitdir:") {
                    Some(rel) => {
                        let rel = rel.trim();
                        let rp = Path::new(rel);
                        if rp.is_absolute() {
                            rp.to_path_buf()
                        } else {
                            Path::new(&p).join(rp)
                        }
                    }
                    None => continue,
                },
                Err(_) => continue,
            }
        } else if dot.is_dir() {
            dot
        } else {
            continue;
        };

        let Ok(head) = std::fs::read_to_string(git_dir.join("HEAD")) else {
            continue;
        };
        let head = head.trim();
        out.push(Head {
            branch: head
                .strip_prefix("ref: refs/heads/")
                .unwrap_or("detached")
                .to_string(),
            path: p,
        });
    }
    out
}

#[derive(Serialize, Clone, Debug)]
pub struct Counts {
    pub path: String,
    pub changes: u32,
    pub conflicts: u32,
}

/// How dirty each of these repositories is, in parallel.
///
/// This one is a real `git status` per path, so it is asked for a listing's
/// repositories once and then cached by the caller until an explicit refresh.
/// The threads are the difference between nine repositories costing one round
/// trip and costing nine.
pub fn counts(paths: Vec<String>) -> Vec<Counts> {
    std::thread::scope(|s| {
        let handles: Vec<_> = paths
            .iter()
            .map(|path| {
                s.spawn(move || {
                    let st = status(path).unwrap_or_default();
                    Counts {
                        path: path.clone(),
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
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One `for-each-ref` record, built the way the format string asks for it.
    fn rec(fields: &[&str]) -> String {
        format!("{}\x1e", fields.join("\x1f"))
    }

    #[test]
    fn track_reads_ahead_and_behind() {
        assert_eq!(track("[ahead 2, behind 1]"), (2, 1));
        assert_eq!(track("[ahead 12]"), (12, 0));
        assert_eq!(track("[behind 3]"), (0, 3));
        // A branch whose upstream was deleted, and one with no upstream at all.
        assert_eq!(track("[gone]"), (0, 0));
        assert_eq!(track(""), (0, 0));
    }

    #[test]
    fn local_refs_carry_head_and_upstream() {
        let out = rec(&["main", "*", "origin/main", "[ahead 2]", "3 hours ago", "Fix it"])
            + &rec(&["wip", " ", "", "", "2 days ago", "Half a thing"]);
        let got = parse_refs(&out, false);

        assert_eq!(got.len(), 2);
        assert_eq!(got[0].name, "main");
        assert!(got[0].current);
        assert!(!got[0].remote);
        assert_eq!(got[0].upstream, "origin/main");
        assert_eq!((got[0].ahead, got[0].behind), (2, 0));
        assert_eq!(got[0].subject, "Fix it");
        assert!(!got[1].current);
    }

    /// The bug this file has actually had: `refs/remotes/origin/HEAD` shortens
    /// to the bare remote name, so a filter for a name ending in `/HEAD` lets it
    /// through and offers a row that detaches HEAD when clicked.
    #[test]
    fn remote_refs_drop_the_symbolic_head() {
        let out = rec(&["origin", " ", "", "", "2 hours ago", "Fix it"])
            + &rec(&["origin/main", " ", "", "", "2 hours ago", "Fix it"])
            + &rec(&["upstream/HEAD", " ", "", "", "2 hours ago", "Fix it"]);
        let got = parse_refs(&out, true);

        assert_eq!(got.iter().map(|b| b.name.as_str()).collect::<Vec<_>>(), ["origin/main"]);
        assert!(got[0].remote);
        // A remote-tracking ref is never the branch you are standing on.
        assert!(!got[0].current);
    }

    #[test]
    fn ref_records_survive_odd_subjects() {
        // A commit subject can hold pipes, tabs and quotes. Only the unit
        // separator is off limits, which is why it is the separator.
        let out = rec(&["odd", " ", "", "", "now", "feat|thing\ttab \"quoted\""]);
        let got = parse_refs(&out, false);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].subject, "feat|thing\ttab \"quoted\"");
    }

    #[test]
    fn name_status_takes_the_surviving_path() {
        let out = "M\tsrc/main.ts\nA\tsrc/new.ts\nD\tsrc/old.ts\nR100\tsrc/was.ts\tsrc/now.ts\n";
        let got = parse_name_status(out);

        assert_eq!(got.len(), 4);
        assert_eq!(got[0].status, "M");
        assert_eq!(got[0].name, "main.ts");
        assert_eq!(got[3].status, "R");
        assert_eq!(got[3].path, "src/now.ts");
    }

    #[test]
    fn name_status_ignores_junk() {
        assert!(parse_name_status("").is_empty());
        assert!(parse_name_status("\n\n").is_empty());
    }

    #[test]
    fn heads_reads_the_branch_without_running_git() {
        let root = std::env::temp_dir().join(format!("marlin-heads-{}", std::process::id()));
        let plain = root.join("plain");
        let detached = root.join("detached");
        let linked = root.join("linked");
        let real = root.join("real-git-dir");
        let not_a_repo = root.join("ordinary");

        std::fs::create_dir_all(plain.join(".git")).unwrap();
        std::fs::write(plain.join(".git/HEAD"), "ref: refs/heads/feature/x\n").unwrap();

        std::fs::create_dir_all(detached.join(".git")).unwrap();
        std::fs::write(detached.join(".git/HEAD"), "9c7b2a1f0e\n").unwrap();

        // A worktree or submodule: `.git` is a file pointing at the real one.
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("HEAD"), "ref: refs/heads/linked-branch\n").unwrap();
        std::fs::create_dir_all(&linked).unwrap();
        std::fs::write(
            linked.join(".git"),
            format!("gitdir: {}\n", real.to_string_lossy()),
        )
        .unwrap();

        std::fs::create_dir_all(&not_a_repo).unwrap();

        let paths: Vec<String> = [&plain, &detached, &linked, &not_a_repo]
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect();
        let got = heads(paths);

        let branch = |p: &std::path::Path| {
            got.iter()
                .find(|h| h.path == p.to_string_lossy())
                .map(|h| h.branch.clone())
        };
        assert_eq!(branch(&plain).as_deref(), Some("feature/x"));
        assert_eq!(branch(&detached).as_deref(), Some("detached"));
        assert_eq!(branch(&linked).as_deref(), Some("linked-branch"));
        // A folder that is not a repository is not in the answer at all.
        assert_eq!(branch(&not_a_repo), None);

        let _ = std::fs::remove_dir_all(&root);
    }
}
