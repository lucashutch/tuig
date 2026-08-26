import { StyledText, fg } from "@opentui/core";
import type { ChangedFile, Commit, FileState } from "../git/types.js";
import { authorAvatar, shortSha } from "./history.js";
import {
  clipColumns,
  fileViewportSize,
  wrappedLineCount,
} from "./runtime-presentation-text.js";
import { oneDarkTheme } from "./theme.js";

export type CommitCoAuthor = { name: string; email: string };

export function parseCoAuthors(body = ""): CommitCoAuthor[] {
  const authors: CommitCoAuthor[] = [];
  const pattern = /^Co-authored-by:\s*(.*?)\s*<([^<>\r\n]+)>\s*$/gim;
  for (const match of body.matchAll(pattern)) {
    const name = match[1]?.trim();
    const email = match[2]?.trim();
    if (name && email) authors.push({ name, email });
  }
  return authors;
}

export function presentCommitCoAuthors(
  coAuthors: readonly CommitCoAuthor[],
  providerEmails: ReadonlySet<string> = new Set(),
): StyledText {
  if (!coAuthors.length) return new StyledText([]);
  return new StyledText([
    fg(oneDarkTheme.muted)("Co-authors: "),
    ...coAuthors.flatMap((author, index) => [
      ...(providerEmails.has(author.email.toLowerCase())
        ? []
        : [fg(oneDarkTheme.author)(authorAvatar(author.name, author.email))]),
      fg(oneDarkTheme.text)(
        `${providerEmails.has(author.email.toLowerCase()) ? "" : " "}${author.name}`,
      ),
      ...(index < coAuthors.length - 1 ? [fg(oneDarkTheme.muted)("  ")] : []),
    ]),
  ]);
}

export function formatCommitDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function presentCommitMeta(commit: Commit): {
  info: StyledText;
  header: string;
  body: string;
} {
  const body = commit.body?.replace(/^(?:[ \t]*\n)+/, "") || "(no body)";
  const committer = `${commit.committer}${commit.committerEmail ? ` <${commit.committerEmail}>` : ""}`;
  const lines = [
    commit.author,
    ...(commit.authorEmail ? [commit.authorEmail] : []),
    formatCommitDate(commit.authoredAt),
    ...(commit.parents.length
      ? [
          `Parent: ${commit.parents.map((parent) => shortSha(parent)).join(", ")}`,
        ]
      : []),
  ];
  if (
    commit.committer !== commit.author ||
    commit.committerEmail !== commit.authorEmail
  ) {
    lines.push(
      `Committed by ${committer}`,
      `Committed: ${formatCommitDate(commit.committedAt)}`,
    );
  }
  return {
    info: new StyledText([
      fg(oneDarkTheme.text)(lines[0] ?? ""),
      fg(oneDarkTheme.muted)(
        lines
          .slice(1)
          .map((line) => `\n${line}`)
          .join(""),
      ),
    ]),
    header: commit.subject,
    body,
  };
}

/**
 * The fixed top row used by a commit diff in the details pane.
 *
 * Keep this here, next to the other pane geometry helpers, rather than in the
 * widget layer.  A commit detail is a single surface: opening a file diff
 * must not require replacing the graph/history pane with a second view.
 */
export const COMMIT_DETAIL_DIFF_TOP = 2;

export type CommitDetailMetadata = {
  info: StyledText;
  sha: string;
  shortSha: string;
  author: string;
  authorEmail: string;
  authoredAt: string;
  committer: string;
  committerEmail: string;
  committedAt: string;
};

export type CommitDetailMessage = {
  subject: string;
  body: string;
};

export type CommitChangedFilesSummary = {
  files: readonly ChangedFile[];
  count: number;
  summary: string;
  byState: Record<FileState, number>;
};

export type CommitDetailBanner = {
  visible: boolean;
  fileCount: number;
  rows: number;
  text: string | undefined;
  lines: string[];
};

export type CommitDetailLayout = {
  bannerRows: number;
  messageTop: number;
  messageHeight: number;
  metadataTop: number;
  metadataHeight: number;
  changedFilesTop: number;
  changedFilesHeight: number;
  diffTop: number;
  diffHeight: number;
};

export type CommitDetailLayoutInput = {
  commit: Commit;
  detailsWidth: number;
  terminalHeight: number;
  workingFileCount: number;
};

/**
 * Calculate the stable vertical order of a commit detail surface.
 *
 * The message and metadata precede the changed-file list.  The diff itself is
 * positioned independently at the bottom of the details pane, which lets the
 * history/graph remain visible while a file diff is open.  This also keeps the
 * working-tree escape banner in the same geometry calculation as the rest of
 * the commit surface.
 */
export function layoutCommitDetail({
  commit,
  detailsWidth,
  terminalHeight,
  workingFileCount,
}: CommitDetailLayoutInput): CommitDetailLayout {
  const width = Math.max(10, Math.floor(detailsWidth) - 8);
  const height = Math.max(0, Math.floor(terminalHeight));
  const body = presentCommitMeta(commit).body;
  // Measure the text that is actually rendered. In particular, formatted
  // dates and the avatar can wrap where the raw commit values would not, and
  // duplicate committer rows are not rendered at all.
  const metadataValue = presentCommitMeta(commit)
    .info.chunks.map((chunk) => chunk.text)
    .join("");
  const messageHeight =
    wrappedLineCount(commit.subject, width) +
    Math.min(15, wrappedLineCount(body, width)) +
    3;
  const metadataHeight = Math.max(
    5,
    wrappedLineCount(metadataValue, width) + 1,
  );
  const bannerRows = workingChangesBannerRows(workingFileCount);
  const metadataTop = bannerRows + messageHeight + 1;
  const changedFilesTop = metadataTop + metadataHeight + 1;
  return {
    bannerRows,
    messageTop: bannerRows,
    messageHeight,
    metadataTop,
    metadataHeight,
    changedFilesTop,
    changedFilesHeight: fileViewportSize("commit", height, changedFilesTop),
    diffTop: COMMIT_DETAIL_DIFF_TOP,
    diffHeight: Math.max(1, height - COMMIT_DETAIL_DIFF_TOP - 1),
  };
}

