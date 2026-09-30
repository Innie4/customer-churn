/**
 * The specific figures the model pages ask for.
 *
 * Each entry point draws one chart and returns PNG bytes. The set matches what
 * the real service renders, because the pages request charts by name and a
 * missing name means a broken image.
 */

import { Canvas, COLORS, drawFrame, Rgb } from "./chart";

const WIDTH = 560;
const HEIGHT = 360;
const MARGIN = { left: 56, right: 20, top: 28, bottom: 40 };

const axis = () => ({
  left: MARGIN.left,
  top: MARGIN.top,
  right: WIDTH - MARGIN.right,
  bottom: HEIGHT - MARGIN.bottom,
});

const unitTicks = () => [0, 0.25, 0.5, 0.75, 1];

export function rocCurvePng(points: { fpr: number; tpr: number }[], auc: number): Buffer {
  const canvas = new Canvas(WIDTH, HEIGHT);
  const box = axis();
  drawFrame(canvas, box, "TRUE POSITIVE RATE", "FALSE POSITIVE RATE", unitTicks(), unitTicks());

  // The diagonal, so the curve's area above it is visible.
  canvas.line(box.left, box.bottom, box.right, box.top, COLORS.faint, 1);

  const scale = (fpr: number, tpr: number): [number, number] => [
    box.left + fpr * (box.right - box.left),
    box.bottom - tpr * (box.bottom - box.top),
  ];

  for (let index = 1; index < points.length; index += 1) {
    const [x0, y0] = scale(points[index - 1]!.fpr, points[index - 1]!.tpr);
    const [x1, y1] = scale(points[index]!.fpr, points[index]!.tpr);
    canvas.line(x0, y0, x1, y1, COLORS.accent, 2);
  }

  canvas.text(box.left + 8, box.top + 6, `AUC ${auc.toFixed(4)}`, COLORS.ink, 1);
  return canvas.toPng();
}

export function confusionMatrixPng(matrix: {
  true_negative: number;
  false_positive: number;
  false_negative: number;
  true_positive: number;
}): Buffer {
  const canvas = new Canvas(WIDTH, HEIGHT);
  const values = [
    matrix.true_negative,
    matrix.false_positive,
    matrix.false_negative,
    matrix.true_positive,
  ];
  const largest = Math.max(...values, 1);

  const cellWidth = 150;
  const cellHeight = 92;
  const left = (WIDTH - cellWidth * 2) / 2;
  const top = 60;
  const cells: [number, string, Rgb][] = [
    [0, "TRUE NEGATIVE", COLORS.good],
    [1, "FALSE POSITIVE", COLORS.bad],
    [2, "FALSE NEGATIVE", COLORS.warn],
    [3, "TRUE POSITIVE", COLORS.good],
  ];

  canvas.text(WIDTH / 2 - 60, 24, "PREDICTED", COLORS.muted, 1);
  canvas.text(WIDTH / 2 - 40, 44, "NO / YES", COLORS.muted, 1);

  for (const [position, label, colour] of cells) {
    const column = position % 2;
    const row = Math.floor(position / 2);
    const x = left + column * cellWidth;
    const y = top + row * cellHeight;
    // Shade the cell in proportion to its count.
    const intensity = 0.12 + (values[position]! / largest) * 0.5;
    canvas.rect(
      x,
      y,
      cellWidth - 6,
      cellHeight - 6,
      { r: colour.r, g: colour.g, b: colour.b, ...{} },
    );
    // Overlay a light wash so the text stays readable.
    canvas.rect(x, y, cellWidth - 6, cellHeight - 6, {
      r: Math.round(255 - (255 - colour.r) * intensity),
      g: Math.round(255 - (255 - colour.g) * intensity),
      b: Math.round(255 - (255 - colour.b) * intensity),
    });
    canvas.text(x + 12, y + 12, String(values[position]), COLORS.ink, 2);
    canvas.text(x + 12, y + 52, label.slice(0, 18), COLORS.muted, 1);
  }
  return canvas.toPng();
}

export function decileLiftPng(
  rows: { decile: number; churn_rate: number; lift: number }[],
  baseline: number,
): Buffer {
  const canvas = new Canvas(WIDTH, HEIGHT);
  const box = axis();
  const highest = Math.max(...rows.map((row) => row.lift), baseline * 2, 1);
  const yTicks = [0, highest / 4, highest / 2, (highest * 3) / 4, highest];
  drawFrame(
    canvas,
    box,
    "LIFT",
    "RISK DECILE (1 = HIGHEST)",
    yTicks,
    [0, 0.25, 0.5, 0.75, 1],
  );

  const barWidth = (box.right - box.left) / rows.length;
  rows.forEach((row, index) => {
    const height = (row.lift / highest) * (box.bottom - box.top);
    const x = box.left + index * barWidth + 4;
    canvas.rect(
      x,
      box.bottom - height,
      barWidth - 8,
      height,
      row.lift >= 1 ? COLORS.accent : COLORS.accentSoft,
    );
    canvas.text(x + 6, box.bottom + 6, String(row.decile), COLORS.muted, 1);
  });

  // The baseline, which is what makes a lift above one meaningful.
  const baselineY = box.bottom - (baseline / highest) * (box.bottom - box.top);
  for (let x = box.left; x < box.right; x += 6) {
    canvas.line(x, baselineY, x + 3, baselineY, COLORS.bad, 1);
  }
  canvas.text(box.left + 4, baselineY - 12, "BASELINE", COLORS.bad, 1);
  return canvas.toPng();
}

