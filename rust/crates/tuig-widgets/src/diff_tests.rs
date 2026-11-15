use super::*;
use tuig_ui_model::diff_lines::{diff_line_target, split_diff_line_target};

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
    // Row 1 pairs the first removal with the first addition. Row 3 has only an addition.
    assert_eq!(side(DiffSide::Old, 1), Some(row_of("-old one")));
    assert_eq!(side(DiffSide::New, 1), Some(row_of("+new one")));
    assert_eq!(side(DiffSide::Old, 3), None, "a filler row selects nothing");
    assert_eq!(side(DiffSide::New, 3), Some(row_of("+extra")));
    // The second hunk follows without a header row, and the marker line has no row.
    assert_eq!(side(DiffSide::Old, 6), Some(row_of("-gone")));
    assert_eq!(side(DiffSide::New, 6), Some(row_of("+kept")));
    assert_eq!(document.len(DiffView::Split), 7);
    // The same rows as the TypeScript mapping before the marker. After it, `splitDiffLineTarget` starts a new run
    // while the TS renderer, which drops the marker, pairs `-gone` with `+kept` as this document does.
    for row in 0..6 {
        for (side, model) in [
            (DiffSide::Old, tuig_ui_model::diff_lines::DiffSide::Old),
            (DiffSide::New, tuig_ui_model::diff_lines::DiffSide::New),
        ] {
            let ours = document.target_at(DiffView::Split, side, row);
            let reference = split_diff_line_target(PATCH, row as i64, model);
            assert_eq!(
                ours.map(|t| (t.raw_row, t.line, t.kind)),
                reference.map(|t| (t.raw_row, t.line, t.kind)),
                "row {row} {side:?}"
            );
        }
    }
}

#[test]
fn unified_rows_number_each_line_on_its_side() {
    let document = DiffDocument::new(PATCH.to_owned(), None);
    let lines: Vec<(u64, DiffLineKind)> = document
        .unified
        .rows
        .iter()
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
