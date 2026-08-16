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
import type { Surface } from "./layout";
import { THEMES, applyTheme, type MarlinTheme } from "./theme";
import { Sidebar } from "./sidebar";
import { Viewer, type DiffMode } from "./viewer";
import { Palette, type Command } from "./palette";
import { invoke } from "@tauri-apps/api/core";

interface PtyOutput {
  id: number;
  data: string;
}

type BarState = "h" | "v" | "hidden";

const app = {
  theme: THEMES[0] as MarlinTheme,
  tabs: [] as Tab[],
  active: 0,
  focused: null as Surface | null,
  bar: "h" as BarState,
  tree: true,
  diffMode: "unified" as DiffMode,
};

const els = {
  panes: document.getElementById("panes") as HTMLDivElement,
  body: document.getElementById("winbody") as HTMLDivElement,
  tabbar: document.getElementById("tabbar") as HTMLDivElement,
  title: document.getElementById("wintitle") as HTMLSpanElement,
  stTheme: document.getElementById("st-theme") as HTMLSpanElement,
  stPanes: document.getElementById("st-panes") as HTMLSpanElement,
  stTabs: document.getElementById("st-tabs") as HTMLSpanElement,
  stShell: document.getElementById("st-shell") as HTMLSpanElement,
  stBar: document.getElementById("st-bar") as HTMLSpanElement,
  main: document.querySelector(".main") as HTMLDivElement,
  tree: document.getElementById("tree") as HTMLElement,
};

let sidebar: Sidebar;
let palette: Palette;

const curTab = (): Tab => app.tabs[app.active] as Tab;
/** Terminal panes only. A viewer has no pty and no theme of its own. */
const isTerm = (s: Surface): s is Pane => "ptyId" in s;
const allSurfaces = (): Surface[] => app.tabs.flatMap((t) => leaves(t.root).map((l) => l.pane));
const allPanes = (): Pane[] => allSurfaces().filter(isTerm);

function paneByPty(id: number): Pane | undefined {
  return allPanes().find((p) => p.ptyId === id);
}

/** A tab is named after its focused pane, and follows focus, until you name it
 *  yourself. Then it is pinned and the shell stops touching it. */
function tabLabel(t: Tab): string {
  if (t.pinned && t.name) return t.name;
  const ls = leaves(t.root);
  const hit = ls.find((l) => l.pane === app.focused);
  return (hit ?? ls[0])?.pane.name ?? "shell";
}

function refreshChrome(): void {
  els.title.textContent = app.focused ? `marlin · ${app.focused.name}` : "marlin";
  els.stTheme.textContent = app.theme.name;
  els.stTabs.textContent = String(app.tabs.length);
  els.stBar.textContent =
    app.bar === "h" ? "horizontal" : app.bar === "v" ? "vertical" : "hidden";
  // setTheme runs before the first tab exists, and a pane's title callback can
  // fire during construction. Neither should have to know about boot order.
  const tab = app.tabs[app.active];
  els.stPanes.textContent = tab ? String(leaves(tab.root).length) : "0";
  renderTabs();
}

function renderTabs(): void {
  if (!app.tabs.length) {
    els.tabbar.replaceChildren();
    return;
  }
  const nodes = app.tabs.map((t, i) => {
    const b = document.createElement("div");
    b.className = "tab";
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", i === app.active ? "true" : "false");
    b.tabIndex = 0;

    const idx = document.createElement("span");
    idx.className = "idx";
    idx.textContent = String(i + 1);

    const lbl = document.createElement("span");
    lbl.className = "lbl";
    lbl.textContent = tabLabel(t);

    const x = document.createElement("button");
    x.className = "x";
    x.textContent = "×";
    x.title = "Close tab";
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(i);
    });

    b.append(idx, lbl, x);
    b.addEventListener("click", () => selectTab(i));
    return b;
  });
  els.tabbar.replaceChildren(...nodes);
}

function applyBar(): void {
  els.body.className = `body ${app.bar === "hidden" ? "h hidden" : app.bar}`;
  requestAnimationFrame(() => {
    for (const l of leaves(curTab().root)) l.pane.resize();
  });
}

/** One key cycles all three states, which is simpler than the pair it replaced
 *  and leaves Cmd+B free for the sidebar, where VSCode users expect it. */
