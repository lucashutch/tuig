use crate::args::CliAction;
use crate::error::CliError;
use std::collections::BTreeMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tuig_git::process::GitError;
use tuig_git::repository::{GitRepository, GitRepositoryService, create_git_repository};
use tuig_ui_model::session_preferences::{
    SessionPreferences, SubmoduleRelation, load_session_preferences, session_preferences_path,
};

/// Something with a repository root, so the start-up logic can be tested without Git.
pub trait HasRoot {
    fn root(&self) -> &str;
}

impl HasRoot for GitRepositoryService {
    fn root(&self) -> &str {
        GitRepository::root(self)
    }
}

impl HasRoot for Arc<dyn GitRepository> {
    fn root(&self) -> &str {
        GitRepository::root(self.as_ref())
    }
}

/// The `Run` fields of a [`CliAction`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartRequest {
    pub path: PathBuf,
    pub clean: bool,
    pub path_provided: bool,
}

impl StartRequest {
    /// `None` for any action other than `Run`.
    pub fn from_action(action: &CliAction) -> Option<Self> {
        match action {
            CliAction::Run {
                path,
                clean,
                path_provided,
            } => Some(Self {
                path: path.clone(),
                clean: *clean,
                path_provided: *path_provided,
            }),
            _ => None,
        }
    }
}

/// Arguments for `runTuig` in the TypeScript app.
#[derive(Debug)]
pub struct StartRepositories<R> {
    /// Saved tabs that still open, then the requested repository.
    pub repositories: Vec<R>,
    /// The requested repository's root, else the saved active repository.
    pub active_repository: Option<String>,
    /// Saved submodule tabs. `None` with `--clean`.
    pub submodules: Option<BTreeMap<String, SubmoduleRelation>>,
    pub recent_repositories: Vec<String>,
}

/// Read the saved session unless `clean` is set. A missing or malformed file gives an empty
/// session. `path` defaults to [`session_preferences_path`].
pub fn load_saved_session(clean: bool, path: Option<&Path>) -> SessionPreferences {
    if clean {
        return SessionPreferences::default();
    }
    match path {
        Some(path) => load_session_preferences(path),
        None => load_session_preferences(&session_preferences_path()),
    }
}

/// Open the repositories to show at start-up. Port of the start-up branch of `src/index.ts`.
///
/// An explicit path must open, or the call fails. Saved repositories that no longer open are
/// dropped. The current directory is a fallback only when nothing else opened.
pub async fn resolve_start_repositories<R, F, Fut>(
    request: &StartRequest,
    saved: SessionPreferences,
    open: F,
) -> Result<StartRepositories<R>, CliError>
where
    R: HasRoot,
    F: Fn(String) -> Fut,
    Fut: Future<Output = Result<R, GitError>>,
{
    let to_string = |path: &Path| path.to_string_lossy().into_owned();
    let requested = if request.path_provided {
        Some(open(to_string(&request.path)).await?)
    } else {
        None
    };
    let requested_root = requested.as_ref().map(|r| r.root().to_string());
    let mut seen: Vec<&str> = Vec::new();
    for path in &saved.repositories {
        if !seen.contains(&path.as_str()) && Some(path) != requested_root.as_ref() {
            seen.push(path);
        }
    }
    // Each open runs Git, so the saved repositories open at the same time.
    let opened = join_all(seen.iter().map(|path| open(path.to_string()))).await;
    let mut repositories: Vec<R> = opened.into_iter().filter_map(Result::ok).collect();
    repositories.extend(requested);
    if repositories.is_empty() {
        repositories.push(open(to_string(&request.path)).await?);
    }
    Ok(StartRepositories {
        repositories,
        active_repository: requested_root.or(saved.active_repository),
        submodules: if request.clean {
            None
        } else {
            saved.submodules
        },
        recent_repositories: saved.recent_repositories.unwrap_or_default(),
    })
}

/// Runs `futures` concurrently on the current task and returns their outputs in input order.
async fn join_all<Fut: Future>(futures: impl IntoIterator<Item = Fut>) -> Vec<Fut::Output> {
    let mut pending: Vec<Option<std::pin::Pin<Box<Fut>>>> =
        futures.into_iter().map(|f| Some(Box::pin(f))).collect();
    let mut outputs: Vec<Option<Fut::Output>> = pending.iter().map(|_| None).collect();
    std::future::poll_fn(|cx| {
        let mut done = true;
        for (slot, output) in pending.iter_mut().zip(outputs.iter_mut()) {
            if let Some(future) = slot {
                match future.as_mut().poll(cx) {
                    std::task::Poll::Ready(value) => {
                        *output = Some(value);
                        *slot = None;
                    }
                    std::task::Poll::Pending => done = false,
                }
            }
        }
        if done {
            std::task::Poll::Ready(())
        } else {
            std::task::Poll::Pending
        }
    })
    .await;
    outputs.into_iter().flatten().collect()
}

