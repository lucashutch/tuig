import {
  BoxRenderable,
  CliRenderEvents,
  TextareaRenderable,
  ScrollBoxRenderable,
  InputRenderable,
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
  Submodule,
  Worktree,
} from "../git/types.js";
import { type GraphRow } from "./graph.js";
import { createAutoRefresh } from "./auto-refresh.js";
import { debugLog } from "./debug-log.js";
import { type HistoryColumns } from "./history-columns.js";
import {
  emptyGraphIndex,
  graphWindow,
  type GraphIndex,
} from "./graph-index.js";
import type { DiffView, DiffViewMode } from "./diff-view.js";
import { clampGraphScroll } from "./graph-viewport.js";
import { emptyBranchHintIndex, shortSha } from "./history.js";
import { type GraphMenuItem, type GraphMenuTarget } from "./graph-menu.js";
import { RuntimePopupController } from "./runtime-popup.js";
import { RuntimeTabsController, type RuntimeTab } from "./runtime-tabs.js";
import { RuntimePaletteController } from "./runtime-palette.js";
import {
  layoutRuntime,
  layoutChanges,
  clampDetailsWidth,
  clampSidebarWidth,
} from "./runtime-layout.js";
import {
  paint as paintRuntime,
  paintComposer as paintRuntimeComposer,
  paintFiles as paintRuntimeFiles,
  paintHistory as paintRuntimeHistory,
  paintSidebar as paintRuntimeSidebar,
} from "./runtime-paint.js";
import { activeTheme as oneDarkTheme } from "./theme.js";
import { setActiveTheme } from "./theme.js";
import type { ThemeCatalog, ThemeSelection } from "./theme-store.js";
import {
  RuntimeThemeController,
  loadInitialTheme,
  updateWidgetTheme,
} from "./runtime-theme.js";
import {
  fileViewportSize,
  clipColumns,
  formatHints,
  type ToolbarAction,
  type SidebarSection,
} from "./runtime-presentation.js";
import {
  ensureFileVisible as ensureRuntimeFileVisible,
  files as runtimeFiles,
  filesClick as handleRuntimeFilesClick,
  filesHover as handleRuntimeFilesHover,
  filesScroll as scrollRuntimeFiles,
  resizeChangeSplit as resizeRuntimeChangeSplit,
  resizeComposer as resizeRuntimeComposer,
  sectionRows as runtimeSectionRows,
  selectedFile as selectedRuntimeFile,
  toggleSection as toggleRuntimeSection,
} from "./runtime-files.js";
import { handleKey as handleRuntimeKey } from "./runtime-keys.js";
import { promoteRecentRepository } from "./session-preferences.js";
import {
  PANE_TOP,
  createOverlayWidgets,
  createRuntimeWidgets,
  type ChangeSection,
} from "./runtime-widgets.js";
import {
  closeDiff as closeRuntimeDiff,
  cancelDiff as cancelRuntimeDiff,
  loadDiff as loadRuntimeDiff,
  openCommit as openRuntimeCommit,
  openWorkingDiff as openRuntimeWorkingDiff,
  HISTORY_PAGE,
  loadMoreCommits as loadMoreRuntimeCommits,
  refresh as refreshRuntimeData,
  refreshWorkingStatus as refreshRuntimeWorkingStatus,
  showCommitMeta as showRuntimeCommitMeta,
  cancelGraphAvatars as cancelRuntimeGraphAvatars,
  updateGraphAvatars as updateRuntimeGraphAvatars,
  type GraphAvatarRequest,
} from "./runtime-data.js";
import { cancelAvatarWork, terminalGraphicsSupported } from "./avatars.js";
import {
  historyClick as handleHistoryClick,
  moveCommit as moveHistoryCommit,
  queueHistoryScroll as queueRuntimeHistoryScroll,
} from "./runtime-history.js";
import {
  acceptBranchFilter as acceptRuntimeBranchFilter,
  activateFilteredBranch as activateRuntimeFilteredBranch,
  cancelBranchFilter as cancelRuntimeBranchFilter,
  finishBranchFilter as finishRuntimeBranchFilter,
  resizeSidebar as resizeRuntimeSidebar,
  sidebarClick as handleSidebarClick,
  cancelSidebarScroll as cancelRuntimeSidebarScroll,
  sidebarScroll as scrollRuntimeSidebar,
  startBranchFilter as startRuntimeBranchFilter,
  updateBranchFilter as updateRuntimeBranchFilter,
  toggleSidebarSection as toggleRuntimeSidebarSection,
} from "./runtime-sidebar.js";
import {
  cancelActiveMutation,
  cancelEditMessage as cancelRuntimeEditMessage,
  editMessage as editRuntimeMessage,
  toggleAmend as toggleRuntimeAmend,
  checkoutBranch as checkoutRuntimeBranch,
  commit as commitRuntime,
  discardAll as discardAllRuntime,
  perform as performRuntime,
  runToolbarAction as runRuntimeToolbarAction,
  stageAll as stageAllRuntime,
  stageFirstHunk as stageFirstRuntimeHunk,
  submitNamePrompt as submitRuntimeNamePrompt,
  unstageAll as unstageAllRuntime,
  runFileAction as runRuntimeFileAction,
} from "./runtime-commands.js";
import { RuntimeDiffSelectionController } from "./runtime-diff-selection.js";
import { RuntimeFileHistoryController } from "./runtime-file-history.js";
import { RuntimeHistoryColumnsController } from "./runtime-history-columns.js";
import {
  DEFAULT_REMOTE_FETCH_INTERVAL_MINUTES,
  RuntimePreferencesController,
} from "./runtime-preferences.js";
import { openGraphMenu as openRuntimeGraphMenu } from "./runtime-graph-menu.js";
import { RuntimeNotificationsController } from "./runtime-notifications.js";
import { RuntimeToolbarController } from "./runtime-toolbar.js";
import {
  bindOverlayInputs,
  createOverlayActions,
  createRuntimeActions,
} from "./runtime-events.js";

