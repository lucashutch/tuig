use super::*;
use tuig_ui_model::theme::one_dark_theme;

fn pr(number: u64, branch: &str) -> PullRequest {
    PullRequest {
        number,
        title: format!("Change {number}"),
        url: format!("https://github.com/o/r/pull/{number}"),
        state: PullRequestState::Open,
        checks: CheckRollup::Passed,
        author: "ada".into(),
        head_branch: branch.into(),
        head_sha: None,
        from_fork: false,
        mine: false,
        review_requested: false,
        updated_at: String::new(),
    }
}

fn branch(name: &str, remote: bool) -> BranchRef {
    BranchRef {
        name: name.into(),
        full_name: if remote {
            format!("refs/remotes/{name}")
        } else {
            format!("refs/heads/{name}")
        },
        sha: "aaa".into(),
        current: false,
        remote,
        upstream: None,
        tracking: None,
    }
}

fn commit(sha: &str, decorations: &[&str]) -> Commit {
    Commit {
        sha: sha.into(),
        decorations: decorations.iter().map(|d| d.to_string()).collect(),
        ..Commit::default()
    }
}

fn text(segments: &[StyledSegment]) -> String {
    segments.iter().map(|s| s.text.as_str()).collect()
}

#[test]
fn local_branch_beats_origin_beats_other_remotes() {
    let branches = [
        branch("upstream/topic", true),
        branch("origin/topic", true),
        branch("topic", false),
    ];
    let found = pull_request_branch(&pr(1, "topic"), &branches).unwrap();
    assert_eq!(found.name, "topic");
    let remote_only = &branches[..2];
    assert_eq!(
        pull_request_branch(&pr(1, "topic"), remote_only)
            .unwrap()
            .name,
        "origin/topic"
    );
    assert_eq!(
        pull_request_branch(&pr(1, "topic"), &remote_only[..1])
            .unwrap()
            .name,
        "upstream/topic"
    );
}

#[test]
fn a_fork_pull_request_never_matches_a_branch_by_name() {
    let mut fork = pr(1, "topic");
    fork.from_fork = true;
    assert!(pull_request_branch(&fork, &[branch("topic", false)]).is_none());
}

#[test]
fn rows_match_by_branch_label_or_head_commit_newest_first() {
    let mut by_sha = pr(7, "other");
    by_sha.head_sha = Some("abc".into());
    let mut fork = pr(9, "topic");
    fork.from_fork = true;
    fork.head_sha = Some("fork".into());
    let list = [pr(3, "topic"), by_sha, fork, pr(5, "topic")];
    let branches = [branch("topic", false), branch("origin/topic", true)];
    let index = pull_request_commit_index(&list, &branches);

    let numbers = |c: &Commit| {
        index
            .for_commit(c)
            .iter()
            .map(|p| p.number)
            .collect::<Vec<_>>()
    };
    assert_eq!(numbers(&commit("x", &["HEAD -> topic"])), [5, 3]);
    assert_eq!(numbers(&commit("x", &["origin/topic"])), [5, 3]);
    assert_eq!(numbers(&commit("abc", &[])), [7]);
    assert_eq!(numbers(&commit("fork", &[])), [9]);
    assert!(numbers(&commit("x", &["tag: topic"])).is_empty());
    assert!(numbers(&commit("x", &["unknown"])).is_empty());
}

#[test]
fn sidebar_lists_mine_then_review_requests_once_each() {
    let mut mine_old = pr(1, "a");
    mine_old.mine = true;
    let mut both = pr(4, "b");
    both.mine = true;
    both.review_requested = true;
    let mut review = pr(6, "c");
    review.review_requested = true;
    let mut review_old = pr(2, "d");
    review_old.review_requested = true;
    let ignored = pr(8, "e");
    let numbers: Vec<u64> = sidebar_pull_requests(&[mine_old, review_old, ignored, review, both])
        .iter()
        .map(|p| p.number)
        .collect();
    assert_eq!(numbers, [4, 1, 6, 2]);
}

#[test]
fn panel_hides_for_missing_gh_and_shows_other_errors() {
    let unavailable = |reason, message: Option<&str>| PullRequestList::Unavailable {
        reason,
        message: message.map(str::to_string),
    };
    assert_eq!(pull_request_panel(false, None), PullRequestPanel::Hidden);
    assert_eq!(pull_request_panel(true, None), PullRequestPanel::Loading);
    for reason in [
        PullRequestUnavailableReason::GhMissing,
        PullRequestUnavailableReason::NotAuthenticated,
        PullRequestUnavailableReason::NotGithub,
    ] {
        assert_eq!(
            pull_request_panel(true, Some(&unavailable(reason, None))),
            PullRequestPanel::Hidden
        );
    }
    let failed = unavailable(PullRequestUnavailableReason::Error, Some("rate limited"));
    assert_eq!(
        pull_request_panel(true, Some(&failed)),
        PullRequestPanel::Message("rate limited".into())
    );
    let bare = unavailable(PullRequestUnavailableReason::Error, None);
    assert_eq!(
        pull_request_panel(true, Some(&bare)),
        PullRequestPanel::Message("Could not load pull requests".into())
    );
}

#[test]
fn history_cell_shows_number_checks_and_extra_count_in_the_column_width() {
    let theme = one_dark_theme();
    let (a, b) = (pr(12, "x"), pr(3, "x"));
    assert_eq!(
        text(&pull_request_history_cell(&[&a], 9, &theme, "⠋")),
        "#12 ✓    "
    );
    assert_eq!(
        text(&pull_request_history_cell(&[&a, &b], 9, &theme, "⠋")),
        "#12 ✓ +1 "
    );
    assert_eq!(
        text(&pull_request_history_cell(&[], 9, &theme, "⠋")),
        " ".repeat(9)
    );
    let mut running = pr(12, "x");
    running.checks = CheckRollup::Running;
    assert!(text(&pull_request_history_cell(&[&running], 9, &theme, "⠹")).contains('⠹'));
}

#[test]
fn clipped_rows_end_in_an_ellipsis_and_fill_the_width() {
    let theme = one_dark_theme();
    let mut long = pr(1234, "x");
    long.title = "A title that is far too long for the row".into();
    let row = pull_request_sidebar_row(&long, 20, &theme, "⠋");
    let joined = text(&row);
    assert_eq!(string_width(&joined), 20);
    assert!(joined.ends_with('…'));
    assert!(joined.contains("#1234"));
}

#[test]
fn tentative_checks_use_a_dimmer_success_color() {
    let theme = one_dark_theme();
    let (_, passed) = pull_request_icons(PullRequestState::Open, CheckRollup::Passed, &theme, "⠋");
    let (_, tentative) =
        pull_request_icons(PullRequestState::Open, CheckRollup::Tentative, &theme, "⠋");
    assert_eq!(passed.glyph, tentative.glyph);
    assert_eq!(tentative.color, mix_color(theme.added, theme.bg, 0.5));
    assert_ne!(tentative.color, passed.color);
    assert_eq!(
        mix_color(Rgba::rgb(0, 0, 0), Rgba::rgb(255, 255, 255), 0.5),
        Rgba::rgb(128, 128, 128)
    );
}
