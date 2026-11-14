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
    let (problem, guidance) = split_error(error);
    eprintln!("tuig: {problem}");
    if let Some(guidance) = guidance {
        println!("{guidance}");
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
