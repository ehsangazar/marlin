//! Local-only diagnostics.
//!
//! **Nothing here is ever transmitted.** The log is a file on this machine, and
//! the only way anything leaves is the user pressing a button that opens a
//! pre-filled GitHub issue they can read and edit first. That keeps the "no
//! telemetry" promise literally true rather than approximately true.
//!
//! **Terminal output is never written here.** Scrollback contains passwords,
//! tokens and private source; a diagnostics file that swallowed it would be a
//! far worse liability than the bugs it helps fix.

use std::io::Write;
use std::path::PathBuf;

use anyhow::Result;
use serde::Serialize;

pub fn dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    PathBuf::from(home).join("Library").join("Logs").join("Marlin")
}

pub fn path() -> PathBuf {
    dir().join("marlin.log")
}

/// Written on start, removed on a clean exit. Finding one at startup means the
/// last run died without saying goodbye.
fn running_marker() -> PathBuf {
    dir().join("running")
}

pub fn init() {
    let _ = std::fs::create_dir_all(dir());

    // A panic anywhere in Rust lands in the log with its location, rather than
    // vanishing into a terminal nobody was watching.
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let loc = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "unknown".into());
        let msg = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "panic".into());
        write("PANIC", &format!("{msg} at {loc}"));
        default(info);
    }));

    let _ = std::fs::write(running_marker(), b"1");
    write("INFO", &format!("started v{}", env!("CARGO_PKG_VERSION")));
}

pub fn mark_clean_exit() {
    write("INFO", "clean exit");
    let _ = std::fs::remove_file(running_marker());
}

pub fn crashed_last_run() -> bool {
    running_marker().exists()
}

pub fn write(level: &str, msg: &str) {
    let _ = std::fs::create_dir_all(dir());
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path()) {
        let _ = writeln!(f, "{stamp} [{level}] {msg}");
    }
    trim();
}

/// Keep the log bounded. An unbounded diagnostics file is its own bug report.
fn trim() {
    let p = path();
    let Ok(meta) = std::fs::metadata(&p) else { return };
    if meta.len() < 256 * 1024 {
        return;
    }
    if let Ok(text) = std::fs::read_to_string(&p) {
        let keep: Vec<&str> = text.lines().rev().take(1000).collect();
        let out: String = keep.into_iter().rev().collect::<Vec<_>>().join("\n");
        let _ = std::fs::write(&p, out);
    }
}

#[derive(Serialize)]
pub struct Diagnostics {
    pub crashed_last_run: bool,
    pub log_path: String,
    pub tail: String,
    pub version: String,
    pub os: String,
}

pub fn diagnostics(lines: usize) -> Result<Diagnostics> {
    let text = std::fs::read_to_string(path()).unwrap_or_default();
    let tail: Vec<&str> = text.lines().rev().take(lines).collect();
    Ok(Diagnostics {
        crashed_last_run: crashed_last_run(),
        log_path: path().to_string_lossy().to_string(),
        tail: tail.into_iter().rev().collect::<Vec<_>>().join("\n"),
        version: env!("CARGO_PKG_VERSION").to_string(),
        os: format!("macOS {}", std::env::consts::ARCH),
    })
}
