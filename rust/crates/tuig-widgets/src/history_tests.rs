//! The painted history list compared cell by cell with the TypeScript app's parity golden.

use super::*;
use crate::branch_hints::BranchHintIndex;
use crate::decorations::{LAPTOP_BRANCH_ICON, RefIndex, resolve_head_sha};
use crate::pull_requests::pull_request_commit_index;
use opentui::testing::TestApp;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use tuig_git::pull_request_types::PullRequestState;
use tuig_ui_model::theme::one_dark_theme;

/// `tools/parity/golden/initial-load/loaded.snap`, recorded from the TypeScript app on the `demo` fixture.
const GOLDEN: &str = include_str!("../../../../tools/parity/golden/initial-load/loaded.snap");
/// Where the history pane's content sits in the golden screen.
const LEFT: usize = 30;
const TOP: usize = 3;
const WIDTH: u16 = 84;
const HEIGHT: u16 = 44;

struct Golden {
    text: Vec<Vec<char>>,
    styles: Vec<Vec<(Rgba, Rgba)>>,
}

fn golden() -> Golden {
    let lines: Vec<&str> = GOLDEN.lines().collect();
    let section = |name: &str| lines.iter().position(|line| *line == name).expect(name) + 1;
    let (text_at, styles_at, grid_at) = (section("[text]"), section("[styles]"), section("[grid]"));
    let mut palette = HashMap::new();
    for line in &lines[styles_at..grid_at - 2] {
        let parts: Vec<&str> = line.split(' ').collect();
        let hex = |part: &str, key: &str| Rgba::parse(&format!("#{}", &part[key.len()..])).unwrap();
        palette.insert(
            parts[0].chars().next().unwrap(),
            (hex(parts[1], "fg="), hex(parts[2], "bg=")),
        );
    }
    let rows = |at: usize| lines[at..at + 48].iter();
    Golden {
        text: rows(text_at).map(|line| line.chars().collect()).collect(),
        styles: rows(grid_at)
            .map(|line| {
                line.chars()
                    .filter(|c| *c != '|')
                    .map(|c| palette[&c])
                    .collect()
            })
            .collect(),
    }
}

fn commit(sha: &str, parents: &[&str], decorations: &[&str], subject: &str) -> Commit {
    Commit {
        sha: sha.to_string(),
        parents: parents.iter().map(|p| p.to_string()).collect(),
        committer: "Ada Tester".to_string(),
        subject: subject.to_string(),
        decorations: decorations.iter().map(|d| d.to_string()).collect(),
        ..Commit::default()
    }
}

fn branch(name: &str, sha: &str, current: bool) -> BranchRef {
    BranchRef {
        name: name.to_string(),
        full_name: format!("refs/heads/{name}"),
        sha: sha.to_string(),
        current,
        remote: false,
        upstream: None,
        tracking: None,
    }
}

/// What the shell holds for one history: commits, refs and the working-tree file count.
struct HistoryData {
    commits: Vec<Commit>,
    branches: Vec<BranchRef>,
    working_files: usize,
    commits_complete: bool,
}

/// The window the shell would build for `lines` body lines from display row `start`.
fn window(data: &HistoryData, start: usize, lines: usize) -> Rc<HistoryWindow> {
    window_with(data, start, lines, None)
}

fn window_with(
    data: &HistoryData,
    start: usize,
    lines: usize,
    pull_requests: Option<&PullRequestCommitIndex>,
) -> Rc<HistoryWindow> {
    window_comparing(data, start, lines, pull_requests, None)
}

fn window_comparing(
    data: &HistoryData,
    start: usize,
    lines: usize,
    pull_requests: Option<&PullRequestCommitIndex>,
    comparison_start: Option<&str>,
) -> Rc<HistoryWindow> {
    let theme = one_dark_theme();
    let colors: Vec<String> = theme.graph.iter().map(|color| color.to_hex()).collect();
    let head = resolve_head_sha(&data.branches, &data.commits);
    let working_parent = head.as_deref().filter(|_| data.working_files > 0);
    let mut index = GraphIndex::new(working_parent, &colors);
    index
        .extend(&data.commits, &colors, head.as_deref())
        .unwrap();
    let refs = RefIndex::new(&data.branches);
    let mut hints = BranchHintIndex::default();
    hints.extend(&data.commits, &data.branches);
    let source = HistorySource {
        commits: &data.commits,
        branches: &data.branches,
        refs: &refs,
        hints: &hints,
        colors: &colors,
        working_files: data.working_files,
        commits_complete: data.commits_complete,
        pull_requests,
        comparison_start,
    };
    Rc::new(history_window(&mut index, &source, start, lines))
}

