/**
 * OTLP/HTTP JSON transport with gzip, built for the Zoroval gateway.
 *
 * - Encodes spans as OTLP JSON (hex ids, int64 as decimal strings) with Zoroval's resource
 *   attributes, then gzips the body with `CompressionStream` (sent as is when a runtime lacks it).
 * - One `X-Zoroval-Batch-Id` (UUIDv7) per batch, reused on its retries.
 * - `fetch` only: no Node APIs, so the same code runs on Node 18+, Workers and Edge. A redirect is
 *   never followed (the request carries the key): a 3xx answer counts as a refused batch.
 * - The request timeout grows with the body size, between `requestTimeoutMs` and a ceiling below
 *   the gateway's 60 s body-read deadline: 64 KiB/s is a slow uplink, so a 2G link gets time.
 * - Retries 429 and 503 after `Retry-After` (never sooner than the backoff), and 5xx, 408, timeouts
 *   and connection errors with backoff, always inside the caller's deadline. A `Retry-After` that
 *   passes the deadline pauses every sender on this transport until then. 401 and 403 stop all
 *   export for the process.
 *
 * Deviations from `_transport.py`: JSON and gzip instead of protobuf and zstd (the gateway accepts
 * both, and protobuf plus zstd would add about 100 KB to every edge bundle); `fetch` cannot tell an
 * upload timeout from a late answer, so a timeout on a batch of several spans halves it (a resent
 * span is deduped by id downstream) and a timeout on a single span is retried under the same batch
 * id; no keep-alive, proxy or fork handling (the runtime's `fetch` owns the connection); no
 * `get_json` (the CLI step adds it).
 */

import { SCOPE_NAME, SDK_NAME, VERSION } from "./version.js";
import type { Config } from "./config.js";
import { nowMs } from "./runtime.js";
import { toNanos } from "./span.js";
import type { AttrValue, Span } from "./span.js";
import { addCount, logOnce, sleep, uuid7 } from "./util.js";

export const USER_AGENT = `${SDK_NAME}/${VERSION}`;
const FATAL_STATUS = new Set([401, 403]);
const RETRY_AFTER_STATUS = new Set([429, 503]);
const RETRY_STATUS = new Set([500, 502, 504]);
const TIMEOUT_STATUS = 408; // the gateway did not get the whole body within its read deadline
export const WIRE_MARGIN = 64 * 1024;

// Request timeout = requestTimeoutMs + wire bytes / MIN_UPLINK, capped at TIMEOUT_CEILING_MS.
// 64 KiB/s is a 512 kbit/s uplink, about the slow-3G and flaky-mobile profiles. The ceiling stays
// under the gateway's 60 s whole-body read deadline.
const MIN_UPLINK_BYTES_PER_MS = 64 * 1024 / 1000;
const TIMEOUT_CEILING_MS = 55_000;
const MAX_PAUSE_MS = 3_600_000; // longest Retry-After honoured; then one probe request
const MIN_PAUSE_MS = 1000; // shortest pause once a batch has used its attempts on 429/503
const MAX_BACKOFF_MS = 60_000; // longest wait between failed batches while the gateway is down

export interface SendResult {
  ok: boolean;
  status: number;
  reason: string;
  rejected: number;
  fatal: boolean;
  retryable: boolean; // failed for a reason that may pass (5xx, 408, timeout, connection)
  timeout: boolean; // the request timed out or got 408: the caller may split the batch
  paused: boolean; // the transport is paused (Retry-After) or backing off past the deadline
}

function result(fields: Partial<SendResult>): SendResult {
  return { ok: false, status: 0, reason: "", rejected: 0, fatal: false, retryable: false, timeout: false, paused: false, ...fields };
}

export interface Compressed {
  bytes: Uint8Array;
  gzip: boolean;
}

/** The `message` of a google.rpc.Status JSON body; the gateway puts the reason code there. */
export function parseStatusMessage(text: string): string {
  if (!text) return "";
  try {
    const message = (JSON.parse(text) as { message?: unknown }).message;
    return typeof message === "string" ? message : "";
  } catch {
    return "";
  }
}

