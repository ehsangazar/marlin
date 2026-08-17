/**
 * A small modal input.
 *
 * Exists because `window.prompt` is blocked in Tauri's webview: it returns
 * without showing anything, so renaming silently did nothing. Anything that
 * relies on a browser dialog has to be built rather than borrowed here.
 */
/** A dialog button that carries its own shortcut, so the key and the thing it
 *  does are never described in two different places. */
function button(label: string, key: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "askbtn";
  b.textContent = label;
  const k = document.createElement("span");
  k.className = "askkey";
  k.textContent = key;
  b.appendChild(k);
  return b;
}

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
    hint.textContent = "Leave it empty to hand the name back to the shell.";

    // Buttons as well as keys. The keys were only ever written in the hint line,
    // which meant the two ways out of this box were a sentence someone had to
    // read rather than a thing they could click, and the shortcut is on the
    // button so that reading it once is how you learn it.
    const row = document.createElement("div");
    row.className = "askrow";
    const cancel = button("Cancel", "esc");
    const save = button("Save", "↩");
    save.classList.add("primary");
    row.append(cancel, save);

    box.append(h, input, hint, row);
    wrap.appendChild(box);
    document.body.appendChild(wrap);

    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      wrap.remove();
      resolve(v);
    };

    cancel.addEventListener("click", () => finish(null));
    save.addEventListener("click", () => finish(input.value));

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
    // The keys are on whichever button Return would press, and the hint moves
    // with the focus, because a hint that says the wrong thing is worse than
    // none. See the key handler below for why that is not fixed to the primary.
    const cancel = button("Cancel", "esc");
    const ok = button(opts.ok, "");
    ok.classList.add("primary");
    if (opts.danger) ok.classList.add("danger");
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
        return;
      }
      if (e.key !== "Enter") return;
      e.preventDefault();
      e.stopPropagation();
      // Return answers the button that has focus, which is Cancel until you
      // move it. It used to always answer yes while Cancel sat focused and a
      // comment claimed that focus was the safety: one keystroke on a dialog
      // you had not read closed every shell you had open.
      finish(document.activeElement === ok);
    }
    // Capture, so the terminal's own key handler never sees these.
    window.addEventListener("keydown", key, true);
    cancel.addEventListener("click", () => finish(false));
    ok.addEventListener("click", () => finish(true));
    wrap.addEventListener("mousedown", (e) => {
      if (e.target === wrap) finish(false);
    });
    // Cancel is focused, not the destructive button: a stray Return should not
    // be the thing that closes someone's session. Tab reaches the other one,
    // and the ↩ hint follows so it is always on the button Return would press.
    const hint = (): void => {
      cancel.querySelector(".askkey")!.textContent =
        document.activeElement === cancel ? "esc ↩" : "esc";
      ok.querySelector(".askkey")!.textContent = document.activeElement === ok ? "↩" : "";
    };
    cancel.addEventListener("focus", hint);
    ok.addEventListener("focus", hint);
    cancel.focus();
    hint();
  });
}
