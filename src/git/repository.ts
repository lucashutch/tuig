import type {
  DiffRequest,
  GitRepository,
  RepositorySnapshot,
  CommitPage,
  Commit,
  CommandResult,
  ResetMode,
  WorkingStatus,
} from "./types";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** Raised when a caller aborted a running Git command. */
export class GitCommandAbortedError extends Error {
  constructor(public readonly args: string[]) {
    super(`git ${args.join(" ")}: cancelled`);
    this.name = "GitCommandAbortedError";
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
): Promise<CommandResult> {
  const p = Bun.spawn(["git", ...args], {
    cwd,
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
  if (signal) {
    const abort = () => p.kill();
    if (signal.aborted) p.kill();
    else signal.addEventListener("abort", abort, { once: true });
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  const result = { stdout, stderr, exitCode };
  if (signal?.aborted) throw new GitCommandAbortedError(args);
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
  private constructor(root: string) {
    this.root = root;
    this.walk = new CommitWalk(root);
  }
  static async open(path = process.cwd()): Promise<GitRepositoryService> {
    const r = await runGit(["rev-parse", "--show-toplevel"], path);
    return new GitRepositoryService(r.stdout.trim());
  }
  private async git(args: string[], signal?: AbortSignal) {
    const subcommand = args.find((arg) => !arg.startsWith("-"));
    if (subcommand && HISTORY_MUTATING.has(subcommand))
      this.invalidateHistory();
    return runGit(args, this.root, undefined, signal);
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
    const [st, refs, log, stash, wt, sm, submoduleConfig, head] =
      await Promise.all([
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
          "refs/heads",
          "refs/remotes",
        ]),
        this.commitPage(limit),
        this.git([
          "stash",
          "list",
          "--format=%gd%x09%H%x09%cr%x09%s%x00",
        ]).catch(() => ({
          stdout: "",
          stderr: "",
          exitCode: 0,
        })),
        this.git(["worktree", "list", "--porcelain"]),
        this.git(["submodule", "status", "--recursive"]).catch(() => ({
          stdout: "",
          stderr: "",
          exitCode: 0,
        })),
        // Read this through git rather than parsing the INI file ourselves: it
        // correctly handles quoting, escapes, spaces, and subsection names.
        this.git([
          "config",
          "--null",
          "--file",
          ".gitmodules",
          "--get-regexp",
          "^submodule\\..*\\.path$",
        ]).catch(() => ({ stdout: "", stderr: "", exitCode: 0 })),
        this.git(["symbolic-ref", "--short", "HEAD"]).catch(() => ({
          stdout: "",
          stderr: "",
          exitCode: 0,
        })),
      ]);
    const tracking = parseTracking(st.stdout);
    return {
      root: this.root,
      branch: head.stdout.trim() || undefined,
      upstream: tracking.upstream,
      ahead: tracking.ahead,
      behind: tracking.behind,
      files: parseStatus(st.stdout),
      branches: parseRefs(refs.stdout),
      stashes: parseStashes(stash.stdout),
      worktrees: parseWorktrees(wt.stdout),
      submodules: parseSubmodules(
        sm.stdout,
        parseSubmoduleNames(submoduleConfig.stdout),
      ),
      commits: log.commits,
      commitsComplete: log.complete,
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
    const commits = await this.walk.read(offset, wanted + 1);
    const complete = commits.length <= wanted;
    return { commits: complete ? commits : commits.slice(0, wanted), complete };
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
  async diff(r: DiffRequest) {
    if (r.commit) return this.commitDiff(r);
    const result = await this.git([
      "diff",
      "--no-ext-diff",
      ...(r.staged ? ["--cached"] : []),
      ...(r.context !== undefined ? [`-U${r.context}`] : []),
      "--",
      ...(r.path ? [r.path] : []),
    ]);
    if (result.stdout || r.staged || !r.path) return result.stdout;
    try {
      await this.git(["ls-files", "--error-unmatch", "--", r.path]);
      return "";
    } catch {
      try {
        await this.git([
          "diff",
          "--no-index",
          "--no-ext-diff",
          ...(r.context !== undefined ? [`-U${r.context}`] : []),
          "--",
          "/dev/null",
          r.path,
        ]);
      } catch (error) {
        if (error instanceof GitCommandError && error.result.exitCode === 1)
          return error.result.stdout;
        throw error;
      }
    }
    return "";
  }
  async commitFiles(sha: string) {
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
  private async commitDetails(sha: string) {
    const resolved = (
      await this.git(["rev-parse", "--verify", `${sha}^{commit}`])
    ).stdout.trim();
    const parents = (
      await this.git(["show", "-s", "--format=%P", resolved])
    ).stdout
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    let untrackedParent: string | undefined;
    if (parents.length === 3) {
      const stashShas = (
        await this.git(["reflog", "show", "--format=%H", "refs/stash"]).catch(
          () => ({ stdout: "" }),
        )
      ).stdout.split("\n");
      const thirdParents = (
        await this.git(["show", "-s", "--format=%P", parents[2]!])
      ).stdout.trim();
      // Only stash commits currently named by the stash reflog get the special
      // third-parent treatment. This avoids reinterpreting arbitrary octopus
      // merges, while the parentless third commit is Git's untracked tree.
      if (stashShas.includes(resolved) && !thirdParents)
        untrackedParent = parents[2];
    }
    return { resolved, parents, untrackedParent };
  }
  private async commitDiff(r: DiffRequest): Promise<string> {
    const { resolved, parents, untrackedParent } = await this.commitDetails(
      r.commit!,
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
    const tracked = (await this.git(args)).stdout;
    if (!untrackedParent) return tracked;
    const untracked = (
      await this.git([
        "show",
        "--format=",
        "--no-ext-diff",
        ...(r.context !== undefined ? [`-U${r.context}`] : []),
        untrackedParent,
        "--",
        ...(r.path ? [r.path] : []),
      ])
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
export const createGitRepository = GitRepositoryService.open;
