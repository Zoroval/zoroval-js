/**
 * What `zoroval detect` reads out of a TypeScript or JavaScript file: token based, no TypeScript
 * compiler. Strings, template literals, regular expressions and comments are skipped properly, so a
 * mention of `chat.completions.create(` in a comment or a string is not a call.
 *
 * Reports: OpenAI calls (`.chat.completions.create|parse|stream(`, `.responses.create|parse|stream(`,
 * `fetch(` to an OpenAI chat or responses URL, literal or built from a base variable), conversation-id candidates (parameters, properties, destructured
 * fields), module imports, and Worker entry points (`export default { fetch }`, `addEventListener("fetch")`).
 */

import { CHAT_ID_NAMES } from "./pyscan.js";

const CHAT_IDS = new Set(CHAT_ID_NAMES);

type Kind = "name" | "str" | "num" | "op" | "regex";
interface Tok {
  k: Kind;
  v: string;
  line: number;
}

const REGEX_AFTER_KEYWORD = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
const NAME_START = /[\p{L}_$]/u;
const NAME_PART = /[\p{L}\p{N}_$]/u;

function regexAllowed(prev: Tok | undefined): boolean {
  if (!prev) return true;
  if (prev.k === "op") return ![")", "]", "}"].includes(prev.v);
  if (prev.k === "name") return REGEX_AFTER_KEYWORD.has(prev.v);
  return false;
}

/** Index after a template literal that starts at `start` (the backtick); `${ }` parts are skipped balanced. */
function skipTemplate(src: string, start: number): number {
  let i = start + 1;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "\\") i += 2;
    else if (c === "`") return i + 1;
    else if (c === "$" && src[i + 1] === "{") i = skipBraces(src, i + 1);
    else i++;
  }
  return i;
}

/** Index after the `{ ... }` that starts at `start`, skipping strings, templates and comments inside. */
function skipBraces(src: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    } else if (c === '"' || c === "'") {
      i++;
      while (i < src.length && src[i] !== c && src[i] !== "\n") i += src[i] === "\\" ? 2 : 1;
    } else if (c === "`") {
      i = skipTemplate(src, i) - 1;
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 1;
    }
    i++;
  }
  return i;
}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  const countLines = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (src[k] === "\n") line++;
  };
  if (src.startsWith("#!")) while (i < n && src[i] !== "\n") i++;
  while (i < n) {
    const c = src[i]!;
    if (c === "\n") {
      line++;
      i++;
    } else if (c === " " || c === "\t" || c === "\r" || c === "\f" || c === " " || c === "﻿") i++;
    else if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      countLines(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      const first = line;
      let value = "";
      i++;
      while (i < n && src[i] !== c && src[i] !== "\n") {
        if (src[i] === "\\") {
          value += src.slice(i, i + 2);
          if (src[i + 1] === "\n") line++;
          i += 2;
        } else value += src[i++];
      }
      i++;
      out.push({ k: "str", v: value, line: first });
    } else if (c === "`") {
      const stop = skipTemplate(src, i);
      const first = line;
      out.push({ k: "str", v: src.slice(i + 1, stop - 1), line: first });
      countLines(i, stop);
      i = stop;
    } else if (c === "/" && regexAllowed(out[out.length - 1])) {
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== "\n") {
        if (src[j] === "\\") j += 2;
        else if (src[j] === "[") { inClass = true; j++; }
        else if (src[j] === "]") { inClass = false; j++; }
        else if (src[j] === "/" && !inClass) break;
        else j++;
      }
      if (src[j] === "/") {
        j++;
        while (j < n && /[a-z]/i.test(src[j]!)) j++;
        out.push({ k: "regex", v: "", line });
        i = j;
      } else {
        out.push({ k: "op", v: "/", line });
        i++;
      }
    } else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const start = i;
      while (i < n && /[0-9A-Za-z_.]/.test(src[i]!)) i++;
      out.push({ k: "num", v: src.slice(start, i), line });
    } else if (NAME_START.test(c) || (c === "#" && NAME_START.test(src[i + 1] ?? ""))) {
      const start = i;
      i++;
      while (i < n && NAME_PART.test(src[i]!)) i++;
      out.push({ k: "name", v: src.slice(start, i), line });
    } else {
      const three = src.slice(i, i + 3);
      const two = src.slice(i, i + 2);
      const op = three === "..." ? three : two === "=>" || two === "?." ? two : c;
      out.push({ k: "op", v: op, line });
      i += op.length;
    }
  }
  return out;
}

