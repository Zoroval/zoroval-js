// Golden comparison of `zoroval detect --json`: the Python CLI (0.2.0) against this CLI on the same
// folder. Not part of `npm test` (it needs a Python with the zoroval dependencies):
//   PYTHON=/path/to/python node test/golden.mjs [fixture ...]
// Prints a diff per fixture; exit 1 when a fixture differs.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareFixture } from "./fixtures-prepare.mjs";

const write = process.argv.includes("--write"); // refresh test/fixtures/detect/<name>.expected.json from the Python CLI
const python = process.env.PYTHON ?? "python3";
const pythonSrc = process.env.ZOROVAL_PYTHON_SRC ?? new URL("../../zoroval-python/src", import.meta.url).pathname;
const cli = new URL("../dist/cli.js", import.meta.url).pathname;
const base = new URL("./fixtures/detect/", import.meta.url).pathname;
const args = process.argv.slice(2).filter((a) => a !== "--write");
const names = args.length ? args : readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.startsWith("python")).map((e) => e.name);
const env = { ...process.env, PYTHONPATH: pythonSrc, PYTHONDONTWRITEBYTECODE: "1" };
for (const k of Object.keys(env)) if (k.startsWith("ZOROVAL_")) delete env[k];

let failed = false;
for (const name of names) {
  const dir = prepareFixture(join(base, name));
  const run = (cmd, args) => execFileSync(cmd, args, { env, encoding: "utf8", cwd: dir });
  const py = run(python, ["-m", "zoroval", "detect", "--json", dir]);
  const ts = run(process.execPath, [cli, "detect", "--json", dir]);
  if (write) writeFileSync(join(base, `${name}.expected.json`), py.split(dir).join("<root>"));
  if (py === ts) console.log(`${name}: identical (${py.length} bytes)`);
  else {
    failed = true;
    const a = join(tmpdir(), `golden-${name}-python.json`), b = join(tmpdir(), `golden-${name}-ts.json`);
    writeFileSync(a, py); writeFileSync(b, ts);
    console.log(`${name}: DIFFERENT`);
    try { execFileSync("diff", ["-u", a, b], { encoding: "utf8" }); } catch (e) { console.log(e.stdout); }
  }
}
process.exit(failed ? 1 : 0);
