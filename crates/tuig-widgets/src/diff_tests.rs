use super::*;
use opentui::testing::TestApp;
use std::cell::RefCell;
use tuig_ui_model::diff_lines::{diff_line_target, split_diff_line_target};
use tuig_ui_model::theme::one_dark_theme;

/// Two hunks. The first replaces two lines with three, so the split view needs one filler row on the left.
const PATCH: &str = "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1,4 +1,5 @@\n same\n-old one\n-old two\n+new one\n+new two\n+extra\n tail\n@@ -20,2 +21,2 @@\n ctx\n-gone\n\\ No newline at end of file\n+kept\n";

fn row_of(line: &str) -> usize {
    PATCH.split('\n').position(|own| own == line).unwrap()
}

#[test]
fn split_rows_map_to_the_raw_patch_rows_of_their_side() {
    let document = DiffDocument::new(PATCH.to_owned(), None);
    let side = |side, row| {
        document
            .target_at(DiffView::Split, side, row)
            .map(|target| target.raw_row)
    };
    // Row 5 is the separator between the hunks. It has no target on either side.
    assert_eq!(side(DiffSide::Old, 5), None);
    assert_eq!(side(DiffSide::New, 5), None);
    assert!(document.is_separator(DiffView::Split, DiffSide::Old, 5));
    assert!(document.is_separator(DiffView::Split, DiffSide::New, 5));
    // Row 1 pairs the first removal with the first addition. Row 3 has only an addition.
    assert_eq!(side(DiffSide::Old, 1), Some(row_of("-old one")));
    assert_eq!(side(DiffSide::New, 1), Some(row_of("+new one")));
    assert_eq!(side(DiffSide::Old, 3), None, "a filler row selects nothing");
    assert_eq!(side(DiffSide::New, 3), Some(row_of("+extra")));
    // The second hunk starts after the separator, and the marker line has no row.
    assert_eq!(side(DiffSide::Old, 7), Some(row_of("-gone")));
    assert_eq!(side(DiffSide::New, 7), Some(row_of("+kept")));
    assert_eq!(document.len(DiffView::Split), 8);
    // The same rows as the TypeScript mapping before the marker, with the separator row left out. After the marker,
    // `splitDiffLineTarget` starts a new run while the TS renderer, which drops the marker, pairs `-gone` with
    // `+kept` as this document does.
    for row in (0..5).chain(6..7) {
        let reference_row = if row > 5 { row - 1 } else { row };
        for (side, model) in [
            (DiffSide::Old, tuig_ui_model::diff_lines::DiffSide::Old),
            (DiffSide::New, tuig_ui_model::diff_lines::DiffSide::New),
        ] {
            let ours = document.target_at(DiffView::Split, side, row);
            let reference = split_diff_line_target(PATCH, reference_row as i64, model);
            assert_eq!(
                ours.map(|t| (t.raw_row, t.line, t.kind)),
                reference.map(|t| (t.raw_row, t.line, t.kind)),
                "row {row} {side:?}"
            );
        }
    }
}

/// What a unified row shows: its raw patch row, or `None` for a separator.
fn unified_raw_rows(patch: &str) -> Vec<Option<usize>> {
    let document = DiffDocument::new(patch.to_owned(), None);
    document
        .unified
        .rows
        .iter()
        .map(|row| row.target.map(|target| target.raw_row))
        .collect()
}

