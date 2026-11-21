//! Themes: the catalog, the saved choice, live switching, and the picker pages of the palette. Ports
//! `src/ui/runtime-theme.ts` and the theme parts of `src/ui/runtime-palette.ts`.
//!
//! The shell owns the resolved [`Theme`] in [`ThemeState`]. A change goes through [`Shell::apply_theme`], which
//! recolors every widget, rebuilds the graph colors and marks everything dirty. A preview does the same without
//! saving. The picker restores the theme it found when it closes.

use crate::screens::palette::PalettePage;
use crate::shell::{Dirty, Shell};
use opentui::prelude::App;
use std::path::{Path, PathBuf};
use tuig_ui_model::command_palette::{CommandCategory, PaletteCommand};
use tuig_ui_model::graph_index::GraphIndex;
use tuig_ui_model::theme::{Theme, one_dark_theme};
use tuig_ui_model::theme_resolver::{ThemeError, ThemeMode};
use tuig_ui_model::theme_store::{
    ThemeCatalog, ThemeEntry, ThemeModeSelection, ThemeSelection, load_theme_catalog_from,
    load_theme_preferences_from, save_theme_preferences_to,
};
use tuig_widgets::decorations::resolve_head_sha;

/// The theme modes, in the order of the picker.
const MODES: [ThemeModeSelection; 3] = [
    ThemeModeSelection::Dark,
    ThemeModeSelection::Light,
    ThemeModeSelection::System,
];

pub fn mode_name(mode: ThemeModeSelection) -> &'static str {
    match mode {
        ThemeModeSelection::Dark => "dark",
        ThemeModeSelection::Light => "light",
        ThemeModeSelection::System => "system",
    }
}

pub struct ThemeState {
    /// The resolved theme every widget paints with. `activeTheme`.
    pub theme: Theme,
    pub selection: ThemeSelection,
    catalog: ThemeCatalog,
    /// The catalog before the last reload, kept while the selected theme has no file any more.
    previous: Option<ThemeCatalog>,
    /// The `tuig` configuration directory. `None` keeps the choice in memory and finds no custom themes, as tests do.
    config: Option<PathBuf>,
    /// The terminal's light or dark setting, once it has said so. The system mode follows it.
    pub appearance: Option<ThemeMode>,
    /// The theme to restore when the picker closes. Set while a picker page is open.
    original: Option<Theme>,
    /// The id of the previewed row, so a repaint does not preview it again.
    preview: Option<String>,
    /// The palette moved, so the next sync previews the selected row.
    preview_due: bool,
}

/// What start-up found: the state, and a message for the footer when something could not load.
pub struct InitialTheme {
    pub state: ThemeState,
    pub warning: Option<String>,
}

fn builtin_catalog() -> ThemeCatalog {
    // A directory that does not exist, so only the built-in themes load.
    load_theme_catalog_from(Path::new(""), None)
}

fn default_selection() -> ThemeSelection {
    ThemeSelection {
        name: "one-dark".to_owned(),
        mode: ThemeModeSelection::System,
    }
}

fn resolve_mode(mode: ThemeModeSelection, appearance: Option<ThemeMode>) -> ThemeMode {
    match mode {
        ThemeModeSelection::Dark => ThemeMode::Dark,
        ThemeModeSelection::Light => ThemeMode::Light,
        ThemeModeSelection::System => appearance.unwrap_or(ThemeMode::Dark),
    }
}

impl ThemeState {
    /// `loadInitialTheme`. `config` is the `tuig` configuration directory, and `repository_root` finds the
    /// `.tuig/themes` directories. Without `config` the built-in themes and the default choice apply.
    pub fn load(
        config: Option<&Path>,
        repository_root: Option<&Path>,
        appearance: Option<ThemeMode>,
    ) -> InitialTheme {
        let catalog = match config {
            Some(config) => load_theme_catalog_from(config, repository_root),
            None => builtin_catalog(),
        };
        let mut warnings: Vec<String> = catalog.errors.clone();
        let loaded = match config {
            Some(config) => load_theme_preferences_from(config),
            None => Ok(default_selection()),
        }
        .and_then(|selection| {
            let mode = resolve_mode(selection.mode, appearance);
            catalog
                .resolve(&selection.name, mode)
                .map(|theme| (selection, theme))
        });
        let (selection, theme) = match loaded {
            Ok(found) => found,
            Err(error) => {
                warnings.insert(
                    0,
                    format!("Theme settings could not be loaded. Using One Dark: {error}"),
                );
                (
                    ThemeSelection {
                        name: "one-dark".to_owned(),
                        mode: ThemeModeSelection::Dark,
                    },
                    one_dark_theme(),
                )
            }
        };
        InitialTheme {
            state: ThemeState {
                theme,
                selection,
                catalog,
                previous: None,
                config: config.map(Path::to_path_buf),
                appearance,
                original: None,
                preview: None,
                preview_due: false,
            },
            warning: (!warnings.is_empty()).then(|| warnings.join("; ")),
        }
    }

