import { defineConfig } from "tsup";

// Builds the test entries into .test-build/ (not published).
export default defineConfig({
  entry: { internal: "test/internal.entry.ts", cli: "test/cli.entry.ts" },
  format: ["esm"],
  platform: "node",
  target: "es2022",
  outDir: ".test-build",
  clean: true,
  dts: false,
  external: [/^node:/],
});