#[test]
fn a_separator_sits_between_hunks_and_nowhere_else() {
    let rows = unified_raw_rows(PATCH);
    let separators: Vec<usize> = (0..rows.len()).filter(|&row| rows[row].is_none()).collect();
    assert_eq!(separators, [7], "one gap, after the seven rows of hunk one");
    assert_eq!(rows[8], Some(row_of(" ctx")));

    // A third hunk adds a second gap. A file boundary adds none: the first hunk of the next file has no gap
    // before it.
    let three = format!(
        "{PATCH}@@ -40 +41 @@
-a
+b
"
    );
    let rows = unified_raw_rows(&three);
    assert_eq!(rows.iter().filter(|row| row.is_none()).count(), 2);
    let two_files = format!(
        "{PATCH}diff --git a/b.py b/b.py
--- a/b.py
+++ b/b.py
@@ -1 +1 @@
-x
+y
"
    );
    let rows = unified_raw_rows(&two_files);
    assert_eq!(rows.iter().filter(|row| row.is_none()).count(), 1);
    assert!(rows.last().unwrap().is_some() && rows[rows.len() - 3].is_some());

    // An empty hunk makes no row and no gap.
    let empty = "--- a/a
+++ b/a
@@ -1 +1 @@
@@ -5 +5 @@
-a
+b
";
    assert_eq!(unified_raw_rows(empty), [Some(4), Some(5)]);
}

#[test]
fn turning_the_gap_off_leaves_the_same_rows_without_separators() {
    let with = DiffDocument::new(PATCH.to_owned(), None);
    let without = DiffDocument::with_hunk_gap(PATCH.to_owned(), None, false);
    let kept = |document: &DiffDocument, view| {
        document
            .column(view, DiffSide::Old)
            .rows
            .iter()
            .filter(|row| !row.separator)
            .map(|row| (row.target, row.number))
            .collect::<Vec<_>>()
    };
    assert!(without.unified.rows.iter().all(|row| !row.separator));
    for view in [DiffView::Unified, DiffView::Split] {
        assert_eq!(kept(&with, view), kept(&without, view));
    }
}

#[test]
fn separators_do_not_change_gutter_numbers_or_the_highlighted_text() {
    let document = DiffDocument::new(PATCH.to_owned(), Some("python"));
    assert!(
        document
            .unified
            .rows
            .iter()
            .filter(|row| row.separator)
            .all(|row| row.number.is_none())
    );
    assert_eq!(document.unified.digits(), 2);
    assert!(
        !document.unified.text.contains("\n\n"),
        "no blank line enters the code that is highlighted"
    );
    // Display rows after the gap still carry the second hunk's line numbers.
    let numbers: Vec<Option<u64>> = document.unified.rows.iter().map(|row| row.number).collect();
    assert_eq!(numbers[6..], [Some(5), None, Some(21), Some(21), Some(22)]);
}

struct PaneRig {
    app: TestApp,
    events: Rc<RefCell<Vec<DiffEvent>>>,
}

/// Unified pane, 60 wide. Screen row 0 is the blank top row, so display row `n` is at `y = n + 1`. The gutter is
/// six cells wide for two-digit line numbers.
fn pane_rig() -> PaneRig {
    let mut pane = DiffPane::new(&one_dark_theme());
    let events = Rc::new(RefCell::new(Vec::new()));
    let seen = events.clone();
    pane.on_event(move |_cx, event| seen.borrow_mut().push(event));
    pane.set_view(DiffView::Unified);
    pane.set_document(Some(Rc::new(DiffDocument::new(PATCH.to_owned(), None))));
    let app = TestApp::new(60, 20);
    let widget = Custom::new(&app, pane).width(60).height(20);
    app.root().add(&widget);
    app.render();
    PaneRig { app, events }
}

const GUTTER: u16 = 6;

#[test]
fn a_press_on_the_separator_selects_nothing_and_rows_after_it_map_to_their_lines() {
    let rig = pane_rig();
    // Display row 7 is the separator, row 8 is ` ctx`, row 9 is `-gone`.
    rig.app.click(GUTTER + 1, 8);
    rig.app.click(GUTTER + 1, 9);
    rig.app.click(GUTTER + 1, 10);
    let presses: Vec<Option<usize>> = rig
        .events
        .borrow()
        .iter()
        .filter_map(|event| match event {
            DiffEvent::Press { target, .. } => Some(target.map(|target| target.raw_row)),
            _ => None,
        })
        .collect();
    assert_eq!(presses, [None, Some(row_of(" ctx")), Some(row_of("-gone"))]);
    assert!(
        !rig.events
            .borrow()
            .iter()
            .any(|event| matches!(event, DiffEvent::Copied(_))),
        "a click copies nothing"
    );
}

