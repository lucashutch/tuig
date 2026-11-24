use tuig_ui_model::history_columns::{
    HistoryColumns, HistoryDividerKey, history_column_layout, history_divider_at,
    is_divider_double_click, visible_history_columns,
};

#[test]
fn header_divider_hit_testing_follows_resized_columns() {
    let layout = history_column_layout(
        120,
        5,
        HistoryColumns {
            branch_width: Some(32),
            committer_width: Some(16),
            show_committer: true,
            show_sha: true,
            ..HistoryColumns::default()
        },
    );
    assert_eq!(
        history_divider_at(32, &layout),
        Some(HistoryDividerKey::BranchWidth)
    );
    assert_eq!(
        history_divider_at(layout.message_start - 2, &layout),
        Some(HistoryDividerKey::GraphWidth)
    );
    assert_eq!(
        history_divider_at(layout.message_end + 1, &layout),
        Some(HistoryDividerKey::CommitterWidth)
    );
    assert_eq!(history_divider_at(layout.message_start + 3, &layout), None);
}

#[test]
fn the_committer_separator_only_resizes_while_the_column_is_shown() {
    let layout = history_column_layout(
        120,
        5,
        HistoryColumns {
            show_sha: true,
            ..HistoryColumns::default()
        },
    );
    assert_eq!(history_divider_at(layout.message_end + 1, &layout), None);
}

#[test]
fn no_column_preference_can_leave_empty_space_beside_the_sha_column() {
    for show_committer in [true, false] {
        for show_sha in [true, false] {
            for show_pr in [None, Some(true)] {
                for committer_width in [1, 11, 40, 500] {
                    for graph_width in [1, 20, 500] {
                        let prefs = visible_history_columns(
                            HistoryColumns {
                                branch_width: Some(30),
                                graph_width: Some(graph_width),
                                committer_width: Some(committer_width),
                                show_committer,
                                show_sha,
                                show_pr,
                            },
                            true,
                        );
                        let layout = history_column_layout(100, 6, prefs);
                        let end = layout.message_end
                            + if show_committer {
                                layout.committer_width + 3
                            } else {
                                0
                            }
                            + if show_pr == Some(true) || show_pr.is_none() {
                                12
                            } else {
                                0
                            }
                            + if show_sha { 11 } else { 0 };
                        // Only the scrollbar column remains.
                        assert_eq!(end + 1, 100, "{prefs:?}");
                    }
                }
            }
        }
    }
}

#[test]
fn the_pr_column_needs_pull_request_data() {
    let columns = HistoryColumns::default();
    assert_eq!(visible_history_columns(columns, false).show_pr, Some(false));
    assert_eq!(visible_history_columns(columns, true).show_pr, Some(true));
    let hidden = HistoryColumns {
        show_pr: Some(false),
        ..columns
    };
    assert_eq!(visible_history_columns(hidden, true).show_pr, Some(false));
}

#[test]
fn a_second_press_on_the_same_separator_within_the_window_is_a_double_click() {
    let first = Some((HistoryDividerKey::GraphWidth, 1000));
    assert!(is_divider_double_click(
        first,
        HistoryDividerKey::GraphWidth,
        1300,
        400
    ));
    assert!(!is_divider_double_click(
        first,
        HistoryDividerKey::GraphWidth,
        1400,
        400
    ));
    assert!(!is_divider_double_click(
        first,
        HistoryDividerKey::BranchWidth,
        1100,
        400
    ));
    assert!(!is_divider_double_click(
        None,
        HistoryDividerKey::GraphWidth,
        1100,
        400
    ));
}

#[test]
fn oversized_preferences_are_clamped_after_a_terminal_resize() {
    let layout = history_column_layout(
        80,
        1,
        HistoryColumns {
            branch_width: Some(100),
            committer_width: Some(200),
            show_committer: true,
            show_sha: true,
            ..HistoryColumns::default()
        },
    );
    assert!(layout.branch_width < 100);
    assert!(layout.committer_width < 200);
    assert_eq!(layout.sha_start + 8 + 1, 80);
}
