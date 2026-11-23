/**
 * `wrapFetch`: a `fetch` that traces calls to the OpenAI API and passes everything else through
 * untouched. For apps that call OpenAI with plain `fetch` (Cloudflare Workers, Edge routes), where
 * the `openai` package is not used. Same span as `wrapOpenAI` (openai.ts): the request body is read
 * as the keyword arguments Python sees, the response as the result object.
 *
 * New in the TypeScript SDK (Python has no equivalent; it patches `httpx`):
 * - The request body is parsed without consuming it: a string or bytes body is read as is, a
 *   `Request` body from a `clone()`.
 * - A response is read from `response.clone()` (a `tee()` of the body), so the app's body is never
 *   slowed or consumed, and the original `Response` is returned. The app cancelling its own half of
 *   a stream does not stop our half: it reads on until the provider ends the stream.
 * - A request the app cannot be told apart from (not POST, a URL that is not an OpenAI chat or
 *   responses endpoint, a body that is not JSON) is passed straight to `fetch`, same call, same result.
 * - An HTTP error response (4xx, 5xx) sets ERROR status with the provider's message and `error.type`.
 * - If a generation span is already open (`wrapOpenAI` over the same call), no second span is made.
 */

import { toPlain } from "../json.js";
import { getState } from "../state.js";
import { internalError } from "../util.js";
import { Generation, get } from "./common.js";
import type { Json } from "./common.js";
import { finishResult, startCall, streamState } from "./openai.js";
import type { Api, Endpoint } from "./openai.js";

export interface WrapFetchOptions {
  /** API base URLs to trace besides `https://api.openai.com/v1` (OpenAI-compatible gateways, Azure). */
  baseURLs?: string[];
}

type FetchFn = typeof fetch;

interface Match {
  api: Api;
  endpoint: Endpoint;
}

function parseBases(options: WrapFetchOptions): URL[] {
  const bases: URL[] = [];
  for (const text of ["https://api.openai.com/v1", ...(options.baseURLs ?? [])]) {
    try {
      bases.push(new URL(text));
    } catch {
      /* a bad base URL is ignored */
    }
  }
  return bases;
}

function match(url: URL, bases: URL[]): Match | null {
  for (const base of bases) {
    if (url.origin !== base.origin) continue;
    const prefix = base.pathname.replace(/\/+$/, "");
    if (!url.pathname.startsWith(prefix)) continue;
    const rest = url.pathname.slice(prefix.length).replace(/\/+$/, "");
    const api: Api | null = rest === "/chat/completions" ? "chat" : rest === "/responses" ? "responses" : null;
    if (!api) continue;
    const provider = url.hostname.includes("azure") ? "azure.ai.openai" : "openai";
    return { api, endpoint: { api, provider, host: url.hostname, ...(url.port ? { port: Number(url.port) } : {}) } };
  }
  return null;
}

function requestUrl(input: unknown): URL | null {
  try {
    if (typeof input === "string") return new URL(input);
    if (input instanceof URL) return input;
    const url = (input as { url?: unknown } | null)?.url;
    return typeof url === "string" ? new URL(url) : null;
  } catch {
    return null;
  }
}

function methodOf(input: unknown, init: RequestInit | undefined): string {
  return String(init?.method ?? (input as { method?: unknown } | null)?.method ?? "GET").toUpperCase();
}

async function readBody(input: unknown, init: RequestInit | undefined): Promise<Json | undefined> {
  const body = init?.body as unknown;
  let text: string | undefined;
  if (typeof body === "string") text = body;
  else if (body instanceof ArrayBuffer) text = new TextDecoder().decode(body);
  else if (ArrayBuffer.isView(body)) text = new TextDecoder().decode(body as ArrayBufferView);
  else if ((body === undefined || body === null) && typeof Request !== "undefined" && input instanceof Request) {
    text = await input.clone().text();
  }
  if (text === undefined) return undefined;
  const parsed = JSON.parse(text);
  return parsed !== null && typeof parsed === "object" ? parsed : undefined;
}

