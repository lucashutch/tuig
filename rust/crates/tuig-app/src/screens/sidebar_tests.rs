//! The sidebar against a real repository, driven through `TestApp` mouse and key events.

use super::*;
use crate::screens::test_support::{Harness, TempDir, git, repository};
use crate::services::Services;
use std::sync::Arc;
use tuig_ui_model::preferences::load_layout_preferences;

fn prefs_file(dir: &TempDir) -> PathBuf {
    dir.0.join("layout.json")
}

/// Three commits on `main` and a branch `topic` at the same commit.
fn harness_with(services: Services) -> Harness {
    let repo = repository(3);
    git(&repo.0, &["branch", "topic"]);
    let h = Harness::start(repo, services);
    h.wait("the snapshot", |shell| shell.snapshot.is_some());
    h.app.render();
    h
}

fn saving(dir: &TempDir) -> Services {
    Services {
        layout_path: Some(prefs_file(dir)),
        ..Services::default()
    }
}

#[test]
fn clicking_a_header_folds_the_section_and_saves_it() {
    let dir = TempDir::new("prefs");
    let h = harness_with(saving(&dir));
    // The local header is the first row under the toolbar.
    h.app.click(5, 3);
    h.app.advance(PERSIST_DELAY);
    h.wait("the fold", |shell| shell.sidebar.collapsed[Section::Local]);
    assert!(h.app.text().contains("▶ LOCAL BRANCHES 2"));
    let saved = load_layout_preferences(&prefs_file(&dir));
    assert_eq!(saved.sidebar_collapsed.unwrap().local, Some(true));
}

#[test]
fn a_left_click_on_a_branch_row_checks_it_out() {
    let h = harness_with(Services::default());
    // Rows: header, then `main` and `topic` in name order.
    h.app.click(5, 5);
    h.wait("the checkout", |shell| {
        shell
            .snapshot
            .as_ref()
            .is_some_and(|snapshot| snapshot.branch.as_deref() == Some("topic"))
    });
}

#[test]
fn a_right_click_on_a_branch_row_opens_its_menu() {
    let h = harness_with(Services::default());
    h.app.mouse(MouseEventKind::Down(MouseButton::Right), 5, 5);
    h.app.mouse(MouseEventKind::Up(MouseButton::Right), 5, 5);
    h.wait("the menu", |shell| shell.overlay.menu.is_some());
}

#[test]
fn dragging_the_divider_resizes_the_sidebar_and_a_plain_click_folds_it() {
    let dir = TempDir::new("prefs");
    let h = harness_with(saving(&dir));
    let divider = h.read(|shell| shell.layout.panes.left_divider_left) as u16;
    h.app.drag((divider, 20), (36, 20));
    h.app.advance(PERSIST_DELAY);
    h.wait("the new width", |shell| shell.layout.left_width == 36);
    assert_eq!(h.read(|shell| shell.layout.panes.sidebar_width), 36);
    assert_eq!(
        load_layout_preferences(&prefs_file(&dir)).left_width,
        Some(36.0)
    );

    h.app.render();
    h.app.click(36, 20);
    h.wait("the fold", |shell| shell.layout.left_collapsed);
    h.app.advance(PERSIST_DELAY);
    assert_eq!(
        load_layout_preferences(&prefs_file(&dir)).left_collapsed,
        Some(true)
    );
}

#[test]
fn the_sidebar_restores_the_saved_layout() {
    let dir = TempDir::new("prefs");
    std::fs::write(
        prefs_file(&dir),
        r#"{"leftWidth":33,"leftCollapsed":false,"sidebarCollapsed":{"remote":true},"sidebarHeights":{"local":6}}"#,
    )
    .unwrap();
    let services = Services {
        layout: load_layout_preferences(&prefs_file(&dir)),
        ..saving(&dir)
    };
    let h = harness_with(services);
    assert_eq!(h.read(|shell| shell.layout.panes.sidebar_width), 33);
    assert!(h.read(|shell| shell.sidebar.collapsed[Section::Remote]));
    assert_eq!(
        h.read(|shell| shell.sidebar.preferred[Section::Local]),
        Some(6)
    );
}

#[test]
fn the_changes_pane_and_diff_view_restore_from_the_saved_layout() {
    let dir = TempDir::new("prefs");
    std::fs::write(
        prefs_file(&dir),
        r#"{"unstagedHeight":8,"composerHeight":9,"diffView":"inline"}"#,
    )
    .unwrap();
    let h = harness_with(Services {
        layout: load_layout_preferences(&prefs_file(&dir)),
        ..saving(&dir)
    });
    assert_eq!(h.read(|s| s.files.preferred_unstaged_height), Some(8));
    assert_eq!(h.read(|s| s.files.preferred_composer_height), Some(9));
    assert!(!h.read(|s| s.diff.side_by_side));
}

#[test]
fn toggling_the_diff_view_and_avatars_saves_them_and_keeps_unknown_keys() {
    let dir = TempDir::new("prefs");
    std::fs::write(
        prefs_file(&dir),
        r#"{"unstagedHeight":8,"futureKey":{"keep":"me"}}"#,
    )
    .unwrap();
    let h = harness_with(Services {
        layout: load_layout_preferences(&prefs_file(&dir)),
        ..saving(&dir)
    });
    h.app.press("v");
    h.app.press("ctrl+p");
    h.app.type_text("avatars");
    h.app.press("enter");
    h.wait("avatars on", |shell| shell.avatars.enabled);
    h.app.advance(PERSIST_DELAY);
    let saved: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(prefs_file(&dir)).unwrap()).unwrap();
    assert_eq!(saved["diffView"], "inline");
    assert_eq!(saved["avatarsEnabled"], true);
    assert_eq!(saved["unstagedHeight"], 8);
    assert_eq!(saved["futureKey"]["keep"], "me");
}

