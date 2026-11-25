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

for (const name of ["python-app", "python-edge", "python-langfuse", "python-otel", "python-worker-forward"]) {
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
  assert.ok(out.plan.includes("Worker: wrap the default export in src/index.ts: `export default zoroval.withZoroval({ async fetch(request, env, ctx) { ... } })` (`import * as zoroval from \"zoroval\"`). It reads ZOROVAL_INGEST_KEY from the Worker's bindings and sends the trace after the response; no `init()` or `flush()` call is needed."));
  assert.ok(!out.plan.some((s) => s.includes("zoroval.init(") || s.includes("waitUntil")), "the plan says what the guide says: withZoroval, no init or flush");
  assert.ok(out.plan.includes("Run `npx zoroval login` (writes the key to .dev.vars, which must be git-ignored), then `npx zoroval doctor`."));
  assert.ok(out.plan.includes("Production: make a deploy key in the app and run `wrangler secret put ZOROVAL_INGEST_KEY` yourself; the skill writes nothing there."));
  assert.ok(!out.plan.some((s) => s.includes("nodejs_als to compatibility_flags") || s.startsWith("Add `nodejs_als`")));
});

test("Worker calling OpenAI with fetch through a base URL variable: counted, and the plan gives wrapFetch baseURLs", () => {
  const { out } = report("worker-fetch-base", WORKER_ENV);
  assert.deepEqual(out.llm_calls, [
    { file: "src/index.ts", line: 8, provider: "openai", api: "fetch", base_url: "variable" },
    { file: "src/index.ts", line: 14, provider: "openai", api: "fetch", base_url: "variable" },
    { file: "src/index.ts", line: 15, provider: "openai", api: "fetch", base_url: "https://llm.example.com/v1" },
  ]);
  assert.equal(out.tracing.openai, true);
  assert.ok(out.plan.some((s) => s.startsWith("Worker: wrap the default export in src/index.ts: `export default zoroval.withZoroval(")));
  const step = out.plan.find((s) => s.includes("baseURLs"));
  assert.ok(step, out.plan.join("\n"));
  assert.match(step, /src\/index\.ts:8/);
  assert.match(step, /zoroval\.wrapFetch\(fetch, \{ baseURLs: \["https:\/\/llm\.example\.com\/v1"\] \}\)/);
  assert.match(step, /same value the code builds the URL from/);
});

