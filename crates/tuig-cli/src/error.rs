use tuig_git::process::GitError;

#[derive(Debug, thiserror::Error)]
pub enum CliError {
    /// A bad command line, for example an unknown option.
    #[error("{0}")]
    Usage(String),
    #[error(transparent)]
    Git(#[from] GitError),
    #[error("{0}")]
    Other(String),
}

/// Print an error the way `src/index.ts` does and return the exit code (always 1).
///
/// A "not a repository" error prints its first line to stderr as `tuig: <problem>` and the
/// guidance lines to stdout.
pub fn report_error(error: &CliError) -> i32 {
    write_error(error, &mut std::io::stdout(), &mut std::io::stderr())
}

/// [`report_error`] with chosen writers. Write failures are ignored, as `println!` would panic
/// on them and nothing else can report them.
pub(crate) fn write_error(
    error: &CliError,
    stdout: &mut dyn std::io::Write,
    stderr: &mut dyn std::io::Write,
) -> i32 {
    let (problem, guidance) = split_error(error);
    let _ = writeln!(stderr, "tuig: {problem}");
    if let Some(guidance) = guidance {
        let _ = writeln!(stdout, "{guidance}");
    }
    1
}

/// The stderr line and the optional stdout guidance for an error.
pub(crate) fn split_error(error: &CliError) -> (String, Option<String>) {
    if let CliError::Git(GitError::NotRepository(inner)) = error {
        let text = inner.to_string();
        let mut lines = text.split('\n');
        let problem = lines.next().unwrap_or_default().to_string();
        let guidance: Vec<&str> = lines.collect();
        let guidance = (!guidance.is_empty()).then(|| guidance.join("\n"));
        return (problem, guidance);
    }
    (error.to_string(), None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tuig_git::process::{NotGitRepositoryError, NotRepositoryProblem};

    fn report(error: &CliError) -> (i32, String, String) {
        let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
        let code = write_error(error, &mut stdout, &mut stderr);
        (
            code,
            String::from_utf8(stdout).unwrap(),
            String::from_utf8(stderr).unwrap(),
        )
    }

    #[test]
    fn not_a_repository_puts_the_problem_on_stderr_and_guidance_on_stdout() {
        let inner = NotGitRepositoryError::new(
            "/tmp/x",
            vec!["/tmp/x/repo".into()],
            NotRepositoryProblem::NotRepository,
        );
        let (code, stdout, stderr) = report(&CliError::Git(GitError::NotRepository(inner)));
        assert_eq!(code, 1);
        assert_eq!(stderr, "tuig: No Git repository found at \"/tmp/x\".\n");
        assert_eq!(stdout, "\nRepositories found nearby:\n  tuig /tmp/x/repo\n");
    }

    #[test]
    fn usage_errors_go_to_stderr_only() {
        let (code, stdout, stderr) = report(&CliError::Usage("unknown option: -x".into()));
        assert_eq!(code, 1);
        assert_eq!(stderr, "tuig: unknown option: -x\n");
        assert_eq!(stdout, "");
    }
}
