//! Recognises remote failures that need the user to set up credentials or
//! trust a host. Tuig disables Git and SSH prompts, so these failures are
//! expected and need a short explanation instead of raw stderr.
//! Port of `src/git/remote-errors.ts`.

use regex::Regex;
use std::sync::LazyLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteOperation {
    Fetch,
    Pull,
    Push,
}

impl RemoteOperation {
    fn label(self) -> &'static str {
        match self {
            RemoteOperation::Fetch => "Fetch",
            RemoteOperation::Pull => "Pull",
            RemoteOperation::Push => "Push",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteAuthKind {
    Credentials,
    HostKey,
    HostKeyChanged,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteAuthFailure {
    pub kind: RemoteAuthKind,
    pub host: Option<String>,
}

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("static regex is valid")
}

static CREDENTIAL_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"(?i)terminal prompts disabled",
        r"(?i)could not read (?:Username|Password) for",
        r"(?i)Authentication failed for",
        r"(?i)Permission denied \([a-z,-]+\)",
        r"(?i)requested URL returned error: 401",
        r"(?i)Invalid username or password",
    ]
    .iter()
    .map(|p| re(p))
    .collect()
});
static HOST_KEY_CHANGED: LazyLock<Regex> =
    LazyLock::new(|| re(r"REMOTE HOST IDENTIFICATION HAS CHANGED"));
static HOST_KEY: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)Host key verification failed"));
static HOST_URL: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)for '[a-z+]+://(?:[^@/']*@)?([^/:']+)"));
static HOST_SCP: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?im)^(?:[^@\s]+@)?([^\s:@]+): Permission denied"));
static HOST_KNOWN: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)host key is known for ([^\s,]+)"));
static HOST_AUTHENTICITY: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)authenticity of host '([^\s']+)"));

/// Returns the failure kind and host, or `None` when stderr is not an auth problem.
pub fn classify_remote_auth_failure(stderr: &str) -> Option<RemoteAuthFailure> {
    let failure = |kind| {
        Some(RemoteAuthFailure {
            kind,
            host: find_host(stderr),
        })
    };
    if HOST_KEY_CHANGED.is_match(stderr) {
        return failure(RemoteAuthKind::HostKeyChanged);
    }
    if HOST_KEY.is_match(stderr) {
        return failure(RemoteAuthKind::HostKey);
    }
    if CREDENTIAL_PATTERNS.iter().any(|p| p.is_match(stderr)) {
        return failure(RemoteAuthKind::Credentials);
    }
    None
}

fn find_host(stderr: &str) -> Option<String> {
    // "could not read Username for 'https://github.com': ..."
    // "Authentication failed for 'https://github.com/o/r.git/'"
    // "git@github.com: Permission denied (publickey)."
    // "No ED25519 host key is known for github.com and you have requested ..."
    // "The authenticity of host 'github.com (140.82.121.4)' can't be established."
    // "Offending ECDSA key in /home/u/.ssh/known_hosts:3" has no host. Skip it.
    [&HOST_URL, &HOST_SCP, &HOST_KNOWN, &HOST_AUTHENTICITY]
        .iter()
        .find_map(|pattern| pattern.captures(stderr))
        .map(|caps| caps[1].to_string())
}

