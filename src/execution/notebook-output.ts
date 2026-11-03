export interface NotebookImage { mimeType: string; data: string; }
export interface NotebookMimeOutput { data?: Record<string, unknown>; }

export function notebookText(value: unknown): string {
  return typeof value === "string" ? value : Array.isArray(value) ? value.filter(part => typeof part === "string").join("") : "";
}

/** One preferred raster per MIME bundle, shared by notebook readers and model results. */
export function notebookImages(outputs: readonly NotebookMimeOutput[]): NotebookImage[] {
  const images: NotebookImage[] = [];
  for (const output of outputs) {
    for (const mimeType of ["image/png", "image/jpeg", "image/webp", "image/gif"]) {
      const data = notebookText(output.data?.[mimeType]).replace(/\s/g, "");
      if (data) { images.push({ mimeType, data }); break; }
    }
    if (images.length === 4) break;
  }
  return images;
}
