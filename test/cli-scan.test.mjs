// Unit tests for the CLI's small parsers and scanners (the built test bundle, not the published one).
import assert from "node:assert/strict";
import { test } from "node:test";
import * as cli from "../.test-build/cli.js";

// ------------------------------------------------------------------ TOML

test("TOML: tables, dotted keys, arrays of tables, inline tables, multi-line arrays, strings, comments", () => {
  const t = cli.parseToml(`
title = "a # not a comment"  # but this is
n = 1_000
f = 1.5
on = true
[a.b]
list = [
  "x", 'y',   # trailing
  "z",
]
inline = { v = "1", w = { deep = 2 } }
dotted.key = "d"
[[items]]
name = "one"
[[items]]
name = "two"
multi = """
first
second"""
lit = '''raw \\n'''
date = 2025-01-01
`);
  assert.deepEqual(t, {
    title: "a # not a comment", n: 1000, f: 1.5, on: true,
    a: { b: { list: ["x", "y", "z"], inline: { v: "1", w: { deep: 2 } }, dotted: { key: "d" } } },
    items: [{ name: "one" }, { name: "two", multi: "first\nsecond", lit: "raw \\n", date: "2025-01-01" }],
  });
});

test("TOML: what it cannot read is null, never a throw", () => {
  for (const bad of ["a = ", "[unclosed", "a = [1, 2", "= 1", "a = 'x\nb = 1", 'a = "unterminated']) assert.equal(cli.parseToml(bad), null, bad);
  assert.deepEqual(cli.parseToml(""), {});
});

test("JSONC: comments and trailing commas go, strings with // stay", () => {
  assert.equal(JSON.parse(cli.stripJsonc('{\n // c\n "u": "http://x.test/a", /* b */ "l": [1,2,],\n}')).u, "http://x.test/a");
});

// ------------------------------------------------------------------ JS scanner

const calls = (src) => cli.scanJs(src).llmCalls;
const ids = (src) => cli.scanJs(src).chatIds.map(([l, n]) => `${l}:${n}`);

test("JS: client calls on chains, optional chaining, new lines, awaits", () => {
  assert.deepEqual(calls("await openai.chat.completions.create({})"), [[1, "chat.completions.create"]]);
  assert.deepEqual(calls("const r = client?.chat.completions.parse(x)"), [[1, "chat.completions.parse"]]);
  assert.deepEqual(calls("x = this.client\n  .responses\n  .stream({})"), [[1, "responses.stream"]]);
  assert.deepEqual(calls("a.b().chat.completions.create()"), [[1, "chat.completions.create"]]);
  assert.deepEqual(calls("foo.chat.completions.delete()"), []);
  assert.deepEqual(calls("responses.create()"), [[1, "responses.create"]]); // like Python, the name is what counts
});

test("JS: comments, strings, templates and regular expressions never count", () => {
  const src = [
    "// openai.chat.completions.create()",
    "/* openai.responses.create() */",
    'const s = "openai.chat.completions.create()";',
    "const t = `openai.chat.completions.create() ${1 + 1}`;",
    "const r = /openai.chat.completions.create(/g; const d = 4 / 2;",
    "const ok = await client.chat.completions.create({});",
  ].join("\n");
  assert.deepEqual(calls(src), [[6, "chat.completions.create"]]);
});

test("JS: regex versus division, template nesting, line counting survive odd code", () => {
  const src = "const a = x / y / z;\nconst b = `a ${`b ${c}`} d`;\nconst re = /[/]\\//;\nclient.chat.completions.create();";
  assert.deepEqual(calls(src), [[4, "chat.completions.create"]]);
});

test("JS: fetch to the OpenAI API, directly or through a constant; other URLs and computed ones are not", () => {
  assert.deepEqual(calls('fetch("https://api.openai.com/v1/chat/completions")'), [[1, "fetch"]]);
  assert.deepEqual(calls('fetch(`https://api.openai.com/v1/${path}`, {})'), [[1, "fetch"]]);
  assert.deepEqual(calls('const U = "https://api.openai.com/v1/responses";\nawait fetch(U, {});'), [[2, "fetch"]]);
  assert.deepEqual(calls('globalThis.fetch("https://api.openai.com/v1/x")'), [[1, "fetch"]]);
  assert.deepEqual(calls('fetch("https://example.com/v1/x")'), []);
  assert.deepEqual(calls('api.fetch("https://api.openai.com/v1/x")'), []);
  assert.deepEqual(calls('fetch(url)'), []);
});