export async function runTuig(
  repositories: GitRepository[],
  activeRepository?: string,
  submodules: Record<string, { root: string; path: string }> = {},
  _reserved?: undefined,
  recentRepositories: string[] = [],
): Promise<void> {
  const repository =
    repositories.find((candidate) => candidate.root === activeRepository) ??
    repositories[0];
  if (!repository) throw new Error("Tuig requires at least one repository");
  const initialTheme = await loadInitialTheme(repository.root);
  const { catalog, selection } = initialTheme;
  setActiveTheme(initialTheme.theme);
  const renderer = await createCliRenderer({
    useMouse: true,
    enableMouseMovement: true,
    exitOnCtrlC: false,
    backgroundColor: oneDarkTheme.bg,
  });
  if (selection.mode === "system") {
    const mode = await renderer.waitForThemeMode(200);
    setActiveTheme(catalog.resolve(selection.name, mode ?? "dark"));
    renderer.setBackgroundColor(oneDarkTheme.bg);
  }
  renderer.setTerminalTitle(`tuig · ${repository.root}`);
  const app = new Runtime(
    renderer,
    repositories,
    repository.root,
    submodules,
    recentRepositories,
  );
  app.configureThemes(catalog, selection, initialTheme.warning);
  await app.start();
}

/** Window in which a second click on the same graph row counts as a double. */
const DOUBLE_CLICK_MS = 400;

export class Runtime {
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
  snapshot?: RepositorySnapshot;
  snapshotSignature?: string;
  historyLimit = HISTORY_PAGE;
  loadingMoreCommits = false;
  historyPageFailures = 0;
  commitIndex = 0;
  historySelection: "working" | "commit" = "working";
  fileIndex = 0;
  mode: ChangeSection = "unstaged";
  view: "history" | "commit" | "working" = "history";
  commitFiles: ChangedFile[] = [];
  /** Older endpoint retained while the user browses for a comparison target. */
  comparisonStartSha?: string;
  /** Older endpoint for the comparison surface currently open. */
  comparisonBaseSha?: string;
  graphIndex: GraphIndex = emptyGraphIndex();
  readonly themes = new RuntimeThemeController(this);
  get themeSelection() {
    return this.themes.selection;
  }
  get themeEntries() {
    return this.themes.entries;
  }

  configureThemes(
    catalog: ThemeCatalog,
    selection: ThemeSelection,
    warning?: string,
  ) {
    this.themes.configure(catalog, selection, warning);
  }

  activateTheme(
    selection: ThemeSelection,
    persist = true,
    appearance?: "dark" | "light",
    preview = false,
  ) {
    return this.themes.activate(selection, persist, appearance, preview);
  }

  repaintTheme() {
    this.themes.repaint();
  }

  showThemePicker(page: "themes" | "theme-mode") {
    return this.themes.showPicker(page);
  }
  readonly fileHistory = new RuntimeFileHistoryController(this);
  get historyFilterActive() {
    return this.fileHistory.active;
  }
  get selectedCommitSha() {
    return this.fileHistory.selectedCommit?.sha;
  }

