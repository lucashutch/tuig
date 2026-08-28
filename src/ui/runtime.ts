import {
  BoxRenderable,
  CliRenderEvents,
  TextareaRenderable,
  ScrollBoxRenderable,
  DiffRenderable,
  InputRenderable,
  InputRenderableEvents,
  ImageRenderable,
  TextRenderable,
  createCliRenderer,
  type CliRenderer,
  type KeyEvent,
  type Selection,
} from "@opentui/core";
import type {
  BranchRef,
  ChangedFile,
  GitRepository,
  RepositorySnapshot,
} from "../git/types.js";
import { type GraphRow } from "./graph.js";
import {
  branchRefsForSection,
  clampBranchSelection,
  moveBranchSelection,
  resolveHeadSha,
  shortSha,
} from "./history.js";
import {
  buildGraphMenu,
  type GraphMenuItem,
  type GraphMenuTarget,
} from "./graph-menu.js";
import { RuntimePopupController } from "./runtime-popup.js";
import {
  layoutRuntime,
  layoutChanges,
  type RuntimeLayoutContext,
} from "./runtime-layout.js";
import {
  paint as paintRuntime,
  paintComposer as paintRuntimeComposer,
  paintFiles as paintRuntimeFiles,
  paintHistory as paintRuntimeHistory,
  type RuntimePaintContext,
} from "./runtime-paint.js";
import { oneDarkTheme } from "./theme.js";
import {
  fileViewportSize,
  clipColumns,
  formatHints,
  renderToolbar,
  toolbarButtons,
  toolbarHit,
  type ToolbarAction,
  type ToolbarHit,
  renderHeader,
  type SidebarSection,
} from "./runtime-presentation.js";
import {
  ensureFileVisible as ensureRuntimeFileVisible,
  files as runtimeFiles,
  filesClick as handleRuntimeFilesClick,
  filesScroll as scrollRuntimeFiles,
  moveFile as moveRuntimeFile,
  resizeChangeSplit as resizeRuntimeChangeSplit,
  resizeComposer as resizeRuntimeComposer,
  sectionRows as runtimeSectionRows,
  selectedFile as selectedRuntimeFile,
  toggleSection as toggleRuntimeSection,
  type RuntimeFilesContext,
} from "./runtime-files.js";
import { loadLayoutPreferences, saveLayoutPreferences } from "./preferences.js";
import {
  PANE_TOP,
  createRuntimeWidgets,
  type ChangeSection,
} from "./runtime-widgets.js";
import {
  closeDiff as closeRuntimeDiff,
  loadDiff as loadRuntimeDiff,
  openCommit as openRuntimeCommit,
  openWorkingDiff as openRuntimeWorkingDiff,
  refresh as refreshRuntimeData,
  showCommitMeta as showRuntimeCommitMeta,
  updateGraphAvatars as updateRuntimeGraphAvatars,
  type GraphAvatarRequest,
  type RuntimeDataContext,
} from "./runtime-data.js";
import {
  historyClick as handleHistoryClick,
  moveCommit as moveHistoryCommit,
  queueHistoryScroll as queueRuntimeHistoryScroll,
  type RuntimeHistoryContext,
} from "./runtime-history.js";
import {
  acceptBranchFilter as acceptRuntimeBranchFilter,
  activateFilteredBranch as activateRuntimeFilteredBranch,
  cancelBranchFilter as cancelRuntimeBranchFilter,
  finishBranchFilter as finishRuntimeBranchFilter,
  resizeSidebar as resizeRuntimeSidebar,
  sidebarClick as handleSidebarClick,
  sidebarScroll as scrollRuntimeSidebar,
  startBranchFilter as startRuntimeBranchFilter,
  toggleSidebarSection as toggleRuntimeSidebarSection,
  type RuntimeSidebarContext,
} from "./runtime-sidebar.js";
import {
  cancelActiveMutation,
  checkoutBranch as checkoutRuntimeBranch,
  commit as commitRuntime,
  discardAll as discardAllRuntime,
  perform as performRuntime,
  runMenuAction as runRuntimeMenuAction,
  runToolbarAction as runRuntimeToolbarAction,
  stageAll as stageAllRuntime,
  stageFirstHunk as stageFirstRuntimeHunk,
  submitNamePrompt as submitRuntimeNamePrompt,
  unstageAll as unstageAllRuntime,
  type RuntimeCommandsContext,
} from "./runtime-commands.js";

export async function runTuig(repository: GitRepository): Promise<void> {
  const renderer = await createCliRenderer({
    useMouse: true,
    enableMouseMovement: true,
    exitOnCtrlC: false,
    backgroundColor: oneDarkTheme.bg,
  });
  renderer.setTerminalTitle(`tuig · ${repository.root}`);
  const app = new Runtime(renderer, repository);
  await app.start();
}

const DEFAULT_REMOTE_FETCH_INTERVAL_MINUTES = 5;

/** Window in which a second click on the same graph row counts as a double. */
const DOUBLE_CLICK_MS = 400;

