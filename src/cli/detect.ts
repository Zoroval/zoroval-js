/**
 * `zoroval detect`: what is in this repo, as JSON. Reads names, never secret values.
 *
 * Same report keys, in the same order, as the Python CLI, so the setup guide reads one shape for both
 * languages. It reads dependency files, Python imports and calls, TypeScript and JavaScript code,
 * env file variable names, deploy and CI file names. It maps what it finds to the setup skill's cases
 * and suggests a plan. It never prints an env value.
 *
 * TypeScript additions: `llm_calls`, `chat_id_candidates` and `entry_points` also cover `.ts`, `.tsx`,
 * `.js`, `.mjs` and `.cjs` files; env files include `.dev.vars*`; a Worker adds `typescript.worker` (its
 * compatibility flags and whether turns can be grouped), Next.js adds `typescript.nextjs`; and `plan`
 * is written for TypeScript projects (`wrapOpenAI`, `conversation()`, flushing).
 */

import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import * as envfile from "./envfile.js";
import { scanJs } from "./jsscan.js";
import { findWrangler, isNext } from "./project.js";
import type { Wrangler } from "./project.js";
import { scanPython } from "./pyscan.js";
import { parseToml } from "./toml.js";
import type { TomlTable, TomlValue } from "./toml.js";

const SKIP_DIRS = new Set([
  ".git", "node_modules", ".venv", "venv", "env", "__pycache__", "dist", "build", ".tox", ".mypy_cache", ".pytest_cache",
  "site-packages", ".next", ".idea", ".vscode", ".ruff_cache", ".wrangler", ".vercel",
]);
const MAX_FILES = 3000;
const MAX_BYTES = 1_000_000;
const DEPLOY_FILES = new Set([
  "Dockerfile", "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml", "railway.json", "railway.toml",
  "vercel.json", "fly.toml", "render.yaml", "app.yaml", "Procfile", "netlify.toml", "serverless.yml", "serverless.yaml",
  "template.yaml", "samconfig.toml", "cdk.json", "Chart.yaml",
]);
const SECRETS_HINTS = [
  "aws secretsmanager", "secretsmanager", "vault ", "doppler", "1password", "op run", "infisical", "gcloud secrets",
  "azure keyvault", "sops",
];
const TS_EXT = [".ts", ".tsx", ".js", ".mjs", ".cjs"];

type Json = Record<string, any>;

const norm = (name: string): string => name.replace(/[-_.]+/g, "-").toLowerCase();

const readText = (path: string): string => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};

/** Files in Python's `os.walk` order: a folder's files (sorted), then its sub-folders (sorted). */
function walk(root: string): string[] {
  const out: string[] = [];
  let count = 0;
  const visit = (dir: string): boolean => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return true;
    }
    const dirs: string[] = [];
    const files: string[] = [];
    for (const entry of entries) {
      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          isDir = statSync(join(dir, entry.name)).isDirectory();
        } catch {
          isDir = false;
        }
        if (isDir) {
          // os.walk lists a symlinked folder among the folders but does not enter it
          continue;
        }
      }
      (isDir ? dirs : files).push(entry.name);
    }
    dirs.sort();
    files.sort();
    for (const name of files) {
      count++;
      if (count > MAX_FILES) return false;
      out.push(join(dir, name));
    }
    for (const name of dirs) {
      if (SKIP_DIRS.has(name) || name.endsWith(".egg-info")) continue;
      if (!visit(join(dir, name))) return false;
    }
    return true;
  };
  visit(root);
  return out;
}

const rel = (path: string, root: string): string => {
  const r = relative(root, path);
  return r.startsWith("..") ? path : r.split(sep).join(posix.sep);
};

// ---------------------------------------------------------------------------- manifests

