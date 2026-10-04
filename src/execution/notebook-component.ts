import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { FULLSCREEN_VIEWPORT_LINES, NORMAL_VIEWPORT_LINES, visibleWidth, type CellRenderOptions } from "./cell-view";
import type { NotebookRenderState } from "./notebook-render";

interface ScrollRegion {
  key: string;
  top: number;
  bottom: number;
  left: number;
  right: number;
  start: number;
  maximum: number;
  followsTail: boolean;
}

/** Build each box with its own persistent viewport and local mouse hit region. */
export class NotebookBoxLayout {
  readonly regions: ScrollRegion[] = [];
  constructor(private readonly state: NotebookRenderState) {}

  box(
    key: string,
    totalLines: number,
    options: CellRenderOptions,
    render: (options: CellRenderOptions) => string[],
    top = 0,
    followsTail = false,
    scrollable = true,
  ): string[] {
    const cap = options.mode === "normal" ? NORMAL_VIEWPORT_LINES : FULLSCREEN_VIEWPORT_LINES;
    const maximum = Math.max(1, totalLines - cap + 1);
    const position = this.state.scrollPositions?.[key] ?? options.viewStart ?? (followsTail ? maximum : 1);
    const start = Math.max(1, Math.min(maximum, position));
    const lines = render({ ...options, viewStart: start });
    if (scrollable && options.mode === "fullscreen" && maximum > 1) {
      // The gutter belongs to transcript navigation, not the box viewport.
      // Derive bounds from the painted fence so custom labels, ANSI styling,
      // wide characters, and narrow/clipped panes use the actual box geometry.
      const fence = lines[0] ?? "";
      const leftCorner = fence.indexOf("┌");
      const rightCorner = fence.lastIndexOf("┐");
      if (leftCorner >= 0 && rightCorner > leftCorner) {
        const left = visibleWidth(fence.slice(0, leftCorner));
        const right = Math.min(options.width, visibleWidth(fence.slice(0, rightCorner)) + 1);
        if (right > left) {
          this.regions.push({ key, top, bottom: top + lines.length, left, right, start, maximum, followsTail });
        }
      }
    }
    return lines;
  }
}

/** Width-aware, mouse-scrollable tool component. Regular mode keeps terminal scrollback. */
export class NotebookComponent implements Component {
  private regions: ScrollRegion[] = [];
  private cached?: {
    width: number;
    renderKey: unknown;
    lastHighlights: NotebookRenderState["lastHighlights"];
    highlightRevision: number | undefined;
    viewStartLine: number | undefined;
    callCode: string | undefined;
    resultOwnsInput: boolean | undefined;
    scrollRevision: number | undefined;
    lines: string[];
  };
  constructor(
    private readonly build: (width: number, layout: NotebookBoxLayout) => string[],
    private readonly state: NotebookRenderState = {},
    private readonly redraw?: () => void,
    private readonly renderKey?: () => unknown,
  ) {}

  render(width: number): string[] {
    const renderKey = this.renderKey?.();
    const cached = this.cached;
    // Transcript redraws revisit every historical tool. Reuse the painted
    // rows instead of reparsing output, allocating body rows, and restyling
    // ANSI text when neither geometry nor this row's state has changed.
    if (cached && cached.width === width && cached.renderKey === renderKey &&
        cached.lastHighlights === this.state.lastHighlights &&
        cached.highlightRevision === this.state.highlightRevision &&
        cached.viewStartLine === this.state.viewStartLine &&
        cached.callCode === this.state.callCode &&
        cached.resultOwnsInput === this.state.resultOwnsInput &&
        cached.scrollRevision === this.state.scrollRevision) {
      return cached.lines;
    }
    const layout = new NotebookBoxLayout(this.state);
    const lines = this.build(width, layout);
    this.regions = layout.regions;
    // Snapshot after build: rendering may resolve already-cached highlights.
    this.cached = {
      width, renderKey, lines,
      lastHighlights: this.state.lastHighlights,
      highlightRevision: this.state.highlightRevision,
      viewStartLine: this.state.viewStartLine,
      callCode: this.state.callCode,
      resultOwnsInput: this.state.resultOwnsInput,
      scrollRevision: this.state.scrollRevision,
    };
    return lines;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    // Preserve transcript selection/clicks and let unhandled events reach the
    // outer ScrollView. Ctrl+o remains the keyboard path to the complete cell.
    if (event.type !== "wheel" || !event.wheelDelta) return undefined;
    const region = this.regions.find((box) =>
      event.x >= box.left && event.x < box.right && event.y >= box.top && event.y < box.bottom,
    );
    if (!region) return undefined;
    const next = Math.max(1, Math.min(region.maximum, region.start + event.wheelDelta));
    if (next === region.start) return { handled: true, render: false };
    const positions = this.state.scrollPositions ??= {};
    if (region.followsTail && next === region.maximum) delete positions[region.key];
    else positions[region.key] = next;
    region.start = next;
    this.state.scrollRevision = (this.state.scrollRevision ?? 0) + 1;
    this.invalidate();
    this.redraw?.();
    return { handled: true, render: true };
  }

  // Keep the last painted hit regions until repaint: host invalidation can occur
  // between consecutive wheel events, which must not leak into transcript scrolling.
  invalidate(): void { this.cached = undefined; }
}
