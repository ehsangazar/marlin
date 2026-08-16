export interface MenuItem {
  label?: string;
  key?: string;
  run?: () => void;
  sep?: boolean;
  head?: string;
}

/** One context menu for the whole app. Right-click is the discovery surface for
 *  everything that has no dedicated key. */
class ContextMenu {
  private el: HTMLDivElement;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "ctx";
    document.body.appendChild(this.el);
    document.addEventListener("mousedown", (e) => {
      if (!this.el.contains(e.target as Node)) this.hide();
    });
    document.addEventListener("scroll", () => this.hide(), true);
    window.addEventListener("blur", () => this.hide());
  }

  hide(): void {
    this.el.classList.remove("on");
  }

  show(x: number, y: number, items: MenuItem[]): void {
    this.el.replaceChildren();
    for (const it of items) {
      if (it.sep) {
        this.el.appendChild(document.createElement("hr"));
        continue;
      }
      if (it.head) {
        const h = document.createElement("div");
        h.className = "hd";
        h.textContent = it.head;
        this.el.appendChild(h);
        continue;
      }
      const b = document.createElement("button");
      const l = document.createElement("span");
      l.textContent = it.label ?? "";
      const k = document.createElement("span");
      k.className = "sc";
      k.textContent = it.key ?? "";
      b.append(l, k);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        this.hide();
        it.run?.();
      });
      this.el.appendChild(b);
    }
    this.el.classList.add("on");
    // Flip near the edges rather than running off screen.
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    this.el.style.left = `${Math.min(x, window.innerWidth - w - 8)}px`;
    this.el.style.top = `${Math.min(y, window.innerHeight - h - 8)}px`;
  }
}

export const menu = new ContextMenu();
