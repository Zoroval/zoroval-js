import { openai } from "@ai-sdk/openai";
import { convertToModelMessages, streamText, type UIMessage } from "ai";
import { saveChat } from "../../../lib/store";

export async function POST(req: Request) {
  const { id, messages }: { id: string; messages: UIMessage[] } = await req.json();
  const result = streamText({ model: openai("gpt-5"), messages: await convertToModelMessages(messages) });
  return result.toUIMessageStreamResponse({ originalMessages: messages, onFinish: ({ messages }) => saveChat(id, messages) });
}
