import { THEMES, type MarlinTheme } from "./theme";
import { configPath, save, type Config } from "./config";

/**
 * One screen, grouped, no tabs and no search box, and every switch that costs
 * something says what it costs.
 *
 * The count is not the constraint: a count breaks the moment anything is added,
 * and it did. What holds is the shape.
 *
 * Second rule, learned the hard way: **only expose what actually does
 * something.** A panel full of toggles that quietly do nothing is worse than a
 * small one, because it teaches people the app lies.
 */
export class Settings {
  private el: HTMLDivElement;
  private cfg: Config;
  private onChange: (c: Config) => void;
  private onOpenFile: (path: string, name: string) => void;
  private path = "";

  constructor(
    cfg: Config,
    onChange: (c: Config) => void,
    onOpenFile: (path: string, name: string) => void,
  ) {
    this.cfg = cfg;
    this.onChange = onChange;
    this.onOpenFile = onOpenFile;
    this.el = document.createElement("div");
    this.el.className = "sheet";
    this.el.addEventListener("mousedown", (e) => {
      if (e.target === this.el) this.close();
    });
    document.body.appendChild(this.el);
    void configPath().then((p) => (this.path = p));
  }

  get isOpen(): boolean {
    return this.el.classList.contains("on");
  }
  close(): void {
    this.el.classList.remove("on");
  }
  open(): void {
    this.render();
    this.el.classList.add("on");
  }
  sync(c: Config): void {
    this.cfg = c;
    if (this.isOpen) this.render();
  }

  private commit(patch: Partial<Config>): void {
    this.cfg = { ...this.cfg, ...patch };
    void save(this.cfg);
    this.onChange(this.cfg);
    this.render();
  }

  private row(label: string, cost: string | null, control: HTMLElement): HTMLElement {
    const r = document.createElement("div");
    r.className = "setrow";
    const lab = document.createElement("span");
    lab.className = "slab";
    const t = document.createElement("span");
    t.textContent = label;
    lab.appendChild(t);
    if (cost) {
      const em = document.createElement("em");
      em.textContent = cost;
      lab.appendChild(em);
    }
    r.append(lab, control);
    return r;
  }

  private toggle(on: boolean, onClick: () => void): HTMLElement {
    const b = document.createElement("button");
    b.className = "sw";
    b.setAttribute("aria-pressed", on ? "true" : "false");
    b.addEventListener("click", onClick);
    return b;
  }

