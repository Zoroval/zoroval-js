// A Worker written as a WorkerEntrypoint class: env and ctx are on `this`.
import { WorkerEntrypoint } from "cloudflare:workers";
import * as zoroval from "zoroval";

export default zoroval.withZoroval(class extends WorkerEntrypoint {
  async fetch(request) {
    const chat = new URL(request.url).searchParams.get("chat");
    return zoroval.conversation(chat, () => zoroval.turn({ input: "hi " + chat }, async () => new Response("class " + this.env.NAME)));
  }
});
