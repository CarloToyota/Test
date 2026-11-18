// Vector PDF export: the score is engraved with the same VexFlow renderer as the
// screen, one SVG per page, and converted to PDF paths (sharp at any zoom or print).

import { jsPDF } from "jspdf";
import { svg2pdf } from "svg2pdf.js";
import { beatSteps, measureSteps, meterName, type TimeSignature } from "../meter";
import type { ScoreMeasure } from "../quantize";
import { ROW_HEIGHT, TOP_PAD, renderScore } from "../render";
import type { Clef } from "../types";

export type PageSize = "letter" | "a4";

export interface PdfOptions {
  title: string;
  /** Shown at top left, e.g. "B♭ Tenor Sax". */
  partName: string;
  clef: Clef;
  keySignature: string;
  timeSig: TimeSignature;
  bpm: number;
  pageSize: PageSize;
}

const MARGIN = 48; // pt
/** Staff size: VexFlow's 40 px staff printed at 24 pt (about 8.5 mm). */
const SCALE = 0.6;
const HEADER_FIRST = 84; // pt for title block on page 1
const HEADER_OTHER = 18;
const FOOTER = 24;

function measuresPerRow(ts: TimeSignature): number {
  const spm = measureSteps(ts);
  return spm <= 8 ? 5 : spm <= 16 ? 4 : 3;
}

/** Draw a small tempo note (the beat unit) followed by "= bpm". */
function drawTempo(pdf: jsPDF, x: number, y: number, ts: TimeSignature, bpm: number): void {
  const beat = beatSteps(ts);
  pdf.setLineWidth(0.8);
  if (beat === 8) pdf.ellipse(x, y, 3.4, 2.4, "S");
  else pdf.ellipse(x, y, 3.4, 2.4, "F");
  pdf.line(x + 3.1, y, x + 3.1, y - 14);
  if (beat === 2) pdf.line(x + 3.1, y - 14, x + 7.5, y - 8);
  let tx = x + 9;
  if (beat === 6) {
    pdf.circle(x + 7.5, y, 0.9, "F");
    tx = x + 12;
  }
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(11);
  pdf.text(`= ${bpm}`, tx, y + 3.5);
}

export async function toPdf(measures: ScoreMeasure[], o: PdfOptions): Promise<Uint8Array> {
  const pdf = new jsPDF({ unit: "pt", format: o.pageSize, orientation: "portrait" });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const contentW = pageW - MARGIN * 2;
  const renderW = contentW / SCALE;
  const perRow = measuresPerRow(o.timeSig);
  const rowPt = ROW_HEIGHT * SCALE;

  const rowsFirst = Math.max(1, Math.floor((pageH - MARGIN * 2 - HEADER_FIRST - FOOTER - TOP_PAD * SCALE) / rowPt));
  const rowsOther = Math.max(1, Math.floor((pageH - MARGIN * 2 - HEADER_OTHER - FOOTER - TOP_PAD * SCALE) / rowPt));
  const totalRows = Math.max(1, Math.ceil(measures.length / perRow));
  const pages: Array<[number, number]> = [];
  let row = 0;
  while (row < totalRows) {
    const n = pages.length === 0 ? rowsFirst : rowsOther;
    pages.push([row * perRow, Math.min(measures.length, (row + n) * perRow)]);
    row += n;
  }
  if (pages.length === 0) pages.push([0, 0]);

  // The renderer needs a live element for text metrics; keep it out of sight.
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-20000px;top:0;width:" + renderW + "px;";
  document.body.appendChild(host);
  try {
    for (let p = 0; p < pages.length; p++) {
      if (p > 0) pdf.addPage(o.pageSize, "portrait");
      const [from, to] = pages[p];
      let top = MARGIN;

      if (p === 0) {
        pdf.setTextColor(0);
        pdf.setFont("times", "bold");
        pdf.setFontSize(22);
        pdf.text(o.title || "Untitled", pageW / 2, top + 22, { align: "center" });
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(11);
        pdf.text(o.partName, MARGIN, top + 52);
        pdf.text(meterName(o.timeSig), pageW - MARGIN, top + 52, { align: "right" });
        drawTempo(pdf, MARGIN + 6, top + 74, o.timeSig, o.bpm);
        top += HEADER_FIRST;
      } else {
        pdf.setFont("helvetica", "italic");
        pdf.setFontSize(9);
        pdf.text(`${o.title || "Untitled"} · ${o.partName}`, MARGIN, top + 8);
        top += HEADER_OTHER;
      }

      const slice = measures.slice(from, to);
      const prev = from > 0 ? measures[from - 1].items[measures[from - 1].items.length - 1] : undefined;
      const { height } = renderScore(host, slice, {
        width: renderW,
        clef: o.clef,
        keySignature: o.keySignature,
        timeSig: meterName(o.timeSig),
        ink: "#000000",
        measuresPerRow: perRow,
        showTimeSig: p === 0,
        firstMeasureNumber: from + 1,
        tieIn: !!prev?.tieToNext,
        finalBarline: p === pages.length - 1,
      });
      const svg = host.querySelector("svg");
      if (svg) await svg2pdf(svg, pdf, { x: MARGIN, y: top, width: contentW, height: height * SCALE });

      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(9);
      pdf.text(`${p + 1} / ${pages.length}`, pageW / 2, pageH - MARGIN / 2, { align: "center" });
    }
  } finally {
    host.remove();
  }
  return new Uint8Array(pdf.output("arraybuffer"));
}
