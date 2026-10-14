import type { SessionSummary, SubagentRuntimeSnapshot } from "../contracts/execution-types";
export interface HostedKernel extends SessionSummary {
  name: string;
  ownerSessionId: string;
  pythonExecutable?: string;
  snapshot?: SubagentRuntimeSnapshot | null;
  lastOperation?: Pick<HostOperation, "id" | "method" | "status" | "startedAt" | "finishedAt">;
}
export interface HostOperation {
  id: string;
  ownerSessionId: string;
  method: string;
  kernelId?: string;
  status: "running" | "completed" | "failed";
  startedAt: number;
  finishedAt?: number;
  result?: unknown;
  error?: SerializedError;
  update?: unknown;
}
export interface HostState { kernels: HostedKernel[]; operations: HostOperation[]; pid: number; }
export interface SerializedError { name: string; message: string; rawMessage?: string; traceback?: string; }
export function serializeError(error: unknown): SerializedError {
  const e = error as Error & { rawMessage?: string; traceback?: string };
  return { name: e?.name ?? "Error", message: e?.message ?? String(error), rawMessage: e?.rawMessage, traceback: e?.traceback };
}
export function cleanArguments(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (key, item) =>
    key === "ctx" || key === "signal" || typeof item === "function" ? undefined : item));
}
export const HOST_PROTOCOL_VERSION = 1;
