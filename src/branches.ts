/**
 * The branch switcher.
 *
 * Reached by clicking the branch a repository is on, wherever that is shown.
 * It does the four things you actually do to a branch from a list: read it,
 * switch to it, see what is on it, and delete it. It deliberately stops there.
 * Merging, rebasing, pushing and pulling are conversations with a remote and
 * with your own history, they fail in ways that need a paragraph of output to
 * understand, and you are already sitting in a terminal that prints it.
 *
 * Every git call here is the user's own git, run by `git.rs`, so what this shows
 * and what the pane below it would print cannot disagree.
 */
import { invoke } from "@tauri-apps/api/core";

import { confirm } from "./prompt";

interface Branch {
  name: string;
  current: boolean;
  /** `origin/main` rather than `main`: a ref you can read and check out, but
   *  not one you are ever standing on. */
  remote: boolean;
  upstream: string;
  ahead: number;
  behind: number;
  subject: string;
  when: string;
}

interface GitFile {
  name: string;
  path: string;
  status: string;
}

export interface BranchesOpts {
  /** The repository root. */
  cwd: string;
  /** Its name, for the title. */
  name: string;
  /** Open one file's diff between a branch and HEAD, in the tab. */
  openDiff: (cwd: string, rev: string, path: string, name: string) => void;
  /** Something changed the repository, so whatever is on screen is now stale. */
  onChanged: () => void;
}

/** `origin/feature/x` is checked out as `feature/x`, which is what `--track`
 *  names it and what the next push expects. */
const localName = (rev: string): string => rev.slice(rev.indexOf("/") + 1);

const STATUS_WORD: Record<string, string> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "type changed",
};

