// Repository tab strip and repository picker runtime glue: painting, drag, open, switch, and close.
import {
  MouseButton,
  StyledText,
  bg,
  fg,
  type BoxRenderable,
  type CliRenderer,
  type InputRenderable,
  type KeyEvent,
  type TextRenderable,
  type TextareaRenderable,
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
  GitRepository,
  RepositorySnapshot,
  Submodule,
  Worktree,
} from "../git/types.js";
import type { ChangedFile } from "../git/types.js";
import type { createAutoRefresh } from "./auto-refresh.js";
import type { DiffView } from "./diff-view.js";
import { resolveHeadSha } from "./history.js";
import {
  dragRepositoryTab,
  layoutRepositoryTabs,
  repositoryTabHit,
  repositoryTabText,
  submoduleTabLabel,
  worktreeTabLabel,
  type RepositoryTabsLayout,
} from "./repository-tabs.js";
import {
  HISTORY_PAGE,
  cancelDiff as cancelRuntimeDiff,
  cancelGraphAvatars as cancelRuntimeGraphAvatars,
  loadMoreCommits as loadMoreRuntimeCommits,
  type RuntimeDataContext,
} from "./runtime-data.js";
import { historyStartForCommit } from "./runtime-history.js";
import { dialogColor } from "./runtime-theme.js";
import {
  promoteRecentRepository,
  removeRecentRepository,
} from "./session-preferences.js";
import {
  activeTheme as oneDarkTheme,
  interactionBackground,
  semanticColor,
} from "./theme.js";

export interface RuntimeTab {
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
}

/**
 * Runtime state and callbacks the tab controller needs. The tab switch resets
 * history, composer, and diff state, so the context exposes those fields.
 */
export interface RuntimeTabsContext extends RuntimeDataContext {
  renderer: Pick<
    CliRenderer,
    "terminalWidth" | "terminalHeight" | "setTerminalTitle"
  >;
  repository: GitRepository;
  tabs: RuntimeTab[];
  activeTabId: string;
  nextTabId: number;
  recentRepositories: string[];
  mutationBusy?: string;
  tabBar: TextRenderable;
  repositoryPickerBox: BoxRenderable;
  repositoryPathInput: InputRenderable;
  repositoryPickerText: TextRenderable;
  branchFilterInput: InputRenderable;
  composerSummary: InputRenderable;
  composerBody: TextareaRenderable;
  namePrompt?: unknown;
  branchFilterActive: boolean;
  branchFilter: string;
  amend: boolean;
  amendDraft?: { summary: string; body: string };
  editingCommitSha?: string;
  editReturnState?: unknown;
  avatarAbort?: AbortController;
  snapshotRequest: number;
  commitFilesRequest: number;
  snapshot?: RepositorySnapshot;
  snapshotSignature?: string;
  historyLimit: number;
  commitIndex: number;
  historySelection: "working" | "commit";
  fileIndex: number;
  fileStart: number;
  historyStart: number;
  historyViewportDetached: boolean;
  view: "history" | "commit" | "working";
  commitFiles: ChangedFile[];
  commitDiff: DiffView;
  commitDiffEmpty: TextRenderable;
  commitInfoBox: BoxRenderable;
  commitBodyBox: BoxRenderable;
  readonly contentHeight: number;
  autoRefresh: ReturnType<typeof createAutoRefresh>;
  autoRefreshStarted: boolean;
  paintViewToggles(): void;
  closePopup(): void;
  notify(text: string, tone?: "info" | "error" | "busy"): void;
  persistSessionPreferences(): void;
  refresh(message?: string, automatic?: boolean): Promise<void>;
  paint(): void;
  paintHistory(): void;
  layout(): void;
  shutdown(): Promise<void>;
}

