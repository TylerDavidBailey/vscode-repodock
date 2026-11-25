// Generates media/icon.png, the Marketplace icon, with zero native dependencies: shapes are
// rasterized in software and encoded as a PNG through node's zlib.
//
// The icon is one glyph in white on a flat tile. media/repodock.svg is the same glyph as a
// single-color outline for the Activity Bar, so a change of glyph here belongs there too.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 256 rather than the 128 minimum, so the icon stays sharp on high-density displays
const SIZE = 256;
// the tile is authored on a 128-unit grid
const GRID = 128;
const SCALE = SIZE / GRID;

// One flat mid-tone, because the icon is shown on whatever theme the user runs: a dark tile
// disappears into a dark theme and a light one into a light theme.
const TILE_COLOR = [99, 102, 241]; // #6366f1
const GLYPH_COLOR = [255, 255, 255];

// The "folder-git" icon from Lucide (https://lucide.dev/icons/folder-git), ISC License, with
// its geometry unchanged. THIRD_PARTY_NOTICES.md carries the license text. Lucide draws on a
// 24-unit box with a 2-unit stroke and round caps and joins.
const GLYPH_PATHS = [
  'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z',
  'M14 13h3',
  'M7 13h3',
];
const GLYPH_CIRCLES = [{ centerX: 12, centerY: 13, radius: 2 }];
const GLYPH_STROKE = 2;
// grid units per glyph unit, and the inset that centers the 24-unit box on the tile
const GLYPH_SCALE = 3;
const GLYPH_OFFSET = (GRID - 24 * GLYPH_SCALE) / 2;

// straight-alpha float channels
const red = new Float64Array(SIZE * SIZE);
const green = new Float64Array(SIZE * SIZE);
const blue = new Float64Array(SIZE * SIZE);
const alpha = new Float64Array(SIZE * SIZE);

function blendPixel(index, [r, g, b], coverage) {
  if (coverage <= 0) return;
  const below = alpha[index] * (1 - coverage);
  const out = coverage + below;
  red[index] = (r * coverage + red[index] * below) / out;
  green[index] = (g * coverage + green[index] * below) / out;
  blue[index] = (b * coverage + blue[index] * below) / out;
  alpha[index] = out;
}

// Paints a shape given as a signed distance in grid units, negative inside. The distance
// becomes coverage across one pixel, which antialiases the edge.
function paint(distanceTo, color) {
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const distance = distanceTo((x + 0.5) / SCALE, (y + 0.5) / SCALE) * SCALE;
      blendPixel(y * SIZE + x, color, Math.max(0, Math.min(1, 0.5 - distance)));
    }
  }
}

function roundedSquareDistance(size, radius) {
  const half = size / 2;
  return (x, y) => {
    const dx = Math.max(Math.abs(x - half) - (half - radius), 0);
    const dy = Math.max(Math.abs(y - half) - (half - radius), 0);
    return Math.hypot(dx, dy) - radius;
  };
}

// SVG's endpoint form of a circular arc, as points along it
function arcPoints(startX, startY, radius, isLargeArc, isPositiveSweep, endX, endY) {
  const halfX = (startX - endX) / 2;
  const halfY = (startY - endY) / 2;
  const halfChordSquared = halfX * halfX + halfY * halfY;
  const side = isLargeArc === isPositiveSweep ? -1 : 1;
  const offset =
    side * Math.sqrt(Math.max(0, radius * radius - halfChordSquared) / halfChordSquared);
  const centerX = (startX + endX) / 2 + offset * halfY;
  const centerY = (startY + endY) / 2 - offset * halfX;
  const startAngle = Math.atan2(startY - centerY, startX - centerX);
  let sweep = Math.atan2(endY - centerY, endX - centerX) - startAngle;
  if (isPositiveSweep && sweep < 0) sweep += 2 * Math.PI;
  if (!isPositiveSweep && sweep > 0) sweep -= 2 * Math.PI;
  const steps = 12;
  const points = [];
  for (let step = 1; step <= steps; step++) {
    const angle = startAngle + (sweep * step) / steps;
    points.push([centerX + radius * Math.cos(angle), centerY + radius * Math.sin(angle)]);
  }
  return points;
}

