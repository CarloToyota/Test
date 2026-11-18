// Open any supported file as a project.

import { PROJECT_EXTENSION, parseProject, type Project } from "../project";
import { importMidi } from "./midi";
import { importMusicXml, mxlToXml } from "./musicxml";

export const IMPORT_EXTENSIONS = [PROJECT_EXTENSION, "musicxml", "xml", "mxl", "mid", "midi"];

export function importFile(name: string, bytes: Uint8Array): Project {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const stem = name.replace(/\.[^.]+$/, "");
  if (ext === PROJECT_EXTENSION || ext === "json") return parseProject(new TextDecoder().decode(bytes));
  if (ext === "mxl") return importMusicXml(mxlToXml(bytes), stem);
  if (ext === "musicxml" || ext === "xml") return importMusicXml(new TextDecoder().decode(bytes), stem);
  if (ext === "mid" || ext === "midi") return importMidi(bytes, stem);
  throw new Error(`Can't open .${ext} files. Use a Band Transcriber project, MusicXML (.musicxml, .xml, .mxl) or MIDI (.mid).`);
}
