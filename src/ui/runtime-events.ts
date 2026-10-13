// Runtime event wiring: widget mouse and key actions, and overlay input handlers.
import {
  InputRenderableEvents,
  type InputRenderable,
  type KeyEvent,
} from "@opentui/core";
import type { RuntimeHistoryColumnsController } from "./runtime-history-columns.js";
import {
  resizeDetailsPane,
  resizeSidebarPane,
  toggleDetailsPane,
  toggleSidebarPane,
  type RuntimePaneResizeContext,
} from "./runtime-layout.js";
import type { RuntimePaletteController } from "./runtime-palette.js";
import type { RuntimePopupController } from "./runtime-popup.js";
import type { SidebarSection } from "./runtime-presentation.js";
import type { RuntimeTabsController } from "./runtime-tabs.js";
import type { RuntimeToolbarController } from "./runtime-toolbar.js";
import {
  PANE_TOP,
  type ChangeSection,
  type RuntimeOverlayActions,
  type RuntimeWidgetActions,
} from "./runtime-widgets.js";

/**
 * Runtime members the widget actions call. Runtime satisfies this structurally,
 * so the actions never import it.
 */
export interface RuntimeActionsContext extends RuntimePaneResizeContext {
  readonly repositoryTabs: Pick<
    RuntimeTabsController,
    "handleTabMouseDown" | "handleTabDrag" | "hover" | "dragEnd"
  >;
  readonly popupController: Pick<RuntimePopupController, "hover" | "click">;
  readonly toolbarController: Pick<
    RuntimeToolbarController,
    "hover" | "down" | "press"
  >;
  readonly historyHeader: Pick<
    RuntimeHistoryColumnsController,
    "hover" | "hoverEnd"
  >;
  toggleAvatars(): void;
  toggleDiffView(): void;
  /** Sidebar, history, and file methods take pane-relative rows. */
  sidebarClick(x: number, y: number, button: number): void;
  sidebarDrag(y: number): void;
  sidebarDragEnd(): void;
  toggleSidebarSection(section: SidebarSection): void;
  sidebarScroll(y: number, delta: number): void;
  resizeSidebar(section: SidebarSection, y: number): void;
  historyClick(x: number, y: number, button: number): void;
  historyDrag(x: number, y: number): void;
  historyDragEnd(): void;
  queueHistoryScroll(delta: number): void;
  scrollGraphColumns(delta: number): boolean;
  filesScroll(section: ChangeSection, delta: number): void;
  filesClick(
    section: ChangeSection,
    y: number,
    button?: number,
    x?: number,
  ): void;
  filesHover(section: ChangeSection, y?: number): void;
  toggleSection(section: ChangeSection): void;
  resizeChangeSplit(y: number): void;
  resizeComposer(y: number): void;
  discardAll(): unknown;
  stageAll(): unknown;
  unstageAll(): unknown;
  layout(): void;
  key(key: KeyEvent): unknown;
  commit(): unknown;
  toggleAmend(): void;
  closeDiff(): void;
  editMessage(): void;
  copyCommitSha(): void;
  diffClick(
    x: number,
    y: number,
    button: number,
    ctrl: boolean,
    alt: boolean,
  ): void;
  diffDrag(x: number, y: number): boolean;
  diffDragEnd(): boolean;
  dismissOverlay(): void;
}

