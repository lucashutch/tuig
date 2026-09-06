/** Limits apply to display only. Git mutations still read complete patches. */
export const DIFF_HIGHLIGHT_MAX_BYTES = 1024 * 1024;
export const DIFF_HIGHLIGHT_MAX_LINES = 20_000;
export const DIFF_DISPLAY_MAX_BYTES = 5 * 1024 * 1024;

export function canHighlightDiff(value: string): boolean {
  if (Buffer.byteLength(value, "utf8") >= DIFF_HIGHLIGHT_MAX_BYTES)
    return false;
  let lines = 1;
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) === 10 && ++lines >= DIFF_HIGHLIGHT_MAX_LINES)
      return false;
  }
  return true;
}
