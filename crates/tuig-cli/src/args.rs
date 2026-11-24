use crate::error::CliError;
use std::path::{Path, PathBuf};

/// The Tuig version, from `[workspace.package]` in the root `Cargo.toml`.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliAction {
    Run {
        path: PathBuf,
        clean: bool,
        path_provided: bool,
    },
    Help,
    Version,
    Update,
}

/// Help text. The TypeScript app prints it with `console.log`, so it ends with a blank line:
/// print it with `println!`.
pub const HELP: &str = "Usage: tuig [options] [path]
       tuig update

Open Git repositories in the terminal UI.

Without a path, Tuig restores the repositories from the last session. It
opens the current directory only when no saved repository is available.
With a path, Tuig adds that repository to the restored session.

Options:
  -h, --help       Show this help
  -v, --version    Show the installed version
  -C, --directory  Open a repository at this path
  --clean           Open only the requested repository, not the saved session

Commands:
  update           Install the latest Tuig release from Git
";

pub fn version_line(version: &str) -> String {
    format!("tuig {version}")
}

fn usage(message: impl Into<String>) -> CliError {
    CliError::Usage(message.into())
}

/// Parse the arguments after the program name. Walks left to right like the TypeScript code, so
/// the first of `--help`, `--version` or `update` that it reaches decides the result.
///
/// An empty string counts as "no path" in the duplicate checks, but still sets `path_provided`.
pub fn parse_args(args: &[String], cwd: &Path) -> Result<CliAction, CliError> {
    let mut path: Option<String> = None;
    let mut clean = false;
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        index += 1;
        match arg {
            "-h" | "--help" => return Ok(CliAction::Help),
            "-v" | "--version" => return Ok(CliAction::Version),
            "--clean" => clean = true,
            "update" => {
                if args.len() != 1 {
                    return Err(usage("update does not accept options or a path"));
                }
                return Ok(CliAction::Update);
            }
            "-C" | "--directory" => {
                let directory = args.get(index).filter(|d| !d.is_empty());
                index += 1;
                let Some(directory) = directory else {
                    return Err(usage(format!("{arg} requires a path")));
                };
                if path.as_deref().is_some_and(|p| !p.is_empty()) {
                    return Err(usage("a repository path was already provided"));
                }
                path = Some(directory.clone());
            }
            _ if arg.starts_with('-') => return Err(usage(format!("unknown option: {arg}"))),
            _ => {
                if path.as_deref().is_some_and(|p| !p.is_empty()) {
                    return Err(usage("only one repository path may be provided"));
                }
                path = Some(arg.to_string());
            }
        }
    }
    Ok(CliAction::Run {
        path_provided: path.is_some(),
        path: path.map_or_else(|| cwd.to_path_buf(), PathBuf::from),
        clean,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<CliAction, String> {
        let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
        parse_args(&args, Path::new("/cwd")).map_err(|e| e.to_string())
    }

    fn run(path: &str, clean: bool, path_provided: bool) -> CliAction {
        CliAction::Run {
            path: path.into(),
            clean,
            path_provided,
        }
    }

    #[test]
    fn defaults_to_the_current_directory_without_marking_a_path() {
        assert_eq!(parse(&[]), Ok(run("/cwd", false, false)));
        assert_eq!(parse(&["--clean"]), Ok(run("/cwd", true, false)));
    }

    #[test]
    fn accepts_a_positional_or_flagged_path_in_any_order() {
        assert_eq!(parse(&["/r"]), Ok(run("/r", false, true)));
        assert_eq!(parse(&["--clean", "-C", "/r"]), Ok(run("/r", true, true)));
        assert_eq!(parse(&["/r", "--clean"]), Ok(run("/r", true, true)));
        assert_eq!(parse(&["--directory", "/r"]), Ok(run("/r", false, true)));
    }

    #[test]
    fn rejects_a_second_path_and_unknown_options() {
        assert_eq!(
            parse(&["/a", "/b"]),
            Err("only one repository path may be provided".into())
        );
        assert_eq!(
            parse(&["-C", "/a", "-C", "/b"]),
            Err("a repository path was already provided".into())
        );
        assert_eq!(parse(&["-x"]), Err("unknown option: -x".into()));
        assert_eq!(parse(&["-"]), Err("unknown option: -".into()));
        assert_eq!(parse(&["-C"]), Err("-C requires a path".into()));
        assert_eq!(
            parse(&["--directory", ""]),
            Err("--directory requires a path".into())
        );
    }

    #[test]
    fn the_first_terminal_flag_wins() {
        assert_eq!(parse(&["/r", "--help", "-x"]), Ok(CliAction::Help));
        assert_eq!(parse(&["-v", "-h"]), Ok(CliAction::Version));
        // A path taken by -C is data, not a flag.
        assert_eq!(parse(&["-C", "--help"]), Ok(run("--help", false, true)));
        assert_eq!(parse(&["-x", "--help"]), Err("unknown option: -x".into()));
    }

    #[test]
    fn update_must_be_the_only_argument() {
        assert_eq!(parse(&["update"]), Ok(CliAction::Update));
        for args in [
            &["update", "--help"][..],
            &["--clean", "update"],
            &["/r", "update"],
        ] {
            assert_eq!(
                parse(args),
                Err("update does not accept options or a path".into())
            );
        }
        // After -C, "update" is the path.
        assert_eq!(parse(&["-C", "update"]), Ok(run("update", false, true)));
    }

    #[test]
    fn an_empty_path_counts_as_provided_but_does_not_block_a_second_one() {
        assert_eq!(parse(&[""]), Ok(run("", false, true)));
        assert_eq!(parse(&["", "/r"]), Ok(run("/r", false, true)));
    }
}
