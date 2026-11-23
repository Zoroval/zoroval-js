export default {
  async fetch(request: Request): Promise<Response> {
    const url = "https://api.openai.com/v1/responses";
    const conversationId = new URL(request.url).searchParams.get("c");
    return fetch(url, { method: "POST", body: JSON.stringify({ model: "gpt-5", input: conversationId }) });
  },
};
