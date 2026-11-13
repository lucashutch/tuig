//! No-terminal checks of the spike, using `opentui::testing::TestApp` (manual clock, real worker threads).

use crate::mapping::{Kind, Side};
use crate::ui;
use opentui::native::Capture;
use opentui::prelude::*;
use opentui::testing::TestApp;
use opentui::widget::{Diff, DiffView, Select, SelectOption, Widget};
use std::cell::RefCell;
use std::path::Path;
use std::rc::Rc;
use std::time::{Duration, Instant};
use tuig_git::repository::GitRepositoryService;

const WAIT: Duration = Duration::from_secs(20);

fn open(app: &App, path: &Path) -> GitRepositoryService {
    app.runtime()
        .block_on(GitRepositoryService::open(path))
        .expect("open repository")
}

fn this_repo() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

/// The screen cell of the first character of `needle`.
fn find(capture: &Capture, needle: &str) -> (u16, u16) {
    for y in 0..capture.height {
        let row = capture.row(y);
        if let Some(byte) = row.find(needle) {
            return (row[..byte].chars().count() as u16, y as u16);
        }
    }
    panic!("{needle:?} not on screen:\n{capture}");
}

const PATCH: &str = "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,3 @@\n alpha\n-bravo\n+BRAVO2\n charlie\n";

fn long_patch() -> String {
    let mut text = String::from("--- a/f.txt\n+++ b/f.txt\n@@ -1,80 +1,81 @@\n");
    for n in 1..=40 {
        text.push_str(&format!(" context line {n}\n"));
    }
    text.push_str("+inserted line\n");
    for n in 41..=80 {
        text.push_str(&format!(" context line {n}\n"));
    }
    text
}

#[test]
fn git_results_reach_widgets_from_worker_threads() {
    let app = TestApp::new(140, 40);
    let service = open(&app, &this_repo());
    let ui = ui::build(&app, service, ui::Options { rows: 0 });
    assert!(
        app.wait_until(WAIT, || ui.history.option_count() > 0),
        "snapshot never arrived"
    );
    assert!(
        ui.state.commit_count() > 100,
        "the worktree has more than 100 commits"
    );
    // Moving the selection starts a debounced diff load on the runtime.
    ui.history.perform(opentui::widget::SelectAction::MoveDown);
    app.advance(Duration::from_millis(100));
    assert!(
        app.wait_until(WAIT, || !ui.diff.diff().is_empty()),
        "diff never arrived"
    );
    let screen = app.render();
    assert!(screen.text().contains("History"));
    assert!(ui.diff.diff().contains("@@"));
    // History page: scrolling to the end pulls the next page through commit_page.
    let before = ui.history.option_count();
    ui.history.perform(opentui::widget::SelectAction::Last);
    assert!(
        app.wait_until(WAIT, || ui.history.option_count() > before
            || ui.state.commit_count() >= before),
        "no page"
    );
}

#[test]
fn completions_run_on_the_ui_thread_and_futures_on_workers() {
    let app = TestApp::new(20, 3);
    let ui_thread = std::thread::current().id();
    let seen = Rc::new(RefCell::new(None));
    let sink = seen.clone();
    app.spawn(
        async { std::thread::current().name().map(str::to_owned) },
        move |_cx, worker| {
            *sink.borrow_mut() = Some((worker, std::thread::current().id()));
        },
    );
    assert!(app.wait_until(WAIT, || seen.borrow().is_some()));
    let (worker, completion_thread) = seen.borrow().clone().unwrap();
    assert_eq!(worker.as_deref(), Some("opentui-task"));
    assert_eq!(completion_thread, ui_thread);
}

#[test]
fn proxy_wakes_a_blocked_loop_immediately() {
    // Real-time headless loop: no timers, nothing dirty after the first frame, so the loop blocks in poll. A
    // thread posts after 300 ms. If the loop polled on a 16 ms frame timer the latency would be up to 16 ms; with a
    // wake pipe it is the thread-hop time.
    let app = App::headless(opentui::app::HeadlessOptions::default()).unwrap();
    let proxy = app.proxy();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        let sent = Instant::now();
        proxy
            .post(move |cx| {
                tx.send(sent.elapsed()).unwrap();
                cx.quit();
            })
            .unwrap();
    });
    app.run().unwrap();
    let latency = rx.recv().unwrap();
    println!("proxy wake latency: {latency:?}");
    assert!(latency < Duration::from_millis(10), "{latency:?}");
}

