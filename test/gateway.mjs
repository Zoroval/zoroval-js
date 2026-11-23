// A local fake gateway: an HTTP server that gunzips and parses the OTLP JSON it receives.
import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";

export const KEY = "zv_ingest_abcdefghijkl_0123456789ABCDEFGHIJ";

export function flat(attributes = []) {
  const out = {};
  for (const { key, value } of attributes) {
    out[key] = "stringValue" in value ? value.stringValue
      : "boolValue" in value ? value.boolValue
      : "intValue" in value ? Number(value.intValue)
      : "doubleValue" in value ? value.doubleValue
      : "arrayValue" in value ? value.arrayValue.values.map((v) => v.stringValue)
      : undefined;
  }
  return out;
}

/**
 * `behaviour(request, index)` may return { status, headers, body, delayMs, bytesPerSecond }.
 * bytesPerSecond throttles how fast the request body is read (a slow uplink).
 */
export async function startGateway(behaviour = () => ({})) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const index = requests.length;
    const plan = (await behaviour(req, index)) ?? {};
    const record = { index, headers: req.headers, url: req.url, method: req.method, complete: false, spans: [], resource: {}, raw: null };
    requests.push(record);
    const chunks = [];
    try {
      for await (const chunk of req) {
        chunks.push(chunk);
        if (plan.bytesPerSecond) await new Promise((r) => setTimeout(r, (chunk.length / plan.bytesPerSecond) * 1000));
      }
    } catch {
      return; // the client gave up
    }
    record.complete = true;
    let body = Buffer.concat(chunks);
    try {
      if (req.headers["content-encoding"] === "gzip") body = gunzipSync(body);
      record.raw = JSON.parse(body.toString("utf8"));
      for (const rs of record.raw.resourceSpans ?? []) {
        record.resource = flat(rs.resource?.attributes);
        for (const ss of rs.scopeSpans ?? []) {
          record.scope = ss.scope;
          for (const span of ss.spans ?? []) record.spans.push({ ...span, attrs: flat(span.attributes) });
        }
      }
    } catch (error) {
      record.parseError = String(error);
    }
    if (plan.delayMs) await new Promise((r) => setTimeout(r, plan.delayMs));
    const status = plan.status ?? 200;
    const payload = plan.body ?? (status < 300 ? "{}" : JSON.stringify({ code: 2, message: plan.message ?? "failed" }));
    res.writeHead(status, { "content-type": "application/json", ...(plan.headers ?? {}) });
    res.end(payload);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    requests,
    spans: () => requests.flatMap((r) => r.spans),
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Capture console.warn for the duration of `fn`. */
export async function withWarnings(fn) {
  const original = console.warn;
  const logged = [];
  console.warn = (...args) => logged.push(args.join(" "));
  try { await fn(); } finally { console.warn = original; }
  return logged;
}
