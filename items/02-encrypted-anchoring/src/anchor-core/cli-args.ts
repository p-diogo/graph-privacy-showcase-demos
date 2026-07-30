/** Minimal flag parser: no dependency, no surprises about how a flag is read. */
export interface ParsedArgs {
  command: string | undefined;
  flags: Map<string, string | boolean>;
  positional: string[];
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  const positional: string[] = [];
  let command: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags.set(body.slice(0, eq), body.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags.set(body, next);
          i++;
        } else {
          flags.set(body, true);
        }
      }
    } else if (command === undefined) {
      command = token;
    } else {
      positional.push(token);
    }
  }

  return { command, flags, positional };
}

export function requireFlag(args: ParsedArgs, name: string): string {
  const value = args.flags.get(name);
  if (typeof value !== "string" || value.length === 0) throw new UsageError(`missing required flag --${name}`);
  return value;
}

export function optionalFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

export function boolFlag(args: ParsedArgs, name: string): boolean {
  const value = args.flags.get(name);
  return value === true || value === "true";
}

export class UsageError extends Error {
  readonly exitCode = 1;
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}
