//! The history header against a real repository: the columns menu and separator drags save to `layout.json`.

use crate::screens::sidebar::PERSIST_DELAY;
use crate::screens::test_support::{Harness, TempDir, repository};
use crate::services::Services;
use crate::shell::Msg;
use opentui::prelude::*;
use tuig_git::pull_request_types::{CheckRollup, PullRequest, PullRequestList, PullRequestState};
use tuig_ui_model::preferences::load_layout_preferences;

fn started(dir: &TempDir) -> Harness {
    let services = Services {
        layout_path: Some(dir.0.join("layout.json")),
        ..Services::default()
    };
    let h = Harness::start(repository(5), services);
    h.wait("the first snapshot", |shell| shell.snapshot.is_some());
    h.send(Msg::Resize(160, 48));
    h.app.render();
    h
}

fn pull_request() -> PullRequest {
    PullRequest {
        number: 7,
        title: "Add a thing".to_owned(),
        url: "https://example.com/7".to_owned(),
        state: PullRequestState::Open,
        checks: CheckRollup::None,
        author: "ada".to_owned(),
        head_branch: "main".to_owned(),
        head_sha: None,
        from_fork: false,
        mine: true,
        review_requested: false,
        updated_at: "2024-01-01T00:00:00Z".to_owned(),
    }
}

/// The (column, line) of the first occurrence of `needle` on the screen.
fn find(h: &Harness, needle: &str) -> (u16, u16) {
    let text = h.app.text();
    text.lines()
        .enumerate()
        .find_map(|(line, text)| text.find(needle).map(|at| (at as u16, line as u16)))
        .unwrap_or_else(|| panic!("{needle:?} is not on screen:\n{}", h.app.text()))
}

#[test]
fn choosing_pr_in_the_columns_menu_hides_the_column_and_saves_it() {
    let dir = TempDir::new("columns");
    let h = started(&dir);
    {
        let mut shell = h.shell.borrow_mut();
        shell.pull_requests_loaded(
            h.app.app(),
            PullRequestList::Available {
                pull_requests: vec![pull_request()],
            },
        );
    }
    h.send(Msg::Resize(160, 48));
    h.app.render();
    assert!(h.read(|shell| shell.pr_column_available()));

    let (_, header) = find(&h, "Message");
    h.app
        .mouse(MouseEventKind::Down(MouseButton::Right), 60, header);
    h.app
        .mouse(MouseEventKind::Up(MouseButton::Right), 60, header);
    h.wait("the columns menu", |shell| shell.overlay.is_open());
    h.app.render();
    let (x, y) = find(&h, "[x] PR");
    h.app.click(x + 4, y);
    h.app.advance(PERSIST_DELAY);

    assert_eq!(h.read(|shell| shell.history.columns.show_pr), Some(false));
    let saved = load_layout_preferences(&dir.0.join("layout.json"));
    assert_eq!(saved.history_columns.unwrap().show_pr, Some(false));
}

#[test]
fn dragging_a_header_separator_resizes_the_column_and_saves_the_width() {
    let dir = TempDir::new("columns");
    let h = started(&dir);
    let layout = h.read(|shell| shell.history_geometry());
    let origin = h.read(|shell| shell.layout.panes.history_left);
    let (_, header) = find(&h, "Message");
    let separator = (origin + layout.branch_width + 1) as u16;

    h.app.drag((separator, header), (separator + 6, header));
    h.app.advance(PERSIST_DELAY);

    let width = h.read(|shell| shell.history.columns.branch_width);
    assert_eq!(width, Some(layout.branch_width + 6));
    let saved = load_layout_preferences(&dir.0.join("layout.json"));
    assert_eq!(
        saved.history_columns.unwrap().branch_width,
        width.map(|w| w as u32)
    );
}