#[test]
fn copy_spanning_two_hunks_holds_one_blank_line_and_never_one_at_the_ends() {
    let rig = pane_rig();
    let copied = || {
        rig.events
            .borrow()
            .iter()
            .filter_map(|event| match event {
                DiffEvent::Copied(text) => Some(text.clone()),
                _ => None,
            })
            .collect::<Vec<_>>()
    };
    // From the start of `tail` (row 6) to the end of ` ctx` (row 8).
    rig.app.drag((GUTTER, 7), (GUTTER + 3, 9));
    assert_eq!(copied(), ["tail\n\nctx"]);
    // Ending on the separator copies no trailing blank line.
    rig.app.drag((GUTTER, 6), (GUTTER + 2, 8));
    assert_eq!(copied()[1], "extra\ntail");
    // A drag that starts on the separator starts no text selection.
    let before = copied().len();
    rig.app.drag((GUTTER + 1, 8), (GUTTER + 3, 10));
    assert_eq!(copied().len(), before);
}

#[test]
fn the_separator_row_shows_a_gutter_mark_and_rule_but_no_number_or_sign() {
    let rig = pane_rig();
    let screen = rig.app.render();
    assert!(screen.row(7).contains("tail"), "{screen}");
    let separator = screen.row(8);
    assert!(
        separator.contains('⋮') && separator.contains('┄'),
        "{screen}"
    );
    assert!(
        !separator
            .chars()
            .any(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-'),
        "{screen}"
    );
    assert!(
        screen.row(9).contains("21") && screen.row(9).contains("ctx"),
        "{screen}"
    );
}

#[test]
fn unified_rows_number_each_line_on_its_side() {
    let document = DiffDocument::new(PATCH.to_owned(), None);
    let lines: Vec<(u64, DiffLineKind)> = document
        .unified
        .rows
        .iter()
        .filter(|row| !row.separator)
        .map(|row| {
            let target = row.target.unwrap();
            (target.line, target.kind)
        })
        .collect();
    use DiffLineKind::{Added, Context, Removed};
    assert_eq!(
        lines,
        [
            (1, Context),
            (2, Removed),
            (3, Removed),
            (2, Added),
            (3, Added),
            (4, Added),
            (5, Context),
            (21, Context),
            (21, Removed),
            (22, Added),
        ]
    );
    for row in document.unified.rows.iter().filter_map(|row| row.target) {
        assert_eq!(
            diff_line_target(PATCH, row.raw_row as i64).map(|t| (t.line, t.kind)),
            Some((row.line, row.kind))
        );
    }
}

#[test]
fn a_drag_range_holds_only_changed_rows() {
    let document = DiffDocument::new(PATCH.to_owned(), None);
    assert_eq!(
        document.changed_rows_between(row_of("+extra"), row_of(" same")),
        [
            row_of("-old one"),
            row_of("-old two"),
            row_of("+new one"),
            row_of("+new two"),
            row_of("+extra")
        ]
    );
}

#[test]
fn every_registered_grammar_compiles() {
    crate::grammars::register_all();
    for filetype in [
        "python",
        "go",
        "html",
        "css",
        "json",
        "bash",
        "c",
        "cpp",
        "typescript",
        "markdown",
    ] {
        assert!(
            opentui::syntax::prewarm(filetype),
            "{filetype} has no working grammar"
        );
    }
}

#[test]
fn the_gutter_fits_the_row_count_when_it_exceeds_the_largest_line_number() {
    // A whole-file rewrite of 60 lines: 120 rows, but no line number above 60. OpenTUI sizes the gutter by rows.
    let mut patch =
        String::from("diff --git a/s.py b/s.py\n--- a/s.py\n+++ b/s.py\n@@ -1,60 +1,60 @@\n");
    for i in 0..60 {
        patch.push_str(&format!("-old{i}\n"));
    }
    for i in 0..60 {
        patch.push_str(&format!("+new{i}\n"));
    }
    let document = DiffDocument::new(patch, Some("python"));
    assert_eq!(document.unified.digits(), 3);
}
