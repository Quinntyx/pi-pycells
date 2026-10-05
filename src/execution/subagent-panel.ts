/** Flat, bounded subagent status appended by the notebook renderer below Out. */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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

const COMPACT_AGENTS = 4;
const EXPANDED_AGENTS = 12;
const COMPACT_POOLS = 1;
const EXPANDED_POOLS = 3;
const COMPACT_STAGES = 2;
const EXPANDED_STAGES = 6;
// Cell boxes reserve a 12-column label/metadata gutter plus inset and separator.
const CELL_INSET = 14;

interface PanelRow {
  text: string;
  color?: ThemeColor;
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

/** Pack whole count phrases; even a one-column viewport has bounded row count. */
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

function priority(agent: SubagentAgentRow): number {
  return ["running", "starting", "queued", "idle", "failed", "cancelled",
    "stopped", "closed", "other", "settled"].indexOf(state(agent));
}

/** Keep only the bounded best rows, stable within each status, without sorting the roster. */
function visibleAgents(agents: SubagentAgentRow[], limit: number): SubagentAgentRow[] {
  const selected: SubagentAgentRow[] = [];
  for (const agent of agents) {
    const rank = priority(agent);
    const index = selected.findIndex((row) => priority(row) > rank);
    if (index < 0) {
      if (selected.length < limit) selected.push(agent);
    } else {
      selected.splice(index, 0, agent);
      if (selected.length > limit) selected.pop();
    }
  }
  return selected;
}

function agentRow(agent: SubagentAgentRow, width: number): PanelRow {
  const kind = state(agent);
  const status = kind === "other" ? label(agent.status) || "unknown" : kind;
  const name = clip(label(agent.name) || label(agent.id) || "unnamed",
    Math.min(18, Math.floor(width / 4)));
  const base = `${clip(status, 12)} ${name}`;
  // Idle and terminal sessions must not advertise a stale tool as currently executing.
  const active = kind === "running" || kind === "starting";
  const fields = [
    ["phase", label(agent.phase) || label(agent.group)],
    ["activity", label(agent.label)],
    ["tool", active ? label(agent.liveTool) : ""],
  ].filter((field) => field[1]);
  let text = base;
  if (fields.length) {
    const overhead = fields.reduce((sum, field) => sum + field[0]!.length + 5, 0);
    const budget = Math.floor((width - visibleWidth(base) - overhead) / fields.length);
    if (budget >= 3) {
      text += fields.map(([key, value]) => ` · ${key}: ${clip(value!, budget)}`).join("");
    } else {
      // At narrow widths prioritize the live tool, then activity, then phase.
      text += [...fields].reverse().map(([key, value]) => ` · ${key}: ${value}`).join("");
    }
  }
  const color: ThemeColor = kind === "failed" ? "error"
    : kind === "cancelled" || kind === "stopped" ? "warning"
    : kind === "settled" ? "success" : active ? "accent" : "muted";
  return { text, color };
}

function poolRows(pools: SubagentPoolState[], expanded: boolean): PanelRow[] {
  const rows: PanelRow[] = [];
  const poolLimit = expanded ? EXPANDED_POOLS : COMPACT_POOLS;
  const stageLimit = expanded ? EXPANDED_STAGES : COMPACT_STAGES;
  let shownStages = 0;
  let totalStages = 0;
  for (const [index, pool] of pools.entries()) {
    const stages = Array.isArray(pool.stages) ? pool.stages.filter(Boolean) : [];
    totalStages += stages.length;
    if (index >= poolLimit) continue;
    rows.push({
      text: `pool ${label(pool.name) || label(pool.id) || "unnamed"} (${label(pool.status)}): ` +
        `${count(pool.running)} running/starting · ${count(pool.queued)} queued · ` +
        `${count(pool.results)} ready`,
      color: "muted",
    });
    for (const stage of stages) {
      if (shownStages >= stageLimit) break;
      shownStages++;
      const running = count(stage.running);
      const queued = count(stage.queued);
      const settled = count(stage.settled);
      const failed = count(stage.failed);
      const cancelled = count(stage.cancelled);
      const activity = running || queued ? `${running} running/starting · ${queued} queued` : "idle";
      rows.push({
        text: `phase ${label(stage.name) || label(stage.id) || "unnamed"}: ${activity}` +
          ` · ${settled} settled · ${failed} failed · ${cancelled} cancelled`,
        color: "muted",
      });
    }
  }
  if (pools.length > poolLimit || totalStages > shownStages) {
    rows.push({
      text: `${Math.max(0, pools.length - poolLimit)} pools / ` +
        `${totalStages - shownStages} phases hidden`,
      color: "dim",
    });
  }
  return rows;
}

/**
 * Pure square-fence panel. Counts describe all pools when pool metrics exist,
 * otherwise the relevant retained rows (never snapshot.totals, which folds
 * starting/idle into running and cancelled/stopped into failed). `ready` is
 * an unconsumed result queue, not a terminal outcome count. No clock-derived
 * durations or mutable caches: a completed snapshot stays frozen at any now.
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
  // Preserve the normal Out fence column, but sacrifice the gutter in narrow panes.
  const inset = width >= CELL_INSET + 24 ? CELL_INSET : 0;
  const interior = Math.max(0, width - inset - 2);
  const rows: PanelRow[] = [{ text: pools.length ? "Subagents · pool totals" : "Subagents · row totals",
    color: "accent" }];
  const counts = rowCounts(agents);
  if (pools.length) {
    let running = 0, queued = 0, ready = 0, settled = 0, failed = 0, cancelled = 0;
    for (const pool of pools) {
      running += count(pool.running);
      queued += count(pool.queued);
      ready += count(pool.results);
      for (const stage of Array.isArray(pool.stages) ? pool.stages : []) {
        if (!stage) continue;
        settled += count(stage.settled);
        failed += count(stage.failed);
        cancelled += count(stage.cancelled);
      }
    }
    rows.push(...phrases([
      `${running} running/starting`, `${queued} queued`, `${ready} ready`,
      `${settled} settled`, `${failed} failed`, `${cancelled} cancelled`,
    ], interior));
    if (counts.idle) rows.push({ text: `${counts.idle} idle retained sessions`, color: "muted" });
    rows.push(...poolRows(pools, !!options.expanded));
  } else {
    rows.push(...phrases(Object.entries(counts)
      .filter(([key, value]) => value || key === "running" || key === "queued")
      .map(([key, value]) => `${value} ${key}`), interior));
  }
  const shown = visibleAgents(agents, options.expanded ? EXPANDED_AGENTS : COMPACT_AGENTS);
  rows.push(...shown.map((agent) => agentRow(agent, interior)));
  if (agents.length > shown.length) {
    rows.push({ text: `${agents.length - shown.length} agents hidden` +
      (options.expanded ? " (panel limit)" : " · expand for more"), color: "dim" });
  }
  const theme = options.theme;
  const paint = (text: string, color: ThemeColor = "muted"): string =>
    theme ? theme.fg(color, text) : text;
  // One column cannot hold both fences; use a bounded minimal marker instead.
  if (width === 1) return [paint("…")];
  const prefix = " ".repeat(inset);
  return [
    prefix + paint(`┌${"─".repeat(interior)}┐`),
    ...rows.map((row) => {
      const text = clip(row.text, interior);
      return prefix + paint("│") + paint(text, row.color) +
        " ".repeat(Math.max(0, interior - visibleWidth(text))) + paint("│");
    }),
    prefix + paint(`└${"─".repeat(interior)}┘`),
  ];
}
