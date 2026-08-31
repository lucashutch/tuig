import type {
  BranchRef,
  ChangedFile,
  Commit,
  Stash,
  Submodule,
  Worktree,
} from "./types";

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
/**
 * Detach a string from the buffer it was cut out of.
 *
 * JavaScriptCore represents the result of `slice` and `split` as a view onto
 * the original string, so one retained commit field pins the whole `git log`
 * chunk it came from. Pages run to 20000 commits, several megabytes of text
 * each, and every page stayed alive for as long as one field of it did.
 *
 * `padEnd` is the cheap way out. It has to build a longer string, so the
 * result owns its characters, and trimming the pad back off leaves a view onto
 * that copy rather than onto the chunk. Rope tricks such as
 * `(" " + v).slice(1)` look equivalent and are not: JSC resolves the rope to
 * the original fiber and the chunk stays pinned. Measured over twenty 10MB
 * chunks holding one field each, `padEnd` and `split("").join("")` both end at
 * 0.2MB where the rope ends at 191MB, and `padEnd` costs 42ns a field against
 * 193ns.
 */
const detach = (value: string) =>
  value.length ? value.padEnd(value.length + 1).slice(0, -1) : "";

/**
 * Shared storage for values that repeat across commits.
 *
 * Author and committer identities repeat heavily: a 40000-commit range of one
 * repository held 87 distinct names. Handing out one string per distinct value
 * saved about 380 bytes per commit. The pool is cleared rather than grown
 * without limit, since a name that stops recurring should not be kept forever.
 */
const POOL_LIMIT = 4096;
const pool = new Map<string, string>();
function shared(value: string): string {
  const held = pool.get(value);
  if (held !== undefined) return held;
  if (pool.size >= POOL_LIMIT) pool.clear();
  // Detached before it is kept, or the pooled view would pin its chunk for as
  // long as the value keeps recurring, which is the whole session.
  const copy = detach(value);
  pool.set(copy, copy);
  return copy;
}

/** Shared by every commit with no parents and every commit with no refs. */
const NONE: readonly string[] = Object.freeze([]);

export function parseLog(data: string): Commit[] {
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
        // Both `join` and `replace` hand the input straight back when there is
        // one field and nothing to trim, which is the common case, so the body
        // arrives here as a chunk view like every other field.
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
export const parsePorcelainStatus = parseStatus;
export const parseForEachRef = parseRefs;
export const parseStructuredLog = parseLog;
export function parseStashes(data: string): Stash[] {
  return (
    data
      // `stash list` appends the requested NUL terminator to its normal newline
      // record separator, so records are commonly separated by `\0\n`.
      .split(/[\0\n]+/)
      .filter(Boolean)
      .map((x) => {
        // Subjects are free-form and may themselves contain tabs. Only the
        // first three separators belong to the machine-readable fields.
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
        return {
          ref: ref ?? "",
          sha: sha ?? "",
          createdAt: at ?? "",
          subject: subject ?? "",
        };
      })
  );
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
/** Parses NUL-delimited `git config --null --get-regexp` submodule paths. */
export function parseSubmoduleNames(s: string): Map<string, string> {
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
export function parseSubmodules(
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
export function parseTracking(s: string) {
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
