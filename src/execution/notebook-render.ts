/**
 * Notebook op renderer — maps every PTC kernel tool result onto the pure
 * cell-view module (`./cell-view`). This is the only layer that knows about
 * pi's render contract; cell-view knows nothing about pi.
 *
 * Design constraints honored here:
 * - **Synchronous, zero-jitter.** No shiki, no async swaps, no
 *   `context.invalidate()` from continuations. Everything renders in one phase;
 *   historical output is a pure function of `(toolName, result, options, state)`.
 *   Live animation samples the existing execution ticker without new timers;
 *   resumed sessions and ctrl+o toggles reproduce the exact same geometry.
 * - **Width at paint time.** `renderResult` has no width argument, so every
 *   box is built inside `Component.render(width)`: terminal resizes re-truncate
 *   instead of leaving stale-width fences behind.
 * - **Truthful numbering.** `In[N]` uses the execution count the RPC reported
 *   (`details.cellIdx`) for executed cells, the notebook position for
 *   non-executing doc ops, and falls back to the unnumbered `In:` variant when
 *   the frame carries no number. Numbers are never invented.
 * - **Stable geometry.** Shared, theme-keyed Shiki work runs asynchronously;
 *   redraws replace colors without changing raw-text-derived geometry.
 * - **Real fullscreen scrolling.** Each input/output box has its own persistent
 *   wheel-scroll window; regular mode retains terminal scrollback.
 */

import { Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import * as path from "node:path";
import { NotebookComponent } from "./notebook-component";
import { cachedCellHighlights, cellHighlightKey, highlightCellCode, reuseCellHighlights, StreamingCellHighlights } from "./code-highlight";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { parseSectionedOutput } from "../utils";
import {
  FULLSCREEN_VIEWPORT_LINES,
  executionIndicator,
  renderClearedCell,
  renderDeletedCell,
  renderEditedCell,
  renderInCell,
  renderLabeledBox,
  renderOutCell,
  type BodyRow,
  type CellRenderOptions,
  type ViewportMode,
} from "./cell-view";
import {
  CODE_VIEW_FULL_THRESHOLD,
  CODE_VIEW_HEIGHT,
  computeCodeViewStart,
  type CodeViewState,
} from "./code-view";
import type { ExecutionDetails, NotebookCellSummary, NotebookRunStep, SubagentRuntimeSnapshot } from "../contracts/execution-types";
import { renderSubagentPanel } from "./subagent-panel";

/** Structural view of the result pi hands to renderResult. */
export interface NotebookToolResult {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
  isError?: boolean;
}

/** Shared per-row renderer state (pi passes one object per tool row by reference). */
export interface NotebookRenderState {
  /** 1-based first visible code line, carried over from the executing view. */
  viewStartLine?: number;
  scrollPositions?: Record<string, number>;
  /** Changes only when this tool row scrolls; unrelated history stays warm. */
  scrollRevision?: number;
  /** Local In-label toggle; reset when Pi's global expansion changes. */
  inputExpanded?: boolean;
  inputExpansionBase?: boolean;
  /** Call previews yield to the partial/final input box at paint time. */
  resultOwnsInput?: boolean;
  callCode?: string;
  callKernelName?: string;
  callNotebookPath?: string;
  identityInCall?: boolean;
  highlights?: Map<string, string[] | null>;
  pendingHighlights?: Set<string>;
  streamingHighlights?: StreamingCellHighlights;
  highlightRevision?: number;
  lastHighlights?: { code: string; themeKey: string; lines: string[]; revision: number };
  /** Frozen final panel survives renderer reconstruction (Ctrl+o/theme/resize). */
  completedSubagentPanel?: { snapshot: SubagentRuntimeSnapshot; now: number; execId?: string };
}

/** Structural view of pi's ToolRenderResultOptions. */
export interface NotebookRenderOptions {
  expanded?: boolean;
  isPartial?: boolean;
}

/** Structural view of the fourth renderResult argument (context.state). */
export interface NotebookRenderContext {
  state?: NotebookRenderState;
  invalidate?: () => void;
}

/**
 * Op-specific detail fields threaded through by the tool execute() paths on
 * top of the exec details every frame carries.
 */
export interface CellOpDetails extends ExecutionDetails {
  /** Human-readable kernel name (never the internal session id). */
  kernelName?: string;
  /** Render-local flag; never stored in model-facing results. */
  identityInCall?: boolean;
  /** Notebook bound to the kernel, when it has one. */
  notebookPath?: string;
  /** write_cell: the written source; delete_cell: the deleted cell's source. */
  cellSource?: string;
  /** write_cell: previous source when an existing cell was replaced. */
  oldCellSource?: string;
  /** write_cell: true when an existing cell was replaced (not appended). */
  replaced?: boolean;
  /** run_cell: 1-based notebook position of the executed cell. */
  runCellIndex?: number;
  /** run_to/run_all: per-cell outcomes in run order. */
  runSteps?: NotebookRunStep[];
  /** run_to/run_all: 1-based position of the first failing cell. */
  failedIndex?: number;
  /** Pre-highlighted code lines (synchronous shiki output), one per code line. */
  highlightLines?: string[];
  /** read_cells / read_cell: the returned cells with sources and outputs. */
  cells?: NotebookCellSummary[];
  /** write_cell: 1-based position written. */
  at?: number;
  /** delete_cell: 1-based position deleted. */
  n?: number;
}

// ---------------------------------------------------------------------------
// Fullscreen / viewport mapping (R1 signal: pi.getSettings().tuiMode)
// ---------------------------------------------------------------------------

export type TuiModeResolver = () => "regular" | "fullscreen" | undefined;

let tuiModeProvider: TuiModeResolver | undefined;

/**
 * Install the live tuiMode resolver. The host passes `() => pi.getSettings().tuiMode`
 * — a per-call structured clone, so every render observes the CURRENT mode even
 * after a regular↔fullscreen switch (pi re-mounts and re-renders all rows on
 * switch). Unset/throwing resolvers collapse to "normal".
 */
export function setNotebookTuiModeProvider(provider: TuiModeResolver | undefined): void {
  tuiModeProvider = provider;
}

/** Map pi's (expanded, tuiMode) pair onto the cell renderer's viewport mode. */
export function currentViewportMode(expanded: boolean): ViewportMode {
  if (expanded) return "expanded";
  let tuiMode: string | undefined;
  try {
    tuiMode = tuiModeProvider?.();
  } catch {
    tuiMode = undefined;
  }
  return tuiMode === "fullscreen" ? "fullscreen" : "normal";
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

/** Width-aware Component: cell boxes are built at paint time, per width. */
function bodyLineCount(text: string): number {
  return text.replace(/\n$/, "").split("\n").length;
}

/** Start async work outside geometry; only the colors change when it finishes. */
function renderHighlights(
  code: string,
  supplied: string[] | undefined,
  theme: Theme,
  state: NotebookRenderState,
  redraw?: () => void,
  streaming = false,
): string[] | undefined {
  const key = cellHighlightKey(code, theme);
  const themeKey = cellHighlightKey("", theme);
  const remember = (lines: string[], revision: number): void => {
    if (revision >= (state.lastHighlights?.revision ?? -1)) {
      state.lastHighlights = { code, themeKey, lines, revision };
    }
  };
  const cached = cachedCellHighlights(code, theme) ?? state.highlights?.get(key);
  const ready = cached ?? supplied;
  if (ready) {
    remember(ready, state.highlightRevision = (state.highlightRevision ?? 0) + 1);
    return ready;
  }
  if (redraw && cached !== null && streaming) {
    const scheduler = state.streamingHighlights ??= new StreamingCellHighlights(highlightCellCode);
    const revision = state.highlightRevision = (state.highlightRevision ?? 0) + 1;
    scheduler.request({ key, code, theme, onResult: (lines) => {
      const highlights = state.highlights ??= new Map();
      if (highlights.size >= 8) highlights.delete(highlights.keys().next().value!);
      highlights.set(key, lines);
      if (lines) remember(lines, revision);
      redraw();
    } });
  } else if (redraw && cached !== null) {
    const pending = state.pendingHighlights ??= new Set();
    if (!pending.has(key)) {
      pending.add(key);
      const revision = state.highlightRevision = (state.highlightRevision ?? 0) + 1;
      void highlightCellCode(code, theme).then((lines) => {
        pending.delete(key);
        const highlights = state.highlights ??= new Map();
        if (highlights.size >= 8) highlights.delete(highlights.keys().next().value!);
        highlights.set(key, lines);
        if (lines) remember(lines, revision);
        redraw();
      });
    }
  }
  const previous = state.lastHighlights;
  return previous?.themeKey === themeKey ? reuseCellHighlights(code, previous.code, previous.lines) : undefined;
}
function resultText(result: NotebookToolResult): string {
  return result.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function boxOptions(
  details: CellOpDetails,
  expanded: boolean,
  theme: Theme | undefined,
  state: NotebookRenderState,
): Omit<CellRenderOptions, "width"> {
  return {
    mode: currentViewportMode(expanded),
    theme,
    // Scroll persistence: continue where the executing view left off. The
    // core clamps this into the valid range for the final body length.
    viewStart: state.viewStartLine,
  };
}

/**
 * Compact identity header: tool · kernel "name" · notebook.ipynb. Internal
 * session ids and model-facing instructional prose never appear here.
 */
function renderIdentityHeader(
  toolName: string,
  details: CellOpDetails,
  theme: Theme,
): string[] {
  if (!details.kernelName || details.identityInCall) return [];
  const notebook = details.notebookPath ? ` · ${path.basename(details.notebookPath)}` : "";
  return [theme.fg("muted", `${toolName} · kernel "${details.kernelName}"${notebook}`)];
}

// ---------------------------------------------------------------------------
// Executing frames (isPartial): live code view + live Out box
// ---------------------------------------------------------------------------

/**
 * Build the model-visible executing-code view: a header with progress and the
 * active nested tool, then a line-numbered viewport of the cell. For long
 * cells (> CODE_VIEW_FULL_THRESHOLD lines) the viewport follows currentLine
 * via the shared state so scroll position persists across updates.
 */
export function buildExecutingCodeLines(
  codeLines: string[],
  currentLine: number,
  totalLines: number,
  activeTool: string | undefined,
  theme: Theme,
  state: CodeViewState
): string[] {
  const lines: string[] = [];
  const toolBadge = activeTool ? theme.fg("success", ` • calling ${activeTool}()`) : "";
  lines.push(theme.fg("muted", `Executing Python code (line ${currentLine}/${totalLines})`) + toolBadge);
  lines.push("");

  let startIdx = 0;
  let endIdx = codeLines.length;

  if (codeLines.length > CODE_VIEW_FULL_THRESHOLD) {
    state.viewStartLine = computeCodeViewStart(currentLine, codeLines.length, state.viewStartLine);
    startIdx = state.viewStartLine - 1;
    endIdx = Math.min(codeLines.length, startIdx + CODE_VIEW_HEIGHT);
  } else {
    state.viewStartLine = 1;
  }

  if (startIdx > 0) {
    lines.push(theme.fg("muted", "       │ ..."));
  }

  for (let index = startIdx; index < endIdx; index++) {
    const lineNumber = index + 1;
    const isCurrentLine = lineNumber === currentLine;
    const line = codeLines[index];
    // The 6-char number field + separator keeps the rail at a constant column
    // for every row. The current line swaps the rail glyph for the marker IN
    // that column (▸ has no wide presentation, unlike ▶).
    const numberField = String(lineNumber).padStart(6, " ");
    let prefix = `${numberField} │ `;
    let content = line;

    if (isCurrentLine) {
      prefix = theme.fg("success", `${numberField} ▸ `);
      content = theme.fg("text", line);
    } else if (lineNumber < currentLine) {
      prefix = theme.fg("muted", prefix);
      content = theme.fg("muted", line);
    } else {
      prefix = theme.fg("muted", prefix);
    }

    lines.push(prefix + content);
  }

  if (endIdx < codeLines.length) {
    lines.push(theme.fg("muted", "       │ ..."));
  }

  return lines;
}

/** In labels expand independently; Ctrl+o / Out clicks remain authoritative on a mode change. */
function inputViewportMode(expanded: boolean, state: NotebookRenderState): ViewportMode {
  if (state.inputExpansionBase !== expanded) {
    state.inputExpanded = undefined;
    state.inputExpansionBase = expanded;
  }
  return currentViewportMode(state.inputExpanded ?? expanded);
}

/**
 * Partial-frame component for exec-like tools: the static executing-code view
 * (width-independent, as before) plus the LIVE Out box, which IS width-aware —
 * the box is rebuilt at paint time from Component.render(width) so terminal
 * resizes never leave a stale-width fence behind. `details.liveOutput` carries
 * the emulated stdout screen (\r/EL/cursor moves already interpreted by the
 * session manager); expanded (ctrl+o) shows the full live screen.
 */
/** Streaming (isPartial) frame: executing code view + live output box. */
function renderExecutingFrame(
  toolName: string,
  details: CellOpDetails,
  theme: Theme,
  state: NotebookRenderState,
  expanded: boolean,
  redraw?: () => void,
): Component {
  const cellNumber = toolName === "scratch_run" ? undefined : details.cellIdx ?? null;
  // Queued frames do not have an execution id yet. Their blank brackets are
  // not evidence of execution; scratch cells never acquire brackets at all.
  const animating = cellNumber === null && !!details.execId;
  return new NotebookComponent((width, layout, now) => {
    const code = details.userCode?.join("\n") ?? state.callCode ?? "";
    const mode = currentViewportMode(expanded);
    const executingLine = Number.isInteger(details.currentLine) && details.currentLine! > 0
      ? details.currentLine : undefined;
    if (executingLine !== undefined) {
      state.viewStartLine = computeCodeViewStart(executingLine, bodyLineCount(code), state.viewStartLine);
    }
    const inputMode = inputViewportMode(expanded, state) === "expanded" ? "expanded" : "fullscreen";
    const identity = renderIdentityHeader(toolName, details, theme);
    const opts = {
      width, mode, cellNumber, theme, labelBackground: "toolPendingBg" as const,
      executionIndicator: animating ? executionIndicator(now) : undefined,
    };
    const panel = renderSubagentPanel(details.subagentSnapshot, {
      width, theme, execId: details.execId, expanded, now, background: opts.labelBackground,
    });
    const lines = layout.box("input", bodyLineCount(code), {
      ...opts, mode: inputMode, viewStart: state.viewStartLine, executingLine,
      highlightLines: renderHighlights(code, details.highlightLines, theme, state, redraw),
    }, (options) => renderInCell(code, options), 0, false, mode === "fullscreen");

    const liveText = (details.liveOutput ?? []).join("\n");
    const hidden = details.liveOutputHidden ?? 0;
    if (!liveText && !hidden && !panel.length && !details.execId) return lines;
    lines.push("");
    if (hidden > 0) {
      lines.push(truncateToWidth(theme.fg("muted", `... ${hidden} earlier output lines`), width));
    }
    const total = bodyLineCount(liveText);
    // Retain the live tail in regular mode; fullscreen additionally allows
    // independent wheel scrolling, suspended while the user inspects history.
    lines.push(...layout.box("output", total, {
      ...opts, mode: expanded ? "expanded" : "fullscreen", followTail: true,
      viewStart: Math.max(1, total - FULLSCREEN_VIEWPORT_LINES + 1),
    }, (options) => renderOutCell(liveText, options), lines.length, true, mode === "fullscreen"));
    if (panel.length) lines.push("", ...panel);
    return identity.length ? [...identity, "", ...lines] : lines;
  }, state, redraw, (now) => {
    // Live frames are often repainted on the SAME component. Include their
    // bracket frame and panel clock in the key, leaving completed rows warm.
    const indicator = animating ? executionIndicator(now) : "";
    const panelTick = details.subagentSnapshot ? Math.floor(now / 120) : "";
    return `${currentViewportMode(expanded)}:${indicator}:${panelTick}:${details.currentLine ?? ""}`;
  });
}
// ---------------------------------------------------------------------------
// Call phase (renderCall): the In box for the submitted code. During
// execution this same box is what the partial frames render, so the tool
// call never shows a raw/truncated argument dump.
export function renderNotebookCall(
  code: string | undefined,
  options: { width?: number; toolName?: string; kernelName?: string; notebookPath?: string } | undefined,
  theme: Theme,
  context?: NotebookRenderContext,
): Component {
  const state = context?.state ?? {};
  if (code !== undefined) state.callCode = code;
  state.identityInCall = Boolean(options?.kernelName && options?.notebookPath);
  return new NotebookComponent((width, layout) => {
    // Pi retains both call and result components. Read shared state at PAINT
    // time (after both renderer callbacks), so even the first result replaces
    // this preview without a duplicate or an extra invalidation round.
    // Keep one compact, pi-tool-display-style title in the call component.
    // Only the input box transfers to the result component during execution.
    const toolLabel = options?.toolName
      ? theme.bold?.(options.toolName) ?? options.toolName
      : undefined;
    const notebook = options?.notebookPath ? ` · ${path.basename(options.notebookPath)}` : "";
    const kernelLabel = options?.kernelName ? theme.fg("muted", ` · ${options.kernelName}${notebook}`) : "";
    const lines = toolLabel
      ? [truncateToWidth(` ${theme.fg("toolTitle", toolLabel)}${kernelLabel}`, width)]
      : [];
    if (state.resultOwnsInput) return lines;
    const source = code ?? "";
    if (!source.trim()) return lines;
    lines.push(...layout.box("input", bodyLineCount(source), {
      width: options?.width ?? width,
      mode: inputViewportMode(false, state),
      followTail: true,
      cellNumber: options?.toolName === "scratch_run" ? undefined : null,
      theme,
      labelBackground: "toolPendingBg",
      highlightLines: renderHighlights(source, undefined, theme, state, context?.invalidate, true),
    }, (opts) => renderInCell(source, opts), lines.length, true));
    return lines;
  }, state, context?.invalidate, () => currentViewportMode(false));
}
// Completed frames, per op
// ---------------------------------------------------------------------------

/** exec_cell / run_cell / scratch_run: In[N] box + Out[N] box. */
function renderExecCompleted(
  toolName: string,
  result: NotebookToolResult,
  details: CellOpDetails,
  expanded: boolean,
  theme: Theme,
  state: NotebookRenderState,
  redraw?: () => void,
): Component {
  if (details.userCode === undefined && state.callCode === undefined) return renderFallback(toolName, result, theme, details);
  // Freeze both data and time at completion. Later registry mutations, resize,
  // expansion, or transcript redraws must not advance a historical panel.
  const completedPanel = state.completedSubagentPanel ?? (details.subagentSnapshot
    ? state.completedSubagentPanel = {
      snapshot: structuredClone(details.subagentSnapshot),
      now: details.subagentSnapshot.timestamp ?? Date.now(),
      execId: details.execId,
    } : undefined);
  return new NotebookComponent((width, layout) => {
    const opts = boxOptions(details, expanded, theme, state);
    const identity = renderIdentityHeader(toolName, details, theme);
    const cellNumber = toolName === "scratch_run" ? undefined : details.cellIdx ?? null;
    const code = details.userCode?.join("\n") ?? state.callCode ?? "";
    const text = outBoxContent(resultText(result)) || "(No output)";
    const outputStyle = result.isError ? "error" as const : text === "(No output)" ? "muted" as const : undefined;
    const labelBackground = result.isError ? "toolErrorBg" as const : "toolSuccessBg" as const;
    const base = { ...opts, width, cellNumber, labelBackground };
    const lines = layout.box("input", bodyLineCount(code), {
      ...base, mode: inputViewportMode(expanded, state), highlightLines: renderHighlights(code, details.highlightLines, theme, state, redraw),
    }, (options) => renderInCell(code, options));
    lines.push("");
    lines.push(...layout.box("output", bodyLineCount(text), { ...base, viewStart: 1, outputStyle },
      (options) => renderOutCell(text, options), lines.length));
    const panel = renderSubagentPanel(completedPanel?.snapshot, {
      width, theme, execId: completedPanel?.execId, expanded, now: completedPanel?.now, background: labelBackground,
    });
    if (panel.length) lines.push("", ...panel);
    return identity.length ? [...identity, "", ...lines] : lines;
  }, state, redraw, () => currentViewportMode(expanded));
}
/**
 * Jupyter-style Out content: stdout plus the echoed value, without the
 * model-facing section markers (`kernel:`, `subagents:`, `tools:` digests)
 * and without re-stating `Out[N]:` inside the box — the gutter already says
 * it. Falls back to the raw text when it is not sectioned (plain tracebacks).
 */
function outBoxContent(sectioned: string): string {
  const sections = parseSectionedOutput(sectioned);
  if (!sections) return sectioned.replace(/\n$/, "");
  const parts: string[] = [];
  for (const section of sections) {
    if (section.name === "output") {
      if (section.body.trim()) parts.push(section.body);
    } else if (section.name === "return") {
      // The runtime's echo already prefixes `Out[N]:`; the gutter says it too.
      const body = section.body.replace(/^Out\[\d+\]:\s*/m, "");
      if (body.trim()) parts.push(body);
    }
    // kernel / subagents / tools digests stay out of the notebook Out box.
  }
  return parts.join("\n");
}

/** write_cell: insert → In box; replace → inline diff; replace-with-empty → cleared red. */
function renderWriteCompleted(
  result: NotebookToolResult,
  details: CellOpDetails,
  expanded: boolean,
  theme: Theme,
  state: NotebookRenderState,
  redraw?: () => void,
): Component {
  const source = details.cellSource;
  if (source === undefined) return renderFallback("write_cell", result, theme);
  return new NotebookComponent((width, layout) => {
    const identity = renderIdentityHeader("write_cell", details, theme);
    const opts = { ...boxOptions(details, expanded, theme, state), width, cellNumber: null, mode: inputViewportMode(expanded, state) };
    const oldSource = details.oldCellSource;
    if (details.replaced && oldSource !== undefined) {
      if (!source.trim()) return layout.box("input", bodyLineCount(oldSource), opts,
        (options) => renderClearedCell(oldSource, options));
      const count = renderEditedCell(oldSource, source, { ...opts, mode: "expanded" }).length - 2;
      return layout.box("input", count, opts, (options) => renderEditedCell(oldSource, source, options));
    }
    const body = layout.box("input", bodyLineCount(source), {
      ...opts, highlightLines: renderHighlights(source, undefined, theme, state, redraw),
    }, (options) => renderInCell(source, options));
    return identity.length ? [...identity, "", ...body] : body;
  }, state, redraw, () => currentViewportMode(expanded));
}
/** delete_cell: the whole cell — gutter included — in red. */
function renderDeleteCompleted(
  details: CellOpDetails,
  expanded: boolean,
  theme: Theme,
  state: NotebookRenderState,
  redraw?: () => void,
): Component {
  return new NotebookComponent((width, layout) => {
    const identity = renderIdentityHeader("delete_cell", details, theme);
    const source = details.cellSource ?? "(source unavailable)";
    const body = layout.box("input", bodyLineCount(source), {
      ...boxOptions(details, expanded, theme, state), width, cellNumber: details.n, mode: inputViewportMode(expanded, state),
    }, (options) => renderDeletedCell(source, options));
    return identity.length ? [...identity, "", ...body] : body;
  }, state, redraw, () => currentViewportMode(expanded));
}
/** run_to / run_all: one compact per-cell status list. */
function renderRunBatchCompleted(
  toolName: "run_to" | "run_all",
  details: CellOpDetails,
  expanded: boolean,
  theme: Theme,
  state: NotebookRenderState,
  redraw?: () => void,
): Component {
  return new NotebookComponent((width, layout) => {
    const identity = renderIdentityHeader(toolName, details, theme);
    const rows: BodyRow[] = (details.runSteps ?? []).map((step) => {
      const glyph = step.ok ? "✓" : "✗";
      const target = step.execCount !== undefined ? ` → Out[${step.execCount}]` : "";
      const failure = step.ok ? "" : `: ${firstLine(step.error ?? "failed")}`;
      return { text: `${glyph} cell ${step.index}${target}${failure}`, style: step.ok ? "success" : "error" };
    });
    if (!rows.length) rows.push({ text: "(no code cells executed)", style: "muted" });
    const body = layout.box("run", rows.length, {
      width, mode: currentViewportMode(expanded), theme,
    }, (options) => renderLabeledBox("Run:", rows, options));
    return identity.length ? [...identity, "", ...body] : body;
  }, state, redraw, () => currentViewportMode(expanded));
}
/** reset_kernel: compact identity plus one muted status line; notebook untouched. */
function renderResetCompleted(
  result: NotebookToolResult,
  details: CellOpDetails,
  theme: Theme,
): Component {
  const identity = renderIdentityHeader("reset_kernel", details, theme);
  const status = "Kernel restarted: fresh namespace; notebook untouched.";
  return new Text([...identity, theme.fg("muted", status)].join("\n"), 0, 0);
}

/** read_cell: the cell as an In box (line-numbered) plus its Out box when executed. */
function renderReadOneCompleted(
  details: CellOpDetails,
  expanded: boolean,
  theme: Theme,
  state: NotebookRenderState,
  redraw?: () => void,
): Component {
  return new NotebookComponent((width, layout) => {
    const identity = renderIdentityHeader("read_cell", details, theme);
    const cell = details.cells?.[0];
    if (!cell) return identity.length ? [...identity, "", theme.fg("muted", "(no cell)")] : [theme.fg("muted", "(no cell)")];
    const opts = { ...boxOptions(details, expanded, theme, state), width, cellNumber: cell.executionCount };
    const lines = layout.box("input", bodyLineCount(cell.source), {
      ...opts, mode: inputViewportMode(expanded, state), highlightLines: cell.cellType === "code" ? renderHighlights(cell.source, undefined, theme, state, redraw) : undefined,
    }, (options) => renderInCell(cell.source, options));
    if (cell.outputText) {
      lines.push(...layout.box("output", bodyLineCount(cell.outputText), { ...opts, viewStart: 1 },
        (options) => renderOutCell(cell.outputText, options), lines.length));
    }
    return identity.length ? [...identity, "", ...lines] : lines;
  }, state, redraw, () => currentViewportMode(expanded));
}
/** read_cell_output: the requested durable page, verbatim, in an Out[N] box. */
function renderReadOutput(
  result: NotebookToolResult,
  details: CellOpDetails,
  options: NotebookRenderOptions,
  theme: Theme,
  state: NotebookRenderState,
  redraw?: () => void,
): Component {
  const expanded = options.expanded ?? false;
  return new NotebookComponent((width, layout) => {
    const identity = renderIdentityHeader("read_cell_output", details, theme);
    // A page can begin inside a section or traceback. Do not strip markers,
    // reinterpret the text as an execution response, or fabricate an In box.
    const text = resultText(result) || (options.isPartial ? "Reading output…" : "(No output)");
    const outputStyle = result.isError ? "error" as const
      : options.isPartial || text === "(No output)" ? "muted" as const : undefined;
    const labelBackground = result.isError ? "toolErrorBg" as const
      : options.isPartial ? "toolPendingBg" as const : "toolSuccessBg" as const;
    const body = layout.box("output", bodyLineCount(text), {
      ...boxOptions(details, expanded, theme, state), width,
      cellNumber: details.cellIdx ?? null, viewStart: 1, outputStyle, labelBackground,
    }, (opts) => renderOutCell(text, opts));
    return identity.length ? [...identity, "", ...body] : body;
  }, state, redraw, () => currentViewportMode(expanded));
}

/** read_cells: compact per-cell list (headers muted, sources plain). */
function renderReadManyCompleted(
  details: CellOpDetails,
  theme: Theme,
): Component {
  const identity = renderIdentityHeader("read_cells", details, theme);
  const cells = details.cells ?? [];
  if (cells.length === 0) {
    return new Text([...identity, theme.fg("muted", "(no cells)")].join("\n"), 0, 0);
  }
  const lines: string[] = [...identity, ""];
  for (const cell of cells) {
    const out = cell.executionCount !== undefined ? ` · Out[${cell.executionCount}]` : "";
    lines.push(theme.fg("muted", `In[${cell.index}] · ${cell.cellType}${out}`));
    for (const sourceLine of cell.source.replace(/\n$/, "").split("\n")) {
      lines.push(`  ${sourceLine}`);
    }
    if (cell.outputText.length > 0) {
      lines.push(theme.fg("muted", "  Out:"));
      for (const outputLine of cell.outputText.replace(/\n$/, "").split("\n")) {
        lines.push(`  ${outputLine}`);
      }
    }
  }
  return new Text(lines.join("\n"), 0, 0);
}

/**
 * Doc-op failure or frame without op details. User-facing text is compact and
 * identity-first: error results show the failure message (name-based, no
 * internal ids); everything else renders ONLY the kernel identity header —
 * model-facing instructional prose is never forwarded to the transcript.
 */
function renderFallback(
  toolName: string,
  result: NotebookToolResult,
  theme: Theme,
  details: CellOpDetails = (result.details ?? {}) as CellOpDetails,
): Component {
  const identity = renderIdentityHeader(toolName, details, theme);
  if (result.isError) {
    const text = resultText(result) || "failed";
    return new Text([...identity, theme.fg("error", firstLine(text))].join("\n"), 0, 0);
  }
  if (details.identityInCall) return { render: () => [], invalidate() {} };
  return new Text(identity.length ? identity.join("\n") : theme.fg("muted", "(no output)"), 0, 0);
}

function firstLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * renderResult for every kernel tool. Total: never throws (a throwing renderer
 * is silently swallowed by the host into a generic fallback).
 */
export function renderNotebookResult(
  toolName: string,
  result: NotebookToolResult,
  options: NotebookRenderOptions,
  theme: Theme,
  context?: NotebookRenderContext,
): Component {
  try {
    const state = (context?.state ?? {}) as NotebookRenderState;
    const details = { ...(result.details ?? {}), identityInCall: state.identityInCall } as CellOpDetails;
    if (["exec_cell", "run_cell", "scratch_run", "write_cell"].includes(toolName)) {
      state.resultOwnsInput = toolName === "write_cell"
        ? details.cellSource !== undefined
        : details.userCode !== undefined || state.callCode !== undefined;
      if (state.resultOwnsInput) state.streamingHighlights?.cancelPending();
    }
    if (toolName === "read_cell_output") {
      return renderReadOutput(result, details, options, theme, state, context?.invalidate);
    }
    if (options.isPartial) {
      return renderExecutingFrame(toolName, details, theme, state, options.expanded ?? false, context?.invalidate);
    }
    switch (toolName) {
      case "exec_cell":
      case "run_cell":
      case "scratch_run":
        return renderExecCompleted(toolName, result, details, options.expanded ?? false, theme, state, context?.invalidate);
      case "write_cell":
        return renderWriteCompleted(result, details, options.expanded ?? false, theme, state, context?.invalidate);
      case "delete_cell":
        return renderDeleteCompleted(details, options.expanded ?? false, theme, state, context?.invalidate);
      case "run_to":
      case "run_all":
        return renderRunBatchCompleted(toolName as "run_to" | "run_all", details, options.expanded ?? false, theme, state, context?.invalidate);
      case "reset_kernel":
        return renderResetCompleted(result, details, theme);
      case "read_cell":
        return renderReadOneCompleted(details, options.expanded ?? false, theme, state, context?.invalidate);
      case "read_cells":
        return renderReadManyCompleted(details, theme);
      default:
        return renderFallback(toolName, result, theme, details);
    }
  } catch {
    // Renderer exceptions are swallowed by the host anyway; degrade to plain
    // text here so the failure is visible and width-correct.
    try {
      return new Text(theme.fg("muted", `${toolName}: rendering unavailable`), 0, 0);
    } catch {
      return new Text("(no output)", 0, 0);
    }
  }
}
