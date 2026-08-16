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