  // Horizontal graph offset, in lanes, used once the graph is wider than the
  // share of the history pane it is allowed to take.
  graphScroll = 0;
  graphVisibleColumns = 1;
  branchHints = new Map<string, string>();
  branchHintIndex = emptyBranchHintIndex();
  historyStart = 0;
  historyViewportDetached = false;
  historyContentWidth = 1;
  historyColumns: HistoryColumns = {
    showCommitter: true,
    showSha: true,
  };
  readonly historyHeader = new RuntimeHistoryColumnsController(this);
  // Mouse events carry absolute terminal columns, so the column the history
  // text starts at is kept to translate them into row offsets.
  historyContentLeft = 1;
  fileStart = 0;
  sectionCollapsed: Record<ChangeSection, boolean> = {
    unstaged: false,
    staged: false,
  };
  sectionStart: Record<ChangeSection, number> = {
    unstaged: 0,
    staged: 0,
  };
  discardArmed = false;
  mutationBusy?: string;
  mutationAbort?: AbortController;
  diffRequest = 0;
  diffAbort?: AbortController;
  diffTooLarge = false;
  commitFilesRequest = 0;
  snapshotRequest = 0;
  snapshotReadStartedAt?: number;
  // Only the active tab is watched. A tab switch reads a fresh snapshot, so
  // background tabs need no watch or poll of their own.
  readonly autoRefresh = createAutoRefresh({
    poll: () => {
      if (!this.composing) void this.refresh("Auto-refreshing…", true);
    },
    changed: (changedAt) => this.refreshForWatchedChange(changedAt),
    fallback: (error) =>
      debugLog("refresh", "watching failed, polling instead", error),
  });
  autoRefreshStarted = false;
  private remoteFetchTimer?: ReturnType<typeof setInterval>;
  private remoteFetchIntervalMinutes = DEFAULT_REMOTE_FETCH_INTERVAL_MINUTES;
  scrollTimer?: ReturnType<typeof setTimeout>;
  scrollSettleTimer?: ReturnType<typeof setTimeout>;
  historyScrolling = false;
  pendingScroll = 0;
  historyShaHits = new Map<number, { start: number; end: number }>();
  historyLabelHits = new Map<
    number,
    { start: number; end: number; ref?: BranchRef }
  >();
  readonly popupController: RuntimePopupController;
  readonly palette: RuntimePaletteController;
  readonly repositoryTabs: RuntimeTabsController;
  lastGraphClick?: { row: number; at: number; label: boolean };
  expandedFiles = new Set<string>();
  seenFileDirectories = new Set<string>();
  hoveredFileRow?: { section: ChangeSection; row: number };
  focus: "history" | "changes" = "history";
  syncedAt?: number;
  readonly notifications = new RuntimeNotificationsController(this);
  busy = false;
  refreshPending = false;
  pendingRefreshMessage?: string;
  readonly header: TextRenderable;
  readonly tabBar: TextRenderable;
  private readonly avatarToggle: TextRenderable;
  readonly diffViewToggle: TextRenderable;
  readonly toolbar: TextRenderable;
  readonly sidebar: BoxRenderable;
  readonly history: BoxRenderable;
  readonly details: BoxRenderable;
  private readonly hints: TextRenderable;
  readonly message: TextRenderable;
  private readonly sidebarText: TextRenderable;
  readonly sidebarSections: ReturnType<
    typeof createRuntimeWidgets
  >["sidebarSections"];
  readonly historyText: TextRenderable;
  readonly commitDiff: DiffView;
  readonly commitDiffEmpty: TextRenderable;
  readonly unstagedLabel: TextRenderable;
  readonly unstagedText: TextRenderable;
  readonly stagedLabel: TextRenderable;
  readonly stagedText: TextRenderable;
  readonly unstagedDivider: BoxRenderable;
  readonly composerDivider: BoxRenderable;
  readonly unstagedDividerBar: TextRenderable;
  readonly composerDividerBar: TextRenderable;
  readonly discardButton: TextRenderable;
  readonly stageAllButton: TextRenderable;
  readonly unstageAllButton: TextRenderable;
  readonly composerBox: BoxRenderable;
  readonly composerSummary: InputRenderable;
  readonly composerBody: TextareaRenderable;
  readonly commitButton: TextRenderable;
  readonly amendButton: TextRenderable;
  readonly workingBanner: TextRenderable;
  readonly commitInfoBox: BoxRenderable;
  readonly commitInfoLabel: TextRenderable;
  readonly commitBodyBox: ScrollBoxRenderable;
  readonly commitInfo: TextRenderable;
  readonly authorPhoto: ImageRenderable;
  readonly authorBadge: TextRenderable;
  readonly commitCoAuthors: TextRenderable;
  readonly commitCoAuthorProvider: ImageRenderable;
  readonly graphAvatars: ImageRenderable[];
  readonly ensureGraphAvatarSlots: (count: number) => void;
  readonly editMessageButton: TextRenderable;
  readonly commitHeader: TextRenderable;
  readonly commitBody: TextRenderable;
  readonly leftDivider: BoxRenderable;
  readonly rightDivider: BoxRenderable;
  readonly leftDividerBar: TextRenderable;
  readonly rightDividerBar: TextRenderable;
  readonly overlayCatcher: BoxRenderable;
  private readonly menuBox: BoxRenderable;
  private readonly menuText: TextRenderable;
  private readonly submenuBox: BoxRenderable;
  private readonly submenuText: TextRenderable;
  readonly branchFilterInput: InputRenderable;
  readonly promptInput: InputRenderable;
  readonly repositoryPathInput: InputRenderable;
  readonly repositoryPickerBox: BoxRenderable;
  readonly repositoryPickerText: TextRenderable;
  readonly commandPaletteBox: BoxRenderable;
  readonly commandPaletteInput: InputRenderable;
  readonly commandPaletteText: TextRenderable;
  readonly commandPaletteFooter: TextRenderable;
  repository: GitRepository;
  tabs: RuntimeTab[];
  activeTabId: string;
  nextTabId = 1;
  lastSidebarClick?: { key: string; at: number };
  recentRepositories: string[];
  leftWidth = 28;
  detailsWidth = 44;
  leftCollapsed = false;
  sidebarCollapsed: Record<SidebarSection, boolean> = {
    local: false,
    remote: false,
    submodules: false,
    stashes: false,
    worktrees: false,
  };
  sidebarPreferred: Record<SidebarSection, number | undefined> = {
    local: undefined,
    remote: undefined,
    submodules: undefined,
    stashes: undefined,
    worktrees: undefined,
  };
  sidebarStart: Record<SidebarSection, number> = {
    local: 0,
    remote: 0,
    submodules: 0,
    stashes: 0,
    worktrees: 0,
  };
  sidebarPendingScroll: Record<SidebarSection, number> = {
    local: 0,
    remote: 0,
    submodules: 0,
    stashes: 0,
    worktrees: 0,
  };
  sidebarScrollTimers: Record<
    SidebarSection,
    ReturnType<typeof setTimeout> | undefined
  > = {
    local: undefined,
    remote: undefined,
    submodules: undefined,
    stashes: undefined,
    worktrees: undefined,
  };
  detailsCollapsed = false;
  branchFilter = "";
  branchFilterActive = false;
  branchSelection: Record<"local" | "remote", number> = {
    local: -1,
    remote: -1,
  };
  namePrompt?: {
    title: string;
    placeholder: string;
    run: (value: string) => Promise<void>;
  };
  diffOrigin?: "working" | "commit";
  private readonly diffSelection = new RuntimeDiffSelectionController(this);
  suppressEnterUntil = 0;
  commitFilesTop = 19;
  // Widths read back off renderables can lag by a frame, so panes keep the
  // numeric widths from the latest layout pass for width-dependent painting.
  sidebarPaneWidth = 28;
  detailsPaneWidth = 44;
  readonly toolbarController = new RuntimeToolbarController(this);
  commitHeaderValue = "";
  commitBodyValue = "";
  commitInfoValue = "";
  commitCoAuthorsValue = "";
  commitCoAuthorsProviderVisible = false;
  avatarRequest = 0;
  avatarsEnabled = true;
  diffViewPreference: DiffViewMode = "side-by-side";
  avatarAbort?: AbortController;
  graphAvatarKeys: Array<string | undefined> = [];
  graphAvatarTokens: number[] = [];
  graphAvatarAborts: Array<AbortController | undefined> = [];
  preferredUnstagedHeight?: number;
  preferredComposerHeight?: number;
  private readonly preferences = new RuntimePreferencesController(this);
  amend = false;
  amendDraft?: { summary: string; body: string };
  editingCommitSha?: string;
  editReturnState?: {
    summary: string;
    body: string;
    amend: boolean;
    amendDraft?: { summary: string; body: string };
  };

