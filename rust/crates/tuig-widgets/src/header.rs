//! The header: the repository tab strip on row 0, and on rows 1 and 2 the repository summary, the toolbar and the
//! avatar and diff view toggles. Ports `paintTabs` in `src/ui/runtime-tabs.ts`, `renderHeader` and
//! `renderToolbar` in `src/ui/runtime-presentation-chrome.ts`, `RuntimeToolbarController`, and the two toggle
//! buttons of `src/ui/runtime-widgets.ts`.
//!
//! One [`Component`] covers all three rows. The shell pushes a [`HeaderView`] and receives [`HeaderEvent`]s. The
//! widget keeps only pointer state: the hovered and pressed button, and the tab being dragged.
//!
//! Known gap: `Widget::on_hover` reports `false` when the pointer leaves (with `MouseTracking::Motion`), but Rust does
//! not use `on_hover(false)` yet. A hover highlight stays until the pointer moves over another cell of the header.

use crate::decorations::display_branch_name;
use opentui::prelude::*;
use tuig_ui_model::color::Rgba;
use tuig_ui_model::graph_menu::clip_columns;
use tuig_ui_model::repository_tabs::{
    RepositoryTab, RepositoryTabHit, layout_repository_tabs, repository_tab_hit,
    repository_tab_text,
};
use tuig_ui_model::text_width::string_width;
use tuig_ui_model::theme::{Surface, Theme, ThemeStates, interaction_background, semantic_color};
use tuig_ui_model::toolbar::{
    ToolbarAction, ToolbarButton, ToolbarCell, centre, layout_toolbar, toolbar_hit,
};

/// Width of the avatar toggle, `right: 1` from the edge. `avatar-toggle` in `runtime-widgets.ts`.
const AVATAR_TOGGLE_WIDTH: usize = 9;
const AVATAR_TOGGLE_RIGHT: usize = 1;
/// Width of the diff view toggle, `right: 11` from the edge. `diff-view-toggle`.
const DIFF_TOGGLE_WIDTH: usize = 16;
const DIFF_TOGGLE_RIGHT: usize = 11;
/// Columns kept clear to the right of the busy text.
const BUSY_INSET: usize = 4;

