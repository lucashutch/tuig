//! The diff pane: unified and split views of one file's patch with line numbers, syntax colors, selected rows for
//! line staging, and code text selection. Ports `DiffView` in `src/ui/diff-view.ts` and the parts of OpenTUI Core's
//! `DiffRenderable` that the TypeScript app shows.
//!
//! This is a custom painter instead of OpenTUI's `Diff` widget. At the pinned version, `Diff` cannot color one row
//! differently from the other rows of its kind, so the selected rows of line staging cannot be shown. The TS app
//! needs that (`setLineColor` per row). A painter also gives exact control of the gutter cells and of the text
//! selection, which must cover code only and never line numbers or signs.
//!
//! [`DiffDocument::new`] parses and highlights a patch. It does no UI work, so the shell builds it on the task that
//! read the patch, away from the UI thread. The shell then passes it in with [`DiffPane::set_document`]. The pane
//! owns its scroll position and the code text selection. The shell owns the selected rows for line staging and sets
//! them with [`DiffPane::set_selected_rows`]. Mouse input comes back as [`DiffEvent`].
//!
//! Known parity gaps with the TypeScript app:
//!
//! - No word-level highlight inside changed lines. The TS app on OpenTUI 0.8.4 shows none either.
//! - Long lines are cut at the pane edge. There is no horizontal scroll.
//! - Text selection copies tabs as two spaces.
//!
//! Deliberate difference from the TypeScript app: one blank separator row sits between consecutive hunks of a file,
//! so the end of one hunk and the start of the next are easy to see. The separator is a display row only. It has no
//! [`DiffLineTarget`], no line number and no syntax text, and the raw patch rows that line staging and the hunk
//! lookup use do not change.

use opentui::prelude::*;
use opentui::syntax::{Capture, SyntaxTheme, highlights, spans};
use std::collections::HashSet;
use std::rc::Rc;
use std::time::{Duration, Instant};
use tuig_ui_model::color::Rgba;
use tuig_ui_model::diff_lines::{DiffLineKind, DiffLineTarget, DiffSide};
use tuig_ui_model::text_width::string_width;
use tuig_ui_model::theme::{Surface, Theme, ThemeStates, semantic_color};

/// Below this width a side-by-side preference shows the unified view. `SPLIT_DIFF_MIN_WIDTH`.
pub const SPLIT_DIFF_MIN_WIDTH: i64 = 120;
/// Columns a tab takes. OpenTUI's code view default.
const TAB_WIDTH: usize = 2;
/// Presses on one cell within this time count as a double or triple click.
const MULTI_CLICK: Duration = Duration::from_millis(400);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DiffView {
    #[default]
    Unified,
    Split,
}

/// Ports `effectiveDiffView`: side by side only when the pane is wide enough.
pub fn effective_diff_view(side_by_side: bool, width: i64) -> DiffView {
    if side_by_side && width >= SPLIT_DIFF_MIN_WIDTH {
        DiffView::Split
    } else {
        DiffView::Unified
    }
}

/// One displayed row of one column. `target` is `None` for the filler rows of a split view.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DiffRow {
    /// The patch line, as `diffLineTarget` reports it. A context row targets the new file on both sides.
    pub target: Option<DiffLineTarget>,
    /// The line number in the gutter: the old file's on the left of a split view.
    pub number: Option<u64>,
    /// The blank row between two hunks. It has no target, so it selects nothing, and it holds no text.
    pub separator: bool,
}

/// The rows of one column and the text shown in them, one line per row.
#[derive(Debug, Clone, Default)]
pub struct DiffColumn {
    pub rows: Vec<DiffRow>,
    /// Contents of the rows that are not separators, joined with `\n`. This is the text that is highlighted as one
    /// document, so a separator never changes how the code around it parses.
    text: String,
    text_rows: usize,
    /// The largest line number pushed so far, kept so the gutter width needs no scan of `rows`.
    largest_number: u64,
    captures: Vec<Capture>,
}

impl DiffColumn {
    fn push(&mut self, target: Option<DiffLineTarget>, content: &str) {
        let number = target.map(|target| target.line);
        self.push_numbered(target, number, content);
    }

    fn push_numbered(
        &mut self,
        target: Option<DiffLineTarget>,
        number: Option<u64>,
        content: &str,
    ) {
        if self.text_rows > 0 {
            self.text.push('\n');
        }
        self.text_rows += 1;
        self.largest_number = self.largest_number.max(number.unwrap_or(0));
        self.text.push_str(content);
        self.rows.push(DiffRow {
            target,
            number,
            separator: false,
        });
    }

    fn push_separator(&mut self) {
        self.rows.push(DiffRow {
            target: None,
            number: None,
            separator: true,
        });
    }

