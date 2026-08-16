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
import { Settings, load as loadConfig, themeByName, type Config } from "./settings";
import { Find } from "./find";
import { menu } from "./menu";
import { ask } from "./prompt";
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
let settings: Settings;
let find: Find;
let dragTab: number | null = null;
let cfg: Config = loadConfig();

const curTab = (): Tab => app.tabs[app.active] as Tab;
/** Terminal panes only. A viewer has no pty and no theme of its own. */
const isTerm = (s: Surface): s is Pane => "ptyId" in s;
const allSurfaces = (): Surface[] => app.tabs.flatMap((t) => leaves(t.root).map((l) => l.pane));
const allPanes = (): Pane[] => allSurfaces().filter(isTerm);

function paneByPty(id: number): Pane | undefined {
  return allPanes().find((p) => p.ptyId === id);
}

/**
 * A dot appears only when a pane knows something you do not, and a tab shows
 * the most urgent state among its panes. Focusing a pane clears its finished
 * and failed dots, because looking at it counts as reading it. Without that
 * rule the window fills with dots you have already seen and they stop meaning
 * anything.
 */
const RANK: Record<string, number> = { err: 3, run: 1, ok: 0 };
const DOT_TIP: Record<string, string> = {
  run: "running",
  ok: "finished cleanly",
  err: "last command failed",
};

function tabStatus(t: Tab): string | null {
  let best: string | null = null;
  for (const l of leaves(t.root)) {
    const s = isTerm(l.pane) ? l.pane.status : null;
    if (!s) continue;
    if (!best || (RANK[s] ?? 0) > (RANK[best] ?? 0)) best = s;
  }
  return best;
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

    const dot = document.createElement("span");
    const st = tabStatus(t);
    dot.className = `sdot${st ? ` ${st}` : ""}`;
    if (st) dot.title = DOT_TIP[st];

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

    b.append(dot, idx, lbl, x);
    b.addEventListener("click", () => selectTab(i));
    b.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      selectTab(i);
      void renameFocused(true);
    });
    b.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      selectTab(i);
      menu.show(e.clientX, e.clientY, [
        { label: "New Tab", key: "⌘T", run: () => void newTab() },
        { label: "Rename Tab…", key: "⇧F2", run: () => void renameFocused(true) },
        { sep: true },
        { label: "Close Tab", key: "⌘W", run: () => closeTab(i) },
        { label: "Close Other Tabs", run: () => closeOthers(i) },
        { sep: true },
        { head: "Tab bar" },
        { label: "Top", run: () => setBar("h") },
        { label: "Side", run: () => setBar("v") },
        { label: "Hidden", run: () => setBar("hidden") },
      ]);
    });

    // Drag to reorder. The click handler re-renders, so the node under the
    // pointer must survive between mousedown and drop: reorder state lives in
    // the closure, not in the DOM.
    b.draggable = true;
    b.addEventListener("dragstart", (e) => {
      dragTab = i;
      b.classList.add("drag");
      e.dataTransfer?.setData("text/plain", String(i));
    });
    b.addEventListener("dragend", () => {
      dragTab = null;
      b.classList.remove("drag");
    });
    b.addEventListener("dragover", (e) => {
      if (dragTab === null || dragTab === i) return;
      e.preventDefault();
      b.classList.add("over");
    });
    b.addEventListener("dragleave", () => b.classList.remove("over"));
    b.addEventListener("drop", (e) => {
      e.preventDefault();
      b.classList.remove("over");
      if (dragTab === null || dragTab === i) return;
      const moved = app.tabs.splice(dragTab, 1)[0];
      if (moved) app.tabs.splice(i, 0, moved);
      dragTab = null;
      app.active = i;
      selectTab(i);
    });
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
  // Looking at it counts as reading it.
  if (isTerm(p) && (p.status === "ok" || p.status === "err")) p.status = null;
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
      if (p === app.focused) {
        void sidebar.setCwd(p.cwd);
        palette.setRoot(p.cwd);
      }
    },
    () => refreshChrome(),
  );
  pane.el.addEventListener("mousedown", () => focusPane(pane));
  pane.el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    focusPane(pane);
    menu.show(e.clientX, e.clientY, [
      { label: "Split Vertically", key: "⌘D", run: () => void doSplit("row") },
      { label: "Split Horizontally", key: "⌘⇧D", run: () => void doSplit("col") },
      { sep: true },
      { label: "Rename Pane…", key: "F2", run: () => void renameFocused(false) },
      { label: "Zoom Pane", key: "⌘⇧↩", run: zoomPane },
      { label: "Find…", key: "⌘F", run: () => find.open(pane) },
      { label: "Clear Buffer", key: "⌘K", run: () => pane.term.clear() },
      { sep: true },
      { label: "Copy", key: "⌘C", run: () => void copySelection(pane) },
      { label: "Paste", key: "⌘V", run: () => void pasteInto(pane) },
      { sep: true },
      { label: "Close Pane", key: "⌘W", run: closeFocused },
    ]);
  });
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

