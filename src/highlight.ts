/**
 * A deliberately small syntax highlighter.
 *
 * Not shiki, not highlight.js. Those are 100KB-plus for a read-only preview in
 * a program whose entire argument is weight. This covers comments, strings,
 * numbers and keywords across the languages actually in this repo, and it is
 * honest about being approximate rather than pretending to parse.
 */
type Rule = { re: RegExp; cls: string };

const KEYWORDS =
  "\\b(fn|let|mut|pub|use|mod|impl|struct|enum|trait|match|if|else|for|while|loop|return|const|static|async|await|move|where|self|Self|crate|dyn|type|as|in|ref|unsafe|" +
  "function|var|class|extends|interface|import|export|from|default|new|typeof|instanceof|throw|try|catch|finally|switch|case|break|continue|do|yield|delete|void|" +
  "def|elif|lambda|None|True|False|and|or|not|pass|raise|with|global|nonlocal|" +
  "null|undefined|true|false|this|super|readonly|private|protected|public|abstract|implements|namespace|declare|satisfies|keyof|infer|never|unknown|any|string|number|boolean)\\b";

const RULES: Rule[] = [
  { re: /(\/\/[^\n]*|#[^\n]*|--[^\n]*)/g, cls: "hl-com" },
  { re: /(\/\*[\s\S]*?\*\/)/g, cls: "hl-com" },
  { re: /('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`)/g, cls: "hl-str" },
  { re: /\b(0x[0-9a-fA-F]+|\d+\.?\d*)\b/g, cls: "hl-num" },
  { re: new RegExp(KEYWORDS, "g"), cls: "hl-kw" },
];

const EXT_OK = new Set([
  "rs", "ts", "tsx", "js", "jsx", "py", "go", "toml", "json", "css", "sh",
  "zsh", "fish", "yml", "yaml", "c", "h", "cpp", "java", "rb", "php", "sql",
]);

export function canHighlight(name: string): boolean {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return !!m?.[1] && EXT_OK.has(m[1].toLowerCase());
}

/**
 * Returns a DocumentFragment rather than an HTML string: building markup by
 * concatenation is how a file viewer becomes an injection bug, and terminal
 * output is untrusted by definition.
 */
export function highlight(code: string): DocumentFragment {
  const marks: { start: number; end: number; cls: string }[] = [];
  for (const { re, cls } of RULES) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code))) {
      const start = m.index;
      const end = start + m[0].length;
      // First rule wins, so a keyword inside a string stays a string.
      if (marks.some((x) => start < x.end && end > x.start)) continue;
      marks.push({ start, end, cls });
    }
  }
  marks.sort((a, b) => a.start - b.start);

  const frag = document.createDocumentFragment();
  let at = 0;
  for (const mk of marks) {
    if (mk.start > at) frag.appendChild(document.createTextNode(code.slice(at, mk.start)));
    const s = document.createElement("span");
    s.className = mk.cls;
    s.textContent = code.slice(mk.start, mk.end);
    frag.appendChild(s);
    at = mk.end;
  }
  if (at < code.length) frag.appendChild(document.createTextNode(code.slice(at)));
  return frag;
}
