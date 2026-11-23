// Manual 2G check of the CLI through the team's slowproxy (outside this repo). Not part of `npm test`.
//   node test/cli-slowproxy.manual.mjs [path/to/slowproxy.mjs]
// Profile: up 25 KB/s (about 200 kbit/s), down 50 KB/s, 300 ms one-way latency (slowproxy defaults).
// Runs `login` (setup code, approved) and `doctor` against fakes that sit behind the proxy.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEY, SETUP_CODE, connectReply, keyReply, makeProject, runCli, sleep, startApp, startGateway } from "./cli-fakes.mjs";

const proxyPath = process.argv[2] ?? "/Users/inesh/Zoroval/low-bandwidth-tests/slowproxy.mjs";
if (!existsSync(proxyPath)) { console.log("slowproxy not found at", proxyPath); process.exit(2); }

function proxy(upstream, port) {
  return spawn(process.execPath, [proxyPath], {
    env: { ...process.env, LISTEN: String(port), UPSTREAM: upstream.replace("http://", ""), UP_KBPS: "25", DOWN_KBPS: "50", LATENCY_MS: "300", LOG: join(tmpdir(), "zoroval-cli-slowproxy.log") },
    stdio: "ignore",
  });
}

const app = await startApp({
  "/api/agent-setup/progress": [202, { status: "ok" }],
  "/api/agent-connect": [200, connectReply({ approved: true, handle: "#ZVtree", project_name: "Shop bot" })],
  "/api/agent-connect/token": [200, keyReply()],
});
const gateway = await startGateway({ firstTrace: "2026-11-23T10:00:00Z" });
const appPort = 18900 + Math.floor(Math.random() * 50), gwPort = appPort + 60;
const proxies = [proxy(app.url, appPort), proxy(gateway.url, gwPort)];
await sleep(600);
let failed = false;
const dir = makeProject();

let t = Date.now();
const login = await runCli(["login", "--root", dir, "--app-url", `http://127.0.0.1:${appPort}`, "--timeout", "60"], { cwd: dir, env: { ZOROVAL_SETUP: SETUP_CODE } });
console.log(JSON.stringify({ step: "login (setup code, approved)", exit: login.code, ms: Date.now() - t, out: login.stdout.trim().split("\n").at(-2) }));
failed ||= login.code !== 0 || Date.now() - t > 60_000;

t = Date.now();
const doctor = await runCli(["doctor", "--root", dir, "--ingest-url", `http://127.0.0.1:${gwPort}`, "--timeout", "30", "--json"], { cwd: dir, env: { ZOROVAL_INGEST_KEY: KEY } });
const checks = JSON.parse(doctor.stdout);
console.log(JSON.stringify({ step: "doctor", exit: doctor.code, ms: Date.now() - t, ok: checks.ok, checks: checks.checks.map((c) => `${c.level}:${c.check}`) }));
failed ||= doctor.code !== 0 || Date.now() - t > 30_000;
console.log(failed ? "FAILED" : "within deadlines");
proxies.forEach((p) => p.kill());
await app.close(); await gateway.close();
process.exit(failed ? 1 : 0);
