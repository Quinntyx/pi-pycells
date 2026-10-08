/** Full working roster and bounded queue appended by the notebook renderer below Out. */

import type { Theme, ThemeBg, ThemeColor } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { restoreBackground } from "./cell-view";
import type {
  SubagentAgentRow,
  SubagentPoolState,
  SubagentRuntimeSnapshot,
} from "../contracts/execution-types";

export interface SubagentPanelOptions {
  width: number;
  theme?: Theme;
  execId?: string;
  expanded?: boolean;
  /** Host tool background, matching the enclosing Out box. */
  background?: ThemeBg;
  /** Accepted for the shared render contract; snapshot rows never tick forward. */
  now?: number;
}

/** Rows relevant to the exec currently being streamed. */
export function relevantAgents(
  snapshot: SubagentRuntimeSnapshot | undefined,
  execId?: string,
): SubagentAgentRow[] {
  if (!snapshot || !Array.isArray(snapshot.agents)) return [];
  if (!execId) return snapshot.agents;
  return snapshot.agents.filter(
    (agent) =>
      agent.execScope === execId ||
      agent.status === "running" ||
      agent.status === "starting" ||
      agent.status === "queued",
  );
}

const COMPACT_QUEUED = 4;
const EXPANDED_QUEUED = 12;
const EXPANDED_POOLS = 3;
const EXPANDED_STAGES = 6;
// Cell boxes reserve a 12-column label/metadata gutter plus inset and separator.
const CELL_INSET = 14;

interface PanelRow {
  text: string;
  color?: ThemeColor;
  bold?: boolean;
  tail?: string;
  tailColor?: ThemeColor;
}

type Counts = Record<
  "running" | "starting" | "queued" | "idle" | "settled" |
  "failed" | "cancelled" | "stopped" | "closed" | "other",
  number
>;