/** Read server-sent events from a body, calling `onEvent` with each JSON payload. */
async function readEvents(body: ReadableStream<Uint8Array>, onEvent: (event: Json) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const dispatch = (block: string) => {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
    if (!data || data === "[DONE]") return;
    let event: Json;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    onEvent(event);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (let at = buffer.search(/\r?\n\r?\n/); at >= 0; at = buffer.search(/\r?\n\r?\n/)) {
      dispatch(buffer.slice(0, at));
      buffer = buffer.slice(at).replace(/^\r?\n\r?\n/, "");
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) dispatch(buffer);
}

/**
 * Read our copy of the response. Returns a promise that settles when the span is finished, and
 * whether the body is a stream: a stream is read in the background, anything else the caller waits for.
 */
function observeResponse(response: Response, gen: Generation, api: Api): { stream: boolean; done: Promise<void> } {
  const copy = response.clone();
  const stream = response.ok && (response.headers.get("content-type") ?? "").includes("text/event-stream") && Boolean(copy.body);
  const done = (async () => {
    try {
      if (!response.ok) {
        let message = "";
        let type: unknown = null;
        try {
          const error = get(JSON.parse(await copy.text()), "error");
          message = String(get(error, "message") ?? "");
          type = get(error, "type") ?? get(error, "code");
        } catch {
          /* not JSON: the status alone */
        }
        gen.set("error.type", String(type ?? response.status));
        gen.setError(`${response.status} ${message}`.trim());
        gen.finish();
      } else if (stream) {
        const state = streamState(gen, api);
        let failure: unknown;
        try {
          await readEvents(copy.body!, (event) => {
            gen.markFirstChunk();
            try {
              state.observe(event);
            } catch (error) {
              internalError("fetch.observe", error);
            }
            const error = api === "chat" ? get(event, "error") : null;
            if (error) failure = Object.assign(new Error(String(get(error, "message") ?? "stream error")), { name: String(get(error, "type") ?? "APIError") });
          });
        } catch (error) {
          failure = error;
        }
        state.finish(failure);
      } else {
        finishResult(gen, api, await copy.json());
      }
    } catch (error) {
      internalError("fetch.observe", error);
      gen.finish();
    }
  })();
  return { stream, done };
}

/**
 * A `fetch` that traces calls to the OpenAI API (chat completions and responses, streaming or not).
 *
 *     const tracedFetch = zoroval.wrapFetch();
 *     const reply = await tracedFetch("https://api.openai.com/v1/chat/completions", { method: "POST", ... });
 */
export function wrapFetch(fetchFn?: FetchFn, options: WrapFetchOptions = {}): FetchFn {
  const base: FetchFn = fetchFn ? (input, init) => fetchFn.call(globalThis, input, init) : (input, init) => globalThis.fetch(input, init);
  const bases = parseBases(options);
  return function zorovalFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (!getState() || methodOf(input, init) !== "POST") return base(input, init);
    const url = requestUrl(input);
    const hit = url && match(url, bases);
    if (!hit) return base(input, init);
    return traced(base, hit, input, init);
  };
}

async function traced(base: FetchFn, hit: Match, input: RequestInfo | URL, init: RequestInit | undefined): Promise<Response> {
  let gen: Generation | undefined;
  try {
    const body = await readBody(input, init);
    if (body !== undefined) gen = startCall(hit.endpoint, toPlain(body));
  } catch {
    /* an unreadable body is not traced */
  }
  if (!gen || !gen.active) return base(input, init);
  let response: Response;
  try {
    response = await gen.run(() => base(input, init));
  } catch (error) {
    gen.fail(error);
    throw error;
  }
  try {
    // A complete body is read before the response is handed back: the app waits for it anyway, and
    // the tool calls it holds are then known when the app's own code runs. A stream is read as it flows.
    const seen = observeResponse(response, gen, hit.api);
    if (!seen.stream) await seen.done;
  } catch (error) {
    internalError("fetch.clone", error);
    gen.finish();
  }
  return response;
}
