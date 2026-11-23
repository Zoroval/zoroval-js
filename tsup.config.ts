import { defineConfig } from "tsup";

// One entry per runtime: the package.json conditional exports (workerd, edge-light, node, default)
// pick the right file, so no Node-only import reaches an edge bundle. Types come from `index`.
const shared = {
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