/** Seconds from a Retry-After header (delta seconds or HTTP date), as milliseconds clamped to [0, MAX_PAUSE_MS]. */
export function parseRetryAfter(value: string | null | undefined): number | null {
  if (!value) return null;
  let seconds = Number(value);
  if (!Number.isFinite(seconds) || value.trim() === "") {
    const when = Date.parse(value);
    if (Number.isNaN(when)) return null;
    seconds = (when - Date.now()) / 1000;
  }
  if (!Number.isFinite(seconds)) return null;
  return Math.min(Math.max(seconds * 1000, 0), MAX_PAUSE_MS);
}

function anyValue(value: AttrValue): Record<string, unknown> {
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    if (Number.isSafeInteger(value)) return { intValue: String(value) };
    return Number.isFinite(value) ? { doubleValue: value } : { stringValue: String(value) };
  }
  if (Array.isArray(value)) return { arrayValue: { values: value.map((item) => ({ stringValue: String(item) })) } };
  return { stringValue: String(value) };
}

function keyValues(attributes: Record<string, AttrValue>): { key: string; value: Record<string, unknown> }[] {
  return Object.entries(attributes).map(([key, value]) => ({ key, value: anyValue(value) }));
}

class Aborted extends Error {}
class RequestTimeout extends Error {}

export class Transport {
  fatalReason: string | null = null;
  lastError: string | null = null;
  lastBatchId: string | null = null;
  private droppedUnreported = 0;
  // Pause and backoff shared by every sender.
  private holdUntil = 0;
  private holdKind = "";
  private holdReason = "";
  private failures = 0;
  private controller = new AbortController();

  constructor(private cfg: Config) {}

  /** Aborted by `abortInflight()` (shutdown, or a flush that ran out of time) to stop sends and sleeps at once. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  abortInflight(): void {
    this.controller.abort();
    this.controller = new AbortController();
  }

  close(): void {
    this.abortInflight();
  }

  // ------------------------------------------------------------------ drop accounting

  reportDropped(count: number): void {
    if (count > 0) this.droppedUnreported += count;
  }

  private ackDropped(sent: number): void {
    this.droppedUnreported = Math.max(0, this.droppedUnreported - sent);
  }

  // ------------------------------------------------------------------ encoding

  resourceAttributes(): Record<string, AttrValue> {
    const attrs: Record<string, AttrValue> = {
      "service.name": this.cfg.serviceName,
      "zoroval.sdk.name": SDK_NAME,
      "zoroval.sdk.version": VERSION,
    };
    if (this.cfg.environment) attrs["deployment.environment.name"] = this.cfg.environment;
    if (this.cfg.release) attrs["service.version"] = this.cfg.release;
    return attrs;
  }

  encodeSpans(spans: readonly Span[]): string {
    return JSON.stringify({
      resourceSpans: [
        {
          resource: { attributes: keyValues(this.resourceAttributes()) },
          scopeSpans: [
            {
              scope: { name: SCOPE_NAME, version: VERSION },
              spans: spans.map((span) => ({
                traceId: span.traceId,
                spanId: span.spanId,
                ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
                name: span.name,
                kind: span.kind,
                startTimeUnixNano: toNanos(span.start),
                endTimeUnixNano: toNanos(span.finish),
                attributes: keyValues(span.attributes),
                ...(span.events.length
                  ? { events: span.events.map((e) => ({ timeUnixNano: toNanos(e.time), name: e.name, attributes: keyValues(e.attributes) })) }
                  : {}),
                ...(span.status ? { status: { code: span.status.code, message: span.status.message } } : {}),
              })),
            },
          ],
        },
      ],
    });
  }

  async compress(raw: string): Promise<Compressed> {
    const bytes = new TextEncoder().encode(raw);
    if (typeof CompressionStream === "undefined") return { bytes, gzip: false };
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
      return { bytes: new Uint8Array(await new Response(stream).arrayBuffer()), gzip: true };
    } catch {
      return { bytes, gzip: false };
    }
  }

  // ------------------------------------------------------------------ pause and backoff

  /** Per-request timeout: the floor plus time for the body on a slow uplink, capped. */
  requestTimeoutFor(wireBytes: number): number {
    const floor = this.cfg.requestTimeoutMs;
    return Math.min(floor + wireBytes / MIN_UPLINK_BYTES_PER_MS, Math.max(floor, TIMEOUT_CEILING_MS));
  }

