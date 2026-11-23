/**
 * What `zoroval detect` reads out of a Python file, without Python. The Python CLI uses `ast`; this is
 * a tokenizer plus the same rules, so a Python project gets the same report from either CLI.
 *
 * It reports what `_PyScan` reports: imports, LLM calls, web framework / tracing signals, routes,
 * conversation-id candidates (keyword arguments, parameters, attributes, string subscripts) and the
 * `if __name__ == ...` guard. Known differences from `ast`: a file with a syntax error is still scanned
 * (`ast.parse` would skip it) and calls written inside f-string braces are not seen.
 */

export const CHAT_ID_NAMES = [
  "conversation_id", "session_id", "chat_id", "thread_id", "conversationId", "sessionId", "chatId", "threadId",
  "dialog_id", "room_id",
];
const CHAT_IDS = new Set(CHAT_ID_NAMES);

export const LLM_CALLS: Record<string, string> = {
  "chat.completions.create": "openai", "chat.completions.parse": "openai", "chat.completions.stream": "openai",
  "responses.create": "openai", "responses.parse": "openai", "responses.stream": "openai",
  "messages.create": "anthropic", "messages.stream": "anthropic", "messages.parse": "anthropic",
};

const KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif",
  "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal", "not", "or",
  "pass", "raise", "return", "try", "while", "with", "yield",
]);

type Kind = "name" | "str" | "num" | "op" | "nl";
interface Tok {
  k: Kind;
  v: string;
  line: number;
  /** For strings: the prefix letters (`r`, `b`, `f`, ...). */
  prefix?: string;
}

const OPS2 = new Set(["==", "!=", "<=", ">=", "->", ":=", "**", "//", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "@=", "<<", ">>", "..."]);
const NAME_START = /[\p{L}_]/u;
const NAME_PART = /[\p{L}\p{N}_]/u;

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let line = 1;
  let depth = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === "\n") {
      if (depth === 0 && out.length && out[out.length - 1]!.k !== "nl") out.push({ k: "nl", v: "", line });
      line++;
      i++;
    } else if (c === " " || c === "\t" || c === "\r" || c === "\f") i++;
    else if (c === "\\" && (src[i + 1] === "\n" || (src[i + 1] === "\r" && src[i + 2] === "\n"))) {
      i += src[i + 1] === "\r" ? 3 : 2;
      line++;
    } else if (c === "#") {
      while (i < n && src[i] !== "\n") i++;
    } else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const start = i;
      while (i < n && /[0-9A-Za-z_.]/.test(src[i]!)) i++;
      out.push({ k: "num", v: src.slice(start, i), line });
    } else if (NAME_START.test(c)) {
      const start = i;
      while (i < n && NAME_PART.test(src[i]!)) i++;
      const word = src.slice(start, i);
      if (/^[rRbBuUfF]{1,2}$/.test(word) && (src[i] === '"' || src[i] === "'")) {
        i = readString(src, i, line, out, word.toLowerCase());
        line = out.length ? lastLine(out) : line;
      } else out.push({ k: "name", v: word, line });
    } else if (c === '"' || c === "'") {
      i = readString(src, i, line, out, "");
      line = lastLine(out);
    } else {
      const two = src.slice(i, i + 3) === "..." ? "..." : src.slice(i, i + 2);
      const op = OPS2.has(two) ? two : c;
      if (op === "(" || op === "[" || op === "{") depth++;
      else if (op === ")" || op === "]" || op === "}") depth = Math.max(0, depth - 1);
      out.push({ k: "op", v: op, line });
      i += op.length;
    }
  }
  return out;
}

/** Strings can span lines; keep the line counter in step through a hidden marker on the token. */
const endLines = new WeakMap<Tok, number>();
function lastLine(toks: Tok[]): number {
  const t = toks[toks.length - 1]!;
  return endLines.get(t) ?? t.line;
}

function readString(src: string, start: number, line: number, out: Tok[], prefix: string): number {
  const q = src[start]!;
  const triple = src.startsWith(q.repeat(3), start);
  let i = start + (triple ? 3 : 1);
  let value = "";
  let l = line;
  const close = triple ? q.repeat(3) : q;
  while (i < src.length) {
    if (src.startsWith(close, i)) {
      i += close.length;
      break;
    }
    const c = src[i]!;
    if (c === "\\") {
      value += src.slice(i, i + 2);
      if (src[i + 1] === "\n") l++;
      i += 2;
      continue;
    }
    if (c === "\n") {
      l++;
      if (!triple) break; // unterminated: stop at the line end
    }
    value += c;
    i++;
  }
  const tok: Tok = { k: "str", v: value, line, prefix };
  endLines.set(tok, l);
  out.push(tok);
  return i;
}

