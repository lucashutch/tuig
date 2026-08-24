import {
  BoxRenderable,
  ScrollBoxRenderable,
  DiffRenderable,
  InputRenderable,
  InputRenderableEvents,
  MouseButton,
  CliRenderEvents,
  StyledText,
  TextRenderable,
  bg,
  createCliRenderer,
  fg,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core";
import type {
  ChangedFile,
  Commit,
  GitRepository,
  RepositorySnapshot,
} from "../git/types.js";
import { splitPatchHunks } from "../git/hunks.js";
import {
  buildFileTree,
  fitTreeLabel,
  flattenVisible,
  toggleExpansion,
  type FileTreeNode,
} from "./file-tree.js";
import { layoutGraph, type GraphRow } from "./graph.js";
import { resolveMaterialIcon } from "./icon-theme.js";
import {
  buildCommitBranchHints,
  branchPresence,
  branchPresenceIcon,
  displayBranchName,
  formatBranchDecoration,
  LAPTOP_BRANCH_ICON,
  REMOTE_BRANCH_ICON,
  shortSha,
} from "./history.js";
import { oneDarkTheme } from "./theme.js";

const dividerColor = "#2B5B61";
const activeDividerColor = "#315878";

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

class Runtime {
  private snapshot?: RepositorySnapshot;
  private commitIndex = 0;
  private historySelection: "working" | "commit" = "working";
  private fileIndex = 0;
  private mode: "unstaged" | "staged" = "unstaged";
  private view: "history" | "commit" | "working" = "history";
  private commitFiles: ChangedFile[] = [];
  private graphRows: GraphRow[] = [];
  private graphColumns = 1;
  private branchHints = new Map<string, string>();
  private historyStart = 0;
  private historyViewportDetached = false;
  private historyContentWidth = 1;
  private fileStart = 0;
  private diffRequest = 0;
  private commitFilesRequest = 0;
  private snapshotRequest = 0;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private scrollTimer?: ReturnType<typeof setTimeout>;
  private pendingScroll = 0;
  private historyShaHits = new Map<number, { start: number; end: number }>();
  private expandedFiles = new Set<string>();
  private busy = false;
  private refreshPending = false;
  private pendingRefreshMessage?: string;
  private readonly sidebar: BoxRenderable;
  private readonly history: BoxRenderable;
  private readonly details: BoxRenderable;
  private readonly status: TextRenderable;
  private readonly sidebarText: TextRenderable;
  private readonly historyText: TextRenderable;
  private readonly diff: DiffRenderable;
  private readonly commitDiff: DiffRenderable;
  private readonly diffEmpty: TextRenderable;
  private readonly commitDiffEmpty: TextRenderable;
  private readonly filesText: TextRenderable;
  private readonly commitInfoBox: BoxRenderable;
  private readonly commitHeaderBox: BoxRenderable;
  private readonly commitBodyBox: ScrollBoxRenderable;
  private readonly commitInfo: TextRenderable;
  private readonly commitHeader: TextRenderable;
  private readonly commitBody: TextRenderable;
  private readonly composer: InputRenderable;
  private readonly leftDivider: BoxRenderable;
  private readonly rightDivider: BoxRenderable;
  private readonly leftDividerBar: TextRenderable;
  private readonly rightDividerBar: TextRenderable;
  private leftWidth = 28;
  private detailsWidth = 44;
  private leftCollapsed = false;
  private localBranchesCollapsed = false;
  private remoteBranchesCollapsed = false;
  private localBranchStart = 0;
  private remoteBranchStart = 0;
  private detailsCollapsed = false;
  private dividerMoved = false;
  private commitFilesTop = 19;
  private commitHeaderValue = "";
  private commitBodyValue = "";

  constructor(
    private renderer: CliRenderer,
    private repository: GitRepository,
  ) {
    const absolute = { position: "absolute" as const };
    this.sidebar = new BoxRenderable(renderer, {
      ...absolute,
      id: "sidebar",
      left: 0,
      top: 0,
      height: "100%",
      backgroundColor: oneDarkTheme.panel,
      onMouseDown: (e) => this.sidebarClick(e.y, e.button),
      onMouseScroll: (e) =>
        this.sidebarScroll(e.y, e.scroll?.direction === "up" ? -3 : 3),
    });
    this.history = new BoxRenderable(renderer, {
      ...absolute,
      id: "history",
      top: 0,
      height: "100%",
      backgroundColor: oneDarkTheme.bg,
      onMouseScroll: (e) =>
        this.queueHistoryScroll(e.scroll?.direction === "up" ? -3 : 3),
    });
    this.details = new BoxRenderable(renderer, {
      ...absolute,
      id: "details",
      top: 0,
      height: "100%",
      backgroundColor: oneDarkTheme.panel,
    });
    this.leftDivider = this.makeDivider("left-divider", (x) => {
      this.leftWidth = Math.max(
        16,
        Math.min(x, this.renderer.terminalWidth - 45),
      );
      this.leftCollapsed = false;
    });
    this.rightDivider = this.makeDivider("right-divider", (x) => {
      this.detailsWidth = Math.max(
        30,
        Math.min(
          this.renderer.terminalWidth - x - 1,
          this.renderer.terminalWidth - 35,
        ),
      );
      this.detailsCollapsed = false;
    });
    this.leftDividerBar = this.makeDividerBar("left-divider-bar");
    this.rightDividerBar = this.makeDividerBar("right-divider-bar");
    this.sidebarText = new TextRenderable(renderer, {
      ...absolute,
      id: "sidebar-content",
      left: 1,
      top: 1,
      width: "95%",
      height: "95%",
      fg: oneDarkTheme.text,
      content: "Loading repository…",
    });
    this.historyText = new TextRenderable(renderer, {
      ...absolute,
      id: "history-content",
      left: 1,
      top: 1,
      width: "97%",
      height: "95%",
      fg: oneDarkTheme.text,
      content: "Loading history…",
      wrapMode: "none",
      onMouseDown: (e) => this.historyClick(e.x, e.y, e.button),
    });
    this.filesText = new TextRenderable(renderer, {
      ...absolute,
      id: "files",
      left: 1,
      top: 1,
      width: "97%",
      height: 6,
      wrapMode: "none",
      fg: oneDarkTheme.text,
      content: "",
      onMouseScroll: (e) => {
        const rows = flattenVisible(
          buildFileTree(this.files()),
          this.expandedFiles,
        );
        this.fileStart = Math.max(
          0,
          Math.min(
            Math.max(0, rows.length - this.fileViewportSize()),
            this.fileStart + (e.scroll?.direction === "up" ? -3 : 3),
          ),
        );
        this.paintFiles();
      },
      onMouseDown: (e) => {
        const row =
          e.y -
          (this.view === "commit" ? this.commitFilesTop : 1) +
          this.fileStart;
        const visible = flattenVisible(
          buildFileTree(this.files()),
          this.expandedFiles,
        );
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
          void this.loadDiff().catch((x) => this.setStatus(String(x)));
        }
      },
    });
    this.commitInfoBox = new BoxRenderable(renderer, {
      ...absolute,
      id: "commit-info-box",
      left: 1,
      top: 1,
      width: "97%",
      height: 4,
      visible: false,
      border: false,
      backgroundColor: oneDarkTheme.panelRaised,
      shouldFill: true,
    });
    this.commitHeaderBox = new BoxRenderable(renderer, {
      ...absolute,
      id: "commit-header-box",
      left: 1,
      top: 5,
      width: "97%",
      height: 4,
      visible: false,
      border: false,
      backgroundColor: oneDarkTheme.panelRaised,
      shouldFill: true,
    });
    this.commitBodyBox = new ScrollBoxRenderable(renderer, {
      ...absolute,
      id: "commit-body-box",
      left: 1,
      top: 9,
      width: "97%",
      height: 9,
      visible: false,
      border: false,
      backgroundColor: oneDarkTheme.panelRaised,
      shouldFill: true,
      scrollY: true,
      scrollX: false,
      viewportCulling: true,
    });
    this.commitInfo = new TextRenderable(renderer, {
      id: "commit-info",
      left: 1,
      top: 1,
      width: "95%",
      height: 1,
      fg: oneDarkTheme.text,
      content: "",
    });
    this.commitHeader = new TextRenderable(renderer, {
      id: "commit-header",
      left: 1,
      top: 1,
      width: "95%",
      height: 1,
      fg: oneDarkTheme.text,
      content: "",
    });
    this.commitBody = new TextRenderable(renderer, {
      id: "commit-body",
      left: 1,
      top: 1,
      width: "95%",
      height: "auto",
      wrapMode: "word",
      fg: "#7F8794",
      content: "",
    });
    const sectionLabel = (id: string, content: string, color: string) =>
      new TextRenderable(renderer, {
        id,
        left: 1,
        top: 0,
        width: "95%",
        height: 1,
        fg: color,
        content,
      });
    this.commitInfoBox.add(
      sectionLabel("commit-info-label", "COMMIT", oneDarkTheme.accent),
    );
    this.commitBodyBox.add(
      sectionLabel("commit-message-label", "COMMIT MESSAGE", oneDarkTheme.text),
    );
    this.commitInfoBox.add(this.commitInfo);
    this.commitBodyBox.add(this.commitHeader);
    this.commitBodyBox.add(this.commitBody);
    this.diff = new DiffRenderable(renderer, {
      ...absolute,
      id: "diff",
      left: 1,
      top: 8,
      width: "97%",
      height: "57%",
      visible: false,
      diff: "",
      view: "unified",
      showLineNumbers: true,
      wrapMode: "none",
      fg: oneDarkTheme.text,
      addedBg: oneDarkTheme.diffAddedBg,
      removedBg: oneDarkTheme.diffRemovedBg,
      addedContentBg: oneDarkTheme.diffAddedBg,
      removedContentBg: oneDarkTheme.diffRemovedBg,
      addedSignColor: oneDarkTheme.added,
      removedSignColor: oneDarkTheme.deleted,
      contextBg: oneDarkTheme.panel,
    });
    this.commitDiff = new DiffRenderable(renderer, {
      ...absolute,
      id: "commit-diff",
      left: 1,
      top: 2,
      width: "97%",
      height: "95%",
      visible: false,
      diff: "",
      view: "unified",
      showLineNumbers: true,
      wrapMode: "none",
      fg: oneDarkTheme.text,
      addedBg: oneDarkTheme.diffAddedBg,
      removedBg: oneDarkTheme.diffRemovedBg,
      addedContentBg: oneDarkTheme.diffAddedBg,
      removedContentBg: oneDarkTheme.diffRemovedBg,
      addedSignColor: oneDarkTheme.added,
      removedSignColor: oneDarkTheme.deleted,
      contextBg: oneDarkTheme.bg,
    });
    this.diffEmpty = new TextRenderable(renderer, {
      ...absolute,
      id: "diff-empty",
      left: 3,
      top: 10,
      width: "90%",
      height: 2,
      visible: false,
      fg: oneDarkTheme.muted,
      content: "No textual diff for this file.",
    });
    this.commitDiffEmpty = new TextRenderable(renderer, {
      ...absolute,
      id: "commit-diff-empty",
      left: 3,
      top: 4,
      width: "90%",
      height: 2,
      visible: false,
      fg: oneDarkTheme.muted,
      content: "This commit has no textual diff to display.",
    });
    this.composer = new InputRenderable(renderer, {
      ...absolute,
      id: "composer",
      left: 1,
      bottom: 2,
      width: "97%",
      value: "",
      placeholder: "Commit message  ·  Enter to commit",
      backgroundColor: oneDarkTheme.panelRaised,
      focusedBackgroundColor: oneDarkTheme.selected,
      textColor: oneDarkTheme.text,
    });
    this.status = new TextRenderable(renderer, {
      ...absolute,
      id: "status",
      left: 1,
      bottom: 0,
      width: "98%",
      height: 1,
      fg: oneDarkTheme.muted,
      content:
        "r refresh  f fetch  l pull  p push  s stage  u unstage  c commit  q quit",
    });
    this.sidebar.add(this.sidebarText);
    this.history.add(this.historyText);
    this.history.add(this.commitDiff);
    this.history.add(this.commitDiffEmpty);
    this.details.add(this.commitInfoBox);
    this.details.add(this.commitBodyBox);
    this.details.add(this.filesText);
    this.details.add(this.diff);
    this.details.add(this.diffEmpty);
    this.details.add(this.composer);
    this.details.add(this.status);
    renderer.root.add(this.sidebar);
    renderer.root.add(this.history);
    renderer.root.add(this.details);
    renderer.root.add(this.leftDividerBar);
    renderer.root.add(this.rightDividerBar);
    renderer.root.add(this.leftDivider);
    renderer.root.add(this.rightDivider);
    renderer.on(CliRenderEvents.RESIZE, () => this.layout());
    renderer.keyInput.on("keypress", (key) => void this.key(key));
    this.composer.on(InputRenderableEvents.ENTER, () => void this.commit());
  }

  async start() {
    this.renderer.start();
    // Terminal dimensions are reliable only after the renderer has started.
    // Laying out earlier can leave the history at a one-column initial width
    // until the first resize event.
    await Bun.sleep(0);
    this.layout();
    await this.refresh();
    // Refresh creates width-dependent history content; recompute once with
    // the live snapshot so startup follows the same path as a manual resize.
    this.layout();
    this.refreshTimer = setInterval(() => {
      if (this.renderer.currentFocusedEditor !== this.composer)
        void this.refresh("Auto-refreshing…");
    }, 60_000);
  }
  private makeDivider(id: string, resize: (x: number) => void) {
    return new BoxRenderable(this.renderer, {
      position: "absolute",
      id,
      top: 0,
      width: 3,
      height: "100%",
      zIndex: 10,
      onMouseDown: () => {
        this.dividerMoved = false;
      },
      onMouseDrag: (e) => {
        this.dividerMoved = true;
        resize(e.x);
        this.layout();
      },
      onMouseUp: () => {
        if (!this.dividerMoved) {
          if (id.startsWith("left")) this.leftCollapsed = !this.leftCollapsed;
          else this.detailsCollapsed = !this.detailsCollapsed;
          this.layout();
        }
      },
    });
  }
  private makeDividerBar(id: string) {
    return new TextRenderable(this.renderer, {
      position: "absolute",
      id,
      top: 0,
      width: 1,
      height: "100%",
      zIndex: 9,
      fg: dividerColor,
      content: "",
    });
  }
  private layout() {
    const total = Math.max(1, this.renderer.terminalWidth);
    const height = Math.max(1, this.renderer.terminalHeight);
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
    this.sidebar.width = Math.min(left, total);
    this.sidebar.visible = !this.leftCollapsed && total > 1;
    const leftBoundary = this.leftCollapsed ? 0 : left;
    this.leftDivider.left = Math.max(0, Math.min(total - 1, leftBoundary - 1));
    this.leftDividerBar.left = Math.max(0, Math.min(total - 1, leftBoundary));
    this.history.left = Math.min(total - 1, left + 1);
    this.history.width = Math.max(
      1,
      Math.min(center, total - Number(this.history.left)),
    );
    this.historyContentWidth = Math.max(1, Number(this.history.width) - 2);
    this.historyText.width = this.historyContentWidth;
    this.historyText.height = Math.max(1, height - 2);
    const rightBoundary = left + center + 1;
    this.rightDivider.left = Math.max(
      0,
      Math.min(total - 1, rightBoundary - 1),
    );
    this.rightDividerBar.left = Math.max(0, Math.min(total - 1, rightBoundary));
    this.details.left = Math.min(total - 1, left + center + 2);
    this.details.width = Math.max(
      1,
      Math.min(right, total - Number(this.details.left)),
    );
    this.details.visible =
      !this.detailsCollapsed && Number(this.details.left) < total - 1;
    const infoHeight = 4;
    // Leave room for the box borders, text inset, scrollbar, and percentage
    // width rounding used by OpenTUI's nested renderables.
    const textWidth = Math.max(10, Number(this.details.width) - 8);
    const headerLines = this.wrappedLineCount(
      this.commitHeaderValue,
      textWidth,
    );
    const bodyLines = this.wrappedLineCount(this.commitBodyValue, textWidth);
    const messageHeight = headerLines + Math.min(15, bodyLines) + 3;
    this.commitHeader.height = headerLines;
    this.commitHeader.top = 1;
    this.commitBody.height = bodyLines;
    this.commitBody.top = headerLines + 2;
    this.commitInfoBox.top = 1;
    this.commitInfoBox.height = infoHeight;
    this.commitBodyBox.top = 2 + infoHeight;
    this.commitBodyBox.height = messageHeight;
    this.commitFilesTop = Math.min(
      Math.max(1, height - 1),
      3 + infoHeight + messageHeight,
    );
    this.leftDividerBar.fg = this.leftCollapsed
      ? activeDividerColor
      : dividerColor;
    this.rightDividerBar.fg = this.detailsCollapsed
      ? activeDividerColor
      : dividerColor;
    const dividerContent = Array.from({ length: height }, () => "▌").join("\n");
    this.leftDividerBar.content = dividerContent;
    this.rightDividerBar.content = dividerContent;
    if (this.snapshot) {
      this.paint();
    }
  }
  private files(): ChangedFile[] {
    return this.view === "commit"
      ? this.commitFiles
      : (this.snapshot?.files ?? []).filter((f) =>
          this.mode === "staged" ? f.staged : f.unstaged,
        );
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
    this.setStatus(message ?? "Refreshing…");
    try {
      const snapshot = await this.repository.snapshot(1000);
      if (request !== this.snapshotRequest) return;
      // A request that arrived while this one was in flight gets the only paint.
      if (this.refreshPending) return;
      this.snapshot = snapshot;
      this.graphRows = layoutGraph(this.snapshot.commits, oneDarkTheme.graph);
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
      this.setStatus(
        `${this.snapshot.branch ?? "detached"}  ↑${this.snapshot.ahead} ↓${this.snapshot.behind}  ·  ${this.snapshot.files.length} changed`,
      );
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : String(error));
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
    const localBranches = s.branches.filter((b) => !b.remote);
    const remoteBranches = s.branches.filter((b) => b.remote);
    const branchLimit = 10;
    this.localBranchStart = Math.max(
      0,
      Math.min(this.localBranchStart, localBranches.length - branchLimit),
    );
    this.remoteBranchStart = Math.max(
      0,
      Math.min(this.remoteBranchStart, remoteBranches.length - branchLimit),
    );
    const local =
      localBranches
        .slice(this.localBranchStart, this.localBranchStart + branchLimit)
        .map(
          (b) =>
            `${branchPresenceIcon(branchPresence(b, s.branches), b.current)} ${LAPTOP_BRANCH_ICON} ${displayBranchName(b.name)}`,
        )
        .join("\n") || "  (none)";
    const remote =
      remoteBranches
        .slice(this.remoteBranchStart, this.remoteBranchStart + branchLimit)
        .map(
          (b) =>
            `${branchPresenceIcon(branchPresence(b, s.branches), b.current)} ${REMOTE_BRANCH_ICON} ${displayBranchName(b.name)}`,
        )
        .join("\n") || "  (none)";
    const localSection = this.localBranchesCollapsed ? "" : `\n${local}`;
    const localRange =
      localBranches.length > branchLimit
        ? ` ${this.localBranchStart + 1}-${Math.min(this.localBranchStart + branchLimit, localBranches.length)}/${localBranches.length}`
        : "";
    const remoteRange =
      remoteBranches.length > branchLimit
        ? ` ${this.remoteBranchStart + 1}-${Math.min(this.remoteBranchStart + branchLimit, remoteBranches.length)}/${remoteBranches.length}`
        : "";
    const remoteSection = this.remoteBranchesCollapsed ? "" : `\n${remote}`;
    const sectionWidth = Math.max(8, Number(this.sidebar.width) - 3);
    const fillSection = (value: string) =>
      value
        .split("\n")
        .map((line) => ` ${line}`.slice(0, sectionWidth).padEnd(sectionWidth))
        .join("\n");
    const localBlock = fillSection(
      `${this.localBranchesCollapsed ? "▶" : "▼"} LOCAL BRANCHES${localRange}${localSection}`,
    );
    const remoteBlock = fillSection(
      `${this.remoteBranchesCollapsed ? "▶" : "▼"} REMOTES${remoteRange}${remoteSection}`,
    );
    const repositoryTail = `\n\n SUBMODULES  ${s.submodules.length}\n${s.submodules.map((x) => ` ${x.state === "clean" ? "✓" : "!"} ${x.path}`).join("\n") || "  (none)"}\n\n STASHES  ${s.stashes.length}\n${
      s.stashes
        .slice(0, 6)
        .map((x) => ` ◇ ${x.ref} ${x.subject}`)
        .join("\n") || "  (none)"
    }\n\n WORKTREES  ${s.worktrees.length}\n${s.worktrees.map((x) => ` ⎇ ${x.path.split("/").at(-1)}`).join("\n")}`;
    this.sidebarText.content = new StyledText([
      fg(oneDarkTheme.text)(
        ` TUIG\n ${displayBranchName(s.branch ?? "detached HEAD")}\n\n`,
      ),
      bg(oneDarkTheme.panelRaised)(fg(oneDarkTheme.text)(localBlock)),
      fg(oneDarkTheme.text)("\n\n"),
      bg(oneDarkTheme.panelRaised)(fg(oneDarkTheme.text)(remoteBlock)),
      fg(oneDarkTheme.text)(repositoryTail),
    ]);
    this.paintHistory();
    this.paintFiles();
  }
  private paintHistory() {
    const s = this.snapshot;
    if (!s) return;
    const hasWorking = s.files.length > 0;
    // `visible` counts selectable rows (not the heading), everywhere below.
    const visible = Math.max(1, this.renderer.terminalHeight - 3);
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
      fg(oneDarkTheme.muted)(
        ` BRANCH / TAG          GRAPH  ${s.commits.length} COMMITS\n`,
      ),
    ];
    this.historyShaHits.clear();
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
        chunks.push(
          bg(rowBg)(
            fg(oneDarkTheme.warning)(
              selected ? "▸ ● Working changes" : "  ● Working changes",
            ),
          ),
          bg(rowBg)(
            fg(oneDarkTheme.muted)(
              `  ${s.files.length} files`.padEnd(
                Math.max(1, this.historyContentWidth - 21),
              ),
            ),
          ),
          fg(
            scrollbarThumb(offset) ? oneDarkTheme.accent : oneDarkTheme.border,
          )(`${scrollbar(offset)}\n`),
        );
        continue;
      }
      const commitRow = displayIndex - (hasWorking ? 1 : 0);
      const row = this.graphRows[commitRow]!;
      const selected =
        this.historySelection === "commit" && commitRow === this.commitIndex;
      const labels = row.commit.decorations
        .filter((label) => !label.startsWith("tag: "))
        .map((label) => formatBranchDecoration(label, s.branches));
      if (selected && labels.length === 0) {
        const hint = this.branchHints.get(row.commit.sha);
        if (hint) labels.push(hint);
      }
      const label = this.fitColumns(labels[0] ?? "", labelWidth - 2, true);
      const labelText = label
        ? this.fitColumns(` ${label} `, labelWidth)
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
      const subject = this.fitColumns(row.commit.subject, subjectWidth, true);
      const cellPadding = Math.max(0, graphColumns - row.cells.length);
      const author = this.fitColumns(row.commit.author, authorWidth, true);
      chunks.push(
        bg(rowBg)(fg(label ? graphColor : oneDarkTheme.muted)(labelText)),
        bg(rowBg)(fg(oneDarkTheme.muted)(selected ? "▸ " : "  ")),
        ...row.cells.map((cell) => bg(rowBg)(fg(cell.color)(cell.symbol))),
        bg(rowBg)(fg(oneDarkTheme.muted)("  ".repeat(cellPadding))),
        bg(rowBg)(fg(oneDarkTheme.text)(subject)),
        bg(rowBg)(fg(oneDarkTheme.border)(" │ ")),
        bg(rowBg)(fg("#C678DD")(author)),
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
    }
    this.historyText.content = new StyledText(chunks);
  }
  private paintFiles() {
    const files = this.files();
    this.details.title =
      this.view === "commit"
        ? ` COMMIT FILES ${files.length} `
        : ` ${this.mode.toUpperCase()} ${files.length} `;
    this.filesText.top = this.view === "commit" ? this.commitFilesTop : 1;
    const limit = this.fileViewportSize();
    this.filesText.height = limit;
    const tree = buildFileTree(files);
    if (this.expandedFiles.size === 0)
      for (const node of tree.children)
        if (node.kind === "directory") this.expandedFiles.add(node.path);
    const allRows = flattenVisible(tree, this.expandedFiles);
    this.ensureFileVisible(allRows);
    const rows = allRows.slice(this.fileStart, this.fileStart + limit);
    if (rows.length === 0) {
      this.filesText.content =
        this.view === "commit" ? "  No changed files" : "  Working tree clean";
      return;
    }
    const selectedPath = this.selectedFile()?.path;
    const chunks = [];
    for (const { node, depth } of rows) {
      const selected = node.kind === "file" && node.path === selectedPath;
      const statusIcon = this.fileIcon(node);
      const statusColor = this.fileColor(node);
      const materialIcon = resolveMaterialIcon(
        node.name,
        node.kind === "directory",
        node.kind === "directory" && this.expandedFiles.has(node.path),
      );
      const nameColor =
        node.kind === "directory" ? oneDarkTheme.folder : oneDarkTheme.text;
      const available = Math.max(6, this.details.width - depth * 2 - 11);
      const label = fitTreeLabel(node.name, available);
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
          ? bg(oneDarkTheme.selected)(fg(nameColor)(label))
          : fg(nameColor)(label),
        fg(oneDarkTheme.muted)("\n"),
      );
    }
    this.filesText.content = new StyledText(chunks);
  }

  private fileViewportSize() {
    return this.view === "commit"
      ? Math.max(1, this.renderer.terminalHeight - this.commitFilesTop - 2)
      : Math.max(1, Math.min(7, this.renderer.terminalHeight - 3));
  }

  private ensureFileVisible(
    rows = flattenVisible(buildFileTree(this.files()), this.expandedFiles),
  ) {
    const path = this.selectedFile()?.path;
    const selectedRow = path
      ? rows.findIndex(({ node }) => node.path === path)
      : -1;
    const limit = this.fileViewportSize();
    const maxStart = Math.max(0, rows.length - limit);
    if (selectedRow >= 0) {
      if (selectedRow < this.fileStart) this.fileStart = selectedRow;
      else if (selectedRow >= this.fileStart + limit)
        this.fileStart = selectedRow - limit + 1;
    }
    this.fileStart = Math.max(0, Math.min(maxStart, this.fileStart));
  }

  private fileIcon(node: FileTreeNode) {
    if (node.kind === "directory") return "";
    return {
      modified: "●",
      added: "✚",
      untracked: "✚",
      deleted: "✖",
      renamed: "➜",
      copied: "⧉",
      conflicted: "⚠",
    }[node.state];
  }

  private fileColor(node: FileTreeNode) {
    const state = node.kind === "directory" ? node.status : node.state;
    if (state === "deleted" || state === "conflicted")
      return oneDarkTheme.deleted;
    if (state === "added" || state === "untracked") return oneDarkTheme.added;
    if (state === "renamed" || state === "copied") return oneDarkTheme.accent;
    return oneDarkTheme.warning;
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
  private setStatus(text: string) {
    this.status.content = text.slice(
      0,
      Math.max(20, this.renderer.terminalWidth - 3),
    );
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
    const visible = Math.max(1, this.renderer.terminalHeight - 3);
    this.historyViewportDetached = true;
    this.historyStart = Math.max(
      0,
      Math.min(Math.max(0, total - visible), this.historyStart + delta),
    );
    this.paintHistory();
  }
  private historyClick(x: number, y: number, button: number) {
    if (this.commitDiff.visible) return;
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
    if (row >= 0 && row < (this.snapshot?.commits.length ?? 0)) {
      this.commitIndex = row;
      this.historySelection = "commit";
      this.paintHistory();
      const hit = this.historyShaHits.get(row);
      if (
        button !== MouseButton.RIGHT &&
        hit &&
        x >= hit.start &&
        x < hit.end
      ) {
        const sha = shortSha(this.snapshot!.commits[row]!.sha);
        if (this.renderer.copyToClipboardOSC52(sha))
          this.setStatus(`Copied ${sha}`);
      } else if (button !== MouseButton.RIGHT) void this.openCommit();
    }
    if (button === MouseButton.RIGHT) {
      const sha = this.snapshot?.commits[this.commitIndex]?.sha;
      const value = sha ? shortSha(sha) : undefined;
      if (value && this.renderer.copyToClipboardOSC52(value))
        this.setStatus(`Copied ${value}`);
    }
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
    this.diff.visible = false;
    this.composer.visible = false;
    this.showCommitMeta(commit);
    this.status.content =
      "Commit selected  ·  click a changed file to open its diff";
    this.commitFiles = [];
    this.filesText.content = "  Loading changed files…";
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
      this.filesText.content = `  Failed to load changed files\n  ${message}`;
      this.setStatus(message);
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
    this.diff.visible = false;
    this.diffEmpty.visible = false;
    this.setCommitMetaVisible(false);
    this.status.content =
      "Esc back to graph  ·  click another file to view its diff";
    try {
      await this.loadDiff();
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : String(error));
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
    this.diff.visible = true;
    this.composer.visible = true;
    this.paint();
  }
  private showCommitMeta(commit: Commit) {
    const date = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "medium",
    }).format(new Date(commit.authoredAt));
    this.commitInfo.content = new StyledText([
      fg(oneDarkTheme.accent)(shortSha(commit.sha)),
      fg(oneDarkTheme.muted)(`  ${commit.author}  ${date}`),
    ]);
    this.commitHeaderValue = commit.subject;
    this.commitHeader.content = this.commitHeaderValue;
    const body = commit.body || "(no body)";
    this.commitBodyValue = body;
    this.commitBody.content = body;
    const bodyWidth = Math.max(10, Number(this.details.width) - 8);
    this.commitBody.height = this.wrappedLineCount(body, bodyWidth);
    this.commitBodyBox.scrollTo(0);
    this.setCommitMetaVisible(true);
    this.layout();
  }
  private wrappedLineCount(value: string, width: number) {
    return Math.max(
      1,
      value
        .split("\n")
        .reduce(
          (lines, line) => lines + Math.max(1, Math.ceil(line.length / width)),
          0,
        ),
    );
  }
  private fitColumns(value: string, width: number, ellipsis = false) {
    if (width <= 0) return "";
    if (Bun.stringWidth(value) <= width)
      return value + " ".repeat(width - Bun.stringWidth(value));
    const suffix = ellipsis && width > 1 ? "…" : "";
    const target = width - Bun.stringWidth(suffix);
    let result = "";
    for (const character of value) {
      if (Bun.stringWidth(result + character) > target) break;
      result += character;
    }
    result += suffix;
    return result + " ".repeat(Math.max(0, width - Bun.stringWidth(result)));
  }
  private setCommitMetaVisible(visible: boolean) {
    this.commitInfoBox.visible = visible;
    this.commitHeaderBox.visible = false;
    this.commitBodyBox.visible = visible;
  }
  private sidebarClick(y: number, button: number) {
    if (button !== MouseButton.RIGHT && (y === 3 || y === 4)) {
      this.localBranchesCollapsed = !this.localBranchesCollapsed;
      this.paint();
      return;
    }
    const localCount =
      this.snapshot?.branches.filter((branch) => !branch.remote).length ?? 0;
    const renderedLocal = this.localBranchesCollapsed
      ? 0
      : Math.min(10, localCount);
    const remoteHeaderY = 6 + renderedLocal;
    if (
      button !== MouseButton.RIGHT &&
      (y === remoteHeaderY || y === remoteHeaderY + 1)
    ) {
      this.remoteBranchesCollapsed = !this.remoteBranchesCollapsed;
      this.paint();
      return;
    }
    if (button === MouseButton.RIGHT) {
      const branch = this.snapshot?.branch;
      if (branch && this.renderer.copyToClipboardOSC52(branch))
        this.setStatus(`Copied ${branch}`);
    }
  }
  private sidebarScroll(y: number, delta: number) {
    const branches = this.snapshot?.branches;
    if (!branches) return;
    const localCount = branches.filter((branch) => !branch.remote).length;
    const remoteCount = branches.length - localCount;
    const renderedLocal = this.localBranchesCollapsed
      ? 0
      : Math.min(10, localCount);
    const remoteHeaderY = 6 + renderedLocal;
    if (y < remoteHeaderY && !this.localBranchesCollapsed) {
      this.localBranchStart = Math.max(
        0,
        Math.min(localCount - 10, this.localBranchStart + delta),
      );
    } else if (!this.remoteBranchesCollapsed) {
      this.remoteBranchStart = Math.max(
        0,
        Math.min(remoteCount - 10, this.remoteBranchStart + delta),
      );
    }
    this.paint();
  }

  private async key(key: KeyEvent) {
    if (
      this.renderer.currentFocusedEditor === this.composer &&
      key.name !== "escape"
    )
      return;
    if (key.name === "escape") {
      if (this.renderer.currentFocusedEditor === this.composer)
        this.composer.blur();
      else if (this.view !== "history") this.closeDiff();
      return;
    }
    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      if (this.refreshTimer) clearInterval(this.refreshTimer);
      if (this.scrollTimer) clearTimeout(this.scrollTimer);
      return this.renderer.destroy();
    }
    if (key.name === "up" || key.name === "k") return this.moveCommit(-1);
    if (key.name === "down" || key.name === "j") return this.moveCommit(1);
    if (key.name === "enter" && this.view === "history")
      return void this.openCommit();
    if (key.name === "tab") {
      this.mode = this.mode === "staged" ? "unstaged" : "staged";
      this.fileIndex = 0;
      this.paint();
      return void this.loadDiff().catch((e) => this.setStatus(String(e)));
    }
    if (key.name === "[") {
      this.leftCollapsed = !this.leftCollapsed;
      return this.layout();
    }
    if (key.name === "]") {
      this.detailsCollapsed = !this.detailsCollapsed;
      return this.layout();
    }
    if (key.name === "left") {
      this.fileIndex = Math.max(0, this.fileIndex - 1);
      this.ensureFileVisible();
      this.paintFiles();
      if (this.view !== "history")
        return void this.loadDiff().catch((e) => this.setStatus(String(e)));
      return;
    }
    if (key.name === "right") {
      this.fileIndex = Math.min(
        Math.max(0, this.files().length - 1),
        this.fileIndex + 1,
      );
      this.ensureFileVisible();
      this.paintFiles();
      if (this.view !== "history")
        return void this.loadDiff().catch((e) => this.setStatus(String(e)));
      return;
    }
    if (key.name === "r") return void this.refresh();
    if (key.name === "f")
      return void this.perform("Fetching…", () => this.repository.fetch());
    if (key.name === "l")
      return void this.perform("Pulling…", () => this.repository.pull());
    if (key.name === "p")
      return void this.perform("Pushing…", () => this.repository.push());
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
    if (key.name === "c") this.composer.focus();
  }
  private async perform(label: string, action: () => Promise<void>) {
    this.setStatus(label);
    try {
      await action();
      await this.refresh();
    } catch (e) {
      this.setStatus(e instanceof Error ? e.message : String(e));
    }
  }
  private async commit() {
    const message = this.composer.value.trim();
    if (!message) return this.setStatus("Commit message cannot be empty");
    this.composer.blur();
    await this.perform("Committing…", () => this.repository.commit(message));
    this.composer.value = "";
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
      if (!hunk) return this.setStatus("No applicable hunk");
      await this.repository.applyPatch(hunk.patch, this.mode === "staged");
      await this.refresh("Applied hunk");
    } catch (e) {
      this.setStatus(e instanceof Error ? e.message : String(e));
    }
  }
}
