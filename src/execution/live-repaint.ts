import type { ToolUpdateCallback } from "../contracts/tool-types";

/** Refresh a live execution during silent awaits; owned by the execution's finally block. */
export function createLiveRepaint(
  onUpdate: ToolUpdateCallback | undefined,
  intervalMs = 120,
): { onUpdate: ToolUpdateCallback | undefined; stop: () => void } {
  if (!onUpdate) return { onUpdate: undefined, stop: () => {} };
  let latest: Parameters<ToolUpdateCallback>[0] | undefined;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped || !latest) return;
    const details = latest.details;
    // Queued/document updates aren't evidence that a kernel is executing.
    if (!details || typeof details !== "object" || !("execId" in details) || !details.execId) return;
    onUpdate({ ...latest, details: { ...details } });
  }, intervalMs);
  timer.unref?.();
  return {
    onUpdate: (update) => {
      if (stopped) return;
      latest = update;
      onUpdate(update);
    },
    stop: () => {
      stopped = true;
      latest = undefined;
      clearInterval(timer);
    },
  };
}