export interface PyScan {
  imports: Set<string>;
  calls: [number, string][]; // [line, "provider:api"]
  signals: [number, string][];
  chatIds: [number, string][];
  hasMain: boolean;
}

interface Event {
  order: number; // insertion order, the last tie-break
  start: number; // token index where the node starts: pre-order = ascending start, outer first
  rank: number;
  line: number;
  apply(): void;
}

function matchBrackets(toks: Tok[]): Int32Array {
  const match = new Int32Array(toks.length).fill(-1);
  const stack: number[] = [];
  toks.forEach((t, i) => {
    if (t.k !== "op") return;
    if (t.v === "(" || t.v === "[" || t.v === "{") stack.push(i);
    else if (t.v === ")" || t.v === "]" || t.v === "}") {
      const open = stack.pop();
      if (open !== undefined) {
        match[open] = i;
        match[i] = open;
      }
    }
  });
  return match;
}

export function scanPython(source: string): PyScan {
  const toks = tokenize(source);
  const match = matchBrackets(toks);
  const result: PyScan = { imports: new Set(), calls: [], signals: [], chatIds: [], hasMain: false };
  const events: Event[] = [];
  const isName = (i: number) => i >= 0 && toks[i]!.k === "name" && !KEYWORDS.has(toks[i]!.v);
  const isOp = (i: number, v: string) => i >= 0 && i < toks.length && toks[i]!.k === "op" && toks[i]!.v === v;

  /** Index of the first token of the expression that ends at token `i` (a name, `)` or `]`). */
  const leftmost = (i: number): number => {
    let idx = i;
    for (;;) {
      const t = toks[idx]!;
      let before = idx - 1;
      if (t.k === "op" && (t.v === ")" || t.v === "]")) {
        const open = match[idx]!;
        if (open < 0) return idx;
        before = open - 1;
        idx = open;
        // a call or subscript continues the expression to its left
        if (isName(before) || isOp(before, ")") || isOp(before, "]")) {
          idx = before;
          continue;
        }
        return open;
      }
      if (isOp(before, ".") && (isName(before - 1) || isOp(before - 1, ")") || isOp(before - 1, "]"))) {
        idx = before - 1;
        continue;
      }
      return idx;
    }
  };

  /** Python's `_dotted`: `a.b.c`, `get()` for a call result, "" for anything else. */
  const dotted = (i: number): string => {
    const parts: string[] = [];
    let idx = i;
    for (;;) {
      const t = toks[idx];
      if (!t) break;
      if (t.k === "name" && !KEYWORDS.has(t.v)) {
        parts.push(t.v);
        if (isOp(idx - 1, ".") && idx - 2 >= 0) {
          const base = idx - 2;
          if (isName(base)) {
            idx = base;
            continue;
          }
          if (isOp(base, ")")) {
            const open = match[base]!;
            parts.push(open > 0 ? dotted(open - 1) + "()" : "()");
          }
        }
        break;
      }
      if (t.k === "op" && t.v === ")") {
        const open = match[idx]!;
        parts.push(open > 0 ? dotted(open - 1) + "()" : "()");
      }
      break;
    }
    return parts.reverse().join(".");
  };

  // ---- statements: imports, decorators, def, main guard
  const pendingDecorators: string[] = [];
  let lineStart = 0;
  for (let i = 0; i <= toks.length; i++) {
    if (i < toks.length && toks[i]!.k !== "nl") continue;
    const first = lineStart;
    const stmt = toks.slice(first, i);
    lineStart = i + 1;
    if (stmt.length) statement(stmt, first);
  }

  function statement(stmt: Tok[], firstIndex: number): void {
    const head = stmt[0]!;
    if (head.k === "op" && head.v === "@") {
      // decorator: the dotted name, with or without a call
      let name = "";
      let j = 1;
      while (j < stmt.length && stmt[j]!.k === "name") {
        name += stmt[j]!.v;
        if (stmt[j + 1]?.k === "op" && stmt[j + 1]!.v === ".") {
          name += ".";
          j += 2;
        } else break;
      }
      pendingDecorators.push(name);
      return;
    }
    if (head.k !== "name") return;
    if (head.v === "import") importStatement(stmt);
    else if (head.v === "from") fromStatement(stmt);
    else if (head.v === "def" || (head.v === "async" && stmt[1]?.v === "def")) {
      defStatement(stmt, firstIndex + (head.v === "async" ? 1 : 0));
    } else if (head.v === "class") pendingDecorators.length = 0;
    else if ((head.v === "if" || head.v === "elif") && stmt[1]?.v === "__name__" && stmt[2] &&
      ((stmt[2].k === "op" && ["==", "!=", "<", ">", "<=", ">="].includes(stmt[2].v)) ||
        (stmt[2].k === "name" && ["in", "is", "not"].includes(stmt[2].v)))) {
      result.hasMain = true;
    }
    // a statement after `;` or a one-line suite (`if x: import y`) is rare enough to leave out
  }

  function dottedName(stmt: Tok[], from: number): [string, number] {
    let name = "";
    let j = from;
    while (stmt[j]?.k === "name") {
      name += stmt[j]!.v;
      if (stmt[j + 1]?.k === "op" && stmt[j + 1]!.v === ".") {
        name += ".";
        j += 2;
      } else {
        j++;
        break;
      }
    }
    return [name, j];
  }

  function importStatement(stmt: Tok[]): void {
    let j = 1;
    for (;;) {
      const [name, next] = dottedName(stmt, j);
      if (name) result.imports.add(name);
      j = next;
      if (stmt[j]?.v === "as") j += 2;
      if (stmt[j]?.k === "op" && stmt[j]!.v === ",") j++;
      else break;
    }
  }

  function fromStatement(stmt: Tok[]): void {
    let j = 1;
    while (stmt[j]?.k === "op" && (stmt[j]!.v === "." || stmt[j]!.v === "...")) j++;
    const [module, next] = dottedName(stmt, j);
    if (stmt[next]?.v !== "import" || !module) return; // `from . import x` has no module
    result.imports.add(module);
    let k = next + 1;
    if (stmt[k]?.v === "(") k++;
    while (k < stmt.length) {
      const t = stmt[k]!;
      if (t.k === "name" || (t.k === "op" && t.v === "*")) result.imports.add(`${module}.${t.v}`);
      else if (t.k === "op" && t.v === ")") break;
      k++;
      if (stmt[k]?.v === "as") k += 2;
      if (stmt[k]?.k === "op" && stmt[k]!.v === ",") k++;
      else break;
    }
  }

  function defStatement(stmt: Tok[], defIndex: number): void {
    const defTok = toks[defIndex]!;
    const line = defTok.line;
    const nameIdx = defIndex + 1;
    const fname = toks[nameIdx]?.v ?? "";
    const open = nameIdx + 1;
    const decorators = pendingDecorators.splice(0);
    const sigs: [number, string][] = [];
    for (const name of decorators) {
      const last = name.slice(name.lastIndexOf(".") + 1);
      if (last === "observe") sigs.push([line, "langfuse_observe"]);
      else if (last === "traceable") sigs.push([line, "langsmith_traceable"]);
      else if (["get", "post", "put", "route", "websocket", "api_route"].includes(last)) sigs.push([line, `route:${fname}`]);
    }
    const names: string[] = [];
    if (isOp(open, "(") && match[open]! > 0) {
      const params: Tok[][] = [[]];
      let depth = 0;
      for (let j = open + 1; j < match[open]!; j++) {
        const t = toks[j]!;
        if (t.k === "op" && ["(", "[", "{"].includes(t.v)) depth++;
        else if (t.k === "op" && [")", "]", "}"].includes(t.v)) depth--;
        if (depth === 0 && t.k === "op" && t.v === ",") params.push([]);
        else params[params.length - 1]!.push(t);
      }
      for (const p of params) {
        const head = p[0];
        if (!head) continue;
        if (head.k === "op" && head.v === "/") names.length = 0; // positional-only parameters are not in `args.args`
        else if (head.k === "name") names.push(head.v); // `*args`, `**kw` and a bare `*` start with an operator: skipped
      }
    }
    if ((fname === "lambda_handler" || fname === "handler") && names[0] === "event" && names[1] === "context") {
      sigs.push([line, "lambda_handler"]);
    }
    events.push({
      order: events.length, start: defIndex, rank: 0, line,
      apply() {
        for (const s of sigs) result.signals.push(s);
        for (const a of names) if (CHAT_IDS.has(a)) result.chatIds.push([line, a]);
      },
    });
  }

  // ---- expressions: calls, attributes, subscripts
  const isDefOrClassParen = (parenIdx: number): boolean => {
    const nameIdx = parenIdx - 1;
    const before = toks[nameIdx - 1];
    return before?.k === "name" && (before.v === "def" || before.v === "class");
  };

  toks.forEach((t, i) => {
    if (t.k !== "op") return;
    if (t.v === "(") {
      const p = i - 1;
      const callable = isName(p) || isOp(p, ")") || isOp(p, "]");
      if (!callable || (isName(p) && isDefOrClassParen(i))) return;
      const name = dotted(p);
      const start = leftmost(p);
      const line = toks[start]!.line;
      const last = name.slice(name.lastIndexOf(".") + 1);
      const sigs: [number, string][] = [];
      const calls: [number, string][] = [];
      for (const [suffix, provider] of Object.entries(LLM_CALLS)) if (name.endsWith(suffix)) calls.push([line, `${provider}:${suffix}`]);
      if (["FastAPI", "Flask", "Starlette", "Quart", "Sanic", "Litestar"].includes(last)) sigs.push([line, `web_app:${last}`]);
      else if (last === "TracerProvider") sigs.push([line, "otel_provider"]);
      else if (last === "set_tracer_provider") sigs.push([line, "otel_set_provider"]);
      else if (last === "load_dotenv") sigs.push([line, "dotenv"]);
      else if (name.endsWith("Traceloop.init")) sigs.push([line, "traceloop_init"]);
      else if (last === "register" && name.includes("phoenix")) sigs.push([line, "phoenix_register"]);
      else if (last === "instrument" && name.includes("Instrumentor")) sigs.push([line, `instrumentor:${name}`]);
      else if ((last === "Langfuse" || last === "get_client") && name.toLowerCase().includes("langfuse")) sigs.push([line, "langfuse_client"]);
      else if (last === "Celery") sigs.push([line, "celery"]);
      const kwargs: string[] = [];
      const close = match[i]!;
      if (close > i) {
        let depth = 0;
        for (let j = i + 1; j < close; j++) {
          const a = toks[j]!;
          if (a.k === "op" && ["(", "[", "{"].includes(a.v)) depth++;
          else if (a.k === "op" && [")", "]", "}"].includes(a.v)) depth--;
          else if (depth === 0 && a.k === "name" && isOp(j + 1, "=") && (isOp(j - 1, "(") || isOp(j - 1, ",")) && CHAT_IDS.has(a.v)) {
            kwargs.push(a.v);
          }
        }
      }
      events.push({
        order: events.length, start, rank: 0, line,
        apply() {
          for (const c of calls) result.calls.push(c);
          for (const s of sigs) result.signals.push(s);
          for (const k of kwargs) result.chatIds.push([line, k]);
        },
      });
      return;
    }
    if (t.v === "." && isName(i + 1) && CHAT_IDS.has(toks[i + 1]!.v) && (isName(i - 1) || isOp(i - 1, ")") || isOp(i - 1, "]"))) {
      const start = leftmost(i - 1);
      const line = toks[start]!.line;
      const attr = toks[i + 1]!.v;
      events.push({ order: events.length, start, rank: 1, line, apply: () => void result.chatIds.push([line, attr]) });
      return;
    }
    if (t.v === "[" && (isName(i - 1) || isOp(i - 1, ")") || isOp(i - 1, "]"))) {
      const key = toks[i + 1];
      if (key?.k === "str" && !/[bf]/.test(key.prefix ?? "") && CHAT_IDS.has(key.v) && isOp(i + 2, "]")) {
        const start = leftmost(i - 1);
        const line = toks[start]!.line;
        events.push({ order: events.length, start, rank: 1, line, apply: () => void result.chatIds.push([line, key.v]) });
      }
    }
  });

  // Pre-order: earlier start first; at the same start the outer node (the later bracket) first.
  events.sort((a, b) => a.start - b.start || a.rank - b.rank || b.order - a.order);
  for (const e of events) e.apply();
  return result;
}
