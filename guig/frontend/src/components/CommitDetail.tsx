import React from "react";
import type { ChangedFile, Commit } from "../../../shared/types.js";
import type { GuigApi } from "../../../shared/ipc.js";
import { formatRelativeTime, shortSha } from "./HistoryPane.js";

export interface CommitDetailProps {
  commit?: Commit | null;
  getCommitFiles?: (sha: string) => Promise<ChangedFile[]>;
  selectedPath?: string | null;
  onSelectFile?: (path: string) => void;
}

function defaultFetcher(sha: string): Promise<ChangedFile[]> {
  const api = (window as unknown as { guig?: GuigApi }).guig;
  if (!api) return Promise.reject(new Error("guig backend not connected"));
  return api.commitFiles(sha);
}

/** Metadata plus changed-file list for the selected commit. */
export function CommitDetail(props: CommitDetailProps): React.JSX.Element {
  const commit = props.commit;
  const [files, setFiles] = React.useState<ChangedFile[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!commit) {
      setFiles([]);
      setError(null);
      setLoading(false);
      return;
    }
    const fetchFiles = props.getCommitFiles ?? defaultFetcher;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void fetchFiles(commit.sha).then(
      (result) => {
        if (cancelled) return;
        setFiles(result);
        setLoading(false);
      },
      (failure: unknown) => {
        if (cancelled) return;
        setError(failure instanceof Error ? failure.message : String(failure));
        setFiles([]);
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [commit, props.getCommitFiles]);

  if (!commit) {
    return (
      <div style={{ padding: 12, color: "#7f848e", fontSize: 13 }}>
        Working copy. Select a commit to inspect it.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ padding: "8px 12px", borderBottom: "1px solid #3e4451" }}>
        <div style={{ color: "#d7dae0", fontSize: 13, fontWeight: 600 }}>
          {commit.subject}
        </div>
        {commit.body && (
          <div
            style={{
              color: "#7f848e",
              fontSize: 12,
              whiteSpace: "pre-wrap",
              marginTop: 4,
            }}
          >
            {commit.body}
          </div>
        )}
        <div
          style={{
            display: "flex",
            gap: 8,
            marginTop: 6,
            color: "#5c6370",
            fontSize: 12,
            flexWrap: "wrap",
          }}
        >
          <span>{commit.author}</span>
          <span title={commit.sha} style={{ fontFamily: "monospace" }}>
            {shortSha(commit.sha)}
          </span>
          <span>{formatRelativeTime(commit.committedAt)}</span>
        </div>
      </div>
      <div style={{ overflowY: "auto", padding: 4 }}>
        {loading && (
          <div style={{ padding: 8, color: "#7f848e", fontSize: 12 }}>
            Loading files…
          </div>
        )}
        {error && (
          <div style={{ padding: 8, color: "#ef596f", fontSize: 12 }}>
            {error}
          </div>
        )}
        {!loading &&
          !error &&
          files.map((file) => {
            const active = file.path === props.selectedPath;
            return (
              <button
                key={file.path}
                type="button"
                onClick={() => props.onSelectFile?.(file.path)}
                title={file.originalPath ?? file.path}
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  width: "100%",
                  textAlign: "left",
                  background: active ? "#2c313c" : "transparent",
                  border: "none",
                  borderRadius: 4,
                  color: "#abb2bf",
                  cursor: "pointer",
                  fontSize: 12,
                  padding: "3px 8px",
                  overflow: "hidden",
                }}
              >
                <span
                  style={{
                    color: stateColor(file.state),
                    fontWeight: 700,
                    width: 14,
                    flexShrink: 0,
                  }}
                >
                  {stateGlyph(file.state)}
                </span>
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {file.path}
                </span>
              </button>
            );
          })}
        {!loading && !error && files.length === 0 && (
          <div style={{ padding: 8, color: "#7f848e", fontSize: 12 }}>
            No changed files.
          </div>
        )}
      </div>
    </div>
  );
}

function stateGlyph(state: ChangedFile["state"]): string {
  switch (state) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "copied":
      return "C";
    case "conflicted":
      return "!";
    case "untracked":
      return "?";
    default:
      return "M";
  }
}

function stateColor(state: ChangedFile["state"]): string {
  switch (state) {
    case "added":
      return "#98c379";
    case "deleted":
      return "#ef596f";
    case "conflicted":
      return "#e5c07b";
    default:
      return "#61afef";
  }
}
