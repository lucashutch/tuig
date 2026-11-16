//! The left sidebar: branch, pull request, submodule, stash and worktree sections, and the vertical dividers between
//! the panes. Ports `paintSidebar` and the renderables of `createRuntimeWidgets` in `src/ui/runtime-paint.ts`,
//! `src/ui/runtime-widgets.ts` and `src/ui/runtime-presentation-sidebar.ts`.
//!
//! [`present_sidebar`] turns the snapshot into a [`SidebarView`] that holds only the rows on screen. The [`Sidebar`]
//! widget paints that view and reports raw pointer input as [`SidebarEvent`]. The shell decides what a press or a
//! wheel notch means. The widget keeps the hit boxes that TS gives to its header and divider renderables.
//!
//! Known parity gap: the divider bars have no hover color. OpenTUI reports no pointer-leave event, so a hover could
//! not be cleared.

use crate::decorations::{
    HEAD_ICON, LAPTOP_BRANCH_ICON, REMOTE_BRANCH_ICON, RefIndex, display_branch_name,
};
use crate::files::Span;
use crate::pull_requests::{
    PullRequestPanel, StyledSegment, fit_segments, pull_request_panel_rows,
    pull_request_sidebar_row,
};
use opentui::prelude::*;
use std::rc::Rc;
use tuig_git::pull_request_types::CheckRollup;
use tuig_git::types::{BranchRef, RepositorySnapshot, Submodule, SubmoduleState, Worktree};
use tuig_ui_model::color::Rgba;
use tuig_ui_model::graph_menu::clip_columns;
use tuig_ui_model::history_viewport::WHEEL_ROWS;
use tuig_ui_model::runtime_layout::vertical_divider_content;
use tuig_ui_model::scrollbar::{ScrollbarCell, scrollbar_cell, scrollbar_thumb};
use tuig_ui_model::sidebar::{PerSection, Section, SidebarRect, sidebar_header};
use tuig_ui_model::text_width::{fit_columns, take_columns};
use tuig_ui_model::theme::Theme;

/// Worktree marker. `WORKTREE_ICON` in `src/ui/history.ts`.
pub const WORKTREE_ICON: &str = "⎇";

fn to_color(color: Rgba) -> Color {
    Color::rgba(color.r, color.g, color.b, color.a)
}

/// The text of the rows on screen for one section.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SectionView {
    pub header: String,
    pub collapsed: bool,
    /// Rows in the section, including those scrolled out of view.
    pub total: usize,
    /// The first visible row, clamped to the row count.
    pub start: usize,
    /// One line per content row, without the scrollbar cell. Each is as wide as the pane minus one column.
    pub lines: Vec<Vec<Span>>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct SidebarView {
    /// Pane width in cells. The last column holds the scrollbars.
    pub width: i64,
    pub rects: PerSection<SidebarRect>,
    pub sections: PerSection<SectionView>,
}

/// What [`present_sidebar`] reads.
pub struct SidebarInput<'a> {
    pub snapshot: &'a RepositorySnapshot,
    pub refs: &'a RefIndex,
    pub panel: &'a PullRequestPanel,
    pub theme: &'a Theme,
    pub spinner_frame: &'a str,
    pub rects: PerSection<SidebarRect>,
    pub collapsed: PerSection<bool>,
    pub start: PerSection<usize>,
    pub width: i64,
    pub filter: &'a str,
}

pub struct Presented {
    pub view: SidebarView,
    /// Each section's first row after clamping. `paintSidebar` writes it back so a shrunk list does not keep a
    /// stale offset.
    pub start: PerSection<usize>,
    /// A visible pull request row shows running checks, so the spinner must run.
    pub running_checks: bool,
}

/// Builds the predicate behind the branch filter. `branchRefFilter`: a case-insensitive substring of a ref's name,
/// full name, or either without its `refs/` and `origin/` prefix.
pub fn branch_ref_filter(query: &str) -> impl Fn(&BranchRef) -> bool {
    let needle = query.trim().to_lowercase();
    move |branch| {
        needle.is_empty()
            || [
                branch.name.as_str(),
                branch.full_name.as_str(),
                display_branch_name(&branch.name),
                display_branch_name(&branch.full_name),
            ]
            .iter()
            .any(|value| value.to_lowercase().contains(&needle))
    }
}

