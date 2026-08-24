import type {
  BranchRef,
  ChangedFile,
  Commit,
  DiffRequest,
  GitRepository,
  RepositorySnapshot,
  Stash,
  Submodule,
  Worktree,
  CommandResult,
} from "./types";

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

export async function runGit(
  args: string[],
  cwd?: string,
): Promise<CommandResult> {
  const p = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  const result = { stdout, stderr, exitCode };
  if (exitCode) throw new GitCommandError(args, result);
  return result;
}

export function parseStatus(data: string): ChangedFile[] {
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

export function parseRefs(data: string): BranchRef[] {
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
export function parseLog(data: string): Commit[] {
  return data
    .split(data.includes("\x1e") ? /[\x1e\0]/ : "\0")
    .filter(Boolean)
    .map((x) => {
      const f = x.replace(/^\n+/, "").split("\x1f");
      return {
        sha: f[0] ?? "",
        parents: (f[1] ?? "").split(" ").filter(Boolean),
        author: f[2] ?? "",
        authorEmail: f[3] ?? "",
        authoredAt: f[4] ?? "",
        subject: f[5] ?? "",
        decorations: (f[6] ?? "")
          .split(", ")
          .map((v) => v.trim())
          .filter(Boolean),
        body: f
          .slice(7)
          .join("\x1f")
          .replace(/^\n+|\n+$/g, ""),
      };
    });
}
export const parsePorcelainStatus = parseStatus;
export const parseForEachRef = parseRefs;
export const parseStructuredLog = parseLog;
export function parseStashes(data: string): Stash[] {
  return data
    .split("\0")
    .filter(Boolean)
    .map((x) => {
      const [ref, sha, at, subject] = x.split("\t");
      return {
        ref: ref ?? "",
        sha: sha ?? "",
        createdAt: at ?? "",
        subject: subject ?? "",
      };
    });
}
export function parseNameStatus(data: string): ChangedFile[] {
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

export class GitRepositoryService implements GitRepository {
  readonly root: string;
  private constructor(root: string) {
    this.root = root;
  }
  static async open(path = process.cwd()): Promise<GitRepositoryService> {
    const r = await runGit(["rev-parse", "--show-toplevel"], path);
    return new GitRepositoryService(r.stdout.trim());
  }
  private async git(args: string[]) {
    return runGit(args, this.root);
  }
  async snapshot(limit = 1000): Promise<RepositorySnapshot> {
    const [st, refs, log, stash, wt, sm, head] = await Promise.all([
      this.git(["status", "--porcelain=v2", "--branch", "-z"]),
      this.git([
        "for-each-ref",
        // %(HEAD) marks the checked-out local branch.  Explicitly emit the
        // record terminator: for-each-ref otherwise separates records with
        // newlines, which makes the tabular parser see all refs as one row.
        "--format=%(refname)\t%(objectname)\t%(HEAD)%00",
        "refs/heads",
        "refs/remotes",
      ]),
      this.git([
        "log",
        "-z",
        "--all",
        "--date-order",
        `-${limit}`,
        "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%D%x1f%b%x1e",
      ]).catch(() => ({ stdout: "", stderr: "", exitCode: 0 })),
      this.git(["stash", "list", "--format=%gd\t%H\t%cr\t%s\0"]).catch(() => ({
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
      submodules: parseSubmodules(sm.stdout),
      commits: parseLog(log.stdout),
    };
  }
  async diff(r: DiffRequest) {
    const result = await this.git(
      r.commit
        ? [
            "show",
            "--format=",
            "--no-ext-diff",
            ...(r.context !== undefined ? [`-U${r.context}`] : []),
            r.commit,
            "--",
            ...(r.path ? [r.path] : []),
          ]
        : [
            "diff",
            "--no-ext-diff",
            ...(r.staged ? ["--cached"] : []),
            ...(r.context !== undefined ? [`-U${r.context}`] : []),
            "--",
            ...(r.path ? [r.path] : []),
          ],
    );
    if (result.stdout || r.commit || r.staged || !r.path) return result.stdout;
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
    return parseNameStatus(
      (
        await this.git([
          "diff-tree",
          "--root",
          "--no-commit-id",
          "--name-status",
          "-z",
          "-r",
          "-M",
          sha,
        ])
      ).stdout,
    );
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
  async commit(m: string) {
    await this.git(["commit", "-m", m]);
  }
  async switchBranch(n: string) {
    await this.git(["switch", n]);
    await this.git(["submodule", "sync", "--recursive"]);
    await this.git(["submodule", "update", "--init", "--recursive"]);
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
  async deleteBranch(n: string, f = false) {
    await this.git(["branch", f ? "-D" : "-d", n]);
  }
  async fetch(r?: string) {
    await this.git(["fetch", ...(r ? [r] : [])]);
  }
  async pull(rebase = false) {
    await this.git(["pull", ...(rebase ? ["--rebase"] : [])]);
  }
  async push(r?: string, s = false) {
    await this.git(["push", ...(s ? ["-u"] : []), ...(r ? [r] : [])]);
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
}
export const createGitRepository = GitRepositoryService.open;
export function parseWorktrees(s: string): Worktree[] {
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
export function parseSubmodules(s: string): Submodule[] {
  return s
    .split("\n")
    .filter(Boolean)
    .map((x) => {
      const rest = x.slice(42).trim();
      const match = rest.match(/^(.*?)(?: \((.*)\))?$/);
      return {
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
