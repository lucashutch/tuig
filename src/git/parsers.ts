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
export function parseLog(data: string): Commit[] {
  return (
    data
      // eslint-disable-next-line no-control-regex
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
          committer: f[5] ?? "",
          committerEmail: f[6] ?? "",
          committedAt: f[7] ?? "",
          subject: f[8] ?? "",
          decorations: (f[9] ?? "")
            .split(", ")
            .map((v) => v.trim())
            .filter(Boolean),
          body: f
            .slice(10)
            .join("\x1f")
            .replace(/^\n+|\n+$/g, ""),
        };
      })
  );
}
export const parsePorcelainStatus = parseStatus;
export const parseForEachRef = parseRefs;
export const parseStructuredLog = parseLog;
export function parseStashes(data: string): Stash[] {
  return data
    .split("\0")
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