#[test]
fn the_palette_toggle_collapses_the_sidebar_and_saves_it() {
    let dir = TempDir::new("prefs");
    let h = harness_with(saving(&dir));
    h.app.press("ctrl+p");
    h.app.type_text("collapse left");
    h.app.press("enter");
    h.wait("the collapse", |shell| shell.layout.left_collapsed);
    h.app.advance(PERSIST_DELAY);
    assert_eq!(
        load_layout_preferences(&prefs_file(&dir)).left_collapsed,
        Some(true)
    );
}

#[test]
fn the_branch_filter_narrows_the_list_and_enter_checks_out_the_first_match() {
    let h = harness_with(Services::default());
    h.app.press("/");
    h.wait("the filter box", |shell| shell.sidebar.filter_active);
    h.app.type_text("top");
    h.wait("the filter text", |shell| shell.sidebar.filter == "top");
    assert_eq!(h.read(|shell| shell.sidebar_total(Section::Local)), 1);
    h.app.press("enter");
    h.wait("the checkout", |shell| {
        shell
            .snapshot
            .as_ref()
            .is_some_and(|snapshot| snapshot.branch.as_deref() == Some("topic"))
    });
    assert!(!h.read(|shell| shell.sidebar.filter_active));
}

#[test]
fn escape_clears_the_filter() {
    let h = harness_with(Services::default());
    h.app.press("/");
    h.app.type_text("top");
    h.wait("the filter text", |shell| shell.sidebar.filter == "top");
    h.app.press("escape");
    h.wait("the cleared filter", |shell| {
        shell.sidebar.filter.is_empty() && !shell.sidebar.filter_active
    });
}

#[test]
fn the_wheel_scrolls_only_the_section_under_the_pointer() {
    let repo = repository(2);
    for i in 0..12 {
        git(&repo.0, &["branch", &format!("b{i:02}")]);
    }
    let h = Harness::start(repo, Services::default());
    h.wait("the snapshot", |shell| shell.snapshot.is_some());
    h.app.render();
    h.app.scroll(5, 5, true);
    h.app.advance(SIDEBAR_SCROLL_INTERVAL);
    h.wait("the scroll", |shell| {
        shell.sidebar.start[Section::Local] == 1
    });
    assert_eq!(h.read(|shell| shell.sidebar.start[Section::Remote]), 0);
}

struct OnePullRequest;

#[async_trait::async_trait]
impl tuig_git::pull_request_types::PullRequestService for OnePullRequest {
    async fn list(
        &self,
        _cancel: Option<&tuig_git::process::CancelToken>,
    ) -> tuig_git::pull_request_types::PullRequestList {
        use tuig_git::pull_request_types::*;
        PullRequestList::Available {
            pull_requests: vec![PullRequest {
                number: 7,
                title: "Add topic".into(),
                url: "https://example.com/pull/7".into(),
                state: PullRequestState::Open,
                checks: CheckRollup::Passed,
                author: "ada".into(),
                head_branch: "topic".into(),
                head_sha: None,
                from_fork: false,
                mine: true,
                review_requested: false,
                updated_at: String::new(),
            }],
        }
    }
}

struct RecordingOpener(std::sync::Mutex<Vec<String>>);

#[async_trait::async_trait]
impl crate::services::UrlOpener for RecordingOpener {
    async fn open(&self, url: &str) -> Result<(), String> {
        self.0.lock().unwrap().push(url.to_owned());
        Ok(())
    }
}

#[test]
fn a_pull_request_row_opens_on_a_second_click() {
    let opener = Arc::new(RecordingOpener(Default::default()));
    let h = harness_with(Services {
        pull_requests: Some(Arc::new(OnePullRequest)),
        url_opener: Some(opener.clone()),
        ..Services::default()
    });
    h.wait("the pull request row", |shell| {
        matches!(shell.pull_request_panel(), PullRequestPanel::List(_))
    });
    h.app.render();
    assert!(h.app.text().contains("PULL REQUESTS 1"));
    // Local branches take rows 1 to 8, so the pull request header is on row 10 and its row is on row 11.
    let row = 3 + h.read(|shell| shell.sidebar_rects()[Section::PullRequests].content_top) as u16;
    h.app.click(5, row);
    h.app.click(5, row);
    h.wait("the browser", |_| !opener.0.lock().unwrap().is_empty());
    assert_eq!(opener.0.lock().unwrap()[0], "https://example.com/pull/7");
}

#[test]
fn a_worktree_row_opens_its_repository_in_a_tab_on_a_second_click() {
    let repo = repository(3);
    let linked = TempDir::new("linked");
    let path = linked.0.join("wt");
    git(
        &repo.0,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "side",
            path.to_str().unwrap(),
        ],
    );
    let h = Harness::start(repo, Services::default());
    h.wait("the worktrees", |shell| {
        shell
            .snapshot
            .as_ref()
            .is_some_and(|snapshot| snapshot.worktrees.len() == 2)
    });
    h.app.render();
    let row = h.read(|shell| {
        let index = shell
            .snapshot
            .as_ref()
            .unwrap()
            .worktrees
            .iter()
            .position(|worktree| std::path::Path::new(&worktree.path).ends_with("wt"));
        3 + shell.sidebar_rects()[Section::Worktrees].content_top as u16 + 2 * index.unwrap() as u16
    });
    h.app.click(5, row);
    assert_eq!(h.read(|shell| shell.header.tabs.len()), 1);
    h.app.click(5, row);
    h.wait("the new tab", |shell| shell.header.tabs.len() == 2);
}
