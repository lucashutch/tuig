import type {
  DiffRequest,
  GitRepository,
  RepositorySnapshot,
  CommitPage,
  Commit,
  CommandResult,
  LineBlame,
  ResetMode,
  WorkingStatus,
} from "./types";
import { access, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  parseLog,
  parseNameStatus,
  parseRefs,
  parseStashes,
  parseStatus,
  parseSubmoduleNames,
  parseSubmodules,
  parseTracking,
  parseWorktrees,
} from "./parsers";

export {
  parseForEachRef,
  parseLog,
  parseNameStatus,
  parsePorcelainStatus,
  parseRefs,
  parseStashes,
  parseStatus,
  parseStructuredLog,
  parseSubmoduleNames,
  parseSubmodules,
  parseWorktrees,
} from "./parsers";

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

async function nearbyRepositories(path: string, pathExists: boolean) {
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
const NON_INTERACTIVE_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
};

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

/** Fields the history graph and commit details are built from. */
const LOG_FORMAT =
  "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI%x1f%s%x1f%D%x1f%b%x1e";

/**
 * A single long-lived `git log` walk that sequential pages are read from.
 *
 * `--skip=N` makes git re-walk the first N commits on every request, so paging
 * through history is quadratic: on a 101591-commit repository one page costs
 * 20ms at skip=0, 51ms at skip=50000 and 103ms at skip=100000, and reading all
 * 116k rows spends 26.7s inside git. Holding the walk open and continuing to
 * read from it makes a page cost only what it emits.
 */
class CommitWalk {
  /** Commits kept behind the read position so a small rewind avoids a restart. */
  private static readonly TAIL = 8;
  /**
   * How long an unused walk is kept before it is closed.
   *
   * Bun reads a subprocess ahead of what the consumer pulls, so an open walk
   * over a large log holds the rest of that log in memory: on a 101591-commit
   * repository an idle app sat at 154MB RSS against a 90MB baseline. One
   * scroll burst is a run of back-to-back reads, so closing shortly after the
   * last one keeps the whole burst on one walk and leaves an idle app holding
   * neither a process nor its buffers.
   */
  private static readonly IDLE_MS = 500;
  /**
   * Bounds on how many commits one spawned `git log` may emit.
   *
   * Bun drains a subprocess as fast as it writes rather than at the pace the
   * consumer pulls, so an unbounded walk buffers and parses the whole
   * remaining log: 116k commits cost about 15MB the moment the first page is
   * read, which showed up as a 154MB idle app against a 90MB baseline.
   * A walk therefore starts barely larger than the page that opened it and
   * doubles on each continuation. An idle app, which reads one page per
   * refresh, never buffers more than that page; a scroll burst reaches the
   * cap after a handful of continuations, whose `--skip` is still shallow.
   */
  private static readonly MIN_CHUNK = 512;
  private static readonly MAX_CHUNK = 20000;
  private proc?: Bun.Subprocess<"ignore", "pipe", "ignore">;
  private chunks?: AsyncIterator<Uint8Array>;
  private decoder = new TextDecoder();
  private partial = "";
  private queue: Commit[] = [];
  /** True once the walk position and tail describe a real walk. */
  private valid = false;
  /** True once git stopped emitting, whether exhausted or killed. */
  private finished = true;
  private position = 0;
  /** Walk position at which the current `git log` stops emitting. */
  private chunkEnd = 0;
  private chunk = CommitWalk.MIN_CHUNK;
  private tail: Commit[] = [];
  private lock: Promise<unknown> = Promise.resolve();
  private idle?: ReturnType<typeof setTimeout>;
  constructor(private readonly root: string) {}
  /** Reads up to `count` commits starting `offset` commits into the walk. */
  read(offset: number, count: number): Promise<Commit[]> {
    // A walk has one read position, so concurrent readers would interleave
    // their pages; serialise them instead.
    if (this.idle) clearTimeout(this.idle);
    const run = this.lock.then(() => this.readNow(offset, count));
    run.then(
      () => this.closeWhenIdle(),
      () => this.closeWhenIdle(),
    );
    this.lock = run.catch(() => undefined);
    return run;
  }
  private async readNow(offset: number, count: number): Promise<Commit[]> {
    if (
      !this.valid ||
      offset > this.position ||
      offset < this.position - this.tail.length
    )
      this.start(offset, false, count);
    const reused = this.position - offset;
    const from = this.tail.length - reused;
    const out = reused > 0 ? this.tail.slice(from, from + count) : [];
    while (out.length < count) {
      const commit = await this.next();
      if (!commit) break;
      out.push(commit);
    }
    return out;
  }
  private closeWhenIdle() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.invalidate(), CommitWalk.IDLE_MS);
    // A pending walk must never be the reason the process stays alive.
    this.idle.unref?.();
  }
  private start(offset: number, continuing = false, wanted = 0) {
    const tail = continuing ? this.tail : [];
    const size = continuing
      ? Math.min(CommitWalk.MAX_CHUNK, this.chunk * 2)
      : Math.max(CommitWalk.MIN_CHUNK, wanted);
    this.invalidate();
    this.tail = tail;
    this.chunk = size;
    const proc = Bun.spawn(
      [
        "git",
        "log",
        "-z",
        // Stash tips and their internal index/untracked parents live under
        // refs/stash. They have their own sidebar section via `stash list`,
        // so keep them out of the history walk where one stash reads as 2-3
        // commit-like rows. `--exclude` must precede `--all` to take effect.
        "--exclude=refs/stash",
        "--all",
        ...(offset ? [`--skip=${offset}`] : []),
        `-${size}`,
        LOG_FORMAT,
      ],
      {
        cwd: this.root,
        env: { ...process.env, ...NON_INTERACTIVE_ENV },
        stdout: "pipe",
        // An empty repository has no commits to walk, which git reports as an
        // error rather than as empty output; an empty stream is that answer.
        stderr: "ignore",
      },
    );
    this.proc = proc;
    this.chunks = proc.stdout[Symbol.asyncIterator]();
    this.decoder = new TextDecoder();
    this.valid = true;
    this.finished = false;
    this.position = offset;
    this.chunkEnd = offset + size;
  }
  private async next(): Promise<Commit | undefined> {
    while (!this.queue.length) {
      if (!this.finished) {
        await this.fill();
        continue;
      }
      // A chunk that stopped exactly on its limit is not the end of history,
      // so continue the walk where it left off. Any shorter one is the end.
      if (!this.valid || this.position < this.chunkEnd) break;
      this.start(this.position, true);
    }
    const commit = this.queue.shift();
    if (!commit) return undefined;
    this.position++;
    this.tail.push(commit);
    if (this.tail.length > CommitWalk.TAIL) this.tail.shift();
    return commit;
  }
  private async fill() {
    let chunk;
    try {
      chunk = await this.chunks!.next();
    } catch {
      this.end();
      return;
    }
    if (chunk.done) {
      this.queue.push(...parseLog(this.partial));
      this.partial = "";
      this.end();
      return;
    }
    this.partial += this.decoder.decode(chunk.value, { stream: true });
    // Records end with \x1e and git's -z then separates them with NUL, so
    // parse up to the last terminator and hold the rest for the next chunk.
    const end = this.partial.lastIndexOf("\x1e");
    if (end < 0) return;
    this.queue.push(...parseLog(this.partial.slice(0, end + 1)));
    this.partial = this.partial.slice(end + 1);
  }
  /** Releases the exhausted process, keeping the position and tail usable. */
  private end() {
    this.finished = true;
    this.chunks?.return?.().catch(() => undefined);
    this.proc?.kill();
    this.chunks = undefined;
    this.proc = undefined;
  }
  /** Drops the walk, so the next read starts a fresh one. */
  invalidate() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = undefined;
    this.end();
    this.valid = false;
    this.queue = [];
    this.tail = [];
    this.partial = "";
    this.position = 0;
  }
}

