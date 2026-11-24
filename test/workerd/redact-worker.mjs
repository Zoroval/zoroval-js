// A Worker that records one chat turn of a given size, with redaction on or off (the `redact` binding).
import * as zoroval from "zoroval";

const LINES = [
  "Hi, my order 403-5926381-7740324 placed on 2026-11-24 has not arrived.",
  "The total was Rs. 4,999 including 18% GST, invoice INV-2026-000123.",
  "Sure! I can see tracking number 789456123012 with Delhivery, ETA 26/11/2026.",
  "Please call me on +91 98765 43210 or mail priya.sharma@example.com.",
  "मेरा ऑर्डर अभी तक नहीं आया, कृपया मदद करें। कुल ₹1,299",
  "I paid with card 4111 1111 1111 1111 but got charged twice 😞",
];
const cache = new Map();
function messages(size) {
  if (!cache.has(size)) {
    const out = [];
    let total = 0;
    for (let i = 0; total < size; i++) {
      const content = LINES[i % LINES.length] + " " + LINES[(i * 7 + 3) % LINES.length];
      out.push({ role: i % 2 ? "assistant" : "user", content });
      total += content.length + 32;
    }
    cache.set(size, out);
  }
  return cache.get(size);
}

export default {
  async fetch(request, env) {
    zoroval.init({ apiKey: env.ZOROVAL_INGEST_KEY, ingestUrl: env.ZOROVAL_INGEST_URL, serviceName: "redact-cpu",
      ...(env.REDACT === "basic" ? { redact: "basic" } : {}) });
    const size = Number(new URL(request.url).searchParams.get("size") ?? 20000);
    const history = messages(size);
    await zoroval.conversation("c1", () => zoroval.turn({ input: { messages: history } }, async (turn) => {
      turn.setOutput(history[history.length - 1].content);
    }));
    if (new URL(request.url).searchParams.has("flush")) await zoroval.flush(5000);
    return Response.json({ status: zoroval.status().redact ?? null });
  },
};