export async function openBranches(o: BranchesOpts): Promise<void> {
  const wrap = document.createElement("div");
  wrap.className = "ask on";
  const box = document.createElement("div");
  box.className = "askbox branches";
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

  /** A failure is reported where it happened. Git's own words are kept: they
   *  name the branch and say why, and any rewrite of them would say less. */
  const say = (msg: string, bad = false): void => {
    note.textContent = msg;
    note.classList.toggle("bad", bad);
  };

  let all: Branch[] = [];

  const load = async (): Promise<void> => {
    try {
      all = await invoke<Branch[]>("git_branches", { cwd: o.cwd });
      say("");
    } catch (e) {
      all = [];
      say(String(e), true);
    }
  };

  const current = (): string => all.find((b) => b.current)?.name ?? "HEAD";

  const switchTo = async (name: string): Promise<void> => {
    try {
      await invoke("git_checkout", { cwd: o.cwd, branch: name });
      o.onChanged();
      close();
    } catch (e) {
      // The usual refusal is uncommitted work that the switch would carry or
      // clobber, and git names the files. That is the answer, not an error.
      say(String(e), true);
    }
  };

  /** Checking out a remote makes a local branch that tracks it, which is the
   *  only way to be "on" a remote branch at all. */
  const trackRemote = async (rev: string): Promise<void> => {
    try {
      await invoke("git_checkout_remote", { cwd: o.cwd, rev });
      o.onChanged();
      close();
    } catch (e) {
      say(String(e), true);
    }
  };

  const create = async (name: string): Promise<void> => {
    try {
      await invoke("git_branch_create", { cwd: o.cwd, name });
      o.onChanged();
      close();
    } catch (e) {
      say(String(e), true);
    }
  };

  const remove = async (name: string): Promise<void> => {
    const ok = await confirm({
      title: `Delete “${name}”?`,
      body: `The branch is deleted from this repository. Commits that are on it and nowhere else go with it.`,
      ok: "Delete Branch",
      danger: true,
    });
    if (!ok) return;
    try {
      await invoke("git_branch_delete", { cwd: o.cwd, branch: name, force: false });
      await load();
      renderList();
      say(`Deleted ${name}.`);
      o.onChanged();
      return;
    } catch (e) {
      const why = String(e);
      // `-d` refuses to drop work that is merged nowhere. That refusal is the
      // safety, so forcing past it is a second, separate decision made against
      // git's own reason for stopping.
      if (!/not fully merged/i.test(why)) {
        say(why, true);
        return;
      }
      const force = await confirm({
        title: `Delete “${name}” anyway?`,
        body: `Git refused: ${why.trim()} Deleting it now loses those commits unless something else points at them.`,
        ok: "Delete Anyway",
        danger: true,
      });
      if (!force) return;
      try {
        await invoke("git_branch_delete", { cwd: o.cwd, branch: name, force: true });
        await load();
        renderList();
        say(`Deleted ${name}.`);
        o.onChanged();
      } catch (e2) {
        say(String(e2), true);
      }
    }
  };

  /** Remote branches are only as current as the last fetch, and a switcher that
   *  shows a week-old list of them is how you end up branching from the wrong
   *  place. This is the one network call in here, and it is always explicit. */
  const fetch = async (btn: HTMLButtonElement): Promise<void> => {
    btn.disabled = true;
    btn.textContent = "Fetching…";
    try {
      await invoke("git_fetch", { cwd: o.cwd });
      await load();
      renderList();
      say("Fetched.");
    } catch (e) {
      await load();
      renderList();
      say(String(e), true);
    }
  };

  /** A labelled button. Every control in here says what it does: this box can
   *  delete work, and a glyph is not a thing to be sure about. */
  const button = (label: string, cls = ""): HTMLButtonElement => {
    const b = document.createElement("button");
    b.className = `askbtn ${cls}`.trim();
    b.textContent = label;
    return b;
  };

  // ---------------------------------------------------------------- the list

  const filter = document.createElement("input");
  filter.type = "text";
  filter.spellcheck = false;
  filter.placeholder = "Filter, or type a new branch name";

  const rows = document.createElement("div");
  rows.className = "brrows";

  /** Which row the arrow keys are on. Filtering resets it, because the list it
   *  pointed into is gone. */
  let sel = 0;

  const matches = (): Branch[] => {
    const q = filter.value.trim().toLowerCase();
    return q ? all.filter((b) => b.name.toLowerCase().includes(q)) : all;
  };

  /** One row, whether the branch is local or on a remote. What differs is the
   *  action: a local branch is switched to, a remote one is checked out, which
   *  creates the local branch that tracks it. */
  function branchRow(b: Branch): HTMLElement {
    const row = document.createElement("div");
    row.className = `brow${b.current ? " on" : ""}`;

    const main = document.createElement("button");
    main.className = "brmain";
    main.title = b.current
      ? "The branch you are on."
      : `Show what ${b.name} has that ${current()} does not`;

    const name = document.createElement("span");
    name.className = "brname";
    name.textContent = b.name;

    const meta = document.createElement("span");
    meta.className = "brmeta";
    const track = [b.ahead ? `↑${b.ahead}` : "", b.behind ? `↓${b.behind}` : ""]
      .filter(Boolean)
      .join(" ");
    meta.textContent = [b.when, track, b.subject].filter(Boolean).join(" · ");

    main.append(name, meta);
    main.addEventListener("click", () => void showDiff(b));
    row.appendChild(main);

    const acts = document.createElement("div");
    acts.className = "bracts";
    if (b.current) {
      const here = document.createElement("span");
      here.className = "brhere";
      here.textContent = "current";
      acts.appendChild(here);
    } else if (b.remote) {
      const co = button("Check out", "primary");
      co.title = `Create ${localName(b.name)} tracking ${b.name}, and switch to it`;
      co.addEventListener("click", () => void trackRemote(b.name));
      acts.appendChild(co);
    } else {
      const sw = button("Switch", "primary");
      sw.addEventListener("click", () => void switchTo(b.name));
      const del = button("Delete", "danger");
      del.addEventListener("click", () => void remove(b.name));
      acts.append(sw, del);
    }
    row.appendChild(acts);
    return row;
  }

  function divider(label: string): HTMLElement {
    const d = document.createElement("div");
    d.className = "brdiv";
    d.textContent = label;
    return d;
  }

  function renderList(): void {
    head.replaceChildren();
    const title = document.createElement("span");
    title.textContent = `${o.name} · on ${current()}`;
    const fetchBtn = button("Fetch");
    fetchBtn.title = "git fetch --all --prune, so the remote list below is current";
    fetchBtn.addEventListener("click", () => void fetch(fetchBtn));
    head.append(title, fetchBtn);

    body.replaceChildren(filter, rows);

    const list = matches();
    const locals = list.filter((b) => !b.remote);
    // A remote whose local branch already exists is the same branch said twice,
    // and the local one is the row that can actually be switched to.
    const haveLocal = new Set(all.filter((b) => !b.remote).map((b) => b.name));
    const remotes = list.filter((b) => b.remote && !haveLocal.has(localName(b.name)));

    rows.replaceChildren();
    const typed = filter.value.trim();

    if (!locals.length && !remotes.length) {
      const none = document.createElement("div");
      none.className = "brempty";
      none.textContent = typed
        ? `No branch matches “${typed}”.`
        : "No branches.";
      rows.appendChild(none);
      if (typed) {
        const mk = button(`Create “${typed}” and switch to it`, "primary");
        mk.addEventListener("click", () => void create(typed));
        rows.appendChild(mk);
      }
      return;
    }

    const visible = [...locals, ...remotes];
    sel = Math.max(0, Math.min(sel, visible.length - 1));

    const add = (b: Branch): void => {
      const row = branchRow(b);
      if (visible.indexOf(b) === sel) row.classList.add("sel");
      rows.appendChild(row);
    };
    for (const b of locals) add(b);
    if (remotes.length) {
      rows.appendChild(divider("On a remote, not here yet"));
      for (const b of remotes) add(b);
    }
    rows.querySelector(".brow.sel")?.scrollIntoView({ block: "nearest" });
  }

  /** The branches the arrows walk, in the order they are drawn. */
  const visibleRows = (): Branch[] => {
    const list = matches();
    const haveLocal = new Set(all.filter((b) => !b.remote).map((b) => b.name));
    return [
      ...list.filter((b) => !b.remote),
      ...list.filter((b) => b.remote && !haveLocal.has(localName(b.name))),
    ];
  };

  filter.addEventListener("input", () => {
    sel = 0;
    renderList();
  });
  filter.addEventListener("keydown", (e) => {
    // The terminal is listening on the document, and every letter typed in here
    // would otherwise also be a letter typed at a shell.
    e.stopPropagation();

    // Arrows walk the list without leaving the filter, so typing and choosing
    // are the same gesture rather than two modes.
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = visibleRows().length;
      if (!n) return;
      sel = (sel + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      renderList();
      return;
    }
    if (e.key !== "Enter") return;
    e.preventDefault();

    // A row the arrows landed on is the answer, whatever the text says.
    const picked = visibleRows()[sel];
    if (picked && sel > 0) {
      if (picked.current) return;
      return void (picked.remote ? trackRemote(picked.name) : switchTo(picked.name));
    }

    const list = matches();
    const q = filter.value.trim();
    const locals = list.filter((b) => !b.remote);
    const remotes = list.filter((b) => b.remote);
    // Return means the obvious thing, and a local branch is always more obvious
    // than a remote one: checking a remote out creates a branch, so it never
    // happens on an ambiguous Return. A name that matches nothing at all is a
    // name you are asking for rather than a typo to be guessed at.
    const exact = locals.find((b) => b.name === q);
    if (exact) return void switchTo(exact.name);
    if (locals.length === 1 && locals[0]) return void switchTo(locals[0].name);
    if (!locals.length) {
      const hit =
        remotes.find((b) => b.name === q || localName(b.name) === q) ??
        (remotes.length === 1 ? remotes[0] : null);
      if (hit) return void trackRemote(hit.name);
      if (q) return void create(q);
    }
  });

  // ----------------------------------------------------------- one branch

  async function showDiff(b: Branch): Promise<void> {
    head.textContent = `${b.name} · what it has that ${current()} does not`;
    body.replaceChildren();
    say("");

    const bar = document.createElement("div");
    bar.className = "brbar";
    const back = button("← Branches");
    back.addEventListener("click", () => renderList());
    bar.appendChild(back);
    if (b.remote) {
      // No delete: dropping a remote branch is a push to the remote, which is a
      // conversation with a server and belongs in the pane below.
      const co = button(`Check out as ${localName(b.name)}`, "primary");
      co.addEventListener("click", () => void trackRemote(b.name));
      bar.appendChild(co);
    } else if (!b.current) {
      const sw = button("Switch to it", "primary");
      sw.addEventListener("click", () => void switchTo(b.name));
      const del = button("Delete it", "danger");
      del.addEventListener("click", () => void remove(b.name));
      bar.append(sw, del);
    }
    const copy = button("Copy name");
    copy.addEventListener("click", () => {
      void navigator.clipboard.writeText(b.name);
      say(`Copied ${b.name}.`);
    });
    bar.appendChild(copy);
    body.appendChild(bar);

    const list = document.createElement("div");
    list.className = "brrows";
    const loading = document.createElement("div");
    loading.className = "brempty";
    loading.textContent = "reading…";
    list.appendChild(loading);
    body.appendChild(list);

    let files: GitFile[] = [];
    try {
      files = await invoke<GitFile[]>("git_branch_files", { cwd: o.cwd, rev: b.name });
    } catch (e) {
      list.replaceChildren();
      say(String(e), true);
      return;
    }

    list.replaceChildren();
    if (!files.length) {
      const none = document.createElement("div");
      none.className = "brempty";
      // Three-dot, so this compares against the point the two branches last
      // agreed rather than against the tip of HEAD.
      none.textContent = b.current
        ? "This is the branch you are on."
        : `Nothing on ${b.name} that is not already in ${current()}.`;
      list.appendChild(none);
      return;
    }

    const count = document.createElement("div");
    count.className = "brempty";
    count.textContent = `${files.length} ${files.length === 1 ? "file" : "files"}. Click one to read the diff.`;
    list.appendChild(count);

    for (const f of files) {
      const row = document.createElement("button");
      row.className = "brow file";
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
      row.append(st, nm, pt);
      row.addEventListener("click", () => {
        o.openDiff(o.cwd, b.name, f.path, f.name);
        close();
      });
      list.appendChild(row);
    }
  }

  await load();
  renderList();
  filter.focus();
}
