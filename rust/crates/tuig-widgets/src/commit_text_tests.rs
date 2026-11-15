use super::*;

fn commit() -> Commit {
    Commit {
        sha: "27e4e3f5aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
        parents: vec!["223ceb6dbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into()],
        author: "Ada Tester".into(),
        author_email: "ada@example.invalid".into(),
        authored_at: "2024-03-01T14:00:00+00:00".into(),
        committer: "Ada Tester".into(),
        committer_email: "ada@example.invalid".into(),
        committed_at: "2024-03-01T14:00:00+00:00".into(),
        subject: "feat: normalise user names".into(),
        body: None,
        decorations: vec![],
    }
}

#[test]
fn identity_card_lists_the_committer_only_when_it_differs() {
    let same = present_commit_text(&commit());
    assert_eq!(same.muted.len(), 3, "email, date, parent");
    assert_eq!(same.muted[2], "Parent: 223ceb6d");
    assert_eq!(same.body, "(no body)");

    let mut other = commit();
    other.committer = "Grace".into();
    other.committer_email = "grace@example.invalid".into();
    let text = present_commit_text(&other);
    assert!(
        text.muted
            .contains(&"Committed by Grace <grace@example.invalid>".to_string())
    );
    assert!(
        text.muted
            .iter()
            .any(|line| line.starts_with("Committed: "))
    );
}

#[test]
fn body_drops_leading_blank_lines_only() {
    let mut commit = commit();
    commit.body = Some("  \n\t\nFirst line\n\nSecond".into());
    assert_eq!(present_commit_text(&commit).body, "First line\n\nSecond");
}

#[test]
fn co_author_trailers_need_a_name_and_an_email() {
    let body = "text\nCo-authored-by: Grace Hopper <grace@example.invalid>\nco-authored-by:  <none@example.invalid>\nCo-authored-by: No Email";
    assert_eq!(
        parse_co_authors(body),
        vec![CoAuthor {
            name: "Grace Hopper".into(),
            email: "grace@example.invalid".into()
        }]
    );
}

#[test]
fn relative_time_picks_the_largest_whole_unit() {
    let now: Timestamp = "2024-03-01T14:00:00Z".parse().unwrap();
    let at = |value: &str| format_relative_time(value, now);
    assert_eq!(at("2024-03-01T13:59:55Z"), "just now");
    assert_eq!(at("2024-03-01T13:59:30Z"), "30s ago");
    assert_eq!(at("2024-03-01T11:00:00Z"), "3h ago");
    assert_eq!(at("2024-02-15T14:00:00Z"), "2w ago");
    assert_eq!(at("2024-02-01T14:00:00Z"), "1mo ago");
    assert_eq!(at("2024-03-02T14:00:00Z"), "in 1d");
    assert_eq!(at("nonsense"), "unknown time");
}

#[test]
fn wrapped_line_count_matches_the_layout_arithmetic() {
    assert_eq!(wrapped_line_count("", 10), 1);
    assert_eq!(wrapped_line_count("abcdefghijk", 10), 2);
    assert_eq!(wrapped_line_count("ab\n\ncd", 10), 3);
}

#[test]
fn banner_has_two_rows_and_a_plural() {
    assert_eq!(working_changes_banner_rows(0), 0);
    assert_eq!(
        working_changes_banner_lines(1, 42),
        ["1 file change in working directory", "View Changes"]
    );
    assert_eq!(
        working_changes_banner_lines(5, 42)[0],
        "5 file changes in working directory"
    );
}
