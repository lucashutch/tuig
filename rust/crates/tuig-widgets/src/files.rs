//! The changed-files pane: file lists with their section label, action buttons and split bars. Ports `paintSection`
//! and the mouse handlers of `makeFileList`, `makeFileLabel` and `makeHorizontalDivider` in `src/ui/runtime-paint.ts` and
//! `src/ui/runtime-widgets.ts`.
//!
//! The widgets hold no file state. The shell builds a [`FileListData`] for the rows on screen, flattened from the
//! tree and sliced to the viewport, and passes it to [`FileList::set_data`]. Mouse input comes back as
//! [`FileListEvent`] through [`FileList::on_event`]. Row numbers in events are indexes into the whole flattened
//! list, so the shell does not need to know the viewport offset.
//!
//! Known parity gaps with the TypeScript widgets: a right click does nothing (the file menu is not ported), hover
//! colors on [`ActionButton`] and [`SplitBar`] are missing, and the split bar accepts a drag on its one row only,
//! where TS also accepts the row above it.

use opentui::prelude::*;
use std::cell::Cell;
use std::rc::Rc;
use tuig_git::types::FileState;
use tuig_ui_model::changes_layout::file_color;
use tuig_ui_model::color::Rgba;
use tuig_ui_model::file_tree::{
    FileRowAction, FileRowActionHit, FileSection, file_row_action_hits,
};
use tuig_ui_model::history_viewport::WHEEL_ROWS;
use tuig_ui_model::icon_theme::resolve_material_icon;
use tuig_ui_model::text_width::{fit_tree_label, string_width};
use tuig_ui_model::theme::Theme;

/// One visible tree row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileRow {
    pub name: String,
    /// Repository-relative path. The shell uses it as the row identity.
    pub path: String,
    pub depth: usize,
    pub directory: bool,
    pub expanded: bool,
    /// The file state, or for a directory the strongest state below it.
    pub state: Option<FileState>,
}

/// Which list this is. The commit list uses the same widget as the unstaged list, as in TS.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ListKind {
    #[default]
    Unstaged,
    Staged,
    Commit,
}

/// What the list shows besides rows.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum ListStatus {
    #[default]
    Ready,
    /// A commit's files are being read. TS draws three rows of `░`.
    Loading,
    Failed(String),
}

