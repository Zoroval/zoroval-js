/**
 * `zoroval login`: the device flow. Writes the key to a git-ignored env file.
 *
 * The key is never printed, logged or written to a tracked file. The device code is never written to
 * disk. Same steps, texts and exit codes as the Python CLI; the differences are the default env file
 * (by project type) and the closing "Next" line (the production step for that platform).
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { DEFAULT_INGEST_URL, keyIdOf } from "../config.js";
import * as envfile from "./envfile.js";
import { postJson } from "./http.js";
import type { Json } from "./http.js";
import { projectKind } from "./project.js";
import type { ProjectKind } from "./project.js";
import * as setupReport from "./setup-report.js";

const SLOW_DOWN_STEP_S = 5; // RFC 8628: add 5 seconds after slow_down
const MIN_INTERVAL_S = 0.05;

export const CMD = "npx zoroval";

/** What a test can replace: the screen, the browser, the clock. */
export interface Deps {
  say(message: string): void;
  openBrowser(url: string): void;
  isTTY: boolean;
  ci: boolean;
  sleep(ms: number): Promise<void>;
  now(): number; // monotonic milliseconds
}

export function defaultDeps(): Deps {
  return {
    say: (message) => console.log(message),
    openBrowser,
    isTTY: Boolean(process.stdout.isTTY),
    ci: Boolean(process.env.CI),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    now: () => performance.now(),
  };
}

/** Open a link in the default browser. Only web links, and a failure is silent (the link is printed anyway). */
export function openBrowser(url: string): void {
  try {
    const protocol = new URL(url).protocol;
    if (protocol !== "https:" && protocol !== "http:") return;
    const [command, args]: [string, string[]] =
      process.platform === "darwin" ? ["open", [url]]
      : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : ["xdg-open", [url]];
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* the link is printed; the person can open it */
  }
}

/** Python's `str(None)` for a value the server may leave out. */
function show(value: unknown): string {
  return value === undefined || value === null ? "None" : String(value);
}

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** The closing line: how the key reaches the running app, and the production step for the platform. */
export function nextMessage(kind: ProjectKind): string {
  if (kind === "worker") {
    return `Next: run \`${CMD} doctor\`. \`wrangler dev\` reads .dev.vars on its own. For production, make a key for production and run \`wrangler secret put ${envfile.KEY_VAR}\`.`;
  }
  if (kind === "next") {
    return `Next: run \`${CMD} doctor\`. \`next dev\` reads .env.local on its own. For production, make a key for production and add ${envfile.KEY_VAR} to the Vercel project's environment variables.`;
  }
  return `Next: load the env file in your app (for example \`node --env-file=.env\` on Node 20.6 or newer, or dotenv) and run \`${CMD} doctor\`.`;
}

export interface LoginOptions {
  root: string;
  envFile: string;
  name?: string;
  appUrl: string;
  noBrowser: boolean;
  replace: boolean;
  allowNoGit: boolean;
  timeoutS: number;
}

