import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { test, beforeEach } from "node:test";
import * as cli from "../.test-build/cli.js";
import { KEY, SETUP_CODE, REFUSALS, connectReply, keyReply, makeProject, runCli, startApp, sleep } from "./cli-fakes.mjs";

const read = (dir, name) => readFileSync(join(dir, name), "utf8");
const approvedApp = (extra = {}, token = {}) => startApp({
  "/api/agent-connect": [200, connectReply({ approved: true, handle: "#ZVtree", project_id: "p1", project_name: "Shop bot", ...extra })],
  "/api/agent-connect/token": [200, keyReply(token)],
  "/api/agent-setup/progress": [202, { status: "ok" }],
});
const manualApp = (token = () => [200, keyReply()], connect = {}) => startApp({
  "/api/agent-connect": [200, connectReply(connect)],
  "/api/agent-connect/token": token,
  "/api/agent-setup/progress": [202, { status: "ok" }],
});
const login = (app, dir, extra = []) => runCli(["login", "--root", dir, "--app-url", app.url, ...extra], { cwd: dir });

// In-process runs replace the screen, the browser and the clock.
function fakeDeps(overrides = {}) {
  const said = [], opened = [], slept = [];
  let t = 0;
  return {
    said, opened, slept,
    deps: {
      say: (m) => said.push(m), openBrowser: (u) => opened.push(u), isTTY: true, ci: false,
      sleep: async (ms) => { slept.push(ms); t += ms; }, now: () => t, ...overrides,
    },
  };
}
const opts = (dir, app, extra = {}) => ({ root: dir, envFile: ".env", appUrl: app.url, noBrowser: false, replace: false, allowNoGit: false, timeoutS: 600, ...extra });

beforeEach(() => { cli.resetSent(); for (const k of ["ZOROVAL_SETUP", "ZOROVAL_INGEST_KEY", "ZOROVAL_APP_URL"]) delete process.env[k]; });

test("login with an approved setup code: no link, no browser, one poll, key written 0600", async () => {
  const app2 = await approvedApp();
  const dir2 = makeProject();
  const r = await runCli(["login", "--root", dir2, "--app-url", app2.url], { cwd: dir2, env: { ZOROVAL_SETUP: SETUP_CODE } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /#ZVtree connected to Shop bot/);
  assert.doesNotMatch(r.stdout, /Open this link/);
  assert.ok(!r.stdout.includes(KEY) && !r.stderr.includes(KEY));
  assert.ok(read(dir2, ".env").includes(`ZOROVAL_INGEST_KEY=${KEY}`));
  assert.equal((statSync(join(dir2, ".env")).mode & 0o777), 0o600);
  const connect = app2.calls.find((c) => c.path === "/api/agent-connect").body;
  assert.equal(connect.setup_code, SETUP_CODE);
  assert.equal(connect.name, `${dir2.split("/").pop()} (agent)`.slice(0, 120));
  assert.equal(app2.paths().filter((p) => p === "/api/agent-connect/token").length, 1);
  assert.equal(app2.calls.find((c) => c.path === "/api/agent-connect").headers["user-agent"], "zoroval-js/0.1.0");
  await app2.close();
});

test("progress events: started first and once, then the command's own, setup code passed through", async () => {
  const app = await approvedApp();
  const dir = makeProject();
  await runCli(["login", "--root", dir, "--app-url", app.url], { cwd: dir, env: { ZOROVAL_SETUP: SETUP_CODE } });
  assert.deepEqual(app.events(), ["started"]);
  assert.ok(app.calls.filter((c) => c.path === "/api/agent-setup/progress").every((c) => c.body.code === SETUP_CODE));
  // `started` goes out before the sign-in request
  assert.equal(app.paths()[0], "/api/agent-setup/progress");
  await app.close();
});

test("login without a setup code prints the approval link and code (check 9), sends no setup_code and no progress", async () => {
  const app = await manualApp(() => [200, keyReply()]);
  const dir = makeProject();
  const r = await login(app, dir, ["--no-browser"]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Open this link and approve the request named ".* \(agent\)":\n  https:\/\/app\.test\/connect\?code=ABCD-2345\nCheck that the page shows the code ABCD-2345\./);
  assert.doesNotMatch(r.stdout, /connected to/);
  assert.equal("setup_code" in app.calls[0].body, false);
  assert.ok(!app.paths().includes("/api/agent-setup/progress"));
  assert.match(r.stdout, /Key written to \.env as ZOROVAL_INGEST_KEY \(key id abcdefghijkl, project proj_1\)\. The key is not shown\. File mode is 600\./);
  await app.close();
});

test("--name is sent as the client name", async () => {
  const app = await manualApp();
  const dir = makeProject();
  await login(app, dir, ["--no-browser", "--name", "my bot"]);
  assert.equal(app.calls[0].body.name, "my bot");
  await app.close();
});

for (const [label, refusal] of Object.entries(REFUSALS)) {
  test(`setup code refused (${label}): server message shown, exit 1, no token call, nothing written`, async () => {
    const app = await startApp({ "/api/agent-connect": refusal, "/api/agent-setup/progress": [202, {}] });
    const dir = makeProject();
    const r = await runCli(["login", "--root", dir, "--app-url", app.url], { cwd: dir, env: { ZOROVAL_SETUP: SETUP_CODE } });
    assert.equal(r.code, 1);
    assert.ok(r.stdout.includes(refusal[1].message));
    assert.doesNotMatch(r.stdout, /Open this link/);
    assert.ok(!app.paths().includes("/api/agent-connect/token"));
    assert.equal(existsSync(join(dir, ".env")), false);
    await app.close();
  });
}

test("setup code refused without a message: the default text", async () => {
  const app = await startApp({ "/api/agent-connect": [400, {}] });
  const dir = makeProject();
  const r = await runCli(["login", "--root", dir, "--app-url", app.url], { cwd: dir, env: { ZOROVAL_SETUP: SETUP_CODE } });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /The setup code was not accepted\. Ask the developer to copy a fresh prompt from Zoroval\./);
  await app.close();
});

test("sign-in cannot start: server error, and no connection", async () => {
  const app = await startApp({ "/api/agent-connect": [500, {}] });
  const dir = makeProject();
  const r = await login(app, dir);
  assert.equal(r.code, 1);
  assert.match(r.stdout, new RegExp(`Could not start sign-in at ${app.url.replace(/\./g, "\\.")} \\(status 500\\)\\.`));
  await app.close();
  const r2 = await runCli(["login", "--root", dir, "--app-url", "http://127.0.0.1:9"], { cwd: dir });
  assert.equal(r2.code, 1);
  assert.match(r2.stdout, /status no connection\)\./);
});

