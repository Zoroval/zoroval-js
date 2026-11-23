// Copies a detect fixture into a temporary git repo and adds the env files (they hold fake values and
// are git-ignored in this repository, so they cannot live in the fixture folder).
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const FAKE_SECRET = "sk-test-DO-NOT-PRINT-0123456789";

export const PYTHON_ENV = {
  ".env": `OPENAI_API_KEY=${FAKE_SECRET}\nLANGFUSE_HOST=https://langfuse.example\nexport OTEL_EXPORTER_OTLP_ENDPOINT=https://otel.example\n# comment\n`,
  ".env.example": "OPENAI_API_KEY=\n",
};

/** `env`: file name to content; the default suits the Python fixtures (and the golden snapshots). */
export function prepareFixture(source, { env = PYTHON_ENV } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "zoroval-fixture-")));
  cpSync(source, dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, ".gitignore"), ".env\n.env.local\n.dev.vars\n");
  for (const [name, content] of Object.entries(env)) writeFileSync(join(dir, name), content);
  return dir;
}
