export function scan(_root: string): Record<string, any> {
  return { root: _root, tracing: {}, servers: {}, packages: {} };
}
export function textReport(_report: Record<string, any>): string[] {
  return [];
}