test("the browser opens only with a TTY, no --no-browser and no CI; an approved request never opens it", async () => {
  for (const [label, deps, extra, expectOpen] of [
    ["tty", {}, {}, true],
    ["no tty", { isTTY: false }, {}, false],
    ["CI", { ci: true }, {}, false],
    ["--no-browser", {}, { noBrowser: true }, false],
  ]) {
    const app = await manualApp(() => [200, keyReply()]);
    const dir = makeProject();
    const f = fakeDeps(deps);
    const code = await cli.login(opts(dir, app, extra), f.deps);
    assert.equal(code, 0, label);
    assert.deepEqual(f.opened, expectOpen ? ["https://app.test/connect?code=ABCD-2345"] : [], label);
    assert.ok(f.said.some((m) => m.startsWith("Open this link")), label);
    await app.close();
  }
  process.env.ZOROVAL_SETUP = SETUP_CODE;
  const app = await approvedApp();
  const dir = makeProject();
  const f = fakeDeps();
  assert.equal(await cli.login(opts(dir, app), f.deps), 0);
  assert.deepEqual(f.opened, []);
  assert.ok(!f.said.some((m) => m.startsWith("Open this link")));
  await app.close();
});

test("polling: waits the server interval, +5 s after a 429, keeps going on 202 and 5xx", async () => {
  const replies = [[202, { status: "pending" }], [429, { status: "slow_down" }], [503, {}], [200, keyReply()]];
  const app = await manualApp((_b, i) => replies[i], { interval: 3 });
  const dir = makeProject();
  const f = fakeDeps();
  assert.equal(await cli.login(opts(dir, app), f.deps), 0);
  // 3 s before every poll; after the 429 the interval is 8 s for the rest
  assert.deepEqual(f.slept, [3000, 3000, 8000, 8000]);
  await app.close();
});

test("an approved request is polled at once (no wait), and a missing interval defaults to 3 s", async () => {
  process.env.ZOROVAL_SETUP = SETUP_CODE;
  const app = await startApp({
    "/api/agent-connect": [200, connectReply({ approved: true, handle: "#ZVtree", interval: undefined })],
    "/api/agent-connect/token": (_b, i) => (i === 0 ? [202, {}] : [200, keyReply()]),
    "/api/agent-setup/progress": [202, {}],
  });
  const dir = makeProject();
  const f = fakeDeps();
  assert.equal(await cli.login(opts(dir, app), f.deps), 0);
  assert.deepEqual(f.slept, [3000]);
  await app.close();
});

