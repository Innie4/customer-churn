/**
 * CSV and PDF rendering for reports.
 *
 * Both renderers are pure functions from data to bytes. They contain no
 * database access and no request context, so a report's contents are decided by
 * its inputs and nothing else.
 *
 * The PDF uses the built-in Helvetica faces, so it needs no font files and
 * cannot fail on a machine without system fonts installed.
 */

import "server-only";

import PDFDocument from "pdfkit";

export type ReportFormat = "pdf" | "csv";

export interface ReportSection {
  heading: string;
  /** Optional prose under the heading. */
  intro?: string;
  /** A key/value block. */
  facts?: { label: string; value: string }[];
  /** A table. The first row is treated as the header. */
  table?: {
    columns: string[];
    rows: (string | number | null | undefined)[][];
    /** Optional per-column alignment. */
    align?: ("left" | "right" | "center")[];
  };
  /** A list of notes or caveats. */
  notes?: string[];
  /** A horizontal bar chart, drawn from already-computed values. */
  bars?: {
    label: string;
    value: number;
    display: string;
    /** Positive bars use the risk colour, negative the protective one. */
    tone?: "risk" | "protective" | "neutral";
  }[];
}

export interface ReportDocument {
  title: string;
  subtitle?: string;
  /** Rendered as a metadata block on the first page. */
  meta: { label: string; value: string }[];
  sections: ReportSection[];
  /** Printed on the final page. */
  footer?: string;
}

// Restrained palette, matching the interface. Colour carries meaning.
const INK = "#111827";
const MUTED = "#6b7280";
const RULE = "#d1d5db";
const RISK = "#b91c1c";
const PROTECTIVE = "#047857";
const ACCENT = "#3730a3";

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  // Quote when the value could otherwise break the row, and double any quote
  // inside it.
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Render sections as CSV. Each section becomes a block, with a blank line between. */
export function renderCsv(document: ReportDocument): string {
  const lines: string[] = [];

  lines.push(csvCell(document.title));
  if (document.subtitle) lines.push(csvCell(document.subtitle));
  lines.push("");

  if (document.meta.length) {
    lines.push(["Field", "Value"].map(csvCell).join(","));
    for (const fact of document.meta) {
      lines.push([csvCell(fact.label), csvCell(fact.value)].join(","));
    }
    lines.push("");
  }

  for (const section of document.sections) {
    lines.push(csvCell(section.heading));
    if (section.intro) lines.push(csvCell(section.intro));
    lines.push("");

    if (section.facts?.length) {
      lines.push(["Field", "Value"].map(csvCell).join(","));
      for (const fact of section.facts) {
        lines.push([csvCell(fact.label), csvCell(fact.value)].join(","));
      }
      lines.push("");
    }

    if (section.table) {
      lines.push(section.table.columns.map(csvCell).join(","));
      for (const row of section.table.rows) {
        lines.push(row.map(csvCell).join(","));
      }
      lines.push("");
    }

    if (section.bars?.length) {
      lines.push(["Item", "Value", "Display"].map(csvCell).join(","));
      for (const bar of section.bars) {
        lines.push(
          [csvCell(bar.label), csvCell(bar.value), csvCell(bar.display)].join(","),
        );
      }
      lines.push("");
    }

    if (section.notes?.length) {
      for (const note of section.notes) lines.push(csvCell(note));
      lines.push("");
    }
  }

  if (document.footer) {
    lines.push("");
    lines.push(csvCell(document.footer));
  }

  return lines.join("\r\n");
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

const PAGE_MARGIN = 56;

function toneColour(tone: "risk" | "protective" | "neutral" | undefined): string {
  if (tone === "risk") return RISK;
  if (tone === "protective") return PROTECTIVE;
  return ACCENT;
}

function percent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

function number(value: number | null | undefined, digits = 4): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toFixed(digits);
}

