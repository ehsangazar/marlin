/**
 * File-type icons, drawn rather than imported.
 *
 * A VSCode-style icon pack is 100KB-plus of font or SVG for a sidebar, in a
 * program whose entire argument is weight. These are three shapes tinted by
 * language, which is what Seti-style themes amount to anyway, and they stay
 * sharp at any size because they are vectors.
 */

const NS = "http://www.w3.org/2000/svg";

/** Language colours, close to the ones people already recognise from GitHub. */
const TINT: Record<string, string> = {
  rs: "#DEA584",
  ts: "#3178C6", tsx: "#3178C6", mts: "#3178C6", cts: "#3178C6",
  js: "#F1E05A", jsx: "#F1E05A", mjs: "#F1E05A", cjs: "#F1E05A",
  json: "#CBCB41", jsonc: "#CBCB41",
  md: "#6A9FDB", mdx: "#6A9FDB",
  toml: "#B0794F", ini: "#B0794F", conf: "#B0794F", cfg: "#B0794F",
  yml: "#E37933", yaml: "#E37933",
  css: "#C678DD", scss: "#C678DD", sass: "#C678DD",
  html: "#E34C26", htm: "#E34C26", xml: "#E34C26",
  py: "#4B8BBE",
  go: "#00ADD8",
  sh: "#89E051", zsh: "#89E051", fish: "#89E051", bash: "#89E051",
  rb: "#CC342D",
  java: "#B07219", kt: "#A97BFF",
  c: "#89C7E8", h: "#89C7E8", cpp: "#7BA7D6", hpp: "#7BA7D6",
  php: "#8892BF",
  sql: "#E38C00",
  svg: "#FFB13B", png: "#A074C4", jpg: "#A074C4", jpeg: "#A074C4",
  gif: "#A074C4", webp: "#A074C4", ico: "#A074C4",
  lock: "#6E7A87",
  txt: "#9AA7B4", log: "#9AA7B4",
};

/** Files whose name, not extension, is the identity. */
const BY_NAME: Record<string, string> = {
  "package.json": "#8BC34A",
  "cargo.toml": "#DEA584",
  "cargo.lock": "#6E7A87",
  "dockerfile": "#2496ED",
  "makefile": "#9AA7B4",
  ".gitignore": "#6E7A87",
  "readme.md": "#6A9FDB",
  "license": "#D6A44C",
  "claude.md": "#9E90FF",
  "agents.md": "#9E90FF",
};

const CONFIG_DIRS = new Set([".claude", ".agents", ".github", ".vscode", ".config"]);

function svg(paths: { d: string; fill?: string; opacity?: number }[], color: string): SVGSVGElement {
  const el = document.createElementNS(NS, "svg");
  el.setAttribute("viewBox", "0 0 16 16");
  el.setAttribute("width", "13");
  el.setAttribute("height", "13");
  el.setAttribute("aria-hidden", "true");
  el.style.flex = "0 0 auto";
  for (const p of paths) {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", p.d);
    path.setAttribute("fill", p.fill ?? color);
    if (p.opacity !== undefined) path.setAttribute("fill-opacity", String(p.opacity));
    el.appendChild(path);
  }
  return el;
}

const FOLDER =
  "M1.75 3h3.9c.3 0 .58.14.76.38L7.4 4.6h6.85c.5 0 .9.4.9.9v6.6c0 .5-.4.9-.9.9H1.75a.9.9 0 0 1-.9-.9v-8.2c0-.5.4-.9.9-.9Z";
const FOLDER_OPEN =
  "M1.75 3h3.9c.3 0 .58.14.76.38L7.4 4.6h6.85c.5 0 .9.4.9.9v1H3.9a.9.9 0 0 0-.86.64L1.2 12.9a.86.86 0 0 1-.35-.7V3.9c0-.5.4-.9.9-.9Zm2.6 4.5h11a.6.6 0 0 1 .57.8l-1.5 5a.9.9 0 0 1-.86.7H1.9a.6.6 0 0 1-.57-.8l1.6-5.2a.9.9 0 0 1 .86-.5Z";
const FILE_BODY = "M3.5 1.4h5.2L13 5.7v8.9a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V2.4a1 1 0 0 1 1-1Z";
const FILE_FOLD = "M8.6 1.4 13 5.7H9.4a.8.8 0 0 1-.8-.8V1.4Z";
const REPO =
  "M11.4 3.6a2.1 2.1 0 1 0-2.6 2.04v.5c0 .9-.7 1.6-1.6 1.6h-1.4c-.5 0-1 .13-1.4.36V5.64a2.1 2.1 0 1 0-1 0v4.72a2.1 2.1 0 1 0 1 0v-.03c0-.9.7-1.6 1.6-1.6h1.4a2.6 2.6 0 0 0 2.6-2.6v-.5a2.1 2.1 0 0 0 1.4-2.02Z";

function ext(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m?.[1]?.toLowerCase() ?? "";
}

export function icon(name: string, kind: "file" | "dir" | "repo", open = false): SVGSVGElement {
  if (kind === "repo") return svg([{ d: REPO }], "var(--m-vio)");

  if (kind === "dir") {
    const cfg = CONFIG_DIRS.has(name.toLowerCase());
    return svg(
      [{ d: open ? FOLDER_OPEN : FOLDER }],
      cfg ? "var(--m-vio)" : "var(--m-acc)",
    );
  }

  const lower = name.toLowerCase();
  const tint = BY_NAME[lower] ?? TINT[ext(name)] ?? "var(--m-dim)";
  return svg(
    [
      { d: FILE_BODY, fill: tint, opacity: 0.9 },
      { d: FILE_FOLD, fill: tint, opacity: 0.45 },
    ],
    tint,
  );
}