test("timeout: gives up after min(expires_in, --timeout) with exit 1", async () => {
  const app = await manualApp(() => [202, { status: "pending" }], { interval: 3, expires_in: 600 });
  const dir = makeProject();
  const f = fakeDeps();
  assert.equal(await cli.login(opts(dir, app, { timeoutS: 10 }), f.deps), 1);
  assert.ok(f.said.at(-1).startsWith("The request expired before it was approved. Run `npx zoroval login` again."));
  assert.equal(f.slept.reduce((a, b) => a + b, 0), 12000); // polls at 3,6,9,12 s; the check at 12 s ends it
  const app2 = await manualApp(() => [202, {}], { interval: 3, expires_in: 5 });
  const f2 = fakeDeps();
  assert.equal(await cli.login(opts(dir, app2, { timeoutS: 600 }), f2.deps), 1);
  assert.equal(f2.slept.reduce((a, b) => a + b, 0), 6000);
  assert.equal(existsSync(join(dir, ".env")), false);
  await app.close(); await app2.close();
});

test("a short real timeout exits 1 quickly", async () => {
  const app = await manualApp(() => [202, {}], { interval: 0.05 });
  const dir = makeProject();
  const started = Date.now();
  const r = await login(app, dir, ["--no-browser", "--timeout", "0.5"]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /expired before it was approved/);
  assert.ok(Date.now() - started < 5000);
  await app.close();
});

for (const [state, text] of [["denied", "The request was denied in the app."], ["used", "This request was already used. Run `npx zoroval login` again."], ["expired", "The request expired. Run `npx zoroval login` again."], [undefined, "The request expired. Run `npx zoroval login` again."]]) {
  test(`token 410 ${state}: ${text}`, async () => {
    const app = await manualApp(() => [410, state ? { status: state } : {}]);
    const dir = makeProject();
    const r = await login(app, dir, ["--no-browser"]);
    assert.equal(r.code, 1);
    assert.ok(r.stdout.includes(text), r.stdout);
    assert.equal(existsSync(join(dir, ".env")), false);
    await app.close();
  });
}

test("a key in an unknown format is never written", async () => {
  const app = await manualApp(() => [200, keyReply({ key: "not-a-key" })]);
  const dir = makeProject();
  const r = await login(app, dir, ["--no-browser"]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /The server returned a key in an unknown format; nothing was written\./);
  assert.equal(existsSync(join(dir, ".env")), false);
  await app.close();
});

test("a non-default ingest URL is written too; the default one is not", async () => {
  const app = await manualApp(() => [200, keyReply({ ingest_url: "https://ingest.example.test/" })]);
  const dir = makeProject();
  const r = await login(app, dir, ["--no-browser"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /ZOROVAL_INGEST_URL was written too \(https:\/\/ingest\.example\.test\/\)\./);
  assert.match(read(dir, ".env"), /ZOROVAL_INGEST_URL=https:\/\/ingest\.example\.test\/\n/);
  await app.close();
  const app2 = await manualApp(() => [200, keyReply({ ingest_url: "https://ingest.zoroval.com/" })]);
  const dir2 = makeProject();
  await login(app2, dir2, ["--no-browser"]);
  assert.doesNotMatch(read(dir2, ".env"), /ZOROVAL_INGEST_URL/);
  await app2.close();
});

test("the env file is written with the marker, the key and existing lines kept", async () => {
  const app = await manualApp();
  const dir = makeProject({ files: { ".env": "A=1\nB=2" } });
  const r = await login(app, dir, ["--no-browser"]);
  assert.equal(r.code, 0);
  assert.equal(read(dir, ".env"), `A=1\nB=2\n# Added by \`zoroval login\`. Remove with \`zoroval logout\`.\nZOROVAL_INGEST_KEY=${KEY}\n`);
  await app.close();
});

// ------------------------------------------------------------------ env file checks

async function refusedBefore(dir, extra, pattern) {
  const app = await manualApp();
  const r = await login(app, dir, ["--no-browser", ...extra]);
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stdout, pattern);
  assert.ok(!app.paths().includes("/api/agent-connect"), "nothing asked of the user before the file is checked");
  await app.close();
}

