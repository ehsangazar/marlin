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
 * A file or diff surface. **A file opens ready to type in.**
 *
 * The old arrangement made editing a mode you had to ask for, on the reasoning
 * that highlighted markup is not editable text and highlighting while typing
 * needs CodeMirror or Monaco at 200KB-plus. The first half is true; the
 * conclusion was not. A textarea with transparent text, sitting exactly on top
 * of a highlighted `<pre>` of the same string, is both at once: the browser
 * does the editing, highlight.js does the colour, and the only thing that has
 * to be right is that the two agree on metrics down to the pixel. That is what
 * `.vcode > *` enforces in the stylesheet, and it is why the font, size, line
 * height, padding and tab size are declared in one place for both layers.
 *
 * Re-highlighting is throttled to a frame and skipped entirely above
 * [`HL_LIMIT`], because the point of the overlay is that typing stays as fast
 * as a textarea: colour is allowed to arrive late, but a keystroke is not.
 */

/**
 * Files above this are edited without highlighting.
 *
 * highlight.js is O(n) in a way that is fine for a source file and not fine for
 * a bundle or a log: at a megabyte it costs more than a frame, and a highlight
 * that costs more than a frame is felt as the editor stuttering. Plain text is
 * the right trade there, and the badge says so rather than leaving you to
 * wonder why the colour went away.
 */
const HL_LIMIT = 400_000;
export class Viewer {
  readonly el: HTMLDivElement;
  name: string;
  readonly kind: "file" | "diff";
  private path: string;
  private cwd: string;
  private staged: boolean;
  /** Set when this diff is a branch against HEAD rather than the working tree.
   *  A viewer with a rev is read-only by nature: there is no file on disk to
   *  save it back to. */
  private rev: string;
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
  private hl: HTMLPreElement | null = null;
  private gutter: HTMLPreElement | null = null;
  private hlPending = 0;

