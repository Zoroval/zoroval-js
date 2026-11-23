/**
 * What kind of project is this folder? Decides the default env file (the one TypeScript difference
 * from the Python CLI) and the closing "Next" message. Reads `wrangler.toml|json|jsonc` and
 * `package.json` only; never an env value.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseToml } from "./toml.js";

const WRANGLER_FILES = ["wrangler.toml", "wrangler.json", "wrangler.jsonc"];
const NEXT_CONFIGS = ["next.config.js", "next.config.mjs", "next.config.cjs", "next.config.ts", "next.config.mts"];
export const ALS_FLAGS = ["nodejs_als", "nodejs_compat"];

export interface Wrangler {
  /** File name, e.g. `wrangler.toml`. */
  file: string;
  main: string | null;
  flags: string[];
  /** `nodejs_als` or `nodejs_compat` is set: turns can be grouped into conversations. */
  als: boolean;
}

/** `//` and `/* *\/` comments and trailing commas out of JSONC, leaving strings alone. */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/,(\s*[\]}])/g, "$1");
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function wranglerFrom(file: string, data: Record<string, unknown>): Wrangler {
  // Environments may carry their own flags; any of them counts (this is advice, not a gate).
  const flags = stringList(data.compatibility_flags);
  const envs = data.env && typeof data.env === "object" ? Object.values(data.env as Record<string, unknown>) : [];
  for (const env of envs) {
    if (env && typeof env === "object") flags.push(...stringList((env as Record<string, unknown>).compatibility_flags));
  }
  const unique = [...new Set(flags)];
  return {
    file,
    main: typeof data.main === "string" ? data.main : null,
    flags: unique,
    als: unique.some((f) => ALS_FLAGS.includes(f)),
  };
}

/** The Worker's Wrangler config in `root`, or null. A file that cannot be read still counts as a Worker. */
export function findWrangler(root: string): Wrangler | null {
  for (const file of WRANGLER_FILES) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return { file, main: null, flags: [], als: false };
    }
    let data: Record<string, unknown> | null = null;
    try {
      data = file.endsWith(".toml") ? (parseToml(text) as Record<string, unknown> | null) : JSON.parse(stripJsonc(text));
    } catch {
      data = null;
    }
    return data && typeof data === "object" ? wranglerFrom(file, data) : { file, main: null, flags: [], als: false };
  }
  return null;
}

function packageDeps(root: string): Record<string, string> {
  try {
    const data = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    return { ...data.dependencies, ...data.devDependencies, ...data.peerDependencies };
  } catch {
    return {};
  }
}

export function isNext(root: string): boolean {
  return "next" in packageDeps(root) || NEXT_CONFIGS.some((f) => existsSync(join(root, f)));
}