const REQ_LINE = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*([<>=!~]=?\s*[^;#\s]+)?/;

function parseRequirements(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.split("#", 1)[0]!.trim();
    if (!line || line.startsWith("-") || line.startsWith("git+") || line.startsWith("http")) continue;
    const match = REQ_LINE.exec(line);
    if (match) out[norm(match[1]!)] = (match[3] ?? "").replace(/ /g, "");
  }
  return out;
}

const asTable = (value: TomlValue | undefined): TomlTable => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
const asList = (value: TomlValue | undefined): TomlValue[] => (Array.isArray(value) ? value : []);

function parseDependencyList(items: TomlValue[]): Record<string, string> {
  const deps: Record<string, string> = {};
  for (const spec of items) if (typeof spec === "string") Object.assign(deps, parseRequirements(spec));
  return deps;
}

function parsePyproject(text: string): Record<string, string> {
  const data = parseToml(text);
  if (!data) return {};
  const deps: Record<string, string> = {};
  const project = asTable(data.project);
  Object.assign(deps, parseDependencyList(asList(project.dependencies)));
  for (const group of Object.values(asTable(project["optional-dependencies"]))) Object.assign(deps, parseDependencyList(asList(group)));
  for (const group of Object.values(asTable(data["dependency-groups"]))) Object.assign(deps, parseDependencyList(asList(group)));
  const poetry = asTable(asTable(data.tool).poetry);
  const tables = [asTable(poetry.dependencies), ...Object.values(asTable(poetry.group)).map((g) => asTable(asTable(g).dependencies))];
  for (const table of tables) {
    for (const [name, spec] of Object.entries(table)) {
      if (name.toLowerCase() === "python") continue;
      deps[norm(name)] = typeof spec === "string" ? spec : spec && typeof spec === "object" && !Array.isArray(spec) ? String(spec.version ?? "") : "";
    }
  }
  return deps;
}

/** uv.lock and poetry.lock: exact installed versions. */
function parseLock(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/\[\[package\]\]\s*\nname\s*=\s*"([^"]+)"\s*\nversion\s*=\s*"([^"]+)"/g)) out[norm(m[1]!)] = "==" + m[2]!;
  return out;
}

function parsePackageJson(text: string): Record<string, string> {
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  if (!data || typeof data !== "object" || Array.isArray(data)) return out;
  for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
    const group = data[key];
    if (group && typeof group === "object") for (const [name, spec] of Object.entries(group)) out[name] = String(spec);
  }
  return out;
}

const major = (spec: string | null | undefined): number | null => {
  const m = /(\d+)/.exec(spec ?? "");
  return m ? Number(m[1]) : null;
};

