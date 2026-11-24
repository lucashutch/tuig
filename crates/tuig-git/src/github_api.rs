//! In-process GitHub API access. It replaces a `gh` process per request: a `gh` start costs about 0.12 s of CPU,
//! which dwarfs the work of a keep-alive HTTPS request.
//!
//! The token comes from the environment or from one `gh auth token` per host and session. Callers fall back to
//! `gh` when [`GithubApi`] reports [`ApiReply::NoToken`], so a setup that only `gh` understands keeps working.
//!
//! Environment tokens apply only to the hosts they belong to: `GH_TOKEN` and `GITHUB_TOKEN` to `github.com`,
//! `GH_ENTERPRISE_TOKEN` and `GITHUB_ENTERPRISE_TOKEN` to any other host. Tuig never sends a `github.com` token to
//! another host.

use std::collections::HashMap;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::Duration;

use crate::pull_requests::GH_NON_INTERACTIVE_ENV;

pub const GITHUB_HOST: &str = "github.com";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// A GitHub repository on one host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoRef {
    pub host: String,
    pub owner: String,
    pub name: String,
}

/// The GraphQL endpoint of a host. GitHub Enterprise Server serves it under `/api`.
pub fn graphql_url(host: &str) -> String {
    if host == GITHUB_HOST {
        "https://api.github.com/graphql".to_string()
    } else {
        format!("https://{host}/api/graphql")
    }
}

/// The REST API root of a host, without a trailing slash.
pub fn rest_url(host: &str) -> String {
    if host == GITHUB_HOST {
        "https://api.github.com".to_string()
    } else {
        format!("https://{host}/api/v3")
    }
}

/// Splits a Git remote URL into host, owner and repository. It reads the scp form (`git@host:o/r.git`) and
/// `https://`, `http://`, `ssh://` and `git://` URLs. A URL with a port or extra path segments gives `None`, and the
/// caller falls back to `gh`.
pub fn parse_remote(remote: &str) -> Option<RepoRef> {
    let remote = remote.trim();
    let (authority, path) = if let Some((_, rest)) = remote.split_once("://") {
        rest.split_once('/')?
    } else {
        let (authority, path) = remote.split_once(':')?;
        if authority.contains('/') {
            return None;
        }
        (authority, path)
    };
    let host = authority.rsplit('@').next()?.to_lowercase();
    if host.is_empty() || host.contains(':') {
        return None;
    }
    let mut parts = path.trim_matches('/').split('/');
    let owner = parts.next()?;
    let name = parts.next()?;
    let name = name.strip_suffix(".git").unwrap_or(name);
    if parts.next().is_some() || owner.is_empty() || name.is_empty() {
        return None;
    }
    Some(RepoRef {
        host,
        owner: owner.to_string(),
        name: name.to_string(),
    })
}

/// Picks the repository `gh` would use, from `git config --get-regexp` output for `remote.*.url` and
/// `remote.*.gh-resolved`. A remote that `gh repo set-default` marked wins. Otherwise `upstream`, `github`, then
/// `origin` win, in that order, and any other remote follows in config order.
pub fn choose_repo(config: &str) -> Option<RepoRef> {
    let mut urls: Vec<(&str, &str)> = Vec::new();
    let mut resolved: HashMap<&str, &str> = HashMap::new();
    for line in config.lines() {
        let Some((key, value)) = line.split_once(' ') else {
            continue;
        };
        let Some(rest) = key.strip_prefix("remote.") else {
            continue;
        };
        if let Some(name) = rest.strip_suffix(".url") {
            urls.push((name, value.trim()));
        } else if let Some(name) = rest.strip_suffix(".gh-resolved") {
            resolved.insert(name, value.trim());
        }
    }
    let rank = |name: &str| match name {
        "upstream" => 0,
        "github" => 1,
        "origin" => 2,
        _ => 3,
    };
    urls.sort_by_key(|(name, _)| rank(name));
    let marked = urls.iter().find(|(name, _)| resolved.contains_key(name));
    let (name, url) = marked.or_else(|| urls.first())?;
    let mut repo = parse_remote(url)?;
    if let Some(value) = resolved.get(name)
        && let Some((owner, repo_name)) = value.split_once('/')
    {
        repo.owner = owner.to_string();
        repo.name = repo_name.to_string();
    }
    Some(repo)
}

/// Reads the repository from the Git config of `root`. `None` means no remote, or one this module cannot read.
pub fn resolve_repo(root: &Path) -> Option<RepoRef> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["config", "--get-regexp", r"^remote\..*\.(url|gh-resolved)$"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    choose_repo(&String::from_utf8_lossy(&output.stdout))
}

/// A reply with any status.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpReply {
    pub status: u16,
    pub body: String,
}

/// The HTTP side of [`GithubApi`]. Tests replace it with a fake, so they never touch the network.
pub trait Http: Send + Sync {
    fn post_json(&self, url: &str, token: &str, body: &str) -> Result<HttpReply, String>;
    fn get(&self, url: &str, token: &str) -> Result<HttpReply, String>;
}