#[test]
fn click_maps_to_file_lines_unified_and_split() {
    let app = TestApp::new(140, 40);
    let service = open(&app, &this_repo());
    let ui = ui::build(&app, service, ui::Options { rows: 0 });
    ui.diff.set_diff(PATCH);
    assert_eq!(ui.diff.hunk_lines(), vec![0]);
    // Two hunks: the widget's per-hunk row offsets must match the ones the mapping derives from the patch.
    let two_hunks = format!("{PATCH}@@ -20,2 +20,3 @@\n x\n+y\n z\n\\ No newline at end of file\n");
    ui.diff.set_diff(two_hunks.clone());
    assert_eq!(
        ui.diff.hunk_lines(),
        crate::mapping::unified_hunk_rows(&two_hunks)
    );
    assert_eq!(ui.diff.hunk_lines(), vec![0, 4]);
    ui.diff.set_diff(PATCH);
    let target_at = |app: &TestApp, needle: &str| {
        let screen = app.render();
        let (x, y) = find(&screen, needle);
        app.click(x, y);
        ui.state.last_click.borrow().expect("a click target")
    };
    let added = target_at(&app, "BRAVO2");
    assert_eq!(
        (added.kind, added.side, added.line, added.raw_row),
        (Kind::Added, Side::New, 2, 6)
    );
    let removed = target_at(&app, "bravo");
    assert_eq!(
        (removed.kind, removed.side, removed.line, removed.raw_row),
        (Kind::Removed, Side::Old, 2, 5)
    );
    let context = target_at(&app, "charlie");
    assert_eq!(
        (context.kind, context.line, context.old_line),
        (Kind::Context, 3, Some(3))
    );

    // Split view: both sides on one row.
    ui.history.focus();
    app.press("u");
    let right = target_at(&app, "BRAVO2");
    assert_eq!(
        (right.kind, right.side, right.line),
        (Kind::Added, Side::New, 2)
    );
    let left = target_at(&app, "bravo");
    assert_eq!(
        (left.kind, left.side, left.line),
        (Kind::Removed, Side::Old, 2)
    );
    let screen = app.render();
    println!("{screen}");
}

#[test]
fn click_mapping_follows_scrolling() {
    let app = TestApp::new(140, 30);
    let service = open(&app, &this_repo());
    let ui = ui::build(&app, service, ui::Options { rows: 0 });
    ui.diff.set_diff(long_patch());
    let screen = app.render();
    let (x, y) = find(&screen, "context line 3");
    for _ in 0..30 {
        app.scroll(x, y, true);
    }
    let screen = app.render();
    let (x, y) = find(&screen, "context line 45");
    app.click(x, y);
    let target = ui.state.last_click.borrow().expect("target");
    // Line 41 of the old file is "inserted line"'s successor: new line numbers are shifted by one after it.
    assert_eq!(
        (target.kind, target.line, target.old_line),
        (Kind::Context, 46, Some(45))
    );
}

#[test]
fn drag_selects_diff_text_and_reports_it() {
    let app = TestApp::new(140, 40);
    let service = open(&app, &this_repo());
    let ui = ui::build(&app, service, ui::Options { rows: 0 });
    ui.diff.set_diff(PATCH);
    let copied = Rc::new(RefCell::new(String::new()));
    let sink = copied.clone();
    app.on_selection(move |_cx, text| *sink.borrow_mut() = text.to_owned());
    let screen = app.render();
    let (x0, y0) = find(&screen, "alpha");
    let (x1, y1) = find(&screen, "charlie");
    app.drag((x0, y0), (x1 + 7, y1));
    let selected = copied.borrow().clone();
    assert!(
        selected.contains("alpha") && selected.contains("BRAVO2") && selected.contains("charlie"),
        "{selected:?}"
    );
    // The gutter (line numbers and signs) is not part of the text.
    assert!(!selected.contains('+'), "{selected:?}");
    assert_eq!(app.selected_text().as_deref(), Some(selected.as_str()));
}

#[test]
fn input_and_textarea_take_text_without_triggering_app_shortcuts() {
    let app = TestApp::new(140, 40);
    let service = open(&app, &this_repo());
    let ui = ui::build(&app, service, ui::Options { rows: 0 });
    assert!(app.wait_until(WAIT, || ui.history.option_count() > 0));
    let all = ui.history.option_count();
    app.press("/");
    app.type_text("quit and fix");
    assert_eq!(ui.filter.value(), "quit and fix");
    assert!(!app.is_quitting(), "typing q in an Input must not quit");
    assert!(ui.history.option_count() <= all);
    app.press("escape");
    app.press("c");
    app.type_text("Subject line");
    app.press("enter");
    app.press("enter");
    app.type_text("Body, with a q and a u.");
    assert_eq!(
        ui.composer.text(),
        "Subject line\n\nBody, with a q and a u."
    );
    assert!(!app.is_quitting());
    app.press("ctrl+s");
    assert!(
        ui.status
            .text()
            .starts_with("composer submit: 37 bytes, 3 lines"),
        "{}",
        ui.status.text()
    );
    app.press("tab");
    app.press("escape");
    ui.history.focus();
    app.press("q");
    assert!(app.is_quitting());
}

