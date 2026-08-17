import { invoke } from "@tauri-apps/api/core";

export interface Config {
  theme: string;
  fontFamily: string;
  fontSize: number;
  /** Everything, scaled at once: chrome by the root font size, terminals by
   *  multiplying the font size above. 1 is life size. */
  zoom: number;
  cursorStyle: "block" | "bar" | "underline";
  cursorBlink: boolean;

  tabBar: "top" | "side" | "hidden";
  paneTitles: boolean;
  fileTree: boolean;
  treeWidth: number;
  diffView: "unified" | "split";

  shell: string;
  scrollback: number;
  copyOnSelect: boolean;
  rightClickPaste: boolean;
  notifications: boolean;
  /** Turned off once the shell-integration offer has been answered, either way.
   *  A prompt that comes back after you have said no is not an offer. */
  shellHint: boolean;
}

export const DEFAULTS: Config = {
  theme: "Marlin Dark",
  fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace",
  fontSize: 13,
  zoom: 1,
  cursorStyle: "block",
  // Off by default. A blinking cursor repaints forever, and "idle costs
  // nothing" is the claim this project is built on.
  cursorBlink: false,

  tabBar: "top",
  paneTitles: true,
  fileTree: true,
  treeWidth: 212,
  diffView: "unified",

  shell: "",
  scrollback: 2000,
  copyOnSelect: false,
  rightClickPaste: false,
  notifications: true,
  shellHint: true,
};

/**
 * `~/.config/marlin/marlin.toml` is the source of truth, not localStorage.
 *
 * A setting you can only change through a panel is a setting you have to open a
 * panel for, and it cannot be put in a dotfiles repo. The panel writes the file;
 * the file is a file.
 *
 * The TOML here is flat sections of scalars, so it is hand-parsed rather than
 * pulling a parser into the bundle for eleven keys.
 */
const SECTIONS: Record<string, (keyof Config)[]> = {
  appearance: ["theme", "fontFamily", "fontSize", "zoom", "cursorStyle", "cursorBlink"],
  layout: ["tabBar", "paneTitles", "fileTree", "treeWidth", "diffView"],
  terminal: ["shell", "scrollback", "copyOnSelect", "rightClickPaste"],
  notifications: ["notifications"],
  hints: ["shellHint"],
};

const SNAKE: Record<string, keyof Config> = {
  theme: "theme",
  font_family: "fontFamily",
  font_size: "fontSize",
  zoom: "zoom",
  cursor_style: "cursorStyle",
  cursor_blink: "cursorBlink",
  tab_bar: "tabBar",
  pane_titles: "paneTitles",
  file_tree: "fileTree",
  tree_width: "treeWidth",
  diff_view: "diffView",
  shell: "shell",
  scrollback: "scrollback",
  copy_on_select: "copyOnSelect",
  right_click_paste: "rightClickPaste",
  notifications: "notifications",
  shell_hint: "shellHint",
};

const toSnake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

export function encode(c: Config): string {
  const out: string[] = [
    "# Marlin configuration.",
    "# Edited by the settings panel, and safe to edit by hand or keep in dotfiles.",
    "",
  ];
  for (const [section, keys] of Object.entries(SECTIONS)) {
    out.push(`[${section}]`);
    for (const k of keys) {
      const v = c[k];
      const val =
        typeof v === "string" ? JSON.stringify(v) : typeof v === "boolean" ? String(v) : String(v);
      out.push(`${toSnake(k)} = ${val}`);
    }
    out.push("");
  }
  return out.join("\n");
}

export function decode(text: string): Partial<Config> {
  const c: Record<string, unknown> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("[")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = SNAKE[line.slice(0, eq).trim()];
    if (!key) continue;
    let v: string = line.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) {
      try {
        c[key] = JSON.parse(v);
      } catch {
        c[key] = v.slice(1, -1);
      }
      continue;
    }
    if (v === "true" || v === "false") {
      c[key] = v === "true";
      continue;
    }
    const n = Number(v);
    c[key] = Number.isFinite(n) ? n : v;
  }
  return c as Partial<Config>;
}

export async function load(): Promise<Config> {
  try {
    const text = await invoke<string>("config_load");
    if (!text.trim()) {
      await save(DEFAULTS);
      return { ...DEFAULTS };
    }
    return { ...DEFAULTS, ...decode(text) };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function save(c: Config): Promise<void> {
  try {
    await invoke("config_save", { toml: encode(c) });
  } catch {
    /* read-only home, or no disk. Not worth failing the app over. */
  }
}

export async function configPath(): Promise<string> {
  try {
    return await invoke<string>("config_path");
  } catch {
    return "~/.config/marlin/marlin.toml";
  }
}
