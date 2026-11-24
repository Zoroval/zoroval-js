/**
 * Content capture: JSON serialization, the redact hook and size caps.
 *
 * Every captured value goes through `capture()`. It applies the redact hook, serializes to JSON
 * and cuts long strings until the result fits the cap, so the JSON stays valid. If the redact
 * hook throws, the content is dropped (fail closed): unredacted content never leaves the app.
 *
 * Deviations from `_json.py`: `dumps` handles the JavaScript values JSON cannot (bigint, Map,
 * Set, bytes, Error, circular references); lengths are UTF-16 code units where Python counts code
 * points; the cut never splits a surrogate pair.
 */

import { addCount, logOnce } from "./util.js";

export interface Captured {
  text: string | null; // JSON text, or null when nothing should be sent
  redacted: boolean; // the redact hook changed the value
  truncatedBytes: number; // bytes removed by the size cap
}

function replacer(this: unknown, _key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Map) return Object.fromEntries(value);
  if (value instanceof Set) return Array.from(value);
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (value instanceof ArrayBuffer) return `[${value.byteLength} bytes omitted]`;
  if (ArrayBuffer.isView(value)) return `[${value.byteLength} bytes omitted]`;
  return value;
}

/** JSON text for any value. Never throws; a value JSON cannot hold becomes `null`. */
export function dumps(value: unknown): string {
  try {
    const text = JSON.stringify(value, replacer);
    return text === undefined ? "null" : text;
  } catch {
    // Circular reference (or a throwing toJSON): replace repeated objects instead of failing.
    try {
      // Only an object that contains itself is circular: track the ancestors of the value being written
      // (`this` is the object holding it), so an object that is merely shared twice is written twice.
      const ancestors: object[] = [];
      const text = JSON.stringify(value, function (key, item) {
        const plain = replacer.call(this, key, item);
        if (plain !== null && typeof plain === "object") {
          while (ancestors.length && ancestors[ancestors.length - 1] !== this) ancestors.pop();
          if (ancestors.includes(plain as object)) return "[Circular]";
          ancestors.push(plain as object);
        }
        return plain;
      });
      return text === undefined ? "null" : text;
    } catch {
      return "null";
    }
  }
}

/** Turn SDK objects into plain JSON values. */
export function toPlain(value: unknown): unknown {
  return JSON.parse(dumps(value));
}

export function utf8Len(text: string): number {
  let size = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) size += 1;
    else if (code < 0x800) size += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      size += 4;
      i++;
    } else size += 3;
  }
  return size;
}

function shrink(value: unknown, maxChars: number): unknown {
  if (typeof value === "string") {
    if (value.length > maxChars) {
      let end = maxChars;
      const last = value.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff) end -= 1; // do not split a surrogate pair
      return `${value.slice(0, end)}...[${value.length - end} chars truncated]`;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => shrink(item, maxChars));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = shrink(item, maxChars);
    return out;
  }
  return value;
}

/** Cut a JSON text to at most `limit` UTF-8 bytes, keeping it valid JSON. Returns [text, bytesCut]. */
export function fit(text: string, limit: number): [string, number] {
  const size = utf8Len(text);
  if (size <= limit) return [text, 0];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = text;
  }
  let maxChars = Math.max(Math.floor(limit / 2), 64);
  for (let i = 0; i < 24; i++) {
    const candidate = dumps(shrink(value, maxChars));
    const newSize = utf8Len(candidate);
    if (newSize <= limit) {
      addCount("truncatedFields");
      return [candidate, size - newSize];
    }
    if (maxChars <= 16) break;
    maxChars = Math.floor(maxChars / 2);
  }
  // Too many small fields: keep the head as one string.
  const head = text.slice(0, Math.max(Math.floor(limit / 4) - 64, 0));
  const candidate = dumps({ "zoroval.truncated": true, head });
  addCount("truncatedFields");
  return [candidate, size - utf8Len(candidate)];
}

type Redact = ((value: unknown) => unknown) | null;

/** Returns [value, redacted, ok]. ok=false means drop the content. */
export function applyRedact(redact: Redact, value: unknown): [unknown, boolean, boolean] {
  if (!redact) return [value, false, true];
  let next: unknown;
  try {
    next = redact(value);
  } catch (error) {
    addCount("redactErrors");
    const kind = error instanceof Error ? error.name : "error";
    logOnce(`redact:${kind}`, `zoroval: the redact hook threw ${kind}; content was dropped for that field.`);
    return [null, true, false];
  }
  if (next === null || next === undefined) return [null, true, false];
  let changed = next !== value;
  if (changed && typeof next !== "string") changed = dumps(next) !== dumps(value);
  return [next, changed, true];
}

/** Serialize content for a span attribute. Returns text=null when nothing is sent. */
export function capture(
  value: unknown,
  options: { redact: Redact; limit: number },
): Captured {
  if (value === null || value === undefined) {
    return { text: null, redacted: false, truncatedBytes: 0 };
  }
  const [next, redacted, ok] = applyRedact(options.redact, value);
  if (!ok) return { text: null, redacted: true, truncatedBytes: 0 };
  const [text, cut] = fit(dumps(next), options.limit);
  return { text, redacted, truncatedBytes: cut };
}

/** Media is not captured in v1: base64 data URLs become a short placeholder. */
export function dataUrlPlaceholder(url: unknown): unknown {
  if (typeof url === "string" && url.startsWith("data:")) {
    const semi = url.indexOf(";");
    const kind = semi > 0 && semi < 64 ? url.slice(5, semi) : "media";
    return `[${kind} omitted]`;
  }
  return url;
}