// Flattens the subset of SVG path syntax Lucide's icon uses (M, L, H, V, Z, and circular A,
// absolute and relative) into one polyline.
function flattenPath(path) {
  const tokens = path.match(/[a-zA-Z]|-?\d*\.?\d+/g) ?? [];
  const points = [];
  let x = 0;
  let y = 0;
  let command = '';
  let index = 0;
  const next = () => Number(tokens[index++]);
  while (index < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[index])) command = tokens[index++];
    const isRelative = command === command.toLowerCase();
    const baseX = isRelative ? x : 0;
    const baseY = isRelative ? y : 0;
    switch (command.toUpperCase()) {
      case 'M':
      case 'L':
        x = baseX + next();
        y = baseY + next();
        points.push([x, y]);
        break;
      case 'H':
        x = baseX + next();
        points.push([x, y]);
        break;
      case 'V':
        y = baseY + next();
        points.push([x, y]);
        break;
      case 'A': {
        const radius = next();
        // the second radius and the rotation, which a circular arc does not need
        index += 2;
        const isLargeArc = next() === 1;
        const isPositiveSweep = next() === 1;
        const endX = baseX + next();
        const endY = baseY + next();
        points.push(...arcPoints(x, y, radius, isLargeArc, isPositiveSweep, endX, endY));
        x = endX;
        y = endY;
        break;
      }
      case 'Z':
        points.push(points[0]);
        break;
      default:
        throw new Error(`unsupported path command: ${command}`);
    }
  }
  return points;
}

function circlePoints({ centerX, centerY, radius }) {
  const steps = 48;
  const points = [];
  for (let step = 0; step <= steps; step++) {
    const angle = (2 * Math.PI * step) / steps;
    points.push([centerX + radius * Math.cos(angle), centerY + radius * Math.sin(angle)]);
  }
  return points;
}

// Distance to a stroked set of polylines. Measuring from the centerline gives round caps and
// round joins for free, which is how Lucide draws.
function strokeDistance(polylines, strokeWidth) {
  return (x, y) => {
    let nearest = Infinity;
    for (const points of polylines) {
      for (let i = 0; i < points.length - 1; i++) {
        const [ax, ay] = points[i];
        const [bx, by] = points[i + 1];
        const abx = bx - ax;
        const aby = by - ay;
        const lengthSquared = abx * abx + aby * aby;
        const t =
          lengthSquared === 0
            ? 0
            : Math.max(0, Math.min(1, ((x - ax) * abx + (y - ay) * aby) / lengthSquared));
        nearest = Math.min(nearest, Math.hypot(x - (ax + abx * t), y - (ay + aby * t)));
      }
    }
    return nearest - strokeWidth / 2;
  };
}

// full-bleed tile
paint(roundedSquareDistance(GRID, 28), TILE_COLOR);

const glyph = [...GLYPH_PATHS.map(flattenPath), ...GLYPH_CIRCLES.map(circlePoints)].map((points) =>
  points.map(([x, y]) => [GLYPH_OFFSET + x * GLYPH_SCALE, GLYPH_OFFSET + y * GLYPH_SCALE]),
);
paint(strokeDistance(glyph, GLYPH_STROKE * GLYPH_SCALE), GLYPH_COLOR);

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
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  const rowStart = y * (SIZE * 4 + 1);
  raw[rowStart] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    const i = y * SIZE + x;
    const offset = rowStart + 1 + x * 4;
    raw[offset] = Math.round(red[i]);
    raw[offset + 1] = Math.round(green[i]);
    raw[offset + 2] = Math.round(blue[i]);
    raw[offset + 3] = Math.round(alpha[i] * 255);
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
