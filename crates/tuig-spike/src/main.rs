//! Throwaway spike: tuig's history list, diff pane, filter, and commit composer on the OpenTUI Rust crate.
//!
//! Run: `cargo run -p tuig-spike --release -- [--repo PATH] [--rows N]`. The history list from tuig-widgets runs in
//! the `tuig-app` crate.
//! Keys: j/k and the wheel move the history, Tab changes focus, u toggles unified and split, [ and ] jump between
//! hunks, / focuses the filter, c focuses the composer, Escape returns to the list, q quits. Drag in the diff to
//! select text. Click a diff line to see its file line in the status bar.

mod grammars;
mod mapping;
mod ui;

use opentui::prelude::*;
use tuig_git::repository::GitRepositoryService;

fn main() -> opentui::Result<()> {
    let mut repo = std::env::current_dir()?;
    let mut rows = 200;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--repo" => repo = args.next().expect("--repo needs a path").into(),
            "--rows" => {
                rows = args
                    .next()
                    .and_then(|n| n.parse().ok())
                    .expect("--rows needs a number")
            }
            other => panic!("unknown argument {other}"),
        }
    }
    grammars::register_all();
    let app = App::new(AppOptions::default())?;
    // Open the repository on the app's runtime: tuig-git is async.
    let service = app
        .runtime()
        .block_on(GitRepositoryService::open(&repo))
        .unwrap_or_else(|error| panic!("open {}: {error}", repo.display()));
    let _ui = ui::build(&app, service, ui::Options { rows });
    app.run()
}

#[cfg(test)]
mod tests;
