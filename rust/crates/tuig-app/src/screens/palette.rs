//! The command palette. Ports `src/ui/runtime-palette.ts`. Matching and ranking come from
//! `tuig_ui_model::command_palette`.
//!
//! The command list is rebuilt on every repaint, so availability follows the repository. A command is a
//! [`PaletteCommand`] with an id. [`Shell::run_palette_command`] maps the id to its action. Commands whose feature
//! is not ported yet show a notice when run: themes, repository tabs, the composer, pull requests, the branch
//! filter and the layout preferences. Replace the notice with the real action when the feature arrives.

use crate::screens::files::Focus;
use crate::shell::{Dirty, Shell};
use opentui::prelude::*;
use tuig_ui_model::command_palette::{
    CommandCategory, PaletteCommand, PaletteMatch, clamp_palette_viewport, command_matches,
    next_enabled_command,
};
use tuig_widgets::popup::{PaletteRowView, PaletteView};

/// Repository tabs are not ported. The palette treats the app as having one tab.
const TAB_COUNT: usize = 1;

#[derive(Default)]
pub struct PaletteState {
    /// The selected match, or -1 when nothing can be selected.
    pub index: isize,
    pub start: i64,
    /// Result rows on screen.
    pub rows: i64,
    pub matches: Vec<PaletteCommand>,
    left: i64,
    top: i64,
    width: i64,
    height: i64,
}

impl PaletteState {
    pub fn view(&self) -> PaletteView {
        let visible = self
            .matches
            .iter()
            .enumerate()
            .skip(self.start.max(0) as usize)
            .take(self.rows.max(0) as usize);
        PaletteView {
            left: self.left,
            top: self.top,
            width: self.width,
            height: self.height,
            rows: visible
                .map(|(index, command)| PaletteRowView {
                    title: command.title.clone(),
                    detail: if command.is_enabled() {
                        command.shortcut.clone().unwrap_or_default()
                    } else {
                        command
                            .disabled_reason
                            .clone()
                            .unwrap_or_else(|| "Unavailable".to_owned())
                    },
                    selected: index as isize == self.index,
                    disabled: !command.is_enabled(),
                })
                .collect(),
            visible_rows: self.rows,
        }
    }

    fn match_list(&self) -> Vec<PaletteMatch<'_>> {
        self.matches
            .iter()
            .map(|command| PaletteMatch { command, score: 0 })
            .collect()
    }
}

fn command(id: &str, title: &str, category: CommandCategory) -> PaletteCommand {
    PaletteCommand::new(id, title, category)
}

fn with(mut command: PaletteCommand, keywords: &[&str], shortcut: Option<&str>) -> PaletteCommand {
    command.keywords = keywords.iter().map(|word| (*word).to_owned()).collect();
    command.shortcut = shortcut.map(str::to_owned);
    command
}

impl Shell {
    /// The mutation that blocks repository commands, as a reason.
    fn busy_reason(&self) -> Option<String> {
        self.diff
            .mutation
            .as_ref()
            .map(|label| format!("{label} is still running"))
    }

