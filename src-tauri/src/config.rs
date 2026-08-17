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

/// Where the shell integration would go, and whether it is already there.
///
/// The hooks ship inside the app and are one line in a config file, but that
/// line is the difference between status dots working and silently not working,
/// which is the kind of setup step everyone skips and nobody debugs.
#[derive(serde::Serialize)]
pub struct ShellHook {
    /// "zsh" or "fish". Empty when it is a shell we ship no hook for.
    pub shell: String,
    /// The rc file the line goes in.
    pub rc: String,
    pub installed: bool,
    /// The exact line, so the UI can show what it is about to write.
    pub line: String,
}

fn hook_line(resource_dir: &std::path::Path, shell: &str) -> String {
    let f = resource_dir.join("shell").join(format!("marlin.{shell}"));
    format!("source \"{}\"", f.to_string_lossy())
}

pub fn shell_hook(resource_dir: &std::path::Path) -> ShellHook {
    let home = std::env::var("HOME").unwrap_or_default();
    let shell = std::env::var("SHELL").unwrap_or_default();
    let (name, rc) = if shell.ends_with("fish") {
        ("fish", format!("{home}/.config/fish/config.fish"))
    } else if shell.ends_with("zsh") {
        ("zsh", format!("{home}/.zshrc"))
    } else {
        // bash and everything else: no hook ships for it, so there is nothing
        // to offer and pretending otherwise would write a line that does
        // nothing.
        return ShellHook {
            shell: String::new(),
            rc: String::new(),
            installed: false,
            line: String::new(),
        };
    };

    let existing = std::fs::read_to_string(&rc).unwrap_or_default();
    ShellHook {
        installed: existing.contains(&format!("marlin.{name}")),
        line: hook_line(resource_dir, name),
        shell: name.to_string(),
        rc,
    }
}

/// Append the hook, once, to the shell's own config file.
///
/// Appending rather than rewriting: this is the user's file, it may be
/// generated, ordered or full of things we know nothing about, and the only
/// safe edit to a file like that is one line at the end.
pub fn install_shell_hook(resource_dir: &std::path::Path) -> anyhow::Result<String> {
    use std::io::Write;
    let h = shell_hook(resource_dir);
    if h.shell.is_empty() {
        return Err(anyhow::anyhow!("no hook ships for this shell"));
    }
    if h.installed {
        return Ok(h.rc);
    }
    if let Some(dir) = std::path::Path::new(&h.rc).parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&h.rc)?;
    writeln!(f, "\n# Marlin shell integration: status dots and directory tracking.")?;
    writeln!(f, "{}", h.line)?;
    Ok(h.rc)
}
