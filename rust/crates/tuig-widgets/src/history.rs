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
//! - The `A ` comparison marker.
//! - The PR number is not a terminal hyperlink: `Painter` has no hyperlink support.
//! - The scrollbar drag.

use crate::branch_hints::BranchHintIndex;
use crate::decorations::{RefIndex, summarise_decorations};
use crate::pointer::{PointerTracker, origin_of};
use crate::pull_requests::{PullRequestCommitIndex, SPINNER_FRAMES, pull_request_history_cell};
use opentui::prelude::*;
use std::cell::Cell;
use std::rc::Rc;
use std::time::{Duration, Instant};
use tuig_git::pull_request_types::{CheckRollup, PullRequest};
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

/// Width of the SHA hit range: the short SHA is eight characters. `historyShaHits`.
const SHA_HIT_WIDTH: i64 = 8;

/// Two presses on the same row within this time count as a double click. `DOUBLE_CLICK_MS` in TypeScript.
pub const DOUBLE_CLICK: Duration = Duration::from_millis(400);

/// One commit on screen.
#[derive(Debug, Clone)]
pub struct HistoryRow {
    pub graph: GraphRow,
    pub commit: Commit,
    /// The primary ref label, empty when the commit has none.
    pub label: String,
    /// The nearest ref that reaches a commit without a label, for example `↳ main`. Shown only on the selected row.
    pub hint: String,
    /// Refs on the commit beyond the primary one, shown as `+N`.
    pub extra: usize,
    /// Open pull requests that match the commit, newest first. Empty without pull request data.
    pub pull_requests: Vec<PullRequest>,
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
    /// Whether pull request data exists, so the PR column can show.
    pub pr_column: bool,
    /// Commit rows from the first commit on screen, at least as many as the body has lines.
    pub rows: Vec<HistoryRow>,
}

impl HistoryWindow {
    /// Display rows: the working row, if any, then one per commit.
    pub fn total(&self) -> usize {
        self.commits + usize::from(self.working_files > 0)
    }

    /// Whether a row in the first `lines` body lines shows running checks, so the spinner must animate.
    pub fn running_checks_visible(&self, lines: usize) -> bool {
        if !self.pr_column {
            return false;
        }
        let working_line = usize::from(self.working_files > 0 && self.start == 0);
        self.rows
            .iter()
            .take(lines.saturating_sub(working_line))
            .any(|row| {
                row.pull_requests
                    .first()
                    .is_some_and(|pr| pr.checks == CheckRollup::Running)
            })
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
    pub hints: &'a BranchHintIndex,
    /// Pull request matcher. `None` hides the PR column.
    pub pull_requests: Option<&'a PullRequestCommitIndex>,
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
                hint: source
                    .hints
                    .hint(&commit.sha)
                    .unwrap_or_default()
                    .to_owned(),
                extra,
                pull_requests: source
                    .pull_requests
                    .map(|index| index.for_commit(commit).into_iter().cloned().collect())
                    .unwrap_or_default(),
            }
        })
        .collect();
    HistoryWindow {
        start,
        working_files: source.working_files,
        commits: source.commits.len(),
        commits_complete: source.commits_complete,
        graph_columns: index.columns,
        pr_column: source.pull_requests.is_some(),
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

/// One commit graph dot that an avatar image can cover. See [`HistoryList::avatar_slots`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AvatarSlot {
    /// Body line. The shell keeps one image widget per line.
    pub line: usize,
    pub sha: String,
    pub author_email: String,
    /// The lane color, for the avatar's ring.
    pub color: Rgba,
    /// The row background, for the avatar's corners.
    pub background: Rgba,
    pub continues_above: bool,
    pub continues_below: bool,
    /// Left cell of the three-cell image, relative to the widget.
    pub left: i64,
    /// Row of the image, relative to the widget. Row 0 is the header.
    pub top: i64,
}

/// The part of a row that a left press landed on. TS keeps hit ranges for the ref label and the short SHA.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClickPart {
    Row,
    /// The ref label column of a row that shows a label or a branch hint.
    Label,
    /// The short SHA.
    Sha,
}

