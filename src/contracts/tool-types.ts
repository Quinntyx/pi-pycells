import type {
  AgentToolUpdateCallback,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";

/** Canonical names registered by this extension in registerPtcTools(). */
export const KERNEL_TOOL_NAMES = ["provision_kernel", "exec_cell", "read_cell_output", "inspect_kernel", "provision_dependency", "scratch_run", "write_cell", "delete_cell", "read_cells", "read_cell", "request_cell_review", "run_cell", "run_to", "run_all", "reset_kernel"] as const;

export type PtcToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown> = ToolDefinition<TParams, TDetails>;

export interface LoadedTool {
  tool: PtcToolDefinition;
  filename: string;
}

export type ToolUpdateCallback = AgentToolUpdateCallback<unknown>;
