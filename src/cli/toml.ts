/**
 * A small TOML reader for the two files the CLI looks at (`wrangler.toml`, `pyproject.toml`): tables,
 * arrays of tables, dotted keys, strings, numbers, booleans, arrays and inline tables. Dates are kept
 * as strings. Anything it cannot read returns `null`, and the caller carries on without that file.
 */

export type TomlValue = string | number | boolean | TomlValue[] | { [key: string]: TomlValue };
export type TomlTable = { [key: string]: TomlValue };

class Reader {
  pos = 0;
  constructor(readonly src: string) {}

  eof(): boolean {
    return this.pos >= this.src.length;
  }

  peek(offset = 0): string {
    return this.src[this.pos + offset] ?? "";
  }

  startsWith(s: string): boolean {
    return this.src.startsWith(s, this.pos);
  }

  slice(from: number, to: number = this.pos): string {
    return this.src.slice(from, to);
  }

  indexOf(s: string): number {
    return this.src.indexOf(s, this.pos);
  }

  skipSpaces(): void {
    while (this.peek() === " " || this.peek() === "\t") this.pos++;
  }

  /** Spaces, newlines and comments (inside arrays and between lines). */
  skipBlank(): void {
    for (;;) {
      const c = this.peek();
      if (c === " " || c === "\t" || c === "\n" || c === "\r") this.pos++;
      else if (c === "#") while (!this.eof() && this.peek() !== "\n") this.pos++;
      else return;
    }
  }

  fail(): never {
    throw new Error("toml");
  }
}

const ESCAPES: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };

function basicString(r: Reader, multiline: boolean): string {
  let out = "";
  const close = multiline ? '"""' : '"';
  for (;;) {
    if (r.eof()) r.fail();
    if (r.startsWith(close)) {
      r.pos += close.length;
      // """ may be followed by up to two more quotes that belong to the text
      if (multiline) for (let extra = 0; extra < 2 && r.peek() === '"'; extra++) out += r.src[r.pos++];
      return out;
    }
    const c = r.peek();
    if (c === "\\") {
      const n = r.peek(1);
      if (n in ESCAPES) {
        out += ESCAPES[n];
        r.pos += 2;
      } else if (n === "u" || n === "U") {
        const len = n === "u" ? 4 : 8;
        out += String.fromCodePoint(parseInt(r.slice(r.pos + 2, r.pos + 2 + len), 16));
        r.pos += 2 + len;
      } else if (multiline && /\s/.test(n)) {
        r.pos++; // a line-ending backslash trims the whitespace that follows
        while (/\s/.test(r.peek())) r.pos++;
      } else r.fail();
    } else {
      if (!multiline && c === "\n") r.fail();
      out += c;
      r.pos++;
    }
  }
}

function literalString(r: Reader, multiline: boolean): string {
  const close = multiline ? "'''" : "'";
  const end = r.indexOf(close);
  if (end < 0) r.fail();
  const out = r.slice(r.pos, end);
  r.pos = end + close.length;
  return out;
}

function skipFirstNewline(r: Reader): void {
  if (r.peek() === "\r") r.pos++;
  if (r.peek() === "\n") r.pos++;
}

function value(r: Reader): TomlValue {
  r.skipSpaces();
  if (r.startsWith('"""')) {
    r.pos += 3;
    skipFirstNewline(r);
    return basicString(r, true);
  }
  if (r.startsWith("'''")) {
    r.pos += 3;
    skipFirstNewline(r);
    return literalString(r, true);
  }
  const c = r.peek();
  if (c === '"') {
    r.pos++;
    return basicString(r, false);
  }
  if (c === "'") {
    r.pos++;
    return literalString(r, false);
  }
  if (c === "[") {
    r.pos++;
    const items: TomlValue[] = [];
    for (;;) {
      r.skipBlank();
      if (r.peek() === "]") {
        r.pos++;
        return items;
      }
      items.push(value(r));
      r.skipBlank();
      if (r.peek() === ",") r.pos++;
      else if (r.peek() !== "]") r.fail();
    }
  }
  if (c === "{") {
    r.pos++;
    const table: TomlTable = {};
    for (;;) {
      r.skipSpaces();
      if (r.peek() === "}") {
        r.pos++;
        return table;
      }
      const path = keyPath(r);
      r.skipSpaces();
      if (r.peek() !== "=") r.fail();
      r.pos++;
      assign(table, path, value(r));
      r.skipSpaces();
      if (r.peek() === ",") r.pos++;
      else if (r.peek() !== "}") r.fail();
    }
  }
  const start = r.pos;
  while (!r.eof() && !/[\s,\]}#]/.test(r.peek())) r.pos++;
  const word = r.slice(start);
  if (word === "true") return true;
  if (word === "false") return false;
  if (/^\d{4}-\d\d-\d\d/.test(word)) return word; // a date or date-time, kept as text
  if (word === "inf" || word === "+inf" || word === "-inf" || word === "nan") return 0;
  const num = Number(word.replace(/_/g, ""));
  if (word !== "" && Number.isFinite(num)) return num;
  return r.fail();
}

function keyPath(r: Reader): string[] {
  const parts: string[] = [];
  for (;;) {
    r.skipSpaces();
    const c = r.peek();
    if (c === '"') {
      r.pos++;
      parts.push(basicString(r, false));
    } else if (c === "'") {
      r.pos++;
      parts.push(literalString(r, false));
    } else {
      const start = r.pos;
      while (/[A-Za-z0-9_-]/.test(r.peek())) r.pos++;
      if (r.pos === start) r.fail();
      parts.push(r.slice(start));
    }
    r.skipSpaces();
    if (r.peek() === ".") r.pos++;
    else return parts;
  }
}

function step(node: TomlTable, part: string): TomlTable {
  const next = node[part];
  if (next === undefined) return (node[part] = {});
  if (Array.isArray(next)) return next[next.length - 1] as TomlTable;
  if (typeof next === "object") return next;
  throw new Error("toml");
}

function assign(table: TomlTable, path: string[], v: TomlValue): void {
  let node = table;
  for (const part of path.slice(0, -1)) node = step(node, part);
  node[path[path.length - 1]!] = v;
}

function openTable(root: TomlTable, path: string[], array: boolean): TomlTable {
  let node = root;
  path.forEach((part, index) => {
    if (index < path.length - 1 || !array) {
      node = step(node, part);
      return;
    }
    const list = (node[part] ??= []);
    if (!Array.isArray(list)) throw new Error("toml");
    const item: TomlTable = {};
    list.push(item);
    node = item;
  });
  return node;
}

export function parseToml(source: string): TomlTable | null {
  try {
    const r = new Reader(source);
    const root: TomlTable = {};
    let current = root;
    for (;;) {
      r.skipBlank();
      if (r.eof()) return root;
      if (r.peek() === "[") {
        const array = r.peek(1) === "[";
        r.pos += array ? 2 : 1;
        const path = keyPath(r);
        r.skipSpaces();
        const close = array ? "]]" : "]";
        if (!r.startsWith(close)) r.fail();
        r.pos += close.length;
        current = openTable(root, path, array);
      } else {
        const path = keyPath(r);
        r.skipSpaces();
        if (r.peek() !== "=") r.fail();
        r.pos++;
        assign(current, path, value(r));
      }
      r.skipSpaces();
      if (r.peek() === "#") while (!r.eof() && r.peek() !== "\n") r.pos++;
      if (!r.eof() && r.peek() !== "\n" && r.peek() !== "\r") r.fail();
    }
  } catch {
    return null;
  }
}
