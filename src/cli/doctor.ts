/**
 * `zoroval doctor`: prove the setup works (`GET /v1/ingest/status`).
 *
 * 1. Finds the key (environment or env file) and checks its format. Never prints it.
 * 2. Checks the gateway accepts the key.
 * 3. Sends a test trace: two test turns with one conversation id (`zoroval.test = true`), each with
 *    a child step, encoded and sent by the SDK's own OTLP JSON and gzip transport.
 * 4. Waits for its batch to reach `done` and checks the two turns became one trace.
 * 5. Reports "first trace received" for real app traffic, and warns about ungrouped turns and
 *    dropped spans in the last 24 hours. With --wait N it waits up to N seconds for the first app trace.
 *
 * Same checks, order, levels and text as the Python CLI, plus one TypeScript check: a Cloudflare Worker
 * with neither `nodejs_als` nor `nodejs_compat` cannot carry the conversation across `await`, so turns
 * are not grouped.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { resolve as resolveConfig, tracesUrl, keyIdOf } from "../config.js";
import { nowMs } from "../runtime.js";
import { KIND_INTERNAL, Span } from "../span.js";
import type { AttrValue } from "../span.js";
import { Transport } from "../transport.js";
import { sleep, uuid7 } from "../util.js";
import { VERSION } from "../version.js";
import * as envfile from "./envfile.js";
import { getJson } from "./http.js";
import type { Json } from "./http.js";
import { CMD } from "./login.js";
import { envFileCandidates, findWrangler } from "./project.js";
import * as setupReport from "./setup-report.js";
import { DEFAULT_INGEST_URL } from "./constants.js";

export const PASS = "pass";
export const WARN = "warn";
export const FAIL = "fail";
export type Level = typeof PASS | typeof WARN | typeof FAIL;

export interface Check {
  level: Level;
  check: string;
  detail: string;
}

export class Report {
  checks: Check[] = [];

  add(level: Level, check: string, detail: string): void {
    this.checks.push({ level, check, detail });
  }

  get ok(): boolean {
    return !this.checks.some((c) => c.level === FAIL);
  }
}

/** `2026-11-23T10:00:00.123456Z`: the form Python writes; the gateway reads three or six digits. */
function rfc3339(date: Date): string {
  return date.toISOString().replace("Z", "000Z");
}

const PACKAGES = ["openai", "@anthropic-ai/sdk", "langfuse", "@opentelemetry/sdk-node"];

function installedVersion(root: string, name: string): string | null {
  for (let dir = root; ; dir = dirname(dir)) {
    const file = join(dir, "node_modules", name, "package.json");
    if (existsSync(file)) {
      try {
        const version = JSON.parse(readFileSync(file, "utf8")).version;
        return typeof version === "string" ? version : null;
      } catch {
        return null;
      }
    }
    if (dirname(dir) === dir) return null;
  }
}

/** The key (environment first, then the env files), its source and URL. Used, never shown. */
function findKey(files: string[], root: string): { key: string | null; source: string; url: string | null } {
  const url = process.env.ZOROVAL_INGEST_URL || null;
  const fromEnv = process.env[envfile.KEY_VAR];
  if (fromEnv) return { key: fromEnv.trim(), source: "environment", url };
  for (const file of files) {
    const path = envfile.resolveEnvPath(root, file);
    if (!existsSync(path)) continue;
    const key = envfile.readValue(path, envfile.KEY_VAR);
    if (key) return { key: key.trim(), source: basename(path), url: url || envfile.readValue(path, envfile.URL_VAR) };
  }
  return { key: null, source: "", url };
}

