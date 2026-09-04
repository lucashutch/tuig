import React from "react";
import type { BranchRef, Commit } from "../../../shared/types.js";
import { GraphCanvas } from "./GraphCanvas.js";

export interface HistoryPaneProps {
  commits: readonly Commit[];
  refs?: readonly BranchRef[];
  selectedSha?: string | null;
  headSha?: string;
  hasMore?: boolean;
  loadingMore?: boolean;
  rowHeight?: number;
  onSelect?: (sha: string) => void;
  onLoadMore?: () => void;
}

export function shortSha(sha: string, length = 8): string {
  return sha.slice(0, length);
}

export function formatRelativeTime(value: string, now = Date.now()): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "unknown time";
  const seconds = Math.round((now - timestamp) / 1000);
  const future = seconds < 0;
  const amount = Math.abs(seconds);
  if (amount < 10) return future ? "in a moment" : "just now";
  const units: Array<[number, string]> = [
    [60, "s"],
    [60, "m"],
    [24, "h"],
    [7, "d"],
    [4, "w"],
    [12, "mo"],
    [Number.POSITIVE_INFINITY, "y"],
  ];
  let rest = amount;
  let unit = "s";
  for (const [size, name] of units) {
    unit = name;
    if (rest < size) break;
    rest = Math.floor(rest / size);
  }
  return future ? `in ${rest}${unit}` : `${rest}${unit} ago`;
}

function copySha(sha: string): void {
  void navigator.clipboard?.writeText(sha).catch(() => undefined);
}

/**
 * Scrollable history list with a lane graph column aligned row-for-row.
 * Paging is caller-driven via `onLoadMore` (wired to `commitPage`).
 */
export function HistoryPane(props: HistoryPaneProps): React.JSX.Element {
  const rowHeight = props.rowHeight ?? 28;
  const listRef = React.useRef<HTMLDivElement>(null);

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === "Enter" && props.selectedSha) {
      event.preventDefault();
      window.dispatchEvent(
        new CustomEvent("guig:inspect-commit", {
          detail: { sha: props.selectedSha },
        }),
      );
    } else if (event.key === "Escape") {
      event.preventDefault();
      window.dispatchEvent(new CustomEvent("guig:return-workcopy"));
    }
  };

  return (
    <div
      ref={listRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      aria-label="History"
      style={{ outline: "none", overflowY: "auto", maxHeight: "100%" }}
    >
      <div style={{ display: "flex", alignItems: "stretch" }}>
        <GraphCanvas
          commits={props.commits}
          refs={props.refs}
          selectedSha={props.selectedSha}
          headSha={props.headSha}
          rowHeight={rowHeight}
          onSelect={props.onSelect}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          {props.commits.map((commit) => {
            const selected = commit.sha === props.selectedSha;
            return (
              <div
                key={commit.sha}
                onClick={() => props.onSelect?.(commit.sha)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  height: rowHeight,
                  padding: "0 8px",
                  background: selected ? "#2c313c" : "transparent",
                  cursor: "pointer",
                  overflow: "hidden",
                  whiteSpace: "nowrap",
                }}
              >
                <span
                  title={commit.subject}
                  style={{
                    flex: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    color: "#d7dae0",
                    fontSize: 13,
                  }}
                >
                  {commit.subject}
                </span>
                <span style={{ color: "#7f848e", fontSize: 12 }}>
                  {commit.author}
                </span>
                <button
                  type="button"
                  title={`Copy ${commit.sha}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    copySha(commit.sha);
                  }}
                  style={{
                    background: "none",
                    border: "none",
                    color: "#61afef",
                    cursor: "pointer",
                    fontFamily: "monospace",
                    fontSize: 12,
                    padding: 0,
                  }}
                >
                  {shortSha(commit.sha)}
                </button>
                <span style={{ color: "#5c6370", fontSize: 12 }}>
                  {formatRelativeTime(commit.authoredAt)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      {props.hasMore && (
        <div style={{ padding: 8, textAlign: "center" }}>
          <button
            type="button"
            disabled={props.loadingMore}
            onClick={() => props.onLoadMore?.()}
            style={{
              background: "#3e4451",
              color: "#d7dae0",
              border: "1px solid #4b5263",
              borderRadius: 4,
              padding: "4px 12px",
              cursor: props.loadingMore ? "wait" : "pointer",
            }}
          >
            {props.loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}
