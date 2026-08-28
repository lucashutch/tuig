import type { InputRenderable, TextareaRenderable } from "@opentui/core";
import type {
  BranchRef,
  ChangedFile,
  GitRepository,
  RepositorySnapshot,
  ResetMode,
  Stash,
  Worktree,
} from "../git/types.js";
import { splitPatchHunks } from "../git/hunks.js";
import { displayBranchName, shortSha } from "./history.js";
import {
  menuWidth,
  type ConfirmRequest,
  type GraphMenuAction,
  type GraphMenuItem,
} from "./graph-menu.js";
import type { ToolbarAction } from "./runtime-presentation.js";
import type { RuntimePopupController } from "./runtime-popup.js";

export interface RuntimeCommandsContext {
  repository: GitRepository;
  popupController: RuntimePopupController;
  promptInput: InputRenderable;
  composerSummary: InputRenderable;
  composerBody: TextareaRenderable;
  snapshot?: RepositorySnapshot;
  syncedAt?: number;
  suppressEnterUntil: number;
  discardArmed: boolean;
  /** Label of the mutation currently running, when one is. */
  busy?: string;
  /** Controller for the running remote mutation, when one is cancellable. */
  mutationAbort?: AbortController;
  namePrompt?: {
    title: string;
    placeholder: string;
    run: (value: string) => Promise<void>;
  };
  editingCommitSha?: string;
  amend: boolean;
  amendDraft?: { summary: string; body: string };
  editReturnState?: {
    summary: string;
    body: string;
    amend: boolean;
    amendDraft?: { summary: string; body: string };
  };
  terminalWidth: number;
  terminalHeight: number;
  mode: "staged" | "unstaged";
  files(section?: "staged" | "unstaged"): ChangedFile[];
  selectedFile(): ChangedFile | undefined;
  copy(text: string): boolean;
  refresh(message?: string): Promise<void>;
  /** Refresh path for mutations that cannot have changed history. */
  refreshWorkingStatus(message?: string): Promise<void>;
  paintComposer(): void;
  notify(text: string, tone?: "info" | "error" | "busy"): void;
  fail(error: unknown): void;
}

/**
 * Runs one repository mutation at a time. Overlapping commands would race on
 * the index and refs, so while one is in flight new requests are refused.
 * Remote operations also get an abort controller so Escape can cancel them.
 */
export async function perform(
  context: RuntimeCommandsContext,
  label: string,
  action: (signal?: AbortSignal) => Promise<void>,
  remote = false,
  // Index-only work leaves history alone, so it can skip the history walk.
  scope: "history" | "working" = "history",
) {
  if (context.busy !== undefined)
    return context.notify(`${context.busy} is still running`, "error");
  context.busy = label;
  const abort = remote ? new AbortController() : undefined;
  context.mutationAbort = abort;
  context.notify(label, "busy");
  try {
    await action(abort?.signal);
    if (remote) context.syncedAt = Date.now();
    await (scope === "working"
      ? context.refreshWorkingStatus()
      : context.refresh());
  } catch (error) {
    if (error instanceof Error && error.name === "GitCommandAbortedError")
      context.notify(`Cancelled ${label.toLowerCase()}`);
    else context.fail(error);
  } finally {
    context.busy = undefined;
    context.mutationAbort = undefined;
  }
}

/**
 * Escape hatch for a hung remote operation. Local mutations are fast and
 * middle-of-command cancellation can leave the index inconsistent, so only
 * cancellable remote work is aborted here.
 */
export function cancelActiveMutation(context: RuntimeCommandsContext) {
  const abort = context.mutationAbort;
  if (!abort) return false;
  abort.abort();
  return true;
}

export async function runToolbarAction(
  context: RuntimeCommandsContext,
  action: ToolbarAction,
) {
  if (action === "refresh") return void context.refresh();
  if (action === "fetch")
    return void perform(
      context,
      "Fetching…",
      (signal) => context.repository.fetch(undefined, signal),
      true,
    );
  if (action === "pull")
    return void perform(
      context,
      "Pulling…",
      (signal) => context.repository.pull(false, signal),
      true,
    );
  if (action === "push")
    return void perform(
      context,
      "Pushing…",
      (signal) => context.repository.push(undefined, false, signal),
      true,
    );
  if (action === "stash")
    return void perform(context, "Stashing…", () =>
      context.repository.stash(undefined, true),
    );
  const stash = context.snapshot?.stashes[0];
  if (!stash) return context.notify("No stash to pop", "error");
  await perform(context, `Popping ${stash.ref}…`, () =>
    context.repository.applyStash(stash.ref, true),
  );
}