/** Two test turns in one conversation, each with a child step: what the SDK sends for a chat. */
export function testSpans(): { spans: Span[]; conversation: string } {
  const conversation = `zoroval-doctor-${randomUUID()}`;
  const spans: Span[] = [];
  for (let index = 0; index < 2; index++) {
    const turn = new Span("zoroval doctor turn", KIND_INTERNAL, null, {
      "zoroval.observation.type": "turn",
      "zoroval.conversation.id": conversation,
      "gen_ai.conversation.id": conversation,
      "zoroval.test": true, // a boolean: it ticks "Test trace" and never counts as production
      "zoroval.grouping": "explicit",
      "zoroval.input": JSON.stringify(`zoroval doctor test turn ${index + 1}`),
    } satisfies Record<string, AttrValue>);
    const step = new Span("zoroval doctor step", KIND_INTERNAL, turn, {
      "zoroval.observation.type": "step",
      "zoroval.conversation.id": conversation,
      "gen_ai.conversation.id": conversation,
    });
    step.end();
    turn.end();
    spans.push(step, turn);
  }
  return { spans, conversation };
}

export interface DoctorOptions {
  root: string;
  /** An explicit `--env-file`; null looks in the project's usual env files. */
  envFile: string | null;
  ingestUrl?: string;
  timeoutS: number;
  waitS: number;
  skipTestTrace?: boolean;
}

const num = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};
const obj = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {});

function workerCheck(report: Report, root: string): void {
  const worker = findWrangler(root);
  if (!worker || worker.als) return;
  const how = worker.file.endsWith(".toml")
    ? 'compatibility_flags = ["nodejs_als"]'
    : '"compatibility_flags": ["nodejs_als"]';
  report.add(
    WARN,
    "worker context",
    `${worker.file} has neither the nodejs_als nor the nodejs_compat compatibility flag, so turns will not be grouped into conversations. ` +
      `Add ${how} to ${worker.file} and deploy again.`,
  );
}