class Runtime {
  /** OpenTUI emits this only when the mouse button ends a selection drag. */
  private readonly copyCompletedSelection = (selection: Selection) => {
    const text = selection.getSelectedText();
    if (!text || !text.trim()) return;
    if (this.renderer.copyToClipboardOSC52(text))
      this.notify("Copied selection");
  };
  private readonly removeSelectionListener = () => {
    this.renderer.off(CliRenderEvents.SELECTION, this.copyCompletedSelection);
  };
  private snapshot?: RepositorySnapshot;
  private commitIndex = 0;
  private historySelection: "working" | "commit" = "working";
  private fileIndex = 0;
  private mode: ChangeSection = "unstaged";
  private view: "history" | "commit" | "working" = "history";
  private commitFiles: ChangedFile[] = [];
  private graphRows: GraphRow[] = [];
  private graphColumns = 1;
  private branchHints = new Map<string, string>();
  private historyStart = 0;
  private historyViewportDetached = false;
  private historyContentWidth = 1;
  // Mouse events carry absolute terminal columns, so the column the history
  // text starts at is kept to translate them into row offsets.
  private historyContentLeft = 1;
  private fileStart = 0;
  private sectionCollapsed: Record<ChangeSection, boolean> = {
    unstaged: false,
    staged: false,
  };
  private sectionStart: Record<ChangeSection, number> = {
    unstaged: 0,
    staged: 0,
  };
  private discardArmed = false;
  private mutationBusy?: string;
  private mutationAbort?: AbortController;
  private diffRequest = 0;
  private commitFilesRequest = 0;
  private snapshotRequest = 0;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private remoteFetchTimer?: ReturnType<typeof setInterval>;
  private remoteFetchIntervalMinutes = DEFAULT_REMOTE_FETCH_INTERVAL_MINUTES;
  private scrollTimer?: ReturnType<typeof setTimeout>;
  private pendingScroll = 0;
  private historyShaHits = new Map<number, { start: number; end: number }>();
  private historyLabelHits = new Map<
    number,
    { start: number; end: number; ref?: BranchRef }
  >();
  private readonly popupController: RuntimePopupController;
  private lastGraphClick?: { row: number; at: number; label: boolean };
  private expandedFiles = new Set<string>();
  private focus: "history" | "changes" = "history";
  private syncedAt?: number;
  private messageTimer?: ReturnType<typeof setTimeout>;
  // Reading `content` back off a renderable returns a StyledText, so the
  // message text is tracked here for width and layout maths.
  private messageText = "";
  private busy = false;
  private refreshPending = false;
  private pendingRefreshMessage?: string;
  private readonly header: TextRenderable;
  private readonly toolbar: TextRenderable;
  private readonly sidebar: BoxRenderable;
  private readonly history: BoxRenderable;
  private readonly details: BoxRenderable;
  private readonly hints: TextRenderable;
  private readonly message: TextRenderable;
  private readonly sidebarText: TextRenderable;
  private readonly sidebarSections: ReturnType<
    typeof createRuntimeWidgets
  >["sidebarSections"];
  private readonly historyText: TextRenderable;
  private readonly commitDiff: DiffRenderable;
  private readonly commitDiffEmpty: TextRenderable;
  private readonly unstagedLabel: TextRenderable;
  private readonly unstagedText: TextRenderable;
  private readonly stagedLabel: TextRenderable;
  private readonly stagedText: TextRenderable;
  private readonly unstagedDivider: BoxRenderable;
  private readonly composerDivider: BoxRenderable;
  private readonly unstagedDividerBar: TextRenderable;
  private readonly composerDividerBar: TextRenderable;
  private readonly discardButton: TextRenderable;
  private readonly stageAllButton: TextRenderable;
  private readonly unstageAllButton: TextRenderable;
  private readonly composerBox: BoxRenderable;
  private readonly composerSummary: InputRenderable;
  private readonly composerBody: TextareaRenderable;
  private readonly commitButton: TextRenderable;
  private readonly amendButton: TextRenderable;
  private readonly workingBanner: TextRenderable;
  private readonly commitInfoBox: BoxRenderable;
  private readonly commitInfoLabel: TextRenderable;
  private readonly commitBodyBox: ScrollBoxRenderable;
  private readonly commitInfo: TextRenderable;
  private readonly authorPhoto: ImageRenderable;
  private readonly authorBadge: TextRenderable;
  private readonly commitCoAuthors: TextRenderable;
  private readonly commitCoAuthorProvider: ImageRenderable;
  private readonly graphAvatars: ImageRenderable[];
  private readonly editMessageButton: TextRenderable;
  private readonly commitHeader: TextRenderable;
  private readonly commitBody: TextRenderable;
  private readonly leftDivider: BoxRenderable;
  private readonly rightDivider: BoxRenderable;
  private readonly leftDividerBar: TextRenderable;
  private readonly rightDividerBar: TextRenderable;
  private readonly overlayCatcher: BoxRenderable;
  private readonly menuBox: BoxRenderable;
  private readonly menuText: TextRenderable;
  private readonly submenuBox: BoxRenderable;
  private readonly submenuText: TextRenderable;
  private readonly branchFilterInput: InputRenderable;
  private readonly promptInput: InputRenderable;
  private leftWidth = 28;
  private detailsWidth = 44;
  private leftCollapsed = false;
  private sidebarCollapsed: Record<SidebarSection, boolean> = {
    local: false,
    remote: false,
    submodules: false,
    stashes: false,
    worktrees: false,
  };
  private sidebarPreferred: Record<SidebarSection, number | undefined> = {
    local: undefined,
    remote: undefined,
    submodules: undefined,
    stashes: undefined,
    worktrees: undefined,
  };
  private sidebarStart: Record<SidebarSection, number> = {
    local: 0,
    remote: 0,
    submodules: 0,
    stashes: 0,
    worktrees: 0,
  };
  private detailsCollapsed = false;
  private branchFilter = "";
  private branchFilterActive = false;
  private branchSelection: Record<"local" | "remote", number> = {
    local: -1,
    remote: -1,
  };
  private namePrompt?: {
    title: string;
    placeholder: string;
    run: (value: string) => Promise<void>;
  };
  private diffOrigin?: "working" | "commit";
  private suppressEnterUntil = 0;
  private commitFilesTop = 19;
  // Widths read back off renderables can lag by a frame, so panes keep the
  // numeric widths from the latest layout pass for width-dependent painting.
  private sidebarPaneWidth = 28;
  private detailsPaneWidth = 44;
  private toolbarHits: ToolbarHit[] = [];
  private commitHeaderValue = "";
  private commitBodyValue = "";
  private commitInfoValue = "";
  private commitCoAuthorsValue = "";
  private commitCoAuthorsProviderVisible = false;
  private avatarRequest = 0;
  private avatarAbort?: AbortController;
  private graphAvatarKeys: Array<string | undefined> = [];
  private graphAvatarTokens: number[] = [];
  private preferredUnstagedHeight?: number;
  private preferredComposerHeight?: number;
  private preferencesTimer?: ReturnType<typeof setTimeout>;
  private amend = false;
  private amendDraft?: { summary: string; body: string };
  private editingCommitSha?: string;
  private editReturnState?: {
    summary: string;
    body: string;
    amend: boolean;
    amendDraft?: { summary: string; body: string };
  };

