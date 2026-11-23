// Check 3: a real Next.js app (Node route and Edge route) using the packed SDK, against the fake OpenAI
// and the fake gateway. Slow and networked (it installs Next), so it is not part of `npm test`.
// usage: node test/nextjs/run.mjs
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { KEY, startGateway } from "../gateway.mjs";
import { startFakeOpenAI } from "../fake-openai.mjs";

// Whatever hangs, this ends the run with a message instead of the CI job's own timeout.
setTimeout(() => { console.error("test:next did not finish within 10 minutes"); process.exit(1); }, 600_000).unref();

const root = fileURLToPath(new URL("../..", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "zoroval-next-"));
const app = join(work, "app");
const run = (cmd, args, cwd, env = {}) => execFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, ...env }, encoding: "utf8" });

// 1. Pack the SDK like a release (so conditional exports, `files` and types are what a developer gets).
execFileSync("npm", ["run", "build"], { cwd: root, stdio: "ignore" });
const tarball = run("npm", ["pack", "--pack-destination", work, "--silent"], root).trim().split("\n").pop();
// 2. A separate app with its own package.json: Next is not a dependency of the SDK.
cpSync(fileURLToPath(new URL("./fixture", import.meta.url)), app, { recursive: true });
run("npm", ["install", "--no-audit", "--no-fund", join(work, tarball)], app);
run("npx", ["next", "build"], app, { NEXT_TELEMETRY_DISABLED: "1" });

const port = await new Promise((resolve) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const gateway = await startGateway();
const fake = await startFakeOpenAI({ chunkDelayMs: 5 });
// Next is started with node itself, in its own process group. Through `npx` (a shell and a wrapper) a
// SIGTERM reached only the wrapper on Linux: `next start` stayed alive holding our pipes and the run never ended.
const server = spawn(process.execPath, [join(app, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(port)], {
  cwd: app, stdio: ["ignore", "pipe", "pipe"], detached: true,
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ZOROVAL_INGEST_KEY: KEY, ZOROVAL_INGEST_URL: gateway.url, OPENAI_BASE: fake.url, ZOROVAL_SERVICE_NAME: "next-fixture" },
});
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));
let exited = false;
server.on("exit", () => { exited = true; });
try {
  const readyBy = Date.now() + 60_000;
  while (!/Ready|started server/i.test(log)) {
    if (exited) throw new Error("next start exited before it was ready");
    if (Date.now() > readyBy) throw new Error("next start was not ready after 60 s");
    await new Promise((r) => setTimeout(r, 100));
  }
  const post = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    return { status: response.status, text: await response.text() };
  };
  for (const [route, chat] of [["node", "N"], ["edge", "E"]]) {
    const first = await post(`/api/${route}`, { chatId: chat, text: `weather in ${chat}?` });
    assert.equal(first.status, 200, first.text);
    assert.match(first.text, /call_abc123/);
    const second = await post(`/api/${route}`, { chatId: chat, text: `now stream ${chat}`, stream: true });
    assert.equal(second.status, 200, second.text);
    assert.match(second.text, /"content":"said: "/);
  }
  const wanted = () => gateway.spans().filter((s) => s.attrs["zoroval.observation.type"] === "generation").length >= 4;
  for (let i = 0; i < 200 && !wanted(); i++) await new Promise((r) => setTimeout(r, 100));
  const spans = gateway.spans();
  for (const [route, chat] of [["node", "N"], ["edge", "E"]]) {
    const turns = spans.filter((s) => s.attrs["zoroval.observation.type"] === "turn" && s.attrs["zoroval.conversation.id"] === chat);
    const gens = spans.filter((s) => s.attrs["zoroval.observation.type"] === "generation" && s.attrs["zoroval.conversation.id"] === chat);
    assert.equal(turns.length, 2, `${route}: two turns in one conversation`);
    assert.equal(gens.length, 2, `${route}: two generations`);
    assert.ok(turns.every((t) => t.attrs["zoroval.user.id"] === "u-" + chat && t.attrs["zoroval.grouping"] === "explicit"));
    const plain = gens.find((g) => g.attrs["gen_ai.request.stream"] === false);
    const streamed = gens.find((g) => g.attrs["gen_ai.request.stream"] === true);
    assert.equal(plain.attrs["gen_ai.request.model"], "gpt-test");
    assert.equal(plain.attrs["gen_ai.usage.input_tokens"], 21);
    assert.equal(JSON.parse(plain.attrs["zoroval.tool_calls"])[0].id, "call_abc123");
    assert.equal(JSON.parse(plain.attrs["gen_ai.input.messages"])[0].parts[0].content, `weather in ${chat}?`);
    assert.equal(JSON.parse(streamed.attrs["gen_ai.output.messages"])[0].parts[0].content, `You said: now stream ${chat}`, `${route}: the streamed answer is complete in the span`);
    assert.ok(turns.some((t) => t.spanId === plain.parentSpanId));
    console.log(`ok - Next.js ${route} route: 2 turns in one conversation, tokens, input/output messages, tool call, streamed reply captured`);
  }
  assert.equal(new Set(spans.map((s) => s.traceId)).size >= 4, true);
} catch (error) {
  console.error("--- next server log ---\n" + log.slice(-4000));
  throw error;
} finally {
  // the whole process group, then a hard kill if it ignores the first signal
  const stop = (signal) => { try { process.kill(-server.pid, signal); } catch { /* already gone */ } };
  stop("SIGTERM");
  const gone = new Promise((resolve) => (exited ? resolve() : server.once("exit", resolve)));
  await Promise.race([gone, new Promise((r) => setTimeout(r, 5000))]);
  stop("SIGKILL");
  server.stdout.destroy();
  server.stderr.destroy();
  await fake.close();
  await gateway.close();
  rmSync(work, { recursive: true, force: true });
}
process.exit(0);
