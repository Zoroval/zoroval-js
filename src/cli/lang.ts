/**
 * Which SDK and which env file this project needs. The language follows where the model is called
 * (see `analyze` in detect.ts), not which config files exist: a Python app behind a forwarding
 * Cloudflare Worker is a Python project, and its key lives in `.env`.
 */

import { analyze } from "./detect.js";
import type { Lang } from "./detect.js";
import { defaultEnvFile, projectKind } from "./project.js";
import type { Wrangler } from "./project.js";

export type Kind = "python" | "worker" | "next" | "node";

export interface Project {
  lang: Lang;
  kind: Kind;
  envFile: string;
  worker: Wrangler | null;
  workerRelevant: boolean;
}

export function projectInfo(root: string): Project {
  const { info } = analyze(root);
  if (info.lang === "python") return { lang: info.lang, kind: "python", envFile: ".env", worker: info.worker, workerRelevant: false };
  return { lang: info.lang, kind: projectKind(root), envFile: defaultEnvFile(root), worker: info.worker, workerRelevant: info.workerRelevant };
}

/** Env files `doctor` looks in when `--env-file` is not given: the project's own first. */
export function envFileCandidates(root: string): string[] {
  return [...new Set([projectInfo(root).envFile, ".dev.vars", ".env.local", ".env"])];
}