/** Owns the tab strip layout, tab drag, and repository picker state. */
export class RuntimeTabsController {
  private tabLayout: RepositoryTabsLayout = layoutRepositoryTabs(
    [],
    undefined,
    0,
  );
  private draggedTabId?: string;
  private hoveredTab?: string;
  private repositorySuggestions: DirectorySuggestion[] = [];
  private repositorySuggestionIndex = 0;
  private repositorySuggestionRows = 5;
  private repositoryPickerRequest = 0;

  constructor(private readonly context: RuntimeTabsContext) {}

  /** Track the hovered tab or the open button, and repaint when it changes. */
  hover(x: number | undefined) {
    const hit =
      x === undefined ? undefined : repositoryTabHit(this.tabLayout, x);
    const next = hit?.action === "open" ? "open" : hit?.tabId;
    if (next === this.hoveredTab) return;
    this.hoveredTab = next;
    this.paintTabs();
  }

  dragEnd() {
    this.draggedTabId = undefined;
  }

  /** Re-run when the repository input text changes. */
  inputChanged() {
    this.repositorySuggestionIndex = 0;
    void this.updateRepositorySuggestions();
  }

  /** Enter in the repository input opens the typed path or the selected recent entry. */
  submitRepositoryInput() {
    void this.openRepositoryPath(
      this.context.repositoryPathInput.value.trim()
        ? undefined
        : this.closedRecentRepositories[this.repositorySuggestionIndex],
    );
  }

  /** Tab strip entries, in the same order as `this.context.tabs`. */
  private tabStripEntries() {
    return this.context.tabs.map((tab) => ({
      id: tab.id,
      path: tab.repository.root,
      label: tab.submoduleOf
        ? submoduleTabLabel(tab.repository.root, tab.submoduleOf.root)
        : tab.repository.mainWorktree
          ? worktreeTabLabel(tab.repository.root, tab.repository.mainWorktree)
          : undefined,
    }));
  }