test("env file: tracked by git is refused before sign-in", async () => {
  const dir = makeProject({ files: { ".env": "A=1\n" } });
  execFileSync("git", ["add", "-f", ".env"], { cwd: dir });
  await refusedBefore(dir, [], /Cannot write the key to \.env: \.env is tracked by git; a key must never be committed\./);
});

test("env file: not git-ignored is refused", async () => {
  const dir = makeProject({ ignore: ["other"] });
  await refusedBefore(dir, [], /Cannot write the key to \.env: \.env is not git-ignored; add it to \.gitignore first\./);
});

test("env file: a symlink is refused", async () => {
  const dir = makeProject();
  writeFileSync(join(dir, "real.txt"), "");
  symlinkSync(join(dir, "real.txt"), join(dir, ".env"));
  await refusedBefore(dir, [], /\.env is a symlink; write the key to a regular file\./);
});

test("env file: outside the project and a missing folder are refused", async () => {
  const dir = makeProject();
  const other = makeProject();
  await refusedBefore(dir, ["--file", join(other, ".env")], /is outside the project folder/);
  await refusedBefore(dir, ["--file", "nope/.env"], /folder .*nope does not exist/);
  mkdirSync(join(dir, "sub"));
  symlinkSync(other, join(dir, "link"));
  await refusedBefore(dir, ["--file", "link/.env"], /is outside the project folder/);
});

test("a --root that does not exist is refused in words, not with a stack trace", async () => {
  const app = await manualApp();
  const dir = makeProject();
  const r = await runCli(["login", "--root", join(dir, "missing"), "--app-url", app.url, "--no-browser"], { cwd: dir });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /Cannot write the key to \.env: folder .*missing does not exist\./);
  assert.equal(r.stderr, "");
  assert.ok(!app.paths().includes("/api/agent-connect"));
  await app.close();
});

test("env file: not a git repository is refused, --allow-no-git allows it", async () => {
  const dir = makeProject({ git: false });
  await refusedBefore(dir, [], /not inside a git repository, so the file cannot be shown to be git-ignored; use --allow-no-git if this folder is never committed\./);
  const app = await manualApp();
  const r = await login(app, dir, ["--no-browser", "--allow-no-git"]);
  assert.equal(r.code, 0, r.stdout);
  assert.ok(read(dir, ".env").includes(KEY));
  await app.close();
});

test("a key already set: nothing to do, unless --replace", async () => {
  const dir = makeProject({ files: { ".env": "ZOROVAL_INGEST_KEY=old\n" } });
  const app = await manualApp();
  let r = await login(app, dir, ["--no-browser"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /ZOROVAL_INGEST_KEY is already in \.env\. Nothing to do \(use --replace for a new key\)\./);
  assert.ok(!app.paths().includes("/api/agent-connect"));
  r = await login(app, dir, ["--no-browser", "--replace"]);
  assert.equal(r.code, 0, r.stdout);
  const text = read(dir, ".env");
  assert.ok(text.includes(KEY) && !text.includes("old"));
  assert.equal(text.match(/ZOROVAL_INGEST_KEY=/g).length, 1);
  r = await runCli(["login", "--root", dir, "--app-url", app.url, "--no-browser"], { cwd: dir, env: { ZOROVAL_INGEST_KEY: "x" } });
  assert.match(r.stdout, /ZOROVAL_INGEST_KEY is already set in the environment\./);
  await app.close();
});

test("the file is checked again after the wait: a file that became tracked is not written, key id reported", async () => {
  const app = await manualApp((_b, i) => {
    if (i === 0) execFileSync("git", ["add", "-f", ".env"], { cwd: dir });
    return [200, keyReply()];
  });
  const dir = makeProject({ files: { ".env": "A=1\n" } });
  const r = await login(app, dir, ["--no-browser"]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /Nothing was written; revoke key abcdefghijkl in the app\./);
  assert.equal(read(dir, ".env"), "A=1\n");
  await app.close();
});

// ------------------------------------------------------------------ which env file

const NEXT_MESSAGE = /`next dev` reads \.env\.local on its own\. For production, make a key for production and add ZOROVAL_INGEST_KEY to the Vercel project's environment variables\./;
const WORKER_MESSAGE = /`wrangler dev` reads \.dev\.vars on its own\. For production, make a key for production and run `wrangler secret put ZOROVAL_INGEST_KEY`\./;

for (const [label, files, expected, message] of [
  ["wrangler.toml", { "wrangler.toml": 'name = "w"\nmain = "src/index.ts"\n' }, ".dev.vars", WORKER_MESSAGE],
  ["wrangler.json", { "wrangler.json": '{"name":"w"}' }, ".dev.vars", WORKER_MESSAGE],
  ["wrangler.jsonc", { "wrangler.jsonc": '{\n // c\n "name": "w",\n}' }, ".dev.vars", WORKER_MESSAGE],
  ["Next.js (package.json)", { "package.json": '{"dependencies":{"next":"15.0.0"}}' }, ".env.local", NEXT_MESSAGE],
  ["Next.js (next.config.mjs)", { "next.config.mjs": "export default {}" }, ".env.local", NEXT_MESSAGE],
  ["Worker and Next.js (the Worker wins)", { "wrangler.toml": 'name = "w"', "package.json": '{"dependencies":{"next":"15"}}' }, ".dev.vars", WORKER_MESSAGE],
  ["a plain Node project", { "package.json": '{"dependencies":{"express":"4"}}' }, ".env", /node --env-file=\.env.*dotenv.*npx zoroval doctor/],
  ["no package.json at all", {}, ".env", /dotenv/],
]) {
  test(`default env file for ${label} is ${expected}`, async () => {
    const app = await manualApp();
    const dir = makeProject({ files });
    const r = await login(app, dir, ["--no-browser"]);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, new RegExp(`Key written to ${expected.replace(".", "\\.")} as`));
    assert.ok(read(dir, expected).includes(KEY));
    assert.match(r.stdout, message);
    for (const other of [".env", ".env.local", ".dev.vars"].filter((n) => n !== expected)) assert.equal(existsSync(join(dir, other)), false);
    await app.close();
  });
}