function cycleBar(): void {
  app.bar = app.bar === "h" ? "v" : app.bar === "v" ? "hidden" : "h";
  applyBar();
  refreshChrome();
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

function focusPane(p: Surface): void {
  app.focused = p;
  for (const l of leaves(curTab().root)) l.pane.el.classList.toggle("focus", l.pane === p);
  p.focus();
  if (isTerm(p) && p.cwd) {
    void sidebar.setCwd(p.cwd);
    palette.setRoot(p.cwd);
  }
  refreshChrome();
}

async function makePane(): Promise<Pane> {
  const pane = new Pane(
    app.theme,
    () => refreshChrome(),
    (p) => {
      if (p === app.focused) void sidebar.setCwd(p.cwd);
    },
  );
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

  // Last pane in the tab closes the tab. Last tab in the window stays: a
  // terminal with nothing in it is not a state worth being able to reach.
  if (leaves(tab.root).length === 1) {
    if (app.tabs.length > 1) closeTab(app.active);
    return;
  }

  target.pane.dispose();
  const next = removeNode(tab.root, target);
  if (!next) return;
  tab.root = next;
  const first = leaves(tab.root)[0];
  if (first) app.focused = first.pane;
  render();
  if (app.focused) focusPane(app.focused);
}

function selectTab(i: number): void {
  if (i < 0 || i >= app.tabs.length) return;
  app.active = i;
  const first = leaves(curTab().root)[0];
  app.focused = first ? first.pane : null;
  render();
  if (app.focused) focusPane(app.focused);
}

async function newTab(): Promise<void> {
  const pane = await makePane();
  app.tabs.push({ name: "", pinned: false, root: leaf(pane) });
  app.active = app.tabs.length - 1;
  app.focused = pane;
  render();
  await pane.open();
  focusPane(pane);
  render();
}

function closeTab(i: number): void {
  if (app.tabs.length <= 1) return;
  const tab = app.tabs[i];
  if (!tab) return;
  for (const l of leaves(tab.root)) l.pane.dispose();
  app.tabs.splice(i, 1);
  if (app.active >= app.tabs.length) app.active = app.tabs.length - 1;
  selectTab(app.active);
}

/**
 * Returning false stops xterm handling the event, which is how a shortcut is
 * taken before it reaches the shell.
 */
function handleShortcut(e: KeyboardEvent): boolean {
  if (e.type !== "keydown") return true;

  // Escape only belongs to Marlin while a viewer has taken the tab over.
  // Otherwise it is the shell's, and stealing it would break vi for everyone.
  if (e.key === "Escape" && !e.metaKey) {
    if (palette.isOpen) {
      palette.close();
      return false;
    }
    return !closeViewer();
  }
  if (e.key === "F2") {
    renameFocused(e.shiftKey);
    return false;
  }
  if (!e.metaKey) return true;
  const k = e.key.toLowerCase();

  // Terminal actions use iTerm2's bindings, file actions will use VSCode's.
  // Where they overlap, the key belongs to whichever app the feature came from.
  if (k === "d") {
    void doSplit(e.shiftKey ? "col" : "row");
    return false;
  }
  if (k === "w") {
    closeFocused();
    return false;
  }
  if (k === "t") {
    void newTab();
    return false;
  }
  if (k === "p") {
    palette.open(e.shiftKey ? "cmd" : "file");
    return false;
  }
  if (k === "f" && e.shiftKey) {
    palette.open("text");
    return false;
  }
  if (k === "b") {
    if (e.shiftKey) cycleBar();
    else toggleTree();
    return false;
  }
  if (k === "]" || (k === "}" && e.shiftKey)) {
    selectTab((app.active + 1) % app.tabs.length);
    return false;
  }
  if (k === "[" || (k === "{" && e.shiftKey)) {
    selectTab((app.active - 1 + app.tabs.length) % app.tabs.length);
    return false;
  }
  if (k >= "1" && k <= "9") {
    selectTab(Number(k) - 1);
    return false;
  }
  return true;
}

/**
 * Opening a file or a diff rearranges the tab rather than adding to it.
 *
 * Three columns, left to right: the tree, the file, then the terminal. The file
 * lands beside the tree it was clicked in so the eye travels the way the hand
 * just did, and the terminal keeps a fixed right edge instead of jumping across
 * the window every time something is opened. Escape restores the exact layout.
 */
function openViewer(v: Viewer): void {
  const tab = curTab();
  const term = leaves(tab.root)
    .map((l) => l.pane)
    .find((p): p is Pane => isTerm(p));
  if (!term) return;

  if (!tab.viewStash) tab.viewStash = tab.root;
  const root = split("row", leaf(v), leaf(term));
  root.ratio = [1.7, 1];
  tab.root = root;
  app.focused = term;
  render();
  void v.load();
}

function closeViewer(): boolean {
  const tab = curTab();
  if (!tab.viewStash) return false;
  for (const l of leaves(tab.root)) if (!isTerm(l.pane)) l.pane.dispose();
  tab.root = tab.viewStash;
  tab.viewStash = null;
  const first = leaves(tab.root)[0];
  if (first) app.focused = first.pane;
  render();
  if (app.focused) focusPane(app.focused);
  return true;
}

/**
 * Renaming, and the rule that makes it worth having.
 *
 * A manual rename pins the name and stops the shell touching that pane. Without
 * the pin, the first `cd` overwrites what you just typed, which is the most
 * irritating possible version of this feature. Clearing it hands control back.
 */
function renameFocused(tabScope: boolean): void {
  const tab = curTab();
  const current = tabScope ? tabLabel(tab) : (app.focused?.name ?? "");
  const next = window.prompt(tabScope ? "Rename tab" : "Rename pane", current);
  if (next === null) return;
  const name = next.trim();
  if (tabScope) {
    tab.name = name;
    tab.pinned = name.length > 0;
  } else if (app.focused && isTerm(app.focused)) {
    app.focused.name = name || "shell";
    app.focused.pinned = name.length > 0;
  }
  refreshChrome();
}

function toggleTree(): void {
  app.tree = !app.tree;
  els.main.classList.toggle("notree", !app.tree);
  requestAnimationFrame(() => {
    for (const l of leaves(curTab().root)) l.pane.resize();
  });
}

function nextTheme(): void {
  const i = THEMES.indexOf(app.theme);
  setTheme(THEMES[(i + 1) % THEMES.length] as MarlinTheme);
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

  applyBar();
  document.getElementById("btn-new")?.addEventListener("click", () => void newTab());
  document.getElementById("btn-bar")?.addEventListener("click", cycleBar);
  document.getElementById("btn-tree")?.addEventListener("click", toggleTree);

  palette = new Palette((path, name) =>
    openViewer(new Viewer({ kind: "file", name, path, onClose: () => closeViewer() })),
  );

  sidebar = new Sidebar(els.tree, {
    openFile: (path, name) =>
      openViewer(
        new Viewer({ kind: "file", name, path, onClose: () => closeViewer() }),
      ),
    openDiff: (cwd, path, name, staged) =>
      openViewer(
        new Viewer({
          kind: "diff",
          name,
          path,
          cwd,
          staged,
          mode: app.diffMode,
          onMode: (m) => (app.diffMode = m),
          onClose: () => closeViewer(),
        }),
      ),
    gitAction: async (action, cwd, path) => {
      const cmd = action === "stage" ? "git_stage" : action === "unstage" ? "git_unstage" : "git_discard";
      try {
        await invoke(cmd, { cwd, path });
      } catch (err) {
        console.error("marlin: git", action, "failed", err);
      }
      await sidebar.refresh();
    },
  });
  const home = await invoke<string>("fs_home");
  void sidebar.setCwd(home);
  palette.setRoot(home);

  // One registry. The palette and the key map both read it, so an action cannot
  // exist in one and be missing from the other.
  const commands: Command[] = [
    { label: "Split Vertically", key: "⌘D", run: () => void doSplit("row") },
    { label: "Split Horizontally", key: "⌘⇧D", run: () => void doSplit("col") },
    { label: "New Tab", key: "⌘T", run: () => void newTab() },
    { label: "Close Pane", key: "⌘W", run: closeFocused },
    { label: "Rename Pane", key: "F2", run: () => renameFocused(false) },
    { label: "Rename Tab", key: "⇧F2", run: () => renameFocused(true) },
    { label: "Go to File", key: "⌘P", run: () => palette.open("file") },
    { label: "Search in Files", key: "⌘⇧F", run: () => palette.open("text") },
    { label: "Toggle File Tree", key: "⌘B", run: toggleTree },
    { label: "Cycle Tab Bar Position", key: "⌘⇧B", run: cycleBar },
    { label: "Refresh Source Control", run: () => void sidebar.refresh() },
    { label: "Next Theme", run: nextTheme },
  ];
  palette.setCommands(commands);

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
