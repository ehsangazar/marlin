// Generate site/version.json from package.json and the changelog, so the feed
// cannot drift from the release it claims to describe.
import { readFileSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const log = readFileSync("CHANGELOG.md", "utf8");

const m = new RegExp(`## \\[${pkg.version.replace(/\\./g, "\\\\.")}\\][^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)`).exec(log);
const notes = (m?.[1] ?? "")
  .split("\n")
  .filter((l) => l.trim().startsWith("- "))
  .slice(0, 6)
  .map((l) => l.trim().replace(/^- /, "").replace(/\*\*/g, ""))
  .join("\n");

writeFileSync(
  "site/version.json",
  JSON.stringify(
    {
      version: pkg.version,
      published: new Date().toISOString().slice(0, 10),
      url: `https://github.com/ehsangazar/marlin/releases/tag/v${pkg.version}`,
      // The name Tauri gives the bundle, so the in-app updater has something to
      // download rather than a page to send you to. Upload the dmg under
      // exactly this name or the button degrades to a link.
      dmg: `https://github.com/ehsangazar/marlin/releases/download/v${pkg.version}/Marlin_${pkg.version}_aarch64.dmg`,
      notes: notes || "See the changelog.",
    },
    null,
    2,
  ) + "\n",
);
console.log("site/version.json ->", pkg.version);
