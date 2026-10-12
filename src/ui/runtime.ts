import {
  BoxRenderable,
  CliRenderEvents,
  TextareaRenderable,
  ScrollBoxRenderable,
  InputRenderable,
  ImageRenderable,
  TextRenderable,
  StyledText,
  bg,
  fg,
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
  extendGraphIndex,
  graphWindow,
  type GraphIndex,
} from "./graph-index.js";
import type { DiffView, DiffViewMode } from "./diff-view.js";
import { clampGraphScroll } from "./graph-viewport.js";
import {
  emptyBranchHintIndex,
  resolveHeadSha,
  authorAvatar,
  formatRelativeTime,
  shortSha,
} from "./history.js";
import {
  buildGraphMenu,
  type GraphMenuItem,
  type GraphMenuTarget,
} from "./graph-menu.js";
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
import {
  loadThemeCatalog,
  loadThemePreferences,
  saveThemePreferences,
} from "./theme-store.js";
import { loadInitialTheme, updateWidgetTheme } from "./runtime-theme.js";
import {
  fileViewportSize,
  clipColumns,
  formatHints,
  type ToolbarAction,
  presentCommitMeta,
  presentCommitCoAuthors,
  parseCoAuthors,
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
import { loadLayoutPreferences, saveLayoutPreferences } from "./preferences.js";
import { handleKey as handleRuntimeKey } from "./runtime-keys.js";
import {
  promoteRecentRepository,
  saveSessionPreferences,
} from "./session-preferences.js";
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
  openComparison as openRuntimeComparison,
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
  runFileAction as runRuntimeFileAction,
} from "./runtime-commands.js";
import { RuntimeDiffSelectionController } from "./runtime-diff-selection.js";
import { RuntimeHistoryColumnsController } from "./runtime-history-columns.js";
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

const DEFAULT_REMOTE_FETCH_INTERVAL_MINUTES = 1;

export const BRAILLE_SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;
export const BRAILLE_SPINNER_INTERVAL_MS = 100;

export interface BrailleSpinnerScheduler {
  schedule(callback: () => void, intervalMs: number): unknown;
  cancel(handle: unknown): void;
}

