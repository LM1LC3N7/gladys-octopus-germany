// Generates cover.png (800x534) for gladys-octopus-germany: plain Node, no dependency.
// A bar chart of hourly prices (the cheap night hours in green, the dear evening
// in amber) beside an electricity meter, on a gradient (no brand logo).
// Usage: node scripts/cover.mjs cover.png
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const W = 800;
const H = 534;
const px = Buffer.alloc(W * H * 3);
const set = (x, y, [r, g, b], a = 1) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = px[i] * (1 - a) + r * a;
  px[i + 1] = px[i + 1] * (1 - a) + g * a;
  px[i + 2] = px[i + 2] * (1 - a) + b * a;
};
const skyAt = (x, y) => {
  const t = (x / W) * 0.7 + (y / H) * 0.3;
  return [90 + 70 * t, 40 + 30 * t, 160 - 40 * t];
};
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    set(x, y, skyAt(x, y));
  }
}
const white = [255, 255, 255];
const dark = [28, 38, 64];
const green = [90, 210, 130];
const disc = (cx, cy, r, color, alpha = 1) => {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y += 1) {
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x += 1) {
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const box = (x0, y0, x1, y1, r, color, alpha = 1) => {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const cx = Math.min(Math.max(x, x0 + r), x1 - r);
      const cy = Math.min(Math.max(y, y0 + r), y1 - r);
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const line = (x0, y0, x1, y1, width, color) => {
  const minX = Math.floor(Math.min(x0, x1) - width);
  const maxX = Math.ceil(Math.max(x0, x1) + width);
  const minY = Math.floor(Math.min(y0, y1) - width);
  const maxY = Math.ceil(Math.max(y0, y1) + width);
  const len2 = (x1 - x0) ** 2 + (y1 - y0) ** 2 || 1;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const t = Math.max(0, Math.min(1, ((x - x0) * (x1 - x0) + (y - y0) * (y1 - y0)) / len2));
      const d = Math.hypot(x - (x0 + t * (x1 - x0)), y - (y0 + t * (y1 - y0)));
      const a = Math.max(0, Math.min(1, width / 2 - d + 0.5));
      if (a > 0) set(x, y, color, a);
    }
  }
};

const grey = [150, 158, 172];
const amber = [245, 180, 60];

disc(400, 270, 260, white, 0.05);

// The price chart: 24 bars, cheap from 00:00 to 05:00.
box(60, 90, 500, 440, 18, white, 0.95);
line(90, 400, 470, 400, 3, grey);
for (let h = 0; h < 24; h += 1) {
  const price = h < 5 ? 0.35 : 0.55 + 0.35 * Math.sin(((h - 5) / 19) * Math.PI);
  const height = Math.round(price * 260);
  const x = 92 + h * 15.5;
  box(
    Math.round(x),
    398 - height,
    Math.round(x + 11),
    398,
    3,
    h < 5 ? green : h >= 17 && h <= 20 ? amber : dark,
  );
}

// The meter: a rounded case, a display, a lightning bolt.
box(560, 120, 740, 420, 22, white);
box(585, 150, 715, 215, 10, dark);
for (let k = 0; k < 4; k += 1) box(600 + k * 27, 168, 620 + k * 27, 198, 3, green);
const bolt = [
  [660, 245],
  [615, 330],
  [650, 330],
  [630, 395],
  [690, 300],
  [655, 300],
  [680, 245],
];
for (let i = 0; i < bolt.length; i += 1) {
  const [x0, y0] = bolt[i];
  const [x1, y1] = bolt[(i + 1) % bolt.length];
  line(x0, y0, x1, y1, 6, amber);
}
for (let y = 245; y < 395; y += 1) {
  const xs = [];
  for (let i = 0; i < bolt.length; i += 1) {
    const [x0, y0] = bolt[i];
    const [x1, y1] = bolt[(i + 1) % bolt.length];
    if ((y0 <= y && y < y1) || (y1 <= y && y < y0))
      xs.push(x0 + ((y - y0) * (x1 - x0)) / (y1 - y0));
  }
  xs.sort((a, b) => a - b);
  for (let k = 0; k + 1 < xs.length; k += 2)
    for (let x = Math.ceil(xs[k]); x <= xs[k + 1]; x += 1) set(x, y, amber);
}
// PNG encoding.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y += 1) {
  raw[y * (W * 3 + 1)] = 0;
  px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(process.argv[2] ?? 'cover.png', png);
console.log('cover', png.length, 'bytes');