    fn digits(&self) -> usize {
        // OpenTUI sizes the gutter for the larger of the row count and the largest line number. The blank row between
        // hunks is not a row of the TS document, so it does not count.
        let max = self.largest_number.max(self.text_rows as u64);
        max.max(1).to_string().len()
    }

    fn highlight(&mut self, filetype: &str) {
        self.captures = highlights(&self.text, filetype).unwrap_or_default();
    }
}

/// A parsed and highlighted patch. Built off the UI thread.
#[derive(Debug, Clone, Default)]
pub struct DiffDocument {
    /// The raw patch. Line staging builds patches from it, so it is kept whole.
    pub patch: String,
    pub unified: DiffColumn,
    /// The split view: old file on the left, new file on the right, with filler rows so changes line up.
    pub old: DiffColumn,
    pub new: DiffColumn,
    pub filetype: Option<String>,
}

fn hunk_starts(line: &str) -> Option<(u64, u64)> {
    let rest = line.strip_prefix("@@ -")?;
    let (old, rest) = rest.split_once(" +")?;
    let new = rest.split(' ').next()?;
    let start = |range: &str| range.split(',').next()?.parse::<u64>().ok();
    Some((start(old)?, start(new)?))
}

impl DiffDocument {
    /// Parses every hunk body of `patch`, as `diffLineTarget` counts rows: header rows and `\ No newline` markers
    /// have no row, and a `diff --git` line ends the hunk before it. With a `filetype`, highlights each column.
    pub fn new(patch: String, filetype: Option<&str>) -> Self {
        Self::with_hunk_gap(patch, filetype, true)
    }

    /// Like [`DiffDocument::new`]. `hunk_gap` false leaves out the separator rows, which shows the diff as the TS
    /// app does. The parity harness uses it to compare against the TS goldens.
    pub fn with_hunk_gap(patch: String, filetype: Option<&str>, hunk_gap: bool) -> Self {
        let mut document = Self {
            filetype: filetype.map(str::to_owned),
            ..Self::default()
        };
        let lines: Vec<&str> = patch.split('\n').collect();
        let last = lines.len().saturating_sub(1);
        let (mut old, mut new, mut in_hunk) = (0u64, 0u64, false);
        // Diff lines so far, which numbers `rendered_row`. Separator rows are not diff lines.
        let mut diff_rows = 0usize;
        // The file has shown a row, so the next hunk needs a separator before its first row.
        let (mut file_has_rows, mut gap_pending) = (false, false);
        // Changed rows wait here until the run ends, so the split view can pair removals with additions.
        let mut removed: Vec<(DiffLineTarget, &str)> = Vec::new();
        let mut added: Vec<(DiffLineTarget, &str)> = Vec::new();
        let flush = |document: &mut Self,
                     removed: &mut Vec<(DiffLineTarget, &str)>,
                     added: &mut Vec<(DiffLineTarget, &str)>| {
            let rows = removed.len().max(added.len());
            for index in 0..rows {
                let left = removed.get(index);
                let right = added.get(index);
                document.old.push(
                    left.map(|(target, _)| *target),
                    left.map_or("", |(_, text)| text),
                );
                document.new.push(
                    right.map(|(target, _)| *target),
                    right.map_or("", |(_, text)| text),
                );
            }
            removed.clear();
            added.clear();
        };
        for (raw_row, text) in lines.iter().enumerate() {
            if let Some((old_start, new_start)) = hunk_starts(text) {
                flush(&mut document, &mut removed, &mut added);
                (old, new, in_hunk) = (old_start, new_start, true);
                gap_pending = hunk_gap && file_has_rows;
                continue;
            }
            if text.starts_with("diff --git ") {
                flush(&mut document, &mut removed, &mut added);
                in_hunk = false;
                (file_has_rows, gap_pending) = (false, false);
                continue;
            }
            if !in_hunk || text.starts_with('\\') || (raw_row == last && text.is_empty()) {
                continue;
            }
            // The pending runs were flushed at the hunk header, so the separator comes before this hunk's rows in
            // all three columns.
            if std::mem::take(&mut gap_pending) {
                document.unified.push_separator();
                document.old.push_separator();
                document.new.push_separator();
            }
            file_has_rows = true;
            let rendered_row = diff_rows;
            diff_rows += 1;
            let (kind, side, line, old_line, content) = match text.as_bytes().first() {
                Some(b'-') => (
                    DiffLineKind::Removed,
                    DiffSide::Old,
                    old,
                    Some(old),
                    &text[1..],
                ),
                Some(b'+') => (DiffLineKind::Added, DiffSide::New, new, None, &text[1..]),
                first => {
                    let content = if first.is_some() { &text[1..] } else { "" };
                    (
                        DiffLineKind::Context,
                        DiffSide::New,
                        new,
                        Some(old),
                        content,
                    )
                }
            };
            let target = DiffLineTarget {
                line,
                side,
                kind,
                old_line,
                raw_row,
                rendered_row,
            };
            document.unified.push(Some(target), content);
            match kind {
                DiffLineKind::Removed => {
                    old = old.saturating_add(1);
                    removed.push((target, content));
                }
                DiffLineKind::Added => {
                    new = new.saturating_add(1);
                    added.push((target, content));
                }
                DiffLineKind::Context => {
                    flush(&mut document, &mut removed, &mut added);
                    document.old.push_numbered(Some(target), Some(old), content);
                    document.new.push(Some(target), content);
                    old = old.saturating_add(1);
                    new = new.saturating_add(1);
                }
            }
        }
        flush(&mut document, &mut removed, &mut added);
        if let Some(filetype) = filetype {
            for column in [&mut document.unified, &mut document.old, &mut document.new] {
                column.highlight(filetype);
            }
        }
        document.patch = patch;
        document
    }

