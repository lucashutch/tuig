use super::*;
use tuig_git::types::Stash;
use tuig_ui_model::sidebar::layout_sidebar_sections;
use tuig_ui_model::theme::one_dark_theme;

fn branch(name: &str, remote: bool, current: bool) -> BranchRef {
    BranchRef {
        name: name.to_owned(),
        full_name: format!("refs/{}/{name}", if remote { "remotes" } else { "heads" }),
        sha: "a".repeat(40),
        current,
        remote,
        upstream: None,
        tracking: None,
    }
}

fn present(snapshot: &RepositorySnapshot, filter: &str, height: i64) -> Presented {
    let hidden = {
        let mut hidden = PerSection::<bool>::default();
        hidden[Section::PullRequests] = true;
        hidden
    };
    let rects = layout_sidebar_sections(
        height,
        &PerSection::default(),
        &PerSection::default(),
        &hidden,
    );
    present_sidebar(&SidebarInput {
        snapshot,
        refs: &RefIndex::new(&snapshot.branches),
        panel: &PullRequestPanel::Hidden,
        theme: &one_dark_theme(),
        spinner_frame: "⠋",
        rects,
        collapsed: PerSection::default(),
        start: PerSection::default(),
        width: 28,
        filter,
    })
}

fn text(view: &SectionView, row: usize) -> String {
    view.lines[row]
        .iter()
        .map(|part| part.text.as_str())
        .collect()
}

#[test]
fn branch_rows_mark_the_checked_out_branch_and_where_a_ref_exists() {
    let snapshot = RepositorySnapshot {
        branches: vec![
            branch("main", false, true),
            branch("both", false, false),
            branch("origin/both", true, false),
            branch("origin/only", true, false),
        ],
        ..RepositorySnapshot::default()
    };
    let presented = present(&snapshot, "", 45);
    let local = &presented.view.sections[Section::Local];
    assert_eq!(text(local, 0).trim_end(), "◉ 󰌢 main");
    assert_eq!(text(local, 1).trim_end(), "◆ 󰌢 both");
    assert_eq!(local.header, "▼ LOCAL BRANCHES 2");
    let remote = &presented.view.sections[Section::Remote];
    assert_eq!(text(remote, 0).trim_end(), "◆ 󰖟 both");
    assert_eq!(text(remote, 1).trim_end(), "◌ 󰖟 only");
}

#[test]
fn the_filter_narrows_the_rows_and_the_header_count() {
    let snapshot = RepositorySnapshot {
        branches: vec![
            branch("main", false, true),
            branch("feature/Login", false, false),
            branch("origin/feature/login", true, false),
        ],
        ..RepositorySnapshot::default()
    };
    let presented = present(&snapshot, "  LOGIN ", 45);
    let local = &presented.view.sections[Section::Local];
    assert_eq!(local.header, "▼ LOCAL BRANCHES 1");
    assert_eq!(text(local, 0).trim_end(), "○ 󰌢 feature/Login");
    assert_eq!(text(local, 1).trim(), "");
    assert_eq!(
        presented.view.sections[Section::Remote].header,
        "▼ REMOTES 1"
    );
}

#[test]
fn an_empty_section_says_none_on_its_first_row_only() {
    let presented = present(&RepositorySnapshot::default(), "", 45);
    let stashes = &presented.view.sections[Section::Stashes];
    assert_eq!(text(stashes, 0).trim_end(), "  (none)");
    assert_eq!(text(stashes, 1).trim(), "");
}

#[test]
fn every_row_is_as_wide_as_the_pane_minus_the_scrollbar_column() {
    let snapshot = RepositorySnapshot {
        stashes: vec![Stash {
            reference: "stash@{0}".into(),
            sha: "b".repeat(40),
            created_at: "2 days ago".into(),
            subject: "WIP on a very long branch name that cannot fit the pane".into(),
            branch: None,
        }],
        ..RepositorySnapshot::default()
    };
    let presented = present(&snapshot, "", 45);
    let stashes = &presented.view.sections[Section::Stashes];
    for row in 0..2 {
        assert_eq!(string_width_of(&text(stashes, row)), 27);
    }
    assert!(text(stashes, 1).starts_with("   on unknown branch"));
}

