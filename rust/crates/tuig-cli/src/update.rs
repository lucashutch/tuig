use crate::error::CliError;
use async_trait::async_trait;
use std::process::Stdio;
use tokio::process::Command;

const REPOSITORY: &str = "lucashutch/tuig";
const LATEST_URL: &str = "https://api.github.com/repos/lucashutch/tuig/releases/latest";

pub struct HttpResponse {
    pub status: u16,
    pub body: String,
}

/// Sends the GET request for the latest release. Tests replace it.
#[async_trait]
pub trait ReleaseFetcher: Send + Sync {
    async fn get(&self, url: &str, accept: &str) -> Result<HttpResponse, CliError>;
}

/// Fetches through the `curl` program. It follows redirects and gives up after 30 seconds.
pub struct CurlFetcher;

#[async_trait]
impl ReleaseFetcher for CurlFetcher {
    async fn get(&self, url: &str, accept: &str) -> Result<HttpResponse, CliError> {
        let output = Command::new("curl")
            .args(["--silent", "--show-error", "--location", "--max-time", "30"])
            .args(["--header", &format!("Accept: {accept}")])
            .args(["--write-out", "\n%{http_code}", url])
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output()
            .await
            .map_err(|error| CliError::Other(format!("could not run curl: {error}")))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(CliError::Other(format!(
                "request failed: {}",
                stderr.trim()
            )));
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let (body, status) = text.rsplit_once('\n').unwrap_or(("", &text));
        let status = status.trim().parse().unwrap_or(0);
        Ok(HttpResponse {
            status,
            body: body.to_string(),
        })
    }
}

/// The argument for `bun install -g`. It names the dependency so Bun replaces its Git resolution.
pub fn install_source_for_tag(tag: &str) -> String {
    format!("tuig@git+https://github.com/{REPOSITORY}.git#{tag}")
}

pub fn is_current_release(version: &str, tag: &str) -> bool {
    tag.strip_prefix('v').unwrap_or(tag) == version.strip_prefix('v').unwrap_or(version)
}

/// The tag of the latest GitHub release.
pub async fn latest_release_tag(fetcher: &dyn ReleaseFetcher) -> Result<String, CliError> {
    let response = fetcher
        .get(LATEST_URL, "application/vnd.github+json")
        .await?;
    if !(200..300).contains(&response.status) {
        return Err(CliError::Other(format!(
            "GitHub could not find the latest release (HTTP {})",
            response.status
        )));
    }
    let release: serde_json::Value =
        serde_json::from_str(&response.body).map_err(|error| CliError::Other(error.to_string()))?;
    match release.get("tag_name").and_then(|tag| tag.as_str()) {
        Some(tag) if !tag.is_empty() => Ok(tag.to_string()),
        _ => Err(CliError::Other(
            "GitHub returned a release without a tag".into(),
        )),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateStatus {
    UpToDate,
    Available { tag: String },
}

/// Compare the running version with the latest release. Every call sends a request. The
/// TypeScript app has no cache or background check, only the `tuig update` command.
pub async fn check_for_update(
    current_version: &str,
    fetcher: &dyn ReleaseFetcher,
) -> Result<UpdateStatus, CliError> {
    let tag = latest_release_tag(fetcher).await?;
    Ok(if is_current_release(current_version, &tag) {
        UpdateStatus::UpToDate
    } else {
        UpdateStatus::Available { tag }
    })
}

/// The `tuig update` command. Prints progress to stdout like the TypeScript app.
pub async fn update_tuig(
    current_version: &str,
    fetcher: &dyn ReleaseFetcher,
) -> Result<(), CliError> {
    println!("Checking for updates...");
    let tag = match check_for_update(current_version, fetcher).await? {
        UpdateStatus::UpToDate => {
            println!("Tuig is up to date.");
            return Ok(());
        }
        UpdateStatus::Available { tag } => tag,
    };
    println!("Update found ({tag}). Upgrading...");
    let output = Command::new("bun")
        .args(["install", "-g", &install_source_for_tag(&tag)])
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|error| CliError::Other(format!("Bun could not start: {error}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let details = if stderr.trim().is_empty() {
            stdout.trim()
        } else {
            stderr.trim()
        };
        let code = output
            .status
            .code()
            .map_or("signal".to_string(), |c| c.to_string());
        let tail = if details.is_empty() {
            ".".to_string()
        } else {
            format!(":\n{details}")
        };
        return Err(CliError::Other(format!(
            "Bun could not install tuig {tag} (exit {code}){tail}"
        )));
    }
    println!("Tuig {tag} is ready.");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct Fake {
        status: u16,
        body: &'static str,
        requests: Mutex<Vec<(String, String)>>,
    }

    impl Fake {
        fn new(status: u16, body: &'static str) -> Self {
            Self {
                status,
                body,
                requests: Mutex::new(Vec::new()),
            }
        }
    }

    #[async_trait]
    impl ReleaseFetcher for Fake {
        async fn get(&self, url: &str, accept: &str) -> Result<HttpResponse, CliError> {
            self.requests
                .lock()
                .unwrap()
                .push((url.into(), accept.into()));
            Ok(HttpResponse {
                status: self.status,
                body: self.body.into(),
            })
        }
    }

    #[test]
    fn compares_versions_ignoring_a_leading_v() {
        assert!(is_current_release("0.1.21", "v0.1.21"));
        assert!(is_current_release("v0.1.21", "0.1.21"));
        assert!(!is_current_release("0.1.21", "v0.1.22"));
        assert_eq!(
            install_source_for_tag("v0.1.22"),
            "tuig@git+https://github.com/lucashutch/tuig.git#v0.1.22"
        );
    }

    #[tokio::test]
    async fn asks_the_github_latest_release_endpoint() {
        let fetcher = Fake::new(200, r#"{"tag_name":"v0.2.0"}"#);
        assert_eq!(
            check_for_update("0.1.21", &fetcher).await.unwrap(),
            UpdateStatus::Available {
                tag: "v0.2.0".into()
            }
        );
        assert_eq!(
            fetcher.requests.lock().unwrap()[0],
            (
                "https://api.github.com/repos/lucashutch/tuig/releases/latest".to_string(),
                "application/vnd.github+json".to_string()
            )
        );
        let fetcher = Fake::new(200, r#"{"tag_name":"v0.1.21"}"#);
        assert_eq!(
            check_for_update("0.1.21", &fetcher).await.unwrap(),
            UpdateStatus::UpToDate
        );
    }

    #[tokio::test]
    async fn reports_http_failures_and_releases_without_a_tag() {
        let error = latest_release_tag(&Fake::new(404, "{}")).await.unwrap_err();
        assert_eq!(
            error.to_string(),
            "GitHub could not find the latest release (HTTP 404)"
        );
        for body in ["{}", r#"{"tag_name":""}"#, r#"{"tag_name":3}"#] {
            let error = latest_release_tag(&Fake::new(200, body)).await.unwrap_err();
            assert_eq!(error.to_string(), "GitHub returned a release without a tag");
        }
    }
}