  constructor(
    readonly renderer: CliRenderer,
    repositories: GitRepository[],
    activeRepository: string,
    submodules: Record<string, { root: string; path: string }> = {},
    recentRepositories: string[] = [],
  ) {
    this.recentRepositories = promoteRecentRepository(
      recentRepositories,
      repositories.find((candidate) => candidate.root === activeRepository)
        ?.root ?? repositories[0]!.root,
    );
    const repository =
      repositories.find((candidate) => candidate.root === activeRepository) ??
      repositories[0]!;
    this.repository = repository;
    this.tabs = repositories.map((repository, index) => ({
      id: `repository-${index}`,
      repository,
      submoduleOf: submodules[repository.root],
    }));
    this.nextTabId = repositories.length;
    this.activeTabId = this.tabs.find(
      (tab) => tab.repository.root === repository.root,
    )!.id;
    const widgets = createRuntimeWidgets(renderer, createRuntimeActions(this));
    this.sidebar = widgets.sidebar;
    this.tabBar = widgets.tabBar;
    this.avatarToggle = widgets.avatarToggle;
    this.diffViewToggle = widgets.diffViewToggle;
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
    this.ensureGraphAvatarSlots = widgets.ensureGraphAvatarSlots;
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
    const overlays = createOverlayWidgets(renderer, createOverlayActions(this));
    this.branchFilterInput = overlays.branchFilterInput;
    this.promptInput = overlays.promptInput;
    this.repositoryPickerBox = overlays.repositoryPickerBox;
    this.repositoryPathInput = overlays.repositoryPathInput;
    this.repositoryPickerText = overlays.repositoryPickerText;
    this.commandPaletteBox = overlays.commandPaletteBox;
    this.commandPaletteInput = overlays.commandPaletteInput;
    this.commandPaletteText = overlays.commandPaletteText;
    this.commandPaletteFooter = overlays.commandPaletteFooter;
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
    this.palette = new RuntimePaletteController(this);
    this.repositoryTabs = new RuntimeTabsController(this);
    bindOverlayInputs(this);
    this.renderer.root.add(this.branchFilterInput);
    this.renderer.root.add(this.promptInput);
    this.renderer.root.add(this.repositoryPickerBox);
    this.renderer.root.add(this.commandPaletteBox);
    updateWidgetTheme(this.renderer.root);
    this.renderer.on(CliRenderEvents.SELECTION, this.copyCompletedSelection);
    this.renderer.once(CliRenderEvents.DESTROY, this.dispose);
  }

