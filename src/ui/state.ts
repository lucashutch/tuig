import type { RepositorySnapshot } from "../git/types.js";
export type Panel = "sidebar" | "history" | "details";
export interface UiState {
  snapshot: RepositorySnapshot | null;
  focus: Panel;
  selectedCommit: number;
  selectedFile: number;
  fileMode: "staged" | "unstaged";
  scroll: number;
  composing: boolean;
  message: string;
  menu?: import("./menu.js").ContextMenu;
  modal?: { title: string; question: string };
  status: string;
}
export function initialState(): UiState {
  return {
    snapshot: null,
    focus: "history",
    selectedCommit: 0,
    selectedFile: 0,
    fileMode: "unstaged",
    scroll: 0,
    composing: false,
    message: "",
    status: "Ready",
  };
}
export function selectFile(
  state: UiState,
  index: number,
  mode = state.fileMode,
): UiState {
  return { ...state, selectedFile: Math.max(0, index), fileMode: mode };
}
export function toggleFileMode(state: UiState): UiState {
  return {
    ...state,
    fileMode: state.fileMode === "staged" ? "unstaged" : "staged",
    selectedFile: 0,
  };
}
