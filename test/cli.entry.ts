// Test-only bundle: CLI modules whose collaborators (browser, clock, screen) a test replaces.
export { run as login, logout, nextMessage } from "../src/cli/login.js";
export { resetSent } from "../src/cli/setup-report.js";
export { COMMANDS, main } from "../src/cli/main.js";