  async start() {
    this.remoteFetchIntervalMinutes = await this.preferences.restoreLayout();
    await this.preferences.flushSession();
    // OpenTUI starts demand-driven. start() would render at 30 FPS even when
    // nothing changes; widget invalidations and spinner ticks request frames.
    this.renderer.requestRender();
    // Terminal dimensions are reliable only after the renderer has started.
    await Bun.sleep(0);
    // Saved widths come from a terminal of unknown size, so clamp them to the
    // live one. Layout clamps again on every later resize.
    this.leftWidth = clampSidebarWidth(
      this.leftWidth,
      this.renderer.terminalWidth,
    );
    this.detailsWidth = clampDetailsWidth(
      this.detailsWidth,
      this.renderer.terminalWidth,
    );
    this.layout();
    await this.refresh();
    await this.repositoryTabs.focusCheckedOutCommit();
    // Refresh creates width-dependent history content; recompute once with
    // the live snapshot so startup follows the same path as a manual resize.
    this.layout();
    this.autoRefreshStarted = true;
    void this.autoRefresh.follow(this.repository);
    if (this.remoteFetchIntervalMinutes > 0) {
      this.remoteFetchTimer = setInterval(() => {
        if (!this.composing && !this.busy && !this.repository.authBlocked)
          void this.perform(
            "Fetching remote changes…",
            () => this.repository.fetch(),
            true,
          );
      }, this.remoteFetchIntervalMinutes * 60_000);
    }
  }
  persistLayoutPreferences() {
    this.preferences.persistLayout();
  }
  persistSessionPreferences() {
    this.preferences.persistSession();
  }
  /** True while either commit-message editor holds the keyboard. */
  get composing(): boolean {
    const focused = this.renderer.currentFocusedEditor;
    return (
      focused === this.composerSummary ||
      focused === this.composerBody ||
      focused === this.branchFilterInput ||
      focused === this.promptInput ||
      focused === this.repositoryPathInput
    );
  }
  label(section: ChangeSection): TextRenderable {
    return section === "unstaged" ? this.unstagedLabel : this.stagedLabel;
  }
  list(section: ChangeSection): TextRenderable {
    return section === "unstaged" ? this.unstagedText : this.stagedText;
  }
  /** Rows the given list can show, which is its rendered height. */
  sectionViewport(section: ChangeSection): number {
    if (this.view === "commit")
      return Math.max(
        1,
        fileViewportSize(this.view, this.contentHeight, this.commitFilesTop) -
          1,
      );
    return Math.max(0, Number(this.list(section).height));
  }
  /** Rows available to the panes, once the header row is taken out. */
  get contentHeight(): number {
    return Math.max(1, this.renderer.terminalHeight - PANE_TOP);
  }
  notify(text: string, tone: "info" | "error" | "busy" = "info") {
    this.notifications.notify(text, tone);
  }
  /** Busy progress for the toolbar, with the current spinner frame. */
  get busyLabel() {
    return this.notifications.busyLabel;
  }
  private readonly dispose = () => {
    this.autoRefresh.dispose();
    cancelRuntimeDiff(this);
    this.removeSelectionListener();
    this.notifications.dispose();
  };
  async shutdown() {
    this.avatarAbort?.abort();
    cancelRuntimeGraphAvatars(this);
    cancelAvatarWork();
    this.mutationAbort?.abort();
    this.autoRefresh.dispose();
    if (this.remoteFetchTimer) clearInterval(this.remoteFetchTimer);
    if (this.scrollTimer) clearTimeout(this.scrollTimer);
    if (this.scrollSettleTimer) clearTimeout(this.scrollSettleTimer);
    cancelRuntimeSidebarScroll(this);
    this.notifications.clearMessageTimer();
    await this.preferences.flushSession().catch(() => undefined);
    for (const tab of this.tabs) tab.repository.dispose?.();
    this.dispose();
    await this.preferences.flushLayout().catch(() => undefined);
    return this.renderer.destroy();
  }
  fail(error: unknown) {
    this.notify(
      error instanceof Error ? error.message : String(error),
      "error",
    );
  }
  positionMessage() {
    this.notifications.positionMessage();
  }
  paintHints() {
    const text = formatHints({
      focus: this.focus,
      view: this.view,
      composing: this.composing,
      lineSelection: this.diffSelection.size
        ? {
            count: this.diffSelection.size,
            action: this.mode === "staged" ? "unstage" : "stage",
          }
        : undefined,
    });
    const room = Math.max(
      10,
      this.renderer.terminalWidth -
        Bun.stringWidth(this.notifications.messageText) -
        4,
    );
    // Hints must not pad, or the padding would erase the message beside them.
    const content = clipColumns(text, room);
    this.hints.width = Math.max(1, Bun.stringWidth(content));
    this.hints.content = content;
  }
  paintHeader() {
    this.toolbarController.paintHeader();
  }
  paintViewToggles() {
    this.avatarToggle.content = `${this.avatarsEnabled ? "■" : "□"} Avatars`;
    const splitPreferred = this.diffViewPreference === "side-by-side";
    this.diffViewToggle.content = `${splitPreferred ? "■" : "□"} ${
      splitPreferred
        ? this.commitDiff.view === "split"
          ? "Side by side"
          : "Split (narrow)"
        : "Inline"
    }`;
  }

