import "@xterm/xterm/css/xterm.css";
import "./style.css";

import { listen } from "@tauri-apps/api/event";
import { Pane } from "./pane";
import {
  findLeaf,
  leaf,
  leaves,
  removeNode,
  renderTree,
  replaceNode,
  split,
  type Tab,
} from "./layout";
import { THEMES, applyTheme, type MarlinTheme } from "./theme";

interface PtyOutput {
  id: number;
  data: string;
}

const app = {
  theme: THEMES[0] as MarlinTheme,
  tabs: [] as Tab[],
  active: 0,
  focused: null as Pane | null,
};

const els = {
  panes: document.getElementById("panes") as HTMLDivElement,
  title: document.getElementById("wintitle") as HTMLSpanElement,
  stTheme: document.getElementById("st-theme") as HTMLSpanElement,
  stPanes: document.getElementById("st-panes") as HTMLSpanElement,
  stShell: document.getElementById("st-shell") as HTMLSpanElement,
};

const curTab = (): Tab => app.tabs[app.active] as Tab;
const allPanes = (): Pane[] => app.tabs.flatMap((t) => leaves(t.root).map((l) => l.pane));

function paneByPty(id: number): Pane | undefined {
  return allPanes().find((p) => p.ptyId === id);
}

function refreshChrome(): void {
  els.title.textContent = app.focused ? `marlin · ${app.focused.name}` : "marlin";
  els.stTheme.textContent = app.theme.name;
  // setTheme runs before the first tab exists, and a pane's title callback can
  // fire during construction. Neither should have to know about boot order.
  const tab = app.tabs[app.active];
  els.stPanes.textContent = tab ? String(leaves(tab.root).length) : "0";
}

/** Rebuild the pane area from the tree, then re-fit. Pane elements are moved,
 *  never recreated, so terminals keep their scrollback across a split. */
function render(): void {
  els.panes.replaceChildren(renderTree(curTab().root, app.focused));
  requestAnimationFrame(() => {
    for (const l of leaves(curTab().root)) l.pane.resize();
  });
  refreshChrome();
}

function focusPane(p: Pane): void {
  app.focused = p;
  for (const l of leaves(curTab().root)) l.pane.el.classList.toggle("focus", l.pane === p);
  p.focus();
  refreshChrome();
}

async function makePane(): Promise<Pane> {
  const pane = new Pane(app.theme, () => refreshChrome());
  pane.el.addEventListener("mousedown", () => focusPane(pane));
  pane.term.attachCustomKeyEventHandler(handleShortcut);
  return pane;
}

async function doSplit(dir: "row" | "col"): Promise<void> {
  const tab = curTab();
  const target = app.focused ? findLeaf(tab.root, app.focused) : null;
  if (!target) return;
  if (leaves(tab.root).length >= 6) return;

  const pane = await makePane();
  const node = leaf(pane);
  tab.root = replaceNode(tab.root, target, split(dir, leaf(target.pane), node));
  render();
  await pane.open();
  focusPane(pane);
  render();
}

function closeFocused(): void {
  const tab = curTab();
  if (!app.focused) return;
  const target = findLeaf(tab.root, app.focused);
  if (!target) return;
  const remaining = leaves(tab.root);
  if (remaining.length === 1) return; // last pane in the last tab: leave it be
  target.pane.dispose();
  const next = removeNode(tab.root, target);
  if (!next) return;
  tab.root = next;
  const first = leaves(tab.root)[0];
  if (first) app.focused = first.pane;
  render();
  if (app.focused) focusPane(app.focused);
}

/**
 * Returning false stops xterm handling the event, which is how a shortcut is
 * taken before it reaches the shell.
 */
function handleShortcut(e: KeyboardEvent): boolean {
  if (e.type !== "keydown" || !e.metaKey) return true;
  const k = e.key.toLowerCase();

  if (k === "d") {
    void doSplit(e.shiftKey ? "col" : "row");
    return false;
  }
  if (k === "w") {
    closeFocused();
    return false;
  }
  return true;
}

function setTheme(t: MarlinTheme): void {
  app.theme = t;
  applyTheme(t);
  for (const p of allPanes()) p.setTheme(t);
  refreshChrome();
}

async function boot(): Promise<void> {
  setTheme(THEMES[0] as MarlinTheme);
  els.stShell.textContent = "zsh";

  // One listener for every pane. Per-pane subscriptions would be N IPC
  // registrations for no benefit.
  await listen<PtyOutput>("pty:data", (e) => {
    paneByPty(e.payload.id)?.write(e.payload.data);
  });
  await listen<number>("pty:exit", (e) => {
    const pane = paneByPty(e.payload);
    if (!pane) return;
    pane.write("\r\n\x1b[38;5;244m[process exited]\x1b[0m\r\n");
    pane.status = "err";
  });

  const first = await makePane();
  app.tabs.push({ name: "", pinned: false, root: leaf(first) });
  app.focused = first;
  render();
  await first.open();
  focusPane(first);
  render();

  // Debounced to a frame: xterm reflow is not free and a window drag fires
  // dozens of these a second.
  let raf = 0;
  window.addEventListener("resize", () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      for (const p of allPanes()) p.resize();
    });
  });
}

void boot();