    /// The column a view shows on one side. A unified view has only the left side.
    pub fn column(&self, view: DiffView, side: DiffSide) -> &DiffColumn {
        match (view, side) {
            (DiffView::Unified, _) => &self.unified,
            (DiffView::Split, DiffSide::Old) => &self.old,
            (DiffView::Split, DiffSide::New) => &self.new,
        }
    }

    /// The patch line shown at a display row, or `None` for filler rows and rows past the end. Ports
    /// `renderedDiffLineTarget` and `splitDiffLineTarget`.
    pub fn target_at(&self, view: DiffView, side: DiffSide, row: usize) -> Option<DiffLineTarget> {
        self.column(view, side).rows.get(row)?.target
    }

    /// Whether a display row is the blank row between two hunks. Both sides of a split view agree.
    pub fn is_separator(&self, view: DiffView, side: DiffSide, row: usize) -> bool {
        self.column(view, side)
            .rows
            .get(row)
            .is_some_and(|row| row.separator)
    }

    /// Changed raw patch rows between two raw rows, inclusive. Ports `changedDiffRowsInRange`.
    pub fn changed_rows_between(&self, from: usize, to: usize) -> Vec<usize> {
        let (start, end) = (from.min(to), from.max(to));
        self.unified
            .rows
            .iter()
            .filter_map(|row| row.target)
            .filter(|target| target.kind != DiffLineKind::Context)
            .map(|target| target.raw_row)
            .filter(|raw| (start..=end).contains(raw))
            .collect()
    }

    /// Display rows of a view.
    pub fn len(&self, view: DiffView) -> usize {
        self.column(view, DiffSide::Old).rows.len()
    }

    pub fn is_empty(&self) -> bool {
        self.unified.rows.is_empty()
    }
}

/// Mouse input the shell acts on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiffEvent {
    /// A press on a document row. `target` is the patch line there, if any. `x` and `y` are terminal cells.
    Press {
        target: Option<DiffLineTarget>,
        button: MouseButton,
        ctrl: bool,
        alt: bool,
        x: u16,
        y: u16,
    },
    /// The left button moved while pressed.
    Drag { target: Option<DiffLineTarget> },
    /// The left button was released.
    Release,
    /// A code text selection ended and was copied.
    Copied(String),
}

/// The colors the pane paints with. Ports `DiffView.updateTheme` and `createDiffSyntaxStyle`.
#[derive(Debug, Clone)]
struct Palette {
    bg: Color,
    blank_fg: Color,
    message: Color,
    line_number: Color,
    context_bg: Color,
    added_bg: Color,
    removed_bg: Color,
    added_gutter: Color,
    removed_gutter: Color,
    added_sign: Color,
    removed_sign: Color,
    added_highlight_gutter: Color,
    removed_highlight_gutter: Color,
    added_highlight: Color,
    removed_highlight: Color,
    text_selection: Color,
    syntax: SyntaxTheme,
}

fn color(color: Rgba) -> Color {
    Color::rgba(color.r, color.g, color.b, color.a)
}

/// Ports `diffColor`: the theme's `diff` table, then the semantic `diff.*` token, then `fallback`.
fn diff_color(theme: &Theme, path: &str, fallback: Rgba) -> Color {
    let mut node = None;
    for (index, key) in path.split('.').enumerate() {
        node = if index == 0 {
            theme.diff.as_ref().and_then(|diff| diff.get(key))
        } else {
            node.and_then(|node: &tuig_ui_model::theme::ColorNode| node.get(key))
        };
    }
    let own = node.and_then(|node| node.color()).unwrap_or(fallback);
    color(semantic_color(
        theme,
        &format!("diff.{path}"),
        own,
        Surface::Default,
        ThemeStates::default(),
    ))
}