  private seg<T extends string>(value: T, opts: [T, string][], pick: (v: T) => void): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "seg";
    for (const [v, label] of opts) {
      const b = document.createElement("button");
      b.textContent = label;
      b.setAttribute("aria-pressed", v === value ? "true" : "false");
      b.addEventListener("click", () => pick(v));
      wrap.appendChild(b);
    }
    return wrap;
  }

  private select(value: string, opts: string[], pick: (v: string) => void): HTMLElement {
    const s = document.createElement("select");
    for (const o of opts) {
      const el = document.createElement("option");
      el.textContent = o;
      el.selected = o === value;
      s.appendChild(el);
    }
    s.addEventListener("change", () => pick(s.value));
    return s;
  }

  private num(value: number, min: number, max: number, step: number, pick: (v: number) => void): HTMLElement {
    const i = document.createElement("input");
    i.type = "number";
    i.value = String(value);
    i.min = String(min);
    i.max = String(max);
    i.step = String(step);
    i.style.width = "78px";
    i.addEventListener("change", () => {
      const n = Number(i.value);
      if (Number.isFinite(n)) pick(Math.min(max, Math.max(min, n)));
    });
    return i;
  }

  private group(label: string): HTMLElement {
    const g = document.createElement("div");
    g.className = "sgrp";
    g.textContent = label;
    return g;
  }

  private render(): void {
    const card = document.createElement("div");
    card.className = "sheetcard";

    const h = document.createElement("h4");
    h.textContent = "Settings";
    const x = document.createElement("button");
    x.className = "vclose";
    x.textContent = "×";
    x.addEventListener("click", () => this.close());
    h.appendChild(x);
    card.appendChild(h);

    const body = document.createElement("div");
    body.className = "sheetbody";
    const c = this.cfg;

    body.appendChild(this.group("Appearance"));
    body.appendChild(
      this.row("Theme", null, this.select(c.theme, THEMES.map((t) => t.name), (v) => this.commit({ theme: v }))),
    );
    body.appendChild(
      this.row(
        "Font",
        "any monospace family installed on this Mac",
        this.select(
          c.fontFamily,
          [
            "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace",
            "Menlo, monospace",
            "JetBrains Mono, monospace",
            "Fira Code, monospace",
            "IBM Plex Mono, monospace",
            "Courier New, monospace",
          ],
          (v) => this.commit({ fontFamily: v }),
        ),
      ),
    );
    body.appendChild(this.row("Font size", null, this.num(c.fontSize, 8, 32, 1, (v) => this.commit({ fontSize: v }))));
    body.appendChild(
      this.row(
        "Cursor",
        null,
        this.seg(c.cursorStyle, [["block", "Block"], ["bar", "Bar"], ["underline", "Underline"]], (v) =>
          this.commit({ cursorStyle: v }),
        ),
      ),
    );
    body.appendChild(
      this.row(
        "Cursor blink",
        "off by default: a blinking cursor repaints forever",
        this.toggle(c.cursorBlink, () => this.commit({ cursorBlink: !c.cursorBlink })),
      ),
    );

    body.appendChild(this.group("Layout"));
    body.appendChild(
      this.row(
        "Tab bar",
        null,
        this.seg(c.tabBar, [["top", "Top"], ["side", "Side"], ["hidden", "Hidden"]], (v) =>
          this.commit({ tabBar: v }),
        ),
      ),
    );
    body.appendChild(
      this.row("File tree", null, this.toggle(c.fileTree, () => this.commit({ fileTree: !c.fileTree }))),
    );
    body.appendChild(
      this.row(
        "Diff view",
        "which reads better is a property of the change, not of you",
        this.seg(c.diffView, [["unified", "Unified"], ["split", "Side by side"]], (v) =>
          this.commit({ diffView: v }),
        ),
      ),
    );

    body.appendChild(this.group("Terminal"));
    body.appendChild(
      this.row(
        "Shell",
        "blank follows $SHELL. Applies to new panes",
        (() => {
          const i = document.createElement("input");
          i.type = "text";
          i.value = c.shell;
          i.placeholder = "$SHELL";
          i.style.width = "150px";
          i.addEventListener("change", () => this.commit({ shell: i.value.trim() }));
          return i;
        })(),
      ),
    );
    body.appendChild(
      this.row(
        "Scrollback lines",
        "2,000 lines is roughly 10 MB per pane",
        this.num(c.scrollback, 0, 100000, 500, (v) => this.commit({ scrollback: v })),
      ),
    );
    body.appendChild(
      this.row(
        "Copy on select",
        null,
        this.toggle(c.copyOnSelect, () => this.commit({ copyOnSelect: !c.copyOnSelect })),
      ),
    );
    body.appendChild(
      this.row(
        "Right click pastes",
        "off by default, so right click keeps its menu",
        this.toggle(c.rightClickPaste, () => this.commit({ rightClickPaste: !c.rightClickPaste })),
      ),
    );

    card.appendChild(body);

    const note = document.createElement("div");
    note.className = "sheetnote";
    const txt = document.createElement("span");
    txt.textContent = "One screen, no tabs. Written to ";
    const link = document.createElement("button");
    link.className = "slink";
    link.textContent = this.path || "marlin.toml";
    link.title = "Open the config file in Marlin";
    link.addEventListener("click", () => {
      this.close();
      this.onOpenFile(this.path, "marlin.toml");
    });
    note.append(txt, link);
    card.appendChild(note);

    this.el.replaceChildren(card);
  }
}

export function themeByName(name: string): MarlinTheme {
  return THEMES.find((t) => t.name === name) ?? (THEMES[0] as MarlinTheme);
}
