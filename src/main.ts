import "@xterm/xterm/css/xterm.css";
import "./style.css";

import { listen } from "@tauri-apps/api/event";
import { DOT_TIP, Pane } from "./pane";
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
import { Settings, themeByName } from "./settings";
import { load as loadConfig, save as saveConfig, DEFAULTS, type Config } from "./config";
import { load as loadSession, save as saveSession, rebuild as rebuildSession } from "./session";
import { Find } from "./find";
import { menu } from "./menu";
import { ask, confirm } from "./prompt";
import { Reporter } from "./report";
import { notifier } from "./notify";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
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
  treegrip: document.getElementById("treegrip") as HTMLDivElement,
};

let sidebar: Sidebar;
let palette: Palette;
let settings: Settings;
let find: Find;
let dragTab: number | null = null;
let dragPane: Surface | null = null;
let reporter: Reporter;
let cfg: Config = { ...DEFAULTS };

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
  els.title.textContent = app.focused?.name ?? "";
  for (const p of allPanes()) p.syncHead();
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
      // The tab bar takes two kinds of drag: a tab being reordered, and a pane
      // being sent to another tab.
      if (dragPane) {
        if (i === app.active) return;
        e.preventDefault();
        b.classList.add("dragtarget");
        return;
      }
      if (dragTab === null || dragTab === i) return;
      e.preventDefault();
      b.classList.add("over");
    });
    b.addEventListener("dragleave", () => b.classList.remove("over", "dragtarget"));
    b.addEventListener("drop", (e) => {
      e.preventDefault();
      b.classList.remove("over", "dragtarget");
      if (dragPane) {
        const moving = dragPane;
        dragPane = null;
        movePaneToTab(moving, i);
        return;
      }
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
  markSession();
}

/**
 * Every layout change ends in render(), so the session save hangs off it rather
 * than off the twenty places that mutate the tree. Debounced, because dragging
 * a split is dozens of renders and one decision.
 *
 * Suppressed until the restore has finished: a save that fires while the tree
 * is half-rebuilt would overwrite the session with the part of it that had been
 * restored so far.
 */
let sessionTimer = 0;
let sessionReady = false;
function markSession(): void {
  if (!sessionReady) return;
  clearTimeout(sessionTimer);
  sessionTimer = window.setTimeout(() => void saveSession(app.tabs, app.active), 500);
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

/**
 * Which part of a pane the cursor is over, as a drop target.
 *
 * A quarter of the width at each edge, and everything else is a swap. Edge
 * bands any narrower turn "put it on the right" into a game of aim, and a pane
 * is not a small target you should have to be precise about.
 */
const ZONES = ["left", "right", "top", "bottom", "swap"] as const;
type Zone = (typeof ZONES)[number];

function zoneAt(el: HTMLElement, x: number, y: number): Zone {
  const r = el.getBoundingClientRect();
  const fx = (x - r.left) / r.width;
  const fy = (y - r.top) / r.height;
  // The nearest edge wins, so a corner resolves to whichever it is closer to
  // rather than to whichever branch happens to be tested first.
  const d: [Zone, number][] = [
    ["left", fx],
    ["right", 1 - fx],
    ["top", fy],
    ["bottom", 1 - fy],
  ];
  d.sort((a, b) => a[1] - b[1]);
  const [zone, dist] = d[0] as [Zone, number];
  return dist < 0.25 ? zone : "swap";
}

function clearZone(el: HTMLElement): void {
  el.classList.remove("dragover", ...ZONES.map((z) => `zone-${z}`));
}

function clearZones(): void {
  for (const p of allPanes()) clearZone(p.el);
  for (const el of els.tabbar.querySelectorAll(".dragtarget")) el.classList.remove("dragtarget");
}

/** Two panes trade places inside their leaves; the tree does not change. */
function swapPanes(a: Surface, b: Surface): void {
  const tab = curTab();
  const la = findLeaf(tab.root, a);
  const lb = findLeaf(tab.root, b);
  if (!la || !lb) return;
  const tmp = la.pane;
  la.pane = lb.pane;
  lb.pane = tmp;
  render();
  focusPane(b);
}

/**
 * Move a pane to one side of another, splitting the target.
 *
 * Detach first, then insert: doing it the other way round means the tree
 * briefly holds the same leaf twice, and `removeNode` would then take out the
 * copy we had just placed.
 */
function movePane(src: Surface, dst: Surface, zone: Zone): void {
  const tab = curTab();
  const from = findLeaf(tab.root, src);
  const to = findLeaf(tab.root, dst);
  if (!from || !to || from === to) return;

  const without = removeNode(tab.root, from);
  if (!without) return;
  const dir = zone === "left" || zone === "right" ? "row" : "col";
  const first = zone === "left" || zone === "top";
  tab.root = replaceNode(without, to, split(dir, first ? from : to, first ? to : from));
  render();
  focusPane(src);
}

/**
 * Drop a pane on a tab to send it there.
 *
 * The pane arrives beside everything already in that tab rather than inside
 * some particular corner of it, because the drop said which tab, not where.
 */
function movePaneToTab(src: Surface, target: number): void {
  const tab = curTab();
  const dest = app.tabs[target];
  if (!dest || dest === tab) return;
  const from = findLeaf(tab.root, src);
  if (!from) return;

  const without = removeNode(tab.root, from);
  if (!without) {
    // It was the only pane in its tab, so the tab goes with it.
    app.tabs.splice(app.tabs.indexOf(tab), 1);
    if (app.active >= app.tabs.length) app.active = app.tabs.length - 1;
  } else {
    tab.root = without;
  }
  dest.root = split("row", dest.root, from);
  selectTab(app.tabs.indexOf(dest));
  focusPane(src);
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
      // A `cd` changes the session without changing the layout, and the
      // directory is half of what the session is for.
      markSession();
    },
    () => refreshChrome(),
  );
  pane.onNotify = (p, message) => {
    void notifier.send(p.name || "Marlin", message || "Something wants your attention");
  };
  pane.onFinished = (p, failed, seconds) => {
    void notifier.send(
      failed ? `Failed in ${p.name}` : `Finished in ${p.name}`,
      `after ${seconds}s`,
    );
  };
  pane.el.addEventListener("mousedown", () => focusPane(pane));

  // Drag a pane onto another. The edge you drop on decides what happens: the
  // middle swaps the two, an edge moves the dragged pane to that side and
  // splits. Either way the pane objects are moved, never rebuilt, so both
  // terminals keep their scrollback and their pty: moving a pane must not
  // restart a shell.
  // The title bar, not the whole pane: making the terminal itself draggable
  // would eat text selection, which is the most-used gesture in a terminal.
  const grip = pane.head;
  grip.title = "Double-click to rename. Drag to an edge to move it there, or to the middle to swap.";
  grip.draggable = true;
  grip.addEventListener("dblclick", (e) => {
    // The pane is already focused: the mousedown above got there first.
    e.preventDefault();
    void renameFocused(false);
  });
  grip.addEventListener("dragstart", (e) => {
    dragPane = pane;
    e.dataTransfer?.setData("text/plain", "pane");
    e.dataTransfer!.effectAllowed = "move";
    pane.el.classList.add("drag");
  });
  grip.addEventListener("dragend", () => {
    dragPane = null;
    pane.el.classList.remove("drag");
    clearZones();
  });
  pane.el.addEventListener("dragover", (e) => {
    if (!dragPane || dragPane === pane) return;
    e.preventDefault();
    const zone = zoneAt(pane.el, e.clientX, e.clientY);
    pane.el.classList.add("dragover");
    for (const z of ZONES) pane.el.classList.toggle(`zone-${z}`, z === zone);
  });
  pane.el.addEventListener("dragleave", (e) => {
    // Crossing onto a child element fires dragleave on the parent, which would
    // strobe the overlay off and on for the whole drag.
    if (pane.el.contains(e.relatedTarget as globalThis.Node | null)) return;
    clearZone(pane.el);
  });
  pane.el.addEventListener("drop", (e) => {
    e.preventDefault();
    const zone = zoneAt(pane.el, e.clientX, e.clientY);
    clearZone(pane.el);
    if (!dragPane || dragPane === pane) return;
    if (zone === "swap") swapPanes(dragPane, pane);
    else movePane(dragPane, pane, zone);
    dragPane = null;
  });
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

/** A new pane in a given directory, split into the current tab. Right-clicking
 *  a folder and getting a shell there is most of why a tree is useful. */
async function openTerminalIn(dir: string): Promise<void> {
  const tab = curTab();
  const target = app.focused ? findLeaf(tab.root, app.focused) : leaves(tab.root)[0];
  if (!target) return;
  const pane = await makePane();
  pane.startCwd = dir;
  tab.root = replaceNode(tab.root, target, split("row", leaf(target.pane), leaf(pane)));
  render();
  await pane.open();
  focusPane(pane);
  render();
}

/**
 * What is still live, in the words someone would use about it. Quitting is only
 * a real decision if the dialog says what is being thrown away.
 */
function liveSummary(): string {
  const panes = app.tabs.flatMap((t) => leaves(t.root).map((l) => l.pane));
  const terms = panes.filter(isTerm);
  const running = terms.filter((p) => p.status === "run").length;
  const waiting = terms.filter((p) => p.status === "wait").length;
  const dirty = panes.filter((p) => p instanceof Viewer && p.isDirty).length;

  const bits: string[] = [];
  bits.push(`${terms.length} ${terms.length === 1 ? "pane" : "panes"} across ${app.tabs.length} ${app.tabs.length === 1 ? "tab" : "tabs"}`);
  if (running) bits.push(`${running} still running`);
  if (waiting) bits.push(`${waiting} waiting for you`);
  if (dirty) bits.push(`${dirty} with unsaved changes`);
  return bits.join(", ") + ".";
}

/** The only path that ends the app, so the confirmation cannot be bypassed by
 *  arriving from a different direction. */
async function confirmQuit(reason: string): Promise<void> {
  const ok = await confirm({
    title: "Quit Marlin?",
    body: `${reason} ${liveSummary()} Every shell in it will be terminated.`,
    ok: "Quit",
    danger: true,
  });
  if (!ok) return;
  // Flush rather than trust the debounce: quitting is exactly the moment a
  // pending save has no later chance to run.
  clearTimeout(sessionTimer);
  await saveSession(app.tabs, app.active);
  await invoke("quit_app").catch(() => {});
}

function closeFocused(): void {
  const tab = curTab();
  if (!app.focused) return;

  // A zoomed pane is the only leaf in the tree, but the tab is not down to one
  // pane: the rest are parked in the stash. Counting the visible tree read a
  // zoom as the last pane, so Cmd+W offered to quit the whole app over a tab
  // that still had panes in it. Unzoom first and the count is the real one.
  if (tab.zoomStash) {
    tab.root = tab.zoomStash;
    tab.zoomStash = null;
  }

  const target = findLeaf(tab.root, app.focused);
  if (!target) return;

  // Last pane in the tab closes the tab. Last pane in the last tab means the
  // window would be empty, which is not a state worth reaching: at that point
  // Cmd+W is someone trying to quit, so treat it as that and ask.
  if (leaves(tab.root).length === 1) {
    if (app.tabs.length > 1) closeTab(app.active);
    else void confirmQuit("This is the last pane, so closing it closes Marlin.");
    return;
  }

  target.pane.dispose();
  const next = removeNode(tab.root, target);
  if (!next) return;
  tab.root = next;
  // A viewer keeps the pre-viewer tree for Escape to put back. The closed pane
  // has to come out of that copy too, or Escape restores a disposed one.
  if (tab.viewStash) {
    const stashed = findLeaf(tab.viewStash, target.pane);
    if (stashed) tab.viewStash = removeNode(tab.viewStash, stashed) ?? tab.viewStash;
  }
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

/**
 * A path is only safe to hand a shell bare if every character in it is inert.
 * Single quotes are the one thing that cannot survive inside single quotes, so
 * they are closed, escaped and reopened.
 */
const BARE = /^[A-Za-z0-9_@%+=:,./-]+$/;
const shellQuote = (p: string): string =>
  BARE.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;

function termAt(x: number, y: number): Pane | null {
  const el = document.elementFromPoint(x, y)?.closest(".pane-term");
  if (!el) return null;
  return allPanes().find((p) => p.el === el) ?? null;
}

/**
 * Where a drop landed, in the CSS pixels the DOM is asked about.
 *
 * Tauri types the position as physical, but only Windows reports it that way:
 * wry reads a macOS drop out of `draggingLocation` and a GTK one out of the
 * widget's own coordinates, and both of those are already logical. Scaling
 * those again halves the point on a retina display, which is what sent every
 * drop to whichever pane sits nearest the top-left corner. The bounds check
 * covers the other direction, so a runtime that starts reporting true physical
 * pixels still lands in the pane under the cursor.
 */
function dropPoint(pos: { x: number; y: number }): { x: number; y: number } {
  const r = window.devicePixelRatio || 1;
  const physical =
    navigator.userAgent.includes("Windows") ||
    pos.x > window.innerWidth ||
    pos.y > window.innerHeight;
  return physical ? { x: pos.x / r, y: pos.y / r } : pos;
}

/**
 * Files dragged in from Finder never reach the pane handlers above: Tauri
 * intercepts an OS-level drop before the webview sees a `drop` event, so
 * without this the drag lands nowhere and the path has to be pasted by hand.
 * The paths are typed into the pty rather than run, with a trailing space, so
 * a drop composes with whatever command is already half-written on the line.
 */
async function wireFileDrop(): Promise<void> {
  let hot: Pane | null = null;
  const highlight = (p: Pane | null): void => {
    if (hot === p) return;
    hot?.el.classList.remove("dragover");
    p?.el.classList.add("dragover");
    hot = p;
  };

  await getCurrentWebview()
    .onDragDropEvent((e) => {
      const ev = e.payload;
      if (ev.type === "leave") return highlight(null);
      const pt = dropPoint(ev.position);
      const over = termAt(pt.x, pt.y);
      if (ev.type !== "drop") return highlight(over);
      highlight(null);
      // Dropping on a viewer, or on chrome, still means the pane you are
      // working in: the alternative is a drag that silently does nothing.
      const pane = over ?? (app.focused && isTerm(app.focused) ? app.focused : null);
      if (!pane || pane.ptyId === null || ev.paths.length === 0) return;
      focusPane(pane);
      void invoke("pty_write", {
        id: pane.ptyId,
        data: `${ev.paths.map(shellQuote).join(" ")} `,
      }).catch(() => {});
    })
    .catch(() => {});
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

/**
 * Put the last layout back, or report that there was not one.
 *
 * Panes are opened after the whole tree is in the DOM, because a pty is spawned
 * with the size of the element it lands in: opening as we build would give every
 * pane the size of the window it was briefly alone in, and the shell would be
 * told the wrong `COLUMNS` before the first prompt was drawn.
 *
 * A directory that no longer exists is not an error worth surfacing. The pane
 * opens at home, which is what a shell does anyway.
 */
async function restoreSession(): Promise<boolean> {
  const saved = await loadSession();
  if (!saved) return false;

  const opening: Pane[] = [];
  try {
    for (const t of saved.tabs) {
      const root = await rebuildSession(
        t.root,
        async (cwd, name, pinned) => {
          const pane = await makePane();
          pane.startCwd = cwd || null;
          if (pinned && name) {
            pane.name = name;
            pane.pinned = true;
          }
          opening.push(pane);
          return leaf(pane);
        },
        (dir, a, b, ratio) => {
          const s = split(dir, a, b);
          if (ratio) s.ratio = ratio;
          return s;
        },
      );
      app.tabs.push({ name: t.name, pinned: t.pinned, root });
    }
  } catch {
    // A tree that will not rebuild is a tree we do not start from.
    for (const p of opening) p.dispose();
    app.tabs.length = 0;
    return false;
  }

  if (!app.tabs.length) return false;
  app.active = Math.min(saved.active, app.tabs.length - 1);
  const first = leaves(curTab().root)[0]?.pane ?? null;
  app.focused = first;
  render();
  for (const p of opening) await p.open();
  if (first) focusPane(first);
  render();
  return true;
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
 * Move `delta` tabs, wrapping at both ends.
 *
 * Bound twice, deliberately. `⌘]` and `⌘[` are iTerm2's, which is where the
 * rest of this key map comes from; Ctrl+Tab is what browsers, editors and
 * Windows Terminal all use. People arrive with one or the other already in
 * their fingers and neither is worth making them relearn.
 *
 * A single tab is not a no-op by accident: cycling would select the tab you are
 * already on, re-render, and steal focus back from whatever had it.
 */
function cycleTab(delta: number): void {
  const n = app.tabs.length;
  if (n < 2) return;
  selectTab((app.active + delta + n) % n);
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

  // Ctrl+Tab, taken before the ⌘ gate below because it is the only shortcut
  // here that is not a ⌘ combination.
  //
  // Safe to take from the shell: a tty has no encoding for Ctrl+Tab. Tab is
  // already Ctrl+I, so the modifier has nowhere to go in the byte stream and
  // nothing downstream ever receives it. Contrast Ctrl+D or Ctrl+C, which are
  // real control characters and must never be intercepted.
  if (e.ctrlKey && e.key === "Tab") {
    cycleTab(e.shiftKey ? -1 : 1);
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
  if (k === "q") {
    void confirmQuit("You pressed ⌘Q.");
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
  const viewer = leaves(curTab().root)
    .map((l) => l.pane)
    .find((p): p is Viewer => p instanceof Viewer);
  if (viewer && (k === "e" || k === "s")) {
    if (k === "e") void viewer.setEditing(!viewer.isEditing);
    else void viewer.save();
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
    cycleTab(1);
    return false;
  }
  if (k === "[" || (k === "{" && e.shiftKey)) {
    cycleTab(-1);
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
  const dirty = leaves(tab.root)
    .map((l) => l.pane)
    .find((p): p is Viewer => p instanceof Viewer && p.isDirty);
  if (dirty) {
    dirty.requestClose();
    return true;
  }
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
  cfg = { ...cfg, fileTree: !app.tree };
  void saveConfig(cfg);
  app.tree = !app.tree;
  els.main.classList.toggle("notree", !app.tree);
  requestAnimationFrame(() => {
    for (const l of leaves(curTab().root)) l.pane.resize();
  });
}

/** Applied everywhere at once: panes, chrome, tab bar and the tree. */
/**
 * The explorer's width, clamped so a drag can never take the terminal away.
 *
 * The ceiling is measured against the window rather than fixed, because the
 * point of a wide tree is a wide display, and a hard 520 would be wrong on both
 * a laptop and a 6K panel.
 */
const TREE_MIN = 140;
const treeMax = () => Math.max(TREE_MIN, Math.min(640, window.innerWidth - 320));

function setTreeWidth(px: number): void {
  const w = Math.round(Math.min(treeMax(), Math.max(TREE_MIN, px || DEFAULTS.treeWidth)));
  els.main.style.setProperty("--tree-w", `${w}px`);
}

/**
 * Drag the border between the tree and the panes.
 *
 * Pointer capture rather than window listeners: a drag that leaves the window,
 * or ends over a terminal that would rather have the mouse, still ends here.
 * The width is written to the config on release, not on every move, because a
 * drag is one decision and it should be one line rewritten in the file.
 */
function wireTreeResize(): void {
  let raf = 0;
  els.treegrip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    els.treegrip.setPointerCapture(e.pointerId);
    els.treegrip.classList.add("on");
    document.body.classList.add("resizing");
    const left = els.tree.getBoundingClientRect().left;

    const move = (ev: PointerEvent) => {
      setTreeWidth(ev.clientX - left);
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        for (const p of allPanes()) p.resize();
      });
    };
    const up = () => {
      els.treegrip.removeEventListener("pointermove", move);
      els.treegrip.removeEventListener("pointerup", up);
      els.treegrip.removeEventListener("pointercancel", up);
      els.treegrip.classList.remove("on");
      document.body.classList.remove("resizing");
      const w = parseInt(els.main.style.getPropertyValue("--tree-w"), 10);
      if (Number.isFinite(w) && w !== cfg.treeWidth) {
        cfg = { ...cfg, treeWidth: w };
        settings.sync(cfg);
        void saveConfig(cfg);
      }
      for (const p of allPanes()) p.resize();
    };
    els.treegrip.addEventListener("pointermove", move);
    els.treegrip.addEventListener("pointerup", up);
    els.treegrip.addEventListener("pointercancel", up);
  });

  // Double-click is the way back: a dragged panel with no reset is a panel you
  // can put somewhere you cannot undo.
  els.treegrip.addEventListener("dblclick", () => {
    applyConfig({ ...cfg, treeWidth: DEFAULTS.treeWidth });
    void saveConfig(cfg);
  });
}

function applyConfig(next: Config): void {
  cfg = next;
  setTheme(themeByName(cfg.theme));
  for (const p of allPanes()) {
    p.term.options.fontFamily = cfg.fontFamily;
    p.term.options.fontSize = cfg.fontSize;
    p.term.options.cursorStyle = cfg.cursorStyle;
    p.term.options.cursorBlink = cfg.cursorBlink;
    p.term.options.scrollback = cfg.scrollback;
  }
  els.panes.classList.toggle("noheads", !cfg.paneTitles);
  app.tree = cfg.fileTree;
  els.main.classList.toggle("notree", !app.tree);
  setTreeWidth(cfg.treeWidth);
  app.bar = cfg.tabBar === "top" ? "h" : cfg.tabBar === "side" ? "v" : "hidden";
  applyBar();
  app.diffMode = cfg.diffView;
  notifier.enabled = cfg.notifications;
  requestAnimationFrame(() => {
    for (const l of leaves(curTab().root)) l.pane.resize();
  });
  refreshChrome();
}

function nextTheme(): void {
  const i = THEMES.indexOf(app.theme);
  const next = THEMES[(i + 1) % THEMES.length] as MarlinTheme;
  applyConfig({ ...cfg, theme: next.name });
  void saveConfig(cfg);
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
  wireTreeResize();
  await wireFileDrop();

  // The webview brings its own context menu. Suppressing it globally, once, is
  // what makes every custom menu below actually appear.
  document.addEventListener("contextmenu", (e) => e.preventDefault());

  // Empty chrome still gets a menu rather than nothing at all.
  for (const el of [els.tabbar, document.querySelector(".titlebar"), document.querySelector(".statusbar")]) {
    el?.addEventListener("contextmenu", (e) => {
      const ev = e as MouseEvent;
      if ((ev.target as HTMLElement).closest(".tab")) return;
      ev.stopPropagation();
      menu.show(ev.clientX, ev.clientY, [
        { label: "New Tab", key: "⌘T", run: () => void newTab() },
        { label: "Split Vertically", key: "⌘D", run: () => void doSplit("row") },
        { label: "Split Horizontally", key: "⌘⇧D", run: () => void doSplit("col") },
        { sep: true },
        { head: "Tab bar" },
        { label: "Top", run: () => setBar("h") },
        { label: "Side", run: () => setBar("v") },
        { label: "Hidden", run: () => setBar("hidden") },
        { sep: true },
        { label: "Toggle File Tree", key: "⌘B", run: toggleTree },
        { label: "Next Theme", run: nextTheme },
        { label: "Settings…", key: "⌘,", run: () => settings.open() },
      ]);
    });
  }

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
    terminalHere: (dir) => void openTerminalIn(dir),
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
    // Tab navigation was bound to ⌘] and ⌘[ but appeared in neither the palette
    // nor any menu, so the only way to find it was to already know it.
    { label: "Next Tab", key: "⌃⇥", run: () => cycleTab(1) },
    { label: "Previous Tab", key: "⌃⇧⇥", run: () => cycleTab(-1) },
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
    { label: "Report a Bug", run: () => void reporter.openIssue("bug") },
    { label: "Request a Feature", run: () => void reporter.openIssue("feature") },
    {
      label: "Open Diagnostics Log",
      run: () =>
        void reporter.openLog().then((p) => {
          if (p) openViewer(new Viewer({ kind: "file", name: "marlin.log", path: p, onClose: () => closeViewer() }));
        }),
    },
  ];
  palette.setCommands(commands);

  // Footer links. Opened through the OS handler, never in the webview: a
  // terminal that can navigate its own UI to an arbitrary page is a terminal
  // with a whole class of problem it did not need.
  reporter = new Reporter((n) => {
    const el = document.getElementById("st-errors");
    if (!el) return;
    el.classList.toggle("on", n > 0);
    el.textContent = n === 1 ? "1 error" : `${n} errors`;
  });

  const openExternal = (url: string) => {
    void invoke("open_external", { url }).catch(() => {});
  };
  document.getElementById("lnk-bug")?.addEventListener("click", () =>
    void reporter.openIssue("bug"),
  );
  document.getElementById("lnk-idea")?.addEventListener("click", () =>
    void reporter.openIssue("feature"),
  );
  document.getElementById("st-errors")?.addEventListener("click", () =>
    void reporter.openIssue("bug"),
  );

  // If the last run died without saying goodbye, say so once, quietly, with a
  // way to act on it. A crash nobody hears about is a crash nobody fixes.
  void reporter.diagnostics().then((d) => {
    if (!d?.crashed_last_run) return;
    const el = document.getElementById("st-errors");
    if (el) {
      el.classList.add("on");
      el.textContent = "crashed last run · report";
    }
    void reporter.clearCrashFlag();
  });
  document.getElementById("lnk-sponsor")?.addEventListener("click", () =>
    openExternal("https://github.com/sponsors/ehsangazar"),
  );

  // The red button and the menu's Quit arrive here too, so there is one
  // confirmation rather than one per entry point.
  void getCurrentWindow()
    .onCloseRequested(async (e) => {
      e.preventDefault();
      await confirmQuit("You asked to close the window.");
    })
    .catch(() => {});

  find = new Find();
  settings = new Settings(
    cfg,
    (next) => applyConfig(next),
    (path, name) =>
      openViewer(new Viewer({ kind: "file", name, path, onClose: () => closeViewer() })),
  );
  document.getElementById("btn-settings")?.addEventListener("click", () => settings.open());
  cfg = await loadConfig();
  settings.sync(cfg);
  applyConfig(cfg);

  if (!(await restoreSession())) {
    const first = await makePane();
    app.tabs.push({ name: "", pinned: false, root: leaf(first) });
    app.focused = first;
    render();
    await first.open();
    focusPane(first);
    render();
  }
  sessionReady = true;

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
