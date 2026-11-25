/**
 * Zoroval TypeScript SDK: traces of your LLM app, grouped as whole conversations.
 *
 *     import * as zoroval from "zoroval";
 *     zoroval.init();                       // reads ZOROVAL_INGEST_KEY
 *
 *     await zoroval.conversation(chatId, { userId }, () =>
 *       zoroval.turn({ input: text }, async (turn) => {
 *         const reply = await ask(text);
 *         turn.setOutput(reply);
 *       }));
 *
 * The SDK never throws into your code and never blocks your requests.
 */

export {
  conversation, turn, trace, step, tool, setUser, setTags, setMetadata, currentObservation, Observation,
} from "./context.js";
export type { ConversationOptions, TurnOptions, StepOptions, ToolOptions } from "./context.js";
export { init, flush, shutdown, status } from "./setup.js";
export type { InitOptions } from "./config.js";
export { wrapOpenAI } from "./integrations/openai.js";
export { wrapAnthropic } from "./integrations/anthropic.js";
export { wrapFetch } from "./integrations/fetch.js";
export type { WrapFetchOptions } from "./integrations/fetch.js";
export { withZoroval } from "./integrations/workers.js";
export { VERSION } from "./version.js";
