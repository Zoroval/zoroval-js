/**
 * Built-in redaction: level-1 rules (cards, emails, phones, Aadhaar, PAN, keys and tokens).
 *
 * The rules live in `redaction/level1.json`, the same file the Python SDK and Zoroval's ingest load
 * (CI checks the copies match). This module only applies them: fold, prefilter, match, validate,
 * replace. Nothing here runs unless the developer turns redaction on.
 */

import RULES_DOC from "./redaction/level1.json";
import { toPlain } from "./json.js";

export const BUILTIN_NAMES = ["basic"] as const;
const MAX_DEPTH = 200; // nested containers deeper than this are not scanned: the field is dropped
const MIN_INT = 1e9; // smaller integers cannot hold any level-1 value

/** The value could not be scanned. The caller drops the field. */
export class RedactionError extends Error {
  override name = "RedactionError";
}

// ---------------------------------------------------------------------------- validators

export function luhn(d: string): boolean {
  let total = 0;
  for (let i = 0; i < d.length; i++) {
    let n = d.charCodeAt(d.length - 1 - i) - 48;
    if (i % 2) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    total += n;
  }
  return total % 10 === 0;
}

const VD = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
const VP = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];

export function verhoeff(d: string): boolean {
  let c = 0;
  for (let i = 0; i < d.length; i++) c = VD[c]![VP[i % 8]![d.charCodeAt(d.length - 1 - i) - 48]!]!;
  return c === 0;
}

const VALIDATORS: Record<string, (digits: string) => boolean> = { luhn, verhoeff };

// ---------------------------------------------------------------------------- rules

interface RuleSpec {
  id: string;
  label: string;
  pattern: string;
  prefilter?: string;
  validators?: string[];
  deny_prefix?: { window: number; pattern: string };
}

interface RulesDoc {
  fold: { from: [number, number]; to: number; shift?: boolean }[];
  rules: RuleSpec[];
  labels: string[];
  integer_keys: string;
}

interface Rule {
  label: string;
  regex: RegExp; // global
  prefilter: RegExp | null;
  validators: ((digits: string) => boolean)[];
  deny: RegExp | null;
  window: number;
}

interface Rules {
  fold: Uint16Array; // code unit -> folded code unit, 0 when unchanged
  foldTest: RegExp;
  rules: Rule[];
  labels: string[];
  integerKeys: RegExp;
}

function compile(doc: RulesDoc): Rules {
  const fold = new Uint16Array(0x10000);
  let ranges = "";
  const hex = (n: number) => "\\u" + n.toString(16).padStart(4, "0");
  for (const entry of doc.fold) {
    const [first, last] = entry.from;
    for (let cp = first; cp <= last; cp++) fold[cp] = entry.shift ? entry.to + (cp - first) : entry.to;
    ranges += hex(first) + "-" + hex(last);
  }
  const rules = doc.rules.map((spec) => ({
    label: spec.label,
    regex: new RegExp(spec.pattern, "g"),
    prefilter: spec.prefilter ? new RegExp(spec.prefilter) : null,
    validators: (spec.validators ?? []).map((name) => {
      const check = VALIDATORS[name];
      if (!check) throw new Error(`unknown validator ${name}`);
      return check;
    }),
    deny: spec.deny_prefix ? new RegExp(spec.deny_prefix.pattern) : null,
    window: spec.deny_prefix ? spec.deny_prefix.window : 0,
  }));
  return {
    fold,
    foldTest: new RegExp(`[${ranges}]`),
    rules,
    labels: doc.labels,
    integerKeys: new RegExp(doc.integer_keys),
  };
}

let RULES: Rules | null = null;

/** The compiled rules. Compiled on first use, so tracing without redaction pays nothing. */
export function rules(): Rules {
  if (RULES === null) RULES = compile(RULES_DOC as unknown as RulesDoc);
  return RULES;
}

const NOT_DIGIT = /[^0-9]/g;

/** The shadow copy: every listed code unit mapped 1:1 to ASCII, so offsets match the original. */
function foldText(text: string, table: Uint16Array): string {
  const codes = new Uint16Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    codes[i] = table[c] || c;
  }
  let out = "";
  for (let i = 0; i < codes.length; i += 8192) out += String.fromCharCode.apply(null, codes.subarray(i, i + 8192) as unknown as number[]);
  return out;
}
const ASCII = /^[\x00-\x7f]*$/;

// ---------------------------------------------------------------------------- strings

/**
 * Replace level-1 values in one string with labels. Returns the same string when nothing matched.
 * `key`: the object key the string sits under; it is context for deny_prefix, so
 * {"pnr": "8123456789"} is treated like the text "pnr: 8123456789".
 */
