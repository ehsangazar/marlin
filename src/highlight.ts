import hljs from "highlight.js/lib/core";

import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import graphql from "highlight.js/lib/languages/graphql";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import lua from "highlight.js/lib/languages/lua";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import nginx from "highlight.js/lib/languages/nginx";
import perl from "highlight.js/lib/languages/perl";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

/**
 * Real per-language grammars, not a regex approximation.
 *
 * The hand-rolled version this replaced highlighted `type` as a keyword inside
 * a YAML file, because it had one keyword list for every language. That is the
 * failure mode of approximate highlighting and it is visible immediately.
 *
 * `highlight.js/lib/core` plus an explicit language list, so only these ship:
 * the full auto-detect build registers 190 languages and is not worth the
 * weight for a read-only preview.
 */
const LANGS: Record<string, unknown> = {
  bash, c, cpp, csharp, css, diff, dockerfile, go, graphql, ini, java,
  javascript, json, kotlin, lua, makefile, markdown, nginx, perl, php,
  python, ruby, rust, scss, shell, sql, swift, typescript, xml, yaml,
};

for (const [name, def] of Object.entries(LANGS)) {
  hljs.registerLanguage(name, def as never);
}
hljs.registerAliases(["toml"], { languageName: "ini" });
hljs.registerAliases(["zsh", "fish", "sh"], { languageName: "bash" });
hljs.registerAliases(["yml"], { languageName: "yaml" });
hljs.registerAliases(["html", "htm", "svg", "vue"], { languageName: "xml" });
hljs.registerAliases(["ts", "tsx", "mts", "cts"], { languageName: "typescript" });
hljs.registerAliases(["js", "jsx", "mjs", "cjs"], { languageName: "javascript" });
hljs.registerAliases(["py"], { languageName: "python" });
hljs.registerAliases(["rs"], { languageName: "rust" });
hljs.registerAliases(["md", "mdx"], { languageName: "markdown" });
hljs.registerAliases(["rb"], { languageName: "ruby" });
hljs.registerAliases(["kt"], { languageName: "kotlin" });
hljs.registerAliases(["cs"], { languageName: "csharp" });
hljs.registerAliases(["cc", "hpp", "hh", "cxx"], { languageName: "cpp" });
hljs.registerAliases(["h"], { languageName: "c" });
hljs.registerAliases(["patch"], { languageName: "diff" });
hljs.registerAliases(["conf", "cfg", "properties", "editorconfig"], { languageName: "ini" });

/** Files whose name carries the language, not the extension. */
const BY_NAME: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  gemfile: "ruby",
  rakefile: "ruby",
  ".zshrc": "bash",
  ".bashrc": "bash",
  ".profile": "bash",
  ".gitignore": "ini",
  ".env": "ini",
};

export function languageFor(name: string): string | null {
  const lower = name.toLowerCase();
  if (BY_NAME[lower]) return BY_NAME[lower] as string;
  const m = /\.([a-z0-9]+)$/i.exec(lower);
  const ext = m?.[1];
  if (!ext) return null;
  return hljs.getLanguage(ext) ? ext : null;
}

export function canHighlight(name: string): boolean {
  return languageFor(name) !== null;
}

/**
 * highlight.js escapes its input, so its output is safe to set as HTML. That is
 * not true of anything assembled by hand, which is why the previous version
 * built nodes instead.
 */
export function highlightTo(el: HTMLElement, code: string, name: string): void {
  const lang = languageFor(name);
  if (!lang) {
    el.textContent = code;
    return;
  }
  try {
    el.innerHTML = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch {
    el.textContent = code;
  }
}
