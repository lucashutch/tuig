use tuig_ui_model::diff_lines::{
    DiffLineKind, DiffLineTarget, DiffSide, changed_diff_rows_in_range, diff_line_target,
    rendered_diff_line_target, split_diff_line_target,
};

fn diff() -> String {
    [
        "diff --git a/a.ts b/a.ts",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -10,3 +10,4 @@",
        " same",
        "-old",
        "+new",
        "+extra",
        " tail",
    ]
    .join("\n")
}

fn target(
    line: u64,
    side: DiffSide,
    kind: DiffLineKind,
    old_line: Option<u64>,
    raw_row: usize,
    rendered_row: usize,
) -> DiffLineTarget {
    DiffLineTarget {
        line,
        side,
        kind,
        old_line,
        raw_row,
        rendered_row,
    }
}

#[test]
fn maps_context_and_changed_rows_to_their_file_side() {
    use DiffLineKind::*;
    use DiffSide::*;
    let diff = diff();
    assert_eq!(
        diff_line_target(&diff, 4),
        Some(target(10, New, Context, Some(10), 4, 0))
    );
    assert_eq!(
        diff_line_target(&diff, 5),
        Some(target(11, Old, Removed, Some(11), 5, 1))
    );
    assert_eq!(
        diff_line_target(&diff, 6),
        Some(target(11, New, Added, None, 6, 2))
    );
    assert_eq!(
        diff_line_target(&diff, 7),
        Some(target(12, New, Added, None, 7, 3))
    );
    assert_eq!(
        diff_line_target(&diff, 8),
        Some(target(13, New, Context, Some(12), 8, 4))
    );
}

#[test]
fn headers_and_out_of_range_rows_have_no_target() {
    let diff = diff();
    assert_eq!(diff_line_target(&diff, 2), None);
    assert_eq!(diff_line_target(&diff, 3), None);
    assert_eq!(diff_line_target(&diff, -1), None);
    assert_eq!(diff_line_target(&diff, 100), None);
}

#[test]
fn counts_are_optional_in_hunk_headers_and_line_numbers_restart_per_hunk() {
    let diff = [
        "diff --git a/a b/a",
        "--- a/a",
        "+++ b/a",
        "@@ -1 +1 @@",
        "-a",
        "+b",
        "@@ -20,2 +20,2 @@",
        " c",
        "-d",
        "+e",
    ]
    .join("\n");
    assert_eq!(
        diff_line_target(&diff, 8),
        Some(target(
            21,
            DiffSide::Old,
            DiffLineKind::Removed,
            Some(21),
            8,
            3
        ))
    );
    // Hunk 1 starts two body rows below the first hunk's start.
    assert_eq!(
        rendered_diff_line_target(&diff, 4, &[0, 2]),
        Some(target(21, DiffSide::New, DiffLineKind::Added, None, 9, 4))
    );
}

#[test]
fn maps_each_side_of_aligned_split_rows() {
    let diff = diff();
    let kind = |row, side| split_diff_line_target(&diff, row, side).map(|t| (t.kind, t.raw_row));
    assert_eq!(kind(1, DiffSide::Old), Some((DiffLineKind::Removed, 5)));
    assert_eq!(kind(1, DiffSide::New), Some((DiffLineKind::Added, 6)));
    assert_eq!(kind(2, DiffSide::Old), None);
    assert_eq!(kind(2, DiffSide::New), Some((DiffLineKind::Added, 7)));
}

#[test]
fn split_rows_ignore_content_after_the_last_hunk_line() {
    let trailing = format!("{}\n\nunknown metadata\n", diff());
    for side in [DiffSide::Old, DiffSide::New] {
        assert_eq!(split_diff_line_target(&trailing, 4, side), None);
        assert_eq!(split_diff_line_target(&trailing, 100, side), None);
    }
}

#[test]
fn rendered_rows_skip_patch_headers_and_no_newline_markers() {
    let diff = diff();
    assert_eq!(
        rendered_diff_line_target(&diff, 2, &[0]),
        Some(target(11, DiffSide::New, DiffLineKind::Added, None, 6, 2))
    );
    let marker = diff.replace("+extra", "+extra\n\\ No newline at end of file");
    assert_eq!(
        rendered_diff_line_target(&marker, 4, &[0]),
        Some(target(
            13,
            DiffSide::New,
            DiffLineKind::Context,
            Some(12),
            9,
            4
        ))
    );
}

#[test]
fn a_drag_range_collects_only_changed_rows_in_either_direction() {
    let diff = diff();
    assert_eq!(changed_diff_rows_in_range(&diff, 4, 8), [5, 6, 7]);
    assert_eq!(changed_diff_rows_in_range(&diff, 8, 4), [5, 6, 7]);
}
