// Toolbar and header interaction: hover and press state, painting, and dispatch.
import type { TextRenderable } from "@opentui/core";
import type { RepositorySnapshot } from "../git/types.js";
import {
  renderHeader,
  renderToolbar,
  toolbarButtons,
  toolbarHit,
  type ToolbarAction,
  type ToolbarHit,
} from "./runtime-presentation.js";

export interface RuntimeToolbarContext {
  readonly toolbar: TextRenderable;
  readonly header: TextRenderable;
  readonly renderer: { terminalWidth: number };
  readonly snapshot?: RepositorySnapshot;
  readonly repository: { root: string };
  /** Busy progress text with its spinner frame, or undefined when idle. */
  readonly busyLabel?: string;
  runToolbarAction(action: ToolbarAction): unknown;
}

/** Owns toolbar hit boxes and the hovered and pressed buttons. */
export class RuntimeToolbarController {
  private hits: ToolbarHit[] = [];
  private hovered?: ToolbarAction;
  private pressed?: ToolbarAction;

  constructor(private readonly context: RuntimeToolbarContext) {}

  paint() {
    const ctx = this.context;
    const width = Math.max(1, ctx.renderer.terminalWidth);
    const toolbar = renderToolbar(toolbarButtons(ctx.snapshot), width, {
      hovered: this.hovered,
      pressed: this.pressed,
      busy: ctx.busyLabel,
    });
    ctx.toolbar.width = width;
    ctx.toolbar.content = toolbar.content;
    this.hits = toolbar.hits;
    this.paintHeader();
  }

  paintHeader() {
    const ctx = this.context;
    // The repository summary shares the toolbar's label row and stops before
    // its first action. The toolbar's second row remains available for glyphs.
    const firstAction = this.hits[0]?.start ?? ctx.renderer.terminalWidth;
    const width = Math.max(1, firstAction - 1);
    ctx.header.width = width;
    ctx.header.content = renderHeader({
      snapshot: ctx.snapshot,
      repositoryRoot: ctx.repository.root,
      width,
    });
  }

  hover(x?: number) {
    const hovered = x === undefined ? undefined : toolbarHit(this.hits, x);
    if (hovered === this.hovered) return;
    this.hovered = hovered;
    this.pressed = undefined;
    this.paint();
  }

  down(x: number) {
    this.pressed = toolbarHit(this.hits, x);
    this.paint();
  }

  /** Run the action when the button released over is the one pressed. */
  async press(x: number) {
    const action = toolbarHit(this.hits, x);
    const pressed = this.pressed;
    this.pressed = undefined;
    this.paint();
    if (!action || action !== pressed) return;
    await this.context.runToolbarAction(action);
  }
}
