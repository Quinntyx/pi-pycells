/** Eight-line execution preview with two following context lines when available.
 * Backward motion scrolls only when the marker leaves the window; no top margin
 * is reserved. Short loops therefore reuse the viewport instead of bouncing.
 */
export const CODE_VIEW_HEIGHT = 8;
export const CODE_VIEW_FULL_THRESHOLD = 8;
export const CODE_VIEW_MARGIN = 2;

export interface CodeViewState {
  /** 1-based first visible user-code line. */
  viewStartLine?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function computeCodeViewStart(
  currentLine: number,
  totalLines: number,
  previousStart: number | undefined,
): number {
  const total = Math.max(1, Number.isFinite(totalLines) ? Math.trunc(totalLines) : 1);
  const line = clamp(Number.isFinite(currentLine) ? Math.trunc(currentLine) : 1, 1, total);
  const maximum = Math.max(1, total - CODE_VIEW_HEIGHT + 1);
  const start = clamp(previousStart !== undefined && Number.isFinite(previousStart)
    ? Math.trunc(previousStart) : 1, 1, maximum);
  if (line < start) return clamp(line, 1, maximum);
  if (line > start + CODE_VIEW_HEIGHT - CODE_VIEW_MARGIN - 1)
    return clamp(line - CODE_VIEW_HEIGHT + CODE_VIEW_MARGIN + 1, 1, maximum);
  return start;
}