test("JS: conversation ids as parameters, properties and destructured fields, not as plain use", () => {
  assert.deepEqual(ids("function f(chatId, b) {}"), ["1:chatId"]);
  assert.deepEqual(ids("const f = (a, chatId: string) => 1;"), ["1:chatId"]);
  assert.deepEqual(ids("const f = async (threadId) => {};"), ["1:threadId"]);
  assert.deepEqual(ids("const f = sessionId => sessionId;"), ["1:sessionId"]);
  assert.deepEqual(ids("const { chatId, text: t } = body;"), ["1:chatId"]);
  assert.deepEqual(ids("const { a = 1, conversationId = 'x' } = body;"), ["1:conversationId"]);
  assert.deepEqual(ids("const x = req.body.chat_id ?? req?.query.chatId;"), ["1:chat_id", "1:chatId"]);
  assert.deepEqual(ids("const o = { chatId: 1, room_id };"), ["1:chatId", "1:room_id"]);
  assert.deepEqual(ids("interface R { chatId?: string; dialog_id: number }"), ["1:chatId", "1:dialog_id"]);
  assert.deepEqual(ids("function g({ chatId }: { chatId: string }) {}"), ["1:chatId"]); // one per line and name
  // plain uses are not candidates
  assert.deepEqual(ids("const x = chatId + 1; log(chatId); if (chatId) { go(); }"), []);
  assert.deepEqual(ids("save(chatId, x);"), []);
});

test("JS: imports of every shape; export default { fetch } and addEventListener are Workers", () => {
  const s = cli.scanJs('import a from "openai";\nimport { b } from \'x\';\nimport "side";\nconst c = require("cjs");\nconst d = await import("dyn");\nexport * from "re";');
  assert.deepEqual([...s.imports].sort(), ["cjs", "dyn", "openai", "side", "x"].sort());
  assert.equal(cli.scanJs("export default {\n  async fetch(r) {}\n};").workerLine, 1);
  assert.equal(cli.scanJs("export default { fetch(r) {} };").workerLine, 1);
  assert.equal(cli.scanJs("export default { fetch };").workerLine, 1);
  assert.equal(cli.scanJs('export default { scheduled() {}, async queue() {} };').workerLine, null);
  assert.equal(cli.scanJs('export default { other: { fetch() {} } };').workerLine, null);
  assert.equal(cli.scanJs('addEventListener("fetch", (e) => {})').workerLine, 1);
});

test("JS: Next.js handlers", () => {
  assert.equal(cli.scanJs("import x from 'y';\nexport async function POST(req) {}").handlerLine, 2);
  assert.equal(cli.scanJs("export const GET = () => 1;").handlerLine, 1);
  assert.equal(cli.scanJs("export default function handler() {}").handlerLine, 1);
  assert.equal(cli.scanJs("export function helper() {}").handlerLine, null);
});

test("JS: odd input does not throw", () => {
  for (const src of ["", "`${", "/*", '"unterminated', "/[", "((((", "}}}}", "#!/usr/bin/env node\nfoo()", "﻿const a = 1", "a ? /re/ : b"]) {
    assert.doesNotThrow(() => cli.scanJs(src), src);
  }
});

// ------------------------------------------------------------------ Python scanner

test("Python: calls, strings and comments, multi-line chains, keyword and attribute ids", () => {
  const s = cli.scanPython([
    '"""client.chat.completions.create()"""',
    "# client.chat.completions.create()",
    "x = '''chat_id'''",
    "r = (get()",
    "     .chat.completions",
    "     .create(chat_id=1, other=2))",
    "y = a.session_id + b['thread_id'] + ['room_id']",
  ].join("\n"));
  assert.deepEqual(s.calls, [[4, "openai:chat.completions.create"]]);
  assert.deepEqual(s.chatIds, [[4, "chat_id"], [7, "session_id"], [7, "thread_id"]]);
});

