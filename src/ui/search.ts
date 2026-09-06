import type { Commit } from "../git/types.js";
import { DEFAULT_HISTORY_PAGE } from "../git/repository.js";
import { packGraphRow, type GraphRow } from "./graph.js";
import { oneDarkTheme } from "./theme.js";

/**
 * Delay between the last keystroke and the search running.
 *
 * Every run is a full history walk, which is under a second on a 140k-commit
 * repository but far too expensive to repeat per character.
 */
export const SEARCH_DEBOUNCE_MS = 180;

/** Result records read per page as the reader scrolls the matches. */
export const SEARCH_PAGE = DEFAULT_HISTORY_PAGE;

/** Results paged into the history pane while a query is showing. */
export interface RuntimeSearchResults {
  query: string;
  /** Every matching commit in the repository, newest first. */
  shas: string[];
  /** Records read so far, a prefix of `shas`. */
  commits: Commit[];
  rows: GraphRow[];
}

/**
 * Rows for a list of search results.
 *
 * Matches come from anywhere in history, so the commits between them are not
 * on screen and there is no ancestry to draw. Each result gets a single dot in
 * one lane rather than lanes that would connect rows which are not parent and
 * child.
 */
export function searchGraphRows(
  commits: readonly Commit[],
  headSha?: string,
): GraphRow[] {
  const color = oneDarkTheme.graph[0] ?? oneDarkTheme.accent;
  return commits.map((commit) => {
    const head = commit.sha === headSha;
    return packGraphRow({
      commit,
      lane: 0,
      head,
      continuesAbove: false,
      cells: [{ symbol: head ? "◉ " : "● ", color }],
      connectors: [],
    });
  });
}
