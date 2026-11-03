import * as fs from "node:fs/promises";
import { notebookImages, notebookText, type NotebookMimeOutput } from "../execution/notebook-output";
import type { HostedKernel } from "./protocol";

type NotebookOutput = { kind: "text" | "error"; text: string } | { kind: "image"; mimeType: string; data: string };
interface NotebookCell {
  id: string;
  index: number;
  cellType: "code" | "markdown" | "raw";
  source: string;
  executionCount: number | null;
  outputs: NotebookOutput[];
}
interface StoredOutput extends NotebookMimeOutput {
  output_type?: string;
  text?: unknown;
  traceback?: unknown;
  ename?: string;
  evalue?: string;
}
interface StoredCell {
  id?: string;
  cell_type?: string;
  source?: unknown;
  execution_count?: number;
  outputs?: StoredOutput[];
}

function cellSnapshot(cell: StoredCell, index: number): NotebookCell {
  const outputs: NotebookOutput[] = [];
  const stored = Array.isArray(cell.outputs) ? cell.outputs : [];
  const images = notebookImages(stored);
  let nextImage = 0;
  for (const output of stored) {
    if (!output || typeof output !== "object") continue;
    if (output.output_type === "error") {
      const traceback = Array.isArray(output.traceback) ? output.traceback.join("\n") : notebookText(output.traceback);
      outputs.push({ kind: "error", text: traceback || `${output.ename ?? "Error"}: ${output.evalue ?? ""}` });
      continue;
    }
    const image = notebookImages([output])[0];
    if (image) {
      if (nextImage < images.length) outputs.push({ kind: "image", ...images[nextImage++]! });
      continue;
    }
    const text = notebookText(output.text) || notebookText(output.data?.["text/plain"]);
    if (text) outputs.push({ kind: "text", text });
  }
  return {
    id: typeof cell.id === "string" && cell.id ? cell.id : `cell-${index}`,
    index,
    cellType: cell.cell_type === "markdown" || cell.cell_type === "raw" ? cell.cell_type : "code",
    source: notebookText(cell.source),
    executionCount: Number.isInteger(cell.execution_count) && cell.execution_count! >= 0 ? cell.execution_count! : null,
    outputs,
  };
}

export async function notebookSnapshot(kernels: readonly HostedKernel[]) {
  const notebooks = await Promise.all(kernels.filter(kernel => kernel.notebookPath).map(async kernel => {
    let cells: StoredCell[] = [];
    try {
      const file = await fs.open(kernel.notebookPath!, "r");
      try {
        if ((await file.stat()).size > 16 * 1024 * 1024) throw new Error(`Notebook exceeds the 16 MiB viewer limit: ${kernel.notebookPath}`);
        const document = JSON.parse(await file.readFile("utf8"));
        if (!Array.isArray(document.cells)) throw new Error(`Invalid notebook cells: ${kernel.notebookPath}`);
        cells = document.cells;
      } finally { await file.close(); }
    } catch (error) {
      // A freshly provisioned scratch notebook is created by its first recorded cell.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { id: kernel.id, name: kernel.name, notebookPath: kernel.notebookPath!, running: kernel.running,
      cells: cells.map((cell, i) => cellSnapshot(cell, i + 1)) };
  }));
  return { version: 1 as const, kernels: notebooks };
}
