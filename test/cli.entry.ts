// Test-only bundle: CLI modules whose collaborators (browser, clock, screen) a test replaces.
export { run as login, logout, nextMessage } from "../src/cli/login.js";
export { resetSent } from "../src/cli/setup-report.js";
export { COMMANDS, main } from "../src/cli/main.js";
export { parseToml } from "../src/cli/toml.js";
export { scanJs } from "../src/cli/jsscan.js";
export { scanPython } from "../src/cli/pyscan.js";
export { stripJsonc, findWrangler } from "../src/cli/project.js";
export { parseArgs, UsageError, EarlyExit } from "../src/cli/args.js";
