import {
  BoxRenderable,
  DiffRenderable,
  type DiffRenderableOptions,
  type RenderContext,
} from "@opentui/core";
import {
  diffLineTarget,
  renderedDiffLineTarget,
  splitDiffLineTarget,
  type DiffLineTarget,
} from "./diff-lines.js";
import { activeTheme as oneDarkTheme, semanticColor } from "./theme.js";
import { createDiffSyntaxStyle } from "./diff-syntax.js";

function diffColor(path: string, fallback: string): string {
  const value = path
    .split(".")
    .reduce<unknown>(
      (node, key) =>
        node && typeof node === "object"
          ? (node as Record<string, unknown>)[key]
          : undefined,
      oneDarkTheme.diff,
    );
  return semanticColor(
    oneDarkTheme,
    `diff.${path}`,
    typeof value === "string" ? value : fallback,
  );
}

export type DiffViewMode = "inline" | "side-by-side";
export const SPLIT_DIFF_MIN_WIDTH = 120;

export function effectiveDiffView(
  preference: DiffViewMode,
  width: number,
): "unified" | "split" {
  return preference === "side-by-side" && width >= SPLIT_DIFF_MIN_WIDTH
    ? "split"
    : "unified";
}

/**
 * Own the displayed diff as a disposable child. OpenTUI 0.5.7 retains its
 * native buffers and line maps when DiffRenderable.diff is set to an empty
 * string. Replacing the child also sets language and content together, so a
 * language switch never highlights the old document with the new parser.
 */
export class DiffView extends BoxRenderable {
  private document?: DiffRenderable;
  private readonly options: DiffRenderableOptions;
  private value = "";
  private currentFiletype?: string;
  private currentWrapMode: "word" | "none" = "word";
  private currentView: "unified" | "split";
  private selectedRows = new Set<number>();
  private ownedSyntaxStyle?: ReturnType<typeof createDiffSyntaxStyle>;

  constructor(ctx: RenderContext, options: DiffRenderableOptions) {
    super(ctx, {
      id: options.id,
      position: options.position,
      left: options.left,
      top: options.top,
      width: options.width,
      height: options.height,
      visible: options.visible,
      zIndex: options.zIndex,
      border: false,
    });
    this.options = { ...options };
    this.currentView = options.view ?? "unified";
    this.updateTheme();
  }

  get diff(): string {
    return this.document?.diff ?? "";
  }

  get filetype(): string | undefined {
    return this.document?.filetype;
  }

  get view(): "unified" | "split" {
    return this.currentView;
  }

  setView(view: "unified" | "split") {
    if (view === this.currentView) return;
    this.currentView = view;
    if (!this.document) return;
    this.document.syncScroll = view === "split";
    this.document.view = view;
    queueMicrotask(() => this.setSelectedRows(this.selectedRows));
  }

  setDiff(
    value: string,
    filetype?: string,
    wrapMode: "word" | "none" = "word",
  ) {
    this.value = value;
    this.currentFiletype = filetype;
    this.currentWrapMode = wrapMode;
    this.replaceDocument(value, filetype, wrapMode);
  }

  private replaceDocument(
    value: string,
    filetype?: string,
    wrapMode: "word" | "none" = "word",
  ) {
    this.destroyDocument();
    if (!value) return;
    this.document = new DiffRenderable(this.ctx, {
      ...this.options,
      id: `${this.id}-document`,
      position: "relative",
      left: 0,
      top: 0,
      width: "100%",
      height: "100%",
      visible: true,
      diff: value,
      view: this.currentView,
      syncScroll: this.currentView === "split",
      filetype,
      wrapMode,
    });
    this.add(this.document);
    // Diff rows use mouse gestures for line staging. Disable OpenTUI's own
    // character-range selection in the nested code view so Alt-drag does not
    // paint a second, unrelated selection over the row highlights.
    const disableTextSelection = (root: { getChildren(): unknown[] }) => {
      for (const child of root.getChildren()) {
        if (
          typeof child === "object" &&
          child !== null &&
          "selectable" in child
        )
          (child as { selectable: boolean }).selectable = false;
        if (
          typeof child === "object" &&
          child !== null &&
          typeof (child as { getChildren?: unknown }).getChildren === "function"
        )
          disableTextSelection(child as { getChildren(): unknown[] });
      }
    };
    disableTextSelection(this.document);
  }

  clear() {
    this.value = "";
    this.currentFiletype = undefined;
    this.selectedRows = new Set();
    this.destroyDocument();
  }

  private destroyDocument() {
    if (!this.document) return;
    this.remove(this.document);
    this.document.destroyRecursively();
    this.document = undefined;
    this.requestRender();
  }