/** Drop terminal controls before labels participate in either geometry or styling. */
function label(value: unknown): string {
  if (typeof value !== "string") return "";
  return stripTerminalSequences(value.slice(0, 4096))
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/[\u061c\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** pi-tui adds trusted SGR resets when clipping; style only after plain-text layout. */
function clip(text: string, width: number): string {
  return stripTerminalSequences(truncateToWidth(text, Math.max(0, width), "…"));
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function state(agent: SubagentAgentRow): keyof Counts {
  if ((agent.status === "running" || agent.status === "starting") && agent.idle) return "idle";
  switch (agent.status) {
    case "running": case "starting": case "queued": case "settled":
    case "failed": case "cancelled": case "stopped": case "closed":
      return agent.status;
    case "dead": return "failed";
    default: return "other";
  }
}

function rowCounts(agents: SubagentAgentRow[]): Counts {
  const counts: Counts = {
    running: 0, starting: 0, queued: 0, idle: 0, settled: 0,
    failed: 0, cancelled: 0, stopped: 0, closed: 0, other: 0,
  };
  for (const agent of agents) counts[state(agent)]++;
  return counts;
}

/** Pack whole, nonzero count phrases with bounded wrapping even in narrow panes. */
function phrases(parts: string[], width: number): PanelRow[] {
  const rows: PanelRow[] = [];
  let line = "";
  for (const part of parts) {
    const next = line ? `${line} · ${part}` : part;
    if (line && visibleWidth(next) > width) {
      rows.push({ text: line, color: "muted" });
      line = part;
    } else {
      line = next;
    }
  }
  if (line) rows.push({ text: line, color: "muted" });
  return rows;
}

function countPhrases(values: Record<string, number>): string[] {
  return Object.entries(values).filter(([, value]) => value > 0)
    .map(([name, value]) => `${value} ${name}`);
}

function agentRows(agent: SubagentAgentRow, expanded: boolean): PanelRow[] {
  const kind = state(agent);
  const status = kind === "other" ? label(agent.status) || "unknown" : kind;
  const color: ThemeColor = kind === "failed" ? "error"
    : kind === "cancelled" || kind === "stopped" ? "warning"
    : kind === "settled" ? "success" : kind === "running" ? "accent" : "muted";
  const rows: PanelRow[] = [{
    text: `  ${label(agent.name) || label(agent.id) || "unnamed"}`,
    color: "text", bold: true, tail: status, tailColor: color,
  }];
  // Never advertise a stale activity/tool on idle, queued, or terminal sessions.
  const active = kind === "running" || kind === "starting";
  const details = active ? [label(agent.liveTool), label(agent.label)] : [];
  if (expanded) details.push(label(agent.phase) || label(agent.group));
  const detail = [...new Set(details.filter(Boolean))].join(" · ");
  if (detail) rows.push({ text: `    ${detail}`, color: "muted" });
  return rows;
}

/** Expanded-only diagnostics: no repeated per-pool/per-stage totals in the default view. */
function poolRows(pools: SubagentPoolState[], width: number): PanelRow[] {
  const rows: PanelRow[] = [];
  let shownStages = 0;
  let totalStages = 0;
  for (const [index, pool] of pools.entries()) {
    const stages = Array.isArray(pool.stages) ? pool.stages.filter(Boolean) : [];
    totalStages += stages.length;
    if (index >= EXPANDED_POOLS) continue;
    const status = label(pool.status);
    rows.push({
      text: (label(pool.name) || label(pool.id) || "unnamed") + (status ? ` (${status})` : ""),
      color: "text", bold: true,
    });
    rows.push(...phrases(countPhrases({
      active: count(pool.running), queued: count(pool.queued), "results ready": count(pool.results),
    }), width));
    for (const stage of stages) {
      if (shownStages >= EXPANDED_STAGES) break;
      shownStages++;
      const stats = countPhrases({
        failed: count(stage.failed), cancelled: count(stage.cancelled),
        active: count(stage.running), queued: count(stage.queued), settled: count(stage.settled),
      });
      rows.push({
        text: `  ${label(stage.name) || label(stage.id) || "unnamed"}`,
        tail: stats.join(" · ") || "idle", color: "muted",
        tailColor: count(stage.failed) ? "error" : "dim",
      });
    }
  }
  const hidden = countPhrases({
    "pools hidden": Math.max(0, pools.length - EXPANDED_POOLS),
    "stages hidden": totalStages - shownStages,
  });
  if (hidden.length) rows.push({ text: hidden.join(" · "), color: "dim" });
  return rows;
}

/**
 * Pure square-fence panel. Aggregate counts describe all local kernel pools when
 * metrics exist, otherwise the relevant retained rows; never snapshot.totals.
 * `active` includes running/starting; `ready` is unconsumed results, not settled.
 * No clock-derived durations or mutable caches: completed snapshots stay frozen.
 */
export function renderSubagentPanel(
  snapshot: SubagentRuntimeSnapshot | undefined,
  options: SubagentPanelOptions,
): string[] {
  const width = Number.isFinite(options.width) ? Math.max(0, Math.floor(options.width)) : 0;
  if (!snapshot || width === 0) return [];
  const agents = relevantAgents({ ...snapshot, agents: Array.isArray(snapshot.agents)
    ? snapshot.agents.filter((agent) => agent && typeof agent === "object") : [] }, options.execId);
  const pools = Array.isArray(snapshot.pools)
    ? snapshot.pools.filter((pool) => pool && typeof pool === "object") : [];
  if (!agents.length && !pools.length) return [];
  const inset = width >= CELL_INSET + 24 ? CELL_INSET : 0;
  const interior = Math.max(0, width - inset - 2);
  const padding = interior >= 4 ? 1 : 0;
  const content = Math.max(0, interior - padding * 2);
  const rows: PanelRow[] = [{ text: "Subagents", color: "text", bold: true }];
  const counts = rowCounts(agents);
  if (pools.length) {
    let active = 0, queued = 0, ready = 0, settled = 0, failed = 0, cancelled = 0;
    for (const pool of pools) {
      active += count(pool.running);
      queued += count(pool.queued);
      ready += count(pool.results);
      for (const stage of Array.isArray(pool.stages) ? pool.stages : []) {
        if (!stage) continue;
        settled += count(stage.settled);
        failed += count(stage.failed);
        cancelled += count(stage.cancelled);
      }
    }
    rows.push(...phrases(countPhrases({
      active, queued, "results ready": ready, failed, cancelled, settled, "idle sessions": counts.idle,
    }), content));
  } else {
    rows.push(...phrases(countPhrases(counts), content));
  }
  // Every working agent gets a row, even when concurrency exceeds the old
  // panel limits. Only the queue is capped; idle/terminal sessions stay in totals.
  const working: SubagentAgentRow[] = [];
  const queued: SubagentAgentRow[] = [];
  const queuedLimit = options.expanded ? EXPANDED_QUEUED : COMPACT_QUEUED;
  let queuedCount = 0;
  for (const agent of agents) {
    const kind = state(agent);
    if (kind === "running" || kind === "starting") working.push(agent);
    else if (kind === "queued") {
      queuedCount++;
      if (queued.length < queuedLimit) queued.push(agent);
    }
  }
  for (const [heading, members] of [["Working", working], ["Queued", queued]] as const) {
    if (!members.length) continue;
    rows.push({ text: "" }, { text: heading, bold: true, color: "muted" });
    for (const agent of members) rows.push(...agentRows(agent, !!options.expanded));
    if (heading === "Queued" && queuedCount > queued.length) {
      rows.push({ text: `${queuedCount - queued.length} queued hidden` +
        (options.expanded ? " · panel limit" : " · expand for more"), color: "dim" });
    }
  }
  if (options.expanded && pools.length) {
    rows.push({ text: "" }, { text: "Pool detail · this kernel", bold: true, color: "muted" },
      ...poolRows(pools, content));
  }
  const theme = options.theme;
  const paint = (text: string, color: ThemeColor = "muted", bold = false): string => {
    if (!theme) return text;
    const styled = theme.fg(color, text);
    return bold && typeof theme.bold === "function" ? theme.bold(styled) : styled;
  };
  const backgroundName = options.background ?? "toolSuccessBg";
  const background = theme?.bg ? theme.getBgAnsi?.(backgroundName) : undefined;
  const paintBackground = (lines: string[]): string[] => !theme?.bg ? lines
    : lines.map((line) => theme.bg(backgroundName,
      background ? restoreBackground(line, background) : line));
  if (width === 1) return paintBackground([paint("…")]);
  const prefix = " ".repeat(inset);
  const blank = { text: "" };
  return paintBackground([
    prefix + paint(`┌${"─".repeat(interior)}┐`, "borderMuted"),
    ...[blank, ...rows, blank].map((row: PanelRow) => {
      // On narrow panes, preserve the name rather than spending all space on status.
      const tail = row.tail && content >= 20 ? clip(row.tail, Math.floor(content / 2)) : "";
      const nameWidth = tail ? content - visibleWidth(tail) - 2 : content;
      const text = clip(row.text, nameWidth);
      const gap = Math.max(0, content - visibleWidth(text) - visibleWidth(tail));
      return prefix + paint("│", "borderMuted") + " ".repeat(padding) +
        paint(text, row.color, row.bold) + " ".repeat(gap) +
        paint(tail, row.tailColor) + " ".repeat(padding) + paint("│", "borderMuted");
    }),
    prefix + paint(`└${"─".repeat(interior)}┘`, "borderMuted"),
  ]);
}
