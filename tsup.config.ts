import { readFile } from "node:fs/promises";
import type { Plugin } from "esbuild";
import { defineConfig } from "tsup";

// One entry per runtime: the package.json conditional exports (workerd, edge-light, node, default)
// pick the right file, so no Node-only import reaches an edge bundle. Types come from `index`.
// The rule file is shared byte for byte with zoroval-python and ingest (CI compares them). Its notes for
// people ("about", "covers", "what") are dropped from the bundle; the rules themselves are untouched.
const rulesWithoutNotes: Plugin = {
  name: "level1-rules",
  setup(build) {
    build.onLoad({ filter: /redaction[\\/]level1\.json$/ }, async (args) => {
      const doc = JSON.parse(await readFile(args.path, "utf8"));
      delete doc.about;
      for (const rule of doc.rules) delete rule.covers;
      for (const entry of doc.fold) delete entry.what;
      return { contents: JSON.stringify(doc), loader: "json" };
    });
  },
};

const shared = {
  esbuildPlugins: [rulesWithoutNotes],
  target: "es2022",
  platform: "neutral",
  minify: true,
  sourcemap: false,
  removeNodeProtocol: false, // Workers need the `node:` prefix
  external: [/^node:/],
} as const;

export default defineConfig([
  {
    ...shared,
    entry: { index: "src/entry.default.ts", node: "src/entry.node.ts", edge: "src/entry.edge.ts", workerd: "src/entry.workerd.ts" },
    format: ["esm"],
    clean: true,
    dts: { entry: { index: "src/api.ts" }, compilerOptions: { stripInternal: true } },
  },
  {
    ...shared,
    entry: { index: "src/entry.default.ts", node: "src/entry.node.ts", edge: "src/entry.edge.ts", workerd: "src/entry.workerd.cjs.ts" },
    format: ["cjs"],
    clean: false,
    dts: { entry: { index: "src/api.ts" }, compilerOptions: { stripInternal: true } },
  },
]);
