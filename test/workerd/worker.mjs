// A Cloudflare Worker that uses the SDK the way a developer would.
import * as zoroval from "zoroval";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  async fetch(request, env, ctx) {
    zoroval.init({ apiKey: env.ZOROVAL_INGEST_KEY, ingestUrl: env.ZOROVAL_INGEST_URL, serviceName: "worker-test" });
    const url = new URL(request.url);
    const chat = url.searchParams.get("chat");
    const answer = await zoroval.conversation(chat, { userId: "u-" + chat }, () =>
      zoroval.turn({ input: "hello " + chat }, async (turn) => {
        await sleep(Number(url.searchParams.get("wait") ?? 0)); // interleave concurrent requests
        const reply = await zoroval.step("think", async (s) => { await sleep(5); s.setOutput("thought " + chat); return "re: " + chat; });
        turn.setOutput(reply);
        return reply;
      }));
    if (!url.searchParams.has("noflush")) ctx.waitUntil(zoroval.flush());
    return Response.json({ answer, status: zoroval.status() });
  },
};
