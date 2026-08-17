import { invoke } from "@tauri-apps/api/core";
import { icon } from "./icons";
import { menu } from "./menu";

export interface Entry {
  name: string;
  path: string;
  dir: boolean;
}

export interface GitFile {
  name: string;
  path: string;
  status: string;
}

export interface GitStatus {
  is_repo: boolean;
  branch: string;
  ahead: number;
  behind: number;
  staged: GitFile[];
  changes: GitFile[];
  conflicts: GitFile[];
}


interface Head {
  path: string;
  branch: string;
}

interface Counts {
  path: string;
  changes: number;
  conflicts: number;
}

export interface Project {
  repos: string[];
  has_claude: boolean;
  has_agents: boolean;
  is_repo: boolean;
}

interface Handlers {
  openFile: (path: string, name: string) => void;
  openDiff: (cwd: string, path: string, name: string, staged: boolean) => void;
  gitAction: (action: "stage" | "unstage" | "discard", cwd: string, path: string) => void;
  /** Open a terminal in this directory, in this tab. */
  terminalHere: (dir: string) => void;
  /** The branch switcher for a repository, opened from the branch it is on. */
  openBranches: (repo: string, name: string) => void;
  /** What is uncommitted in a repository, opened from its change count. */
  openChanges: (repo: string, name: string) => void;
}

/**
 * The explorer and source control.
 *
 * A directory of repositories used to get a list of its own above the tree.
 * The tree now marks every folder that is a repository with the branch it is
 * on, which is the same information in the place you were already looking, so
 * the second list was two answers to one question.
 *
 * Everything here is driven by the focused pane's cwd. Nothing polls: `refresh`
 * is called on a cd or an explicit request, never on a timer, because a git
 * status per repo on a timer is how a fast terminal becomes a battery drain
 * nobody attributes to it.
 */
export class Sidebar {
  readonly el: HTMLElement;
  private cwd = "";
  private expanded = new Set<string>();
  private explorerOpen = true;
  /** Directory path to the branch it is on, for the folders in the explorer
   *  that happen to be repositories. Filled by reading `.git/HEAD`, never by
   *  running git: this is asked about every folder in every listing. */
  private heads = new Map<string, string>();
  /** Path to how dirty that repository is. A real `git status` each, so they are
   *  fetched once for a listing and then held until an explicit refresh: the
   *  tree re-renders on every expand and this must not re-run with it. */
  private counts = new Map<string, { changes: number; conflicts: number }>();
  /** Folders already known not to be repositories. Without it, the one listing
   *  of ordinary folders is re-asked about on every expand and collapse, since
   *  only the answers get cached and "no" is an answer. */
  private notRepo = new Set<string>();
  /**
   * The sidebar's own tabs. The explorer is the first one and is always there;
   * clicking a repository's change count opens another beside it, showing only
   * that repository's changed files. Reviewing a handful of files means moving
   * between them and coming back to the list, so the list has to be a place you
   * can leave and return to rather than a box that closes on the first click.
   */
  private panels: { cwd: string; name: string; status: GitStatus | null }[] = [];
  /** Which one is showing: -1 the explorer, -2 the changes of the repository the
   *  focused shell is standing in, 0 and up a repository opened from the tree.
   *  Source control used to be a section stapled to the bottom of the explorer,
   *  which meant changed files were listed in two places at once. */
  private panel = -1;
  private CURRENT = -2;
  private status: GitStatus | null = null;
  private project: Project | null = null;
  private selected = "";
  private h: Handlers;

  constructor(el: HTMLElement, handlers: Handlers) {
    this.el = el;
    this.h = handlers;
  }

  get dir(): string {
    return this.cwd;
  }

  async setCwd(cwd: string, force = false): Promise<void> {
    if (!cwd || (cwd === this.cwd && !force)) return;
    this.cwd = cwd;
    this.expanded.clear();
    await this.refresh();
  }

  /** One filesystem scan and at most one `git status`. */
  async refresh(): Promise<void> {
    if (!this.cwd) return;
    try {
      this.project = await invoke<Project>("fs_detect", { path: this.cwd });
      this.status = await invoke<GitStatus>("git_status", { cwd: this.cwd });
      this.heads.clear();
      this.counts.clear();
      this.notRepo.clear();
      // The open panels are lists of what is uncommitted, which is exactly the
      // thing a refresh exists to re-read.
      for (const p of this.panels) {
        p.status = await invoke<GitStatus>("git_status", { cwd: p.cwd }).catch(() => null);
      }
    } catch {
      this.project = null;
      this.status = null;
    }
    await this.render();
  }

