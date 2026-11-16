//! The box of the repository picker: border, title and the suggestion list under the path input. Ports
//! `repositoryPickerBox` and `repositoryPickerText` in `src/ui/runtime-widgets.ts` and
//! `RuntimeTabsController.paintRepositorySuggestions`.
//!
//! The path input is a separate widget that the shell places over the first row inside the box. This component
//! paints the rest and reports clicks on suggestions. It does not cover the screen, so the rest of the app keeps
//! working while the picker is open, as in TS.

use opentui::native::BoxSpec;
use opentui::prelude::*;
use tuig_ui_model::color::Rgba;
use tuig_ui_model::theme::{Surface, Theme, ThemeStates, semantic_color};

/// Rows between the box top and the first suggestion row: border, blank, input, blank.
pub const SUGGESTIONS_TOP: i32 = 4;

/// One suggestion line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PickerRow {
    /// The text without the `> ` marker.
    pub text: String,
    pub selected: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PickerView {
    /// A muted line above the rows, for the recently closed list.
    pub heading: Option<String>,
    pub rows: Vec<PickerRow>,
    /// A muted line shown when there are no rows.
    pub empty: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PickerEvent {
    /// A left press on suggestion `row`, counted from the first suggestion row on screen.
    Choose(usize),
}

type EventHandler = Box<dyn FnMut(&mut Cx<'_>, PickerEvent)>;

pub struct RepositoryPicker {
    theme: Theme,
    view: PickerView,
    on_event: Option<EventHandler>,
}

fn to_color(color: Rgba) -> Color {
    Color::rgba(color.r, color.g, color.b, color.a)
}

impl RepositoryPicker {
    pub fn new(theme: Theme) -> Self {
        Self {
            theme,
            view: PickerView::default(),
            on_event: None,
        }
    }

    pub fn set_view(&mut self, view: PickerView) {
        self.view = view;
    }

    /// The handler must not call `Custom::update` or `Custom::with` on this widget. Queue a message instead.
    pub fn on_event(&mut self, handler: impl FnMut(&mut Cx<'_>, PickerEvent) + 'static) {
        self.on_event = Some(Box::new(handler));
    }

    fn dialog(&self, path: &str, fallback: Rgba, states: ThemeStates) -> Color {
        to_color(semantic_color(
            &self.theme,
            path,
            fallback,
            Surface::Dialog,
            states,
        ))
    }
}

impl Component for RepositoryPicker {
    fn paint(&self, painter: &mut Painter<'_>) {
        let theme = &self.theme;
        let (width, height) = painter.size();
        painter.draw_box(
            0,
            0,
            width,
            height,
            &BoxSpec {
                border_color: to_color(theme.border),
                background: to_color(theme.panel_raised),
                fill: true,
                title: " Open repository ",
                ..BoxSpec::default()
            },
        );
        let x = 2;
        let mut y = SUGGESTIONS_TOP;
        let none = ThemeStates::default();
        let muted = Style::new().fg(self.dialog("text.muted", theme.muted, none));
        if let Some(heading) = &self.view.heading {
            painter.text(x, y, heading, muted);
            y += 1;
        }
        if self.view.rows.is_empty() {
            painter.text(x, y, &self.view.empty, muted);
            return;
        }
        for row in &self.view.rows {
            let states = ThemeStates {
                selected: row.selected,
                focused: row.selected,
                ..none
            };
            let base = if row.selected {
                theme.selected
            } else {
                theme.panel_raised
            };
            painter.text(
                x,
                y,
                &format!("{} {}", if row.selected { ">" } else { " " }, row.text),
                Style::new()
                    .bg(self.dialog("background.action.primary", base, states))
                    .fg(self.dialog("text.action.primary", theme.text, states)),
            );
            y += 1;
        }
    }

    fn mouse(&mut self, cx: &mut Cx<'_>, event: &MouseEvent, local: (i32, i32)) -> bool {
        let MouseEventKind::Down(MouseButton::Left) = event.kind else {
            return false;
        };
        let first = SUGGESTIONS_TOP + i32::from(self.view.heading.is_some());
        let Ok(row) = usize::try_from(local.1 - first) else {
            return false;
        };
        if local.0 < 2 || row >= self.view.rows.len() {
            return false;
        }
        if let Some(handler) = self.on_event.as_mut() {
            handler(cx, PickerEvent::Choose(row));
        }
        true
    }
}
