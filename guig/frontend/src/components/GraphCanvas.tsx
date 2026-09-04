import React from "react";
import type { Commit } from "../../../shared/types.js";
import type { BranchRef } from "../../../shared/types.js";
import { assignLanes, type RowGraph } from "../lib/graph.js";

export interface GraphCanvasProps {
  commits?: readonly Commit[];
  rows?: readonly RowGraph[];
  refs?: readonly BranchRef[];
  selectedSha?: string | null;
  headSha?: string;
  rowHeight?: number;
  onSelect?: (sha: string) => void;
}

export interface GraphMenuDetail {
  sha: string;
  ref?: string;
}

const LANE_STEP = 16;
const LANE_ORIGIN = 10;

function emit<T>(name: string, detail: T): void {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function LabelIcon({
  remote,
  tag,
}: {
  remote: boolean;
  tag: boolean;
}): React.JSX.Element {
  const glyph = tag ? "🏷" : remote ? "🌐" : "💻";
  const title = tag ? "tag" : remote ? "remote branch" : "local branch";
  return (
    <span title={title} aria-hidden="true" style={{ marginRight: 4 }}>
      {glyph}
    </span>
  );
}

/** SVG lane graph column, one row per commit, aligned by fixed row height. */
export function GraphCanvas(props: GraphCanvasProps): React.JSX.Element {
  const rowHeight = props.rowHeight ?? 28;
  const rows = React.useMemo<readonly RowGraph[]>(() => {
    if (props.rows) return props.rows;
    return assignLanes(props.commits ?? [], {
      refs: props.refs,
      headSha: props.headSha,
    });
  }, [props.rows, props.commits, props.refs, props.headSha]);

  const maxLanes = rows.reduce((n, row) => Math.max(n, row.laneCount), 1);
  const width = LANE_ORIGIN * 2 + (maxLanes - 1) * LANE_STEP;

  return (
    <div role="presentation" aria-label="Commit graph">
      {rows.map((row) => {
        const selected = row.sha === props.selectedSha;
        const x = (lane: number): number => LANE_ORIGIN + lane * LANE_STEP;
        return (
          <div
            key={row.sha}
            data-sha={row.sha}
            onClick={() => props.onSelect?.(row.sha)}
            onDoubleClick={() => {
              if (row.refName && !row.tag)
                emit("guig:checkout-branch", {
                  ref: row.refName,
                  sha: row.sha,
                });
              else emit("guig:checkout-commit", { sha: row.sha });
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              const detail: GraphMenuDetail = { sha: row.sha };
              if (row.refName) detail.ref = row.refName;
              emit("guig:graph-menu", detail);
            }}
            title={row.sha}
            style={{
              display: "flex",
              alignItems: "center",
              height: rowHeight,
              background: selected ? "#2c313c" : "transparent",
              cursor: "pointer",
              overflow: "hidden",
              whiteSpace: "nowrap",
            }}
          >
            <svg
              width={width}
              height={rowHeight}
              aria-hidden="true"
              style={{ flexShrink: 0 }}
            >
              {row.columns.map((laneColor, lane) => (
                <line
                  key={lane}
                  x1={x(lane)}
                  x2={x(lane)}
                  y1={0}
                  y2={rowHeight}
                  stroke={laneColor}
                  strokeOpacity={lane === row.lane ? 1 : 0.55}
                  strokeWidth={2}
                />
              ))}
              {row.edges.map((edge, index) =>
                edge.to !== edge.from ? (
                  <line
                    key={index}
                    x1={x(edge.from)}
                    x2={x(edge.to)}
                    y1={rowHeight / 2}
                    y2={rowHeight}
                    stroke={edge.color}
                    strokeWidth={2}
                  />
                ) : null,
              )}
              {row.head && (
                <circle
                  cx={x(row.lane)}
                  cy={rowHeight / 2}
                  r={8}
                  fill="none"
                  stroke={row.color}
                  strokeWidth={1.5}
                  opacity={0.8}
                />
              )}
              <circle
                cx={x(row.lane)}
                cy={rowHeight / 2}
                r={row.head ? 5 : 4.5}
                fill={row.head ? "#ffffff" : row.color}
                stroke={row.color}
                strokeWidth={2}
              />
            </svg>
            {row.label ? (
              <span
                data-ref={row.refName}
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  if (row.refName && !row.tag)
                    emit("guig:checkout-branch", {
                      ref: row.refName,
                      sha: row.sha,
                    });
                  else emit("guig:checkout-commit", { sha: row.sha });
                }}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  fontSize: 12,
                  color: "#abb2bf",
                  background: "#3e4451",
                  borderRadius: 4,
                  padding: "1px 6px",
                  marginLeft: 2,
                  maxWidth: 220,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                <LabelIcon remote={row.remote} tag={row.tag} />
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {row.label}
                </span>
                {row.extra > 0 && (
                  <span style={{ marginLeft: 4, color: "#7f848e" }}>
                    +{row.extra}
                  </span>
                )}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
