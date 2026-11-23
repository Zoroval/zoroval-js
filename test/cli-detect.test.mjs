import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { FAKE_SECRET, prepareFixture } from "./fixtures-prepare.mjs";
import { CLI, makeProject, runCli, startApp, SETUP_CODE } from "./cli-fakes.mjs";

const fixtures = new URL("./fixtures/detect/", import.meta.url).pathname;
const TS_ENV = { ".env": `OPENAI_API_KEY=${FAKE_SECRET}\nOTHER=1\n` };
const WORKER_ENV = { ".dev.vars": `OPENAI_API_KEY=${FAKE_SECRET}\n`, ".dev.vars.staging": "X=1\n" };

// A minimal environment: the developer's own OTEL_* or LANGCHAIN_* variables must not change a report.
const detect = (dir, ...args) => {
  const r = spawnSync(process.execPath, [CLI, "detect", dir, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  return r;
};
const report = (name, env) => {
  const dir = prepareFixture(join(fixtures, name), env ? { env } : undefined);
  const r = detect(dir, "--json");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes(FAKE_SECRET), "an env value was printed");
  return { dir, out: JSON.parse(r.stdout), raw: r.stdout };
};
const KEYS = ["root", "services", "packages", "imports", "llm_calls", "tracing", "entry_points", "chat_id_candidates", "servers", "serverless", "env", "deploy_files", "ci_files", "collector_configs", "secrets_managers", "typescript", "cases", "explain_only", "notes", "plan"];

// ------------------------------------------------------------------ Python: the same report as the Python CLI

for (const name of ["python-app", "python-edge", "python-langfuse", "python-otel"]) {
  test(`${name}: the report equals the one the Python CLI wrote (snapshot of Python 0.2.0 output)`, () => {
    const dir = prepareFixture(join(fixtures, name));
    const r = detect(dir, "--json");
    assert.equal(r.status, 0, r.stderr);
    const expected = readFileSync(join(fixtures, `${name}.expected.json`), "utf8");
    assert.equal(r.stdout.split(dir).join("<root>"), expected);
  });
}

test("a Python project's report has the Python key order, and a text report like Python's", () => {
  const { out, dir } = report("python-app");
  assert.deepEqual(Object.keys(out).slice(0, KEYS.length), KEYS);
  assert.equal(Object.keys(out).at(-1), "routes");
  const text = detect(dir).stdout.split("\n");
  assert.equal(text[0], `Folder: ${dir}`);
  assert.equal(text[1], "Cases: 3, 7, 9");
  assert.equal(text[2], "ZOROVAL_INGEST_KEY: absent");
  assert.ok(text.includes("LLM call: app/main.py:15 openai chat.completions.create"));
  assert.ok(text.includes("Conversation id candidate: app/main.py:12 chat_id"));
  assert.ok(text.includes("Plan:"));
  assert.ok(text.includes("- Run `zoroval login` (writes the key to the git-ignored env file), then `zoroval doctor`."));
});

test("a Python project's plan is the Python plan, word for word", () => {
  const { out } = report("python-app");
  assert.deepEqual(out.plan, [
    "Add `zoroval` to the Python dependencies.",
    "Add `import zoroval` and `zoroval.init()` after the existing tracing setup (in handler.py); it attaches to the existing provider.",
    "Wrap each chat turn in `with zoroval.conversation(chat_id):` (candidate at app/main.py:12).",
    "Call `zoroval.flush()` at the end of each serverless handler.",
    "Pre-fork servers: nothing extra; the SDK restarts its export thread after fork.",
    "Run `zoroval login` (writes the key to the git-ignored env file), then `zoroval doctor`.",
    "Production: make a deploy key in the app and set ZOROVAL_INGEST_KEY in the host's secret settings yourself; the skill writes nothing there.",
  ]);
});

// ------------------------------------------------------------------ Node + openai

test("Node app with openai: calls, conversation ids, no false hits from comments, strings or regexes", () => {
  const { out } = report("node-openai", TS_ENV);
  assert.deepEqual(Object.keys(out).slice(0, KEYS.length), KEYS);
  assert.deepEqual(out.llm_calls, [
    { file: "src/chat.ts", line: 10, provider: "openai", api: "chat.completions.create" },
    { file: "src/chat.ts", line: 14, provider: "openai", api: "responses.create" },
    { file: "src/chat.ts", line: 15, provider: "openai", api: "chat.completions.stream" },
    { file: "src/lib.js", line: 5, provider: "openai", api: "fetch" },
    { file: "src/lib.js", line: 6, provider: "openai", api: "fetch" },
  ]);
  assert.deepEqual(out.chat_id_candidates.map((c) => `${c.file}:${c.line}:${c.name}`), [
    "src/chat.ts:9:chatId", "src/chat.ts:19:threadId", "src/chat.ts:19:sessionId", "src/chat.ts:20:conversationId", "src/chat.ts:20:chatId",
  ]);
  assert.deepEqual(out.packages.typescript, { dotenv: "^16.4.0", openai: "^5.0.0", typescript: "^5.6.0" });
  assert.deepEqual(out.services, [{ path: ".", kind: "typescript", manifest: "package.json" }]);
  assert.equal(out.tracing.openai, true);
  assert.deepEqual(out.cases, [1, 9]);
  assert.deepEqual(out.entry_points, []);
  assert.deepEqual(out.typescript, { signals: [] });
  assert.equal(out.env.dotenv_loader, true);
  assert.deepEqual(out.env.env_files, [{ path: ".env", symlink: false, tracked: false, ignored: true, names: ["OPENAI_API_KEY", "OTHER"] }]);
  assert.equal(out.env.repo_is_git, true);
});

test("Node app plan is written for TypeScript: install, wrapOpenAI, wrapFetch, conversation(), flushing, npx login", () => {
  const { out } = report("node-openai", TS_ENV);
  assert.deepEqual(out.plan, [
    "Install the package: `npm install zoroval` (or the project's package manager).",
    "Add `import * as zoroval from \"zoroval\"` and call `zoroval.init()` once when the app starts.",
    "Wrap the OpenAI client: `const openai = zoroval.wrapOpenAI(new OpenAI())`.",
    "Use `zoroval.wrapFetch()` as the `fetch` for the calls to api.openai.com.",
    "Wrap each chat turn in `zoroval.conversation(chatId, () => zoroval.turn({ input }, async (turn) => { ... }))` (candidate at src/chat.ts:9).",
    "Long-running Node servers send spans in the background; in short scripts call `await zoroval.flush()` before exit.",
    "Run `npx zoroval login` (writes the key to .env, which must be git-ignored), then `npx zoroval doctor`.",
  ]);
  assert.ok(out.notes.some((n) => n.startsWith("Several possible conversation ids (chatId, conversationId, sessionId, threadId)")));
});

// ------------------------------------------------------------------ Workers

test("Worker with plain fetch and the nodejs_als flag: entry point, flag reported, no warning", () => {
  const { out } = report("worker-als", WORKER_ENV);
  assert.deepEqual(out.entry_points, [{ file: "src/index.ts", line: 3, kind: "worker" }]);
  assert.deepEqual(out.llm_calls, [{ file: "src/index.ts", line: 6, provider: "openai", api: "fetch" }]);
  assert.deepEqual(out.typescript.worker, { config: "wrangler.toml", main: "src/index.ts", compatibility_flags: ["streams_enable_constructors", "nodejs_als"], nodejs_als: true });
  assert.deepEqual(out.serverless, [{ kind: "cloudflare_worker", file: "wrangler.toml" }]);
  assert.deepEqual(out.chat_id_candidates.map((c) => c.name), ["chatId"]);
  assert.deepEqual(out.notes, []);
  assert.deepEqual(out.cases, [1, 7, 9]);
  assert.deepEqual(out.env.env_files.map((e) => [e.path, e.names]), [[".dev.vars", ["OPENAI_API_KEY"]], [".dev.vars.staging", ["X"]]]);
  assert.ok(out.plan.includes("Worker: in the `fetch` handler (src/index.ts) call `zoroval.init({ apiKey: env.ZOROVAL_INGEST_KEY })` (`import * as zoroval from \"zoroval\"`)."));
  assert.ok(out.plan.includes("Hand the flush to the platform: `ctx.waitUntil(zoroval.flush())` before the `fetch` handler returns."));
  assert.ok(out.plan.includes("Run `npx zoroval login` (writes the key to .dev.vars, which must be git-ignored), then `npx zoroval doctor`."));
  assert.ok(out.plan.includes("Production: make a deploy key in the app and run `wrangler secret put ZOROVAL_INGEST_KEY` yourself; the skill writes nothing there."));
  assert.ok(!out.plan.some((s) => s.includes("nodejs_als to compatibility_flags") || s.startsWith("Add `nodejs_als`")));
});

test("Worker without the flag: reported, noted, and the plan adds the flag", () => {
  const { out } = report("worker-noals", WORKER_ENV);
  assert.deepEqual(out.typescript.worker, { config: "wrangler.jsonc", main: "src/index.ts", compatibility_flags: [], nodejs_als: false });
  assert.ok(out.notes.some((n) => /^wrangler\.jsonc has neither the nodejs_als nor the nodejs_compat/.test(n)));
  assert.ok(out.plan.includes("Add `nodejs_als` to compatibility_flags in wrangler.jsonc; without it turns are not grouped into conversations."));
  assert.deepEqual(out.llm_calls, [{ file: "src/index.ts", line: 5, provider: "openai", api: "fetch" }]); // the URL is held in a variable
  assert.deepEqual(out.chat_id_candidates, []);
});

test("nodejs_compat counts as the flag", () => {
  const dir = makeProject({ files: { "wrangler.toml": 'name="w"\nmain="i.ts"\ncompatibility_flags=["nodejs_compat"]\n', "package.json": "{}", "i.ts": "export default { fetch() {} }" } });
  const out = JSON.parse(detect(dir, "--json").stdout);
  assert.equal(out.typescript.worker.nodejs_als, true);
  assert.deepEqual(out.entry_points, [{ file: "i.ts", line: 1, kind: "worker" }]);
});

// ------------------------------------------------------------------ Next.js

test("Next.js app: route handlers and pages/api are entry points, openai call found, plan names after()", () => {
  const { out } = report("nextjs", TS_ENV);
  assert.deepEqual(out.entry_points, [
    { file: "app/api/chat/route.ts", line: 5, kind: "nextjs_route" },
    { file: "pages/api/legacy.ts", line: 1, kind: "nextjs_api" },
  ]);
  assert.deepEqual(out.llm_calls, [{ file: "app/api/chat/route.ts", line: 7, provider: "openai", api: "chat.completions.create" }]);
  assert.deepEqual(out.chat_id_candidates.map((c) => `${c.file}:${c.line}:${c.name}`), ["app/api/chat/route.ts:6:chatId", "app/api/chat/route.ts:8:chatId", "pages/api/legacy.ts:2:sessionId"]);
  assert.deepEqual(out.typescript, { signals: [{ file: "instrumentation.ts", signal: "next_instrumentation_hook" }], nextjs: true });
  assert.ok(out.plan.some((s) => s.startsWith("Hand the flush to the platform: `after(() => zoroval.flush())`")));
  assert.ok(out.plan.includes("Run `npx zoroval login` (writes the key to .env.local, which must be git-ignored), then `npx zoroval doctor`."));
  assert.ok(out.plan.some((s) => s.startsWith("Production:") && s.includes("Vercel")));
});

// ------------------------------------------------------------------ secrets, errors, limits

test("no env value is ever printed, in JSON or text, and the setup report carries names only", async () => {
  const app = await startApp({ "/api/agent-setup/progress": [202, {}] });
  const dir = prepareFixture(join(fixtures, "node-openai"), { env: { ".env": `OPENAI_API_KEY=${FAKE_SECRET}\nZOROVAL_INGEST_KEY=zv_ingest_abcdefghijkl_0123456789ABCDEFGHIJ\n` } });
  for (const args of [["--json"], []]) {
    // async: the fake app lives in this process and must be able to answer while the CLI runs
    const r = await runCli(["detect", dir, ...args], { env: { ZOROVAL_SETUP: SETUP_CODE, ZOROVAL_APP_URL: app.url } });
    assert.equal(r.code, 0);
    assert.ok(!r.stdout.includes(FAKE_SECRET) && !r.stdout.includes("0123456789ABCDEFGHIJ") && !r.stderr.includes(FAKE_SECRET));
    if (args.length === 0) assert.match(r.stdout, /ZOROVAL_INGEST_KEY: present in \.env/);
  }
  const detected = app.calls.filter((c) => c.body.event === "detected");
  assert.deepEqual(detected[0].body.detail, { apps: ["openai"] });
  assert.ok(!JSON.stringify(app.calls).includes(FAKE_SECRET));
  await app.close();
});

test("a key set in the environment is reported as present (never its value)", () => {
  const dir = makeProject();
  const r = spawnSync(process.execPath, [CLI, "detect", dir, "--json"], { encoding: "utf8", env: { PATH: process.env.PATH, ZOROVAL_INGEST_KEY: "zv_ingest_abcdefghijkl_0123456789ABCDEFGHIJ" } });
  assert.equal(JSON.parse(r.stdout).env.ZOROVAL_INGEST_KEY, "present");
  assert.ok(!r.stdout.includes("0123456789ABCDEFGHIJ"));
});

test("env files: tracked, ignored, symlink flags; unreadable names never throw", () => {
  const dir = makeProject({ files: { ".env": "A=1\n", ".env.test": "B=2\n", "real": "C=3\n" } });
  symlinkSync(join(dir, "real"), join(dir, ".env.link"));
  execFileSync("git", ["add", "-f", ".env.test"], { cwd: dir });
  const out = JSON.parse(detect(dir, "--json").stdout);
  const byPath = Object.fromEntries(out.env.env_files.map((e) => [e.path, e]));
  assert.deepEqual(byPath[".env"], { path: ".env", symlink: false, tracked: false, ignored: true, names: ["A"] });
  assert.equal(byPath[".env.test"].tracked, true);
  assert.equal(byPath[".env.link"].symlink, true);
});

test("an empty folder and a folder without git give a report, not an error", () => {
  const dir = makeProject({ git: false });
  const r = detect(dir, "--json");
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.env.repo_is_git, false);
  assert.deepEqual(out.cases, [9]);
  assert.deepEqual(out.notes, ["No OpenAI or Anthropic client found. Other providers need OTel GenAI instrumentation."]);
  assert.deepEqual(out.plan, ["Run `zoroval login` (writes the key to the git-ignored env file), then `zoroval doctor`."]);
});