/// The `demo` fixture from `tools/parity/parity/fixtures.py`, as `git log` reports it.
fn demo() -> HistoryData {
    let (s2d6, s352, s1c1, s988, sb01, sbb4, s27e, s223, s34d, s51b) = (
        "2d6de2094080d928c32deb928beebd641128f39f",
        "3522bedb49f8166bfc7aae47496f3363232bb2fe",
        "1c131e9c8db3330f6a72e34534b176e2bff14afb",
        "988a3fa770e98cc55272fceef9e24fda1a2bbb3d",
        "b0168a570bc7902526aa4c766f8e1f79474a1bd5",
        "bb48f3e70c8fcee0835c607dc10681a8f3a38b8c",
        "27e4e3f5fcfacf42bd238aeb7806ebbd64e6f60e",
        "223ceb6d869503433d0aea91b25eca064bb5eb9f",
        "34d2f7d2d15eabdca2b3a2d36666e47da50e7fa1",
        "51bd7f1b751431ecf2cc169165e07b1186930fcc",
    );
    HistoryData {
        commits: vec![
            commit(
                s2d6,
                &[s352],
                &["HEAD -> main"],
                "docs: describe installation",
            ),
            commit(
                s352,
                &[s1c1, sbb4],
                &["tag: v1.0", "release/1.0"],
                "merge: fix/typo into main",
            ),
            commit(s1c1, &[s988], &[], "refactor: rename old_name to new_name"),
            commit(s988, &[sb01, s27e], &[], "merge: feature/login into main"),
            commit(sb01, &[s34d], &[], "feat: add clamp helper"),
            commit(
                sbb4,
                &[s34d],
                &["fix/typo"],
                "docs: link the guide from the readme",
            ),
            commit(
                s27e,
                &[s223],
                &["feature/login"],
                "feat: normalise user names",
            ),
            commit(s223, &[s34d], &[], "feat: add login"),
            commit(s34d, &[s51b], &["tag: v0.1"], "docs: add guide"),
            commit(s51b, &[], &[], "chore: initial commit"),
        ],
        branches: vec![
            branch("feature/login", s27e, false),
            branch("fix/typo", sbb4, false),
            branch("main", s2d6, true),
            branch("release/1.0", s352, false),
        ],
        working_files: 5,
        commits_complete: true,
    }
}

fn paint(list: HistoryList) -> (TestApp, Custom<HistoryList>) {
    let app = TestApp::new(WIDTH, HEIGHT);
    let widget = Custom::new(&app, list)
        .width(u32::from(WIDTH))
        .height(u32::from(HEIGHT));
    app.root().add(&widget);
    (app, widget)
}

fn rgba(color: Color) -> Rgba {
    Rgba::new(color.r, color.g, color.b, color.a)
}

#[test]
fn painted_cells_match_the_typescript_golden() {
    let mut list = HistoryList::new(one_dark_theme());
    list.set_window(window(&demo(), 0, usize::from(HEIGHT) - 1));
    list.set_focused(true);
    // The app opens with the first commit selected, below the working row.
    list.set_selected(Some(1));
    let (app, _widget) = paint(list);
    let capture = app.render();
    let golden = golden();
    let mut differences = Vec::new();
    for y in 0..usize::from(HEIGHT) {
        for x in 0..usize::from(WIDTH) {
            let cell = capture.cell(x as u32, y as u32).unwrap();
            let expected = golden.text[TOP + y][LEFT + x];
            let (fg, bg) = golden.styles[TOP + y][LEFT + x];
            let symbol = cell.symbol.chars().next().unwrap_or(' ');
            if symbol != expected {
                differences.push(format!("({x},{y}) text {symbol:?}, expected {expected:?}"));
            } else if rgba(cell.bg) != bg {
                differences.push(format!(
                    "({x},{y}) {symbol:?} bg {:?}, expected {:?}",
                    rgba(cell.bg).to_hex(),
                    bg.to_hex()
                ));
            } else if expected != ' ' && rgba(cell.fg) != fg {
                differences.push(format!(
                    "({x},{y}) {symbol:?} fg {:?}, expected {:?}",
                    rgba(cell.fg).to_hex(),
                    fg.to_hex()
                ));
            }
        }
    }
    assert!(
        differences.is_empty(),
        "{} cells differ:\n{}\n\n{}",
        differences.len(),
        differences
            .iter()
            .take(40)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n"),
        capture.text()
    );
}

