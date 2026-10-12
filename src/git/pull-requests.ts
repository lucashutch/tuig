/** Lists open pull requests with the GitHub CLI and rolls their checks up into one status. */
import type { CommandResult } from "./types";
import type {
  CheckRollup,
  PullRequest,
  PullRequestList,
  PullRequestService,
  PullRequestUnavailableReason,
} from "./pull-request-types";

export interface GhRunOptions {
  cwd: string;
  signal?: AbortSignal;
}

/**
 * Runs `gh` with the given arguments. It resolves with the exit code for any
 * exit, and rejects when `gh` cannot start (`code: "ENOENT"`), times out, or is
 * aborted.
 */
export type GhRunner = (
  args: string[],
  options: GhRunOptions,
) => Promise<CommandResult>;

export interface PullRequestServiceOptions {
  runner?: GhRunner;
  /** Milliseconds clock. Defaults to `Date.now`. */
  now?: () => number;
}

/** Raised when `gh` runs longer than the timeout. */
export class GhTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`GitHub CLI timed out after ${Math.round(timeoutMs / 1000)} s.`);
    this.name = "GhTimeoutError";
  }
}

const GH_TIMEOUT_MS = 15_000;
/** How long to wait before asking `gh` for the signed-in login again after a failure. */
const LOGIN_RETRY_MS = 60_000;

/** `gh` must never prompt, page, color, or animate: Tuig owns the terminal. */
export const GH_NON_INTERACTIVE_ENV: Record<string, string> = {
  GH_PROMPT_DISABLED: "1",
  GH_PAGER: "cat",
  GH_SPINNER_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
  GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
  NO_COLOR: "1",
};

const LIST_FIELDS =
  "number,title,url,isDraft,author,headRefName,headRefOid,headRepositoryOwner,isCrossRepository,updatedAt,statusCheckRollup";

const LIST_ARGS = [
  "pr",
  "list",
  "--state",
  "open",
  "--limit",
  "100",
  "--json",
  LIST_FIELDS,
];
const REVIEW_ARGS = [
  "pr",
  "list",
  "--state",
  "open",
  "--search",
  "review-requested:@me",
  "--json",
  "number",
  "--limit",
  "100",
];
const LOGIN_ARGS = ["api", "user", "--jq", ".login"];

export const runGh: GhRunner = async (args, { cwd, signal }) => {
  if (signal?.aborted) throw abortError();
  const p = Bun.spawn(["gh", ...args], {
    cwd,
    env: { ...process.env, ...GH_NON_INTERACTIVE_ENV },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    p.kill("SIGKILL");
  }, GH_TIMEOUT_MS);
  const abort = () => p.kill("SIGKILL");
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    if (signal?.aborted) throw abortError();
    if (timedOut) throw new GhTimeoutError(GH_TIMEOUT_MS);
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
};

function abortError() {
  return new DOMException(
    "The pull request request was cancelled.",
    "AbortError",
  );
}

type Failure = { reason: PullRequestUnavailableReason; message?: string };

function shorten(text: string) {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

function describeFailure(error: unknown): Failure {
  if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT")
    return { reason: "gh-missing" };
  const message = error instanceof Error ? error.message : String(error);
  return { reason: "error", message: shorten(message) };
}

function classifyExit(result: CommandResult): Failure {
  const stderr = result.stderr.toLowerCase();
  // Checked first: this message also tells the user to run `gh auth login`.
  if (
    stderr.includes("known github host") ||
    stderr.includes("no github remote")
  )
    return { reason: "not-github" };
  if (
    result.exitCode === 4 ||
    stderr.includes("gh auth login") ||
    stderr.includes("bad credentials") ||
    stderr.includes("http 401")
  )
    return { reason: "not-authenticated" };
  return {
    reason: "error",
    message:
      shorten(result.stderr) ||
      `GitHub CLI exited with code ${result.exitCode}.`,
  };
}

export function createPullRequestService(
  root: string,
  options: PullRequestServiceOptions = {},
): PullRequestService {
  const run = options.runner ?? runGh;
  const now = options.now ?? Date.now;
  // gh-missing and not-github do not change while Tuig runs.
  let permanent: Failure | undefined;
  let login: string | undefined;
  let loginFailedAt = -Infinity;

  /** Runs gh and returns stdout, or the failure. Throws only on abort. */
  async function gh(
    args: string[],
    signal?: AbortSignal,
  ): Promise<{ stdout: string } | Failure> {
    try {
      const result = await run(args, { cwd: root, signal });
      return result.exitCode === 0 ? result : classifyExit(result);
    } catch (error) {
      if (signal?.aborted) throw abortError();
      return describeFailure(error);
    }
  }

  async function signedInLogin(signal?: AbortSignal) {
    if (login !== undefined || now() - loginFailedAt < LOGIN_RETRY_MS)
      return login;
    const result = await gh(LOGIN_ARGS, signal);
    const value = "stdout" in result ? result.stdout.trim() : "";
    if (value) login = value.toLowerCase();
    else loginFailedAt = now();
    return login;
  }

  async function reviewRequestedNumbers(signal?: AbortSignal) {
    const result = await gh(REVIEW_ARGS, signal);
    // A failed search only hides the "review requested" group.
    if (!("stdout" in result)) return new Set<number>();
    return new Set(
      parseArray(result.stdout)
        .map((entry) => asRecord(entry)?.number)
        .filter((n): n is number => Number.isInteger(n)),
    );
  }

  return {
    async list(signal): Promise<PullRequestList> {
      if (permanent) return { available: false, ...permanent };
      const [listed, requested, user] = await Promise.all([
        gh(LIST_ARGS, signal),
        reviewRequestedNumbers(signal),
        signedInLogin(signal),
      ]);
      if (!("stdout" in listed)) {
        if (listed.reason === "gh-missing" || listed.reason === "not-github")
          permanent = listed;
        return { available: false, ...listed };
      }
      const entries = parseArray(listed.stdout, true);
      if (!entries)
        return {
          available: false,
          reason: "error",
          message: "GitHub CLI returned unreadable pull request data.",
        };
      const pullRequests = entries
        .map((entry) => parsePullRequest(entry, user, requested))
        .filter((pr): pr is PullRequest => pr !== undefined)
        .sort((a, b) => time(b.updatedAt) - time(a.updatedAt));
      return { available: true, pullRequests };
    },
  };
}

function time(iso: string) {
  const value = Date.parse(iso);
  return Number.isNaN(value) ? -Infinity : value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseArray(text: string): unknown[];
function parseArray(text: string, strict: true): unknown[] | undefined;
function parseArray(text: string, strict = false): unknown[] | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (Array.isArray(value)) return value;
  } catch {
    // Fall through to the caller's empty or error handling.
  }
  return strict ? undefined : [];
}

