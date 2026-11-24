/**
 * Configuration: explicit options first, then environment variables, then defaults.
 *
 * Deviations from `_config.py`: camelCase names; durations are milliseconds (`flushIntervalMs`,
 * `shutdownTimeoutMs`, `requestTimeoutMs`) because that is the unit of JavaScript timers and of
 * `flush(timeoutMs)`; environment variables are read only where `process.env` exists; an unknown
 * option is logged once and ignored instead of raising (the SDK never breaks the app).
 * No log-export settings: this SDK exports spans only.
 */

import { buildHook } from "./redact.js";
import type { RedactOption } from "./redact.js";
import { readEnv, RUNTIME } from "./runtime.js";

export const DEFAULT_INGEST_URL = "https://ingest.zoroval.com";
export const ENV_KEY = "ZOROVAL_INGEST_KEY";

const KEY_PATTERN = /^zv_ingest_([a-z2-7]{12})_([0-9A-Za-z]{20,64})$/;

const MIB = 1024 * 1024;

/** The public key id inside an ingest key, or null. Never returns the secret. */
export function keyIdOf(key: string | null | undefined): string | null {
  if (!key) return null;
  const match = KEY_PATTERN.exec(key.trim());
  return match ? match[1]! : null;
}

/** https only; plain http is allowed for localhost and 127.0.0.1 (the key is in every request). */
export function ingestUrlOk(url: string): boolean {
  try {
    const parts = new URL(url);
    return (
      parts.protocol === "https:" ||
      (parts.protocol === "http:" && (parts.hostname === "localhost" || parts.hostname === "127.0.0.1"))
    );
  } catch {
    return false;
  }
}

/** What a developer sets in `init()`. */
export interface InitOptions {
  /** Ingest key. Defaults to the `ZOROVAL_INGEST_KEY` environment variable where one exists. */
  apiKey?: string;
  ingestUrl?: string;
  serviceName?: string;
  environment?: string;
  release?: string;
  /**
   * Off by default. "basic" replaces card numbers, emails, phone numbers, Aadhaar, PAN and API keys
   * with labels; a function runs your own on every content field; ["basic", fn] runs both, basic
   * first. If the function throws or returns null, that field is dropped.
   */
  redact?: RedactOption;
  /** Head sampling from 0 to 1, kept whole per conversation. */
  sampleRate?: number;
  enabled?: boolean;
}

export interface Config {
  apiKey: string | null;
  ingestUrl: string;
  serviceName: string;
  environment: string | null;
  release: string | null;
  /** The effective hook: built-in rules, the developer's function, or both chained. */
  redact: ((value: unknown) => unknown) | null;
  /** null, "basic", "function" or "basic+function". */
  redactMode: string | null;
  sampleRate: number;
  enabled: boolean;
  // Transport and queue.
  maxQueueBytes: number;
  maxQueueSpans: number;
  /** Raw JSON bytes per batch before gzip. 4 MiB is the gateway's per-span cap, so the largest span still goes alone. */
  maxBatchBytes: number;
  maxBatchSpans: number;
  maxRequestBytes: number; // gateway wire limit
  flushIntervalMs: number;
  shutdownTimeoutMs: number;
  requestTimeoutMs: number; // floor; grows with the body size (transport.requestTimeoutFor)
  maxAttempts: number;
  // Content caps.
  maxContentBytes: number; // per content attribute (messages, inputs, outputs)
  maxMetadataBytes: number; // zoroval.metadata at most 16 KB
  maxStackBytes: number;
  extraHeaders: Record<string, string>;
}

const TUNING_DEFAULTS = {
  maxQueueBytes: 64 * MIB,
  maxQueueSpans: 20_000,
  maxBatchBytes: 4 * MIB,
  maxBatchSpans: 4096,
  maxRequestBytes: 16 * MIB,
  flushIntervalMs: 1000,
  shutdownTimeoutMs: 5000,
  requestTimeoutMs: 10_000,
  maxAttempts: 5,
  maxContentBytes: 4 * MIB,
  maxMetadataBytes: 16 * 1024,
  maxStackBytes: 16 * 1024,
};