    /// Every command, in the order of `RuntimePaletteController.commands`.
    fn palette_commands(&self) -> Vec<PaletteCommand> {
        use CommandCategory::*;
        let snapshot = self.snapshot.as_ref();
        let busy = self.busy_reason();
        let availability = |mut command: PaletteCommand, enabled: bool, reason: &str| {
            command.enabled = Some(enabled && busy.is_none());
            command.disabled_reason = busy
                .clone()
                .or_else(|| (!enabled).then(|| reason.to_owned()));
            command
        };
        let selected = self.files.selected.as_ref().and_then(|selected| {
            snapshot.and_then(|snapshot| {
                snapshot
                    .files
                    .iter()
                    .find(|file| file.path == selected.path)
            })
        });
        let loading = "Repository is loading";
        let working_files = snapshot.map_or(0, |snapshot| snapshot.files.len());
        let unstaged = snapshot.map_or(0, |snapshot| {
            snapshot.files.iter().filter(|file| file.unstaged).count()
        });
        let staged = snapshot.map_or(0, |snapshot| {
            snapshot.files.iter().filter(|file| file.staged).count()
        });
        let has_upstream = snapshot.is_some_and(|snapshot| snapshot.upstream.is_some());
        let stashes = snapshot.map_or(0, |snapshot| snapshot.stashes.len());
        let mut commands = vec![
            command("theme.change", "Change theme", Settings),
            command("theme.mode", "Change theme mode", Settings),
            availability(
                with(
                    command("repository.refresh", "Refresh repository", Repository),
                    &["reload", "status"],
                    Some("r"),
                ),
                snapshot.is_some(),
                loading,
            ),
            availability(
                with(
                    command("repository.fetch", "Fetch remotes", Repository),
                    &[],
                    Some("f"),
                ),
                snapshot.is_some(),
                loading,
            ),
            availability(
                with(
                    command("repository.pull", "Pull current branch", Repository),
                    &[],
                    Some("l"),
                ),
                has_upstream,
                "No upstream branch",
            ),
            availability(
                with(
                    command("repository.push", "Push current branch", Repository),
                    &[],
                    Some("p"),
                ),
                has_upstream,
                "No upstream branch",
            ),
            availability(
                command("repository.stash", "Stash working changes", Repository),
                working_files > 0,
                "No changes to stash",
            ),
            availability(
                command("repository.pop-stash", "Pop latest stash", Repository),
                stashes > 0,
                "No stash to pop",
            ),
        ];
        // TODO: pull requests. TS lists these when pull request support is on.
        commands.push(with(
            command("pull-requests.refresh", "Refresh pull requests", Repository),
            &["github", "pr", "checks"],
            None,
        ));
        let mut open_pull_request = with(
            command(
                "pull-requests.open-current",
                "Open pull request for current branch",
                Repository,
            ),
            &["github", "pr", "browser"],
            None,
        );
        open_pull_request.enabled = Some(false);
        open_pull_request.disabled_reason =
            Some("No open pull request for the current branch".to_owned());
        commands.push(open_pull_request);
        commands.push(with(
            command("repository.open", "Open new repository tab", Repository),
            &["add tab", "open repository"],
            Some("Ctrl+T"),
        ));
        commands.push(availability(
            with(
                command(
                    "repository.close",
                    "Close current repository tab",
                    Repository,
                ),
                &[],
                Some("Ctrl+W"),
            ),
            TAB_COUNT > 1,
            "Cannot close the only repository tab",
        ));
        // TODO: the composer. It is never active until it exists.
        commands.push(with(
            command("changes.commit", "Compose commit", Changes),
            &[],
            Some("c"),
        ));
        commands.push(availability(
            with(
                command("changes.stage-selected", "Stage selected file", Changes),
                &[],
                Some("s"),
            ),
            selected.is_some_and(|file| file.unstaged),
            "No unstaged file selected",
        ));
        commands.push(availability(
            with(
                command("changes.unstage-selected", "Unstage selected file", Changes),
                &[],
                Some("u"),
            ),
            selected.is_some_and(|file| file.staged),
            "No staged file selected",
        ));
        commands.push(availability(
            with(
                command("changes.stage-all", "Stage all changes", Changes),
                &[],
                Some("a"),
            ),
            unstaged > 0,
            "No unstaged changes",
        ));
        commands.push(availability(
            command("changes.unstage-all", "Unstage all changes", Changes),
            staged > 0,
            "No staged changes",
        ));
        commands.push(availability(
            command(
                "changes.discard-all",
                "Discard all unstaged changes",
                Changes,
            ),
            unstaged > 0,
            "No unstaged changes",
        ));
        let mut filter = with(
            command(
                "navigation.filter-branches",
                "Filter and checkout branches",
                Navigation,
            ),
            &["switch", "find branch"],
            Some("/"),
        );
        filter.enabled = Some(snapshot.is_some());
        filter.disabled_reason = snapshot.is_none().then(|| loading.to_owned());
        commands.push(filter);
        commands.push(command(
            "navigation.history",
            "Focus commit history",
            Navigation,
        ));
        commands.push(command(
            "navigation.changes",
            "Focus changed files",
            Navigation,
        ));
        commands.push(availability(
            with(
                command("navigation.next-tab", "Next repository tab", Navigation),
                &[],
                Some("Ctrl+Tab"),
            ),
            TAB_COUNT > 1,
            "Only one repository tab is open",
        ));
        commands.push(availability(
            with(
                command(
                    "navigation.previous-tab",
                    "Previous repository tab",
                    Navigation,
                ),
                &[],
                Some("Ctrl+Shift+Tab"),
            ),
            TAB_COUNT > 1,
            "Only one repository tab is open",
        ));
        commands.push(with(
            command(
                "view.sidebar",
                &format!(
                    "{} left panel",
                    if self.layout.left_collapsed {
                        "Expand"
                    } else {
                        "Collapse"
                    }
                ),
                View,
            ),
            &["lhs", "sidebar", "branches", "show", "hide"],
            Some("["),
        ));
        commands.push(with(
            command(
                "view.details",
                &format!(
                    "{} right panel",
                    if self.layout.details_collapsed {
                        "Expand"
                    } else {
                        "Collapse"
                    }
                ),
                View,
            ),
            &["rhs", "details", "show", "hide"],
            Some("]"),
        ));
        commands.push(with(
            command(
                "settings.avatars",
                &format!(
                    "{} author avatars",
                    if self.avatars_enabled {
                        "Disable"
                    } else {
                        "Enable"
                    }
                ),
                Settings,
            ),
            &["images", "privacy", "remote"],
            None,
        ));
        commands
    }

