import {
  BoxRenderable,
  CliRenderEvents,
  InputRenderable,
  TextareaRenderable,
  TextRenderable,
  type CliRenderer,
  type Renderable,
  type TextBufferRenderable,
} from "@opentui/core";
import type { RepositorySnapshot } from "../git/types.js";
import type { DiffView } from "./diff-view.js";
import {
  emptyGraphIndex,
  extendGraphIndex,
  type GraphIndex,
} from "./graph-index.js";
import { resolveHeadSha } from "./history.js";
import type { RuntimePaletteController } from "./runtime-palette.js";
import {
  parseCoAuthors,
  presentCommitCoAuthors,
  presentCommitMeta,
} from "./runtime-presentation.js";
import {
  activeTheme as theme,
  interactionBackground,
  oneDarkTheme,
  semanticColor,
  setActiveTheme,
  type Theme,
  type ThemeState,
} from "./theme.js";
import {
  loadThemeCatalog,
  loadThemePreferences,
  saveThemePreferences,
  type ThemeCatalog,
  type ThemeSelection,
} from "./theme-store.js";

export async function loadInitialTheme(repositoryRoot?: string): Promise<{
  catalog: ThemeCatalog;
  selection: ThemeSelection;
  theme: Theme;
  warning?: string;
}> {
  const catalog = await loadThemeCatalog(repositoryRoot);
  try {
    const selection = await loadThemePreferences();
    return {
      catalog,
      selection,
      theme: catalog.resolve(
        selection.name,
        selection.mode === "light" ? "light" : "dark",
      ),
    };
  } catch (error) {
    return {
      catalog,
      selection: { name: "one-dark", mode: "dark" },
      theme: { ...oneDarkTheme, graph: [...oneDarkTheme.graph] },
      warning: `Theme settings could not be loaded. Using One Dark: ${String(error)}`,
    };
  }
}

type Binding = (widget: Renderable) => void;
const bindings = new WeakMap<Renderable, Binding>();
const actionStates = new WeakMap<
  object,
  Partial<Record<ThemeState, boolean>>
>();
export function bindWidgetTheme(widget: Renderable, binding: Binding) {
  bindings.set(widget, binding);
  binding(widget);
}
export function setActionState(
  widget: object,
  state: Partial<Record<ThemeState, boolean>>,
) {
  actionStates.set(widget, { ...actionStates.get(widget), ...state });
}
export function actionEnabled(widget: object) {
  return !actionStates.get(widget)?.disabled;
}
const actionIds =
  /^(discard-all|stage-all|unstage-all|commit-button|amend-toggle|avatar-toggle|edit-message|working-banner)$/;
export function applyActionTheme(widget: TextBufferRenderable) {
  if (!actionIds.test(widget.id)) return;
  const states = actionStates.get(widget) ?? {};
  const variant =
    widget.id === "discard-all"
      ? "destructive"
      : /^(amend-toggle|avatar-toggle|edit-message|working-banner|unstage-all)$/.test(
            widget.id,
          )
        ? "secondary"
        : "primary";
  const fallback =
    widget.id === "discard-all"
      ? theme.deleted
      : /^(stage-all|commit-button)$/.test(widget.id)
        ? theme.added
        : /^(unstage-all|working-banner)$/.test(widget.id)
          ? theme.warning
          : widget.id === "edit-message"
            ? theme.accent
            : theme.muted;
  widget.fg = semanticColor(
    theme,
    `text.action.${variant}`,
    states.disabled ? theme.muted : fallback,
    { states },
  );
  const base = /^(amend-toggle|edit-message|working-banner)$/.test(widget.id)
    ? "transparent"
    : theme.panelRaised;
  widget.bg = semanticColor(
    theme,
    `background.action.${variant}`,
    states.disabled
      ? base
      : interactionBackground(theme, base, {
          pressed: states.pressed,
          hovered: states.hovered,
        }),
    { states },
  );
}
export function dialogColor(
  path: string,
  fallback: string,
  states?: Partial<Record<ThemeState, boolean>>,
) {
  return semanticColor(theme, path, fallback, { surface: "dialog", states });
}

