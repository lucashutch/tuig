/** Previews and runs an undo of the latest commit-like reflog entry on the current branch. */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type { CommandResult, UndoPreview } from "./types";

type GitRunner = (args: string[]) => Promise<CommandResult>;
type GitEnvRunner = (
  args: string[],
  env: Record<string, string>,
) => Promise<CommandResult>;

export async function getUndoPreview(git: GitRunner): Promise<UndoPreview> {
  const branch = (
    await git(["symbolic-ref", "--quiet", "HEAD"]).catch(() => undefined)
  )?.stdout.trim();
  if (!branch) throw new Error("Cannot undo while HEAD is detached");
  const paths = (
    await git([
      "rev-parse",
      "--path-format=absolute",
      ...[
        "logs/HEAD",
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "rebase-merge",
        "rebase-apply",
        "sequencer",
        "BISECT_START",
      ].flatMap((path) => ["--git-path", path]),
    ])
  ).stdout
    .trim()
    .split("\n");
  for (const path of paths.slice(1)) {
    if (
      await stat(path).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      )
    )
      throw new Error("Cannot undo while a Git operation is active");
  }
  const status = await git([
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignored=matching",
    "--ignore-submodules=none",
  ]);
  const statusEntries = status.stdout.split("\0").filter(Boolean);
  const ignoredPaths = statusEntries
    .filter((entry) => entry.startsWith("!! "))
    .map((entry) => entry.slice(3).replace(/\/$/, ""));
  if (statusEntries.some((entry) => !entry.startsWith("!! ")))
    throw new Error("Cannot undo with tracked changes or untracked files");
  // Read the raw log: its old object ID is the actual operation boundary.
  // Hash all bytes so even identical entries appended in one second are stale.
  const log = await readFile(paths[0]!).catch(() => {
    throw new Error("Cannot undo: HEAD reflog is unavailable");
  });
  const entries = log.toString("utf8").trimEnd().split("\n");
  const latest = entries.at(-1) ?? "";
  const match = /^([0-9a-f]{40,64}) ([0-9a-f]{40,64}) [^\t]+\t(.+)$/.exec(
    latest,
  );
  if (!match) throw new Error("Cannot undo: invalid HEAD reflog entry");
  const target = match[1]!;
  const head = match[2]!;
  const action = match[3]!;
  // Reflog messages are user-controlled, not authenticated provenance.
  // This allowlist assumes ordinary Git-generated messages in a trusted repo.
  if (action.startsWith("tuig undo"))
    throw new Error("Cannot undo the previous undo");
  if (
    !/^(commit: |commit \(amend\): |reset: moving to |merge .+: )/.test(action)
  )
    throw new Error(`Cannot undo unsupported reflog action: ${action}`);
  // Cherry-pick logs do not record the invocation boundary. A completed
  // sequence cannot reliably be distinguished from separate single picks.
  if (/^0+$/.test(target)) throw new Error("Cannot undo an initial commit");
  if (head === target)
    throw new Error("Cannot undo: latest reflog entry did not move HEAD");
  const current = (await git(["rev-parse", "--verify", "HEAD"])).stdout.trim();
  if (current !== head)
    throw new Error("Cannot undo: HEAD changed while reading reflog");
  await git(["cat-file", "-e", `${target}^{commit}`]);
  if (ignoredPaths.length) {
    // reset --keep can overwrite ignored content. Check both prefix
    // directions: a target file can replace a directory, or need a directory
    // where an ignored file currently exists. Matching ignored directories
    // are treated as occupied without walking their potentially large trees.
    const targetPaths = (
      await git(["ls-tree", "-r", "-z", "--name-only", target])
    ).stdout
      .split("\0")
      .filter(Boolean);
    if (
      ignoredPaths.some((ignored) =>
        targetPaths.some(
          (tracked) =>
            tracked === ignored ||
            tracked.startsWith(`${ignored}/`) ||
            ignored.startsWith(`${tracked}/`),
        ),
      )
    )
      throw new Error(
        "Cannot undo: target paths overlap ignored untracked files or directories",
      );
  }
  return {
    head,
    target,
    branch,
    action,
    reflogToken: createHash("sha256").update(log).digest("hex"),
  };
}

export async function undo(
  git: GitRunner,
  gitWithEnv: GitEnvRunner,
  preview: UndoPreview,
): Promise<void> {
  const current = await getUndoPreview(git);
  if (
    (["head", "target", "branch", "action", "reflogToken"] as const).some(
      (key) => current[key] !== preview[key],
    )
  )
    throw new Error("Cannot undo: preview is stale; refresh and try again");
  // reset has no expected-old-HEAD option. External Git commands can race
  // after validation; callers must not run concurrent repository mutations.
  await gitWithEnv(
    ["reset", "--keep", "--no-recurse-submodules", current.target],
    {
      GIT_REFLOG_ACTION: "tuig undo",
    },
  );
}
