/** Reads history pages from one long-lived `git log` walk and tracks when it goes stale. */
import { NON_INTERACTIVE_ENV } from "./process";
import { parseLog } from "./parsers";
import type { Commit } from "./types";

/** Fields the history graph and commit details are built from. */
export const LOG_FORMAT =
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
export class CommitWalk {
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
export const HISTORY_MUTATING = new Set([
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
