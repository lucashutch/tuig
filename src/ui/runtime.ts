import {
  BoxRenderable,
  MouseButton,
  CliRenderEvents,
  TextareaRenderable,
  ScrollBoxRenderable,
  InputRenderable,
  InputRenderableEvents,
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
import { resolve } from "node:path";
import {
  createGitRepository,
  NotGitRepositoryError,
  resolveRepositoryPath,
  suggestDirectories,
  type DirectorySuggestion,
} from "../git/index.js";
import type {
  BranchRef,
  ChangedFile,
  GitRepository,
  RepositorySnapshot,
  Submodule,
} from "../git/types.js";
import { type GraphRow } from "./graph.js";
import {
  historyColumnLayout,
  historyDividerAt,
  type HistoryColumns,
} from "./history-columns.js";
import {
  emptyGraphIndex,
  graphWindow,
  type GraphIndex,
} from "./graph-index.js";
import type { DiffView } from "./diff-view.js";
import { clampGraphScroll } from "./graph-viewport.js";
import {
  branchRefsForSection,
  clampBranchSelection,
  emptyBranchHintIndex,
  moveBranchSelection,
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
import {
  clampPaletteViewport,
  commandMatches,
  nextEnabledCommand,
  type PaletteCommand,
  type PaletteMatch,
} from "./command-palette.js";
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
  paintSidebar as paintRuntimeSidebar,
  type RuntimePaintContext,
  type RuntimeSidebarPaintContext,
} from "./runtime-paint.js";
import { oneDarkTheme } from "./theme.js";
import {
  layoutRepositoryTabs,
  repositoryTabText,
  repositoryTabHit,
  reorderRepositoryTabs,
  submoduleTabLabel,
  type RepositoryTabsLayout,
} from "./repository-tabs.js";
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
  filesHover as handleRuntimeFilesHover,
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
import { saveSessionPreferences } from "./session-preferences.js";
import { changedDiffRowsInRange } from "./diff-lines.js";
import {
  PANE_TOP,
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
  type RuntimeDataContext,
} from "./runtime-data.js";
import { cancelAvatarWork, terminalGraphicsSupported } from "./avatars.js";
import {
  historyStartForCommit,
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
  cancelSidebarScroll as cancelRuntimeSidebarScroll,
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
  runFileAction as runRuntimeFileAction,
  type RuntimeCommandsContext,
} from "./runtime-commands.js";
import { selectPatchLines } from "../git/hunks.js";

export async function runTuig(
  repositories: GitRepository[],
  activeRepository?: string,
  submodules: Record<string, { root: string; path: string }> = {},
): Promise<void> {
  const repository =
    repositories.find((candidate) => candidate.root === activeRepository) ??
    repositories[0];
  if (!repository) throw new Error("Tuig requires at least one repository");
  const renderer = await createCliRenderer({
    useMouse: true,
    enableMouseMovement: true,
    exitOnCtrlC: false,
    backgroundColor: oneDarkTheme.bg,
  });
  renderer.setTerminalTitle(`tuig · ${repository.root}`);
  const app = new Runtime(renderer, repositories, repository.root, submodules);
  await app.start();
}

const DEFAULT_REMOTE_FETCH_INTERVAL_MINUTES = 1;
const REFRESH_INTERVAL_MS = 10_000;

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
  private snapshotSignature?: string;
  private historyLimit = HISTORY_PAGE;
  private loadingMoreCommits = false;
  private historyPageFailures = 0;
  private commitIndex = 0;
  private historySelection: "working" | "commit" = "working";
  private fileIndex = 0;
  private mode: ChangeSection = "unstaged";
  private view: "history" | "commit" | "working" = "history";
  private commitFiles: ChangedFile[] = [];
  /** Older endpoint retained while the user browses for a comparison target. */
  private comparisonStartSha?: string;
  /** Older endpoint for the comparison surface currently open. */
  private comparisonBaseSha?: string;
  private graphIndex: GraphIndex = emptyGraphIndex();
  private historyFilter?: {
    path: string;
    file: ChangedFile;
    commits: RepositorySnapshot["commits"];
    index: number;
    line?: number;
  };
  private get historyFilterActive() {
    return this.historyFilter !== undefined;
  }
  private get selectedCommitSha() {
    return this.historyFilter?.commits[this.historyFilter.index]?.sha;
  }

  // Horizontal graph offset, in lanes, used once the graph is wider than the
  // share of the history pane it is allowed to take.
  private graphScroll = 0;
  private graphVisibleColumns = 1;
  private branchHints = new Map<string, string>();
  private branchHintIndex = emptyBranchHintIndex();
  private historyStart = 0;
  private historyViewportDetached = false;
  private historyContentWidth = 1;
  private historyColumns: HistoryColumns = {
    showCommitter: true,
    showSha: true,
  };
  private historyColumnDrag?: {
    key: "branchWidth" | "graphWidth" | "messageWidth";
    x: number;
    width: number;
  };
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
  private diffAbort?: AbortController;
  private diffTooLarge = false;
  private commitFilesRequest = 0;
  private historyFilterRequest = 0;
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
  private seenFileDirectories = new Set<string>();
  private hoveredFileRow?: { section: ChangeSection; row: number };
  private focus: "history" | "changes" = "history";
  private syncedAt?: number;
  private messageTimer?: ReturnType<typeof setTimeout>;
  private busySpinnerText = "";
  private readonly busySpinner = createBrailleSpinner((frame) =>
    this.renderBusyNotification(frame),
  );
  // Reading `content` back off a renderable returns a StyledText, so the
  // message text is tracked here for width and layout maths.
  private messageText = "";
  private busy = false;
  private disposed = false;
  private refreshPending = false;
  private pendingRefreshMessage?: string;
  private readonly header: TextRenderable;
  private readonly tabBar: TextRenderable;
  private readonly avatarToggle: TextRenderable;
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
  private readonly commitDiff: DiffView;
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
  private readonly ensureGraphAvatarSlots: (count: number) => void;
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
  private readonly repositoryPathInput: InputRenderable;
  private readonly repositoryPickerBox: BoxRenderable;
  private readonly repositoryPickerText: TextRenderable;
  private readonly commandPaletteBox: BoxRenderable;
  private readonly commandPaletteInput: InputRenderable;
  private readonly commandPaletteText: TextRenderable;
  private repository: GitRepository;
  private tabs: Array<{
    id: string;
    repository: GitRepository;
    submoduleOf?: { root: string; path: string };
    history?: {
      start: number;
      commitIndex: number;
      selectedSha?: string;
      selection: "working" | "commit";
      viewportDetached: boolean;
      limit: number;
    };
  }>;
  private activeTabId: string;
  private nextTabId = 1;
  private tabLayout: RepositoryTabsLayout = layoutRepositoryTabs(
    [],
    undefined,
    0,
  );
  private draggedTabId?: string;
  private lastSubmoduleClick?: { path: string; at: number };
  private repositorySuggestions: DirectorySuggestion[] = [];
  private repositorySuggestionIndex = 0;
  private repositorySuggestionRows = 5;
  private repositoryPickerRequest = 0;
  private commandPaletteOpen = false;
  private commandPaletteMatches: PaletteMatch[] = [];
  private commandPaletteIndex = 0;
  private commandPaletteStart = 0;
  private commandPaletteRows = 10;
  private palettePreviousEditor?: InputRenderable | TextareaRenderable;
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
  private sidebarPendingScroll: Record<SidebarSection, number> = {
    local: 0,
    remote: 0,
    submodules: 0,
    stashes: 0,
    worktrees: 0,
  };
  private sidebarScrollTimers: Record<
    SidebarSection,
    ReturnType<typeof setTimeout> | undefined
  > = {
    local: undefined,
    remote: undefined,
    submodules: undefined,
    stashes: undefined,
    worktrees: undefined,
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
  private selectedDiffRows = new Set<number>();
  private selectedDiffSnapshot = "";
  private diffDragAnchor?: number;
  private diffDragSelecting = true;
  private suppressEnterUntil = 0;
  private commitFilesTop = 19;
  // Widths read back off renderables can lag by a frame, so panes keep the
  // numeric widths from the latest layout pass for width-dependent painting.
  private sidebarPaneWidth = 28;
  private detailsPaneWidth = 44;
  private toolbarHits: ToolbarHit[] = [];
  private toolbarHovered?: ToolbarAction;
  private toolbarPressed?: ToolbarAction;
  private busyFrame = "";
  private commitHeaderValue = "";
  private commitBodyValue = "";
  private commitInfoValue = "";
  private commitCoAuthorsValue = "";
  private commitCoAuthorsProviderVisible = false;
  private avatarRequest = 0;
  private avatarsEnabled = true;
  private avatarAbort?: AbortController;
  private graphAvatarKeys: Array<string | undefined> = [];
  private graphAvatarTokens: number[] = [];
  private graphAvatarAborts: Array<AbortController | undefined> = [];
  private preferredUnstagedHeight?: number;
  private preferredComposerHeight?: number;
  private preferencesTimer?: ReturnType<typeof setTimeout>;
  private sessionPreferencesTimer?: ReturnType<typeof setTimeout>;
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
    repositories: GitRepository[],
    activeRepository: string,
    submodules: Record<string, { root: string; path: string }> = {},
  ) {
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
    const widgets = createRuntimeWidgets(renderer, {
      tabMouseDown: (x, button) => this.handleTabMouseDown(x, button),
      toggleAvatars: () => this.toggleAvatars(),
      tabDrag: (x) => this.handleTabDrag(x),
      tabDragEnd: () => {
        this.draggedTabId = undefined;
      },
      sidebarClick: (x, y, button) =>
        this.sidebarClick(x, y - PANE_TOP, button),
      sidebarToggle: (section) => this.toggleSidebarSection(section),
      sidebarScroll: (y, delta) => this.sidebarScroll(y - PANE_TOP, delta),
      sidebarResize: (section, y) => this.resizeSidebar(section, y),
      historyScroll: (delta, axis) => {
        if (axis === "horizontal") {
          this.scrollGraphColumns(delta);
          return;
        }
        this.queueHistoryScroll(delta);
      },
      historyClick: (x, y, button) =>
        this.historyClick(x, y - PANE_TOP, button),
      historyDrag: (x) => {
        const drag = this.historyColumnDrag;
        if (!drag) return;
        this.historyColumns[drag.key] = Math.max(4, drag.width + x - drag.x);
        const layout = historyColumnLayout(
          this.historyContentWidth,
          this.graphIndex.columns,
          this.historyColumns,
        );
        this.historyColumns[drag.key] = layout[drag.key];
        this.paintHistory();
      },
      historyDragEnd: () => {
        this.historyColumnDrag = undefined;
      },
      filesScroll: (section, delta) => this.filesScroll(section, delta),
      filesClick: (section, y, button, x) =>
        this.filesClick(section, y, button, x),
      filesHover: (section, y) =>
        handleRuntimeFilesHover(this.filesContext(), section, y),
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
      toolbarHover: (x) => {
        const hovered =
          x === undefined ? undefined : toolbarHit(this.toolbarHits, x);
        if (hovered === this.toolbarHovered) return;
        this.toolbarHovered = hovered;
        this.toolbarPressed = undefined;
        this.paintToolbar();
      },
      toolbarDown: (x) => {
        this.toolbarPressed = toolbarHit(this.toolbarHits, x);
        this.paintToolbar();
      },
      commit: () => void this.commit(),
      toggleAmend: () => this.toggleAmend(),
      viewWorkingChanges: () => this.closeDiff(),
      editMessage: () => this.editMessage(),
      copyCommitSha: () => this.copyCommitSha(),
      diffClick: (x, y, button, ctrl, alt) =>
        this.diffClick(x, y, button, ctrl, alt),
      diffDrag: (y) => this.diffDrag(y),
      diffDragEnd: () => this.diffDragEnd(),
      overlayDismiss: () => this.dismissOverlay(),
      menuHover: (x, y) => this.popupController.hover(x, y, false),
      menuClick: (x, y) => this.popupController.click(x, y, false),
      submenuHover: (x, y) => this.popupController.hover(x, y, true),
      submenuClick: (x, y) => this.popupController.click(x, y, true),
    });
    this.sidebar = widgets.sidebar;
    this.tabBar = widgets.tabBar;
    this.avatarToggle = widgets.avatarToggle;
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
    this.repositoryPickerBox = new BoxRenderable(renderer, {
      position: "absolute",
      id: "repository-picker",
      left: 2,
      top: 2,
      width: 60,
      height: 10,
      zIndex: 90,
      visible: false,
      border: true,
      borderColor: oneDarkTheme.border,
      backgroundColor: oneDarkTheme.panelRaised,
      shouldFill: true,
      title: " Open repository ",
      titleAlignment: "left",
    });
    this.repositoryPathInput = new InputRenderable(renderer, {
      position: "absolute",
      id: "repository-path",
      left: 1,
      top: 1,
      width: 56,
      visible: true,
      zIndex: 92,
      placeholder: "Path from current directory",
      backgroundColor: oneDarkTheme.selected,
      focusedBackgroundColor: oneDarkTheme.selected,
      textColor: oneDarkTheme.text,
    });
    this.repositoryPickerText = new TextRenderable(renderer, {
      position: "absolute",
      id: "repository-suggestions",
      left: 1,
      top: 3,
      width: 56,
      height: 5,
      visible: true,
      zIndex: 92,
      fg: oneDarkTheme.text,
      wrapMode: "none",
      content: "",
      onMouseDown: (event) =>
        this.chooseRepositorySuggestion(
          event.y - Number(this.repositoryPickerBox.top) - 3,
        ),
    });
    this.repositoryPickerBox.add(this.repositoryPathInput);
    this.repositoryPickerBox.add(this.repositoryPickerText);
    this.commandPaletteBox = new BoxRenderable(renderer, {
      position: "absolute",
      id: "command-palette",
      left: 2,
      top: 2,
      width: 70,
      height: 14,
      zIndex: 100,
      visible: false,
      border: true,
      borderColor: oneDarkTheme.border,
      backgroundColor: oneDarkTheme.panelRaised,
      shouldFill: true,
      title: " Command palette ",
      titleAlignment: "left",
    });
    this.commandPaletteInput = new InputRenderable(renderer, {
      position: "absolute",
      id: "command-palette-search",
      left: 1,
      top: 1,
      width: 66,
      zIndex: 102,
      placeholder: "Search commands",
      backgroundColor: oneDarkTheme.selected,
      focusedBackgroundColor: oneDarkTheme.selected,
      textColor: oneDarkTheme.text,
    });
    this.commandPaletteText = new TextRenderable(renderer, {
      position: "absolute",
      id: "command-palette-results",
      left: 1,
      top: 3,
      width: 66,
      height: 10,
      zIndex: 102,
      wrapMode: "none",
      selectable: false,
      content: "",
      onMouseMove: (event) => this.hoverPaletteRow(event.y),
      onMouseDown: (event) => this.activatePaletteRow(event.y, event.button),
      onMouseScroll: (event) =>
        this.movePaletteSelection(event.scroll?.direction === "up" ? -3 : 3),
    });
    this.commandPaletteBox.add(this.commandPaletteInput);
    this.commandPaletteBox.add(this.commandPaletteText);
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
      cancelRuntimeSidebarScroll(this.sidebarContext());
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
    this.repositoryPathInput.on(InputRenderableEvents.INPUT, () => {
      this.repositorySuggestionIndex = 0;
      void this.updateRepositorySuggestions();
    });
    this.commandPaletteInput.on(InputRenderableEvents.INPUT, () => {
      this.commandPaletteIndex = 0;
      this.commandPaletteStart = 0;
      this.paintCommandPalette();
    });
    this.commandPaletteInput.on(InputRenderableEvents.ENTER, () =>
      this.activatePaletteCommand(),
    );
    this.repositoryPathInput.on(
      InputRenderableEvents.ENTER,
      () => void this.openRepositoryPath(),
    );
    this.renderer.root.add(this.branchFilterInput);
    this.renderer.root.add(this.promptInput);
    this.renderer.root.add(this.repositoryPickerBox);
    this.renderer.root.add(this.commandPaletteBox);
    this.renderer.on(CliRenderEvents.SELECTION, this.copyCompletedSelection);
    this.renderer.once(CliRenderEvents.DESTROY, this.dispose);
  }

  async start() {
    const preferences = await loadLayoutPreferences();
    this.avatarsEnabled = preferences.avatarsEnabled ?? true;
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
    await this.flushSessionPreferences();
    // OpenTUI starts demand-driven. start() would render at 30 FPS even when
    // nothing changes; widget invalidations and spinner ticks request frames.
    this.renderer.requestRender();
    // Terminal dimensions are reliable only after the renderer has started.
    await Bun.sleep(0);
    this.layout();
    await this.refresh();
    await this.focusCheckedOutCommit();
    // Refresh creates width-dependent history content; recompute once with
    // the live snapshot so startup follows the same path as a manual resize.
    this.layout();
    this.refreshTimer = setInterval(() => {
      if (!this.composing) void this.refresh("Auto-refreshing…", true);
    }, REFRESH_INTERVAL_MS);
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
      avatarsEnabled: this.avatarsEnabled,
      remoteFetchIntervalMinutes: this.remoteFetchIntervalMinutes,
      leftWidth: this.leftWidth,
      detailsWidth: this.detailsWidth,
      unstagedHeight: this.preferredUnstagedHeight,
      composerHeight: this.preferredComposerHeight,
      sidebarHeights: this.sidebarPreferred,
      sidebarCollapsed: this.sidebarCollapsed,
    });
  }
  private persistSessionPreferences() {
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
  private get composing(): boolean {
    const focused = this.renderer.currentFocusedEditor;
    return (
      focused === this.composerSummary ||
      focused === this.composerBody ||
      focused === this.branchFilterInput ||
      focused === this.promptInput ||
      focused === this.repositoryPathInput
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
   * Show busy progress in the toolbar and transient messages at bottom right.
   *
   * Messages expire so the keybinding hints on the left, which they never
   * overwrite, remain the resting state of the row.
   */
  private notify(text: string, tone: "info" | "error" | "busy" = "info") {
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
    cancelRuntimeDiff(this.dataContext());
    this.removeSelectionListener();
    this.stopBusySpinner();
    if (this.messageTimer) clearTimeout(this.messageTimer);
    this.messageTimer = undefined;
  };
  private async shutdown() {
    this.avatarAbort?.abort();
    cancelRuntimeGraphAvatars(this.dataContext());
    cancelAvatarWork();
    this.mutationAbort?.abort();
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.remoteFetchTimer) clearInterval(this.remoteFetchTimer);
    if (this.scrollTimer) clearTimeout(this.scrollTimer);
    cancelRuntimeSidebarScroll(this.sidebarContext());
    if (this.messageTimer) clearTimeout(this.messageTimer);
    await this.flushSessionPreferences().catch(() => undefined);
    for (const tab of this.tabs) tab.repository.dispose?.();
    this.dispose();
    await this.flushLayoutPreferences().catch(() => undefined);
    return this.renderer.destroy();
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
      lineSelection: this.selectedDiffRows.size
        ? {
            count: this.selectedDiffRows.size,
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
  private paintHeader() {
    // The repository summary shares the toolbar's label row and stops before
    // its first action. The toolbar's second row remains available for glyphs.
    const firstAction =
      this.toolbarHits[0]?.start ?? this.renderer.terminalWidth;
    const width = Math.max(1, firstAction - 1);
    this.header.width = width;
    this.header.content = renderHeader({
      snapshot: this.snapshot,
      repositoryRoot: this.repository.root,
      width,
    });
  }
  private paintTabs() {
    const width = Math.max(1, this.renderer.terminalWidth);
    this.tabLayout = layoutRepositoryTabs(
      this.tabs.map((tab) => ({
        id: tab.id,
        path: tab.repository.root,
        label: tab.submoduleOf
          ? submoduleTabLabel(tab.repository.root, tab.submoduleOf.root)
          : undefined,
      })),
      this.activeTabId,
      width,
    );
    const cells = [];
    for (const [index, tab] of this.tabLayout.tabs.entries()) {
      const previous = this.tabLayout.tabs[index - 1];
      if (previous) {
        cells.push(
          bg(oneDarkTheme.panelRaised)(
            " ".repeat(Math.max(0, tab.start - previous.end)),
          ),
        );
      }
      const background = tab.active
        ? oneDarkTheme.selected
        : oneDarkTheme.panel;
      const label = repositoryTabText(tab);
      cells.push(
        bg(background)(
          fg(tab.active ? oneDarkTheme.accent : oneDarkTheme.muted)(label),
        ),
      );
    }
    const used = this.tabLayout.tabs.at(-1)?.end ?? 0;
    const gap = Math.max(0, this.tabLayout.open.start - used);
    cells.push(bg(oneDarkTheme.panelRaised)(" ".repeat(gap)));
    const openLabel = " + ".slice(
      0,
      this.tabLayout.open.end - this.tabLayout.open.start,
    );
    cells.push(
      bg(oneDarkTheme.panelRaised)(fg(oneDarkTheme.accent)(openLabel)),
    );
    cells.push(
      bg(oneDarkTheme.panelRaised)(
        " ".repeat(Math.max(0, width - this.tabLayout.open.end)),
      ),
    );
    this.avatarToggle.content = `${this.avatarsEnabled ? "■" : "□"} Avatars`;
    this.tabBar.width = width;
    this.tabBar.content = new StyledText(cells);
  }

  private handleTabMouseDown(x: number, button: number) {
    const hit = repositoryTabHit(this.tabLayout, x);
    if (!hit) return;
    if (button === MouseButton.MIDDLE) {
      if (hit.action === "select" || hit.action === "close")
        void this.closeRepositoryTab(hit.tabId);
      return;
    }
    if (button !== MouseButton.LEFT) return;
    if (hit.action === "open") return this.showRepositoryPicker();
    if (hit.action === "close") return void this.closeRepositoryTab(hit.tabId);
    this.draggedTabId = hit.tabId;
    void this.activateRepositoryTab(hit.tabId);
  }

  private toggleAvatars() {
    this.avatarsEnabled = !this.avatarsEnabled;
    this.avatarAbort?.abort();
    cancelRuntimeGraphAvatars(this.dataContext());
    const commit = this.snapshot?.commits[this.commitIndex];
    if (commit && this.view === "commit")
      showRuntimeCommitMeta(this.dataContext(), commit);
    this.persistLayoutPreferences();
    this.paintTabs();
    this.paint();
  }

  private handleTabDrag(x: number) {
    const movedId = this.draggedTabId;
    if (!movedId) return;
    const hit = repositoryTabHit(this.tabLayout, x);
    if (!hit || hit.action === "open" || hit.tabId === movedId) return;
    this.tabs = reorderRepositoryTabs(this.tabs, movedId, hit.tabId);
    this.paintTabs();
    this.persistSessionPreferences();
  }

  private dismissOverlay() {
    if (this.commandPaletteOpen) return this.closeCommandPalette();
    this.popupController.close();
  }

  private paletteCommands(): PaletteCommand[] {
    const snapshot = this.snapshot;
    const selected = this.selectedFile();
    const busyReason = this.mutationBusy
      ? `${this.mutationBusy} is still running`
      : undefined;
    const repositoryAvailability = (enabled: boolean, reason: string) => ({
      enabled: enabled && !busyReason,
      disabledReason: busyReason ?? (enabled ? undefined : reason),
    });
    const toolbar = (action: ToolbarAction) => () =>
      void runRuntimeToolbarAction(this.commandsContext(), action);
    return [
      {
        id: "repository.refresh",
        title: "Refresh repository",
        category: "Repository",
        keywords: ["reload", "status"],
        shortcut: "r",
        ...repositoryAvailability(Boolean(snapshot), "Repository is loading"),
        run: toolbar("refresh"),
      },
      {
        id: "repository.fetch",
        title: "Fetch remotes",
        category: "Repository",
        shortcut: "f",
        ...repositoryAvailability(Boolean(snapshot), "Repository is loading"),
        run: toolbar("fetch"),
      },
      {
        id: "repository.pull",
        title: "Pull current branch",
        category: "Repository",
        shortcut: "l",
        ...repositoryAvailability(
          Boolean(snapshot?.upstream),
          "No upstream branch",
        ),
        run: toolbar("pull"),
      },
      {
        id: "repository.push",
        title: "Push current branch",
        category: "Repository",
        shortcut: "p",
        ...repositoryAvailability(
          Boolean(snapshot?.upstream),
          "No upstream branch",
        ),
        run: toolbar("push"),
      },
      {
        id: "repository.stash",
        title: "Stash working changes",
        category: "Repository",
        ...repositoryAvailability(
          (snapshot?.files.length ?? 0) > 0,
          "No changes to stash",
        ),
        run: toolbar("stash"),
      },
      {
        id: "repository.pop-stash",
        title: "Pop latest stash",
        category: "Repository",
        ...repositoryAvailability(
          (snapshot?.stashes.length ?? 0) > 0,
          "No stash to pop",
        ),
        run: toolbar("pop"),
      },
      {
        id: "repository.open",
        title: "Open new repository tab",
        category: "Repository",
        keywords: ["add tab", "open repository"],
        shortcut: "Ctrl+T",
        run: () => this.showRepositoryPicker(),
      },
      {
        id: "repository.close",
        title: "Close current repository tab",
        category: "Repository",
        shortcut: "Ctrl+W",
        enabled: this.tabs.length > 1 && !busyReason,
        disabledReason: busyReason ?? "Cannot close the only repository tab",
        run: () => void this.closeRepositoryTab(this.activeTabId),
      },
      {
        id: "changes.commit",
        title: "Compose commit",
        category: "Changes",
        shortcut: "c",
        enabled: !this.composing,
        disabledReason: "Commit composer is already active",
        run: () => {
          setTimeout(() => this.composerSummary.focus(), 0);
        },
      },
      {
        id: "changes.stage-selected",
        title: "Stage selected file",
        category: "Changes",
        shortcut: "s",
        ...repositoryAvailability(
          Boolean(selected?.unstaged),
          "No unstaged file selected",
        ),
        run: () =>
          selected &&
          void this.perform(
            `Staging ${selected.path}…`,
            () => this.repository.stage([selected.path]),
            false,
            "working",
          ),
      },
      {
        id: "changes.unstage-selected",
        title: "Unstage selected file",
        category: "Changes",
        shortcut: "u",
        ...repositoryAvailability(
          Boolean(selected?.staged),
          "No staged file selected",
        ),
        run: () =>
          selected &&
          void this.perform(
            `Unstaging ${selected.path}…`,
            () => this.repository.unstage([selected.path]),
            false,
            "working",
          ),
      },
      {
        id: "changes.stage-all",
        title: "Stage all changes",
        category: "Changes",
        shortcut: "a",
        ...repositoryAvailability(
          this.files("unstaged").length > 0,
          "No unstaged changes",
        ),
        run: () => void this.stageAll(),
      },
      {
        id: "changes.unstage-all",
        title: "Unstage all changes",
        category: "Changes",
        ...repositoryAvailability(
          this.files("staged").length > 0,
          "No staged changes",
        ),
        run: () => void this.unstageAll(),
      },
      {
        id: "changes.discard-all",
        title: "Discard all unstaged changes",
        category: "Changes",
        ...repositoryAvailability(
          this.files("unstaged").length > 0,
          "No unstaged changes",
        ),
        run: () => void this.discardAll(),
      },
      {
        id: "navigation.filter-branches",
        title: "Filter and checkout branches",
        category: "Navigation",
        keywords: ["switch", "find branch"],
        shortcut: "/",
        enabled: Boolean(snapshot),
        disabledReason: "Repository is loading",
        run: () => this.startBranchFilter(),
      },
      {
        id: "navigation.history",
        title: "Focus commit history",
        category: "Navigation",
        run: () => this.setFocus("history"),
      },
      {
        id: "navigation.changes",
        title: "Focus changed files",
        category: "Navigation",
        run: () => this.setFocus("changes"),
      },
      {
        id: "navigation.next-tab",
        title: "Next repository tab",
        category: "Navigation",
        shortcut: "Ctrl+Tab",
        enabled: this.tabs.length > 1 && !busyReason,
        disabledReason: busyReason ?? "Only one repository tab is open",
        run: () => void this.activateRelativeRepositoryTab(1),
      },
      {
        id: "navigation.previous-tab",
        title: "Previous repository tab",
        category: "Navigation",
        shortcut: "Ctrl+Shift+Tab",
        enabled: this.tabs.length > 1 && !busyReason,
        disabledReason: busyReason ?? "Only one repository tab is open",
        run: () => void this.activateRelativeRepositoryTab(-1),
      },
      {
        id: "view.sidebar",
        title: `${this.leftCollapsed ? "Expand" : "Collapse"} left panel`,
        category: "View",
        shortcut: "[",
        keywords: ["lhs", "sidebar", "branches", "show", "hide"],
        run: () => {
          this.leftCollapsed = !this.leftCollapsed;
          this.layout();
        },
      },
      {
        id: "view.details",
        title: `${this.detailsCollapsed ? "Expand" : "Collapse"} right panel`,
        category: "View",
        shortcut: "]",
        keywords: ["rhs", "details", "show", "hide"],
        run: () => {
          this.detailsCollapsed = !this.detailsCollapsed;
          this.layout();
        },
      },
      {
        id: "settings.avatars",
        title: `${this.avatarsEnabled ? "Disable" : "Enable"} author avatars`,
        category: "Settings",
        keywords: ["images", "privacy", "remote"],
        run: () => this.toggleAvatars(),
      },
    ];
  }

  private activateRelativeRepositoryTab(delta: number) {
    const index = this.tabs.findIndex((tab) => tab.id === this.activeTabId);
    const next = (index + delta + this.tabs.length) % this.tabs.length;
    return this.activateRepositoryTab(this.tabs[next]!.id);
  }

  private showCommandPalette() {
    if (this.commandPaletteOpen) return this.closeCommandPalette();
    this.popupController.close();
    this.palettePreviousEditor = this.renderer.currentFocusedEditor as
      | InputRenderable
      | TextareaRenderable
      | undefined;
    this.commandPaletteOpen = true;
    this.commandPaletteInput.value = "";
    this.commandPaletteIndex = 0;
    this.commandPaletteStart = 0;
    this.overlayCatcher.visible = true;
    this.commandPaletteBox.visible = true;
    this.paintCommandPalette();
    setTimeout(() => this.commandPaletteInput.focus(), 0);
  }

  private closeCommandPalette(restoreFocus = true) {
    if (!this.commandPaletteOpen) return;
    this.commandPaletteOpen = false;
    this.commandPaletteInput.blur();
    this.commandPaletteBox.visible = false;
    this.overlayCatcher.visible = this.popupController.isOpen;
    const previous = this.palettePreviousEditor;
    this.palettePreviousEditor = undefined;
    if (restoreFocus && previous) setTimeout(() => previous.focus(), 0);
    this.renderer.requestRender();
  }

  private paintCommandPalette() {
    if (!this.commandPaletteOpen) return;
    const terminalWidth = Math.max(1, this.renderer.terminalWidth);
    const terminalHeight = Math.max(1, this.renderer.terminalHeight);
    const width = Math.max(1, Math.min(76, terminalWidth - 2));
    // Keep one blank row below the results. OpenTUI text can occupy its full
    // declared height, so the spare row prevents the final result touching or
    // painting over the bottom border.
    this.commandPaletteRows = Math.max(1, Math.min(14, terminalHeight - 5));
    this.commandPaletteBox.left = Math.max(
      0,
      Math.floor((terminalWidth - width) / 2),
    );
    this.commandPaletteBox.top = Math.max(
      0,
      Math.floor((terminalHeight - this.commandPaletteRows - 5) / 2),
    );
    this.commandPaletteBox.width = width;
    this.commandPaletteBox.height = this.commandPaletteRows + 5;
    this.commandPaletteInput.width = Math.max(1, width - 4);
    this.commandPaletteText.width = Math.max(1, width - 2);
    this.commandPaletteText.height = this.commandPaletteRows;
    this.commandPaletteMatches = commandMatches(
      this.paletteCommands(),
      this.commandPaletteInput.value,
    );
    if (this.commandPaletteMatches.length === 0) this.commandPaletteIndex = -1;
    else if (
      this.commandPaletteIndex < 0 ||
      this.commandPaletteIndex >= this.commandPaletteMatches.length ||
      this.commandPaletteMatches[this.commandPaletteIndex]?.command.enabled ===
        false
    )
      this.commandPaletteIndex = nextEnabledCommand(
        this.commandPaletteMatches,
        -1,
        1,
      );
    this.commandPaletteStart = clampPaletteViewport(
      this.commandPaletteIndex,
      this.commandPaletteStart,
      this.commandPaletteRows,
      this.commandPaletteMatches.length,
    );
    const visible = this.commandPaletteMatches.slice(
      this.commandPaletteStart,
      this.commandPaletteStart + this.commandPaletteRows,
    );
    if (visible.length === 0) {
      this.commandPaletteText.content = new StyledText([
        fg(oneDarkTheme.muted)(" No matching commands"),
      ]);
      return;
    }
    const content = visible.map((match, row) => {
      const index = this.commandPaletteStart + row;
      const command = match.command;
      const selected = index === this.commandPaletteIndex;
      const rawSuffix =
        command.enabled === false
          ? (command.disabledReason ?? "Unavailable")
          : (command.shortcut ?? "");
      const innerWidth = Math.max(1, width - 2);
      const contentWidth = Math.max(1, innerWidth - 2);
      const categoryWidth = Math.min(13, Math.max(0, contentWidth - 1));
      const detailWidth = Math.min(
        24,
        Math.max(0, contentWidth - categoryWidth - 8),
      );
      const titleWidth = Math.max(
        1,
        contentWidth - categoryWidth - detailWidth,
      );
      const category = clipColumns(
        `${command.category} ·`,
        categoryWidth,
      ).padEnd(categoryWidth);
      const title = clipColumns(command.title, titleWidth).padEnd(titleWidth);
      const suffix = clipColumns(rawSuffix, detailWidth).padStart(detailWidth);
      const line = clipColumns(` ${category}${title}${suffix} `, innerWidth);
      const background = selected
        ? oneDarkTheme.selected
        : oneDarkTheme.panelRaised;
      const color =
        command.enabled === false ? oneDarkTheme.muted : oneDarkTheme.text;
      return bg(background)(
        fg(color)(`${line}${row === visible.length - 1 ? "" : "\n"}`),
      );
    });
    this.commandPaletteText.content = new StyledText(content);
  }

  private movePaletteSelection(delta: number) {
    if (!this.commandPaletteOpen) return;
    const direction = delta < 0 ? -1 : 1;
    for (let count = 0; count < Math.abs(delta); count += 1)
      this.commandPaletteIndex = nextEnabledCommand(
        this.commandPaletteMatches,
        this.commandPaletteIndex,
        direction,
      );
    this.paintCommandPalette();
  }

  private hoverPaletteRow(y: number) {
    const index =
      this.commandPaletteStart + y - Number(this.commandPaletteBox.top) - 3;
    const command = this.commandPaletteMatches[index]?.command;
    if (
      !command ||
      command.enabled === false ||
      index === this.commandPaletteIndex
    )
      return;
    this.commandPaletteIndex = index;
    this.paintCommandPalette();
  }

  private activatePaletteRow(y: number, button: number) {
    if (button !== MouseButton.LEFT) return;
    const index =
      this.commandPaletteStart + y - Number(this.commandPaletteBox.top) - 3;
    const command = this.commandPaletteMatches[index]?.command;
    if (!command || command.enabled === false) return;
    this.commandPaletteIndex = index;
    this.activatePaletteCommand();
  }

  private activatePaletteCommand() {
    const selected =
      this.commandPaletteMatches[this.commandPaletteIndex]?.command;
    if (!selected || selected.enabled === false) return;
    const current = this.paletteCommands().find(
      (command) => command.id === selected.id,
    );
    if (!current || current.enabled === false) {
      this.paintCommandPalette();
      return;
    }
    this.closeCommandPalette();
    void current.run();
  }

  private showRepositoryPicker() {
    this.popupController.close();
    const width = Math.max(30, Math.min(70, this.renderer.terminalWidth - 4));
    this.repositoryPickerBox.width = width;
    this.repositoryPickerBox.left = Math.max(
      0,
      Math.floor((this.renderer.terminalWidth - width) / 2),
    );
    this.repositoryPickerBox.top = Math.max(
      1,
      Math.min(4, this.renderer.terminalHeight - 10),
    );
    const pickerHeight = Math.max(
      6,
      Math.min(
        12,
        this.renderer.terminalHeight - Number(this.repositoryPickerBox.top) - 1,
      ),
    );
    this.repositoryPickerBox.height = pickerHeight;
    this.repositoryPathInput.width = Math.max(8, width - 4);
    this.repositoryPickerText.width = Math.max(8, width - 4);
    this.repositorySuggestionRows = Math.max(1, pickerHeight - 5);
    this.repositoryPickerText.height = this.repositorySuggestionRows;
    this.repositoryPathInput.value = "";
    this.repositorySuggestionIndex = 0;
    this.repositoryPickerBox.visible = true;
    void this.updateRepositorySuggestions();
    setTimeout(() => this.repositoryPathInput.focus(), 0);
  }

  private closeRepositoryPicker() {
    this.repositoryPickerRequest++;
    this.repositoryPathInput.blur();
    this.repositoryPickerBox.visible = false;
  }

  private async updateRepositorySuggestions() {
    const request = ++this.repositoryPickerRequest;
    const suggestions = await suggestDirectories(
      this.repositoryPathInput.value,
    );
    if (
      request !== this.repositoryPickerRequest ||
      !this.repositoryPickerBox.visible
    )
      return;
    this.repositorySuggestions = suggestions;
    this.repositorySuggestionIndex = Math.min(
      this.repositorySuggestionIndex,
      Math.max(0, suggestions.length - 1),
    );
    this.paintRepositorySuggestions();
  }

  private paintRepositorySuggestions() {
    const count = this.repositorySuggestionRows;
    const start = Math.max(
      0,
      Math.min(
        this.repositorySuggestionIndex - count + 1,
        this.repositorySuggestions.length - count,
      ),
    );
    const visible = this.repositorySuggestions.slice(start, start + count);
    this.repositoryPickerText.content = visible.length
      ? visible
          .map(
            (entry, index) =>
              `${start + index === this.repositorySuggestionIndex ? ">" : " "} ${entry.name}/`,
          )
          .join("\n")
      : "  No matching folders";
  }

  private chooseRepositorySuggestion(row: number) {
    if (row < 0) return;
    const count = this.repositorySuggestionRows;
    const start = Math.max(
      0,
      Math.min(
        this.repositorySuggestionIndex - count + 1,
        this.repositorySuggestions.length - count,
      ),
    );
    const suggestion = this.repositorySuggestions[start + row];
    if (!suggestion) return;
    this.repositoryPathInput.value = `${suggestion.path}/`;
    this.repositorySuggestionIndex = 0;
    void this.updateRepositorySuggestions();
    this.repositoryPathInput.focus();
  }

  private completeRepositorySuggestion() {
    const suggestion =
      this.repositorySuggestions[this.repositorySuggestionIndex];
    if (!suggestion) return;
    this.repositoryPathInput.value = `${suggestion.path}/`;
    this.repositorySuggestionIndex = 0;
    void this.updateRepositorySuggestions();
  }

  private async openRepositoryPath() {
    const typedPath = this.repositoryPathInput.value.trim();
    const path = resolveRepositoryPath(typedPath || process.cwd());
    try {
      const repository = await createGitRepository(path);
      const existing = this.tabs.find(
        (tab) => tab.repository.root === repository.root,
      );
      if (existing) {
        repository.dispose?.();
        this.closeRepositoryPicker();
        return this.activateRepositoryTab(existing.id, true);
      }
      const id = `repository-${this.nextTabId++}`;
      this.tabs.push({ id, repository });
      this.persistSessionPreferences();
      this.closeRepositoryPicker();
      await this.activateRepositoryTab(id, true);
    } catch (error) {
      this.notify(
        error instanceof NotGitRepositoryError
          ? `Not a Git repository: ${path}`
          : error instanceof Error
            ? error.message
            : String(error),
        "error",
      );
    }
  }

  private async openSubmodule(submodule: Submodule) {
    const parentRoot = this.repository.root;
    const path = resolve(parentRoot, submodule.path);
    try {
      const repository = await createGitRepository(path);
      const existing = this.tabs.find(
        (tab) => tab.repository.root === repository.root,
      );
      if (existing) {
        repository.dispose?.();
        if (!existing.submoduleOf)
          existing.submoduleOf = { root: parentRoot, path: submodule.path };
        this.paintTabs();
        return this.activateRepositoryTab(existing.id, true);
      }
      const id = `repository-${this.nextTabId++}`;
      this.tabs.push({
        id,
        repository,
        submoduleOf: { root: parentRoot, path: submodule.path },
      });
      this.persistSessionPreferences();
      await this.activateRepositoryTab(id, true);
    } catch (error) {
      this.notify(
        submodule.state === "uninitialized"
          ? `Initialize ${submodule.path} before opening it`
          : error instanceof Error
            ? error.message
            : String(error),
        "error",
      );
    }
  }

  private async activateRepositoryTab(id: string, focusCheckedOut = false) {
    const tab = this.tabs.find((candidate) => candidate.id === id);
    if (!tab) return;
    if (id === this.activeTabId)
      return focusCheckedOut ? this.focusCheckedOutCommit() : undefined;
    if (this.mutationBusy)
      return this.notify("Wait for the current Git operation to finish");
    this.saveActiveTabHistory();
    this.closePopup();
    this.closeRepositoryPicker();
    this.branchFilterInput.blur();
    this.composerSummary.blur();
    this.composerBody.blur();
    this.namePrompt = undefined;
    this.branchFilterActive = false;
    this.branchFilter = "";
    this.composerSummary.value = "";
    this.composerBody.setText("");
    this.amend = false;
    this.amendDraft = undefined;
    this.editingCommitSha = undefined;
    this.editReturnState = undefined;
    cancelRuntimeDiff(this.dataContext());
    cancelRuntimeGraphAvatars(this.dataContext());
    this.avatarAbort?.abort();
    this.snapshotRequest++;
    this.commitFilesRequest++;
    this.repository = tab.repository;
    this.activeTabId = id;
    this.persistSessionPreferences();
    this.snapshot = undefined;
    this.snapshotSignature = undefined;
    this.historyLimit = tab.history?.limit ?? HISTORY_PAGE;
    this.commitIndex = 0;
    this.historySelection = "working";
    this.fileIndex = 0;
    this.fileStart = 0;
    this.historyStart = 0;
    this.view = "history";
    this.commitFiles = [];
    this.commitDiff.visible = false;
    this.commitDiffEmpty.visible = false;
    this.commitInfoBox.visible = false;
    this.commitBodyBox.visible = false;
    this.renderer.setTerminalTitle(`tuig · ${this.repository.root}`);
    this.paintTabs();
    this.paint();
    await this.refresh();
    if (focusCheckedOut) await this.focusCheckedOutCommit();
    else this.restoreTabHistory(tab);
    this.layout();
  }

  private saveActiveTabHistory() {
    const tab = this.tabs.find(
      (candidate) => candidate.id === this.activeTabId,
    );
    if (!tab) return;
    tab.history = {
      start: this.historyStart,
      commitIndex: this.commitIndex,
      selectedSha: this.snapshot?.commits[this.commitIndex]?.sha,
      selection: this.historySelection,
      viewportDetached: this.historyViewportDetached,
      limit: this.historyLimit,
    };
  }

  private restoreTabHistory(tab: (typeof this.tabs)[number]) {
    const saved = tab.history;
    const snapshot = this.snapshot;
    if (!saved || !snapshot) return;
    const selectedIndex = saved.selectedSha
      ? snapshot.commits.findIndex((commit) => commit.sha === saved.selectedSha)
      : -1;
    this.commitIndex =
      selectedIndex >= 0
        ? selectedIndex
        : Math.min(saved.commitIndex, Math.max(0, snapshot.commits.length - 1));
    this.historySelection = saved.selection;
    this.historyViewportDetached = saved.viewportDetached;
    const totalRows =
      snapshot.commits.length + (snapshot.files.length > 0 ? 1 : 0);
    this.historyStart = Math.max(
      0,
      Math.min(saved.start, Math.max(0, totalRows - 1)),
    );
    this.paintHistory();
  }

  /**
   * A newly opened repository starts at its checked-out commit. History is
   * paged until that commit is found, but ordinary tab switches do not call
   * this method and therefore do not snap the reader back to HEAD.
   */
  private async focusCheckedOutCommit() {
    let snapshot = this.snapshot;
    if (!snapshot) return;
    const headSha =
      snapshot.headSha ?? resolveHeadSha(snapshot.branches, snapshot.commits);
    if (!headSha) return;
    let index = snapshot.commits.findIndex((commit) => commit.sha === headSha);
    while (index < 0 && !snapshot.commitsComplete) {
      const count = snapshot.commits.length;
      await loadMoreRuntimeCommits(this.dataContext());
      snapshot = this.snapshot ?? snapshot;
      if (snapshot.commits.length === count) break;
      index = snapshot.commits.findIndex((commit) => commit.sha === headSha);
    }
    if (index < 0) return;
    this.commitIndex = index;
    this.historySelection = "commit";
    this.historyViewportDetached = false;
    this.historyStart = historyStartForCommit(
      index,
      snapshot.files.length > 0,
      this.contentHeight,
      snapshot.commits.length,
    );
    this.paintHistory();
  }

  private async closeRepositoryTab(id: string) {
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    if (id === this.activeTabId && this.mutationBusy)
      return this.notify("Wait for the current Git operation to finish");
    if (this.tabs.length === 1) return this.shutdown();
    const wasActive = id === this.activeTabId;
    const [removed] = this.tabs.splice(index, 1);
    removed?.repository.dispose?.();
    if (wasActive) {
      const next = this.tabs[Math.min(index, this.tabs.length - 1)]!;
      await this.activateRepositoryTab(next.id);
    } else {
      this.paintTabs();
      this.persistSessionPreferences();
    }
  }
  private paintToolbar() {
    const width = Math.max(1, this.renderer.terminalWidth);
    const toolbar = renderToolbar(toolbarButtons(this.snapshot), width, {
      hovered: this.toolbarHovered,
      pressed: this.toolbarPressed,
      busy: this.busySpinnerText
        ? `${this.busyFrame} ${this.busySpinnerText}`
        : undefined,
    });
    this.toolbar.width = width;
    this.toolbar.content = toolbar.content;
    this.toolbarHits = toolbar.hits;
    this.paintHeader();
  }
  private async toolbarPress(x: number) {
    const action = toolbarHit(this.toolbarHits, x);
    const pressed = this.toolbarPressed;
    this.toolbarPressed = undefined;
    this.paintToolbar();
    if (!action || action !== pressed) return;
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
    this.paintTabs();
    layoutRuntime(this.layoutContext());
    this.paintCommandPalette();
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
      get hoveredFileRow() {
        return runtime.hoveredFileRow;
      },
      set hoveredFileRow(value) {
        runtime.hoveredFileRow = value;
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
      get selectedCommitSha() {
        return runtime.snapshot?.commits[runtime.commitIndex]?.sha;
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
      openFileMenu: (x, y, target) => this.openGraphMenu(x, y, target),
      runFileAction: (action, files, directory) =>
        void runRuntimeFileAction(
          this.commandsContext(),
          action,
          files,
          directory,
        ),
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
    scrollRuntimeFiles(this.filesContext(), section, delta);
  }
  private filesClick(
    section: ChangeSection,
    y: number,
    button?: number,
    x?: number,
  ) {
    if (this.selectedDiffRows.size) this.clearLineSelection(false);
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
    handleRuntimeFilesClick(this.filesContext(), section, y, button, x);
  }
  private selectedFile() {
    return selectedRuntimeFile(this.filesContext());
  }

  private refresh(message?: string, automatic = false) {
    if (this.historyFilter) {
      if (automatic) return Promise.resolve();
      this.clearHistoryFilter();
    }
    return refreshRuntimeData(this.dataContext(), message, automatic);
  }

  /** Refresh after a change that cannot have touched history. */
  private refreshWorkingStatus(message?: string) {
    return refreshRuntimeWorkingStatus(this.dataContext(), message);
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
        ensureGraphAvatarSlots: this.ensureGraphAvatarSlots,
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
      get historyLimit() {
        return runtime.historyLimit;
      },
      set historyLimit(value) {
        runtime.historyLimit = value;
      },
      get loadingMoreCommits() {
        return runtime.loadingMoreCommits;
      },
      set loadingMoreCommits(value) {
        runtime.loadingMoreCommits = value;
      },
      get historyPageFailures() {
        return runtime.historyPageFailures;
      },
      set historyPageFailures(value) {
        runtime.historyPageFailures = value;
      },
      get snapshotSignature() {
        return runtime.snapshotSignature;
      },
      set snapshotSignature(value) {
        runtime.snapshotSignature = value;
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
      get diffAbort() {
        return runtime.diffAbort;
      },
      set diffAbort(value) {
        runtime.diffAbort = value;
      },
      get diffTooLarge() {
        return runtime.diffTooLarge;
      },
      set diffTooLarge(value) {
        runtime.diffTooLarge = value ?? false;
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
      get selectedCommitSha() {
        return runtime.historyFilter?.commits[runtime.historyFilter.index]?.sha;
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
      get comparisonBaseSha() {
        return runtime.comparisonBaseSha;
      },
      set comparisonBaseSha(value) {
        runtime.comparisonBaseSha = value;
      },
      get comparisonStartSha() {
        return runtime.comparisonStartSha;
      },
      get graphIndex() {
        return runtime.graphIndex;
      },
      set graphIndex(value) {
        runtime.graphIndex = value;
      },
      get branchHints() {
        return runtime.branchHints;
      },
      set branchHints(value) {
        runtime.branchHints = value;
      },
      get branchHintIndex() {
        return runtime.branchHintIndex;
      },
      set branchHintIndex(value) {
        runtime.branchHintIndex = value;
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
      graphAvatarAborts: runtime.graphAvatarAborts,
      // OpenTUI falls back to colored character blocks when Kitty and Sixel
      // graphics are unavailable. Those approximations are too coarse for
      // these small avatars, so use the text fallbacks instead.
      get avatarSupported() {
        return (
          runtime.avatarsEnabled &&
          terminalGraphicsSupported(runtime.authorPhoto.effectiveProtocol)
        );
      },
      files: () => this.files(),
      selectedFile: () => this.selectedFile(),
      ensureFileVisible: () => this.ensureFileVisible(),
      layout: () => this.layout(),
      paint: () => this.paint(),
      paintFiles: () => this.paintFiles(),
      paintHistory: () => this.paintHistory(),
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
      seenFileDirectories: this.seenFileDirectories,
      hoveredFileRow: this.hoveredFileRow,
      detailsPaneWidth: this.detailsPaneWidth,
      graphRowCount: this.graphIndex.length,
      graphRowsAt: (from, count) => this.graphRowsAt(from, count),
      graphColumns: this.graphIndex.columns,
      graphScroll: this.graphScroll,
      setGraphScroll: (value) => {
        this.graphScroll = value;
      },
      setGraphVisibleColumns: (value) => {
        this.graphVisibleColumns = value;
      },
      branchHints: this.branchHints,
      historySelection: this.historySelection,
      commitIndex: this.commitIndex,
      comparisonStartSha: this.comparisonStartSha,
      comparisonBaseSha: this.comparisonBaseSha,
      historyStart: this.historyStart,
      setHistoryStart: (value) => {
        this.historyStart = value;
      },
      historyViewportDetached: this.historyViewportDetached,
      historyContentWidth: this.historyContentWidth,
      historyColumns: this.historyColumns,
      historyShaHits: this.historyShaHits,
      historyLabelHits: this.historyLabelHits,
      historyText: this.historyText,
      commitDiffVisible: this.commitDiff.visible,
      requestMoreCommits: () => {
        void loadMoreRuntimeCommits(this.dataContext());
      },
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
    // The shared painter renders the ordinary commit-file picker. File-history
    // mode reuses that surface, so it must be the final writer on every full
    // paint rather than only on scroll events.
    if (this.historyFilter) {
      layoutChanges(this.layoutContext(), this.contentHeight);
      this.paintHistoryFilter();
    }
  }
  private sidebarPaintContext(): RuntimeSidebarPaintContext {
    return {
      snapshot: this.snapshot,
      contentHeight: this.contentHeight,
      sidebarPreferred: this.sidebarPreferred,
      sidebarCollapsed: this.sidebarCollapsed,
      sidebarStart: this.sidebarStart,
      sidebarSections: this.sidebarSections,
      sidebarPaneWidth: this.sidebarPaneWidth,
      branchFilter: this.branchFilter,
    };
  }
  private paintSidebar() {
    paintRuntimeSidebar(this.sidebarPaintContext());
  }
  private paintHistory() {
    paintRuntimeHistory(this.paintContext());
  }
  private paintFiles() {
    if (this.historyFilter) {
      layoutChanges(this.layoutContext(), this.contentHeight);
      this.paintHistoryFilter();
      return;
    }
    paintRuntimeFiles(this.paintContext());
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
    if (commit) showRuntimeCommitMeta(this.dataContext(), commit);
  }
  private paintComposer() {
    paintRuntimeComposer(this.paintContext());
  }

  private ensureFileVisible() {
    ensureRuntimeFileVisible(this.filesContext());
  }

  private loadDiff(allowLarge = false) {
    return loadRuntimeDiff(this.dataContext(), allowLarge);
  }

  private historyContext(): RuntimeHistoryContext {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const runtime = this;
    return {
      get snapshot() {
        return runtime.snapshot;
      },
      get graphRowCount() {
        // A getter, not a snapshot: a page can land while a queued scroll
        // still holds this context, and it would clamp against a stale count.
        return runtime.graphIndex.length;
      },
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
  /**
   * Rows for a visible range, replayed from the nearest lane checkpoint.
   *
   * Held rows cost about 750 bytes a commit, so the graph is stored as lane
   * state every few hundred rows and the window is rebuilt when it is painted.
   */
  private graphRowsAt(from: number, count: number): readonly GraphRow[] {
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
  private queueHistoryScroll(delta: number) {
    queueRuntimeHistoryScroll(this.historyContext(), delta);
  }
  /** Pan the graph sideways; returns false when nothing is hidden. */
  private scrollGraphColumns(delta: number): boolean {
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
  private historyClick(x: number, y: number, button: number) {
    this.historyColumnDrag = undefined;
    if (y === 1 && !this.commitDiff.visible) {
      if (button === MouseButton.RIGHT) {
        const committer = {
          label: `${this.historyColumns.showCommitter ? "[x]" : "[ ]"} Committer`,
        };
        const sha = {
          label: `${this.historyColumns.showSha ? "[x]" : "[ ]"} SHA`,
        };
        this.openPopup(
          "History columns",
          [committer, sha],
          x,
          y + PANE_TOP,
          (item) => {
            if (item === committer)
              this.historyColumns.showCommitter =
                !this.historyColumns.showCommitter;
            if (item === sha)
              this.historyColumns.showSha = !this.historyColumns.showSha;
            this.paintHistory();
          },
        );
      } else if (button === MouseButton.LEFT) {
        const layout = historyColumnLayout(
          this.historyContentWidth,
          this.graphIndex.columns,
          this.historyColumns,
        );
        const key = historyDividerAt(x - this.historyContentLeft, layout);
        if (key)
          this.historyColumnDrag = {
            key,
            x,
            width: layout[key],
          };
      }
      return;
    }
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
      sidebarPendingScroll: this.sidebarPendingScroll,
      sidebarScrollTimers: this.sidebarScrollTimers,
      branchSelection: this.branchSelection,
      get lastSubmoduleClick() {
        return runtime.lastSubmoduleClick;
      },
      set lastSubmoduleClick(value) {
        runtime.lastSubmoduleClick = value;
      },
      doubleClickMs: DOUBLE_CLICK_MS,
      branchFilterInput: this.branchFilterInput,
      layout: () => this.layout(),
      paint: () => this.paint(),
      paintSidebar: () => this.paintSidebar(),
      paintHints: () => this.paintHints(),
      persistLayoutPreferences: () => this.persistLayoutPreferences(),
      notify: (text) => this.notify(text),
      checkoutBranch: (branch) => this.checkoutBranch(branch),
      openSubmodule: (submodule) => this.openSubmodule(submodule),
      openGraphMenu: (x, y, target) => this.openGraphMenu(x, y, target),
    };
  }

  /** Open the graph context menu at a terminal position. */
  private openGraphMenu(x: number, y: number, target: GraphMenuTarget) {
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
      return openRuntimeComparison(this.dataContext(), base);
    }
    return runRuntimeMenuAction(this.commandsContext(), action, target);
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

  private clearHistoryFilter() {
    this.historyFilterRequest++;
    const saved = this.historyFilter;
    if (!saved) return false;
    this.historyFilter = undefined;
    this.history.title = undefined;
    this.closeDiff();
    return true;
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
    if (focusedEditor === this.commandPaletteInput) {
      if (key.ctrl && key.name === "p") return this.closeCommandPalette();
      if (key.name === "escape") return this.closeCommandPalette();
      if (key.name === "up" || (key.ctrl && key.name === "k"))
        return this.movePaletteSelection(-1);
      if (key.name === "down" || (key.ctrl && key.name === "n"))
        return this.movePaletteSelection(1);
      if (key.name === "pageup")
        return this.movePaletteSelection(-this.commandPaletteRows);
      if (key.name === "pagedown")
        return this.movePaletteSelection(this.commandPaletteRows);
      return;
    }
    if (focusedEditor === this.repositoryPathInput) {
      if (key.name === "escape") return this.closeRepositoryPicker();
      if (key.name === "up" || key.name === "down") {
        const delta = key.name === "up" ? -1 : 1;
        this.repositorySuggestionIndex = Math.max(
          0,
          Math.min(
            this.repositorySuggestions.length - 1,
            this.repositorySuggestionIndex + delta,
          ),
        );
        return this.paintRepositorySuggestions();
      }
      if (key.name === "tab") return this.completeRepositorySuggestion();
      return;
    }
    // Confirmation and naming popups own the keyboard until resolved. Opening
    // another modal here would silently discard their pending action or input.
    if (key.ctrl && key.name === "p" && this.popupController.isOpen) return;
    if (key.ctrl && key.name === "p") return this.showCommandPalette();
    if (key.ctrl && key.name === "t") return this.showRepositoryPicker();
    if (key.ctrl && key.name === "w")
      return void this.closeRepositoryTab(this.activeTabId);
    if (key.ctrl && key.name === "tab") {
      const index = this.tabs.findIndex((tab) => tab.id === this.activeTabId);
      const delta = key.shift ? -1 : 1;
      const next = (index + delta + this.tabs.length) % this.tabs.length;
      return void this.activateRepositoryTab(this.tabs[next]!.id);
    }
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
      if (this.historyFilter && this.clearHistoryFilter()) return;
      if (this.selectedDiffRows.size) {
        this.clearLineSelection();
        return;
      }
      if (this.composing) {
        this.composerSummary.blur();
        this.composerBody.blur();
        this.paintHints();
      } else if (this.view !== "history") this.closeDiff();
      return;
    }
    if (
      this.popupController.isOpen &&
      (key.name === "enter" || key.name === "return")
    )
      return this.popupController.activate();
    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      return this.shutdown();
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
      if (this.selectedDiffRows.size) return void this.applySelectedLines();
      if (this.focus === "changes") return void this.openSelectedFile();
      if (this.view === "history") return void this.openCommit();
      return;
    }
    if (key.name === "t") {
      if (this.selectedDiffRows.size) this.clearLineSelection(false);
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
    if (key.name === "left" || key.name === "right") {
      const delta = key.name === "left" ? -1 : 1;
      // In the history pane the arrows pan a graph that is too wide to fit;
      // with nothing hidden they keep their file-navigation meaning.
      if (this.focus === "history" && this.scrollGraphColumns(delta)) return;
      return this.moveFile(delta);
    }
    if (
      key.shift &&
      key.name.toLowerCase() === "l" &&
      this.diffTooLarge &&
      this.commitDiff.visible
    )
      return void this.loadDiff(true).catch((error) => this.fail(error));
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
      return void this.perform(
        "Staging…",
        () => this.repository.stage([this.selectedFile()!.path]),
        false,
        "working",
      );
    if (key.name === "u" && this.selectedFile())
      return void this.perform(
        "Unstaging…",
        () => this.repository.unstage([this.selectedFile()!.path]),
        false,
        "working",
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
    if (this.selectedDiffRows.size) this.clearLineSelection(false);
    if (this.historyFilter) return this.filesScroll("unstaged", delta);
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
  private diffClick(
    x: number,
    y: number,
    button: number,
    ctrl: boolean,
    alt: boolean,
  ) {
    if (!this.commitDiff.visible) return;
    const hit = this.commitDiff.lineTargetAt(y);
    const file = this.selectedFile();
    if (!file) return;
    if (
      button === MouseButton.LEFT &&
      this.diffOrigin === "working" &&
      hit &&
      hit.kind !== "context"
    ) {
      if (this.selectedDiffSnapshot !== this.commitDiff.diff) {
        this.selectedDiffRows.clear();
        this.selectedDiffSnapshot = this.commitDiff.diff;
      }
      if (!ctrl && !alt) {
        this.selectedDiffRows.clear();
        this.selectedDiffRows.add(hit.rawRow);
      } else if (this.selectedDiffRows.has(hit.rawRow)) {
        this.selectedDiffRows.delete(hit.rawRow);
      } else this.selectedDiffRows.add(hit.rawRow);
      if (alt) {
        this.diffDragAnchor = hit.rawRow;
        this.diffDragSelecting = this.selectedDiffRows.has(hit.rawRow);
      }
      this.commitDiff.setSelectedRows(this.selectedDiffRows);
      this.paintHints();
      const count = this.selectedDiffRows.size;
      this.notify(
        count
          ? `${count} line${count === 1 ? "" : "s"} selected · Enter to ${this.mode === "staged" ? "unstage" : "stage"}`
          : "Line selection cleared",
      );
      return;
    }
    if (button !== MouseButton.RIGHT) return;
    if (
      this.diffOrigin === "working" &&
      hit &&
      hit.kind !== "context" &&
      (!this.selectedDiffRows.size || !this.selectedDiffRows.has(hit.rawRow))
    ) {
      this.selectedDiffRows.clear();
      this.selectedDiffRows.add(hit.rawRow);
      this.selectedDiffSnapshot = this.commitDiff.diff;
      this.commitDiff.setSelectedRows(this.selectedDiffRows);
      this.paintHints();
    }
    if (
      this.diffOrigin === "working" &&
      this.selectedDiffRows.size &&
      this.selectedDiffSnapshot === this.commitDiff.diff
    ) {
      const action =
        this.mode === "staged" ? "Unstage selected" : "Stage selected";
      const items = [
        { label: action },
        ...(this.mode === "unstaged"
          ? [{ label: "Discard selected", destructive: true }]
          : []),
        { label: "Clear selection" },
      ];
      this.openPopup("Selected lines", items, x, y, (item) => {
        if (item.label === "Clear selection") this.clearLineSelection();
        else if (item.label === "Discard selected")
          void this.applySelectedLines(true);
        else void this.applySelectedLines();
      });
      return;
    }
    if (!hit) return;
    const selected =
      this.historyFilter?.commits[this.historyFilter.index] ??
      this.snapshot?.commits[this.commitIndex];
    let sha: string;
    let path = file.path;
    if (this.diffOrigin === "commit" && selected) {
      sha =
        hit.side === "old"
          ? (this.comparisonBaseSha ?? selected.parents[0] ?? "")
          : selected.sha;
      if (hit.side === "old") path = file.originalPath ?? file.path;
    } else if (hit.kind !== "added") {
      sha = this.snapshot?.headSha ?? "";
      path = file.originalPath ?? file.path;
    } else {
      this.notify("Uncommitted added lines cannot be blamed");
      return;
    }
    this.openGraphMenu(x, y, {
      sha,
      file: { ...file, path },
      fileStaged: this.mode === "staged",
      line:
        this.diffOrigin !== "commit" && hit.kind === "context"
          ? (hit.oldLine ?? hit.line)
          : hit.line,
    });
  }
  private diffDrag(y: number) {
    if (
      this.diffDragAnchor === undefined ||
      this.selectedDiffSnapshot !== this.commitDiff.diff
    )
      return false;
    const hit = this.commitDiff.lineTargetAt(y);
    if (!hit) return true;
    for (const row of changedDiffRowsInRange(
      this.commitDiff.diff,
      this.diffDragAnchor,
      hit.rawRow,
    )) {
      if (this.diffDragSelecting) this.selectedDiffRows.add(row);
      else this.selectedDiffRows.delete(row);
    }
    this.commitDiff.setSelectedRows(this.selectedDiffRows);
    this.paintHints();
    return true;
  }
  private diffDragEnd() {
    const active = this.diffDragAnchor !== undefined;
    this.diffDragAnchor = undefined;
    return active;
  }
  private clearLineSelection(notify = true) {
    this.diffDragEnd();
    this.selectedDiffRows.clear();
    this.selectedDiffSnapshot = "";
    this.commitDiff.setSelectedRows(this.selectedDiffRows);
    this.paintHints();
    if (notify) this.notify("Line selection cleared");
  }
  private applySelectedLines(discard = false) {
    if (
      this.diffOrigin !== "working" ||
      !this.selectedDiffRows.size ||
      this.selectedDiffSnapshot !== this.commitDiff.diff
    ) {
      this.clearLineSelection();
      return;
    }
    const patch = selectPatchLines(
      this.selectedDiffSnapshot,
      this.selectedDiffRows,
      discard || this.mode === "staged" ? "new" : "old",
    );
    if (!patch) return this.notify("No changed lines selected", "error");
    const staged = this.mode === "staged";
    const label = discard
      ? "Discarding selected lines…"
      : `${staged ? "Unstaging" : "Staging"} selected lines…`;
    this.selectedDiffRows.clear();
    this.selectedDiffSnapshot = "";
    return this.perform(
      label,
      () =>
        discard
          ? this.repository.discardPatch(patch)
          : this.repository.applyPatch(patch, staged),
      false,
      "working",
    );
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
      refreshWorkingStatus: (message) => this.refreshWorkingStatus(message),
      paintComposer: () => this.paintComposer(),
      notify: (text, tone) => this.notify(text, tone),
      fail: (error) => this.fail(error),
      openSubmodule: (submodule) => this.openSubmodule(submodule),
    };
  }
  private perform(
    label: string,
    action: (signal?: AbortSignal) => Promise<void>,
    remote = false,
    scope: "history" | "working" = "history",
  ) {
    return performRuntime(this.commandsContext(), label, action, remote, scope);
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