export async function run(o: DoctorOptions): Promise<Report> {
  const report = new Report();
  report.add(PASS, "sdk", `zoroval ${VERSION}`);
  for (const name of PACKAGES) {
    const version = installedVersion(o.root, name);
    if (version) report.add(PASS, `package ${name}`, version);
  }
  workerCheck(report, o.root);

  const files = o.envFile ? [o.envFile] : envFileCandidates(o.root);
  const { key, source, url: fileUrl } = findKey(files, o.root);
  if (!key) {
    report.add(FAIL, "key", `${envfile.KEY_VAR} not found in the environment or ${files.join(", ")}. Run \`${CMD} login\`.`);
    return report;
  }
  const keyId = keyIdOf(key);
  if (keyId === null) {
    report.add(FAIL, "key", `${envfile.KEY_VAR} (from ${source}) is not a Zoroval ingest key.`);
    return report;
  }
  report.add(PASS, "key", `found in ${source}, key id ${keyId}`);
  if (source !== "environment") {
    report.add(
      WARN,
      "key loading",
      `the key is in ${source}, not in this shell's environment. Make sure the app loads that file ` +
        "(`wrangler dev` reads .dev.vars and `next dev` reads .env.local; other Node apps need dotenv or `node --env-file`).",
    );
  }

  const ingestUrl = o.ingestUrl || fileUrl || DEFAULT_INGEST_URL;
  const cfg = {
    ...resolveConfig({ apiKey: key, ingestUrl, serviceName: process.env.ZOROVAL_SERVICE_NAME || "zoroval-doctor" }).cfg,
    environment: null,
    release: null,
  };
  const transport = new Transport(cfg);
  let [status, body] = await getJson(cfg.ingestUrl, "/v1/ingest/status", key);
  if (status === 401 || status === 403) {
    report.add(
      FAIL,
      "gateway",
      `the gateway refused the key (${status} ${body.message ?? ""}). Run \`${CMD} login --replace\` or make a new key in the app.`,
    );
    return report;
  }
  if (status !== 200) {
    report.add(FAIL, "gateway", `${cfg.ingestUrl} answered ${status || "nothing"} (${body.message ?? ""}).`);
    return report;
  }
  report.add(PASS, "gateway", `${cfg.ingestUrl} accepts the key; project ${pyStr(body.project_key)}`);

  if (!o.skipTestTrace) {
    const start = new Date(Date.now() - 1000);
    const { spans } = testSpans();
    const payload = await transport.compress(transport.encodeSpans(spans));
    const batchId = uuid7();
    const result = await transport.send(tracesUrl(cfg), payload, { deadline: nowMs() + o.timeoutS * 1000, batchId });
    if (!result.ok) {
      report.add(FAIL, "test trace", `not accepted (${result.status} ${result.reason})`);
      return report;
    }
    report.add(PASS, "test trace", `sent 2 test turns, batch ${batchId}`);
    const deadline = nowMs() + o.timeoutS * 1000;
    let batch: Json = {};
    let since: Json = {};
    while (nowMs() < deadline) {
      [status, body] = await getJson(cfg.ingestUrl, `/v1/ingest/status?batch_id=${batchId}&since=${encodeURIComponent(rfc3339(start))}`, key);
      batch = obj(body.batch);
      since = obj(body.since);
      if (status === 200 && ["done", "done_with_errors", "failed"].includes(String(batch.status))) break;
      await sleep(500);
    }
    if (batch.status !== "done" && batch.status !== "done_with_errors") {
      report.add(FAIL, "test trace processed", `batch status ${pyStr(batch.status, "unknown")} after ${o.timeoutS.toFixed(0)}s`);
      return report;
    }
    report.add(PASS, "test trace processed", `batch ${batch.status}, ${num(batch.spans_received)} spans`);
    const traceIds = Array.isArray(batch.trace_ids) ? batch.trace_ids : [];
    if (traceIds.length === 1 && num(since.turns) >= 2) {
      report.add(PASS, "grouping", "2 test turns with one conversation id became 1 trace");
    } else {
      report.add(FAIL, "grouping", `expected 1 trace from 2 turns, got ${traceIds.length} trace ids and ${num(since.turns)} turns`);
    }
  }

  // real traffic
  const waitUntil = nowMs() + Math.max(o.waitS, 0) * 1000;
  let first: unknown = null;
  let recent: Json = {};
  for (;;) {
    const dayAgo = encodeURIComponent(rfc3339(new Date(Date.now() - 24 * 3600 * 1000)));
    [status, body] = await getJson(cfg.ingestUrl, `/v1/ingest/status?since=${dayAgo}`, key);
    first = status === 200 ? body.first_trace_received_at : null;
    recent = obj(body.since);
    if (first || nowMs() >= waitUntil) break;
    await sleep(1000);
  }
  if (first) report.add(PASS, "first trace received", `app traces are arriving (first at ${pyStr(first)})`);
  else {
    report.add(o.waitS <= 0 ? WARN : FAIL, "first trace received", `no app traces yet. Run your app once, then \`${CMD} doctor --wait 60\`.`);
  }
  const ungrouped = num(recent.ungrouped_turns);
  if (ungrouped) {
    report.add(
      WARN,
      "grouping (app)",
      `${ungrouped} turns in the last 24 h arrived ungrouped. Wrap chat handlers in zoroval.conversation(chatId, ...) so one chat is one trace.`,
    );
  }
  const dropped = num(recent.dropped_spans_reported);
  if (dropped) {
    report.add(WARN, "dropped spans", `the SDK reported ${dropped} dropped spans in the last 24 h (queue full or failed sends).`);
  }
  for (const error of Array.isArray(recent.errors) ? recent.errors : []) {
    const e = obj(error);
    report.add(WARN, "ingest errors", `${pyStr(e.reason_code)}: ${pyStr(e.count)}`);
  }
  return report;
}

/** Python's `str(None)` for a server field that may be missing. */
function pyStr(value: unknown, fallback = "None"): string {
  return value === undefined || value === null || value === "" ? fallback : String(value);
}

const MARKS: Record<Level, string> = { [PASS]: "ok  ", [WARN]: "warn", [FAIL]: "FAIL" };

export function formatReport(report: Report): string[] {
  const lines = report.checks.map((c) => `[${MARKS[c.level]}] ${c.check}: ${c.detail}`);
  lines.push("Doctor: " + (report.ok ? "all required checks passed." : "failed. Fix the FAIL lines above."));
  return lines;
}

export async function startedReport(): Promise<void> {
  await setupReport.doctorStarted();
}
