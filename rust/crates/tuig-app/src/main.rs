//! tuig: a terminal Git UI on OpenTUI.
//!
//! Usage: `tuig [PATH]`. Opens the repository at `PATH`, or at the current directory. Full argument parsing lives
//! in the `tuig-cli` crate; this file only reads one optional path so it is easy to replace.

mod keys;
mod refresh;
mod screens;
mod shell;
mod sync;
mod tasks;

use opentui::prelude::*;
use std::path::PathBuf;
use std::sync::Arc;
use tuig_git::repository::GitRepositoryService;

/// The repository path: the first argument that does not start with `-`, else the current directory. The parity
/// harness passes `--clean`, which this ignores.
// TODO: replace this with the `tuig-cli` crate, which parses the flags.
fn repository_path() -> std::io::Result<PathBuf> {
    match std::env::args().skip(1).find(|arg| !arg.starts_with('-')) {
        Some(path) => Ok(path.into()),
        None => std::env::current_dir(),
    }
}

fn main() -> opentui::Result<()> {
    let path = repository_path()?;
    let app = App::new(AppOptions::default())?;
    let repo = match app.runtime().block_on(GitRepositoryService::open(&path)) {
        Ok(repo) => repo,
        Err(error) => {
            drop(app);
            eprintln!("tuig: cannot open {}: {error}", path.display());
            std::process::exit(1);
        }
    };
    let _shell = shell::Shell::start(&app, Arc::new(repo));
    app.run()
}
