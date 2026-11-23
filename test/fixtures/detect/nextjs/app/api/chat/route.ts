import OpenAI from "openai";

const openai = new OpenAI();

export async function POST(req: Request) {
  const { chatId, message } = await req.json();
  const reply = await openai.chat.completions.create({ model: "gpt-5", messages: [{ role: "user", content: message }] });
  return Response.json({ chatId, reply });
}