  /** No sends until `ms` from now. A later hold never shortens an earlier one. */
  hold(ms: number, kind: string, reason: string): void {
    const until = nowMs() + Math.max(ms, 0);
    if (until > this.holdUntil) {
      this.holdUntil = until;
      this.holdKind = kind;
      this.holdReason = reason;
    }
    if (kind === "paused" && ms >= 5000) {
      logOnce(`paused:${reason}`, `zoroval: the gateway asked to pause export for ${Math.round(ms / 1000)}s (${reason}). Spans stay queued (oldest dropped when full) and are sent after the pause.`);
    }
  }

  /**
   * After a batch failed all its retries, or was paused: wait longer each time until a send
   * succeeds (0.5 s doubling to MAX_BACKOFF_MS), and never less than `atLeast` (a Retry-After).
   */
  backOff(reason: string, atLeast = 0, kind = "backing_off"): number {
    this.failures += 1;
    let delay = Math.min(500 * 2 ** (this.failures - 1), MAX_BACKOFF_MS) * (0.8 + 0.4 * Math.random());
    delay = Math.max(delay, atLeast);
    this.hold(delay, kind, reason);
    return delay;
  }

  holdRemaining(): number {
    return Math.max(this.holdUntil - nowMs(), 0);
  }

  /** `off` (key refused), `paused` (Retry-After), `backing_off` (gateway failing) or `running`. */
  exportState(): string {
    if (this.fatalReason) return "off";
    if (this.holdRemaining() > 0) return this.holdKind || "paused";
    return "running";
  }

  private succeeded(): void {
    this.failures = 0;
    if (this.holdKind === "backing_off") this.holdUntil = 0;
  }

  private static backoff(attempt: number): number {
    return Math.min(500 * 2 ** (attempt - 1), 8000) * (0.8 + 0.4 * Math.random());
  }

  // ------------------------------------------------------------------ sending

