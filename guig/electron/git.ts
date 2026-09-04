import { execFile, spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  BranchRef,
  ChangedFile,
  CommandResult,
  Commit,
  CommitPage,
  DiffRequest,
  GitRepository,
  RepositorySnapshot,
  ResetMode,
  Stash,
  Submodule,
  WorkingStatus,
  Worktree,
} from "../shared/types.js";

const execFileAsync = promisify(execFile);

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
 * The GUI cannot answer prompts, so credential requests are disabled outright:
 * Git fails fast with a clear error instead of blocking on an invisible prompt.
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
  if (signal?.aborted) throw new GitCommandAbortedError(args);
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      signal,
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
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
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    if (signal?.aborted) throw new GitCommandAbortedError(args);
    const err = error as {
      code?: string | number;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    if (err.code === "ABORT_ERR") throw new GitCommandAbortedError(args);
    const result: CommandResult = {
      stdout: typeof err.stdout === "string" ? err.stdout : "",
      stderr: typeof err.stderr === "string" ? err.stderr : (err.message ?? ""),
      exitCode: typeof err.code === "number" ? err.code : 1,
    };
    throw new GitCommandError(args, result);
  }
}

/** Fields the history graph and commit details are built from. */
const LOG_FORMAT =
  "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI%x1f%s%x1f%D%x1f%b%x1e";

// Pure parsers ported from `src/git/parsers.ts` (no Bun APIs involved).

function parseStatus(data: string): ChangedFile[] {
  const out: ChangedFile[] = [];
  const parts = data.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const r = parts[i]!;
    if (!r || r === "#") continue;
    if (r.startsWith("1 ") || r.startsWith("2 ") || r.startsWith("u ")) {
      const fields = r.split(" ");
      const xy = fields[1] ?? "  ";
      const path = afterSpaces(
        r,
        r.startsWith("u ") ? 10 : r.startsWith("2 ") ? 9 : 8,
      );
      const renamed = r.startsWith("2 ");
      const original = renamed ? parts[++i] : undefined;
      out.push({
        path,
        originalPath: original,
        state: r.startsWith("u ") ? "conflicted" : stateFor(xy),
        staged: xy[0] !== ".",
        unstaged: xy[1] !== ".",
      });
    } else if (r.startsWith("? "))
      out.push({
        path: r.slice(2),
        state: "untracked",
        staged: false,
        unstaged: true,
      });
  }
  return out;
}

function afterSpaces(value: string, count: number): string {
  let at = -1;
  for (let i = 0; i < count; i++) at = value.indexOf(" ", at + 1);
  return at < 0 ? "" : value.slice(at + 1);
}

function stateFor(xy: string): ChangedFile["state"] {
  const x = xy.replace(".", "");
  if (x.includes("U")) return "conflicted";
  const c = x[0];
  return c === "A"
    ? "added"
    : c === "D"
      ? "deleted"
      : c === "R"
        ? "renamed"
        : c === "C"
          ? "copied"
          : "modified";
}

