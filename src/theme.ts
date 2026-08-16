import type { ITheme } from "@xterm/xterm";

export interface MarlinTheme {
  name: string;
  mode: "dark" | "light";
  /** Chrome colours, applied as CSS custom properties. */
  ui: {
    bg: string;
    bar: string;
    chrome: string;
    line: string;
    fg: string;
    dim: string;
    acc: string;
    vio: string;
    grn: string;
    yel: string;
    red: string;
    cyn: string;
  };
  /** Passed straight to xterm. */
  term: ITheme;
}

function build(
  name: string,
  mode: "dark" | "light",
  ui: MarlinTheme["ui"],
): MarlinTheme {
  return {
    name,
    mode,
    ui,
    term: {
      background: ui.bg,
      foreground: ui.fg,
      cursor: ui.acc,
      cursorAccent: ui.bg,
      selectionBackground: mode === "dark" ? "#1E3A5F" : "#CBD9EE",
      black: ui.dim,
      red: ui.red,
      green: ui.grn,
      yellow: ui.yel,
      blue: ui.acc,
      magenta: ui.vio,
      cyan: ui.cyn,
      white: ui.fg,
      brightBlack: ui.dim,
      brightRed: ui.red,
      brightGreen: ui.grn,
      brightYellow: ui.yel,
      brightBlue: ui.acc,
      brightMagenta: ui.vio,
      brightCyan: ui.cyn,
      brightWhite: ui.fg,
    },
  };
}

/** Three dark, three light. Hex values taken from each upstream project. */
export const THEMES: MarlinTheme[] = [
  build("Marlin Dark", "dark", {
    bg: "#0A0F16", bar: "#0D131C", chrome: "#101823", line: "#1C2734",
    fg: "#C6D3E1", dim: "#5C6E82", acc: "#4C8DFF", vio: "#8B7BFF",
    grn: "#5FD3A0", yel: "#E8B44C", red: "#FF7A7A", cyn: "#4FD1E0",
  }),
  build("Dracula", "dark", {
    bg: "#282A36", bar: "#21222C", chrome: "#1E1F29", line: "#44475A",
    fg: "#F8F8F2", dim: "#6272A4", acc: "#BD93F9", vio: "#FF79C6",
    grn: "#50FA7B", yel: "#F1FA8C", red: "#FF5555", cyn: "#8BE9FD",
  }),
  build("Tokyo Night", "dark", {
    bg: "#1A1B26", bar: "#16161E", chrome: "#13131A", line: "#2F3549",
    fg: "#C0CAF5", dim: "#565F89", acc: "#7AA2F7", vio: "#BB9AF7",
    grn: "#9ECE6A", yel: "#E0AF68", red: "#F7768E", cyn: "#7DCFFF",
  }),
  build("Marlin Light", "light", {
    bg: "#FBFCFE", bar: "#EEF2F7", chrome: "#E7EDF4", line: "#D3DCE7",
    fg: "#14202C", dim: "#5D6E7F", acc: "#1B5FD0", vio: "#5B48D6",
    grn: "#12805A", yel: "#8A6100", red: "#C0392B", cyn: "#0E7490",
  }),
  build("Solarized Light", "light", {
    bg: "#FDF6E3", bar: "#EEE8D5", chrome: "#E8E1CC", line: "#D9D2BC",
    fg: "#586E75", dim: "#93A1A1", acc: "#268BD2", vio: "#6C71C4",
    grn: "#859900", yel: "#B58900", red: "#DC322F", cyn: "#2AA198",
  }),
  build("Catppuccin Latte", "light", {
    bg: "#EFF1F5", bar: "#E6E9EF", chrome: "#DCE0E8", line: "#CCD0DA",
    fg: "#4C4F69", dim: "#8C8FA1", acc: "#1E66F5", vio: "#8839EF",
    grn: "#40A02B", yel: "#DF8E1D", red: "#D20F39", cyn: "#179299",
  }),
];

export function applyTheme(t: MarlinTheme): void {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(t.ui)) {
    root.style.setProperty(`--m-${k}`, v);
  }
  root.dataset.mode = t.mode;
}