fn string_width_of(text: &str) -> usize {
    tuig_ui_model::text_width::string_width(text)
}

fn worktree(path: &str, branch: Option<&str>, prunable: Option<&str>) -> Worktree {
    Worktree {
        path: path.to_owned(),
        sha: "0123456789abcdef".to_owned(),
        branch: branch.map(str::to_owned),
        bare: false,
        detached: branch.is_none(),
        locked: None,
        prunable: prunable.map(str::to_owned),
    }
}

#[test]
fn worktrees_mark_the_open_one_and_flag_a_prunable_one_that_has_a_reason() {
    let rows = worktree_rows(
        &[
            worktree("/work/repo/", Some("main"), None),
            worktree(
                "/work/other",
                None,
                Some("gitdir file points to a missing location"),
            ),
            worktree("/work/empty", Some("x"), Some("")),
        ],
        "/work/repo",
        28,
    );
    assert_eq!(rows[0].label, " ◉ repo");
    assert!(rows[0].current);
    assert_eq!(rows[0].detail, "  on main");
    assert_eq!(rows[1].label, " ⎇ other ⚠");
    assert_eq!(rows[1].detail, "  detached at 0123456");
    // A prunable worktree without a reason has an empty reason, which TS treats as not set.
    assert_eq!(rows[2].label, " ⎇ empty");
}

#[test]
fn the_scrollbar_thumb_follows_the_scroll_position() {
    let track: String = (0..10)
        .map(|row| scrollbar_glyph(100, 50, 10, row))
        .collect();
    assert_eq!(track, "│││││█││││");
    assert_eq!(scrollbar_glyph(10, 0, 10, 0), ' ');
}

#[test]
fn a_scrolled_list_clamps_to_its_last_page() {
    let snapshot = RepositorySnapshot {
        branches: (0..20)
            .map(|i| branch(&format!("b{i:02}"), false, false))
            .collect(),
        ..RepositorySnapshot::default()
    };
    let hidden = {
        let mut hidden = PerSection::<bool>::splat(true);
        hidden[Section::Local] = false;
        hidden
    };
    let rects = layout_sidebar_sections(6, &PerSection::default(), &PerSection::default(), &hidden);
    let mut start = PerSection::<usize>::default();
    start[Section::Local] = 99;
    let presented = present_sidebar(&SidebarInput {
        snapshot: &snapshot,
        refs: &RefIndex::new(&snapshot.branches),
        panel: &PullRequestPanel::Hidden,
        theme: &one_dark_theme(),
        spinner_frame: "⠋",
        rects,
        collapsed: PerSection::default(),
        start,
        width: 28,
        filter: "",
    });
    let local = &presented.view.sections[Section::Local];
    assert_eq!(presented.start[Section::Local], 20 - local.lines.len());
    assert!(text(local, local.lines.len() - 1).contains("b19"));
}

#[test]
fn only_the_middle_columns_above_a_divider_scroll_once_and_start_its_drag() {
    let mut hidden = PerSection::<bool>::default();
    hidden[Section::PullRequests] = true;
    let rects =
        layout_sidebar_sections(30, &PerSection::default(), &PerSection::default(), &hidden);
    let divider = rects[Section::Local]
        .divider_top
        .expect("a divider below Local");
    let mut sidebar = Sidebar::new(one_dark_theme());
    sidebar.set_view(Rc::new(SidebarView {
        width: 28,
        rects,
        ..SidebarView::default()
    }));
    // The hit box starts at column 7 and is 14 columns wide.
    let (inside, left_of, right_of) = (7, 6, 21);
    for (x, handlers, drags) in [(inside, 1, true), (left_of, 2, false), (right_of, 2, false)] {
        assert_eq!(
            sidebar.wheel_handlers(x, divider - 1),
            handlers,
            "column {x}"
        );
        assert_eq!(
            sidebar.divider_at(x, divider - 1).is_some(),
            drags,
            "column {x}"
        );
    }
    assert_eq!(sidebar.wheel_handlers(inside, divider - 2), 2);
    assert_eq!(sidebar.wheel_handlers(inside, divider), 1);
    assert_eq!(sidebar.divider_at(inside, divider), Some(Section::Local));
    assert_eq!(sidebar.divider_at(left_of, divider), None);
}