const KNOWN_OPTIONS = new Set([
  "apiKey", "ingestUrl", "serviceName", "environment", "release", "captureContent", "redact", "sampleRate",
  "enabled", "extraHeaders", ...Object.keys(TUNING_DEFAULTS),
]);

function envBool(name: string, fallback: boolean): boolean {
  const value = readEnv(name);
  if (value === undefined || value.trim() === "") return fallback;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function envNumber(name: string, fallback: number): number {
  const value = readEnv(name);
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function defaultServiceName(): string {
  for (const name of ["ZOROVAL_SERVICE_NAME", "OTEL_SERVICE_NAME"]) {
    const value = readEnv(name);
    if (value) return value;
  }
  if (RUNTIME.background) {
    const argv = (globalThis as { process?: { argv?: string[] } }).process?.argv;
    const script = argv?.[1] ? argv[1].split(/[\\/]/).pop()!.replace(/\.[^.]*$/, "") : "";
    if (script && !["-e", "[eval]", "node"].includes(script)) return script;
    return "unknown_service:nodejs";
  }
  return "unknown_service:js";
}

/** Build a Config from `init()` options (undefined means "not given") and the environment. */
export function resolve(options: Record<string, unknown> = {}): { cfg: Config; unknown: string[]; refuse?: string } {
  const given: Record<string, unknown> = {};
  const unknown: string[] = [];
  for (const [key, value] of Object.entries(options)) {
    if (!KNOWN_OPTIONS.has(key)) unknown.push(key);
    else if (value !== undefined && value !== null) given[key] = value;
  }
  const str = (key: string, env?: string): string | null => {
    const value = typeof given[key] === "string" ? (given[key] as string) : "";
    return value || (env ? readEnv(env) : undefined) || null;
  };
  const apiKey = str("apiKey", ENV_KEY)?.trim() || null;
  const hook = buildHook(given.redact);
  // Content-off was removed in 0.2.0. Starting anyway would send what this app chose not to send.
  const contentOff = "captureContent" in options ? options.captureContent === false : !envBool("ZOROVAL_CAPTURE_CONTENT", true);
  const sampleRaw = typeof given.sampleRate === "number" ? given.sampleRate : envNumber("ZOROVAL_SAMPLE_RATE", 1);
  const cfg: Config = {
    apiKey,
    ingestUrl: str("ingestUrl", "ZOROVAL_INGEST_URL") ?? DEFAULT_INGEST_URL,
    serviceName: str("serviceName") ?? defaultServiceName(),
    environment: str("environment", "ZOROVAL_ENVIRONMENT"),
    release: str("release", "ZOROVAL_RELEASE"),
    redact: hook.hook,
    redactMode: hook.mode,
    sampleRate: Math.min(1, Math.max(0, Number.isFinite(sampleRaw) ? sampleRaw : 1)),
    enabled: typeof given.enabled === "boolean" ? given.enabled : envBool("ZOROVAL_ENABLED", true),
    ...TUNING_DEFAULTS,
    extraHeaders: {},
  };
  for (const key of Object.keys(TUNING_DEFAULTS) as (keyof typeof TUNING_DEFAULTS)[]) {
    if (typeof given[key] === "number" && Number.isFinite(given[key])) cfg[key] = given[key] as number;
  }
  if (given.extraHeaders && typeof given.extraHeaders === "object") {
    cfg.extraHeaders = { ...(given.extraHeaders as Record<string, string>) };
  }
  const refuse = hook.error
    ? `zoroval: init() ${hook.error}. Tracing is off.`
    : contentOff
      ? "zoroval: captureContent was removed in 0.2.0. Tracing is off so prompts and outputs are not sent. " +
        "Remove captureContent (or ZOROVAL_CAPTURE_CONTENT) and use redact to clean content before it is sent."
      : undefined;
  return { cfg, unknown, refuse };
}

export function tracesUrl(cfg: Config): string {
  return cfg.ingestUrl.replace(/\/+$/, "") + "/v1/traces";
}
