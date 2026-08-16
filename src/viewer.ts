import { invoke } from "@tauri-apps/api/core";

export type DiffMode = "unified" | "split";

interface DiffLine {
  t: " " | "+" | "-" | "@";
  s: string;
}

/**
 * A read-only surface: a file preview or a diff.
 *
 * It satisfies the same shape as a terminal pane, so the layout tree does not
 * need to know which it is holding.
 */
export class Viewer {
  readonly el: HTMLDivElement;
  name: string;
  readonly kind: "file" | "diff";
  private path: string;
  private cwd: string;
  private staged: boolean;
  private body = document.createElement("div");
  private mode: DiffMode;
  private onMode?: (m: DiffMode) => void;

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

    this.el = document.createElement("div");
    this.el.className = "pane-term viewer";

    const head = document.createElement("div");
    head.className = "vhead";
    const nm = document.createElement("span");
    nm.className = "vname";
    nm.textContent = opts.name;
    const badge = document.createElement("span");
    badge.className = "vbadge";
    badge.textContent = opts.kind === "diff" ? "diff" : "read-only";
    head.append(nm, badge);

    if (opts.kind === "diff") {
      const seg = document.createElement("span");
      seg.className = "vseg";
      for (const m of ["unified", "split"] as DiffMode[]) {
        const b = document.createElement("button");
        b.textContent = m === "unified" ? "unified" : "side by side";
        b.setAttribute("aria-pressed", this.mode === m ? "true" : "false");
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          this.mode = m;
          this.onMode?.(m);
          void this.load();
        });
        seg.appendChild(b);
      }
      head.appendChild(seg);
    }

    const close = document.createElement("button");
    close.className = "vclose";
    close.textContent = "×";
    close.title = "Close and put the layout back (Esc)";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      opts.onClose?.();
    });
    head.appendChild(close);

    this.body.className = "vbody";
    this.el.append(head, this.body);
  }

  async load(): Promise<void> {
    try {
      if (this.kind === "file") {
        const text = await invoke<string>("fs_read", { path: this.path });
        this.renderFile(text);
      } else {
        const raw = await invoke<string>("git_diff", {
          cwd: this.cwd,
          path: this.path,
          staged: this.staged,
        });
        this.renderDiff(parseDiff(raw));
      }
    } catch (e) {
      this.body.replaceChildren(text("verr", String(e)));
    }
  }

  private renderFile(content: string): void {
    const pre = document.createElement("pre");
    pre.className = "vfile";
    const lines = content.split("\n");
    const width = String(lines.length).length;
    pre.textContent = lines
      .map((l, i) => `${String(i + 1).padStart(width, " ")}  ${l}`)
      .join("\n");
    this.body.replaceChildren(pre);
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
    this.el.focus();
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
