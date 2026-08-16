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
