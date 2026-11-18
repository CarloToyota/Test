// Saving generated files: a native Save dialog in the app, a download in a browser.

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../bridge";

export interface SaveRequest {
  bytes: Uint8Array;
  defaultName: string;
  filterName: string;
  extension: string;
  mime: string;
}

/** Returns the saved path, or null if the person cancelled. */
export async function saveFile(r: SaveRequest): Promise<string | null> {
  if (isTauri()) {
    return invoke<string | null>("save_export", {
      defaultName: r.defaultName,
      filterName: r.filterName,
      extensions: [r.extension],
      contents: Array.from(r.bytes),
    });
  }
  const url = URL.createObjectURL(new Blob([r.bytes as BlobPart], { type: r.mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = r.defaultName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return r.defaultName;
}

/** A filesystem-safe file name from a title. */
export function fileStem(title: string): string {
  const s = title.trim().replace(/[^\p{L}\p{N} _-]+/gu, "").replace(/\s+/g, " ");
  return s || "Transcription";
}