#[test]
fn select_with_5000_rows_scrolls_by_wheel_and_keys() {
    let app = TestApp::new(100, 40);
    let list = Select::new(&app).grow(1.0);
    list.options(
        (0..5000).map(|n| {
            SelectOption::new(format!("{n:04} commit subject {n}"), format!("author {n}"))
        }),
    );
    app.root().add(&list);
    list.focus();
    app.render();
    let started = Instant::now();
    let mut frames = 0;
    for _ in 0..500 {
        app.scroll(10, 10, true);
        app.render();
        frames += 1;
    }
    assert_eq!(list.selected(), 500);
    for _ in 0..500 {
        app.press("down");
        app.render();
        frames += 1;
    }
    assert_eq!(list.selected(), 1000);
    list.perform(opentui::widget::SelectAction::Last);
    assert!(app.render().text().contains("4999 commit subject 4999"));
    println!(
        "Select 5000 rows: {:?} per frame over {frames} frames",
        started.elapsed() / frames
    );
}

#[test]
fn scrollbox_with_5000_rows_scrolls() {
    let app = TestApp::new(100, 40);
    let scroll = opentui::widget::ScrollBox::new(&app).grow(1.0);
    let started = Instant::now();
    for n in 0..5000 {
        scroll.add(&Text::new(&app, format!("{n:04} commit subject {n}")).height(1));
    }
    println!("ScrollBox: built 5000 Text rows in {:?}", started.elapsed());
    app.root().add(&scroll);
    app.render();
    let started = Instant::now();
    for _ in 0..500 {
        app.scroll(10, 10, true);
        app.render();
    }
    println!(
        "ScrollBox 5000 rows: {:?} per wheel frame",
        started.elapsed() / 500
    );
    assert!(scroll.scroll_position().1 > 0.0);
    scroll.scroll_to_bottom();
    assert!(app.render().text().contains("4999 commit subject 4999"));
}

/// Distinct foreground colors on the row that shows `needle`, with a filetype and without one.
fn colors_on_row(filetype: Option<&str>, source: &str, needle: &str) -> (usize, usize) {
    let count = |filetype: Option<&str>| {
        let app = TestApp::new(100, 10);
        let diff = Diff::new(&app)
            .grow(1.0)
            .view(DiffView::Unified)
            .filetype(filetype);
        app.root().add(&diff);
        let mut patch = format!("@@ -0,0 +1,{} @@\n", source.lines().count());
        for line in source.lines() {
            patch.push('+');
            patch.push_str(line);
            patch.push('\n');
        }
        diff.set_diff(patch);
        app.render();
        // Appended text highlights on a worker; replaced text on the UI thread before the frame.
        app.advance(Duration::from_millis(50));
        let screen = app.render();
        let (x, y) = find(&screen, needle);
        let mut colors = std::collections::HashSet::new();
        for dx in 0..60 {
            if let Some(cell) = screen
                .cell(u32::from(x) + dx, u32::from(y))
                .filter(|cell| !cell.symbol.trim().is_empty())
            {
                colors.insert(format!("{:?}", cell.fg));
            }
        }
        colors.len()
    };
    (count(filetype), count(None))
}