/**
 * Subcommands after which the open history walk can no longer be trusted.
 *
 * A few of these (`reset` for unstaging, `push`) rarely move history, but an
 * unnecessary invalidation only costs one restarted walk, while a missed one
 * would page stale commits.
 */
const HISTORY_MUTATING = new Set([
  "am",
  "branch",
  "checkout",
  "cherry-pick",
  "commit",
  "fetch",
  "merge",
  "pull",
  "push",
  "rebase",
  "reset",
  "revert",
  "stash",
  "switch",
  "tag",
  "worktree",
]);

/** Commits in the first page of history, before any paging. */
export const DEFAULT_HISTORY_PAGE = 250;

export class GitRepositoryService implements GitRepository {
  readonly root: string;
  private readonly walk: CommitWalk;
  private readonly historySignatures = new WeakMap<Commit[], string>();
  private constructor(
    root: string,
    private readonly shallowMetadataPaths: readonly string[],
  ) {
    this.root = root;
    this.walk = new CommitWalk(root);
  }
  static async open(path = process.cwd()): Promise<GitRepositoryService> {
    let pathStat;
    try {
      pathStat = await stat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      throw new NotGitRepositoryError(
        path,
        await nearbyRepositories(path, false),
        "missing",
      );
    }
    if (!pathStat.isDirectory())
      throw new NotGitRepositoryError(path, [], "not-directory");
    const r = await runGit(["rev-parse", "--show-toplevel"], path).catch(
      (error: unknown) => {
        if (
          error instanceof GitCommandError &&
          /not a git repository/i.test(error.result.stderr)
        )
          return nearbyRepositories(path, true).then((suggestions) => {
            throw new NotGitRepositoryError(path, suggestions);
          });
        throw error;
      },
    );
    const root = r.stdout.trim();
    const metadata = await runGit(
      [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "shallow",
        "--git-path",
        "info/grafts",
      ],
      root,
    );
    return new GitRepositoryService(root, metadata.stdout.trim().split("\n"));
  }
  private async git(args: string[], signal?: AbortSignal, maxBytes?: number) {
    const subcommand = args.find((arg) => !arg.startsWith("-"));
    if (subcommand && HISTORY_MUTATING.has(subcommand))
      this.invalidateHistory();
    return runGit(args, this.root, undefined, signal, maxBytes);
  }
  private async gitWithEnv(args: string[], env: Record<string, string>) {
    const subcommand = args.find((arg) => !arg.startsWith("-"));
    if (subcommand && HISTORY_MUTATING.has(subcommand))
      this.invalidateHistory();
    return runGit(args, this.root, env);
  }
  async remoteUrl() {
    return (
      (
        await this.git(["remote", "get-url", "origin"]).catch(() => undefined)
      )?.stdout.trim() || undefined
    );
  }
  async snapshot(limit = DEFAULT_HISTORY_PAGE): Promise<RepositorySnapshot> {
    // A snapshot is the refresh point for new history, so the walk restarts
    // from the tip rather than continuing one taken before a fetch or commit.
    this.invalidateHistory();
    const metadata = await this.readSnapshotMetadata();
    const log = await this.commitPage(limit);
    const snapshot = this.buildSnapshot(metadata, log.commits, log.complete);
    this.historySignatures.set(snapshot.commits, metadata.historySignature);
    return snapshot;
  }
  async refreshSnapshot(
    previous: RepositorySnapshot,
    limit = DEFAULT_HISTORY_PAGE,
  ): Promise<RepositorySnapshot> {
    const metadata = await this.readSnapshotMetadata();
    const priorSignature = this.historySignatures.get(previous.commits);
    if (
      priorSignature === metadata.historySignature &&
      (previous.commitsComplete || previous.commits.length >= limit)
    ) {
      const snapshot = this.buildSnapshot(
        metadata,
        previous.commits,
        previous.commitsComplete,
      );
      this.historySignatures.set(snapshot.commits, metadata.historySignature);
      return snapshot;
    }
    this.invalidateHistory();
    const log = await this.commitPage(limit);
    const snapshot = this.buildSnapshot(metadata, log.commits, log.complete);
    this.historySignatures.set(snapshot.commits, metadata.historySignature);
    return snapshot;
  }
  private async readSnapshotMetadata() {
    const submoduleConfig = await this.git([
      "config",
      "--null",
      "--file",
      ".gitmodules",
      "--get-regexp",
      "^submodule\\..*\\.path$",
    ]).catch(() => ({ stdout: "", stderr: "", exitCode: 0 }));
    const submoduleNames = parseSubmoduleNames(submoduleConfig.stdout);
    const shallowMetadata = Promise.all(
      this.shallowMetadataPaths.map((path) =>
        readFile(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return Buffer.alloc(0);
          throw error;
        }),
      ),
    );
    const [st, allRefs, stash, wt, sm, shallow] = await Promise.all([
      // Polling must not take the index lock: the auto-refresh would
      // otherwise collide with a Git command the user is running elsewhere.
      this.git([
        "--no-optional-locks",
        "status",
        "--porcelain=v2",
        "--branch",
        "-z",
      ]),
      this.git([
        "for-each-ref",
        // %(HEAD) marks the checked-out local branch.  Explicitly emit the
        // record terminator: for-each-ref otherwise separates records with
        // newlines, which makes the tabular parser see all refs as one row.
        "--format=%(refname)\t%(objectname)\t%(HEAD)%00",
      ]),
      this.git(["stash", "list", "--format=%gd%x09%H%x09%cr%x09%s%x00"]).catch(
        () => ({
          stdout: "",
          stderr: "",
          exitCode: 0,
        }),
      ),
      this.git(["worktree", "list", "--porcelain"]),
      (submoduleNames.size
        ? this.git(["submodule", "status", "--recursive"])
        : Promise.resolve({ stdout: "", stderr: "", exitCode: 0 })
      ).catch(() => ({
        stdout: "",
        stderr: "",
        exitCode: 0,
      })),
      shallowMetadata,
    ]);
    const branchHead = st.stdout
      .split("\0")
      .find((record) => record.startsWith("# branch.head "))
      ?.slice(14);
    const headSha = st.stdout
      .split("\0")
      .find((record) => record.startsWith("# branch.oid "))
      ?.slice(13);
    const worktreeHeads = wt.stdout
      .split("\n")
      .filter((line) => line.startsWith("HEAD ") || line.startsWith("branch "))
      .join("\n");
    return {
      st,
      refs: {
        ...allRefs,
        stdout: allRefs.stdout
          .split("\0")
          .filter((record) => /^\n?refs\/(?:heads|remotes)\//.test(record))
          .join("\0"),
      },
      stash,
      wt,
      sm,
      submoduleNames,
      branch:
        branchHead && branchHead !== "(detached)" ? branchHead : undefined,
      headSha:
        headSha && headSha !== "(initial)" && headSha !== "(unknown)"
          ? headSha
          : undefined,
      historySignature: [
        allRefs.stdout,
        st.stdout
          .split("\0")
          .filter(
            (r) =>
              r.startsWith("# branch.oid ") || r.startsWith("# branch.head "),
          )
          .join("\0"),
        worktreeHeads,
        ...shallow.map((contents) => contents.toString("base64")),
      ].join("\x1e"),
    };
  }
  private buildSnapshot(
    metadata: Awaited<ReturnType<GitRepositoryService["readSnapshotMetadata"]>>,
    commits: Commit[],
    commitsComplete: boolean,
  ): RepositorySnapshot {
    const { st, refs, stash, wt, sm, submoduleNames, branch, headSha } =
      metadata;
    const tracking = parseTracking(st.stdout);
    return {
      root: this.root,
      headSha,
      branch,
      upstream: tracking.upstream,
      ahead: tracking.ahead,
      behind: tracking.behind,
      files: parseStatus(st.stdout),
      branches: parseRefs(refs.stdout),
      stashes: parseStashes(stash.stdout),
      worktrees: parseWorktrees(wt.stdout),
      submodules: parseSubmodules(sm.stdout, submoduleNames),
      commits,
      commitsComplete,
    };
  }
  /**
   * Read `limit` commits across every ref, starting `skip` commits in.
   *
   * One extra commit is requested so the caller learns whether older history
   * remains without a second walk; it is dropped before returning. The page
   * is served from a `CommitWalk` held open across calls, so reading pages in
   * sequence costs only the commits each page emits. A `skip` the open walk
   * cannot reach restarts it with `--skip`, which is what every page used to
   * do: that made paging quadratic, at 20ms for the page at skip=0 against
   * 103ms at skip=100000 and 26.7s for all 116k rows of one repository.
   */
  async commitPage(
    limit = DEFAULT_HISTORY_PAGE,
    skip = 0,
  ): Promise<CommitPage> {
    const wanted = Math.max(1, Math.trunc(limit));
    const offset = Math.max(0, Math.trunc(skip));
    // Git's default walk is already newest-first by commit date.
    // `--date-order` only adds the guarantee that no parent is emitted before
    // its children, and buying it costs a walk of the entire history: on a
    // 145k-commit repository that is 910ms of a 950ms snapshot, against 10ms
    // without it, for identical output. The graph layout opens a fresh lane
    // for a commit it has not seen yet, so a clock-skewed parent degrades to
    // an extra lane rather than a fault.
    //
    // The walk excludes refs/stash, so each stash tip is layered back here as
    // a single row: one WIP entry per stash instead of the tip plus its
    // internal index/untracked commits. A stash can outlive newer commits, so
    // merge tips by commit time instead of always putting them at the top.
    const tips = await this.stashTipCommits();
    // At most every tip can occur before this page, so this is the earliest
    // ordinary commit that could occupy `offset`. Including all tips then
    // gives the merged window a known global starting position.
    const walkOffset = Math.max(0, offset - tips.length);
    const localOffset = offset - walkOffset;
    const walked = await this.walk.read(walkOffset, wanted + tips.length + 1);
    const merged = [...tips, ...walked].sort(
      (a, b) => Date.parse(b.committedAt) - Date.parse(a.committedAt),
    );
    const page = merged.slice(localOffset, localOffset + wanted + 1);
    const complete = page.length <= wanted;
    return {
      commits: complete ? page : page.slice(0, wanted),
      complete,
    };
  }
  /**
   * One history row per stash: the WIP tip with only its first parent, so the
   * graph draws a single lane back to the base commit instead of extra lanes
   * for the internal index/untracked commits the walk excludes.
   *
   * Read-only: uses runGit directly so the `stash` subcommand does not trip
   * the history-mutating invalidation that would drop the held-open walk.
   */
  private async stashTipCommits(): Promise<Commit[]> {
    const list = await runGit(
      ["stash", "list", "--format=%H"],
      this.root,
    ).catch(() => undefined);
    const shas = (list?.stdout ?? "")
      .split("\n")
      .map((sha) => sha.trim())
      .filter(Boolean);
    if (!shas.length) return [];
    const order = new Map(shas.map((sha, index) => [sha, index] as const));
    const out = await runGit(
      ["log", "--no-walk", "--decorate", "-z", LOG_FORMAT, ...shas],
      this.root,
    ).catch(() => undefined);
    if (!out) return [];
    const tips = parseLog(out.stdout).map((commit) => ({
      ...commit,
      parents: commit.parents.slice(0, 1),
    }));
    tips.sort((a, b) => (order.get(a.sha) ?? 0) - (order.get(b.sha) ?? 0));
    return tips;
  }
  /** Ends the background history walk; the service stays usable after it. */
  dispose() {
    this.walk.invalidate();
  }
  /** Drops the open walk because history may have moved under it. */
  private invalidateHistory() {
    this.walk.invalidate();
  }
  /**
   * Re-read only the working tree and branch tracking state.
   *
   * Staging a file cannot change history, so the index mutations refresh
   * through this instead of paying for the full snapshot's history walk.
   */
  async workingStatus(): Promise<WorkingStatus> {
    const st = await this.git([
      "--no-optional-locks",
      "status",
      "--porcelain=v2",
      "--branch",
      "-z",
    ]);
    const tracking = parseTracking(st.stdout);
    return {
      upstream: tracking.upstream,
      ahead: tracking.ahead,
      behind: tracking.behind,
      files: parseStatus(st.stdout),
    };
  }
  /** Reads the history of one path on the current branch or from `start`. */
  async fileHistory(path: string, start?: string): Promise<Commit[]> {
    this.validateHistoryPath(path);
    if (start !== undefined) this.validateCommitRef(start);
    const result = await this.git([
      "log",
      "--follow",
      "--decorate",
      "-z",
      LOG_FORMAT,
      ...(start !== undefined ? ["--end-of-options", start] : []),
      "--",
      path,
    ]);
    return parseLog(result.stdout);
  }
  /** Reads commits that changed the ancestry of one line. */
  async lineHistory(
    path: string,
    line: number,
    start = "HEAD",
  ): Promise<Commit[]> {
    this.validateHistoryPath(path);
    if (!Number.isSafeInteger(line) || line < 1)
      throw new RangeError("A positive 1-based line number is required");
    this.validateCommitRef(start);
    const result = await this.git([
      "log",
      "--decorate",
      "-z",
      LOG_FORMAT,
      `-L${line},${line}:${path}`,
      start,
    ]);
    // -L necessarily emits patches between formatted records. Keep only the
    // machine-formatted commit portions before passing them to the log parser.
    const records: string[] = [];
    for (const chunk of result.stdout.split("\u001e")) {
      let field = chunk.indexOf("\u001f");
      while (field >= 40) {
        let start = field;
        while (start > 0 && /[0-9a-f]/.test(chunk[start - 1]!)) start--;
        const sha = chunk.slice(start, field);
        if (sha.length >= 40) {
          records.push(`${chunk.slice(start)}\u001e`);
          break;
        }
        field = chunk.indexOf("\u001f", field + 1);
      }
    }
    return parseLog(records.join(""));
  }
  /** Blames one line at a commit, defaulting to HEAD. */
  async blameLine(
    path: string,
    line: number,
    commit = "HEAD",
  ): Promise<LineBlame> {
    this.validateHistoryPath(path);
    if (!Number.isSafeInteger(line) || line < 1)
      throw new RangeError("A positive 1-based line number is required");
    this.validateCommitRef(commit);
    // Unlike log/show, blame does not accept --end-of-options. Validating the
    // ref keeps it from becoming an option, and -- disambiguates the path.
    const blame = await this.git([
      "blame",
      "--line-porcelain",
      `-L${line},${line}`,
      commit,
      "--",
      path,
    ]);
    const header = /^([0-9a-f]+) (\d+) (\d+)(?: \d+)?$/m.exec(blame.stdout);
    if (!header)
      throw new Error(`Git returned no blame information for ${path}:${line}`);
    const sha = header[1]!;
    const originalLine = Number(header[2]);
    const finalLine = Number(header[3]);
    const filename = blame.stdout
      .split("\n")
      .find((entry) => entry.startsWith("filename "))
      ?.slice("filename ".length);
    const details = await this.git([
      "show",
      "-s",
      "--decorate",
      "-z",
      LOG_FORMAT,
      "--end-of-options",
      `${sha}^{commit}`,
    ]);
    const blamedCommit = parseLog(details.stdout)[0];
    if (!blamedCommit)
      throw new Error(`Git returned no commit information for ${sha}`);
    return {
      commit: blamedCommit,
      originalPath: filename ? parseGitQuotedPath(filename) : path,
      originalLine,
      finalPath: path,
      finalLine,
    };
  }
  private validateHistoryPath(path: string) {
    if (!path || path.includes("\0"))
      throw new Error("A file path is required");
  }
  async diff(r: DiffRequest) {
    if (r.base || r.target) return this.comparisonDiff(r);
    if (r.commit) return this.commitDiff(r);
    const result = await this.git(
      [
        "diff",
        "--no-ext-diff",
        ...(r.staged ? ["--cached"] : []),
        ...(r.context !== undefined ? [`-U${r.context}`] : []),
        "--",
        ...(r.path ? [r.path] : []),
      ],
      r.signal,
      r.maxBytes,
    );
    if (result.stdout || r.staged || !r.path) return result.stdout;
    try {
      await this.git(["ls-files", "--error-unmatch", "--", r.path], r.signal);
      return "";
    } catch {
      try {
        await this.git(
          [
            "diff",
            "--no-index",
            "--no-ext-diff",
            ...(r.context !== undefined ? [`-U${r.context}`] : []),
            "--",
            "/dev/null",
            r.path,
          ],
          r.signal,
          r.maxBytes,
        );
      } catch (error) {
        if (error instanceof GitCommandError && error.result.exitCode === 1)
          return error.result.stdout;
        throw error;
      }
    }
    return "";
  }
  async commitFiles(sha: string, base?: string) {
    if (base) {
      this.validateCommitRef(base);
      this.validateCommitRef(sha);
      return parseNameStatus(
        (
          await this.git([
            "diff",
            "--name-status",
            "-z",
            "-M",
            "--end-of-options",
            base,
            sha,
          ])
        ).stdout,
      );
    }
    const { resolved, parents, untrackedParent } =
      await this.commitDetails(sha);
    const outputs = [
      (
        await this.git([
          "diff-tree",
          "--root",
          "--no-commit-id",
          "--name-status",
          "-z",
          "-r",
          "-M",
          ...(parents[0] ? [parents[0], resolved] : [resolved]),
        ])
      ).stdout,
    ];
    if (untrackedParent)
      outputs.push(
        (
          await this.git([
            "diff-tree",
            "--root",
            "--no-commit-id",
            "--name-status",
            "-z",
            "-r",
            "-M",
            untrackedParent,
          ])
        ).stdout,
      );
    const files = outputs.flatMap(parseNameStatus);
    return files.filter(
      (file, index) =>
        files.findIndex((other) => other.path === file.path) === index,
    );
  }
  private async commitDetails(sha: string, signal?: AbortSignal) {
    this.validateCommitRef(sha);
    const [resolved = "", parentLine = ""] = (
      await this.git(
        [
          "show",
          "-s",
          "--format=%H%x00%P",
          "--end-of-options",
          `${sha}^{commit}`,
        ],
        signal,
      )
    ).stdout
      .trim()
      .split("\0");
    const parents = parentLine.split(/\s+/).filter(Boolean);
    let untrackedParent: string | undefined;
    if (parents.length === 3) {
      const stashShas = (
        await this.git(
          ["reflog", "show", "--format=%H", "refs/stash"],
          signal,
        ).catch(() => ({ stdout: "" }))
      ).stdout.split("\n");
      const thirdParents = (
        await this.git(["show", "-s", "--format=%P", parents[2]!], signal)
      ).stdout.trim();
      // Only stash commits currently named by the stash reflog get the special
      // third-parent treatment. This avoids reinterpreting arbitrary octopus
      // merges, while the parentless third commit is Git's untracked tree.
      if (stashShas.includes(resolved) && !thirdParents)
        untrackedParent = parents[2];
    }
    return { resolved, parents, untrackedParent };
  }
  private validateCommitRef(sha: string) {
    if (!sha.trim() || sha.includes("\0") || sha.startsWith("-"))
      throw new Error("A commit is required");
  }
  private async comparisonDiff(r: DiffRequest): Promise<string> {
    if (!r.base || !r.target)
      throw new Error("Both comparison commits are required");
    this.validateCommitRef(r.base);
    this.validateCommitRef(r.target);
    return (
      await this.git(
        [
          "diff",
          "--no-ext-diff",
          ...(r.context !== undefined ? [`-U${r.context}`] : []),
          "--end-of-options",
          r.base,
          r.target,
          "--",
          ...diffPaths(r),
        ],
        r.signal,
        r.maxBytes,
      )
    ).stdout;
  }
  private async commitDiff(r: DiffRequest): Promise<string> {
    const { resolved, parents, untrackedParent } = await this.commitDetails(
      r.commit!,
      r.signal,
    );
    const args = parents[0]
      ? [
          "diff",
          "--no-ext-diff",
          ...(r.context !== undefined ? [`-U${r.context}`] : []),
          parents[0],
          resolved,
          "--",
          ...(r.path ? [r.path] : []),
        ]
      : [
          "show",
          "--format=",
          "--no-ext-diff",
          ...(r.context !== undefined ? [`-U${r.context}`] : []),
          resolved,
          "--",
          ...(r.path ? [r.path] : []),
        ];
    const tracked = (await this.git(args, r.signal, r.maxBytes)).stdout;
    if (!untrackedParent) return tracked;
    const untracked = (
      await this.git(
        [
          "show",
          "--format=",
          "--no-ext-diff",
          ...(r.context !== undefined ? [`-U${r.context}`] : []),
          untrackedParent,
          "--",
          ...(r.path ? [r.path] : []),
        ],
        r.signal,
        r.maxBytes === undefined
          ? undefined
          : Math.max(
              0,
              r.maxBytes - new TextEncoder().encode(tracked).byteLength,
            ),
      )
    ).stdout;
    return tracked + untracked;
  }
  async stage(p: string[]) {
    await this.git(["add", "--", ...p]);
  }
  async unstage(p: string[]) {
    await this.git(["reset", "HEAD", "--", ...p]);
  }
  async applyPatch(patch: string, reverse = false) {
    const a = ["apply", "--cached", ...(reverse ? ["--reverse"] : [])];
    const x = Bun.spawn(["git", ...a], {
      cwd: this.root,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    x.stdin.write(patch);
    x.stdin.end();
    const [o, e, c] = await Promise.all([
      new Response(x.stdout).text(),
      new Response(x.stderr).text(),
      x.exited,
    ]);
    if (c) throw new GitCommandError(a, { stdout: o, stderr: e, exitCode: c });
  }
  async discardAll() {
    // Untracked files are not restorable, so they are removed separately.
    await this.discard(["."]);
    await this.git(["clean", "-fd"]);
  }
  async commit(m: string) {
    await this.git(["commit", "-m", m]);
  }
  async amendCommit(message: string) {
    await this.git(["commit", "--amend", "-m", message]);
  }
  async rewordCommit(sha: string, message: string) {
    const status = await this.git(["status", "--porcelain"]);
    if (status.stdout)
      throw new Error("Cannot reword a commit with a dirty worktree");
    const branch = await this.git(["symbolic-ref", "--quiet", "HEAD"]).catch(
      () => undefined,
    );
    if (!branch)
      throw new Error("Cannot reword a commit while HEAD is detached");
    const target = (
      await this.git(["rev-parse", "--verify", `${sha}^{commit}`])
    ).stdout.trim();
    try {
      await this.git(["merge-base", "--is-ancestor", target, "HEAD"]);
    } catch {
      throw new Error(
        "Can only reword commits reachable from the current HEAD",
      );
    }
    const parents = (
      await this.git(["show", "-s", "--format=%P", target])
    ).stdout.trim();
    this.invalidateHistory();
    const dir = await mkdtemp(join(tmpdir(), "tuig-reword-"));
    const messagePath = `${dir}/message`;
    const sequenceEditor = `${dir}/sequence-editor`;
    const editor = `${dir}/editor`;
    await Bun.write(messagePath, message);
    // Rebase abbreviates object IDs in its todo file, so match its stable
    // seven-character prefix rather than requiring the full SHA.
    const targetPrefix = target.slice(0, 7);
    await Bun.write(
      sequenceEditor,
      `#!/bin/sh\nsed -i -e '0,/^pick ${targetPrefix}/s//reword ${targetPrefix}/' -e '0,/^merge -C ${targetPrefix}/s//merge -c ${targetPrefix}/' "$1"\n`,
    );
    await Bun.write(editor, `#!/bin/sh\ncat "${messagePath}" > "$1"\n`);
    await Bun.spawn(["chmod", "+x", sequenceEditor, editor]).exited;
    try {
      await runGit(
        parents
          ? [
              "rebase",
              "-i",
              "--rebase-merges",
              "--onto",
              parents.split(" ")[0]!,
              `${target}^`,
            ]
          : ["rebase", "-i", "--rebase-merges", "--root"],
        this.root,
        { GIT_SEQUENCE_EDITOR: sequenceEditor, GIT_EDITOR: editor },
      );
    } catch (error) {
      // A failed interactive rebase leaves repository state behind unless it is
      // explicitly aborted. Keep the original error, which explains why the
      // requested reword failed, rather than replacing it with abort cleanup.
      await this.git(["rebase", "--abort"]).catch(() => undefined);
      throw error;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  async switchBranch(n: string) {
    await this.git(["switch", n]);
    await this.syncSubmodules();
  }
  private async syncSubmodules() {
    await this.git(["submodule", "sync", "--recursive"]);
    await this.git(["submodule", "update", "--init", "--recursive"]);
  }
  async checkoutCommit(sha: string) {
    await this.git(["checkout", "--detach", sha]);
    await this.syncSubmodules();
  }
  async checkoutRemoteBranch(local: string, remote: string, reset = false) {
    // `-C` moves an existing local branch onto the remote tip, discarding the
    // local commits that are not on the remote.
    await this.git(["switch", reset ? "-C" : "-c", local, "--track", remote]);
    await this.syncSubmodules();
  }
  async resetTo(sha: string, mode: ResetMode = "mixed") {
    await this.git(["reset", `--${mode}`, sha]);
    if (mode === "hard") await this.syncSubmodules();
  }
  async rebaseOnto(ref: string) {
    await this.git(["rebase", ref]);
  }
  async cherryPick(sha: string) {
    if (!sha.trim() || sha.includes("\0"))
      throw new Error("A commit is required for cherry-pick");
    // Keep a ref supplied by a caller from being interpreted as a cherry-pick
    // option (for example, `--abort`).
    await this.git(["cherry-pick", "--", sha]);
  }
  /** Creates a lightweight tag; annotated tags are deliberately not implied. */
  async createTag(name: string, target?: string) {
    if (!name.trim() || name.includes("\0"))
      throw new Error("A tag name is required");
    if (target !== undefined && (!target.trim() || target.includes("\0")))
      throw new Error("A tag target is required");
    // Let Git validate the complete ref name so names containing `..`, a
    // trailing dot, or other invalid ref syntax are rejected before creation.
    await this.git([
      "check-ref-format",
      "--allow-onelevel",
      `refs/tags/${name}`,
    ]);
    // `--` also makes otherwise valid names beginning with `-` safe.
    await this.git([
      "tag",
      "--",
      name,
      ...(target !== undefined ? [target] : []),
    ]);
  }
  async pushTag(name: string, remote?: string, signal?: AbortSignal) {
    await this.validateTagName(name);
    await this.git(
      ["push", ...(remote ? [remote] : []), "--", `refs/tags/${name}`],
      signal,
    );
  }
  async deleteTag(name: string) {
    await this.validateTagName(name);
    await this.git(["tag", "--delete", "--", name]);
  }
  private async validateTagName(name: string) {
    if (!name.trim() || name.includes("\0"))
      throw new Error("A tag name is required");
    await this.git([
      "check-ref-format",
      "--allow-onelevel",
      `refs/tags/${name}`,
    ]);
  }
  async createBranch(n: string, s?: string, c = false) {
    await this.git([
      "branch",
      ...(c ? ["--create-reflog"] : []),
      n,
      ...(s ? [s] : []),
    ]);
    if (c) await this.switchBranch(n);
  }
  async deleteBranch(n: string, f = false, remote = false) {
    await this.git(["branch", ...(remote ? ["-r"] : []), f ? "-D" : "-d", n]);
  }
  async deleteRemoteBranch(name: string, signal?: AbortSignal) {
    const remotes = (await this.git(["remote"])).stdout.trim().split("\n");
    const remote = remotes
      .filter((candidate) => candidate && name.startsWith(`${candidate}/`))
      .sort((a, b) => b.length - a.length)[0];
    if (!remote) throw new Error(`No configured remote for ${name}`);
    const branch = name.slice(remote.length + 1);
    await this.git(["check-ref-format", `refs/heads/${branch}`]);
    await this.git(
      ["push", "--delete", "--", remote, `refs/heads/${branch}`],
      signal,
    );
  }
  async fetch(r?: string, signal?: AbortSignal) {
    // Remove remote-tracking refs that disappeared from the remote. Without
    // pruning, the sidebar and graph keep showing branches deleted upstream.
    await this.git(["fetch", "--prune", ...(r ? [r] : [])], signal);
  }
  async pull(rebase = false, signal?: AbortSignal) {
    await this.git(["pull", ...(rebase ? ["--rebase"] : [])], signal);
  }
  async push(r?: string, s = false, signal?: AbortSignal) {
    await this.git(["push", ...(s ? ["-u"] : []), ...(r ? [r] : [])], signal);
  }
  async stash(m?: string, i = false) {
    await this.git([
      "stash",
      "push",
      ...(i ? ["--include-untracked"] : []),
      ...(m ? ["-m", m] : []),
    ]);
  }
  async applyStash(r: string, p = false) {
    await this.git(["stash", p ? "pop" : "apply", r]);
  }
  async popStash(r: string) {
    await this.applyStash(r, true);
  }
  async dropStash(r: string) {
    await this.git(["stash", "drop", r]);
  }
  async renameStash(ref: string, message: string) {
    const match = /^stash@\{(\d+)\}$/.exec(ref);
    if (!match) throw new Error(`Invalid stash reference: ${ref}`);
    if (!message.trim() || message.includes("\0"))
      throw new Error("A stash name is required");
    const output = (await this.git(["stash", "list", "--format=%H%x00%gs%x00"]))
      .stdout;
    const fields = output.split("\0");
    const entries: { sha: string; message: string }[] = [];
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const sha = fields[index]?.trim();
      if (!sha) continue;
      const subject = fields[index + 1] ?? "";
      entries.push({ sha, message: subject });
    }
    const target = Number(match[1]);
    if (!entries[target]) throw new Error(`Stash not found: ${ref}`);
    const original = entries[target]!.sha;
    const originalMessage = entries[target]!.message;
    const tree = (
      await this.git(["rev-parse", "--verify", `${original}^{tree}`])
    ).stdout.trim();
    const parents = (
      await this.git(["rev-list", "--parents", "-n", "1", original])
    ).stdout
      .trim()
      .split(" ")
      .slice(1);
    const identity = (
      await this.git([
        "show",
        "-s",
        "--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI",
        original,
      ])
    ).stdout.split("\0");
    const prefix = /^(?:(?:WIP on|On) [^:]*: )/.exec(
      entries[target]!.message,
    )?.[0];
    const renamedMessage = `${prefix ?? ""}${message}`;
    entries[target]!.sha = (
      await this.gitWithEnv(
        [
          "commit-tree",
          tree,
          ...parents.flatMap((parent) => ["-p", parent]),
          "-m",
          renamedMessage,
        ],
        {
          GIT_AUTHOR_NAME: identity[0] ?? "",
          GIT_AUTHOR_EMAIL: identity[1] ?? "",
          GIT_AUTHOR_DATE: identity[2] ?? "",
          GIT_COMMITTER_NAME: identity[3] ?? "",
          GIT_COMMITTER_EMAIL: identity[4] ?? "",
          GIT_COMMITTER_DATE: identity[5]?.trim() ?? "",
        },
      )
    ).stdout.trim();
    entries[target]!.message = renamedMessage;
    const originals = entries.map((entry, index) => ({
      ...entry,
      sha: index === target ? original : entry.sha,
      message: index === target ? originalMessage : entry.message,
    }));
    const backupPrefix = `refs/tuig/stash-rename-${process.pid}-${Date.now()}`;
    for (const [index, entry] of entries.entries())
      await this.git(["update-ref", `${backupPrefix}/${index}`, entry.sha]);
    const rebuild = async (
      stack: readonly { sha: string; message: string }[],
    ) => {
      await this.git(["reflog", "expire", "--expire=all", "refs/stash"]).catch(
        () => undefined,
      );
      await this.git(["update-ref", "-d", "refs/stash"]);
      for (const entry of stack.toReversed())
        await this.git(["stash", "store", "-m", entry.message, entry.sha]);
    };
    let cleanupBackups = false;
    try {
      // Rebuild oldest first because Git provides no reflog-message edit. The
      // temporary refs keep every stash reachable while refs/stash is absent.
      await rebuild(entries);
      cleanupBackups = true;
    } catch (error) {
      try {
        await rebuild(originals);
        cleanupBackups = true;
      } catch {
        // Keep the backup refs when restoration fails so no stash is lost.
      }
      throw error;
    } finally {
      if (cleanupBackups)
        for (const index of entries.keys())
          await this.git([
            "update-ref",
            "-d",
            `${backupPrefix}/${index}`,
          ]).catch(() => undefined);
    }
  }
  async updateSubmodule(path: string, init = false) {
    this.validateSubmodulePath(path);
    await this.git([
      "submodule",
      "update",
      ...(init ? ["--init"] : []),
      "--recursive",
      "--",
      path,
    ]);
  }
  async syncSubmodule(path: string) {
    this.validateSubmodulePath(path);
    await this.git(["submodule", "sync", "--recursive", "--", path]);
  }
  private validateSubmodulePath(path: string) {
    if (!path.trim() || path.includes("\0"))
      throw new Error("A submodule path is required");
  }
  async addWorktree(path: string, branch?: string, create = false) {
    await this.git([
      "worktree",
      "add",
      ...(create && branch ? ["-b", branch] : []),
      path,
      ...(!create && branch ? [branch] : []),
    ]);
  }
  async removeWorktree(path: string, force = false) {
    await this.git(["worktree", "remove", ...(force ? ["--force"] : []), path]);
  }
  async lockWorktree(path: string, lock = true, reason?: string) {
    await this.git([
      "worktree",
      lock ? "lock" : "unlock",
      ...(lock && reason ? ["--reason", reason] : []),
      path,
    ]);
  }
  async discard(paths: string[]) {
    await this.git(["restore", "--worktree", "--", ...paths]);
  }
}
function diffPaths(request: DiffRequest): string[] {
  return [
    ...new Set([request.originalPath, request.path].filter(Boolean)),
  ] as string[];
}

/** Decodes the C-style path quoting used by blame's porcelain output. */
function parseGitQuotedPath(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  const bytes: number[] = [];
  const escapes: Record<string, number> = {
    a: 7,
    b: 8,
    t: 9,
    n: 10,
    v: 11,
    f: 12,
    r: 13,
    '"': 34,
    "\\": 92,
  };
  const inner = path.slice(1, -1);
  for (let index = 0; index < inner.length; index++) {
    const character = inner[index]!;
    if (character !== "\\") {
      const literal = String.fromCodePoint(inner.codePointAt(index)!);
      bytes.push(...new TextEncoder().encode(literal));
      index += literal.length - 1;
      continue;
    }
    const escaped = inner[++index];
    if (escaped === undefined) break;
    if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      while (octal.length < 3 && /[0-7]/.test(inner[index + 1] ?? ""))
        octal += inner[++index]!;
      bytes.push(Number.parseInt(octal, 8));
    } else {
      const decoded = escapes[escaped];
      if (decoded !== undefined) bytes.push(decoded);
      else bytes.push(...new TextEncoder().encode(escaped));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}
export const createGitRepository = GitRepositoryService.open;
