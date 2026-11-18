// Vector PDF export: the score is engraved with the same VexFlow renderer as the
// screen, one SVG per page, and converted to PDF paths (sharp at any zoom or print).
// A document holds one or more sections: the full score and/or individual parts,
// each starting on a new page.

import { jsPDF } from "jspdf";
import { svg2pdf } from "svg2pdf.js";
import { beatSteps, groupSteps, meterGlyph, meterName, type TimeSignature } from "../meter";
import { renderScore, systemHeight, type StaffInput } from "../render";

export type PageSize = "letter" | "a4";

export interface PdfSection {
  /** Shown at top left of the section's first page, e.g. "Full Score" or "B♭ Tenor Sax". */
  label: string;
  staves: StaffInput[];
}

export interface PdfOptions {
  title: string;
  timeSig: TimeSignature;
  bpm: number;
  pageSize: PageSize;
}

const MARGIN = 42; // pt
const TOP_PAD_PX = 24;
const HEADER_FIRST = 84; // pt for the title block
const HEADER_OTHER = 18;
const FOOTER = 24;

/** Draw a small tempo note (the beat unit) followed by "= bpm". */
function drawTempo(pdf: jsPDF, x: number, y: number, ts: TimeSignature, bpm: number): void {
  const beat = beatSteps(ts);
  pdf.setLineWidth(0.8);
  if (beat === 8) pdf.ellipse(x, y, 3.4, 2.4, "S");
  else pdf.ellipse(x, y, 3.4, 2.4, "F");
  pdf.line(x + 3.1, y, x + 3.1, y - 14);
  if (beat <= 3) pdf.line(x + 3.1, y - 14, x + 7.5, y - 8);
  if (beat === 1) pdf.line(x + 3.1, y - 10.5, x + 7.5, y - 4.5);
  let tx = x + 9;
  if (beat === 6 || beat === 3) {
    pdf.circle(x + 7.5, y, 0.9, "F");
    tx = x + 12;
  }
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(11);
  pdf.text(`= ${bpm}`, tx, y + 3.5);
}

export async function toPdf(sections: PdfSection[], o: PdfOptions): Promise<Uint8Array> {
  const pdf = new jsPDF({ unit: "pt", format: o.pageSize, orientation: "portrait" });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const contentW = pageW - MARGIN * 2;
  let firstPage = true;
  let pageNo = 0;
  const footers: Array<() => void> = [];

  // The renderer needs a live element for text metrics; keep it out of sight.
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-30000px;top:0;";
  document.body.appendChild(host);
  try {
    for (const section of sections) {
      const n = section.staves.length;
      // Staff size: about 8.5 mm for a part, smaller for a full score.
      const scale = n === 1 ? 0.6 : n <= 3 ? 0.5 : n <= 6 ? 0.42 : 0.36;
      const renderW = contentW / scale;
      const sysPt = systemHeight(n) * scale;
      const measureCount = Math.max(1, ...section.staves.map((s) => s.measures.length));
      const renderOpts = {
        width: renderW,
        timeSig: meterGlyph(o.timeSig),
        beamGroups: groupSteps(o.timeSig),
        ink: "#000000",
        showNames: n > 1,
      };
      // Trial layout of the whole section: where the line breaks fall.
      const trial = renderScore(host, section.staves, renderOpts);
      const rowStarts: number[] = [];
      trial.measures.forEach((m, i) => {
        if (i === 0 || m.system !== trial.measures[i - 1].system) rowStarts.push(i);
      });
      const totalRows = rowStarts.length;

      let row = 0;
      let sectionPage = 0;
      while (row < totalRows) {
        if (!firstPage) pdf.addPage(o.pageSize, "portrait");
        firstPage = false;
        pageNo += 1;
        let top = MARGIN;
        if (sectionPage === 0) {
          pdf.setTextColor(0);
          pdf.setFont("times", "bold");
          pdf.setFontSize(22);
          pdf.text(o.title || "Untitled", pageW / 2, top + 22, { align: "center" });
          pdf.setFont("helvetica", "normal");
          pdf.setFontSize(11);
          pdf.text(section.label, MARGIN, top + 52);
          pdf.text(meterName(o.timeSig), pageW - MARGIN, top + 52, { align: "right" });
          drawTempo(pdf, MARGIN + 6, top + 74, o.timeSig, o.bpm);
          top += HEADER_FIRST;
        } else {
          pdf.setFont("helvetica", "italic");
          pdf.setFontSize(9);
          pdf.text(`${o.title || "Untitled"} · ${section.label}`, MARGIN, top + 8);
          top += HEADER_OTHER;
        }
        const room = pageH - MARGIN - FOOTER - top - TOP_PAD_PX * scale;
        const rowsHere = Math.max(1, Math.floor(room / sysPt));
        const from = rowStarts[row];
        const to = row + rowsHere < totalRows ? rowStarts[row + rowsHere] : measureCount;

        const staves: StaffInput[] = section.staves.map((s) => {
          const pm = from > 0 ? s.measures[from - 1] : undefined;
          const prev = pm ? pm.items[pm.items.length - 1] : undefined;
          return { ...s, measures: s.measures.slice(from, to), tieIn: !!prev?.tieToNext, isSelected: undefined };
        });
        const layout = renderScore(host, staves, {
          ...renderOpts,
          showTimeSig: sectionPage === 0,
          firstMeasureNumber: from + 1,
          finalBarline: to >= measureCount,
        });
        const svg = host.querySelector("svg");
        // svg2pdf ignores "pt" font sizes and unknown families: use px and a PDF base font.
        svg?.querySelectorAll("text").forEach((t) => {
          const size = t.getAttribute("font-size") ?? "";
          if (size.endsWith("pt")) t.setAttribute("font-size", String((parseFloat(size) * 4) / 3));
          t.setAttribute("font-family", "helvetica");
        });
        if (svg) await svg2pdf(svg, pdf, { x: MARGIN, y: top, width: contentW, height: layout.height * scale });

        const thisPage = pageNo;
        footers.push(() => {
          pdf.setPage(thisPage);
          pdf.setFont("helvetica", "normal");
          pdf.setFontSize(9);
          pdf.text(`${thisPage} / ${pageNo}`, pageW / 2, pageH - MARGIN / 2, { align: "center" });
        });
        row += rowsHere;
        sectionPage += 1;
      }
    }
    footers.forEach((f) => f());
  } finally {
    host.remove();
  }
  return new Uint8Array(pdf.output("arraybuffer"));
}
