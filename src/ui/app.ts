import type { GitRepository, RepositorySnapshot } from "../git/types.js";
import { oneDarkTheme, type Theme } from "./theme.js";
import { initialState, type UiState } from "./state.js";
import { contextMenu } from "./menu.js";
import { layoutGraph, type GraphRow } from "./graph.js";

export interface TuigApp {
  readonly state: UiState;
  readonly graph: GraphRow[];
  refresh(): Promise<void>;
  dispatch(action: UiAction): Promise<void>;
  render(width?: number, height?: number): string;
}
export type UiAction =
  | { type: "focus"; panel: UiState["focus"] }
  | { type: "select-commit"; index: number }
  | { type: "toggle-files" }
  | { type: "menu"; kind: "commit" | "branch" | "file"; x?: number; y?: number }
  | { type: "compose"; value?: string };

export function createTuigApp(
  repository: GitRepository,
  theme: Theme = oneDarkTheme,
): TuigApp {
  const state = initialState();
  let graph: GraphRow[] = [];
  const refresh = async () => {
    state.snapshot = await repository.snapshot(1000);
    graph = layoutGraph(state.snapshot.commits, theme.graph);
    state.status = `Loaded ${graph.length} commits`;
  };
  const dispatch = async (a: UiAction) => {
    if (a.type === "focus") state.focus = a.panel;
    else if (a.type === "select-commit")
      state.selectedCommit = Math.max(0, Math.min(a.index, graph.length - 1));
    else if (a.type === "toggle-files")
      state.fileMode = state.fileMode === "staged" ? "unstaged" : "staged";
    else if (a.type === "menu") state.menu = contextMenu(a.kind, a.x, a.y);
    else if (a.type === "compose") {
      state.composing = true;
      state.message = a.value ?? state.message;
    }
  };
  const render = (width = 120, height = 30) => {
    const s = state.snapshot;
    const branch = s?.branch ?? "No repository";
    const rows = graph
      .slice(state.scroll, state.scroll + Math.max(1, height - 6))
      .map((r) => `${r.laneColors[0] ? "●" : "·"} ${r.commit.subject}`)
      .join("\n");
    return `TUIG  ${branch}\n${"─".repeat(Math.max(1, width))}\nBranches   │ History\n${rows}\n${"─".repeat(Math.max(1, width))}\n${state.status}  ${state.composing ? "COMMIT: " + state.message : "Space stage  c commit  q quit"}`;
  };
  return {
    state,
    get graph() {
      return graph;
    },
    refresh,
    dispatch,
    render,
  };
}
export { oneDarkTheme } from "./theme.js";
export type { RepositorySnapshot };