test("--env-file overrides the project type", async () => {
  const app = await manualApp();
  const dir = makeProject({ files: { "wrangler.toml": 'name = "w"' } });
  const r = await login(app, dir, ["--no-browser", "--file", ".env"]);
  assert.equal(r.code, 0);
  assert.ok(read(dir, ".env").includes(KEY));
  assert.equal(existsSync(join(dir, ".dev.vars")), false);
  assert.match(r.stdout, WORKER_MESSAGE); // the production step still follows the project type
  await app.close();
});

// ------------------------------------------------------------------ logout

test("logout removes the lines login wrote, from the same default file, and says to revoke the key", async () => {
  const dir = makeProject({ files: { "wrangler.toml": 'name = "w"', ".dev.vars": `A=1\n# Added by \`zoroval login\`. Remove with \`zoroval logout\`.\nZOROVAL_INGEST_KEY=${KEY}\nZOROVAL_INGEST_URL=https://x.test\n` } });
  const r = await runCli(["logout", "--root", dir], { cwd: dir });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "Removed ZOROVAL_INGEST_KEY, ZOROVAL_INGEST_URL from .dev.vars. If key abcdefghijkl is no longer used, revoke it in the app.\n");
  assert.equal(read(dir, ".dev.vars"), "A=1\n");
  assert.ok(!r.stdout.includes(KEY));
});

test("logout deletes a file that held only Zoroval lines; with no Zoroval lines it changes nothing", async () => {
  const dir = makeProject({ files: { ".env": `# Added by \`zoroval login\`. Remove with \`zoroval logout\`.\nZOROVAL_INGEST_KEY=${KEY}\n`, ".env.local": "A=1\n" } });
  let r = await runCli(["logout", "--root", dir, "--env-file", ".env"], { cwd: dir });
  assert.equal(r.code, 0);
  assert.equal(existsSync(join(dir, ".env")), false);
  r = await runCli(["logout", "--root", dir, "--env-file", ".env.local"], { cwd: dir });
  assert.equal(r.stdout, "No Zoroval lines in .env.local.\n");
  assert.equal(read(dir, ".env.local"), "A=1\n");
  r = await runCli(["logout", "--root", dir, "--file", "missing"], { cwd: dir });
  assert.equal(r.stdout, "No Zoroval lines in missing.\n");
});

test("login then logout leaves the file as it was", async () => {
  const app = await manualApp();
  const dir = makeProject({ files: { ".env": "A=1\nB=2\n" } });
  await login(app, dir, ["--no-browser"]);
  const r = await runCli(["logout", "--root", dir], { cwd: dir });
  assert.equal(r.code, 0);
  assert.equal(read(dir, ".env"), "A=1\nB=2\n");
  await app.close();
});

// ------------------------------------------------------------------ setup progress errors are swallowed