export async function run(o: LoginOptions, deps: Deps = defaultDeps()): Promise<number> {
  const say = deps.say;
  const envPath = envfile.resolveEnvPath(o.root, o.envFile);
  const envName = basename(envPath);
  await setupReport.started(o.appUrl);
  // 1. Already set? Report presence only.
  if (!o.replace) {
    if (process.env[envfile.KEY_VAR]) {
      say(`${envfile.KEY_VAR} is already set in the environment. Nothing to do (use --replace for a new key).`);
      return 0;
    }
    if (existsSync(envPath) && envfile.readNames(envPath).includes(envfile.KEY_VAR)) {
      say(`${envfile.KEY_VAR} is already in ${envName}. Nothing to do (use --replace for a new key).`);
      return 0;
    }
  }
  // 2. Check the file before asking anyone to approve anything.
  let verdict = envfile.check(envPath, o.root, o.allowNoGit);
  if (!verdict.ok) {
    say(`Cannot write the key to ${envName}: ${verdict.reason}.`);
    return 1;
  }
  // 3. Start the device flow.
  const clientName = Array.from(o.name || `${basename(resolve(o.root))} (agent)`).slice(0, 120).join("");
  const code = setupReport.setupCode();
  const payload: Json = { name: clientName };
  if (code) payload.setup_code = code;
  const base = o.appUrl.replace(/\/+$/, "");
  let [status, body] = await postJson(base + "/api/agent-connect", payload);
  if (code && status >= 400 && status < 500) {
    const message = body.message || body.error || body.detail;
    say(
      typeof message === "string" && message
        ? message
        : "The setup code was not accepted. Ask the developer to copy a fresh prompt from Zoroval.",
    );
    return 1;
  }
  if (status !== 200 || !("device_code" in body)) {
    say(`Could not start sign-in at ${o.appUrl} (status ${status || "no connection"}).`);
    return 1;
  }
  const deviceCode = body.device_code;
  let intervalS = Math.max(Number(body.interval) || 3, MIN_INTERVAL_S);
  const expiresAt = deps.now() + Math.min(Number(body.expires_in) || 600, o.timeoutS) * 1000;
  const approved = body.approved === true;
  const handle = text(body.handle);
  const projectName = text(body.project_name);
  if (!approved) {
    const link = body.verification_uri_complete || body.verification_uri;
    say(`Open this link and approve the request named "${clientName}":\n  ${show(link)}\nCheck that the page shows the code ${show(body.user_code)}.`);
    if (!o.noBrowser && deps.isTTY && !deps.ci && typeof link === "string") deps.openBrowser(link);
  }
  // 4. Poll.
  const tokenUrl = base + "/api/agent-connect/token";
  let firstPoll = approved; // an approved request has its key ready: no wait before the first poll
  for (;;) {
    if (deps.now() >= expiresAt) {
      say(`The request expired before it was approved. Run \`${CMD} login\` again.`);
      return 1;
    }
    if (!firstPoll) await deps.sleep(intervalS * 1000);
    firstPoll = false;
    [status, body] = await postJson(tokenUrl, { device_code: deviceCode });
    if (status === 202) continue;
    if (status === 429) {
      intervalS += SLOW_DOWN_STEP_S;
      continue;
    }
    if (status === 410) {
      const state = body.status ?? "expired";
      say(
        state === "denied" ? "The request was denied in the app."
        : state === "used" ? `This request was already used. Run \`${CMD} login\` again.`
        : `The request expired. Run \`${CMD} login\` again.`,
      );
      return 1;
    }
    if (status === 200 && body.key) break;
    // 5xx, connection errors: wait and try again.
  }
  const key = String(body.key);
  if (keyIdOf(key) === null) {
    say("The server returned a key in an unknown format; nothing was written.");
    return 1;
  }
  const ingestUrl = text(body.ingest_url);
  const writeUrl = ingestUrl && ingestUrl.replace(/\/+$/, "") !== DEFAULT_INGEST_URL ? ingestUrl : null;
  // 5. Re-check (the file could have changed while we waited), then write.
  verdict = envfile.check(envPath, o.root, o.allowNoGit);
  if (!verdict.ok) {
    say(`Cannot write the key to ${envName}: ${verdict.reason}. Nothing was written; revoke key ${show(body.key_id)} in the app.`);
    return 1;
  }
  try {
    envfile.writeKey(envPath, key, writeUrl, o.replace);
  } catch (error) {
    if (error instanceof envfile.KeyAlreadySet) {
      say(`${error.message}. Nothing was written; revoke key ${show(body.key_id)} in the app.`);
      return 1;
    }
    throw error;
  }
  say(`Key written to ${envName} as ${envfile.KEY_VAR} (key id ${show(body.key_id)}, project ${show(body.project_key)}). The key is not shown. File mode is 600.`);
  if (approved) say(`${handle || "Setup code"} connected to ${projectName || text(body.project_name) || show(body.project_key)}`);
  if (writeUrl) say(`${envfile.URL_VAR} was written too (${writeUrl}).`);
  say(nextMessage(projectKind(o.root)));
  return 0;
}

export function logout(o: { root: string; envFile: string }, deps: Deps = defaultDeps()): number {
  const envPath = envfile.resolveEnvPath(o.root, o.envFile);
  const key = existsSync(envPath) ? envfile.readValue(envPath, envfile.KEY_VAR) : null;
  const removed = envfile.removeKey(envPath);
  if (!removed.length) {
    deps.say(`No Zoroval lines in ${basename(envPath)}.`);
    return 0;
  }
  const keyId = keyIdOf(key);
  deps.say(`Removed ${removed.join(", ")} from ${basename(envPath)}.` + (keyId ? ` If key ${keyId} is no longer used, revoke it in the app.` : ""));
  return 0;
}
