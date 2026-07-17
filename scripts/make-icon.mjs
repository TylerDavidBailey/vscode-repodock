// Generates media/icon.png (128x128 marketplace icon) with zero native dependencies:
// software-rendered shapes encoded as a PNG via node's zlib.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 128;
const W = SIZE;
const H = SIZE;

// straight-alpha float channels
const R = new Float64Array(W * H);
const G = new Float64Array(W * H);
const B = new Float64Array(W * H);
const A = new Float64Array(W * H);

function blend(x, y, r, g, b, coverage) {
  if (x < 0 || y < 0 || x >= W || y >= H || coverage <= 0) return;
  const i = y * W + x;
  const aS = Math.min(coverage, 1);
  const aD = A[i];
  const aOut = aS + aD * (1 - aS);
  if (aOut === 0) return;
  R[i] = (r * aS + R[i] * aD * (1 - aS)) / aOut;
  G[i] = (g * aS + G[i] * aD * (1 - aS)) / aOut;
  B[i] = (b * aS + B[i] * aD * (1 - aS)) / aOut;
  A[i] = aOut;
}

/** coverage from a signed distance: 1 inside, antialiased ~1px edge */
const cov = (dist) => Math.max(0, Math.min(1, 0.5 - dist));

function roundedRect(cx, cy, w, h, radius, colorAt) {
  const x0 = Math.floor(cx - w / 2 - 1);
  const x1 = Math.ceil(cx + w / 2 + 1);
  const y0 = Math.floor(cy - h / 2 - 1);
  const y1 = Math.ceil(cy + h / 2 + 1);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = Math.max(Math.abs(x + 0.5 - cx) - (w / 2 - radius), 0);
      const dy = Math.max(Math.abs(y + 0.5 - cy) - (h / 2 - radius), 0);
      const dist = Math.hypot(dx, dy) - radius;
      const [r, g, b] = colorAt(y);
      blend(x, y, r, g, b, cov(dist));
    }
  }
}

/** paints a signed-distance function (px units, negative inside) in one color */
function paintDist(x0, y0, x1, y1, dist, [r, g, b]) {
  for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) {
      blend(x, y, r, g, b, cov(dist(x + 0.5, y + 0.5)));
    }
  }
}

// background: full-bleed rounded square, near-black with a whisper of depth
const top = [38, 38, 42]; // #26262a
const bottom = [14, 14, 16]; // #0e0e10
roundedRect(64, 64, 128, 128, 28, (y) => {
  const t = Math.max(0, Math.min(1, y / H));
  return [
    top[0] + (bottom[0] - top[0]) * t,
    top[1] + (bottom[1] - top[1]) * t,
    top[2] + (bottom[2] - top[2]) * t,
  ];
});

// ---- branch-in-a-box glyph, same geometry as media/repodock.svg ----
// glyph is authored in a 24-unit box, inset and scaled like the sidebar icon
const GLYPH_SCALE = 0.78;
const GLYPH_OFFSET = 2.6;
const PX = SIZE / 24;
const gx = (v) => (GLYPH_OFFSET + GLYPH_SCALE * v) * PX;
const STROKE = 1.7 * GLYPH_SCALE * PX;
const white = [255, 255, 255];

function strokeRoundedRect(cx, cy, w, h, radius) {
  const [pcx, pcy] = [gx(cx), gx(cy)];
  const [pw, ph, pr] = [w * GLYPH_SCALE * PX, h * GLYPH_SCALE * PX, radius * GLYPH_SCALE * PX];
  const pad = STROKE;
  paintDist(
    pcx - pw / 2 - pad,
    pcy - ph / 2 - pad,
    pcx + pw / 2 + pad,
    pcy + ph / 2 + pad,
    (x, y) => {
      const dx = Math.max(Math.abs(x - pcx) - (pw / 2 - pr), 0);
      const dy = Math.max(Math.abs(y - pcy) - (ph / 2 - pr), 0);
      return Math.abs(Math.hypot(dx, dy) - pr) - STROKE / 2;
    },
    white,
  );
}

function strokeCircle(cx, cy, radius) {
  const [pcx, pcy, pr] = [gx(cx), gx(cy), radius * GLYPH_SCALE * PX];
  const pad = pr + STROKE;
  paintDist(
    pcx - pad,
    pcy - pad,
    pcx + pad,
    pcy + pad,
    (x, y) => Math.abs(Math.hypot(x - pcx, y - pcy) - pr) - STROKE / 2,
    white,
  );
}

/** stroked polyline with round caps (also used to approximate curves) */
function strokePolyline(points) {
  const px = points.map(([x, y]) => [gx(x), gx(y)]);
  const xs = px.map((p) => p[0]);
  const ys = px.map((p) => p[1]);
  paintDist(
    Math.min(...xs) - STROKE,
    Math.min(...ys) - STROKE,
    Math.max(...xs) + STROKE,
    Math.max(...ys) + STROKE,
    (x, y) => {
      let best = Infinity;
      for (let i = 0; i < px.length - 1; i++) {
        const [ax, ay] = px[i];
        const [bx, by] = px[i + 1];
        const abx = bx - ax;
        const aby = by - ay;
        const lenSq = abx * abx + aby * aby;
        const t =
          lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * abx + (y - ay) * aby) / lenSq));
        best = Math.min(best, Math.hypot(x - (ax + abx * t), y - (ay + aby * t)));
      }
      return best - STROKE / 2;
    },
    white,
  );
}

function cubicPoints(p0, c1, c2, p1, steps = 24) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p1[0],
      u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p1[1],
    ]);
  }
  return out;
}

function arcPoints(cx, cy, radius, a0, a1, steps = 10) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    out.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a)]);
  }
  return out;
}

// back box peeking out behind the front one — the "many repos" half of the mark
strokePolyline([
  [8.5, 4.5],
  ...arcPoints(11, 4, 2.5, Math.PI, 1.5 * Math.PI),
  [19, 1.5],
  ...arcPoints(19, 4, 2.5, 1.5 * Math.PI, 2 * Math.PI),
  [21.5, 12],
  ...arcPoints(19, 12, 2.5, 0, 0.5 * Math.PI),
  [18.5, 14.5],
]);

// front box with the branch glyph
strokeRoundedRect(10, 14, 15, 15, 3.8);
strokeCircle(7.6, 11, 1.4);
strokeCircle(7.6, 17, 1.4);
strokeCircle(12.9, 12.5, 1.4);
strokePolyline([
  [7.6, 12.4],
  [7.6, 15.6],
]);
strokePolyline(cubicPoints([11.6, 13], [9.6, 13.4], [8.2, 14.1], [7.8, 15.4]));

// ---- PNG encoding ----
const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const raw = Buffer.alloc(H * (W * 4 + 1));
for (let y = 0; y < H; y++) {
  const rowStart = y * (W * 4 + 1);
  raw[rowStart] = 0; // filter: none
  for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const offset = rowStart + 1 + x * 4;
    raw[offset] = Math.round(R[i]);
    raw[offset + 1] = Math.round(G[i]);
    raw[offset + 2] = Math.round(B[i]);
    raw[offset + 3] = Math.round(A[i] * 255);
  }
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'media', 'icon.png');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