  constructor(
    private renderer: CliRenderer,
    private repository: GitRepository,
  ) {
    const widgets = createRuntimeWidgets(renderer, {
      sidebarClick: (x, y, button) =>
        this.sidebarClick(x, y - PANE_TOP, button),
      sidebarToggle: (section) => this.toggleSidebarSection(section),
      sidebarScroll: (y, delta) => this.sidebarScroll(y - PANE_TOP, delta),
      sidebarResize: (section, y) => this.resizeSidebar(section, y),
      historyScroll: (delta) => this.queueHistoryScroll(delta),
      historyClick: (x, y, button) =>
        this.historyClick(x, y - PANE_TOP, button),
      filesScroll: (section, delta) => this.filesScroll(section, delta),
      filesClick: (section, y, button, x) =>
        this.filesClick(section, y - PANE_TOP, button, x),
      toggleSection: (section) => this.toggleSection(section),
      resizeChangeSplit: (y) => this.resizeChangeSplit(y),
      resizeComposer: (y) => this.resizeComposer(y),
      discardAll: () => void this.discardAll(),
      stageAll: () => void this.stageAll(),
      unstageAll: () => void this.unstageAll(),
      resizeLeft: (x) => {
        this.leftWidth = Math.max(16, Math.min(x, renderer.terminalWidth - 45));
        this.leftCollapsed = false;
        this.persistLayoutPreferences();
        this.layout();
      },
      resizeRight: (x) => {
        this.detailsWidth = Math.max(
          30,
          Math.min(renderer.terminalWidth - x - 1, renderer.terminalWidth - 35),
        );
        this.detailsCollapsed = false;
        this.persistLayoutPreferences();
        this.layout();
      },
      toggleLeft: () => {
        this.leftCollapsed = !this.leftCollapsed;
        this.layout();
      },
      toggleRight: () => {
        this.detailsCollapsed = !this.detailsCollapsed;
        this.layout();
      },
      resize: () => this.layout(),
      keypress: (key) => void this.key(key),
      toolbarClick: (x) => void this.toolbarPress(x),
      commit: () => void this.commit(),
      toggleAmend: () => this.toggleAmend(),
      viewWorkingChanges: () => this.closeDiff(),
      editMessage: () => this.editMessage(),
      copyCommitSha: () => this.copyCommitSha(),
      overlayDismiss: () => this.popupController.close(),
      menuHover: (x, y) => this.popupController.hover(x, y, false),
      menuClick: (x, y) => this.popupController.click(x, y, false),
      submenuHover: (x, y) => this.popupController.hover(x, y, true),
      submenuClick: (x, y) => this.popupController.click(x, y, true),
    });
    this.sidebar = widgets.sidebar;
    this.history = widgets.history;
    this.details = widgets.details;
    this.header = widgets.header;
    this.toolbar = widgets.toolbar;
    this.hints = widgets.hints;
    this.message = widgets.message;
    this.sidebarText = widgets.sidebarText;
    this.sidebarSections = widgets.sidebarSections;
    this.historyText = widgets.historyText;
    this.commitDiff = widgets.commitDiff;
    this.commitDiffEmpty = widgets.commitDiffEmpty;
    this.unstagedLabel = widgets.unstagedLabel;
    this.unstagedText = widgets.unstagedText;
    this.stagedLabel = widgets.stagedLabel;
    this.stagedText = widgets.stagedText;
    this.unstagedDivider = widgets.unstagedDivider;
    this.composerDivider = widgets.composerDivider;
    this.unstagedDividerBar = widgets.unstagedDividerBar;
    this.composerDividerBar = widgets.composerDividerBar;
    this.discardButton = widgets.discardButton;
    this.stageAllButton = widgets.stageAllButton;
    this.unstageAllButton = widgets.unstageAllButton;
    this.composerBox = widgets.composerBox;
    this.composerSummary = widgets.composerSummary;
    this.composerBody = widgets.composerBody;
    this.commitButton = widgets.commitButton;
    this.amendButton = widgets.amendButton;
    this.workingBanner = widgets.workingBanner;
    this.commitInfoBox = widgets.commitInfoBox;
    this.commitInfoLabel = widgets.commitInfoLabel;
    this.commitBodyBox = widgets.commitBodyBox;
    this.commitInfo = widgets.commitInfo;
    this.authorPhoto = widgets.authorPhoto;
    this.authorBadge = widgets.authorBadge;
    this.commitCoAuthors = widgets.commitCoAuthors;
    this.commitCoAuthorProvider = widgets.commitCoAuthorProvider;
    this.graphAvatars = widgets.graphAvatars;
    this.editMessageButton = widgets.editMessageButton;
    this.commitHeader = widgets.commitHeader;
    this.commitBody = widgets.commitBody;
    this.leftDivider = widgets.leftDivider;
    this.rightDivider = widgets.rightDivider;
    this.leftDividerBar = widgets.leftDividerBar;
    this.rightDividerBar = widgets.rightDividerBar;
    this.overlayCatcher = widgets.overlayCatcher;
    this.menuBox = widgets.menuBox;
    this.menuText = widgets.menuText;
    this.submenuBox = widgets.submenuBox;
    this.submenuText = widgets.submenuText;
    this.branchFilterInput = new InputRenderable(renderer, {
      position: "absolute",
      id: "branch-filter",
      top: PANE_TOP,
      left: 1,
      width: 24,
      visible: false,
      zIndex: 80,
      placeholder: "Filter branches…",
      backgroundColor: oneDarkTheme.selected,
      focusedBackgroundColor: oneDarkTheme.selected,
      textColor: oneDarkTheme.text,
    });
    this.promptInput = new InputRenderable(renderer, {
      position: "absolute",
      id: "name-prompt",
      top: 1,
      left: 1,
      width: 24,
      visible: false,
      zIndex: 80,
      placeholder: "Name",
      backgroundColor: oneDarkTheme.selected,
      focusedBackgroundColor: oneDarkTheme.selected,
      textColor: oneDarkTheme.text,
    });
    this.popupController = new RuntimePopupController({
      terminalSize: () => ({
        width: this.renderer.terminalWidth,
        height: this.renderer.terminalHeight,
      }),
      overlayCatcher: this.overlayCatcher,
      menuBox: this.menuBox,
      menuText: this.menuText,
      submenuBox: this.submenuBox,
      submenuText: this.submenuText,
      promptInput: this.promptInput,
      closed: () => {
        this.namePrompt = undefined;
      },
    });
    this.branchFilterInput.on(InputRenderableEvents.INPUT, () => {
      this.branchFilter = this.branchFilterInput.value;
      this.sidebarStart.local = 0;
      this.sidebarStart.remote = 0;
      this.branchSelection.local = 0;
      this.branchSelection.remote = 0;
      this.paint();
    });
    this.branchFilterInput.on(InputRenderableEvents.ENTER, () =>
      this.activateFilteredBranch(),
    );
    this.promptInput.on(
      InputRenderableEvents.ENTER,
      () => void this.submitNamePrompt(),
    );
    this.renderer.root.add(this.branchFilterInput);
    this.renderer.root.add(this.promptInput);
    this.renderer.on(CliRenderEvents.SELECTION, this.copyCompletedSelection);
    this.renderer.once(CliRenderEvents.DESTROY, this.removeSelectionListener);
  }

