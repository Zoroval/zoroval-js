// A Cloudflare Worker that calls OpenAI with plain fetch, the way a developer would.
import * as zoroval from "zoroval";

// wrapFetch is called when the module loads, before init(): withZoroval starts the SDK from `env` later.
const base = zoroval.wrapFetch;

export default zoroval.withZoroval({
  async fetch(request, env) {
    const url = new URL(request.url);
    const chat = url.searchParams.get("chat");
    const stream = url.searchParams.has("stream");
    const openai = base(fetch, { baseURLs: [env.OPENAI_BASE] });
    return zoroval.conversation(chat, { userId: "u-" + chat }, () =>
      zoroval.turn({ input: "weather in " + chat }, async (turn) => {
        const upstream = await openai(env.OPENAI_BASE + "/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer sk-test" },
          body: JSON.stringify({ model: url.searchParams.get("model") ?? "gpt-test", stream, messages: [{ role: "user", content: (stream ? "a long answer for " : "weather in ") + chat }] }),
        });
        if (stream) {
          // the turn returns the Response right away; the reply keeps streaming after the handler is done
          return new Response(upstream.body, { status: upstream.status, headers: { "content-type": "text/event-stream" } });
        }
        const body = await upstream.json();
        turn.setOutput(body.choices[0].message.tool_calls?.[0]?.function.name ?? body.choices[0].message.content);
        return Response.json(body);
      }));
  },
});