export interface JsScan {
  /** [line, api], plus for `fetch` the base URL when it is not api.openai.com ("variable" when not literal). */
  llmCalls: [number, string, string?][];
  chatIds: [number, string][];
  imports: Set<string>;
  /** Line of `export default { fetch }` or `addEventListener("fetch", ...)`, if any. */
  workerLine: number | null;
  /** Line of the first exported HTTP handler (`export async function POST`) or default export, if any. */
  handlerLine: number | null;
  /** A command-line program: reads a terminal (`readline`) or `process.argv`. */
  cliMain: boolean;
  /** Web servers created in the file (first of each kind): Express, Hono, Fastify. */
  frameworks: { kind: string; line: number }[];
}

const OPENAI_URL = "api.openai.com/v1/";
// The paths `wrapFetch()` traces. Embeddings are not counted: wrapFetch passes them through untraced.
const OPENAI_PATH = /\/(chat\/completions|responses)\/?(\?.*)?$/;

/** For a URL text (`${...}` where a part is not literal): the base to pass `wrapFetch`, null for api.openai.com, undefined when not an OpenAI call. */
function fetchBase(text: string): string | null | undefined {
  if (text.includes(OPENAI_URL)) return null;
  const path = OPENAI_PATH.exec(text);
  if (!path) return undefined;
  const base = text.slice(0, path.index);
  return /^https?:\/\/[^$]+$/.test(base) ? base : "variable";
}
const CONTROL = new Set(["if", "for", "while", "switch", "catch", "with"]);
const HTTP_VERBS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