export function confirmThen(
  context: RuntimeCommandsContext,
  request: ConfirmRequest,
  run: () => Promise<void>,
) {
  const items: GraphMenuItem[] = [
    ...request.lines.map((label) => ({ label, disabled: true })),
    { label: "", separator: true },
    { label: request.confirmLabel, destructive: request.destructive },
    { label: "Cancel" },
  ];
  const width = menuWidth(items);
  context.popupController.open(
    request.title,
    items,
    Math.max(0, Math.floor((context.terminalWidth - width) / 2)),
    Math.max(0, Math.floor((context.terminalHeight - items.length) / 2)),
    (item) => {
      if (item.label === request.confirmLabel) void run();
    },
  );
}

export function openNamePrompt(
  context: RuntimeCommandsContext,
  title: string,
  placeholder: string,
  run: (value: string) => Promise<void>,
) {
  context.namePrompt = { title, placeholder, run };
  context.promptInput.value = "";
  const items: GraphMenuItem[] = [
    { label: " ", disabled: true },
    { label: "Enter confirm · Esc cancel", disabled: true },
  ];
  const width = Math.max(menuWidth(items), 28);
  context.popupController.open(
    title,
    items,
    Math.max(0, Math.floor((context.terminalWidth - width) / 2)),
    Math.max(0, Math.floor((context.terminalHeight - 4) / 2)),
    () => undefined,
    true,
  );
  context.promptInput.placeholder = placeholder;
  context.promptInput.visible = true;
  context.popupController.paint();
  setTimeout(() => context.promptInput.focus(), 0);
}

export async function submitNamePrompt(context: RuntimeCommandsContext) {
  const prompt = context.namePrompt;
  if (!prompt) return;
  const value = context.promptInput.value.trim();
  if (!value) return context.notify("A name is required", "error");
  context.suppressEnterUntil = Date.now() + 100;
  setTimeout(() => {
    if (Date.now() >= context.suppressEnterUntil)
      context.suppressEnterUntil = 0;
  }, 100);
  context.popupController.close();
  await prompt.run(value);
}

