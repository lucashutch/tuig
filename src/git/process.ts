/** Runs Git subprocesses, tracks Tuig's own processes, and defines Git error types. */
import { access, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { CommandResult } from "./types";
import type { RemoteAuthFailure } from "./remote-errors";

/** A fetch, pull, or push failed because credentials or a host key are missing. */
export class GitAuthError extends Error {
  constructor(
    message: string,
    public readonly failure: RemoteAuthFailure,
    public readonly command: GitCommandError,
  ) {
    super(message);
    this.name = "GitAuthError";
  }
}

export class GitCommandError extends Error {
  constructor(
    public readonly args: string[],
    public readonly result: CommandResult,
  ) {
    super(
      `git ${args.join(" ")}: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
    );
    this.name = "GitCommandError";
  }
}

/** Raised when the path used to launch Tuig is outside a Git work tree. */
export class NotGitRepositoryError extends Error {
  constructor(
    public readonly path: string,
    public readonly suggestions: readonly string[] = [],
    problem: "not-repository" | "missing" | "not-directory" = "not-repository",
  ) {
    const description =
      problem === "missing"
        ? `Path "${path}" does not exist.`
        : problem === "not-directory"
          ? `Path "${path}" is not a directory.`
          : `No Git repository found at "${path}".`;
    const hint = suggestions.length
      ? `\n\nRepositories found nearby:\n${suggestions.map((candidate) => `  tuig ${shellPath(candidate)}`).join("\n")}`
      : "\n\nHint: Run tuig from inside a Git repository or pass the path to one.";
    super(description + hint);
    this.name = "NotGitRepositoryError";
  }
}

function shellPath(path: string) {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(path)
    ? path
    : `'${path.replaceAll("'", `'"'"'`)}'`;
}

async function repositoryDirectories(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  const repositories = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const candidate = join(path, entry.name);
        try {
          await access(join(candidate, ".git"));
          const root = (
            await runGit(["rev-parse", "--show-toplevel"], candidate)
          ).stdout.trim();
          return resolve(root) === resolve(candidate) ? candidate : undefined;
        } catch {
          return undefined;
        }
      }),
  );
  return repositories.filter((path): path is string => path !== undefined);
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++)
      current[j] = Math.min(
        current[j - 1]! + 1,
        previous[j]! + 1,
        previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  return previous[right.length]!;
}

export async function nearbyRepositories(path: string, pathExists: boolean) {
  if (pathExists) return (await repositoryDirectories(path)).sort().slice(0, 3);

  const wanted = basename(path).toLowerCase();
  return (await repositoryDirectories(dirname(path)))
    .map((candidate) => ({
      candidate,
      distance: editDistance(wanted, basename(candidate).toLowerCase()),
    }))
    .filter(
      ({ distance }) =>
        distance <= Math.max(2, Math.floor(wanted.length * 0.4)),
    )
    .sort(
      (a, b) =>
        a.distance - b.distance || a.candidate.localeCompare(b.candidate),
    )
    .slice(0, 3)
    .map(({ candidate }) => candidate);
}

/** Raised when a caller aborted a running Git command. */
export class GitCommandAbortedError extends Error {
  constructor(public readonly args: string[]) {
    super(`git ${args.join(" ")}: cancelled`);
    this.name = "GitCommandAbortedError";
  }
}

/** Raised when a command emits more stdout than its caller permits. */
export class GitOutputLimitError extends Error {
  constructor(
    public readonly args: string[],
    public readonly limitBytes: number,
  ) {
    super(`git ${args.join(" ")}: output exceeded ${limitBytes} bytes`);
    this.name = "GitOutputLimitError";
  }
}

/**
 * The TUI cannot answer prompts printed to its terminal, so credential
 * requests are disabled outright: Git fails fast with a clear error instead
 * of blocking the whole interface on an invisible prompt.
 */
export const NON_INTERACTIVE_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
};

let ownGitProcesses = 0;
let ownGitExitedAt = -Infinity;

/**
 * Count a Git process Tuig started, until the returned callback runs.
 *
 * Read-only commands such as `git diff` still rewrite `.git/index` to cache
 * file stat data, even with `--no-optional-locks`. The repository watcher uses
 * this count to tell those writes apart from changes made in another terminal.
 */
export function trackOwnGitProcess() {
  ownGitProcesses++;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    ownGitProcesses--;
    ownGitExitedAt = performance.now();
  };
}

/** True while a Tuig Git process runs, or ended less than graceMs ago. */
export function ownGitActive(graceMs = 0, now = performance.now()) {
  return ownGitProcesses > 0 || now - ownGitExitedAt < graceMs;
}

export async function runGit(
  args: string[],
  cwd?: string,
  env?: Record<string, string | undefined>,
  signal?: AbortSignal,
  maxBytes?: number,
): Promise<CommandResult> {
  if (
    maxBytes !== undefined &&
    (!Number.isFinite(maxBytes) || !Number.isInteger(maxBytes) || maxBytes < 0)
  )
    throw new RangeError("maxBytes must be a finite nonnegative integer");
  if (signal?.aborted) throw new GitCommandAbortedError(args);
  const ended = trackOwnGitProcess();
  try {
    return await runTrackedGit(args, cwd, env, signal, maxBytes);
  } finally {
    ended();
  }
}

async function runTrackedGit(
  args: string[],
  cwd: string | undefined,
  env: Record<string, string | undefined> | undefined,
  signal: AbortSignal | undefined,
  maxBytes: number | undefined,
): Promise<CommandResult> {
  // A textconv/credential helper can inherit Git's pipes. Killing only Git
  // leaves those pipes open and makes a cancelled read wait for the helper.
  const isolated =
    process.platform !== "win32" &&
    (signal !== undefined || maxBytes !== undefined);
  const p = Bun.spawn(["git", ...args], {
    cwd,
    detached: isolated,
    env: {
      ...process.env,
      ...(env ?? {}),
      // The non-interactive defaults win unless the caller overrode the key.
      ...Object.fromEntries(
        Object.entries(NON_INTERACTIVE_ENV).filter(
          ([key]) => !(env && key in env),
        ),
      ),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const kill = (signal: NodeJS.Signals) => {
    try {
      if (isolated) process.kill(-p.pid, signal);
      else p.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  const abort = () => {
    kill("SIGTERM");
    killTimer ??= setTimeout(() => kill("SIGKILL"), 250);
    killTimer.unref();
  };
  signal?.addEventListener("abort", abort, { once: true });
  let exceeded = false;
  const stdoutPromise = (async () => {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of p.stdout) {
      bytes += chunk.byteLength;
      if (maxBytes !== undefined && bytes > maxBytes) {
        exceeded = true;
        abort();
        break;
      }
      chunks.push(chunk);
    }
    if (exceeded) return "";
    const output = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(output);
  })();
  let stdout: string;
  let stderr: string;
  let exitCode: number;
  try {
    [stdout, stderr, exitCode] = await Promise.all([
      stdoutPromise,
      new Response(p.stderr).text(),
      p.exited,
    ]);
  } catch (error) {
    kill("SIGKILL");
    await p.exited.catch(() => undefined);
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    if (killTimer) clearTimeout(killTimer);
  }
  const result = { stdout, stderr, exitCode };
  if (signal?.aborted) throw new GitCommandAbortedError(args);
  if (exceeded) throw new GitOutputLimitError(args, maxBytes!);
  if (exitCode) throw new GitCommandError(args, result);
  return result;
}
