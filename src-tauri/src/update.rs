//! The update check, and the install behind it.
//!
//! **Unsigned, and still installable.** Marlin has no Apple Developer ID, but
//! Gatekeeper's first-launch block is triggered by the `com.apple.quarantine`
//! attribute, and that attribute is written by whichever app *downloads* the
//! file. A browser sets it; Marlin fetching its own disk image over TLS does
//! not. So a bundle replaced from in here launches exactly the way the running
//! one did. Signing would add provenance, which is worth having, but it is not
//! what stands between this code and a working update.
//!
//! What the install is trusting, then, is TLS to the feed host and to the
//! release host, and nothing else. There is no signature to verify. That is a
//! real limit and it is why [`install`] refuses any URL that is not HTTPS.
//!
//! **What leaves the machine:** one GET to a static JSON file, at most once a
//! day, carrying no identifiers, no version query string and no user agent
//! beyond the crate name, plus the disk image itself if you ask for it. These
//! are the only outbound requests Marlin ever makes.

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

const FEED: &str = "https://marlin.gazar.dev/version.json";

#[derive(Deserialize)]
struct Feed {
    version: String,
    notes: Option<String>,
    url: Option<String>,
    published: Option<String>,
    dmg: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub newer: bool,
    pub notes: String,
    pub url: String,
    pub published: String,
    /// The disk image to install. Empty when the release only published a page,
    /// which is the difference between a button that updates and a link.
    pub dmg: String,
}

/// Compare as numbers, not as strings: "0.10.0" is newer than "0.9.0" and a
/// lexical comparison says the opposite.
fn parse(v: &str) -> Vec<u32> {
    v.trim()
        .trim_start_matches('v')
        .split('-')
        .next()
        .unwrap_or("")
        .split('.')
        .map(|p| p.parse::<u32>().unwrap_or(0))
        .collect()
}

fn newer_than(a: &str, b: &str) -> bool {
    let (x, y) = (parse(a), parse(b));
    for i in 0..x.len().max(y.len()) {
        let (l, r) = (*x.get(i).unwrap_or(&0), *y.get(i).unwrap_or(&0));
        if l != r {
            return l > r;
        }
    }
    false
}

pub fn check() -> Result<UpdateInfo> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    // A global timeout, so a hung network cannot leave a background check
    // sitting on a socket for the life of the app.
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_secs(8)))
        .build()
        .new_agent();

    let body = agent
        .get(FEED)
        .call()
        .map_err(|e| anyhow!("could not reach the update feed: {e}"))?
        .body_mut()
        .read_to_string()?;
    let feed: Feed = serde_json::from_str(&body)?;

    Ok(UpdateInfo {
        newer: newer_than(&feed.version, &current),
        latest: feed.version,
        notes: feed.notes.unwrap_or_default(),
        url: feed
            .url
            .unwrap_or_else(|| "https://github.com/ehsangazar/marlin/releases".into()),
        published: feed.published.unwrap_or_default(),
        dmg: feed.dmg.unwrap_or_default(),
        current,
    })
}