  async start() {
    const preferences = await loadLayoutPreferences();
    this.leftWidth = preferences.leftWidth ?? this.leftWidth;
    this.detailsWidth = preferences.detailsWidth ?? this.detailsWidth;
    this.preferredUnstagedHeight = preferences.unstagedHeight;
    this.preferredComposerHeight = preferences.composerHeight;
    this.sidebarPreferred = {
      ...this.sidebarPreferred,
      ...preferences.sidebarHeights,
    };
    this.sidebarCollapsed = {
      ...this.sidebarCollapsed,
      ...preferences.sidebarCollapsed,
    };
    this.remoteFetchIntervalMinutes =
      preferences.remoteFetchIntervalMinutes ??
      DEFAULT_REMOTE_FETCH_INTERVAL_MINUTES;
    this.renderer.start();
    // Terminal dimensions are reliable only after the renderer has started.
    await Bun.sleep(0);
    this.layout();
    await this.refresh();
    // Refresh creates width-dependent history content; recompute once with
    // the live snapshot so startup follows the same path as a manual resize.
    this.layout();
    this.refreshTimer = setInterval(() => {
      if (!this.composing) void this.refresh("Auto-refreshing…");
    }, 60_000);
    if (this.remoteFetchIntervalMinutes > 0) {
      this.remoteFetchTimer = setInterval(() => {
        if (!this.composing && !this.busy)
          void this.perform(
            "Fetching remote changes…",
            () => this.repository.fetch(),
            true,
          );
      }, this.remoteFetchIntervalMinutes * 60_000);
    }
  }
  private persistLayoutPreferences() {
    if (this.preferencesTimer) clearTimeout(this.preferencesTimer);
    this.preferencesTimer = setTimeout(() => {
      this.preferencesTimer = undefined;
      void this.flushLayoutPreferences().catch(() => undefined);
    }, 150);
  }
  private async flushLayoutPreferences() {
    if (this.preferencesTimer) {
      clearTimeout(this.preferencesTimer);
      this.preferencesTimer = undefined;
    }
    await saveLayoutPreferences({
      remoteFetchIntervalMinutes: this.remoteFetchIntervalMinutes,
      leftWidth: this.leftWidth,
      detailsWidth: this.detailsWidth,
      unstagedHeight: this.preferredUnstagedHeight,
      composerHeight: this.preferredComposerHeight,
      sidebarHeights: this.sidebarPreferred,
      sidebarCollapsed: this.sidebarCollapsed,
    });
  }
  /** True while either commit-message editor holds the keyboard. */
  private get composing(): boolean {
    const focused = this.renderer.currentFocusedEditor;
    return (
      focused === this.composerSummary ||
      focused === this.composerBody ||
      focused === this.branchFilterInput ||
      focused === this.promptInput
    );
  }
  private label(section: ChangeSection): TextRenderable {
    return section === "unstaged" ? this.unstagedLabel : this.stagedLabel;
  }
  private list(section: ChangeSection): TextRenderable {
    return section === "unstaged" ? this.unstagedText : this.stagedText;
  }
  /** Rows the given list can show, which is its rendered height. */
  private sectionViewport(section: ChangeSection): number {
    if (this.view === "commit")
      return Math.max(
        1,
        fileViewportSize(this.view, this.contentHeight, this.commitFilesTop) -
          1,
      );
    return Math.max(0, Number(this.list(section).height));
  }
  /** Rows available to the panes, once the header row is taken out. */
  private get contentHeight(): number {
    return Math.max(1, this.renderer.terminalHeight - PANE_TOP);
  }
  /**
   * Show a transient message on the right of the bottom row.
   *
   * Messages expire so the keybinding hints on the left, which they never
   * overwrite, remain the resting state of the row.
   */
  private notify(text: string, tone: "info" | "error" | "busy" = "info") {
    if (this.messageTimer) clearTimeout(this.messageTimer);
    this.messageTimer = undefined;
    const limit = Math.max(20, Math.floor(this.renderer.terminalWidth / 2));
    this.messageText = clipColumns(tone === "busy" ? `⠿ ${text}` : text, limit);
    this.message.content = this.messageText;
    this.message.fg =
      tone === "error"
        ? oneDarkTheme.deleted
        : tone === "busy"
          ? oneDarkTheme.accentSoft
          : oneDarkTheme.muted;
    this.positionMessage();
    this.paintHints();
    if (tone === "busy") return;
    this.messageTimer = setTimeout(() => {
      this.messageText = "";
      this.message.content = "";
      this.messageTimer = undefined;
      this.positionMessage();
      this.paintHints();
    }, 6000);
  }
  private fail(error: unknown) {
    this.notify(
      error instanceof Error ? error.message : String(error),
      "error",
    );
  }
  private positionMessage() {
    const width = Bun.stringWidth(this.messageText);
    this.message.width = Math.max(1, width);
    this.message.left = Math.max(1, this.renderer.terminalWidth - width - 1);
  }
  private paintHints() {
    const text = formatHints({
      focus: this.focus,
      view: this.view,
      composing: this.composing,
    });
    const room = Math.max(
      10,
      this.renderer.terminalWidth - Bun.stringWidth(this.messageText) - 4,
    );
    // Hints must not pad, or the padding would erase the message beside them.
    const content = clipColumns(text, room);
    this.hints.width = Math.max(1, Bun.stringWidth(content));
    this.hints.content = content;
  }
  private paintHeader() {
    this.header.width = Math.max(1, this.renderer.terminalWidth);
    this.header.content = renderHeader({
      snapshot: this.snapshot,
      repositoryRoot: this.repository.root,
      width: Math.max(1, this.renderer.terminalWidth),
      syncedAt: this.syncedAt,
    });
  }
  private paintToolbar() {
    const width = Math.max(1, this.renderer.terminalWidth);
    const toolbar = renderToolbar(toolbarButtons(this.snapshot), width);
    this.toolbar.width = width;
    this.toolbar.content = toolbar.content;
    this.toolbarHits = toolbar.hits;
  }
  private async toolbarPress(x: number) {
    const action = toolbarHit(this.toolbarHits, x);
    if (!action) return;
    await this.runToolbarAction(action);
  }
  private runToolbarAction(action: ToolbarAction) {
    return runRuntimeToolbarAction(this.commandsContext(), action);
  }
  private setFocus(focus: "history" | "changes") {
    if (this.focus === focus) return;
    this.focus = focus;
    this.paintHints();
    this.paint();
  }
  private layout() {
    layoutRuntime(this.layoutContext());
  }
  private layoutChanges(height: number) {
    layoutChanges(this.layoutContext(), height);
  }
  private layoutContext(): RuntimeLayoutContext {
    return this as unknown as RuntimeLayoutContext;
  }
  private filesContext(): RuntimeFilesContext {
    // Accessors keep file interactions attached to the live runtime state.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const runtime = this;
    return {
      get snapshot() {
        return runtime.snapshot;
      },
      get commitFiles() {
        return runtime.commitFiles;
      },
      get view() {
        return runtime.view;
      },
      set view(value) {
        runtime.view = value;
      },
      get mode() {
        return runtime.mode;
      },
      set mode(value) {
        runtime.mode = value;
      },
      get fileIndex() {
        return runtime.fileIndex;
      },
      set fileIndex(value) {
        runtime.fileIndex = value;
      },
      get fileStart() {
        return runtime.fileStart;
      },
      set fileStart(value) {
        runtime.fileStart = value;
      },
      sectionCollapsed: this.sectionCollapsed,
      sectionStart: this.sectionStart,
      get expandedFiles() {
        return runtime.expandedFiles;
      },
      set expandedFiles(value) {
        runtime.expandedFiles = value;
      },
      get preferredUnstagedHeight() {
        return runtime.preferredUnstagedHeight;
      },
      set preferredUnstagedHeight(value) {
        runtime.preferredUnstagedHeight = value;
      },
      get preferredComposerHeight() {
        return runtime.preferredComposerHeight;
      },
      set preferredComposerHeight(value) {
        runtime.preferredComposerHeight = value;
      },
      get contentHeight() {
        return runtime.contentHeight;
      },
      get commitFilesTop() {
        return runtime.commitFilesTop;
      },
      get diffOrigin() {
        return runtime.diffOrigin;
      },
      set diffOrigin(value) {
        runtime.diffOrigin = value;
      },
      widgets: {
        unstagedText: this.unstagedText,
        stagedText: this.stagedText,
        commitDiff: this.commitDiff,
        commitDiffEmpty: this.commitDiffEmpty,
      },
      sectionViewport: (section) => this.sectionViewport(section),
      setFocus: (focus) => this.setFocus(focus),
      layout: () => this.layout(),
      paint: () => this.paint(),
      paintFiles: () => this.paintFiles(),
      loadDiff: () => this.loadDiff(),
      openWorkingDiff: () => this.openWorkingDiff(),
      notify: (text) => this.notify(text),
      fail: (error) => this.fail(error),
      persistLayoutPreferences: () => this.persistLayoutPreferences(),
      openFileMenu: (x, y, target) =>
        this.openGraphMenu(x, y + PANE_TOP, target),
    };
  }
  private files(section: ChangeSection = this.mode): ChangedFile[] {
    return runtimeFiles(this.filesContext(), section);
  }
  private sectionRows(section: ChangeSection) {
    return runtimeSectionRows(this.filesContext(), section);
  }
  private toggleSection(section: ChangeSection) {
    toggleRuntimeSection(this.filesContext(), section);
  }
  private resizeChangeSplit(y: number) {
    resizeRuntimeChangeSplit(this.filesContext(), y);
  }
  private resizeComposer(y: number) {
    resizeRuntimeComposer(this.filesContext(), y);
  }
  private filesScroll(section: ChangeSection, delta: number) {
    scrollRuntimeFiles(this.filesContext(), section, delta);
  }
  private filesClick(
    section: ChangeSection,
    y: number,
    button?: number,
    x?: number,
  ) {
    handleRuntimeFilesClick(this.filesContext(), section, y, button, x);
  }
  private selectedFile() {
    return selectedRuntimeFile(this.filesContext());
  }

