// Generate site/version.json from package.json and the changelog, so the feed
// cannot drift from the release it claims to describe.
//
// The feed carries one entry per platform, not one disk image. It used to carry
// a single `dmg` pointing at an aarch64 build, which meant an Intel Mac was
// offered an Apple Silicon app and a Windows machine was offered a disk image.
// `downloads` is keyed the way update.rs keys it: `<os>-<arch>`.
import { readFileSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const log = readFileSync("CHANGELOG.md", "utf8");

const m = new RegExp(`## \\[${pkg.version.replace(/\\./g, "\\\\.")}\\][^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)`).exec(log);
// Rejoin wrapped bullets before taking them. Keeping only the first physical
// line of each cut every entry off mid-sentence, and the settings panel now
// shows the first note to your face.
const bullets = [];
for (const raw of (m?.[1] ?? "").split("\n")) {
  const line = raw.trim();
  if (line.startsWith("- ")) bullets.push(line.slice(2));
  else if (line && bullets.length && !line.startsWith("#")) {
    bullets[bullets.length - 1] += ` ${line}`;
  }
}
const notes = bullets
  .slice(0, 6)
  .map((b) => b.replace(/\*\*/g, ""))
  .join("\n");

const v = pkg.version;
const rel = `https://github.com/ehsangazar/marlin/releases/download/v${v}`;

// The names Tauri gives the bundles. scripts/publish.sh checks every one of
// these against the actual release before the feed goes up, because a name
// invented here and never verified is how the update button starts downloading
// a 404.
const macos = `${rel}/Marlin_${v}_universal.dmg`;
const downloads = {
  "macos-aarch64": macos,
  "macos-x86_64": macos,
  "windows-x86_64": `${rel}/Marlin_${v}_x64-setup.exe`,
  // The AppImage, not the .deb, even though the release ships both. This map
  // holds one artefact per `platform_key()` and the AppImage is the one that
  // runs without a package manager and without root, so it is the one to hand
  // a stranger. Anybody who wants the .deb is on the release page already.
  //
  // What a Linux copy does with this, stated plainly because it is less than it
  // looks: nothing yet. update.rs::installable() returns empty on anything that
  // is not macOS before it ever reads `downloads`, since the in-place swap is
  // hdiutil and ditto moving an .app and has no counterpart here. So a Linux
  // build sees "a new version exists" and gets the release page, exactly as
  // Windows does. The entry is here so the feed is an honest manifest of what
  // the release contains, and so it is already right on the day an in-place
  // Linux install exists.
  //
  // The real consequence is at the other end: publish.sh checks every URL in
  // this map against the actual release, so from now on a release with no Linux
  // artefact cannot publish a feed at all, for any platform. That is the same
  // rule the workflow's publish job already applies and it is the one we want,
  // but it does mean a red Linux leg now blocks the macOS and Windows feed too.
  "linux-x86_64": `${rel}/Marlin_${v}_amd64.AppImage`,
};

writeFileSync(
  "site/version.json",
  JSON.stringify(
    {
      version: v,
      published: new Date().toISOString().slice(0, 10),
      url: `https://github.com/ehsangazar/marlin/releases/tag/v${v}`,
      // Kept, and kept pointing at macOS, because copies of Marlin already
      // installed read this field and know nothing about `downloads`. Dropping
      // it would silently stop updating every 0.1.x in the wild.
      dmg: macos,
      downloads,
      notes: notes || "See the changelog.",
    },
    null,
    2,
  ) + "\n",
);
console.log("site/version.json ->", v);
for (const [k, u] of Object.entries(downloads)) console.log(`  ${k.padEnd(15)} ${u.split("/").pop()}`);