const defaultBrailleSpinnerScheduler: BrailleSpinnerScheduler = {
  schedule: (callback, intervalMs) => setInterval(callback, intervalMs),
  cancel: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/**
 * Small, restartable spinner used by transient busy notifications. Keeping
 * the timer behind this helper makes its lifecycle explicit and testable.
 */
export function createBrailleSpinner(
  render: (frame: string) => void,
  scheduler: BrailleSpinnerScheduler = defaultBrailleSpinnerScheduler,
) {
  let handle: unknown;
  let frame = 0;
  return {
    start() {
      if (handle !== undefined) return;
      frame = 0;
      render(BRAILLE_SPINNER_FRAMES[frame]!);
      handle = scheduler.schedule(() => {
        frame = (frame + 1) % BRAILLE_SPINNER_FRAMES.length;
        render(BRAILLE_SPINNER_FRAMES[frame]!);
      }, BRAILLE_SPINNER_INTERVAL_MS);
    },
    stop() {
      if (handle !== undefined) {
        scheduler.cancel(handle);
        handle = undefined;
      }
      frame = 0;
    },
  };
}

/** Window in which a second click on the same graph row counts as a double. */
const DOUBLE_CLICK_MS = 400;
const FILE_HISTORY_CARD_ROWS = 4;
const fileHistoryDate = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

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
  private themeCatalog?: Awaited<ReturnType<typeof loadThemeCatalog>>;
  themeSelection: Awaited<ReturnType<typeof loadThemePreferences>> = {
    name: "one-dark",
    mode: "dark",
  };

  configureThemes(
    catalog: Awaited<ReturnType<typeof loadThemeCatalog>>,
    selection: Awaited<ReturnType<typeof loadThemePreferences>>,
    warning?: string,
  ) {
    this.themeCatalog = catalog;
    this.themeSelection = selection;
    const warnings = [warning, ...catalog.errors].filter(Boolean);
    if (warnings.length) this.notify(warnings.join("; "), "error");
    this.renderer.on(CliRenderEvents.THEME_MODE, (mode: "dark" | "light") => {
      if (this.themeSelection.mode === "system")
        void this.activateTheme(this.themeSelection, false, mode);
    });
    if (selection.mode === "system") void this.activateTheme(selection, false);
  }

  async activateTheme(
    selection: typeof this.themeSelection,
    persist = true,
    appearance?: "dark" | "light",
    preview = false,
  ) {
    if (!this.themeCatalog) return;
    try {
      const mode =
        selection.mode === "system"
          ? (appearance ?? this.renderer.themeMode ?? "dark")
          : selection.mode;
      setActiveTheme(this.themeCatalog.resolve(selection.name, mode));
      if (!preview) this.themeSelection = selection;
      this.repaintTheme();
      if (persist) await saveThemePreferences(selection);
    } catch (error) {
      this.notify(
        `Theme change failed: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  }

  repaintTheme() {
    this.renderer.setBackgroundColor(oneDarkTheme.bg);
    updateWidgetTheme(this.renderer.root);
    this.commitDiff.updateTheme();
    const commit =
      this.historyFilter?.commits[this.historyFilter.index] ??
      this.snapshot?.commits[this.commitIndex];
    if (commit && this.view === "commit") {
      const meta = presentCommitMeta(commit);
      this.commitInfo.content = meta.info;
      this.commitHeader.content = meta.header;
      this.commitBody.content = meta.body;
      this.commitCoAuthors.content = presentCommitCoAuthors(
        parseCoAuthors(commit.body),
      );
    }
    const headSha = this.snapshot
      ? resolveHeadSha(this.snapshot.branches, this.snapshot.commits)
      : undefined;
    this.graphIndex = emptyGraphIndex(
      this.snapshot?.files.length ? headSha : undefined,
      oneDarkTheme.graph,
    );
    if (this.snapshot)
      extendGraphIndex(
        this.graphIndex,
        this.snapshot.commits,
        oneDarkTheme.graph,
        headSha,
      );
    this.paint();
  }

  async showThemePicker(page: "themes" | "theme-mode") {
    if (page === "themes") {
      const previous = this.themeCatalog;
      const catalog = await loadThemeCatalog(this.repository.root);
      this.themeCatalog = {
        ...catalog,
        entries: catalog.entries.some(
          (entry) => entry.name === this.themeSelection.name,
        )
          ? catalog.entries
          : [
              ...catalog.entries,
              { name: this.themeSelection.name, source: "active selection" },
            ],
        resolve: (name, mode) =>
          catalog.entries.some((entry) => entry.name === name)
            ? catalog.resolve(name, mode)
            : previous
              ? previous.resolve(name, mode)
              : catalog.resolve(name, mode),
      };
      if (catalog.errors.length)
        this.notify(catalog.errors.join("; "), "error");
    }
    this.palette.page = page;
    this.showCommandPalette();
  }
  private historyFilter?: {
    path: string;
    file: ChangedFile;
    commits: RepositorySnapshot["commits"];
    index: number;
    line?: number;
  };
  get historyFilterActive() {
    return this.historyFilter !== undefined;
  }
  get selectedCommitSha() {
    return this.historyFilter?.commits[this.historyFilter.index]?.sha;
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
  private historyFilterRequest = 0;
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
  private messageTimer?: ReturnType<typeof setTimeout>;
  private busySpinnerText = "";
  private readonly busySpinner = createBrailleSpinner((frame) =>
    this.renderBusyNotification(frame),
  );
  // Reading `content` back off a renderable returns a StyledText, so the
  // message text is tracked here for width and layout maths.
  private messageText = "";
  busy = false;
  private disposed = false;
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
  private readonly message: TextRenderable;
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
  private busyFrame = "";
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
  private preferencesTimer?: ReturnType<typeof setTimeout>;
  private sessionPreferencesTimer?: ReturnType<typeof setTimeout>;
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
    const preferences = await loadLayoutPreferences();
    this.avatarsEnabled = preferences.avatarsEnabled ?? true;
    this.diffViewPreference = preferences.diffView ?? "side-by-side";
    this.leftWidth = preferences.leftWidth ?? this.leftWidth;
    this.detailsWidth = preferences.detailsWidth ?? this.detailsWidth;
    this.leftCollapsed = preferences.leftCollapsed ?? this.leftCollapsed;
    this.detailsCollapsed =
      preferences.detailsCollapsed ?? this.detailsCollapsed;
    this.historyColumns = {
      ...this.historyColumns,
      ...Object.fromEntries(
        Object.entries(preferences.historyColumns ?? {}).filter(
          ([, value]) => value !== undefined,
        ),
      ),
    };
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
    await this.flushSessionPreferences();
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
      avatarsEnabled: this.avatarsEnabled,
      diffView: this.diffViewPreference,
      leftWidth: this.leftWidth,
      detailsWidth: this.detailsWidth,
      leftCollapsed: this.leftCollapsed,
      detailsCollapsed: this.detailsCollapsed,
      historyColumns: { ...this.historyColumns },
      unstagedHeight: this.preferredUnstagedHeight,
      composerHeight: this.preferredComposerHeight,
      sidebarHeights: this.sidebarPreferred,
      sidebarCollapsed: this.sidebarCollapsed,
    });
  }
  persistSessionPreferences() {
    if (this.sessionPreferencesTimer)
      clearTimeout(this.sessionPreferencesTimer);
    this.sessionPreferencesTimer = setTimeout(() => {
      this.sessionPreferencesTimer = undefined;
      void this.flushSessionPreferences().catch(() => undefined);
    }, 100);
  }
  private async flushSessionPreferences() {
    if (this.sessionPreferencesTimer) {
      clearTimeout(this.sessionPreferencesTimer);
      this.sessionPreferencesTimer = undefined;
    }
    await saveSessionPreferences({
      repositories: this.tabs.map((tab) => tab.repository.root),
      recentRepositories: this.recentRepositories,
      activeRepository: this.repository.root,
      submodules: Object.fromEntries(
        this.tabs
          .filter(
            (
              tab,
            ): tab is typeof tab & {
              submoduleOf: { root: string; path: string };
            } => Boolean(tab.submoduleOf),
          )
          .map((tab) => [tab.repository.root, tab.submoduleOf]),
      ),
    });
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
  /**
   * Show busy progress in the toolbar and transient messages at bottom right.
   *
   * Messages expire so the keybinding hints on the left, which they never
   * overwrite, remain the resting state of the row.
   */
  notify(text: string, tone: "info" | "error" | "busy" = "info") {
    if (this.disposed) return;
    if (this.messageTimer) clearTimeout(this.messageTimer);
    this.messageTimer = undefined;
    if (tone === "busy") {
      this.stopBusySpinner();
      this.busySpinnerText = text;
      this.messageText = "";
      this.message.content = "";
      this.paintHints();
      this.busySpinner.start();
      return;
    }
    this.stopBusySpinner();
    const limit = Math.max(20, Math.floor(this.renderer.terminalWidth / 2));
    this.messageText = clipColumns(text, limit);
    this.message.content = this.messageText;
    this.message.fg =
      tone === "error" ? oneDarkTheme.deleted : oneDarkTheme.muted;
    this.positionMessage();
    this.paintHints();
    this.messageTimer = setTimeout(() => {
      this.messageText = "";
      this.message.content = "";
      this.messageTimer = undefined;
      this.positionMessage();
      this.paintHints();
    }, 6000);
  }
  private renderBusyNotification(frame: string) {
    this.busyFrame = frame;
    this.paintToolbar();
  }
  private stopBusySpinner() {
    this.busySpinner.stop();
    this.busySpinnerText = "";
    if (!this.disposed) this.paintToolbar();
  }
  private readonly dispose = () => {
    this.disposed = true;
    this.autoRefresh.dispose();
    cancelRuntimeDiff(this);
    this.removeSelectionListener();
    this.stopBusySpinner();
    if (this.messageTimer) clearTimeout(this.messageTimer);
    this.messageTimer = undefined;
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
    if (this.messageTimer) clearTimeout(this.messageTimer);
    await this.flushSessionPreferences().catch(() => undefined);
    for (const tab of this.tabs) tab.repository.dispose?.();
    this.dispose();
    await this.flushLayoutPreferences().catch(() => undefined);
    return this.renderer.destroy();
  }
  fail(error: unknown) {
    this.notify(
      error instanceof Error ? error.message : String(error),
      "error",
    );
  }
  positionMessage() {
    const width = Bun.stringWidth(this.messageText);
    this.message.width = Math.max(1, width);
    this.message.left = Math.max(1, this.renderer.terminalWidth - width - 1);
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
      this.renderer.terminalWidth - Bun.stringWidth(this.messageText) - 4,
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
    if (commit && this.view === "commit") showRuntimeCommitMeta(this, commit);
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
  /** Busy progress for the toolbar, with the current spinner frame. */
  get busyLabel() {
    return this.busySpinnerText
      ? `${this.busyFrame} ${this.busySpinnerText}`
      : undefined;
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
    if (this.historyFilter) {
      const max = Math.max(0, this.historyFilter.commits.length - 1);
      this.historyFilter.index = Math.max(
        0,
        Math.min(max, this.historyFilter.index + delta),
      );
      const viewport = this.historyFilterViewport();
      if (this.historyFilter.index < this.fileStart)
        this.fileStart = this.historyFilter.index;
      else if (this.historyFilter.index >= this.fileStart + viewport)
        this.fileStart = this.historyFilter.index - viewport + 1;
      this.paintHistoryFilter();
      this.showHistoryFilterCommit();
      void this.loadDiff().catch((error) => this.fail(error));
      return;
    }
    scrollRuntimeFiles(this, section, delta);
  }
  filesClick(section: ChangeSection, y: number, button?: number, x?: number) {
    if (this.diffSelection.size) this.clearLineSelection(false);
    if (this.historyFilter) {
      const row =
        Math.floor((y - this.unstagedText.y) / FILE_HISTORY_CARD_ROWS) +
        this.fileStart;
      if (row < 0 || row >= this.historyFilter.commits.length) return;
      this.historyFilter.index = row;
      this.paintHistoryFilter();
      this.showHistoryFilterCommit();
      void this.loadDiff().catch((error) => this.fail(error));
      return;
    }
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
      this.historyFilter?.commits[this.historyFilter.index] ??
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

  get themeEntries() {
    return this.themeCatalog?.entries ?? [];
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
    if (this.historyFilter) {
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
    if (this.historyFilter) {
      layoutChanges(this, this.contentHeight);
      this.paintHistoryFilter();
    }
  }
  paintSidebar() {
    paintRuntimeSidebar(this);
  }
  paintHistory() {
    paintRuntimeHistory(this);
  }
  paintFiles() {
    if (this.historyFilter) {
      layoutChanges(this, this.contentHeight);
      this.paintHistoryFilter();
      return;
    }
    paintRuntimeFiles(this);
  }

  private paintHistoryFilter() {
    const filter = this.historyFilter;
    if (!filter) return;
    this.unstagedLabel.content = ` ${filter.line === undefined ? "File" : "Line"} history · Esc to close `;
    const width = Math.max(12, this.detailsPaneWidth - 3);
    this.unstagedText.content = new StyledText(
      filter.commits
        .slice(this.fileStart, this.fileStart + this.historyFilterViewport())
        .flatMap((commit, offset) => {
          const index = this.fileStart + offset;
          const selected = index === filter.index;
          const marker = selected ? "›" : " ";
          const avatar = authorAvatar(commit.author, commit.authorEmail);
          const subject = clipColumns(commit.subject, Math.max(1, width - 2));
          const identity = clipColumns(
            `${avatar} ${commit.author} · ${shortSha(commit.sha)}`,
            Math.max(1, width - 2),
          );
          const metadata = clipColumns(
            `${formatRelativeTime(commit.committedAt)} · ${fileHistoryDate.format(new Date(commit.committedAt))}`,
            Math.max(1, width - 2),
          );
          const background = selected
            ? oneDarkTheme.selected
            : oneDarkTheme.panel;
          return [
            bg(background)(
              fg(oneDarkTheme.text)(
                `${marker} ${subject}`.padEnd(width) + "\n",
              ),
            ),
            bg(background)(
              fg(selected ? oneDarkTheme.accent : oneDarkTheme.author)(
                `  ${identity}`.padEnd(width) + "\n",
              ),
            ),
            bg(background)(
              fg(oneDarkTheme.muted)(`  ${metadata}`.padEnd(width) + "\n"),
            ),
            bg(oneDarkTheme.panel)(" ".repeat(width) + "\n"),
          ];
        }),
    );
  }

  private historyFilterViewport() {
    return Math.max(
      1,
      Math.floor(Number(this.unstagedText.height) / FILE_HISTORY_CARD_ROWS),
    );
  }

  private showHistoryFilterCommit() {
    const filter = this.historyFilter;
    const commit = filter?.commits[filter.index];
    if (commit) showRuntimeCommitMeta(this, commit);
  }
  paintComposer() {
    paintRuntimeComposer(this);
  }

  ensureFileVisible() {
    ensureRuntimeFileVisible(this);
  }

  loadDiff(allowLarge = false) {
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

  /** Open the graph context menu at a terminal position. */
  openGraphMenu(x: number, y: number, target: GraphMenuTarget) {
    if (!this.snapshot) return;
    if (this.branchFilterActive) this.finishBranchFilter();
    const built = buildGraphMenu(
      target,
      this.snapshot,
      this.comparisonStartSha,
    );
    this.openPopup(built.title, built.items, x, y, (item) => {
      if (item.action) void this.runMenuAction(item.action, target);
    });
  }

  private runMenuAction(
    action: Parameters<typeof runRuntimeMenuAction>[1],
    target: Parameters<typeof runRuntimeMenuAction>[2],
  ) {
    if (action === "file-history") {
      if (target.file)
        void this.showFileHistory(target.file, target.sha || undefined);
      return;
    }
    if (action === "blame-line") {
      if (target.file && target.line !== undefined)
        void this.showLineBlame(
          target.file.path,
          target.line,
          target.sha || undefined,
        );
      return;
    }
    if (action === "line-history") {
      if (target.file && target.line !== undefined)
        void this.showLineHistory(
          target.file,
          target.line,
          target.sha || undefined,
        );
      return;
    }
    if (action === "select-comparison-start") {
      this.comparisonStartSha = target.sha;
      this.history.title = ` Comparison start: ${shortSha(target.sha)} `;
      this.paintHistory();
      this.notify(
        `Comparison start: ${shortSha(target.sha)} · right-click another commit`,
      );
      return;
    }
    if (action === "clear-comparison-start") {
      this.comparisonStartSha = undefined;
      this.history.title = undefined;
      this.paintHistory();
      this.notify("Comparison start cleared");
      return;
    }
    if (action === "compare-with-selected") {
      const base = this.comparisonStartSha;
      if (!base || base === target.sha) return;
      const index = this.snapshot?.commits.findIndex(
        (commit) => commit.sha === target.sha,
      );
      if (index !== undefined && index >= 0) this.commitIndex = index;
      return openRuntimeComparison(this, base);
    }
    return runRuntimeMenuAction(this, action, target);
  }

  private async showFileHistory(file: ChangedFile, start?: string) {
    const path = file.path;
    try {
      const request = ++this.historyFilterRequest;
      const repository = this.repository;
      const snapshot = this.snapshot;
      this.notify(`Loading history for ${path}…`, "busy");
      const commits = await repository.fileHistory(path, start);
      if (
        request !== this.historyFilterRequest ||
        repository !== this.repository ||
        snapshot !== this.snapshot
      )
        return;
      this.installHistoryFilter(file, commits);
    } catch (error) {
      this.fail(error);
    }
  }

  private installHistoryFilter(
    file: ChangedFile,
    commits: RepositorySnapshot["commits"],
    line?: number,
  ) {
    if (!this.snapshot) return;
    this.historyFilter = { path: file.path, file, commits, index: 0, line };
    this.commitFiles = [file];
    this.fileIndex = 0;
    this.fileStart = 0;
    this.mode = "unstaged";
    this.diffOrigin = "commit";
    this.view = "commit";
    this.setFocus("changes");
    this.commitDiff.visible = commits.length > 0;
    this.commitDiffEmpty.visible = commits.length === 0;
    this.history.title = undefined;
    this.showHistoryFilterCommit();
    this.paintHistoryFilter();
    this.layout();
    if (commits.length) void this.loadDiff().catch((error) => this.fail(error));
    this.paint();
    this.notify(commits.length ? "" : `No history found for ${file.path}`);
  }

  private async showLineBlame(path: string, line: number, commit?: string) {
    try {
      const blame = await this.repository.blameLine(path, line, commit);
      this.notify(
        `${shortSha(blame.commit.sha)} · ${blame.commit.author} · ${blame.commit.subject}`,
      );
    } catch (error) {
      this.fail(error);
    }
  }

  private async showLineHistory(
    file: ChangedFile,
    line: number,
    commit?: string,
  ) {
    const path = file.path;
    try {
      const request = ++this.historyFilterRequest;
      const repository = this.repository;
      const snapshot = this.snapshot;
      this.notify(`Loading history for ${path}:${line}…`, "busy");
      const commits = await repository.lineHistory(path, line, commit);
      if (
        request !== this.historyFilterRequest ||
        repository !== this.repository ||
        snapshot !== this.snapshot
      )
        return;
      this.installHistoryFilter(file, commits, line);
    } catch (error) {
      this.fail(error);
    }
  }

  clearHistoryFilter() {
    this.historyFilterRequest++;
    const saved = this.historyFilter;
    if (!saved) return false;
    this.historyFilter = undefined;
    this.history.title = undefined;
    this.closeDiff();
    return true;
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
  private setCommitMetaVisible(visible: boolean) {
    this.commitInfoBox.visible = visible;
    this.commitBodyBox.visible = visible;
  }
  toggleAmend() {
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
  editMessage() {
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
  cancelEditMessage() {
    this.composerSummary.blur();
    this.composerBody.blur();
    this.editingCommitSha = undefined;
    this.restoreEditReturnState();
    const commit = this.snapshot?.commits[this.commitIndex];
    if (commit) showRuntimeCommitMeta(this, commit);
    this.paintComposer();
    this.paintHints();
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
