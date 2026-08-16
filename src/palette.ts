import { invoke } from "@tauri-apps/api/core";

export type PaletteMode = "cmd" | "file" | "text";

export interface Command {
  label: string;
  key?: string;
  run: () => void;
}

interface Entry {
  name: string;
  path: string;
}

interface Hit {
  path: string;
  name: string;
  line: number;
  text: string;
}

type Item =
  | { kind: "cmd"; cmd: Command }
  | { kind: "file"; name: string; path: string }
  | { kind: "text"; name: string; path: string; line: number; text: string; at: number; len: number };

/**
 * One overlay, three modes: commands, go to file, and search across files.
 *
 * The command list is the registry that also drives the key map, which is what
 * makes "everything is reachable from the keyboard" structural rather than a
 * promise somebody has to keep remembering.
 */
export class Palette {
  private el: HTMLDivElement;
  private input: HTMLInputElement;
  private list: HTMLDivElement;
  private prefix: HTMLSpanElement;
  private mode: PaletteMode = "cmd";
  private items: Item[] = [];
  private sel = 0;
  private commands: Command[] = [];
  private root = "";
  private onOpenFile: (path: string, name: string) => void;
  /** Bumped per keystroke so a slow search cannot overwrite a newer one. */
  private seq = 0;

  constructor(onOpenFile: (path: string, name: string) => void) {
    this.onOpenFile = onOpenFile;

    this.el = document.createElement("div");
    this.el.className = "pal";
    this.el.innerHTML = `
      <div class="palbox">
        <div class="palin"><span class="pfx"></span><input type="text" spellcheck="false" autocomplete="off"></div>
        <div class="palres"></div>
        <div class="palfoot"><span>↑↓ move</span><span>↩ open</span><span>esc close</span></div>
      </div>`;
    this.input = this.el.querySelector("input") as HTMLInputElement;
    this.list = this.el.querySelector(".palres") as HTMLDivElement;
    this.prefix = this.el.querySelector(".pfx") as HTMLSpanElement;

    this.input.addEventListener("input", () => {
      this.sel = 0;
      void this.search();
    });
    this.input.addEventListener("keydown", (e) => this.onKey(e));
    this.el.addEventListener("mousedown", (e) => {
      if (e.target === this.el) this.close();
    });
    document.body.appendChild(this.el);
  }

  setCommands(c: Command[]): void {
    this.commands = c;
  }
  setRoot(r: string): void {
    this.root = r;
  }
  get isOpen(): boolean {
    return this.el.classList.contains("on");
  }

  open(mode: PaletteMode): void {
    this.mode = mode;
    this.sel = 0;
    this.prefix.textContent = mode === "cmd" ? ">" : mode === "file" ? "file" : "text";
    this.input.placeholder =
      mode === "cmd" ? "Run a command…" : mode === "file" ? "Go to file…" : "Search in all files…";
    this.input.value = "";
    this.el.classList.add("on");
    this.input.focus();
    void this.search();
  }

  close(): void {
    this.el.classList.remove("on");
    this.input.blur();
  }

  private onKey(e: KeyboardEvent): void {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      this.close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      this.sel = Math.min(this.sel + 1, this.items.length - 1);
      this.paint();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this.sel = Math.max(this.sel - 1, 0);
      this.paint();
    } else if (e.key === "Enter") {
      e.preventDefault();
      this.pick(this.sel);
    }
  }

  private async search(): Promise<void> {
    const q = this.input.value.trim();
    const ql = q.toLowerCase();
    const mine = ++this.seq;

    if (this.mode === "cmd") {
      this.items = this.commands
        .filter((c) => !ql || c.label.toLowerCase().includes(ql))
        .map((cmd) => ({ kind: "cmd" as const, cmd }));
    } else if (this.mode === "file") {
      try {
        const files = await invoke<Entry[]>("fs_walk", { path: this.root });
        if (mine !== this.seq) return;
        this.items = files
          .filter((f) => !ql || f.name.toLowerCase().includes(ql) || f.path.toLowerCase().includes(ql))
          .slice(0, 60)
          .map((f) => ({ kind: "file" as const, name: f.name, path: f.path }));
      } catch {
        this.items = [];
      }
    } else {
      if (!q) {
        this.items = [];
      } else {
        try {
          const hits = await invoke<Hit[]>("fs_grep", { path: this.root, query: q });
          if (mine !== this.seq) return;
          this.items = hits.slice(0, 60).map((h) => {
            const at = h.text.toLowerCase().indexOf(ql);
            return {
              kind: "text" as const,
              name: h.name,
              path: h.path,
              line: h.line,
              text: h.text,
              at: at < 0 ? 0 : at,
              len: q.length,
            };
          });
        } catch {
          this.items = [];
        }
      }
    }
    this.paint();
  }

  private paint(): void {
    if (!this.items.length) {
      const e = document.createElement("div");
      e.className = "pres empty";
      e.textContent =
        this.mode === "cmd"
          ? "No command matches"
          : this.mode === "file"
            ? "No files match"
            : this.input.value
              ? "No matches in any file"
              : "Type to search every file in the project";
      this.list.replaceChildren(e);
      return;
    }

    const rows = this.items.map((it, i) => {
      const b = document.createElement("div");
      b.className = `pres${i === this.sel ? " on" : ""}`;
      if (it.kind === "cmd") {
        b.append(span("", it.cmd.label), span("pth", it.cmd.key ?? "palette only"));
      } else if (it.kind === "file") {
        b.append(span("", it.name), span("pth", it.path));
      } else {
        b.appendChild(span("ln", `${it.name}:${it.line}`));
        const t = document.createElement("span");
        t.append(
          document.createTextNode(it.text.slice(0, it.at)),
          mark(it.text.slice(it.at, it.at + it.len)),
          document.createTextNode(it.text.slice(it.at + it.len)),
        );
        b.appendChild(t);
      }
      b.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.pick(i);
      });
      return b;
    });
    this.list.replaceChildren(...rows);
    rows[this.sel]?.scrollIntoView({ block: "nearest" });
  }

  private pick(i: number): void {
    const it = this.items[i];
    if (!it) return;
    this.close();
    if (it.kind === "cmd") it.cmd.run();
    else this.onOpenFile(it.path, it.name);
  }
}

function span(cls: string, s: string): HTMLSpanElement {
  const e = document.createElement("span");
  if (cls) e.className = cls;
  e.textContent = s;
  return e;
}

function mark(s: string): HTMLElement {
  const m = document.createElement("mark");
  m.textContent = s;
  return m;
}
