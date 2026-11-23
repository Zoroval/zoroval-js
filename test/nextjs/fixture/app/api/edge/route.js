// The same route on the Edge runtime, with plain fetch.
import { after } from "next/server";
import * as zoroval from "zoroval";

zoroval.init();

export const runtime = "edge";
export const dynamic = "force-dynamic";

export async function POST(request) {
  const { chatId, text, stream } = await request.json();
  const base = process.env.OPENAI_BASE;
  const openai = zoroval.wrapFetch(fetch, { baseURLs: [base] });
  after(() => zoroval.flush());
  return zoroval.conversation(chatId, { userId: "u-" + chatId }, () =>
    zoroval.turn({ input: text }, async (turn) => {
      const upstream = await openai(base + "/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer sk-test" },
        body: JSON.stringify({ model: "gpt-test", stream, messages: [{ role: "user", content: text }] }),
      });
      if (stream) return new Response(upstream.body, { headers: { "content-type": "text/event-stream" } });
      const reply = await upstream.json();
      const message = reply.choices[0].message;
      turn.setOutput(message.content ?? message.tool_calls[0].function.name);
      return Response.json(reply);
    }));
}
