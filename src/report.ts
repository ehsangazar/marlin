import { invoke } from "@tauri-apps/api/core";

interface Diagnostics {
  crashed_last_run: boolean;
  log_path: string;
  tail: string;
  version: string;
  os: string;
}

const REPO = "https://github.com/ehsangazar/marlin";

/**
 * How problems reach the author without breaking the no-telemetry promise.
 *
 * Errors are written to a local log. Nothing is transmitted. Reporting is a
 * button that opens a GitHub issue **pre-filled and editable**, so the user
 * sees exactly what they are sending before they send it. That is the whole
 * mechanism, and it is why the promise on the landing page stays literally
 * true rather than approximately true.
 *
 * Terminal output is never logged. Scrollback holds passwords and private
 * source, and a diagnostics file that swallowed it would be a worse liability
 * than the bugs it helps fix.
 */
export class Reporter {
  private errors = 0;
  private onCount: (n: number) => void;

  constructor(onCount: (n: number) => void) {
    this.onCount = onCount;

    window.addEventListener("error", (e) => {
      this.record("ERROR", `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
    });
    window.addEventListener("unhandledrejection", (e) => {
      this.record("REJECT", String((e as PromiseRejectionEvent).reason));
    });

    // A console.error worth reporting is still an error, and swallowing it
    // means the log disagrees with what the developer already saw.
    const orig = console.error.bind(console);
    console.error = (...args: unknown[]) => {
      this.record("CONSOLE", args.map((a) => String(a)).join(" "));
      orig(...args);
    };
  }

  get count(): number {
    return this.errors;
  }

  record(level: string, message: string): void {
    this.errors += 1;
    this.onCount(this.errors);
    void invoke("log_write", { level, message: message.slice(0, 2000) }).catch(() => {});
  }

  async diagnostics(): Promise<Diagnostics | null> {
    try {
      return await invoke<Diagnostics>("log_diagnostics");
    } catch {
      return null;
    }
  }

  /** Open a pre-filled issue. The body is capped so the URL stays valid, and
   *  the user reads it in GitHub before pressing submit. */
  async openIssue(kind: "bug" | "crash" | "feature"): Promise<void> {
    if (kind === "feature") {
      await this.open(
        `${REPO}/issues/new?labels=enhancement&title=${encodeURIComponent("Feature: ")}`,
      );
      return;
    }

    const d = await this.diagnostics();
    const tail = (d?.tail ?? "").split("\n").slice(-40).join("\n").slice(0, 3000);
    const title = kind === "crash" ? "Crash on the previous run" : "Bug: ";
    const body = [
      "**What I did**",
      "",
      "",
      "**What happened**",
      "",
      "",
      "---",
      `Marlin ${d?.version ?? "?"} · ${d?.os ?? "?"}`,
      "",
      "<details><summary>Recent log</summary>",
      "",
      "```",
      tail || "(empty)",
      "```",
      "",
      "</details>",
      "",
      "_This log is from your machine and contains no terminal output. Edit or delete anything before submitting._",
    ].join("\n");

    await this.open(
      `${REPO}/issues/new?labels=${kind}&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`,
    );
  }

  async openLog(): Promise<string> {
    const d = await this.diagnostics();
    return d?.log_path ?? "";
  }

  async clearCrashFlag(): Promise<void> {
    await invoke("log_clear_crash_flag").catch(() => {});
  }

  private async open(url: string): Promise<void> {
    await invoke("open_external", { url }).catch(() => {});
  }
}
