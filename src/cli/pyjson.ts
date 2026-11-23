/** `JSON.stringify` the way Python's `json.dumps(value, indent=2)` writes it (ASCII only), so the `--json` text matches. */
export function pyJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}
