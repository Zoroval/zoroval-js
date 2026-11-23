export interface Env { OPENAI_API_KEY: string; ZOROVAL_INGEST_KEY: string }

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { chatId, text } = (await request.json()) as { chatId: string; text: string };
    const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: "gpt-5", messages: [{ role: "user", content: text }], user: chatId }),
    });
    return upstream;
  },
};
