// Transient messages at bottom right and the busy spinner shown in the toolbar.
import type { TextRenderable } from "@opentui/core";
import { clipColumns } from "./runtime-presentation.js";
import { activeTheme as theme } from "./theme.js";

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

export interface RuntimeNotificationsContext {
  readonly message: TextRenderable;
  readonly renderer: { terminalWidth: number };
  paintHints(): void;
  paintToolbar(): void;
}

/** Owns the message text, its expiry timer, and the busy spinner state. */
export class RuntimeNotificationsController {
  // Reading `content` back off a renderable returns a StyledText, so the
  // message text is tracked here for width and layout maths.
  messageText = "";
  private messageTimer?: ReturnType<typeof setTimeout>;
  private busyText = "";
  private busyFrame = "";
  private disposed = false;
  private readonly spinner = createBrailleSpinner((frame) => {
    this.busyFrame = frame;
    this.context.paintToolbar();
  });

  constructor(private readonly context: RuntimeNotificationsContext) {}

  /** Busy progress for the toolbar, with the current spinner frame. */
  get busyLabel() {
    return this.busyText ? `${this.busyFrame} ${this.busyText}` : undefined;
  }

  /**
   * Show busy progress in the toolbar and transient messages at bottom right.
   *
   * Messages expire so the keybinding hints on the left, which they never
   * overwrite, remain the resting state of the row.
   */
  notify(text: string, tone: "info" | "error" | "busy" = "info") {
    if (this.disposed) return;
    const ctx = this.context;
    this.clearMessageTimer();
    if (tone === "busy") {
      this.stopSpinner();
      this.busyText = text;
      this.messageText = "";
      ctx.message.content = "";
      ctx.paintHints();
      this.spinner.start();
      return;
    }
    this.stopSpinner();
    const limit = Math.max(20, Math.floor(ctx.renderer.terminalWidth / 2));
    this.messageText = clipColumns(text, limit);
    ctx.message.content = this.messageText;
    ctx.message.fg = tone === "error" ? theme.deleted : theme.muted;
    this.positionMessage();
    ctx.paintHints();
    this.messageTimer = setTimeout(() => {
      this.messageText = "";
      ctx.message.content = "";
      this.messageTimer = undefined;
      this.positionMessage();
      ctx.paintHints();
    }, 6000);
  }

  positionMessage() {
    const ctx = this.context;
    const width = Bun.stringWidth(this.messageText);
    ctx.message.width = Math.max(1, width);
    ctx.message.left = Math.max(1, ctx.renderer.terminalWidth - width - 1);
  }

  clearMessageTimer() {
    if (this.messageTimer) clearTimeout(this.messageTimer);
    this.messageTimer = undefined;
  }

  /** Stop the spinner and timer, and ignore later notifications. */
  dispose() {
    this.disposed = true;
    this.stopSpinner();
    this.clearMessageTimer();
  }

  private stopSpinner() {
    this.spinner.stop();
    this.busyText = "";
    if (!this.disposed) this.context.paintToolbar();
  }
}
