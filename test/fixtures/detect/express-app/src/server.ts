import express from "express";
import OpenAI from "openai";

const app = express();
const openai = new OpenAI();
app.use(express.json());

app.post("/chat", async (req, res) => {
  const { chatId, text } = req.body;
  const reply = await openai.chat.completions.create({ model: "gpt-5", messages: [{ role: "user", content: text }] });
  res.json({ chatId, reply });
});

app.listen(3000);
