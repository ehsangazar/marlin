import "@xterm/xterm/css/xterm.css";
import "./style.css";

import { listen } from "@tauri-apps/api/event";
import { Pane } from "./pane";
import { THEMES, applyTheme, type MarlinTheme } from "./theme";

interface PtyOutput {
  id: number;
  data: string;
}

const app = {
  theme: THEMES[0] as MarlinTheme,
  panes: [] as Pane[],
  focused: null as Pane | null,
};

const els = {
  panes: document.getElementById("panes") as HTMLDivElement,
  title: document.getElementById("wintitle") as HTMLSpanElement,
  stTheme: document.getElementById("st-theme") as HTMLSpanElement,
  stPanes: document.getElementById("st-panes") as HTMLSpanElement,
  stShell: document.getElementById("st-shell") as HTMLSpanElement,
};

function paneById(id: number): Pane | undefined {
  return app.panes.find((p) => p.ptyId === id);
}

function refreshChrome(): void {
  els.title.textContent = app.focused ? `marlin · ${app.focused.name}` : "marlin";
  els.stPanes.textContent = String(app.panes.length);
  els.stTheme.textContent = app.theme.name;
}

async function addPane(): Promise<Pane> {
  const pane = new Pane(app.theme, () => refreshChrome());
  app.panes.push(pane);
  els.panes.appendChild(pane.el);
  await pane.open();
  pane.el.addEventListener("mousedown", () => {
    app.focused = pane;
    refreshChrome();
  });
  app.focused = pane;
  pane.focus();
  refreshChrome();
  return pane;
}

function setTheme(t: MarlinTheme): void {
  app.theme = t;
  applyTheme(t);
  for (const p of app.panes) p.setTheme(t);
  refreshChrome();
}

async function boot(): Promise<void> {
  setTheme(THEMES[0] as MarlinTheme);
  els.stShell.textContent = "zsh";

  // One listener for every pane. Per-pane listeners would mean N IPC
  // subscriptions for no benefit.
  await listen<PtyOutput>("pty:data", (e) => {
    paneById(e.payload.id)?.write(e.payload.data);
  });

  await listen<number>("pty:exit", (e) => {
    const pane = paneById(e.payload);
    if (!pane) return;
    pane.write("\r\n\x1b[38;5;244m[process exited]\x1b[0m\r\n");
    pane.status = "err";
  });

  await addPane();

  // Resize is debounced to a frame: xterm reflow is not free and a drag fires
  // dozens of these a second.
  let raf = 0;
  window.addEventListener("resize", () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      for (const p of app.panes) p.resize();
    });
  });
}

void boot();