/// Where tokens come from.
pub trait TokenSource: Send + Sync {
    /// The token for `host`, or `None` when none exists.
    fn token(&self, host: &str) -> Option<String>;
}

/// `ureq` with rustls and one connection pool for the whole session.
pub struct UreqHttp {
    agent: ureq::Agent,
}

impl Default for UreqHttp {
    fn default() -> Self {
        let agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(REQUEST_TIMEOUT))
            .user_agent("tuig")
            .build()
            .into();
        Self { agent }
    }
}

fn read_reply(
    result: Result<ureq::http::Response<ureq::Body>, ureq::Error>,
) -> Result<HttpReply, String> {
    let mut response = result.map_err(|error| error.to_string())?;
    let status = response.status().as_u16();
    let body = response
        .body_mut()
        .read_to_string()
        .map_err(|error| error.to_string())?;
    Ok(HttpReply { status, body })
}

impl Http for UreqHttp {
    fn post_json(&self, url: &str, token: &str, body: &str) -> Result<HttpReply, String> {
        read_reply(
            self.agent
                .post(url)
                .header("Authorization", format!("Bearer {token}"))
                .header("Content-Type", "application/json")
                .send(body),
        )
    }

    fn get(&self, url: &str, token: &str) -> Result<HttpReply, String> {
        read_reply(
            self.agent
                .get(url)
                .header("Authorization", format!("Bearer {token}"))
                .header("Accept", "application/vnd.github+json")
                .call(),
        )
    }
}

/// Environment variables, then `gh auth token --hostname <host>`.
pub struct SystemTokens;

fn env_token(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

impl TokenSource for SystemTokens {
    fn token(&self, host: &str) -> Option<String> {
        let names: [&str; 2] = if host == GITHUB_HOST {
            ["GH_TOKEN", "GITHUB_TOKEN"]
        } else {
            ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]
        };
        if let Some(token) = names.iter().find_map(|name| env_token(name)) {
            return Some(token);
        }
        let output = Command::new("gh")
            .args(["auth", "token", "--hostname", host])
            .envs(GH_NON_INTERACTIVE_ENV)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
        (!token.is_empty()).then_some(token)
    }
}

/// What a request came back with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApiReply {
    Response(HttpReply),
    /// No token exists for the host. The caller should use `gh`.
    NoToken,
    /// The host rejected the token twice, the second time with a freshly read one.
    Unauthorized,
    /// The request did not complete.
    Transport(String),
}

/// A GitHub API client with a per-host token cache. Its methods block, so call them from `spawn_blocking`.
pub struct GithubApi {
    http: Box<dyn Http>,
    tokens: Box<dyn TokenSource>,
    /// `None` records a host without a token, so one session asks `gh` once.
    cache: Mutex<HashMap<String, Option<String>>>,
}

impl GithubApi {
    pub fn new(http: Box<dyn Http>, tokens: Box<dyn TokenSource>) -> Self {
        Self {
            http,
            tokens,
            cache: Mutex::new(HashMap::new()),
        }
    }

    /// The client every service of this process shares, so requests reuse one connection pool.
    pub fn shared() -> Arc<GithubApi> {
        static SHARED: OnceLock<Arc<GithubApi>> = OnceLock::new();
        SHARED
            .get_or_init(|| {
                Arc::new(Self::new(
                    Box::new(UreqHttp::default()),
                    Box::new(SystemTokens),
                ))
            })
            .clone()
    }

    fn cached(&self, host: &str) -> Option<Option<String>> {
        self.cache
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(host)
            .cloned()
    }

    fn remember(&self, host: &str, token: Option<String>) {
        self.cache
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(host.to_string(), token);
    }

    pub fn post_json(&self, host: &str, url: &str, body: &str) -> ApiReply {
        self.send(host, |token| self.http.post_json(url, token, body))
    }

    pub fn get(&self, host: &str, url: &str) -> ApiReply {
        self.send(host, |token| self.http.get(url, token))
    }

    fn send(&self, host: &str, request: impl Fn(&str) -> Result<HttpReply, String>) -> ApiReply {
        let token = match self.cached(host) {
            Some(token) => token,
            None => {
                let token = self.tokens.token(host);
                self.remember(host, token.clone());
                token
            }
        };
        let Some(token) = token else {
            return ApiReply::NoToken;
        };
        match request(&token) {
            Ok(reply) if reply.status == 401 => {}
            Ok(reply) => return ApiReply::Response(reply),
            Err(error) => return ApiReply::Transport(error),
        }
        // The token may have been revoked or rotated. Read it again, once.
        let Some(fresh) = self.tokens.token(host) else {
            self.remember(host, None);
            return ApiReply::Unauthorized;
        };
        self.remember(host, Some(fresh.clone()));
        match request(&fresh) {
            Ok(reply) if reply.status == 401 => ApiReply::Unauthorized,
            Ok(reply) => ApiReply::Response(reply),
            Err(error) => ApiReply::Transport(error),
        }
    }
}

#[cfg(test)]
#[path = "github_api_tests.rs"]
mod tests;
