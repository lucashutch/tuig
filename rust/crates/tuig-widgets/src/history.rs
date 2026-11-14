//! The history list: header, working-changes row, one row per commit with its ref label, graph lanes, subject,
//! committer and short SHA, and the scrollbar. Ports `paintHistory` in `src/ui/runtime-paint.ts`.
//!
//! [`HistoryList`] is a [`Component`]. Put it in the tree with `Custom::new(app, HistoryList::new(theme))` and change
//! it with `Custom::update`. Its width is the pane's content width: the TypeScript app draws the same rows inside a
//! one-cell padding.
//!
//! Known parity gaps with `paintHistory` and its mouse handling in the TypeScript app:
//!
//! - Branch hints.
//! - The `A ` comparison marker.
//! - The PR column and its spinner.
//! - Divider hover and drag colors.
//! - Avatars.
//! - Click hits on the SHA and on labels.
//! - The 16 ms wheel batching and the 80 ms settle timer.
//! - The shell, not the widget, owns viewport and selection in the TypeScript app. Here the widget owns both.

use crate::decorations::{RefIndex, resolve_head_sha, summarise_decorations};
use crate::viewport::Viewport;
use opentui::prelude::*;
use std::cell::{Cell, RefCell};
use tuig_git::types::{BranchRef, Commit};
use tuig_ui_model::color::Rgba;
use tuig_ui_model::graph::GraphCell;
use tuig_ui_model::graph_index::GraphIndex;
use tuig_ui_model::graph_viewport::{
    clamp_graph_scroll, graph_scroll_indicator, graph_window_cells,
};
use tuig_ui_model::history_columns::{
    HistoryColumns, history_column_layout, visible_history_columns,
};
use tuig_ui_model::scrollbar::{ScrollbarCell, scrollbar_cell, scrollbar_thumb};
use tuig_ui_model::text_width::{fit_columns, string_width};
use tuig_ui_model::theme::{Theme, interaction_background};

/// Rows one wheel notch scrolls. `WHEEL_ROWS` in `src/ui/runtime-widgets.ts`.
pub const WHEEL_ROWS: i64 = 1;

/// What the list shows. The shell owns loading; the widget only lays it out.
#[derive(Debug, Clone, Default)]
pub struct HistoryData {
    /// Newest first, as `git log` lists them.
    pub commits: Vec<Commit>,
    pub branches: Vec<BranchRef>,
    /// Changed files in the working tree. Above zero, the list starts with a working-changes row.
    pub working_files: usize,
    /// False while older commits remain unread. The header then shows `N+ commits`.
    pub commits_complete: bool,
}

/// One run of cells with one style. `bg: None` keeps the pane background.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Span {
    pub text: String,
    pub fg: Rgba,
    pub bg: Option<Rgba>,
}

/// The selected row, kept apart from display rows so that the working row appearing or disappearing does not move
/// the selection to another commit. TypeScript keeps `historySelection` and `commitIndex` the same way.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Selection {
    Working,
    Commit(usize),
}

