// A Next.js route handler on the Node runtime, written the way the README says.
import OpenAI from "openai";
import { after } from "next/server";
import * as zoroval from "zoroval";

zoroval.init();
const openai = zoroval.wrapOpenAI(new OpenAI({ apiKey: "sk-test", baseURL: process.env.OPENAI_BASE, maxRetries: 0 }));

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  const { chatId, text, stream } = await request.json();
  after(() => zoroval.flush());
  return zoroval.conversation(chatId, { userId: "u-" + chatId }, () =>
    zoroval.turn({ input: text }, async (turn) => {
      const messages = [{ role: "user", content: text }];
      if (stream) {
        // the turn returns the Response before the reply has finished streaming
        const events = await openai.chat.completions.create({ model: "gpt-test", stream: true, messages });
        return new Response(events.toReadableStream(), { headers: { "content-type": "application/x-ndjson" } });
      }
      const reply = await openai.chat.completions.create({ model: "gpt-test", messages });
      const message = reply.choices[0].message;
      turn.setOutput(message.content ?? message.tool_calls[0].function.name);
      return Response.json(reply);
    }));
}
