/**
 * The tree holds surfaces, not terminals specifically: a leaf can be a pane or
 * a read-only viewer, and the layout does not need to know which.
 */
export interface Surface {
  readonly el: HTMLElement;
  name: string;
  resize(): void;
  dispose(): void;
  focus(): void;
}

/**
 * A tab holds a tree, not a row.
 *
 * Splitting a pane replaces it with a split node containing the original and a
 * new sibling, which is why a vertical split inside a horizontal one falls out
 * of pressing the second key rather than needing a special case.
 */
export type Leaf = { pane: Surface };
export type Split = { dir: "row" | "col"; a: Node; b: Node; ratio?: [number, number] };
export type Node = Leaf | Split;

export function isLeaf(n: Node): n is Leaf {
  return (n as Leaf).pane !== undefined;
}

export function leaf(pane: Surface): Leaf {
  return { pane };
}

export function split(dir: "row" | "col", a: Node, b: Node): Split {
  return { dir, a, b };
}

export function leaves(n: Node, out: Leaf[] = []): Leaf[] {
  if (isLeaf(n)) {
    out.push(n);
    return out;
  }
  leaves(n.a, out);
  leaves(n.b, out);
  return out;
}

export function replaceNode(root: Node, target: Node, repl: Node): Node {
  if (root === target) return repl;
  if (isLeaf(root)) return root;
  root.a = replaceNode(root.a, target, repl);
  root.b = replaceNode(root.b, target, repl);
  return root;
}

/** Removing a leaf collapses its parent, so a closed pane gives its space back
 *  to its sibling rather than leaving a hole. */
export function removeNode(root: Node, target: Node): Node | null {
  if (root === target) return null;
  if (isLeaf(root)) return root;
  const a = removeNode(root.a, target);
  const b = removeNode(root.b, target);
  if (!a) return b;
  if (!b) return a;
  root.a = a;
  root.b = b;
  return root;
}

export function findLeaf(root: Node, pane: Surface): Leaf | null {
  for (const l of leaves(root)) if (l.pane === pane) return l;
  return null;
}

export interface Tab {
  name: string;
  pinned: boolean;
  root: Node;
  /** Set while a file or diff has taken the tab over, so Escape can restore. */
  viewStash?: Node | null;
  /** Set while a pane is zoomed. */
  zoomStash?: Node | null;
}

/**
 * Build DOM for a tree.
 *
 * Existing pane elements are moved rather than recreated: an xterm instance
 * holds the scrollback and the pty binding, so recreating one on every layout
 * change would wipe the terminal.
 */
export function renderTree(n: Node, focused: Surface | null): HTMLElement {
  if (isLeaf(n)) {
    n.pane.el.classList.toggle("focus", n.pane === focused);
    return n.pane.el;
  }
  const d = document.createElement("div");
  d.className = `split ${n.dir}`;
  const a = renderTree(n.a, focused);
  const b = renderTree(n.b, focused);
  if (n.ratio) {
    a.style.flex = String(n.ratio[0]);
    b.style.flex = String(n.ratio[1]);
  }
  d.append(a, b);
  return d;
}
