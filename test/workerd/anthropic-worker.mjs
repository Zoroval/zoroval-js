// A Cloudflare Worker that calls Claude through the official `@anthropic-ai/sdk`, wrapped with wrapAnthropic.
import Anthropic from "@anthropic-ai/sdk";
import * as zoroval from "zoroval";

export default zoroval.withZoroval({
  async fetch(request, env) {
    const url = new URL(request.url);
    const chat = url.searchParams.get("chat");
    const anthropic = zoroval.wrapAnthropic(new Anthropic({ apiKey: "sk-ant-test", baseURL: env.ANTHROPIC_BASE, maxRetries: 0 }));
    return zoroval.conversation(chat, { userId: "u-" + chat }, () =>
      zoroval.turn({ input: "hours for " + chat }, async (turn) => {
        const params = { max_tokens: 100, messages: [{ role: "user", content: "hours for " + chat }] };
        const message = url.searchParams.has("stream")
          ? await anthropic.messages.stream({ ...params, model: "claude-test-server", thinking: { type: "enabled", budget_tokens: 50 } }).finalMessage()
          : await anthropic.messages.create({ ...params, model: "claude-test-tools" });
        turn.setOutput(message.content.at(-1).text ?? message.content.at(-1).name);
        return Response.json(message);
      }));
  },
});
