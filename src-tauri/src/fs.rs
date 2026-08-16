//! Filesystem, and the project detection that the agent features hang off.

use std::path::PathBuf;

use anyhow::Result;
use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub dir: bool,
}

/// Directories that are never worth walking into and are the reason naive file
/// watchers fall over.
const SKIP: &[&str] = &[
    "node_modules", "target", ".git", ".next", "dist", "build",
    ".venv", "__pycache__", ".turbo", ".cache",
];

pub fn list_dir(path: &str) -> Result<Vec<Entry>> {
    let mut out = Vec::new();
    for e in std::fs::read_dir(path)? {
        let e = e?;
        let name = e.file_name().to_string_lossy().to_string();
        let dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if dir && SKIP.contains(&name.as_str()) && name != ".git" {
            continue;
        }
        // .git is the plumbing and .DS_Store is Finder noise. Neither is a
        // file anyone opened a sidebar to look at.
        if name == ".git" || name == ".DS_Store" {
            continue;
        }
        out.push(Entry {
            name,
            path: e.path().to_string_lossy().to_string(),
            dir,
        });
    }
    // Directories first, then alphabetical. Dotfiles sort with everything else
    // rather than being exiled to the top, because .claude matters here.
    out.sort_by(|a, b| b.dir.cmp(&a.dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct Project {
    /// Repositories found one level down. More than one means this is a
    /// workspace, not a project, and a directory usually is.
    pub repos: Vec<String>,
    pub has_claude: bool,
    pub has_agents: bool,
    pub is_repo: bool,
}

/// One shallow scan per `cd`. Never on a timer, never per frame.
pub fn detect(path: &str) -> Project {
    let root = PathBuf::from(path);
    let mut p = Project {
        is_repo: root.join(".git").exists(),
        has_claude: root.join(".claude").exists() || root.join("CLAUDE.md").exists(),
        has_agents: root.join(".agents").exists() || root.join("AGENTS.md").exists(),
        repos: Vec::new(),
    };

    if let Ok(rd) = std::fs::read_dir(&root) {
        for e in rd.flatten() {
            if !e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            if e.path().join(".git").exists() {
                p.repos.push(e.file_name().to_string_lossy().to_string());
            }
        }
    }
    p.repos.sort();
    p
}

/// Read a file for the preview pane. Capped, because a preview that can be
/// handed a 2GB log is a way to freeze the window.
pub fn read_text(path: &str, max_bytes: usize) -> Result<String> {
    let meta = std::fs::metadata(path)?;
    if meta.len() as usize > max_bytes {
        let bytes = std::fs::read(path)?;
        let cut = &bytes[..max_bytes.min(bytes.len())];
        return Ok(format!(
            "{}\n\n[truncated at {} KB of {} KB]",
            String::from_utf8_lossy(cut),
            max_bytes / 1024,
            meta.len() as usize / 1024
        ));
    }
    Ok(String::from_utf8_lossy(&std::fs::read(path)?).to_string())
}

pub fn home() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/".into())
}

pub fn display_path(path: &str) -> String {
    let h = home();
    match path.strip_prefix(&h) {
        Some(rest) => format!("~{rest}"),
        None => path.to_string(),
    }
}


#[derive(Serialize, Clone, Debug)]
pub struct Hit {
    pub path: String,
    pub name: String,
    pub line: u32,
    pub text: String,
}

/// Walk for go-to-file. Uses the `ignore` crate so `.gitignore` is respected,
/// which is the difference between a useful index and one full of `target/`.
pub fn walk(root: &str, limit: usize) -> Vec<Entry> {
    let mut out = Vec::new();
    for e in ignore::WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .max_depth(Some(12))
        .build()
        .flatten()
    {
        if out.len() >= limit {
            break;
        }
        if !e.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let path = e.path();
        if path.components().any(|c| SKIP.contains(&c.as_os_str().to_string_lossy().as_ref())) {
            continue;
        }
        out.push(Entry {
            name: path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
            path: path.to_string_lossy().to_string(),
            dir: false,
        });
    }
    out
}

/// Search every file's text. A naive scan, because at project scale it is
/// instant. If it ever is not, the answer is to shell out to ripgrep, not to
/// build an index: an index means a watcher, a cache and an invalidation bug.
pub fn grep(root: &str, query: &str, limit: usize) -> Vec<Hit> {
    let mut out = Vec::new();
    if query.is_empty() {
        return out;
    }
    let needle = query.to_lowercase();

    for e in ignore::WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .max_depth(Some(12))
        .build()
        .flatten()
    {
        if out.len() >= limit {
            break;
        }
        if !e.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let path = e.path();
        // Skip anything large enough that reading it would stall the search.
        if std::fs::metadata(path).map(|m| m.len() > 2 * 1024 * 1024).unwrap_or(true) {
            continue;
        }
        let Ok(bytes) = std::fs::read(path) else { continue };
        // Binary files have nothing to match and everything to slow us down.
        if bytes.iter().take(1024).any(|b| *b == 0) {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes);
        for (i, line) in text.lines().enumerate() {
            if out.len() >= limit {
                break;
            }
            if line.to_lowercase().contains(&needle) {
                out.push(Hit {
                    path: path.to_string_lossy().to_string(),
                    name: path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
                    line: i as u32 + 1,
                    text: line.chars().take(200).collect(),
                });
            }
        }
    }
    out
}

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

#[derive(Serialize, Clone, Debug)]
pub struct FileDoc {
    pub content: String,
    /// Cheap fingerprint of what was on disk when we read it. Not a checksum
    /// for integrity, just enough to notice somebody else wrote the file.
    pub stamp: String,
}

fn stamp_of(bytes: &[u8]) -> String {
    let mut h = DefaultHasher::new();
    bytes.hash(&mut h);
    format!("{:x}:{}", h.finish(), bytes.len())
}

pub fn read_doc(path: &str, max_bytes: usize) -> Result<FileDoc> {
    let bytes = std::fs::read(path)?;
    if bytes.len() > max_bytes {
        anyhow::bail!("file is too large to edit safely ({} KB)", bytes.len() / 1024);
    }
    Ok(FileDoc {
        stamp: stamp_of(&bytes),
        content: String::from_utf8_lossy(&bytes).to_string(),
    })
}

/// Write only if the file still looks like what was read.
///
/// Without this, opening a file, leaving it, and saving an hour later silently
/// destroys whatever happened in between. An editor that can lose someone
/// else's work is worse than no editor.
pub fn write_doc(path: &str, content: &str, expect: &str) -> Result<FileDoc> {
    if let Ok(current) = std::fs::read(path) {
        let now = stamp_of(&current);
        if now != expect {
            anyhow::bail!("changed on disk since it was opened, so nothing was written");
        }
    }
    let bytes = content.as_bytes();
    // Write to a sibling then rename: a crash mid-write leaves the original
    // intact rather than a half-file.
    let tmp = format!("{path}.marlin.tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)?;
    Ok(FileDoc {
        stamp: stamp_of(bytes),
        content: content.to_string(),
    })
}

/// Hand a URL to the OS browser.
///
/// Only http and https, and never inside the webview. Terminal output is
/// untrusted, and a UI that can be navigated to an arbitrary page by something
/// it printed is a whole class of problem this app does not need.
pub fn open_url(url: &str) -> Result<()> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        anyhow::bail!("refused: only http and https are opened");
    }
    std::process::Command::new("open").arg(url).spawn()?;
    Ok(())
}