export type CommitDetailPresentationInput = {
  commit: Commit;
  changedFiles?: readonly ChangedFile[];
  /** Number of working-tree files available through the escape banner. */
  workingFileCount?: number;
  /** Width of the details pane, excluding no border cells. */
  detailsWidth?: number;
  terminalHeight?: number;
  /** Whether a selected changed file's diff is currently open. */
  diffOpen?: boolean;
};

export type CommitDetailPresentation = {
  /** Stable identity for consumers that need to distinguish this surface. */
  surface: "commit-detail";
  /** The graph remains present while details and a file diff are shown. */
  history: { visible: true; selectedSha: string };
  commitSha: string;
  metadata: CommitDetailMetadata;
  message: CommitDetailMessage;
  changedFiles: CommitChangedFilesSummary;
  layout: CommitDetailLayout;
  diff: {
    visible: boolean;
    mode: "placeholder" | "open";
    top: number;
    height: number;
    emptyMessage: string;
    workingChangesBanner: CommitDetailBanner;
  };
};

const COMMIT_FILE_STATES: readonly FileState[] = [
  "modified",
  "added",
  "deleted",
  "renamed",
  "copied",
  "untracked",
  "conflicted",
];

/**
 * Build all content and geometry for one commit detail surface.
 *
 * `presentCommitMeta` remains the compatibility API used by the runtime.  The
 * richer model composes it instead of changing its shape, so existing widget
 * integration can continue to consume `info`, `header`, and `body` while new
 * callers get files, diff layout, and the working-tree banner together.
 */
export function presentCommitDetail({
  commit,
  changedFiles = [],
  workingFileCount: requestedWorkingFileCount = 0,
  detailsWidth: requestedDetailsWidth = 80,
  terminalHeight: requestedTerminalHeight = 24,
  diffOpen = false,
}: CommitDetailPresentationInput): CommitDetailPresentation {
  const files = [...changedFiles];
  const workingFileCount = Math.max(0, Math.floor(requestedWorkingFileCount));
  const detailsWidth = Math.max(1, Math.floor(requestedDetailsWidth));
  const terminalHeight = Math.max(0, Math.floor(requestedTerminalHeight));
  const byState = Object.fromEntries(
    COMMIT_FILE_STATES.map((state) => [
      state,
      files.filter((file) => file.state === state).length,
    ]),
  ) as Record<FileState, number>;
  const count = files.length;
  const summary =
    count === 0
      ? "No changed files"
      : `${count} changed file${count === 1 ? "" : "s"}`;
  const meta = presentCommitMeta(commit);
  const layout = layoutCommitDetail({
    commit,
    detailsWidth,
    terminalHeight,
    workingFileCount,
  });
  const banner: CommitDetailBanner = {
    visible: workingFileCount > 0,
    fileCount: workingFileCount,
    rows: workingChangesBannerRows(workingFileCount),
    text: workingChangesBanner(workingFileCount),
    lines: workingChangesBannerLines(
      workingFileCount,
      Math.max(1, detailsWidth - 2),
    ),
  };
  return {
    surface: "commit-detail",
    history: { visible: true, selectedSha: commit.sha },
    commitSha: commit.sha,
    metadata: {
      info: meta.info,
      sha: commit.sha,
      shortSha: shortSha(commit.sha),
      author: commit.author,
      authorEmail: commit.authorEmail,
      authoredAt: commit.authoredAt,
      committer: commit.committer,
      committerEmail: commit.committerEmail,
      committedAt: commit.committedAt,
    },
    message: { subject: meta.header, body: meta.body },
    changedFiles: { files, count, summary, byState },
    layout,
    diff: {
      visible: diffOpen,
      mode: diffOpen ? "open" : "placeholder",
      top: layout.diffTop,
      height: layout.diffHeight,
      emptyMessage:
        count > 0
          ? "Select a changed file to open its diff."
          : "This commit has no textual diff to display.",
      workingChangesBanner: banner,
    },
  };
}

/** Copy for the commit-inspection escape hatch back to working changes. */
export function workingChangesBanner(fileCount: number): string | undefined {
  if (fileCount <= 0) return undefined;
  return `${fileCount} file change${fileCount === 1 ? "" : "s"} in working directory  ·  View Changes`;
}

/** The notice is deliberately two rows: the action can never be clipped away. */
export function workingChangesBannerLines(
  fileCount: number,
  width: number,
): string[] {
  if (fileCount <= 0) return [];
  return [
    clipColumns(
      `${fileCount} file change${fileCount === 1 ? "" : "s"} in working directory`,
      Math.max(1, width),
    ),
    clipColumns("View Changes", Math.max(1, width)),
  ];
}

/** The banner's geometry derives from repository state, never stale widgets. */
export function workingChangesBannerRows(fileCount: number): number {
  return fileCount > 0 ? 2 : 0;
}