  select(path: string): void {
    this.selected = path;
  }

  /** Open the changes for a repository, or show the one already open for it.
   *  Clicking the same count twice is a way back to that list, not a second
   *  copy of it. */
  async openChanges(cwd: string, name: string): Promise<void> {
    const at = this.panels.findIndex((p) => p.cwd === cwd);
    if (at >= 0) {
      this.panel = at;
      await this.render();
      return;
    }
    this.panels.push({ cwd, name, status: null });
    this.panel = this.panels.length - 1;
    await this.render();
    await this.loadPanel(this.panel);
  }

  private async closePanel(i: number): Promise<void> {
    this.panels.splice(i, 1);
    // Back to the explorer rather than to whichever panel slid into the gap:
    // closing a list means you are done with it, not that you want another.
    if (this.panel >= this.panels.length || this.panel === i) this.panel = -1;
    await this.render();
  }

  private async loadPanel(i: number): Promise<void> {
    const p = this.panels[i];
    if (!p) return;
    p.status = await invoke<GitStatus>("git_status", { cwd: p.cwd }).catch(() => null);
    await this.render();
  }

  /**
   * How many files are uncommitted, as the thing you click to read them.
   *
   * A tick rather than a zero when there is nothing: the eye can skip a tick,
   * and a column of zeroes is a column you have to read to learn nothing.
   */
  private countChip(repo: string, name: string, c: { changes: number; conflicts: number }): HTMLElement {
    const b = document.createElement("button");
    b.className = c.conflicts ? "cchip conf" : c.changes ? "cchip dirty" : "cchip clean";
    b.textContent = c.conflicts ? `!${c.conflicts}` : c.changes ? String(c.changes) : "✓";
    b.title = c.conflicts
      ? `${c.conflicts} conflicted. Click to open a tab for reading them.`
      : c.changes
        ? `${c.changes} changed. Click to open a tab for reading them.`
        : "Clean. Click to open a tab and check.";
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      this.h.openChanges(repo, name);
    });
    return b;
  }

  /**
   * The branch a repository is on, as the thing you click to change it.
   *
   * One factory for all three places a branch is shown: the workspace list, a
   * folder in the explorer, and the source control bar. They were three
   * separate spans that looked the same and did nothing, and a name that is
   * displayed in three places and clickable in one is worse than not clickable
   * at all.
   */
  private branchChip(repo: string, name: string, branch: string): HTMLElement {
    const b = document.createElement("button");
    b.className = "br";
    b.textContent = branch;
    b.title = `On ${branch}. Click to switch branch, or to see what another one has.`;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      this.h.openBranches(repo, name);
    });
    return b;
  }

  private row(depth: number, opts: {
    twisty?: string;
    icon: SVGElement;
    label: string;
    cls?: string;
    title?: string;
    isDir?: boolean;
    trailing?: HTMLElement[];
    onClick?: (e: MouseEvent) => void;
  }): HTMLElement {
    const b = document.createElement("div");
    b.className = `trow ${opts.cls ?? ""}${this.selected === opts.title ? " sel" : ""}`;
    if (opts.title) b.title = opts.title;

    for (let i = 0; i < depth; i++) {
      const g = document.createElement("span");
      g.className = "gd";
      b.appendChild(g);
    }
    const tw = document.createElement("span");
    tw.className = "tw";
    tw.textContent = opts.twisty ?? "";
    const ic = document.createElement("span");
    ic.className = "ic";
    ic.appendChild(opts.icon);
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = opts.label;
    b.append(tw, ic, nm);
    if (opts.trailing) b.append(...opts.trailing);
    if (opts.onClick) b.addEventListener("click", opts.onClick);
    if (opts.title) {
      const path = opts.title;
      b.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        menu.show(e.clientX, e.clientY, this.pathMenu(path, opts.isDir ?? false));
      });
    }
    return b;
  }

  /** The menu a path gets. Directories and files differ by one entry, so they
   *  share it rather than drifting apart. */
  private pathMenu(path: string, isDir: boolean) {
    const name = path.split("/").pop() ?? path;
    return [
      ...(isDir
        ? [{ label: "Open in Terminal Here", run: () => this.h.terminalHere(path) }]
        : [
            { label: "Open", run: () => this.h.openFile(path, name) },
            { label: "Open in Terminal Here", run: () => void this.terminalForFile(path) },
          ]),
      { label: "Open with Default App", run: () => void invoke("fs_open_default", { path }) },
      { sep: true },
      { label: "Reveal in Finder", run: () => void invoke("fs_reveal", { path }) },
      { label: "Copy Path", run: () => void navigator.clipboard.writeText(path) },
      { label: "Copy Name", run: () => void navigator.clipboard.writeText(name) },
      { sep: true },
      { label: "Set as Sidebar Root", run: () => void this.setCwd(isDir ? path : dirOf(path)) },
      { label: "Refresh", run: () => void this.refresh() },
    ];
  }

  private async terminalForFile(path: string): Promise<void> {
    const dir = await invoke<string>("fs_parent", { path });
    this.h.terminalHere(dir);
  }

  private section(label: string, open: boolean, count: number | null, toggle: () => void, hint?: string): HTMLElement {
    const s = document.createElement("div");
    s.className = "tsec";
    const tw = document.createElement("span");
    tw.textContent = open ? "▾" : "▸";
    const t = document.createElement("span");
    t.textContent = label;
    s.append(tw, t);
    if (count !== null) {
      const c = document.createElement("span");
      c.className = "cnt";
      c.textContent = String(count);
      s.appendChild(c);
    }
    if (hint) {
      const hn = document.createElement("span");
      hn.className = "shint";
      hn.textContent = hint;
      s.appendChild(hn);
    }
    s.addEventListener("click", toggle);
    return s;
  }

  private async tree(path: string, depth: number, into: HTMLElement): Promise<void> {
    let entries: Entry[] = [];
    try {
      entries = await invoke<Entry[]>("fs_list", { path });
    } catch {
      return;
    }

    // Which of these folders are repositories, and what they are on. One call
    // for the whole listing, and it reads `.git/HEAD` rather than running git,
    // so a folder full of repositories costs a file read each and not a
    // subprocess each.
    const dirs = entries.filter((e) => e.dir).map((e) => e.path);
    const unknown = dirs.filter((d) => !this.heads.has(d) && !this.notRepo.has(d));
    if (unknown.length) {
      let repos: string[] = [];
      try {
        for (const h of await invoke<Head[]>("git_heads", { paths: unknown })) {
          this.heads.set(h.path, h.branch);
          repos.push(h.path);
        }
        for (const d of unknown) if (!this.heads.has(d)) this.notRepo.add(d);
      } catch {
        /* a listing without branch chips is a listing, not a failure */
        repos = [];
      }

      // And how dirty each of those is. This one is a `git status` each, run in
      // parallel, asked once per repository and then cached: the tree
      // re-renders on every expand and a status per render is how a sidebar
      // becomes a background job.
      if (repos.length) {
        try {
          for (const c of await invoke<Counts[]>("git_counts", { paths: repos })) {
            this.counts.set(c.path, { changes: c.changes, conflicts: c.conflicts });
          }
        } catch {
          /* the branch still shows; the count is the part that is missing */
        }
      }
    }

    for (const e of entries) {
      const open = this.expanded.has(e.path);
      const branch = e.dir ? this.heads.get(e.path) : undefined;
      const count = branch ? this.counts.get(e.path) : undefined;
      into.appendChild(
        this.row(depth, {
          twisty: e.dir ? (open ? "▾" : "▸") : "",
          icon: icon(e.name, e.dir ? (branch ? "repo" : "dir") : "file", open),
          label: e.name,
          cls: e.dir ? "dir" : "",
          title: e.path,
          isDir: e.dir,
          trailing: branch
            ? [
                this.branchChip(e.path, e.name, branch),
                ...(count ? [this.countChip(e.path, e.name, count)] : []),
              ]
            : undefined,
          onClick: () => {
            if (e.dir) {
              if (open) this.expanded.delete(e.path);
              else this.expanded.add(e.path);
              void this.render();
            } else {
              this.selected = e.path;
              this.h.openFile(e.path, e.name);
              void this.render();
            }
          },
        }),
      );
      if (e.dir && open) await this.tree(e.path, depth + 1, into);
    }
  }

  private gitRow(f: GitFile, staged: boolean, repo?: string): HTMLElement {
    const cwd = repo ?? this.cwd;
    const acts: HTMLElement[] = [];
    const mk = (id: "stage" | "unstage" | "discard", glyph: string, tip: string, danger = false) => {
      const a = document.createElement("span");
      a.className = `fact${danger ? " dz" : ""}`;
      a.textContent = glyph;
      a.title = tip;
      a.addEventListener("click", (e) => {
        e.stopPropagation();
        this.h.gitAction(id, cwd, f.path);
      });
      return a;
    };
    const wrap = document.createElement("span");
    wrap.className = "facts";
    wrap.append(
      staged ? mk("unstage", "−", "Unstage") : mk("stage", "+", "Stage"),
      mk("discard", "↺", "Discard changes", true),
    );
    acts.push(wrap);

    const st = document.createElement("span");
    st.className = `gst ${f.status}`;
    st.textContent = f.status;
    acts.push(st);

    return this.row(1, {
      icon: icon(f.name, "file"),
      label: f.name,
      title: `${cwd}/${f.path}`,
      trailing: acts,
      onClick: () => {
        this.selected = f.path;
        this.h.openDiff(cwd, f.path, f.name, staged);
        void this.render();
      },
    });
  }

  /** The strip that switches the sidebar between its own tabs. Hidden entirely
   *  when the explorer is the only one, because a single tab is not a choice. */
  private tabs(): HTMLElement | null {
    const bar = document.createElement("div");
    bar.className = "sbtabs";

    const tab = (label: string, on: boolean, pick: () => void, shut?: () => void): void => {
      const b = document.createElement("button");
      b.className = `sbtab${on ? " on" : ""}`;
      b.textContent = label;
      b.title = label;
      b.addEventListener("click", pick);
      if (shut) {
        const x = document.createElement("span");
        x.className = "x";
        x.textContent = "×";
        x.title = `Close ${label}`;
        x.addEventListener("click", (e) => {
          e.stopPropagation();
          shut();
        });
        b.appendChild(x);
      }
      bar.appendChild(b);
    };

    tab("Explorer", this.panel === -1, () => {
      this.panel = -1;
      void this.render();
    });
    if (this.status?.is_repo) {
      const n =
        this.status.conflicts.length + this.status.staged.length + this.status.changes.length;
      tab(`Changes${n ? ` ${n}` : ""}`, this.panel === this.CURRENT, () => {
        this.panel = this.CURRENT;
        void this.render();
      });
    }
    for (const [i, p] of this.panels.entries()) {
      const n = p.status
        ? p.status.conflicts.length + p.status.staged.length + p.status.changes.length
        : 0;
      tab(
        `${p.name}${n ? ` ${n}` : ""}`,
        this.panel === i,
        () => {
          this.panel = i;
          void this.render();
        },
        () => void this.closePanel(i),
      );
    }
    return bar;
  }

  /** One repository's uncommitted files, as its own tab of the sidebar. */
  private changesPanel(frag: HTMLElement): void {
    const p =
      this.panel === this.CURRENT
        ? { cwd: this.cwd, name: base(this.cwd), status: this.status }
        : this.panels[this.panel];
    if (!p) return;
    const st = p.status;

    const bar = document.createElement("div");
    bar.className = "scbar";
    const ic = document.createElement("span");
    ic.className = "ic";
    ic.textContent = "⑂";
    const bn = st?.branch
      ? this.branchChip(p.cwd, p.name, st.branch)
      : document.createElement("span");
    if (!st?.branch) bn.textContent = "detached";
    const ab = document.createElement("span");
    ab.className = "ab";
    ab.textContent = [st?.ahead ? `↑${st.ahead}` : "", st?.behind ? `↓${st.behind}` : ""]
      .filter(Boolean)
      .join(" ");
    bar.append(ic, bn, ab);
    frag.appendChild(bar);

    if (!st) {
      const l = document.createElement("div");
      l.className = "sgh";
      l.textContent = "reading…";
      frag.appendChild(l);
      return;
    }

    const total = st.conflicts.length + st.staged.length + st.changes.length;
    const group = (label: string, files: GitFile[], staged: boolean, cls = "") => {
      if (!files.length) return;
      const h = document.createElement("div");
      h.className = `sgh ${cls}`;
      const t = document.createElement("span");
      t.textContent = label;
      const n = document.createElement("span");
      n.className = "n";
      n.textContent = String(files.length);
      h.append(t, n);
      frag.appendChild(h);
      for (const f of files) frag.appendChild(this.gitRow(f, staged, p.cwd));
    };
    group("Merge conflicts", st.conflicts, false, "conf");
    group("Staged changes", st.staged, true);
    group("Changes", st.changes, false);

    if (!total) {
      const e = document.createElement("div");
      e.className = "sgh";
      e.textContent = "working tree clean";
      frag.appendChild(e);
      return;
    }

    // Reading what an agent changed and then accepting it is one thought, and
    // leaving for a shell to type the second half of it is the seam this app is
    // meant to close. Staged only, no amend, no push: everything past "record
    // what I just read" is still a conversation for the pane below.
    if (!st.staged.length) return;
    const box = document.createElement("div");
    box.className = "cmt";
    const msg = document.createElement("input");
    msg.type = "text";
    msg.spellcheck = false;
    msg.placeholder = `Commit ${st.staged.length} staged ${st.staged.length === 1 ? "file" : "files"}`;
    const go = document.createElement("button");
    go.className = "askbtn primary";
    go.textContent = "Commit";
    const say = document.createElement("div");
    say.className = "cmtnote";

    const run = async (): Promise<void> => {
      const message = msg.value.trim();
      if (!message) {
        say.textContent = "A commit needs a message.";
        return;
      }
      go.disabled = true;
      say.textContent = "committing…";
      try {
        await invoke<string>("git_commit", { cwd: p.cwd, message });
        msg.value = "";
        say.textContent = "";
        await this.refresh();
      } catch (e) {
        // Git's own refusal, which names the hook or the empty index.
        say.textContent = String(e);
        go.disabled = false;
      }
    };
    msg.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key !== "Enter") return;
      e.preventDefault();
      void run();
    });
    go.addEventListener("click", () => void run());
    box.append(msg, go);
    frag.append(box, say);
  }

  async render(): Promise<void> {
    const frag = document.createElement("div");

    const head = document.createElement("div");
    head.className = "treehead";
    const hp = document.createElement("span");
    hp.textContent = await shortPath(this.cwd);
    const spacer = document.createElement("span");
    spacer.className = "thsp";
    head.append(hp, spacer);
    if (this.project?.has_claude || this.project?.has_agents) {
      const ok = document.createElement("span");
      ok.className = "ok2";
      ok.textContent = this.project.has_claude ? ".claude ✓" : ".agents ✓";
      head.appendChild(ok);
    }

    // Nothing here polls, deliberately: a `git status` per repo on a timer is
    // how a fast terminal becomes a battery drain nobody attributes to it. The
    // cost of that choice is that a change made outside Marlin, by an agent in
    // another window or a rebase in another terminal, sits there looking
    // current. This is the button that says otherwise. It is labelled rather
    // than drawn as a glyph, because a circular arrow in a corner is a guess.
    const refresh = document.createElement("button");
    refresh.className = "thbtn";
    refresh.textContent = "Refresh";
    refresh.title = "Rescan this folder and its git status";
    refresh.addEventListener("click", (e) => {
      e.stopPropagation();
      refresh.disabled = true;
      refresh.textContent = "Refreshing…";
      void this.refresh();
    });
    head.appendChild(refresh);
    frag.appendChild(head);

    const strip = this.tabs();
    if (strip) frag.appendChild(strip);

    // One tab or the other, never both: the changes list is the whole reason
    // that tab exists, and the explorer is one click away in the strip above.
    if (this.panel >= 0) {
      this.changesPanel(frag);
      this.el.replaceChildren(...Array.from(frag.children));
      return;
    }

    frag.appendChild(
      this.section("Explorer", this.explorerOpen, null, () => {
        this.explorerOpen = !this.explorerOpen;
        void this.render();
      }),
    );
    if (this.explorerOpen) await this.tree(this.cwd, 0, frag);

    this.el.replaceChildren(...Array.from(frag.children));
  }
}

async function shortPath(p: string): Promise<string> {
  if (!p) return "";
  try {
    return await invoke<string>("fs_display", { path: p });
  } catch {
    return p;
  }
}


function base(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}

function dirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i > 0 ? p.slice(0, i) : p;
}
