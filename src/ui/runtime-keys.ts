import type {
  InputRenderable,
  KeyEvent,
  TextareaRenderable,
} from "@opentui/core";
import type {
  BranchRef,
  GitRepository,
  RepositorySnapshot,
} from "../git/types.js";
import {
  branchRefsForSection,
  clampBranchSelection,
  moveBranchSelection,
} from "./history.js";
import {
  moveFile as moveRuntimeFile,
  type RuntimeFilesContext,
} from "./runtime-files.js";
import type { RuntimePopupController } from "./runtime-popup.js";
import type { ChangeSection } from "./runtime-widgets.js";

export interface RuntimeKeysContext {
  suppressEnterUntil: number;
  /** The editor that currently owns keyboard focus, if any. */
  readonly focusedEditor: unknown;
  commandPaletteInput: InputRenderable;
  repositoryPathInput: InputRenderable;
  composerSummary: InputRenderable;
  composerBody: TextareaRenderable;
  popupController: RuntimePopupController;
  readonly commandPaletteRows: number;
  readonly composing: boolean;
  readonly mutationActive: boolean;
  readonly historyFilterActive: boolean;
  readonly tabs: ReadonlyArray<{ id: string }>;
  readonly activeTabId: string;
  readonly snapshot?: RepositorySnapshot;
  readonly repository: GitRepository;
  /** Diff lines selected for line staging. */
  readonly selectedLineCount: number;
  readonly files: RuntimeFilesContext;
  readonly commitDiff: { visible: boolean };
  readonly commitDiffEmpty: { visible: boolean };
  readonly diffTooLarge: boolean;
  view: "history" | "commit" | "working";
  focus: "history" | "changes";
  mode: ChangeSection;
  fileIndex: number;
  fileStart: number;
  sectionStart: Record<ChangeSection, number>;
  leftCollapsed: boolean;
  detailsCollapsed: boolean;
  diffOrigin?: "working" | "commit";
  branchFilter: string;
  branchFilterActive: boolean;
  branchSelection: Record<"local" | "remote", number>;
  editingCommitSha?: string;
  closeCommandPalette: () => void;
  movePaletteSelection: (delta: number) => void;
  showCommandPalette: () => void;
  /** Handle a key while the repository path input is focused. */
  repositoryPickerKey: (key: KeyEvent) => void;
  showRepositoryPicker: () => void;
  closeRepositoryTab: (id: string) => Promise<void>;
  activateRepositoryTab: (id: string) => Promise<void>;
  paintComposer: () => void;
  paintHints: () => void;
  paint: () => void;
  layout: () => void;
  closePopup: () => void;
  cancelMutation: () => void;
  cancelBranchFilter: () => void;
  finishBranchFilter: () => void;
  startBranchFilter: () => void;
  cancelEditMessage: () => void;
  clearHistoryFilter: () => boolean;
  clearLineSelection: (notify?: boolean) => void;
  applySelectedLines: () => unknown;
  closeDiff: () => void;
  shutdown: () => unknown;
  setFocus: (focus: "history" | "changes") => void;
  checkoutBranch: (branch: BranchRef) => unknown;
  moveCommit: (delta: number) => void;
  filesScroll: (section: ChangeSection, delta: number) => void;
  scrollGraphColumns: (delta: number) => boolean;
  selectedFile: () => { path: string } | undefined;
  openCommit: () => unknown;
  openWorkingDiff: () => unknown;
  loadDiff: (allowLarge?: boolean) => Promise<unknown>;
  refresh: () => unknown;
  perform: (
    label: string,
    action: (signal?: AbortSignal) => Promise<void>,
    remote?: boolean,
    scope?: "history" | "working",
  ) => unknown;
  stageFirstHunk: () => unknown;
  stageAll: () => unknown;
  discardAll: () => unknown;
  notify: (text: string) => void;
  fail: (error: unknown) => void;
}

/**
 * Dispatch one key press. The order of checks is behavior: overlays first,
 * then modal shortcuts, commit composing, Escape, branch filtering, and last
 * the pane shortcuts.
 */
export async function handleKey(ctx: RuntimeKeysContext, key: KeyEvent) {
  if (key.name === "enter" && Date.now() < ctx.suppressEnterUntil) {
    ctx.suppressEnterUntil = 0;
    return;
  }
  const focusedEditor = ctx.focusedEditor;
  if (focusedEditor === ctx.commandPaletteInput) return paletteKey(ctx, key);
  if (focusedEditor === ctx.repositoryPathInput)
    return ctx.repositoryPickerKey(key);
  if (globalKey(ctx, key)) return;
  if (composerKey(ctx, key, focusedEditor)) return;
  if (key.name === "escape") return escapeKey(ctx);
  if (
    ctx.popupController.isOpen &&
    (key.name === "enter" || key.name === "return")
  )
    return ctx.popupController.activate();
  if (key.name === "q" || (key.ctrl && key.name === "c")) {
    return void ctx.shutdown();
  }
  if (key.name === "tab") {
    ctx.setFocus(ctx.focus === "history" ? "changes" : "history");
    return;
  }
  if (key.name === "/" && ctx.focus === "history")
    return ctx.startBranchFilter();
  if (branchFilterKey(ctx, key)) return;
  if (key.name === "c" && ctx.focus === "history" && ctx.branchFilter) {
    ctx.cancelBranchFilter();
    return;
  }
  paneKey(ctx, key);
}