/** Zoom: stash the tree and show one pane. Pressing it again restores. */
function zoomPane(): void {
  const tab = curTab();
  if (tab.zoomStash) {
    tab.root = tab.zoomStash;
    tab.zoomStash = null;
  } else if (leaves(tab.root).length > 1 && app.focused) {
    tab.zoomStash = tab.root;
    tab.root = leaf(app.focused);
  } else {
    return;
  }
  render();
  const still = leaves(tab.root).find((l) => l.pane === app.focused);
  focusPane(still ? still.pane : (leaves(tab.root)[0] as { pane: Surface }).pane);
}

/**
 * Focus the nearest pane in a direction, by geometry rather than by tree
 * position. The tree knows the split structure; only the screen knows what is
 * actually to the left of what.
 */
function focusDirection(dir: "left" | "right" | "up" | "down"): void {
  if (!app.focused) return;
  const from = app.focused.el.getBoundingClientRect();
  let best: Surface | null = null;
  let bestDist = Infinity;

  for (const l of leaves(curTab().root)) {
    if (l.pane === app.focused) continue;
    const r = l.pane.el.getBoundingClientRect();
    const dx = r.left + r.width / 2 - (from.left + from.width / 2);
    const dy = r.top + r.height / 2 - (from.top + from.height / 2);
    const ok =
      dir === "left" ? dx < -1 : dir === "right" ? dx > 1 : dir === "up" ? dy < -1 : dy > 1;
    if (!ok) continue;
    // Distance along the axis of travel, plus a penalty for drifting off it.
    const along = dir === "left" || dir === "right" ? Math.abs(dx) : Math.abs(dy);
    const off = dir === "left" || dir === "right" ? Math.abs(dy) : Math.abs(dx);
    const d = along + off * 2;
    if (d < bestDist) {
      bestDist = d;
      best = l.pane;
    }
  }
  if (best) focusPane(best);
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

function setBar(b: BarState): void {
  app.bar = b;
  applyBar();
  refreshChrome();
}

function closeOthers(keep: number): void {
  const survivor = app.tabs[keep];
  if (!survivor) return;
  for (const [i, t] of app.tabs.entries()) {
    if (i === keep) continue;
    for (const l of leaves(t.root)) l.pane.dispose();
  }
  app.tabs = [survivor];
  app.active = 0;
  selectTab(0);
}

async function copySelection(p: Pane): Promise<void> {
  const sel = p.term.getSelection();
  if (sel) await navigator.clipboard.writeText(sel).catch(() => {});
}

async function pasteInto(p: Pane): Promise<void> {
  try {
    const t = await navigator.clipboard.readText();
    if (t && p.ptyId !== null) await invoke("pty_write", { id: p.ptyId, data: t });
  } catch {
    /* clipboard denied */
  }
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
    if (settings.isOpen) {
      settings.close();
      return false;
    }
    if (find.isOpen) {
      find.close();
      return false;
    }
    menu.hide();
    return !closeViewer();
  }
  if (e.key === "F2") {
    void renameFocused(e.shiftKey);
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
  if (k === ",") {
    settings.open();
    return false;
  }
  if (k === "f" && !e.shiftKey) {
    if (app.focused && isTerm(app.focused)) find.open(app.focused);
    return false;
  }
  if (k === "k") {
    if (app.focused && isTerm(app.focused)) app.focused.term.clear();
    return false;
  }
  if (k === "enter" && e.shiftKey) {
    zoomPane();
    return false;
  }
  if (e.altKey && ["arrowleft", "arrowright", "arrowup", "arrowdown"].includes(k)) {
    focusDirection(k.replace("arrow", "") as "left" | "right" | "up" | "down");
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
async function renameFocused(tabScope: boolean): Promise<void> {
  const tab = curTab();
  const current = tabScope ? tabLabel(tab) : (app.focused?.name ?? "");
  const next = await ask(tabScope ? "Rename tab" : "Rename pane", current);
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
  cfg = { ...cfg, tree: !app.tree };
  app.tree = !app.tree;
  els.main.classList.toggle("notree", !app.tree);
  requestAnimationFrame(() => {
    for (const l of leaves(curTab().root)) l.pane.resize();
  });
}

/** Applied everywhere at once: panes, chrome and the tree toggle. */
function applyConfig(next: Config): void {
  cfg = next;
  setTheme(themeByName(cfg.theme));
  for (const p of allPanes()) {
    p.term.options.fontSize = cfg.fontSize;
    p.term.options.cursorBlink = cfg.cursorBlink;
    p.term.options.scrollback = cfg.scrollback;
  }
  app.tree = cfg.tree;
  els.main.classList.toggle("notree", !app.tree);
  app.diffMode = cfg.diffSplit ? "split" : "unified";
  requestAnimationFrame(() => {
    for (const l of leaves(curTab().root)) l.pane.resize();
  });
}

function nextTheme(): void {
  const i = THEMES.indexOf(app.theme);
  const next = THEMES[(i + 1) % THEMES.length] as MarlinTheme;
  applyConfig({ ...cfg, theme: next.name });
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

  // Double-click the empty run of the tab bar for a new tab, the way every
  // browser does. The check matters: without it, a double-click that lands on a
  // tab opens a tab as well as selecting one.
  els.tabbar.addEventListener("dblclick", (e) => {
    if ((e.target as HTMLElement).closest(".tab")) return;
    void newTab();
  });

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
    { label: "Rename Pane", key: "F2", run: () => void renameFocused(false) },
    { label: "Rename Tab", key: "⇧F2", run: () => void renameFocused(true) },
    { label: "Go to File", key: "⌘P", run: () => palette.open("file") },
    { label: "Search in Files", key: "⌘⇧F", run: () => palette.open("text") },
    { label: "Toggle File Tree", key: "⌘B", run: toggleTree },
    { label: "Cycle Tab Bar Position", key: "⌘⇧B", run: cycleBar },
    { label: "Refresh Source Control", run: () => void sidebar.refresh() },
    { label: "Next Theme", run: nextTheme },
    { label: "Open Settings", key: "⌘,", run: () => settings.open() },
    { label: "Zoom Pane", key: "⌘⇧↩", run: zoomPane },
    { label: "Find in Scrollback", key: "⌘F", run: () => { if (app.focused && isTerm(app.focused)) find.open(app.focused); } },
    { label: "Clear Buffer", key: "⌘K", run: () => { if (app.focused && isTerm(app.focused)) app.focused.term.clear(); } },
    { label: "Close Other Tabs", run: () => closeOthers(app.active) },
  ];
  palette.setCommands(commands);

  find = new Find();
  settings = new Settings(cfg, (next) => applyConfig(next));
  document.getElementById("btn-settings")?.addEventListener("click", () => settings.open());
  applyConfig(cfg);

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
