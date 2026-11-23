// Runs every test file in its own `node --test` process, a few at a time, each with a time limit.
// A test that hangs is killed and named, instead of holding the whole run (Node 18's test runner has no
// --test-timeout). Prints each file's TAP output when it ends, then a summary in the usual `# pass` form.
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { availableParallelism, cpus } from "node:os";

const LIMIT_MS = Number(process.env.TEST_FILE_TIMEOUT_MS ?? 240_000);
const dir = new URL("../test/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".test.mjs")).sort();
const slots = Math.max(2, Math.min(4, (availableParallelism?.() ?? cpus().length)));

const totals = { tests: 0, pass: 0, fail: 0 };
const problems = [];

function runFile(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", new URL(file, dir).pathname], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, LIMIT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      const count = (name) => Number(new RegExp(`^# ${name} (\\d+)`, "m").exec(out)?.[1] ?? 0);
      totals.tests += count("tests"); totals.pass += count("pass"); totals.fail += count("fail");
      if (timedOut) {
        const started = [...out.matchAll(/^# Subtest: (.+)$/gm)].map((m) => m[1]);
        const finished = new Set([...out.matchAll(/^(?:not )?ok \d+ - (.+?)(?: # .*)?$/gm)].map((m) => m[1]));
        const open = started.filter((name) => !finished.has(name));
        problems.push(`${file}: no result after ${LIMIT_MS / 1000} s, killed. Started but not finished: ${open.join(" | ") || "(unknown)"}`);
      } else if (code !== 0) problems.push(`${file}: exit ${code}`);
      process.stdout.write(`${timedOut ? "TIMEOUT" : code === 0 ? "ok" : "FAIL"} ${file}\n${timedOut || code !== 0 ? out : ""}`);
      resolve();
    });
  });
}

const queue = [...files];
await Promise.all(Array.from({ length: slots }, async () => { for (let f; (f = queue.shift()); ) await runFile(f); }));
console.log(`# tests ${totals.tests}\n# pass ${totals.pass}\n# fail ${totals.fail}`);
for (const p of problems) console.log(`# PROBLEM ${p}`);
process.exit(problems.length ? 1 : 0);
