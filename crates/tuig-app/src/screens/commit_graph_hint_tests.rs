use crate::screens::test_support::{Harness, TempDir, repository};
use crate::services::Services;
use tuig_ui_model::preferences::load_layout_preferences;

fn start(dir: &TempDir) -> Harness {
    let services = Services {
        layout: load_layout_preferences(&dir.0.join("layout.json")),
        layout_path: Some(dir.0.join("layout.json")),
        ..Services::default()
    };
    let h = Harness::start(repository(3), services);
    h.wait("the first snapshot", |shell| shell.snapshot.is_some());
    h.shell.borrow_mut().notice = None;
    h
}

fn hint(h: &Harness, result: Option<&str>) -> Option<String> {
    let mut shell = h.shell.borrow_mut();
    shell.notice = None;
    shell.commit_graph_hint_loaded(Ok(result.map(str::to_owned)));
    shell.notice.clone()
}

#[test]
fn a_large_repository_without_a_commit_graph_gets_the_notice_once() {
    let dir = TempDir::new("graph-hint");
    let h = start(&dir);
    let notice = hint(&h, Some("/work/big/.git")).expect("the first check shows the notice");
    assert!(notice.contains("git maintenance start"), "{notice}");
    assert_eq!(hint(&h, Some("/work/big/.git")), None, "shown once");
}

#[test]
fn another_repository_still_gets_its_notice() {
    let dir = TempDir::new("graph-hint");
    let h = start(&dir);
    assert!(hint(&h, Some("/work/a/.git")).is_some());
    assert!(hint(&h, Some("/work/b/.git")).is_some());
}

#[test]
fn a_repository_that_passes_the_check_shows_nothing() {
    let dir = TempDir::new("graph-hint");
    let h = start(&dir);
    assert_eq!(hint(&h, None), None);
    // A repository that never got the notice is not recorded as dismissed.
    assert!(
        load_layout_preferences(&dir.0.join("layout.json"))
            .commit_graph_hint_dismissed
            .is_none()
    );
}

#[test]
fn the_dismissal_survives_a_restart() {
    let dir = TempDir::new("graph-hint");
    {
        let h = start(&dir);
        assert!(hint(&h, Some("/work/big/.git")).is_some());
    }
    let saved = load_layout_preferences(&dir.0.join("layout.json"));
    assert_eq!(
        saved.commit_graph_hint_dismissed,
        Some(vec!["/work/big/.git".to_owned()])
    );
    let h = start(&dir);
    assert_eq!(hint(&h, Some("/work/big/.git")), None);
}