export function scanJs(source: string): JsScan {
  const toks = tokenize(source);
  const n = toks.length;
  const match = new Int32Array(n).fill(-1);
  const parent = new Int32Array(n).fill(-1); // the bracket that encloses token i
  const stack: number[] = [];
  toks.forEach((t, i) => {
    parent[i] = stack.length ? stack[stack.length - 1]! : -1;
    if (t.k !== "op") return;
    if (t.v === "(" || t.v === "[" || t.v === "{") stack.push(i);
    else if (t.v === ")" || t.v === "]" || t.v === "}") {
      const open = stack.pop();
      if (open !== undefined) {
        match[open] = i;
        match[i] = open;
        parent[i] = stack.length ? stack[stack.length - 1]! : -1;
      }
    }
  });
  const op = (i: number, ...vs: string[]) => i >= 0 && i < n && toks[i]!.k === "op" && vs.includes(toks[i]!.v);
  const nm = (i: number, v?: string) => i >= 0 && i < n && toks[i]!.k === "name" && (v === undefined || toks[i]!.v === v);
  const dot = (i: number) => op(i, ".", "?.");

  const result: JsScan = { llmCalls: [], chatIds: [], imports: new Set(), workerLine: null, handlerLine: null, cliMain: false, frameworks: [] };

  /** First token of the member chain that ends at token `i` (`a.b().c.d`). */
  const chainStart = (i: number): number => {
    let idx = i;
    for (;;) {
      let before = idx - 1;
      if (op(idx, ")", "]")) {
        const open = match[idx]!;
        if (open < 0) return idx;
        idx = open;
        before = open - 1;
        if (nm(before) || op(before, ")", "]")) {
          idx = before;
          continue;
        }
        return open;
      }
      if (dot(before) && (nm(before - 1) || op(before - 1, ")", "]"))) {
        idx = before - 1;
        continue;
      }
      return idx;
    }
  };

  /** The URL text of an expression from token `from` up to `end`: literal parts kept, the rest `${}`. */
  const urlText = (from: number, end: number): string => {
    let text = "";
    for (let j = from; j < end; j++) {
      const tok = toks[j]!;
      if (tok.k === "str") text += tok.v;
      else if (op(j, "+")) continue;
      else if (!text.endsWith("${}")) text += "${}";
      if (op(j, "(", "[", "{") && match[j]! > j) j = match[j]!;
    }
    return text;
  };
  /** End of the expression that starts at `from`: the first `,` `;` or closing bracket at its level. */
  const exprEnd = (from: number): number => {
    let j = from;
    while (j < n && !op(j, ",", ";", ")", "]", "}")) j = op(j, "(", "[", "{") && match[j]! > j ? match[j]! + 1 : j + 1;
    return j;
  };

  // URLs bound to a name (`const url = "https://api.openai.com/v1/..."`, `` `${base}/chat/completions` ``,
  // `base + "/responses"`), for `fetch(url)`
  const bound = new Map<string, string>();
  for (let i = 0; i + 2 < n; i++) {
    if (nm(i) && op(i + 1, "=") && !op(i + 2, "=", ">") && !dot(i - 1)) {
      const end = exprEnd(i + 2);
      if (end - (i + 2) <= 12 && toks.slice(i + 2, end).some((tok) => tok.k === "str")) bound.set(toks[i]!.v, urlText(i + 2, end));
    }
  }

  for (let i = 0; i < n; i++) {
    const t = toks[i]!;
    // ---- imports
    if (t.k === "name" && t.v === "import") {
      if (toks[i + 1]?.k === "str") result.imports.add(toks[i + 1]!.v); // import "x"
      else if (op(i + 1, "(") && toks[i + 2]?.k === "str") result.imports.add(toks[i + 2]!.v); // import("x")
      else {
        // import ... from "x"
        for (let j = i + 1; j < Math.min(n, i + 400); j++) {
          if (nm(j, "from") && toks[j + 1]?.k === "str") {
            result.imports.add(toks[j + 1]!.v);
            break;
          }
          if (op(j, ";")) break;
        }
      }
    } else if (t.k === "name" && t.v === "require" && op(i + 1, "(") && toks[i + 2]?.k === "str" && !dot(i - 1)) {
      result.imports.add(toks[i + 2]!.v);
    }
    // export ... from "x" re-exports are not usage

    // ---- OpenAI calls
    if (t.k === "name" && dot(i - 1) && op(i + 1, "(")) {
      const m = t.v;
      if ((m === "create" || m === "parse" || m === "stream") && nm(i - 2, "completions") && dot(i - 3) && nm(i - 4, "chat")) {
        result.llmCalls.push([toks[chainStart(i - 4)]!.line, `chat.completions.${m}`]);
      } else if ((m === "create" || m === "parse" || m === "stream") && nm(i - 2, "responses")) {
        result.llmCalls.push([toks[chainStart(i - 2)]!.line, `responses.${m}`]);
      }
    }
    if (t.k === "name" && t.v === "fetch" && op(i + 1, "(") && !(dot(i - 1) && !nm(i - 2, "globalThis") && !nm(i - 2, "window") && !nm(i - 2, "self"))) {
      const arg = toks[i + 2];
      const end = exprEnd(i + 2);
      const url = arg?.k === "name" && end === i + 3 ? bound.get(arg.v) : urlText(i + 2, end);
      const base = url === undefined ? undefined : fetchBase(url);
      if (base !== undefined) result.llmCalls.push(base === null ? [t.line, "fetch"] : [t.line, "fetch", base]);
    }

    // ---- Worker entry points
    if (t.k === "name" && t.v === "export" && nm(i + 1, "default")) {
      result.handlerLine ??= t.line;
      if (op(i + 2, "{") && match[i + 2]! > 0) {
        const close = match[i + 2]!;
        for (let j = i + 3; j < close; j++) {
          if (parent[j] === i + 2 && nm(j, "fetch") && (op(j - 1, "{", ",") || nm(j - 1, "async")) && op(j + 1, "(", ":", ",", "}")) {
            result.workerLine ??= t.line;
          }
        }
      }
    }
    if (t.k === "name" && t.v === "addEventListener" && op(i + 1, "(") && toks[i + 2]?.k === "str" && toks[i + 2]!.v === "fetch") {
      result.workerLine ??= t.line;
    }
    if (t.k === "name" && t.v === "export") {
      let j = i + 1;
      if (nm(j, "async")) j++;
      if (nm(j, "function") && toks[j + 1] && HTTP_VERBS.has(toks[j + 1]!.v)) result.handlerLine ??= t.line;
      else if ((nm(j, "const") || nm(j, "let")) && toks[j + 1] && HTTP_VERBS.has(toks[j + 1]!.v)) result.handlerLine ??= t.line;
    }

    // ---- conversation id candidates
    if (t.k === "name" && CHAT_IDS.has(t.v)) {
      const prev = i - 1;
      const next = i + 1;
      let candidate = false;
      if (dot(prev)) candidate = true; // request.chatId, body?.chatId
      else if (nm(prev, "const") || nm(prev, "let") || nm(prev, "var")) candidate = true; // const chatId = ...
      else if (op(next, "=") && !op(next + 1, "=") && !op(prev, ".", "?")) candidate = true; // chatId = ...
      else if ((op(next, ":") || (op(next, "?") && op(next + 1, ":"))) && !op(prev, "?") && !nm(prev, "case")) {
        candidate = true; // { chatId: x }, (chatId: string), (chatId?: string), an interface member after `;` or a line end
      } else if (op(prev, "{", ",", "(")) {
        if (op(prev, "{", ",") && op(next, "}", ",", "=") && toks[parent[i]!]?.v === "{") candidate = true; // { chatId }, { chatId = 1 }
        else if (op(prev, "(", ",") && op(next, ",", ")", "=") && toks[parent[i]!]?.v === "(") {
          const open = parent[i]!;
          const close = match[open]!;
          const before = toks[open - 1];
          const after = toks[close + 1];
          const controlled = before?.k === "name" && CONTROL.has(before.v);
          if (close > 0 && !controlled && after && ((after.k === "op" && after.v === "=>") ||
            (after.k === "op" && after.v === "{" && (before?.k === "name" || (before?.k === "op" && before.v === ")"))) ||
            (nm(open - 2, "function") || nm(open - 3, "function")))) candidate = true;
        }
      } else if (op(next, "=>") && !op(prev, ".")) candidate = true; // chatId => ...
      if (candidate) result.chatIds.push([t.line, t.v]);
    }
  }
  result.cliMain = [...result.imports].some((m) => /^(node:)?readline(\/promises)?$/.test(m)) ||
    toks.some((t, i) => t.k === "name" && t.v === "process" && dot(i + 1) && nm(i + 2, "argv"));
  // Web servers come last: an import of the package plus the call that creates the app.
  const imported = (...names: string[]) => [...result.imports].some((m) => names.some((n) => m === n || m.startsWith(n + "/")));
  const found = (kind: string, line: number) => {
    if (!result.frameworks.some((f) => f.kind === kind)) result.frameworks.push({ kind, line });
  };
  for (let i = 0; i < n; i++) {
    const t = toks[i]!;
    if (t.k !== "name") continue;
    if (t.v === "express" && op(i + 1, "(") && !dot(i - 1) && imported("express")) found("express", t.line);
    else if ((t.v === "Hono" || t.v === "OpenAPIHono") && nm(i - 1, "new") && imported("hono", "@hono/zod-openapi")) found("hono", t.line);
    else if ((t.v === "Fastify" || t.v === "fastify") && op(i + 1, "(") && !dot(i - 1) && imported("fastify")) found("fastify", t.line);
    else if (t.v === "require" && op(i + 1, "(") && op(i + 3, ")") && op(i + 4, "(") && !dot(i - 1)) {
      // require("fastify")({ ... }) and require("express")(): the call is on the module itself
      const spec = toks[i + 2];
      if (spec?.k === "str" && (spec.v === "express" || spec.v === "fastify")) found(spec.v, t.line);
    }
  }
  const seen = new Set<string>();
  result.chatIds = result.chatIds.filter(([line, name]) => !seen.has(`${line}:${name}`) && !!seen.add(`${line}:${name}`));
  return result;
}