export function redactText(text: string, key?: string | null): string {
  if (!text) return text;
  const rs = rules();
  let shadow = ASCII.test(text) || !rs.foldTest.test(text) ? text : foldText(text, rs.fold);
  let same = shadow === text;
  const context = key ? key.toLowerCase() + ": " : "";
  const passed = new Map<RegExp, boolean>();
  for (const rule of rs.rules) {
    if (rule.prefilter) {
      let hit = passed.get(rule.prefilter);
      if (hit === undefined) {
        hit = rule.prefilter.test(shadow);
        passed.set(rule.prefilter, hit);
      }
      if (!hit) continue;
    }
    let out = "";
    let sh = "";
    let last = 0;
    let found = false;
    rule.regex.lastIndex = 0;
    for (let m = rule.regex.exec(shadow); m !== null; m = rule.regex.exec(shadow)) {
      const start = m.index;
      const end = start + m[0].length;
      if (start === end) {
        rule.regex.lastIndex++;
        continue;
      }
      if (rule.validators.length) {
        const digits = m[0].replace(NOT_DIGIT, "");
        if (!rule.validators.every((check) => check(digits))) continue;
      }
      if (rule.deny) {
        let before = shadow.slice(Math.max(0, start - rule.window), start);
        if (context && start < rule.window) before = (context + before).slice(-rule.window);
        if (rule.deny.test(before.toLowerCase())) continue;
      }
      out += text.slice(last, start) + rule.label;
      if (!same) sh += shadow.slice(last, start) + rule.label;
      last = end;
      found = true;
    }
    if (!found) continue;
    text = out + text.slice(last);
    shadow = same ? text : sh + shadow.slice(last);
    same = shadow === text;
    passed.clear(); // labels may contain characters the prefilters look for
  }
  return text;
}

// ---------------------------------------------------------------------------- values

const UNCHANGED: unique symbol = Symbol("unchanged");
type Walked = unknown | typeof UNCHANGED;

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function walk(value: unknown, depth: number, key: string | null): Walked {
  switch (typeof value) {
    case "string": {
      const next = redactText(value, key);
      return next === value ? UNCHANGED : next;
    }
    case "number":
    case "bigint": {
      // Amounts, ids and timestamps are integers far more often than phone or card numbers are,
      // so an integer is scanned only under a key that names one (integer_keys).
      if (typeof value === "number" && (!Number.isInteger(value) || Math.abs(value) < MIN_INT)) return UNCHANGED;
      if (typeof value === "bigint" && value < BigInt(MIN_INT) && value > -BigInt(MIN_INT)) return UNCHANGED;
      if (!key || !rules().integerKeys.test(key.toLowerCase())) return UNCHANGED;
      const text = String(value);
      const next = redactText(text, key);
      return next === text ? UNCHANGED : next;
    }
    case "object":
      break;
    default:
      return UNCHANGED; // boolean, undefined, function, symbol: never sent as text
  }
  if (value === null) return UNCHANGED;
  if (depth >= MAX_DEPTH) throw new RedactionError("value nested too deep to scan");
  if (Array.isArray(value)) {
    let items: unknown[] | null = null;
    for (let i = 0; i < value.length; i++) {
      const next = walk(value[i], depth + 1, key);
      if (next !== UNCHANGED) {
        items ??= value.slice();
        items[i] = next;
      }
    }
    return items ?? UNCHANGED;
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return UNCHANGED; // sent as "[N bytes omitted]"
  // An object with toJSON is sent as what toJSON returns, so that is what gets scanned.
  if (isPlainObject(value) && typeof (value as { toJSON?: unknown }).toJSON !== "function") {
    let changed: Record<string, unknown> | null = null;
    for (const name of Object.keys(value)) {
      const next = walk((value as Record<string, unknown>)[name], depth + 1, name);
      if (next !== UNCHANGED) {
        changed ??= { ...(value as Record<string, unknown>) };
        changed[name] = next;
      }
    }
    return changed ?? UNCHANGED;
  }
  // Map, Set, Error, Date, class instances, objects with toJSON: scan what will be sent.
  const plain = toPlain(value);
  if (plain === null || typeof plain !== "object" && typeof plain !== "string") return UNCHANGED;
  return walk(plain, depth + 1, key);
}

/**
 * The built-in redact hook. Same value back when nothing matched. Throws RedactionError when the
 * value cannot be scanned, so the caller drops the field (fail closed).
 */
export function redactValue(value: unknown): unknown {
  let next: Walked;
  try {
    next = walk(value, 0, null);
  } catch (error) {
    if (error instanceof RangeError) throw new RedactionError("value nested too deep to scan");
    throw error;
  }
  return next === UNCHANGED ? value : next;
}

// ---------------------------------------------------------------------------- init({ redact })

export type RedactFunction = (value: unknown) => unknown;
export type RedactOption = "basic" | RedactFunction | ReadonlyArray<"basic" | RedactFunction>;

/**
 * Turn init({ redact }) into one function plus a short description for status(). The built-in always
 * runs first, then the developer's function on its output. An invalid value returns `error`: the
 * caller keeps tracing off rather than send content the developer meant to clean.
 */
export function buildHook(redact: unknown): { hook: RedactFunction | null; mode: string | null; error?: string } {
  if (redact === undefined || redact === null) return { hook: null, mode: null };
  const parts = Array.isArray(redact) ? redact : [redact];
  let builtin = false;
  const functions: RedactFunction[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      if (!(BUILTIN_NAMES as readonly string[]).includes(part)) {
        return { hook: null, mode: null, error: `redact got ${JSON.stringify(part)}; use "basic" or a function` };
      }
      builtin = true;
    } else if (typeof part === "function") {
      functions.push(part as RedactFunction);
    } else {
      return { hook: null, mode: null, error: 'redact takes "basic", a function, or an array of both' };
    }
  }
  if (functions.length > 1) return { hook: null, mode: null, error: "redact takes at most one function" };
  if (builtin) rules(); // compile now, so a broken bundle shows at init and not on the first call
  const fn = functions[0];
  if (builtin && !fn) return { hook: redactValue, mode: "basic" };
  if (!fn) return { hook: null, mode: null };
  if (!builtin) return { hook: fn, mode: "function" };
  return { hook: (value) => fn(redactValue(value)), mode: "basic+function" };
}
