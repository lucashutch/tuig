//! Git layer for tuig: process runner, parsers, patch building, and domain types.
//!
//! This crate ports `src/git/` from the TypeScript implementation. Behavior
//! matches the TypeScript code unless a module documents a difference.

pub mod commit_walk;
pub mod debug_log;
pub mod hunks;
pub mod parsers;
pub mod process;
pub mod pull_request_types;
pub mod pull_requests;
pub mod remote_errors;
pub mod repository;
pub mod repository_browser;
pub mod repository_watcher;
pub mod types;
pub mod undo;

#[cfg(test)]
pub(crate) mod test_util;
