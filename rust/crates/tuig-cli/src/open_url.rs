use crate::error::CliError;
use std::process::{Command, Stdio};

/// Strip leading and trailing C0 controls and spaces, as the WHATWG parser behind `new URL` does.
fn trim_url(url: &str) -> &str {
    url.trim_matches(|c: char| c <= ' ')
}

/// The scheme of a trimmed `url` in lowercase, or `None` when it has no valid scheme.
fn scheme(url: &str) -> Option<String> {
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
    let url = trim_url(url);
    let invalid = || CliError::Other(format!("Not a valid URL: {url}"));
    let scheme = scheme(url).ok_or_else(invalid)?;
    if url.chars().any(|c| c.is_ascii_control()) {
        return Err(invalid());
    }
    if matches!(scheme.as_str(), "http" | "https") {
        // A web URL needs a host: `new URL` rejects "http:" and "http://".
        let after = url[scheme.len() + 1..].trim_start_matches(['/', '\\']);
        let host = after
            .split(['/', '\\', '?', '#'])
            .next()
            .unwrap_or_default();
        let host = host.rsplit_once('@').map_or(host, |(_, host)| host);
        if host.is_empty() || host.starts_with(':') {
            return Err(invalid());
        }
    } else {
        return Err(CliError::Other(format!("Not a web URL: {url}")));
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
            ("http:", "Not a valid URL: http:"),
            ("http://", "Not a valid URL: http://"),
            ("http://:80/", "Not a valid URL: http://:80/"),
            ("http://a.com/\nx", "Not a valid URL: http://a.com/\nx"),
            (
                "http://a.com/\x1b[0m",
                "Not a valid URL: http://a.com/\x1b[0m",
            ),
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

    #[tokio::test]
    async fn trims_the_url_before_checking() {
        let error = open_url_with("tuig-no-such-opener", "  https://example.com \n")
            .await
            .unwrap_err();
        assert!(!error.to_string().starts_with("Not a"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn passes_the_trimmed_url_to_the_opener() {
        let dir = std::env::temp_dir().join(format!("tuig-open-url-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("arg");
        let script = dir.join("opener.sh");
        // Write the script from a separate process. A file this process holds open for writing leaks into any
        // child that another test thread forks meanwhile, and running the script then fails with "Text file busy".
        let status = std::process::Command::new("sh")
            .arg("-c")
            .arg(r#"printf '#!/bin/sh\nprintf %%s "$1" > "%s"\n' "$2" > "$1" && chmod 755 "$1""#)
            .arg("sh")
            .arg(&script)
            .arg(&out)
            .status()
            .unwrap();
        assert!(status.success());
        open_url_with(script.to_str().unwrap(), " https://example.com/a ")
            .await
            .unwrap();
        for _ in 0..100 {
            if out.exists() && std::fs::metadata(&out).unwrap().len() > 0 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert_eq!(
            std::fs::read_to_string(&out).unwrap(),
            "https://example.com/a"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn starts_the_opener_with_the_url() {
        assert!(open_url_with("true", "https://example.com").await.is_ok());
    }
}