/// The screen row of the commit with `subject` in a list painted from display row 0.
fn row_of(data: &HistoryData, subject: &str) -> usize {
    let commit = data
        .commits
        .iter()
        .position(|commit| commit.subject == subject)
        .unwrap();
    // The header is line 0 and the working row is the first body line.
    commit + 2
}

#[test]
fn the_comparison_start_shows_a_marker_that_replaces_the_head_and_selection_markers() {
    let data = demo();
    let head = row_of(&data, "docs: describe installation");
    let start = row_of(&data, "feat: add login");
    let sha = data
        .commits
        .iter()
        .find(|commit| commit.subject == "feat: add login")
        .unwrap()
        .sha
        .clone();
    let paint_with = |selected: usize, comparison: Option<&str>| {
        let mut list = HistoryList::new(one_dark_theme());
        list.set_window(window_comparing(
            &data,
            0,
            usize::from(HEIGHT) - 1,
            None,
            comparison,
        ));
        list.set_selected(Some(selected - 1));
        let (app, _widget) = paint(list);
        app.render()
    };
    let marked = paint_with(head, Some(&sha));
    assert!(
        marked.row(start as u32).contains("A "),
        "{}",
        marked.row(start as u32)
    );
    let marker_rows: Vec<u32> = (0..u32::from(HEIGHT))
        .filter(|&row| marked.row(row).contains("  A "))
        .collect();
    assert_eq!(marker_rows, [start as u32], "{marked}");
    assert!(marked.row(head as u32).contains('›') || marked.row(head as u32).contains('▶'));

    // The selection arrow gives way to the marker on the same row.
    let selected = paint_with(start, Some(&sha));
    assert!(
        !selected.row(start as u32).contains('›'),
        "{}",
        selected.row(start as u32)
    );
    assert!(selected.row(start as u32).contains("A "));

    // Without a comparison start the row shows no marker.
    assert!(!paint_with(head, None).text().contains("A ●"));
}

#[test]
fn only_the_selected_row_shows_its_branch_hint() {
    let data = demo();
    let paint_selected = |subject: &str| {
        let mut list = HistoryList::new(one_dark_theme());
        list.set_window(window(&data, 0, usize::from(HEIGHT) - 1));
        list.set_selected(Some(row_of(&data, subject) - 1));
        let (app, _widget) = paint(list);
        app.render()
    };
    let hint = format!("↳ {LAPTOP_BRANCH_ICON} feature/login");
    let row = row_of(&data, "feat: add login");

    let selected = paint_selected("feat: add login");
    assert!(
        selected.row(row as u32).contains(&hint),
        "{}",
        selected.row(row as u32)
    );
    let elsewhere = paint_selected("docs: add guide");
    assert!(
        !elsewhere.text().contains("↳"),
        "an unselected row shows no hint:\n{elsewhere}"
    );
}

#[test]
fn a_press_on_a_row_with_only_a_hint_counts_as_a_press_on_its_label() {
    let data = demo();
    let mut list = HistoryList::new(one_dark_theme());
    list.set_window(window(&data, 0, usize::from(HEIGHT) - 1));
    let (app, widget) = paint(list);
    let events = Rc::new(RefCell::new(Vec::new()));
    let seen = events.clone();
    widget.update(|list| {
        // Every release comes through as an event. These tests look at the presses.
        list.on_event(move |_cx, event| {
            if event != HistoryEvent::Release {
                seen.borrow_mut().push(event)
            }
        })
    });
    app.render();
    let line = row_of(&data, "feat: add login") as u16;
    for kind in [
        MouseEventKind::Down(MouseButton::Right),
        MouseEventKind::Up(MouseButton::Right),
    ] {
        app.mouse(kind, 5, line);
    }
    assert!(matches!(
        events.borrow().as_slice(),
        [HistoryEvent::Menu { on_label: true, .. }]
    ));
}