  private refresh(message?: string) {
    return refreshRuntimeData(this.dataContext(), message);
  }

  private dataContext(): RuntimeDataContext {
    // Accessors keep async data operations attached to the live runtime state.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const runtime = this;
    return {
      repository: this.repository,
      widgets: {
        history: this.history,
        historyText: this.historyText,
        graphAvatars: this.graphAvatars,
        commitDiff: this.commitDiff,
        commitDiffEmpty: this.commitDiffEmpty,
        workingBanner: this.workingBanner,
        unstagedText: this.unstagedText,
        commitInfo: this.commitInfo,
        commitHeader: this.commitHeader,
        commitBody: this.commitBody,
        commitBodyBox: this.commitBodyBox,
        commitInfoBox: this.commitInfoBox,
        authorPhoto: this.authorPhoto,
        authorBadge: this.authorBadge,
        commitCoAuthors: this.commitCoAuthors,
        commitCoAuthorProvider: this.commitCoAuthorProvider,
      },
      get snapshot() {
        return runtime.snapshot;
      },
      set snapshot(value) {
        runtime.snapshot = value;
      },
      get snapshotRequest() {
        return runtime.snapshotRequest;
      },
      set snapshotRequest(value) {
        runtime.snapshotRequest = value;
      },
      get diffRequest() {
        return runtime.diffRequest;
      },
      set diffRequest(value) {
        runtime.diffRequest = value;
      },
      get commitFilesRequest() {
        return runtime.commitFilesRequest;
      },
      set commitFilesRequest(value) {
        runtime.commitFilesRequest = value;
      },
      get busy() {
        return runtime.busy;
      },
      set busy(value) {
        runtime.busy = value;
      },
      get refreshPending() {
        return runtime.refreshPending;
      },
      set refreshPending(value) {
        runtime.refreshPending = value;
      },
      get pendingRefreshMessage() {
        return runtime.pendingRefreshMessage;
      },
      set pendingRefreshMessage(value) {
        runtime.pendingRefreshMessage = value;
      },
      get view() {
        return runtime.view;
      },
      set view(value) {
        runtime.view = value;
      },
      get mode() {
        return runtime.mode;
      },
      set mode(value) {
        runtime.mode = value;
      },
      get diffOrigin() {
        return runtime.diffOrigin;
      },
      set diffOrigin(value) {
        runtime.diffOrigin = value;
      },
      get historySelection() {
        return runtime.historySelection;
      },
      set historySelection(value) {
        runtime.historySelection = value;
      },
      get commitIndex() {
        return runtime.commitIndex;
      },
      set commitIndex(value) {
        runtime.commitIndex = value;
      },
      get fileIndex() {
        return runtime.fileIndex;
      },
      set fileIndex(value) {
        runtime.fileIndex = value;
      },
      get fileStart() {
        return runtime.fileStart;
      },
      set fileStart(value) {
        runtime.fileStart = value;
      },
      get commitFiles() {
        return runtime.commitFiles;
      },
      set commitFiles(value) {
        runtime.commitFiles = value;
      },
      get graphRows() {
        return runtime.graphRows;
      },
      set graphRows(value) {
        runtime.graphRows = value;
      },
      get graphColumns() {
        return runtime.graphColumns;
      },
      set graphColumns(value) {
        runtime.graphColumns = value;
      },
      get branchHints() {
        return runtime.branchHints;
      },
      set branchHints(value) {
        runtime.branchHints = value;
      },
      get detailsPaneWidth() {
        return runtime.detailsPaneWidth;
      },
      set detailsPaneWidth(value) {
        runtime.detailsPaneWidth = value;
      },
      get commitInfoValue() {
        return runtime.commitInfoValue;
      },
      set commitInfoValue(value) {
        runtime.commitInfoValue = value;
      },
      get commitHeaderValue() {
        return runtime.commitHeaderValue;
      },
      set commitHeaderValue(value) {
        runtime.commitHeaderValue = value;
      },
      get commitBodyValue() {
        return runtime.commitBodyValue;
      },
      set commitBodyValue(value) {
        runtime.commitBodyValue = value;
      },
      get commitCoAuthorsValue() {
        return runtime.commitCoAuthorsValue;
      },
      set commitCoAuthorsValue(value) {
        runtime.commitCoAuthorsValue = value;
      },
      get commitCoAuthorsProviderVisible() {
        return runtime.commitCoAuthorsProviderVisible;
      },
      set commitCoAuthorsProviderVisible(value) {
        runtime.commitCoAuthorsProviderVisible = value;
      },
      get avatarRequest() {
        return runtime.avatarRequest;
      },
      set avatarRequest(value) {
        runtime.avatarRequest = value;
      },
      get avatarAbort() {
        return runtime.avatarAbort;
      },
      set avatarAbort(value) {
        runtime.avatarAbort = value;
      },
      graphAvatarKeys: runtime.graphAvatarKeys,
      graphAvatarTokens: runtime.graphAvatarTokens,
      // OpenTUI's block protocol can render images even without Kitty or
      // Sixel, so keep photo loading enabled on ordinary terminals too. The
      // pooled graph avatars need real pixels, though: a 2x2-cell half-block
      // image is an unrecognizable smear.
      get avatarSupported() {
        return runtime.authorPhoto.effectiveProtocol !== "blocks";
      },
      files: () => this.files(),
      selectedFile: () => this.selectedFile(),
      ensureFileVisible: () => this.ensureFileVisible(),
      layout: () => this.layout(),
      paint: () => this.paint(),
      paintFiles: () => this.paintFiles(),
      paintHints: () => this.paintHints(),
      notify: (text, tone) => this.notify(text, tone),
      fail: (error) => this.fail(error),
      refresh: (text) => this.refresh(text),
    };
  }

