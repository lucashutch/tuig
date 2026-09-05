const REPOSITORY = "lucashutch/tuig";
const GIT_SOURCE = `git+https://github.com/${REPOSITORY}.git`;

type ReleaseResponse = { tag_name?: unknown };

export function installSourceForTag(tag: string) {
  // Name the existing dependency explicitly so Bun replaces its Git resolution.
  return `tuig@${GIT_SOURCE}#${tag}`;
}

export function isCurrentRelease(version: string, tag: string) {
  return tag.replace(/^v/, "") === version.replace(/^v/, "");
}

export async function latestReleaseTag(
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const response = await fetcher(
    `https://api.github.com/repos/${REPOSITORY}/releases/latest`,
    { headers: { Accept: "application/vnd.github+json" } },
  );
  if (!response.ok)
    throw new Error(
      `GitHub could not find the latest release (HTTP ${response.status})`,
    );

  const release = (await response.json()) as ReleaseResponse;
  if (typeof release.tag_name !== "string" || !release.tag_name)
    throw new Error("GitHub returned a release without a tag");
  return release.tag_name;
}

export async function updateTuig(currentVersion: string) {
  console.log("Checking for updates...");
  const tag = await latestReleaseTag();
  if (isCurrentRelease(currentVersion, tag)) {
    console.log("Tuig is up to date.");
    return;
  }

  console.log(`Update found (${tag}). Upgrading...`);
  const child = Bun.spawn(["bun", "install", "-g", installSourceForTag(tag)], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    const details = stderr.trim() || stdout.trim();
    throw new Error(
      `Bun could not install tuig ${tag} (exit ${exitCode})${details ? `:\n${details}` : "."}`,
    );
  }
  console.log(`Tuig ${tag} is ready.`);
}