  get widgets() {
    return this;
  }

  // OpenTUI falls back to colored character blocks when Kitty and Sixel
  // graphics are unavailable. Those approximations are too coarse for
  // these small avatars, so use the text fallbacks instead.
  get avatarSupported() {
    return (
      this.avatarsEnabled &&
      terminalGraphicsSupported(this.authorPhoto.effectiveProtocol)
    );
  }

  toggleAvatars() {
    this.avatarsEnabled = !this.avatarsEnabled;
    this.avatarAbort?.abort();
    cancelRuntimeGraphAvatars(this);
    const commit = this.snapshot?.commits[this.commitIndex];
    if (commit && this.view === "commit") this.showCommitMeta(commit);
    this.persistLayoutPreferences();
    this.repositoryTabs.paintTabs();
    this.paint();
  }

  toggleDiffView() {
    this.diffViewPreference =
      this.diffViewPreference === "side-by-side" ? "inline" : "side-by-side";
    this.persistLayoutPreferences();
    this.layout();
  }

  dismissOverlay() {
    if (this.commandPaletteOpen) return this.closeCommandPalette();
    this.popupController.close();
  }

  private get commandPaletteOpen() {
    return this.palette.isOpen;
  }

  get commandPaletteRows() {
    return this.palette.rows;
  }

  showCommandPalette() {
    this.palette.show();
  }

  closeCommandPalette(restoreFocus = true) {
    this.palette.close(restoreFocus);
  }

  private paintCommandPalette() {
    this.palette.paint();
  }

  movePaletteSelection(delta: number) {
    this.palette.moveSelection(delta);
  }

  paintToolbar() {
    this.toolbarController.paint();
  }
  runToolbarAction(action: ToolbarAction) {
    return runRuntimeToolbarAction(this, action);
  }
  setFocus(focus: "history" | "changes") {
    if (this.focus === focus) return;
    this.focus = focus;
    this.paintHints();
    this.paint();
  }
  layout() {
    layoutRuntime(this);
    this.repositoryTabs.paintTabs();
    this.paintCommandPalette();
  }
  layoutChanges(height: number) {
    layoutChanges(this, height);
  }
  files(section: ChangeSection = this.mode): ChangedFile[] {
    return runtimeFiles(this, section);
  }
  sectionRows(section: ChangeSection) {
    return runtimeSectionRows(this, section);
  }
  toggleSection(section: ChangeSection) {
    toggleRuntimeSection(this, section);
  }
  resizeChangeSplit(y: number) {
    resizeRuntimeChangeSplit(this, y);
  }
  resizeComposer(y: number) {
    resizeRuntimeComposer(this, y);
  }
  filesHover(section: ChangeSection, y?: number) {
    handleRuntimeFilesHover(this, section, y);
  }
  filesScroll(section: ChangeSection, delta: number) {
    if (this.fileHistory.scroll(delta)) return;
    scrollRuntimeFiles(this, section, delta);
  }
  filesClick(section: ChangeSection, y: number, button?: number, x?: number) {
    if (this.diffSelection.size) this.clearLineSelection(false);
    if (this.fileHistory.click(y)) return;
    handleRuntimeFilesClick(this, section, y, button, x);
  }
  readonly paneTop = PANE_TOP;
  readonly doubleClickMs = DOUBLE_CLICK_MS;

