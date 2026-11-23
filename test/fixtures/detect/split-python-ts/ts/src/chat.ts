import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { handleMessage } from "./app.ts";

const chatId = `terminal-${randomUUID()}`;
const rl = createInterface({ input: process.stdin });
for await (const line of rl) console.log((await handleMessage(chatId, line)).text);
