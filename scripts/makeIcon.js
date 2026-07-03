// Generates icon.png (256×256 RGBA) with no dependencies: SDF-rendered
// shapes, hand-rolled PNG encoding via zlib. Run: node scripts/makeIcon.js
const zlib = require("node:zlib");
const fs = require("node:fs");
const path = require("node:path");

const SIZE = 256;

// ---- geometry helpers (all in screen coords, y down) ----
const smooth = (d) => Math.min(1, Math.max(0, 0.5 - d)); // 1px anti-alias

function sdRoundedRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - hw + r;
  const qy = Math.abs(y - cy) - hh + r;
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdSegment(x, y, ax, ay, bx, by) {
  const pax = x - ax, pay = y - ay;
  const bax = bx - ax, bay = by - ay;
  const h = Math.min(1, Math.max(0, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  return Math.hypot(pax - bax * h, pay - bay * h);
}

// Ring of radius r around (cx,cy), but absent inside the angular gap.
function sdArc(x, y, cx, cy, r, gapFrom, gapTo) {
  const dx = x - cx, dy = y - cy;
  const angle = Math.atan2(dy, dx);
  if (angle > gapFrom && angle < gapTo) {
    // inside the gap: distance to the arc endpoints (round caps)
    const d1 = Math.hypot(dx - r * Math.cos(gapFrom), dy - r * Math.sin(gapFrom));
    const d2 = Math.hypot(dx - r * Math.cos(gapTo), dy - r * Math.sin(gapTo));
    return Math.min(d1, d2);
  }
  return Math.abs(Math.hypot(dx, dy) - r);
}

// ---- palette ----
const BG = [27, 42, 65]; // dark slate blue
const RING = [147, 164, 184]; // grey-blue
const CHECK = [63, 214, 139]; // green

// ---- render ----
const px = Buffer.alloc(SIZE * SIZE * 4);
const C = SIZE / 2;
const gapFrom = -70 * (Math.PI / 180); // gap at the top-right (screen coords)
const gapTo = -20 * (Math.PI / 180);

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const fx = x + 0.5, fy = y + 0.5;
    let r = 0, g = 0, b = 0, a = 0;

    const bgCov = smooth(sdRoundedRect(fx, fy, C, C, 120, 120, 56));
    if (bgCov > 0) {
      [r, g, b] = BG;
      a = bgCov;

      const ringCov = smooth(sdArc(fx, fy, C, C, 86, gapFrom, gapTo) - 6);
      if (ringCov > 0) {
        r = r + (RING[0] - r) * ringCov;
        g = g + (RING[1] - g) * ringCov;
        b = b + (RING[2] - b) * ringCov;
      }

      const dCheck = Math.min(
        sdSegment(fx, fy, 88, 132, 118, 162),
        sdSegment(fx, fy, 118, 162, 174, 100)
      );
      const checkCov = smooth(dCheck - 11);
      if (checkCov > 0) {
        r = r + (CHECK[0] - r) * checkCov;
        g = g + (CHECK[1] - g) * checkCov;
        b = b + (CHECK[2] - b) * checkCov;
      }
    }

    const i = (y * SIZE + x) * 4;
    px[i] = Math.round(r);
    px[i + 1] = Math.round(g);
    px[i + 2] = Math.round(b);
    px[i + 3] = Math.round(a * 255);
  }
}

// ---- PNG encoding ----
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c;
});

function crc32(buf) {
  let c = -1;
  for (const byte of buf) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = path.resolve(__dirname, "..", "icon.png");
fs.writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
