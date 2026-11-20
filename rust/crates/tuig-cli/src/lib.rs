//! Command line handling for tuig. Ports `src/cli.ts`, `src/update.ts`, `src/open-url.ts` and the
//! start-up logic in `src/index.ts`.
//!
//! Differences from the TypeScript code:
//! - The release request runs through `curl` (see [`CurlFetcher`]) with a 30 second limit. The
//!   TypeScript code uses `fetch` with no limit.
//! - [`open_url`] uses `open` on macOS. The TypeScript code only knows `xdg-open`.
//! - `tuig update` downloads the release package, checks its SHA-256 sum and replaces the running
//!   executable. The TypeScript app runs `bun install -g`.

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
    CurlFetcher, HttpResponse, ReleaseFetcher, UpdateStatus, check_for_update, current_platform,
    install_release, is_current_release, latest_release_tag, package_stem, package_url,
    update_tuig, update_tuig_at,
};
