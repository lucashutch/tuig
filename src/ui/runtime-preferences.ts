// Saved layout and session preferences: debounced writes and startup restore.
import type { DiffViewMode } from "./diff-view.js";
import type { HistoryColumns } from "./history-columns.js";
import { loadLayoutPreferences, saveLayoutPreferences } from "./preferences.js";
import type { SidebarSection } from "./runtime-presentation.js";
import { saveSessionPreferences } from "./session-preferences.js";

export const DEFAULT_REMOTE_FETCH_INTERVAL_MINUTES = 1;

export interface RuntimePreferencesContext {
  avatarsEnabled: boolean;
  diffViewPreference: DiffViewMode;
  leftWidth: number;
  detailsWidth: number;
  leftCollapsed: boolean;
  detailsCollapsed: boolean;
  historyColumns: HistoryColumns;
  preferredUnstagedHeight?: number;
  preferredComposerHeight?: number;
  sidebarPreferred: Record<SidebarSection, number | undefined>;
  sidebarCollapsed: Record<SidebarSection, boolean>;
  readonly repository: { root: string };
  readonly recentRepositories: string[];
  readonly tabs: readonly {
    repository: { root: string };
    submoduleOf?: { root: string; path: string };
  }[];
}

/** Owns the debounce timers that save layout and session preferences. */
export class RuntimePreferencesController {
  private layoutTimer?: ReturnType<typeof setTimeout>;
  private sessionTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly context: RuntimePreferencesContext) {}

  /**
   * Copy the saved layout onto the runtime. Returns the remote fetch interval,
   * which the runtime owns.
   */
  async restoreLayout(): Promise<number> {
    const ctx = this.context;
    const preferences = await loadLayoutPreferences();
    ctx.avatarsEnabled = preferences.avatarsEnabled ?? true;
    ctx.diffViewPreference = preferences.diffView ?? "side-by-side";
    ctx.leftWidth = preferences.leftWidth ?? ctx.leftWidth;
    ctx.detailsWidth = preferences.detailsWidth ?? ctx.detailsWidth;
    ctx.leftCollapsed = preferences.leftCollapsed ?? ctx.leftCollapsed;
    ctx.detailsCollapsed = preferences.detailsCollapsed ?? ctx.detailsCollapsed;
    ctx.historyColumns = {
      ...ctx.historyColumns,
      ...Object.fromEntries(
        Object.entries(preferences.historyColumns ?? {}).filter(
          ([, value]) => value !== undefined,
        ),
      ),
    };
    ctx.preferredUnstagedHeight = preferences.unstagedHeight;
    ctx.preferredComposerHeight = preferences.composerHeight;
    ctx.sidebarPreferred = {
      ...ctx.sidebarPreferred,
      ...preferences.sidebarHeights,
    };
    ctx.sidebarCollapsed = {
      ...ctx.sidebarCollapsed,
      ...preferences.sidebarCollapsed,
    };
    return (
      preferences.remoteFetchIntervalMinutes ??
      DEFAULT_REMOTE_FETCH_INTERVAL_MINUTES
    );
  }

  persistLayout() {
    if (this.layoutTimer) clearTimeout(this.layoutTimer);
    this.layoutTimer = setTimeout(() => {
      this.layoutTimer = undefined;
      void this.flushLayout().catch(() => undefined);
    }, 150);
  }

  async flushLayout() {
    const ctx = this.context;
    if (this.layoutTimer) {
      clearTimeout(this.layoutTimer);
      this.layoutTimer = undefined;
    }
    await saveLayoutPreferences({
      avatarsEnabled: ctx.avatarsEnabled,
      diffView: ctx.diffViewPreference,
      leftWidth: ctx.leftWidth,
      detailsWidth: ctx.detailsWidth,
      leftCollapsed: ctx.leftCollapsed,
      detailsCollapsed: ctx.detailsCollapsed,
      historyColumns: { ...ctx.historyColumns },
      unstagedHeight: ctx.preferredUnstagedHeight,
      composerHeight: ctx.preferredComposerHeight,
      sidebarHeights: ctx.sidebarPreferred,
      sidebarCollapsed: ctx.sidebarCollapsed,
    });
  }

  persistSession() {
    if (this.sessionTimer) clearTimeout(this.sessionTimer);
    this.sessionTimer = setTimeout(() => {
      this.sessionTimer = undefined;
      void this.flushSession().catch(() => undefined);
    }, 100);
  }

  async flushSession() {
    const ctx = this.context;
    if (this.sessionTimer) {
      clearTimeout(this.sessionTimer);
      this.sessionTimer = undefined;
    }
    await saveSessionPreferences({
      repositories: ctx.tabs.map((tab) => tab.repository.root),
      recentRepositories: ctx.recentRepositories,
      activeRepository: ctx.repository.root,
      submodules: Object.fromEntries(
        ctx.tabs
          .filter(
            (
              tab,
            ): tab is typeof tab & {
              submoduleOf: { root: string; path: string };
            } => Boolean(tab.submoduleOf),
          )
          .map((tab) => [tab.repository.root, tab.submoduleOf]),
      ),
    });
  }
}
