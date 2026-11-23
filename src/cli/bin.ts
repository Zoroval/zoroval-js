#!/usr/bin/env node
// `npx zoroval`. The SDK's runtime entries never import anything under src/cli.
import { webcrypto } from "node:crypto";
import { installRuntime } from "../runtime.js";
import { main } from "./main.js";

installRuntime({ background: false, webcrypto }); // Node 18 has no global `crypto`; the SDK's ids need one
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  },
);