    /// Ctrl+P: opens the palette, or closes it when it is open. `show`.
    pub(crate) fn toggle_palette(&mut self, app: &App) {
        if self.overlay.palette.is_some() {
            return self.close_palette(app, true);
        }
        self.close_popup(app);
        self.remember_focus(app);
        self.widgets.overlay.palette_input.set_value("");
        self.overlay.palette = Some(PaletteState::default());
        self.repaint_palette_state();
        self.widgets.overlay.palette_input.visible(true);
        self.widgets.overlay.palette_input.focus();
    }

    pub(crate) fn close_palette(&mut self, app: &App, restore: bool) {
        if self.overlay.palette.take().is_none() {
            return;
        }
        self.dirty |= Dirty::OVERLAY;
        if restore {
            self.restore_focus(app);
        } else {
            self.overlay.previous_focus = None;
        }
    }

    /// The search text changed: restart from the top. `queryChanged`.
    pub(crate) fn palette_query_changed(&mut self) {
        if let Some(palette) = &mut self.overlay.palette {
            palette.index = 0;
            palette.start = 0;
            self.repaint_palette_state();
        }
    }

    /// Recomputes matches, selection, viewport and placement. `paint`.
    pub(crate) fn repaint_palette_state(&mut self) {
        if self.overlay.palette.is_none() {
            return;
        }
        let query = self.widgets.overlay.palette_input.value();
        let commands = self.palette_commands();
        let terminal_width = i64::from(self.layout.width).max(1);
        let terminal_height = i64::from(self.layout.height).max(1);
        let Some(palette) = &mut self.overlay.palette else {
            return;
        };
        let matches: Vec<PaletteCommand> = command_matches(&commands, &query)
            .into_iter()
            .map(|found| found.command.clone())
            .collect();
        let width = (terminal_width - 2).clamp(1, 76);
        // Room for the search field, spacing, footer and outer padding.
        palette.rows = (matches.len() as i64)
            .min(12)
            .min(terminal_height - 7)
            .max(1);
        palette.left = ((terminal_width - width) / 2).max(0);
        palette.top = ((terminal_height - palette.rows - 7) / 3).max(0);
        palette.width = width;
        palette.height = terminal_height.min(palette.rows + 7);
        palette.matches = matches;
        let count = palette.matches.len() as isize;
        if count == 0 {
            palette.index = -1;
        } else if palette.index < 0
            || palette.index >= count
            || !palette.matches[palette.index as usize].is_enabled()
        {
            palette.index = next_enabled_command(&palette.match_list(), -1, 1);
        }
        palette.start = clamp_palette_viewport(
            palette.index as i64,
            palette.start,
            palette.rows,
            count as i64,
        );
        self.dirty |= Dirty::OVERLAY;
    }

    pub(crate) fn palette_move(&mut self, delta: isize) {
        let Some(palette) = &mut self.overlay.palette else {
            return;
        };
        let direction = delta.signum();
        for _ in 0..delta.unsigned_abs() {
            palette.index = next_enabled_command(&palette.match_list(), palette.index, direction);
        }
        self.repaint_palette_state();
    }

    /// Page Up and Page Down move by the visible rows.
    pub(crate) fn palette_page(&mut self, direction: isize) {
        let rows = self
            .overlay
            .palette
            .as_ref()
            .map_or(0, |palette| palette.rows);
        self.palette_move(direction * rows as isize);
    }

    /// The pointer is over result `row`. Moves the selection to an enabled command. `hoverRow`.
    pub(crate) fn palette_hover(&mut self, row: usize) {
        let Some(palette) = &mut self.overlay.palette else {
            return;
        };
        let index = palette.start.max(0) as usize + row;
        let enabled = palette
            .matches
            .get(index)
            .is_some_and(PaletteCommand::is_enabled);
        if !enabled || index as isize == palette.index {
            return;
        }
        palette.index = index as isize;
        self.repaint_palette_state();
    }

