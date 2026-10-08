import { Type } from "@sinclair/typebox";
import type { AgentToolResult, ExtensionContext, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, type Component, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { PythonSessionManager } from "../python-session-manager";
import type { PtcToolDefinition } from "../types";
import { withActivityLabel } from "../utils";
import { highlightCellCode } from "../execution/code-highlight";
import { KernelDirectory } from "./kernel-directory";

type ReviewDecision = { action: "approve" | "reject"; note?: string };
type Reviewer = (ctx: ExtensionContext, kernelName: string, code: string) => Promise<ReviewDecision>;

/** Review a SAVED notebook cell (write_cell first): a user decision, never execution or an exact-code permission token. */
export function createCellReviewTool(manager: PythonSessionManager, review: Reviewer, directory: KernelDirectory): PtcToolDefinition {
  return withActivityLabel({
    name: "request_cell_review",
    label: "review cell",
    description:
      "Ask the user to review a saved notebook cell without executing it. Supply the kernel name and the 1-based position n of a saved code cell (persist it first with write_cell; detached code and file inputs are not accepted). Review substantial workflows and destructive operations before execution; minor repairs within the approved scope do not need another review. Never prompt when the user explicitly requested autonomous execution without prompts.",
    parameters: Type.Object({
      kernel: Type.String({ description: "Kernel to review the saved cell in (name from provision_kernel)." }),
      n: Type.Integer({ minimum: 1, description: "1-based position of the saved code cell to review." }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const { kernel, n } = params as { kernel: string; n: number };
      if (typeof params === "object" && params !== null && ("code" in params || "file" in params)) {
        return { content: [{ type: "text", text: "Detached code and file reviews are not supported. Save a code cell with write_cell, then specify kernel and n." }],
          details: { approved: false, rejected: true, kernel, n }, isError: true };
      }
      if (!Number.isInteger(n) || n < 1) {
        return { content: [{ type: "text", text: "request_cell_review requires the 1-based position n of a saved code cell." }],
          details: { approved: false, rejected: true, kernel }, isError: true };
      }
      try {
        let ref;
        try {
          ref = directory.resolveKernel(kernel);
        } catch (resolutionError) {
          throw new Error(resolutionError instanceof Error ? resolutionError.message : String(resolutionError));
        }
        const preview = await manager.readCell(ref.id, n);
        const cell = preview.cells[0];
        if (!cell) throw new Error(`Cell ${n} does not exist in kernel "${ref.name}".`);
        if (cell.cellType !== "code") throw new Error("Only code cells can be reviewed.");
        const decision = await review(ctx, ref.name, cell.source);
        const approved = decision.action === "approve";
        return {
          content: [{ type: "text", text: approved
            ? "Cell approved for the intended operation. Nothing was executed. Execute separately; small fixes within this scope do not require another review."
            : `Cell rejected. Nothing was executed.${decision.note ? ` User feedback: ${decision.note}` : ""}` }],
          details: { approved, rejected: !approved, note: decision.note, kernel: ref.name, kernelName: ref.name, notebookPath: ref.notebookPath, n },
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Cell review failed: ${error instanceof Error ? error.message : String(error)}` }],
          details: { approved: false, rejected: true, kernel, n }, isError: true };
      }
    },
  });
}

/** Keep review instructions model-facing; render only the user's decision on success. */
export function createRenderedCellReviewTool(
  sessionManager: PythonSessionManager,
  directory?: KernelDirectory,
  review: Reviewer = requestCellApproval
): PtcToolDefinition {
  return {
    ...createCellReviewTool(sessionManager, review, directory ?? new KernelDirectory(sessionManager)),
    renderResult(
      result: AgentToolResult<unknown>,
      { isPartial }: ToolRenderResultOptions,
      theme: Theme,
      context?: { isError?: boolean }
    ): Component {
      if (isPartial) return new Text(theme.fg("muted", "Reviewing…"), 0, 0);
      const details = result.details as {
        approved?: boolean; rejected?: boolean; edited?: boolean; cancelled?: boolean;
      } | undefined;
      if (
        !result.isError && !context?.isError && details?.approved === true && details.rejected === false
        && !details.edited && !details.cancelled
      ) {
        // Expansion must not reveal the separate model-facing execution instructions.
        return new Text(theme.fg("success", "Approved"), 0, 0);
      }
      if (result.isError || context?.isError) {
        const text = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
        return new Text(theme.fg("error", (text.split("\n", 1)[0] || "Review failed").slice(0, 160)), 0, 0);
      }
      const outcome = result.details as { rejected?: boolean; note?: string } | undefined;
      return new Text(theme.fg("muted", outcome?.rejected
        ? `Rejected${outcome.note ? ` · ${outcome.note}` : ""}`
        : "Review incomplete"), 0, 0);
    },
  };
}

/** The three choices offered in the cell approval popup. */
const CELL_APPROVAL_OPTIONS = [
  { value: "approve", label: "Approve — accept this operation" },
  { value: "reject", label: "Reject — do not execute this operation" },
  { value: "note", label: "Reject with note — tell the model why" },
] as const;

/**
 * Questionnaire-style approval box: shows the cell code, then Approve /
 * Reject / Reject with note. Resolves when the user decides (Esc = reject).
 */
async function requestCellApproval(
  ctx: ExtensionContext,
  kernelName: string,
  code: string
): Promise<ReviewDecision> {
  if (!ctx.hasUI) {
    // No UI to ask in: fail closed with an explanatory result.
    return { action: "reject", note: "approval requested but no UI is available in this mode" };
  }

  // Highlight once, up-front (before the sync TUI renderer runs). Falls back
  // to plain text if Shiki is unavailable.
  const highlightedLines = await highlightCellCode(code, ctx.ui?.theme);
  const previewLines = highlightedLines ?? code.split("\n");
  const isHighlighted = highlightedLines !== null;

  try {
    return await ctx.ui.custom<ReviewDecision>((tui, theme, _kb, done) => {
      let optionIndex = 0;
      let inputMode = false;
      let cachedLines: string[] | undefined;
      const viewportRows = 24; // visible code rows; the box scrolls instead of truncating
      let rowOffset = 0;
      const editorTheme: EditorTheme = {
        borderColor: (style: string) => theme.fg("accent", style),
        selectList: {
          selectedPrefix: (style: string) => theme.fg("accent", style),
          selectedText: (style: string) => theme.fg("accent", style),
          description: (style: string) => theme.fg("muted", style),
          scrollInfo: (style: string) => theme.fg("dim", style),
          noMatch: (style: string) => theme.fg("warning", style),
        },
      };
      const editor = new Editor(tui, editorTheme);
      editor.onSubmit = (value: string) => {
        const note = value.trim() || "(no note)";
        done({ action: "reject", note });
      };

      // Wrapped rows over the whole document, rebuilt when the width changes.
      let cachedRows: { text: string; line: number }[] | undefined;
      let cachedRowsWidth = -1;

      function buildRows(renderWidth: number): void {
        const innerWidth = Math.max(1, renderWidth - 3);
        const gutterWidth = Math.max(1, String(previewLines.length).length);
        const rows: { text: string; line: number }[] = [];
        for (let i = 0; i < previewLines.length; i++) {
          const num = theme.fg("dim", String(i + 1).padStart(gutterWidth));
          for (const wrapped of wrapTextWithAnsi(num + "  " + previewLines[i], innerWidth)) {
            rows.push({ text: wrapped, line: i });
          }
        }
        cachedRows = rows;
        cachedRowsWidth = renderWidth;
      }

      function refresh() {
        cachedLines = undefined;
        tui.requestRender();
      }

      function render(width: number): string[] {
        if (cachedLines) return cachedLines;
        const renderWidth: number = Math.max(1, width);
        if (!cachedRows || cachedRowsWidth !== renderWidth) buildRows(renderWidth);
        const rows = cachedRows!;

        // Clamp the scroll window so the bottom of the code is reachable.
        rowOffset = Math.max(0, Math.min(rowOffset, Math.max(0, rows.length - viewportRows)));
        const visible = rows.slice(rowOffset, rowOffset + viewportRows);

        const lines: string[] = [];
        lines.push(theme.fg("accent", "┌─ cell review ─ kernel " + kernelName + " " + "─".repeat(Math.max(0, renderWidth - 22 - kernelName.length))));
        const rangeLabel = visible.length
          ? `lines ${visible[0].line + 1}–${visible[visible.length - 1].line + 1} of ${previewLines.length}`
          : "0 lines";
        const syntaxLabel = isHighlighted ? "· shiki" : "· plain";
        const canScroll = rows.length > viewportRows;
        const scrollLabel = canScroll ? `· PgUp/PgDn scroll (${rowOffset + 1}/${rows.length})` : "";
        lines.push(theme.fg("muted", `│ ${rangeLabel} ${syntaxLabel}${scrollLabel}`));
        for (const row of visible) {
          lines.push("│ " + row.text);
        }
        lines.push(theme.fg("accent", "└" + "─".repeat(Math.max(0, renderWidth - 2)) + "┘"));
        lines.push("");
        CELL_APPROVAL_OPTIONS.forEach((option, index) => {
          const selected = !inputMode && index === optionIndex;
          const marker = selected ? theme.fg("accent", "❯ ") : "  ";
          const label = selected ? theme.fg("accent", option.label) : theme.fg("muted", option.label);
          lines.push(`${marker}${label}`);
        });
        if (inputMode) {
          lines.push(theme.fg("muted", "Why reject? (Enter to submit)"));
          lines.push(...editor.getLines());
        }
        lines.push(theme.fg("dim", "↑/↓ select · wheel/PgUp/PgDn scroll · Home/End top/bottom · Enter confirm · y approve · n reject · Esc reject"));
        return lines;
      }

      function handleInput(data: string): void {
        if (inputMode) {
          editor.handleInput(data);
          refresh();
          return;
        }
        if (matchesKey(data, Key.pageUp)) {
          rowOffset = Math.max(0, rowOffset - (viewportRows - 4));
          refresh();
          return;
        }
        if (matchesKey(data, Key.pageDown)) {
          rowOffset += viewportRows - 4;
          refresh();
          return;
        }
        if (matchesKey(data, Key.home)) {
          rowOffset = 0;
          refresh();
          return;
        }
        if (matchesKey(data, Key.end)) {
          rowOffset = Number.MAX_SAFE_INTEGER; // render() clamps to the last full page
          refresh();
          return;
        }
        if (data === "\x1b[A" || data === "k") {
          optionIndex = (optionIndex + CELL_APPROVAL_OPTIONS.length - 1) % CELL_APPROVAL_OPTIONS.length;
          refresh();
          return;
        }
        if (data === "\x1b[B" || data === "j") {
          optionIndex = (optionIndex + 1) % CELL_APPROVAL_OPTIONS.length;
          refresh();
          return;
        }
        if (data === "y") {
          done({ action: "approve" });
          return;
        }
        if (data === "n") {
          done({ action: "reject" });
          return;
        }
        if (matchesKey(data, Key.return)) {
          const selected = CELL_APPROVAL_OPTIONS[optionIndex];
          if (selected.value === "approve") {
            done({ action: "approve" });
          } else if (selected.value === "note") {
            inputMode = true;
            editor.setText("");
            refresh();
          } else {
            done({ action: "reject" });
          }
          return;
        }
        if (matchesKey(data, Key.escape)) {
          done({ action: "reject" });
        }
      }

      /**
       * Wheel scrolling: pi-tui's alt-screen renderer dispatches wheel events
       * as normalized mouse events to the component under the pointer before
       * falling back to chat scrolling. Consuming them here scrolls the code
       * viewport; wheelDelta is negative when scrolling up.
       */
      function handleMouse(event: { type?: string; wheelDelta?: number }): { handled: boolean } | undefined {
        if (event.type !== "wheel") return undefined;
        const delta = event.wheelDelta ?? 0;
        if (delta !== 0) {
          rowOffset += delta; // render() clamps to the valid range
          refresh();
        }
        return { handled: true };
      }

      return { render, invalidate: () => { cachedLines = undefined; }, handleInput, handleMouse };
    });
  } catch (error) {
    // A broken dialog must not run the cell unasked.
    return {
      action: "reject",
      note: `approval dialog failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
