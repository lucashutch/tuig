import {
  BoxRenderable,
  CliRenderEvents,
  DiffRenderable,
  InputRenderable,
  InputRenderableEvents,
  ImageRenderable,
  ScrollBoxRenderable,
  StyledText,
  TextareaRenderable,
  bg,
  fg,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core";
import { oneDarkTheme } from "./theme.js";
import { COMMIT_COMPOSER_HEIGHT } from "./runtime-presentation.js";
import {
  SIDEBAR_SECTIONS,
  type SidebarSection,
} from "./runtime-presentation.js";

export type ChangeSection = "unstaged" | "staged";

/** Row the diff starts on inside the details pane. */
export const COMMIT_DIFF_TOP = 2;

/** First row the panes may use: the header row plus the two toolbar rows. */
export const PANE_TOP = 3;

export type RuntimeWidgets = {
  header: TextRenderable;
  toolbar: TextRenderable;
  sidebar: BoxRenderable;
  history: BoxRenderable;
  details: BoxRenderable;
  hints: TextRenderable;
  message: TextRenderable;
  sidebarText: TextRenderable;
  sidebarSections: Record<
    SidebarSection,
    {
      box: BoxRenderable;
      header: TextRenderable;
      text: TextRenderable;
      divider: BoxRenderable;
      dividerBar: TextRenderable;
    }
  >;
  historyText: TextRenderable;
  commitDiff: DiffRenderable;
  commitDiffEmpty: TextRenderable;
  unstagedLabel: TextRenderable;
  unstagedText: TextRenderable;
  stagedLabel: TextRenderable;
  stagedText: TextRenderable;
  unstagedDivider: BoxRenderable;
  composerDivider: BoxRenderable;
  unstagedDividerBar: TextRenderable;
  composerDividerBar: TextRenderable;
  discardButton: TextRenderable;
  stageAllButton: TextRenderable;
  unstageAllButton: TextRenderable;
  composerBox: BoxRenderable;
  composerSummary: InputRenderable;
  composerBody: TextareaRenderable;
  commitButton: TextRenderable;
  amendButton: TextRenderable;
  workingBanner: TextRenderable;
  commitInfoBox: BoxRenderable;
  commitInfoLabel: TextRenderable;
  commitBodyBox: ScrollBoxRenderable;
  commitInfo: TextRenderable;
  authorPhoto: ImageRenderable;
  authorBadge: TextRenderable;
  commitCoAuthors: TextRenderable;
  commitCoAuthorProvider: ImageRenderable;
  editMessageButton: TextRenderable;
  commitHeader: TextRenderable;
  commitBody: TextRenderable;
  leftDivider: BoxRenderable;
  rightDivider: BoxRenderable;
  leftDividerBar: TextRenderable;
  rightDividerBar: TextRenderable;
  overlayCatcher: BoxRenderable;
  menuBox: BoxRenderable;
  menuText: TextRenderable;
  submenuBox: BoxRenderable;
  submenuText: TextRenderable;
};

export type RuntimeWidgetActions = {
  sidebarClick(x: number, y: number, button: number): void;
  sidebarToggle(section: SidebarSection): void;
  sidebarScroll(y: number, delta: number): void;
  sidebarResize(section: SidebarSection, y: number): void;
  historyScroll(delta: number): void;
  historyClick(x: number, y: number, button: number): void;
  filesScroll(section: ChangeSection, delta: number): void;
  filesClick(
    section: ChangeSection,
    y: number,
    button?: number,
    x?: number,
  ): void;
  toggleSection(section: ChangeSection): void;
  resizeChangeSplit(y: number): void;
  resizeComposer(y: number): void;
  discardAll(): void;
  stageAll(): void;
  unstageAll(): void;
  resizeLeft(x: number): void;
  resizeRight(x: number): void;
  toggleLeft(): void;
  toggleRight(): void;
  resize(): void;
  keypress(key: KeyEvent): void;
  toolbarClick(x: number): void;
  commit(): void;
  toggleAmend(): void;
  viewWorkingChanges(): void;
  editMessage(): void;
  copyCommitSha(): void;
  overlayDismiss(): void;
  menuHover(x: number, y: number): void;
  menuClick(x: number, y: number): void;
  submenuHover(x: number, y: number): void;
  submenuClick(x: number, y: number): void;
};

export function createRuntimeWidgets(
  renderer: CliRenderer,
  actions: RuntimeWidgetActions,
): RuntimeWidgets {
  const absolute = { position: "absolute" as const };
  const sidebar = new BoxRenderable(renderer, {
    ...absolute,
    id: "sidebar",
    left: 0,
    top: PANE_TOP,
    backgroundColor: oneDarkTheme.panel,
    onMouseDown: (e) => actions.sidebarClick(e.x, e.y, e.button),
    onMouseScroll: (e) =>
      actions.sidebarScroll(e.y, e.scroll?.direction === "up" ? -3 : 3),
  });
  const history = new BoxRenderable(renderer, {
    ...absolute,
    id: "history",
    top: PANE_TOP,
    backgroundColor: oneDarkTheme.bg,
    onMouseScroll: (e) =>
      actions.historyScroll(e.scroll?.direction === "up" ? -3 : 3),
  });
  const details = new BoxRenderable(renderer, {
    ...absolute,
    id: "details",
    top: PANE_TOP,
    backgroundColor: oneDarkTheme.panel,
  });
  const makeDividerBar = (id: string) =>
    new TextRenderable(renderer, {
      ...absolute,
      id,
      top: PANE_TOP,
      width: 1,
      zIndex: 9,
      fg: oneDarkTheme.divider,
      content: "",
    });
  const leftDividerBar = makeDividerBar("left-divider-bar");
  const rightDividerBar = makeDividerBar("right-divider-bar");
  const makeDivider = (
    id: string,
    bar: TextRenderable,
    drag: (x: number) => void,
    toggle: () => void,
  ) => {
    let moved = false;
    let hovered = false;
    let dragging = false;
    const paint = () => {
      bar.fg = dragging
        ? oneDarkTheme.added
        : hovered
          ? oneDarkTheme.accentSoft
          : oneDarkTheme.divider;
    };
    return new BoxRenderable(renderer, {
      ...absolute,
      id,
      top: PANE_TOP,
      width: 3,
      zIndex: 10,
      onMouseDown: () => {
        moved = false;
        dragging = true;
        paint();
      },
      onMouseDrag: (e) => {
        moved = true;
        drag(e.x);
        paint();
      },
      onMouseUp: () => {
        dragging = false;
        paint();
        if (!moved) toggle();
      },
      onMouseDragEnd: () => {
        dragging = false;
        paint();
      },
      onMouseOver: () => {
        hovered = true;
        paint();
      },
      onMouseOut: () => {
        hovered = false;
        if (!dragging) paint();
      },
    });
  };
  const leftDivider = makeDivider(
    "left-divider",
    leftDividerBar,
    actions.resizeLeft,
    actions.toggleLeft,
  );
  const rightDivider = makeDivider(
    "right-divider",
    rightDividerBar,
    actions.resizeRight,
    actions.toggleRight,
  );
  const sidebarText = new TextRenderable(renderer, {
    ...absolute,
    id: "sidebar-content",
    left: 0,
    top: 1,
    width: "100%",
    height: "95%",
    fg: oneDarkTheme.text,
    content: " ░░░░░░░░░░░░\n\n ░░░░░░░░░  ░░░░\n ░░░░░░░░░░░░░░",
    visible: false,
  });
  const sidebarSections = {} as RuntimeWidgets["sidebarSections"];
  for (const section of SIDEBAR_SECTIONS) {
    const box = new BoxRenderable(renderer, {
      ...absolute,
      id: `sidebar-${section}`,
      left: 0,
      top: 0,
      width: "100%",
      height: 1,
      // Sidebar sections deliberately use the same unraised panel treatment
      // as the staged/unstaged lists.
      backgroundColor: oneDarkTheme.panel,
      shouldFill: true,
    });
    const header = new TextRenderable(renderer, {
      ...absolute,
      id: `sidebar-${section}-header`,
      left: 1,
      top: 0,
      width: "95%",
      height: 1,
      fg: oneDarkTheme.muted,
      zIndex: 10,
      content: "",
      onMouseDown: () => actions.sidebarToggle(section),
    });
    const text = new TextRenderable(renderer, {
      ...absolute,
      id: `sidebar-${section}-content`,
      left: 0,
      top: 1,
      width: "100%",
      height: 1,
      wrapMode: "none",
      fg: oneDarkTheme.text,
      content: "",
      onMouseScroll: (e) =>
        actions.sidebarScroll(
          Number(box.top) + 1 + PANE_TOP,
          e.scroll?.direction === "up" ? -3 : 3,
        ),
    });
    let hovered = false;
    let dragging = false;
    // Assigned after the paint callback is created so the callback can style it.
    // eslint-disable-next-line prefer-const
    let dividerBar: TextRenderable;
    const paintDividerState = () => {
      dividerBar.fg = dragging
        ? oneDarkTheme.added
        : hovered
          ? oneDarkTheme.accentSoft
          : oneDarkTheme.divider;
    };
    const divider = new BoxRenderable(renderer, {
      ...absolute,
      id: `sidebar-${section}-divider`,
      left: 0,
      top: 0,
      width: "100%",
      // Use the divider row plus the content row above it as the drag target.
      // Extending below the divider would overlap the next section's header
      // and make its expand/collapse action difficult to hit.
      height: 2,
      zIndex: 8,
      onMouseOver: () => {
        hovered = true;
        paintDividerState();
      },
      onMouseOut: () => {
        hovered = false;
        if (!dragging) paintDividerState();
      },
      onMouseDown: () => {
        dragging = true;
        paintDividerState();
      },
      onMouseDrag: (e) => actions.sidebarResize(section, e.y - PANE_TOP),
      onMouseUp: () => {
        dragging = false;
        paintDividerState();
      },
      onMouseDragEnd: () => {
        dragging = false;
        paintDividerState();
      },
    });
    dividerBar = new TextRenderable(renderer, {
      ...absolute,
      id: `sidebar-${section}-divider-bar`,
      left: 0,
      top: 0,
      width: "100%",
      height: 1,
      fg: oneDarkTheme.divider,
      content: "─",
      wrapMode: "none",
    });
    box.add(header);
    box.add(text);
    sidebar.add(box);
    sidebar.add(dividerBar);
    sidebar.add(divider);
    sidebarSections[section] = { box, header, text, divider, dividerBar };
  }
  const historyText = new TextRenderable(renderer, {
    ...absolute,
    id: "history-content",
    left: 1,
    top: 1,
    width: "97%",
    height: "95%",
    fg: oneDarkTheme.text,
    content:
      " ░░░░░░░  ░ ░░░░░░░░░░░░░░░░  ░░░░░░░\n ░░░░░░░  ░ ░░░░░░░░░░░  ░░░░░░░",
    wrapMode: "none",
    onMouseDown: (e) => actions.historyClick(e.x, e.y, e.button),
  });
  const makeFileList = (section: ChangeSection) =>
    new TextRenderable(renderer, {
      ...absolute,
      id: `${section}-files`,
      left: 1,
      top: 1,
      width: "97%",
      height: 6,
      wrapMode: "none",
      fg: oneDarkTheme.text,
      content: "",
      onMouseScroll: (e) =>
        actions.filesScroll(section, e.scroll?.direction === "up" ? -3 : 3),
      onMouseDown: (e) => actions.filesClick(section, e.y, e.button, e.x),
    });
  const makeFileLabel = (section: ChangeSection) =>
    new TextRenderable(renderer, {
      ...absolute,
      id: `${section}-files-label`,
      left: 1,
      top: 1,
      width: "97%",
      height: 1,
      wrapMode: "none",
      fg: oneDarkTheme.muted,
      content: "",
      onMouseDown: () => actions.toggleSection(section),
    });
  const unstagedText = makeFileList("unstaged");
  const unstagedLabel = makeFileLabel("unstaged");
  const stagedText = makeFileList("staged");
  const stagedLabel = makeFileLabel("staged");
  const makeHorizontalDividerBar = (id: string) =>
    new TextRenderable(renderer, {
      ...absolute,
      id: `${id}-bar`,
      left: 0,
      top: 1,
      width: "100%",
      height: 1,
      wrapMode: "none",
      fg: oneDarkTheme.divider,
      content: "",
    });
  const unstagedDividerBar = makeHorizontalDividerBar(
    "unstaged-staged-divider",
  );
  const composerDividerBar = makeHorizontalDividerBar(
    "staged-composer-divider",
  );
  const makeHorizontalDivider = (
    id: string,
    bar: TextRenderable,
    drag: (y: number) => void,
  ) => {
    let hovered = false;
    let dragging = false;
    const paint = () => {
      bar.fg = dragging
        ? oneDarkTheme.added
        : hovered
          ? oneDarkTheme.accentSoft
          : oneDarkTheme.divider;
    };
    return new BoxRenderable(renderer, {
      ...absolute,
      id,
      left: 0,
      top: 1,
      width: "100%",
      height: 2,
      zIndex: 8,
      onMouseOver: () => {
        hovered = true;
        paint();
      },
      onMouseOut: () => {
        hovered = false;
        if (!dragging) paint();
      },
      onMouseDown: () => {
        dragging = true;
        paint();
      },
      onMouseDrag: (e) => {
        drag(e.y - PANE_TOP);
        paint();
      },
      onMouseUp: () => {
        dragging = false;
        paint();
      },
      onMouseDragEnd: () => {
        dragging = false;
        paint();
      },
    });
  };
  const unstagedDivider = makeHorizontalDivider(
    "unstaged-staged-divider",
    unstagedDividerBar,
    actions.resizeChangeSplit,
  );
  const composerDivider = makeHorizontalDivider(
    "staged-composer-divider",
    composerDividerBar,
    actions.resizeComposer,
  );
  const makeButton = (
    id: string,
    content: string,
    color: string,
    onPress: () => void,
  ) =>
    new TextRenderable(renderer, {
      ...absolute,
      id,
      left: 1,
      top: 0,
      height: 1,
      width: Bun.stringWidth(content),
      wrapMode: "none",
      content: new StyledText([
        bg(oneDarkTheme.panelRaised)(fg(color)(content)),
      ]),
      onMouseDown: onPress,
    });
  const discardButton = makeButton(
    "discard-all",
    " ✖  Discard all ",
    oneDarkTheme.deleted,
    actions.discardAll,
  );
  const stageAllButton = makeButton(
    "stage-all",
    " ✚  Stage all ",
    oneDarkTheme.added,
    actions.stageAll,
  );
  const unstageAllButton = makeButton(
    "unstage-all",
    " −  Unstage all ",
    oneDarkTheme.warning,
    actions.unstageAll,
  );
  const commitInfoBox = new BoxRenderable(renderer, {
    ...absolute,
    id: "commit-info-box",
    left: 1,
    top: 1,
    width: "97%",
    height: 4,
    visible: false,
    border: false,
    backgroundColor: oneDarkTheme.panel,
    shouldFill: true,
  });
  const commitBodyBox = new ScrollBoxRenderable(renderer, {
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
  const text = (id: string, content = "") =>
    new TextRenderable(renderer, {
      id,
      left: 1,
      top: 1,
      width: "95%",
      height: 1,
      fg: oneDarkTheme.text,
      content,
    });
  const commitInfo = text("commit-info");
  const authorPhoto = new ImageRenderable(renderer, {
    ...absolute,
    id: "author-photo",
    left: 1,
    top: 1,
    width: 8,
    height: 4,
    fit: "cover",
    protocol: "auto",
    visible: false,
  });
  const authorBadge = new TextRenderable(renderer, {
    ...absolute,
    id: "author-badge",
    left: 1,
    top: 2,
    width: 8,
    height: 1,
    wrapMode: "none",
    fg: oneDarkTheme.author,
    content: "",
  });
  const commitCoAuthors = new TextRenderable(renderer, {
    ...absolute,
    id: "commit-coauthors",
    left: 1,
    top: 5,
    width: "95%",
    height: 1,
    wrapMode: "word",
    fg: oneDarkTheme.muted,
    content: "",
  });
  const commitCoAuthorProvider = new ImageRenderable(renderer, {
    ...absolute,
    id: "commit-coauthor-provider",
    left: 1,
    top: 5,
    width: 4,
    height: 2,
    fit: "cover",
    protocol: "auto",
    visible: false,
  });
  const editMessageButton = new TextRenderable(renderer, {
    ...absolute,
    id: "edit-message",
    left: 1,
    top: 0,
    width: 16,
    height: 1,
    wrapMode: "none",
    fg: oneDarkTheme.accent,
    content: new StyledText([
      bg(oneDarkTheme.selected)(fg(oneDarkTheme.accent)(" Edit Message ")),
    ]),
    onMouseDown: actions.editMessage,
  });
  const commitHeader = text("commit-header");
  const commitBody = new TextRenderable(renderer, {
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
  const commitInfoLabel = sectionLabel(
    "commit-info-label",
    "DETAILS",
    oneDarkTheme.accent,
  );
  commitInfoLabel.onMouseDown = actions.copyCommitSha;
  commitInfoBox.add(commitInfoLabel);
  commitInfoBox.add(authorPhoto);
  commitInfoBox.add(authorBadge);
  commitInfoBox.add(commitCoAuthors);
  commitInfoBox.add(commitCoAuthorProvider);
  commitBodyBox.add(
    sectionLabel("commit-message-label", "COMMIT MESSAGE", oneDarkTheme.text),
  );
  commitInfoBox.add(commitInfo);
  commitBodyBox.add(editMessageButton);
  commitBodyBox.add(commitHeader);
  commitBodyBox.add(commitBody);
  const diffOptions = {
    diff: "",
    view: "unified" as const,
    showLineNumbers: true,
    wrapMode: "none" as const,
    fg: oneDarkTheme.text,
    addedBg: oneDarkTheme.diffAddedBg,
    removedBg: oneDarkTheme.diffRemovedBg,
    addedContentBg: oneDarkTheme.diffAddedBg,
    removedContentBg: oneDarkTheme.diffRemovedBg,
    addedSignColor: oneDarkTheme.added,
    removedSignColor: oneDarkTheme.deleted,
  };
  const commitDiff = new DiffRenderable(renderer, {
    ...absolute,
    id: "commit-diff",
    left: 1,
    top: COMMIT_DIFF_TOP,
    width: "97%",
    height: "95%",
    visible: false,
    ...diffOptions,
    contextBg: oneDarkTheme.bg,
  });
  const commitDiffEmpty = new TextRenderable(renderer, {
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
  const composerBox = new BoxRenderable(renderer, {
    ...absolute,
    id: "composer-box",
    left: 1,
    top: 10,
    width: "97%",
    height: COMMIT_COMPOSER_HEIGHT,
    border: false,
    backgroundColor: oneDarkTheme.panel,
    shouldFill: true,
  });
  const composerLabel = new TextRenderable(renderer, {
    ...absolute,
    id: "composer-label",
    left: 0,
    top: 0,
    width: "95%",
    height: 1,
    wrapMode: "none",
    fg: oneDarkTheme.accent,
    content: " COMMIT MESSAGE",
  });
  const composerSummary = new InputRenderable(renderer, {
    ...absolute,
    id: "composer-summary",
    left: 1,
    top: 1,
    width: "94%",
    value: "",
    placeholder: "Summary",
    backgroundColor: oneDarkTheme.panelRaised,
    focusedBackgroundColor: oneDarkTheme.selected,
    textColor: oneDarkTheme.text,
  });
  const composerBody = new TextareaRenderable(renderer, {
    ...absolute,
    id: "composer-body",
    left: 1,
    top: 2,
    width: "94%",
    height: 3,
    placeholder: "Description",
    backgroundColor: oneDarkTheme.panelRaised,
    focusedBackgroundColor: oneDarkTheme.selected,
    textColor: oneDarkTheme.text,
    wrapMode: "word",
  });
  const commitButton = new TextRenderable(renderer, {
    ...absolute,
    id: "commit-button",
    left: 1,
    top: 6,
    height: 1,
    width: "94%",
    wrapMode: "none",
    fg: oneDarkTheme.text,
    content: "",
    onMouseDown: () => actions.commit(),
  });
  const amendButton = new TextRenderable(renderer, {
    ...absolute,
    id: "amend-toggle",
    left: 1,
    top: 5,
    width: "94%",
    height: 1,
    wrapMode: "none",
    fg: oneDarkTheme.muted,
    content: "[ ] Amend previous commit",
    onMouseDown: actions.toggleAmend,
  });
  const workingBanner = new TextRenderable(renderer, {
    ...absolute,
    id: "working-banner",
    left: 1,
    top: 0,
    width: "97%",
    height: 1,
    wrapMode: "none",
    visible: false,
    fg: oneDarkTheme.warning,
    content: "",
    onMouseDown: actions.viewWorkingChanges,
  });
  composerBox.add(composerLabel);
  composerBox.add(composerSummary);
  composerBox.add(composerBody);
  composerBox.add(amendButton);
  composerBox.add(commitButton);
  const header = new TextRenderable(renderer, {
    ...absolute,
    id: "header",
    left: 0,
    top: 0,
    height: 1,
    zIndex: 20,
    fg: oneDarkTheme.text,
    wrapMode: "none",
    content: "",
  });
  // Hints and messages share the bottom row but never overwrite each other,
  // and both sit on the root so collapsing a pane cannot hide them.
  const toolbar = new TextRenderable(renderer, {
    ...absolute,
    id: "toolbar",
    left: 0,
    top: 1,
    height: 2,
    zIndex: 20,
    fg: oneDarkTheme.text,
    wrapMode: "none",
    content: "",
    onMouseDown: (e) => actions.toolbarClick(e.x),
  });
  const hints = new TextRenderable(renderer, {
    ...absolute,
    id: "hints",
    left: 1,
    bottom: 0,
    height: 1,
    zIndex: 20,
    wrapMode: "none",
    fg: oneDarkTheme.muted,
    content: "",
  });
  const message = new TextRenderable(renderer, {
    ...absolute,
    id: "message",
    left: 1,
    bottom: 0,
    height: 1,
    zIndex: 21,
    wrapMode: "none",
    fg: oneDarkTheme.muted,
    content: "",
  });
  // The overlay layer: a full-screen catcher that dismisses the menu, the
  // menu itself, and its submenu, all above every pane.
  const overlayCatcher = new BoxRenderable(renderer, {
    ...absolute,
    id: "overlay-catcher",
    left: 0,
    top: 0,
    width: "100%",
    height: "100%",
    zIndex: 50,
    visible: false,
    border: false,
    shouldFill: false,
    onMouseDown: () => actions.overlayDismiss(),
  });
  const makePopup = (
    id: string,
    zIndex: number,
    hover: (x: number, y: number) => void,
    click: (x: number, y: number) => void,
  ) => {
    const box = new BoxRenderable(renderer, {
      ...absolute,
      id,
      left: 0,
      top: 0,
      width: 24,
      height: 4,
      zIndex,
      visible: false,
      border: true,
      borderColor: oneDarkTheme.border,
      backgroundColor: oneDarkTheme.panelRaised,
      shouldFill: true,
      title: "",
      titleAlignment: "left" as const,
    });
    const text = new TextRenderable(renderer, {
      ...absolute,
      id: `${id}-content`,
      left: 1,
      top: 1,
      width: 22,
      height: 2,
      zIndex: zIndex + 1,
      visible: false,
      wrapMode: "none",
      fg: oneDarkTheme.text,
      content: "",
      onMouseMove: (e) => hover(e.x, e.y),
      onMouseDown: (e) => click(e.x, e.y),
    });
    return { box, text };
  };
  const menu = makePopup(
    "graph-menu",
    60,
    actions.menuHover,
    actions.menuClick,
  );
  const submenu = makePopup(
    "graph-submenu",
    70,
    actions.submenuHover,
    actions.submenuClick,
  );
  const menuBox = menu.box;
  const menuText = menu.text;
  const submenuBox = submenu.box;
  const submenuText = submenu.text;
  sidebar.add(sidebarText);
  history.add(historyText);
  details.add(commitInfoBox);
  details.add(workingBanner);
  details.add(commitBodyBox);
  details.add(discardButton);
  details.add(stageAllButton);
  details.add(unstageAllButton);
  details.add(unstagedLabel);
  details.add(unstagedText);
  details.add(stagedLabel);
  details.add(stagedText);
  details.add(unstagedDividerBar);
  details.add(composerDividerBar);
  details.add(unstagedDivider);
  details.add(composerDivider);
  details.add(composerBox);
  // A selected file diff is an overlay on the history pane, while commit
  // metadata remains in the details pane. The runtime positions these above
  // the graph only while a diff is open.
  renderer.root.add(header);
  renderer.root.add(toolbar);
  renderer.root.add(hints);
  renderer.root.add(message);
  renderer.root.add(sidebar);
  renderer.root.add(history);
  renderer.root.add(details);
  renderer.root.add(commitDiff);
  renderer.root.add(commitDiffEmpty);
  renderer.root.add(leftDividerBar);
  renderer.root.add(rightDividerBar);
  renderer.root.add(leftDivider);
  renderer.root.add(rightDivider);
  renderer.root.add(overlayCatcher);
  renderer.root.add(menuBox);
  renderer.root.add(menuText);
  renderer.root.add(submenuBox);
  renderer.root.add(submenuText);
  renderer.on(CliRenderEvents.RESIZE, actions.resize);
  renderer.keyInput.on("keypress", (key) => actions.keypress(key));
  composerSummary.on(InputRenderableEvents.ENTER, actions.commit);
  return {
    header,
    toolbar,
    sidebar,
    history,
    details,
    hints,
    message,
    sidebarText,
    sidebarSections,
    historyText,
    commitDiff,
    commitDiffEmpty,
    unstagedLabel,
    unstagedText,
    stagedLabel,
    stagedText,
    unstagedDivider,
    composerDivider,
    unstagedDividerBar,
    composerDividerBar,
    discardButton,
    stageAllButton,
    unstageAllButton,
    composerBox,
    composerSummary,
    composerBody,
    commitButton,
    amendButton,
    workingBanner,
    commitInfoBox,
    commitInfoLabel,
    commitBodyBox,
    commitInfo,
    authorPhoto,
    authorBadge,
    commitCoAuthors,
    commitCoAuthorProvider,
    editMessageButton,
    commitHeader,
    commitBody,
    leftDivider,
    rightDivider,
    leftDividerBar,
    rightDividerBar,
    overlayCatcher,
    menuBox,
    menuText,
    submenuBox,
    submenuText,
  };
}