function paletteKey(ctx: RuntimeKeysContext, key: KeyEvent) {
  if (key.ctrl && key.name === "p") return ctx.closeCommandPalette();
  if (key.name === "escape") return ctx.closeCommandPalette();
  if (key.name === "up" || (key.ctrl && key.name === "k"))
    return ctx.movePaletteSelection(-1);
  if (key.name === "down" || (key.ctrl && key.name === "n"))
    return ctx.movePaletteSelection(1);
  if (key.name === "pageup")
    return ctx.movePaletteSelection(-ctx.commandPaletteRows);
  if (key.name === "pagedown")
    return ctx.movePaletteSelection(ctx.commandPaletteRows);
}

/** Modal and tab shortcuts. Returns true when the key was consumed. */
function globalKey(ctx: RuntimeKeysContext, key: KeyEvent): boolean {
  // Confirmation and naming popups own the keyboard until resolved. Opening
  // another modal here would silently discard their pending action or input.
  if (key.ctrl && key.name === "p" && ctx.popupController.isOpen) return true;
  if (key.ctrl && key.name === "p") {
    ctx.showCommandPalette();
    return true;
  }
  if (key.ctrl && key.name === "t") {
    ctx.showRepositoryPicker();
    return true;
  }
  if (key.ctrl && key.name === "w") {
    void ctx.closeRepositoryTab(ctx.activeTabId);
    return true;
  }
  if (key.ctrl && key.name === "tab") {
    const index = ctx.tabs.findIndex((tab) => tab.id === ctx.activeTabId);
    const delta = key.shift ? -1 : 1;
    const next = (index + delta + ctx.tabs.length) % ctx.tabs.length;
    void ctx.activateRepositoryTab(ctx.tabs[next]!.id);
    return true;
  }
  return false;
}

/** Commit composer keys. Returns true when the key was consumed. */
function composerKey(
  ctx: RuntimeKeysContext,
  key: KeyEvent,
  focusedEditor: unknown,
): boolean {
  const composingCommit =
    focusedEditor === ctx.composerSummary || focusedEditor === ctx.composerBody;
  if (composingCommit && key.name !== "escape" && key.name !== "tab") {
    // The editors own every other key while composing, but the button label
    // tracks the summary, so repaint after the keystroke lands.
    setTimeout(() => ctx.paintComposer(), 0);
    return true;
  }
  if (composingCommit && key.name === "tab") {
    const next =
      focusedEditor === ctx.composerSummary
        ? ctx.composerBody
        : ctx.composerSummary;
    next.focus();
    return true;
  }
  if (ctx.composing && key.name === "tab") return true;
  if (ctx.composing && key.name !== "escape") return true;
  return false;
}

function escapeKey(ctx: RuntimeKeysContext) {
  if (ctx.popupController.isOpen) return ctx.closePopup();
  if (ctx.mutationActive) return ctx.cancelMutation();
  if (ctx.branchFilterActive) return ctx.cancelBranchFilter();
  // A failed reword can leave the editor blurred; edit mode itself still
  // owns Escape so its saved working draft is never stranded.
  if (ctx.editingCommitSha) return ctx.cancelEditMessage();
  if (ctx.historyFilterActive && ctx.clearHistoryFilter()) return;
  if (ctx.selectedLineCount) {
    ctx.clearLineSelection();
    return;
  }
  if (ctx.composing) {
    ctx.composerSummary.blur();
    ctx.composerBody.blur();
    ctx.paintHints();
  } else if (ctx.view !== "history") ctx.closeDiff();
}

/** Branch filter navigation. Returns true when the key was consumed. */
function branchFilterKey(ctx: RuntimeKeysContext, key: KeyEvent): boolean {
  if (!ctx.branchFilterActive || !ctx.snapshot) return false;
  // While filtering, j/k (or arrows) navigate the matching local rows.
  // Shift selects the remote section, keeping both branch lists keyboard
  // accessible without introducing a second focus widget.
  const section = key.shift ? "remote" : "local";
  const refs = branchRefsForSection(ctx.snapshot.branches, section);
  const filtered = branchRefsForSection(
    ctx.snapshot.branches,
    section,
    ctx.branchFilter,
  );
  if (
    key.name === "up" ||
    key.name === "k" ||
    key.name === "down" ||
    key.name === "j"
  ) {
    const delta = key.name === "up" || key.name === "k" ? -1 : 1;
    ctx.branchSelection[section] = moveBranchSelection(
      refs,
      ctx.branchSelection[section],
      delta,
      ctx.branchFilter,
    );
    ctx.paint();
    return true;
  }
  if (key.name === "enter" || key.name === "return") {
    const index = clampBranchSelection(
      ctx.branchSelection[section],
      filtered.length,
    );
    const branch = index >= 0 ? filtered[index] : undefined;
    if (branch) {
      ctx.finishBranchFilter();
      void ctx.checkoutBranch(branch);
      return true;
    }
  }
  return false;
}

