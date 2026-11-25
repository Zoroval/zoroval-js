import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("..", import.meta.url).pathname;
// require.resolve honours --conditions and package self-reference on every supported Node (import.meta.resolve is not stable on 18).
const resolveWith = (conditions) =>
  execFileSync(process.execPath, [...conditions.map((c) => `--conditions=${c}`), "-e", 'console.log(require.resolve("zoroval"))'], { cwd: root, encoding: "utf8" }).trim();

test("conditional exports pick one entry per runtime", () => {
  assert.match(resolveWith([]), /dist\/node\.cjs$/);
  assert.match(resolveWith(["workerd"]), /dist\/workerd\.cjs$/);
  assert.match(resolveWith(["edge-light"]), /dist\/edge\.cjs$/);
});

test("the edge entries contain no Node-only import except node:async_hooks in the workerd one", () => {
  for (const file of ["edge.js", "edge.cjs", "index.js", "index.cjs", "workerd.js", "workerd.cjs"]) {
    const text = readFileSync(new URL(`../dist/${file}`, import.meta.url), "utf8");
    const imports = text.match(/node:[a-z_/]+/g) ?? [];
    const allowed = file.startsWith("workerd") ? ["node:async_hooks"] : [];
    assert.deepEqual([...new Set(imports)], allowed, file);
  }
  const chunk = readFileSync(new URL("../dist/", import.meta.url).pathname + "/" + execFileSync("ls", ["dist"], { cwd: root, encoding: "utf8" }).split("\n").find((f) => f.startsWith("chunk-")), "utf8");
  assert.deepEqual(chunk.match(/node:[a-z_/]+|require\(/g) ?? [], []);
});

test("package has zero runtime dependencies and the declared engines", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.engines.node, ">=18");
});

test("the CommonJS build works with require()", () => {
  const out = execFileSync(process.execPath, ["-e", `
    const z = require("zoroval");
    (async () => {
      const r = await z.conversation("c", () => z.turn(async () => 41 + 1));
      console.log(JSON.stringify({ r, init: z.init(), keys: Object.keys(z).sort() }));
    })();`], { cwd: root, encoding: "utf8", env: { ...process.env, ZOROVAL_INGEST_KEY: "" } });
  const result = JSON.parse(out);
  assert.equal(result.r, 42);
  assert.equal(result.init, false);
  assert.deepEqual(result.keys, ["Observation", "VERSION", "conversation", "currentObservation", "flush", "init", "setMetadata", "setTags", "setUser", "shutdown", "status", "step", "tool", "trace", "turn", "withZoroval", "wrapAnthropic", "wrapFetch", "wrapOpenAI"]);
});
