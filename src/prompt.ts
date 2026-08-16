/**
 * A small modal input.
 *
 * Exists because `window.prompt` is blocked in Tauri's webview: it returns
 * without showing anything, so renaming silently did nothing. Anything that
 * relies on a browser dialog has to be built rather than borrowed here.
 */
export function ask(title: string, value: string): Promise<string | null> {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "ask on";

    const box = document.createElement("div");
    box.className = "askbox";

    const h = document.createElement("div");
    h.className = "asktitle";
    h.textContent = title;

    const input = document.createElement("input");
    input.type = "text";
    input.value = value;
    input.spellcheck = false;

    const hint = document.createElement("div");
    hint.className = "askhint";
    hint.textContent = "↩ to rename · esc to cancel · empty to hand the name back to the shell";

    box.append(h, input, hint);
    wrap.appendChild(box);
    document.body.appendChild(wrap);

    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      wrap.remove();
      resolve(v);
    };

    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        finish(input.value);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(null);
      }
    });
    wrap.addEventListener("mousedown", (e) => {
      if (e.target === wrap) finish(null);
    });

    input.focus();
    input.select();
  });
}

/**
 * A confirm dialog.
 *
 * Built rather than borrowed for the same reason `ask` is: `window.confirm` is
 * blocked in Tauri's webview and returns without showing anything, so a
 * "confirm before quitting" built on it would quit without confirming.
 */
export function confirm(opts: {
  title: string;
  body: string;
  ok: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "ask on";

    const box = document.createElement("div");
    box.className = "askbox confirm";

    const h = document.createElement("div");
    h.className = "asktitle strong";
    h.textContent = opts.title;

    const b = document.createElement("div");
    b.className = "askbody";
    b.textContent = opts.body;

    const row = document.createElement("div");
    row.className = "askrow";
    const cancel = document.createElement("button");
    cancel.className = "askbtn";
    cancel.textContent = "Cancel";
    const ok = document.createElement("button");
    ok.className = `askbtn primary${opts.danger ? " danger" : ""}`;
    ok.textContent = opts.ok;
    row.append(cancel, ok);

    box.append(h, b, row);
    wrap.appendChild(box);
    document.body.appendChild(wrap);

    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      wrap.remove();
      window.removeEventListener("keydown", key, true);
      resolve(v);
    };
    function key(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        finish(true);
      }
    }
    // Capture, so the terminal's own key handler never sees these.
    window.addEventListener("keydown", key, true);
    cancel.addEventListener("click", () => finish(false));
    ok.addEventListener("click", () => finish(true));
    wrap.addEventListener("mousedown", (e) => {
      if (e.target === wrap) finish(false);
    });
    // Cancel is focused, not the destructive button: a stray Return should not
    // be the thing that closes someone's session.
    cancel.focus();
  });
}