/// Mouse input for the shell. Rows are display rows and columns are cells from the widget's left edge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistoryEvent {
    /// A left press on a row. `clicks` is 2 for a second press on the same row and the same part within
    /// [`DOUBLE_CLICK`]. A press on the SHA is never part of a double click.
    Click {
        row: usize,
        column: u16,
        part: ClickPart,
        clicks: u8,
    },
    /// Vertical wheel, in rows.
    Wheel(i32),
    /// Horizontal wheel or shift with the vertical wheel, in graph columns.
    ScrollGraph(i32),
    /// A right press on a row, for the context menu. `on_label` is set when the press landed on the ref label.
    /// `x` and `y` are terminal cells.
    Menu {
        row: usize,
        on_label: bool,
        x: u16,
        y: u16,
    },
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
    /// Index into [`SPINNER_FRAMES`] for running checks.
    spinner: usize,
    /// The row and part of the last press that can start a double click, and when it happened.
    last_press: Option<(usize, bool, Instant)>,
    /// The width of the last paint, for the label hit test.
    width: Cell<u32>,
    pointer: PointerTracker,
    /// The list's top left cell on the terminal, from the last pointer event.
    origin: Option<(i32, i32)>,
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
            spinner: 0,
            last_press: None,
            width: Cell::new(0),
            pointer: PointerTracker::default(),
            origin: None,
            on_event: None,
        }
    }

    /// Shares the pointer position, so the row under a still pointer is highlighted again after a popup closes.
    pub fn set_pointer_tracker(&mut self, pointer: PointerTracker) {
        self.pointer = pointer;
    }

    /// The pointer left the list: no row is hovered.
    pub fn pointer_left(&mut self) {
        self.hovered_line = None;
    }

    /// The pointer is over the list without having moved, for example after a popup closed. Hovers the row under
    /// the last known position, as TS does when the renderable under the pointer changes.
    pub fn pointer_entered(&mut self) {
        let line = self.pointer.local(self.origin).map(|(_, line)| line);
        self.hovered_line = line
            .filter(|line| self.row_at_line(*line).is_some())
            .and_then(|line| usize::try_from(line - 1).ok());
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

    /// The spinner frame for running checks, as an index into [`SPINNER_FRAMES`].
    pub fn set_spinner_frame(&mut self, frame: usize) {
        self.spinner = frame % SPINNER_FRAMES.len();
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

    /// Whether column `column` of display row `row` is on the ref label. The label column is as wide as the branch
    /// column and has a hit only on rows that show a label.
    fn on_label(&self, row: usize, column: i32) -> bool {
        let data = &*self.window;
        let Some(index) = row.checked_sub(usize::from(data.working_files > 0)) else {
            return false;
        };
        let Some(entry) = index
            .checked_sub(
                data.start
                    .saturating_sub(usize::from(data.working_files > 0)),
            )
            .and_then(|offset| data.rows.get(offset))
        else {
            return false;
        };
        let columns = visible_history_columns(self.columns, data.pr_column);
        let geometry =
            history_column_layout(i64::from(self.width.get()), data.graph_columns, columns);
        // A click selects the row, and the selected row shows its hint, so a hint counts as a label.
        !(entry.label.is_empty() && entry.hint.is_empty())
            && column >= 0
            && i64::from(column) < geometry.branch_width
    }

    /// Whether column `column` is on the short SHA. The SHA column has a hit on every row while it shows.
    fn on_sha(&self, column: i32) -> bool {
        let data = &*self.window;
        let columns = visible_history_columns(self.columns, data.pr_column);
        if !columns.show_sha {
            return false;
        }
        let geometry =
            history_column_layout(i64::from(self.width.get()), data.graph_columns, columns);
        let column = i64::from(column);
        column >= geometry.sha_start && column < geometry.sha_start + SHA_HIT_WIDTH
    }

    /// A left press at widget line `line` and column `column`. Counts double clicks and emits
    /// [`HistoryEvent::Click`]. Avatar images lie over the list and pass their presses here. Returns false when
    /// no row is under the line.
    pub fn press(&mut self, cx: &mut Cx<'_>, line: i32, column: i32) -> bool {
        let Some(row) = self.row_at_line(line) else {
            return false;
        };
        let part = if self.on_sha(column) {
            ClickPart::Sha
        } else if self.on_label(row, column) {
            ClickPart::Label
        } else {
            ClickPart::Row
        };
        let now = cx.app().now();
        let mut doubled = false;
        // `historyClick` returns on a SHA press before it looks at double clicks.
        if part != ClickPart::Sha {
            let label = part == ClickPart::Label;
            doubled = self.last_press.is_some_and(|(last_row, last_label, at)| {
                last_row == row && last_label == label && now.duration_since(at) < DOUBLE_CLICK
            });
            self.last_press = if doubled {
                None
            } else {
                Some((row, label, now))
            };
        }
        self.emit(
            cx,
            HistoryEvent::Click {
                row,
                column: u16::try_from(column.max(0)).unwrap_or(u16::MAX),
                part,
                clicks: if doubled { 2 } else { 1 },
            },
        );
        true
    }

    /// The commit graph dots that an avatar can cover, for a widget of `width` by `height` cells. Slots are body
    /// lines, so an image keeps its terminal row while commits scroll under it. Rows whose lane is scrolled out of
    /// view have no slot. The background ignores hover, which the shell does not see.
    pub fn avatar_slots(&self, width: u32, height: u32) -> Vec<AvatarSlot> {
        let theme = &self.theme;
        let data = &*self.window;
        let columns = visible_history_columns(self.columns, data.pr_column);
        let geometry = history_column_layout(i64::from(width), data.graph_columns, columns);
        let visible = geometry.graph_columns;
        let scroll =
            clamp_graph_scroll(self.graph_scroll as i64, data.graph_columns, visible) as i64;
        let lines = (height as usize).saturating_sub(1).max(1);
        let has_working = data.working_files > 0;
        let first_row = data.start.max(usize::from(has_working && data.start == 0));
        let leading = usize::from(has_working);
        let window_from = first_row.saturating_sub(leading);
        let backgrounds = [theme.bg, theme.panel_raised];
        let first_line = usize::from(has_working && data.start == 0);
        let mut slots = Vec::new();
        for (line, row_index) in (first_line..lines).zip(first_row..data.total()) {
            let commit_index = row_index - leading;
            let Some(entry) = data.rows.get(commit_index - window_from) else {
                break;
            };
            let row = &entry.graph;
            let lane = row.lane as i64;
            if lane >= scroll && lane < scroll + visible as i64 {
                let selected = self.selected == Some(row_index);
                slots.push(AvatarSlot {
                    line,
                    sha: entry.commit.sha.clone(),
                    author_email: entry.commit.author_email.clone(),
                    color: row
                        .color_at(row.lane)
                        .and_then(Rgba::parse)
                        .unwrap_or(theme.accent),
                    background: interaction_background(
                        theme,
                        backgrounds[commit_index % 2],
                        false,
                        selected,
                        false,
                    ),
                    continues_above: row.continues_above,
                    continues_below: !entry.commit.parents.is_empty(),
                    left: geometry.branch_width + 2 + (lane - scroll) * 2 - 1,
                    top: line as i64 + 1,
                });
            }
        }
        slots
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
        let columns = visible_history_columns(self.columns, data.pr_column);
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
        if columns.show_pr == Some(true) {
            line.push(separator(" │ "));
            line.push(span(
                fit_columns("PR", geometry.pr_width, false),
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
            if columns.show_pr == Some(true) {
                line.push(span(
                    format!("   {}", " ".repeat(geometry.pr_width.max(0) as usize)),
                    theme.border,
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
            // `paintHistory`: the selected row shows its branch hint in place of a missing label.
            let primary = if selected_row == Some(row_index) && entry.label.is_empty() {
                &entry.hint
            } else {
                &entry.label
            };
            let extra = entry.extra;
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
            if columns.show_pr == Some(true) {
                line.push(span("   ".to_string(), theme.border, bg));
                let matches: Vec<&PullRequest> = entry.pull_requests.iter().collect();
                let frame = SPINNER_FRAMES[self.spinner];
                let cell = pull_request_history_cell(
                    &matches,
                    geometry.pr_width.max(0) as usize,
                    theme,
                    frame,
                );
                for part in cell {
                    line.push(span(part.text, part.color, bg));
                }
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
        self.width.set(width);
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

    fn mouse(&mut self, cx: &mut Cx<'_>, event: &MouseEvent, local: (i32, i32)) -> bool {
        self.pointer.record(event);
        self.origin = Some(origin_of(event, local));
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
            MouseEventKind::Down(MouseButton::Right) => {
                let Some(row) = self.row_at_line(local.1) else {
                    return false;
                };
                HistoryEvent::Menu {
                    row,
                    on_label: self.on_label(row, local.0),
                    x: event.x,
                    y: event.y,
                }
            }
            MouseEventKind::Down(MouseButton::Left) => return self.press(cx, local.1, local.0),
            _ => return false,
        };
        self.emit(cx, event);
        true
    }
}

#[cfg(test)]
#[path = "history_tests.rs"]
mod tests;
