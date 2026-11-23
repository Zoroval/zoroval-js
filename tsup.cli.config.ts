import { defineConfig } from "tsup";

// `npx zoroval`: Node only, one self-contained file. It bundles the few core modules it reuses
// (transport, span, config) into its own file, so nothing is shared with the runtime entries and
// no runtime entry can import CLI code. Runs after the runtime build (which cleans dist).
export default defineConfig({
  entry: { cli: "src/cli/bin.ts" },
  format: ["esm"],
  platform: "node",
  target: "node18",
  clean: false,
  splitting: false,
  minify: false,
  sourcemap: false,
  dts: false,
  removeNodeProtocol: false,
  external: [/^node:/],
});
