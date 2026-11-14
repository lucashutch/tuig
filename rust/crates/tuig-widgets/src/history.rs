//! The history list: header, working-changes row, one row per commit with its ref label, graph lanes, subject,
//! committer and short SHA, and the scrollbar. Ports `paintHistory` in `src/ui/runtime-paint.ts`.
//!
//! [`HistoryList`] is a [`Component`]. Put it in the tree with `Custom::new(app, HistoryList::new(theme))` and change
//! it with `Custom::update`. Its width is the pane's content width: the TypeScript app draws the same rows inside a
//! one-cell padding.
//!
//! The widget holds no history state of its own. The shell owns the commits, the graph index, the viewport and the
//! selection. It builds a [`HistoryWindow`] for the rows on screen with [`history_window`] and passes it in with
//! [`HistoryList::set_window`], with the selection through [`HistoryList::set_selected`]. Mouse input comes back as
//! [`HistoryEvent`] through [`HistoryList::on_event`].
//!
//! Known parity gaps with `paintHistory` and its mouse handling in the TypeScript app:
//!
//! - Branch hints.
//! - The `A ` comparison marker.
//! - The PR column and its spinner.
//! - Divider hover and drag colors.
//! - Avatars.
//! - Click hits on the SHA and on labels, and the scrollbar drag.

use crate::decorations::{RefIndex, summarise_decorations};
use opentui::prelude::*;
use std::rc::Rc;
use std::time::{Duration, Instant};
use tuig_git::types::{BranchRef, Commit};
use tuig_ui_model::color::Rgba;
use tuig_ui_model::graph::{GraphCell, GraphRow};
use tuig_ui_model::graph_index::GraphIndex;
use tuig_ui_model::graph_viewport::{
    clamp_graph_scroll, graph_scroll_indicator, graph_window_cells,
};
use tuig_ui_model::history_columns::{
    HistoryColumns, history_column_layout, visible_history_columns,
};
use tuig_ui_model::history_viewport::WHEEL_ROWS;
use tuig_ui_model::scrollbar::{ScrollbarCell, scrollbar_cell, scrollbar_thumb};
use tuig_ui_model::text_width::{fit_columns, string_width};
use tuig_ui_model::theme::{Theme, interaction_background};

/// Two presses on the same row within this time count as a double click. `DOUBLE_CLICK_MS` in TypeScript.
pub const DOUBLE_CLICK: Duration = Duration::from_millis(400);

/// One commit on screen.
#[derive(Debug, Clone)]
pub struct HistoryRow {
    pub graph: GraphRow,
    pub commit: Commit,
    /// The primary ref label, empty when the commit has none.
    pub label: String,
    /// Refs on the commit beyond the primary one, shown as `+N`.
    pub extra: usize,
}

/// The part of the history the widget paints, built by [`history_window`].
#[derive(Debug, Clone, Default)]
pub struct HistoryWindow {
    /// First display row on screen. Row 0 is the working row when `working_files` is above zero.
    pub start: usize,
    /// Changed files in the working tree. Above zero, the list starts with a working-changes row.
    pub working_files: usize,
    /// Commits loaded, for the header and the row count.
    pub commits: usize,
    /// False while older commits remain unread. The header then shows `N+ commits`.
    pub commits_complete: bool,
    /// Graph lanes across all loaded commits, so the column layout does not change while scrolling.
    pub graph_columns: usize,
    /// Commit rows from the first commit on screen, at least as many as the body has lines.
    pub rows: Vec<HistoryRow>,
}

impl HistoryWindow {
    /// Display rows: the working row, if any, then one per commit.
    pub fn total(&self) -> usize {
        self.commits + usize::from(self.working_files > 0)
    }
}

/// The inputs to [`history_window`] that change only when the history does.
pub struct HistorySource<'a> {
    pub commits: &'a [Commit],
    pub branches: &'a [BranchRef],
    pub refs: &'a RefIndex,
    pub colors: &'a [String],
    pub working_files: usize,
    pub commits_complete: bool,
}

/// Builds the rows for `lines` body lines from display row `start`. The graph rows come from `index`, which keeps
/// lane checkpoints and replays the window.
pub fn history_window(
    index: &mut GraphIndex,
    source: &HistorySource<'_>,
    start: usize,
    lines: usize,
) -> HistoryWindow {
    let has_working = source.working_files > 0;
    let first_commit = start.saturating_sub(usize::from(has_working));
    let graph = index.window(source.commits, source.colors, first_commit, lines + 1);
    let rows = graph
        .iter()
        .zip(&source.commits[first_commit.min(source.commits.len())..])
        .map(|(graph, commit)| {
            let (label, extra) =
                summarise_decorations(&commit.decorations, source.branches, source.refs);
            HistoryRow {
                graph: graph.clone(),
                commit: commit.clone(),
                label,
                extra,
            }
        })
        .collect();
    HistoryWindow {
        start,
        working_files: source.working_files,
        commits: source.commits.len(),
        commits_complete: source.commits_complete,
        graph_columns: index.columns,
        rows,
    }
}