  constructor(opts: {
    kind: "file" | "diff";
    name: string;
    path: string;
    cwd?: string;
    staged?: boolean;
    rev?: string;
    mode?: DiffMode;
    onMode?: (m: DiffMode) => void;
    onClose?: () => void;
  }) {
    this.kind = opts.kind;
    this.name = opts.name;
    this.path = opts.path;
    this.cwd = opts.cwd ?? "";
    this.staged = opts.staged ?? false;
    this.rev = opts.rev ?? "";
    this.mode = opts.mode ?? "unified";
    this.onMode = opts.onMode;
    this.onClose = opts.onClose;
    // A file opens editable. Clicking a file to read it and then having to ask
    // for permission to fix the typo you came to fix is a mode you pay for
    // every time and benefit from never.
    this.editing = this.kind === "file";

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
    badge.textContent =
      this.kind === "diff"
        ? // Which diff this is, since a branch diff and a working-tree diff look
          // identical once they are rendered and mean very different things.
          this.rev
          ? `${this.rev} vs HEAD`
          : this.staged
            ? "staged diff"
            : "diff"
        : !this.editing
          ? "read-only"
          : this.original.length > HL_LIMIT
            ? "editing, too big to highlight"
            : "editing";
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

      // Save is always present while editing, and says which of the two things
      // it means: there is something to write, or there is not. A button that
      // vanishes when it has nothing to do is a button you go looking for.
      const save = document.createElement("button");
      save.className = `vbtn${this.dirty ? " primary" : ""}`;
      save.textContent = this.dirty ? "Save" : "Saved";
      save.title = this.dirty ? "Save this file (⌘S)" : "No unsaved changes";
      save.disabled = !this.dirty || !this.editing;
      save.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.save();
      });
      tools.appendChild(save);

      const edit = document.createElement("button");
      edit.className = "vbtn";
      edit.textContent = this.editing ? "Read only" : "Edit";
      edit.title = this.editing
        ? "Stop editing and show it highlighted (⌘E)"
        : "Edit this file (⌘E)";
      edit.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.setEditing(!this.editing);
      });
      tools.appendChild(edit);
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
        const raw = this.rev
          ? await invoke<string>("git_rev_diff", {
              cwd: this.cwd,
              rev: this.rev,
              path: this.path,
            })
          : await invoke<string>("git_diff", {
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

  private lineCount = 0;

  /** The gutter is rebuilt only when the number of lines actually changes,
   *  because typing inside one line is the common case and renumbering on every
   *  keystroke would be the most expensive thing in the editor. */
  private setGutter(n: number): void {
    if (!this.gutter || n === this.lineCount) return;
    this.lineCount = n;
    this.gutter.textContent = Array.from({ length: n }, (_, i) => String(i + 1)).join("\n");
  }

  /** Colour arrives on the next frame, and only the last request in a frame is
   *  honoured: typing must never wait for highlight.js. */
  private scheduleHighlight(): void {
    if (!this.hl || !this.area) return;
    cancelAnimationFrame(this.hlPending);
    this.hlPending = requestAnimationFrame(() => {
      if (!this.hl || !this.area) return;
      const text = this.area.value;
      const plain = text.length > HL_LIMIT;
      this.hl.parentElement?.classList.toggle("plain", plain);
      if (plain) return;
      highlightTo(this.hl, text, this.name);
    });
  }

  private renderFile(content: string): void {
    const wrap = document.createElement("div");
    // Editing fills the pane and scrolls inside itself; reading lets the pane
    // scroll the whole document, which is what a reader expects.
    wrap.className = `vfilewrap${this.editing ? " editing" : ""}`;

    const gutter = document.createElement("pre");
    gutter.className = "vgutter";
    this.gutter = gutter;
    this.lineCount = 0;
    this.setGutter(content.split("\n").length);
    wrap.appendChild(gutter);

    if (!this.editing) {
      const pre = document.createElement("pre");
      pre.className = "vfile hljs";
      highlightTo(pre, content, this.name);
      this.area = null;
      this.hl = null;
      wrap.appendChild(pre);
      this.body.replaceChildren(wrap);
      return;
    }

    // Two layers, one string. The `<pre>` is the colour and is inert; the
    // textarea is the caret, the selection, undo, IME and every other thing a
    // browser already does properly, with its own text painted transparent so
    // only the layer underneath is seen.
    const code = document.createElement("div");
    code.className = "vcode";

    const hl = document.createElement("pre");
    hl.className = "vhl hljs";
    hl.setAttribute("aria-hidden", "true");

    const area = document.createElement("textarea");
    area.className = "vedit";
    area.spellcheck = false;
    area.autocapitalize = "off";
    area.autocomplete = "off";
    area.setAttribute("autocorrect", "off");
    area.value = content;
    area.setAttribute("aria-label", `Edit ${this.name}`);

    this.area = area;
    this.hl = hl;

    area.addEventListener("input", () => {
      this.setGutter(area.value.split("\n").length);
      this.scheduleHighlight();
      // Length first: a keystroke almost always changes it, and comparing two
      // lengths is free where comparing two megabyte strings is not.
      const nowDirty =
        area.value.length !== this.original.length || area.value !== this.original;
      if (nowDirty !== this.dirty) {
        this.dirty = nowDirty;
        this.renderHead();
      }
    });

    area.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void this.save();
        return;
      }
      // Tab indents rather than leaving the editor. Leaving on Tab is correct
      // for a form and wrong for a code editor, and this is a code editor.
      if (e.key === "Tab") {
        e.preventDefault();
        const { selectionStart: s, selectionEnd: t } = area;
        area.setRangeText("  ", s, t, "end");
        area.dispatchEvent(new Event("input"));
        return;
      }
      // Everything else stays here: the terminal's key handler must not see
      // typing meant for this box.
      e.stopPropagation();
    });

    // One scroll position for three layers.
    //
    // Scrolled, not transformed. Both of the other layers are fixed-size boxes
    // with their overflow hidden, so a transform moves the box itself off the
    // screen and takes the text with it. Setting scrollTop moves the content
    // inside the box, which is the thing that has to match.
    area.addEventListener("scroll", () => {
      hl.scrollTop = area.scrollTop;
      hl.scrollLeft = area.scrollLeft;
      gutter.scrollTop = area.scrollTop;
    });

    code.append(hl, area);
    wrap.appendChild(code);
    this.body.replaceChildren(wrap);
    this.scheduleHighlight();
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