#[derive(Debug, Clone, Default)]
pub struct FileListData {
    pub kind: ListKind,
    /// Files in the list, for the label.
    pub count: usize,
    pub collapsed: bool,
    /// The label takes the focus color: the changes pane has focus and this is its active section.
    pub active: bool,
    /// Index in the flattened list of `rows[0]`.
    pub start: usize,
    pub rows: Vec<FileRow>,
    pub selected_path: Option<String>,
    pub status: ListStatus,
    /// A comparison of two commits. Changes the empty text.
    pub compared: bool,
    /// Working lists show Stage, Discard or Unstage on the hovered row. `None` for the commit list.
    pub actions: Option<FileSection>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileListEvent {
    /// A left press on a row. `column` is in cells from the list's left edge.
    Click {
        row: usize,
        column: u16,
    },
    Wheel(i32),
    /// A left press on the label.
    ToggleSection,
    /// A left press on a hover action of `row`.
    RowAction {
        row: usize,
        action: FileRowAction,
    },
}

type ListHandler = Box<dyn FnMut(&mut Cx<'_>, FileListEvent)>;
type PressHandler = Box<dyn FnMut(&mut Cx<'_>)>;
type SplitHandler = Box<dyn FnMut(&mut Cx<'_>, SplitEvent)>;

pub struct FileList {
    data: Rc<FileListData>,
    theme: Theme,
    hovered: Option<usize>,
    /// The width of the last paint, for hit tests on the hover actions.
    width: Cell<u32>,
    on_event: Option<ListHandler>,
}

fn to_color(color: Rgba) -> Color {
    Color::rgba(color.r, color.g, color.b, color.a)
}

/// One run of cells. `bg: None` keeps what is under it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Span {
    pub text: String,
    pub fg: Rgba,
    pub bg: Option<Rgba>,
}

fn paint_lines(painter: &mut Painter<'_>, lines: &[Vec<Span>]) {
    for (y, line) in lines.iter().enumerate() {
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

impl FileList {
    pub fn new(theme: Theme) -> Self {
        Self {
            data: Rc::default(),
            theme,
            hovered: None,
            width: Cell::new(0),
            on_event: None,
        }
    }

    pub fn set_data(&mut self, data: Rc<FileListData>) {
        self.data = data;
    }

    pub fn set_theme(&mut self, theme: &Theme) {
        self.theme = theme.clone();
    }

    /// The handler must not call `Custom::update` or `Custom::with` on this widget. Queue a message instead.
    pub fn on_event(&mut self, handler: impl FnMut(&mut Cx<'_>, FileListEvent) + 'static) {
        self.on_event = Some(Box::new(handler));
    }

    fn emit(&mut self, cx: &mut Cx<'_>, event: FileListEvent) {
        if let Some(handler) = self.on_event.as_mut() {
            handler(cx, event);
        }
    }

    /// The row index under widget line `line`, where line 0 is the label.
    fn row_at_line(&self, line: i32) -> Option<usize> {
        let row = usize::try_from(line.checked_sub(1)?).ok()?;
        (row < self.data.rows.len() && !self.data.collapsed).then_some(row)
    }

    fn hover_actions(&self, row: usize, depth: usize, width: usize) -> Vec<FileRowActionHit> {
        match self.data.actions {
            Some(section) if self.hovered == Some(row) => {
                file_row_action_hits(section, width, 6 + depth * 2)
            }
            _ => Vec::new(),
        }
    }

    /// The lines the widget draws at `width` by `height` cells.
    pub fn render(&self, width: u32, height: u32) -> Vec<Vec<Span>> {
        let theme = &self.theme;
        let data = &*self.data;
        let span = |text: String, fg: Rgba, bg: Option<Rgba>| Span { text, fg, bg };
        let label = match data.kind {
            ListKind::Commit => format!(" COMMIT FILES  {}", data.count),
            kind => format!(
                " {} {} files ({})",
                if data.collapsed { "▶" } else { "▼" },
                if kind == ListKind::Staged {
                    "Staged"
                } else {
                    "Unstaged"
                },
                data.count
            ),
        };
        let label_color = if data.kind == ListKind::Commit || data.active {
            theme.focus_ring
        } else {
            theme.muted
        };
        let mut out = vec![vec![span(label, label_color, None)]];
        if data.collapsed {
            return out;
        }
        let limit = (height as usize).saturating_sub(1);
        let width_cells = width as usize;
        match &data.status {
            ListStatus::Loading => {
                out.push(vec![span(
                    "  ░░░░░░░░░░░░░░░".to_string(),
                    theme.muted,
                    None,
                )]);
                out.push(vec![span("  ░░░░░░░░░░".to_string(), theme.muted, None)]);
                out.push(vec![span("  ░░░░░░░░░░░░".to_string(), theme.muted, None)]);
                return out;
            }
            ListStatus::Failed(message) => {
                out.push(vec![span(
                    "  Failed to load changed files".to_string(),
                    theme.text,
                    None,
                )]);
                out.push(vec![span(format!("  {message}"), theme.text, None)]);
                return out;
            }
            ListStatus::Ready => {}
        }
        if data.rows.is_empty() {
            let muted = |text: &str| vec![span(text.to_string(), theme.muted, None)];
            match data.kind {
                ListKind::Commit => {
                    out.push(muted(if data.compared {
                        "  No changed files between these commits"
                    } else {
                        "  No changed files in this commit"
                    }));
                    out.push(muted("  esc  back to the graph"));
                }
                ListKind::Staged => out.push(muted("  Nothing staged")),
                ListKind::Unstaged => out.push(muted("  Nothing to stage")),
            }
            return out;
        }
        for (index, row) in data.rows.iter().enumerate().take(limit) {
            let selected = !row.directory && data.selected_path.as_deref() == Some(&row.path);
            let hovered = data.actions.is_some() && self.hovered == Some(index);
            let bg = if selected {
                Some(theme.selected)
            } else if hovered {
                Some(theme.hover)
            } else {
                None
            };
            let color = file_color(row.state, row.directory, theme);
            let icon =
                resolve_material_icon(&row.name, row.directory, row.directory && row.expanded);
            let actions = self.hover_actions(index, row.depth, width_cells.max(1));
            let action_width: usize = actions.iter().map(|action| action.label.len()).sum();
            let tree_label = fit_tree_label(
                &row.name,
                (width_cells as i64 - row.depth as i64 * 2 - 7 - action_width as i64).max(1),
            );
            let used = 2 + row.depth * 2 + 2 + 2 + string_width(&tree_label);
            let padding = width_cells.saturating_sub(used + action_width);
            let mut line = vec![span(
                if selected { "▸ " } else { "  " }.to_string(),
                if selected { theme.text } else { theme.muted },
                bg,
            )];
            line.push(span("│ ".repeat(row.depth), theme.border, bg));
            line.push(if row.directory {
                span(
                    if row.expanded { "▼ " } else { "▶ " }.to_string(),
                    theme.folder,
                    bg,
                )
            } else {
                span("  ".to_string(), theme.muted, bg)
            });
            line.push(span(
                format!("{} ", icon.glyph),
                color.or(icon.color).unwrap_or(theme.folder),
                bg,
            ));
            line.push(span(
                tree_label,
                if row.directory {
                    theme.folder
                } else {
                    theme.text
                },
                bg,
            ));
            line.push(span(" ".repeat(padding), theme.muted, bg));
            for action in actions {
                let fg = match action.action {
                    FileRowAction::Discard => theme.deleted,
                    FileRowAction::Stage => theme.added,
                    FileRowAction::Unstage => theme.warning,
                };
                line.push(span(action.label.to_string(), fg, bg));
            }
            out.push(line);
        }
        out
    }
}

impl Component for FileList {
    fn paint(&self, painter: &mut Painter<'_>) {
        let (width, height) = painter.size();
        self.width.set(width);
        painter.fill(0, 0, width, height, to_color(self.theme.panel));
        paint_lines(painter, &self.render(width, height));
    }

    fn focus_changed(&mut self, _cx: &mut Cx<'_>, focused: bool) {
        if !focused {
            self.hovered = None;
        }
    }

    fn mouse(&mut self, cx: &mut Cx<'_>, event: &MouseEvent, local: (i32, i32)) -> bool {
        let event = match event.kind {
            MouseEventKind::Moved => {
                let hovered = self.row_at_line(local.1);
                let changed = hovered != self.hovered;
                self.hovered = hovered;
                return changed;
            }
            MouseEventKind::ScrollUp => FileListEvent::Wheel(-WHEEL_ROWS),
            MouseEventKind::ScrollDown => FileListEvent::Wheel(WHEEL_ROWS),
            MouseEventKind::Down(MouseButton::Left) if local.1 == 0 => FileListEvent::ToggleSection,
            MouseEventKind::Down(MouseButton::Left) => {
                let Some(index) = self.row_at_line(local.1) else {
                    return false;
                };
                let row = &self.data.rows[index];
                let column = usize::try_from(local.0).unwrap_or(0);
                let width = self.width.get() as usize;
                let hit = self
                    .hover_actions(index, row.depth, width)
                    .into_iter()
                    .find(|hit| (hit.start..hit.end).contains(&column));
                match hit {
                    Some(hit) => FileListEvent::RowAction {
                        row: self.data.start + index,
                        action: hit.action,
                    },
                    None => FileListEvent::Click {
                        row: self.data.start + index,
                        column: u16::try_from(column).unwrap_or(u16::MAX),
                    },
                }
            }
            _ => return false,
        };
        self.emit(cx, event);
        true
    }
}

/// A one-row button. Used for the pane actions: Discard all, Stage all, Unstage all.
pub struct ActionButton {
    label: String,
    fg: Rgba,
    theme: Theme,
    on_press: Option<PressHandler>,
}

impl ActionButton {
    pub fn new(theme: Theme, label: &str, fg: Rgba) -> Self {
        Self {
            label: label.to_string(),
            fg,
            theme,
            on_press: None,
        }
    }

    /// The width in cells, for placing the widget.
    pub fn width(&self) -> usize {
        string_width(&self.label)
    }

    /// The handler must not call `Custom::update` or `Custom::with` on this widget. Queue a message instead.
    pub fn on_press(&mut self, handler: impl FnMut(&mut Cx<'_>) + 'static) {
        self.on_press = Some(Box::new(handler));
    }
}

impl Component for ActionButton {
    fn paint(&self, painter: &mut Painter<'_>) {
        let (width, height) = painter.size();
        painter.fill(0, 0, width, height, to_color(self.theme.panel_raised));
        painter.text(
            0,
            0,
            &self.label,
            Style::new()
                .fg(to_color(self.fg))
                .bg(to_color(self.theme.panel_raised)),
        );
    }

    fn mouse(&mut self, cx: &mut Cx<'_>, event: &MouseEvent, _local: (i32, i32)) -> bool {
        if event.kind != MouseEventKind::Down(MouseButton::Left) {
            return false;
        }
        if let Some(handler) = self.on_press.as_mut() {
            handler(cx);
        }
        true
    }
}

/// What a drag on a [`SplitBar`] reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SplitEvent {
    /// The pointer moved to screen row `y` while the button was down.
    Drag { y: u16 },
}

/// The grip line between two sections, `───━━━━━───`. Dragging it asks the shell to move the split.
pub struct SplitBar {
    theme: Theme,
    dragging: bool,
    on_event: Option<SplitHandler>,
}

impl SplitBar {
    pub fn new(theme: Theme) -> Self {
        Self {
            theme,
            dragging: false,
            on_event: None,
        }
    }

    /// The handler must not call `Custom::update` or `Custom::with` on this widget. Queue a message instead.
    pub fn on_event(&mut self, handler: impl FnMut(&mut Cx<'_>, SplitEvent) + 'static) {
        self.on_event = Some(Box::new(handler));
    }

    /// The bar text for `width` cells: a thin line with a thick grip in the middle.
    pub fn content(width: u32) -> String {
        let width = width.max(1) as usize;
        let grip = (width / 3).clamp(3, 5);
        let start = (width.saturating_sub(grip)) / 2;
        let end = width.saturating_sub(start + grip);
        format!(
            "{}{}{}",
            "─".repeat(start),
            "━".repeat(grip),
            "─".repeat(end)
        )
    }
}

impl Component for SplitBar {
    fn paint(&self, painter: &mut Painter<'_>) {
        let (width, height) = painter.size();
        let mut style = Style::new().fg(to_color(self.theme.divider));
        let bg = if self.dragging {
            self.theme.pressed
        } else {
            self.theme.panel
        };
        style = style.bg(to_color(bg));
        painter.fill(0, 0, width, height, to_color(bg));
        painter.text(0, 0, &Self::content(width), style);
    }

    fn mouse(&mut self, cx: &mut Cx<'_>, event: &MouseEvent, _local: (i32, i32)) -> bool {
        match event.kind {
            MouseEventKind::Down(MouseButton::Left) => {
                self.dragging = true;
                true
            }
            MouseEventKind::Drag(MouseButton::Left) => {
                if let Some(handler) = self.on_event.as_mut() {
                    handler(cx, SplitEvent::Drag { y: event.y });
                }
                true
            }
            MouseEventKind::Up(_) if self.dragging => {
                self.dragging = false;
                true
            }
            _ => false,
        }
    }
}