  paintTabs() {
    const width = Math.max(1, this.context.renderer.terminalWidth);
    this.tabLayout = layoutRepositoryTabs(
      this.tabStripEntries(),
      this.context.activeTabId,
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
      const hovered = this.hoveredTab === tab.id;
      const background = interactionBackground(
        oneDarkTheme,
        oneDarkTheme.panel,
        { selected: tab.active, hovered },
      );
      const label = repositoryTabText(tab);
      cells.push(
        bg(
          semanticColor(
            oneDarkTheme,
            "background.action.secondary",
            background,
            { states: { selected: tab.active, hovered } },
          ),
        )(
          fg(
            semanticColor(
              oneDarkTheme,
              "text.action.secondary",
              tab.active ? oneDarkTheme.accent : oneDarkTheme.muted,
              { states: { selected: tab.active } },
            ),
          )(label),
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
      bg(
        semanticColor(
          oneDarkTheme,
          "background.action.secondary",
          interactionBackground(oneDarkTheme, oneDarkTheme.panelRaised, {
            hovered: this.hoveredTab === "open",
          }),
          { states: { hovered: this.hoveredTab === "open" } },
        ),
      )(
        fg(
          semanticColor(
            oneDarkTheme,
            "text.action.secondary",
            oneDarkTheme.accent,
          ),
        )(openLabel),
      ),
    );
    cells.push(
      bg(oneDarkTheme.panelRaised)(
        " ".repeat(Math.max(0, width - this.tabLayout.open.end)),
      ),
    );
    this.context.paintViewToggles();
    this.context.tabBar.width = width;
    this.context.tabBar.content = new StyledText(cells);
  }

  handleTabMouseDown(x: number, button: number) {
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

  handleTabDrag(x: number) {
    const movedId = this.draggedTabId;
    if (!movedId) return;
    const order = dragRepositoryTab(
      this.tabStripEntries(),
      movedId,
      x,
      this.context.activeTabId,
      Math.max(1, this.context.renderer.terminalWidth),
    );
    if (!order) return;
    this.context.tabs = order.map(
      (entry) => this.context.tabs.find((tab) => tab.id === entry.id)!,
    );
    this.paintTabs();
    this.context.persistSessionPreferences();
  }

  activateRelativeRepositoryTab(delta: number) {
    const index = this.context.tabs.findIndex(
      (tab) => tab.id === this.context.activeTabId,
    );
    const next =
      (index + delta + this.context.tabs.length) % this.context.tabs.length;
    return this.activateRepositoryTab(this.context.tabs[next]!.id);
  }

  showRepositoryPicker() {
    this.context.closePopup();
    const width = Math.max(
      30,
      Math.min(70, this.context.renderer.terminalWidth - 4),
    );
    this.context.repositoryPickerBox.width = width;
    this.context.repositoryPickerBox.left = Math.max(
      0,
      Math.floor((this.context.renderer.terminalWidth - width) / 2),
    );
    this.context.repositoryPickerBox.top = Math.max(
      1,
      Math.min(4, this.context.renderer.terminalHeight - 10),
    );
    const pickerHeight = Math.max(
      6,
      Math.min(
        12,
        this.context.renderer.terminalHeight -
          Number(this.context.repositoryPickerBox.top) -
          1,
      ),
    );
    this.context.repositoryPickerBox.height = pickerHeight;
    this.context.repositoryPathInput.width = Math.max(8, width - 4);
    this.context.repositoryPickerText.width = Math.max(8, width - 4);
    this.repositorySuggestionRows = Math.max(1, pickerHeight - 5);
    this.context.repositoryPickerText.height = this.repositorySuggestionRows;
    this.context.repositoryPathInput.value = "";
    this.repositorySuggestionIndex = 0;
    this.context.repositoryPickerBox.visible = true;
    void this.updateRepositorySuggestions();
    setTimeout(() => this.context.repositoryPathInput.focus(), 0);
  }

  private closeRepositoryPicker() {
    this.repositoryPickerRequest++;
    this.context.repositoryPathInput.blur();
    this.context.repositoryPickerBox.visible = false;
  }

  private async updateRepositorySuggestions() {
    const request = ++this.repositoryPickerRequest;
    if (!this.context.repositoryPathInput.value.trim()) {
      this.repositorySuggestions = [];
      this.paintRepositorySuggestions();
      return;
    }
    const suggestions = await suggestDirectories(
      this.context.repositoryPathInput.value,
    );
    if (
      request !== this.repositoryPickerRequest ||
      !this.context.repositoryPickerBox.visible
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
    const recent = !this.context.repositoryPathInput.value.trim();
    const entries = recent
      ? this.closedRecentRepositories
      : this.repositorySuggestions;
    const count = Math.max(1, this.repositorySuggestionRows - (recent ? 1 : 0));
    const start = Math.max(
      0,
      Math.min(
        this.repositorySuggestionIndex - count + 1,
        entries.length - count,
      ),
    );
    const visible = entries.slice(start, start + count);
    const rows = visible.length
      ? visible.map((entry, index) => {
          const selected = start + index === this.repositorySuggestionIndex;
          const states = { selected, focused: selected };
          return bg(
            dialogColor(
              "background.action.primary",
              selected ? oneDarkTheme.selected : oneDarkTheme.panelRaised,
              states,
            ),
          )(
            fg(dialogColor("text.action.primary", oneDarkTheme.text, states))(
              `${selected ? ">" : " "} ${typeof entry === "string" ? entry : `${entry.name}/`}${index === visible.length - 1 ? "" : "\n"}`,
            ),
          );
        })
      : [
          fg(dialogColor("text.muted", oneDarkTheme.muted))(
            recent
              ? "  No recently closed repositories"
              : "  No matching folders",
          ),
        ];
    this.context.repositoryPickerText.content = new StyledText([
      ...(recent
        ? [
            fg(dialogColor("text.muted", oneDarkTheme.muted))(
              "Recently opened (closed tabs)\n",
            ),
          ]
        : []),
      ...rows,
    ]);
  }

  private get closedRecentRepositories(): string[] {
    const open = new Set(this.context.tabs.map((tab) => tab.repository.root));
    return this.context.recentRepositories.filter((path) => !open.has(path));
  }

  chooseRepositorySuggestion(row: number) {
    if (row < 0) return;
    const recent = !this.context.repositoryPathInput.value.trim();
    if (recent && row-- === 0) return;
    const entries = recent
      ? this.closedRecentRepositories
      : this.repositorySuggestions;
    const count = Math.max(1, this.repositorySuggestionRows - (recent ? 1 : 0));
    const start = Math.max(
      0,
      Math.min(
        this.repositorySuggestionIndex - count + 1,
        entries.length - count,
      ),
    );
    const suggestion = entries[start + row];
    if (!suggestion) return;
    if (typeof suggestion === "string") {
      void this.openRepositoryPath(suggestion);
      return;
    }
    this.context.repositoryPathInput.value = `${suggestion.path}/`;
    this.repositorySuggestionIndex = 0;
    void this.updateRepositorySuggestions();
    this.context.repositoryPathInput.focus();
  }

  private completeRepositorySuggestion() {
    if (!this.context.repositoryPathInput.value.trim()) {
      const recent =
        this.closedRecentRepositories[this.repositorySuggestionIndex];
      if (recent) {
        this.context.repositoryPathInput.value = recent;
        void this.updateRepositorySuggestions();
      }
      return;
    }
    const suggestion =
      this.repositorySuggestions[this.repositorySuggestionIndex];
    if (!suggestion) return;
    this.context.repositoryPathInput.value = `${suggestion.path}/`;
    this.repositorySuggestionIndex = 0;
    void this.updateRepositorySuggestions();
  }

  private async openRepositoryPath(selectedRecent?: string) {
    if (this.context.mutationBusy) {
      this.context.notify("Wait for the current Git operation to finish");
      return;
    }
    const typedPath =
      selectedRecent ??
      (this.context.repositoryPathInput.value.trim() || process.cwd());
    const path = resolveRepositoryPath(typedPath);
    try {
      const repository = await createGitRepository(path);
      const existing = this.context.tabs.find(
        (tab) => tab.repository.root === repository.root,
      );
      if (existing) {
        repository.dispose?.();
        this.closeRepositoryPicker();
        await this.activateRepositoryTab(existing.id, true);
        this.context.recentRepositories = promoteRecentRepository(
          this.context.recentRepositories,
          repository.root,
        );
        this.context.persistSessionPreferences();
        return;
      }
      const id = `repository-${this.context.nextTabId++}`;
      this.context.tabs.push({ id, repository });
      this.context.persistSessionPreferences();
      this.closeRepositoryPicker();
      await this.activateRepositoryTab(id, true);
      this.context.recentRepositories = promoteRecentRepository(
        this.context.recentRepositories,
        repository.root,
      );
      this.context.persistSessionPreferences();
    } catch (error) {
      this.context.notify(
        error instanceof NotGitRepositoryError
          ? `Not a Git repository: ${path}`
          : error instanceof Error
            ? error.message
            : String(error),
        "error",
      );
    }
  }

  async openSubmodule(submodule: Submodule) {
    const parentRoot = this.context.repository.root;
    const path = resolve(parentRoot, submodule.path);
    try {
      const repository = await createGitRepository(path);
      const existing = this.context.tabs.find(
        (tab) => tab.repository.root === repository.root,
      );
      if (existing) {
        repository.dispose?.();
        if (!existing.submoduleOf)
          existing.submoduleOf = { root: parentRoot, path: submodule.path };
        this.paintTabs();
        return this.activateRepositoryTab(existing.id, true);
      }
      const id = `repository-${this.context.nextTabId++}`;
      this.context.tabs.push({
        id,
        repository,
        submoduleOf: { root: parentRoot, path: submodule.path },
      });
      this.context.persistSessionPreferences();
      await this.activateRepositoryTab(id, true);
    } catch (error) {
      this.context.notify(
        submodule.state === "uninitialized"
          ? `Initialize ${submodule.path} before opening it`
          : error instanceof Error
            ? error.message
            : String(error),
        "error",
      );
    }
  }

  /**
   * Show a worktree in its own tab, reusing the tab when it is already open.
   * A worktree is a separate checkout, so this is how its branch is reached.
   */
  async openWorktree(worktree: Worktree) {
    try {
      const repository = await createGitRepository(worktree.path);
      const existing = this.context.tabs.find(
        (tab) => tab.repository.root === repository.root,
      );
      if (existing) {
        repository.dispose?.();
        return this.activateRepositoryTab(existing.id, true);
      }
      const id = `repository-${this.context.nextTabId++}`;
      this.context.tabs.push({ id, repository });
      this.context.persistSessionPreferences();
      await this.activateRepositoryTab(id, true);
    } catch (error) {
      this.context.notify(
        worktree.prunable
          ? `Worktree ${worktree.path} no longer exists`
          : error instanceof Error
            ? error.message
            : String(error),
        "error",
      );
    }
  }

  async activateRepositoryTab(
    id: string,
    focusCheckedOut = false,
  ): Promise<void> {
    const tab = this.context.tabs.find((candidate) => candidate.id === id);
    if (!tab) return;
    if (id === this.context.activeTabId)
      return focusCheckedOut ? this.focusCheckedOutCommit() : undefined;
    if (this.context.mutationBusy)
      return this.context.notify(
        "Wait for the current Git operation to finish",
      );
    this.saveActiveTabHistory();
    this.context.closePopup();
    this.closeRepositoryPicker();
    this.context.branchFilterInput.blur();
    this.context.composerSummary.blur();
    this.context.composerBody.blur();
    this.context.namePrompt = undefined;
    this.context.branchFilterActive = false;
    this.context.branchFilter = "";
    this.context.composerSummary.value = "";
    this.context.composerBody.setText("");
    this.context.amend = false;
    this.context.amendDraft = undefined;
    this.context.editingCommitSha = undefined;
    this.context.editReturnState = undefined;
    cancelRuntimeDiff(this.context);
    cancelRuntimeGraphAvatars(this.context);
    this.context.avatarAbort?.abort();
    this.context.snapshotRequest++;
    this.context.commitFilesRequest++;
    this.context.repository = tab.repository;
    this.context.activeTabId = id;
    if (this.context.autoRefreshStarted)
      void this.context.autoRefresh.follow(tab.repository);
    this.context.persistSessionPreferences();
    this.context.snapshot = undefined;
    this.context.snapshotSignature = undefined;
    this.context.historyLimit = tab.history?.limit ?? HISTORY_PAGE;
    this.context.commitIndex = 0;
    this.context.historySelection = "working";
    this.context.fileIndex = 0;
    this.context.fileStart = 0;
    this.context.historyStart = 0;
    this.context.view = "history";
    this.context.commitFiles = [];
    this.context.commitDiff.visible = false;
    this.context.commitDiffEmpty.visible = false;
    this.context.commitInfoBox.visible = false;
    this.context.commitBodyBox.visible = false;
    this.context.renderer.setTerminalTitle(
      `tuig · ${this.context.repository.root}`,
    );
    this.paintTabs();
    this.context.paint();
    await this.context.refresh();
    if (focusCheckedOut) await this.focusCheckedOutCommit();
    else this.restoreTabHistory(tab);
    this.context.layout();
  }

  private saveActiveTabHistory() {
    const tab = this.context.tabs.find(
      (candidate) => candidate.id === this.context.activeTabId,
    );
    if (!tab) return;
    tab.history = {
      start: this.context.historyStart,
      commitIndex: this.context.commitIndex,
      selectedSha:
        this.context.snapshot?.commits[this.context.commitIndex]?.sha,
      selection: this.context.historySelection,
      viewportDetached: this.context.historyViewportDetached,
      limit: this.context.historyLimit,
    };
  }

  private restoreTabHistory(tab: RuntimeTab) {
    const saved = tab.history;
    const snapshot = this.context.snapshot;
    if (!saved || !snapshot) return;
    const selectedIndex = saved.selectedSha
      ? snapshot.commits.findIndex((commit) => commit.sha === saved.selectedSha)
      : -1;
    this.context.commitIndex =
      selectedIndex >= 0
        ? selectedIndex
        : Math.min(saved.commitIndex, Math.max(0, snapshot.commits.length - 1));
    this.context.historySelection = saved.selection;
    this.context.historyViewportDetached = saved.viewportDetached;
    const totalRows =
      snapshot.commits.length + (snapshot.files.length > 0 ? 1 : 0);
    this.context.historyStart = Math.max(
      0,
      Math.min(saved.start, Math.max(0, totalRows - 1)),
    );
    this.context.paintHistory();
  }

  /**
   * A newly opened repository starts at its checked-out commit. History is
   * paged until that commit is found, but ordinary tab switches do not call
   * this method and therefore do not snap the reader back to HEAD.
   */
  async focusCheckedOutCommit() {
    let snapshot = this.context.snapshot;
    if (!snapshot) return;
    const headSha =
      snapshot.headSha ?? resolveHeadSha(snapshot.branches, snapshot.commits);
    if (!headSha) return;
    let index = snapshot.commits.findIndex((commit) => commit.sha === headSha);
    while (index < 0 && !snapshot.commitsComplete) {
      const count = snapshot.commits.length;
      await loadMoreRuntimeCommits(this.context);
      snapshot = this.context.snapshot ?? snapshot;
      if (snapshot.commits.length === count) break;
      index = snapshot.commits.findIndex((commit) => commit.sha === headSha);
    }
    if (index < 0) return;
    this.context.commitIndex = index;
    this.context.historySelection = "commit";
    this.context.historyViewportDetached = false;
    this.context.historyStart = historyStartForCommit(
      index,
      snapshot.files.length > 0,
      this.context.contentHeight,
      snapshot.commits.length,
    );
    this.context.paintHistory();
  }

  async closeRepositoryTab(id: string): Promise<void> {
    const index = this.context.tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    if (id === this.context.activeTabId && this.context.mutationBusy)
      return this.context.notify(
        "Wait for the current Git operation to finish",
      );
    if (this.context.tabs.length === 1) return this.context.shutdown();
    const wasActive = id === this.context.activeTabId;
    const [removed] = this.context.tabs.splice(index, 1);
    removed?.repository.dispose?.();
    if (wasActive) {
      const next =
        this.context.tabs[Math.min(index, this.context.tabs.length - 1)]!;
      await this.activateRepositoryTab(next.id);
    } else {
      this.paintTabs();
      this.context.persistSessionPreferences();
    }
  }

  repositoryPickerKey(key: KeyEvent) {
    if (key.name === "escape") return this.closeRepositoryPicker();
    if (key.name === "up" || key.name === "down") {
      const delta = key.name === "up" ? -1 : 1;
      const length = this.context.repositoryPathInput.value.trim()
        ? this.repositorySuggestions.length
        : this.closedRecentRepositories.length;
      this.repositorySuggestionIndex = Math.max(
        0,
        Math.min(length - 1, this.repositorySuggestionIndex + delta),
      );
      return this.paintRepositorySuggestions();
    }
    if (
      !this.context.repositoryPathInput.value.trim() &&
      (key.name === "delete" || key.name === "backspace")
    ) {
      const selected =
        this.closedRecentRepositories[this.repositorySuggestionIndex];
      if (selected) {
        this.context.recentRepositories = removeRecentRepository(
          this.context.recentRepositories,
          selected,
        );
        this.repositorySuggestionIndex = Math.min(
          this.repositorySuggestionIndex,
          Math.max(0, this.closedRecentRepositories.length - 1),
        );
        this.paintRepositorySuggestions();
        this.context.persistSessionPreferences();
      }
      return;
    }
    if (key.name === "tab") return this.completeRepositorySuggestion();
    return;
  }
}
