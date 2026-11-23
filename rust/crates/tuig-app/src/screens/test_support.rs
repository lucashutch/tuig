//! Fixtures for shell tests that use real repositories in temp directories, driven through `TestApp`.

use crate::services::Services;
use crate::shell::{Msg, Shell};
use opentui::testing::TestApp;
use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;
use tuig_git::repository::GitRepositoryService;

pub const WAIT: Duration = Duration::from_secs(20);

pub struct TempDir(pub PathBuf);

impl TempDir {
    pub fn new(name: &str) -> Self {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("tuig-app-{name}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub fn git(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(["-c", "user.name=Ada", "-c", "user.email=ada@example.com"])
        .args(args)
        .current_dir(dir)
        .stdout(Stdio::null())
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?}");
}

/// A repository with `count` linear commits on `main`, authored by `ada@example.com`, and a clean work tree. Built
/// with `git fast-import`, so a few hundred commits take one process.
pub fn repository(count: usize) -> TempDir {
    use std::io::Write as _;
    let dir = TempDir::new("repo");
    git(&dir.0, &["init", "-q", "-b", "main"]);
    let mut stream = String::new();
    for i in 0..count {
        let message = format!("commit {i}\n");
        stream.push_str(&format!(
            "commit refs/heads/main\ncommitter Ada <ada@example.com> {} +0000\ndata {}\n{message}",
            1_700_000_000 + i,
            message.len(),
        ));
        let content = format!("{i}\n");
        stream.push_str(&format!(
            "M 100644 inline file.txt\ndata {}\n{content}\n",
            content.len()
        ));
    }
    let mut import = Command::new("git")
        .args(["fast-import", "--quiet"])
        .current_dir(&dir.0)
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    import
        .stdin
        .take()
        .unwrap()
        .write_all(stream.as_bytes())
        .unwrap();
    assert!(import.wait().unwrap().success());
    git(&dir.0, &["reset", "-q", "--hard", "main"]);
    dir
}

pub struct Harness {
    pub app: TestApp,
    pub shell: Rc<RefCell<Shell>>,
    pub _repo: TempDir,
}

impl Harness {
    pub fn start(repo: TempDir, services: Services) -> Self {
        let app = TestApp::new(160, 48);
        let service = app
            .app()
            .runtime()
            .block_on(GitRepositoryService::open(&repo.0))
            .unwrap();
        let shell = Shell::start_with(app.app(), Arc::new(service), services);
        Self {
            app,
            shell,
            _repo: repo,
        }
    }

    pub fn wait(&self, what: &str, mut condition: impl FnMut(&Shell) -> bool) {
        assert!(
            self.app
                .wait_until(WAIT, || condition(&self.shell.borrow())),
            "timed out waiting for {what}"
        );
    }

    /// Runs a message and then `sync`, as the inbox does.
    pub fn send(&self, msg: Msg) {
        let mut shell = self.shell.borrow_mut();
        shell.update(self.app.app(), msg);
        shell.sync(self.app.app());
    }

    pub fn read<R>(&self, read: impl FnOnce(&Shell) -> R) -> R {
        read(&self.shell.borrow())
    }
}
