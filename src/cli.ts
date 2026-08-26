import packageJson from "../package.json" with { type: "json" };

export const VERSION = packageJson.version;

export type CliAction =
  | { kind: "run"; path: string }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "update" };

export const HELP = `Usage: tuig [options] [path]
       tuig update

Open a Git repository in the terminal UI.

Options:
  -h, --help       Show this help
  -v, --version    Show the installed version
  -C, --directory  Open a repository at this path

Commands:
  update           Install the latest Tuig release from Git
`;

export function parseArgs(args: string[], cwd = process.cwd()): CliAction {
  let path: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "-h" || arg === "--help") return { kind: "help" };
    if (arg === "-v" || arg === "--version") return { kind: "version" };
    if (arg === "update") {
      if (args.length !== 1)
        throw new Error("update does not accept options or a path");
      return { kind: "update" };
    }
    if (arg === "-C" || arg === "--directory") {
      const directory = args[++i];
      if (!directory) throw new Error(`${arg} requires a path`);
      if (path) throw new Error("a repository path was already provided");
      path = directory;
      continue;
    }
    if (arg?.startsWith("-")) throw new Error(`unknown option: ${arg}`);
    if (path) throw new Error("only one repository path may be provided");
    path = arg;
  }

  return { kind: "run", path: path ?? cwd };
}