/** Build the actions the widget factory binds to mouse and key events. */
export function createRuntimeActions(
  runtime: RuntimeActionsContext,
): RuntimeWidgetActions {
  return {
    tabMouseDown: (x, button) =>
      runtime.repositoryTabs.handleTabMouseDown(x, button),
    toggleAvatars: () => runtime.toggleAvatars(),
    toggleDiffView: () => runtime.toggleDiffView(),
    tabDrag: (x) => runtime.repositoryTabs.handleTabDrag(x),
    tabHover: (x) => runtime.repositoryTabs.hover(x),
    tabDragEnd: () => runtime.repositoryTabs.dragEnd(),
    sidebarClick: (x, y, button) =>
      runtime.sidebarClick(x, y - PANE_TOP, button),
    sidebarDrag: (y) => runtime.sidebarDrag(y - PANE_TOP),
    sidebarDragEnd: () => runtime.sidebarDragEnd(),
    sidebarToggle: (section) => runtime.toggleSidebarSection(section),
    sidebarScroll: (y, delta) => runtime.sidebarScroll(y - PANE_TOP, delta),
    sidebarResize: (section, y) => runtime.resizeSidebar(section, y),
    historyScroll: (delta, axis) => {
      if (axis === "horizontal") runtime.scrollGraphColumns(delta);
      else runtime.queueHistoryScroll(delta);
    },
    historyClick: (x, y, button) =>
      runtime.historyClick(x, y - PANE_TOP, button),
    historyDrag: (x, y) => runtime.historyDrag(x, y - PANE_TOP),
    historyDragEnd: () => runtime.historyDragEnd(),
    historyHover: (x, y) => runtime.historyHeader.hover(x, y),
    historyHoverEnd: () => runtime.historyHeader.hoverEnd(),
    filesScroll: (section, delta) => runtime.filesScroll(section, delta),
    filesClick: (section, y, button, x) =>
      runtime.filesClick(section, y, button, x),
    filesHover: (section, y) => runtime.filesHover(section, y),
    toggleSection: (section) => runtime.toggleSection(section),
    resizeChangeSplit: (y) => runtime.resizeChangeSplit(y),
    resizeComposer: (y) => runtime.resizeComposer(y),
    discardAll: () => void runtime.discardAll(),
    stageAll: () => void runtime.stageAll(),
    unstageAll: () => void runtime.unstageAll(),
    resizeLeft: (x) => resizeSidebarPane(runtime, x),
    resizeRight: (x) => resizeDetailsPane(runtime, x),
    toggleLeft: () => toggleSidebarPane(runtime),
    toggleRight: () => toggleDetailsPane(runtime),
    resize: () => runtime.layout(),
    keypress: (key) => void runtime.key(key),
    toolbarClick: (x) => void runtime.toolbarController.press(x),
    toolbarHover: (x) => runtime.toolbarController.hover(x),
    toolbarDown: (x) => runtime.toolbarController.down(x),
    commit: () => void runtime.commit(),
    toggleAmend: () => runtime.toggleAmend(),
    viewWorkingChanges: () => runtime.closeDiff(),
    editMessage: () => runtime.editMessage(),
    copyCommitSha: () => runtime.copyCommitSha(),
    diffClick: (x, y, button, ctrl, alt) =>
      runtime.diffClick(x, y, button, ctrl, alt),
    diffDrag: (x, y) => runtime.diffDrag(x, y),
    diffDragEnd: () => runtime.diffDragEnd(),
    overlayDismiss: () => runtime.dismissOverlay(),
    menuHover: (x, y) => runtime.popupController.hover(x, y, false),
    menuClick: (x, y) => runtime.popupController.click(x, y, false),
    submenuHover: (x, y) => runtime.popupController.hover(x, y, true),
    submenuClick: (x, y) => runtime.popupController.click(x, y, true),
  };
}

/** Runtime members the overlay widgets and their input handlers use. */
export interface RuntimeOverlayEventsContext {
  readonly branchFilterInput: InputRenderable;
  readonly promptInput: InputRenderable;
  readonly repositoryPathInput: InputRenderable;
  readonly commandPaletteInput: InputRenderable;
  readonly repositoryTabs: Pick<
    RuntimeTabsController,
    "chooseRepositorySuggestion" | "inputChanged" | "submitRepositoryInput"
  >;
  readonly palette: Pick<
    RuntimePaletteController,
    "hoverRow" | "activateRow" | "activate" | "queryChanged" | "moveSelection"
  >;
  branchFilterChanged(): void;
  activateFilteredBranch(): void;
  submitNamePrompt(): unknown;
}

/** Actions for the repository picker and command palette widgets. */
export function createOverlayActions(
  runtime: RuntimeOverlayEventsContext,
): RuntimeOverlayActions {
  return {
    chooseRepositorySuggestion: (row) =>
      runtime.repositoryTabs.chooseRepositorySuggestion(row),
    paletteHover: (y) => runtime.palette.hoverRow(y),
    paletteActivate: (y, button) => runtime.palette.activateRow(y, button),
    paletteScroll: (delta) => runtime.palette.moveSelection(delta),
  };
}

/** Bind the input and Enter handlers of the overlay text inputs. */
export function bindOverlayInputs(runtime: RuntimeOverlayEventsContext) {
  runtime.branchFilterInput.on(InputRenderableEvents.INPUT, () =>
    runtime.branchFilterChanged(),
  );
  runtime.branchFilterInput.on(InputRenderableEvents.ENTER, () =>
    runtime.activateFilteredBranch(),
  );
  runtime.promptInput.on(
    InputRenderableEvents.ENTER,
    () => void runtime.submitNamePrompt(),
  );
  runtime.repositoryPathInput.on(InputRenderableEvents.INPUT, () =>
    runtime.repositoryTabs.inputChanged(),
  );
  runtime.commandPaletteInput.on(InputRenderableEvents.INPUT, () =>
    runtime.palette.queryChanged(),
  );
  runtime.commandPaletteInput.on(InputRenderableEvents.ENTER, () =>
    runtime.palette.activate(),
  );
  runtime.repositoryPathInput.on(InputRenderableEvents.ENTER, () =>
    runtime.repositoryTabs.submitRepositoryInput(),
  );
}