#[test]
fn mouse_input_becomes_events_for_the_shell() {
    let mut list = HistoryList::new(one_dark_theme());
    // Five body lines under the header from row 3, eleven rows in all.
    list.set_window(window(&demo(), 3, 5));
    let app = TestApp::new(WIDTH, 6);
    let widget = Custom::new(&app, list).width(u32::from(WIDTH)).height(6);
    app.root().add(&widget);
    let events = Rc::new(RefCell::new(Vec::new()));
    let seen = events.clone();
    widget.update(|list| {
        // Every release comes through as an event. These tests look at the presses.
        list.on_event(move |_cx, event| {
            if event != HistoryEvent::Release {
                seen.borrow_mut().push(event)
            }
        })
    });
    let screen = app.render();
    assert!(screen.row(1).contains("refactor: rename"), "{screen}");

    app.scroll(10, 3, true);
    app.scroll(10, 3, false);
    // Line 2 shows row 4, which is commit 3 because the working row is row 0.
    app.click(40, 2);
    app.click(40, 2);
    app.click(40, 0);
    assert_eq!(
        *events.borrow(),
        [
            HistoryEvent::Wheel(1),
            HistoryEvent::Wheel(-1),
            HistoryEvent::Click {
                row: 4,
                column: 40,
                part: ClickPart::Row,
                clicks: 1
            },
            HistoryEvent::Click {
                row: 4,
                column: 40,
                part: ClickPart::Row,
                clicks: 2
            },
            // The header is not a row. It reports its own press.
            HistoryEvent::HeaderPress {
                button: MouseButton::Left,
                column: 40,
                x: 40,
                y: 0
            },
        ],
        "the header is not a row"
    );
    assert_eq!(
        widget.with(|list| list.window().start),
        3,
        "the widget does not scroll by itself"
    );
}

#[test]
fn a_press_on_the_scrollbar_column_starts_a_scrollbar_drag_only_when_rows_overflow() {
    let data = demo();
    // Eleven rows in five lines: the scrollbar has a thumb.
    let mut list = HistoryList::new(one_dark_theme());
    list.set_window(window(&data, 0, 5));
    let app = TestApp::new(WIDTH, 6);
    let widget = Custom::new(&app, list).width(u32::from(WIDTH)).height(6);
    app.root().add(&widget);
    let events = Rc::new(RefCell::new(Vec::new()));
    let seen = events.clone();
    widget.update(|list| list.on_event(move |_cx, event| seen.borrow_mut().push(event)));
    app.render();
    let last = WIDTH - 1;
    app.click(last, 2);
    // A press on the scrollbar column of a header line is a header press.
    app.click(last, 0);
    assert_eq!(
        *events.borrow(),
        [
            HistoryEvent::ScrollbarPress { line: 2 },
            HistoryEvent::Release,
            HistoryEvent::HeaderPress {
                button: MouseButton::Left,
                column: i32::from(last),
                x: last,
                y: 0
            },
            HistoryEvent::Release,
        ]
    );

    // With every row on screen there is no thumb, so the press selects the row.
    let mut list = HistoryList::new(one_dark_theme());
    list.set_window(window(&data, 0, usize::from(HEIGHT) - 1));
    let (app, widget) = paint(list);
    let events = Rc::new(RefCell::new(Vec::new()));
    let seen = events.clone();
    widget.update(|list| list.on_event(move |_cx, event| seen.borrow_mut().push(event)));
    app.render();
    app.click(WIDTH - 1, 2);
    assert!(
        matches!(events.borrow()[0], HistoryEvent::Click { .. }),
        "{:?}",
        events.borrow()
    );
}

