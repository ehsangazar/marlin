/**
 * What is uncommitted in one repository, as a list you can read from anywhere.
 *
 * The sidebar already shows this for the repository you are standing in. This
 * is the same view for a repository you are only looking at: a sibling in the
 * tree, three folders away, that has a number next to its branch. Opening it
 * costs one `git status`, on a click, and never on a timer.
 */
import { invoke } from "@tauri-apps/api/core";

interface GitFile {
  name: string;
  path: string;
  status: string;
}

interface GitStatus {
  is_repo: boolean;
  branch: string;
  ahead: number;
  behind: number;
  staged: GitFile[];
  changes: GitFile[];
  conflicts: GitFile[];
}

const STATUS_WORD: Record<string, string> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "conflicted",
  U: "untracked",
  "?": "untracked",
};

export interface ChangesOpts {
  /** The repository root. */
  cwd: string;
  /** Its name, for the title. */
  name: string;
  /** Open one file's working-tree diff, in the tab. */
  openDiff: (cwd: string, path: string, name: string, staged: boolean) => void;
}

export async function openChanges(o: ChangesOpts): Promise<void> {
  const wrap = document.createElement("div");
  wrap.className = "ask on";
  const box = document.createElement("div");
  box.className = "askbox branches wide";
  wrap.appendChild(box);

  const head = document.createElement("div");
  head.className = "asktitle strong brhead";
  const body = document.createElement("div");
  body.className = "brbody";
  const note = document.createElement("div");
  note.className = "brnote";
  box.append(head, body, note);
  document.body.appendChild(wrap);

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    wrap.remove();
    window.removeEventListener("keydown", onKey, true);
  };
  function onKey(e: KeyboardEvent): void {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  }
  // Capture, so the terminal's own key handler never sees these.
  window.addEventListener("keydown", onKey, true);
  wrap.addEventListener("mousedown", (e) => {
    if (e.target === wrap) close();
  });

  const rows = document.createElement("div");
  rows.className = "brrows";
  body.appendChild(rows);

  const row = (f: GitFile, staged: boolean): HTMLElement => {
    const b = document.createElement("button");
    b.className = "brow file";
    b.title = `Open the diff for ${f.path}`;
    const st = document.createElement("span");
    st.className = `gst ${f.status}`;
    st.textContent = f.status;
    st.title = STATUS_WORD[f.status] ?? f.status;
    const nm = document.createElement("span");
    nm.className = "brname";
    nm.textContent = f.name;
    const pt = document.createElement("span");
    pt.className = "brmeta";
    pt.textContent = f.path;
    b.append(st, nm, pt);
    b.addEventListener("click", () => {
      o.openDiff(o.cwd, f.path, f.name, staged);
      close();
    });
    return b;
  };

  const group = (label: string, files: GitFile[], staged: boolean): void => {
    if (!files.length) return;
    const h = document.createElement("div");
    h.className = "brdiv";
    h.textContent = `${label} · ${files.length}`;
    rows.appendChild(h);
    for (const f of files) rows.appendChild(row(f, staged));
  };

  const loading = document.createElement("div");
  loading.className = "brempty";
  loading.textContent = "reading…";
  rows.appendChild(loading);

  let st: GitStatus | null = null;
  try {
    st = await invoke<GitStatus>("git_status", { cwd: o.cwd });
  } catch (e) {
    rows.replaceChildren();
    note.classList.add("bad");
    note.textContent = String(e);
    return;
  }

  const total = st.conflicts.length + st.staged.length + st.changes.length;
  head.textContent = `${o.name} · ${st.branch || "detached"} · ${total} ${total === 1 ? "file" : "files"}`;

  rows.replaceChildren();
  // Conflicts first, because they are the only ones that stop you working, and
  // staged before unstaged, because that is the order they left in.
  group("Merge conflicts", st.conflicts, false);
  group("Staged", st.staged, true);
  group("Changes", st.changes, false);

  if (!total) {
    const clean = document.createElement("div");
    clean.className = "brempty";
    clean.textContent = "Working tree clean.";
    rows.appendChild(clean);
  } else {
    note.textContent = "A diff opens in the tab. Staging and discarding stay in the sidebar for the repository you are in.";
  }
}
