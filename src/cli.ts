import packageJson from "../package.json" with { type: "json" };

export const VERSION = packageJson.version;

export type CliAction =
  | { kind: "run"; path: string; clean: boolean; pathProvided: boolean }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "update" };

export const HELP = `Usage: tuig [options] [path]
       tuig update

Open Git repositories in the terminal UI.

Without a path, Tuig restores the repositories from the last session. It
opens the current directory only when no saved repository is available.
With a path, Tuig adds that repository to the restored session.

Options:
  -h, --help       Show this help
  -v, --version    Show the installed version
  -C, --directory  Open a repository at this path
  --clean           Open only the requested repository, not the saved session

Commands:
  update           Install the latest Tuig release from Git
`;

export function parseArgs(args: string[], cwd = process.cwd()): CliAction {
  let path: string | undefined;
  let clean = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "-h" || arg === "--help") return { kind: "help" };
    if (arg === "-v" || arg === "--version") return { kind: "version" };
    if (arg === "--clean") {
      clean = true;
      continue;
    }
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

  return {
    kind: "run",
    path: path ?? cwd,
    clean,
    pathProvided: path !== undefined,
  };
}