function str(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

/** Returns undefined for an entry that lacks a field the UI cannot do without. */
function parsePullRequest(
  entry: unknown,
  login: string | undefined,
  requested: ReadonlySet<number>,
): PullRequest | undefined {
  const raw = asRecord(entry);
  if (!raw) return undefined;
  const number = raw.number;
  const title = str(raw.title);
  const url = str(raw.url);
  const headBranch = str(raw.headRefName);
  const updatedAt = str(raw.updatedAt);
  if (
    typeof number !== "number" ||
    !Number.isInteger(number) ||
    title === undefined ||
    url === undefined ||
    !headBranch ||
    updatedAt === undefined
  )
    return undefined;
  // GitHub reports deleted accounts as null.
  const author = str(asRecord(raw.author)?.login) ?? "ghost";
  const headSha = str(raw.headRefOid);
  return {
    number,
    title,
    url,
    state: raw.isDraft === true ? "draft" : "open",
    checks: rollupChecks(
      Array.isArray(raw.statusCheckRollup) ? raw.statusCheckRollup : [],
    ),
    author,
    headBranch,
    ...(headSha ? { headSha } : {}),
    fromFork: raw.isCrossRepository === true,
    mine: login !== undefined && author.toLowerCase() === login,
    reviewRequested: requested.has(number),
    updatedAt,
  };
}

type CheckState = "failed" | "running" | "queued" | "passed";

/**
 * Sorts one `statusCheckRollup` item into a state, or undefined when the item
 * is not a check. Unknown in-flight values count as running and unknown final
 * values count as failed, so a new GitHub value never shows a green rollup.
 */
function checkState(item: unknown): CheckState | undefined {
  const raw = asRecord(item);
  if (!raw) return undefined;
  const status = str(raw.status)?.toUpperCase();
  const state = str(raw.state)?.toUpperCase();
  if (raw.__typename === "StatusContext" || (!status && state)) {
    switch (state) {
      case "SUCCESS":
        return "passed";
      case "FAILURE":
      case "ERROR":
        return "failed";
      case "EXPECTED":
        return "queued";
      // A commit status has no queued or running split. External CI usually
      // reports PENDING once the build starts, so it counts as running.
      default:
        return "running";
    }
  }
  if (!status) return undefined;
  switch (status) {
    case "COMPLETED": {
      const conclusion = str(raw.conclusion)?.toUpperCase();
      // FAILURE, CANCELLED, TIMED_OUT, ACTION_REQUIRED, STALE, STARTUP_FAILURE,
      // a missing conclusion, and unknown values all count as failed.
      return conclusion === "SUCCESS" ||
        conclusion === "SKIPPED" ||
        conclusion === "NEUTRAL"
        ? "passed"
        : "failed";
    }
    case "QUEUED":
    case "WAITING":
    case "PENDING":
    case "REQUESTED":
      return "queued";
    default:
      return "running";
  }
}

/**
 * Combines `statusCheckRollup` items (CheckRun and StatusContext) into one
 * status. The rules and their order are documented on `CheckRollup`.
 * Items that are not checks are ignored.
 */
export function rollupChecks(contexts: readonly unknown[]): CheckRollup {
  const counts: Record<CheckState, number> = {
    failed: 0,
    running: 0,
    queued: 0,
    passed: 0,
  };
  for (const item of contexts) {
    const state = checkState(item);
    if (state) counts[state]++;
  }
  if (counts.failed) return "failed";
  if (counts.running) return "running";
  if (counts.queued) return counts.passed ? "tentative" : "pending";
  return counts.passed ? "passed" : "none";
}