#[test]
fn a_press_names_the_label_or_sha_it_hit_and_only_a_matching_second_press_doubles() {
    let data = demo();
    let mut list = HistoryList::new(one_dark_theme());
    list.set_window(window(&data, 0, usize::from(HEIGHT) - 1));
    let (app, widget) = paint(list);
    let events = Rc::new(RefCell::new(Vec::new()));
    let seen = events.clone();
    widget.update(|list| {
        // Every release comes through as an event. These tests look at the presses.
        list.on_event(move |_cx, event| {
            if event != HistoryEvent::Release {
                seen.borrow_mut().push(event)
            }
        })
    });
    let screen = app.render();
    let tip = data
        .commits
        .iter()
        .position(|commit| {
            commit
                .decorations
                .iter()
                .any(|label| label.contains("main"))
        })
        .unwrap();
    let line = (tip + 2) as u16;
    let sha = &data.commits[tip].sha[..8];
    let text = screen.row(u32::from(line));
    // `find` counts bytes, and the row holds graph and icon glyphs.
    let sha_x = text[..text.find(sha).unwrap()].chars().count() as u16;
    let label_x = 3;
    let message_x = 40;

    // Label twice: a double click. SHA twice: two single presses. Label then message: not a double click.
    for x in [label_x, label_x, sha_x, sha_x, label_x, message_x] {
        app.click(x, line);
    }
    let seen: Vec<(ClickPart, u8)> = events
        .borrow()
        .iter()
        .map(|event| match event {
            HistoryEvent::Click { part, clicks, .. } => (*part, *clicks),
            other => panic!("{other:?}"),
        })
        .collect();
    assert_eq!(
        seen,
        [
            (ClickPart::Label, 1),
            (ClickPart::Label, 2),
            (ClickPart::Sha, 1),
            (ClickPart::Sha, 1),
            (ClickPart::Label, 1),
            (ClickPart::Row, 1),
        ]
    );
}

#[test]
fn columns_after_a_wide_subject_stay_aligned() {
    let mut data = demo();
    data.working_files = 0;
    data.commits[0].subject = "日本語 👨\u{200d}👩\u{200d}👧 family".to_string();
    let mut list = HistoryList::new(one_dark_theme());
    list.set_window(window(&data, 0, usize::from(HEIGHT) - 1));
    let (app, _widget) = paint(list);
    let capture = app.render();
    let committer_x = |y: u32| {
        (0..u32::from(WIDTH) - 1)
            .find(|&x| {
                capture.cell(x, y).is_some_and(|cell| cell.symbol == "A")
                    && capture
                        .cell(x + 1, y)
                        .is_some_and(|cell| cell.symbol == "d")
            })
            .unwrap_or_else(|| panic!("no committer on line {y}\n{}", capture.text()))
    };
    // Line 1 holds the wide subject and line 2 a plain one.
    assert_eq!(committer_x(1), committer_x(2), "{}", capture.text());
}

fn pull_request(number: u64, branch: &str, checks: CheckRollup) -> PullRequest {
    PullRequest {
        number,
        title: String::new(),
        url: String::new(),
        state: PullRequestState::Open,
        checks,
        author: String::new(),
        head_branch: branch.to_string(),
        head_sha: None,
        from_fork: false,
        mine: false,
        review_requested: false,
        updated_at: String::new(),
    }
}

#[test]
fn the_pr_column_shows_matches_beside_their_branch_commits_and_keeps_columns_aligned() {
    let data = demo();
    let list = [
        pull_request(42, "feature/login", CheckRollup::Failed),
        pull_request(7, "fix/typo", CheckRollup::Running),
    ];
    let index = pull_request_commit_index(&list, &data.branches);
    let mut painted = HistoryList::new(one_dark_theme());
    painted.set_window(window_with(&data, 0, usize::from(HEIGHT) - 1, Some(&index)));
    painted.set_spinner_frame(3);
    let (app, _widget) = paint(painted);
    let screen = app.render();
    let text = screen.text();
    let lines: Vec<&str> = text.lines().collect();
    assert!(lines[0].contains("│ PR "), "{text}");
    let login = lines.iter().find(|l| l.contains("feat: normal")).unwrap();
    assert!(login.contains("#42 ✗"), "{login}");
    let typo = lines.iter().find(|l| l.contains("docs: link")).unwrap();
    assert!(typo.contains("#7 ⠸"), "the spinner frame is drawn: {typo}");
    // The SHA column starts at the same cell with or without a pull request.
    let sha_at = |commit: &Commit| {
        let line = lines.iter().find(|l| l.contains(&commit.sha[..8])).unwrap();
        let byte = line.find(&commit.sha[..8]).unwrap();
        line[..byte].chars().count()
    };
    let by_subject = |subject: &str| {
        data.commits
            .iter()
            .find(|c| c.subject.contains(subject))
            .unwrap()
    };
    assert_eq!(
        sha_at(by_subject("normalise")),
        sha_at(by_subject("add login"))
    );
}

