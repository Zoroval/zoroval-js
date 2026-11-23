/**
 * The CLI's own small HTTP helpers (global `fetch`, no dependencies). A redirect is never followed:
 * the requests carry a setup code or the ingest key. Every failure becomes `[0, {...}]`; nothing throws.
 */

import { ingestUrlOk } from "../config.js";
import { USER_AGENT } from "../transport.js";

export type Json = Record<string, unknown>;

async function request(url: string, init: RequestInit, timeoutMs: number): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, redirect: "manual" });
    return { status: response.status, text: await response.text() };
  } finally {
    clearTimeout(timer);
  }
}

function parseObject(text: string): Json {
  const value: unknown = JSON.parse(text || "{}");
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

/** POST JSON. A 2xx whose body is not JSON, or any network failure, is `[0, { status: "connection:<Name>" }]`. */
export async function postJson(url: string, payload: Json, timeoutMs = 15_000): Promise<[number, Json]> {
  try {
    const { status, text } = await request(
      url,
      {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": USER_AGENT },
      },
      timeoutMs,
    );
    try {
      return [status, parseObject(text)];
    } catch {
      if (status < 200 || status >= 300) return [status, {}];
      return [0, { status: "connection:SyntaxError" }];
    }
  } catch (error) {
    return [0, { status: `connection:${error instanceof Error ? error.name : "Error"}` }];
  }
}

/** GET with the ingest key (the gateway status endpoint). The URL must be https, or http on localhost. */
export async function getJson(ingestUrl: string, path: string, apiKey: string, timeoutMs = 10_000): Promise<[number, Json]> {
  const url = ingestUrl.replace(/\/+$/, "") + path;
  if (!ingestUrlOk(url)) return [0, { message: "refused: the ingest URL must be https (http only for localhost)" }];
  try {
    const { status, text } = await request(
      url,
      { method: "GET", headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": USER_AGENT, Accept: "application/json" } },
      timeoutMs,
    );
    try {
      return [status, parseObject(text)];
    } catch {
      if (status < 200 || status >= 300) return [status, { message: "" }];
      return [0, { message: "connection:SyntaxError" }];
    }
  } catch (error) {
    return [0, { message: `connection:${error instanceof Error ? error.name : "Error"}` }];
  }
}