function parseRefs(data: string): BranchRef[] {
  return data
    .split("\0")
    .filter(Boolean)
    .map((r) => {
      const [name, sha, sym] = r.replace(/^\n+/, "").split("\t");
      const fullName = name ?? "";
      return {
        name: fullName.replace(/^refs\/(heads|remotes)\//, ""),
        fullName,
        sha: sha ?? "",
        current: sym === "*",
        remote: fullName.startsWith("refs/remotes/"),
        upstream: undefined,
      };
    });
}

const detach = (value: string) =>
  value.length ? value.padEnd(value.length + 1).slice(0, -1) : "";

const POOL_LIMIT = 4096;
const pool = new Map<string, string>();
function shared(value: string): string {
  const held = pool.get(value);
  if (held !== undefined) return held;
  if (pool.size >= POOL_LIMIT) pool.clear();
  const copy = detach(value);
  pool.set(copy, copy);
  return copy;
}

/** Shared by every commit with no parents and every commit with no refs. */
const NONE: readonly string[] = Object.freeze([]);

function parseLog(data: string): Commit[] {
  return (
    data
      // eslint-disable-next-line no-control-regex
      .split(data.includes("\x1e") ? /[\x1e\0]/ : "\0")
      .filter(Boolean)
      .map((x) => {
        const f = x.replace(/^\n+/, "").split("\x1f");
        const parents = (f[1] ?? "").split(" ").filter(Boolean).map(detach);
        const decorations = (f[9] ?? "")
          .split(", ")
          .map((v) => v.trim())
          .filter(Boolean)
          .map(detach);
        const body = f
          .slice(10)
          .join("\x1f")
          .replace(/^\n+|\n+$/g, "");
        return {
          sha: detach(f[0] ?? ""),
          parents: parents.length ? parents : NONE,
          author: shared(f[2] ?? ""),
          authorEmail: shared(f[3] ?? ""),
          authoredAt: detach(f[4] ?? ""),
          committer: shared(f[5] ?? ""),
          committerEmail: shared(f[6] ?? ""),
          committedAt: detach(f[7] ?? ""),
          subject: detach(f[8] ?? ""),
          decorations: decorations.length ? decorations : NONE,
          body: detach(body),
        };
      })
  );
}

function parseStashes(data: string): Stash[] {
  return data
    .split(/[\0\n]+/)
    .filter(Boolean)
    .map((x) => {
      const fields: string[] = [];
      let rest = x;
      for (let i = 0; i < 3; i++) {
        const separator = rest.indexOf("\t");
        if (separator < 0) break;
        fields.push(rest.slice(0, separator));
        rest = rest.slice(separator + 1);
      }
      const [ref, sha, at] = fields;
      const subject = rest;
      const branch =
        /^(?:WIP on|On) ([^:]+):/.exec(subject)?.[1]?.trim() || undefined;
      return {
        ref: ref ?? "",
        sha: sha ?? "",
        createdAt: at ?? "",
        subject: subject ?? "",
        branch,
      };
    });
}

function parseNameStatus(data: string): ChangedFile[] {
  const parts = data.split("\0");
  const files: ChangedFile[] = [];
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++];
    if (!status) continue;
    const code = status[0] ?? "M";
    const first = parts[i++] ?? "";
    const renamed = code === "R" || code === "C";
    const path = renamed ? (parts[i++] ?? first) : first;
    files.push({
      path,
      originalPath: renamed ? first : undefined,
      state:
        code === "A"
          ? "added"
          : code === "D"
            ? "deleted"
            : code === "R"
              ? "renamed"
              : code === "C"
                ? "copied"
                : "modified",
      staged: false,
      unstaged: false,
    });
  }
  return files;
}

function parseWorktrees(s: string): Worktree[] {
  return s
    .split("\n\n")
    .filter(Boolean)
    .map((x) => {
      const l = x.split("\n");
      return {
        path: l.find((v) => v.startsWith("worktree "))?.slice(9) ?? "",
        sha: l.find((v) => v.startsWith("HEAD "))?.slice(5) ?? "",
        branch: l
          .find((v) => v.startsWith("branch "))
          ?.slice(7)
          .replace(/^refs\/heads\//, ""),
        bare: l.includes("bare"),
        detached: l.includes("detached"),
        locked: l.find((v) => v.startsWith("locked"))?.slice(7),
        prunable: l.find((v) => v.startsWith("prunable"))?.slice(9),
      };
    });
}

/** Parses NUL-delimited `git config --null --get-regexp` submodule paths. */
function parseSubmoduleNames(s: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const entry of s.split("\0")) {
    const newline = entry.indexOf("\n");
    if (newline < 0) continue;
    const key = entry.slice(0, newline);
    const path = entry.slice(newline + 1);
    const match = key.match(/^submodule\.(.+)\.path$/);
    if (match && path) names.set(path, match[1]!);
  }
  return names;
}

