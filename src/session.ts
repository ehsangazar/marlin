import { invoke } from "@tauri-apps/api/core";
import { isLeaf, type Node, type Tab } from "./layout";
import { Pane } from "./pane";

/**
 * The layout, across a quit.
 *
 * **What comes back is the shape and the directories, and nothing else.** Not
 * scrollback, not what was running, not a half-typed command. A terminal that
 * pretended to restore a session would have to either keep processes alive
 * after you quit or fake a screen that no process is behind, and both are worse
 * than an honest empty prompt in the right directory.
 *
 * Saved on a debounce from the same place the layout is drawn, so there is one
 * funnel rather than a save call next to every mutation, which is how a save
 * call gets forgotten next to the tenth one.
 */

const VERSION = 1;

type SLeaf = { cwd: string; name: string; pinned: boolean };
type SSplit = { dir: "row" | "col"; a: SNode; b: SNode; ratio?: [number, number] };
type SNode = SLeaf | SSplit;

interface SSession {
  v: number;
  active: number;
  tabs: { name: string; pinned: boolean; root: SNode }[];
}

const isSLeaf = (n: SNode): n is SLeaf => (n as SLeaf).cwd !== undefined;

/**
 * A viewer leaf serialises as the pane it is sitting on top of, because a file
 * view is a thing you are doing, not a thing you arranged.
 */
function encodeNode(n: Node): SNode | null {
  if (isLeaf(n)) {
    const p = n.pane;
    if (!(p instanceof Pane)) return null;
    return { cwd: p.cwd || p.startCwd || "", name: p.pinned ? p.name : "", pinned: p.pinned };
  }
  const a = encodeNode(n.a);
  const b = encodeNode(n.b);
  if (!a) return b;
  if (!b) return a;
  const out: SSplit = { dir: n.dir, a, b };
  if (n.ratio) out.ratio = n.ratio;
  return out;
}

export function encode(tabs: Tab[], active: number): SSession {
  const out: SSession["tabs"] = [];
  for (const t of tabs) {
    // A tab mid-zoom or mid-file-view stashes its real tree; that stash is the
    // layout, and the thing on screen is temporary.
    const root = encodeNode(t.zoomStash ?? t.viewStash ?? t.root);
    if (root) out.push({ name: t.name, pinned: t.pinned, root });
  }
  return { v: VERSION, active: Math.min(Math.max(0, active), Math.max(0, out.length - 1)), tabs: out };
}

export async function save(tabs: Tab[], active: number): Promise<void> {
  try {
    await invoke("session_save", { json: JSON.stringify(encode(tabs, active)) });
  } catch {
    /* A layout is not worth failing the app over. */
  }
}

/**
 * Anything unreadable is treated as no session at all. A corrupt file must cost
 * you your layout, never your launch.
 */
export async function load(): Promise<SSession | null> {
  try {
    const text = await invoke<string>("session_load");
    if (!text.trim()) return null;
    const s = JSON.parse(text) as SSession;
    if (!s || s.v !== VERSION || !Array.isArray(s.tabs) || !s.tabs.length) return null;
    return s;
  } catch {
    return null;
  }
}

/**
 * Rebuild a saved tree, asking the caller for each pane.
 *
 * The caller owns pane construction because a pane needs the wiring in main.ts
 * (notifications, focus, the drag grip) that this module has no business
 * knowing about.
 */
export async function rebuild(
  n: SNode,
  make: (cwd: string, name: string, pinned: boolean) => Promise<Node>,
  split: (dir: "row" | "col", a: Node, b: Node, ratio?: [number, number]) => Node,
): Promise<Node> {
  if (isSLeaf(n)) return make(n.cwd, n.name, n.pinned);
  const a = await rebuild(n.a, make, split);
  const b = await rebuild(n.b, make, split);
  return split(n.dir, a, b, n.ratio);
}

export type { SSession, SNode };
