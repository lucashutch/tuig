// File and line history shown in the details pane, and line blame.
import {
  StyledText,
  bg,
  fg,
  type BoxRenderable,
  type TextRenderable,
} from "@opentui/core";
import type {
  ChangedFile,
  GitRepository,
  RepositorySnapshot,
} from "../git/types.js";
import type { DiffView } from "./diff-view.js";
import { authorAvatar, formatRelativeTime, shortSha } from "./history.js";
import { clipColumns } from "./runtime-presentation.js";
import type { ChangeSection } from "./runtime-widgets.js";
import { activeTheme as theme } from "./theme.js";

type Commit = RepositorySnapshot["commits"][number];

/** Terminal rows one commit card takes in the file history list. */
const FILE_HISTORY_CARD_ROWS = 4;
const fileHistoryDate = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export interface RuntimeFileHistoryContext {
  readonly repository: GitRepository;
  readonly snapshot?: RepositorySnapshot;
  commitFiles: ChangedFile[];
  fileIndex: number;
  fileStart: number;
  mode: ChangeSection;
  diffOrigin?: "working" | "commit";
  view: "history" | "commit" | "working";
  readonly detailsPaneWidth: number;
  readonly history: BoxRenderable;
  readonly commitDiff: DiffView;
  readonly commitDiffEmpty: TextRenderable;
  /** File history reuses the changed-file list widgets for its commit cards. */
  readonly unstagedLabel: TextRenderable;
  readonly unstagedText: TextRenderable;
  setFocus(focus: "history" | "changes"): void;
  layout(): void;
  paint(): void;
  loadDiff(): Promise<void>;
  closeDiff(): void;
  showCommitMeta(commit: Commit): void;
  notify(text: string, tone?: "info" | "error" | "busy"): void;
  fail(error: unknown): void;
}

/** Owns the open file or line history and the request guard that loads it. */
export class RuntimeFileHistoryController {
  private filter?: {
    path: string;
    file: ChangedFile;
    commits: Commit[];
    index: number;
    line?: number;
  };
  private request = 0;

  constructor(private readonly context: RuntimeFileHistoryContext) {}

  get active() {
    return this.filter !== undefined;
  }

  /** The commit selected in the open history, if one is open. */
  get selectedCommit() {
    return this.filter?.commits[this.filter.index];
  }

  async showFile(file: ChangedFile, start?: string) {
    const ctx = this.context;
    const path = file.path;
    try {
      const request = ++this.request;
      const repository = ctx.repository;
      const snapshot = ctx.snapshot;
      ctx.notify(`Loading history for ${path}…`, "busy");
      const commits = await repository.fileHistory(path, start);
      if (
        request !== this.request ||
        repository !== ctx.repository ||
        snapshot !== ctx.snapshot
      )
        return;
      this.install(file, commits);
    } catch (error) {
      ctx.fail(error);
    }
  }

  async showLine(file: ChangedFile, line: number, commit?: string) {
    const ctx = this.context;
    const path = file.path;
    try {
      const request = ++this.request;
      const repository = ctx.repository;
      const snapshot = ctx.snapshot;
      ctx.notify(`Loading history for ${path}:${line}…`, "busy");
      const commits = await repository.lineHistory(path, line, commit);
      if (
        request !== this.request ||
        repository !== ctx.repository ||
        snapshot !== ctx.snapshot
      )
        return;
      this.install(file, commits, line);
    } catch (error) {
      ctx.fail(error);
    }
  }

  async showBlame(path: string, line: number, commit?: string) {
    const ctx = this.context;
    try {
      const blame = await ctx.repository.blameLine(path, line, commit);
      ctx.notify(
        `${shortSha(blame.commit.sha)} · ${blame.commit.author} · ${blame.commit.subject}`,
      );
    } catch (error) {
      ctx.fail(error);
    }
  }

  private install(file: ChangedFile, commits: Commit[], line?: number) {
    const ctx = this.context;
    if (!ctx.snapshot) return;
    this.filter = { path: file.path, file, commits, index: 0, line };
    ctx.commitFiles = [file];
    ctx.fileIndex = 0;
    ctx.fileStart = 0;
    ctx.mode = "unstaged";
    ctx.diffOrigin = "commit";
    ctx.view = "commit";
    ctx.setFocus("changes");
    ctx.commitDiff.visible = commits.length > 0;
    ctx.commitDiffEmpty.visible = commits.length === 0;
    ctx.history.title = undefined;
    this.showCommit();
    this.paint();
    ctx.layout();
    if (commits.length) void ctx.loadDiff().catch((error) => ctx.fail(error));
    ctx.paint();
    ctx.notify(commits.length ? "" : `No history found for ${file.path}`);
  }

  /** Close the history. Returns false when none was open. */
  clear() {
    this.request++;
    if (!this.filter) return false;
    this.filter = undefined;
    this.context.history.title = undefined;
    this.context.closeDiff();
    return true;
  }

  /** Move the selection by `delta` commits. Returns false when none is open. */
  scroll(delta: number) {
    const filter = this.filter;
    if (!filter) return false;
    const ctx = this.context;
    const max = Math.max(0, filter.commits.length - 1);
    filter.index = Math.max(0, Math.min(max, filter.index + delta));
    const viewport = this.viewport();
    if (filter.index < ctx.fileStart) ctx.fileStart = filter.index;
    else if (filter.index >= ctx.fileStart + viewport)
      ctx.fileStart = filter.index - viewport + 1;
    this.select();
    return true;
  }

  /** Select the commit card at terminal row `y`. Returns false when none is open. */
  click(y: number) {
    const filter = this.filter;
    if (!filter) return false;
    const ctx = this.context;
    const row =
      Math.floor((y - ctx.unstagedText.y) / FILE_HISTORY_CARD_ROWS) +
      ctx.fileStart;
    if (row < 0 || row >= filter.commits.length) return true;
    filter.index = row;
    this.select();
    return true;
  }

  private select() {
    this.paint();
    this.showCommit();
    void this.context.loadDiff().catch((error) => this.context.fail(error));
  }

  paint() {
    const filter = this.filter;
    if (!filter) return;
    const ctx = this.context;
    ctx.unstagedLabel.content = ` ${filter.line === undefined ? "File" : "Line"} history · Esc to close `;
    const width = Math.max(12, ctx.detailsPaneWidth - 3);
    ctx.unstagedText.content = new StyledText(
      filter.commits
        .slice(ctx.fileStart, ctx.fileStart + this.viewport())
        .flatMap((commit, offset) => {
          const index = ctx.fileStart + offset;
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
          const background = selected ? theme.selected : theme.panel;
          return [
            bg(background)(
              fg(theme.text)(`${marker} ${subject}`.padEnd(width) + "\n"),
            ),
            bg(background)(
              fg(selected ? theme.accent : theme.author)(
                `  ${identity}`.padEnd(width) + "\n",
              ),
            ),
            bg(background)(
              fg(theme.muted)(`  ${metadata}`.padEnd(width) + "\n"),
            ),
            bg(theme.panel)(" ".repeat(width) + "\n"),
          ];
        }),
    );
  }

  /** Commit cards the list can show at once. */
  private viewport() {
    return Math.max(
      1,
      Math.floor(
        Number(this.context.unstagedText.height) / FILE_HISTORY_CARD_ROWS,
      ),
    );
  }

  private showCommit() {
    const commit = this.selectedCommit;
    if (commit) this.context.showCommitMeta(commit);
  }
}
