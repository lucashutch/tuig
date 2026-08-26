import { describe, expect, test } from "bun:test";
import { getGravatarUrl } from "../../src/ui/avatars.js";
import { getGitHubCommitUrl } from "../../src/ui/avatars.js";

describe("Gravatar URLs", () => {
  test("returns undefined for blank or invalid email addresses", () => {
    expect(getGravatarUrl("  ")).toBeUndefined();
    expect(getGravatarUrl("not-an-email")).toBeUndefined();
  });

  test("normalizes the email before hashing", () => {
    expect(getGravatarUrl("  Ada@Example.com ")).toBe(
      "https://www.gravatar.com/avatar/b5fc85e55755f9e0d030a10ab4429b6b2944855f9a0d60077fe832becbc41d72?s=64&d=404",
    );
  });

  test("uses a stable HTTPS URL with a missing-image fallback", () => {
    const url = getGravatarUrl("ada@example.com");
    expect(url).toStartWith("https://www.gravatar.com/avatar/");
    expect(url).toEndWith("?s=64&d=404");
  });
});

test("GitHub commit URLs use a GitHub origin and commit SHA", () => {
  expect(getGitHubCommitUrl("git@github.com:acme/project.git", "abc123")).toBe(
    "https://api.github.com/repos/acme/project/commits/abc123",
  );
  expect(
    getGitHubCommitUrl("https://github.com/acme/project.git/", "abc123"),
  ).toBe("https://api.github.com/repos/acme/project/commits/abc123");
  expect(
    getGitHubCommitUrl("https://example.com/acme/project.git", "abc123"),
  ).toBeUndefined();
  expect(
    getGitHubCommitUrl("https://notgithub.com/acme/project.git", "abc123"),
  ).toBeUndefined();
});
