/**
 * A very small chart renderer.
 *
 * The real service draws its charts with Matplotlib. Without Python there is
 * no Matplotlib, but the model pages still have to show something honest, so
 * this draws the same figures into a raster and encodes a PNG using only
 * Node's own zlib.
 *
 * It is a plotting surface, not a charting library: there are axes, a line, a
 * set of bars and a colour per series, which is what these figures need.
 */

import { deflateSync } from "node:zlib";

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export const COLORS: Record<string, Rgb> = {
  ink: { r: 15, g: 23, b: 42 },
  muted: { r: 100, g: 116, b: 139 },
  faint: { r: 226, g: 232, b: 240 },
  grid: { r: 241, g: 245, b: 249 },
  white: { r: 255, g: 255, b: 255 },
  accent: { r: 37, g: 99, b: 235 },
  accentSoft: { r: 191, g: 219, b: 254 },
  good: { r: 22, g: 163, b: 74 },
  bad: { r: 220, g: 38, b: 38 },
  warn: { r: 217, g: 119, b: 6 },
};

/** A fixed-size RGB raster with just enough drawing operations. */
export class Canvas {
  readonly width: number;
  readonly height: number;
  private readonly pixels: Uint8Array;

  constructor(width: number, height: number, background: Rgb = COLORS.white) {
    this.width = width;
    this.height = height;
    this.pixels = new Uint8Array(width * height * 3);
    this.fill(background);
  }

  private fill(colour: Rgb): void {
    for (let index = 0; index < this.pixels.length; index += 3) {
      this.pixels[index] = colour.r;
      this.pixels[index + 1] = colour.g;
      this.pixels[index + 2] = colour.b;
    }
  }

  set(x: number, y: number, colour: Rgb): void {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return;
    const offset = (py * this.width + px) * 3;
    this.pixels[offset] = colour.r;
    this.pixels[offset + 1] = colour.g;
    this.pixels[offset + 2] = colour.b;
  }

  /** A filled rectangle, used for bars, backgrounds and grid bands. */
  rect(x: number, y: number, w: number, h: number, colour: Rgb): void {
    const x0 = Math.max(0, Math.round(Math.min(x, x + w)));
    const y0 = Math.max(0, Math.round(Math.min(y, y + h)));
    const x1 = Math.min(this.width, Math.round(Math.max(x, x + w)));
    const y1 = Math.min(this.height, Math.round(Math.max(y, y + h)));
    for (let py = y0; py < y1; py += 1) {
      for (let px = x0; px < x1; px += 1) {
        const offset = (py * this.width + px) * 3;
        this.pixels[offset] = colour.r;
        this.pixels[offset + 1] = colour.g;
        this.pixels[offset + 2] = colour.b;
      }
    }
  }

  /** A line, drawn as a run of pixels. */
  line(x0: number, y0: number, x1: number, y1: number, colour: Rgb, thickness = 1): void {
    const steps = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))) || 1;
    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps;
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      for (let dy = 0; dy < thickness; dy += 1) {
        for (let dx = 0; dx < thickness; dx += 1) {
          this.set(x + dx, y + dy, colour);
        }
      }
    }
  }

  /** A small filled square, used as a scatter marker. */
  dot(x: number, y: number, size: number, colour: Rgb): void {
    this.rect(x - size / 2, y - size / 2, size, size, colour);
  }

  /**
   * Text, using a 5x7 bitmap font.
   *
   * Only the characters the axes need are defined. Anything else renders as a
   * blank, which is preferable to a wrong glyph.
   */
  text(x: number, y: number, value: string, colour: Rgb = COLORS.muted, scale = 1): void {
    let cursor = x;
    for (const character of value.toUpperCase()) {
      const glyph = FONT[character];
      if (glyph) {
        for (let row = 0; row < 7; row += 1) {
          for (let column = 0; column < 5; column += 1) {
            if ((glyph[row] as number) & (1 << (4 - column))) {
              this.rect(
                cursor + column * scale,
                y + row * scale,
                scale,
                scale,
                colour,
              );
            }
          }
        }
      }
      cursor += 6 * scale;
    }
  }

  /**
   * Encode as PNG.
   *
   * Each scanline is prefixed with its filter byte, which PNG requires even
   * when the filter is "none", and the whole thing is deflated.
   */
  toPng(): Buffer {
    const raw = Buffer.alloc((this.width * 3 + 1) * this.height);
    for (let y = 0; y < this.height; y += 1) {
      const rowStart = y * (this.width * 3 + 1);
      raw[rowStart] = 0;
      Buffer.from(
        this.pixels.buffer,
        y * this.width * 3,
        this.width * 3,
      ).copy(raw, rowStart + 1);
    }

    const header = Buffer.alloc(13);
    header.writeUInt32BE(this.width, 0);
    header.writeUInt32BE(this.height, 4);
    header[8] = 8; // bit depth
    header[9] = 2; // colour type: truecolour
    header[10] = 0; // deflate
    header[11] = 0; // adaptive filtering
    header[12] = 0; // no interlace

    const ihdr = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(raw, { level: 9 })),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    return ihdr;
  }
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

let crcTable: Uint32Array | null = null;

function crc32(buffer: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      crcTable[index] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crcTable[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A 5x7 font, one seven-bit mask per row. Digits, letters and a few marks. */
const FONT: Record<string, number[]> = {
  "0": [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  "1": [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  "2": [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  "3": [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  "4": [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  "5": [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  "6": [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  "7": [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  "8": [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  "9": [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  ".": [0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x0c],
  ",": [0x00, 0x00, 0x00, 0x00, 0x0c, 0x04, 0x08],
  "-": [0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00],
  ":": [0x00, 0x0c, 0x0c, 0x00, 0x0c, 0x0c, 0x00],
  "/": [0x01, 0x02, 0x02, 0x04, 0x08, 0x08, 0x10],
  "%": [0x18, 0x19, 0x02, 0x04, 0x08, 0x13, 0x03],
  "(": [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02],
  ")": [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08],
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x11, 0x19, 0x15, 0x13, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  "=": [0x00, 0x00, 0x1f, 0x00, 0x1f, 0x00, 0x00],
  "?": [0x0e, 0x11, 0x01, 0x02, 0x04, 0x00, 0x04],
  "+": [0x00, 0x04, 0x04, 0x1f, 0x04, 0x04, 0x00],
};

export interface Axis {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Draw an axis frame with tick labels along the left and bottom edges. */
export function drawFrame(
  canvas: Canvas,
  axis: Axis,
  yLabel: string,
  xLabel: string,
  yTicks: number[],
  xTicks: number[],
  format: (value: number) => string = (value) => value.toFixed(2),
): void {
  for (const tick of yTicks) {
    const y = axis.bottom - tick * (axis.bottom - axis.top);
    canvas.line(axis.left, y, axis.right, y, COLORS.grid, 1);
    canvas.text(4, y - 3, format(tick), COLORS.muted, 1);
  }
  canvas.line(axis.left, axis.top, axis.left, axis.bottom, COLORS.faint, 1);
  canvas.line(axis.left, axis.bottom, axis.right, axis.bottom, COLORS.faint, 1);

  for (const tick of xTicks) {
    const x = axis.left + tick * (axis.right - axis.left);
    canvas.text(x - 10, axis.bottom + 6, format(tick), COLORS.muted, 1);
  }
  canvas.text(axis.left, axis.top - 14, yLabel, COLORS.ink, 1);
  canvas.text(axis.right - 60, axis.bottom + 16, xLabel, COLORS.ink, 1);
}