  /** One POST. Throws `RequestTimeout` when `timeoutMs` passes and `Aborted` on `abortInflight()`. */
  private async postOnce(url: string, body: Compressed, headers: Record<string, string>, timeoutMs: number) {
    if (typeof fetch !== "function") throw new Error("no fetch");
    const request = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      request.abort();
    }, timeoutMs);
    const shared = this.signal;
    const onAbort = () => request.abort();
    shared.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: body.bytes as unknown as BodyInit,
        signal: request.signal,
        redirect: "manual", // never followed; workerd does not support "error"
      });
      const text = await response.text();
      return { status: response.status, headers: response.headers, text };
    } catch (error) {
      if (timedOut) throw new RequestTimeout();
      if (shared.aborted) throw new Aborted();
      throw error;
    } finally {
      clearTimeout(timer);
      shared.removeEventListener("abort", onAbort);
    }
  }

  /**
   * POST one compressed request with retries inside `deadline` (`nowMs()` time).
   *
   * With `splitOnTimeout`, a timeout or 408 returns at once (`timeout: true`) so the caller can
   * send the batch in two halves; otherwise it is retried like a connection error.
   */
  async send(
    url: string,
    body: Compressed,
    options: { deadline: number; batchId?: string; timeout?: number; splitOnTimeout?: boolean },
  ): Promise<SendResult> {
    if (this.fatalReason) return result({ reason: this.fatalReason, fatal: true });
    const batchId = options.batchId ?? uuid7();
    this.lastBatchId = batchId;
    const perRequest = options.timeout ?? this.requestTimeoutFor(body.bytes.length);
    const { deadline } = options;
    let attempt = 0;
    for (;;) {
      const held = this.holdRemaining();
      if (held > 0) {
        if (nowMs() + held >= deadline) return result({ reason: this.holdReason || "paused", retryable: true, paused: true });
        if (await sleep(held, this.signal)) return result({ reason: "shutdown", retryable: true });
      }
      attempt += 1;
      const remaining = deadline - nowMs();
      if (remaining <= 50) return result({ reason: "deadline", retryable: true });
      const dropped = this.droppedUnreported;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.cfg.apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        "X-Zoroval-Batch-Id": batchId,
      };
      if (body.gzip) headers["Content-Encoding"] = "gzip";
      Object.assign(headers, this.cfg.extraHeaders);
      if (dropped) headers["X-Zoroval-Dropped-Spans"] = String(dropped);
      let status = 0;
      let reason = "";
      let retryAfter: string | null = null;
      let text = "";
      let timedOut = false;
      // An attempt cut short by the deadline proves nothing about the uplink: no split.
      const cutShort = remaining < perRequest;
      try {
        const response = await this.postOnce(url, body, headers, Math.min(perRequest, remaining));
        status = response.status;
        text = response.text;
        if (status < 200 || status >= 300) {
          reason = parseStatusMessage(text);
          retryAfter = response.headers.get("Retry-After");
        }
      } catch (error) {
        if (error instanceof Aborted) return result({ reason: "shutdown", retryable: true });
        if (error instanceof RequestTimeout) {
          reason = "timeout";
          timedOut = !cutShort;
        } else {
          reason = `connection:${error instanceof Error ? error.name : "error"}`;
        }
      }

      if (status >= 200 && status < 300) {
        this.ackDropped(dropped);
        this.succeeded();
        addCount("bytesSent", body.bytes.length);
        this.lastError = null;
        return result({ ok: true, status, rejected: rejectedCount(text) });
      }

      this.lastError = status ? `${status}:${reason}` : reason;
      if (FATAL_STATUS.has(status)) {
        this.fatalReason = reason || (status === 401 ? "invalid_key" : "key_revoked");
        logOnce("fatal-key", `zoroval: the gateway refused the ingest key (${this.fatalReason}). Export is off for this process. Run \`zoroval doctor\` to check the key.`);
        return result({ status, reason: this.fatalReason, fatal: true });
      }
      timedOut = timedOut || status === TIMEOUT_STATUS;
      if (status && !timedOut && !RETRY_AFTER_STATUS.has(status) && !RETRY_STATUS.has(status)) {
        logOnce(`status:${status}`, `zoroval: the gateway refused a batch (${status} ${reason}).`);
        return result({ status, reason });
      }
      if (timedOut && options.splitOnTimeout) {
        return result({ status, reason: reason || "timeout", retryable: true, timeout: true });
      }
      if (RETRY_AFTER_STATUS.has(status)) {
        const wait = parseRetryAfter(retryAfter);
        if (wait !== null) {
          // The gateway said when: every sender waits, and a wait past this batch's deadline (or its
          // last attempt) pauses export instead of failing the batch. Never sooner than the normal
          // backoff, so `Retry-After: 0` cannot cause a loop; pauses in a row grow like backoff.
          if (attempt >= this.cfg.maxAttempts || nowMs() + wait >= deadline) {
            this.backOff(reason || String(status), Math.max(wait, MIN_PAUSE_MS), "paused");
            return result({ status, reason: reason || "paused", retryable: true, paused: true });
          }
          this.hold(Math.max(wait, Transport.backoff(attempt)), "paused", reason || String(status));
          continue;
        }
      }
      if (attempt >= this.cfg.maxAttempts) {
        return result({ status, reason: reason || "retries_exhausted", retryable: true });
      }
      const delay = Transport.backoff(attempt);
      if (nowMs() + delay >= deadline) return result({ status, reason: reason || "deadline", retryable: true });
      if (await sleep(delay, this.signal)) return result({ status, reason: "shutdown", retryable: true });
    }
  }
}

function rejectedCount(text: string): number {
  if (!text) return 0;
  try {
    const rejected = Number((JSON.parse(text) as { partialSuccess?: { rejectedSpans?: unknown } }).partialSuccess?.rejectedSpans);
    return Number.isFinite(rejected) && rejected > 0 ? rejected : 0;
  } catch {
    return 0;
  }
}
