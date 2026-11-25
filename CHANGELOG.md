# Changelog

## 0.2.1

- OpenAI Responses: built-in tool calls (web search, file search, code interpreter, MCP and others) are recorded as tool calls with their query or arguments, in the output and in the input history. Before, only their type was kept.
- `zoroval detect` finds OpenAI calls made through a name that holds `fetch` (`const doFetch = opts.fetchImpl ?? fetch; doFetch("https://api.openai.com/v1/responses")`) or a fetch-named function.
- `zoroval detect` lists conversation ids in server code (Worker, handlers, files that call the model) before browser components, so the plan points at the server.
- New: `wrapAnthropic(new Anthropic())` traces `messages.create`, `messages.parse` and `messages.stream()` of `@anthropic-ai/sdk`, streaming or not, on Node, Edge and Cloudflare Workers: thinking, tool calls, server tools (web search, web fetch, code execution) with their results, citations, and cache token counts. Input tokens are the whole prompt (uncached, cache reads and cache writes); the cache counts are kept beside it. The runtime bundle grows by about 1 KB gzip.
- `zoroval detect` finds Anthropic calls in TypeScript and JavaScript and plans `wrapAnthropic`.
- `zoroval detect` for a Vercel AI SDK app no longer asks for the `zoroval` package, `init()` or `flush()`. For AI SDK 7 it plans `@ai-sdk/otel` with `registerTelemetry(new OpenTelemetry({ runtimeContext: true }))` and the chat id through `runtimeContext`; AI SDK 6 and older keep `experimental_telemetry` metadata. A route that reads `{ id, messages }` from its body offers `id` as the chat id.
- OpenAI Responses: one assistant message per output item, the same as when the app sends the item back as history, so a reply is not shown twice. Built-in tools keep their result (web search sources, file search results, code interpreter output, MCP output or error) beside the call, and web search keeps only its query as arguments.
- OpenAI: text keeps its annotations (URL and file citations).
- OpenAI-compatible providers: reasoning from DeepSeek (`reasoning_content`) and OpenRouter (`reasoning`, `reasoning_details`) is recorded, as its own message before the reply; Groq stream usage (`x_groq.usage`) is read; `gen_ai.provider.name` comes from the base URL (groq, deepseek, openrouter and others).
- `wrapFetch`: an HTTP error is recorded as the error the `openai` package throws for that status (`RateLimitError` for 429), with an exception event, like `wrapOpenAI`.

## 0.2.0

- Breaking: `captureContent` is removed. If `captureContent: false` or `ZOROVAL_CAPTURE_CONTENT` (env or Worker binding) is set to off, tracing stays off until you remove it. Use `redact` to clean content before it is sent.
- New: built-in redaction, off by default. `zoroval.init({ redact: "basic" })` replaces card numbers, emails, phone numbers, Aadhaar, PAN and API keys with labels. `redact: ["basic", fn]` runs it before your own function.
- `zoroval.status()` reports `redact` in place of `captureContent`.
