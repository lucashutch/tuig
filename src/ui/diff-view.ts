import {
  BoxRenderable,
  DiffRenderable,
  type DiffRenderableOptions,
  type RenderContext,
} from "@opentui/core";

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
  }

  clear() {
    if (!this.document) return;
    this.remove(this.document);
    this.document.destroyRecursively();
    this.document = undefined;
    this.requestRender();
  }
}
