//! The pane keys against a real repository: stage, unstage, stage all, discard all, and the remote keys.

use crate::screens::test_support::{Harness, TempDir, git, repository};
use crate::selected_file::FileSource;
use crate::services::Services;
use std::process::Command;

/// A repository with one modified tracked file and one untracked file.
fn dirty() -> Harness {
    let dir: TempDir = repository(2);
    std::fs::write(dir.0.join("file.txt"), "changed\n").unwrap();
    std::fs::write(dir.0.join("new.txt"), "new\n").unwrap();
    let h = Harness::start(dir, Services::default());
    h.wait("the working files", |shell| {
        shell
            .snapshot
            .as_ref()
            .is_some_and(|snapshot| snapshot.files.len() == 2)
    });
    // Tab moves to the changes pane, which selects the first file.
    h.app.press("tab");
    h.wait("a selected file", |shell| shell.files.selected.is_some());
    h
}

/// `git status` without the optional index lock. The tests poll it, and a lock held at the wrong moment would make the
/// app's own `git add` fail.
fn status(h: &Harness) -> Vec<String> {
    let output = Command::new("git")
        .args(["--no-optional-locks", "status", "--porcelain"])
        .current_dir(&h._repo.0)
        .output()
        .unwrap();
    String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(str::to_owned)
        .collect()
}

fn wait_for_status(h: &Harness, expected: &[&str]) {
    h.wait("the repository to change", |_| status(h) == expected);
}

#[test]
fn s_stages_the_selected_file_and_u_unstages_it() {
    let h = dirty();
    let path = h.read(|shell| shell.files.selected.as_ref().unwrap().path.clone());
    assert_eq!(path, "file.txt");
    h.app.press("s");
    wait_for_status(&h, &["M  file.txt", "?? new.txt"]);
    h.wait("the refresh", |shell| !shell.tasks.snapshot.busy());
    h.app.press("t");
    h.wait("the staged file", |shell| {
        shell
            .files
            .selected
            .as_ref()
            .is_some_and(|file| file.source == FileSource::WorkingStaged && file.path == "file.txt")
    });
    h.app.press("u");
    wait_for_status(&h, &[" M file.txt", "?? new.txt"]);
}

#[test]
fn a_stages_everything() {
    let h = dirty();
    h.app.press("a");
    wait_for_status(&h, &["M  file.txt", "A  new.txt"]);
}

#[test]
fn d_discards_only_on_the_second_press() {
    let h = dirty();
    // Stage the untracked file so that only the tracked change is left to discard.
    git(&h._repo.0, &["add", "new.txt"]);
    h.app.press("d");
    assert_eq!(
        h.read(|shell| shell.notice.clone()).as_deref(),
        Some("Discard all unstaged changes? Press again to confirm")
    );
    assert_eq!(
        status(&h),
        [" M file.txt", "A  new.txt"],
        "one press only asks"
    );
    h.app.press("d");
    wait_for_status(&h, &["A  new.txt"]);
}

#[test]
fn s_does_nothing_without_a_selected_file() {
    let h = dirty();
    h.shell.borrow_mut().files.selected = None;
    h.app.press("s");
    std::thread::sleep(std::time::Duration::from_millis(200));
    assert_eq!(status(&h), [" M file.txt", "?? new.txt"]);
}

#[test]
fn f_l_and_p_start_the_remote_operations() {
    for (key, label) in [("f", "Fetching…"), ("l", "Pulling…"), ("p", "Pushing…")] {
        let h = dirty();
        h.app.press(key);
        assert_eq!(
            h.read(|shell| shell.busy_notice().map(str::to_owned))
                .as_deref(),
            Some(label),
            "key {key}"
        );
    }
}
