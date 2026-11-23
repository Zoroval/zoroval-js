/** The `zoroval` command: detect, login, logout, doctor. Same commands, flags, exit codes and output as the Python CLI. */

import { statSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_APP_URL } from "./constants.js";
import { EarlyExit, UsageError, parseArgs } from "./args.js";
import type { CommandSpec, Values } from "./args.js";
import { VERSION } from "../version.js";
import * as detect from "./detect.js";
import * as doctor from "./doctor.js";
import { pyJson } from "./pyjson.js";
import * as login from "./login.js";
import { defaultEnvFile } from "./project.js";
import * as setupReport from "./setup-report.js";

// Node 20.6+ reads `--env-file` itself, even after the script name, and exits 9 when that file does not
// exist yet (the usual case for `login`). `--file` means the same and Node leaves it alone.
const FILE_NOTE = "--file is the same flag; use it on Node 20.6 or newer when the file does not exist yet.";
const ENV_DEFAULT_HELP = ".dev.vars for a Cloudflare Worker, .env.local for Next.js, otherwise .env";

export const COMMANDS: CommandSpec[] = [
  {
    name: "detect",
    help: "report what this repo uses (JSON with --json); never prints secrets",
    positional: { dest: "path", default: ".", metavar: "path" },
    options: [{ flags: ["--json"], dest: "json", switch: true, help: "print the report as JSON" }],
  },
  {
    name: "login",
    help: "sign in through the browser and write the ingest key to an env file",
    options: [
      { flags: ["--root"], dest: "root", default: ".", help: "project folder (default: current folder)" },
      { flags: ["--env-file", "--file"], dest: "envFile", help: `git-ignored env file for the key (default: ${ENV_DEFAULT_HELP}). ${FILE_NOTE}` },
      { flags: ["--name"], dest: "name", help: "name shown on the approve page (default: '<folder> (agent)')" },
      { flags: ["--app-url"], dest: "appUrl", help: "default: ZOROVAL_APP_URL or https://app.zoroval.com" },
      { flags: ["--no-browser"], dest: "noBrowser", switch: true, help: "print the link only" },
      { flags: ["--replace"], dest: "replace", switch: true, help: "replace a key that is already set" },
      { flags: ["--allow-no-git"], dest: "allowNoGit", switch: true, help: "allow a folder that is not a git repository" },
      { flags: ["--timeout"], dest: "timeout", default: "600", help: "seconds to wait for approval (default 600)" },
    ],
  },
  {
    name: "logout",
    help: "remove the lines `zoroval login` wrote (does not revoke the key)",
    options: [
      { flags: ["--root"], dest: "root", default: ".", help: "project folder (default: current folder)" },
      { flags: ["--env-file", "--file"], dest: "envFile", help: `env file login wrote to (default: ${ENV_DEFAULT_HELP})` },
    ],
  },
  {
    name: "doctor",
    help: "send a test trace and check the setup",
    options: [
      { flags: ["--root"], dest: "root", default: ".", help: "project folder (default: current folder)" },
      { flags: ["--env-file", "--file"], dest: "envFile", help: "env file with the key (default: the project's usual env files)" },
      { flags: ["--ingest-url"], dest: "ingestUrl", help: "default: ZOROVAL_INGEST_URL or https://ingest.zoroval.com" },
      { flags: ["--timeout"], dest: "timeout", default: "30", help: "seconds to wait for the test batch (default 30)" },
      { flags: ["--wait"], dest: "wait", default: "0", help: "seconds to wait for the first app trace (default 0)" },
      { flags: ["--no-test-trace"], dest: "noTestTrace", switch: true, help: "only read status" },
      { flags: ["--json"], dest: "json", switch: true, help: "print the checks as JSON" },
    ],
  },
];

/** A number option, like argparse's `type=float`: a bad value is a usage error. */
function seconds(values: Values, dest: string, flag: string, command: string): number {
  const raw = String(values[dest]).trim();
  const value = Number(raw);
  if (raw === "" || !Number.isFinite(value)) {
    throw new UsageError(`argument ${flag}: invalid float value: '${values[dest]}'`, `usage: zoroval ${command} [-h] ...`);
  }
  return value;
}

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs(argv, COMMANDS, VERSION);
  } catch (error) {
    if (error instanceof EarlyExit) {
      process.stdout.write(error.stdout);
      return error.code;
    }
    if (error instanceof UsageError) {
      process.stderr.write(`${error.usage}\nzoroval: error: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
  const { command, values: v } = parsed;
  try {
    if (command === "detect") {
      const root = String(v.path || ".");
      if (!isFolder(root)) {
        process.stderr.write(`zoroval detect: ${root} is not a folder\n`);
        return 2;
      }
      const report = detect.scan(root);
      await setupReport.detected(report);
      if (v.json) console.log(pyJson(report));
      else for (const line of detect.textReport(report)) console.log(line);
      return 0;
    }
    const root = String(v.root || ".");
    const envFile = typeof v.envFile === "string" ? v.envFile : defaultEnvFile(resolve(root));
    if (command === "login") {
      return await login.run({
        root,
        envFile,
        name: typeof v.name === "string" ? v.name : undefined,
        appUrl: String(v.appUrl || process.env.ZOROVAL_APP_URL || DEFAULT_APP_URL),
        noBrowser: Boolean(v.noBrowser),
        replace: Boolean(v.replace),
        allowNoGit: Boolean(v.allowNoGit),
        timeoutS: seconds(v, "timeout", "--timeout", "login"),
      });
    }
    if (command === "logout") return login.logout({ root, envFile });
    // doctor
    const timeoutS = seconds(v, "timeout", "--timeout", "doctor");
    const waitS = seconds(v, "wait", "--wait", "doctor");
    await doctor.startedReport();
    const report = await doctor.run({
      root,
      envFile: typeof v.envFile === "string" ? v.envFile : null,
      ingestUrl: typeof v.ingestUrl === "string" ? v.ingestUrl : undefined,
      timeoutS,
      waitS,
      skipTestTrace: Boolean(v.noTestTrace),
    });
    if (v.json) console.log(pyJson({ ok: report.ok, checks: report.checks }));
    else for (const line of doctor.formatReport(report)) console.log(line);
    return report.ok ? 0 : 1;
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.usage}\nzoroval: error: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
}

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
