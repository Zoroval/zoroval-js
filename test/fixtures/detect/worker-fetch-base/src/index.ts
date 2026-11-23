// A Worker that calls OpenAI with plain fetch through a configurable base URL (the preview run's shape).
export interface Env { OPENAI_API_KEY: string; OPENAI_BASE_URL?: string }

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { chatId, text } = (await request.json()) as { chatId: string; text: string };
    const base = env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
    const reply = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5", messages: [{ role: "user", content: text }], user: chatId }),
    });
    const url = env.OPENAI_BASE_URL + "/responses";
    await fetch(url, { method: "POST", body: "{}" });
    await fetch("https://llm.example.com/v1/chat/completions", { method: "POST", body: "{}" });
    await fetch(`${base}/embeddings`, { method: "POST", body: "{}" }); // not traced by wrapFetch: not counted
    return reply;
  },
};