/** History and changes pane shortcuts. */
function paneKey(ctx: RuntimeKeysContext, key: KeyEvent) {
  if (key.name === "up" || key.name === "k")
    return ctx.focus === "changes" ? moveFile(ctx, -1) : ctx.moveCommit(-1);
  if (key.name === "down" || key.name === "j")
    return ctx.focus === "changes" ? moveFile(ctx, 1) : ctx.moveCommit(1);
  // OpenTUI reports the Enter key as "return"; both names are accepted so
  // the binding cannot break with a rename upstream.
  if (key.name === "enter" || key.name === "return") {
    if (ctx.selectedLineCount) return void ctx.applySelectedLines();
    if (ctx.focus === "changes") return void openSelectedFile(ctx);
    if (ctx.view === "history") return void ctx.openCommit();
    return;
  }
  if (key.name === "t") {
    if (ctx.selectedLineCount) ctx.clearLineSelection(false);
    ctx.mode = ctx.mode === "staged" ? "unstaged" : "staged";
    ctx.fileIndex = 0;
    ctx.fileStart = ctx.sectionStart[ctx.mode];
    ctx.setFocus("changes");
    ctx.paint();
    return void ctx.loadDiff().catch((e) => ctx.fail(e));
  }
  if (key.name === "[") {
    ctx.leftCollapsed = !ctx.leftCollapsed;
    return ctx.layout();
  }
  if (key.name === "]") {
    ctx.detailsCollapsed = !ctx.detailsCollapsed;
    return ctx.layout();
  }
  if (key.name === "left" || key.name === "right") {
    const delta = key.name === "left" ? -1 : 1;
    // In the history pane the arrows pan a graph that is too wide to fit;
    // with nothing hidden they keep their file-navigation meaning.
    if (ctx.focus === "history" && ctx.scrollGraphColumns(delta)) return;
    return moveFile(ctx, delta);
  }
  if (
    key.shift &&
    key.name.toLowerCase() === "l" &&
    ctx.diffTooLarge &&
    ctx.commitDiff.visible
  )
    return void ctx.loadDiff(true).catch((error) => ctx.fail(error));
  if (key.name === "r") return void ctx.refresh();
  if (key.name === "f")
    return void ctx.perform(
      "Fetching…",
      (signal) => ctx.repository.fetch(undefined, signal),
      true,
    );
  if (key.name === "l")
    return void ctx.perform(
      "Pulling…",
      (signal) => ctx.repository.pull(false, signal),
      true,
    );
  if (key.name === "p")
    return void ctx.perform(
      "Pushing…",
      (signal) => ctx.repository.push(undefined, false, signal),
      true,
    );
  if (key.name === "s" && ctx.selectedFile())
    return void ctx.perform(
      "Staging…",
      () => ctx.repository.stage([ctx.selectedFile()!.path]),
      false,
      "working",
    );
  if (key.name === "u" && ctx.selectedFile())
    return void ctx.perform(
      "Unstaging…",
      () => ctx.repository.unstage([ctx.selectedFile()!.path]),
      false,
      "working",
    );
  if (key.name === "h" && ctx.selectedFile()) return void ctx.stageFirstHunk();
  if (key.name === "a") return void ctx.stageAll();
  if (key.name === "d") return void ctx.discardAll();
  if (key.name === "c") {
    // Focus after this keypress has been dispatched, otherwise the same "c"
    // also reaches the input and starts the commit message with it.
    setTimeout(() => {
      ctx.composerSummary.focus();
      ctx.paintHints();
    }, 0);
  }
}

function moveFile(ctx: RuntimeKeysContext, delta: number) {
  if (ctx.selectedLineCount) ctx.clearLineSelection(false);
  if (ctx.historyFilterActive) return ctx.filesScroll("unstaged", delta);
  moveRuntimeFile(ctx.files, delta);
}

async function openSelectedFile(ctx: RuntimeKeysContext) {
  if (!ctx.selectedFile()) return ctx.notify("No file selected");
  if (ctx.view === "history") return void ctx.openWorkingDiff();
  ctx.diffOrigin = ctx.view === "commit" ? "commit" : "working";
  ctx.commitDiff.visible = true;
  ctx.commitDiffEmpty.visible = false;
  ctx.layout();
  await ctx.loadDiff().catch((e) => ctx.fail(e));
}