/// The local or remote branches that match `filter`, in snapshot order. `branchRefsForSection`.
pub fn filtered_branches<'a>(
    snapshot: &'a RepositorySnapshot,
    section: Section,
    filter: &str,
) -> Vec<&'a BranchRef> {
    let remote = section == Section::Remote;
    let matches = branch_ref_filter(filter);
    snapshot
        .branches
        .iter()
        .filter(|branch| branch.remote == remote && matches(branch))
        .collect()
}

/// Rows a section scrolls through. Stashes, worktrees and submodules take two rows each.
pub fn row_total(
    snapshot: &RepositorySnapshot,
    section: Section,
    panel: &PullRequestPanel,
    filter: &str,
) -> usize {
    match section {
        Section::Local | Section::Remote => filtered_branches(snapshot, section, filter).len(),
        Section::PullRequests => pull_request_panel_rows(panel),
        Section::Submodules => snapshot.submodules.len() * 2,
        Section::Stashes => snapshot.stashes.len() * 2,
        Section::Worktrees => snapshot.worktrees.len() * 2,
    }
}

/// The scrollbar glyph for one track row, or a space when every row fits. `sidebarScrollbar`.
pub fn scrollbar_glyph(total: usize, start: usize, viewport: usize, row: usize) -> char {
    if total <= viewport {
        return ' ';
    }
    let thumb = scrollbar_thumb(total as i64, start as i64, viewport as i64);
    match scrollbar_cell(&thumb, row as i64) {
        ScrollbarCell::Full => '█',
        ScrollbarCell::Upper => '▀',
        ScrollbarCell::Lower => '▄',
        ScrollbarCell::None => '│',
    }
}

/// The last path component, or the whole path when it has none. `submoduleDisplayName`.
fn submodule_display_name(submodule: &Submodule) -> &str {
    submodule
        .path
        .split('/')
        .rfind(|part| !part.is_empty())
        .unwrap_or(&submodule.path)
}

fn submodule_status_color(submodule: &Submodule, theme: &Theme) -> Rgba {
    match submodule.state {
        SubmoduleState::Clean => theme.added,
        SubmoduleState::Different => theme.warning,
        _ => theme.deleted,
    }
}

pub struct WorktreeRow {
    pub label: String,
    pub detail: String,
    pub current: bool,
}

/// Labels every worktree and marks the one this session has open. The detail line names what each has checked
/// out. `worktreeRows`.
pub fn worktree_rows(worktrees: &[Worktree], root: &str, width: i64) -> Vec<WorktreeRow> {
    let normalise = |path: &str| path.trim_end_matches('/').to_owned();
    // A wrapped row would spill out of the pane, so both lines are clipped.
    let columns = 6.max(width - 1);
    worktrees
        .iter()
        .map(|worktree| {
            let path = normalise(&worktree.path);
            let current = path == normalise(root);
            let name = path.rsplit('/').next().unwrap_or_default();
            let checkout = if worktree.bare {
                "bare".to_owned()
            } else if let Some(branch) = &worktree.branch {
                format!("on {branch}")
            } else {
                format!(
                    "detached at {}",
                    worktree.sha.chars().take(7).collect::<String>()
                )
            };
            // A prunable worktree without a reason has an empty string in TS, which is falsy.
            let prunable = worktree
                .prunable
                .as_deref()
                .is_some_and(|reason| !reason.is_empty());
            WorktreeRow {
                label: clip_columns(
                    &format!(
                        " {} {name}{}",
                        if current { HEAD_ICON } else { WORKTREE_ICON },
                        if prunable { " ⚠" } else { "" }
                    ),
                    columns,
                ),
                detail: clip_columns(&format!("  {checkout}"), columns),
                current,
            }
        })
        .collect()
}

fn span(text: String, fg: Rgba) -> Span {
    Span { text, fg, bg: None }
}

/// A row body, padded or cut to the pane width minus the scrollbar column.
fn body(text: &str, fg: Rgba, width: i64) -> Vec<Span> {
    if width <= 1 {
        return Vec::new();
    }
    vec![span(fit_columns(text, width - 1, false), fg)]
}

