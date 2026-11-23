// Golden comparison of `zoroval login` and `logout`: the Python CLI (0.2.0) against this CLI, same fake
// app, same scenario. Not part of `npm test` (needs a Python with the zoroval dependencies):
//   PYTHON=/path/to/python node test/golden-login.mjs
// The only expected differences are printed: `npx zoroval` for `zoroval` in the commands the texts name,
// and the closing "Next:" line (the production step for the platform).
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { KEY, SETUP_CODE, REFUSALS, connectReply, keyReply, makeProject, startApp } from "./cli-fakes.mjs";

const python = process.env.PYTHON ?? "python3";
const pythonSrc = process.env.ZOROVAL_PYTHON_SRC ?? "/Users/inesh/Zoroval/zoroval-python/src";
const cli = new URL("../dist/cli.js", import.meta.url).pathname;
const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("ZOROVAL_") && k !== "CI"));

const run = (cmd, args, env) => new Promise((resolve) => {
  const child = spawn(cmd, args, { env: { ...base, PYTHONDONTWRITEBYTECODE: "1", PYTHONPATH: pythonSrc, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  child.on("close", (code) => resolve({ code, out }));
});

const scenarios = {
  "approved setup code": { env: { ZOROVAL_SETUP: SETUP_CODE }, routes: { "/api/agent-connect": [200, connectReply({ approved: true, handle: "#ZVtree", project_name: "Shop bot" })], "/api/agent-connect/token": [200, keyReply()], "/api/agent-setup/progress": [202, {}] } },
  "manual approval": { routes: { "/api/agent-connect": [200, connectReply()], "/api/agent-connect/token": (_b, i) => (i === 0 ? [202, {}] : [200, keyReply()]) } },
  "other ingest url": { routes: { "/api/agent-connect": [200, connectReply()], "/api/agent-connect/token": [200, keyReply({ ingest_url: "https://ingest.example.test" })] } },
  "denied": { routes: { "/api/agent-connect": [200, connectReply()], "/api/agent-connect/token": [410, { status: "denied" }] } },
  "used": { routes: { "/api/agent-connect": [200, connectReply()], "/api/agent-connect/token": [410, { status: "used" }] } },
  "bad key format": { routes: { "/api/agent-connect": [200, connectReply()], "/api/agent-connect/token": [200, keyReply({ key: "nope" })] } },
  "sign-in fails": { routes: { "/api/agent-connect": [500, {}] } },
  ...Object.fromEntries(Object.entries(REFUSALS).map(([k, v]) => [`refused: ${k}`, { env: { ZOROVAL_SETUP: SETUP_CODE }, routes: { "/api/agent-connect": v } }])),
};

let failed = false;
for (const [name, s] of Object.entries(scenarios)) {
  const result = {};
  for (const [who, cmd, args] of [["python", python, ["-m", "zoroval"]], ["ts", process.execPath, [cli]]]) {
    const app = await startApp(s.routes);
    const dir = makeProject();
    const r = await run(cmd, [...args, "login", "--root", dir, "--app-url", app.url, "--no-browser", "--timeout", "20"], s.env ?? {});
    const file = join(dir, ".env");
    result[who] = {
      code: r.code,
      out: r.out.split(app.url).join("<app>").split(dir).join("<dir>").split(dir.split("/").pop()).join("<folder>").split("`npx zoroval ").join("`zoroval ").split("\n").filter((l) => !l.startsWith("Next: ")).join("\n"),
      next: r.out.split("\n").find((l) => l.startsWith("Next: ")) ?? null,
      file: existsSync(file) ? readFileSync(file, "utf8") : null,
      calls: app.calls.map((c) => `${c.path} ${JSON.stringify(c.body).split(dir.split("/").pop()).join("<folder>")}`),
    };
    await app.close();
  }
  const same = ["code", "out", "file"].every((k) => result.python[k] === result.ts[k]) && JSON.stringify(result.python.calls) === JSON.stringify(result.ts.calls);
  console.log(`${same ? "identical" : "DIFFERENT"}  ${name}  (exit ${result.ts.code})`);
  if (!same) { failed = true; console.log(JSON.stringify(result, null, 2)); }
  if (result.ts.next) console.log(`            Next (python): ${result.python.next}\n            Next (ts):     ${result.ts.next}`);
}
process.exit(failed ? 1 : 0);