    fn entries(&self) -> Vec<ThemeEntry> {
        self.catalog.entries()
    }

    fn resolve(
        &self,
        selection: &ThemeSelection,
        appearance: Option<ThemeMode>,
    ) -> Result<Theme, ThemeError> {
        let mode = resolve_mode(selection.mode, appearance.or(self.appearance));
        let known = self
            .catalog
            .entries()
            .iter()
            .any(|entry| entry.name == selection.name);
        match &self.previous {
            Some(previous) if !known => previous.resolve(&selection.name, mode),
            _ => self.catalog.resolve(&selection.name, mode),
        }
    }
}

impl Shell {
    /// `showPicker`. Reloads the catalog for the themes page, then opens the palette on `page`.
    pub(crate) fn show_theme_picker(&mut self, app: &App, page: PalettePage) {
        if page == PalettePage::Themes {
            let root = std::path::PathBuf::from(self.repo.root());
            let fresh = match &self.themes.config {
                Some(config) => load_theme_catalog_from(config, Some(&root)),
                None => builtin_catalog(),
            };
            let errors = fresh.errors.join("; ");
            let selected = self.themes.selection.name.clone();
            let kept = fresh.entries().iter().any(|entry| entry.name == selected);
            let old = std::mem::replace(&mut self.themes.catalog, fresh);
            self.themes.previous = (!kept).then_some(old);
            if !errors.is_empty() {
                self.notify_error(errors);
            }
        }
        self.open_palette(app, page);
    }

    /// The rows of a picker page. The theme list marks the selected theme, and the mode list the selected mode.
    pub(crate) fn theme_page_commands(&self, page: PalettePage) -> Vec<PaletteCommand> {
        let current = |name: &str, active: bool| {
            if active {
                format!("{name} (current)")
            } else {
                name.to_owned()
            }
        };
        match page {
            PalettePage::Themes => {
                let mut entries = self.themes.entries();
                if !entries
                    .iter()
                    .any(|entry| entry.name == self.themes.selection.name)
                {
                    entries.push(ThemeEntry {
                        name: self.themes.selection.name.clone(),
                        source: "active selection".to_owned(),
                    });
                }
                entries
                    .into_iter()
                    .map(|entry| {
                        PaletteCommand::new(
                            format!("theme.{}", entry.name),
                            current(&entry.name, entry.name == self.themes.selection.name),
                            CommandCategory::Settings,
                        )
                    })
                    .collect()
            }
            PalettePage::ThemeMode => MODES
                .iter()
                .map(|mode| {
                    let name = mode_name(*mode);
                    PaletteCommand::new(
                        format!("theme-mode.{name}"),
                        current(name, *mode == self.themes.selection.mode),
                        CommandCategory::Settings,
                    )
                })
                .collect(),
            PalettePage::Commands => Vec::new(),
        }
    }

    /// The picker opened: remember the theme to restore.
    pub(crate) fn theme_picker_opened(&mut self) {
        self.themes.original = Some(self.themes.theme.clone());
        self.themes.preview = None;
        self.themes.preview_due = true;
    }

    /// The picker closed: put back the theme it found.
    pub(crate) fn theme_picker_closed(&mut self, app: &App) {
        self.themes.preview = None;
        self.themes.preview_due = false;
        if let Some(original) = self.themes.original.take() {
            self.apply_theme(app, original);
        }
    }

