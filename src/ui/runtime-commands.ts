import type { InputRenderable, TextareaRenderable } from "@opentui/core";
import type {
  BranchRef,
  ChangedFile,
  GitRepository,
  RepositorySnapshot,
  ResetMode,
  Stash,
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
  paintComposer(): void;
  notify(text: string, tone?: "info" | "error" | "busy"): void;
  fail(error: unknown): void;
}

export async function perform(
  context: RuntimeCommandsContext,
  label: string,
  action: () => Promise<void>,
  remote = false,
) {
  context.notify(label, "busy");
  try {
    await action();
    if (remote) context.syncedAt = Date.now();
    await context.refresh();
  } catch (error) {
    context.fail(error);
  }
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
      () => context.repository.fetch(),
      true,
    );
  if (action === "pull")
    return void perform(
      context,
      "Pulling…",
      () => context.repository.pull(),
      true,
    );
  if (action === "push")
    return void perform(
      context,
      "Pushing…",
      () => context.repository.push(),
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
  target: { sha: string; branch?: BranchRef; stash?: Stash },
) {
  const branch = target.branch;
  const stash = target.stash;
  const reference = branch ? branch.name : target.sha;
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
  await perform(context, "Staging all…", () => context.repository.stage(paths));
}
export async function unstageAll(context: RuntimeCommandsContext) {
  const paths = context.files("staged").map((file) => file.path);
  if (!paths.length) return context.notify("Nothing to unstage");
  await perform(context, "Unstaging all…", () =>
    context.repository.unstage(paths),
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
    await context.refresh("Applied hunk");
  } catch (error) {
    context.fail(error);
  }
}