export async function checkoutBranch(
  context: RuntimeCommandsContext,
  branch: BranchRef,
) {
  if (branch.current) return context.notify(`Already on ${branch.name}`);
  if (!branch.remote)
    return perform(context, `Switching to ${branch.name}…`, () =>
      context.repository.switchBranch(branch.name),
    );
  const short = branch.name.replace(/^[^/]+\//, "");
  const local = context.snapshot?.branches.find(
    (ref) => !ref.remote && ref.name === short,
  );
  if (!local)
    return perform(context, `Switching to ${short}…`, () =>
      context.repository.checkoutRemoteBranch(short, branch.name, false),
    );
  if (local.sha === branch.sha)
    return perform(context, `Switching to ${short}…`, () =>
      context.repository.switchBranch(short),
    );
  return confirmThen(
    context,
    {
      title: "Overwrite local branch",
      lines: [
        `Your local ${short} differs from ${branch.name}.`,
        "Continuing moves the local branch onto the remote tip,",
        "abandoning any local commits it has.",
      ],
      confirmLabel: `Overwrite local ${short}`,
      destructive: true,
    },
    () =>
      perform(context, `Resetting ${short} to ${branch.name}…`, () =>
        context.repository.checkoutRemoteBranch(short, branch.name, true),
      ),
  );
}

export async function runMenuAction(
  context: RuntimeCommandsContext,
  action: GraphMenuAction,
  target: {
    sha: string;
    branch?: BranchRef;
    stash?: Stash;
    worktree?: Worktree;
    file?: ChangedFile;
    fileStaged?: boolean;
  },
) {
  const branch = target.branch;
  const stash = target.stash;
  const worktree = target.worktree;
  const file = target.file;
  const reference = branch ? branch.name : target.sha;
  if (action === "copy-path") {
    const path = file?.path ?? worktree?.path;
    return void (
      path &&
      context.copy(path) &&
      context.notify(`Copied ${path}`)
    );
  }
  if (action === "stage-file" || action === "unstage-file") {
    if (!file) return;
    const staging = action === "stage-file";
    return perform(
      context,
      `${staging ? "Staging" : "Unstaging"} ${file.path}…`,
      () =>
        staging
          ? context.repository.stage([file.path])
          : context.repository.unstage([file.path]),
      false,
      "working",
    );
  }
  if (action === "discard-file") {
    if (!file) return;
    return confirmThen(
      context,
      {
        title: "Discard changes",
        lines: [`Discard unstaged changes in ${file.path}?`],
        confirmLabel: "Discard changes",
        destructive: true,
      },
      () =>
        // Discarding can restore a submodule to its recorded commit, which
        // the working-tree fast path does not re-read.
        perform(context, `Discarding ${file.path}…`, () =>
          context.repository.discard([file.path]),
        ),
    );
  }
  if (action === "lock-worktree" || action === "unlock-worktree") {
    if (!worktree) return;
    const lock = action === "lock-worktree";
    return perform(context, `${lock ? "Locking" : "Unlocking"} worktree…`, () =>
      context.repository.lockWorktree(worktree.path, lock),
    );
  }
  if (action === "remove-worktree") {
    if (!worktree) return;
    const name =
      worktree.path.replace(/\/+$/, "").split("/").at(-1) ?? worktree.path;
    return confirmThen(
      context,
      {
        title: "Remove worktree",
        lines: [`Remove the worktree at ${worktree.path}?`],
        confirmLabel: `Remove ${name}`,
        destructive: true,
      },
      () =>
        perform(context, `Removing ${name}…`, () =>
          context.repository.removeWorktree(worktree.path),
        ),
    );
  }
  if (action === "delete-stash" || action === "drop-stash") {
    if (!stash) return;
    const verb = action === "delete-stash" ? "Delete" : "Drop";
    return confirmThen(
      context,
      {
        title: `${verb} stash`,
        lines: [`${verb} ${stash.ref}?`, stash.subject],
        confirmLabel: `${verb} ${stash.ref}`,
        destructive: true,
      },
      () =>
        perform(
          context,
          `${verb === "Delete" ? "Deleting" : "Dropping"} ${stash.ref}…`,
          () => context.repository.dropStash(stash.ref),
        ),
    );
  }
  if (action === "apply-stash") {
    if (!stash) return;
    return perform(context, `Applying ${stash.ref}…`, () =>
      context.repository.applyStash(stash.ref, false),
    );
  }
  if (action === "pop-stash") {
    if (!stash) return;
    return confirmThen(
      context,
      {
        title: "Pop stash",
        lines: [
          `Apply ${stash.ref} and remove it from the stash list?`,
          stash.subject,
        ],
        confirmLabel: `Pop ${stash.ref}`,
        destructive: true,
      },
      () =>
        perform(context, `Popping ${stash.ref}…`, () =>
          context.repository.popStash(stash.ref),
        ),
    );
  }
  if (action === "copy-sha") {
    const sha = shortSha(target.sha);
    return void (context.copy(sha) && context.notify(`Copied ${sha}`));
  }
  if (action === "copy-branch")
    return void (
      branch &&
      context.copy(branch.name) &&
      context.notify(`Copied ${branch.name}`)
    );
  if (action === "checkout-branch")
    return void (branch && checkoutBranch(context, branch));
  if (action === "checkout-commit")
    return perform(context, `Checking out ${shortSha(target.sha)}…`, () =>
      context.repository.checkoutCommit(target.sha),
    );
  if (action === "create-branch")
    return openNamePrompt(context, "Create branch", "branch name", (name) =>
      perform(context, `Creating ${name}…`, () =>
        context.repository.createBranch(name, target.sha, false),
      ),
    );
  if (action === "create-tag")
    return openNamePrompt(context, "Create tag", "tag name", (name) =>
      perform(context, `Creating tag ${name}…`, () =>
        context.repository.createTag(name, target.sha),
      ),
    );
  if (action === "cherry-pick")
    return perform(context, `Cherry-picking ${shortSha(target.sha)}…`, () =>
      context.repository.cherryPick(target.sha),
    );
  if (action === "rebase-onto")
    return perform(context, `Rebasing onto ${reference}…`, () =>
      context.repository.rebaseOnto(reference),
    );
  if (action === "delete-branch") {
    if (!branch) return;
    return confirmThen(
      context,
      {
        title: "Delete branch",
        lines: [
          `Delete the ${branch.remote ? "remote-tracking " : "local "}branch ${displayBranchName(branch.name)}?`,
          "Commits only on this branch become unreachable.",
        ],
        confirmLabel: `Delete ${displayBranchName(branch.name)}`,
        destructive: true,
      },
      () =>
        perform(context, `Deleting ${branch.name}…`, () =>
          context.repository.deleteBranch(branch.name, true, branch.remote),
        ),
    );
  }
  const mode: ResetMode =
    action === "reset-soft"
      ? "soft"
      : action === "reset-hard"
        ? "hard"
        : "mixed";
  const label = `${context.snapshot?.branch ?? "HEAD"} → ${branch ? displayBranchName(branch.name) : shortSha(target.sha)}`;
  if (mode !== "hard")
    return perform(context, `Resetting (${mode}) ${label}…`, () =>
      context.repository.resetTo(reference, mode),
    );
  return confirmThen(
    context,
    {
      title: "Hard reset",
      lines: [
        `Move ${context.snapshot?.branch ?? "HEAD"} to ${branch ? displayBranchName(branch.name) : shortSha(target.sha)}`,
        "and throw away all uncommitted changes to tracked files.",
        "This cannot be undone from the working tree.",
      ],
      confirmLabel: "Reset --hard",
      destructive: true,
    },
    () =>
      perform(context, `Resetting (hard) ${label}…`, () =>
        context.repository.resetTo(reference, "hard"),
      ),
  );
}

export async function commit(context: RuntimeCommandsContext) {
  const summary = context.composerSummary.value.trim();
  if (!summary)
    return context.notify("Commit summary cannot be empty", "error");
  if (!context.editingCommitSha && context.files("staged").length === 0)
    return context.notify("Nothing staged to commit", "error");
  const body = context.composerBody.plainText.trim();
  const message = body ? `${summary}\n\n${body}` : summary;
  context.composerSummary.blur();
  context.composerBody.blur();
  const reword = context.editingCommitSha;
  try {
    context.notify(reword ? "Saving message…" : "Committing…", "busy");
    if (reword) await context.repository.rewordCommit(reword, message);
    else if (context.amend) await context.repository.amendCommit(message);
    else await context.repository.commit(message);
    context.editingCommitSha = undefined;
    if (reword) restoreEditReturnState(context);
    else {
      context.amend = false;
      context.amendDraft = undefined;
      context.composerSummary.value = "";
      context.composerBody.setText("");
    }
    await context.refresh();
    context.paintComposer();
  } catch (error) {
    context.fail(error);
    if (reword) setTimeout(() => context.composerSummary.focus(), 0);
  }
}

function restoreEditReturnState(context: RuntimeCommandsContext) {
  const state = context.editReturnState;
  context.editReturnState = undefined;
  if (!state) return;
  context.composerSummary.value = state.summary;
  context.composerBody.setText(state.body);
  context.amend = state.amend;
  context.amendDraft = state.amendDraft;
}

export async function stageAll(context: RuntimeCommandsContext) {
  const paths = context.files("unstaged").map((file) => file.path);
  if (!paths.length) return context.notify("Nothing to stage");
  await perform(
    context,
    "Staging all…",
    () => context.repository.stage(paths),
    false,
    "working",
  );
}
export async function unstageAll(context: RuntimeCommandsContext) {
  const paths = context.files("staged").map((file) => file.path);
  if (!paths.length) return context.notify("Nothing to unstage");
  await perform(
    context,
    "Unstaging all…",
    () => context.repository.unstage(paths),
    false,
    "working",
  );
}
export async function discardAll(context: RuntimeCommandsContext) {
  if (!context.files("unstaged").length)
    return context.notify("Nothing to discard");
  if (!context.discardArmed) {
    context.discardArmed = true;
    setTimeout(() => {
      context.discardArmed = false;
    }, 5000);
    return context.notify(
      "Discard all unstaged changes? Press again to confirm",
      "error",
    );
  }
  context.discardArmed = false;
  // `git clean -fd` and a worktree restore can both change submodule state,
  // so this takes the full refresh rather than the working-tree fast path.
  await perform(context, "Discarding…", () => context.repository.discardAll());
}
export async function stageFirstHunk(context: RuntimeCommandsContext) {
  const file = context.selectedFile();
  if (!file) return;
  try {
    const patch = await context.repository.diff({
      path: file.path,
      staged: context.mode === "staged",
      context: 3,
    });
    const hunk = splitPatchHunks(patch)[0];
    if (!hunk) return context.notify("No applicable hunk", "error");
    await context.repository.applyPatch(hunk.patch, context.mode === "staged");
    await context.refreshWorkingStatus("Applied hunk");
  } catch (error) {
    context.fail(error);
  }
}
