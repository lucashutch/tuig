//! Command line handling for tuig. Ports `src/cli.ts`, `src/update.ts`, `src/open-url.ts` and the
//! start-up logic in `src/index.ts`.
//!
//! Differences from the TypeScript code:
//! - The release request runs through `curl` (see [`CurlFetcher`]) with a 30 second limit. The
//!   TypeScript code uses `fetch` with no limit.
//! - [`open_url`] uses `open` on macOS. The TypeScript code only knows `xdg-open`.
//! - `tuig update` still installs through `bun install -g`, as in the TypeScript app.

pub mod args;
pub mod error;
pub mod open_url;
pub mod start;
pub mod update;

pub use args::{CliAction, HELP, VERSION, parse_args, version_line};
pub use error::{CliError, report_error};
pub use open_url::{open_url, open_url_with};
pub use start::{
    HasRoot, StartRepositories, StartRequest, load_saved_session, open_start_repositories,
    resolve_start_repositories,
};
pub use update::{
    CurlFetcher, HttpResponse, ReleaseFetcher, UpdateStatus, check_for_update,
    install_source_for_tag, is_current_release, latest_release_tag, update_tuig,
};
