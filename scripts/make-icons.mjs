// Generates the PWA icons into public/icons/ (committed). Run manually: node scripts/make-icons.mjs
// No dependencies: draws a ring + dot ("you are here") on the accent colour and encodes PNG by hand.
// The artwork stays inside the central 60% so the same files also work as maskable icons.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const BG = [0x1f, 0x5f, 0xbf];
const FG = [0xff, 0xff, 0xff];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

/** Share of the pixel covered by a shape whose signed distance to its edge is `d` (negative = inside). */
const coverage = (d) => Math.min(1, Math.max(0, 0.5 - d));

function png(size) {
  const cx = size / 2;
  const ringOuter = size * 0.3;
  const ringInner = size * 0.2;
  const dot = size * 0.09;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3); // filter byte 0 + RGB
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x + 0.5 - cx, y + 0.5 - cx);
      const ring = Math.min(coverage(r - ringOuter), coverage(ringInner - r));
      const a = Math.max(ring, coverage(r - dot));
      for (let i = 0; i < 3; i++) row[1 + x * 3 + i] = Math.round(BG[i] + (FG[i] - BG[i]) * a);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync('public/icons', { recursive: true });
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  writeFileSync(`public/icons/${name}`, png(size));
  console.log(`public/icons/${name}`);
}
