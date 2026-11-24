use crate::error::CliError;
use async_trait::async_trait;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
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
    /// Saves the body of a successful GET request to `dest`.
    async fn download(&self, url: &str, dest: &Path) -> Result<(), CliError>;
}

/// Fetches through the `curl` program. It follows redirects. A request gives up after 30 seconds
/// and a download after 5 minutes.
pub struct CurlFetcher;

#[async_trait]
impl ReleaseFetcher for CurlFetcher {
    async fn get(&self, url: &str, accept: &str) -> Result<HttpResponse, CliError> {
        let output = Command::new("curl")
            .args(["-q", "--silent", "--show-error", "--location"])
            .args(["--proto", "=https", "--max-time", "30"])
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

    async fn download(&self, url: &str, dest: &Path) -> Result<(), CliError> {
        let output = Command::new("curl")
            .args(["-q", "--silent", "--show-error", "--location", "--fail"])
            .args(["--proto", "=https", "--max-time", "300"])
            .arg("--output")
            .arg(dest)
            .arg(url)
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output()
            .await
            .map_err(|error| CliError::Other(format!("could not run curl: {error}")))?;
        if !output.status.success() {
            return Err(CliError::Other(format!(
                "download failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )));
        }
        Ok(())
    }
}

pub fn is_current_release(version: &str, tag: &str) -> bool {
    tag.strip_prefix('v').unwrap_or(tag) == version.strip_prefix('v').unwrap_or(version)
}

/// The latest GitHub release: its tag and the names of its assets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LatestRelease {
    pub tag: String,
    pub assets: Vec<String>,
}

/// The latest GitHub release, with its tag and asset names.
pub async fn latest_release(fetcher: &dyn ReleaseFetcher) -> Result<LatestRelease, CliError> {
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
    let tag = match release.get("tag_name").and_then(|tag| tag.as_str()) {
        Some(tag) if !tag.is_empty() => tag.to_string(),
        _ => {
            return Err(CliError::Other(
                "GitHub returned a release without a tag".into(),
            ));
        }
    };
    let assets = release
        .get("assets")
        .and_then(|assets| assets.as_array())
        .map(|assets| {
            assets
                .iter()
                .filter_map(|asset| asset.get("name").and_then(|name| name.as_str()))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    Ok(LatestRelease { tag, assets })
}

/// The tag of the latest GitHub release.
pub async fn latest_release_tag(fetcher: &dyn ReleaseFetcher) -> Result<String, CliError> {
    Ok(latest_release(fetcher).await?.tag)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateStatus {
    UpToDate,
    Available {
        tag: String,
    },
    /// The latest release exists, but it has no package for the platform yet. The release job
    /// uploads the packages after it creates the release.
    NoPackage {
        tag: String,
        platform: String,
    },
}

/// Compare the running version with the latest release. Every call sends a request. The
/// TypeScript app has no cache or background check, only the `tuig update` command. A newer
/// release counts as available only when its assets include the package for `platform`.
pub async fn check_for_update(
    current_version: &str,
    platform: &str,
    fetcher: &dyn ReleaseFetcher,
) -> Result<UpdateStatus, CliError> {
    let release = latest_release(fetcher).await?;
    if is_current_release(current_version, &release.tag) {
        return Ok(UpdateStatus::UpToDate);
    }
    let archive = format!("{}.tar.gz", package_stem(&release.tag, platform));
    Ok(if release.assets.contains(&archive) {
        UpdateStatus::Available { tag: release.tag }
    } else {
        UpdateStatus::NoPackage {
            tag: release.tag,
            platform: platform.to_string(),
        }
    })
}

/// The release platform of this build, as it appears in asset names, or `None` when no release
/// is built for it. `scripts/package.sh` builds the four platforms that [`platform_for`] lists.
pub fn current_platform() -> Option<&'static str> {
    platform_for(std::env::consts::OS, std::env::consts::ARCH)
}

/// The release platform for an operating system and CPU architecture, named as in
/// `std::env::consts`. The result is the platform part of the asset name that `package.sh` writes.
fn platform_for(os: &str, arch: &str) -> Option<&'static str> {
    match (os, arch) {
        ("linux", "x86_64") => Some("x86_64-linux"),
        ("linux", "aarch64") => Some("aarch64-linux"),
        ("macos", "aarch64") => Some("aarch64-macos"),
        ("macos", "x86_64") => Some("x86_64-macos"),
        _ => None,
    }
}

/// The package name without the extension, for example `tuig-0.1.22-x86_64-linux`. The archive
/// holds one directory of this name. `scripts/package.sh` builds the same name.
pub fn package_stem(tag: &str, platform: &str) -> String {
    format!("tuig-{}-{platform}", tag.strip_prefix('v').unwrap_or(tag))
}

/// The download address of the package archive for a release tag. A `.sha256` file with the same
/// name sits beside it. Both are assets of the GitHub release, which the `rust-package` job in
/// `.github/workflows/release.yml` uploads.
pub fn package_url(tag: &str, platform: &str) -> String {
    format!(
        "https://github.com/{REPOSITORY}/releases/download/{tag}/{}.tar.gz",
        package_stem(tag, platform)
    )
}

/// Removes the directory when dropped, so a failed update leaves nothing behind.
struct ScratchDir(PathBuf);

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Prefix of the scratch directories that `install_release` creates beside the executable.
const SCRATCH_PREFIX: &str = ".tuig-update-";

/// Removes the scratch directories that an interrupted update left in `dir` (SIGINT or SIGKILL
/// skip `Drop`). It removes real directories with the scratch prefix only, never files or links.
fn remove_stale_scratch_dirs(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let is_scratch = entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.starts_with(SCRATCH_PREFIX));
        // `DirEntry::file_type` does not follow symbolic links.
        if is_scratch && entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

fn io_error(what: &str, error: std::io::Error) -> CliError {
    CliError::Other(format!("{what}: {error}"))
}

fn sha256_hex(path: &Path) -> Result<String, CliError> {
    let bytes = std::fs::read(path).map_err(|e| io_error("could not read the download", e))?;
    Ok(Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

/// Downloads the release package for `tag`, checks its SHA-256 sum, and replaces the executable
/// at `exe` with the binary inside. The checksum comes from the same release as the archive, so it
/// detects a damaged or incomplete download. It does not prove who published the archive. The work happens in a directory beside `exe`, so the final
/// rename stays on one file system. Linux lets a running program be replaced by rename.
pub async fn install_release(
    tag: &str,
    platform: &str,
    exe: &Path,
    fetcher: &dyn ReleaseFetcher,
) -> Result<(), CliError> {
    let dir = exe
        .parent()
        .ok_or_else(|| CliError::Other("the tuig executable has no directory".into()))?;
    let scratch = ScratchDir(dir.join(format!("{SCRATCH_PREFIX}{}", std::process::id())));
    remove_stale_scratch_dirs(dir);
    let _ = std::fs::remove_dir_all(&scratch.0);
    std::fs::create_dir(&scratch.0).map_err(|e| {
        io_error(
            &format!("could not write to {} (is it read-only?)", dir.display()),
            e,
        )
    })?;

    let stem = package_stem(tag, platform);
    let url = package_url(tag, platform);
    let archive = scratch.0.join(format!("{stem}.tar.gz"));
    fetcher.download(&url, &archive).await?;

    let sums = fetcher.get(&format!("{url}.sha256"), "text/plain").await?;
    if !(200..300).contains(&sums.status) {
        return Err(CliError::Other(format!(
            "could not download the checksum for {tag} (HTTP {})",
            sums.status
        )));
    }
    let expected = sums.body.split_whitespace().next().unwrap_or("");
    let actual = sha256_hex(&archive)?;
    if !expected.eq_ignore_ascii_case(&actual) {
        return Err(CliError::Other(format!(
            "the download for {tag} does not match its checksum (expected {expected}, got {actual})"
        )));
    }

    let unpacked = scratch.0.join("unpacked");
    std::fs::create_dir(&unpacked).map_err(|e| io_error("could not create a directory", e))?;
    let output = Command::new("tar")
        .arg("-xzf")
        .arg(&archive)
        .arg("-C")
        .arg(&unpacked)
        .arg("--no-same-owner")
        .arg(format!("{stem}/tuig"))
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|error| CliError::Other(format!("could not run tar: {error}")))?;
    if !output.status.success() {
        return Err(CliError::Other(format!(
            "could not unpack the download: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    let binary = unpacked.join(&stem).join("tuig");
    // `tar` would also extract a symbolic link or a device node under this name.
    let is_file = std::fs::symlink_metadata(&binary).is_ok_and(|meta| meta.is_file());
    if !is_file {
        return Err(CliError::Other(
            "the download does not contain a tuig program".into(),
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| io_error("could not unpack the download", e))?;
    }

    // A binary for the wrong platform or a damaged one must not replace the working one.
    let check = Command::new(&binary)
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|error| CliError::Other(format!("the new tuig does not start: {error}")))?;
    if !check.status.success() {
        return Err(CliError::Other("the new tuig does not start".into()));
    }
    let expected_line = crate::version_line(tag.strip_prefix('v').unwrap_or(tag));
    let reported = String::from_utf8_lossy(&check.stdout);
    let reported = reported.trim_end_matches('\n');
    if reported != expected_line {
        return Err(CliError::Other(format!(
            "the new tuig reports \"{reported}\" instead of \"{expected_line}\""
        )));
    }

    // The scratch directory is beside `exe`, so this rename stays on one file system.
    std::fs::rename(&binary, exe)
        .map_err(|e| io_error(&format!("could not replace {}", exe.display()), e))
}

/// The `tuig update` command. Prints progress to stdout like the TypeScript app.
pub async fn update_tuig(
    current_version: &str,
    fetcher: &dyn ReleaseFetcher,
) -> Result<(), CliError> {
    let platform = current_platform().ok_or_else(|| {
        CliError::Other(format!(
            "no tuig release is built for {} on {}",
            std::env::consts::ARCH,
            std::env::consts::OS
        ))
    })?;
    let exe = std::env::current_exe()
        .map_err(|error| CliError::Other(format!("could not find the tuig executable: {error}")))?;
    update_tuig_at(current_version, fetcher, platform, &exe).await
}

/// [`update_tuig`] for a chosen platform and executable path.
pub async fn update_tuig_at(
    current_version: &str,
    fetcher: &dyn ReleaseFetcher,
    platform: &str,
    exe: &Path,
) -> Result<(), CliError> {
    println!("Checking for updates...");
    let tag = match check_for_update(current_version, platform, fetcher).await? {
        UpdateStatus::UpToDate => {
            println!("Tuig is up to date.");
            return Ok(());
        }
        UpdateStatus::NoPackage { tag, platform } => {
            println!("no package for {platform} in {tag} yet");
            return Ok(());
        }
        UpdateStatus::Available { tag } => tag,
    };
    println!("Update found ({tag}). Upgrading...");
    install_release(&tag, platform, exe, fetcher).await?;
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

        async fn download(&self, _url: &str, _dest: &Path) -> Result<(), CliError> {
            panic!("this test must not download");
        }
    }

    /// Serves a release: the latest-release JSON, one archive file, and a checksum text.
    struct Release {
        archive: PathBuf,
        checksum: String,
        urls: Mutex<Vec<String>>,
    }

    #[async_trait]
    impl ReleaseFetcher for Release {
        async fn get(&self, url: &str, _accept: &str) -> Result<HttpResponse, CliError> {
            self.urls.lock().unwrap().push(url.into());
            let body = if url.ends_with(".sha256") {
                format!("{}  archive.tar.gz\n", self.checksum)
            } else {
                r#"{"tag_name":"v0.2.0","assets":[{"name":"tuig-0.2.0-x86_64-linux.tar.gz"}]}"#
                    .to_string()
            };
            Ok(HttpResponse { status: 200, body })
        }

        async fn download(&self, url: &str, dest: &Path) -> Result<(), CliError> {
            self.urls.lock().unwrap().push(url.into());
            std::fs::copy(&self.archive, dest).unwrap();
            Ok(())
        }
    }

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let path =
                std::env::temp_dir().join(format!("tuig-update-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A release package whose `tuig` is a script that prints `tuig 0.2.0` and exits with `code`.
    fn build_package(dir: &Path, stem: &str, code: i32) -> (PathBuf, String) {
        build_package_printing(dir, stem, "tuig 0.2.0", code)
    }

    /// Like [`build_package`], with the `--version` output chosen.
    fn build_package_printing(
        dir: &Path,
        stem: &str,
        printed: &str,
        code: i32,
    ) -> (PathBuf, String) {
        let root = dir.join("package");
        std::fs::create_dir_all(root.join(stem)).unwrap();
        std::fs::write(
            root.join(stem).join("tuig"),
            format!("#!/bin/sh\necho \"{printed}\"\nexit {code}\n"),
        )
        .unwrap();
        let archive = dir.join("archive.tar.gz");
        let status = std::process::Command::new("tar")
            .arg("-czf")
            .arg(&archive)
            .arg("-C")
            .arg(&root)
            .arg(stem)
            .status()
            .unwrap();
        assert!(status.success());
        let checksum = sha256_hex(&archive).unwrap();
        (archive, checksum)
    }

    fn old_executable(dir: &Path) -> PathBuf {
        let exe = dir.join("tuig");
        std::fs::write(&exe, "old-binary").unwrap();
        exe
    }

    #[test]
    fn compares_versions_ignoring_a_leading_v() {
        assert!(is_current_release("0.1.21", "v0.1.21"));
        assert!(is_current_release("v0.1.21", "0.1.21"));
        assert!(!is_current_release("0.1.21", "v0.1.22"));
    }

    #[test]
    fn names_the_package_after_the_tag_and_platform() {
        assert_eq!(
            package_stem("v0.1.22", "x86_64-linux"),
            "tuig-0.1.22-x86_64-linux"
        );
        assert_eq!(
            package_url("v0.1.22", "x86_64-linux"),
            "https://github.com/lucashutch/tuig/releases/download/v0.1.22/tuig-0.1.22-x86_64-linux.tar.gz"
        );
    }

    #[test]
    fn picks_the_release_platform_for_each_supported_target() {
        for (os, arch, platform) in [
            ("linux", "x86_64", "x86_64-linux"),
            ("linux", "aarch64", "aarch64-linux"),
            ("macos", "aarch64", "aarch64-macos"),
            ("macos", "x86_64", "x86_64-macos"),
        ] {
            assert_eq!(platform_for(os, arch), Some(platform), "{os} {arch}");
        }
        for (os, arch) in [
            ("windows", "x86_64"),
            ("linux", "riscv64"),
            ("linux", "x86"),
            ("freebsd", "x86_64"),
        ] {
            assert_eq!(platform_for(os, arch), None, "{os} {arch}");
        }
    }

    #[test]
    fn names_the_release_asset_for_each_platform() {
        for platform in [
            "x86_64-linux",
            "aarch64-linux",
            "aarch64-macos",
            "x86_64-macos",
        ] {
            assert_eq!(
                package_url("v0.1.22", platform),
                format!(
                    "https://github.com/lucashutch/tuig/releases/download/v0.1.22/tuig-0.1.22-{platform}.tar.gz"
                )
            );
        }
    }

    #[tokio::test]
    async fn update_replaces_the_executable_with_the_packaged_binary() {
        let temp = TempDir::new("replace");
        let stem = package_stem("v0.2.0", "x86_64-linux");
        let (archive, checksum) = build_package(&temp.0, &stem, 0);
        let bin = temp.0.join("bin");
        std::fs::create_dir(&bin).unwrap();
        let exe = old_executable(&bin);
        let release = Release {
            archive,
            checksum,
            urls: Mutex::new(Vec::new()),
        };

        update_tuig_at("0.1.21", &release, "x86_64-linux", &exe)
            .await
            .unwrap();

        let output = std::process::Command::new(&exe).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&output.stdout), "tuig 0.2.0\n");
        let urls = release.urls.lock().unwrap();
        assert!(urls.contains(&package_url("v0.2.0", "x86_64-linux")));
        assert!(urls.contains(&format!("{}.sha256", package_url("v0.2.0", "x86_64-linux"))));
        let left: Vec<_> = std::fs::read_dir(&bin).unwrap().collect();
        assert_eq!(left.len(), 1, "the scratch directory must be removed");
    }

    #[tokio::test]
    async fn update_keeps_the_old_executable_when_the_checksum_differs() {
        let temp = TempDir::new("checksum");
        let stem = package_stem("v0.2.0", "x86_64-linux");
        let (archive, _) = build_package(&temp.0, &stem, 0);
        let bin = temp.0.join("bin");
        std::fs::create_dir(&bin).unwrap();
        let exe = old_executable(&bin);
        let release = Release {
            archive,
            checksum: "0".repeat(64),
            urls: Mutex::new(Vec::new()),
        };

        let error = update_tuig_at("0.1.21", &release, "x86_64-linux", &exe)
            .await
            .unwrap_err();

        assert!(
            error.to_string().contains("does not match its checksum"),
            "{error}"
        );
        assert_eq!(std::fs::read_to_string(&exe).unwrap(), "old-binary");
        assert_eq!(std::fs::read_dir(&bin).unwrap().count(), 1);
    }

    #[tokio::test]
    async fn update_keeps_the_old_executable_when_the_new_one_does_not_run() {
        let temp = TempDir::new("broken");
        let stem = package_stem("v0.2.0", "x86_64-linux");
        let (archive, checksum) = build_package(&temp.0, &stem, 3);
        let bin = temp.0.join("bin");
        std::fs::create_dir(&bin).unwrap();
        let exe = old_executable(&bin);
        let release = Release {
            archive,
            checksum,
            urls: Mutex::new(Vec::new()),
        };

        let error = update_tuig_at("0.1.21", &release, "x86_64-linux", &exe)
            .await
            .unwrap_err();

        assert_eq!(error.to_string(), "the new tuig does not start");
        assert_eq!(std::fs::read_to_string(&exe).unwrap(), "old-binary");
    }

    #[tokio::test]
    async fn update_keeps_the_old_executable_when_the_new_version_differs() {
        let temp = TempDir::new("mismatch");
        let stem = package_stem("v0.2.0", "x86_64-linux");
        let (archive, checksum) = build_package_printing(&temp.0, &stem, "tuig 0.1.9", 0);
        let bin = temp.0.join("bin");
        std::fs::create_dir(&bin).unwrap();
        let exe = old_executable(&bin);
        let release = Release {
            archive,
            checksum,
            urls: Mutex::new(Vec::new()),
        };

        let error = update_tuig_at("0.1.21", &release, "x86_64-linux", &exe)
            .await
            .unwrap_err();

        assert_eq!(
            error.to_string(),
            "the new tuig reports \"tuig 0.1.9\" instead of \"tuig 0.2.0\""
        );
        assert_eq!(std::fs::read_to_string(&exe).unwrap(), "old-binary");
        assert_eq!(std::fs::read_dir(&bin).unwrap().count(), 1);
    }

    #[tokio::test]
    async fn update_rejects_a_package_whose_tuig_is_a_symbolic_link() {
        let temp = TempDir::new("symlink");
        let stem = package_stem("v0.2.0", "x86_64-linux");
        let root = temp.0.join("package");
        std::fs::create_dir_all(root.join(&stem)).unwrap();
        std::os::unix::fs::symlink("/bin/true", root.join(&stem).join("tuig")).unwrap();
        let archive = temp.0.join("archive.tar.gz");
        let status = std::process::Command::new("tar")
            .arg("-czf")
            .arg(&archive)
            .arg("-C")
            .arg(&root)
            .arg(&stem)
            .status()
            .unwrap();
        assert!(status.success());
        let checksum = sha256_hex(&archive).unwrap();
        let bin = temp.0.join("bin");
        std::fs::create_dir(&bin).unwrap();
        let exe = old_executable(&bin);
        let release = Release {
            archive,
            checksum,
            urls: Mutex::new(Vec::new()),
        };

        let error = update_tuig_at("0.1.21", &release, "x86_64-linux", &exe)
            .await
            .unwrap_err();

        assert_eq!(
            error.to_string(),
            "the download does not contain a tuig program"
        );
        assert_eq!(std::fs::read_to_string(&exe).unwrap(), "old-binary");
    }

    #[tokio::test]
    async fn update_removes_scratch_directories_left_by_an_interrupted_update() {
        let temp = TempDir::new("stale");
        let stem = package_stem("v0.2.0", "x86_64-linux");
        let (archive, checksum) = build_package(&temp.0, &stem, 0);
        let bin = temp.0.join("bin");
        std::fs::create_dir(&bin).unwrap();
        let exe = old_executable(&bin);
        let stale = bin.join(".tuig-update-99999999");
        std::fs::create_dir_all(stale.join("unpacked")).unwrap();
        std::fs::write(stale.join("unpacked").join("partial.tar.gz"), "x").unwrap();
        let other_dir = bin.join("other-dir");
        std::fs::create_dir(&other_dir).unwrap();
        let prefixed_file = bin.join(".tuig-update-note");
        std::fs::write(&prefixed_file, "keep").unwrap();
        let release = Release {
            archive,
            checksum,
            urls: Mutex::new(Vec::new()),
        };

        update_tuig_at("0.1.21", &release, "x86_64-linux", &exe)
            .await
            .unwrap();

        assert!(!stale.exists());
        assert!(other_dir.exists());
        assert_eq!(std::fs::read_to_string(&prefixed_file).unwrap(), "keep");
    }

    #[tokio::test]
    async fn update_downloads_nothing_when_current() {
        let fetcher = Fake::new(200, r#"{"tag_name":"v0.1.21"}"#);
        let exe = std::env::temp_dir().join("tuig-update-never-written");
        update_tuig_at("0.1.21", &fetcher, "x86_64-linux", &exe)
            .await
            .unwrap();
        assert!(!exe.exists());
    }

    #[tokio::test]
    async fn asks_the_github_latest_release_endpoint() {
        let fetcher = Fake::new(
            200,
            r#"{"tag_name":"v0.2.0","assets":[{"name":"tuig-0.2.0-x86_64-linux.tar.gz"}]}"#,
        );
        assert_eq!(
            check_for_update("0.1.21", "x86_64-linux", &fetcher)
                .await
                .unwrap(),
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
            check_for_update("0.1.21", "x86_64-linux", &fetcher)
                .await
                .unwrap(),
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

    #[tokio::test]
    async fn offers_no_update_while_the_release_lacks_this_platform_package() {
        // The release job publishes the tag first and uploads each platform later.
        let body = r#"{"tag_name":"v0.2.0","assets":[{"name":"tuig-0.2.0-aarch64-macos.tar.gz"},{"name":"tuig-0.2.0-x86_64-linux.tar.gz.sha256"}]}"#;
        let fetcher = Fake::new(200, body);
        assert_eq!(
            check_for_update("0.1.21", "x86_64-linux", &fetcher)
                .await
                .unwrap(),
            UpdateStatus::NoPackage {
                tag: "v0.2.0".into(),
                platform: "x86_64-linux".into()
            }
        );
        for body in [
            r#"{"tag_name":"v0.2.0"}"#,
            r#"{"tag_name":"v0.2.0","assets":[]}"#,
        ] {
            let fetcher = Fake::new(200, body);
            assert!(matches!(
                check_for_update("0.1.21", "x86_64-linux", &fetcher)
                    .await
                    .unwrap(),
                UpdateStatus::NoPackage { .. }
            ));
        }
    }

    #[tokio::test]
    async fn update_downloads_nothing_when_the_package_is_missing() {
        let fetcher = Fake::new(200, r#"{"tag_name":"v0.2.0","assets":[]}"#);
        let exe = std::env::temp_dir().join("tuig-update-never-written-missing");
        update_tuig_at("0.1.21", &fetcher, "x86_64-linux", &exe)
            .await
            .unwrap();
        assert!(!exe.exists());
    }
}
