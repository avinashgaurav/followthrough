/**
 * Draws the toolbar and store icons (icons/icon-16.png, -48, -128) from the
 * Followthrough mark used for the site favicon (site/favicon.svg): a dark
 * square, a thin vertical line and an amber dot. No image dependencies: the
 * shapes are rasterised with 8x8 supersampling and written as plain RGBA PNGs.
 *
 * The PNGs are committed; run `bun run icons` only if the mark changes.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const BG = [0x0a, 0x0b, 0x0d];
const LINE = [0x27, 0x2a, 0x2f];
const DOT = [0xf4, 0xa5, 0x21];
const SAMPLES = 8;

/** Colour of a point in favicon.svg's 32x32 viewBox. */
function colourAt(x: number, y: number): number[] {
  if ((x - 16) ** 2 + (y - 16) ** 2 <= 16) return DOT; // circle cx=16 cy=16 r=4
  if (x >= 15 && x < 17 && y >= 5 && y < 27) return LINE; // rect x=15 y=5 w=2 h=22
  return BG;
}

function render(size: number): Buffer {
  const scale = 32 / size;
  const rows: Buffer[] = [];
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 4); // leading 0 = PNG filter "none"
    for (let px = 0; px < size; px++) {
      const sum = [0, 0, 0];
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const c = colourAt((px + (sx + 0.5) / SAMPLES) * scale, (py + (sy + 0.5) / SAMPLES) * scale);
          for (let i = 0; i < 3; i++) sum[i]! += c[i]!;
        }
      }
      const o = 1 + px * 4;
      for (let i = 0; i < 3; i++) row[o + i] = Math.round(sum[i]! / SAMPLES ** 2);
      row[o + 3] = 255;
    }
    rows.push(row);
  }
  return png(size, deflateSync(Buffer.concat(rows)));
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size: number, idat: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const out = join(import.meta.dir, "icons");
mkdirSync(out, { recursive: true });
for (const size of [16, 48, 128]) {
  writeFileSync(join(out, `icon-${size}.png`), render(size));
  console.log(`icons/icon-${size}.png`);
}
