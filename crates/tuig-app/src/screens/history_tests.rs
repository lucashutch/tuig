//! History clicks against a real repository: the SHA copy, and the checkout by double click on a label.

use super::*;
use crate::screens::test_support::{Harness, TempDir, git, repository};
use crate::services::Services;

/// Four commits on `main`, a branch `topic` on the second newest commit, and a tag on the oldest.
fn labelled() -> TempDir {
    let dir = repository(4);
    git(&dir.0, &["branch", "topic", "HEAD~1"]);
    git(&dir.0, &["tag", "v1", "HEAD~3"]);
    dir
}

fn start() -> Harness {
    let h = Harness::start(labelled(), Services::default());
    h.wait("the first snapshot", |shell| shell.snapshot_complete());
    h
}

fn current_branch(h: &Harness) -> String {
    let output = std::process::Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&h._repo.0)
        .output()
        .unwrap();
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

/// The display row of the commit whose decorations include `label`.
fn row_with(h: &Harness, label: &str) -> usize {
    h.read(|shell| {
        let index = shell
            .history
            .commits
            .iter()
            .position(|commit| commit.decorations.iter().any(|d| d.contains(label)))
            .unwrap();
        index + usize::from(shell.has_working())
    })
}

#[test]
fn a_double_click_on_a_branch_label_checks_the_branch_out() {
    let h = start();
    let row = row_with(&h, "topic");
    h.send(Msg::HistoryClick {
        row,
        part: ClickPart::Label,
        clicks: 1,
    });
    assert_eq!(current_branch(&h), "main", "one click only selects");
    h.send(Msg::HistoryClick {
        row,
        part: ClickPart::Label,
        clicks: 2,
    });
    h.wait("the checkout", |_| current_branch(&h) == "topic");
}

#[test]
fn a_double_click_on_a_tag_label_checks_nothing_out() {
    let h = start();
    let row = row_with(&h, "tag: v1");
    h.send(Msg::HistoryClick {
        row,
        part: ClickPart::Label,
        clicks: 2,
    });
    assert_eq!(
        h.read(|shell| shell.notice.clone()).as_deref(),
        Some("That label is a tag, not a branch")
    );
    assert_eq!(current_branch(&h), "main");
}

#[test]
fn a_double_click_off_the_label_only_opens_the_commit() {
    let h = start();
    let row = row_with(&h, "topic");
    h.send(Msg::HistoryClick {
        row,
        part: ClickPart::Row,
        clicks: 2,
    });
    assert!(h.read(|shell| shell.commit_open()));
    assert_eq!(current_branch(&h), "main");
}

#[test]
fn a_press_on_the_sha_selects_the_row_without_opening_the_commit() {
    // The copy and its notice need a running terminal, which tests do not have.
    let h = start();
    let row = row_with(&h, "topic");
    h.send(Msg::HistoryClick {
        row,
        part: ClickPart::Sha,
        clicks: 1,
    });
    let (selected, open) = h.read(|shell| (shell.history.selection, shell.commit_open()));
    // The clean repository has no working row, so display rows are commit indexes.
    assert_eq!(selected, HistorySelection::Commit(row));
    assert!(!open, "TS selects the row but does not open the commit");
}
