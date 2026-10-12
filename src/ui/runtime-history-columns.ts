// History header interaction: column dividers, the columns menu, and row hover.
import { MouseButton } from "@opentui/core";
import type { GraphMenuItem } from "./graph-menu.js";
import {
  historyColumnLayout,
  historyDividerAt,
  isDividerDoubleClick,
  visibleHistoryColumns,
  type HistoryColumns,
  type HistoryDividerKey,
} from "./history-columns.js";

export interface RuntimeHistoryColumnsContext {
  /** Shown column set and saved widths. The runtime persists them. */
  historyColumns: HistoryColumns;
  historyContentWidth: number;
  historyContentLeft: number;
  /** True when pull request data exists, so the PR column can be drawn. */
  pullRequestColumnAvailable?: boolean;
  /** Graph lane count, which sets the graph column width. */
  graphColumns: number;
  commitDiffVisible: boolean;
  snapshot?: unknown;
  paneTop: number;
  doubleClickMs: number;
  paintHistory(): void;
  persistLayoutPreferences(): void;
  openPopup(
    title: string,
    items: GraphMenuItem[],
    x: number,
    y: number,
    select: (item: GraphMenuItem) => void,
  ): void;
}

/** Owns divider drag and hover state for the history header and row hover. */
export class RuntimeHistoryColumnsController {
  /** History body line under the pointer, or undefined when none. */
  hoveredLine?: number;
  private dividerHover?: HistoryDividerKey;
  private lastDividerPress?: { key: HistoryDividerKey; at: number };
  private drag?: { key: HistoryDividerKey; x: number; width: number };

  constructor(private readonly context: RuntimeHistoryColumnsContext) {}

  /** The header separator under the pointer or being dragged. */
  get divider() {
    return this.drag
      ? { key: this.drag.key, dragging: true }
      : this.dividerHover
        ? { key: this.dividerHover, dragging: false }
        : undefined;
  }

  private layout() {
    const ctx = this.context;
    return historyColumnLayout(
      ctx.historyContentWidth,
      ctx.graphColumns,
      visibleHistoryColumns(
        ctx.historyColumns,
        ctx.pullRequestColumnAvailable ?? false,
      ),
    );
  }

  /**
   * Handle a click on the header line. Returns false when the click is not on
   * the header, so the caller can treat it as a commit row click.
   */
  click(x: number, y: number, button: number): boolean {
    const ctx = this.context;
    this.drag = undefined;
    if (y !== 0 || ctx.commitDiffVisible) return false;
    if (button === MouseButton.RIGHT) {
      const committer = {
        label: `${ctx.historyColumns.showCommitter ? "[x]" : "[ ]"} Committer`,
      };
      const sha = {
        label: `${ctx.historyColumns.showSha ? "[x]" : "[ ]"} SHA`,
      };
      const pr = {
        label: `${(ctx.historyColumns.showPr ?? true) ? "[x]" : "[ ]"} PR`,
      };
      ctx.openPopup(
        "History columns",
        // The PR toggle appears only when there is pull request data to show.
        ctx.pullRequestColumnAvailable
          ? [committer, pr, sha]
          : [committer, sha],
        x,
        y + ctx.paneTop,
        (item) => {
          const columns = ctx.historyColumns;
          if (item === committer)
            columns.showCommitter = !columns.showCommitter;
          if (item === sha) columns.showSha = !columns.showSha;
          if (item === pr) columns.showPr = !(columns.showPr ?? true);
          ctx.persistLayoutPreferences();
          ctx.paintHistory();
        },
      );
    } else if (button === MouseButton.LEFT) {
      const layout = this.layout();
      const key = historyDividerAt(x - ctx.historyContentLeft, layout);
      const now = Date.now();
      if (
        key &&
        isDividerDoubleClick(this.lastDividerPress, key, now, ctx.doubleClickMs)
      ) {
        // Double-click restores the column's default width.
        this.lastDividerPress = undefined;
        delete ctx.historyColumns[key];
        ctx.persistLayoutPreferences();
        ctx.paintHistory();
      } else if (key) {
        this.lastDividerPress = { key, at: now };
        this.drag = { key, x, width: layout[key] };
        ctx.paintHistory();
      }
    }
    return true;
  }

  dragTo(x: number) {
    const drag = this.drag;
    if (!drag) return;
    const ctx = this.context;
    // The committer's left edge is its separator, so dragging right narrows it.
    const delta = drag.key === "committerWidth" ? drag.x - x : x - drag.x;
    ctx.historyColumns[drag.key] = Math.max(4, drag.width + delta);
    ctx.historyColumns[drag.key] = this.layout()[drag.key];
    ctx.paintHistory();
  }

  dragEnd() {
    if (this.drag) this.context.persistLayoutPreferences();
    this.drag = undefined;
    this.setDividerHover(undefined);
  }

  /** Track the pointer over the header dividers and the history rows. */
  hover(x: number, y: number) {
    const ctx = this.context;
    const line = y - ctx.paneTop;
    this.setDividerHover(
      line === 0 && !ctx.commitDiffVisible
        ? historyDividerAt(x - ctx.historyContentLeft, this.layout())
        : undefined,
    );
    this.setHoveredLine(
      !ctx.commitDiffVisible && line >= 1 ? line - 1 : undefined,
    );
  }

  hoverEnd() {
    this.setDividerHover(undefined);
    this.setHoveredLine(undefined);
  }

  private setHoveredLine(line: number | undefined) {
    if (this.hoveredLine === line) return;
    this.hoveredLine = line;
    if (this.context.snapshot) this.context.paintHistory();
  }

  private setDividerHover(key: HistoryDividerKey | undefined) {
    if (this.dividerHover === key) return;
    this.dividerHover = key;
    if (this.context.snapshot) this.context.paintHistory();
  }
}
