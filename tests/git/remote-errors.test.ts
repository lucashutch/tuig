import { describe, expect, test } from "bun:test";
import {
  classifyRemoteAuthFailure,
  describeRemoteAuthFailure,
} from "../../src/git/remote-errors.js";

// Samples are real git and OpenSSH output.
const HTTPS_NO_PROMPT =
  "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n";
const HTTPS_NO_PASSWORD =
  "fatal: could not read Password for 'https://user@git.example.com': terminal prompts disabled\n";
const HTTPS_BAD_PASSWORD =
  "remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/acme/widgets.git/'\n";
const SSH_PUBLICKEY =
  "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n";
const SSH_HOST_KEY =
  "No ED25519 host key is known for git.example.com and you have requested strict checking.\nHost key verification failed.\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n";
const SSH_HOST_CHANGED =
  "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\nOffending ECDSA key in /home/u/.ssh/known_hosts:3\nHost key verification failed.\nfatal: Could not read from remote repository.\n";
const NETWORK =
  "fatal: unable to access 'https://github.com/acme/widgets.git/': Could not resolve host: github.com\n";
const MISSING_REPO =
  "remote: Repository not found.\nfatal: repository 'https://github.com/acme/nope.git/' not found\n";
const REJECTED =
  "To github.com:acme/widgets.git\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to 'github.com:acme/widgets.git'\n";
const BARE_READ_FAILURE =
  "ssh: connect to host github.com port 22: Connection timed out\nfatal: Could not read from remote repository.\n";

describe("classifyRemoteAuthFailure", () => {
  test("recognises HTTPS credential failures and finds the host", () => {
    expect(classifyRemoteAuthFailure(HTTPS_NO_PROMPT)).toEqual({
      kind: "credentials",
      host: "github.com",
    });
    expect(classifyRemoteAuthFailure(HTTPS_NO_PASSWORD)).toEqual({
      kind: "credentials",
      host: "git.example.com",
    });
    expect(classifyRemoteAuthFailure(HTTPS_BAD_PASSWORD)).toEqual({
      kind: "credentials",
      host: "github.com",
    });
  });

  test("recognises SSH key rejection", () => {
    expect(classifyRemoteAuthFailure(SSH_PUBLICKEY)).toEqual({
      kind: "credentials",
      host: "github.com",
    });
  });

  test("separates host key problems from missing credentials", () => {
    expect(classifyRemoteAuthFailure(SSH_HOST_KEY)).toEqual({
      kind: "host-key",
      host: "git.example.com",
    });
    expect(classifyRemoteAuthFailure(SSH_HOST_CHANGED)?.kind).toBe(
      "host-key-changed",
    );
  });

  test("ignores network errors, missing repositories, and rejected pushes", () => {
    for (const stderr of [NETWORK, MISSING_REPO, REJECTED, BARE_READ_FAILURE])
      expect(classifyRemoteAuthFailure(stderr)).toBeUndefined();
  });
});

describe("describeRemoteAuthFailure", () => {
  test("names the remote and host when both are known", () => {
    expect(
      describeRemoteAuthFailure(
        "push",
        { kind: "credentials", host: "github.com" },
        "origin",
      ),
    ).toBe(
      "Push needs credentials for origin (github.com). Set up a credential helper or an SSH key in an agent.",
    );
  });

  test("falls back to the host, then to a generic name", () => {
    expect(
      describeRemoteAuthFailure("fetch", { kind: "credentials", host: "h.io" }),
    ).toContain("for h.io.");
    expect(describeRemoteAuthFailure("pull", { kind: "host-key" })).toContain(
      "host key for the remote",
    );
  });
});
