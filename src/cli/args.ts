/**
 * A small argparse look-alike, so `zoroval` parses its command line the way the Python CLI does:
 * usage errors print `usage: ...` and `zoroval: error: ...` on stderr and exit 2; `--opt=value`,
 * a unique prefix of a long option (`--env`), and `--` all work.
 */

export interface OptionSpec {
  flags: string[]; // e.g. ["--root"]
  dest: string;
  /** true: a switch; false: takes one value. */
  switch?: boolean;
  default?: string | boolean;
  help: string;
  metavar?: string;
  /** Show this text in `--help` instead of the default (the real default is chosen later). */
  shownDefault?: string;
}

export interface CommandSpec {
  name: string;
  help: string;
  positional?: { dest: string; default: string; metavar: string };
  options: OptionSpec[];
}

export class UsageError extends Error {
  constructor(
    message: string,
    public usage: string,
  ) {
    super(message);
  }
}

export class EarlyExit extends Error {
  constructor(
    public stdout: string,
    public code = 0,
  ) {
    super(stdout);
  }
}

export type Values = Record<string, string | boolean | undefined>;

const NEGATIVE_NUMBER = /^-\d+$|^-\d*\.\d+$/;

function usageLine(prog: string, options: OptionSpec[], positional?: CommandSpec["positional"]): string {
  const parts = options.map((o) => {
    const flag = o.flags[0]!;
    return o.switch ? `[${flag}]` : `[${flag} ${o.metavar ?? o.dest.toUpperCase()}]`;
  });
  return `usage: ${prog} [-h] ${parts.join(" ")}${positional ? ` [${positional.metavar}]` : ""}`.replace(/ +/g, " ");
}

function helpText(prog: string, description: string, options: OptionSpec[], positional?: CommandSpec["positional"]): string {
  const lines = [usageLine(prog, options, positional), "", description, ""];
  if (positional) lines.push("positional arguments:", `  ${positional.metavar}`, "");
  lines.push("options:", "  -h, --help            show this help message and exit");
  for (const o of options) {
    const head = o.switch ? o.flags.join(", ") : `${o.flags.join(", ")} ${o.metavar ?? o.dest.toUpperCase()}`;
    lines.push(`  ${head.padEnd(21)} ${o.help}`);
  }
  return lines.join("\n") + "\n";
}

/** Parse the options and the one optional positional of a sub-command. */
function parseCommand(spec: CommandSpec, argv: string[]): Values {
  const prog = `zoroval ${spec.name}`;
  const usage = usageLine(prog, spec.options, spec.positional);
  const values: Values = {};
  for (const o of spec.options) values[o.dest] = o.switch ? false : o.default;
  if (spec.positional) values[spec.positional.dest] = spec.positional.default;
  const byFlag = new Map<string, OptionSpec>();
  for (const o of spec.options) for (const f of o.flags) byFlag.set(f, o);
  const longFlags = [...byFlag.keys()].filter((f) => f.startsWith("--"));
  const positionals: string[] = [];
  const unrecognized: string[] = [];
  let rest = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (rest || arg === "-" || !arg.startsWith("-") || NEGATIVE_NUMBER.test(arg)) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      rest = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") throw new EarlyExit(helpText(prog, spec.help, spec.options, spec.positional));
    let name = arg;
    let inline: string | undefined;
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq > 0) {
      name = arg.slice(0, eq);
      inline = arg.slice(eq + 1);
    }
    let option = byFlag.get(name);
    if (!option && name.startsWith("--")) {
      const matches = longFlags.filter((f) => f.startsWith(name));
      if (matches.length > 1) {
        throw new UsageError(`ambiguous option: ${name} could match ${matches.join(", ")}`, usage);
      }
      if (matches.length === 1) option = byFlag.get(matches[0]!);
    }
    if (!option) {
      unrecognized.push(arg);
      continue;
    }
    const flagName = option.flags.join("/");
    if (option.switch) {
      if (inline !== undefined) throw new UsageError(`argument ${flagName}: ignored explicit argument '${inline}'`, usage);
      values[option.dest] = true;
      continue;
    }
    let value = inline;
    if (value === undefined) {
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith("-") && next !== "-" && !NEGATIVE_NUMBER.test(next))) {
        throw new UsageError(`argument ${flagName}: expected one argument`, usage);
      }
      value = next;
      i += 1;
    }
    values[option.dest] = value;
  }
  if (spec.positional) {
    if (positionals.length > 0) values[spec.positional.dest] = positionals.shift()!;
  }
  unrecognized.push(...positionals);
  if (unrecognized.length) throw new UsageError(`unrecognized arguments: ${unrecognized.join(" ")}`, "usage: zoroval [-h] [--version] {detect,login,logout,doctor} ...");
  return values;
}

export interface Parsed {
  command: string;
  values: Values;
}

export function parseArgs(argv: string[], commands: CommandSpec[], version: string): Parsed {
  const names = commands.map((c) => c.name);
  const top = "usage: zoroval [-h] [--version] {" + names.join(",") + "} ...";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      const lines = [top, "", "Set up and check Zoroval tracing.", "", "positional arguments:", `  {${names.join(",")}}`];
      for (const c of commands) lines.push(`    ${c.name.padEnd(8)}${c.help}`);
      lines.push("", "options:", "  -h, --help            show this help message and exit", "  --version             show program's version number and exit");
      throw new EarlyExit(lines.join("\n") + "\n");
    }
    if (arg === "--version") throw new EarlyExit(`zoroval ${version}\n`);
    if (!arg.startsWith("-")) {
      const spec = commands.find((c) => c.name === arg);
      if (!spec) {
        throw new UsageError(
          `argument command: invalid choice: '${arg}' (choose from ${names.map((n) => `'${n}'`).join(", ")})`,
          top,
        );
      }
      return { command: spec.name, values: parseCommand(spec, argv.slice(i + 1)) };
    }
    throw new UsageError(`unrecognized arguments: ${arg}`, top);
  }
  throw new UsageError("the following arguments are required: command", top);
}
