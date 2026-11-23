import { Hono } from "hono";

const app = new Hono();
app.post("/chat", async (c) => {
  const { conversationId } = await c.req.json();
  const r = await fetch("https://api.openai.com/v1/responses", { method: "POST", body: conversationId });
  return c.json(await r.json());
});

export default app;
