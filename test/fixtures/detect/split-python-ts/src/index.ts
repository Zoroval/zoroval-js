// A Worker that only forwards requests to the container: no model calls here.
export default {
  async fetch(request: Request, env: { BOX: { fetch(r: Request): Promise<Response> } }): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname !== "/slack/events" && pathname !== "/health") return new Response("not found", { status: 404 });
    return env.BOX.fetch(request);
  },
};
