import React from "react";
import type { DiffRequest } from "../../../shared/types.js";
import type { GuigApi } from "../../../shared/ipc.js";

export interface DiffViewerProps {
  /** Controlled diff text. When omitted with commitSha/path, the viewer fetches. */
  diffText?: string;
  commitSha?: string;
  path?: string;
  staged?: boolean;
  fetchDiff?: (request: DiffRequest) => Promise<string>;
  loading?: boolean;
  error?: string | null;
  contextLines?: number;
  onContextChange?: (context: number) => void;
  autoScroll?: boolean;
}

const CONTEXT_CHOICES = [1, 3, 10, 25];

interface DiffLine {
  kind: "file" | "hunk" | "add" | "del" | "context" | "meta";
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

function parseDiff(text: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const raw of text.split("\n")) {
    if (raw.startsWith("@@")) {
      const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      oldNo = match ? Number(match[1]) : 0;
      newNo = match ? Number(match[2]) : 0;
      out.push({ kind: "hunk", text: raw, oldNo: null, newNo: null });
    } else if (
      raw.startsWith("diff --git") ||
      raw.startsWith("index ") ||
      raw.startsWith("--- ") ||
      raw.startsWith("+++ ") ||
      raw.startsWith("new file") ||
      raw.startsWith("deleted file") ||
      raw.startsWith("similarity") ||
      raw.startsWith("rename ")
    ) {
      out.push({ kind: "file", text: raw, oldNo: null, newNo: null });
    } else if (raw.startsWith("+") && !raw.startsWith("+++")) {
      out.push({ kind: "add", text: raw, oldNo: null, newNo: newNo++ });
    } else if (raw.startsWith("-") && !raw.startsWith("---")) {
      out.push({ kind: "del", text: raw, oldNo: oldNo++, newNo: null });
    } else if (raw.startsWith("\\")) {
      out.push({ kind: "meta", text: raw, oldNo: null, newNo: null });
    } else {
      const line = raw.startsWith(" ") ? raw : ` ${raw}`;
      out.push({ kind: "context", text: line, oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return out;
}

function defaultFetcher(request: DiffRequest): Promise<string> {
  const api = (window as unknown as { guig?: GuigApi }).guig;
  if (!api) return Promise.reject(new Error("guig backend not connected"));
  return api.diff(request);
}

/** Syntax-tinted unified diff with hunk headers, line numbers, and context toggle. */
export function DiffViewer(props: DiffViewerProps): React.JSX.Element {
  const [fetched, setFetched] = React.useState("");
  const [fetching, setFetching] = React.useState(false);
  const [fetchError, setFetchError] = React.useState<string | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const controlled = props.diffText !== undefined;
  const fetchDiff = props.fetchDiff ?? defaultFetcher;

  React.useEffect(() => {
    if (controlled) return;
    if (
      !props.commitSha &&
      props.path === undefined &&
      props.staged === undefined
    )
      return;
    let cancelled = false;
    setFetching(true);
    setFetchError(null);
    const request: DiffRequest = {
      commit: props.commitSha,
      path: props.path,
      staged: props.staged,
      context: props.contextLines,
    };
    void fetchDiff(request).then(
      (text) => {
        if (cancelled) return;
        setFetched(text);
        setFetching(false);
      },
      (failure: unknown) => {
        if (cancelled) return;
        setFetchError(
          failure instanceof Error ? failure.message : String(failure),
        );
        setFetching(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [
    controlled,
    props.commitSha,
    props.path,
    props.staged,
    props.contextLines,
    fetchDiff,
  ]);

  const text = controlled ? (props.diffText ?? "") : fetched;
  const loading = props.loading ?? fetching;
  const error = props.error ?? fetchError;
  const lines = React.useMemo(() => parseDiff(text), [text]);

  React.useEffect(() => {
    if (props.autoScroll === false) return;
    const node = scrollRef.current;
    if (node) node.scrollTop = 0;
  }, [text, props.autoScroll]);

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      {props.onContextChange && (
        <div
          style={{
            display: "flex",
            gap: 4,
            alignItems: "center",
            padding: "4px 8px",
            borderBottom: "1px solid #3e4451",
            fontSize: 12,
            color: "#7f848e",
          }}
        >
          <span>Context</span>
          {CONTEXT_CHOICES.map((choice) => (
            <button
              key={choice}
              type="button"
              onClick={() => props.onContextChange?.(choice)}
              style={{
                background:
                  props.contextLines === choice ? "#61afef" : "#3e4451",
                color: props.contextLines === choice ? "#282c34" : "#abb2bf",
                border: "none",
                borderRadius: 4,
                padding: "1px 8px",
                cursor: "pointer",
              }}
            >
              {choice}
            </button>
          ))}
        </div>
      )}
      <div
        ref={scrollRef}
        style={{
          overflowY: "auto",
          fontFamily: "monospace",
          fontSize: 12,
          lineHeight: 1.5,
        }}
      >
        {loading && (
          <div style={{ padding: 8, color: "#7f848e" }}>Loading diff…</div>
        )}
        {error && <div style={{ padding: 8, color: "#ef596f" }}>{error}</div>}
        {!loading && !error && lines.length === 0 && (
          <div style={{ padding: 8, color: "#7f848e" }}>No changes.</div>
        )}
        {!loading &&
          !error &&
          lines.map((line, index) => (
            <div
              key={index}
              style={{
                display: "flex",
                background: rowBackground(line.kind),
                color: rowColor(line.kind),
                paddingLeft: 8,
                whiteSpace: "pre",
              }}
            >
              <span
                style={{
                  width: 44,
                  flexShrink: 0,
                  textAlign: "right",
                  paddingRight: 8,
                  color: "#5c6370",
                  userSelect: "none",
                }}
              >
                {line.oldNo ?? ""}
              </span>
              <span
                style={{
                  width: 44,
                  flexShrink: 0,
                  textAlign: "right",
                  paddingRight: 8,
                  color: "#5c6370",
                  userSelect: "none",
                }}
              >
                {line.newNo ?? ""}
              </span>
              <span style={{ flex: 1 }}>{line.text}</span>
            </div>
          ))}
      </div>
    </div>
  );
}

function rowBackground(kind: DiffLine["kind"]): string {
  switch (kind) {
    case "add":
      return "rgba(152, 195, 121, 0.12)";
    case "del":
      return "rgba(239, 89, 111, 0.12)";
    case "hunk":
      return "#2c313c";
    case "file":
      return "#21252b";
    default:
      return "transparent";
  }
}

function rowColor(kind: DiffLine["kind"]): string {
  switch (kind) {
    case "add":
      return "#98c379";
    case "del":
      return "#ef596f";
    case "hunk":
      return "#61afef";
    case "file":
      return "#abb2bf";
    case "meta":
      return "#5c6370";
    default:
      return "#abb2bf";
  }
}
