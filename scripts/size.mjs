// Prints the gzip size of the runtime bundle for each entry (shared chunk plus entry file).
import { readdirSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const dist = new URL("../dist/", import.meta.url);
const gz = (name) => gzipSync(readFileSync(new URL(name, dist)), { level: 9 }).length;
const chunks = readdirSync(dist).filter((f) => f.startsWith("chunk-") && f.endsWith(".js"));
for (const entry of ["index", "node", "edge", "workerd"]) {
  const esm = gz(`${entry}.js`) + chunks.reduce((sum, c) => sum + gz(c), 0);
  console.log(`${entry.padEnd(8)} esm ${(esm / 1024).toFixed(2)} KB gzip   cjs ${(gz(`${entry}.cjs`) / 1024).toFixed(2)} KB gzip`);
}
