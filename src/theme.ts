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

/**
 * Three dark, three light.
 *
 * Contrast raised across all six on 16 Aug after reading a real screenshot: the
 * secondary text was thin enough that the sidebar was hard to scan, which is
 * the half of the UI you look at without focusing on. Backgrounds and accents
 * are close to their upstream values; `dim` and `line` are the ones that moved,
 * because they carry the chrome.
 */
export const THEMES: MarlinTheme[] = [
  build("Marlin Dark", "dark", {
    bg: "#080D14", bar: "#0C121B", chrome: "#111A26", line: "#26333F",
    fg: "#E4ECF5", dim: "#8497AB", acc: "#5C9CFF", vio: "#9E90FF",
    grn: "#6FE0AF", yel: "#F0C25F", red: "#FF8C8C", cyn: "#5FDCEC",
  }),
  build("Dracula", "dark", {
    bg: "#282A36", bar: "#21222C", chrome: "#1E1F29", line: "#565A72",
    fg: "#F8F8F2", dim: "#8B9BD4", acc: "#C9A5FA", vio: "#FF8FD0",
    grn: "#5DFB87", yel: "#F4FC9B", red: "#FF6B6B", cyn: "#9BEDFD",
  }),
  build("Tokyo Night", "dark", {
    bg: "#161721", bar: "#12131B", chrome: "#0F1017", line: "#3B4261",
    fg: "#D5DCF7", dim: "#7E88B8", acc: "#8DB0F9", vio: "#C7AAF9",
    grn: "#AEDA7C", yel: "#EBBC7A", red: "#FF8A9F", cyn: "#93D9FF",
  }),
  build("Marlin Light", "light", {
    bg: "#FFFFFF", bar: "#EDF1F6", chrome: "#E3EAF2", line: "#C2CDDA",
    fg: "#0C1620", dim: "#46586A", acc: "#0E4FBF", vio: "#4B36CC",
    grn: "#0C6E4C", yel: "#7A5400", red: "#B32D1F", cyn: "#0A6076",
  }),
  build("Solarized Light", "light", {
    bg: "#FDF6E3", bar: "#F1EAD6", chrome: "#E9E1CB", line: "#CFC9B4",
    fg: "#3E5257", dim: "#5A6B70", acc: "#1A7BC4", vio: "#5C61BC",
    grn: "#6E7F00", yel: "#9A7500", red: "#CE2A26", cyn: "#1D8F86",
  }),
  build("Catppuccin Latte", "light", {
    bg: "#FFFFFF", bar: "#E9ECF2", chrome: "#DEE2EA", line: "#BCC0CC",
    fg: "#363950", dim: "#6B6E82", acc: "#0F52E0", vio: "#7526E0",
    grn: "#2F8A1F", yel: "#B0700F", red: "#C00A2F", cyn: "#0E7C74",
  }),
];

export function applyTheme(t: MarlinTheme): void {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(t.ui)) {
    root.style.setProperty(`--m-${k}`, v);
  }
  root.dataset.mode = t.mode;
}