/** Explicit semantic widget roles. Color equality never determines a role. */
export function updateWidgetTheme(root: Renderable) {
  if (typeof root.id !== "string" || typeof root.getChildren !== "function")
    return;
  const dialog =
    /^(graph-menu|graph-submenu|menu|submenu|name-prompt|repository-picker|repository-path|repository-suggestions|command-palette)/.test(
      root.id,
    );
  const color = (
    path: string,
    fallback: string,
    states?: Partial<Record<ThemeState, boolean>>,
  ) =>
    semanticColor(theme, path, fallback, {
      surface: dialog ? "dialog" : undefined,
      states,
    });
  if (root instanceof InputRenderable || root instanceof TextareaRenderable) {
    const base = /^(composer-summary|composer-body)$/.test(root.id)
      ? theme.panelRaised
      : theme.selected;
    root.backgroundColor = color("background.formfield", base);
    root.textColor = color("text.formfield", theme.text);
    root.focusedBackgroundColor = color(
      "background.formfield",
      theme.selected,
      { focused: true },
    );
    root.focusedTextColor = color("text.formfield", theme.text, {
      focused: true,
    });
    root.cursorColor = color("text.formfield", theme.focusRing, {
      focused: true,
    });
    root.placeholderColor = color("text.muted", theme.muted);
  } else if (root instanceof TextRenderable) {
    let role: keyof Theme = "text";
    if (
      /^(hints|message|avatar-toggle|amend-toggle|commit-coauthors|commit-diff-empty)$/.test(
        root.id,
      ) ||
      /-(header|files-label)$/.test(root.id)
    )
      role = "muted";
    if (root.id.endsWith("divider-bar")) role = "divider";
    if (root.id === "author-badge") role = "author";
    if (/^(edit-message|composer-label|commit-info-label)$/.test(root.id))
      role = "accent";
    if (root.id === "working-banner") role = "warning";
    root.fg = color(
      role === "muted" ? "text.muted" : "text.base",
      theme[role] as string,
    );
    if (actionIds.test(root.id)) applyActionTheme(root);
  } else if (root instanceof BoxRenderable) {
    if (dialog) {
      root.backgroundColor = dialogColor("background.base", theme.panelRaised);
      // OpenTUI enables borders when borderColor is assigned.
      if (root.id !== "command-palette")
        root.borderColor = dialogColor("border.base", theme.border);
    } else if (
      /^(sidebar|details|composer-box|commit-info-box|sidebar-[^-]+)$/.test(
        root.id,
      )
    )
      root.backgroundColor = color("background.raised.base", theme.panel);
    else if (root.id === "history")
      root.backgroundColor = color("background.base", theme.bg);
    else if (root.id === "commit-body-box")
      root.backgroundColor = color("background.raised.high", theme.panelRaised);
  }
  bindings.get(root)?.(root);
  // Diff children own syntax and row styles. Do not overwrite nested code text.
  if (root.id === "commit-diff" || root.id.endsWith("-document")) return;
  for (const child of root.getChildren()) updateWidgetTheme(child);
}

export interface RuntimeThemeContext {
  readonly renderer: Pick<
    CliRenderer,
    "root" | "on" | "themeMode" | "setBackgroundColor"
  >;
  readonly repository: { root: string };
  readonly snapshot?: RepositorySnapshot;
  readonly view: "history" | "commit" | "working";
  readonly commitIndex: number;
  graphIndex: GraphIndex;
  readonly commitDiff: Pick<DiffView, "updateTheme">;
  readonly commitInfo: TextRenderable;
  readonly commitHeader: TextRenderable;
  readonly commitBody: TextRenderable;
  readonly commitCoAuthors: TextRenderable;
  readonly palette: Pick<RuntimePaletteController, "page">;
  /** The commit shown in the details pane, including a file-history commit. */
  selectedCommit(): RepositorySnapshot["commits"][number] | undefined;
  showCommandPalette(): void;
  notify(text: string, tone?: "info" | "error" | "busy"): void;
  paint(): void;
}