/** Render a report document to PDF bytes. */
export function renderPdf(document: ReportDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({
      size: "A4",
      margins: { top: PAGE_MARGIN, bottom: PAGE_MARGIN, left: PAGE_MARGIN, right: PAGE_MARGIN },
      info: {
        Title: document.title,
        Author: "Interpretable Customer Churn Platform",
        Subject: document.subtitle ?? "Model and retention report",
      },
      autoFirstPage: true,
    });

    const chunks: Buffer[] = [];
    pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);

    const contentWidth =
      pdf.page.width - PAGE_MARGIN * 2;

    // -- title block
    pdf.fillColor(INK).font("Helvetica-Bold").fontSize(20).text(document.title, {
      lineGap: 2,
    });
    if (document.subtitle) {
      pdf
        .moveDown(0.3)
        .fillColor(MUTED)
        .font("Helvetica")
        .fontSize(11)
        .text(document.subtitle);
    }

    pdf.moveDown(0.8);

    if (document.meta.length) {
      const labelX = PAGE_MARGIN;
      const valueX = PAGE_MARGIN + 170;
      for (const fact of document.meta) {
        const y = pdf.y;
        pdf
          .fillColor(MUTED)
          .font("Helvetica")
          .fontSize(9)
          .text(fact.label, labelX, y, { width: 160 });
        pdf
          .fillColor(INK)
          .font("Helvetica")
          .fontSize(9)
          .text(fact.value, valueX, y, { width: contentWidth - 170 });
        pdf.moveDown(0.25);
      }
      pdf.moveDown(0.4);
      drawRule(pdf, contentWidth);
      pdf.moveDown(0.6);
    }

    // -- sections
    for (const section of document.sections) {
      ensureSpace(pdf, 140);

      pdf
        .fillColor(INK)
        .font("Helvetica-Bold")
        .fontSize(13)
        .text(section.heading);
      pdf.moveDown(0.3);

      if (section.intro) {
        pdf.fillColor(MUTED).font("Helvetica").fontSize(9.5).text(section.intro);
        pdf.moveDown(0.5);
      }

      if (section.facts?.length) {
        for (const fact of section.facts) {
          const y = pdf.y;
          pdf.fillColor(MUTED).font("Helvetica").fontSize(9).text(fact.label, PAGE_MARGIN, y, { width: 220 });
          pdf.fillColor(INK).font("Helvetica").fontSize(9).text(fact.value, PAGE_MARGIN + 230, y, {
            width: contentWidth - 230,
          });
          pdf.moveDown(0.22);
        }
        pdf.moveDown(0.4);
      }

      if (section.table) {
        drawTable(pdf, section.table, contentWidth);
        pdf.moveDown(0.6);
      }

      if (section.bars?.length) {
        drawBars(pdf, section.bars, contentWidth);
        pdf.moveDown(0.6);
      }

      if (section.notes?.length) {
        for (const note of section.notes) {
          ensureSpace(pdf, 40);
          pdf
            .fillColor(MUTED)
            .font("Helvetica")
            .fontSize(9)
            .text(`•  ${note}`, { width: contentWidth });
          pdf.moveDown(0.2);
        }
        pdf.moveDown(0.4);
      }
    }

    if (document.footer) {
      ensureSpace(pdf, 70);
      pdf.moveDown(0.6);
      drawRule(pdf, contentWidth);
      pdf.moveDown(0.4);
      pdf.fillColor(MUTED).font("Helvetica-Oblique").fontSize(8.5).text(document.footer, {
        width: contentWidth,
      });
    }

    // Page numbers on every page.
    const range = pdf.bufferedPageRange();
    for (let index = range.start; index < range.start + range.count; index += 1) {
      pdf.switchToPage(index);
      pdf
        .fillColor(MUTED)
        .font("Helvetica")
        .fontSize(8)
        .text(
          `Page ${index - range.start + 1} of ${range.count}`,
          PAGE_MARGIN,
          pdf.page.height - PAGE_MARGIN + 12,
          { width: contentWidth, align: "right" },
        );
    }

    pdf.end();
  });
}

function drawRule(pdf: PDFKit.PDFDocument, width: number): void {
  const y = pdf.y;
  pdf
    .strokeColor(RULE)
    .lineWidth(0.5)
    .moveTo(PAGE_MARGIN, y)
    .lineTo(PAGE_MARGIN + width, y)
    .stroke();
  pdf.y = y + 6;
}

