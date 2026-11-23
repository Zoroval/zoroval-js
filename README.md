# zoroval

Traces of your LLM app, grouped as whole conversations. Works on Node.js 18+, Next.js, Vercel Edge and Cloudflare Workers.

```sh
npm install zoroval
```

## Start

Set your ingest key as `ZOROVAL_INGEST_KEY` (or pass `apiKey`), then call `init()` once when your app starts.

```ts
import * as zoroval from "zoroval";

zoroval.init();
```

Without a key, `init()` does nothing and your app runs as before.

## Conversations and turns

Wrap the code that handles one chat message in `conversation()` and `turn()`. Every turn inside one
`conversation()` joins the same conversation in Zoroval.

```ts
export async function handleMessage(chatId: string, userId: string, text: string) {
  return zoroval.conversation(chatId, { userId }, () =>
    zoroval.turn({ input: text }, async (turn) => {
      const answer = await askModel(text);
      turn.setOutput(answer);
      return answer;
    }));
}
```

Both return whatever your function returns, and errors from your code pass through unchanged.

Add detail inside a turn with `step()` and `tool()`:

```ts
await zoroval.step("retrieve", async (step) => {
  step.setOutput(await search(text));
});

await zoroval.tool("get_weather", { arguments: { city } }, async (tool) => {
  tool.setOutput(await getWeather(city));
});
```

`zoroval.trace("nightly-job", fn)` does the same for a run that is not a chat, such as an agent or a batch job.
`setUser()`, `setTags()` and `setMetadata()` add details to the current turn.

## Sending on Workers, Edge and short scripts

On Node.js, spans are sent in the background and when the process exits. On Cloudflare Workers and Vercel Edge,
hand `flush()` to the platform so the response is not held up:

```ts
// Cloudflare Workers
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    zoroval.init({ apiKey: env.ZOROVAL_INGEST_KEY });
    const response = await handle(request);
    ctx.waitUntil(zoroval.flush());
    return response;
  },
};
```

Cloudflare Workers need the `nodejs_als` (or `nodejs_compat`) compatibility flag in `wrangler.toml` so that turns can be
grouped into conversations.

`await zoroval.flush()` also works anywhere you want everything sent before moving on, and `await zoroval.shutdown()`
sends what is left and stops.

## Privacy

Prompts, outputs and tool arguments are sent by default. Change that in `init()`:

```ts
zoroval.init({
  captureContent: false,                       // send no prompts, outputs or tool arguments
});

zoroval.init({
  redact: (value) => scrub(value),             // runs on every text field before it is sent
});
```

If your `redact` function throws, that field is not sent.

## Options

| Option | Environment variable | |
| --- | --- | --- |
| `apiKey` | `ZOROVAL_INGEST_KEY` | Your ingest key. |
| `serviceName` | `ZOROVAL_SERVICE_NAME` | Name of your service. |
| `environment` | `ZOROVAL_ENVIRONMENT` | For example `production`. |
| `release` | `ZOROVAL_RELEASE` | Your app version. |
| `captureContent` | `ZOROVAL_CAPTURE_CONTENT` | `false` to send no content. |
| `redact` | | Function applied to every text field. |
| `sampleRate` | `ZOROVAL_SAMPLE_RATE` | 0 to 1; a conversation is kept or dropped as a whole. |
| `enabled` | `ZOROVAL_ENABLED` | `false` turns Zoroval off. |

`zoroval.status()` shows what has been sent.

## License

Apache-2.0
