//! The bottom row: key hints on the left and the transient message on the right. Ports `formatHints` in
//! `src/ui/runtime-presentation-chrome.ts`, `paintHints` in `src/ui/runtime.ts`, and the message placement in
//! `src/ui/runtime-notifications.ts`. The hints and the message are two text widgets in TS. They share one row, and
//! the hints give way to the message, so one painter draws both.

use opentui::prelude::*;
use tuig_ui_model::color::Rgba;
use tuig_ui_model::graph_menu::clip_columns;
use tuig_ui_model::text_width::string_width;
use tuig_ui_model::theme::Theme;

fn to_color(color: Rgba) -> Color {
    Color::rgba(color.r, color.g, color.b, color.a)
}

/// The pane with the keyboard focus. `focus` in `Runtime`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum HintFocus {
    #[default]
    History,
    Changes,
}

/// What the main area shows. `view` in `Runtime`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum HintView {
    #[default]
    History,
    Commit,
    Working,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct HintContext {
    pub focus: HintFocus,
    pub view: HintView,
    /// A commit field has focus.
    pub composing: bool,
    /// The number of selected diff lines, and whether Enter unstages them.
    pub line_selection: Option<(usize, bool)>,
}

/// Keybinding hints for the current focus, so the bottom row keeps teaching the keys that apply right now.
pub fn format_hints(context: &HintContext) -> String {
    let join = |hints: &[&str]| hints.join("  ·  ");
    if context.composing {
        return join(&["↵ commit", "⇥ summary/description", "esc cancel"]);
    }
    if let Some((count, unstage)) = context.line_selection
        && count > 0
    {
        let selected = format!("{count} lines selected");
        let action = if unstage { "↵ unstage" } else { "↵ stage" };
        return join(&[
            &selected,
            action,
            "alt-drag range",
            "right-click actions",
            "esc clear",
        ]);
    }
    let shared = ["⇥ pane", "[ ] collapse", "r refresh", "q quit"];
    let with_shared = |first: &[&str]| join(&[first, &shared].concat());
    match (context.view, context.focus) {
        (HintView::Working, _) => with_shared(&[
            "click select",
            "ctrl/alt-click add",
            "alt-drag range",
            "esc back",
        ]),
        (HintView::Commit, _) => {
            with_shared(&["esc back to graph", "←/→ file", "s stage", "u unstage"])
        }
        (HintView::History, HintFocus::Changes) => with_shared(&[
            "←/→ file",
            "s stage",
            "u unstage",
            "h hunk",
            "t section",
            "c commit",
        ]),
        (HintView::History, HintFocus::History) => with_shared(&[
            "j/k move",
            "←/→ pan graph",
            "↵ open commit",
            "/ filter branches",
        ]),
    }
}

/// How a message is colored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageTone {
    Info,
    Error,
}

pub struct Footer {
    theme: Theme,
    hints: String,
    message: String,
    tone: MessageTone,
    /// The columns of the sidebar and details panes. Both reach the bottom row in TS, so they color it.
    sidebar: Option<(u32, u32)>,
    details: Option<(u32, u32)>,
}

impl Footer {
    pub fn new(theme: Theme) -> Self {
        Self {
            theme,
            hints: format_hints(&HintContext::default()),
            message: String::new(),
            tone: MessageTone::Info,
            sidebar: None,
            details: None,
        }
    }

    pub fn set_theme(&mut self, theme: &Theme) {
        self.theme = theme.clone();
    }

    /// The `(left, width)` of each pane that is showing.
    pub fn set_panes(&mut self, sidebar: Option<(u32, u32)>, details: Option<(u32, u32)>) {
        self.sidebar = sidebar;
        self.details = details;
    }

    pub fn set_hints(&mut self, context: &HintContext) {
        self.hints = format_hints(context);
    }

    /// An empty `text` clears the message. The text is clipped to half of `terminal_width`, but at least 20
    /// columns, as `notify` does when the message appears. A later resize does not clip it again.
    pub fn set_message(&mut self, text: &str, tone: MessageTone, terminal_width: u32) {
        let limit = (i64::from(terminal_width) / 2).max(20);
        self.message = clip_columns(text, limit);
        self.tone = tone;
    }
}

impl Component for Footer {
    fn paint(&self, painter: &mut Painter<'_>) {
        let (width, _) = painter.size();
        for (left, pane) in [self.sidebar, self.details].into_iter().flatten() {
            painter.fill(left as i32, 0, pane, 1, to_color(self.theme.panel));
        }
        // The hints start at column 1. TS leaves column 0 to the sidebar, which paints it with the text color.
        if self
            .sidebar
            .is_some_and(|(left, width)| left == 0 && width > 0)
        {
            painter.cell(0, 0, ' ', Style::new().fg(to_color(self.theme.text)));
        }
        let total = i64::from(width);
        let message = self.message.as_str();
        let message_width = string_width(message) as i64;
        // The hints must leave the message its columns and a gap.
        let room = (total - message_width - 4).max(10);
        let hints = clip_columns(&self.hints, room);
        let muted = Style::new().fg(to_color(self.theme.muted));
        painter.text(1, 0, &hints, muted);
        if !message.is_empty() {
            let left = (total - message_width - 1).max(1);
            let fg = match self.tone {
                MessageTone::Error => self.theme.deleted,
                MessageTone::Info => self.theme.muted,
            };
            painter.text(
                i32::try_from(left).unwrap_or(1),
                0,
                // The text has one row, so a second line does not show. The width and the position still come
                // from the whole text, as in TS.
                message.split('\n').next().unwrap_or_default(),
                Style::new().fg(to_color(fg)),
            );
        }
    }
}

#[cfg(test)]
#[path = "footer_tests.rs"]
mod tests;
