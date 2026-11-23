import { defineConfig } from "tsup";

// One entry per runtime: the package.json conditional exports (workerd, edge-light, node, default)
// pick the right file, so no Node-only import reaches an edge bundle. Types come from `index`.
export default defineConfig({
  entry: {
    index: "src/entry.default.ts",
    node: "src/entry.node.ts",
    edge: "src/entry.edge.ts",
    workerd: "src/entry.workerd.ts",
  },
  format: ["esm", "cjs"],
  dts: { entry: { index: "src/api.ts" } },
  target: "es2022",
  platform: "neutral",
  minify: true,
  clean: true,
  sourcemap: false,
  external: [/^node:/],
});
