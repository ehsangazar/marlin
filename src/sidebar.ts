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
}

/**
 * The explorer, source control, and the workspace view for a directory that
 * holds several repositories, which a working directory usually is.
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
  private reposOpen = true;
  private scOpen = true;
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
    } catch {
      this.project = null;
      this.status = null;
    }
    await this.render();
  }

  select(path: string): void {
    this.selected = path;
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

  private section(label: string, open: boolean, count: number | null, toggle: () => void): HTMLElement {
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
    for (const e of entries) {
      const open = this.expanded.has(e.path);
      into.appendChild(
        this.row(depth, {
          twisty: e.dir ? (open ? "▾" : "▸") : "",
          icon: icon(e.name, e.dir ? "dir" : "file", open),
          label: e.name,
          cls: e.dir ? "dir" : "",
          title: e.path,
          isDir: e.dir,
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

  private gitRow(f: GitFile, staged: boolean): HTMLElement {
    const acts: HTMLElement[] = [];
    const mk = (id: "stage" | "unstage" | "discard", glyph: string, tip: string, danger = false) => {
      const a = document.createElement("span");
      a.className = `fact${danger ? " dz" : ""}`;
      a.textContent = glyph;
      a.title = tip;
      a.addEventListener("click", (e) => {
        e.stopPropagation();
        this.h.gitAction(id, this.cwd, f.path);
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
      title: f.path,
      trailing: acts,
      onClick: () => {
        this.selected = f.path;
        this.h.openDiff(this.cwd, f.path, f.name, staged);
        void this.render();
      },
    });
  }

  async render(): Promise<void> {
    const frag = document.createElement("div");

    const head = document.createElement("div");
    head.className = "treehead";
    const hp = document.createElement("span");
    hp.textContent = await shortPath(this.cwd);
    head.appendChild(hp);
    if (this.project?.has_claude || this.project?.has_agents) {
      const ok = document.createElement("span");
      ok.className = "ok2";
      ok.textContent = this.project.has_claude ? ".claude ✓" : ".agents ✓";
      head.appendChild(ok);
    }
    frag.appendChild(head);

    // A directory holding several repositories is a workspace, and treating it
    // as one project is wrong about the most common case.
    const repos = this.project?.repos ?? [];
    if (repos.length > 1 && !this.project?.is_repo) {
      frag.appendChild(
        this.section("Repositories", this.reposOpen, repos.length, () => {
          this.reposOpen = !this.reposOpen;
          void this.render();
        }),
      );
      if (this.reposOpen) {
        for (const r of repos) {
          frag.appendChild(
            this.row(0, {
              icon: icon(r, "repo"),
              cls: "repo",
              label: r,
              title: `${this.cwd}/${r}`,
              isDir: true,
              onClick: () => void this.setCwd(`${this.cwd}/${r}`),
            }),
          );
        }
      }
    }

    frag.appendChild(
      this.section("Explorer", this.explorerOpen, null, () => {
        this.explorerOpen = !this.explorerOpen;
        void this.render();
      }),
    );
    if (this.explorerOpen) await this.tree(this.cwd, 0, frag);

    const st = this.status;
    if (st?.is_repo) {
      const total = st.conflicts.length + st.staged.length + st.changes.length;
      frag.appendChild(
        this.section("Source Control", this.scOpen, total, () => {
          this.scOpen = !this.scOpen;
          void this.render();
        }),
      );
      if (this.scOpen) {
        const bar = document.createElement("div");
        bar.className = "scbar";
        const ic = document.createElement("span");
        ic.className = "ic";
        ic.textContent = "⑂";
        const bn = document.createElement("span");
        bn.textContent = st.branch || "detached";
        const ab = document.createElement("span");
        ab.className = "ab";
        ab.textContent = [st.ahead ? `↑${st.ahead}` : "", st.behind ? `↓${st.behind}` : ""]
          .filter(Boolean)
          .join(" ");
        bar.append(ic, bn, ab);
        frag.appendChild(bar);

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
          for (const f of files) frag.appendChild(this.gitRow(f, staged));
        };

        group("Merge conflicts", st.conflicts, false, "conf");
        group("Staged changes", st.staged, true);
        group("Changes", st.changes, false);

        if (!total) {
          const e = document.createElement("div");
          e.className = "sgh";
          e.textContent = "working tree clean";
          frag.appendChild(e);
        }
      }
    }

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


function dirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i > 0 ? p.slice(0, i) : p;
}
