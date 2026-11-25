import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic();

export async function reply(chatId: string, history: Anthropic.MessageParam[]) {
  const message = await anthropic.messages.create({ model: "claude-sonnet-5-5", max_tokens: 1024, messages: history });
  const stream = anthropic.messages.stream({ model: "claude-sonnet-5-5", max_tokens: 1024, messages: history });
  return [message, await stream.finalMessage()];
}
