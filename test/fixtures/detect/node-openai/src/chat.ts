import OpenAI from "openai";

const openai = new OpenAI();
// openai.chat.completions.create({ model: "not-a-call" })
const doc = "openai.chat.completions.create(not a call either)";
const pattern = /chat.completions.create(/g;
/* openai.responses.create({}) in a block comment */

export async function handleMessage(chatId: string, userId: string, text: string) {
  const reply = await openai.chat.completions.create({
    model: "gpt-5",
    messages: [{ role: "user", content: text }],
  });
  const second = await openai.responses.create({ model: "gpt-5", input: text });
  const stream = openai.chat.completions.stream({ model: "gpt-5", messages: [] });
  return { reply, second, stream, doc, pattern };
}

export function route({ threadId, sessionId = "x" }: { threadId: string; sessionId?: string }, req: any) {
  const id = req.body.conversationId ?? req?.query.chatId;
  return handleMessage(id, "u", `${threadId} ${sessionId}`);
}

const notCandidates = (value: string) => value.length; // chat_id mentioned only in a comment
const same = chatIdOnly => chatIdOnly;
