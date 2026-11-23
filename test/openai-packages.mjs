// The `openai` packages the tests run against: v5 (runs on every Node the SDK supports) and, on Node 22+
// where it can run, the current v7.
const major = Number(process.versions.node.split(".")[0]);
export const packages = [{ label: "openai 5", OpenAI: (await import("openai-v5")).default }];
if (major >= 22) packages.push({ label: "openai 7", OpenAI: (await import("openai")).default });
/** The newest one available. */
export const OpenAI = packages[packages.length - 1].OpenAI;
