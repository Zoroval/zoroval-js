const OpenAI = require("openai");
const BASE = "https://api.openai.com/v1/responses";

async function viaFetch(body) {
  const direct = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", body });
  const named = await fetch(BASE, { method: "POST", body });
  const other = await fetch("https://example.com/api", { method: "GET" });
  return [direct, named, other];
}
module.exports = { viaFetch, OpenAI };