  get commitDiffVisible() {
    return this.commitDiff.visible;
  }

  // A getter, not a snapshot: a page can land while a queued scroll still
  // holds the runtime, and it would clamp against a stale count.
  get graphRowCount() {
    return this.graphIndex.length;
  }

  openSubmodule(submodule: Submodule) {
    return this.repositoryTabs.openSubmodule(submodule);
  }

  openWorktree(worktree: Worktree) {
    return this.repositoryTabs.openWorktree(worktree);
  }

  get graphColumns() {
    return this.graphIndex.columns;
  }

  /** The header separator under the pointer or being dragged. */
  get historyDivider() {
    return this.historyHeader.divider;
  }

  get hoveredHistoryLine() {
    return this.historyHeader.hoveredLine;
  }

  requestMoreCommits() {
    void loadMoreRuntimeCommits(this);
  }

  updateGraphAvatars(requests: readonly GraphAvatarRequest[]) {
    return updateRuntimeGraphAvatars(this, requests);
  }

  get headSha() {
    return this.snapshot?.headSha;
  }

  selectedCommit() {
    return (
      this.fileHistory.selectedCommit ??
      this.snapshot?.commits[this.commitIndex]
    );
  }

  get terminalWidth() {
    return this.renderer.terminalWidth;
  }

  get terminalHeight() {
    return this.renderer.terminalHeight;
  }

  copy(text: string) {
    return this.renderer.copyToClipboardOSC52(text);
  }

  focusComposer() {
    setTimeout(() => this.composerSummary.focus(), 0);
  }

  get focusedEditor() {
    return this.renderer.currentFocusedEditor;
  }

  get mutationActive() {
    return this.mutationAbort !== undefined;
  }

  /** Diff lines selected for line staging. */
  get selectedLineCount() {
    return this.diffSelection.size;
  }

  cancelMutation() {
    void cancelActiveMutation(this);
  }

  get snapshotCommitSha() {
    return this.snapshot?.commits[this.commitIndex]?.sha;
  }

  runFileAction(
    action: "stage" | "discard" | "unstage",
    files: ChangedFile[],
    directory: boolean,
  ) {
    void runRuntimeFileAction(this, action, files, directory);
  }

  selectedFile() {
    return selectedRuntimeFile(this);
  }

  refresh(message?: string, automatic = false) {
    if (this.fileHistory.active) {
      if (automatic) return Promise.resolve();
      this.clearHistoryFilter();
    }
    return refreshRuntimeData(this, message, automatic);
  }

  /**
   * Refresh for a change seen on disk. Returning false asks the watcher to
   * try again later, while the user types or another Git read or mutation
   * runs. A snapshot read that started after the change already includes it,
   * which also absorbs the events Tuig's own mutations cause.
   */
  private refreshForWatchedChange(changedAt: number) {
    if (this.composing || this.busy || this.mutationBusy) return false;
    if ((this.snapshotReadStartedAt ?? -Infinity) > changedAt) return true;
    void this.refresh(undefined, true);
    return true;
  }

  /** Refresh after a change that cannot have touched history. */
  refreshWorkingStatus(message?: string) {
    return refreshRuntimeWorkingStatus(this, message);
  }

  paint() {
    paintRuntime(this);
    // The shared painter renders the ordinary commit-file picker. File-history
    // mode reuses that surface, so it must be the final writer on every full
    // paint rather than only on scroll events.
    if (this.fileHistory.active) {
      layoutChanges(this, this.contentHeight);
      this.fileHistory.paint();
    }
  }
  paintSidebar() {
    paintRuntimeSidebar(this);
  }
  paintHistory() {
    paintRuntimeHistory(this);
  }
  paintFiles() {
    if (this.fileHistory.active) {
      layoutChanges(this, this.contentHeight);
      this.fileHistory.paint();
      return;
    }
    paintRuntimeFiles(this);
  }

  paintComposer() {
    paintRuntimeComposer(this);
  }

  ensureFileVisible() {
    ensureRuntimeFileVisible(this);
  }

  loadDiff(allowLarge = false): Promise<void> {
    return loadRuntimeDiff(this, allowLarge);
  }

