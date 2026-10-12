// Command palette runtime glue: command list, painting, theme preview, and activation.
import {
  MouseButton,
  StyledText,
  bg,
  fg,
  type BoxRenderable,
  type CliRenderer,
  type InputRenderable,
  type TextareaRenderable,
  type TextRenderable,
} from "@opentui/core";
import {
  clampPaletteViewport,
  commandMatches,
  nextEnabledCommand,
  type PaletteCommand,
  type PaletteMatch,
} from "./command-palette.js";
import {
  runToolbarAction as runRuntimeToolbarAction,
  type RuntimeCommandsContext,
} from "./runtime-commands.js";
import { clipColumns, type ToolbarAction } from "./runtime-presentation.js";
import type { RuntimeTabsController } from "./runtime-tabs.js";
import { dialogColor } from "./runtime-theme.js";
import { activeTheme as oneDarkTheme, setActiveTheme } from "./theme.js";
import type { ThemeEntry, ThemeSelection } from "./theme-store.js";

export type PalettePage = "commands" | "themes" | "theme-mode";

export interface RuntimePaletteContext extends RuntimeCommandsContext {
  overlayCatcher: BoxRenderable;
  commandPaletteBox: BoxRenderable;
  commandPaletteInput: InputRenderable;
  commandPaletteText: TextRenderable;
  commandPaletteFooter: TextRenderable;
  renderer: Pick<
    CliRenderer,
    | "terminalWidth"
    | "terminalHeight"
    | "currentFocusedEditor"
    | "requestRender"
  >;
  themeEntries: ThemeEntry[];
  themeSelection: ThemeSelection;
  activateTheme(
    selection: ThemeSelection,
    persist?: boolean,
    appearance?: "dark" | "light",
    preview?: boolean,
  ): Promise<void>;
  showThemePicker(page: "themes" | "theme-mode"): Promise<void>;
  repaintTheme(): void;
  composing: boolean;
  tabs: readonly unknown[];
  leftCollapsed: boolean;
  detailsCollapsed: boolean;
  avatarsEnabled: boolean;
  perform(
    label: string,
    action: (signal?: AbortSignal) => Promise<void>,
    remote?: boolean,
    scope?: "history" | "working",
  ): Promise<void>;
  stageAll(): unknown;
  unstageAll(): unknown;
  discardAll(): unknown;
  focusComposer(): void;
  startBranchFilter(): void;
  setFocus(focus: "history" | "changes"): void;
  activeTabId: string;
  repositoryTabs: Pick<
    RuntimeTabsController,
    | "showRepositoryPicker"
    | "closeRepositoryTab"
    | "activateRelativeRepositoryTab"
  >;
  persistLayoutPreferences(): void;
  layout(): void;
  toggleAvatars(): void;
}

/** Owns command palette state, painting, theme preview, and activation. */
export class RuntimePaletteController {
  page: PalettePage = "commands";
  isOpen = false;
  matches: PaletteMatch[] = [];
  index = 0;
  start = 0;
  rows = 10;
  private themeOriginal?: typeof oneDarkTheme;
  private themePreview?: string;
  private previousEditor?: InputRenderable | TextareaRenderable;

  constructor(private readonly context: RuntimePaletteContext) {}