/// What the summary shows once the first snapshot has loaded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SummaryState {
    /// `None` for a detached HEAD.
    pub branch: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub has_upstream: bool,
    pub changed: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HeaderView {
    pub tabs: Vec<RepositoryTab>,
    pub active_tab: Option<String>,
    /// The folder name of the active repository.
    pub name: String,
    /// `None` while the first snapshot loads.
    pub summary: Option<SummaryState>,
    pub buttons: Vec<ToolbarButton>,
    /// Progress text with its spinner frame, shown at the right end of the label row.
    pub busy: Option<String>,
    pub avatars_enabled: bool,
    /// The diff view toggle's text. `None` hides the toggle, as it is hidden while no diff shows.
    pub diff_toggle: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HeaderEvent {
    /// A left press on a tab. Starts a drag.
    TabSelect(String),
    TabClose(String),
    /// A middle press on a tab.
    TabMiddleClose(String),
    TabOpen,
    /// The pointer is at column `x` while dragging tab `id`.
    TabDrag {
        id: String,
        x: usize,
    },
    Toolbar(ToolbarAction),
    ToggleAvatars,
    ToggleDiffView,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Target {
    Tab(String),
    Open,
    Toolbar(ToolbarAction),
    Avatars,
    DiffView,
}

type EventHandler = Box<dyn FnMut(&mut Cx<'_>, HeaderEvent)>;

pub struct HeaderBar {
    theme: Theme,
    view: HeaderView,
    hovered: Option<Target>,
    /// The button under a left press, which runs when the release lands on it.
    pressed: Option<Target>,
    dragging: Option<String>,
    /// The width of the last paint, for hit tests.
    width: std::cell::Cell<usize>,
    on_event: Option<EventHandler>,
}

/// A run of spaces with a foreground, because the TS cells carry one and the parity check compares it.
fn blank(painter: &mut Painter<'_>, x: usize, y: i32, width: usize, bg: Color, fg: Color) {
    painter.text(x as i32, y, &" ".repeat(width), Style::new().bg(bg).fg(fg));
}

fn to_color(color: Rgba) -> Color {
    Color::rgba(color.r, color.g, color.b, color.a)
}

impl HeaderBar {
    pub fn new(theme: Theme) -> Self {
        Self {
            theme,
            view: HeaderView::default(),
            hovered: None,
            pressed: None,
            dragging: None,
            width: std::cell::Cell::new(0),
            on_event: None,
        }
    }

    pub fn set_view(&mut self, view: HeaderView) {
        self.view = view;
    }

    /// The handler must not call `Custom::update` or `Custom::with` on this widget. Queue a message instead.
    pub fn on_event(&mut self, handler: impl FnMut(&mut Cx<'_>, HeaderEvent) + 'static) {
        self.on_event = Some(Box::new(handler));
    }

    fn emit(&mut self, cx: &mut Cx<'_>, event: HeaderEvent) {
        if let Some(handler) = self.on_event.as_mut() {
            handler(cx, event);
        }
    }

    fn toolbar_cells(&self, width: usize) -> Vec<ToolbarCell> {
        layout_toolbar(self.view.buttons.clone(), width)
    }

    fn avatar_range(width: usize) -> (usize, usize) {
        let end = width.saturating_sub(AVATAR_TOGGLE_RIGHT);
        (end.saturating_sub(AVATAR_TOGGLE_WIDTH), end)
    }

    fn diff_range(width: usize) -> (usize, usize) {
        let end = width.saturating_sub(DIFF_TOGGLE_RIGHT);
        (end.saturating_sub(DIFF_TOGGLE_WIDTH), end)
    }

    /// What the pointer is over at column `x` of header row `y`.
    fn target_at(&self, x: usize, y: usize) -> Option<Target> {
        let width = self.width.get();
        if y == 0 {
            let layout =
                layout_repository_tabs(&self.view.tabs, self.view.active_tab.as_deref(), width);
            return match repository_tab_hit(&layout, x)? {
                RepositoryTabHit::Open => Some(Target::Open),
                RepositoryTabHit::Select(id) | RepositoryTabHit::Close(id) => Some(Target::Tab(id)),
            };
        }
        let within = |(start, end): (usize, usize)| x >= start && x < end;
        if y == 1 {
            // The toggles sit above the toolbar's label row.
            if within(Self::avatar_range(width)) {
                return Some(Target::Avatars);
            }
            if self.view.diff_toggle.is_some() && within(Self::diff_range(width)) {
                return Some(Target::DiffView);
            }
        }
        toolbar_hit(&self.toolbar_cells(width), x).map(Target::Toolbar)
    }

    fn state(&self, button: &Target) -> ThemeStates {
        ThemeStates {
            hovered: self.hovered.as_ref() == Some(button),
            pressed: self.pressed.as_ref() == Some(button),
            ..ThemeStates::default()
        }
    }

    fn semantic(&self, path: &str, fallback: Rgba, states: ThemeStates) -> Color {
        to_color(semantic_color(
            &self.theme,
            path,
            fallback,
            Surface::Default,
            states,
        ))
    }

    fn paint_tabs(&self, painter: &mut Painter<'_>, width: usize) {
        let theme = &self.theme;
        blank(
            painter,
            0,
            0,
            width,
            to_color(theme.panel_raised),
            to_color(theme.text),
        );
        let layout =
            layout_repository_tabs(&self.view.tabs, self.view.active_tab.as_deref(), width);
        for tab in &layout.tabs {
            let hovered = self.hovered == Some(Target::Tab(tab.id.clone()));
            let states = ThemeStates {
                selected: tab.active,
                hovered,
                ..ThemeStates::default()
            };
            let base = interaction_background(theme, theme.panel, false, tab.active, hovered);
            let bg = self.semantic("background.action.secondary", base, states);
            let fg = self.semantic(
                "text.action.secondary",
                if tab.active {
                    theme.accent
                } else {
                    theme.muted
                },
                ThemeStates {
                    selected: tab.active,
                    ..ThemeStates::default()
                },
            );
            painter.text(
                tab.start as i32,
                0,
                &repository_tab_text(tab),
                Style::new().bg(bg).fg(fg),
            );
        }
        let (start, end) = layout.open;
        let hovered = self.hovered == Some(Target::Open);
        let states = ThemeStates {
            hovered,
            ..ThemeStates::default()
        };
        let base = interaction_background(theme, theme.panel_raised, false, false, hovered);
        let label: String = " + ".chars().take(end - start).collect();
        painter.text(
            start as i32,
            0,
            &label,
            Style::new()
                .bg(self.semantic("background.action.secondary", base, states))
                .fg(self.semantic(
                    "text.action.secondary",
                    theme.accent,
                    ThemeStates::default(),
                )),
        );
    }

    /// The two toolbar rows: labels, then glyphs. `renderToolbar`.
    fn paint_toolbar(&self, painter: &mut Painter<'_>, width: usize, cells: &[ToolbarCell]) {
        let theme = &self.theme;
        let raised = to_color(theme.panel_raised);
        let text = to_color(theme.text);
        blank(painter, 0, 1, width, raised, text);
        blank(painter, 0, 2, width, raised, text);
        for cell in cells {
            let button = &cell.button;
            let target = Target::Toolbar(button.id);
            let mut states = self.state(&target);
            states.disabled = !button.enabled;
            states.pressed &= button.enabled;
            states.hovered &= button.enabled;
            let label_color = self.semantic(
                "text.action.secondary",
                if button.enabled {
                    theme.text
                } else {
                    theme.border
                },
                states,
            );
            let glyph_color = self.semantic(
                "text.action.secondary",
                if button.enabled {
                    theme.accent
                } else {
                    theme.border
                },
                states,
            );
            let base = interaction_background(
                theme,
                theme.panel_raised,
                states.pressed,
                false,
                states.hovered,
            );
            let background = self.semantic("background.action.secondary", base, states);
            let x = cell.start as i32;
            painter.text(
                x,
                1,
                &centre(button.label, cell.width),
                Style::new().bg(background).fg(label_color),
            );
            painter.text(
                x,
                2,
                &centre(button.glyph, cell.width),
                Style::new().bg(background).fg(glyph_color),
            );
        }
        let trail = width.saturating_sub(cells.last().map_or(0, ToolbarCell::end));
        // Progress stays clear of the buttons and four columns from the right edge.
        let status = clip_columns(
            self.view.busy.as_deref().unwrap_or(""),
            trail.saturating_sub(5) as i64,
        );
        if !status.is_empty() {
            let x = width.saturating_sub(BUSY_INSET + string_width(&status));
            let accent = to_color(theme.accent);
            blank(
                painter,
                x as usize,
                1,
                string_width(&status) + BUSY_INSET,
                raised,
                accent,
            );
            painter.text(x as i32, 1, &status, Style::new().bg(raised).fg(accent));
        }
    }

    /// The repository summary over the label row, up to the first enabled action. `renderHeader`.
    fn paint_summary(&self, painter: &mut Painter<'_>, width: usize, cells: &[ToolbarCell]) {
        let first_action = cells
            .iter()
            .find(|cell| cell.button.enabled)
            .map_or(width, |cell| cell.start);
        let room = first_action.saturating_sub(1).max(1);
        let theme = &self.theme;
        let mut segments: Vec<(String, Rgba)> =
            vec![(format!(" {}", self.view.name), theme.accent)];
        match &self.view.summary {
            None => segments.push(("  loading…".to_owned(), theme.muted)),
            Some(state) => {
                let branch = state.branch.as_deref().unwrap_or("detached HEAD");
                segments.push((format!("  {}", display_branch_name(branch)), theme.warning));
                if state.ahead > 0 {
                    segments.push((format!("  ↑{}", state.ahead), theme.added));
                }
                if state.behind > 0 {
                    segments.push((format!("  ↓{}", state.behind), theme.deleted));
                }
                if state.ahead == 0 && state.behind == 0 {
                    let text = if state.has_upstream {
                        "  up to date"
                    } else {
                        "  no upstream"
                    };
                    segments.push((text.to_owned(), theme.muted));
                }
                segments.push(if state.changed > 0 {
                    (format!("  {} changed", state.changed), theme.warning)
                } else {
                    ("  clean".to_owned(), theme.muted)
                });
            }
        }
        let raised = to_color(theme.panel_raised);
        blank(painter, 0, 1, room, raised, to_color(theme.muted));
        let mut left = room as i64;
        let mut x = 0;
        for (text, color) in segments {
            let text = clip_columns(&text, left);
            left -= string_width(&text) as i64;
            painter.text(x, 1, &text, Style::new().bg(raised).fg(to_color(color)));
            x += string_width(&text) as i32;
        }
    }

    fn paint_toggle(
        &self,
        painter: &mut Painter<'_>,
        range: (usize, usize),
        text: &str,
        target: Target,
    ) {
        let theme = &self.theme;
        let states = self.state(&target);
        let (bg, fg) = match target {
            Target::Avatars => (
                self.semantic(
                    "background.action.secondary",
                    interaction_background(
                        theme,
                        theme.panel_raised,
                        states.pressed,
                        false,
                        states.hovered,
                    ),
                    states,
                ),
                self.semantic("text.action.secondary", theme.muted, states),
            ),
            // The diff toggle has no semantic tokens: it uses the hover color and the plain text color, which is
            // what the TS app shows although the widget is created with the muted one.
            _ => (
                to_color(if states.hovered {
                    theme.hover
                } else {
                    theme.panel_raised
                }),
                to_color(theme.text),
            ),
        };
        painter.fill(range.0 as i32, 1, (range.1 - range.0) as u32, 1, bg);
        painter.text(range.0 as i32, 1, text, Style::new().bg(bg).fg(fg));
    }
}

impl Component for HeaderBar {
    fn paint(&self, painter: &mut Painter<'_>) {
        let width = painter.width() as usize;
        self.width.set(width);
        self.paint_tabs(painter, width);
        let cells = self.toolbar_cells(width);
        self.paint_toolbar(painter, width, &cells);
        self.paint_summary(painter, width, &cells);
        let avatars = format!(
            "{} Avatars",
            if self.view.avatars_enabled {
                "■"
            } else {
                "□"
            }
        );
        self.paint_toggle(
            painter,
            Self::avatar_range(width),
            &avatars,
            Target::Avatars,
        );
        if let Some(text) = &self.view.diff_toggle {
            self.paint_toggle(painter, Self::diff_range(width), text, Target::DiffView);
        }
    }

    fn mouse(&mut self, cx: &mut Cx<'_>, event: &MouseEvent, local: (i32, i32)) -> bool {
        let x = usize::try_from(local.0).unwrap_or(0);
        let y = usize::try_from(local.1).unwrap_or(0);
        match event.kind {
            MouseEventKind::Moved => {
                let hovered = self.target_at(x, y);
                if hovered == self.hovered {
                    return false;
                }
                self.hovered = hovered;
                self.pressed = None;
                true
            }
            MouseEventKind::Down(MouseButton::Middle) => {
                if let Some(Target::Tab(id)) = self.target_at(x, y) {
                    self.emit(cx, HeaderEvent::TabMiddleClose(id));
                }
                true
            }
            MouseEventKind::Down(MouseButton::Left) => {
                let target = self.target_at(x, y);
                match target.clone() {
                    Some(Target::Open) => self.emit(cx, HeaderEvent::TabOpen),
                    Some(Target::Tab(id)) => {
                        let layout = layout_repository_tabs(
                            &self.view.tabs,
                            self.view.active_tab.as_deref(),
                            self.width.get(),
                        );
                        if repository_tab_hit(&layout, x)
                            == Some(RepositoryTabHit::Close(id.clone()))
                        {
                            self.emit(cx, HeaderEvent::TabClose(id));
                        } else {
                            self.dragging = Some(id.clone());
                            self.emit(cx, HeaderEvent::TabSelect(id));
                        }
                    }
                    _ => self.pressed = target,
                }
                true
            }
            MouseEventKind::Drag(MouseButton::Left) => match self.dragging.clone() {
                Some(id) => {
                    self.emit(cx, HeaderEvent::TabDrag { id, x });
                    true
                }
                None => false,
            },
            MouseEventKind::Up(button) => {
                self.dragging = None;
                if button != MouseButton::Left {
                    return false;
                }
                // The button runs when the release lands on the one pressed.
                let pressed = self.pressed.take();
                let released = self.target_at(x, y);
                match (pressed, released) {
                    (Some(pressed), Some(released)) if pressed == released => match released {
                        Target::Toolbar(action) => self.emit(cx, HeaderEvent::Toolbar(action)),
                        Target::Avatars => self.emit(cx, HeaderEvent::ToggleAvatars),
                        Target::DiffView => self.emit(cx, HeaderEvent::ToggleDiffView),
                        Target::Tab(_) | Target::Open => {}
                    },
                    _ => {}
                }
                true
            }
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tuig_ui_model::theme::one_dark_theme;
    use tuig_ui_model::toolbar::toolbar_buttons;

    fn bar(width: usize) -> HeaderBar {
        let mut bar = HeaderBar::new(one_dark_theme());
        bar.width.set(width);
        bar.set_view(HeaderView {
            tabs: vec![RepositoryTab {
                id: "a".into(),
                path: "/w/a".into(),
                label: None,
            }],
            active_tab: Some("a".into()),
            buttons: toolbar_buttons(Some(&Default::default())),
            diff_toggle: Some("■ Side by side".into()),
            ..HeaderView::default()
        });
        bar
    }

    #[test]
    fn rows_map_to_the_tab_strip_the_toolbar_and_the_toggles() {
        let bar = bar(160);
        assert_eq!(bar.target_at(3, 0), Some(Target::Tab("a".into())));
        assert_eq!(bar.target_at(17, 0), Some(Target::Open));
        // Fetch is enabled, Pull needs an upstream.
        assert_eq!(
            bar.target_at(55, 1),
            Some(Target::Toolbar(ToolbarAction::Fetch))
        );
        assert_eq!(
            bar.target_at(55, 2),
            Some(Target::Toolbar(ToolbarAction::Fetch))
        );
        assert_eq!(bar.target_at(66, 1), None);
        // The toggles cover the right end of the label row only.
        assert_eq!(bar.target_at(150, 1), Some(Target::Avatars));
        assert_eq!(bar.target_at(150, 2), None);
        assert_eq!(bar.target_at(135, 1), Some(Target::DiffView));
    }

    #[test]
    fn the_diff_toggle_is_hidden_without_a_diff() {
        let mut bar = bar(160);
        bar.view.diff_toggle = None;
        assert_eq!(bar.target_at(135, 1), None);
    }
}