type SelectHandler = Box<dyn FnMut(&mut Cx<'_>, usize)>;

pub struct HistoryList {
    data: HistoryData,
    refs: RefIndex,
    graph: RefCell<GraphIndex>,
    colors: Vec<String>,
    theme: Theme,
    columns: HistoryColumns,
    selection: Selection,
    /// Scroll state. `selected` is derived from `selection` whenever the widget reads or paints it.
    viewport: Cell<Viewport>,
    /// Body lines at the last paint, so events between paints use the painted geometry.
    lines: Cell<usize>,
    graph_scroll: Cell<usize>,
    focused: bool,
    hovered_line: Option<usize>,
    on_select: Option<SelectHandler>,
}

impl HistoryList {
    pub fn new(theme: Theme) -> Self {
        let colors: Vec<String> = theme.graph.iter().map(|color| color.to_hex()).collect();
        Self {
            data: HistoryData::default(),
            refs: RefIndex::default(),
            graph: RefCell::new(GraphIndex::new(None, &colors)),
            colors,
            theme,
            columns: HistoryColumns {
                show_committer: true,
                show_sha: true,
                ..HistoryColumns::default()
            },
            selection: Selection::Working,
            viewport: Cell::new(Viewport::default()),
            lines: Cell::new(1),
            graph_scroll: Cell::new(0),
            focused: false,
            hovered_line: None,
            on_select: None,
        }
    }

    /// Replaces the history and lays out its graph again.
    pub fn set_data(&mut self, data: HistoryData) {
        let head = resolve_head_sha(&data.branches, &data.commits);
        let working_parent = if data.working_files > 0 {
            head.as_deref()
        } else {
            None
        };
        let mut graph = GraphIndex::new(working_parent, &self.colors);
        graph
            .extend(&data.commits, &self.colors, head.as_deref())
            .expect("a new index takes any commit list");
        self.refs = RefIndex::new(&data.branches);
        self.graph = RefCell::new(graph);
        self.data = data;
        self.selection = match self.selection {
            Selection::Working if self.has_working() => Selection::Working,
            Selection::Working => Selection::Commit(0),
            Selection::Commit(index) => {
                Selection::Commit(index.min(self.data.commits.len().saturating_sub(1)))
            }
        };
        self.sync_selected();
    }

    /// Adds the next page of older commits. The graph continues from where it stopped.
    pub fn append_commits(&mut self, commits: Vec<Commit>, complete: bool) {
        self.data.commits.extend(commits);
        self.data.commits_complete = complete;
        let head = resolve_head_sha(&self.data.branches, &self.data.commits);
        self.graph
            .get_mut()
            .extend(&self.data.commits, &self.colors, head.as_deref())
            .expect("the commit list only grows");
    }

    pub fn data(&self) -> &HistoryData {
        &self.data
    }

    pub fn set_columns(&mut self, columns: HistoryColumns) {
        self.columns = columns;
    }

    pub fn set_focused(&mut self, focused: bool) {
        self.focused = focused;
    }

    /// Called with the new display row after a click selects one. The handler must not call `Custom::update` or
    /// `Custom::with` on this widget: the widget is borrowed while it runs.
    pub fn on_select(&mut self, handler: impl FnMut(&mut Cx<'_>, usize) + 'static) {
        self.on_select = Some(Box::new(handler));
    }

    /// Display rows: the working row, if any, then one per commit.
    pub fn total(&self) -> usize {
        self.data.commits.len() + usize::from(self.has_working())
    }

    fn has_working(&self) -> bool {
        self.data.working_files > 0
    }

    /// The selected display row.
    fn selected_row(&self) -> usize {
        match self.selection {
            Selection::Working => 0,
            Selection::Commit(index) => index + usize::from(self.has_working()),
        }
    }

    fn sync_selected(&self) {
        let mut viewport = self.viewport.get();
        viewport.selected = self.selected_row();
        self.viewport.set(viewport);
    }

    pub fn viewport(&self) -> Viewport {
        self.sync_selected();
        self.viewport.get()
    }

    /// Body lines at the last paint.
    pub fn lines(&self) -> usize {
        self.lines.get()
    }

    /// Selects a display row. The viewport follows it at the next paint.
    pub fn select(&mut self, row: usize) {
        let mut viewport = self.viewport.get();
        viewport.select(row, self.total());
        self.viewport.set(viewport);
        self.selection = match (self.has_working(), viewport.selected) {
            (true, 0) => Selection::Working,
            (true, row) => Selection::Commit(row - 1),
            (false, row) => Selection::Commit(row),
        };
    }

    /// The commit index of the selected row, or `None` for the working row.
    pub fn selected_commit(&self) -> Option<usize> {
        match self.selection {
            Selection::Working => None,
            Selection::Commit(index) => Some(index),
        }
    }

    pub fn wheel(&mut self, delta: i64) {
        let mut viewport = self.viewport.get();
        viewport.wheel(delta, self.total(), self.lines.get());
        self.viewport.set(viewport);
    }

    /// Scrolls the graph lanes sideways. Painting clamps the offset to the lanes.
    pub fn scroll_graph(&mut self, delta: i64) {
        let next = (self.graph_scroll.get() as i64 + delta).max(0) as usize;
        self.graph_scroll.set(next);
    }

    /// The rows the widget draws at `width` by `height` cells, one span list per line. Resolves the viewport as
    /// painting does.
    pub fn render(&self, width: u32, height: u32) -> Vec<Vec<Span>> {
        let theme = &self.theme;
        let width = i64::from(width);
        // The widget is the pane's content: one header line, then body lines up to the bottom edge. TypeScript's
        // `contentHeight - 2` counts the pane border too, which is already outside this widget's height.
        let lines = (height as usize).saturating_sub(1).max(1);
        self.lines.set(lines);
        let has_working = self.has_working();
        let total = self.total();
        self.sync_selected();
        let mut viewport = self.viewport.get();
        let start = viewport.resolve(total, lines);
        self.viewport.set(viewport);

        let mut graph = self.graph.borrow_mut();
        let graph_columns = graph.columns;
        let columns = visible_history_columns(self.columns, false);
        let geometry = history_column_layout(width, graph_columns, columns);
        let label_width = geometry.branch_width;
        let visible_graph = geometry.graph_columns;
        let graph_scroll =
            clamp_graph_scroll(self.graph_scroll.get() as i64, graph_columns, visible_graph);
        self.graph_scroll.set(graph_scroll);
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
                        self.data.commits.len(),
                        if self.data.commits_complete { "" } else { "+" }
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
        let selected_row = viewport.selected;

        let mut body = 0;
        if has_working && start == 0 {
            let selected = selected_row == 0;
            let bg = Some(interaction_background(
                theme,
                theme.panel_raised,
                false,
                selected,
                self.hovered_line == Some(0),
            ));
            let files = self.data.working_files;
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
        let rows = graph.window(
            &self.data.commits,
            &self.colors,
            window_from,
            lines - body + 1,
        );
        let backgrounds = [theme.bg, theme.panel_raised];
        for row_index in first_row..total {
            if body >= lines {
                break;
            }
            let commit_index = row_index - leading;
            let Some(row) = rows.get(commit_index - window_from) else {
                break;
            };
            let commit = &self.data.commits[commit_index];
            let offset = row_index - start;
            let selected = row_index == selected_row;
            let (primary, extra) =
                summarise_decorations(&commit.decorations, &self.data.branches, &self.refs);
            let chip = if extra > 0 {
                format!(" +{extra}")
            } else {
                String::new()
            };
            let label = if primary.is_empty() {
                String::new()
            } else {
                let fitted = fit_columns(&primary, label_width - 2 - chip.len() as i64, true);
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
        match event.kind {
            MouseEventKind::ScrollUp if sideways => self.scroll_graph(-1),
            MouseEventKind::ScrollDown if sideways => self.scroll_graph(1),
            MouseEventKind::ScrollLeft => self.scroll_graph(-1),
            MouseEventKind::ScrollRight => self.scroll_graph(1),
            MouseEventKind::ScrollUp => self.wheel(-WHEEL_ROWS),
            MouseEventKind::ScrollDown => self.wheel(WHEEL_ROWS),
            // A right click does nothing here: the shell handles it and opens the graph menu, as TypeScript does.
            MouseEventKind::Down(MouseButton::Left) => {
                let Some(row) = self.viewport.get().row_at_line(local.1, self.total()) else {
                    return false;
                };
                self.select(row);
                if let Some(handler) = self.on_select.as_mut() {
                    handler(cx, row);
                }
            }
            MouseEventKind::Moved => {
                let line = usize::try_from(local.1 - 1).ok();
                let hovered = line.filter(|&line| {
                    self.viewport
                        .get()
                        .row_at_line(line as i32 + 1, self.total())
                        .is_some()
                });
                if hovered == self.hovered_line {
                    return false;
                }
                self.hovered_line = hovered;
            }
            _ => return false,
        }
        true
    }
}

#[cfg(test)]
#[path = "history_tests.rs"]
mod tests;
