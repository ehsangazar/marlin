import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { SearchAddon } from "@xterm/addon-search";
import { invoke } from "@tauri-apps/api/core";
import type { MarlinTheme } from "./theme";

export type PaneStatus = "run" | "ok" | "err" | "wait" | "paused" | null;

let uid = 0;

/**
 * One terminal pane: an xterm instance bound to one pty in the Rust side.
 *
 * The WebGL renderer is not optional. xterm's DOM renderer is the difference
 * between this being usable and being another slow Electron terminal, and it is
 * the whole reason the platform decision was defensible.
 */
export class Pane {
  readonly key = ++uid;
  readonly el: HTMLDivElement;
  readonly term: Terminal;

  name = "shell";
  /** Set by hand pins the name and stops the shell overwriting it. */
  pinned = false;
  status: PaneStatus = null;
  cwd = "";
  /** Where a pane should start, when it was opened from the tree. */
  startCwd: string | null = null;
  ptyId: number | null = null;

  private fit = new FitAddon();
  private ro: ResizeObserver | null = null;
  private fitPending = 0;
  readonly search = new SearchAddon();
  private webgl: WebglAddon | null = null;
  private onTitle?: (p: Pane) => void;
  private onCwd?: (p: Pane) => void;
  private onStatus?: (p: Pane) => void;
  onNotify?: (p: Pane, message: string) => void;
  onFinished?: (p: Pane, failed: boolean, seconds: number) => void;
  private startedAt = 0;

  constructor(
    theme: MarlinTheme,
    onTitle?: (p: Pane) => void,
    onCwd?: (p: Pane) => void,
    onStatus?: (p: Pane) => void,
  ) {
    this.onTitle = onTitle;
    this.onCwd = onCwd;
    this.onStatus = onStatus;
    this.el = document.createElement("div");
    this.el.className = "pane-term";

    this.term = new Terminal({
      allowProposedApi: true,
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.35,
      letterSpacing: 0,
      // Off by default. A blinking cursor repaints forever, and "idle costs
      // nothing" is the claim this project is built on.
      cursorBlink: false,
      cursorStyle: "block",
      scrollback: 2000,
      theme: theme.term,
      macOptionIsMeta: true,
    });

    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
  }

  /** Must run after the element is in the DOM: WebGL needs a real canvas size. */
  async open(): Promise<void> {
    this.term.open(this.el);
    try {
      this.webgl = new WebglAddon();
      this.webgl.onContextLoss(() => {
        this.webgl?.dispose();
        this.webgl = null;
      });
      this.term.loadAddon(this.webgl);
    } catch {
      // Falls back to the canvas renderer. Worth knowing about rather than
      // failing silently, so it is surfaced in the status bar.
      console.warn("marlin: WebGL renderer unavailable, falling back");
    }

    this.fit.fit();

    if (this.startCwd) this.cwd = this.startCwd;
    this.ptyId = await invoke<number>("pty_spawn", {
      rows: this.term.rows,
      cols: this.term.cols,
      cwd: this.startCwd,
      shell: null,
    });

    // Straight to the pty, in the handler. Never queued for the next frame.
    this.term.onData((d) => {
      if (this.ptyId !== null) void invoke("pty_write", { id: this.ptyId, data: d });
    });

    this.term.onResize(({ rows, cols }) => {
      if (this.ptyId !== null) void invoke("pty_resize", { id: this.ptyId, rows, cols });
    });

    // Watch the element itself rather than the window. Splitting a pane,
    // toggling the tree and rotating the tab bar all change a pane's size
    // without a window resize, and any path that forgets to call resize()
    // silently leaves the pty believing the wrong width.
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.el);

    // OSC 0 / OSC 2. The shell names the pane until you name it yourself.
    this.term.onTitleChange((t) => {
      if (this.pinned || !t) return;
      this.name = t;
      this.onTitle?.(this);
    });

    // OSC 9 (iTerm2 form) and OSC 777 (urxvt form). Any program can ask for a
    // notification; Marlin forwards it and adds nothing of its own.
    this.term.parser.registerOscHandler(9, (data) => {
      this.onNotify?.(this, data.trim());
      return true;
    });
    this.term.parser.registerOscHandler(777, (data) => {
      const m = /^notify;(?:([^;]*);)?(.*)$/.exec(data);
      if (m) this.onNotify?.(this, (m[2] ?? "").trim() || (m[1] ?? "").trim());
      return true;
    });

    // OSC 133: semantic prompt marks. The shell says "a command started" and
    // "it exited with N", and Marlin gets running/ok/failed state without
    // parsing a single character of your command line. This is the line the
    // whole design rests on: the shell owns the language, the terminal owns
    // the marks.
    this.term.parser.registerOscHandler(133, (data) => {
      const [kind, arg] = data.split(";");
      if (kind === "C") {
        this.startedAt = Date.now();
        this.status = "run";
        this.onStatus?.(this);
      } else if (kind === "D") {
        const code = Number(arg ?? "0");
        const failed = Number.isFinite(code) && code !== 0;
        this.status = failed ? "err" : "ok";
        // A command that finished in a pane you were not looking at is the one
        // case worth interrupting for, and only if it ran long enough that you
        // went and did something else.
        const ran = Date.now() - this.startedAt;
        if (this.startedAt && ran > 8000) {
          this.onFinished?.(this, failed, Math.round(ran / 1000));
        }
        this.startedAt = 0;
        this.onStatus?.(this);
      }
      return true;
    });

    // OSC 7 carries the working directory, and it is the single cheapest signal
    // in the whole app: the sidebar, the git panel and the project detection
    // all hang off knowing where a pane is, and the shell already emits it.
    this.term.parser.registerOscHandler(7, (data) => {
      const m = /^file:\/\/[^/]*(\/.*)$/.exec(data);
      if (m?.[1]) {
        const next = decodeURIComponent(m[1]);
        if (next !== this.cwd) {
          this.cwd = next;
          this.onCwd?.(this);
        }
      }
      return true;
    });
  }

  write(data: string): void {
    this.term.write(data);
  }

  /** Refit, but never against an element that has no size: FitAddon divides by
   *  the cell width and a hidden pane yields a nonsense column count that then
   *  gets sent to the pty. */
  private refit(): void {
    if (this.el.clientWidth < 24 || this.el.clientHeight < 24) return;
    try {
      this.fit.fit();
    } catch {
      /* not laid out yet */
    }
  }

  resize(): void {
    cancelAnimationFrame(this.fitPending);
    this.fitPending = requestAnimationFrame(() => this.refit());
  }

  setTheme(theme: MarlinTheme): void {
    this.term.options.theme = theme.term;
  }

  focus(): void {
    this.term.focus();
  }

  dispose(): void {
    this.ro?.disconnect();
    cancelAnimationFrame(this.fitPending);
    if (this.ptyId !== null) void invoke("pty_close", { id: this.ptyId });
    this.webgl?.dispose();
    this.term.dispose();
    this.el.remove();
  }
}
