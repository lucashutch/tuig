use crate::error::CliError;
use std::process::{Command, Stdio};

/// The scheme of `url` in lowercase, or `None` when it has no valid scheme.
fn scheme(url: &str) -> Option<String> {
    // The WHATWG parser that `new URL` uses strips leading and trailing C0 controls and spaces.
    let url = url.trim_matches(|c: char| c <= ' ');
    let (scheme, _) = url.split_once(':')?;
    let mut chars = scheme.chars();
    let valid = chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));
    valid.then(|| scheme.to_ascii_lowercase())
}

/// The command that opens a URL in the desktop's default browser.
fn opener() -> &'static str {
    if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "windows") {
        "explorer"
    } else {
        "xdg-open"
    }
}

/// Open a web URL in the default browser. Only http and https URLs are accepted.
///
/// The opener runs in its own process group, without a shell, with no stdio. It cannot write
/// into the terminal that tuig draws on. Returns once the opener starts.
pub async fn open_url(url: &str) -> Result<(), CliError> {
    open_url_with(opener(), url).await
}

/// [`open_url`] with a chosen program.
pub async fn open_url_with(program: &str, url: &str) -> Result<(), CliError> {
    match scheme(url).as_deref() {
        None => return Err(CliError::Other(format!("Not a valid URL: {url}"))),
        Some("http" | "https") => {}
        Some(_) => return Err(CliError::Other(format!("Not a web URL: {url}"))),
    }
    let mut command = Command::new(program);
    command
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    // Dropping the child does not kill it.
    command
        .spawn()
        .map(drop)
        .map_err(|error| CliError::Other(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn accepts_only_web_urls_before_starting_anything() {
        // The program does not exist, so only the URL check can produce these messages.
        let program = "tuig-no-such-opener";
        for (url, message) in [
            ("not a url", "Not a valid URL: not a url"),
            ("file:///etc/passwd", "Not a web URL: file:///etc/passwd"),
            ("mailto:a@b.c", "Not a web URL: mailto:a@b.c"),
            ("javascript:alert(1)", "Not a web URL: javascript:alert(1)"),
        ] {
            let error = open_url_with(program, url).await.unwrap_err();
            assert_eq!(error.to_string(), message);
        }
        // A web URL passes the check and fails only when the opener is missing.
        let error = open_url_with(program, "HTTPS://example.com/x")
            .await
            .unwrap_err();
        assert!(!error.to_string().starts_with("Not a"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn starts_the_opener_with_the_url() {
        assert!(open_url_with("true", "https://example.com").await.is_ok());
    }
}
