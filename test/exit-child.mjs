// usage: node exit-child.mjs <mode> <gatewayUrl> <key>   modes: natural | sigterm | sigterm-app
import * as zoroval from "../dist/node.js";
const [mode, url, key] = process.argv.slice(2);
zoroval.init({ apiKey: key, ingestUrl: url, flushIntervalMs: 60_000 }); // the timer would not fire in time
await zoroval.conversation("exit-chat", () => zoroval.turn({ input: "bye" }, () => {}));
if (mode === "sigterm" || mode === "sigterm-app") {
  if (mode === "sigterm-app") process.on("SIGTERM", () => setTimeout(() => process.exit(0), 600)); // the app handles SIGTERM itself
  console.log("ready");
  setInterval(() => {}, 1000);
}
