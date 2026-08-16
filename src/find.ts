import type { Pane } from "./pane";

/**
 * Find in scrollback.
 *
 * The plan called this "the one deferred feature a daily user will genuinely
 * miss", which is exactly why it should not have shipped without it.
 */
export class Find {
  private el: HTMLDivElement;
  private input: HTMLInputElement;
  private count: HTMLSpanElement;
  private pane: Pane | null = null;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "find";
    this.el.innerHTML = `
      <input type="text" placeholder="Find in scrollback…" spellcheck="false" autocomplete="off">
      <span class="fcount"></span>
      <button class="fbtn" data-d="prev" title="Previous (⇧↩)">↑</button>
      <button class="fbtn" data-d="next" title="Next (↩)">↓</button>
      <button class="fbtn" data-d="close" title="Close (Esc)">×</button>`;
    this.input = this.el.querySelector("input") as HTMLInputElement;
    this.count = this.el.querySelector(".fcount") as HTMLSpanElement;

    this.input.addEventListener("input", () => this.run("next", true));
    this.input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") this.close();
      else if (e.key === "Enter") this.run(e.shiftKey ? "prev" : "next", false);
    });
    for (const b of this.el.querySelectorAll<HTMLButtonElement>(".fbtn")) {
      b.addEventListener("click", () => {
        const d = b.dataset.d;
        if (d === "close") this.close();
        else this.run(d === "prev" ? "prev" : "next", false);
      });
    }
    document.body.appendChild(this.el);
  }

  get isOpen(): boolean {
    return this.el.classList.contains("on");
  }

  open(pane: Pane): void {
    this.pane = pane;
    this.el.classList.add("on");
    this.input.select();
    this.input.focus();
    if (this.input.value) this.run("next", true);
  }

  close(): void {
    this.el.classList.remove("on");
    this.pane?.search.clearDecorations();
    this.pane?.focus();
  }

  private run(dir: "next" | "prev", fromStart: boolean): void {
    const q = this.input.value;
    if (!this.pane || !q) {
      this.count.textContent = "";
      this.pane?.search.clearDecorations();
      return;
    }
    const opts = {
      decorations: {
        matchBackground: "#E8B44C",
        matchOverviewRuler: "#E8B44C",
        activeMatchBackground: "#4C8DFF",
        activeMatchColorOverviewRuler: "#4C8DFF",
      },
  };
    const found =
      dir === "next"
        ? this.pane.search.findNext(q, { ...opts, incremental: fromStart })
        : this.pane.search.findPrevious(q, opts);
    this.count.textContent = found ? "" : "no matches";
  }
}
