import { Type } from "@sinclair/typebox";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolResult, ExtensionContext, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, type Component, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { PythonSessionManager } from "../python-session-manager";
import type { PtcToolDefinition } from "../types";
import { withActivityLabel } from "../utils";
import { highlightCellCode } from "../execution/code-highlight";

type ReviewDecision = { action: "approve" | "reject"; note?: string };
type Reviewer = (ctx: ExtensionContext, sessionId: string, code: string) => Promise<ReviewDecision>;

/** Review is a user decision, never execution or an exact-code permission token. */
export function createCellReviewTool(manager: PythonSessionManager, review: Reviewer): PtcToolDefinition {
  return withActivityLabel({
    name: "request_cell_review",
    label: "review cell",
    description:
      "Ask the user to review a cell without executing it. Supply exactly one of code, file, or notebook position n. Review substantial workflows and destructive operations before execution; minor repairs within the approved scope do not need another review. Never prompt when the user explicitly requested autonomous execution without prompts.",
    parameters: Type.Object({
      session_id: Type.Optional(Type.String({ description: "Kernel id; n defaults to the most recently used kernel." })),
      n: Type.Optional(Type.Integer({ minimum: 1, description: "1-based position of the notebook code cell to review." })),
      code: Type.Optional(Type.String({ description: "Complete Python cell body to review, without running it." })),
      file: Type.Optional(Type.String({ description: "Python file whose complete contents are shown for review." })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const { session_id: requestedId, n, code, file } = params as {
        session_id?: string; n?: number; code?: string; file?: string;
      };
      if ([n, code, file].filter((value) => value !== undefined).length !== 1) {
        return { content: [{ type: "text", text: "request_cell_review requires exactly one of code, file, or n." }],
          details: { approved: false }, isError: true };
      }
      let sessionId = requestedId;
      let source = code ?? "";
      try {
        if (n !== undefined) {
          sessionId ??= manager.list()[0]?.id;
          if (!sessionId || !manager.get(sessionId)) {
            throw new Error(sessionId ? `Unknown kernel ${sessionId}.` : "No live kernels. Provision one first.");
          }
          const preview = await manager.readCell(sessionId, n);
          const cell = preview.cells[0];
          if (!cell || cell.cellType !== "code") throw new Error("Only code cells can be reviewed.");
          source = cell.source;
        } else if (file !== undefined) {
          source = await fs.readFile(path.resolve(ctx.cwd, file), "utf8");
        }
        const decision = await review(ctx, sessionId ?? "unbound", source);
        const approved = decision.action === "approve";
        return {
          content: [{ type: "text", text: approved
            ? "Cell approved for the intended operation. Nothing was executed. Execute separately; small fixes within this scope do not require another review."
            : `Cell rejected. Nothing was executed.${decision.note ? ` User feedback: ${decision.note}` : ""}` }],
          details: { approved, rejected: !approved, note: decision.note, sessionId, n },
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Cell review failed: ${error instanceof Error ? error.message : String(error)}` }],
          details: { approved: false, rejected: true, sessionId, n }, isError: true };
      }
    },
  });
}

/** Keep review instructions model-facing; render only the user's decision on success. */
export function createRenderedCellReviewTool(
  sessionManager: PythonSessionManager,
  review: Reviewer = requestCellApproval
): PtcToolDefinition {
  return {
    ...createCellReviewTool(sessionManager, review),
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
      const text = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
      return new Text(text, 0, 0);
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
  sessionId: string,
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
        lines.push(theme.fg("accent", "┌─ cell review ─ kernel " + sessionId + " " + "─".repeat(Math.max(0, renderWidth - 22 - sessionId.length))));
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