for (const status of [404, 410, 429, 500]) {
  test(`progress error ${status} is swallowed: no output, same result`, async () => {
    const app = await startApp({
      "/api/agent-setup/progress": [status, { message: "nope" }],
      "/api/agent-connect": [200, connectReply({ approved: true, handle: "#ZVtree", project_name: "Shop bot" })],
      "/api/agent-connect/token": [200, keyReply()],
    });
    const dir = makeProject();
    const r = await runCli(["login", "--root", dir, "--app-url", app.url], { cwd: dir, env: { ZOROVAL_SETUP: SETUP_CODE } });
    assert.equal(r.code, 0);
    assert.equal(r.stderr, "");
    assert.doesNotMatch(r.stdout, /nope|404|410|429|500/);
    assert.ok(read(dir, ".env").includes(KEY));
    await app.close();
  });
}

test("progress with no network at all is swallowed", async () => {
  const dir = makeProject({ files: { "package.json": '{"dependencies":{"openai":"4"}}' } });
  const r = await runCli(["detect", dir, "--json"], { cwd: dir, env: { ZOROVAL_SETUP: SETUP_CODE, ZOROVAL_APP_URL: "http://127.0.0.1:9" } });
  assert.equal(r.code, 0);
  assert.equal(r.stderr, "");
});

test("a progress request that hangs is cut off after about 2 seconds", async () => {
  const app = await startApp({ "/api/agent-setup/progress": ["hang", {}] });
  const dir = makeProject();
  const started = Date.now();
  const r = await runCli(["detect", dir, "--json"], { cwd: dir, env: { ZOROVAL_SETUP: SETUP_CODE, ZOROVAL_APP_URL: app.url } });
  const took = Date.now() - started;
  assert.equal(r.code, 0);
  // `started` and `detected`, 2 s each at most
  assert.ok(took >= 1800 && took < 8000, `took ${took} ms`);
  await app.close();
});

test("progress sends no paths and no values", async () => {
  const app = await startApp({ "/api/agent-setup/progress": [202, { status: "ok" }] });
  const dir = makeProject({ files: { "package.json": '{"dependencies":{"openai":"4"}}', ".env": "SECRET_TOKEN=hunter2hunter2\n" } });
  await runCli(["detect", dir], { cwd: dir, env: { ZOROVAL_SETUP: SETUP_CODE, ZOROVAL_APP_URL: app.url } });
  const sent = JSON.stringify(app.calls.map((c) => c.body));
  assert.ok(!sent.includes(dir) && !sent.includes("hunter2"));
  assert.deepEqual(app.events(), ["started", "detected"]);
  await app.close();
});

// ------------------------------------------------------------------ command line

test("usage errors exit 2 with usage on stderr and nothing on stdout", async () => {
  for (const [args, message] of [
    [[], /the following arguments are required: command/],
    [["nope"], /invalid choice: 'nope' \(choose from 'detect', 'login', 'logout', 'doctor'\)/],
    [["login", "--nope"], /unrecognized arguments: --nope/],
    [["login", "--root"], /argument --root: expected one argument/],
    [["login", "--timeout", "abc"], /argument --timeout: invalid float value: 'abc'/],
    [["doctor", "--wait", "x"], /argument --wait: invalid float value/],
    [["logout", "extra"], /unrecognized arguments: extra/],
  ]) {
    const r = await runCli(args);
    assert.equal(r.code, 2, args.join(" "));
    assert.match(r.stderr, /^usage: zoroval/);
    assert.match(r.stderr, message);
    assert.equal(r.stdout, "");
  }
});

test("--version, --help and option prefixes", async () => {
  let r = await runCli(["--version"]);
  assert.equal(r.stdout, "zoroval 0.1.0\n");
  assert.equal(r.code, 0);
  r = await runCli(["--help"]);
  assert.match(r.stdout, /usage: zoroval \[-h\] \[--version\] \{detect,login,logout,doctor\} \.\.\./);
  assert.equal(r.code, 0);
  r = await runCli(["login", "--help"]);
  assert.match(r.stdout, /--allow-no-git/);
  assert.match(r.stdout, /\.dev\.vars for a Cloudflare Worker/);
  const dir = makeProject();
  r = await runCli(["logout", "--ro", dir, "--env=.env"], { cwd: dir });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "No Zoroval lines in .env.\n");
});

test("detect of something that is not a folder exits 2 on stderr", async () => {
  const r = await runCli(["detect", "/nonexistent-zoroval-dir"]);
  assert.equal(r.code, 2);
  assert.equal(r.stderr, "zoroval detect: /nonexistent-zoroval-dir is not a folder\n");
});