  private paintContext(): RuntimePaintContext {
    return {
      snapshot: this.snapshot,
      contentHeight: this.contentHeight,
      sidebarPreferred: this.sidebarPreferred,
      sidebarCollapsed: this.sidebarCollapsed,
      sidebarStart: this.sidebarStart,
      sidebarSections: this.sidebarSections,
      sidebarPaneWidth: this.sidebarPaneWidth,
      branchFilter: this.branchFilter,
      paintHeader: () => this.paintHeader(),
      paintToolbar: () => this.paintToolbar(),
      layoutChanges: (height) => this.layoutChanges(height),
      view: this.view,
      mode: this.mode,
      focus: this.focus,
      sectionCollapsed: this.sectionCollapsed,
      sectionStart: this.sectionStart,
      fileStart: this.fileStart,
      setFileStart: (value) => {
        this.fileStart = value;
      },
      files: (section) => this.files(section),
      label: (section) => this.label(section),
      list: (section) => this.list(section),
      sectionViewport: (section) => this.sectionViewport(section),
      selectedFile: () => this.selectedFile(),
      expandedFiles: this.expandedFiles,
      detailsPaneWidth: this.detailsPaneWidth,
      graphRows: this.graphRows,
      graphColumns: this.graphColumns,
      branchHints: this.branchHints,
      historySelection: this.historySelection,
      commitIndex: this.commitIndex,
      historyStart: this.historyStart,
      setHistoryStart: (value) => {
        this.historyStart = value;
      },
      historyViewportDetached: this.historyViewportDetached,
      historyContentWidth: this.historyContentWidth,
      historyShaHits: this.historyShaHits,
      historyLabelHits: this.historyLabelHits,
      historyText: this.historyText,
      commitDiffVisible: this.commitDiff.visible,
      updateGraphAvatars: (requests: readonly GraphAvatarRequest[]) =>
        updateRuntimeGraphAvatars(this.dataContext(), requests),
      editingCommitSha: this.editingCommitSha,
      composerSummary: this.composerSummary,
      commitButton: this.commitButton,
      amendButton: this.amendButton,
      amend: this.amend,
    };
  }

  private paint() {
    paintRuntime(this.paintContext());
  }
  private paintHistory() {
    paintRuntimeHistory(this.paintContext());
  }
  private paintFiles() {
    paintRuntimeFiles(this.paintContext());
  }
  private paintComposer() {
    paintRuntimeComposer(this.paintContext());
  }

  private ensureFileVisible() {
    ensureRuntimeFileVisible(this.filesContext());
  }

  private loadDiff() {
    return loadRuntimeDiff(this.dataContext());
  }

  private historyContext(): RuntimeHistoryContext {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const runtime = this;
    return {
      get snapshot() {
        return runtime.snapshot;
      },
      graphRows: this.graphRows,
      get commitIndex() {
        return runtime.commitIndex;
      },
      set commitIndex(value) {
        runtime.commitIndex = value;
      },
      get historySelection() {
        return runtime.historySelection;
      },
      set historySelection(value) {
        runtime.historySelection = value;
      },
      get historyStart() {
        return runtime.historyStart;
      },
      set historyStart(value) {
        runtime.historyStart = value;
      },
      get historyViewportDetached() {
        return runtime.historyViewportDetached;
      },
      set historyViewportDetached(value) {
        runtime.historyViewportDetached = value;
      },
      historyContentLeft: this.historyContentLeft,
      contentHeight: this.contentHeight,
      get pendingScroll() {
        return runtime.pendingScroll;
      },
      set pendingScroll(value) {
        runtime.pendingScroll = value;
      },
      get scrollTimer() {
        return runtime.scrollTimer;
      },
      set scrollTimer(value) {
        runtime.scrollTimer = value;
      },
      get lastGraphClick() {
        return runtime.lastGraphClick;
      },
      set lastGraphClick(value) {
        runtime.lastGraphClick = value;
      },
      historyShaHits: this.historyShaHits,
      historyLabelHits: this.historyLabelHits,
      renderer: this.renderer,
      paneTop: PANE_TOP,
      doubleClickMs: DOUBLE_CLICK_MS,
      commitDiffVisible: this.commitDiff.visible,
      get diffOrigin() {
        return runtime.diffOrigin;
      },
      set diffOrigin(value) {
        runtime.diffOrigin = value;
      },
      get mode() {
        return runtime.mode;
      },
      set mode(value) {
        runtime.mode = value;
      },
      paint: () => this.paint(),
      paintHistory: () => this.paintHistory(),
      openCommit: () => this.openCommit(),
      openGraphMenu: (x, y, target) => this.openGraphMenu(x, y, target),
      closeDiff: () => this.closeDiff(),
      checkoutBranch: (branch) => this.checkoutBranch(branch),
      setFocus: (focus) => this.setFocus(focus),
      notify: (text) => this.notify(text),
    };
  }

  private moveCommit(delta: number) {
    const wasCommitView = this.view === "commit";
    moveHistoryCommit(this.historyContext(), delta);
    if (
      wasCommitView &&
      this.view === "commit" &&
      this.historySelection === "commit"
    )
      void this.openCommit();
  }
  private queueHistoryScroll(delta: number) {
    queueRuntimeHistoryScroll(this.historyContext(), delta);
  }
  private historyClick(x: number, y: number, button: number) {
    handleHistoryClick(this.historyContext(), x, y, button);
  }

  private sidebarContext(): RuntimeSidebarContext {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const runtime = this;
    return {
      get snapshot() {
        return runtime.snapshot;
      },
      get contentHeight() {
        return runtime.contentHeight;
      },
      get sidebarPaneWidth() {
        return runtime.sidebarPaneWidth;
      },
      paneTop: PANE_TOP,
      get view() {
        return runtime.view;
      },
      get leftCollapsed() {
        return runtime.leftCollapsed;
      },
      set leftCollapsed(value) {
        runtime.leftCollapsed = value;
      },
      get branchFilter() {
        return runtime.branchFilter;
      },
      set branchFilter(value) {
        runtime.branchFilter = value;
      },
      get branchFilterActive() {
        return runtime.branchFilterActive;
      },
      set branchFilterActive(value) {
        runtime.branchFilterActive = value;
      },
      get suppressEnterUntil() {
        return runtime.suppressEnterUntil;
      },
      set suppressEnterUntil(value) {
        runtime.suppressEnterUntil = value;
      },
      get sidebarPreferred() {
        return runtime.sidebarPreferred;
      },
      set sidebarPreferred(value) {
        runtime.sidebarPreferred = value;
      },
      sidebarCollapsed: this.sidebarCollapsed,
      sidebarStart: this.sidebarStart,
      branchSelection: this.branchSelection,
      branchFilterInput: this.branchFilterInput,
      layout: () => this.layout(),
      paint: () => this.paint(),
      paintHints: () => this.paintHints(),
      persistLayoutPreferences: () => this.persistLayoutPreferences(),
      notify: (text) => this.notify(text),
      checkoutBranch: (branch) => this.checkoutBranch(branch),
      openGraphMenu: (x, y, target) => this.openGraphMenu(x, y, target),
    };
  }

