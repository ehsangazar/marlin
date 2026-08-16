import { THEMES, type MarlinTheme } from "./theme";

export interface Config {
  theme: string;
  fontSize: number;
  scrollback: number;
  cursorBlink: boolean;
  tree: boolean;
  diffSplit: boolean;
}

export const DEFAULTS: Config = {
  theme: "Marlin Dark",
  fontSize: 13,
  scrollback: 2000,
  // Off by default. A blinking cursor repaints forever, and "idle costs
  // nothing" is the claim this project is built on.
  cursorBlink: false,
  tree: true,
  diffSplit: false,
};

const KEY = "marlin.config";

export function load(): Config {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Config>) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

export function save(c: Config): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    /* private mode, or a full disk. Not worth failing over. */
  }
}

/**
 * One screen, grouped, no tabs and no search box, and every switch that costs
 * something says what it costs. The count is not the constraint: the moment
 * anything is added a count breaks, and it broke within an hour last time.
 */
export class Settings {
  private el: HTMLDivElement;
  private cfg: Config;
  private onChange: (c: Config) => void;

  constructor(cfg: Config, onChange: (c: Config) => void) {
    this.cfg = cfg;
    this.onChange = onChange;
    this.el = document.createElement("div");
    this.el.className = "sheet";
    this.el.addEventListener("mousedown", (e) => {
      if (e.target === this.el) this.close();
    });
    document.body.appendChild(this.el);
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

  private commit(patch: Partial<Config>): void {
    this.cfg = { ...this.cfg, ...patch };
    save(this.cfg);
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

    body.appendChild(this.group("Appearance"));

    const sel = document.createElement("select");
    for (const t of THEMES) {
      const o = document.createElement("option");
      o.textContent = t.name;
      o.selected = t.name === this.cfg.theme;
      sel.appendChild(o);
    }
    sel.addEventListener("change", () => this.commit({ theme: sel.value }));
    body.appendChild(this.row("Theme", null, sel));

    const size = document.createElement("input");
    size.type = "number";
    size.min = "8";
    size.max = "32";
    size.value = String(this.cfg.fontSize);
    size.style.width = "64px";
    size.addEventListener("change", () => this.commit({ fontSize: Number(size.value) || 13 }));
    body.appendChild(this.row("Font size", null, size));

    body.appendChild(
      this.row(
        "Cursor blink",
        "off by default: a blinking cursor repaints forever",
        this.toggle(this.cfg.cursorBlink, () => this.commit({ cursorBlink: !this.cfg.cursorBlink })),
      ),
    );

    body.appendChild(this.group("Layout"));
    body.appendChild(
      this.row("File tree", null, this.toggle(this.cfg.tree, () => this.commit({ tree: !this.cfg.tree }))),
    );
    body.appendChild(
      this.row(
        "Diffs side by side",
        "which one reads better is a property of the change, not of you",
        this.toggle(this.cfg.diffSplit, () => this.commit({ diffSplit: !this.cfg.diffSplit })),
      ),
    );

    body.appendChild(this.group("Terminal"));
    const sb = document.createElement("input");
    sb.type = "number";
    sb.min = "0";
    sb.step = "500";
    sb.value = String(this.cfg.scrollback);
    sb.style.width = "84px";
    sb.addEventListener("change", () => this.commit({ scrollback: Number(sb.value) || 2000 }));
    body.appendChild(
      this.row("Scrollback lines", "2,000 lines is roughly 10 MB per pane", sb),
    );

    card.appendChild(body);

    const note = document.createElement("div");
    note.className = "sheetnote";
    note.textContent =
      "One screen, grouped, no tabs and no search box. Every action is also in ⌘⇧P.";
    card.appendChild(note);

    this.el.replaceChildren(card);
  }
}

export function themeByName(name: string): MarlinTheme {
  return THEMES.find((t) => t.name === name) ?? (THEMES[0] as MarlinTheme);
}
