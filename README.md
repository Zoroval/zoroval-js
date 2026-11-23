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

## OpenAI

Wrap your OpenAI client once. Use it exactly as before: every chat completion and response becomes a span inside the
current turn, with the model, token counts, messages and tool calls. Streaming works the same way.

```ts
import OpenAI from "openai";

const openai = zoroval.wrapOpenAI(new OpenAI());
```

## Conversations and turns

Wrap the code that handles one chat message in `conversation()` and `turn()`. Every turn inside one
`conversation()` joins the same conversation in Zoroval.

```ts
export async function handleMessage(chatId: string, userId: string, text: string) {
  return zoroval.conversation(chatId, { userId }, () =>
    zoroval.turn({ input: text }, async (turn) => {
      const reply = await openai.chat.completions.create({
        model: "gpt-5",
        messages: [{ role: "user", content: text }],
      });
      const answer = reply.choices[0].message.content;
      turn.setOutput(answer);
      return answer;
    }));
}
```

Both return whatever your function returns, and errors from your code pass through unchanged.

Add detail inside a turn with `step()` and `tool()`. A `tool()` run is matched to the tool call the model asked for:

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

## Plain `fetch`

If you call OpenAI with `fetch` instead of the `openai` package, use `wrapFetch()`. Calls to the OpenAI API are traced;
every other call goes through untouched.

```ts
const tracedFetch = zoroval.wrapFetch();

const response = await tracedFetch("https://api.openai.com/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
  body: JSON.stringify({ model: "gpt-5", messages }),
});
```

For an OpenAI-compatible endpoint, list its base URL: `zoroval.wrapFetch(fetch, { baseURLs: ["https://llm.example.com/v1"] })`.

## Cloudflare Workers

Wrap your exported handler. `withZoroval()` reads `ZOROVAL_INGEST_KEY` (and the other `ZOROVAL_*` settings) from your
Worker's bindings and sends the trace after the response, including streamed responses.

```ts
export default zoroval.withZoroval({
  async fetch(request: Request, env: Env) {
    const openai = zoroval.wrapFetch();
    // ... handle the request
  },
});
```

Add the `nodejs_als` (or `nodejs_compat`) compatibility flag to `wrangler.toml` so that turns can be grouped into
conversations. Keep the key in a secret: `npx wrangler secret put ZOROVAL_INGEST_KEY`.

## Next.js and Vercel

On Node.js, spans are sent in the background and when the process exits. On serverless and edge routes, ask the platform
to send them after the response:

```ts
import { after } from "next/server";
import * as zoroval from "zoroval";

export async function POST(request: Request) {
  after(() => zoroval.flush());
  // ... handle the request
}
```

Outside Next.js on Vercel, use `waitUntil(zoroval.flush())` from `@vercel/functions`.

`await zoroval.flush()` also works anywhere you want everything sent before moving on, and `await zoroval.shutdown()`
sends what is left and stops.

## Command line

`npx zoroval` connects a project and checks it.

```sh
npx zoroval login     # sign in in your browser; the key is saved to a file git ignores
npx zoroval doctor    # send a test trace and check that it arrives
```

`login` saves the key as `ZOROVAL_INGEST_KEY` in `.dev.vars` for a Cloudflare Worker, `.env.local` for a
Next.js app and `.env` otherwise. It refuses a file that git tracks or does not ignore, so the key is never
committed. Pick another file with `--file <path>` (the same as `--env-file`; on Node 20.6 or newer use `--file`,
because Node reads `--env-file` itself and stops when that file does not exist yet).

For production, add the key to your host yourself: `wrangler secret put ZOROVAL_INGEST_KEY` for a Worker, or the
project's environment variables on Vercel. Make a separate key for production.

`doctor` also checks that a Cloudflare Worker has the `nodejs_als` or `nodejs_compat` flag, and
`npx zoroval doctor --wait 60` waits for your first real trace. `npx zoroval detect` lists what your project
uses (add `--json` for a machine-readable report) and `npx zoroval logout` removes what `login` wrote. None of
them prints your key or any value from your env files.

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