test("Python: def parameters (positional-only, keyword-only, star args), decorators, imports, main guard", () => {
  const s = cli.scanPython([
    "import os, a.b as c",
    "from x.y import (z, w as v,)",
    "from . import rel",
    "from .m import n",
    "@app.get('/x')",
    "@observe()",
    "def h(chat_id, /, thread_id, *args, session_id=1, **kw): pass",
    "def lambda_handler(event, context): pass",
    "if __name__ == '__main__': pass",
  ].join("\n"));
  assert.deepEqual([...s.imports].sort(), ["a.b", "m", "m.n", "os", "x.y", "x.y.w", "x.y.z"]); // `as` names are not imports: Python records alias.name
  assert.deepEqual(s.signals, [[7, "route:h"], [7, "langfuse_observe"], [8, "lambda_handler"]]);
  assert.deepEqual(s.chatIds, [[7, "thread_id"], [7, "session_id"]]);
  assert.equal(s.hasMain, true);
});

test("Python: odd input does not throw", () => {
  for (const src of ["", "(((", "def (", "'''", "@", "from", "import", "x = 'a\n", "\\\n", "def f(:\n pass"]) {
    assert.doesNotThrow(() => cli.scanPython(src), src);
  }
});

// ------------------------------------------------------------------ args

test("args: abbreviations must be unique; --opt=value; -- ends options", () => {
  const spec = cli.COMMANDS;
  assert.throws(() => cli.parseArgs(["login", "--n"], spec, "0"), (e) => e instanceof cli.UsageError && /ambiguous option: --n could match --name, --no-browser/.test(e.message));
  assert.equal(cli.parseArgs(["login", "--root=x", "--rep"], spec, "0").values.root, "x");
  assert.equal(cli.parseArgs(["login", "--rep"], spec, "0").values.replace, true);
  assert.equal(cli.parseArgs(["detect", "--", "--odd-folder"], spec, "0").values.path, "--odd-folder");
});

test("JS: web servers need the import and the call that creates the app", () => {
  const kinds = (src) => cli.scanJs(src).frameworks.map((f) => `${f.kind}:${f.line}`);
  assert.deepEqual(kinds('import express from "express";\nconst app = express();'), ["express:2"]);
  assert.deepEqual(kinds('const express = require("express");\nconst app = express();'), ["express:2"]);
  assert.deepEqual(kinds('const f = require("fastify")({ logger: true });'), ["fastify:1"]);
  assert.deepEqual(kinds('const a = require("express")();'), ["express:1"]);
  assert.deepEqual(kinds('const a = require("other")();'), []);
  assert.deepEqual(kinds("const app = express();"), []); // no import
  assert.deepEqual(kinds('import express from "express";\napp.use(express.json());'), []); // not a call to express()
  assert.deepEqual(kinds('import { Hono } from "hono";\nconst a = new Hono();'), ["hono:2"]);
  assert.deepEqual(kinds('import Fastify from "fastify";\nconst f = Fastify({});'), ["fastify:2"]);
  assert.deepEqual(kinds('import { Hono } from "hono"; const a = new Hono(); const b = new Hono();'), ["hono:1"]); // first only
});

test("JS: a chat id declared or assigned is a candidate; comparisons and other names are not", () => {
  assert.deepEqual(ids("const chatId = make();"), ["1:chatId"]);
  assert.deepEqual(ids("let threadId;\nvar sessionId = 1;"), ["1:threadId", "2:sessionId"]);
  assert.deepEqual(ids("let id;\nchatId = next();"), ["2:chatId"]);
  assert.deepEqual(ids("if (chatId == 1 || chatId === 2) {}"), []);
  assert.deepEqual(ids("const chatIdPrefix = 'x'; x.chatId2 = 1;"), []);
});

test("JS: a program for the terminal is one that reads readline or process.argv", () => {
  assert.equal(cli.scanJs('import { createInterface } from "node:readline/promises";').cliMain, true);
  assert.equal(cli.scanJs('const rl = require("readline");').cliMain, true);
  assert.equal(cli.scanJs("const [, , q] = process.argv;").cliMain, true);
  assert.equal(cli.scanJs("export const x = process.env.A;").cliMain, false);
});