/// Ports `createDiffSyntaxStyle`. Capture names fall back to their first dotted part, as Core's `SyntaxStyle` does.
pub fn diff_syntax_theme(theme: &Theme) -> SyntaxTheme {
    let syntax = |name: &str| theme.syntax.as_ref().and_then(|map| map.get(name)).copied();
    let fg = |rgba: Rgba| Style::new().fg(color(rgba));
    let number = syntax("number").unwrap_or(theme.warning);
    let mut styles: Vec<(String, Style)> = [
        ("default", fg(theme.text)),
        (
            "comment",
            fg(syntax("comment").unwrap_or(theme.muted)).italic(),
        ),
        ("number", fg(number)),
        ("boolean", fg(number)),
        ("constant", fg(number)),
        ("punctuation", fg(theme.text)),
        ("keyword", fg(theme.author)),
        ("operator", fg(theme.accent_soft)),
        ("string", fg(theme.added)),
        ("character", fg(theme.added)),
        ("function", fg(theme.accent)),
        ("method", fg(theme.accent)),
        ("type", fg(theme.warning)),
        ("constructor", fg(theme.warning)),
        ("variable", fg(theme.text)),
        ("property", fg(theme.deleted)),
        ("attribute", fg(theme.warning)),
        ("tag", fg(theme.deleted)),
        ("label", fg(theme.author)),
        ("module", fg(theme.warning)),
        ("markup.heading", fg(theme.accent).bold()),
        ("markup.link", fg(theme.accent_soft).underline()),
        ("markup.raw", fg(theme.added)),
        ("markup.strong", fg(theme.text).bold()),
        ("markup.italic", fg(theme.text).italic()),
    ]
    .into_iter()
    .map(|(name, style)| (name.to_owned(), style))
    .collect();
    let set = |styles: &mut Vec<(String, Style)>, name: &str, rgba: Rgba| match styles
        .iter_mut()
        .find(|(own, _)| own == name)
    {
        Some((_, style)) => {
            *style = Style {
                fg: Some(color(rgba)),
                ..*style
            }
        }
        None => styles.push((name.to_owned(), fg(rgba))),
    };
    for (name, rgba) in theme.syntax.iter().flatten() {
        set(&mut styles, name, *rgba);
    }
    let mut aliases: Vec<(&str, &[&str])> = vec![
        ("string", &["character"]),
        ("number", &["boolean", "constant"]),
        ("function", &["method"]),
        ("type", &["constructor", "attribute", "module"]),
        ("keyword", &["label"]),
    ];
    if theme.semantic.is_some() {
        aliases.push(("variable", &["property"]));
    }
    for (name, captures) in aliases {
        if let Some(rgba) = syntax(name) {
            for capture in captures {
                set(&mut styles, capture, rgba);
            }
        }
    }
    for (capture, token) in [
        ("markup.heading", "heading"),
        ("markup.link", "link"),
        ("markup.raw", "code"),
        ("markup.strong", "strong"),
        ("markup.italic", "emphasis"),
    ] {
        let current = styles
            .iter()
            .find(|(own, _)| own == capture)
            .and_then(|(_, style)| style.fg)
            .map_or(theme.text, |c| Rgba::new(c.r, c.g, c.b, c.a));
        let token = semantic_color(
            theme,
            &format!("markdown.{token}"),
            current,
            Surface::Default,
            ThemeStates::default(),
        );
        set(&mut styles, capture, token);
    }
    styles.into_iter().fold(
        SyntaxTheme::new().first_part_fallback(),
        |syntax, (name, style)| syntax.style(name, style),
    )
}

impl Palette {
    fn new(theme: &Theme) -> Self {
        Self {
            bg: color(theme.bg),
            blank_fg: Color::rgb(255, 255, 255),
            message: color(theme.muted),
            line_number: diff_color(theme, "lineNumber.text", theme.muted),
            context_bg: diff_color(theme, "background.context", theme.bg),
            added_bg: diff_color(theme, "background.added", theme.diff_added_bg),
            removed_bg: diff_color(theme, "background.removed", theme.diff_removed_bg),
            added_gutter: diff_color(theme, "lineNumber.background.added", theme.diff_added_bg),
            removed_gutter: diff_color(
                theme,
                "lineNumber.background.removed",
                theme.diff_removed_bg,
            ),
            added_sign: diff_color(theme, "text.added", theme.added),
            removed_sign: diff_color(theme, "text.removed", theme.deleted),
            added_highlight_gutter: diff_color(theme, "highlight.added", theme.accent),
            removed_highlight_gutter: diff_color(theme, "highlight.removed", theme.accent),
            added_highlight: diff_color(theme, "highlight.added", theme.selected),
            removed_highlight: diff_color(theme, "highlight.removed", theme.selected),
            text_selection: color(theme.selected),
            syntax: diff_syntax_theme(theme),
        }
    }
}