test("skipped folders are not scanned: node_modules, .next, dist, build, .wrangler, .vercel", () => {
  const files = {};
  for (const d of ["node_modules/x", ".next/server", "dist", "build", ".wrangler/tmp", ".vercel/output"]) files[`${d}/a.js`] = 'client.chat.completions.create({}); fetch("https://api.openai.com/v1/chat/completions")';
  files["src/real.js"] = "client.chat.completions.create({});";
  const out = JSON.parse(detect(makeProject({ files }), "--json").stdout);
  assert.deepEqual(out.llm_calls.map((c) => c.file), ["src/real.js"]);
});

test("a Python repo with a TypeScript front end gets both, Python plan first", () => {
  const dir = prepareFixture(join(fixtures, "python-langfuse"), { env: {} });
  cpSync(join(fixtures, "nextjs"), join(dir, "web"), { recursive: true });
  const out = JSON.parse(detect(dir, "--json").stdout);
  assert.deepEqual(out.services.map((s) => `${s.kind}:${s.path}`), ["python:.", "typescript:web"]);
  assert.ok(out.llm_calls.some((c) => c.file === "chat.py") && out.llm_calls.some((c) => c.file === "web/app/api/chat/route.ts"));
  assert.equal(out.plan[0], "Add `zoroval` to the Python dependencies.");
  assert.ok(out.plan.includes("Install the package: `npm install zoroval` (or the project's package manager)."));
  assert.equal(out.plan.filter((s) => s.startsWith("Run `")).length, 1);
});

test(".d.ts files and files over 1 MB are not scanned; a file the tokenizer chokes on adds nothing", () => {
  const files = { "types.d.ts": "client.chat.completions.create({});", "big.js": "client.chat.completions.create({});" + " ".repeat(1_000_100), "weird.js": "/* unterminated comment client.chat.completions.create({}); `${" };
  const r = detect(makeProject({ files }), "--json");
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout).llm_calls, []);
});