test("Worker without the flag: reported, noted, and the plan adds the flag", () => {
  const { out } = report("worker-noals", WORKER_ENV);
  assert.deepEqual(out.typescript.worker, { config: "wrangler.jsonc", main: "src/index.ts", compatibility_flags: [], nodejs_als: false });
  assert.ok(out.notes.some((n) => /^wrangler\.jsonc has neither the nodejs_als nor the nodejs_compat/.test(n)));
  assert.ok(out.plan.includes("Add `nodejs_als` to compatibility_flags in wrangler.jsonc; without it turns are not grouped into conversations."));
  assert.deepEqual(out.llm_calls, [{ file: "src/index.ts", line: 5, provider: "openai", api: "fetch" }]); // the URL is held in a variable
  assert.deepEqual(out.chat_id_candidates, [{ file: "src/index.ts", line: 4, name: "conversationId" }]); // a `const` counts
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

// ------------------------------------------------------------------ Anthropic and the Vercel AI SDK

test("Anthropic TypeScript app: messages.create and stream() are calls, Twilio's messages.create is not; plan wraps the client", () => {
  const { out } = report("node-anthropic", TS_ENV);
  assert.deepEqual(out.llm_calls, [
    { file: "src/chat.ts", line: 6, provider: "anthropic", api: "messages.create" },
    { file: "src/chat.ts", line: 7, provider: "anthropic", api: "messages.stream" },
  ]);
  assert.deepEqual(out.tracing, { openai: false, anthropic: true });
  assert.deepEqual(out.cases, [1, 9], "OpenTelemetry packages beside a direct Anthropic call: still case 1");
  assert.deepEqual(out.plan, [
    "Install the package: `npm install zoroval` (or the project's package manager).",
    "Add `import * as zoroval from \"zoroval\"` and call `zoroval.init()` once when the app starts.",
    "Wrap the Anthropic client: `const anthropic = zoroval.wrapAnthropic(new Anthropic())`.",
    "Wrap each chat turn in `zoroval.conversation(chatId, () => zoroval.turn({ input }, async (turn) => { ... }))` (candidate at src/chat.ts:5).",
    "Long-running Node servers send spans in the background; in short scripts call `await zoroval.flush()` before exit.",
    "Run `npx zoroval login` (writes the key to .env, which must be git-ignored), then `npx zoroval doctor`.",
  ]);
});

const EXPORTER = "`registerOTel` from `@vercel/otel` with `traceExporter: new OTLPHttpJsonTraceExporter({ url: `${process.env.ZOROVAL_INGEST_URL ?? \"https://ingest.zoroval.com\"}/v1/traces`, headers: { Authorization: `Bearer ${process.env.ZOROVAL_INGEST_KEY}` } })`";

test("Vercel AI SDK 7 app: no zoroval package, init() or flush(); @ai-sdk/otel with runtimeContext; the route's id is the chat id", () => {
  const { out } = report("ai-sdk7", { ".env.local": `OPENAI_API_KEY=${FAKE_SECRET}\n` });
  assert.deepEqual(out.cases, [6, 9]);
  assert.deepEqual(out.tracing.vercel_ai, { spec: "^7.0.0", major: 7 });
  assert.deepEqual(out.chat_id_candidates[0], { file: "app/api/chat/route.ts", line: 6, name: "id" });
  assert.deepEqual(out.plan, [
    "No `zoroval` package, `init()` or `flush()` is needed: the traces go to Zoroval over OpenTelemetry.",
    "Install `@ai-sdk/otel` and `@vercel/otel`: AI SDK 7 sends telemetry only through a registered integration.",
    `In instrumentation.ts (Next.js runs its \`register()\`): \`registerTelemetry(new OpenTelemetry({ runtimeContext: true }))\` (\`registerTelemetry\` from \`ai\`, \`OpenTelemetry\` from \`@ai-sdk/otel\`), then ${EXPORTER}.`,
    "On each AI SDK call (`streamText`, `generateText`), pass the chat id: `runtimeContext: { sessionId: id }, telemetry: { functionId: \"chat\", includeRuntimeContext: { sessionId: true } }` (candidate at app/api/chat/route.ts:6). Do not use `experimental_telemetry` metadata: AI SDK 7 drops it.",
    "Run `npx zoroval login` (writes the key to .env.local, which must be git-ignored), then `npx zoroval doctor`.",
    "Production: make a deploy key in the app and add ZOROVAL_INGEST_KEY to the host's environment variables (for Vercel, the project's settings) yourself; the skill writes nothing there.",
  ]);
  assert.ok(!out.plan.some((step) => /npm install zoroval|zoroval\.init\(|zoroval\.flush\(/.test(step)));
});

test("Vercel AI SDK 6 app: registerOTel and experimental_telemetry metadata; a version with no number assumes AI SDK 7 and says so", () => {
  const { out } = report("ai-sdk6", { ".env.local": "X=1\n" });
  assert.deepEqual(out.plan.slice(0, 4), [
    "No `zoroval` package, `init()` or `flush()` is needed: the traces go to Zoroval over OpenTelemetry.",
    "Install `@vercel/otel`.",
    `In instrumentation.ts (Next.js runs its \`register()\`): ${EXPORTER}.`,
    "On each AI SDK call (`streamText`, `generateText`), pass the chat id: `experimental_telemetry: { isEnabled: true, functionId: \"chat\", metadata: { sessionId: id } }` (candidate at app/api/chat/route.ts:6).",
  ]);
  const dir = makeProject({ files: {
    "package.json": JSON.stringify({ dependencies: { ai: "latest", "@ai-sdk/otel": "latest", "@vercel/otel": "^2.0.0" } }),
    "chat.ts": "import { generateText } from \"ai\";\nexport const run = (chatId: string) => generateText({ prompt: chatId } as any);\n",
  } });
  const latest = JSON.parse(detect(dir, "--json").stdout);
  assert.ok(latest.notes.some((n) => n.startsWith("Vercel AI SDK version \"latest\" has no number")));
  assert.ok(latest.plan.some((step) => step.includes("runtimeContext: { sessionId: chatId }")));
  assert.ok(!latest.plan.some((step) => step.startsWith("Install `")), "nothing to install: both packages are there");
});

test("AI SDK beside a direct OpenAI call: the SDK steps for the direct call, then the AI SDK steps", () => {
  const dir = makeProject({ files: {
    "package.json": JSON.stringify({ dependencies: { ai: "^7.0.0", openai: "^5.0.0" } }),
    "chat.ts": "import OpenAI from \"openai\";\nconst openai = new OpenAI();\nexport const ask = (chatId: string) => openai.chat.completions.create({ model: \"m\", messages: [] });\n",
  } });
  const out = JSON.parse(detect(dir, "--json").stdout);
  assert.deepEqual(out.cases, [1, 6, 9]);
  assert.equal(out.plan[0], "Install the package: `npm install zoroval` (or the project's package manager).");
  assert.ok(out.plan.includes("Wrap the OpenAI client: `const openai = zoroval.wrapOpenAI(new OpenAI())`."));
  assert.ok(out.plan.some((step) => step.includes("registerTelemetry(new OpenTelemetry({ runtimeContext: true }))")));
  assert.ok(!out.plan.some((step) => step.startsWith("No `zoroval` package")));
});

test("Python model calls beside an AI SDK web app: Python steps, then the AI SDK steps (case 6 is kept)", () => {
  const files = {
    "requirements.txt": "openai\n",
    "chat.py": "from openai import OpenAI\nclient = OpenAI()\ndef ask(chat_id):\n    return client.chat.completions.create(model=\"m\", messages=[])\n",
    "web/package.json": JSON.stringify({ dependencies: { ai: "^7.0.0", next: "16.0.0" } }),
  };
  const out = JSON.parse(detect(makeProject({ files }), "--json").stdout);
  assert.deepEqual(out.cases, [1, 6, 9]);
  assert.equal(out.tracing.vercel_ai, undefined, "a Python project's report keeps the Python CLI's keys");
  assert.equal(out.plan[0], "Add `zoroval` to the Python dependencies.");
  assert.ok(out.plan.includes("TypeScript: the app needs no `zoroval` npm package; its traces go to Zoroval over OpenTelemetry."));
  assert.ok(out.plan.some((step) => step.includes("registerTelemetry(new OpenTelemetry({ runtimeContext: true }))")));
});

test("a destructured { id, messages } body names id; other ids do not", () => {
  const files = {
    "package.json": JSON.stringify({ dependencies: { openai: "^5.0.0" } }),
    "a.ts": "export async function POST(req: Request) {\n  const { id, messages } = await req.json();\n  const { id: userId } = await req.json();\n  const { id: x, name } = other;\n  return f(id, messages);\n}\nfunction g({ id, name }) { return id; }\n",
  };
  const out = JSON.parse(detect(makeProject({ files }), "--json").stdout);
  assert.deepEqual(out.chat_id_candidates.map((c) => `${c.line}:${c.name}`), ["2:id"]);
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
  assert.match(out.plan[0], /^Two languages in this repo \(Python: chat\.py in the repo root; TypeScript: web\/app\/api\/chat\/route\.ts in web\)/);
  assert.equal(out.plan[1], "Add `zoroval` to the Python dependencies.");
  assert.ok(out.plan.includes("Install the package in `web`: `npm install zoroval` (or the project's package manager)."));
  assert.equal(out.plan.filter((s) => s.startsWith("Run `")).length, 1);
});

test(".d.ts files and files over 1 MB are not scanned; a file the tokenizer chokes on adds nothing", () => {
  const files = { "types.d.ts": "client.chat.completions.create({});", "big.js": "client.chat.completions.create({});" + " ".repeat(1_000_100), "weird.js": "/* unterminated comment client.chat.completions.create({}); `${" };
  const r = detect(makeProject({ files }), "--json");
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout).llm_calls, []);
});

// ------------------------------------------------------------------ Express, Hono, Fastify (added last)

test("Express, Hono and Fastify servers are entry points, after the Worker and Next.js ones", () => {
  const express = report("express-app", TS_ENV).out;
  assert.deepEqual(express.entry_points, [{ file: "src/server.ts", line: 4, kind: "express" }]);
  assert.ok(express.plan.includes("Add `import * as zoroval from \"zoroval\"` and call `zoroval.init()` once when the app starts (for example in src/server.ts)."));
  const fastify = report("fastify-app", TS_ENV).out;
  assert.deepEqual(fastify.entry_points, [{ file: "server.js", line: 1, kind: "fastify" }]);
  const hono = report("hono-worker", WORKER_ENV).out;
  // the Worker `main` is already an entry point: the framework adds no second one for the same file
  assert.deepEqual(hono.entry_points, [{ file: "src/index.ts", line: null, kind: "worker" }]);
  assert.equal(hono.typescript.worker.nodejs_als, true);
  assert.deepEqual(hono.llm_calls, [{ file: "src/index.ts", line: 6, provider: "openai", api: "fetch" }]);
});

test("a Hono app that is not a Worker main is still found; a server import without the call is not an entry point", () => {
  const dir = makeProject({ files: { "package.json": '{"dependencies":{"hono":"4"}}', "src/app.ts": 'import { Hono } from "hono";\nexport const app = new Hono();', "src/types.ts": 'import type { Request } from "express";\nexport type R = Request;' } });
  const out = JSON.parse(detect(dir, "--json").stdout);
  assert.deepEqual(out.entry_points, [{ file: "src/app.ts", line: 2, kind: "hono" }]);
});

// ------------------------------------------------------------------ the language follows where the model is called

test("a Python app behind a forwarding Worker is a Python project: no TypeScript plan, no Worker notes, Python's own report", () => {
  const { out } = report("python-worker-forward");
  assert.deepEqual(out.llm_calls, [{ file: "prompt.py", line: 7, provider: "openai", api: "responses.parse" }]);
  assert.deepEqual(out.typescript, { signals: [] });
  assert.deepEqual(out.entry_points, [{ file: "main.py", line: null, kind: "script" }]);
  assert.deepEqual(out.serverless, []);
  assert.ok(out.plan.every((s) => !/npm|wrangler|nodejs_als|Worker|npx/.test(s)), out.plan.join("\n"));
  assert.ok(out.plan.includes("Run `zoroval login` (writes the key to the git-ignored env file), then `zoroval doctor`."));
  assert.ok(out.notes.every((n) => !/nodejs_als|compatibility/.test(n)));
  assert.deepEqual(out.env.env_files.map((e) => e.path), [".env", ".env.example"]);
});

test("a Worker with its own model call is a TypeScript project, noted when it lacks the flag", () => {
  const { out } = report("worker-noals", WORKER_ENV);
  assert.ok(out.notes.some((n) => /nodejs_als/.test(n)));
  assert.ok(out.plan.some((s) => s.startsWith("Install the package: `npm install zoroval`")));
});

test("a repo with a model call in Python and one in a Worker names both SDKs", () => {
  const { out } = report("mixed-worker", WORKER_ENV);
  assert.equal(out.plan[0], "Two languages in this repo (Python: app/prompt.py in the repo root; TypeScript: worker/index.ts in worker): set each one up with its own SDK (`pip install zoroval` for Python, `npm install zoroval` for TypeScript).");
  assert.ok(out.plan.includes("Add `zoroval` to the Python dependencies."));
  assert.ok(out.plan.includes("Install the package in `worker`: `npm install zoroval` (or the project's package manager)."));
  assert.ok(out.notes.some((n) => /^wrangler\.toml has neither the nodejs_als/.test(n)));
  assert.deepEqual(out.llm_calls.map((c) => c.file), ["app/prompt.py", "worker/index.ts"]);
});

test("no model call anywhere: the plan follows the manifests", () => {
  const dir = makeProject({ files: { "requirements.txt": "flask\n", "web/package.json": "{}" } });
  const out = JSON.parse(detect(dir, "--json").stdout);
  assert.ok(out.notes.includes("No OpenAI or Anthropic client found. Other providers need OTel GenAI instrumentation."));
  assert.ok(out.plan[0].startsWith("Two languages in this repo:"));
  const pyOnly = JSON.parse(detect(makeProject({ files: { "requirements.txt": "flask\n" } }), "--json").stdout);
  assert.equal(pyOnly.plan[0], "Add `zoroval` to the Python dependencies.");
});

// ------------------------------------------------------------------ services: the model call decides, per package

test("a Python app, a forwarding Worker and a TypeScript chat service: two services, a plan for each, nothing for the Worker", () => {
  const { out } = report("split-python-ts", { ".env": `OPENAI_API_KEY=${FAKE_SECRET}\n` });
  assert.deepEqual(out.services, [
    { path: ".", kind: "python", manifest: "requirements.txt" },
    { path: "ts", kind: "typescript", manifest: "ts/package.json" },
  ]);
  assert.deepEqual(out.llm_calls.map((c) => `${c.file}:${c.line}`), ["prompt.py:7", "ts/src/operation.ts:6"]);
  // nothing for the Worker: no entry point, no Worker block, no serverless entry, no note, no plan step
  assert.ok(!out.entry_points.some((e) => e.kind === "worker" || e.file === "src/index.ts"));
  assert.equal(out.typescript.worker, undefined);
  assert.deepEqual(out.serverless, []);
  assert.ok(out.notes.every((n) => !/nodejs_als|compatibility|wrangler/i.test(n)));
  assert.ok(out.plan.every((s) => !/wrangler|nodejs_als|waitUntil|Worker/.test(s)), out.plan.join("\n"));
  // Python plan, then the TypeScript plan for the `ts` service
  assert.match(out.plan[0], /^Two languages in this repo \(Python: prompt\.py in the repo root; TypeScript: ts\/src\/operation\.ts in ts\)/);
  assert.ok(out.plan.includes("Add `zoroval` to the Python dependencies."));
  assert.ok(out.plan.includes("Install the package in `ts`: `npm install zoroval` (or the project's package manager)."));
  assert.ok(out.plan.includes("Wrap each chat turn in `zoroval.conversation(chatId, () => zoroval.turn({ input }, async (turn) => { ... }))` (candidate at ts/src/app.ts:3)."));
  assert.ok(out.plan.some((s) => s.includes("(for example in ts/src/")));
});

test("Worker app with a React front end: the call through a fetch alias is found, and the Worker's chat id comes before the browser's", () => {
  const dir = makeProject({ files: {
    "package.json": '{"dependencies":{"react":"19"},"devDependencies":{"wrangler":"4"}}',
    "wrangler.jsonc": '{ "name": "w", "main": "worker/index.ts", "compatibility_flags": ["nodejs_als"] }',
    "src/Chat.tsx": 'import { useRef } from "react";\nexport function Chat() {\n  const chatId = useRef(crypto.randomUUID());\n  return null;\n}',
    "shared/agent.ts": 'export async function runAgent(opts) {\n  const doFetch = opts.fetchImpl ?? fetch;\n  return doFetch("https://api.openai.com/v1/responses", { method: "POST" });\n}',
    "worker/index.ts": 'import { runAgent } from "../shared/agent";\nexport default {\n  async fetch(req, env) {\n    const body = await req.json();\n    const chatId = body.chatId;\n    return Response.json(await runAgent({}));\n  },\n};',
  } });
  const r = detect(dir, "--json");
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.llm_calls, [{ file: "shared/agent.ts", line: 3, provider: "openai", api: "fetch" }]);
  assert.equal(out.chat_id_candidates[0].file, "worker/index.ts");
  assert.equal(out.chat_id_candidates.at(-1).file, "src/Chat.tsx");
  assert.ok(out.plan.some((s) => s.includes("candidate at worker/index.ts:")), out.plan.join("\n"));
});

test("TypeScript chat ids: const, let and assignments count, plain comparisons do not", () => {
  const { out } = report("split-python-ts", { ".env": "A=1\n" });
  const ts = out.chat_id_candidates.filter((c) => c.file.startsWith("ts/")).map((c) => `${c.file}:${c.line}:${c.name}`);
  assert.deepEqual(ts, ["ts/src/app.ts:3:chatId", "ts/src/chat.ts:5:chatId"]);
});

test("terminal programs are entry points: package.json scripts and bin, readline and argv mains; tests are not", () => {
  const { out } = report("split-python-ts", { ".env": "A=1\n" });
  assert.deepEqual(out.entry_points.filter((e) => e.file.endsWith(".ts")), [
    { file: "ts/src/ask.ts", line: null, kind: "script" },
    { file: "ts/src/chat.ts", line: null, kind: "script" },
  ]);
  const dir = makeProject({ files: { "package.json": '{"bin":{"tool":"./cli/run.js"},"scripts":{"start":"node --env-file=.env server/main.mjs && echo done"}}', "cli/run.js": "console.log(1)", "server/main.mjs": "console.log(2)", "lib/read.ts": 'import rl from "node:readline"; rl.createInterface({});', "lib/plain.ts": "export const x = 1;" } });
  const found = JSON.parse(detect(dir, "--json").stdout).entry_points.map((e) => e.file).sort();
  assert.deepEqual(found, ["cli/run.js", "lib/read.ts", "server/main.mjs"]);
});

test("the chat plan step is always there for a chat app; with no candidate it says to ask", () => {
  const dir = makeProject({ files: { "package.json": '{"dependencies":{"openai":"5"}}', "src/answer.ts": 'import OpenAI from "openai";\nconst o = new OpenAI();\nexport const go = () => o.chat.completions.create({ model: "m", messages: [] });' } });
  const out = JSON.parse(detect(dir, "--json").stdout);
  assert.deepEqual(out.chat_id_candidates, []);
  assert.ok(out.plan.includes("Wrap each chat turn in `zoroval.conversation(chatId, () => zoroval.turn({ input }, async (turn) => { ... }))`; no conversation id was found, so ask the developer which variable is the chat id."));
});

test("detect on the TypeScript service alone gives the TypeScript plan", () => {
  const dir = prepareFixture(join(fixtures, "split-python-ts", "ts"), { env: { ".env": "A=1\n" } });
  const out = JSON.parse(detect(dir, "--json").stdout);
  assert.deepEqual(out.services, [{ path: ".", kind: "typescript", manifest: "package.json" }]);
  assert.ok(out.plan.some((s) => s.startsWith("Install the package:")));
  assert.ok(out.plan.includes("Run `npx zoroval login` (writes the key to .env, which must be git-ignored), then `npx zoroval doctor`."));
});

test("a Worker that calls a model in its own package still gets its plan next to a Python app", () => {
  const { out } = report("mixed-worker", WORKER_ENV);
  assert.ok(out.plan.some((s) => s.includes("zoroval.withZoroval(")));
  assert.equal(out.typescript.worker.config, "wrangler.toml");
});