fn run(bin: &str, args: &[&str]) -> Result<()> {
    let out = Command::new(bin).args(args).output()?;
    if !out.status.success() {
        bail!("{bin} failed: {}", String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

/// The bundle we are running from. A development build has no `.app` around
/// it, and silently doing nothing there would look exactly like a broken
/// update, so it says which case it is.
fn bundle() -> Result<PathBuf> {
    let exe = std::env::current_exe()?;
    exe.ancestors()
        .find(|p| p.extension().is_some_and(|e| e == "app"))
        .map(Path::to_path_buf)
        .ok_or_else(|| anyhow!("this is a development build, so there is no app bundle to replace"))
}

/// Download the disk image, mount it, and swap the new bundle in beside the old
/// one.
///
/// The swap is two renames inside a single directory, which on APFS is atomic
/// per rename and cannot cross a volume boundary halfway through. The old
/// bundle is kept until the new one is in place, so a failure at the last step
/// puts back what was working rather than leaving no Marlin at all. Returns the
/// installed path, ready to relaunch.
pub fn install(url: &str) -> Result<PathBuf> {
    if !url.starts_with("https://") {
        bail!("refusing to install over anything but https");
    }
    let target = bundle()?;
    let parent = target
        .parent()
        .ok_or_else(|| anyhow!("the app bundle has no parent directory"))?;
    let name = target
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| anyhow!("the app bundle has no name"))?;

    let tmp = std::env::temp_dir().join(format!("marlin-update-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp)?;
    let dmg = tmp.join("marlin.dmg");
    let mnt = tmp.join("mnt");
    std::fs::create_dir_all(&mnt)?;

    // Longer than the check's eight seconds: this is tens of megabytes, and a
    // timeout that fires mid-download is a failure the network did not have.
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_secs(600)))
        .build()
        .new_agent();
    let mut resp = agent
        .get(url)
        .call()
        .map_err(|e| anyhow!("could not download the update: {e}"))?;
    let mut file = std::fs::File::create(&dmg)?;
    std::io::copy(&mut resp.body_mut().as_reader(), &mut file)?;
    drop(file);

    run(
        "/usr/bin/hdiutil",
        &[
            "attach",
            &dmg.to_string_lossy(),
            "-nobrowse",
            "-readonly",
            "-mountpoint",
            &mnt.to_string_lossy(),
        ],
    )
    .context("the downloaded file did not mount as a disk image")?;

    let staged = parent.join(format!("{name}.new"));
    let installed = (|| -> Result<PathBuf> {
        let src = std::fs::read_dir(&mnt)?
            .filter_map(Result::ok)
            .map(|e| e.path())
            .find(|p| p.extension().is_some_and(|e| e == "app"))
            .ok_or_else(|| anyhow!("the disk image holds no application"))?;

        // ditto, not a recursive copy by hand: it is the only thing that keeps
        // symlinks, resource forks and the code signature intact, and a bundle
        // that loses its signature will not launch on Apple Silicon at all.
        let _ = std::fs::remove_dir_all(&staged);
        run("/usr/bin/ditto", &[&src.to_string_lossy(), &staged.to_string_lossy()])
            .context("could not write next to the installed app: is it in a folder you own?")?;
        Ok(staged.clone())
    })();
    let _ = run("/usr/bin/hdiutil", &["detach", &mnt.to_string_lossy(), "-quiet"]);
    installed?;

    let old = parent.join(format!("{name}.old"));
    let _ = std::fs::remove_dir_all(&old);
    std::fs::rename(&target, &old)
        .context("could not move the installed app aside: is it in a folder you own?")?;
    if let Err(e) = std::fs::rename(&staged, &target) {
        let _ = std::fs::rename(&old, &target);
        return Err(anyhow!("could not put the new app in place: {e}"));
    }
    let _ = std::fs::remove_dir_all(&old);
    let _ = std::fs::remove_dir_all(&tmp);
    Ok(target)
}

/// Relaunch through `open`, from a process that outlives this one. Handing the
/// job to the shell is what makes it survive our own exit: a child we spawn and
/// then immediately die on top of would be racing the app it is trying to
/// start.
pub fn relaunch(app: &Path) -> Result<()> {
    Command::new("/bin/sh")
        .arg("-c")
        .arg(format!("sleep 1; /usr/bin/open {}", shell_quote(&app.to_string_lossy())))
        .spawn()?;
    Ok(())
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

#[cfg(test)]
mod tests {
    use super::newer_than;

    #[test]
    fn compares_numerically_not_lexically() {
        assert!(newer_than("0.10.0", "0.9.0"));
        assert!(newer_than("1.0.0", "0.99.9"));
        assert!(!newer_than("0.1.0", "0.1.0"));
        assert!(!newer_than("0.1.0", "0.2.0"));
        assert!(newer_than("v0.2.0", "0.1.9"));
    }
}
