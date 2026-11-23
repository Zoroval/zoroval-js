// Simulates Node 18: no global `crypto`. The Node entry must fall back to node:crypto's webcrypto.
Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
// Ids must come from webcrypto, never from the Math.random last resort.
Math.random = () => { throw new Error("Math.random used"); };
const [url, key] = process.argv.slice(2);
const zoroval = await import("../dist/node.js");
zoroval.init({ apiKey: key, ingestUrl: url, flushIntervalMs: 20 });
await zoroval.conversation("n18", () => zoroval.turn(() => zoroval.step("s", () => {})));
const ok = await zoroval.flush(3000);
console.log(JSON.stringify({ ok, typeofCrypto: typeof globalThis.crypto, status: zoroval.status().spansExported }));
process.exit(0);
