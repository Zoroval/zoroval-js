/**
 * Writing the ingest key into an env file, under the same checks as the Python CLI: the file must be
 * inside the project, not a symlink, not tracked by git, and git-ignored. The key is written with
 * mode 600 and never printed.
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync, closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, statSync,
  unlinkSync, writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export const KEY_VAR = "ZOROVAL_INGEST_KEY";
export const URL_VAR = "ZOROVAL_INGEST_URL";
const MANAGED = [KEY_VAR, URL_VAR];
export const MARKER = "# Added by `zoroval login`. Remove with `zoroval logout`.";

export interface Check {
  ok: boolean;
  reason: string;
  gitRoot?: string;
}

function git(args: string[], cwd: string): { code: number; stdout: string } {
  try {
    const stdout = execFileSync("git", args, { cwd, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] });
    return { code: 0, stdout };
  } catch (error) {
    const status = (error as { status?: number | null }).status;
    return { code: typeof status === "number" ? status : 128, stdout: "" };
  }
}

export function gitRoot(path: string): string | null {
  const out = git(["rev-parse", "--show-toplevel"], path);
  return out.code === 0 && out.stdout.trim() ? out.stdout.trim() : null;
}

export function isTracked(path: string, repo: string): boolean {
  return git(["ls-files", "--error-unmatch", "--", path], repo).code === 0;
}

export function isIgnored(path: string, repo: string): boolean {
  return git(["check-ignore", "-q", "--", path], repo).code === 0;
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Can the key go into `path`? Never reads or prints values. */
export function check(path: string, root: string, allowNoGit = false): Check {
  const realRoot = realpathSync(root);
  const absolute = isAbsolute(path) ? path : join(realRoot, path);
  const parent = dirname(absolute);
  if (!existsSync(parent)) return { ok: false, reason: `folder ${parent} does not exist` };
  const realParent = realpathSync(parent);
  const rel = relative(realRoot, realParent);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return { ok: false, reason: `${absolute} is outside the project folder ${realRoot}` };
  }
  const name = basename(absolute);
  const target = join(realParent, name);
  if (isSymlink(absolute) || isSymlink(target)) {
    return { ok: false, reason: `${name} is a symlink; write the key to a regular file` };
  }
  if (existsSync(target) && !statSync(target).isFile()) return { ok: false, reason: `${name} is not a regular file` };
  const repo = gitRoot(realParent);
  if (repo === null) {
    if (allowNoGit) return { ok: true, reason: "not a git repository (allowed by --allow-no-git)" };
    return {
      ok: false,
      reason:
        "not inside a git repository, so the file cannot be shown to be git-ignored; use --allow-no-git if this folder is never committed",
    };
  }
  if (isTracked(target, repo)) return { ok: false, reason: `${name} is tracked by git; a key must never be committed` };
  if (!isIgnored(target, repo)) return { ok: false, reason: `${name} is not git-ignored; add it to .gitignore first` };
  return { ok: true, reason: "untracked, git-ignored, not a symlink", gitRoot: repo };
}

function lines(text: string): string[] {
  const out = text.split(/\r\n|\r|\n/);
  if (out.length && out[out.length - 1] === "") out.pop();
  return out;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Variable names in an env file. Values are never returned. */
export function readNames(path: string): string[] {
  const text = readText(path);
  if (text === null) return [];
  const names: string[] = [];
  for (const line of lines(text)) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#") || !stripped.includes("=")) continue;
    let name = stripped.slice(0, stripped.indexOf("=")).trim();
    if (name.startsWith("export ")) name = name.slice("export ".length).trim();
    if (name) names.push(name);
  }
  return names;
}

/** One value, for the SDK and doctor to use. Callers must never print it. */
export function readValue(path: string, name: string): string | null {
  const text = readText(path);
  if (text === null) return null;
  for (const line of lines(text)) {
    let stripped = line.trim();
    if (stripped.startsWith("export ")) stripped = stripped.slice("export ".length);
    if (stripped.startsWith(name + "=")) {
      let value = stripped.slice(stripped.indexOf("=") + 1).trim();
      if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
        value = value.slice(1, -1);
      }
      return value;
    }
  }
  return null;
}

/** Temp file in the same folder, mode 600, fsync, then rename: a reader never sees half a file. */
function writeAtomic(path: string, text: string): void {
  const tmp = join(dirname(path), `${basename(path)}.zoroval-tmp-${randomBytes(6).toString("hex")}`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    try {
      writeSync(fd, text, null, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* already gone */
    }
    throw error;
  }
  chmodSync(path, 0o600);
}

function setsManaged(line: string): boolean {
  let bare = line.trim();
  if (bare.startsWith("export ")) bare = bare.slice("export ".length);
  return MANAGED.some((name) => bare.startsWith(name + "="));
}

export class KeyAlreadySet extends Error {}

export function writeKey(path: string, key: string, ingestUrl: string | null, replace = false): void {
  const exists = existsSync(path);
  const existing = exists ? readFileSync(path, "utf8") : "";
  const present = exists ? readNames(path).filter((n) => MANAGED.includes(n)) : [];
  if (present.length && !replace) throw new KeyAlreadySet(`${basename(path)} already sets ${present.join(", ")}; use --replace`);
  const kept = lines(existing).filter((line) => line.trim() !== MARKER && !setsManaged(line));
  let out = kept.join("\n");
  if (out && !out.endsWith("\n")) out += "\n";
  out += MARKER + "\n" + `${KEY_VAR}=${key}\n`;
  if (ingestUrl) out += `${URL_VAR}=${ingestUrl}\n`;
  writeAtomic(path, out);
}

/** Remove what `zoroval login` wrote. Deletes the file if nothing else is left in it. */
export function removeKey(path: string): string[] {
  if (!existsSync(path) || isSymlink(path)) return [];
  const all = lines(readFileSync(path, "utf8"));
  const removed: string[] = [];
  const kept: string[] = [];
  for (const line of all) {
    let bare = line.trim();
    if (bare.startsWith("export ")) bare = bare.slice("export ".length);
    const name = MANAGED.find((n) => bare.startsWith(n + "="));
    if (name) removed.push(name);
    else if (line.trim() !== MARKER) kept.push(line);
  }
  if (!removed.length && kept.length === all.length) return [];
  if (!kept.some((line) => line.trim())) unlinkSync(path);
  else writeAtomic(path, kept.join("\n") + "\n");
  return removed;
}

/** An env file path from a flag, relative to the project folder. */
export function resolveEnvPath(root: string, envFile: string): string {
  return isAbsolute(envFile) ? envFile : resolve(root, envFile);
}