  updateTheme() {
    const previousStyle = this.ownedSyntaxStyle;
    this.ownedSyntaxStyle = createDiffSyntaxStyle();
    const colors = {
      fg: diffColor("text.context", oneDarkTheme.text),
      contextBg: diffColor("background.context", oneDarkTheme.bg),
      contextContentBg: diffColor("background.context", oneDarkTheme.bg),
      addedBg: diffColor("background.added", oneDarkTheme.diffAddedBg),
      removedBg: diffColor("background.removed", oneDarkTheme.diffRemovedBg),
      addedContentBg: diffColor("background.added", oneDarkTheme.diffAddedBg),
      removedContentBg: diffColor(
        "background.removed",
        oneDarkTheme.diffRemovedBg,
      ),
      addedSignColor: diffColor("text.added", oneDarkTheme.added),
      removedSignColor: diffColor("text.removed", oneDarkTheme.deleted),
      lineNumberFg: diffColor("lineNumber.text", oneDarkTheme.muted),
      lineNumberBg: diffColor("background.context", oneDarkTheme.bg),
      addedLineNumberBg: diffColor(
        "lineNumber.background.added",
        oneDarkTheme.diffAddedBg,
      ),
      removedLineNumberBg: diffColor(
        "lineNumber.background.removed",
        oneDarkTheme.diffRemovedBg,
      ),
      selectionBg: oneDarkTheme.selected,
      syntaxStyle: this.ownedSyntaxStyle,
    };
    Object.assign(this.options, colors);
    if (this.document) Object.assign(this.document, colors);
    this.setSelectedRows(this.selectedRows);
    previousStyle?.destroy();
  }

  protected override destroySelf() {
    super.destroySelf();
    this.ownedSyntaxStyle?.destroy();
    this.ownedSyntaxStyle = undefined;
  }

  /** Show persistent selection on changed rows while preserving diff colors. */
  setSelectedRows(rows: ReadonlySet<number>) {
    this.selectedRows = new Set(rows);
    if (!this.document) return;
    const lines = this.document.diff.split("\n");
    for (let rawRow = 0; rawRow < lines.length; rawRow++) {
      const target = diffLineTarget(this.document.diff, rawRow);
      if (!target || target.kind === "context") continue;
      this.document.setLineColor(
        target.renderedRow,
        rows.has(rawRow)
          ? {
              gutter: diffColor(
                `highlight.${target.kind === "added" ? "added" : "removed"}`,
                oneDarkTheme.accent,
              ),
              content: diffColor(
                `highlight.${target.kind === "added" ? "added" : "removed"}`,
                oneDarkTheme.selected,
              ),
            }
          : target.kind === "added"
            ? {
                gutter: diffColor(
                  "lineNumber.background.added",
                  oneDarkTheme.diffAddedBg,
                ),
                content: diffColor(
                  "background.added",
                  oneDarkTheme.diffAddedBg,
                ),
              }
            : {
                gutter: diffColor(
                  "lineNumber.background.removed",
                  oneDarkTheme.diffRemovedBg,
                ),
                content: diffColor(
                  "background.removed",
                  oneDarkTheme.diffRemovedBg,
                ),
              },
      );
    }
    this.requestRender();
  }

  /** Resolve an absolute terminal row to the file line shown there. */
  lineTargetAt(x: number, y: number): DiffLineTarget | undefined {
    if (!this.document) return undefined;
    const descendants = (root: { getChildren(): unknown[] }): unknown[] =>
      root
        .getChildren()
        .flatMap((child) => [
          child,
          ...(typeof (child as { getChildren?: unknown }).getChildren ===
          "function"
            ? descendants(child as { getChildren(): unknown[] })
            : []),
        ]);
    const all = descendants(this.document);
    const side =
      this.currentView === "split" &&
      x >= this.document.screenX + this.document.width / 2
        ? "new"
        : "old";
    const scroller = all.find(
      (child) =>
        typeof child === "object" &&
        child !== null &&
        "scrollY" in child &&
        "getLineInfo" in child &&
        (this.currentView !== "split" ||
          String((child as { id?: string }).id).endsWith(
            side === "old" ? "-left-code" : "-right-code",
          )),
    ) as { scrollY: number; screenY: number } | undefined;
    const row =
      y -
      (scroller?.screenY ?? this.document.screenY) +
      (scroller?.scrollY ?? 0);
    return this.currentView === "split"
      ? splitDiffLineTarget(this.document.diff, row, side)
      : renderedDiffLineTarget(
          this.document.diff,
          row,
          this.document.getHunkRowOffsets(),
        );
  }
}
