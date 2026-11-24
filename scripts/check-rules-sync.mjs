// Fails when the shared redaction rules or corpus differ from the zoroval-python copy, which is the
// source of truth (the TypeScript SDK, the Python SDK and ingest must run the same rules).
// usage: node scripts/check-rules-sync.mjs
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const BASE = "https://raw.githubusercontent.com/Zoroval/zoroval-python/main/";
const FILES = [
  ["src/redaction/level1.json", "src/zoroval/redaction/level1.json"],
  ["test/redaction/level1_corpus.json", "tests/redaction/level1_corpus.json"],
];
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
let failed = false;
for (const [local, remote] of FILES) {
  const mine = sha(readFileSync(new URL(`../${local}`, import.meta.url)));
  const response = await fetch(BASE + remote);
  if (!response.ok) {
    console.log(`::error::${remote} not readable on zoroval-python main (HTTP ${response.status})`);
    failed = true;
    continue;
  }
  const theirs = sha(Buffer.from(await response.arrayBuffer()));
  if (mine !== theirs) {
    console.log(`::error::${local} differs from zoroval-python main ${remote}: copy it from there`);
    failed = true;
  } else {
    console.log(`ok ${local} matches zoroval-python main (${mine.slice(0, 12)})`);
  }
}
process.exit(failed ? 1 : 0);
