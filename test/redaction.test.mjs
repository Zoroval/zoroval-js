// The shared level-1 rules on V8: the corpus, structures, the developer's function, and attacks
// (slow matching, exceptions, memory, unicode, event-loop blocking). Budgets are about three times
// what an M1 Pro measures, so a slower CI runner passes and super-linear matching fails.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { redactText, redactValue, RedactionError } from "../.test-build/internal.js";
import { ADVERSARIAL, rng, typicalPayload } from "./redaction-inputs.mjs";

const corpus = JSON.parse(readFileSync(new URL("./redaction/level1_corpus.json", import.meta.url), "utf8"));
const MIB = 1 << 20;
const BUDGET_MS_PER_MIB = 600; // worst adversarial input
const TYPICAL_BUDGET_MS_PER_MIB = 200; // chat-shaped JSON

// ---------------------------------------------------------------------------- corpus

test("corpus: must_redact gives expect exactly", () => {
  for (const c of corpus.must_redact) assert.equal(redactText(c.text), c.expect, c.id);
});

test("corpus: must_keep is unchanged", () => {
  for (const c of corpus.must_keep) assert.equal(redactText(c.text), c.text, c.id);
});

test("corpus: values_must_redact and values_must_keep", () => {
  for (const c of corpus.values_must_redact) assert.deepEqual(redactValue(c.value), c.expect, c.id);
  for (const c of corpus.values_must_keep) assert.equal(redactValue(c.value), c.value, c.id);
});

test("labels never match a rule, and redaction is idempotent on the corpus", () => {
  for (const label of ["[SECRET]", "[EMAIL]", "[CARD]", "[PHONE]", "[AADHAAR]", "[PAN]"]) {
    assert.equal(redactText(`${label} ${label}${label}`), `${label} ${label}${label}`);
  }
  for (const c of corpus.must_redact) assert.equal(redactText(c.expect), c.expect, c.id);
});

// ---------------------------------------------------------------------------- structures

test("structures: copy on change, keys kept, integers only under phone or card keys", () => {
  const clean = Array.from({ length: 20_000 }, (_, i) => ({ role: "user", content: `message ${i}` }));
  assert.equal(redactValue(clean), clean);
  const dirty = [...clean, { role: "user", content: "x@y.co" }];
  const out = redactValue(dirty);
  assert.equal(out[0], dirty[0]);
  assert.deepEqual(out.at(-1), { role: "user", content: "[EMAIL]" });
  assert.deepEqual(redactValue({ "a@b.co": "x@y.co" }), { "a@b.co": "[EMAIL]" });
  assert.deepEqual(redactValue({ phone: 9876543210, amount_paise: 9876543210, ts: 1764000000123, flag: true, f: 9.876543210 }),
    { phone: "[PHONE]", amount_paise: 9876543210, ts: 1764000000123, flag: true, f: 9.876543210 });
  assert.deepEqual(redactValue({ mobile: 9876543210n }), { mobile: "[PHONE]" });
  const frozen = Object.freeze({ email: "a@b.co" });
  assert.deepEqual(redactValue(frozen), { email: "[EMAIL]" });
  assert.equal(frozen.email, "a@b.co", "input never mutated");
});

test("structures: Map, Set, Date, class instances, toJSON, typed arrays, JSON inside strings", () => {
  class Msg { constructor() { this.content = "call 9876543210"; } }
  assert.deepEqual(redactValue(new Msg()), { content: "call [PHONE]" });
  assert.deepEqual(redactValue(new Map([["email", "a@b.co"]])), { email: "[EMAIL]" });
  assert.deepEqual(redactValue(new Set(["a@b.co"])), ["[EMAIL]"]);
  assert.deepEqual(redactValue({ toJSON: () => ({ email: "a@b.co" }) }), { email: "[EMAIL]" });
  const bytes = new Uint8Array([1, 2, 3]);
  assert.equal(redactValue(bytes), bytes);
  const d = new Date(0);
  assert.equal(redactValue(d), d);
  const args = JSON.stringify({ customer: { email: "a@b.co", phone: "9876543210" }, pnr: "8123456789" });
  assert.deepEqual(JSON.parse(redactValue(args)), { customer: { email: "[EMAIL]", phone: "[PHONE]" }, pnr: "8123456789" });
});

test("structures: deep nesting and cycles fail closed; getters that throw propagate to the caller", () => {
  let deep = {};
  const root = deep;
  for (let i = 0; i < 5000; i++) { deep.x = {}; deep = deep.x; }
  assert.throws(() => redactValue(root), RedactionError);
  const loop = []; loop.push(loop);
  assert.throws(() => redactValue(loop), RedactionError);
  const hostile = { get boom() { throw new TypeError("getter"); } };
  assert.throws(() => redactValue(hostile)); // applyRedact catches this and drops the field
});

test("structures: 200k-item arrays stay fast", () => {
  const items = Array.from({ length: 200_000 }, (_, i) => `line ${i} of the report`);
  items.push("mail a@b.co");
  const began = performance.now();
  const out = redactValue(items);
  assert.ok(performance.now() - began < 3000);
  assert.equal(out.at(-1), "mail [EMAIL]");
});

// ---------------------------------------------------------------------------- unicode

