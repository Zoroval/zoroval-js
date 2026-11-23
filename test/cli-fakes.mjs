// Fakes for the CLI tests: an app server (agent-connect, token, setup progress) and a gateway
// (ingest status and traces), shaped like the real endpoints, plus a runner for the built CLI.
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { flat } from "./gateway.mjs";

export const KEY = "zv_ingest_abcdefghijkl_0123456789ABCDEFGHIJ";
export const SETUP_CODE = "zvs_tree_" + "a1B2c3D4e5F6g7H8i9J0k1L2";
export const DEVICE_CODE = "d".repeat(43);
export const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function listen(handler) {
  const server = createServer(handler);
  server.unref(); // a failed test must not keep the run alive
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      server,
      url: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(done); }),
    }));
  });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * `routes[path]` is a function (body, callIndex) => [status, json, headers?] or a fixed [status, json].
 * Unknown paths answer 404, like the real app when the feature is off. `calls` records every request.
 */
export async function startApp(routes = {}) {
  const calls = [];
  const counts = {};
  const { server, url, close } = await listen(async (req, res) => {
    const raw = await readBody(req);
    let body = {};
    try { body = JSON.parse(raw.toString("utf8") || "{}"); } catch { /* not json */ }
    const path = req.url.split("?")[0];
    const index = counts[path] = (counts[path] ?? -1) + 1;
    calls.push({ path, method: req.method, body, headers: req.headers, at: Date.now() });
    const route = routes[path];
    const [status, payload, headers] = typeof route === "function" ? await route(body, index) : route ?? [404, {}];
    if (status === "hang") return; // never answer
    const data = typeof payload === "string" ? payload : JSON.stringify(payload);
    res.writeHead(status, { "content-type": "application/json", ...(headers ?? {}) });
    res.end(data);
  });
  return { url, calls, close, paths: () => calls.map((c) => c.path), events: () => calls.filter((c) => c.path === "/api/agent-setup/progress").map((c) => c.body.event) };
}

/** A device-flow reply like the real `POST /api/agent-connect`. */
export function connectReply(extra = {}) {
  return {
    device_code: DEVICE_CODE, user_code: "ABCD-2345", verification_uri: "https://app.test/connect",
    verification_uri_complete: "https://app.test/connect?code=ABCD-2345", expires_in: 600, interval: 0.05, ...extra,
  };
}

/** A key reply like the real `POST /api/agent-connect/token`. */
export function keyReply(extra = {}) {
  return { key: KEY, key_id: "abcdefghijkl", project_id: "p1", project_key: "proj_1", ingest_url: "https://ingest.zoroval.com", env_var: "ZOROVAL_INGEST_KEY", ...extra };
}

/** The setup-code refusals the real server sends (`SETUP_REFUSED`). */
export const REFUSALS = {
  unknown: [404, { error: "setup_code_invalid", message: "This setup code is not valid. Copy a fresh prompt from Zoroval." }],
  expired: [410, { error: "setup_code_expired", message: "This setup code has expired. Copy a fresh prompt from Zoroval." }],
  used: [409, { error: "setup_code_used", message: "This setup code was already used. Copy a fresh prompt from Zoroval." }],
  noRoom: [403, { error: "project_limit", message: "Your plan has reached its project limit." }],
};

/**
 * A gateway with `GET /v1/ingest/status` and `POST /v1/traces`. It checks the bearer key, gunzips and
 * parses the OTLP JSON, and answers batch polls from what it received.
 * `options`: key, batchStatus (done|failed|received), groupTurns (true: the two turns become one trace),
 * since (extra `since` fields), firstTrace, statusCode (override for the status endpoint), tracesStatus.
 */
export async function startGateway(options = {}) {
  const o = { key: KEY, batchStatus: "done", groupTurns: true, since: {}, firstTrace: null, project: "proj_1", ...options };
  const requests = [];
  const batches = new Map();
  const { url, close } = await listen(async (req, res) => {
    const path = req.url.split("?")[0];
    const query = new URL(req.url, "http://x").searchParams;
    const record = { method: req.method, url: req.url, path, headers: req.headers, at: Date.now() };
    requests.push(record);
    const send = (status, payload, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(payload));
    };
    if (req.headers.authorization !== `Bearer ${o.key}`) return send(401, { code: 16, message: "invalid_key" });
    if (path === "/v1/traces" && req.method === "POST") {
      let raw = await readBody(req);
      if (req.headers["content-encoding"] === "gzip") raw = gunzipSync(raw);
      record.raw = JSON.parse(raw.toString("utf8"));
      record.spans = [];
      for (const rs of record.raw.resourceSpans ?? []) {
        record.resource = flat(rs.resource?.attributes);
        record.scope = rs.scopeSpans?.[0]?.scope;
        for (const ss of rs.scopeSpans ?? []) for (const span of ss.spans ?? []) record.spans.push({ ...span, attrs: flat(span.attributes), rawAttrs: span.attributes });
      }
      const batchId = req.headers["x-zoroval-batch-id"];
      const turns = record.spans.filter((s) => s.attrs["zoroval.observation.type"] === "turn").length;
      const conversations = new Set(record.spans.map((s) => s.attrs["zoroval.conversation.id"]));
      const traceIds = o.groupTurns ? [...conversations].map((c) => `trace-${c}`) : [...new Set(record.spans.map((s) => s.traceId))];
      batches.set(batchId, { turns, traceIds, spans: record.spans.length });
      if (o.tracesStatus) return send(o.tracesStatus, { code: 2, message: o.tracesMessage ?? "failed" });
      return send(200, {});
    }
    if (path === "/v1/ingest/status") {
      if (o.statusCode) return send(o.statusCode, { message: o.statusMessage ?? "unavailable" });
      const body = {
        project_id: "p1", project_key: o.project, first_trace_received_at: o.firstTrace, last_trace_received_at: o.firstTrace,
        since: { turns: 0, traces: 0, ungrouped_turns: 0, dropped_spans_reported: 0, errors: [], ...o.since },
      };
      const ref = query.get("batch_id");
      if (ref) {
        const seen = batches.get(ref);
        if (!seen) body.batch = { id: ref, status: "unknown" };
        else {
          const done = o.batchStatus === "done";
          body.batch = { id: ref, status: o.batchStatus, spans_received: seen.spans, spans_rejected: 0, trace_ids: done ? seen.traceIds : [], attempts: 1, retrying: false };
          if (done) body.since.turns = Math.max(body.since.turns, seen.turns);
        }
      }
      return send(200, body);
    }
    return send(404, { message: "not_found" });
  });
  return { url, requests, close, posts: () => requests.filter((r) => r.method === "POST"), gets: () => requests.filter((r) => r.method === "GET") };
}

/** A temporary project folder: a git repo that ignores `.env*` and `.dev.vars` unless `git: false`. */
export function makeProject({ git = true, ignore = [".env", ".env.local", ".dev.vars"], files = {} } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "zoroval-cli-")));
  if (git) {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, ".gitignore"), ignore.join("\n") + "\n");
  }
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("ZOROVAL_") && k !== "CI"));

/** Run the built CLI. Resolves { code, stdout, stderr }. */
export function runCli(args, { cwd, env = {}, timeout = 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...CLEAN_ENV, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
