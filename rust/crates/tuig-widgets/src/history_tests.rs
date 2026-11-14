//! The painted history list compared cell by cell with the TypeScript app's parity golden.

use super::*;
use opentui::testing::TestApp;
use std::collections::HashMap;
use std::rc::Rc;
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
    list.set_data(demo());
    list.set_focused(true);
    // The app opens with the first commit selected, below the working row.
    list.select(1);
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

#[test]
fn wheel_scrolls_rows_and_click_selects_the_row_under_the_pointer() {
    let mut list = HistoryList::new(one_dark_theme());
    list.set_data(demo());
    let app = TestApp::new(WIDTH, 6);
    let widget = Custom::new(&app, list).width(u32::from(WIDTH)).height(6);
    app.root().add(&widget);
    let clicked = Rc::new(Cell::new(None));
    let seen = clicked.clone();
    widget.update(|list| list.on_select(move |_cx, row| seen.set(Some(row))));
    app.render();
    // Five body lines under the header, eleven rows in all.
    for _ in 0..3 {
        app.scroll(10, 3, true);
    }
    let viewport = widget.with(HistoryList::viewport);
    assert_eq!(
        (viewport.start, viewport.selected),
        (3, 0),
        "the wheel moves rows, not the selection"
    );
    let screen = app.render();
    assert!(screen.row(1).contains("refactor: rename"), "{screen}");
    // Line 2 shows row 4, which is commit 3 because the working row is row 0.
    app.click(40, 2);
    assert_eq!(clicked.get(), Some(4));
    assert_eq!(widget.with(HistoryList::selected_commit), Some(3));
    assert_eq!(
        widget.with(HistoryList::viewport).start,
        3,
        "a click does not scroll"
    );
}

#[test]
fn columns_after_a_wide_subject_stay_aligned() {
    let mut data = demo();
    data.working_files = 0;
    data.commits[0].subject = "日本語 👨\u{200d}👩\u{200d}👧 family".to_string();
    let mut list = HistoryList::new(one_dark_theme());
    list.set_data(data);
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

#[test]
fn the_selected_commit_stays_selected_when_the_working_row_changes() {
    let mut list = HistoryList::new(one_dark_theme());
    list.set_data(demo());
    list.select(4);
    assert_eq!(list.selected_commit(), Some(3));
    let mut data = demo();
    data.working_files = 0;
    list.set_data(data);
    assert_eq!(list.selected_commit(), Some(3));
    assert_eq!(list.viewport().selected, 3);
    list.set_data(demo());
    assert_eq!(list.selected_commit(), Some(3));
    assert_eq!(list.viewport().selected, 4);
}
