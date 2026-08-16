import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

/**
 * Desktop notifications.
 *
 * Two sources, and no others. A program can ask for one through an escape
 * sequence, and Marlin adds exactly one rule of its own: a long command that
 * finished in a pane you were not looking at. Notifying about anything you can
 * already see is how a notification becomes noise, and noise gets muted.
 */
class Notifier {
  private allowed: boolean | null = null;
  enabled = true;

  private async permit(): Promise<boolean> {
    if (this.allowed !== null) return this.allowed;
    try {
      let ok = await isPermissionGranted();
      if (!ok) ok = (await requestPermission()) === "granted";
      this.allowed = ok;
    } catch {
      this.allowed = false;
    }
    return this.allowed;
  }

  async send(title: string, body: string): Promise<void> {
    if (!this.enabled) return;
    // If the window is focused you can already see it. Sending anyway is the
    // fastest way to teach someone to turn notifications off.
    if (document.hasFocus()) return;
    if (!(await this.permit())) return;
    try {
      sendNotification({ title, body });
    } catch {
      /* denied at the OS level */
    }
  }
}

export const notifier = new Notifier();
