import OpenAI from "openai";

const openai = new OpenAI();

export async function answer(input: string, user: string) {
  const reply = await openai.responses.parse({ model: "gpt-5", input, user });
  return { text: String(reply.output_text) };
}
