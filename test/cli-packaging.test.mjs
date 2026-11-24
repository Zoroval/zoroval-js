import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { test } from "node:test";

const root = new URL("..", import.meta.url).pathname;
const dist = (name) => readFileSync(new URL(`../dist/${name}`, import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("the bin entry exists, is executable, starts with a Node shebang, and is ESM", () => {
  assert.equal(pkg.bin.zoroval, "dist/cli.js"); // npm normalizes away a leading ./
  const text = dist("cli.js");
  assert.ok(text.startsWith("#!/usr/bin/env node\n"));
  assert.ok(statSync(new URL("../dist/cli.js", import.meta.url)).mode & 0o111, "not executable");
  assert.equal(pkg.type, "module");
});

test("no runtime entry contains CLI code or the Node modules the CLI needs", () => {
  const files = readdirSync(new URL("../dist/", import.meta.url)).filter((f) => /\.(js|cjs)$/.test(f) && f !== "cli.js");
  assert.ok(files.length >= 8);
  for (const file of files) {
    const text = dist(file);
    for (const marker of ["agent-connect", "agent-setup", "child_process", "node:fs", "wrangler", "ZOROVAL_SETUP", "npx zoroval"]) {
      assert.ok(!text.includes(marker), `${file} contains ${marker}`);
    }
  }
});

test("the CLI bundle imports only Node built-ins, with the node: prefix, and no package", () => {
  const imports = [...dist("cli.js").matchAll(/^import\b[^"';]*?(?:from\s*)?"([^"]+)";/gm)].map((m) => m[1]);
  assert.ok(imports.length > 0);
  for (const spec of imports) assert.match(spec, /^node:/, spec);
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), []);
});

test("the runtime bundle stays under the 20 KB gzip budget for every entry", () => {
  const chunks = readdirSync(new URL("../dist/", import.meta.url)).filter((f) => f.startsWith("chunk-") && f.endsWith(".js"));
  const gz = (name) => gzipSync(readFileSync(new URL(`../dist/${name}`, import.meta.url)), { level: 9 }).length;
  for (const entry of ["index", "node", "edge", "workerd"]) {
    const esm = gz(`${entry}.js`) + chunks.reduce((sum, c) => sum + gz(c), 0);
    assert.ok(esm < 20 * 1024, `${entry} esm is ${esm} bytes`);
    assert.ok(gz(`${entry}.cjs`) < 20 * 1024, `${entry} cjs`);
  }
});

test("npm pack ships dist, README and LICENSE only: the CLI, no sources, tests or fixtures", () => {
  const out = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" }));
  const files = out[0].files.map((f) => f.path);
  assert.ok(files.includes("dist/cli.js"));
  assert.ok(files.includes("dist/node.js") && files.includes("README.md") && files.includes("LICENSE"));
  assert.ok(files.every((f) => f === "package.json" || f === "README.md" || f === "LICENSE" || f.startsWith("dist/")), files.join(" "));
});

test("`zoroval --version` runs from the built bin", () => {
  const out = execFileSync(process.execPath, [new URL("../dist/cli.js", import.meta.url).pathname, "--version"], { encoding: "utf8" });
  assert.equal(out, `zoroval ${pkg.version}\n`);
});
