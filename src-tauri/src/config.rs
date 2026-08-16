//! Config as a file you can edit by hand.
//!
//! `~/.config/marlin/marlin.toml`. The app writes it and reads it, but it is a
//! plain text file first: a settings panel that is the only way to change
//! something is a settings panel you have to open.

use std::path::PathBuf;

use anyhow::Result;

pub fn dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    PathBuf::from(home).join(".config").join("marlin")
}

pub fn path() -> PathBuf {
    dir().join("marlin.toml")
}

pub fn load() -> String {
    std::fs::read_to_string(path()).unwrap_or_default()
}

pub fn save(toml: &str) -> Result<()> {
    std::fs::create_dir_all(dir())?;
    std::fs::write(path(), toml)?;
    Ok(())
}

/// The layout you left behind, beside the config but deliberately not in it.
///
/// `marlin.toml` is a file you choose to write and would put in a dotfiles
/// repository. This one is written for you, several times a session, and
/// describes one machine's window. Mixing the two would mean a settings file
/// that changes under you every time you split a pane.
pub fn session_path() -> PathBuf {
    dir().join("session.json")
}

pub fn session_load() -> String {
    std::fs::read_to_string(session_path()).unwrap_or_default()
}

/// Written through a temporary file and renamed, because this is saved on a
/// timer: a crash mid-write must not be able to leave a half-parsed layout that
/// the next launch chokes on.
pub fn session_save(json: &str) -> Result<()> {
    std::fs::create_dir_all(dir())?;
    let tmp = session_path().with_extension("json.tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, session_path())?;
    Ok(())
}
