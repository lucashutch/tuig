//! tuig: a terminal Git UI on OpenTUI.
//!
//! Usage: `tuig [options] [path]` and `tuig update`. Argument parsing, the update command and the start-up
//! repositories come from the `tuig-cli` crate.

mod avatars;
mod keys;
mod refresh;
mod screens;
mod selected_file;
mod services;
mod shell;
mod sync;
mod tasks;

use opentui::prelude::*;
use screens::header::TabsInit;
use std::sync::Arc;
use tuig_cli::{
    CliAction, CliError, CurlFetcher, HELP, StartRequest, VERSION, open_start_repositories,
    parse_args, report_error, update_tuig, version_line,
};
use tuig_git::repository::{GitRepository, GitRepositoryService};
use tuig_ui_model::preferences::{layout_preferences_path, load_layout_preferences};
use tuig_ui_model::session_preferences::session_preferences_path;

/// Runs `tuig update` on a plain tokio runtime, because it must not start the terminal UI.
fn update() -> Result<(), CliError> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| CliError::Other(error.to_string()))?;
    runtime.block_on(update_tuig(VERSION, &CurlFetcher))
}

/// The position of the repository to show first: the one named by the path argument or the saved session, else the
/// first that opened.
fn active_position(repositories: &[GitRepositoryService], active: Option<&str>) -> usize {
    active
        .and_then(|root| repositories.iter().position(|repo| repo.root() == root))
        .unwrap_or(0)
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
    let at = active_position(&start.repositories, start.active_repository.as_deref());
    let repositories: Vec<Arc<dyn GitRepository>> = start
        .repositories
        .into_iter()
        .map(|repo| Arc::new(repo) as Arc<dyn GitRepository>)
        .collect();
    let repo = repositories
        .get(at)
        .cloned()
        .expect("a successful start opens at least one repository");
    let services = services::Services::system(
        repo.root(),
        &load_layout_preferences(&layout_preferences_path()),
    );
    let shell = shell::Shell::start_with(&app, repo, services);
    shell.borrow_mut().restore_tabs(TabsInit {
        repositories,
        submodules: start.submodules.unwrap_or_default().into_iter().collect(),
        recent: start.recent_repositories,
        session_path: Some(session_preferences_path()),
    });
    let _shell = shell;
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