/// Builds the short status-bar message for an auth failure.
pub fn describe_remote_auth_failure(
    operation: RemoteOperation,
    failure: &RemoteAuthFailure,
    remote: Option<&str>,
) -> String {
    // Mirrors the TypeScript `&&` (empty is falsy) then `??` (empty is kept) chain.
    let host = failure.host.as_deref();
    let name = match (remote, host) {
        (Some(r), Some(h)) if !r.is_empty() && !h.is_empty() && h != r => format!("{r} ({h})"),
        (Some(r), _) => r.to_string(),
        (None, Some(h)) => h.to_string(),
        (None, None) => "the remote".to_string(),
    };
    let label = operation.label();
    match failure.kind {
        RemoteAuthKind::HostKeyChanged => format!(
            "{label} stopped. The SSH host key for {name} changed. Check the server, then update ~/.ssh/known_hosts."
        ),
        RemoteAuthKind::HostKey => format!(
            "{label} stopped. SSH does not trust the host key for {name}. Run ssh to that host once in a terminal to accept it."
        ),
        RemoteAuthKind::Credentials => format!(
            "{label} needs credentials for {name}. Set up a credential helper or an SSH key in an agent."
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process::{GitError, run_git};
    use crate::test_util::temp_repo;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    // Samples are real git and OpenSSH output.
    const HTTPS_NO_PROMPT: &str =
        "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n";
    const HTTPS_NO_PASSWORD: &str = "fatal: could not read Password for 'https://user@git.example.com': terminal prompts disabled\n";
    const HTTPS_BAD_PASSWORD: &str = "remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/acme/widgets.git/'\n";
    const SSH_PUBLICKEY: &str = "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n";
    const SSH_HOST_KEY: &str = "No ED25519 host key is known for git.example.com and you have requested strict checking.\nHost key verification failed.\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n";
    const SSH_HOST_CHANGED: &str = "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\nOffending ECDSA key in /home/u/.ssh/known_hosts:3\nHost key verification failed.\nfatal: Could not read from remote repository.\n";
    const NETWORK: &str = "fatal: unable to access 'https://github.com/acme/widgets.git/': Could not resolve host: github.com\n";
    const MISSING_REPO: &str = "remote: Repository not found.\nfatal: repository 'https://github.com/acme/nope.git/' not found\n";
    const REJECTED: &str = "To github.com:acme/widgets.git\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to 'github.com:acme/widgets.git'\n";
    const BARE_READ_FAILURE: &str = "ssh: connect to host github.com port 22: Connection timed out\nfatal: Could not read from remote repository.\n";

    fn credentials(host: &str) -> Option<RemoteAuthFailure> {
        Some(RemoteAuthFailure {
            kind: RemoteAuthKind::Credentials,
            host: Some(host.into()),
        })
    }

    #[test]
    fn recognises_https_credential_failures_and_finds_the_host() {
        assert_eq!(
            classify_remote_auth_failure(HTTPS_NO_PROMPT),
            credentials("github.com")
        );
        assert_eq!(
            classify_remote_auth_failure(HTTPS_NO_PASSWORD),
            credentials("git.example.com")
        );
        assert_eq!(
            classify_remote_auth_failure(HTTPS_BAD_PASSWORD),
            credentials("github.com")
        );
    }

    #[test]
    fn recognises_ssh_key_rejection() {
        assert_eq!(
            classify_remote_auth_failure(SSH_PUBLICKEY),
            credentials("github.com")
        );
    }

    #[test]
    fn separates_host_key_problems_from_missing_credentials() {
        assert_eq!(
            classify_remote_auth_failure(SSH_HOST_KEY),
            Some(RemoteAuthFailure {
                kind: RemoteAuthKind::HostKey,
                host: Some("git.example.com".into())
            })
        );
        assert_eq!(
            classify_remote_auth_failure(SSH_HOST_CHANGED).map(|f| (f.kind, f.host)),
            Some((RemoteAuthKind::HostKeyChanged, None))
        );
    }

    #[test]
    fn ignores_network_errors_missing_repositories_and_rejected_pushes() {
        for stderr in [NETWORK, MISSING_REPO, REJECTED, BARE_READ_FAILURE] {
            assert_eq!(classify_remote_auth_failure(stderr), None, "{stderr}");
        }
    }

    /// A real 401 makes Git ask for a username. Prompts are disabled, so Git
    /// fails with "terminal prompts disabled", the case users hit in Tuig.
    #[tokio::test]
    async fn fetch_from_an_https_remote_that_demands_credentials_classifies_as_credentials() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut buffer = [0u8; 4096];
                let _ = stream.read(&mut buffer);
                let _ = stream.write_all(
                    b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"git\"\r\nContent-Length: 6\r\nConnection: close\r\n\r\ndenied",
                );
            }
        });
        let repo = temp_repo().await;
        let remote = format!("http://127.0.0.1:{port}/x.git");
        run_git(&["remote", "add", "origin", &remote], Some(repo.path()))
            .await
            .unwrap();

        let error = run_git(&["fetch"], Some(repo.path())).await.unwrap_err();
        let GitError::Command(error) = error else {
            panic!("expected a command error, got {error:?}");
        };
        assert_eq!(
            classify_remote_auth_failure(&error.result.stderr),
            credentials("127.0.0.1")
        );
    }
}
