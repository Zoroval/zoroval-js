export default {
  async fetch(request: Request): Promise<Response> {
    return fetch("https://api.openai.com/v1/responses", { method: "POST", body: await request.text() });
  },
};