export function calibrationPng(points: { predicted: number; actual: number }[]): Buffer {
  const canvas = new Canvas(WIDTH, HEIGHT);
  const box = axis();
  drawFrame(canvas, box, "OBSERVED RATE", "PREDICTED RATE", unitTicks(), unitTicks());

  canvas.line(box.left, box.bottom, box.right, box.top, COLORS.faint, 1);

  for (const point of points) {
    const x = box.left + point.predicted * (box.right - box.left);
    const y = box.bottom - point.actual * (box.bottom - box.top);
    canvas.dot(x, y, 7, COLORS.accent);
  }
  canvas.text(box.left + 8, box.top + 6, "IDEAL", COLORS.muted, 1);
  return canvas.toPng();
}

export function featureImportancePng(
  features: { label: string; mean_abs_shap: number }[],
): Buffer {
  const canvas = new Canvas(WIDTH, Math.max(200, features.length * 26 + 70));
  const top = features.slice(0, 12);
  const highest = Math.max(...top.map((feature) => feature.mean_abs_shap), 0.0001);
  const left = 210;

  canvas.text(16, 18, "MEAN ABS SHAP VALUE", COLORS.ink, 1);
  top.forEach((feature, index) => {
    const y = 40 + index * 26;
    const width = (feature.mean_abs_shap / highest) * (WIDTH - left - 40);
    canvas.rect(left, y, width, 16, COLORS.accent);
    canvas.text(16, y + 5, feature.label.slice(0, 30), COLORS.muted, 1);
    canvas.text(left + width + 6, y + 5, feature.mean_abs_shap.toFixed(4), COLORS.ink, 1);
  });
  return canvas.toPng();
}

export function waterfallPng(
  contributions: { label: string; shap_value: number }[],
  baseValue: number,
  probability: number,
): Buffer {
  const canvas = new Canvas(WIDTH, Math.max(220, contributions.length * 30 + 90));
  const top = contributions.slice(0, 10);
  const left = 200;
  const scaleWidth = WIDTH - left - 60;

  let running = baseValue;
  canvas.text(16, 18, "WATERFALL ON LOG ODDS", COLORS.ink, 1);
  canvas.text(16, 34, `STARTS AT ${baseValue.toFixed(2)}`, COLORS.muted, 1);

  const allValues = [baseValue, probability === 0 ? 0 : 0];
  top.forEach((entry) => {
    running += entry.shap_value;
    allValues.push(running);
  });
  const extent = Math.max(...allValues.map(Math.abs), 0.5) * 1.15;
  const zero = left + scaleWidth / 2;
  const toX = (value: number) => zero + (value / extent) * (scaleWidth / 2);

  canvas.line(zero, 40, zero, canvas.height - 30, COLORS.faint, 1);

  top.forEach((entry, index) => {
    const y = 50 + index * 30;
    const from = toX(running);
    running -= entry.shap_value;
    const to = toX(running);
    const colour = entry.shap_value >= 0 ? COLORS.bad : COLORS.good;
    canvas.rect(Math.min(from, to), y, Math.max(Math.abs(to - from), 2), 18, colour);
    canvas.text(16, y + 5, entry.label.slice(0, 28), COLORS.muted, 1);
    canvas.text(
      Math.max(from, to) + 6,
      y + 5,
      `${entry.shap_value >= 0 ? "+" : ""}${entry.shap_value.toFixed(2)}`,
      colour,
      1,
    );
  });

  canvas.text(16, canvas.height - 18, `ENDS AT P = ${probability.toFixed(3)}`, COLORS.ink, 1);
  return canvas.toPng();
}

export function beeswarmPng(
  features: { label: string; mean_abs_shap: number }[],
): Buffer {
  const canvas = new Canvas(WIDTH, Math.max(200, features.length * 26 + 70));
  const top = features.slice(0, 12);
  const highest = Math.max(...top.map((feature) => feature.mean_abs_shap), 0.0001);
  const left = 210;

  canvas.text(16, 18, "DISTRIBUTION OF CONTRIBUTIONS", COLORS.ink, 1);
  top.forEach((feature, index) => {
    const y = 44 + index * 26;
    // A deterministic spread of dots around the centre, wider where the
    // feature's influence is larger.
    const spread = 26 + (feature.mean_abs_shap / highest) * 120;
    for (let dot = 0; dot < 26; dot += 1) {
      const offset = (((dot * 37) % 100) / 100 - 0.5) * spread;
      canvas.dot(left + spread + offset, y + 8, 4, offset >= 0 ? COLORS.bad : COLORS.accent);
    }
    canvas.text(16, y + 5, feature.label.slice(0, 30), COLORS.muted, 1);
  });
  return canvas.toPng();
}

/** A distribution histogram, used for score and tenure summaries. */
export function histogramPng(
  counts: number[],
  labels: string[],
  title: string,
): Buffer {
  const canvas = new Canvas(WIDTH, HEIGHT);
  const box = axis();
  const highest = Math.max(...counts, 1);
  drawFrame(
    canvas,
    box,
    "CUSTOMERS",
    title.slice(0, 22),
    [0, highest / 2, highest],
    [0, 0.5, 1],
  );

  const barWidth = (box.right - box.left) / counts.length;
  counts.forEach((count, index) => {
    const height = (count / highest) * (box.bottom - box.top);
    canvas.rect(
      box.left + index * barWidth + 3,
      box.bottom - height,
      barWidth - 6,
      height,
      COLORS.accent,
    );
    if (labels[index]) {
      canvas.text(box.left + index * barWidth + 4, box.bottom + 6, labels[index]!.slice(0, 5), COLORS.muted, 1);
    }
  });
  return canvas.toPng();
}