function parseSubmodules(
  s: string,
  names: ReadonlyMap<string, string> = new Map(),
): Submodule[] {
  return s
    .split("\n")
    .filter(Boolean)
    .map((x) => {
      const rest = x.slice(42).trim();
      const match = rest.match(/^(.*?)(?: \((.*)\))?$/);
      return {
        name: names.get(match?.[1] ?? rest),
        sha: x.slice(1, 41),
        path: match?.[1] ?? rest,
        description: match?.[2],
        state:
          x[0] === "-"
            ? "uninitialized"
            : x[0] === "+"
              ? "different"
              : x[0] === "U"
                ? "conflicted"
                : "clean",
      };
    });
}

function parseTracking(s: string) {
  const records = s.split("\0");
  const upstream = records
    .find((x) => x.startsWith("# branch.upstream "))
    ?.slice(18);
  const ab = records
    .find((x) => x.startsWith("# branch.ab "))
    ?.match(/\+(\d+) -(\d+)/);
  return {
    upstream,
    ahead: Number(ab?.[1] ?? 0),
    behind: Number(ab?.[2] ?? 0),
  };
}

/**
 * Subcommands after which cached history can no longer be trusted.
 * Kept in sync with the TUI backend.
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
  private constructor(root: string) {
    this.root = root;
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
          // %(HEAD) marks the checked-out local branch. Explicitly emit the
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
   * remains without a second walk; it is dropped before returning. Unlike the
   * TUI backend, which holds a streaming walk open across pages, this port
   * issues one `git log` per page with `--skip`, using the same exclusions
   * and structured format.
   */
  async commitPage(
    limit = DEFAULT_HISTORY_PAGE,
    skip = 0,
  ): Promise<CommitPage> {
    const wanted = Math.max(1, Math.trunc(limit));
    const offset = Math.max(0, Math.trunc(skip));
    // The walk excludes refs/stash, so each stash tip is layered back here as
    // a single row: one WIP entry per stash instead of the tip plus its
    // internal index/untracked commits. Tips are newest-first and recent, so
    // the merged sequence is tips followed by the walk.
    const tips = await this.stashTipCommits();
    if (offset >= tips.length) {
      const commits = await this.readWalk(offset - tips.length, wanted + 1);
      const complete = commits.length <= wanted;
      return {
        commits: complete ? commits : commits.slice(0, wanted),
        complete,
      };
    }
    const head = tips.slice(offset, offset + wanted + 1);
    if (head.length > wanted)
      return { commits: head.slice(0, wanted), complete: false };
    const rest = await this.readWalk(0, wanted + 1 - head.length);
    const commits = [...head, ...rest];
    const complete = commits.length <= wanted;
    return { commits: complete ? commits : commits.slice(0, wanted), complete };
  }
  /**
   * One `git log` page with the same exclusions and format as the TUI walk.
   * An empty repository reports an error rather than empty output; that is
   * the empty page.
   */
  private async readWalk(offset: number, count: number): Promise<Commit[]> {
    try {
      const out = await runGit(
        [
          "log",
          "-z",
          // Stash tips and their internal index/untracked parents live under
          // refs/stash. They have their own section via `stash list`, so keep
          // them out of the history walk where one stash reads as 2-3 rows.
          // `--exclude` must precede `--all` to take effect.
          "--exclude=refs/stash",
          "--all",
          ...(offset ? [`--skip=${offset}`] : []),
          `-${count}`,
          LOG_FORMAT,
        ],
        this.root,
      );
      return parseLog(out.stdout);
    } catch (error) {
      if (error instanceof GitCommandError) return [];
      throw error;
    }
  }
  /**
   * One history row per stash: the WIP tip with only its first parent, so the
   * graph draws a single lane back to the base commit instead of extra lanes
   * for the internal index/untracked commits the walk excludes.
   *
   * Read-only: uses runGit directly so the `stash` subcommand does not trip
   * the history-mutating invalidation.
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
  /** Ends cached history state; the service stays usable after it. */
  dispose() {
    this.invalidateHistory();
  }
  /** Drops cached history because it may have moved underneath us. */
  private invalidateHistory() {
    // This port reads each history page with a fresh `git log`, so there is
    // no held-open walk to restart. The hook stays so mutating commands keep
    // their explicit invalidation point in sync with the TUI backend.
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
    await new Promise<void>((resolve, reject) => {
      const child = spawn("git", a, {
        cwd: this.root,
        env: { ...process.env, ...NON_INTERACTIVE_ENV },
      });
      let out = "";
      let err = "";
      child.stdout?.on("data", (d) => {
        out += d;
      });
      child.stderr?.on("data", (d) => {
        err += d;
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code)
          reject(
            new GitCommandError(a, {
              stdout: out,
              stderr: err,
              exitCode: code,
            }),
          );
        else resolve();
      });
      child.stdin?.on("error", () => undefined);
      if (child.stdin) {
        child.stdin.write(patch);
        child.stdin.end();
      } else {
        reject(
          new GitCommandError(a, {
            stdout: out,
            stderr: "no stdin",
            exitCode: 1,
          }),
        );
      }
    });
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
    const dir = await mkdtemp(join(tmpdir(), "guig-reword-"));
    const messagePath = `${dir}/message`;
    const sequenceEditor = `${dir}/sequence-editor`;
    const editor = `${dir}/editor`;
    await writeFile(messagePath, message);
    // Rebase abbreviates object IDs in its todo file, so match its stable
    // seven-character prefix rather than requiring the full SHA.
    const targetPrefix = target.slice(0, 7);
    await writeFile(
      sequenceEditor,
      `#!/bin/sh\nsed -i -e '0,/^pick ${targetPrefix}/s//reword ${targetPrefix}/' -e '0,/^merge -C ${targetPrefix}/s//merge -c ${targetPrefix}/' "$1"\n`,
    );
    await writeFile(editor, `#!/bin/sh\ncat "${messagePath}" > "$1"\n`);
    await chmod(sequenceEditor, 0o700);
    await chmod(editor, 0o700);
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
    if (!n.trim() || n.includes("\0"))
      throw new Error("A branch name is required");
    if (n.startsWith("-")) throw new Error(`Invalid branch name: ${n}`);
    await this.git(["switch", "--", n]);
    await this.syncSubmodules();
  }
  private async syncSubmodules() {
    await this.git(["submodule", "sync", "--recursive"]);
    await this.git(["submodule", "update", "--init", "--recursive"]);
  }
  async checkoutCommit(sha: string) {
    if (!sha.trim() || sha.includes("\0"))
      throw new Error("A commit is required for checkout");
    if (sha.startsWith("-")) throw new Error(`Invalid revision: ${sha}`);
    await this.git(["checkout", "--detach", "--", sha]);
    await this.syncSubmodules();
  }
  async checkoutRemoteBranch(local: string, remote: string, reset = false) {
    // `-C` moves an existing local branch onto the remote tip, discarding the
    // local commits that are not on the remote.
    await this.git(["switch", reset ? "-C" : "-c", local, "--track", remote]);
    await this.syncSubmodules();
  }
  async resetTo(sha: string, mode: ResetMode = "mixed") {
    if (!sha.trim() || sha.includes("\0"))
      throw new Error("A commit is required for reset");
    if (sha.startsWith("-")) throw new Error(`Invalid revision: ${sha}`);
    await this.git(["reset", `--${mode}`, "--", sha]);
    if (mode === "hard") await this.syncSubmodules();
  }
  async rebaseOnto(ref: string) {
    if (!ref.trim() || ref.includes("\0"))
      throw new Error("A ref is required for rebase");
    if (ref.startsWith("-")) throw new Error(`Invalid revision: ${ref}`);
    await this.git(["rebase", "--", ref]);
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
    if (!n.trim() || n.includes("\0"))
      throw new Error("A branch name is required");
    if (!remote && n.startsWith("-"))
      throw new Error(`Invalid branch name: ${n}`);
    await this.git([
      "branch",
      ...(remote ? ["-r"] : []),
      f ? "-D" : "-d",
      "--",
      n,
    ]);
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
