/**
 * Progress reports for a guided setup. Active only when ZOROVAL_SETUP is set.
 *
 * Best effort: short timeout, never throws, never changes a command's result. A 404 or 410 (unknown
 * or finished code) is ignored without a word. Only event names and app or framework names are sent.
 * The setup code is passed through unparsed.
 */

import { USER_AGENT } from "../transport.js";
import { DEFAULT_APP_URL } from "./constants.js";

export const ENV_VAR = "ZOROVAL_SETUP";
const TIMEOUT_MS = 2000;
const MAX_NAMES = 10;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,39}$/;

const sent = new Set<string>();

/** Test hook: a new process starts with nothing sent. */
export function resetSent(): void {
  sent.clear();
}

export function setupCode(): string | null {
  return (process.env[ENV_VAR] ?? "").trim() || null;
}

function baseUrl(appUrl?: string | null): string {
  return (appUrl || process.env.ZOROVAL_APP_URL || DEFAULT_APP_URL).replace(/\/+$/, "");
}

export async function report(event: string, detail?: Record<string, unknown>, appUrl?: string | null): Promise<void> {
  const code = setupCode();
  if (!code) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const body: Record<string, unknown> = { code, event };
    if (detail && Object.keys(detail).length) body.detail = detail;
    const response = await fetch(baseUrl(appUrl) + "/api/agent-setup/progress", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": USER_AGENT },
      signal: controller.signal,
      redirect: "manual",
    });
    await response.text();
  } catch {
    /* 404, 410, no network, anything: ignored */
  } finally {
    clearTimeout(timer);
  }
}

/** Posts `started` once per process. */
export async function started(appUrl?: string | null): Promise<void> {
  if (sent.has("started") || !setupCode()) return;
  sent.add("started");
  await report("started", undefined, appUrl);
}

/** Framework and app names from a detect report. Names only: no paths, no values. */
export function appNames(scan: Record<string, any>): string[] {
  const names: string[] = [];
  const tracing = scan.tracing ?? {};
  for (const key of ["openai", "anthropic", "langfuse", "otel", "openinference", "openllmetry", "langsmith"]) {
    if (isTruthy(tracing[key])) names.push(key);
  }
  const js = scan.packages?.typescript ?? {};
  if ("ai" in js) names.push("vercel-ai");
  names.push(...Object.keys(scan.servers ?? {}));
  const seen: string[] = [];
  for (const name of names) if (NAME_PATTERN.test(name) && !seen.includes(name)) seen.push(name);
  return seen.slice(0, MAX_NAMES);
}

/** Python truthiness for the values detect puts under `tracing`. */
function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

export async function detected(scan: Record<string, any>, appUrl?: string | null): Promise<void> {
  await started(appUrl);
  await report("detected", { apps: appNames(scan) }, appUrl);
}

export async function doctorStarted(appUrl?: string | null): Promise<void> {
  await started(appUrl);
  await report("doctor_started", undefined, appUrl);
}
