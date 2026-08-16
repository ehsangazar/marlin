import { invoke } from "@tauri-apps/api/core";
import { highlightTo } from "./highlight";
import { menu } from "./menu";

export type DiffMode = "unified" | "split";

interface DiffLine {
  t: " " | "+" | "-" | "@";
  s: string;
}

interface FileDoc {
  content: string;
  stamp: string;
}

/**
 * A file or diff surface. Reading is the default and stays highlighted; editing
 * is an explicit mode.
 *
 * The split is the design decision. Highlighted markup is not editable text, so
 * highlighting *while* typing needs a real editor component (CodeMirror,
 * Monaco) at 200KB-plus. Making editing a mode keeps reading fast and
 * highlighted, keeps writing simple and correct, and costs one keystroke.
 */
export class Viewer {
  readonly el: HTMLDivElement;
  name: string;
  readonly kind: "file" | "diff";
  private path: string;
  private cwd: string;
  private staged: boolean;
  private body = document.createElement("div");
  private head = document.createElement("div");
  private mode: DiffMode;
  private onMode?: (m: DiffMode) => void;
  private onClose?: () => void;

  private editing = false;
  private dirty = false;
  private stamp = "";
  private original = "";
  private area: HTMLTextAreaElement | null = null;

  constructor(opts: {
    kind: "file" | "diff";
    name: string;
    path: string;
    cwd?: string;
    staged?: boolean;
    mode?: DiffMode;
    onMode?: (m: DiffMode) => void;
    onClose?: () => void;
  }) {
    this.kind = opts.kind;
    this.name = opts.name;
    this.path = opts.path;
    this.cwd = opts.cwd ?? "";
    this.staged = opts.staged ?? false;
    this.mode = opts.mode ?? "unified";
    this.onMode = opts.onMode;
    this.onClose = opts.onClose;

    this.el = document.createElement("div");
    this.el.className = "pane-term viewer";
    this.head.className = "vhead";
    this.body.className = "vbody";
    this.el.append(this.head, this.body);

    this.el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      menu.show(e.clientX, e.clientY, this.menuItems());
    });

    this.renderHead();
  }

  private menuItems() {
    if (this.kind === "diff") {
      return [
        { label: "Unified", run: () => this.setDiffMode("unified") },
        { label: "Side by side", run: () => this.setDiffMode("split") },
        { sep: true },
        { label: "Copy Path", run: () => void navigator.clipboard.writeText(this.path) },
        { label: "Close", key: "Esc", run: () => this.onClose?.() },
      ];
    }
    return [
      this.editing
        ? { label: "Stop Editing", key: "⌘E", run: () => void this.setEditing(false) }
        : { label: "Edit This File", key: "⌘E", run: () => void this.setEditing(true) },
      { label: "Save", key: "⌘S", run: () => void this.save() },
      { sep: true },
      { label: "Copy Path", run: () => void navigator.clipboard.writeText(this.path) },
      { label: "Close", key: "Esc", run: () => this.requestClose() },
    ];
  }

  private renderHead(): void {
    this.head.replaceChildren();

    const nm = document.createElement("span");
    nm.className = "vname";
    nm.textContent = this.name;

    const badge = document.createElement("span");
    badge.className = `vbadge${this.editing ? " editing" : ""}`;
    badge.textContent = this.kind === "diff" ? "diff" : this.editing ? "editing" : "read-only";
    this.head.append(nm, badge);

    if (this.dirty) {
      const d = document.createElement("span");
      d.className = "vdirty";
      d.title = "Unsaved changes";
      this.head.appendChild(d);
    }

    if (this.kind === "diff") {
      const seg = document.createElement("span");
      seg.className = "vseg";
      for (const m of ["unified", "split"] as DiffMode[]) {
        const b = document.createElement("button");
        b.textContent = m === "unified" ? "unified" : "side by side";
        b.setAttribute("aria-pressed", this.mode === m ? "true" : "false");
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          this.setDiffMode(m);
        });
        seg.appendChild(b);
      }
      this.head.appendChild(seg);
    } else {
      const tools = document.createElement("span");
      tools.className = "vtools";
      const edit = document.createElement("button");
      edit.className = "vbtn";
      edit.textContent = this.editing ? "done" : "edit";
      edit.title = this.editing ? "Stop editing (⌘E)" : "Edit this file (⌘E)";
      edit.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.setEditing(!this.editing);
      });
      tools.appendChild(edit);
      if (this.editing) {
        const save = document.createElement("button");
        save.className = "vbtn primary";
        save.textContent = "save";
        save.title = "Save (⌘S)";
        save.addEventListener("click", (e) => {
          e.stopPropagation();
          void this.save();
        });
        tools.appendChild(save);
      }
      this.head.appendChild(tools);
    }

    const close = document.createElement("button");
    close.className = "vclose";
    close.textContent = "×";
    close.title = "Close and put the layout back (Esc)";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      this.requestClose();
    });
    this.head.appendChild(close);
  }

  private setDiffMode(m: DiffMode): void {
    this.mode = m;
    this.onMode?.(m);
    this.renderHead();
    void this.load();
  }

  /** Close refuses while there are unsaved changes. Losing an edit to a stray
   *  Escape is unforgivable, and Escape is bound to close. */
  requestClose(): boolean {
    if (this.dirty) {
      this.flash("Unsaved changes. Save with ⌘S first.");
      return false;
    }
    this.onClose?.();
    return true;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  get isEditing(): boolean {
    return this.editing;
  }

  async load(): Promise<void> {
    try {
      if (this.kind === "file") {
        const doc = await invoke<FileDoc>("fs_read_doc", { path: this.path });
        this.stamp = doc.stamp;
        this.original = doc.content;
        this.dirty = false;
        this.renderFile(doc.content);
      } else {
        const raw = await invoke<string>("git_diff", {
          cwd: this.cwd,
          path: this.path,
          staged: this.staged,
        });
        this.renderDiff(parseDiff(raw));
      }
      this.renderHead();
    } catch (e) {
      this.body.replaceChildren(text("verr", String(e)));
    }
  }

  async setEditing(on: boolean): Promise<void> {
    if (this.kind !== "file") return;
    if (!on && this.dirty) {
      this.flash("Unsaved changes. Save with ⌘S first.");
      return;
    }
    this.editing = on;
    this.renderHead();
    this.renderFile(on ? (this.area?.value ?? this.original) : this.original);
    if (on) this.area?.focus();
  }

  async save(): Promise<void> {
    if (this.kind !== "file" || !this.editing) return;
    const content = this.area?.value ?? this.original;
    try {
      const doc = await invoke<FileDoc>("fs_write_doc", {
        path: this.path,
        content,
        expect: this.stamp,
      });
      this.stamp = doc.stamp;
      this.original = doc.content;
      this.dirty = false;
      this.renderHead();
      this.flash("Saved", true);
    } catch (e) {
      this.flash(String(e));
    }
  }

  private flash(msg: string, good = false): void {
    this.el.querySelector(".vflash")?.remove();
    const d = document.createElement("div");
    d.className = `vflash${good ? " good" : ""}`;
    d.textContent = msg;
    this.el.appendChild(d);
    setTimeout(() => d.remove(), 3200);
  }

  private renderFile(content: string): void {
    const wrap = document.createElement("div");
    wrap.className = "vfilewrap";

    const lines = content.split("\n");
    const gutter = document.createElement("pre");
    gutter.className = "vgutter";
    gutter.textContent = lines.map((_, i) => String(i + 1)).join("\n");
    wrap.appendChild(gutter);

    if (this.editing) {
      const area = document.createElement("textarea");
      area.className = "vedit";
      area.spellcheck = false;
      area.value = content;
      area.addEventListener("input", () => {
        const n = area.value.split("\n").length;
        if (n !== (gutter.textContent?.split("\n").length ?? 0)) {
          gutter.textContent = Array.from({ length: n }, (_, i) => String(i + 1)).join("\n");
        }
        const nowDirty = area.value !== this.original;
        if (nowDirty !== this.dirty) {
          this.dirty = nowDirty;
          this.renderHead();
        }
      });
      // The terminal's key handler must not see typing meant for this box.
      area.addEventListener("keydown", (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
          e.preventDefault();
          void this.save();
        }
        e.stopPropagation();
      });
      area.addEventListener("scroll", () => {
        gutter.style.transform = `translateY(${-area.scrollTop}px)`;
      });
      this.area = area;
      wrap.appendChild(area);
    } else {
      const pre = document.createElement("pre");
      pre.className = "vfile hljs";
      highlightTo(pre, content, this.name);
      this.area = null;
      wrap.appendChild(pre);
    }

    this.body.replaceChildren(wrap);
  }

  private renderDiff(lines: DiffLine[]): void {
    if (!lines.length) {
      this.body.replaceChildren(text("vempty", "No changes to show."));
      return;
    }
    if (this.mode === "split") {
      this.body.replaceChildren(this.splitDiff(lines));
      return;
    }
    const pre = document.createElement("pre");
    pre.className = "vdiff";
    for (const l of lines) {
      const span = document.createElement("span");
      span.className =
        l.t === "+" ? "dadd" : l.t === "-" ? "ddel" : l.t === "@" ? "dhun" : "dctx";
      span.textContent = (l.t === "@" ? "" : l.t) + l.s;
      pre.appendChild(span);
    }
    this.body.replaceChildren(pre);
  }

  /** Pair each run of deletions with the run of additions that replaced it and
   *  pad the shorter side. That is all a side-by-side diff actually is. */
  private splitDiff(lines: DiffLine[]): HTMLElement {
    const L: DiffLine[] = [];
    const R: DiffLine[] = [];
    let i = 0;
    while (i < lines.length) {
      const l = lines[i] as DiffLine;
      if (l.t === " " || l.t === "@") {
        L.push(l);
        R.push(l);
        i++;
        continue;
      }
      const dels: DiffLine[] = [];
      const adds: DiffLine[] = [];
      while (i < lines.length && lines[i]!.t === "-") dels.push(lines[i++]!);
      while (i < lines.length && lines[i]!.t === "+") adds.push(lines[i++]!);
      const n = Math.max(dels.length, adds.length);
      for (let k = 0; k < n; k++) {
        L.push(dels[k] ?? { t: " ", s: "" });
        R.push(adds[k] ?? { t: " ", s: "" });
      }
    }

    const wrap = document.createElement("div");
    wrap.className = "dsplit";
    for (const [side, rows] of [["before", L], ["after", R]] as const) {
      const col = document.createElement("div");
      col.className = "dcol";
      const h = document.createElement("div");
      h.className = "dchd";
      h.textContent = side;
      col.appendChild(h);
      const pre = document.createElement("pre");
      pre.className = "vdiff";
      for (const r of rows) {
        const span = document.createElement("span");
        span.className =
          r.t === "+" ? "dadd" : r.t === "-" ? "ddel" : r.t === "@" ? "dhun" : "dctx";
        span.textContent = r.s || " ";
        pre.appendChild(span);
      }
      col.appendChild(pre);
      wrap.appendChild(col);
    }
    return wrap;
  }

  resize(): void {
    /* nothing to reflow: the browser does it */
  }
  focus(): void {
    if (this.editing) this.area?.focus();
    else this.el.focus();
  }
  dispose(): void {
    this.el.remove();
  }
}

function parseDiff(raw: string): DiffLine[] {
  const out: DiffLine[] = [];
  for (const line of raw.split("\n")) {
    if (
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("new file") ||
      line.startsWith("deleted file")
    ) {
      continue;
    }
    if (line.startsWith("@@")) out.push({ t: "@", s: line });
    else if (line.startsWith("+")) out.push({ t: "+", s: line.slice(1) });
    else if (line.startsWith("-")) out.push({ t: "-", s: line.slice(1) });
    else if (line.length) out.push({ t: " ", s: line.slice(1) });
  }
  return out;
}

function text(cls: string, s: string): HTMLElement {
  const d = document.createElement("div");
  d.className = cls;
  d.textContent = s;
  return d;
}