  private commands(): PaletteCommand[] {
    if (this.page === "themes")
      return this.context.themeEntries.map((entry) => ({
        id: `theme.${entry.name}`,
        title: `${entry.name}${entry.name === this.context.themeSelection.name ? " (current)" : ""}`,
        category: "Settings",
        run: () =>
          this.context.activateTheme({
            ...this.context.themeSelection,
            name: entry.name,
          }),
      }));
    if (this.page === "theme-mode")
      return (["dark", "light", "system"] as const).map((mode) => ({
        id: `theme-mode.${mode}`,
        title: `${mode}${mode === this.context.themeSelection.mode ? " (current)" : ""}`,
        category: "Settings",
        run: () =>
          this.context.activateTheme({ ...this.context.themeSelection, mode }),
      }));
    const snapshot = this.context.snapshot;
    const selected = this.context.selectedFile();
    const busyReason = this.context.mutationBusy
      ? `${this.context.mutationBusy} is still running`
      : undefined;
    const repositoryAvailability = (enabled: boolean, reason: string) => ({
      enabled: enabled && !busyReason,
      disabledReason: busyReason ?? (enabled ? undefined : reason),
    });
    const toolbar = (action: ToolbarAction) => () =>
      void runRuntimeToolbarAction(this.context, action);
    return [
      {
        id: "theme.change",
        title: "Change theme",
        category: "Settings",
        run: () => this.context.showThemePicker("themes"),
      },
      {
        id: "theme.mode",
        title: "Change theme mode",
        category: "Settings",
        run: () => this.context.showThemePicker("theme-mode"),
      },
      {
        id: "repository.refresh",
        title: "Refresh repository",
        category: "Repository",
        keywords: ["reload", "status"],
        shortcut: "r",
        ...repositoryAvailability(Boolean(snapshot), "Repository is loading"),
        run: toolbar("refresh"),
      },
      {
        id: "repository.fetch",
        title: "Fetch remotes",
        category: "Repository",
        shortcut: "f",
        ...repositoryAvailability(Boolean(snapshot), "Repository is loading"),
        run: toolbar("fetch"),
      },
      {
        id: "repository.pull",
        title: "Pull current branch",
        category: "Repository",
        shortcut: "l",
        ...repositoryAvailability(
          Boolean(snapshot?.upstream),
          "No upstream branch",
        ),
        run: toolbar("pull"),
      },
      {
        id: "repository.push",
        title: "Push current branch",
        category: "Repository",
        shortcut: "p",
        ...repositoryAvailability(
          Boolean(snapshot?.upstream),
          "No upstream branch",
        ),
        run: toolbar("push"),
      },
      {
        id: "repository.stash",
        title: "Stash working changes",
        category: "Repository",
        ...repositoryAvailability(
          (snapshot?.files.length ?? 0) > 0,
          "No changes to stash",
        ),
        run: toolbar("stash"),
      },
      {
        id: "repository.pop-stash",
        title: "Pop latest stash",
        category: "Repository",
        ...repositoryAvailability(
          (snapshot?.stashes.length ?? 0) > 0,
          "No stash to pop",
        ),
        run: toolbar("pop"),
      },
      {
        id: "repository.open",
        title: "Open new repository tab",
        category: "Repository",
        keywords: ["add tab", "open repository"],
        shortcut: "Ctrl+T",
        run: () => this.context.repositoryTabs.showRepositoryPicker(),
      },
      {
        id: "repository.close",
        title: "Close current repository tab",
        category: "Repository",
        shortcut: "Ctrl+W",
        enabled: this.context.tabs.length > 1 && !busyReason,
        disabledReason: busyReason ?? "Cannot close the only repository tab",
        run: () =>
          void this.context.repositoryTabs.closeRepositoryTab(
            this.context.activeTabId,
          ),
      },
      {
        id: "changes.commit",
        title: "Compose commit",
        category: "Changes",
        shortcut: "c",
        enabled: !this.context.composing,
        disabledReason: "Commit composer is already active",
        run: () => {
          setTimeout(() => this.context.focusComposer(), 0);
        },
      },
      {
        id: "changes.stage-selected",
        title: "Stage selected file",
        category: "Changes",
        shortcut: "s",
        ...repositoryAvailability(
          Boolean(selected?.unstaged),
          "No unstaged file selected",
        ),
        run: () =>
          selected &&
          void this.context.perform(
            `Staging ${selected.path}…`,
            () => this.context.repository.stage([selected.path]),
            false,
            "working",
          ),
      },
      {
        id: "changes.unstage-selected",
        title: "Unstage selected file",
        category: "Changes",
        shortcut: "u",
        ...repositoryAvailability(
          Boolean(selected?.staged),
          "No staged file selected",
        ),
        run: () =>
          selected &&
          void this.context.perform(
            `Unstaging ${selected.path}…`,
            () => this.context.repository.unstage([selected.path]),
            false,
            "working",
          ),
      },
      {
        id: "changes.stage-all",
        title: "Stage all changes",
        category: "Changes",
        shortcut: "a",
        ...repositoryAvailability(
          this.context.files("unstaged").length > 0,
          "No unstaged changes",
        ),
        run: () => void this.context.stageAll(),
      },
      {
        id: "changes.unstage-all",
        title: "Unstage all changes",
        category: "Changes",
        ...repositoryAvailability(
          this.context.files("staged").length > 0,
          "No staged changes",
        ),
        run: () => void this.context.unstageAll(),
      },
      {
        id: "changes.discard-all",
        title: "Discard all unstaged changes",
        category: "Changes",
        ...repositoryAvailability(
          this.context.files("unstaged").length > 0,
          "No unstaged changes",
        ),
        run: () => void this.context.discardAll(),
      },
      {
        id: "navigation.filter-branches",
        title: "Filter and checkout branches",
        category: "Navigation",
        keywords: ["switch", "find branch"],
        shortcut: "/",
        enabled: Boolean(snapshot),
        disabledReason: "Repository is loading",
        run: () => this.context.startBranchFilter(),
      },
      {
        id: "navigation.history",
        title: "Focus commit history",
        category: "Navigation",
        run: () => this.context.setFocus("history"),
      },
      {
        id: "navigation.changes",
        title: "Focus changed files",
        category: "Navigation",
        run: () => this.context.setFocus("changes"),
      },
      {
        id: "navigation.next-tab",
        title: "Next repository tab",
        category: "Navigation",
        shortcut: "Ctrl+Tab",
        enabled: this.context.tabs.length > 1 && !busyReason,
        disabledReason: busyReason ?? "Only one repository tab is open",
        run: () =>
          void this.context.repositoryTabs.activateRelativeRepositoryTab(1),
      },
      {
        id: "navigation.previous-tab",
        title: "Previous repository tab",
        category: "Navigation",
        shortcut: "Ctrl+Shift+Tab",
        enabled: this.context.tabs.length > 1 && !busyReason,
        disabledReason: busyReason ?? "Only one repository tab is open",
        run: () =>
          void this.context.repositoryTabs.activateRelativeRepositoryTab(-1),
      },
      {
        id: "view.sidebar",
        title: `${this.context.leftCollapsed ? "Expand" : "Collapse"} left panel`,
        category: "View",
        shortcut: "[",
        keywords: ["lhs", "sidebar", "branches", "show", "hide"],
        run: () => {
          this.context.leftCollapsed = !this.context.leftCollapsed;
          this.context.persistLayoutPreferences();
          this.context.layout();
        },
      },
      {
        id: "view.details",
        title: `${this.context.detailsCollapsed ? "Expand" : "Collapse"} right panel`,
        category: "View",
        shortcut: "]",
        keywords: ["rhs", "details", "show", "hide"],
        run: () => {
          this.context.detailsCollapsed = !this.context.detailsCollapsed;
          this.context.persistLayoutPreferences();
          this.context.layout();
        },
      },
      {
        id: "settings.avatars",
        title: `${this.context.avatarsEnabled ? "Disable" : "Enable"} author avatars`,
        category: "Settings",
        keywords: ["images", "privacy", "remote"],
        run: () => this.context.toggleAvatars(),
      },
    ];
  }