    /// A left press on result `row` runs it. `activateRow`.
    pub(crate) fn palette_click(&mut self, app: &App, row: usize, button: MouseButton) {
        if button != MouseButton::Left {
            return;
        }
        let Some(palette) = &mut self.overlay.palette else {
            return;
        };
        let index = palette.start.max(0) as usize + row;
        if !palette
            .matches
            .get(index)
            .is_some_and(PaletteCommand::is_enabled)
        {
            return;
        }
        palette.index = index as isize;
        self.palette_activate(app);
    }

    /// Runs the selected command if it is still available. `activate`.
    pub(crate) fn palette_activate(&mut self, app: &App) {
        let Some(palette) = &self.overlay.palette else {
            return;
        };
        let Some(selected) = usize::try_from(palette.index)
            .ok()
            .and_then(|index| palette.matches.get(index))
            .filter(|command| command.is_enabled())
        else {
            return;
        };
        let id = selected.id.clone();
        let still_enabled = self
            .palette_commands()
            .iter()
            .any(|command| command.id == id && command.is_enabled());
        if !still_enabled {
            return self.repaint_palette_state();
        }
        self.close_palette(app, true);
        self.run_palette_command(app, &id);
    }

    fn run_palette_command(&mut self, app: &App, id: &str) {
        let repo = self.repo.clone();
        match id {
            "repository.refresh" => self.request_refresh(app, false),
            "repository.fetch" => {
                self.perform_remote(app, "Fetching…", move |repo, cancel| async move {
                    repo.fetch(None, Some(&cancel)).await
                })
            }
            "repository.pull" => {
                self.perform_remote(app, "Pulling…", move |repo, cancel| async move {
                    repo.pull(false, Some(&cancel)).await
                })
            }
            "repository.push" => {
                self.perform_remote(app, "Pushing…", move |repo, cancel| async move {
                    repo.push(None, false, Some(&cancel)).await
                })
            }
            "repository.stash" => {
                self.perform(
                    app,
                    "Stashing…",
                    async move { repo.stash(None, true).await },
                )
            }
            "repository.pop-stash" => {
                let stash = self
                    .snapshot
                    .as_ref()
                    .and_then(|snapshot| snapshot.stashes.first().cloned());
                match stash {
                    Some(stash) => {
                        self.perform(app, &format!("Popping {}…", stash.reference), async move {
                            repo.apply_stash(&stash.reference, true).await
                        })
                    }
                    None => self.notify("No stash to pop"),
                }
            }
            "changes.stage-selected" | "changes.unstage-selected" => {
                let Some(path) = self.files.selected.as_ref().map(|file| file.path.clone()) else {
                    return;
                };
                let staging = id == "changes.stage-selected";
                let label = format!("{} {path}…", if staging { "Staging" } else { "Unstaging" });
                self.perform(app, &label, async move {
                    if staging {
                        repo.stage(&[path]).await
                    } else {
                        repo.unstage(&[path]).await
                    }
                });
            }
            "changes.stage-all" => self.stage_all(app),
            "changes.unstage-all" => self.unstage_all(app),
            "changes.discard-all" => self.discard_all(app),
            "navigation.history" => {
                self.files.focus = Focus::History;
                self.dirty |= Dirty::FILES | Dirty::HISTORY;
            }
            "navigation.changes" => self.focus_changes(),
            "view.sidebar" => {
                self.layout
                    .set_collapsed(!self.layout.left_collapsed, self.layout.details_collapsed);
                self.dirty |= Dirty::all();
            }
            "view.details" => {
                self.layout
                    .set_collapsed(self.layout.left_collapsed, !self.layout.details_collapsed);
                self.dirty |= Dirty::all();
            }
            "settings.avatars" => {
                self.avatars_enabled = !self.avatars_enabled;
                self.notify(if self.avatars_enabled {
                    "Author avatars on"
                } else {
                    "Author avatars off"
                });
            }
            "theme.change" | "theme.mode" => self.notify("Themes are not available yet"),
            "repository.open" => self.notify("Repository tabs are not available yet"),
            "changes.commit" => self.notify("The commit composer is not available yet"),
            "navigation.filter-branches" => self.notify("The branch filter is not available yet"),
            "pull-requests.refresh" => self.notify("Pull requests are not available yet"),
            _ => {}
        }
    }
}