const sortKeys = <T>(o: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

// ---------------------------------------------------------------------------- main scan

/** Which SDK the project needs: where the model is called decides, not which config files exist. */
export type Lang = "python" | "typescript" | "both";

export interface ProjectInfo {
  lang: Lang;
  worker: Wrangler | null;
  /** The Worker itself calls a model or uses zoroval, so it needs `nodejs_als` / `nodejs_compat`. */
  workerRelevant: boolean;
  nextProject: boolean;
}

export function scan(rootArg: string): Json {
  return analyze(rootArg).report;
}

export function analyze(rootArg: string): { report: Json; info: ProjectInfo } {
  const root = resolve(rootArg);
  const report: Json = {
    root, services: [], packages: {}, imports: {}, llm_calls: [], tracing: {}, entry_points: [], chat_id_candidates: [],
    servers: {}, serverless: [], env: {}, deploy_files: [], ci_files: [], collector_configs: [], secrets_managers: [],
    typescript: {}, cases: [], explain_only: [], notes: [], plan: [],
  };
  let pyPackages: Record<string, string> = {};
  const jsPackages: Record<string, string> = {};
  const envFiles: string[] = [];
  const devVarsFiles: string[] = [];
  const pyFiles: string[] = [];
  const tsFiles: string[] = [];
  const sigFiles: string[] = []; // the files Python's CLI reads for TypeScript signals
  const hintTexts: string[] = [];

  for (const path of walk(root)) {
    const name = path.slice(path.lastIndexOf(sep) + 1);
    const relPath = rel(path, root);
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      continue;
    }
    if (size > MAX_BYTES) continue;
    if (["pyproject.toml", "setup.py", "setup.cfg", "Pipfile"].includes(name) || (name.startsWith("requirements") && (name.endsWith(".txt") || name.endsWith(".in")))) {
      const text = readText(path);
      const deps = name === "pyproject.toml"
        ? parsePyproject(text)
        : parseRequirements(name.endsWith(".txt") || name.endsWith(".in") ? text : [...text.matchAll(/['"]([A-Za-z][^'"]+)['"]/g)].map((m) => m[1]).join("\n"));
      for (const [k, v] of Object.entries(deps)) if (v || !(k in pyPackages)) pyPackages[k] = v;
      if (name === "pyproject.toml" || name === "setup.py" || name === "requirements.txt") {
        const service = posix.dirname(relPath);
        if (!report.services.some((s: Json) => s.path === service)) report.services.push({ path: service, kind: "python", manifest: relPath });
      }
    } else if (name === "uv.lock" || name === "poetry.lock") {
      Object.assign(pyPackages, parseLock(readText(path)));
    } else if (name === "package.json") {
      Object.assign(jsPackages, parsePackageJson(readText(path)));
      report.services.push({ path: posix.dirname(relPath), kind: "typescript", manifest: relPath });
    } else if (name === ".env" || name.startsWith(".env.") || name.endsWith(".env")) {
      envFiles.push(path);
    } else if (name.startsWith(".dev.vars")) {
      devVarsFiles.push(path);
    } else if (name.endsWith(".py")) {
      pyFiles.push(path);
    } else if (TS_EXT.some((ext) => name.endsWith(ext))) {
      if (!name.endsWith(".cjs")) sigFiles.push(path);
      if (!name.endsWith(".d.ts")) tsFiles.push(path);
    }
    if (DEPLOY_FILES.has(name) || ["k8s/", "kubernetes/", "helm/"].some((p) => relPath.startsWith(p))) {
      report.deploy_files.push(relPath);
      hintTexts.push(readText(path));
    }
    if ([".github/workflows/", ".gitlab-ci", ".circleci/"].some((p) => relPath.startsWith(p)) || name === ".gitlab-ci.yml" || name === "Jenkinsfile") {
      report.ci_files.push(relPath);
      hintTexts.push(readText(path));
    }
    if (/^(otel|otelcol|collector)[-_.]?.*\.(ya?ml)$/.test(name) || name === "otel-collector-config.yaml") {
      const text = readText(path);
      if (text.includes("receivers") && text.includes("exporters")) report.collector_configs.push(relPath);
    }
    if (name === "gunicorn.conf.py" || name === "gunicorn_config.py" || name === "Procfile" || name.endsWith(".sh")) hintTexts.push(readText(path));
  }

  report.packages = { python: sortKeys(pyPackages), typescript: sortKeys(jsPackages) };

  // python code
  const imports: Record<string, string[]> = {};
  for (const path of pyFiles) {
    const relPath = rel(path, root);
    const source = readText(path);
    if (source.includes("\0")) continue; // ast.parse refuses it
    const visitor = scanPython(source);
    for (const module of visitor.imports) {
      const top = module.split(".")[0]!;
      (imports[top] ??= []);
      if (!imports[top]!.includes(relPath)) imports[top]!.push(relPath);
      if (module.startsWith("langfuse.openai") || module.startsWith("langfuse.decorators")) {
        (imports[module.includes("openai") ? "langfuse.openai" : module] ??= []).push(relPath);
      }
    }
    for (const [line, call] of visitor.calls) {
      const [provider, api] = [call.slice(0, call.indexOf(":")), call.slice(call.indexOf(":") + 1)];
      report.llm_calls.push({ file: relPath, line, provider, api });
    }
    for (const [line, signal] of visitor.signals) {
      const colon = signal.indexOf(":");
      const kind = colon < 0 ? signal : signal.slice(0, colon);
      const detail = colon < 0 ? "" : signal.slice(colon + 1);
      if (kind === "web_app" || kind === "lambda_handler") report.entry_points.push({ file: relPath, line, kind: detail || kind });
      else if (kind === "route") (report.routes ??= []).push({ file: relPath, line, function: detail });
      else (report.tracing.code_signals ??= []).push({ file: relPath, line, signal });
    }
    if (visitor.hasMain && !report.entry_points.some((e: Json) => e.file === relPath)) report.entry_points.push({ file: relPath, line: null, kind: "script" });
    const seen = new Set<string>();
    for (const [line, name] of visitor.chatIds) {
      if (!seen.has(`${line}:${name}`)) {
        seen.add(`${line}:${name}`);
        report.chat_id_candidates.push({ file: relPath, line, name });
      }
    }
    hintTexts.push(source.includes("gunicorn") || source.includes("uvicorn") ? source : "");
  }
  report.imports = Object.fromEntries(Object.entries(sortKeys(imports)).map(([k, v]) => [k, [...new Set(v)].sort()]));

  // typescript and javascript
  const tsSignals: Json[] = [];
  const tsScans = new Map<string, ReturnType<typeof scanJs>>();
  for (const path of sigFiles) {
    const text = readText(path);
    const relPath = rel(path, root);
    if (/from\s+['"]ai['"]|require\(['"]ai['"]\)/.test(text)) tsSignals.push({ file: relPath, signal: "vercel_ai_sdk" });
    if (text.includes("registerOTel") || text.includes("@vercel/otel")) tsSignals.push({ file: relPath, signal: "vercel_otel" });
    if (text.includes("experimental_telemetry")) tsSignals.push({ file: relPath, signal: "ai_sdk_telemetry" });
    if (text.includes("NodeSDK") || text.includes("@opentelemetry/")) tsSignals.push({ file: relPath, signal: "otel_js" });
    if (relPath.endsWith("instrumentation.ts") || relPath.endsWith("instrumentation.js")) tsSignals.push({ file: relPath, signal: "next_instrumentation_hook" });
  }
  for (const path of tsFiles) {
    const text = readText(path);
    const relPath = rel(path, root);
    try {
      tsScans.set(relPath, scanJs(text));
    } catch {
      /* a file the scanner cannot read adds nothing */
    }
  }
  report.typescript = { signals: tsSignals };
  const tsOpenAICalls: Json[] = [];
  const tsChatIds: Json[] = [];
  for (const [file, result] of tsScans) {
    for (const [line, api] of result.llmCalls) tsOpenAICalls.push({ file, line, provider: "openai", api });
    for (const [line, name] of result.chatIds) tsChatIds.push({ file, line, name });
  }
  const worker = findWrangler(root);
  const nextProject = isNext(root);
  const usesZoroval = "zoroval" in jsPackages || [...tsScans.values()].some((r) => r.imports.has("zoroval"));
  const pythonCalls = (report.llm_calls as Json[]).length > 0;
  const hasPythonService = (report.services as Json[]).some((s) => s.kind === "python");
  const hasTsService = (report.services as Json[]).some((s) => s.kind === "typescript") || worker !== null;
  const lang: Lang = pythonCalls && tsOpenAICalls.length ? "both"
    : pythonCalls ? "python"
    : tsOpenAICalls.length ? "typescript"
    : hasPythonService && hasTsService ? "both"
    : hasTsService ? "typescript" : "python";
  const includeTs = lang !== "python";
  const workerRelevant = includeTs && worker !== null && (tsOpenAICalls.length > 0 || usesZoroval);
  // A Python-only project gets exactly what the Python CLI prints: no TypeScript scan results at all.
  if (includeTs) {
    report.llm_calls.push(...tsOpenAICalls);
    report.chat_id_candidates.push(...tsChatIds);
    if (worker) {
      report.typescript.worker = { config: worker.file, main: worker.main, compatibility_flags: worker.flags, nodejs_als: worker.als };
    }
    if (nextProject) report.typescript.nextjs = true;
    addTypescriptEntryPoints(report, tsScans, worker);
    addFrameworkEntryPoints(report, tsScans); // last: nothing above depends on it
    envFiles.push(...devVarsFiles);
  }

  // servers and serverless
  const hintText = hintTexts.join("\n");
  const servers: Json = {};
  if (hintText.includes("gunicorn") || "gunicorn" in pyPackages) {
    servers.gunicorn = {
      preload: hintText.includes("--preload") || hintText.includes("preload_app"),
      workers: /(-w|--workers)[ =]\d+|workers\s*=/.test(hintText),
    };
  }
  if (/uvicorn[^\n]*--workers/.test(hintText)) servers.uvicorn_workers = true;
  if ("celery" in pyPackages || "celery" in imports) servers.celery = true;
  report.servers = servers;
  for (const entry of report.entry_points) if (entry.kind === "lambda_handler") report.serverless.push({ kind: "aws_lambda", file: entry.file });
  for (const relPath of report.deploy_files as string[]) {
    const base = posix.basename(relPath);
    if (base.startsWith("serverless.") || base.startsWith("template.yaml") || base.startsWith("samconfig")) report.serverless.push({ kind: "serverless_config", file: relPath });
    if (base === "vercel.json" && pyFiles.length) report.serverless.push({ kind: "vercel_python", file: relPath });
    else if (includeTs && base === "vercel.json" && report.services.some((s: Json) => s.kind === "typescript")) report.serverless.push({ kind: "vercel", file: relPath });
  }
  if (includeTs && worker) report.serverless.push({ kind: "cloudflare_worker", file: worker.file });
  const lowered = hintText.toLowerCase();
  report.secrets_managers = [...new Set(SECRETS_HINTS.filter((h) => lowered.includes(h)).map((h) => h.trim()))].sort();

  // env files: names only
  const envReport: Json[] = [];
  for (const path of envFiles) {
    const info: Json = { path: rel(path, root), symlink: isSymlink(path) };
    const repo = envfile.gitRoot(dirname(path));
    info.tracked = repo !== null ? envfile.isTracked(path, repo) : null;
    info.ignored = repo !== null ? envfile.isIgnored(path, repo) : null;
    info.names = envfile.readNames(path);
    envReport.push(info);
  }
  let keyState = process.env[envfile.KEY_VAR] ? "present" : "absent";
  if (keyState === "absent") {
    for (const info of envReport) {
      if (info.inaccessible) keyState = "inaccessible";
      else if ((info.names ?? []).includes(envfile.KEY_VAR)) {
        keyState = `present in ${info.path}`;
        break;
      }
    }
  }
  const namesInFiles = new Set<string>(envReport.flatMap((info) => info.names ?? []));
  report.env = {
    [envfile.KEY_VAR]: keyState,
    env_files: envReport,
    dotenv_loader: (report.tracing.code_signals ?? []).some((s: Json) => s.signal === "dotenv") || "python-dotenv" in pyPackages || (includeTs && ("dotenv" in jsPackages || "dotenv-cli" in jsPackages)),
    vendor_vars: [...new Set([...namesInFiles, ...Object.keys(process.env)])]
      .filter((n) => ["LANGFUSE_", "LANGSMITH_", "LANGCHAIN_", "OTEL_EXPORTER_OTLP", "TRACELOOP_", "PHOENIX_", "ARIZE_"].some((p) => n.startsWith(p)))
      .sort(),
    repo_is_git: envfile.gitRoot(root) !== null,
  };

  classify(report, pyPackages, jsPackages, imports, includeTs && tsOpenAICalls.length > 0, includeTs, lang, worker, workerRelevant, nextProject);
  return { report, info: { lang, worker, workerRelevant, nextProject } };
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

const NEXT_ROUTE = /(^|\/)app\/(.*\/)?route\.(ts|tsx|js|jsx|mjs|cjs)$/;
const NEXT_PAGES_API = /(^|\/)pages\/api\/.+\.(ts|tsx|js|jsx|mjs|cjs)$/;

/** Entry points of TypeScript apps: the Worker, then Next.js handlers. (Express, Hono and Fastify are added last.) */
function addTypescriptEntryPoints(report: Json, scans: Map<string, ReturnType<typeof scanJs>>, worker: Wrangler | null): void {
  const entries: Json[] = [];
  const known = (file: string) => entries.some((e) => e.file === file) || report.entry_points.some((e: Json) => e.file === file);
  if (worker?.main) {
    const main = posix.normalize(worker.main.split("\\").join("/")).replace(/^\.\//, "");
    entries.push({ file: main, line: scans.get(main)?.workerLine ?? null, kind: "worker" });
  }
  for (const [file, result] of scans) {
    if (result.workerLine !== null && !known(file)) entries.push({ file, line: result.workerLine, kind: "worker" });
  }
  for (const [file, result] of scans) {
    if (known(file)) continue;
    if (NEXT_ROUTE.test(file)) entries.push({ file, line: result.handlerLine, kind: "nextjs_route" });
    else if (NEXT_PAGES_API.test(file)) entries.push({ file, line: result.handlerLine, kind: "nextjs_api" });
  }
  report.entry_points.push(...entries);
}

/** Express, Hono and Fastify servers, after every other entry point. A failure here costs only these entries. */
function addFrameworkEntryPoints(report: Json, scans: Map<string, ReturnType<typeof scanJs>>): void {
  try {
    for (const [file, result] of scans) {
      for (const { kind, line } of result.frameworks) {
        if (!report.entry_points.some((e: Json) => e.file === file)) report.entry_points.push({ file, line, kind });
      }
    }
  } catch {
    /* the rest of the report stands */
  }
}

const has = (packages: Record<string, string>, ...names: string[]): boolean => names.some((n) => norm(n) in packages);

function classify(report: Json, py: Record<string, string>, js: Record<string, string>, imports: Record<string, string[]>, tsOpenAI: boolean, includeTs: boolean, lang: Lang, worker: Wrangler | null, workerRelevant: boolean, nextProject: boolean): void {
  const cases: (number | string)[] = [];
  const explain: (number | string)[] = [];
  const notes: string[] = report.notes;
  const tracing = report.tracing;
  const signals = new Set<string>((tracing.code_signals ?? []).map((s: Json) => String(s.signal).split(":")[0]));

  const usesOpenai = has(py, "openai") || "openai" in imports || (includeTs && "openai" in js) || tsOpenAI;
  const usesAnthropic = has(py, "anthropic") || "anthropic" in imports;
  tracing.openai = usesOpenai;
  tracing.anthropic = usesAnthropic;

  const langfuseSpec = py.langfuse;
  if (langfuseSpec !== undefined || "langfuse" in imports) {
    // Python also asks the installed package for its version when the spec has none; this CLI has no Python.
    const m = major(langfuseSpec ?? "");
    tracing.langfuse = {
      spec: langfuseSpec ?? null, major: m, otel_based: m === null ? null : m >= 3,
      openai_wrapper: "langfuse" in imports && Object.keys(imports).some((k) => k.startsWith("langfuse.openai")),
    };
    if (m === null) {
      notes.push("Langfuse version unknown: pin it or check `pip show langfuse` (v3+ is OTel based).");
      cases.push(2);
    } else if (m >= 3) cases.push(2);
    else explain.push("2b");
  }
  const contrib = Object.keys(py).filter((p) => p.startsWith("opentelemetry-instrumentation-") && p.endsWith("-v2"));
  const openllmetry = Object.keys(py).filter((p) => p === "traceloop-sdk" || (p.startsWith("opentelemetry-instrumentation-") && !p.endsWith("-v2") && ["openai", "anthropic", "langchain", "llamaindex", "bedrock"].some((x) => p.includes(x))));
  const openinference = Object.keys(py).filter((p) => p.startsWith("openinference-"));
  if (has(py, "opentelemetry-sdk") || ["otel_provider", "otel_set_provider"].some((s) => signals.has(s)) || report.collector_configs.length ||
    (report.env.vendor_vars ?? []).some((n: string) => n.startsWith("OTEL_EXPORTER_OTLP"))) {
    tracing.otel = { sdk: has(py, "opentelemetry-sdk"), contrib_instrumentors: contrib, collector_configs: report.collector_configs };
    if (!cases.includes(2) || signals.has("otel_provider")) cases.push(3);
  }
  if (openinference.length || openllmetry.length) {
    tracing.openinference = openinference;
    tracing.openllmetry = openllmetry;
    cases.push(4);
  }
  if (has(py, "langsmith") || signals.has("langsmith_traceable") || (report.env.vendor_vars ?? []).some((n: string) => n.startsWith("LANGSMITH_") || n.startsWith("LANGCHAIN_TRACING"))) {
    tracing.langsmith = true;
    explain.push(5);
  }
  if (Object.keys(js).some((k) => k === "ai" || k === "@vercel/otel" || k.startsWith("@opentelemetry/"))) cases.push(6);
  if (report.serverless.length || Object.keys(report.servers).length) cases.push(7);
  if (report.services.length > 1) explain.push(8);
  if ((usesOpenai || usesAnthropic) && ![2, 3, 4].some((c) => cases.includes(c)) && !explain.includes("2b")) cases.push(1);
  cases.push(9);
  report.cases = [1, 2, 3, 4, 6, 7, 9].filter((c) => cases.includes(c));
  report.explain_only = ["2b", 5, 8].filter((c) => explain.includes(c));
  if (!(usesOpenai || usesAnthropic) && !cases.includes(6) && !cases.includes(4)) {
    notes.push("No OpenAI or Anthropic client found. Other providers need OTel GenAI instrumentation.");
  }
  if (report.chat_id_candidates.length) {
    const names = [...new Set<string>(report.chat_id_candidates.map((c: Json) => c.name))].sort();
    if (names.length > 1) notes.push(`Several possible conversation ids (${names.join(", ")}): ask the user which one.`);
  } else if (usesOpenai || usesAnthropic) {
    notes.push("No conversation id found. Ask whether this is a chat app and where its chat id lives.");
  }
  if (worker && workerRelevant && !worker.als) {
    notes.push(`${worker.file} has neither the nodejs_als nor the nodejs_compat compatibility flag: turns will not be grouped into conversations. Add nodejs_als to compatibility_flags.`);
  }
  report.plan = makePlan(report, lang, worker, workerRelevant, nextProject, usesOpenai);
}

const isTsFile = (file: string): boolean => TS_EXT.some((ext) => file.endsWith(ext));

function makePlan(report: Json, lang: Lang, worker: Wrangler | null, workerRelevant: boolean, nextProject: boolean, usesOpenai: boolean): string[] {
  const cases = report.cases as number[];
  const plan: string[] = [];
  const entryOf = (pred: (e: Json) => boolean) => (report.entry_points as Json[]).find(pred)?.file as string | undefined;
  const hasPython = (report.services as Json[]).some((s) => s.kind === "python");
  const hasTypescript = lang !== "python";
  const tsOnly = lang === "typescript";

  if (lang === "both") {
    const where = (pred: (f: string) => boolean) => (report.llm_calls as Json[]).find((c) => pred(c.file))?.file;
    const py = where((f) => !isTsFile(f));
    const ts = where(isTsFile);
    plan.push(`Two languages in this repo${py && ts ? ` (Python: ${py}; TypeScript: ${ts})` : ""}: set each one up with its own SDK (\`pip install zoroval\` for Python, \`npm install zoroval\` for TypeScript).`);
  }
  if (!tsOnly) {
    const entry = report.entry_points.length ? report.entry_points[0].file : null;
    if (hasPython) plan.push("Add `zoroval` to the Python dependencies.");
    if (cases.includes(2) || cases.includes(3) || cases.includes(4)) {
      plan.push(`Add \`import zoroval\` and \`zoroval.init()\` after the existing tracing setup (${entry ? "in " + entry : "at the app entry"}); it attaches to the existing provider.`);
    } else if (cases.includes(1)) {
      plan.push(`Add \`import zoroval\` and \`zoroval.init()\` at the top of ${entry || "the app entry"}.`);
    }
    if (cases.includes(4)) plan.push("Keep their instrumentor; do not add a second OpenAI wrapper (zoroval detects theirs).");
    if (report.chat_id_candidates.length && !cases.includes(2)) {
      const first = report.chat_id_candidates.find((c: Json) => !isTsFile(c.file)) ?? report.chat_id_candidates[0];
      plan.push(`Wrap each chat turn in \`with zoroval.conversation(${first.name}):\` (candidate at ${first.file}:${first.line}).`);
    }
    if (cases.includes(7)) {
      if (report.serverless.some((s: Json) => s.kind !== "cloudflare_worker")) plan.push("Call `zoroval.flush()` at the end of each serverless handler.");
      if (report.servers.gunicorn) plan.push("Pre-fork servers: nothing extra; the SDK restarts its export thread after fork.");
    }
  }
  if (hasTypescript) plan.push(...typescriptPlan(report, worker, workerRelevant, nextProject, usesOpenai, entryOf));
  if (cases.includes(6)) {
    plan.push("TypeScript: register an OTLP exporter to the Zoroval endpoint with the key header; pass the chat id in experimental_telemetry metadata.");
  }
  if (lang !== "typescript") {
    plan.push("Run `zoroval login` (writes the key to the git-ignored env file), then `zoroval doctor`.");
  } else {
    const file = worker ? ".dev.vars" : nextProject ? ".env.local" : ".env";
    plan.push(`Run \`npx zoroval login\` (writes the key to ${file}, which must be git-ignored), then \`npx zoroval doctor\`.`);
  }
  if (report.deploy_files.length && lang !== "typescript") {
    plan.push("Production: make a deploy key in the app and set ZOROVAL_INGEST_KEY in the host's secret settings yourself; the skill writes nothing there.");
  } else if (worker && hasTypescript) {
    plan.push("Production: make a deploy key in the app and run `wrangler secret put ZOROVAL_INGEST_KEY` yourself; the skill writes nothing there.");
  } else if (hasTypescript && (nextProject || report.deploy_files.length)) {
    plan.push("Production: make a deploy key in the app and add ZOROVAL_INGEST_KEY to the host's environment variables (for Vercel, the project's settings) yourself; the skill writes nothing there.");
  }
  return plan;
}

function typescriptPlan(report: Json, worker: Wrangler | null, workerRelevant: boolean, nextProject: boolean, usesOpenai: boolean, entryOf: (pred: (e: Json) => boolean) => string | undefined): string[] {
  const plan: string[] = [];
  const tsCalls = (report.llm_calls as Json[]).filter((c) => isTsFile(c.file));
  const entry = worker
    ? entryOf((e) => e.kind === "worker")
    : nextProject
      ? entryOf((e) => String(e.kind).startsWith("nextjs"))
      : entryOf((e) => isTsFile(e.file));
  plan.push("Install the package: `npm install zoroval` (or the project's package manager).");
  if (worker) {
    plan.push(`Worker: in the \`fetch\` handler${entry ? ` (${entry})` : ""} call \`zoroval.init({ apiKey: env.ZOROVAL_INGEST_KEY })\` (\`import * as zoroval from "zoroval"\`).`);
  } else {
    plan.push(`Add \`import * as zoroval from "zoroval"\` and call \`zoroval.init()\` once when the app starts${entry ? ` (for example in ${entry})` : ""}.`);
  }
  if (tsCalls.some((c) => c.api !== "fetch") || (usesOpenai && !tsCalls.length && "openai" in report.packages.typescript)) {
    plan.push("Wrap the OpenAI client: `const openai = zoroval.wrapOpenAI(new OpenAI())`.");
  }
  if (tsCalls.some((c) => c.api === "fetch")) plan.push("Use `zoroval.wrapFetch()` as the `fetch` for the calls to api.openai.com.");
  const candidate = (report.chat_id_candidates as Json[]).find((c) => isTsFile(c.file));
  if (candidate) {
    plan.push(`Wrap each chat turn in \`zoroval.conversation(${candidate.name}, () => zoroval.turn({ input }, async (turn) => { ... }))\` (candidate at ${candidate.file}:${candidate.line}).`);
  }
  if (worker) {
    plan.push("Hand the flush to the platform: `ctx.waitUntil(zoroval.flush())` before the `fetch` handler returns.");
    if (workerRelevant && !worker.als) plan.push(`Add \`nodejs_als\` to compatibility_flags in ${worker.file}; without it turns are not grouped into conversations.`);
  } else if (nextProject) {
    plan.push("Hand the flush to the platform: `after(() => zoroval.flush())` in Next.js 15 (or `waitUntil` from `@vercel/functions`) at the end of each route that calls the model.");
  } else {
    plan.push("Long-running Node servers send spans in the background; in short scripts call `await zoroval.flush()` before exit.");
  }
  return plan;
}

// ---------------------------------------------------------------------------- text output

export function textReport(report: Json): string[] {
  const lines = [`Folder: ${report.root}`];
  lines.push(`Cases: ${report.cases.join(", ") || "none"}` + (report.explain_only.length ? `; explain only: ${report.explain_only.join(", ")}` : ""));
  lines.push(`ZOROVAL_INGEST_KEY: ${report.env[envfile.KEY_VAR]}`);
  for (const call of report.llm_calls.slice(0, 10)) lines.push(`LLM call: ${call.file}:${call.line} ${call.provider} ${call.api}`);
  for (const cand of report.chat_id_candidates.slice(0, 10)) lines.push(`Conversation id candidate: ${cand.file}:${cand.line} ${cand.name}`);
  for (const note of report.notes) lines.push(`Note: ${note}`);
  lines.push("Plan:");
  for (const step of report.plan) lines.push(`- ${step}`);
  return lines;
}
