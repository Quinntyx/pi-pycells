import { PtcProtocolError } from "./execution/execution-errors";
import type { RpcMessage, PtcImageArtifact, SubagentRuntimeSnapshot } from "./contracts/execution-types";

/** Structural type guards for incoming RPC frames (see validateRpcMessage). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}



function isPtcImageArtifact(value: unknown): value is PtcImageArtifact {
  return (
    isRecord(value) &&
    isString(value.mimeType) &&
    isString(value.data) &&
    (value.width === undefined || (typeof value.width === "number" && Number.isFinite(value.width))) &&
    (value.height === undefined || (typeof value.height === "number" && Number.isFinite(value.height)))
  );
}

function validateImages(value: unknown, frameType: "complete" | "exec_done"): PtcImageArtifact[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every(isPtcImageArtifact)) {
    throw new PtcProtocolError(
      `Invalid ${frameType} frame: images must be an array of { mimeType: string, data: string } artifacts.`
    );
  }
  return value;
}

type RpcMessageType = RpcMessage["type"];
type RpcMessageValidator<TType extends RpcMessageType> = (
  value: Record<string, unknown>
) => Extract<RpcMessage, { type: TType }>;





function validateExecutionProgressMessage(
  value: Record<string, unknown>
): Extract<RpcMessage, { type: "execution_progress" }> {
  if (typeof value.line === "number" && typeof value.total_lines === "number") {
    return {
      type: "execution_progress",
      line: value.line,
      total_lines: value.total_lines,
    };
  }

  throw new PtcProtocolError("Invalid execution_progress frame: expected numeric line and total_lines.");
}

function validateStdoutMessage(value: Record<string, unknown>): Extract<RpcMessage, { type: "stdout" }> {
  if (isString(value.text)) {
    return { type: "stdout", text: value.text };
  }

  throw new PtcProtocolError("Invalid stdout frame: expected string text.");
}

function validateCompleteMessage(value: Record<string, unknown>): Extract<RpcMessage, { type: "complete" }> {
  const totalOutputChars = value.total_output_chars;
  if (
    !isString(value.output) ||
    (totalOutputChars !== undefined &&
      !(typeof totalOutputChars === "number" && Number.isFinite(totalOutputChars) && totalOutputChars >= 0))
  ) {
    throw new PtcProtocolError(
      "Invalid complete frame: expected string output and optional non-negative total_output_chars."
    );
  }

  return {
    type: "complete",
    output: value.output,
    images: validateImages(value.images, "complete"),
    total_output_chars: totalOutputChars,
  };
}

function validateErrorMessage(value: Record<string, unknown>): Extract<RpcMessage, { type: "error" }> {
  if (isString(value.message) && (value.traceback === undefined || isString(value.traceback))) {
    return {
      type: "error",
      message: value.message,
      traceback: value.traceback,
    };
  }

  throw new PtcProtocolError("Invalid error frame: expected string message and optional traceback.");
}

function validateUpdateMessage(value: Record<string, unknown>): Extract<RpcMessage, { type: "update" }> {
  if (isString(value.message)) {
    return { type: "update", message: value.message };
  }

  throw new PtcProtocolError("Invalid update frame: expected string message.");
}

function validateExecDoneMessage(value: Record<string, unknown>): Extract<RpcMessage, { type: "exec_done" }> {
  if (!isString(value.id) || !isString(value.output)) {
    throw new PtcProtocolError("Invalid exec_done frame: expected string id and output.");
  }
  const echo = value.echo;
  if (echo !== undefined && echo !== null && !isString(echo)) {
    throw new PtcProtocolError("Invalid exec_done frame: echo must be a string when present.");
  }
  const kernelText = value.kernel_text;
  if (kernelText !== undefined && kernelText !== null && !isString(kernelText)) {
    throw new PtcProtocolError("Invalid exec_done frame: kernel_text must be a string when present.");
  }
  const subagentsText = value.subagents_text;
  if (subagentsText !== undefined && subagentsText !== null && !isString(subagentsText)) {
    throw new PtcProtocolError("Invalid exec_done frame: subagents_text must be a string when present.");
  }
  const totalOutputChars = value.total_output_chars;
  if (totalOutputChars !== undefined && !(typeof totalOutputChars === "number" && Number.isFinite(totalOutputChars) && totalOutputChars >= 0)) {
    throw new PtcProtocolError("Invalid exec_done frame: total_output_chars must be a non-negative number.");
  }
  const cell = value.cell;
  if (cell !== undefined && !(typeof cell === "number" && Number.isInteger(cell) && cell > 0)) {
    throw new PtcProtocolError("Invalid exec_done frame: cell must be a positive integer.");
  }
  return {
    type: "exec_done",
    id: value.id,
    output: value.output,
    echo: echo ?? undefined,
    kernel_text: kernelText ?? undefined,
    subagents_text: subagentsText ?? undefined,
    images: validateImages(value.images, "exec_done"),
    total_output_chars: totalOutputChars,
    cell,
  };
}

function validateExecErrorMessage(value: Record<string, unknown>): Extract<RpcMessage, { type: "exec_error" }> {
  if (
    !isString(value.id) ||
    !isString(value.message) ||
    (value.traceback !== undefined && !isString(value.traceback)) ||
    (value.interrupted !== undefined && typeof value.interrupted !== "boolean") ||
    (value.line !== undefined && !(typeof value.line === "number" && Number.isFinite(value.line))) ||
    (value.source !== undefined && !isString(value.source))
  ) {
    throw new PtcProtocolError(
      "Invalid exec_error frame: expected string id/message and valid optional traceback/interrupted/line/source fields."
    );
  }
  return {
    type: "exec_error",
    id: value.id,
    message: value.message,
    traceback: value.traceback,
    interrupted: value.interrupted,
    line: value.line,
    source: value.source,
  };
}

function validateSessionReadyMessage(value: Record<string, unknown>): Extract<RpcMessage, { type: "session_ready" }> {
  return { type: "session_ready" };
}

function validateSubagentStateMessage(value: Record<string, unknown>): Extract<RpcMessage, { type: "subagent_state" }> {
  if (!isRecord(value.snapshot) || !Array.isArray(value.snapshot.agents)) {
    throw new PtcProtocolError("Invalid subagent_state frame: expected object snapshot with an agents array.");
  }
  return { type: "subagent_state", snapshot: value.snapshot as unknown as SubagentRuntimeSnapshot };
}

function validateScriptExportedMessage(value: Record<string, unknown>): Extract<RpcMessage, { type: "script_exported" }> {
  if (!isString(value.id) || !isString(value.path) || typeof value.cells !== "number") {
    throw new PtcProtocolError("Invalid script_exported frame: expected string id/path and numeric cells.");
  }
  return {
    type: "script_exported",
    id: value.id,
    path: value.path,
    cells: value.cells,
    wrapped_async: value.wrapped_async === true,
    error: isString(value.error) ? value.error : undefined,
  };
}

const RPC_MESSAGE_VALIDATORS: { [K in RpcMessageType]: RpcMessageValidator<K> } = {
  execution_progress: validateExecutionProgressMessage,
  stdout: validateStdoutMessage,
  complete: validateCompleteMessage,
  error: validateErrorMessage,
  update: validateUpdateMessage,
  exec_done: validateExecDoneMessage,
  exec_error: validateExecErrorMessage,
  session_ready: validateSessionReadyMessage,
  subagent_state: validateSubagentStateMessage,
  script_exported: validateScriptExportedMessage,
};

/**
 * Validate and normalize one parsed RPC frame from Python. Throws
 * PtcProtocolError for unknown frame types or fields of the wrong shape, so a
 * buggy runtime fails loudly instead of silently producing undefined fields.
 */
export function validateRpcMessage(value: unknown): RpcMessage {
  if (!isRecord(value) || !isString(value.type)) {
    throw new PtcProtocolError("RPC frame must be an object with a string type field.");
  }

  if (!(value.type in RPC_MESSAGE_VALIDATORS)) {
    throw new PtcProtocolError(`Unknown RPC frame type: ${value.type}`);
  }

  return RPC_MESSAGE_VALIDATORS[value.type as RpcMessageType](value);
}
