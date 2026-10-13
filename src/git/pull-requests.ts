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
}

/** Raised when `gh` runs longer than the timeout. */
export class GhTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`GitHub CLI timed out after ${Math.round(timeoutMs / 1000)} s.`);
    this.name = "GhTimeoutError";
  }
}

const GH_TIMEOUT_MS = 15_000;

/** `gh` must never prompt, page, color, or animate: Tuig owns the terminal. */
export const GH_NON_INTERACTIVE_ENV: Record<string, string> = {
  GH_PROMPT_DISABLED: "1",
  GH_PAGER: "cat",
  GH_SPINNER_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
  GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
  NO_COLOR: "1",
};

/**
 * One GraphQL request for the signed-in login, the open pull requests, and the
 * ones that ask for the user's review. Checks come as counts per state, which
 * GitHub answers much faster than the full check list `gh pr list` asks for.
 */
const LIST_QUERY = `query($owner: String!, $repo: String!, $review: String!) {
  viewer { login }
  repository(owner: $owner, name: $repo) {
    pullRequests(states: OPEN, first: 100, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number title url isDraft updatedAt
        author { login }
        headRefName headRefOid isCrossRepository
        commits(last: 1) { nodes { commit { statusCheckRollup { contexts {
          checkRunCountsByState { state count }
          statusContextCountsByState { state count }
        } } } } }
      }
    }
  }
  review: search(query: $review, type: ISSUE, first: 100) {
    nodes { ... on PullRequest { number } }
  }
}`;

// gh fills `{owner}` and `{repo}` from the repository's GitHub remote.
const LIST_ARGS = [
  "api",
  "graphql",
  "-F",
  "owner={owner}",
  "-F",
  "repo={repo}",
  "-F",
  "review=repo:{owner}/{repo} is:pr is:open review-requested:@me",
  "-f",
  `query=${LIST_QUERY}`,
];

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
  // gh-missing and not-github do not change while Tuig runs.
  let permanent: Failure | undefined;

  /** Runs the query and returns its `data`, or the failure. Throws only on abort. */
  async function query(
    signal?: AbortSignal,
  ): Promise<{ data: Record<string, unknown> } | Failure> {
    let result: CommandResult;
    try {
      result = await run(LIST_ARGS, { cwd: root, signal });
    } catch (error) {
      if (signal?.aborted) throw abortError();
      return describeFailure(error);
    }
    const data = parseData(result.stdout);
    // A failed review search exits non-zero but still returns the list.
    if (asRecord(data?.repository)) return { data: data! };
    if (result.exitCode !== 0) return classifyExit(result);
    return {
      reason: "error",
      message: "GitHub CLI returned unreadable pull request data.",
    };
  }

  return {
    async list(signal): Promise<PullRequestList> {
      if (permanent) return { available: false, ...permanent };
      const answer = await query(signal);
      if (!("data" in answer)) {
        if (answer.reason === "gh-missing" || answer.reason === "not-github")
          permanent = answer;
        return { available: false, ...answer };
      }
      const { data } = answer;
      const login = str(asRecord(data.viewer)?.login)?.toLowerCase();
      const requested = new Set(
        nodes(data.review)
          .map((node) => asRecord(node)?.number)
          .filter((n): n is number => Number.isInteger(n)),
      );
      const pullRequests = nodes(asRecord(data.repository)?.pullRequests)
        .map((entry) => parsePullRequest(entry, login, requested))
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

function parseData(text: string): Record<string, unknown> | undefined {
  try {
    return asRecord(asRecord(JSON.parse(text))?.data);
  } catch {
    return undefined;
  }
}

/** The `nodes` array of a GraphQL connection, or none. */
function nodes(connection: unknown): unknown[] {
  const value = asRecord(connection)?.nodes;
  return Array.isArray(value) ? value : [];
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
    checks: rollupCheckCounts(
      asRecord(
        asRecord(asRecord(nodes(raw.commits)[0])?.commit)?.statusCheckRollup,
      )?.contexts,
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
 * Sorts a check run state. A finished run reports its conclusion as its state.
 * FAILURE, CANCELLED, TIMED_OUT, ACTION_REQUIRED, STALE, STARTUP_FAILURE, and
 * COMPLETED without a conclusion count as failed. Counts cannot tell a new
 * in-flight value from a new final one, so unknown values count as running,
 * which never shows green and keeps the faster refresh.
 */
function checkRunState(state: string): CheckState {
  switch (state) {
    case "SUCCESS":
    case "SKIPPED":
    case "NEUTRAL":
      return "passed";
    case "QUEUED":
    case "WAITING":
    case "PENDING":
    case "REQUESTED":
      return "queued";
    case "IN_PROGRESS":
      return "running";
    case "COMPLETED":
    case "FAILURE":
    case "CANCELLED":
    case "TIMED_OUT":
    case "ACTION_REQUIRED":
    case "STALE":
    case "STARTUP_FAILURE":
      return "failed";
    default:
      return "running";
  }
}

/** Sorts a commit status state. */
function statusContextState(state: string): CheckState {
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

/**
 * Combines the check counts of a `statusCheckRollup.contexts` connection into
 * one status. The rules and their order are documented on `CheckRollup`.
 * Malformed entries are ignored.
 */
export function rollupCheckCounts(contexts: unknown): CheckRollup {
  const counts: Record<CheckState, number> = {
    failed: 0,
    running: 0,
    queued: 0,
    passed: 0,
  };
  const raw = asRecord(contexts);
  const add = (entries: unknown, sort: (state: string) => CheckState) => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      const state = str(asRecord(entry)?.state)?.toUpperCase();
      const count = asRecord(entry)?.count;
      if (state && typeof count === "number" && count > 0)
        counts[sort(state)] += count;
    }
  };
  add(raw?.checkRunCountsByState, checkRunState);
  add(raw?.statusContextCountsByState, statusContextState);
  if (counts.failed) return "failed";
  if (counts.running) return "running";
  if (counts.queued) return counts.passed ? "tentative" : "pending";
  return counts.passed ? "passed" : "none";
}
