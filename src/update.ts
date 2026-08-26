const REPOSITORY = "lucashutch/tuig";
const GIT_SOURCE = `git+https://github.com/${REPOSITORY}.git`;

type ReleaseResponse = { tag_name?: unknown };

export function installSourceForTag(tag: string) {
  return `${GIT_SOURCE}#${tag}`;
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

export async function updateTuig() {
  const tag = await latestReleaseTag();
  const child = Bun.spawn(["bun", "install", "-g", installSourceForTag(tag)], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await child.exited) !== 0)
    throw new Error(`Bun could not install tuig ${tag}`);
}
