import {
  BoxRenderable,
  DiffRenderable,
  type DiffRenderableOptions,
  type RenderContext,
} from "@opentui/core";
import {
  diffLineTarget,
  renderedDiffLineTarget,
  type DiffLineTarget,
} from "./diff-lines.js";
import { oneDarkTheme } from "./theme.js";

/**
 * Own the displayed diff as a disposable child. OpenTUI 0.5.7 retains its
 * native buffers and line maps when DiffRenderable.diff is set to an empty
 * string. Replacing the child also sets language and content together, so a
 * language switch never highlights the old document with the new parser.
 */
export class DiffView extends BoxRenderable {
  private document?: DiffRenderable;
  private readonly options: DiffRenderableOptions;

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
    this.options = options;
  }

  get diff(): string {
    return this.document?.diff ?? "";
  }

  get filetype(): string | undefined {
    return this.document?.filetype;
  }

  setDiff(
    value: string,
    filetype?: string,
    wrapMode: "word" | "none" = "word",
  ) {
    this.clear();
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
    if (!this.document) return;
    this.remove(this.document);
    this.document.destroyRecursively();
    this.document = undefined;
    this.requestRender();
  }

  /** Show persistent selection on changed rows while preserving diff colors. */
  setSelectedRows(rows: ReadonlySet<number>) {
    if (!this.document) return;
    const lines = this.document.diff.split("\n");
    for (let rawRow = 0; rawRow < lines.length; rawRow++) {
      const target = diffLineTarget(this.document.diff, rawRow);
      if (!target || target.kind === "context") continue;
      this.document.setLineColor(
        target.renderedRow,
        rows.has(rawRow)
          ? {
              gutter: oneDarkTheme.accent,
              content: oneDarkTheme.dividerActive,
            }
          : target.kind === "added"
            ? {
                gutter: oneDarkTheme.diffAddedBg,
                content: oneDarkTheme.diffAddedBg,
              }
            : {
                gutter: oneDarkTheme.diffRemovedBg,
                content: oneDarkTheme.diffRemovedBg,
              },
      );
    }
    this.requestRender();
  }

  /** Resolve an absolute terminal row to the file line shown there. */
  lineTargetAt(y: number): DiffLineTarget | undefined {
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
    const scroller = descendants(this.document).find(
      (child) =>
        typeof child === "object" &&
        child !== null &&
        "scrollY" in child &&
        "getLineInfo" in child,
    ) as { scrollY: number; screenY: number } | undefined;
    return renderedDiffLineTarget(
      this.document.diff,
      y -
        (scroller?.screenY ?? this.document.screenY) +
        (scroller?.scrollY ?? 0),
      this.document.getHunkRowOffsets(),
    );
  }
}