/// One styled run of a row, with tabs expanded.
#[derive(Debug, Clone)]
struct Run {
    text: String,
    style: Style,
}

/// Styled runs for every row of a column.
fn styled_rows(column: &DiffColumn, syntax: &SyntaxTheme) -> Vec<Vec<Run>> {
    let default = syntax.get("default").unwrap_or_default();
    let mut rows: Vec<Vec<Run>> = vec![Vec::new(); column.rows.len()];
    // The highlighted text has no separator rows, so its line `n` is the `n`th row that is not a separator.
    let text_rows: Vec<usize> = (0..column.rows.len())
        .filter(|&row| !column.rows[row].separator)
        .collect();
    let mut line = 0;
    let push = |rows: &mut Vec<Vec<Run>>, line: usize, text: &str, style: Style| {
        let Some(&row) = text_rows.get(line) else {
            return;
        };
        if text.is_empty() {
            return;
        }
        rows[row].push(Run {
            text: text.replace('\t', &" ".repeat(TAB_WIDTH)),
            style,
        });
    };
    let pieces = if column.captures.is_empty() {
        vec![Span::styled(column.text.clone(), default)]
    } else {
        spans(&column.text, &column.captures, syntax)
    };
    for piece in pieces {
        let mut parts = piece.content.split('\n');
        if let Some(first) = parts.next() {
            push(&mut rows, line, first, piece.style);
        }
        for part in parts {
            line += 1;
            push(&mut rows, line, part, piece.style);
        }
    }
    rows
}

/// Which column a point of the pane is in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Pane {
    side: DiffSide,
    left: i32,
    width: i32,
}

/// A code text selection in display coordinates: row and code column, the anchor where the drag started.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TextSelection {
    side: DiffSide,
    anchor: (usize, usize),
    focus: (usize, usize),
}

impl TextSelection {
    fn ordered(&self) -> ((usize, usize), (usize, usize)) {
        if self.anchor <= self.focus {
            (self.anchor, self.focus)
        } else {
            (self.focus, self.anchor)
        }
    }

    /// The selected code columns of `row`, end exclusive, for a row `width` columns wide.
    fn columns(&self, row: usize, width: usize) -> Option<(usize, usize)> {
        let ((start_row, start_col), (end_row, end_col)) = self.ordered();
        if row < start_row || row > end_row {
            return None;
        }
        let from = if row == start_row { start_col } else { 0 };
        let to = if row == end_row { end_col } else { width };
        (from < to.min(width)).then_some((from, to.min(width)))
    }
}