  show() {
    if (this.isOpen) return this.close();
    this.context.popupController.close();
    this.previousEditor = this.context.renderer.currentFocusedEditor as
      | InputRenderable
      | TextareaRenderable
      | undefined;
    this.isOpen = true;
    if (this.page === "themes" || this.page === "theme-mode")
      this.themeOriginal = {
        ...oneDarkTheme,
        graph: [...oneDarkTheme.graph],
      };
    this.context.commandPaletteInput.value = "";
    this.index = 0;
    this.start = 0;
    this.context.overlayCatcher.visible = true;
    this.context.commandPaletteBox.visible = true;
    this.paint();
    setTimeout(() => this.context.commandPaletteInput.focus(), 0);
  }

  close(restoreFocus = true) {
    if (!this.isOpen) return;
    this.isOpen = false;
    const original = this.themeOriginal;
    this.themeOriginal = undefined;
    this.themePreview = undefined;
    this.page = "commands";
    this.context.commandPaletteInput.blur();
    this.context.commandPaletteBox.visible = false;
    this.context.overlayCatcher.visible = this.context.popupController.isOpen;
    const previous = this.previousEditor;
    this.previousEditor = undefined;
    if (original) {
      setActiveTheme(original);
      this.context.repaintTheme();
    }
    if (restoreFocus && previous) setTimeout(() => previous.focus(), 0);
    this.context.renderer.requestRender();
  }