/// [`resolve_start_repositories`] with real Git repositories and the session file on disk.
pub async fn open_start_repositories(
    request: &StartRequest,
) -> Result<StartRepositories<GitRepositoryService>, CliError> {
    let saved = load_saved_session(request.clean, None);
    resolve_start_repositories(request, saved, create_git_repository).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct Fake(String);
    impl HasRoot for Fake {
        fn root(&self) -> &str {
            &self.0
        }
    }

    fn request(path: &str, clean: bool, path_provided: bool) -> StartRequest {
        StartRequest {
            path: path.into(),
            clean,
            path_provided,
        }
    }

    fn saved(repositories: &[&str], active: Option<&str>) -> SessionPreferences {
        SessionPreferences {
            repositories: repositories.iter().map(|s| s.to_string()).collect(),
            active_repository: active.map(str::to_string),
            submodules: None,
            recent_repositories: Some(vec!["/recent".into()]),
        }
    }

    /// Opens every path except those in `missing`, and records the order.
    async fn resolve(
        req: &StartRequest,
        session: SessionPreferences,
        missing: &[&str],
    ) -> (Result<StartRepositories<Fake>, CliError>, Vec<String>) {
        let calls = Mutex::new(Vec::new());
        let result = resolve_start_repositories(req, session, |path: String| {
            calls.lock().unwrap().push(path.clone());
            let ok = !missing.contains(&path.as_str());
            async move {
                if ok {
                    Ok(Fake(path))
                } else {
                    Err(GitError::Io(std::io::Error::other(format!(
                        "cannot open {path}"
                    ))))
                }
            }
        })
        .await;
        (result, calls.into_inner().unwrap())
    }

    fn roots(result: &StartRepositories<Fake>) -> Vec<&str> {
        result.repositories.iter().map(|r| r.root()).collect()
    }

    #[tokio::test]
    async fn restores_saved_tabs_and_drops_those_that_no_longer_open() {
        let session = saved(&["/a", "/gone", "/b"], Some("/b"));
        let (result, _) = resolve(&request("/cwd", false, false), session, &["/gone"]).await;
        let result = result.unwrap();
        assert_eq!(roots(&result), ["/a", "/b"]);
        assert_eq!(result.active_repository.as_deref(), Some("/b"));
        assert_eq!(result.recent_repositories, ["/recent"]);
    }

    #[tokio::test]
    async fn saved_tabs_open_concurrently_and_keep_their_order() {
        // "/a" finishes only after "/b" started and finished, which a serial loop would never reach.
        let b_done = tokio::sync::Notify::new();
        let session = saved(&["/a", "/gone", "/b"], None);
        let result =
            resolve_start_repositories(&request("/cwd", false, false), session, |path: String| {
                let b_done = &b_done;
                async move {
                    match path.as_str() {
                        "/a" => b_done.notified().await,
                        "/b" => b_done.notify_one(),
                        _ => return Err(GitError::Io(std::io::Error::other("gone"))),
                    }
                    Ok(Fake(path))
                }
            })
            .await
            .unwrap();
        assert_eq!(roots(&result), ["/a", "/b"]);
    }

    #[tokio::test]
    async fn an_explicit_path_joins_the_session_last_and_becomes_active() {
        let session = saved(&["/a", "/req"], Some("/a"));
        let (result, _) = resolve(&request("/req", false, true), session, &[]).await;
        let result = result.unwrap();
        assert_eq!(roots(&result), ["/a", "/req"]);
        assert_eq!(result.active_repository.as_deref(), Some("/req"));
    }

    #[tokio::test]
    async fn an_explicit_path_that_does_not_open_is_an_error() {
        let (result, _) = resolve(
            &request("/bad", false, true),
            saved(&["/a"], None),
            &["/bad"],
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn falls_back_to_the_current_directory_only_when_nothing_else_opens() {
        let (result, _) = resolve(
            &request("/cwd", false, false),
            saved(&["/gone"], None),
            &["/gone"],
        )
        .await;
        assert_eq!(roots(&result.unwrap()), ["/cwd"]);
        let (result, _) =
            resolve(&request("/cwd", false, false), saved(&[], None), &["/cwd"]).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn clean_ignores_the_saved_session_but_keeps_recent_paths_empty() {
        let session = load_saved_session(true, None);
        let (result, calls) = resolve(&request("/req", true, true), session, &[]).await;
        let result = result.unwrap();
        assert_eq!(roots(&result), ["/req"]);
        assert_eq!(calls, ["/req"]);
        assert!(result.submodules.is_none());
        assert!(result.recent_repositories.is_empty());
    }

    #[test]
    fn reads_a_session_file_written_by_the_typescript_app() {
        let dir = std::env::temp_dir().join(format!("tuig-cli-session-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.json");
        std::fs::write(
            &path,
            "{\n  \"repositories\": [\n    \"/work/app\"\n  ],\n  \"activeRepository\": \"/work/app\",\n  \"recentRepositories\": [\n    \"/old\"\n  ]\n}\n",
        )
        .unwrap();
        let loaded = load_saved_session(false, Some(&path));
        assert_eq!(loaded.repositories, ["/work/app"]);
        assert_eq!(
            loaded.recent_repositories.as_deref(),
            Some(&["/old".to_string()][..])
        );
        // A malformed file behaves like no file.
        std::fs::write(&path, "{ nope").unwrap();
        assert!(
            load_saved_session(false, Some(&path))
                .repositories
                .is_empty()
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
