import { defineConfig } from "tsup";

// Builds test/internal.entry.ts into .test-build/ (not published).
export default defineConfig({
  entry: { internal: "test/internal.entry.ts" },
  format: ["esm"],
  platform: "node",
  target: "es2022",
  outDir: ".test-build",
  clean: true,
  dts: false,
  external: [/^node:/],
});
