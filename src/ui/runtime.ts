import {
  BoxRenderable,
  TextareaRenderable,
  ScrollBoxRenderable,
  DiffRenderable,
  InputRenderable,
  MouseButton,
  StyledText,
  TextRenderable,
  bg,
  createCliRenderer,
  fg,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core";
import type {
  BranchRef,
  ChangedFile,
  Commit,
  GitRepository,
  RepositorySnapshot,
  ResetMode,
} from "../git/types.js";
import { splitPatchHunks } from "../git/hunks.js";
import {
  buildFileTree,
  fitTreeLabel,
  flattenVisible,
  toggleExpansion,
} from "./file-tree.js";
import { layoutGraph, type GraphRow } from "./graph.js";
import { resolveMaterialIcon } from "./icon-theme.js";
import {
  buildCommitBranchHints,
  displayBranchName,
  primaryDecorationRef,
  resolveHeadSha,
  shortSha,
  summariseDecorations,
} from "./history.js";
import {
  buildGraphMenu,
  menuRowAt,
  menuWidth,
  placeMenu,
  renderMenuLine,
  type ConfirmRequest,
  type GraphMenuAction,
  type GraphMenuItem,
} from "./graph-menu.js";
import { oneDarkTheme } from "./theme.js";
import {
  layoutChangeSections,
  fileColor,
  fileViewportSize,
  fileIcon,
  clipColumns,
  fitColumns,
  formatHints,
  presentCommitMeta,
  workingChangesBannerLines,
  workingChangesBannerRows,
  renderToolbar,
  toolbarButtons,
  toolbarHit,
  type ToolbarAction,
  type ToolbarHit,
  renderHeader,
  SIDEBAR_SECTIONS,
  layoutSidebarSections,
  sidebarHeader,
  sidebarRows,
  renderSidebarViewport,
  renderSubmoduleSidebarViewport,
  resizeSidebarBoundary,
  type SidebarSection,
  wrappedLineCount,
} from "./runtime-presentation.js";
import { loadLayoutPreferences, saveLayoutPreferences } from "./preferences.js";
import {
  COMMIT_DIFF_TOP,
  PANE_TOP,
  createRuntimeWidgets,
  type ChangeSection,
} from "./runtime-widgets.js";

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

/** Window in which a second click on the same graph row counts as a double. */
const DOUBLE_CLICK_MS = 400;

interface PopupPane {
  items: GraphMenuItem[];
  left: number;
  top: number;
  width: number;
  hover?: number;
}

interface Popup extends PopupPane {
  title: string;
  submenu?: PopupPane & { parent: number };
  select(item: GraphMenuItem): void;
}

class Runtime {
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
  private diffRequest = 0;
  private commitFilesRequest = 0;
  private snapshotRequest = 0;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private scrollTimer?: ReturnType<typeof setTimeout>;
  private pendingScroll = 0;
  private historyShaHits = new Map<number, { start: number; end: number }>();
  private historyLabelHits = new Map<
    number,
    { start: number; end: number; ref?: BranchRef }
  >();
  private popup?: Popup;
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
  private readonly commitBodyBox: ScrollBoxRenderable;
  private readonly commitInfo: TextRenderable;
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
  private commitFilesTop = 19;
  // Widths read back off renderables can lag by a frame, so panes keep the
  // numeric widths from the latest layout pass for width-dependent painting.
  private sidebarPaneWidth = 28;
  private detailsPaneWidth = 44;
  private toolbarHits: ToolbarHit[] = [];
  private commitHeaderValue = "";
  private commitBodyValue = "";
  private commitInfoValue = "";
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
      sidebarClick: (y, button) => this.sidebarClick(y - PANE_TOP, button),
      sidebarToggle: (section) => this.toggleSidebarSection(section),
      sidebarScroll: (y, delta) => this.sidebarScroll(y - PANE_TOP, delta),
      sidebarResize: (section, y) => this.resizeSidebar(section, y),
      historyScroll: (delta) => this.queueHistoryScroll(delta),
      historyClick: (x, y, button) =>
        this.historyClick(x, y - PANE_TOP, button),
      filesScroll: (section, delta) => this.filesScroll(section, delta),
      filesClick: (section, y) => this.filesClick(section, y - PANE_TOP),
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
      overlayDismiss: () => this.closePopup(),
      menuHover: (x, y) => this.hoverPopup(x, y, false),
      menuClick: (x, y) => this.clickPopup(x, y, false),
      submenuHover: (x, y) => this.hoverPopup(x, y, true),
      submenuClick: (x, y) => this.clickPopup(x, y, true),
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
    this.commitBodyBox = widgets.commitBodyBox;
    this.commitInfo = widgets.commitInfo;
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
    return focused === this.composerSummary || focused === this.composerBody;
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
  private filesViewport(): number {
    return Math.max(1, this.sectionViewport(this.mode));
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
  private async runToolbarAction(action: ToolbarAction) {
    if (action === "refresh") return void this.refresh();
    if (action === "fetch")
      return void this.perform(
        "Fetching…",
        () => this.repository.fetch(),
        true,
      );
    if (action === "pull")
      return void this.perform("Pulling…", () => this.repository.pull(), true);
    if (action === "push")
      return void this.perform("Pushing…", () => this.repository.push(), true);
    if (action === "stash")
      return void this.perform("Stashing…", () =>
        this.repository.stash(undefined, true),
      );
    const stash = this.snapshot?.stashes[0];
    if (!stash) return this.notify("No stash to pop", "error");
    await this.perform(`Popping ${stash.ref}…`, () =>
      this.repository.applyStash(stash.ref, true),
    );
  }
  private setFocus(focus: "history" | "changes") {
    if (this.focus === focus) return;
    this.focus = focus;
    this.paintHints();
    this.paint();
  }
  private layout() {
    const total = Math.max(1, this.renderer.terminalWidth);
    // The header and toolbar own the top rows, so the panes start below them.
    const height = this.contentHeight;
    const available = Math.max(3, total - 2);
    const leftMin = this.leftCollapsed ? 1 : Math.min(12, available);
    const rightMin = this.detailsCollapsed ? 1 : Math.min(20, available);
    const centerMin = Math.max(1, Math.min(18, available - leftMin - rightMin));
    const left = this.leftCollapsed
      ? 1
      : Math.min(
          this.leftWidth,
          Math.max(leftMin, available - rightMin - centerMin),
        );
    const right = this.detailsCollapsed
      ? 1
      : Math.min(this.detailsWidth, Math.max(1, available - left - centerMin));
    const center = Math.max(1, available - left - right);
    this.sidebarPaneWidth = Math.min(left, total);
    this.sidebar.width = this.sidebarPaneWidth;
    this.sidebar.height = height;
    this.history.height = height;
    this.details.height = height;
    // Dividers stop above the bottom row so they cannot draw over the hints.
    const dividerHeight = Math.max(1, height - 1);
    this.leftDivider.height = dividerHeight;
    this.rightDivider.height = dividerHeight;
    this.leftDividerBar.height = dividerHeight;
    this.rightDividerBar.height = dividerHeight;
    this.sidebar.visible = !this.leftCollapsed && total > 1;
    // A collapsed pane keeps only its divider column, so the graph starts
    // immediately beside whichever divider is showing.
    const leftBoundary = this.leftCollapsed ? 0 : left;
    const rightBoundary = this.detailsCollapsed
      ? Math.max(leftBoundary + 2, total - 1)
      : left + center + 1;
    this.leftDivider.left = Math.max(0, Math.min(total - 1, leftBoundary - 1));
    this.leftDividerBar.left = Math.max(0, Math.min(total - 1, leftBoundary));
    // Positions and sizes are computed as plain numbers, because reading them
    // back off a renderable returns the previous frame's value.
    const historyLeft = Math.min(total - 1, leftBoundary + 1);
    const historyWidth = Math.max(
      1,
      Math.min(rightBoundary - historyLeft, total - historyLeft),
    );
    this.history.left = historyLeft;
    this.history.width = historyWidth;
    this.historyContentLeft = historyLeft + 1;
    this.historyContentWidth = Math.max(1, historyWidth - 2);
    this.historyText.width = this.historyContentWidth;
    this.historyText.height = Math.max(1, height - 2);
    this.rightDivider.left = Math.max(
      0,
      Math.min(total - 1, rightBoundary - 1),
    );
    this.rightDividerBar.left = Math.max(0, Math.min(total - 1, rightBoundary));
    const detailsLeft = Math.min(total, rightBoundary + 1);
    this.details.left = detailsLeft;
    this.detailsPaneWidth = Math.max(
      1,
      Math.min(right, Math.max(1, total - detailsLeft)),
    );
    this.details.width = this.detailsPaneWidth;
    this.details.visible = !this.detailsCollapsed && detailsLeft < total - 1;
    // Leave room for the box borders, text inset, scrollbar, and percentage
    // width rounding used by OpenTUI's nested renderables.
    const textWidth = Math.max(10, this.detailsPaneWidth - 8);
    const headerLines = wrappedLineCount(this.commitHeaderValue, textWidth);
    const bodyLines = wrappedLineCount(this.commitBodyValue, textWidth);
    const messageHeight = headerLines + Math.min(15, bodyLines) + 3;
    this.commitHeader.height = headerLines;
    this.commitHeader.top = 1;
    this.commitBody.height = bodyLines;
    this.commitBody.top = headerLines + 2;
    const bannerRows =
      this.view === "commit" && !this.editingCommitSha
        ? workingChangesBannerRows(this.snapshot?.files.length ?? 0)
        : 0;
    // Inspection follows a predictable reading order: message first, metadata,
    // then files.  The cards' explicit rows keep narrow wrapping collision-free.
    this.commitBodyBox.top = bannerRows;
    this.commitBodyBox.height = messageHeight;
    this.editMessageButton.left = Math.max(1, this.detailsPaneWidth - 18);
    const infoHeight = Math.max(
      5,
      wrappedLineCount(this.commitInfoValue, textWidth) + 1,
    );
    this.commitInfoBox.top = bannerRows + messageHeight;
    this.commitInfoBox.height = infoHeight;
    this.commitFilesTop = Math.min(
      Math.max(1, height - 1),
      bannerRows + messageHeight + infoHeight,
    );
    this.layoutChanges(height);
    // The diff takes whatever height the commit metadata leaves, rather than a
    // fixed share of the terminal.
    this.commitDiff.height = Math.max(1, height - COMMIT_DIFF_TOP - 1);
    const verticalGripHeight = Math.max(
      3,
      Math.min(9, Math.floor(dividerHeight / 3)),
    );
    const verticalGripStart = Math.max(
      0,
      Math.floor((dividerHeight - verticalGripHeight) / 2),
    );
    const dividerContent = Array.from({ length: dividerHeight }, (_, row) =>
      row >= verticalGripStart && row < verticalGripStart + verticalGripHeight
        ? "║"
        : "│",
    ).join("\n");
    this.leftDividerBar.content = dividerContent;
    this.rightDividerBar.content = dividerContent;
    this.paintHeader();
    this.paintToolbar();
    this.paintHints();
    this.positionMessage();
    if (this.snapshot) {
      this.paint();
    }
  }
  /**
   * Place the changes pane: pane actions, the two file sections, and the
   * commit composer, or the commit-file list when a commit is open.
   */
  private layoutChanges(height: number) {
    const commitView = this.view === "commit";
    const editing = !!this.editingCommitSha;
    const width = Math.max(1, this.detailsPaneWidth);
    for (const widget of [
      this.discardButton,
      this.stageAllButton,
      this.unstageAllButton,
      this.composerBox,
      this.stagedLabel,
      this.stagedText,
    ])
      widget.visible = !commitView || (widget === this.composerBox && editing);
    this.amendButton.visible = !commitView;
    this.workingBanner.visible =
      commitView && !editing && (this.snapshot?.files.length ?? 0) > 0;
    this.workingBanner.height = workingChangesBannerRows(
      this.snapshot?.files.length ?? 0,
    );
    this.editMessageButton.visible = commitView && !editing;
    for (const widget of [
      this.unstagedDivider,
      this.composerDivider,
      this.unstagedDividerBar,
      this.composerDividerBar,
    ])
      widget.visible = !commitView && !editing;
    if (commitView && !editing) {
      this.unstagedLabel.top = this.commitFilesTop;
      this.unstagedText.top = this.commitFilesTop + 1;
      this.unstagedText.height = this.sectionViewport("unstaged");
      return;
    }
    if (editing) {
      this.composerBox.top = 1;
      const composerHeight = Math.max(0, height - 2);
      this.composerBox.height = composerHeight;
      this.composerBox.visible = composerHeight > 0 && width >= 2;
      const boxWidth = Math.max(1, width - 2);
      const fieldWidth = Math.max(1, boxWidth - 1);
      this.composerBox.width = boxWidth;
      this.composerSummary.width = fieldWidth;
      this.composerBody.width = fieldWidth;
      this.commitButton.width = fieldWidth;
      this.layoutComposerChildren(composerHeight, boxWidth);
      return;
    }
    this.discardButton.top = 0;
    this.discardButton.left = 1;
    this.stageAllButton.top = 0;
    this.stageAllButton.left = Math.max(
      Number(this.discardButton.width) + 2,
      width - Number(this.stageAllButton.width) - 2,
    );
    const layout = layoutChangeSections({
      // The bottom row belongs to the hints, so the pane stops one row short.
      available: Math.max(0, height - 1),
      unstagedRows: this.sectionRows("unstaged").length,
      stagedRows: this.sectionRows("staged").length,
      unstagedCollapsed: this.sectionCollapsed.unstaged,
      stagedCollapsed: this.sectionCollapsed.staged,
      preferredUnstagedHeight: this.preferredUnstagedHeight,
      preferredComposerHeight: this.preferredComposerHeight,
    });
    this.unstagedLabel.top = layout.unstagedTop;
    this.unstagedText.top = layout.unstagedTop + 1;
    this.unstagedText.height = Math.max(1, layout.unstagedHeight);
    this.unstagedText.visible = layout.unstagedHeight > 0;
    this.stagedLabel.top = layout.stagedTop;
    this.unstageAllButton.top = layout.stagedTop;
    this.unstageAllButton.left = Math.max(
      1,
      width - Number(this.unstageAllButton.width) - 2,
    );
    this.unstageAllButton.visible =
      !this.sectionCollapsed.staged && this.files("staged").length > 0;
    this.stagedText.top = layout.stagedTop + 1;
    this.stagedText.height = Math.max(1, layout.stagedHeight);
    this.stagedText.visible = layout.stagedHeight > 0;
    this.composerBox.top = layout.composerTop;
    this.composerBox.height = layout.composerHeight;
    this.composerBox.visible = layout.composerHeight > 0 && width >= 2;
    // Percentage widths round unpredictably inside nested renderables, so the
    // composer's children are sized from the pane width directly.
    const boxWidth = Math.max(1, width - 2);
    this.composerBox.width = boxWidth;
    const fieldWidth = Math.max(1, boxWidth - 1);
    this.composerSummary.width = fieldWidth;
    this.composerBody.width = fieldWidth;
    this.commitButton.width = fieldWidth;
    this.layoutComposerChildren(layout.composerHeight, boxWidth);
    const gripWidth = Math.max(3, Math.min(9, Math.floor(width / 3)));
    const gripStart = Math.max(0, Math.floor((width - gripWidth) / 2));
    const divider = `${"─".repeat(gripStart)}${"═".repeat(gripWidth)}${"─".repeat(Math.max(0, width - gripStart - gripWidth))}`;
    this.unstagedDivider.top = Math.max(0, layout.unstagedDividerTop - 1);
    this.unstagedDivider.left = Math.floor(width / 4);
    this.unstagedDivider.width = Math.min(
      width,
      Math.max(5, Math.floor(width / 2)),
    );
    this.unstagedDivider.visible = true;
    this.unstagedDividerBar.top = this.unstagedDivider.top;
    this.unstagedDividerBar.width = width;
    this.unstagedDividerBar.content = divider;
    this.unstagedDividerBar.visible = this.unstagedDivider.visible;
    this.composerDivider.top = Math.max(0, layout.composerDividerTop - 1);
    this.composerDivider.left = Math.floor(width / 4);
    this.composerDivider.width = Math.min(
      width,
      Math.max(5, Math.floor(width / 2)),
    );
    this.composerDivider.visible = true;
    this.composerDividerBar.top = this.composerDivider.top;
    this.composerDividerBar.width = width;
    this.composerDividerBar.content = divider;
    this.composerDividerBar.visible = true;
  }
  private layoutComposerChildren(height: number, width: number) {
    this.composerBody.top = 2;
    const hasFieldRoom = width >= 2;
    this.composerSummary.visible = hasFieldRoom && height >= 2;
    this.composerBody.visible = hasFieldRoom && height >= 3;
    this.composerBody.height = Math.max(1, height - 6);
    const showActions = hasFieldRoom && height >= 6;
    this.amendButton.visible = showActions && !this.editingCommitSha;
    this.commitButton.visible = showActions;
    this.amendButton.top = height - 3;
    this.commitButton.top = height - 2;
  }
  private files(section: ChangeSection = this.mode): ChangedFile[] {
    return this.view === "commit"
      ? this.commitFiles
      : (this.snapshot?.files ?? []).filter((f) =>
          section === "staged" ? f.staged : f.unstaged,
        );
  }
  private sectionRows(section: ChangeSection) {
    return flattenVisible(
      buildFileTree(this.files(section)),
      this.expandedFiles,
    );
  }
  private toggleSection(section: ChangeSection) {
    if (this.view === "commit") return;
    this.sectionCollapsed[section] = !this.sectionCollapsed[section];
    this.layout();
  }
  private resizeChangeSplit(y: number) {
    if (this.view !== "history") return;
    // Labels are positioned within the pane; the staged label starts after
    // the unstaged heading and list, so its row directly expresses the split.
    this.preferredUnstagedHeight = Math.max(0, y - 2);
    this.persistLayoutPreferences();
    this.layout();
  }
  private resizeComposer(y: number) {
    if (this.view !== "history") return;
    // y is pane-relative (the widget explicitly removes PANE_TOP).  Everything
    // below the divider belongs to the composer.
    this.preferredComposerHeight = Math.max(0, this.contentHeight - 2 - y);
    this.persistLayoutPreferences();
    this.layout();
  }
  private filesScroll(section: ChangeSection, delta: number) {
    this.setFocus("changes");
    const rows = this.sectionRows(section);
    this.sectionStart[section] = Math.max(
      0,
      Math.min(
        Math.max(0, rows.length - this.sectionViewport(section)),
        this.sectionStart[section] + delta,
      ),
    );
    if (section === this.mode) this.fileStart = this.sectionStart[section];
    this.paintFiles();
  }
  private filesClick(section: ChangeSection, y: number) {
    this.setFocus("changes");
    if (this.view !== "commit" && section !== this.mode) {
      this.mode = section;
      this.fileStart = this.sectionStart[section];
      this.fileIndex = 0;
    }
    const list = this.list(section);
    const row = y - Number(list.top) + this.sectionStart[section];
    const visible = this.sectionRows(section);
    const node = visible[row]?.node;
    if (!node) return;
    if (node.kind === "directory") {
      this.expandedFiles = toggleExpansion(this.expandedFiles, node.path);
      this.paintFiles();
      return;
    }
    this.fileIndex = Math.max(
      0,
      this.files().findIndex((file) => file.path === node.path),
    );
    this.ensureFileVisible();
    this.paintFiles();
    if (this.view === "history") void this.openWorkingDiff();
    else {
      this.historyText.visible = false;
      this.commitDiff.visible = true;
      this.commitDiffEmpty.visible = false;
      void this.loadDiff().catch((error) => this.fail(error));
    }
  }
  private selectedFile() {
    return this.files()[this.fileIndex];
  }

  private async refresh(message?: string) {
    if (this.busy) {
      this.refreshPending = true;
      this.pendingRefreshMessage = message ?? this.pendingRefreshMessage;
      return;
    }
    this.busy = true;
    const request = ++this.snapshotRequest;
    // Nothing started against the old snapshot may paint over this refresh.
    ++this.diffRequest;
    ++this.commitFilesRequest;
    const selectedSha = this.snapshot?.commits[this.commitIndex]?.sha;
    const selectedPath = this.selectedFile()?.path;
    this.notify(message ?? "Refreshing…", "busy");
    try {
      const snapshot = await this.repository.snapshot(1000);
      if (request !== this.snapshotRequest) return;
      // A request that arrived while this one was in flight gets the only paint.
      if (this.refreshPending) return;
      this.snapshot = snapshot;
      this.graphRows = layoutGraph(
        this.snapshot.commits,
        oneDarkTheme.graph,
        resolveHeadSha(this.snapshot.branches, this.snapshot.commits),
      );
      this.branchHints = buildCommitBranchHints(
        this.snapshot.commits,
        this.snapshot.branches,
      );
      this.graphColumns = Math.max(
        1,
        ...this.graphRows.map((row) =>
          Math.max(row.cells.length, row.connectors.length),
        ),
      );
      const commitAt = selectedSha
        ? this.snapshot.commits.findIndex(
            (commit) => commit.sha === selectedSha,
          )
        : -1;
      this.commitIndex =
        commitAt >= 0
          ? commitAt
          : Math.min(
              this.commitIndex,
              Math.max(0, this.snapshot.commits.length - 1),
            );
      const fileAt = selectedPath
        ? this.files().findIndex((file) => file.path === selectedPath)
        : -1;
      this.fileIndex =
        fileAt >= 0
          ? fileAt
          : Math.min(this.fileIndex, Math.max(0, this.files().length - 1));
      this.ensureFileVisible();
      this.paint();
      if (this.view === "commit") void this.openCommit();
      // Branch, sync, and dirty state now live in the header, so a successful
      // refresh only needs to clear the in-flight message.
      this.notify("");
    } catch (error) {
      this.fail(error);
    } finally {
      this.busy = false;
      if (this.refreshPending) {
        const trailingMessage = this.pendingRefreshMessage;
        this.refreshPending = false;
        this.pendingRefreshMessage = undefined;
        void this.refresh(trailingMessage);
      }
    }
  }

  private paint() {
    const s = this.snapshot;
    if (!s) return;
    const rects = layoutSidebarSections(
      this.contentHeight,
      this.sidebarPreferred,
      this.sidebarCollapsed,
    );
    for (const section of SIDEBAR_SECTIONS) {
      const rect = rects[section],
        widgets = this.sidebarSections[section];
      const rows = sidebarRows(s, section, this.sidebarPaneWidth);
      const requested = this.sidebarStart[section];
      const start = Math.max(
        0,
        Math.min(Math.max(0, rows.length - rect.contentHeight), requested),
      );
      this.sidebarStart[section] = start;
      widgets.box.top = rect.headerTop;
      widgets.box.height = Math.max(1, 1 + rect.contentHeight);
      widgets.box.width = this.sidebarPaneWidth;
      widgets.box.visible = rect.headerTop < this.contentHeight;
      widgets.header.content = sidebarHeader(
        section,
        section === "local"
          ? s.branches.filter((b) => !b.remote).length
          : section === "remote"
            ? s.branches.filter((b) => b.remote).length
            : section === "submodules"
              ? s.submodules.length
              : section === "stashes"
                ? s.stashes.length
                : s.worktrees.length,
        this.sidebarCollapsed[section],
      );
      widgets.text.top = 1;
      widgets.text.height = Math.max(1, rect.contentHeight);
      widgets.text.visible =
        !this.sidebarCollapsed[section] && rect.contentHeight > 0;
      widgets.text.content =
        section === "submodules" && s.submodules.length > 0
          ? renderSubmoduleSidebarViewport(
              s.submodules,
              this.sidebarPaneWidth,
              start,
              rect.contentHeight,
            )
          : renderSidebarViewport(
              rows,
              this.sidebarPaneWidth,
              start,
              rect.contentHeight,
            ).join("\n");
      const showDivider = rect.dividerTop !== undefined;
      widgets.divider.top = Math.max(0, (rect.dividerTop ?? 0) - 1);
      // Keep the forgiving drag target around the visible centre grip instead
      // of covering the full section width and intercepting nearby content.
      widgets.divider.left = Math.floor(this.sidebarPaneWidth / 4);
      widgets.divider.width = Math.min(
        this.sidebarPaneWidth,
        Math.max(5, Math.floor(this.sidebarPaneWidth / 2)),
      );
      widgets.divider.visible = showDivider;
      widgets.dividerBar.top = rect.dividerTop ?? 0;
      widgets.dividerBar.width = this.sidebarPaneWidth;
      const dividerWidth = Math.max(1, this.sidebarPaneWidth);
      const gripWidth = Math.max(3, Math.min(9, Math.floor(dividerWidth / 3)));
      const gripStart = Math.max(0, Math.floor((dividerWidth - gripWidth) / 2));
      widgets.dividerBar.content = `${"─".repeat(gripStart)}${"═".repeat(gripWidth)}${"─".repeat(Math.max(0, dividerWidth - gripStart - gripWidth))}`;
      widgets.dividerBar.visible = showDivider;
    }
    this.paintHeader();
    this.paintToolbar();
    this.paintHistory();
    this.paintFiles();
  }
  private paintHistory() {
    const s = this.snapshot;
    if (!s) return;
    const hasWorking = s.files.length > 0;
    // `visible` counts selectable rows (not the heading), everywhere below.
    const visible = Math.max(1, this.contentHeight - 3);
    const totalDisplayRows = this.graphRows.length + (hasWorking ? 1 : 0);
    const selectedDisplay =
      this.historySelection === "working" && hasWorking
        ? 0
        : this.commitIndex + (hasWorking ? 1 : 0);
    const maxHistoryStart = Math.max(0, totalDisplayRows - visible);
    if (!this.historyViewportDetached) {
      if (selectedDisplay < this.historyStart)
        this.historyStart = selectedDisplay;
      else if (selectedDisplay >= this.historyStart + visible)
        this.historyStart = selectedDisplay - visible + 1;
    }
    this.historyStart = Math.max(
      0,
      Math.min(maxHistoryStart, this.historyStart),
    );
    const chunks = [
      fg(this.focus === "history" ? oneDarkTheme.accent : oneDarkTheme.muted)(
        ` BRANCH / TAG          GRAPH  ${s.commits.length} COMMITS\n`,
      ),
    ];
    this.historyShaHits.clear();
    this.historyLabelHits.clear();
    const labelWidth = Math.min(
      22,
      Math.max(14, Math.floor(this.historyContentWidth * 0.28)),
    );
    const graphColumns = this.graphColumns;
    const rowBackgrounds = [oneDarkTheme.bg, oneDarkTheme.panelRaised];
    const maxStart = Math.max(0, totalDisplayRows - visible);
    const thumbSize = Math.max(
      1,
      Math.floor((visible * visible) / Math.max(1, totalDisplayRows)),
    );
    const thumbStart = maxStart
      ? Math.floor(
          (this.historyStart / maxStart) * Math.max(0, visible - thumbSize),
        )
      : 0;
    const scrollbarThumb = (displayOffset: number) =>
      displayOffset >= thumbStart && displayOffset < thumbStart + thumbSize;
    const scrollbar = (displayOffset: number) =>
      scrollbarThumb(displayOffset) ? "█" : "│";
    for (let offset = 0; offset < visible; offset++) {
      const displayIndex = this.historyStart + offset;
      if (displayIndex >= totalDisplayRows) break;
      if (hasWorking && displayIndex === 0) {
        const selected = this.historySelection === "working";
        const rowBg = selected
          ? oneDarkTheme.selected
          : oneDarkTheme.panelRaised;
        const workingLabel = selected
          ? "▸ ● Working changes"
          : "  ● Working changes";
        const fileCount = `  ${s.files.length} files`;
        const fileCountWidth = Math.max(
          Bun.stringWidth(fileCount),
          this.historyContentWidth - Bun.stringWidth(workingLabel) - 1,
        );
        chunks.push(
          bg(rowBg)(fg(oneDarkTheme.warning)(workingLabel)),
          bg(rowBg)(fg(oneDarkTheme.muted)(fileCount.padEnd(fileCountWidth))),
          bg(rowBg)(
            fg(
              scrollbarThumb(offset)
                ? oneDarkTheme.accent
                : oneDarkTheme.border,
            )(`${scrollbar(offset)}\n`),
          ),
        );
        continue;
      }
      const commitRow = displayIndex - (hasWorking ? 1 : 0);
      const row = this.graphRows[commitRow]!;
      const selected =
        this.historySelection === "commit" && commitRow === this.commitIndex;
      const summary = summariseDecorations(row.commit.decorations, s.branches);
      let primary = summary.label;
      if (selected && !primary)
        primary = this.branchHints.get(row.commit.sha) ?? "";
      // Refs that do not fit are counted, so a commit never silently hides
      // the tag or branch you were looking for.
      const chip = summary.extra > 0 ? ` +${summary.extra}` : "";
      const label = primary
        ? fitColumns(primary, labelWidth - 2 - chip.length, true).trimEnd() +
          chip
        : "";
      const labelText = label
        ? fitColumns(` ${label} `, labelWidth)
        : "".padEnd(labelWidth);
      const graphColor = row.cells[row.lane]?.color ?? oneDarkTheme.accent;
      const rowBg = selected
        ? oneDarkTheme.selected
        : rowBackgrounds[commitRow % 2]!;
      const rowWidth = this.historyContentWidth;
      const nonTextWidth = labelWidth + 2 + graphColumns * 2 + 15;
      const textWidth = Math.max(2, rowWidth - nonTextWidth);
      const authorWidth = Math.max(1, Math.min(11, textWidth - 8));
      const subjectWidth = Math.max(1, textWidth - authorWidth);
      const subject = fitColumns(row.commit.subject, subjectWidth, true);
      const cellPadding = Math.max(0, graphColumns - row.cells.length);
      const author = fitColumns(row.commit.author, authorWidth, true);
      chunks.push(
        bg(rowBg)(fg(label ? graphColor : oneDarkTheme.muted)(labelText)),
        bg(rowBg)(fg(oneDarkTheme.muted)(selected ? "▸ " : "  ")),
        ...row.cells.map((cell) => bg(rowBg)(fg(cell.color)(cell.symbol))),
        bg(rowBg)(fg(oneDarkTheme.muted)("  ".repeat(cellPadding))),
        // HEAD's subject takes the marker colour so the checked-out commit
        // reads at a glance without stealing width from the row.
        bg(rowBg)(
          fg(row.head ? oneDarkTheme.warning : oneDarkTheme.text)(subject),
        ),
        bg(rowBg)(fg(oneDarkTheme.border)(" │ ")),
        bg(rowBg)(fg(oneDarkTheme.author)(author)),
        bg(rowBg)(fg(oneDarkTheme.border)(" │ ")),
        bg(rowBg)(fg(oneDarkTheme.accent)(shortSha(row.commit.sha))),
        bg(rowBg)(
          fg(
            scrollbarThumb(offset) ? oneDarkTheme.accent : oneDarkTheme.border,
          )(`${scrollbar(offset)}\n`),
        ),
      );
      const shaStart =
        labelWidth + 2 + graphColumns * 2 + subjectWidth + 3 + authorWidth + 3;
      this.historyShaHits.set(commitRow, {
        start: shaStart,
        end: shaStart + 8,
      });
      if (label)
        this.historyLabelHits.set(commitRow, {
          start: 0,
          end: labelWidth,
          ref: primaryDecorationRef(row.commit.decorations, s.branches),
        });
    }
    this.historyText.content = new StyledText(chunks);
  }
  private paintFiles() {
    // File counts change with every refresh, so the sections are re-measured
    // before they are drawn.
    this.layoutChanges(this.contentHeight);
    if (this.view === "commit") {
      this.paintSection("unstaged");
      return;
    }
    this.paintSection("unstaged");
    this.paintSection("staged");
    this.paintComposer();
  }
  /** Draw one changed-files list, its heading, and its empty state. */
  private paintSection(section: ChangeSection) {
    const commitView = this.view === "commit";
    const files = this.files(commitView ? this.mode : section);
    const label = this.label(section);
    const list = this.list(section);
    const active = !commitView && section === this.mode;
    const collapsed = !commitView && this.sectionCollapsed[section];
    label.content = new StyledText([
      fg(
        this.focus === "changes" && (active || commitView)
          ? oneDarkTheme.accent
          : oneDarkTheme.muted,
      )(
        commitView
          ? ` COMMIT FILES  ${files.length}`
          : ` ${collapsed ? "▶" : "▼"} ${section === "staged" ? "Staged" : "Unstaged"} files (${files.length})`,
      ),
    ]);
    if (collapsed) {
      list.content = "";
      return;
    }
    const limit = this.sectionViewport(section);
    if (commitView) list.height = limit;
    const tree = buildFileTree(files);
    if (this.expandedFiles.size === 0)
      for (const node of tree.children)
        if (node.kind === "directory") this.expandedFiles.add(node.path);
    const allRows = flattenVisible(tree, this.expandedFiles);
    const start = Math.max(
      0,
      Math.min(
        Math.max(0, allRows.length - limit),
        active || commitView ? this.fileStart : this.sectionStart[section],
      ),
    );
    this.sectionStart[section] = start;
    if (active || commitView) this.fileStart = start;
    const rows = allRows.slice(start, start + limit);
    if (rows.length === 0) {
      list.content = commitView
        ? new StyledText([
            fg(oneDarkTheme.muted)("  No changed files in this commit\n"),
            fg(oneDarkTheme.muted)("  esc  back to the graph"),
          ])
        : new StyledText([
            fg(oneDarkTheme.muted)(
              section === "staged" ? "  Nothing staged" : "  Nothing to stage",
            ),
          ]);
      return;
    }
    const selectedPath =
      active || commitView ? this.selectedFile()?.path : undefined;
    const chunks = [];
    for (const { node, depth } of rows) {
      const selected = node.kind === "file" && node.path === selectedPath;
      const statusIcon = fileIcon(node);
      const statusColor = fileColor(node);
      const materialIcon = resolveMaterialIcon(
        node.name,
        node.kind === "directory",
        node.kind === "directory" && this.expandedFiles.has(node.path),
      );
      const nameColor =
        node.kind === "directory" ? oneDarkTheme.folder : oneDarkTheme.text;
      const available = Math.max(6, this.detailsPaneWidth - depth * 2 - 11);
      const treeLabel = fitTreeLabel(node.name, available);
      chunks.push(
        selected
          ? bg(oneDarkTheme.selected)("▸ ")
          : fg(oneDarkTheme.muted)("  "),
        fg(oneDarkTheme.border)("│ ".repeat(depth)),
        node.kind === "directory"
          ? fg(oneDarkTheme.folder)(
              this.expandedFiles.has(node.path) ? "▼ " : "▶ ",
            )
          : fg(oneDarkTheme.muted)("  "),
        fg(materialIcon.color ?? oneDarkTheme.folder)(`${materialIcon.glyph} `),
        node.kind === "directory"
          ? fg(oneDarkTheme.muted)("")
          : fg(statusColor)(`${statusIcon} `),
        selected
          ? bg(oneDarkTheme.selected)(fg(nameColor)(treeLabel))
          : fg(nameColor)(treeLabel),
        fg(oneDarkTheme.muted)("\n"),
      );
    }
    list.content = new StyledText(chunks);
  }
  /** Refresh the commit button's label and enabled colours. */
  private paintComposer() {
    if (this.editingCommitSha) {
      this.commitButton.fg = oneDarkTheme.added;
      this.commitButton.content = "Save message";
      return;
    }
    const staged = this.files("staged").length;
    const ready = staged > 0 && this.composerSummary.value.trim().length > 0;
    const width = Math.max(10, this.detailsPaneWidth - 4);
    const text = ready
      ? `Commit ${staged} staged file${staged === 1 ? "" : "s"}`
      : staged === 0
        ? "Stage files to commit"
        : "Write a summary to commit";
    const padding = Math.max(
      0,
      Math.floor((width - Bun.stringWidth(text)) / 2),
    );
    this.commitButton.fg = ready ? oneDarkTheme.added : oneDarkTheme.muted;
    this.commitButton.content = new StyledText([
      bg(ready ? oneDarkTheme.selected : oneDarkTheme.panelRaised)(
        fg(ready ? oneDarkTheme.added : oneDarkTheme.muted)(
          fitColumns(
            `${" ".repeat(padding)}${ready ? "✓ " : ""}${text}`,
            width,
          ),
        ),
      ),
    ]);
    this.amendButton.content = `${this.amend ? "[x]" : "[ ]"} Amend previous commit`;
    this.amendButton.fg = this.amend
      ? oneDarkTheme.warning
      : oneDarkTheme.muted;
  }

  private ensureFileVisible(
    rows = flattenVisible(buildFileTree(this.files()), this.expandedFiles),
  ) {
    const path = this.selectedFile()?.path;
    const selectedRow = path
      ? rows.findIndex(({ node }) => node.path === path)
      : -1;
    const limit = this.filesViewport();
    const maxStart = Math.max(0, rows.length - limit);
    if (selectedRow >= 0) {
      if (selectedRow < this.fileStart) this.fileStart = selectedRow;
      else if (selectedRow >= this.fileStart + limit)
        this.fileStart = selectedRow - limit + 1;
    }
    this.fileStart = Math.max(0, Math.min(maxStart, this.fileStart));
  }

  private async loadDiff() {
    const token = ++this.diffRequest;
    const file = this.selectedFile();
    const selected = this.snapshot?.commits[this.commitIndex];
    const snapshot = this.snapshot;
    const view = this.view;
    const mode = this.mode;
    const path = file?.path;
    const value =
      this.view === "commit" && selected
        ? await this.repository.diff({
            commit: selected.sha,
            path: file?.path,
            context: 6,
          })
        : file
          ? await this.repository.diff({
              path: file.path,
              staged: this.mode === "staged",
              context: 6,
            })
          : "";
    if (
      token !== this.diffRequest ||
      this.snapshot !== snapshot ||
      this.view !== view ||
      this.mode !== mode ||
      this.selectedFile()?.path !== path ||
      (view === "commit" &&
        this.snapshot?.commits[this.commitIndex]?.sha !== selected?.sha)
    )
      return;
    if (this.view !== "history") {
      this.commitDiff.diff = value;
      this.commitDiffEmpty.visible = value.length === 0;
    }
  }
  private moveCommit(delta: number) {
    if (!this.snapshot || this.commitDiff.visible) return;
    this.historyViewportDetached = false;
    const hasWorking = this.snapshot.files.length > 0;
    if (this.historySelection === "working") {
      if (delta <= 0) return;
      this.historySelection = "commit";
      this.commitIndex = 0;
      this.paintHistory();
      return;
    }
    if (hasWorking && delta < 0 && this.commitIndex === 0) {
      this.historySelection = "working";
      this.paintHistory();
      return;
    }
    this.historySelection = "commit";
    this.commitIndex = Math.max(
      0,
      Math.min(this.snapshot.commits.length - 1, this.commitIndex + delta),
    );
    this.paintHistory();
  }
  private queueHistoryScroll(delta: number) {
    this.pendingScroll += delta;
    if (this.scrollTimer) return;
    this.scrollTimer = setTimeout(() => {
      const movement = this.pendingScroll;
      this.pendingScroll = 0;
      this.scrollTimer = undefined;
      this.scrollHistoryViewport(movement);
    }, 16);
  }
  private scrollHistoryViewport(delta: number) {
    if (!this.snapshot || this.commitDiff.visible) return;
    const total =
      this.graphRows.length + (this.snapshot.files.length > 0 ? 1 : 0);
    const visible = Math.max(1, this.contentHeight - 3);
    this.historyViewportDetached = true;
    this.historyStart = Math.max(
      0,
      Math.min(Math.max(0, total - visible), this.historyStart + delta),
    );
    this.paintHistory();
  }
  private historyClick(x: number, y: number, button: number) {
    if (this.commitDiff.visible) return;
    this.setFocus("history");
    if (this.scrollTimer) {
      clearTimeout(this.scrollTimer);
      this.scrollTimer = undefined;
      this.pendingScroll = 0;
    }
    this.historyViewportDetached = false;
    const hasWorking = (this.snapshot?.files.length ?? 0) > 0;
    const displayRow = y - 2;
    const displayIndex = this.historyStart + displayRow;
    if (hasWorking && displayIndex === 0) {
      this.closeDiff();
      this.mode = "unstaged";
      this.paint();
      return;
    }
    const row = displayIndex - (hasWorking ? 1 : 0);
    if (row < 0 || row >= (this.snapshot?.commits.length ?? 0)) return;
    this.commitIndex = row;
    this.historySelection = "commit";
    this.paintHistory();
    const commit = this.snapshot!.commits[row]!;
    const column = x - this.historyContentLeft;
    const labelHit = this.historyLabelHits.get(row);
    const onLabel =
      !!labelHit && column >= labelHit.start && column < labelHit.end;
    if (button === MouseButton.RIGHT) {
      this.openGraphMenu(x, y + PANE_TOP, {
        sha: commit.sha,
        branch: onLabel ? labelHit?.ref : undefined,
      });
      return;
    }
    const shaHit = this.historyShaHits.get(row);
    if (shaHit && column >= shaHit.start && column < shaHit.end) {
      const sha = shortSha(commit.sha);
      if (this.renderer.copyToClipboardOSC52(sha)) this.notify(`Copied ${sha}`);
      return;
    }
    const now = Date.now();
    const previous = this.lastGraphClick;
    this.lastGraphClick = { row, at: now, label: onLabel };
    const doubled =
      !!previous &&
      previous.row === row &&
      previous.label === onLabel &&
      now - previous.at < DOUBLE_CLICK_MS;
    if (doubled) {
      this.lastGraphClick = undefined;
      if (onLabel && labelHit?.ref)
        return void this.checkoutBranch(labelHit.ref);
      if (onLabel) return this.notify("That label is a tag, not a branch");
    }
    void this.openCommit();
  }

  /** Open the graph context menu at a terminal position. */
  private openGraphMenu(
    x: number,
    y: number,
    target: { sha: string; branch?: BranchRef },
  ) {
    if (!this.snapshot) return;
    const built = buildGraphMenu(target, this.snapshot);
    this.openPopup(built.title, built.items, x, y, (item) => {
      if (item.action) void this.runMenuAction(item.action, target);
    });
  }

  private async runMenuAction(
    action: GraphMenuAction,
    target: { sha: string; branch?: BranchRef },
  ) {
    const branch = target.branch;
    const reference = branch ? branch.name : target.sha;
    if (action === "copy-sha") {
      const sha = shortSha(target.sha);
      return void (
        this.renderer.copyToClipboardOSC52(sha) && this.notify(`Copied ${sha}`)
      );
    }
    if (action === "copy-branch") {
      if (!branch) return;
      return void (
        this.renderer.copyToClipboardOSC52(branch.name) &&
        this.notify(`Copied ${branch.name}`)
      );
    }
    if (action === "checkout-branch")
      return void (branch && this.checkoutBranch(branch));
    if (action === "checkout-commit")
      return this.perform(`Checking out ${shortSha(target.sha)}…`, () =>
        this.repository.checkoutCommit(target.sha),
      );
    if (action === "rebase-onto")
      return this.perform(`Rebasing onto ${reference}…`, () =>
        this.repository.rebaseOnto(reference),
      );
    if (action === "delete-branch") {
      if (!branch) return;
      return this.confirmThen(
        {
          title: "Delete branch",
          lines: [
            `Delete the local branch ${displayBranchName(branch.name)}?`,
            "Commits only on this branch become unreachable.",
          ],
          confirmLabel: `Delete ${displayBranchName(branch.name)}`,
          destructive: true,
        },
        () =>
          this.perform(`Deleting ${branch.name}…`, () =>
            this.repository.deleteBranch(branch.name, true),
          ),
      );
    }
    const mode: ResetMode =
      action === "reset-soft"
        ? "soft"
        : action === "reset-hard"
          ? "hard"
          : "mixed";
    const label = `${this.snapshot?.branch ?? "HEAD"} → ${branch ? displayBranchName(branch.name) : shortSha(target.sha)}`;
    if (mode !== "hard")
      return this.perform(`Resetting (${mode}) ${label}…`, () =>
        this.repository.resetTo(reference, mode),
      );
    return this.confirmThen(
      {
        title: "Hard reset",
        lines: [
          `Move ${this.snapshot?.branch ?? "HEAD"} to ${branch ? displayBranchName(branch.name) : shortSha(target.sha)}`,
          "and throw away all uncommitted changes to tracked files.",
          "This cannot be undone from the working tree.",
        ],
        confirmLabel: "Reset --hard",
        destructive: true,
      },
      () =>
        this.perform(`Resetting (hard) ${label}…`, () =>
          this.repository.resetTo(reference, "hard"),
        ),
    );
  }

  /**
   * Check out a branch from the graph.
   *
   * A remote branch is checked out through its local counterpart. When that
   * local branch already exists and has diverged, the move discards the local
   * commits, so it is confirmed first.
   */
  private async checkoutBranch(branch: BranchRef) {
    if (branch.current) return this.notify(`Already on ${branch.name}`);
    if (!branch.remote)
      return this.perform(`Switching to ${branch.name}…`, () =>
        this.repository.switchBranch(branch.name),
      );
    const short = displayBranchName(branch.name);
    const local = this.snapshot?.branches.find(
      (ref) => !ref.remote && ref.name === short,
    );
    if (!local)
      return this.perform(`Switching to ${short}…`, () =>
        this.repository.checkoutRemoteBranch(short, branch.name, false),
      );
    if (local.sha === branch.sha)
      return this.perform(`Switching to ${short}…`, () =>
        this.repository.switchBranch(short),
      );
    return this.confirmThen(
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
        this.perform(`Resetting ${short} to ${branch.name}…`, () =>
          this.repository.checkoutRemoteBranch(short, branch.name, true),
        ),
    );
  }

  /** Ask before running an action that loses work. */
  private confirmThen(request: ConfirmRequest, run: () => Promise<void>) {
    const items: GraphMenuItem[] = [
      ...request.lines.map((line) => ({ label: line, disabled: true })),
      { label: "", separator: true },
      { label: request.confirmLabel, destructive: request.destructive },
      { label: "Cancel" },
    ];
    const width = menuWidth(items);
    this.openPopup(
      request.title,
      items,
      Math.max(0, Math.floor((this.renderer.terminalWidth - width) / 2)),
      Math.max(
        0,
        Math.floor((this.renderer.terminalHeight - items.length) / 2),
      ),
      (item) => {
        if (item.label === request.confirmLabel) void run();
      },
    );
  }

  private openPopup(
    title: string,
    items: GraphMenuItem[],
    x: number,
    y: number,
    select: (item: GraphMenuItem) => void,
  ) {
    const width = menuWidth(items);
    const { left, top } = placeMenu(
      x,
      y,
      width,
      items.length,
      this.renderer.terminalWidth,
      this.renderer.terminalHeight,
    );
    this.popup = { title, items, left, top, width, select };
    this.paintPopup();
  }

  private closePopup() {
    this.popup = undefined;
    this.paintPopup();
  }

  private paintPopup() {
    const popup = this.popup;
    const visible = !!popup;
    for (const widget of [this.overlayCatcher, this.menuBox, this.menuText])
      widget.visible = visible;
    const submenuVisible = !!popup?.submenu;
    this.submenuBox.visible = submenuVisible;
    this.submenuText.visible = submenuVisible;
    if (!popup) return;
    this.menuBox.left = popup.left;
    this.menuBox.top = popup.top;
    this.menuBox.width = popup.width;
    this.menuBox.height = popup.items.length + 2;
    this.menuBox.title = ` ${clipColumns(popup.title, popup.width - 4)} `;
    this.menuText.left = popup.left + 1;
    this.menuText.top = popup.top + 1;
    this.menuText.width = popup.width - 2;
    this.menuText.height = popup.items.length;
    this.menuText.content = this.popupContent(popup);
    const submenu = popup.submenu;
    if (!submenu) return;
    this.submenuBox.left = submenu.left;
    this.submenuBox.top = submenu.top;
    this.submenuBox.width = submenu.width;
    this.submenuBox.height = submenu.items.length + 2;
    this.submenuBox.title = "";
    this.submenuText.left = submenu.left + 1;
    this.submenuText.top = submenu.top + 1;
    this.submenuText.width = submenu.width - 2;
    this.submenuText.height = submenu.items.length;
    this.submenuText.content = this.popupContent(submenu);
  }

  private popupContent(pane: PopupPane): StyledText {
    const width = pane.width - 2;
    return new StyledText(
      pane.items.map((item, index) => {
        const line = renderMenuLine(item, width);
        const suffix = index === pane.items.length - 1 ? "" : "\n";
        if (item.separator) return fg(oneDarkTheme.border)(`${line}${suffix}`);
        const rowBg =
          index === pane.hover && !item.disabled
            ? oneDarkTheme.selected
            : oneDarkTheme.panelRaised;
        const color = item.disabled
          ? oneDarkTheme.muted
          : item.destructive
            ? oneDarkTheme.deleted
            : oneDarkTheme.text;
        return bg(rowBg)(fg(color)(`${line}${suffix}`));
      }),
    );
  }

  private hoverPopup(x: number, y: number, inSubmenu: boolean) {
    const popup = this.popup;
    if (!popup) return;
    const pane = inSubmenu ? popup.submenu : popup;
    if (!pane) return;
    const row = menuRowAt(pane, x, y);
    if (pane.hover === row) return;
    pane.hover = row;
    // Moving onto another top-level row closes a submenu that is no longer
    // under the pointer, which is what a menu is expected to do.
    if (!inSubmenu && row !== undefined && popup.submenu?.parent !== row)
      popup.submenu = undefined;
    if (!inSubmenu && row !== undefined) this.openSubmenuFor(row);
    this.paintPopup();
  }

  private openSubmenuFor(row: number) {
    const popup = this.popup;
    const item = popup?.items[row];
    if (!popup || !item?.submenu || popup.submenu?.parent === row) return;
    const width = menuWidth(item.submenu);
    const { left, top } = placeMenu(
      popup.left + popup.width,
      popup.top + 1 + row,
      width,
      item.submenu.length,
      this.renderer.terminalWidth,
      this.renderer.terminalHeight,
    );
    popup.submenu = { parent: row, items: item.submenu, left, top, width };
  }

  private clickPopup(x: number, y: number, inSubmenu: boolean) {
    const popup = this.popup;
    if (!popup) return;
    const pane = inSubmenu ? popup.submenu : popup;
    if (!pane) return;
    const row = menuRowAt(pane, x, y);
    if (row === undefined) return;
    const item = pane.items[row];
    if (!item || item.disabled) return;
    if (item.submenu) {
      this.openSubmenuFor(row);
      this.paintPopup();
      return;
    }
    const select = popup.select;
    this.closePopup();
    select(item);
  }

  private async openCommit() {
    const commit = this.snapshot?.commits[this.commitIndex];
    if (!commit) return;
    const token = ++this.commitFilesRequest;
    ++this.diffRequest;
    const snapshot = this.snapshot;
    const selectedPath = this.selectedFile()?.path;
    this.view = "commit";
    this.historySelection = "commit";
    this.fileIndex = 0;
    this.fileStart = 0;
    this.history.title = undefined;
    this.historyText.visible = true;
    this.commitDiff.visible = false;
    this.commitDiffEmpty.visible = false;
    this.showCommitMeta(commit);
    this.workingBanner.content = workingChangesBannerLines(
      this.snapshot?.files.length ?? 0,
      Math.max(1, this.detailsPaneWidth - 2),
    ).join("\n");
    this.workingBanner.height = this.workingBanner.visible ? 2 : 1;
    this.layout();
    this.notify("Commit selected · click a changed file for its diff");
    this.commitFiles = [];
    this.unstagedText.content = new StyledText([
      fg(oneDarkTheme.muted)("  ░░░░░░░░░░░░░░░\n  ░░░░░░░░░░\n  ░░░░░░░░░░░░"),
    ]);
    this.commitDiffEmpty.content = "Select a changed file to open its diff.";
    try {
      const files = await this.repository.commitFiles(commit.sha);
      if (
        token !== this.commitFilesRequest ||
        this.snapshot !== snapshot ||
        this.view !== "commit" ||
        this.snapshot?.commits[this.commitIndex]?.sha !== commit.sha
      )
        return;
      this.commitFiles = files;
      const fileAt = selectedPath
        ? files.findIndex((file) => file.path === selectedPath)
        : -1;
      this.fileIndex = fileAt >= 0 ? fileAt : 0;
      this.ensureFileVisible();
      this.paintFiles();
    } catch (e) {
      if (token !== this.commitFilesRequest || this.snapshot !== snapshot)
        return;
      const message = e instanceof Error ? e.message : String(e);
      this.unstagedText.content = `  Failed to load changed files\n  ${message}`;
      this.notify(message, "error");
    }
  }
  private async openWorkingDiff() {
    const file = this.selectedFile();
    if (!file) return;
    this.view = "working";
    this.history.title = ` ${this.mode.toUpperCase()} · ${file.path} `;
    this.historyText.visible = false;
    this.commitDiff.visible = true;
    this.commitDiffEmpty.visible = false;
    this.setCommitMetaVisible(false);
    this.paintHints();
    this.layout();
    try {
      await this.loadDiff();
    } catch (error) {
      this.fail(error);
    }
  }
  private closeDiff() {
    this.view = "history";
    this.historySelection = "working";
    this.commitFiles = [];
    this.fileIndex = 0;
    this.history.title = undefined;
    this.historyText.visible = true;
    this.commitDiff.visible = false;
    this.commitDiffEmpty.visible = false;
    this.setCommitMetaVisible(false);
    this.paintHints();
    // A view change moves the file list and the diff, so geometry has to be
    // recomputed rather than only repainted.
    this.layout();
  }
  private showCommitMeta(commit: Commit) {
    const meta = presentCommitMeta(commit);
    this.commitInfo.content = meta.info;
    this.commitInfoValue = `${shortSha(commit.sha)}\nAuthor: ${commit.author}${commit.authorEmail ? ` <${commit.authorEmail}>` : ""}\nAuthored: ${commit.authoredAt}\nCommitter: ${commit.committer}${commit.committerEmail ? ` <${commit.committerEmail}>` : ""}\nCommitted: ${commit.committedAt}`;
    this.commitHeaderValue = meta.header;
    this.commitHeader.content = meta.header;
    this.commitBodyValue = meta.body;
    this.commitBody.content = meta.body;
    const bodyWidth = Math.max(10, this.detailsPaneWidth - 8);
    this.commitBody.height = wrappedLineCount(meta.body, bodyWidth);
    this.commitBodyBox.scrollTo(0);
    this.setCommitMetaVisible(true);
    this.layout();
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
    if (commit) this.showCommitMeta(commit);
    this.paintComposer();
    this.paintHints();
  }
  private sidebarClick(y: number, button: number) {
    if (button === MouseButton.RIGHT) {
      const branch = this.snapshot?.branch;
      if (branch && this.renderer.copyToClipboardOSC52(branch))
        this.notify(`Copied ${branch}`);
    }
  }
  private toggleSidebarSection(section: SidebarSection) {
    this.sidebarCollapsed[section] = !this.sidebarCollapsed[section];
    this.persistLayoutPreferences();
    this.paint();
  }
  private sidebarScroll(y: number, delta: number) {
    if (!this.snapshot) return;
    const rects = layoutSidebarSections(
      this.contentHeight,
      this.sidebarPreferred,
      this.sidebarCollapsed,
    );
    const section = SIDEBAR_SECTIONS.find(
      (s) =>
        y >= rects[s].contentTop &&
        y < rects[s].contentTop + rects[s].contentHeight,
    );
    if (!section || this.sidebarCollapsed[section]) return;
    const rows = sidebarRows(this.snapshot, section, this.sidebarPaneWidth);
    this.sidebarStart[section] = Math.max(
      0,
      Math.min(
        Math.max(0, rows.length - rects[section].contentHeight),
        this.sidebarStart[section] + delta,
      ),
    );
    this.paint();
  }
  private resizeSidebar(section: SidebarSection, y: number) {
    const layout = layoutSidebarSections(
      this.contentHeight,
      this.sidebarPreferred,
      this.sidebarCollapsed,
    );
    this.sidebarPreferred = resizeSidebarBoundary(
      layout,
      this.sidebarPreferred,
      this.sidebarCollapsed,
      section,
      y,
    );
    this.persistLayoutPreferences();
    this.paint();
  }

  private async key(key: KeyEvent) {
    if (this.composing && key.name !== "escape" && key.name !== "tab") {
      // The editors own every other key while composing, but the button label
      // tracks the summary, so repaint after the keystroke lands.
      setTimeout(() => this.paintComposer(), 0);
      return;
    }
    if (this.composing && key.name === "tab") {
      const next =
        this.renderer.currentFocusedEditor === this.composerSummary
          ? this.composerBody
          : this.composerSummary;
      next.focus();
      return;
    }
    if (key.name === "escape") {
      if (this.popup) return this.closePopup();
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
      if (this.refreshTimer) clearInterval(this.refreshTimer);
      if (this.scrollTimer) clearTimeout(this.scrollTimer);
      if (this.messageTimer) clearTimeout(this.messageTimer);
      await this.flushLayoutPreferences().catch(() => undefined);
      return this.renderer.destroy();
    }
    if (key.name === "tab") {
      this.setFocus(this.focus === "history" ? "changes" : "history");
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
        () => this.repository.fetch(),
        true,
      );
    if (key.name === "l")
      return void this.perform("Pulling…", () => this.repository.pull(), true);
    if (key.name === "p")
      return void this.perform("Pushing…", () => this.repository.push(), true);
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
    this.setFocus("changes");
    this.fileIndex = Math.max(
      0,
      Math.min(Math.max(0, this.files().length - 1), this.fileIndex + delta),
    );
    this.ensureFileVisible();
    this.paintFiles();
    if (this.view !== "history")
      void this.loadDiff().catch((e) => this.fail(e));
  }
  private async openSelectedFile() {
    if (!this.selectedFile()) return this.notify("No file selected");
    if (this.view === "history") return void this.openWorkingDiff();
    this.historyText.visible = false;
    this.commitDiff.visible = true;
    this.commitDiffEmpty.visible = false;
    await this.loadDiff().catch((e) => this.fail(e));
  }
  private async perform(
    label: string,
    action: () => Promise<void>,
    remote = false,
  ) {
    this.notify(label, "busy");
    try {
      await action();
      if (remote) this.syncedAt = Date.now();
      await this.refresh();
    } catch (e) {
      this.fail(e);
    }
  }
  private async commit() {
    const summary = this.composerSummary.value.trim();
    if (!summary) return this.notify("Commit summary cannot be empty", "error");
    if (!this.editingCommitSha && this.files("staged").length === 0)
      return this.notify("Nothing staged to commit", "error");
    const body = this.composerBody.plainText.trim();
    const message = body ? `${summary}\n\n${body}` : summary;
    this.composerSummary.blur();
    this.composerBody.blur();
    const reword = this.editingCommitSha;
    try {
      this.notify(reword ? "Saving message…" : "Committing…", "busy");
      if (reword) await this.repository.rewordCommit(reword, message);
      else if (this.amend) await this.repository.amendCommit(message);
      else await this.repository.commit(message);
      this.editingCommitSha = undefined;
      if (reword) this.restoreEditReturnState();
      else {
        this.amend = false;
        this.amendDraft = undefined;
        this.composerSummary.value = "";
        this.composerBody.setText("");
      }
      await this.refresh();
      this.paintComposer();
    } catch (error) {
      this.fail(error);
      if (reword) setTimeout(() => this.composerSummary.focus(), 0);
    }
  }
  private async stageAll() {
    const paths = this.files("unstaged").map((file) => file.path);
    if (paths.length === 0) return this.notify("Nothing to stage");
    await this.perform("Staging all…", () => this.repository.stage(paths));
  }
  private async unstageAll() {
    const paths = this.files("staged").map((file) => file.path);
    if (paths.length === 0) return this.notify("Nothing to unstage");
    await this.perform("Unstaging all…", () => this.repository.unstage(paths));
  }
  /**
   * Discard every unstaged change, including untracked files.
   *
   * The first press only arms the action, because nothing here is recoverable
   * from Git afterwards.
   */
  private async discardAll() {
    if (this.files("unstaged").length === 0)
      return this.notify("Nothing to discard");
    if (!this.discardArmed) {
      this.discardArmed = true;
      setTimeout(() => {
        this.discardArmed = false;
      }, 5000);
      return this.notify(
        "Discard all unstaged changes? Press again to confirm",
        "error",
      );
    }
    this.discardArmed = false;
    await this.perform("Discarding…", () => this.repository.discardAll());
  }
  private async stageFirstHunk() {
    const file = this.selectedFile();
    if (!file) return;
    try {
      const patch = await this.repository.diff({
        path: file.path,
        staged: this.mode === "staged",
        context: 3,
      });
      const hunk = splitPatchHunks(patch)[0];
      if (!hunk) return this.notify("No applicable hunk", "error");
      await this.repository.applyPatch(hunk.patch, this.mode === "staged");
      await this.refresh("Applied hunk");
    } catch (e) {
      this.fail(e);
    }
  }
}
