import { handleMessage } from "./app.ts";

let id;
id = "ask-1";
console.log((await handleMessage(id, process.argv.slice(2).join(" "))).text);