    /// The palette selection may have moved. The next sync previews it.
    pub(crate) fn theme_preview_due(&mut self) {
        if self.themes.original.is_some() {
            self.themes.preview_due = true;
        }
    }

    pub(crate) fn sync_theme(&mut self, app: &App) {
        if std::mem::take(&mut self.themes.preview_due) {
            self.preview_theme(app);
        }
    }

    /// The selection a picker row stands for.
    fn picked_selection(&self, page: PalettePage, id: &str) -> Option<ThemeSelection> {
        let current = self.themes.selection.clone();
        match page {
            PalettePage::Themes => Some(ThemeSelection {
                name: id.strip_prefix("theme.")?.to_owned(),
                ..current
            }),
            PalettePage::ThemeMode => Some(ThemeSelection {
                mode: *MODES
                    .iter()
                    .find(|mode| id.strip_prefix("theme-mode.") == Some(mode_name(**mode)))?,
                ..current
            }),
            PalettePage::Commands => None,
        }
    }

    /// `previewTheme`.
    fn preview_theme(&mut self, app: &App) {
        let Some(original) = self.themes.original.clone() else {
            return;
        };
        let Some(palette) = &self.overlay.palette else {
            return;
        };
        let page = palette.page;
        let id = usize::try_from(palette.index)
            .ok()
            .and_then(|index| palette.matches.get(index))
            .filter(|command| command.is_enabled())
            .map(|command| command.id.clone())
            .unwrap_or_default();
        if self.themes.preview.as_deref() == Some(id.as_str()) {
            return;
        }
        self.themes.preview = Some(id.clone());
        if id.is_empty() {
            return self.apply_theme(app, original);
        }
        if let Some(selection) = self.picked_selection(page, &id) {
            self.activate_theme(app, selection, false, None, true);
        }
    }

    /// A picker row was chosen. The picker has closed and restored the old theme.
    pub(crate) fn theme_picked(&mut self, app: &App, page: PalettePage, id: &str) {
        if let Some(selection) = self.picked_selection(page, id) {
            self.activate_theme(app, selection, true, None, false);
        }
    }

    /// `activate`. A preview changes the colors only. Otherwise the selection is kept, and saved when `persist`.
    pub(crate) fn activate_theme(
        &mut self,
        app: &App,
        selection: ThemeSelection,
        persist: bool,
        appearance: Option<ThemeMode>,
        preview: bool,
    ) {
        match self.themes.resolve(&selection, appearance) {
            Ok(theme) => {
                if !preview {
                    self.themes.selection = selection.clone();
                }
                self.apply_theme(app, theme);
            }
            Err(error) => {
                return self.notify_error(format!("Theme change failed: {error}"));
            }
        }
        if persist
            && let Some(config) = &self.themes.config
            && let Err(error) = save_theme_preferences_to(config, &selection)
        {
            self.notify_error(format!("Theme change failed: {error}"));
        }
    }

    /// The terminal changed between light and dark. The system mode follows it.
    pub(crate) fn terminal_appearance_changed(&mut self, app: &App, mode: ThemeMode) {
        self.themes.appearance = Some(mode);
        if self.themes.selection.mode == ThemeModeSelection::System {
            let selection = self.themes.selection.clone();
            self.activate_theme(app, selection, false, Some(mode), false);
        }
    }

    /// `repaint`: gives every widget the new colors, rebuilds the graph colors, and marks everything dirty.
    pub(crate) fn apply_theme(&mut self, app: &App, theme: Theme) {
        self.themes.theme = theme.clone();
        self.sidebar.set_theme(&theme);
        self.widgets.set_theme(app, &theme);
        let history = &mut self.history;
        history.colors = theme.graph.iter().map(|color| color.to_hex()).collect();
        if let Some(snapshot) = &self.snapshot {
            let head = resolve_head_sha(&snapshot.branches, &history.commits);
            let working_parent = head.clone().filter(|_| !snapshot.files.is_empty());
            history.index = GraphIndex::new(working_parent.as_deref(), &history.colors);
            history
                .index
                .extend(&history.commits, &history.colors, head.as_deref())
                .expect("a new index takes any commit list");
        }
        self.dirty = Dirty::all();
    }
}

#[cfg(test)]
#[path = "theme_tests.rs"]
mod tests;