  /** Open the graph context menu at a terminal position. */
  private openGraphMenu(x: number, y: number, target: GraphMenuTarget) {
    if (!this.snapshot) return;
    if (this.branchFilterActive) this.finishBranchFilter();
    const built = buildGraphMenu(target, this.snapshot);
    this.openPopup(built.title, built.items, x, y, (item) => {
      if (item.action) void this.runMenuAction(item.action, target);
    });
  }

  private runMenuAction(
    action: Parameters<typeof runRuntimeMenuAction>[1],
    target: Parameters<typeof runRuntimeMenuAction>[2],
  ) {
    return runRuntimeMenuAction(this.commandsContext(), action, target);
  }
  private checkoutBranch(branch: BranchRef) {
    return checkoutRuntimeBranch(this.commandsContext(), branch);
  }
  private submitNamePrompt() {
    return submitRuntimeNamePrompt(this.commandsContext());
  }

  private openPopup(
    title: string,
    items: GraphMenuItem[],
    x: number,
    y: number,
    select: (item: GraphMenuItem) => void,
    promptActive = false,
  ) {
    this.popupController.open(title, items, x, y, select, promptActive);
  }

  private closePopup() {
    this.popupController.close();
  }

  private openCommit() {
    return openRuntimeCommit(this.dataContext());
  }
  private openWorkingDiff() {
    return openRuntimeWorkingDiff(this.dataContext());
  }
  private closeDiff() {
    closeRuntimeDiff(this.dataContext());
  }

  private copyCommitSha() {
    const sha = this.snapshot?.commits[this.commitIndex]?.sha;
    if (!sha) return;
    if (this.renderer.copyToClipboardOSC52(sha))
      this.notify(`Copied ${shortSha(sha)}`);
  }
  private setCommitMetaVisible(visible: boolean) {
    this.commitInfoBox.visible = visible;
    this.commitBodyBox.visible = visible;
  }
  private toggleAmend() {
    if (this.amend) {
      this.amend = false;
      if (this.amendDraft) {
        this.composerSummary.value = this.amendDraft.summary;
        this.composerBody.setText(this.amendDraft.body);
      }
      this.amendDraft = undefined;
    } else {
      const headSha = this.snapshot
        ? resolveHeadSha(this.snapshot.branches, this.snapshot.commits)
        : undefined;
      const head = headSha
        ? this.snapshot?.commits.find((commit) => commit.sha === headSha)
        : undefined;
      if (!head) return this.notify("No previous commit to amend", "error");
      this.amendDraft = {
        summary: this.composerSummary.value,
        body: this.composerBody.plainText,
      };
      this.amend = true;
      this.composerSummary.value = head.subject;
      this.composerBody.setText(head.body ?? "");
    }
    this.paintComposer();
  }
  private editMessage() {
    const commit = this.snapshot?.commits[this.commitIndex];
    if (!commit) return;
    this.editReturnState = {
      summary: this.composerSummary.value,
      body: this.composerBody.plainText,
      amend: this.amend,
      amendDraft: this.amendDraft && { ...this.amendDraft },
    };
    this.editingCommitSha = commit.sha;
    this.composerSummary.value = commit.subject;
    this.composerBody.setText(commit.body ?? "");
    this.setCommitMetaVisible(false);
    this.layout();
    this.paintComposer();
    setTimeout(() => this.composerSummary.focus(), 0);
  }
  private restoreEditReturnState() {
    const state = this.editReturnState;
    this.editReturnState = undefined;
    if (!state) return;
    this.composerSummary.value = state.summary;
    this.composerBody.setText(state.body);
    this.amend = state.amend;
    this.amendDraft = state.amendDraft;
  }
  private cancelEditMessage() {
    this.composerSummary.blur();
    this.composerBody.blur();
    this.editingCommitSha = undefined;
    this.restoreEditReturnState();
    const commit = this.snapshot?.commits[this.commitIndex];
    if (commit) showRuntimeCommitMeta(this.dataContext(), commit);
    this.paintComposer();
    this.paintHints();
  }
  private sidebarClick(x: number, y: number, button: number) {
    handleSidebarClick(this.sidebarContext(), x, y, button);
  }
  private startBranchFilter() {
    startRuntimeBranchFilter(this.sidebarContext());
  }
  private finishBranchFilter() {
    finishRuntimeBranchFilter(this.sidebarContext());
  }
  private acceptBranchFilter() {
    acceptRuntimeBranchFilter(this.sidebarContext());
  }
  private activateFilteredBranch() {
    activateRuntimeFilteredBranch(this.sidebarContext());
  }
  private cancelBranchFilter() {
    cancelRuntimeBranchFilter(this.sidebarContext());
  }
  private toggleSidebarSection(section: SidebarSection) {
    toggleRuntimeSidebarSection(this.sidebarContext(), section);
  }
  private sidebarScroll(y: number, delta: number) {
    scrollRuntimeSidebar(this.sidebarContext(), y, delta);
  }
  private resizeSidebar(section: SidebarSection, y: number) {
    resizeRuntimeSidebar(this.sidebarContext(), section, y);
  }