/** Owns the theme catalog and selection, and repaints the runtime on change. */
export class RuntimeThemeController {
  private catalog?: ThemeCatalog;
  selection: ThemeSelection = { name: "one-dark", mode: "dark" };

  constructor(private readonly context: RuntimeThemeContext) {}

  get entries() {
    return this.catalog?.entries ?? [];
  }

  configure(
    catalog: ThemeCatalog,
    selection: ThemeSelection,
    warning?: string,
  ) {
    const ctx = this.context;
    this.catalog = catalog;
    this.selection = selection;
    const warnings = [warning, ...catalog.errors].filter(Boolean);
    if (warnings.length) ctx.notify(warnings.join("; "), "error");
    ctx.renderer.on(CliRenderEvents.THEME_MODE, (mode: "dark" | "light") => {
      if (this.selection.mode === "system")
        void this.activate(this.selection, false, mode);
    });
    if (selection.mode === "system") void this.activate(selection, false);
  }

  async activate(
    selection: ThemeSelection,
    persist = true,
    appearance?: "dark" | "light",
    preview = false,
  ) {
    if (!this.catalog) return;
    try {
      const mode =
        selection.mode === "system"
          ? (appearance ?? this.context.renderer.themeMode ?? "dark")
          : selection.mode;
      setActiveTheme(this.catalog.resolve(selection.name, mode));
      if (!preview) this.selection = selection;
      this.repaint();
      if (persist) await saveThemePreferences(selection);
    } catch (error) {
      this.context.notify(
        `Theme change failed: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  }

  /** Apply the active theme to every widget, the graph colors, and the commit text. */
  repaint() {
    const ctx = this.context;
    ctx.renderer.setBackgroundColor(theme.bg);
    updateWidgetTheme(ctx.renderer.root);
    ctx.commitDiff.updateTheme();
    const commit = ctx.selectedCommit();
    if (commit && ctx.view === "commit") {
      const meta = presentCommitMeta(commit);
      ctx.commitInfo.content = meta.info;
      ctx.commitHeader.content = meta.header;
      ctx.commitBody.content = meta.body;
      ctx.commitCoAuthors.content = presentCommitCoAuthors(
        parseCoAuthors(commit.body),
      );
    }
    const snapshot = ctx.snapshot;
    const headSha = snapshot
      ? resolveHeadSha(snapshot.branches, snapshot.commits)
      : undefined;
    ctx.graphIndex = emptyGraphIndex(
      snapshot?.files.length ? headSha : undefined,
      theme.graph,
    );
    if (snapshot)
      extendGraphIndex(ctx.graphIndex, snapshot.commits, theme.graph, headSha);
    ctx.paint();
  }

  /** Reload the catalog for the "themes" page, then open the palette on `page`. */
  async showPicker(page: "themes" | "theme-mode") {
    const ctx = this.context;
    if (page === "themes") {
      const previous = this.catalog;
      const catalog = await loadThemeCatalog(ctx.repository.root);
      this.catalog = {
        ...catalog,
        entries: catalog.entries.some(
          (entry) => entry.name === this.selection.name,
        )
          ? catalog.entries
          : [
              ...catalog.entries,
              { name: this.selection.name, source: "active selection" },
            ],
        resolve: (name, mode) =>
          catalog.entries.some((entry) => entry.name === name)
            ? catalog.resolve(name, mode)
            : previous
              ? previous.resolve(name, mode)
              : catalog.resolve(name, mode),
      };
      if (catalog.errors.length) ctx.notify(catalog.errors.join("; "), "error");
    }
    ctx.palette.page = page;
    ctx.showCommandPalette();
  }
}