#[test]
fn grammars_highlight_every_filetype_the_typescript_app_loads() {
    crate::grammars::register_all();
    // (filetype, a file name that resolves to it, source, text on the line to inspect)
    let samples: &[(&str, &str, &str, &str)] = &[
        (
            "rust",
            "a.rs",
            "fn main() { let x = \"s\"; } // c",
            "fn main",
        ),
        (
            "typescript",
            "a.ts",
            "export const x: number = 1; // c",
            "export const",
        ),
        (
            "typescriptreact",
            "a.tsx",
            "const v = <Box title=\"x\" />; // c",
            "const v",
        ),
        (
            "javascript",
            "a.js",
            "function f() { return 'a'; } // c",
            "function f",
        ),
        (
            "javascriptreact",
            "a.jsx",
            "const v = <Box title=\"x\" />; // c",
            "const v",
        ),
        ("python", "a.py", "def f(x):  # c", "def f"),
        ("go", "a.go", "func main() { return } // c", "func main"),
        ("html", "a.html", "<div class=\"a\">hi</div>", "<div class"),
        ("css", "a.css", "a { color: red; } /* c */", "a { color"),
        ("json", "a.json", "{\"a\": 1, \"b\": true}", "{\"a\""),
        (
            "bash",
            "a.sh",
            "if [ -f x ]; then echo \"hi\"; fi # c",
            "if [ -f",
        ),
        ("c", "a.c", "int main(void) { return 0; } // c", "int main"),
        (
            "cpp",
            "a.cpp",
            "class A { public: int x; }; // c",
            "class A",
        ),
    ];
    let mut report = Vec::new();
    for &(filetype, path, source, needle) in samples {
        let resolved = opentui::syntax::filetype_for_path(path);
        let has = opentui::syntax::has_grammar(filetype);
        let (highlighted, plain) = colors_on_row(Some(filetype), source, needle);
        report.push(format!(
            "{filetype:16} path->{:?} grammar={has} colors highlighted={highlighted} plain={plain}",
            resolved
        ));
        assert!(has, "{filetype}: no grammar");
        assert!(
            highlighted > plain,
            "{filetype}: highlighting changed no colors"
        );
    }
    println!("{}", report.join("\n"));
}

/// Real repository with a long history: `SPIKE_BIG_REPO=/path cargo test -p tuig-spike -- --ignored --nocapture`.
#[test]
#[ignore = "needs SPIKE_BIG_REPO, a repository with more than 5000 commits"]
fn history_pages_to_5000_rows_in_a_real_repository() {
    let path = std::env::var("SPIKE_BIG_REPO").expect("SPIKE_BIG_REPO");
    let app = TestApp::new(140, 45);
    let service = open(&app, Path::new(&path));
    let started = Instant::now();
    let ui = ui::build(&app, service, ui::Options { rows: 5000 });
    assert!(
        app.wait_until(Duration::from_secs(60), || ui.history.option_count()
            >= 5000)
    );
    println!(
        "5000 rows loaded through commit_page in {:?}",
        started.elapsed()
    );
    let started = Instant::now();
    for _ in 0..300 {
        app.scroll(10, 12, true);
        app.render();
    }
    println!("wheel frame with real rows: {:?}", started.elapsed() / 300);
    assert_eq!(ui.history.selected(), 300);
}

#[test]
fn split_drag_stays_in_one_column() {
    let app = TestApp::new(140, 40);
    let service = open(&app, &this_repo());
    let ui = ui::build(&app, service, ui::Options { rows: 0 });
    ui.diff.set_diff(PATCH);
    app.press("u");
    let copied = Rc::new(RefCell::new(String::new()));
    let sink = copied.clone();
    app.on_selection(move |_cx, text| *sink.borrow_mut() = text.to_owned());
    let screen = app.render();
    let (x0, y0) = find(&screen, "alpha");
    let (_, y1) = find(&screen, "charlie");
    app.drag((x0, y0), (x0 + 10, y1));
    let selected = copied.borrow().clone();
    assert!(
        selected.contains("alpha") && selected.contains("bravo") && selected.contains("charlie"),
        "{selected:?}"
    );
    assert!(
        !selected.contains("BRAVO2"),
        "the right column must stay out of a left-column drag: {selected:?}"
    );
}

/// `Diff` exposes no per-row highlight (the TypeScript `setSelectedRows`), and its `LineNumbers` is private. A diff
/// built from the public `Code` and `LineNumbers` can color rows, which is what a copy of `Diff` would use.
#[test]
fn rows_can_be_highlighted_with_public_line_numbers() {
    use opentui::widget::{Code, LineColor, LineNumbers};
    let app = TestApp::new(40, 6);
    let code = Code::new(&app).grow(1.0);
    code.set_code("one\ntwo\nthree");
    let numbers = LineNumbers::new(&app, &code).grow(1.0);
    app.root().add(&numbers);
    let selected = Color::hex(0x224488);
    numbers.line_color(1, LineColor::new(selected, selected));
    let screen = app.render();
    let (x, y) = find(&screen, "two");
    assert_eq!(
        screen.cell(u32::from(x), u32::from(y)).unwrap().bg,
        selected
    );
    let (x, y) = find(&screen, "one");
    assert_ne!(
        screen.cell(u32::from(x), u32::from(y)).unwrap().bg,
        selected
    );
}
