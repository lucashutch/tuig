use super::*;
use crate::screens::test_support::{Harness, repository};
use crate::services::Services;
use std::time::Duration;

fn start() -> Harness {
    let h = Harness::start(repository(3), Services::default());
    h.wait("the first snapshot", |shell| shell.snapshot_complete());
    h
}

fn bottom_row(h: &Harness) -> String {
    h.app.render().row(47).to_string()
}

#[test]
fn a_notice_shows_at_the_right_of_the_bottom_row_and_expires() {
    let h = start();
    assert!(bottom_row(&h).contains("j/k move"), "{}", bottom_row(&h));
    h.shell.borrow_mut().notice = Some("Copied abc12345".into());
    h.send(Msg::Resize(160, 48));
    let row = bottom_row(&h);
    assert!(row.trim_end().ends_with("Copied abc12345"), "{row:?}");
    assert!(row.contains("j/k move"), "the hints stay: {row:?}");
    h.app.advance(NOTICE_TIMEOUT + Duration::from_millis(100));
    assert!(h.read(|shell| shell.notice.is_none()));
    h.send(Msg::Resize(160, 48));
    assert!(!bottom_row(&h).contains("Copied"), "{}", bottom_row(&h));
}

#[test]
fn the_same_notice_shown_again_gets_six_more_seconds() {
    let h = start();
    h.shell.borrow_mut().notify("Copied abc12345");
    h.send(Msg::Resize(160, 48));
    h.app.advance(Duration::from_secs(4));
    // Same text, a new notification. Its timer starts now, so the first timer must not clear it.
    h.shell.borrow_mut().notify("Copied abc12345");
    h.send(Msg::Resize(160, 48));
    h.app.advance(Duration::from_secs(4));
    assert!(
        h.read(|shell| shell.notice.is_some()),
        "8 s after the first, 4 s after the second"
    );
    h.app
        .advance(Duration::from_secs(2) + Duration::from_millis(100));
    assert!(h.read(|shell| shell.notice.is_none()));
}

#[test]
fn a_busy_notice_stays_out_of_the_footer() {
    let h = start();
    h.shell
        .borrow_mut()
        .notify_tone(NoticeTone::Busy, "Pushing…");
    h.send(Msg::Resize(160, 48));
    assert!(!bottom_row(&h).contains("Pushing"), "{}", bottom_row(&h));
    assert_eq!(
        h.read(|shell| shell.busy_notice().map(str::to_owned))
            .as_deref(),
        Some("Pushing…")
    );
}

#[test]
fn the_hints_switch_while_the_commit_fields_have_focus() {
    let h = start();
    h.app.press("tab");
    h.app.press("c");
    assert!(h.read(|shell| shell.composing()));
    h.send(Msg::Resize(160, 48));
    assert!(bottom_row(&h).contains("↵ commit"), "{}", bottom_row(&h));
    h.app.press("escape");
    h.send(Msg::Resize(160, 48));
    assert!(
        !bottom_row(&h).contains("↵ commit  ·  ⇥ summary"),
        "{}",
        bottom_row(&h)
    );
}