/// One run of cells with one style. `bg: None` keeps the pane background.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Span {
    pub text: String,
    pub fg: Rgba,
    pub bg: Option<Rgba>,
}

/// Mouse input for the shell. Rows are display rows and columns are cells from the widget's left edge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistoryEvent {
    /// A left press on a row. `clicks` is 2 for a second press on the same row within [`DOUBLE_CLICK`].
    Click { row: usize, column: u16, clicks: u8 },
    /// Vertical wheel, in rows.
    Wheel(i32),
    /// Horizontal wheel or shift with the vertical wheel, in graph columns.
    ScrollGraph(i32),
}

type EventHandler = Box<dyn FnMut(&mut Cx<'_>, HistoryEvent)>;

pub struct HistoryList {
    window: Rc<HistoryWindow>,
    theme: Theme,
    columns: HistoryColumns,
    /// The selected display row.
    selected: Option<usize>,
    graph_scroll: usize,
    focused: bool,
    hovered_line: Option<usize>,
    last_press: Option<(usize, Instant)>,
    on_event: Option<EventHandler>,
}

impl HistoryList {
    pub fn new(theme: Theme) -> Self {
        Self {
            window: Rc::default(),
            theme,
            columns: HistoryColumns {
                show_committer: true,
                show_sha: true,
                ..HistoryColumns::default()
            },
            selected: None,
            graph_scroll: 0,
            focused: false,
            hovered_line: None,
            last_press: None,
            on_event: None,
        }
    }

    pub fn set_window(&mut self, window: Rc<HistoryWindow>) {
        self.window = window;
    }

    pub fn window(&self) -> &HistoryWindow {
        &self.window
    }

    /// The selected display row, or `None` for no selection.
    pub fn set_selected(&mut self, row: Option<usize>) {
        self.selected = row;
    }

    /// The first graph column on screen. Painting clamps it to the lanes.
    pub fn set_graph_scroll(&mut self, columns: usize) {
        self.graph_scroll = columns;
    }

    pub fn set_theme(&mut self, theme: &Theme) {
        self.theme = theme.clone();
    }

    pub fn set_columns(&mut self, columns: HistoryColumns) {
        self.columns = columns;
    }

    pub fn set_focused(&mut self, focused: bool) {
        self.focused = focused;
    }

    /// Called for each mouse event the shell must handle. The handler must not call `Custom::update` or
    /// `Custom::with` on this widget: the widget is borrowed while it runs. Queue a message instead.
    pub fn on_event(&mut self, handler: impl FnMut(&mut Cx<'_>, HistoryEvent) + 'static) {
        self.on_event = Some(Box::new(handler));
    }

    fn emit(&mut self, cx: &mut Cx<'_>, event: HistoryEvent) {
        if let Some(handler) = self.on_event.as_mut() {
            handler(cx, event);
        }
    }

    /// The display row under widget line `line`, where line 0 is the header.
    fn row_at_line(&self, line: i32) -> Option<usize> {
        let body = usize::try_from(line.checked_sub(1)?).ok()?;
        let row = self.window.start + body;
        (row < self.window.total()).then_some(row)
    }

    /// The rows the widget draws at `width` by `height` cells, one span list per line.
    pub fn render(&self, width: u32, height: u32) -> Vec<Vec<Span>> {
        let theme = &self.theme;
        let width = i64::from(width);
        // The widget is the pane's content: one header line, then body lines up to the bottom edge. TypeScript's
        // `contentHeight - 2` counts the pane border too, which is already outside this widget's height.
        let lines = (height as usize).saturating_sub(1).max(1);
        let data = &*self.window;
        let has_working = data.working_files > 0;
        let total = data.total();
        let start = data.start;
        let graph_columns = data.graph_columns;
        let columns = visible_history_columns(self.columns, false);
        let geometry = history_column_layout(width, graph_columns, columns);
        let label_width = geometry.branch_width;
        let visible_graph = geometry.graph_columns;
        let graph_scroll =
            clamp_graph_scroll(self.graph_scroll as i64, graph_columns, visible_graph);
        let graph_pad =
            " ".repeat((geometry.graph_width - visible_graph as i64 * 2).max(0) as usize);

        let span = |text: String, fg: Rgba, bg: Option<Rgba>| Span { text, fg, bg };
        let mut out = Vec::with_capacity(lines + 1);

        // Header.
        let header = if self.focused {
            theme.focus_ring
        } else {
            theme.muted
        };
        let arrows = graph_scroll_indicator(
            graph_scroll,
            graph_columns.saturating_sub(graph_scroll + visible_graph),
        );
        let separator = |text: &str| span(text.to_string(), theme.divider, None);
        let mut line = vec![
            span(
                fit_columns(" Branch / tag", label_width, false),
                header,
                None,
            ),
            separator("│ "),
            span(
                fit_columns(
                    "Graph",
                    geometry.graph_width - string_width(&arrows) as i64,
                    false,
                ),
                header,
                None,
            ),
            span(arrows, theme.accent, None),
            separator(" │ "),
            span(
                fit_columns(
                    &format!(
                        "Message ({}{} commits)",
                        data.commits,
                        if data.commits_complete { "" } else { "+" }
                    ),
                    geometry.message_width,
                    false,
                ),
                header,
                None,
            ),
        ];
        if columns.show_committer {
            line.push(separator(" │ "));
            line.push(span(
                fit_columns("Committer", geometry.committer_width, false),
                header,
                None,
            ));
        }
        if columns.show_sha {
            line.push(separator(" │ "));
            line.push(span("SHA     ".to_string(), header, None));
        }
        line.push(separator("│"));
        out.push(line);

        let thumb = scrollbar_thumb(total as i64, start as i64, lines as i64);
        let scroll = |offset: usize| {
            let cell = scrollbar_cell(&thumb, offset as i64);
            let glyph = match cell {
                ScrollbarCell::Full => "▐",
                ScrollbarCell::Upper => "▝",
                ScrollbarCell::Lower => "▗",
                ScrollbarCell::None => " ",
            };
            let fg = if cell == ScrollbarCell::None {
                theme.border
            } else {
                theme.accent
            };
            (glyph.to_string(), fg)
        };
        let muted_hex = theme.muted.to_hex();
        let window = |cells: &[GraphCell]| {
            graph_window_cells(
                cells,
                graph_scroll as i64,
                visible_graph,
                graph_columns,
                &muted_hex,
            )
            .cells
        };
        let color = |hex: &str| Rgba::parse(hex).unwrap_or(theme.muted);
        let selected_row = self.selected;

        let mut body = 0;
        if has_working && start == 0 {
            let selected = selected_row == Some(0);
            let bg = Some(interaction_background(
                theme,
                theme.panel_raised,
                false,
                selected,
                self.hovered_line == Some(0),
            ));
            let files = data.working_files;
            let subject = fit_columns(
                &format!(
                    "Working Changes ({files} {} modified)",
                    if files == 1 { "file" } else { "files" }
                ),
                geometry.message_width,
                true,
            );
            let mut line = vec![
                span(" ".repeat(label_width.max(0) as usize), theme.text, bg),
                span(
                    if selected { "▸ " } else { "  " }.to_string(),
                    theme.muted,
                    bg,
                ),
            ];
            let working = [GraphCell {
                symbol: "● ".to_string(),
                color: theme.warning.to_hex(),
            }];
            for cell in window(&working) {
                line.push(span(cell.symbol, color(&cell.color), bg));
            }
            line.push(span(graph_pad.clone(), theme.border, bg));
            line.push(span("   ".to_string(), theme.border, bg));
            line.push(span(subject, theme.warning, bg));
            if columns.show_committer {
                line.push(span("   ".to_string(), theme.border, bg));
                line.push(span(
                    " ".repeat(geometry.committer_width.max(0) as usize),
                    theme.muted,
                    bg,
                ));
            }
            if columns.show_sha {
                line.push(span("   ".to_string(), theme.border, bg));
                line.push(span("        ".to_string(), theme.text, bg));
            }
            let (glyph, fg) = scroll(0);
            line.push(span(glyph, fg, bg));
            out.push(line);
            body = 1;
        }

        let first_row = start.max(usize::from(has_working && start == 0));
        let leading = usize::from(has_working);
        let window_from = first_row.saturating_sub(leading);
        let backgrounds = [theme.bg, theme.panel_raised];
        for row_index in first_row..total {
            if body >= lines {
                break;
            }
            let commit_index = row_index - leading;
            let Some(entry) = data.rows.get(commit_index - window_from) else {
                break;
            };
            let (row, commit) = (&entry.graph, &entry.commit);
            let (primary, extra) = (&entry.label, entry.extra);
            let offset = row_index - start;
            let selected = selected_row == Some(row_index);
            let chip = if extra > 0 {
                format!(" +{extra}")
            } else {
                String::new()
            };
            let label = if primary.is_empty() {
                String::new()
            } else {
                let fitted = fit_columns(primary, label_width - 2 - chip.len() as i64, true);
                format!("{}{chip}", fitted.trim_end())
            };
            let label_text = if label.is_empty() {
                " ".repeat(label_width.max(0) as usize)
            } else {
                fit_columns(&format!(" {label} "), label_width, false)
            };
            let graph_color = row.color_at(row.lane).map_or(theme.accent, color);
            let bg = Some(interaction_background(
                theme,
                backgrounds[commit_index % 2],
                false,
                selected,
                self.hovered_line == Some(body),
            ));
            let stash = commit
                .decorations
                .iter()
                .any(|label| label == "refs/stash" || label == "stash");
            let mut line = vec![span(
                label_text,
                if stash || label.is_empty() {
                    theme.muted
                } else {
                    graph_color
                },
                if stash { Some(theme.panel_raised) } else { bg },
            )];
            line.push(if row.head {
                span("▶ ".to_string(), theme.warning, bg)
            } else {
                span(
                    if selected { "› " } else { "  " }.to_string(),
                    theme.accent,
                    bg,
                )
            });
            for cell in window(&row.cells) {
                line.push(span(cell.symbol, color(&cell.color), bg));
            }
            line.push(span(format!("{graph_pad}   "), theme.border, bg));
            line.push(span(
                fit_columns(&commit.subject, geometry.message_width, true),
                if row.head { theme.warning } else { theme.text },
                bg,
            ));
            if columns.show_committer {
                line.push(span("   ".to_string(), theme.border, bg));
                line.push(span(
                    fit_columns(&commit.committer, geometry.committer_width, true),
                    theme.author,
                    bg,
                ));
            }
            if columns.show_sha {
                line.push(span("   ".to_string(), theme.border, bg));
                line.push(span(commit.sha.chars().take(8).collect(), theme.accent, bg));
            }
            let (glyph, fg) = scroll(offset);
            line.push(span(glyph, fg, bg));
            out.push(line);
            body += 1;
        }
        out
    }
}

fn to_color(color: Rgba) -> Color {
    Color::rgba(color.r, color.g, color.b, color.a)
}

impl Component for HistoryList {
    fn paint(&self, painter: &mut Painter<'_>) {
        let (width, height) = painter.size();
        painter.fill(0, 0, width, height, to_color(self.theme.bg));
        for (y, line) in self.render(width, height).into_iter().enumerate() {
            let mut x = 0;
            for span in line {
                let mut style = Style::new().fg(to_color(span.fg));
                if let Some(bg) = span.bg {
                    style = style.bg(to_color(bg));
                }
                painter.text(x, y as i32, &span.text, style);
                // Advance by the width OpenTUI draws with, so a span never overlaps the next one.
                x += painter.text_width(&span.text) as i32;
            }
        }
    }

    fn focus_changed(&mut self, _cx: &mut Cx<'_>, focused: bool) {
        if !focused {
            self.hovered_line = None;
        }
    }

    fn mouse(&mut self, cx: &mut Cx<'_>, event: &MouseEvent, local: (i32, i32)) -> bool {
        let sideways = event.modifiers.contains(Modifiers::SHIFT);
        if matches!(
            event.kind,
            MouseEventKind::Moved
                | MouseEventKind::ScrollUp
                | MouseEventKind::ScrollDown
                | MouseEventKind::ScrollLeft
                | MouseEventKind::ScrollRight
        ) {
            // The TS app also moves the hover highlight to the line under a wheel event.
            let hovered = usize::try_from(local.1 - 1)
                .ok()
                .filter(|_| self.row_at_line(local.1).is_some());
            let changed = hovered != self.hovered_line;
            self.hovered_line = hovered;
            if event.kind == MouseEventKind::Moved {
                return changed;
            }
        }
        let event = match event.kind {
            MouseEventKind::ScrollUp if sideways => HistoryEvent::ScrollGraph(-1),
            MouseEventKind::ScrollDown if sideways => HistoryEvent::ScrollGraph(1),
            MouseEventKind::ScrollLeft => HistoryEvent::ScrollGraph(-1),
            MouseEventKind::ScrollRight => HistoryEvent::ScrollGraph(1),
            MouseEventKind::ScrollUp => HistoryEvent::Wheel(-WHEEL_ROWS),
            MouseEventKind::ScrollDown => HistoryEvent::Wheel(WHEEL_ROWS),
            // A right click does nothing here: the graph menu is not ported yet.
            MouseEventKind::Down(MouseButton::Left) => {
                let Some(row) = self.row_at_line(local.1) else {
                    return false;
                };
                let now = cx.app().now();
                let doubled = self
                    .last_press
                    .is_some_and(|(last, at)| last == row && now.duration_since(at) < DOUBLE_CLICK);
                self.last_press = if doubled { None } else { Some((row, now)) };
                HistoryEvent::Click {
                    row,
                    column: u16::try_from(local.0.max(0)).unwrap_or(u16::MAX),
                    clicks: if doubled { 2 } else { 1 },
                }
            }
            _ => return false,
        };
        self.emit(cx, event);
        true
    }
}

#[cfg(test)]
#[path = "history_tests.rs"]
mod tests;