test("unicode: full-width, Indian-script and mixed digits, zero-width, RTL, emoji, lone surrogates", () => {
  assert.equal(redactText("‮रुको 😀 a@b.co 🇮🇳 \ud800 ９८७६५४३२१० சரி ௦"), "‮रुको 😀 [EMAIL] 🇮🇳 \ud800 [PHONE] சரி ௦");
  assert.equal(redactText("4111 １１１１ ११११ ௧௧௧௧"), "[CARD]");
  assert.equal(redactText("card 4111​1111​1111​1111"), "card [CARD]");
  assert.equal(redactText("\udfff\ud800".repeat(1000)), "\udfff\ud800".repeat(1000));
});

// ---------------------------------------------------------------------------- fuzz

const TOKENS = [..."0123456789 -+@.()\n\r\t_/#:=", "４", "＠", "＋", "－", "​", "‍", "﻿", " ", "–",
  "९", "௯", "٣", "‮", "😀", "\ud800", "a", "Z", "sk-", "eyJ", "AKIA", "Bearer ", "[CARD]", "4111", "9876543210",
  "+91 ", "aadhaar ", "pnr ", "order ", "x@y.co", "ABCPE", "1234F", "com", "."];


test("fuzz: 100k random strings never throw and always return a string", () => {
  const r = rng(20261124);
  for (let i = 0; i < 100_000; i++) {
    let s = "";
    const n = Math.floor(r() * 80);
    for (let j = 0; j < n; j++) s += TOKENS[Math.floor(r() * TOKENS.length)];
    assert.equal(typeof redactText(s), "string");
  }
});

test("fuzz: planted values are always removed", () => {
  const plants = [["4111 1111 1111 1111", "[CARD]"], ["priya@example.com", "[EMAIL]"], ["+91 98765 43210", "[PHONE]"],
    ["9876543210", "[PHONE]"], ["ABCPE1234F", "[PAN]"], ["AKIAIOSFODNN7EXAMPLE", "[SECRET]"]];
  const filler = ["hello", "नमस्ते", "வணக்கம்", "مرحبا", "😀", "price ₹499 only", "v1.2.3 ok", "ok."];
  const gaps = [" ", "\n", ", ", ": ", " (", "\t", " ‏"];
  const r = rng(7);
  for (let i = 0; i < 20_000; i++) {
    const [value, label] = plants[Math.floor(r() * plants.length)];
    const pick = () => filler[Math.floor(r() * filler.length)];
    const text = `${pick()} ${pick()}${gaps[Math.floor(r() * gaps.length)]}${value} ${pick()}`;
    const out = redactText(text);
    assert.ok(!out.includes(value) && out.includes(label), JSON.stringify(text));
  }
});

// ---------------------------------------------------------------------------- timing

function bestMs(fn, arg, runs = 2) {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const began = performance.now();
    fn(arg);
    best = Math.min(best, performance.now() - began);
  }
  return best;
}

test("timing: every adversarial 4 MiB input stays within budget", () => {
  const report = {};
  for (const [name, make] of Object.entries(ADVERSARIAL)) {
    const text = make(4 * MIB);
    const perMib = bestMs(redactText, text) / (text.length / MIB);
    report[name] = Math.round(perMib);
    assert.ok(perMib < BUDGET_MS_PER_MIB, `${name}: ${perMib.toFixed(0)} ms per MiB`);
  }
  if (process.env.ZOROVAL_PRINT_TIMINGS) console.log(JSON.stringify(report));
});

test("timing: matching grows linearly (1 MiB vs 4 MiB)", () => {
  for (const name of ["digits_spaced", "card_groups", "a_at_dot", "plus_spaced", "hindi_digits", "deny_words", "long_domain", "local_part_no_at"]) {
    const small = bestMs(redactText, ADVERSARIAL[name](MIB));
    const large = bestMs(redactText, ADVERSARIAL[name](4 * MIB));
    assert.ok(large < small * 4 * 2 + 50, `${name}: 1 MiB ${small.toFixed(0)} ms, 4 MiB ${large.toFixed(0)} ms`);
  }
});

test("timing: typical chat payload within budget, values gone, ids kept", () => {
  const text = typicalPayload(4 * MIB);
  const perMib = bestMs(redactText, text) / (text.length / MIB);
  assert.ok(perMib < TYPICAL_BUDGET_MS_PER_MIB, `${perMib.toFixed(0)} ms per MiB`);
  const out = redactText(text);
  assert.ok(!out.includes("4111 1111") && !out.includes("98765 43210") && !out.includes("priya.sharma@"));
  assert.ok(out.includes("403-5926381-7740324") && out.includes("INV-2026-000123") && out.includes("789456123012"));
});

// ---------------------------------------------------------------------------- memory and event loop

test("memory: no growth over repeated calls", () => {
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc");
  const text = typicalPayload(MIB);
  redactText(text);
  gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 20; i++) redactText(text);
  gc();
  const grown = process.memoryUsage().heapUsed - before;
  assert.ok(grown < 16 * MIB, `heap grew ${grown} bytes`);
});

test("event loop: the only block is the redaction call itself, and nothing runs later", async () => {
  // A timer due every 1 ms records the gaps between ticks while one 100 KB payload is redacted.
  const text = typicalPayload(100 * 1024);
  const alone = bestMs(redactText, text, 5);
  const gaps = [];
  let last = performance.now();
  const timer = setInterval(() => { const now = performance.now(); gaps.push(now - last); last = now; }, 1);
  await new Promise((r) => setTimeout(r, 20));
  redactText(text);
  await new Promise((r) => setTimeout(r, 50));
  clearInterval(timer);
  const worst = Math.max(...gaps);
  assert.ok(worst < alone * 3 + 15, `worst gap ${worst.toFixed(1)} ms, redaction alone ${alone.toFixed(1)} ms`);
});