function ensureSpace(pdf: PDFKit.PDFDocument, needed: number): void {
  if (pdf.y + needed > pdf.page.height - PAGE_MARGIN) {
    pdf.addPage();
  }
}

function drawTable(
  pdf: PDFKit.PDFDocument,
  table: NonNullable<ReportSection["table"]>,
  contentWidth: number,
): void {
  const columns = table.columns;
  const weights = columns.map((column, index) =>
    index === 0 ? 1.5 : Math.max(1, column.length / 8),
  );
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const widths = weights.map((weight) => (weight / totalWeight) * contentWidth);

  const drawHeader = () => {
    const y = pdf.y;
    let x = PAGE_MARGIN;
    pdf.font("Helvetica-Bold").fontSize(8.5).fillColor(MUTED);
    columns.forEach((column, index) => {
      pdf.text(column.toUpperCase(), x, y, {
        width: widths[index] - 6,
        align: table.align?.[index] === "right" ? "right" : "left",
        lineBreak: false,
      });
      x += widths[index];
    });
    pdf.y = y + 12;
    drawRule(pdf, contentWidth);
    pdf.y += 4;
  };

  drawHeader();

  pdf.font("Helvetica").fontSize(8.5);
  for (const row of table.rows) {
    const cells = row.map((cell) =>
      cell === null || cell === undefined ? "—" : String(cell),
    );
    const estimatedLines = Math.max(
      1,
      ...cells.map((cell, index) =>
        Math.ceil(pdf.widthOfString(cell) / Math.max(widths[index] - 6, 20)),
      ),
    );
    const rowHeight = Math.max(14, estimatedLines * 10 + 4);

    if (pdf.y + rowHeight > pdf.page.height - PAGE_MARGIN) {
      pdf.addPage();
      drawHeader();
      pdf.font("Helvetica").fontSize(8.5);
    }

    const y = pdf.y;
    let x = PAGE_MARGIN;
    cells.forEach((cell, index) => {
      pdf.fillColor(INK).text(cell, x, y, {
        width: widths[index] - 6,
        align: table.align?.[index] === "right" ? "right" : "left",
        ellipsis: true,
        lineBreak: false,
      });
      x += widths[index];
    });
    pdf.y = y + rowHeight;
  }
}

function drawBars(
  pdf: PDFKit.PDFDocument,
  bars: NonNullable<ReportSection["bars"]>,
  contentWidth: number,
): void {
  const magnitudes = bars.map((bar) => Math.abs(bar.value));
  const max = Math.max(...magnitudes, 1e-9);
  const labelWidth = 210;
  const valueWidth = 90;
  const barWidth = contentWidth - labelWidth - valueWidth;

  for (const bar of bars) {
    if (pdf.y + 20 > pdf.page.height - PAGE_MARGIN) pdf.addPage();
    const y = pdf.y;
    const length = (Math.abs(bar.value) / max) * barWidth;

    pdf
      .fillColor(INK)
      .font("Helvetica")
      .fontSize(8.5)
      .text(bar.label, PAGE_MARGIN, y, { width: labelWidth - 8, lineBreak: false, ellipsis: true });

    // Track, then the value bar inside it.
    pdf
      .fillColor("#f1f5f9")
      .roundedRect(PAGE_MARGIN + labelWidth, y + 1, barWidth, 9, 2)
      .fill();
    pdf
      .fillColor(toneColour(bar.tone))
      .roundedRect(PAGE_MARGIN + labelWidth, y + 1, Math.max(length, 1.5), 9, 2)
      .fill();

    pdf
      .fillColor(MUTED)
      .font("Helvetica")
      .fontSize(8.5)
      .text(bar.display, PAGE_MARGIN + labelWidth + barWidth + 6, y, {
        width: valueWidth - 6,
        align: "right",
        lineBreak: false,
      });

    pdf.y = y + 15;
  }
}

export { percent, number as formatNumber };