fn segments(parts: Vec<StyledSegment>) -> Vec<Span> {
    parts
        .into_iter()
        .map(|part| span(part.text, part.color))
        .collect()
}

/// Builds what the sidebar paints. `paintSidebar` and the `render*SidebarViewport` functions.
pub fn present_sidebar(input: &SidebarInput<'_>) -> Presented {
    let snapshot = input.snapshot;
    let theme = input.theme;
    let width = input.width.max(1);
    let mut view = SidebarView {
        width,
        rects: input.rects,
        sections: PerSection::default(),
    };
    let mut starts = input.start;
    let mut running_checks = false;
    for section in Section::ALL {
        let rect = input.rects[section];
        if rect.hidden {
            continue;
        }
        let collapsed = input.collapsed[section];
        let total = row_total(snapshot, section, input.panel, input.filter);
        let viewport = usize::try_from(rect.content_height).unwrap_or(0);
        let start = input.start[section].min(total.saturating_sub(viewport));
        if !collapsed {
            starts[section] = start;
        }
        let count = match section {
            Section::Local | Section::Remote => total,
            Section::PullRequests => match input.panel {
                PullRequestPanel::List(list) => list.len(),
                _ => 0,
            },
            Section::Submodules => snapshot.submodules.len(),
            Section::Stashes => snapshot.stashes.len(),
            Section::Worktrees => snapshot.worktrees.len(),
        };
        let mut lines = Vec::new();
        if !collapsed {
            // Branch rows come from the filtered list. Build it once for the whole viewport.
            let branches = matches!(section, Section::Local | Section::Remote)
                .then(|| filtered_branches(snapshot, section, input.filter));
            let worktrees = (section == Section::Worktrees && !snapshot.worktrees.is_empty())
                .then(|| worktree_rows(&snapshot.worktrees, &snapshot.root, width));
            for offset in 0..viewport {
                let index = start + offset;
                let line = match section {
                    Section::Local | Section::Remote => {
                        let icon = if section == Section::Remote {
                            REMOTE_BRANCH_ICON
                        } else {
                            LAPTOP_BRANCH_ICON
                        };
                        match branches.as_ref().and_then(|list| list.get(index)) {
                            Some(branch) => body(
                                &format!(
                                    "{} {icon} {}",
                                    input.refs.presence_icon(branch),
                                    display_branch_name(&branch.name)
                                ),
                                theme.text,
                                width,
                            ),
                            None => body(none_row(total, offset), theme.text, width),
                        }
                    }
                    Section::PullRequests => {
                        let body_width = (width - 1).max(0) as usize;
                        let pull_request = match input.panel {
                            PullRequestPanel::List(list) => list.get(index),
                            _ => None,
                        };
                        if let Some(pull_request) = pull_request {
                            running_checks |= pull_request.checks == CheckRollup::Running;
                        }
                        if width == 1 {
                            Vec::new()
                        } else if let Some(pull_request) = pull_request {
                            segments(pull_request_sidebar_row(
                                pull_request,
                                body_width,
                                theme,
                                input.spinner_frame,
                            ))
                        } else {
                            let text = if offset == 0 && start == 0 {
                                match input.panel {
                                    PullRequestPanel::Loading => "  Loading...".to_owned(),
                                    PullRequestPanel::Message(text) => format!("  {text}"),
                                    PullRequestPanel::List(_) => "  (none)".to_owned(),
                                    PullRequestPanel::Hidden => String::new(),
                                }
                            } else {
                                String::new()
                            };
                            let parts = if text.is_empty() {
                                Vec::new()
                            } else {
                                vec![StyledSegment {
                                    text,
                                    color: theme.muted,
                                }]
                            };
                            segments(fit_segments(&parts, body_width, theme.muted))
                        }
                    }
                    Section::Submodules => match snapshot.submodules.get(index / 2) {
                        Some(submodule) if index.is_multiple_of(2) => {
                            let mark = match submodule.state {
                                SubmoduleState::Clean => "✓",
                                SubmoduleState::Uninitialized => "✖",
                                _ => "!",
                            };
                            body(
                                &format!(" {mark} {}", submodule_display_name(submodule)),
                                submodule_status_color(submodule, theme),
                                width,
                            )
                        }
                        Some(submodule) => {
                            body(&format!("   {}", submodule.path), theme.muted, width)
                        }
                        None => body(
                            none_row(total, offset),
                            if total == 0 { theme.text } else { theme.muted },
                            width,
                        ),
                    },
                    Section::Stashes => match snapshot.stashes.get(index / 2) {
                        Some(stash) if index.is_multiple_of(2) => {
                            body(&format!(" ◇ {}", stash.subject), theme.text, width)
                        }
                        Some(stash) => body(
                            &format!(
                                "   on {} • {}",
                                stash.branch.as_deref().unwrap_or("unknown branch"),
                                stash.created_at
                            ),
                            theme.muted,
                            width,
                        ),
                        None => body(
                            none_row(total, offset),
                            if total == 0 || index.is_multiple_of(2) {
                                theme.text
                            } else {
                                theme.muted
                            },
                            width,
                        ),
                    },
                    Section::Worktrees => {
                        match worktrees.as_ref().and_then(|rows| rows.get(index / 2)) {
                            Some(row) if index.is_multiple_of(2) => body(
                                &row.label,
                                if row.current {
                                    theme.warning
                                } else {
                                    theme.text
                                },
                                width,
                            ),
                            Some(row) => body(&row.detail, theme.muted, width),
                            None => body(
                                none_row(total, offset),
                                if total == 0 || index.is_multiple_of(2) {
                                    theme.text
                                } else {
                                    theme.muted
                                },
                                width,
                            ),
                        }
                    }
                };
                lines.push(line);
            }
        }
        view.sections[section] = SectionView {
            header: sidebar_header(section, count, collapsed),
            collapsed,
            total,
            start,
            lines,
        };
    }
    Presented {
        view,
        start: starts,
        running_checks: running_checks && !input.collapsed[Section::PullRequests],
    }
}