  moveCommit(delta: number) {
    const wasCommitView = this.view === "commit";
    moveHistoryCommit(this, delta);
    if (
      wasCommitView &&
      this.view === "commit" &&
      this.historySelection === "commit"
    )
      void this.openCommit();
  }
  /**
   * Rows for a visible range, replayed from the nearest lane checkpoint.
   *
   * Held rows cost about 750 bytes a commit, so the graph is stored as lane
   * state every few hundred rows and the window is rebuilt when it is painted.
   */
  graphRowsAt(from: number, count: number): readonly GraphRow[] {
    const commits = this.snapshot?.commits;
    if (!commits) return [];
    return graphWindow(
      this.graphIndex,
      commits,
      oneDarkTheme.graph,
      from,
      count,
    );
  }
  queueHistoryScroll(delta: number) {
    queueRuntimeHistoryScroll(this, delta);
  }
  /** Pan the graph sideways; returns false when nothing is hidden. */
  scrollGraphColumns(delta: number): boolean {
    const next = clampGraphScroll(
      this.graphScroll + delta,
      this.graphIndex.columns,
      this.graphVisibleColumns,
    );
    if (this.graphIndex.columns <= this.graphVisibleColumns) return false;
    if (next === this.graphScroll) return true;
    this.graphScroll = next;
    this.paintHistory();
    return true;
  }
  historyClick(x: number, y: number, button: number) {
    if (this.historyHeader.click(x, y, button)) return;
    handleHistoryClick(this, x, y, button);
  }

  openGraphMenu(x: number, y: number, target: GraphMenuTarget) {
    openRuntimeGraphMenu(this, x, y, target);
  }

  showCommitMeta(commit: RepositorySnapshot["commits"][number]) {
    showRuntimeCommitMeta(this, commit);
  }

  clearHistoryFilter() {
    return this.fileHistory.clear();
  }
  checkoutBranch(branch: BranchRef) {
    return checkoutRuntimeBranch(this, branch);
  }
  submitNamePrompt() {
    return submitRuntimeNamePrompt(this);
  }

  openPopup(
    title: string,
    items: GraphMenuItem[],
    x: number,
    y: number,
    select: (item: GraphMenuItem) => void,
    promptActive = false,
  ) {
    this.popupController.open(title, items, x, y, select, promptActive);
  }

  closePopup() {
    this.popupController.close();
  }

  openCommit() {
    return openRuntimeCommit(this);
  }
  openWorkingDiff() {
    return openRuntimeWorkingDiff(this);
  }
  closeDiff() {
    closeRuntimeDiff(this);
  }

  copyCommitSha() {
    const sha = this.snapshot?.commits[this.commitIndex]?.sha;
    if (!sha) return;
    if (this.renderer.copyToClipboardOSC52(sha))
      this.notify(`Copied ${shortSha(sha)}`);
  }
  toggleAmend() {
    toggleRuntimeAmend(this);
  }
  editMessage() {
    editRuntimeMessage(this);
  }
  cancelEditMessage() {
    cancelRuntimeEditMessage(this);
  }
  sidebarClick(x: number, y: number, button: number) {
    handleSidebarClick(this, x, y, button);
  }
  startBranchFilter() {
    startRuntimeBranchFilter(this);
  }
  finishBranchFilter() {
    finishRuntimeBranchFilter(this);
  }
  private acceptBranchFilter() {
    acceptRuntimeBranchFilter(this);
  }
  branchFilterChanged() {
    updateRuntimeBranchFilter(this);
  }
  activateFilteredBranch() {
    activateRuntimeFilteredBranch(this);
  }
  cancelBranchFilter() {
    cancelRuntimeBranchFilter(this);
  }
  toggleSidebarSection(section: SidebarSection) {
    toggleRuntimeSidebarSection(this, section);
  }
  sidebarScroll(y: number, delta: number) {
    scrollRuntimeSidebar(this, y, delta);
  }
  resizeSidebar(section: SidebarSection, y: number) {
    resizeRuntimeSidebar(this, section, y);
  }

  key(key: KeyEvent) {
    return handleRuntimeKey(this, key);
  }
  diffClick(x: number, y: number, button: number, ctrl: boolean, alt: boolean) {
    this.diffSelection.click(x, y, button, ctrl, alt);
  }
  diffDrag(x: number, y: number) {
    return this.diffSelection.drag(x, y);
  }
  diffDragEnd() {
    return this.diffSelection.dragEnd();
  }
  clearLineSelection(notify = true) {
    this.diffSelection.clear(notify);
  }
  applySelectedLines(discard = false) {
    return this.diffSelection.apply(discard);
  }
  perform(
    label: string,
    action: (signal?: AbortSignal) => Promise<void>,
    remote = false,
    scope: "history" | "working" = "history",
  ) {
    return performRuntime(this, label, action, remote, scope);
  }
  commit() {
    return commitRuntime(this);
  }
  stageAll() {
    return stageAllRuntime(this);
  }
  unstageAll() {
    return unstageAllRuntime(this);
  }
  discardAll() {
    return discardAllRuntime(this);
  }
  stageFirstHunk() {
    return stageFirstRuntimeHunk(this);
  }
}
