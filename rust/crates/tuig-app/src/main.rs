//! tuig: a terminal Git UI on OpenTUI.
//!
//! Usage: `tuig [options] [path]` and `tuig update`. Argument parsing, the update command and the start-up
//! repositories come from the `tuig-cli` crate.

mod keys;
mod refresh;
mod screens;
mod selected;
mod selected_file;
mod shell;
mod sync;
mod tasks;

use opentui::prelude::*;
use std::sync::Arc;
use tuig_cli::{
    CliAction, CliError, CurlFetcher, HELP, StartRequest, VERSION, open_start_repositories,
    parse_args, report_error, update_tuig, version_line,
};
use tuig_git::repository::{GitRepository, GitRepositoryService};

/// Runs `tuig update` on a plain tokio runtime, because it must not start the terminal UI.
fn update() -> Result<(), CliError> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| CliError::Other(error.to_string()))?;
    runtime.block_on(update_tuig(VERSION, &CurlFetcher))
}

/// The repository to show. Tabs are not built, so this opens the active repository only: the one named by
/// the path argument or the saved session, else the first that opened. The other saved repositories are dropped.
// TODO: pass every repository to the shell when repository tabs exist.
fn active_repository(
    repositories: Vec<GitRepositoryService>,
    active: Option<&str>,
) -> Option<GitRepositoryService> {
    let at = active
        .and_then(|root| repositories.iter().position(|repo| repo.root() == root))
        .unwrap_or(0);
    repositories.into_iter().nth(at)
}

fn run(request: &StartRequest) -> Result<(), CliError> {
    let app =
        App::new(AppOptions::default()).map_err(|error| CliError::Other(error.to_string()))?;
    let start = match app.runtime().block_on(open_start_repositories(request)) {
        Ok(start) => start,
        Err(error) => {
            // Restore the terminal before the error text.
            drop(app);
            return Err(error);
        }
    };
    let repo = active_repository(start.repositories, start.active_repository.as_deref())
        .expect("a successful start opens at least one repository");
    let _shell = shell::Shell::start(&app, Arc::new(repo));
    app.run()
        .map_err(|error| CliError::Other(error.to_string()))
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = std::env::current_dir()
        .map_err(|error| CliError::Other(error.to_string()))
        .and_then(|cwd| parse_args(&args, &cwd))
        .and_then(|action| match action {
            CliAction::Help => {
                println!("{HELP}");
                Ok(())
            }
            CliAction::Version => {
                println!("{}", version_line(VERSION));
                Ok(())
            }
            CliAction::Update => update(),
            CliAction::Run {
                path,
                clean,
                path_provided,
            } => run(&StartRequest {
                path,
                clean,
                path_provided,
            }),
        });
    if let Err(error) = result {
        std::process::exit(report_error(&error));
    }
}