  private async key(key: KeyEvent) {
    if (key.name === "enter" && Date.now() < this.suppressEnterUntil) {
      this.suppressEnterUntil = 0;
      return;
    }
    const focusedEditor = this.renderer.currentFocusedEditor;
    const composingCommit =
      focusedEditor === this.composerSummary ||
      focusedEditor === this.composerBody;
    if (composingCommit && key.name !== "escape" && key.name !== "tab") {
      // The editors own every other key while composing, but the button label
      // tracks the summary, so repaint after the keystroke lands.
      setTimeout(() => this.paintComposer(), 0);
      return;
    }
    if (composingCommit && key.name === "tab") {
      const next =
        focusedEditor === this.composerSummary
          ? this.composerBody
          : this.composerSummary;
      next.focus();
      return;
    }
    if (this.composing && key.name === "tab") return;
    if (this.composing && key.name !== "escape") return;
    if (key.name === "escape") {
      if (this.popupController.isOpen) return this.closePopup();
      if (this.mutationAbort)
        return void cancelActiveMutation(this.commandsContext());
      if (this.branchFilterActive) return this.cancelBranchFilter();
      // A failed reword can leave the editor blurred; edit mode itself still
      // owns Escape so its saved working draft is never stranded.
      if (this.editingCommitSha) return this.cancelEditMessage();
      if (this.composing) {
        this.composerSummary.blur();
        this.composerBody.blur();
        this.paintHints();
      } else if (this.view !== "history") this.closeDiff();
      return;
    }
    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      this.avatarAbort?.abort();
      if (this.refreshTimer) clearInterval(this.refreshTimer);
      if (this.remoteFetchTimer) clearInterval(this.remoteFetchTimer);
      if (this.scrollTimer) clearTimeout(this.scrollTimer);
      if (this.messageTimer) clearTimeout(this.messageTimer);
      await this.flushLayoutPreferences().catch(() => undefined);
      return this.renderer.destroy();
    }
    if (key.name === "tab") {
      this.setFocus(this.focus === "history" ? "changes" : "history");
      return;
    }
    if (key.name === "/" && this.focus === "history")
      return this.startBranchFilter();
    if (this.branchFilterActive && this.snapshot) {
      // While filtering, j/k (or arrows) navigate the matching local rows.
      // Shift selects the remote section, keeping both branch lists keyboard
      // accessible without introducing a second focus widget.
      const section = key.shift ? "remote" : "local";
      const refs = branchRefsForSection(this.snapshot.branches, section);
      const filtered = branchRefsForSection(
        this.snapshot.branches,
        section,
        this.branchFilter,
      );
      if (
        key.name === "up" ||
        key.name === "k" ||
        key.name === "down" ||
        key.name === "j"
      ) {
        const delta = key.name === "up" || key.name === "k" ? -1 : 1;
        this.branchSelection[section] = moveBranchSelection(
          refs,
          this.branchSelection[section],
          delta,
          this.branchFilter,
        );
        this.paint();
        return;
      }
      if (key.name === "enter" || key.name === "return") {
        const index = clampBranchSelection(
          this.branchSelection[section],
          filtered.length,
        );
        const branch = index >= 0 ? filtered[index] : undefined;
        if (branch) {
          this.finishBranchFilter();
          return void this.checkoutBranch(branch);
        }
      }
    }
    if (key.name === "c" && this.focus === "history" && this.branchFilter) {
      this.cancelBranchFilter();
      return;
    }
    if (key.name === "up" || key.name === "k")
      return this.focus === "changes" ? this.moveFile(-1) : this.moveCommit(-1);
    if (key.name === "down" || key.name === "j")
      return this.focus === "changes" ? this.moveFile(1) : this.moveCommit(1);
    // OpenTUI reports the Enter key as "return"; both names are accepted so
    // the binding cannot break with a rename upstream.
    if (key.name === "enter" || key.name === "return") {
      if (this.focus === "changes") return void this.openSelectedFile();
      if (this.view === "history") return void this.openCommit();
      return;
    }
    if (key.name === "t") {
      this.mode = this.mode === "staged" ? "unstaged" : "staged";
      this.fileIndex = 0;
      this.fileStart = this.sectionStart[this.mode];
      this.setFocus("changes");
      this.paint();
      return void this.loadDiff().catch((e) => this.fail(e));
    }
    if (key.name === "[") {
      this.leftCollapsed = !this.leftCollapsed;
      return this.layout();
    }
    if (key.name === "]") {
      this.detailsCollapsed = !this.detailsCollapsed;
      return this.layout();
    }
    if (key.name === "left") return this.moveFile(-1);
    if (key.name === "right") return this.moveFile(1);
    if (key.name === "r") return void this.refresh();
    if (key.name === "f")
      return void this.perform(
        "Fetching…",
        (signal) => this.repository.fetch(undefined, signal),
        true,
      );
    if (key.name === "l")
      return void this.perform(
        "Pulling…",
        (signal) => this.repository.pull(false, signal),
        true,
      );
    if (key.name === "p")
      return void this.perform(
        "Pushing…",
        (signal) => this.repository.push(undefined, false, signal),
        true,
      );
    if (key.name === "s" && this.selectedFile())
      return void this.perform("Staging…", () =>
        this.repository.stage([this.selectedFile()!.path]),
      );
    if (key.name === "u" && this.selectedFile())
      return void this.perform("Unstaging…", () =>
        this.repository.unstage([this.selectedFile()!.path]),
      );
    if (key.name === "h" && this.selectedFile())
      return void this.stageFirstHunk();
    if (key.name === "a") return void this.stageAll();
    if (key.name === "d") return void this.discardAll();
    if (key.name === "c") {
      // Focus after this keypress has been dispatched, otherwise the same "c"
      // also reaches the input and starts the commit message with it.
      setTimeout(() => {
        this.composerSummary.focus();
        this.paintHints();
      }, 0);
    }
  }
  private moveFile(delta: number) {
    moveRuntimeFile(this.filesContext(), delta);
  }
  private async openSelectedFile() {
    if (!this.selectedFile()) return this.notify("No file selected");
    if (this.view === "history") return void this.openWorkingDiff();
    this.diffOrigin = this.view === "commit" ? "commit" : "working";
    this.commitDiff.visible = true;
    this.commitDiffEmpty.visible = false;
    this.layout();
    await this.loadDiff().catch((e) => this.fail(e));
  }
  private commandsContext(): RuntimeCommandsContext {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const runtime = this;
    return {
      repository: this.repository,
      popupController: this.popupController,
      promptInput: this.promptInput,
      composerSummary: this.composerSummary,
      composerBody: this.composerBody,
      get snapshot() {
        return runtime.snapshot;
      },
      get syncedAt() {
        return runtime.syncedAt;
      },
      set syncedAt(value) {
        runtime.syncedAt = value;
      },
      get suppressEnterUntil() {
        return runtime.suppressEnterUntil;
      },
      set suppressEnterUntil(value) {
        runtime.suppressEnterUntil = value;
      },
      get discardArmed() {
        return runtime.discardArmed;
      },
      set discardArmed(value) {
        runtime.discardArmed = value;
      },
      get busy() {
        return runtime.mutationBusy;
      },
      set busy(value) {
        runtime.mutationBusy = value;
      },
      get mutationAbort() {
        return runtime.mutationAbort;
      },
      set mutationAbort(value) {
        runtime.mutationAbort = value;
      },
      get namePrompt() {
        return runtime.namePrompt;
      },
      set namePrompt(value) {
        runtime.namePrompt = value;
      },
      get editingCommitSha() {
        return runtime.editingCommitSha;
      },
      set editingCommitSha(value) {
        runtime.editingCommitSha = value;
      },
      get amend() {
        return runtime.amend;
      },
      set amend(value) {
        runtime.amend = value;
      },
      get amendDraft() {
        return runtime.amendDraft;
      },
      set amendDraft(value) {
        runtime.amendDraft = value;
      },
      get editReturnState() {
        return runtime.editReturnState;
      },
      set editReturnState(value) {
        runtime.editReturnState = value;
      },
      get terminalWidth() {
        return runtime.renderer.terminalWidth;
      },
      get terminalHeight() {
        return runtime.renderer.terminalHeight;
      },
      get mode() {
        return runtime.mode;
      },
      files: (section) => this.files(section),
      selectedFile: () => this.selectedFile(),
      copy: (text) => this.renderer.copyToClipboardOSC52(text),
      refresh: (message) => this.refresh(message),
      paintComposer: () => this.paintComposer(),
      notify: (text, tone) => this.notify(text, tone),
      fail: (error) => this.fail(error),
    };
  }
  private perform(
    label: string,
    action: (signal?: AbortSignal) => Promise<void>,
    remote = false,
  ) {
    return performRuntime(this.commandsContext(), label, action, remote);
  }
  private commit() {
    return commitRuntime(this.commandsContext());
  }
  private stageAll() {
    return stageAllRuntime(this.commandsContext());
  }
  private unstageAll() {
    return unstageAllRuntime(this.commandsContext());
  }
  private discardAll() {
    return discardAllRuntime(this.commandsContext());
  }
  private stageFirstHunk() {
    return stageFirstRuntimeHunk(this.commandsContext());
  }
}