type EventHandler = Box<dyn FnMut(&mut Cx<'_>, DiffEvent)>;

/// The diff pane. Its height includes one blank row on top, where the history pane has its header.
pub struct DiffPane {
    palette: Palette,
    document: Option<Rc<DiffDocument>>,
    view: DiffView,
    /// Runs for the left (or only) column and the right column of the current view.
    runs: [Vec<Vec<Run>>; 2],
    selected_rows: HashSet<usize>,
    message: String,
    scroll: usize,
    /// Body rows on screen, from the last paint.
    body_rows: std::cell::Cell<usize>,
    width: std::cell::Cell<i32>,
    selection: Option<TextSelection>,
    selecting: bool,
    last_press: Option<(Instant, (usize, usize), u8)>,
    on_event: Option<EventHandler>,
}

impl DiffPane {
    pub fn new(theme: &Theme) -> Self {
        Self {
            palette: Palette::new(theme),
            document: None,
            view: DiffView::Unified,
            runs: [Vec::new(), Vec::new()],
            selected_rows: HashSet::new(),
            message: String::new(),
            scroll: 0,
            body_rows: std::cell::Cell::new(0),
            width: std::cell::Cell::new(0),
            selection: None,
            selecting: false,
            last_press: None,
            on_event: None,
        }
    }

    pub fn on_event(&mut self, handler: impl FnMut(&mut Cx<'_>, DiffEvent) + 'static) {
        self.on_event = Some(Box::new(handler));
    }

    /// Shows a document from the top, or clears the pane. Clears the text selection.
    pub fn set_document(&mut self, document: Option<Rc<DiffDocument>>) {
        let same = match (&self.document, &document) {
            (Some(old), Some(new)) => Rc::ptr_eq(old, new),
            (None, None) => true,
            _ => false,
        };
        if same {
            return;
        }
        self.document = document;
        self.scroll = 0;
        self.selection = None;
        self.selecting = false;
        self.restyle();
    }

    pub fn document(&self) -> Option<&Rc<DiffDocument>> {
        self.document.as_ref()
    }

    /// A message in place of the document, such as `Loading diff…`. Empty for none.
    pub fn set_message(&mut self, message: impl Into<String>) {
        self.message = message.into();
    }

    pub fn set_view(&mut self, view: DiffView) {
        if view != self.view {
            self.view = view;
            self.selection = None;
            self.restyle();
        }
    }

    pub fn set_selected_rows(&mut self, rows: HashSet<usize>) {
        self.selected_rows = rows;
    }

    pub fn set_theme(&mut self, theme: &Theme) {
        self.palette = Palette::new(theme);
        self.restyle();
    }

    pub fn scroll(&self) -> usize {
        self.scroll
    }

    fn restyle(&mut self) {
        self.runs = match &self.document {
            None => [Vec::new(), Vec::new()],
            Some(document) => {
                let syntax = &self.palette.syntax;
                let left = styled_rows(document.column(self.view, DiffSide::Old), syntax);
                let right = match self.view {
                    DiffView::Split => styled_rows(&document.new, syntax),
                    DiffView::Unified => Vec::new(),
                };
                [left, right]
            }
        };
    }

    fn emit(&mut self, cx: &mut Cx<'_>, event: DiffEvent) {
        if let Some(handler) = self.on_event.as_mut() {
            handler(cx, event);
        }
    }

    fn panes(&self, width: i32) -> Vec<Pane> {
        match self.view {
            DiffView::Unified => vec![Pane {
                side: DiffSide::Old,
                left: 0,
                width,
            }],
            DiffView::Split => {
                let half = width / 2;
                vec![
                    Pane {
                        side: DiffSide::Old,
                        left: 0,
                        width: half,
                    },
                    Pane {
                        side: DiffSide::New,
                        left: half,
                        width: width - half,
                    },
                ]
            }
        }
    }

    fn pane_at(&self, x: i32) -> Pane {
        let panes = self.panes(self.width.get());
        panes
            .iter()
            .copied()
            .find(|pane| x < pane.left + pane.width)
            .unwrap_or(panes[panes.len() - 1])
    }

    fn max_scroll(&self) -> usize {
        let rows = self.document.as_ref().map_or(0, |doc| doc.len(self.view));
        rows.saturating_sub(self.body_rows.get())
    }

    fn scroll_by(&mut self, delta: i64) -> bool {
        let next = (self.scroll as i64 + delta).clamp(0, self.max_scroll() as i64) as usize;
        let changed = next != self.scroll;
        self.scroll = next;
        changed
    }

    fn gutter_width(column: &DiffColumn) -> i32 {
        // Left padding, digits, the sign and one space.
        (1 + column.digits() + 3) as i32
    }

    /// Display row and code column under a local point, clamped into the document.
    fn code_point(&self, pane: Pane, local: (i32, i32)) -> Option<(usize, usize)> {
        let document = self.document.as_ref()?;
        let rows = document.len(self.view);
        if rows == 0 {
            return None;
        }
        let row = (self.scroll as i64 + i64::from(local.1) - 1).clamp(0, rows as i64 - 1) as usize;
        let gutter = Self::gutter_width(document.column(self.view, pane.side));
        let column = (local.0 - pane.left - gutter).max(0) as usize;
        Some((row, column))
    }

    /// The display row under a local point, if it is a document row on screen.
    fn row_at(&self, y: i32) -> Option<usize> {
        let document = self.document.as_ref()?;
        let row = self.scroll as i64 + i64::from(y) - 1;
        (y >= 1 && row >= 0 && (row as usize) < document.len(self.view)).then_some(row as usize)
    }

    fn row_text(&self, side: DiffSide, row: usize) -> String {
        let index = usize::from(side == DiffSide::New && self.view == DiffView::Split);
        self.runs[index]
            .get(row)
            .map(|runs| runs.iter().map(|run| run.text.as_str()).collect())
            .unwrap_or_default()
    }

    /// The selected code text, rows joined with `\n`.
    pub fn selected_text(&self) -> Option<String> {
        let selection = self.selection?;
        let ((mut start, _), (mut end, _)) = selection.ordered();
        // A selection that starts or ends on the gap between hunks copies no blank line at that end.
        let document = self.document.as_ref()?;
        let separator = |row| document.is_separator(self.view, selection.side, row);
        while start < end && separator(start) {
            start += 1;
        }
        while end > start && separator(end) {
            end -= 1;
        }
        let mut lines = Vec::new();
        for row in start..=end {
            let text = self.row_text(selection.side, row);
            let chars: Vec<char> = text.chars().collect();
            let mut columns = 0;
            let mut picked = String::new();
            for c in chars {
                let width = string_width(c.encode_utf8(&mut [0; 4]));
                if let Some((from, to)) = selection.columns(row, usize::MAX)
                    && columns >= from
                    && columns < to
                {
                    picked.push(c);
                }
                columns += width;
            }
            lines.push(picked);
        }
        let text = lines.join("\n");
        (!text.is_empty()).then_some(text)
    }

    /// Selects the word, or the whole row, around a code column.
    fn select_around(&mut self, side: DiffSide, row: usize, column: usize, clicks: u8) {
        let text = self.row_text(side, row);
        let chars: Vec<char> = text.chars().collect();
        if clicks >= 3 {
            self.selection = Some(TextSelection {
                side,
                anchor: (row, 0),
                focus: (row, string_width(&text)),
            });
            return;
        }
        let word = |c: char| c.is_alphanumeric() || c == '_';
        let mut starts = Vec::with_capacity(chars.len() + 1);
        let mut at = 0;
        for c in &chars {
            starts.push(at);
            at += string_width(c.encode_utf8(&mut [0; 4]));
        }
        starts.push(at);
        let Some(index) = starts.iter().rposition(|&start| start <= column) else {
            return;
        };
        if index >= chars.len() || !word(chars[index]) {
            return;
        }
        let mut from = index;
        while from > 0 && word(chars[from - 1]) {
            from -= 1;
        }
        let mut to = index;
        while to < chars.len() && word(chars[to]) {
            to += 1;
        }
        self.selection = Some(TextSelection {
            side,
            anchor: (row, starts[from]),
            focus: (row, starts[to]),
        });
    }

    fn paint_column(&self, painter: &mut Painter<'_>, pane: Pane, height: i32) {
        let palette = &self.palette;
        let Some(document) = &self.document else {
            return;
        };
        let column = document.column(self.view, pane.side);
        let runs =
            &self.runs[usize::from(pane.side == DiffSide::New && self.view == DiffView::Split)];
        let digits = column.digits();
        let gutter = Self::gutter_width(column);
        let blank = Style::new().fg(palette.blank_fg);
        let code_width = (pane.width - gutter).max(0) as usize;
        let pane_fill = " ".repeat(pane.width.max(0) as usize);
        let code_fill = " ".repeat(code_width);
        for y in 1..height {
            let row = self.scroll + (y - 1) as usize;
            let Some(entry) = column.rows.get(row) else {
                break;
            };
            let Some(target) = entry.target else {
                // A filler row of the split view, or the separator between hunks. Both are plain background.
                painter.text(pane.left, y, &pane_fill, blank.bg(palette.bg));
                continue;
            };
            let selected = self.selected_rows.contains(&target.raw_row);
            let (gutter_bg, content_bg, sign, sign_fg) = match (target.kind, selected) {
                (DiffLineKind::Context, _) => (
                    palette.context_bg,
                    palette.context_bg,
                    "  ",
                    palette.blank_fg,
                ),
                (DiffLineKind::Added, false) => (
                    palette.added_gutter,
                    palette.added_bg,
                    " +",
                    palette.added_sign,
                ),
                (DiffLineKind::Added, true) => (
                    palette.added_highlight_gutter,
                    palette.added_highlight,
                    " +",
                    palette.added_sign,
                ),
                (DiffLineKind::Removed, false) => (
                    palette.removed_gutter,
                    palette.removed_bg,
                    " -",
                    palette.removed_sign,
                ),
                (DiffLineKind::Removed, true) => (
                    palette.removed_highlight_gutter,
                    palette.removed_highlight,
                    " -",
                    palette.removed_sign,
                ),
            };
            let x = pane.left;
            painter.text(x, y, " ", blank.bg(gutter_bg));
            // Padding cells keep the default foreground; only the digits are muted.
            let number = entry.number.unwrap_or(target.line).to_string();
            let pad = digits.saturating_sub(number.len());
            painter.text(x + 1, y, &" ".repeat(pad), blank.bg(gutter_bg));
            painter.text(
                x + 1 + pad as i32,
                y,
                &number,
                Style::new().fg(palette.line_number).bg(gutter_bg),
            );
            painter.text(
                x + 1 + digits as i32,
                y,
                sign,
                Style::new().fg(sign_fg).bg(gutter_bg),
            );
            painter.text(x + gutter - 1, y, " ", blank.bg(gutter_bg));
            painter.text(x + gutter, y, &code_fill, blank.bg(content_bg));
            let selection = self
                .selection
                .filter(|selection| selection.side == pane.side)
                .and_then(|selection| selection.columns(row, code_width));
            let mut column_at = 0usize;
            'runs: for run in runs.get(row).into_iter().flatten() {
                for c in run.text.chars() {
                    let width = string_width(c.encode_utf8(&mut [0; 4]));
                    if column_at + width > code_width {
                        break 'runs;
                    }
                    let in_selection =
                        selection.is_some_and(|(from, to)| column_at >= from && column_at < to);
                    let bg = if in_selection {
                        palette.text_selection
                    } else {
                        content_bg
                    };
                    let mut buffer = [0u8; 4];
                    painter.text(
                        x + gutter + column_at as i32,
                        y,
                        c.encode_utf8(&mut buffer),
                        run.style.bg(bg),
                    );
                    column_at += width;
                }
            }
        }
    }
}

impl Component for DiffPane {
    fn paint(&self, painter: &mut Painter<'_>) {
        let (width, height) = painter.size();
        let (width_i, height_i) = (width as i32, height as i32);
        self.width.set(width_i);
        self.body_rows.set(height.saturating_sub(1) as usize);
        painter.fill(0, 0, width, height, self.palette.bg);
        let blank = Style::new().fg(self.palette.blank_fg).bg(self.palette.bg);
        let fill = " ".repeat(width as usize);
        for y in 0..height_i {
            painter.text(0, y, &fill, blank);
        }
        if !self.message.is_empty() {
            let style = Style::new().fg(self.palette.message).bg(self.palette.bg);
            for (index, line) in self.message.lines().enumerate() {
                painter.text(2, 4 + index as i32, line, style);
            }
            return;
        }
        for pane in self.panes(width_i) {
            self.paint_column(painter, pane, height_i);
        }
    }

    fn mouse(&mut self, cx: &mut Cx<'_>, event: &MouseEvent, local: (i32, i32)) -> bool {
        let ctrl = event.modifiers.contains(Modifiers::CTRL);
        let alt = event.modifiers.contains(Modifiers::ALT);
        match event.kind {
            MouseEventKind::ScrollUp => self.scroll_by(-1),
            MouseEventKind::ScrollDown => self.scroll_by(1),
            MouseEventKind::Down(button) => {
                let pane = self.pane_at(local.0);
                let target = self.row_at(local.1).and_then(|row| {
                    self.document
                        .as_ref()
                        .and_then(|document| document.target_at(self.view, pane.side, row))
                });
                self.selection = None;
                self.selecting = false;
                if button == MouseButton::Left
                    && !ctrl
                    && !alt
                    && let Some(point) = self.code_point(pane, local)
                    && let Some(row) = self.row_at(local.1)
                    && !self
                        .document
                        .as_ref()
                        .is_some_and(|document| document.is_separator(self.view, pane.side, row))
                {
                    let now = cx.app().now();
                    let clicks = match self.last_press {
                        Some((at, last, clicks))
                            if last.0 == point.0 && now.duration_since(at) < MULTI_CLICK =>
                        {
                            clicks % 3 + 1
                        }
                        _ => 1,
                    };
                    self.last_press = Some((now, point, clicks));
                    if clicks > 1 {
                        self.select_around(pane.side, point.0, point.1, clicks);
                    } else {
                        self.selecting = true;
                        self.selection = Some(TextSelection {
                            side: pane.side,
                            anchor: point,
                            focus: point,
                        });
                    }
                }
                self.emit(
                    cx,
                    DiffEvent::Press {
                        target,
                        button,
                        ctrl,
                        alt,
                        x: event.x,
                        y: event.y,
                    },
                );
                true
            }
            MouseEventKind::Drag(MouseButton::Left) => {
                if self.selecting
                    && let Some(selection) = self.selection
                {
                    let pane = Pane {
                        side: selection.side,
                        ..self.pane_at(local.0)
                    };
                    let pane = self
                        .panes(self.width.get())
                        .into_iter()
                        .find(|own| own.side == pane.side)
                        .unwrap_or(pane);
                    if let Some(point) = self.code_point(pane, local) {
                        self.selection = Some(TextSelection {
                            focus: point,
                            ..selection
                        });
                    }
                }
                let pane = self.pane_at(local.0);
                let target = self.row_at(local.1).and_then(|row| {
                    self.document
                        .as_ref()
                        .and_then(|document| document.target_at(self.view, pane.side, row))
                });
                self.emit(cx, DiffEvent::Drag { target });
                true
            }
            MouseEventKind::Up(MouseButton::Left) => {
                let selecting = std::mem::take(&mut self.selecting);
                let dragged = self
                    .selection
                    .is_some_and(|selection| selection.anchor != selection.focus);
                if !dragged && selecting {
                    self.selection = None;
                }
                if let Some(text) = self.selection.and_then(|_| self.selected_text()) {
                    cx.app().copy_to_clipboard(&text);
                    self.emit(cx, DiffEvent::Copied(text));
                }
                self.emit(cx, DiffEvent::Release);
                true
            }
            _ => false,
        }
    }
}

#[cfg(test)]
#[path = "diff_tests.rs"]
mod tests;