  paint() {
    if (!this.isOpen) return;
    const terminalWidth = Math.max(1, this.context.renderer.terminalWidth);
    const terminalHeight = Math.max(1, this.context.renderer.terminalHeight);
    const width = Math.max(1, Math.min(76, terminalWidth - 2));
    this.matches = commandMatches(
      this.commands(),
      this.context.commandPaletteInput.value,
    );
    // Reserve space for the search field, spacing, footer, and outer padding.
    this.rows = Math.max(
      1,
      Math.min(12, this.matches.length, terminalHeight - 7),
    );
    this.context.commandPaletteBox.left = Math.max(
      0,
      Math.floor((terminalWidth - width) / 2),
    );
    this.context.commandPaletteBox.top = Math.max(
      0,
      Math.floor((terminalHeight - this.rows - 7) / 3),
    );
    this.context.commandPaletteBox.width = width;
    this.context.commandPaletteBox.height = Math.min(
      terminalHeight,
      this.rows + 7,
    );
    this.context.commandPaletteInput.placeholder =
      this.page === "commands"
        ? "Search commands"
        : this.page === "themes"
          ? "Search themes"
          : "Search modes";
    this.context.commandPaletteInput.width = Math.max(1, width - 4);
    this.context.commandPaletteText.width = Math.max(1, width - 4);
    this.context.commandPaletteText.height = this.rows;
    this.context.commandPaletteFooter.top = this.rows + 4;
    this.context.commandPaletteFooter.width = Math.max(1, width - 4);
    this.context.commandPaletteFooter.content = new StyledText([
      fg(dialogColor("text.muted", oneDarkTheme.muted))(
        clipColumns(
          "↑↓ navigate   enter select   esc close",
          Math.max(1, width - 4),
        ),
      ),
    ]);
    if (this.matches.length === 0) this.index = -1;
    else if (
      this.index < 0 ||
      this.index >= this.matches.length ||
      this.matches[this.index]?.command.enabled === false
    )
      this.index = nextEnabledCommand(this.matches, -1, 1);
    this.start = clampPaletteViewport(
      this.index,
      this.start,
      this.rows,
      this.matches.length,
    );
    this.previewTheme();
    const visible = this.matches.slice(this.start, this.start + this.rows);
    if (visible.length === 0) {
      this.context.commandPaletteText.content = new StyledText([
        fg(dialogColor("text.muted", oneDarkTheme.muted))(
          " No matching commands",
        ),
      ]);
      return;
    }
    const content = visible.map((match, row) => {
      const index = this.start + row;
      const command = match.command;
      const selected = index === this.index;
      const rawSuffix =
        command.enabled === false
          ? (command.disabledReason ?? "Unavailable")
          : (command.shortcut ?? "");
      const innerWidth = Math.max(1, width - 4);
      const contentWidth = Math.max(1, innerWidth - 2);
      const detailWidth = Math.min(
        rawSuffix.length,
        24,
        Math.max(0, contentWidth - 24),
      );
      const titleWidth = Math.max(1, contentWidth - detailWidth);
      const title = clipColumns(command.title, titleWidth).padEnd(titleWidth);
      const suffix = clipColumns(rawSuffix, detailWidth).padStart(detailWidth);
      const background = selected
        ? oneDarkTheme.selected
        : oneDarkTheme.panelRaised;
      const color =
        command.enabled === false ? oneDarkTheme.muted : oneDarkTheme.text;
      const states = {
        selected,
        focused: selected,
        disabled: command.enabled === false,
      };
      const rowBackground = dialogColor(
        "background.action.primary",
        background,
        states,
      );
      return [
        bg(rowBackground)(
          fg(dialogColor("text.action.primary", color, states))(` ${title}`),
        ),
        bg(rowBackground)(
          fg(dialogColor("text.muted", oneDarkTheme.muted, states))(
            `${suffix} ${row === visible.length - 1 ? "" : "\n"}`,
          ),
        ),
      ];
    });
    this.context.commandPaletteText.content = new StyledText(content.flat());
  }

  private previewTheme() {
    if (!this.themeOriginal) return;
    const command = this.matches[this.index]?.command;
    const id = command?.enabled === false ? "" : (command?.id ?? "");
    if (id === this.themePreview) return;
    this.themePreview = id;
    if (!id) {
      setActiveTheme(this.themeOriginal);
      this.context.repaintTheme();
      return;
    }
    const selection =
      this.page === "themes"
        ? { ...this.context.themeSelection, name: id.slice("theme.".length) }
        : {
            ...this.context.themeSelection,
            mode: id.slice("theme-mode.".length) as "dark" | "light" | "system",
          };
    void this.context.activateTheme(selection, false, undefined, true);
  }

  moveSelection(delta: number) {
    if (!this.isOpen) return;
    const direction = delta < 0 ? -1 : 1;
    for (let count = 0; count < Math.abs(delta); count += 1)
      this.index = nextEnabledCommand(this.matches, this.index, direction);
    this.paint();
  }

  hoverRow(y: number) {
    const index =
      this.start + y - Number(this.context.commandPaletteBox.top) - 3;
    const command = this.matches[index]?.command;
    if (!command || command.enabled === false || index === this.index) return;
    this.index = index;
    this.paint();
  }

  activateRow(y: number, button: number) {
    if (button !== MouseButton.LEFT) return;
    const index =
      this.start + y - Number(this.context.commandPaletteBox.top) - 3;
    const command = this.matches[index]?.command;
    if (!command || command.enabled === false) return;
    this.index = index;
    this.activate();
  }

  activate() {
    const selected = this.matches[this.index]?.command;
    if (!selected || selected.enabled === false) return;
    const current = this.commands().find(
      (command) => command.id === selected.id,
    );
    if (!current || current.enabled === false) {
      this.paint();
      return;
    }
    this.close();
    void current.run();
  }
}