#[test]
fn the_pr_number_is_a_hyperlink_to_the_pull_request_and_nothing_around_it_is() {
    let data = demo();
    let mut open = pull_request(42, "feature/login", CheckRollup::Failed);
    open.url = "https://example.invalid/pull/42".into();
    let index = pull_request_commit_index(&[open], &data.branches);
    let paint_with_links = |linked: bool| {
        let app = TestApp::with_hyperlinks(WIDTH, HEIGHT);
        let mut list = HistoryList::new(one_dark_theme());
        if linked {
            list.set_link_context(
                app.app().session().context().clone(),
                app.app().width_method(),
            );
        }
        list.set_window(window_with(&data, 0, usize::from(HEIGHT) - 1, Some(&index)));
        let widget = Custom::new(&app, list)
            .width(u32::from(WIDTH))
            .height(u32::from(HEIGHT));
        app.root().add(&widget);
        // `render` checks the terminal output against the cell buffer, so a link that corrupts it fails here.
        let text = app.render().text();
        (app, widget, text)
    };
    let (app, _widget, text) = paint_with_links(true);
    let (line, row) = text
        .lines()
        .enumerate()
        .find(|(_, line)| line.contains("#42"))
        .map(|(row, line)| (line.to_owned(), row as i32))
        .unwrap();
    let column = line[..line.find("#42").unwrap()].chars().count() as i32;
    let session = app.app().session();
    let url_at = |x: i32| {
        session
            .link_id(x, row)
            .unwrap()
            .map(|id| session.context().link_url(id).unwrap())
    };
    for offset in 0..3 {
        assert_eq!(
            url_at(column + offset).as_deref(),
            Some("https://example.invalid/pull/42"),
            "column {offset} of `#42` in {line}"
        );
    }
    assert_eq!(url_at(column - 1), None, "the gap before the number");
    assert_eq!(
        url_at(column + 3),
        None,
        "the checks icon is not part of the link"
    );

    // Without a link context the same row paints as plain text.
    let (plain, _widget, plain_text) = paint_with_links(false);
    assert_eq!(plain_text, text);
    assert_eq!(plain.app().session().link_id(column, row).unwrap(), None);
}

#[test]
fn running_checks_count_only_on_visible_rows() {
    let data = demo();
    let list = [pull_request(7, "feature/login", CheckRollup::Running)];
    let index = pull_request_commit_index(&list, &data.branches);
    // The feature/login commit is commit 6: display row 7 with the working row.
    let near = window_with(&data, 0, 9, Some(&index));
    assert!(near.running_checks_visible(9));
    assert!(!near.running_checks_visible(6), "row 7 is below six lines");
    assert!(
        !window(&data, 0, 9).running_checks_visible(9),
        "no data, no spinner"
    );
}

#[test]
fn avatar_slots_follow_the_graph_dot_and_skip_hidden_lanes() {
    let data = demo();
    let mut list = HistoryList::new(one_dark_theme());
    list.set_window(window(&data, 0, 9));
    list.set_selected(Some(1));
    let slots = list.avatar_slots(u32::from(WIDTH), 10);
    // Line 0 is the working row. Commit rows follow, one slot per line.
    assert_eq!(slots[0].line, 1);
    assert_eq!(
        slots[0].top, 2,
        "row 0 is the header and line 0 is the working row"
    );
    assert_eq!(slots[0].sha, data.commits[0].sha);
    // The dot sits two cells after the branch column. The image is three cells wide and centred on it.
    let columns = visible_history_columns(list.columns, false);
    let geometry = history_column_layout(i64::from(WIDTH), list.window().graph_columns, columns);
    assert_eq!(slots[0].left, geometry.branch_width + 1);
    assert!(
        slots[0].continues_above,
        "HEAD continues up to the working row"
    );
    assert!(slots[0].continues_below);
    assert!(slots.iter().all(|slot| slot.top == slot.line as i64 + 1));
    let selected = slots
        .iter()
        .find(|slot| slot.sha == data.commits[0].sha)
        .unwrap();
    let other = slots
        .iter()
        .find(|slot| slot.sha == data.commits[1].sha)
        .unwrap();
    assert_ne!(
        selected.background, other.background,
        "the selected row has its own background"
    );

    list.set_graph_scroll(1);
    let scrolled = list.avatar_slots(u32::from(WIDTH), 10);
    assert!(scrolled.iter().all(|slot| slot.left >= 0));
}