/// The text of a row past the end of the list. An empty section shows `(none)` on its first row.
fn none_row(total: usize, offset: usize) -> &'static str {
    if total == 0 && offset == 0 {
        "  (none)"
    } else {
        ""
    }
}

/// Events from the [`Sidebar`]. Rows are pane-local: row 0 is the first row under the toolbar.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SidebarEvent {
    /// A left or right press that is not on a header. `x` and `y` are pane-local. `screen` is the terminal cell,
    /// for placing a menu.
    Press {
        x: i64,
        y: i64,
        button: MouseButton,
        screen: (u16, u16),
    },
    /// The pointer moved with a button down.
    Drag {
        y: i64,
    },
    /// The button came up.
    Release,
    Wheel {
        y: i64,
        delta: i32,
    },
    /// A press on a section header.
    Toggle(Section),
    /// A divider drag reached pane-local row `y`.
    Resize {
        section: Section,
        y: i64,
    },
}

type SidebarHandler = Box<dyn FnMut(&mut Cx<'_>, SidebarEvent)>;

pub struct Sidebar {
    view: Rc<SidebarView>,
    theme: Theme,
    /// The section whose divider a drag started on.
    divider_drag: Option<Section>,
    on_event: Option<SidebarHandler>,
}

impl Sidebar {
    pub fn new(theme: Theme) -> Self {
        Self {
            view: Rc::default(),
            theme,
            divider_drag: None,
            on_event: None,
        }
    }

    pub fn set_view(&mut self, view: Rc<SidebarView>) {
        self.view = view;
    }

    pub fn set_theme(&mut self, theme: &Theme) {
        self.theme = theme.clone();
    }

    /// The handler must not call `Custom::update` or `Custom::with` on this widget. Queue a message instead.
    pub fn on_event(&mut self, handler: impl FnMut(&mut Cx<'_>, SidebarEvent) + 'static) {
        self.on_event = Some(Box::new(handler));
    }

    fn emit(&mut self, cx: &mut Cx<'_>, event: SidebarEvent) {
        if let Some(handler) = self.on_event.as_mut() {
            handler(cx, event);
        }
    }

    /// Columns the header text takes: TS gives it `left: 1` and `width: 95%`, which rounds to this on the pixel grid.
    fn header_hit(&self) -> std::ops::Range<i64> {
        let end = (1.0 + self.view.width as f64 * 0.95 + 0.5).floor() as i64;
        1..end
    }

    fn header_at(&self, x: i64, y: i64) -> Option<Section> {
        if !self.header_hit().contains(&x) {
            return None;
        }
        Section::ALL.into_iter().rev().find(|section| {
            let rect = self.view.rects[*section];
            !rect.hidden && rect.header_top == y
        })
    }

    /// The divider whose hit box holds `y`: its row and the content row above it. Later sections sit on top.
    fn divider_at(&self, y: i64) -> Option<Section> {
        Section::ALL.into_iter().rev().find(|section| {
            let rect = self.view.rects[*section];
            !rect.hidden
                && rect
                    .divider_top
                    .is_some_and(|top| y == top || y == (top - 1).max(0))
        })
    }

    fn paint_header(&self, painter: &mut Painter<'_>, section: Section, rect: SidebarRect) {
        let view = &self.view.sections[section];
        let room = usize::try_from(self.header_hit().end - 1).unwrap_or(0);
        painter.text(
            1,
            rect.header_top as i32,
            &take_columns(&view.header, room, false),
            Style::new().fg(to_color(self.theme.muted)),
        );
    }
}

impl Component for Sidebar {
    fn paint(&self, painter: &mut Painter<'_>) {
        let (width, height) = painter.size();
        let theme = &self.theme;
        painter.fill(0, 0, width, height, to_color(theme.panel));
        let pane = self.view.width.max(1);
        for section in Section::ALL {
            let rect = self.view.rects[section];
            if rect.hidden {
                continue;
            }
            let view = &self.view.sections[section];
            if i64::from(height) > rect.header_top {
                self.paint_header(painter, section, rect);
            }
            if !view.collapsed {
                let viewport = usize::try_from(rect.content_height).unwrap_or(0);
                for (offset, line) in view.lines.iter().enumerate() {
                    let y = (rect.content_top + offset as i64) as i32;
                    let mut x = 0;
                    for part in line {
                        painter.text(x, y, &part.text, Style::new().fg(to_color(part.fg)));
                        // Advance by the width OpenTUI draws with, so a span never overlaps the next one.
                        x += painter.text_width(&part.text) as i32;
                    }
                    let glyph = scrollbar_glyph(view.total, view.start, viewport, offset);
                    painter.text(
                        (pane - 1) as i32,
                        y,
                        &glyph.to_string(),
                        Style::new().fg(to_color(theme.text)),
                    );
                }
            }
            if let Some(top) = rect.divider_top {
                let mut style = Style::new().fg(to_color(theme.divider));
                if self.divider_drag == Some(section) {
                    style = style.bg(to_color(theme.pressed));
                }
                painter.text(0, top as i32, &divider_line(pane), style);
            }
        }
    }

    fn mouse(&mut self, cx: &mut Cx<'_>, event: &MouseEvent, local: (i32, i32)) -> bool {
        let (x, y) = (i64::from(local.0), i64::from(local.1));
        let kind = match event.kind {
            MouseEventKind::ScrollUp => {
                self.emit(
                    cx,
                    SidebarEvent::Wheel {
                        y,
                        delta: -WHEEL_ROWS,
                    },
                );
                return true;
            }
            MouseEventKind::ScrollDown => {
                self.emit(
                    cx,
                    SidebarEvent::Wheel {
                        y,
                        delta: WHEEL_ROWS,
                    },
                );
                return true;
            }
            kind => kind,
        };
        match kind {
            MouseEventKind::Down(button) => {
                self.divider_drag = None;
                if let Some(section) = self.header_at(x, y) {
                    self.emit(cx, SidebarEvent::Toggle(section));
                    return true;
                }
                // The divider takes the drag, and the press still reaches the row under it, as in TS where the
                // press bubbles from the divider box to the sidebar.
                if button == MouseButton::Left {
                    self.divider_drag = self.divider_at(y);
                }
                if matches!(button, MouseButton::Left | MouseButton::Right) {
                    self.emit(
                        cx,
                        SidebarEvent::Press {
                            x,
                            y,
                            button,
                            screen: (event.x, event.y),
                        },
                    );
                }
                true
            }
            MouseEventKind::Drag(_) => {
                if let Some(section) = self.divider_drag {
                    self.emit(cx, SidebarEvent::Resize { section, y });
                }
                self.emit(cx, SidebarEvent::Drag { y });
                true
            }
            MouseEventKind::Up(_) => {
                self.divider_drag = None;
                self.emit(cx, SidebarEvent::Release);
                true
            }
            _ => false,
        }
    }
}

/// The divider line, `────━━━━━────`, for a pane `width` cells wide. `makeDividerBar` content and
/// `placeSectionWidgets`.
pub fn divider_line(width: i64) -> String {
    let width = width.max(1);
    let grip = 3.max(5.min(width / 3));
    let start = 0.max((width - grip) / 2);
    let end = 0.max(width - start - grip);
    format!(
        "{}{}{}",
        "─".repeat(start as usize),
        "━".repeat(grip as usize),
        "─".repeat(end as usize)
    )
}

/// What a [`PaneDivider`] reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DividerEvent {
    /// The pointer moved to terminal column `x` with the button down.
    Drag { x: u16 },
    /// A press and release with no movement in between.
    Toggle,
}

type DividerHandler = Box<dyn FnMut(&mut Cx<'_>, DividerEvent)>;

/// The vertical bar between two panes, with a hit box a cell wider than the bar. A drag resizes the pane and a
/// plain click collapses or expands it. Ports `makeDivider` in `src/ui/runtime-widgets.ts`.
pub struct PaneDivider {
    theme: Theme,
    /// The column of the bar inside the hit box.
    bar_column: i32,
    /// The color under each column of the hit box. The widget paints it so the cells keep the pane colors.
    backdrop: Vec<Rgba>,
    dragging: bool,
    moved: bool,
    on_event: Option<DividerHandler>,
}

impl PaneDivider {
    pub fn new(theme: Theme) -> Self {
        Self {
            theme,
            bar_column: 0,
            backdrop: Vec::new(),
            dragging: false,
            moved: false,
            on_event: None,
        }
    }

    pub fn set_backdrop(&mut self, backdrop: Vec<Rgba>) {
        self.backdrop = backdrop;
    }

    pub fn set_bar_column(&mut self, column: i64) {
        self.bar_column = column.max(0) as i32;
    }

    /// The handler must not call `Custom::update` or `Custom::with` on this widget. Queue a message instead.
    pub fn on_event(&mut self, handler: impl FnMut(&mut Cx<'_>, DividerEvent) + 'static) {
        self.on_event = Some(Box::new(handler));
    }

    fn emit(&mut self, cx: &mut Cx<'_>, event: DividerEvent) {
        if let Some(handler) = self.on_event.as_mut() {
            handler(cx, event);
        }
    }
}

impl Component for PaneDivider {
    fn paint(&self, painter: &mut Painter<'_>) {
        let (_, height) = painter.size();
        for (column, backdrop) in self.backdrop.iter().enumerate() {
            painter.fill(column as i32, 0, 1, height, to_color(*backdrop));
        }
        let mut style = Style::new().fg(to_color(self.theme.divider));
        if self.dragging {
            style = style.bg(to_color(self.theme.pressed));
        }
        for (row, glyph) in vertical_divider_content(i64::from(height))
            .split('\n')
            .enumerate()
        {
            painter.text(self.bar_column, row as i32, glyph, style);
        }
    }

    fn mouse(&mut self, cx: &mut Cx<'_>, event: &MouseEvent, _local: (i32, i32)) -> bool {
        match event.kind {
            MouseEventKind::Down(_) => {
                self.moved = false;
                self.dragging = true;
                true
            }
            MouseEventKind::Drag(_) => {
                self.moved = true;
                self.emit(cx, DividerEvent::Drag { x: event.x });
                true
            }
            MouseEventKind::Up(_) => {
                let click = self.dragging && !self.moved;
                self.dragging = false;
                if click {
                    self.emit(cx, DividerEvent::Toggle);
                }
                true
            }
            _ => false,
        }
    }
}

#[cfg(test)]
#[path = "sidebar_tests.rs"]
mod tests;
