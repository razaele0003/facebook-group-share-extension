import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
export function crc32(data) { let c = 0xffffffff; for (const byte of data) { c ^= byte; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; }
const chunk = (name, bytes) => { const type = Buffer.from(name), len = Buffer.alloc(4), crc = Buffer.alloc(4); len.writeUInt32BE(bytes.length); crc.writeUInt32BE(crc32(Buffer.concat([type, bytes]))); return Buffer.concat([len, type, bytes, crc]); };
const distance = (x, y, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy))); return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy); };
await mkdir(new URL('../icons/', import.meta.url), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const raw = Buffer.alloc((1 + size * 4) * size), blue = [34, 91, 213];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const rgba = [0, 0, 0, 0];
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      const px = (x + (sx + .5) / 4) / size * 32, py = (y + (sy + .5) / 4) / size * 32;
      const radius = 7, cx = Math.max(radius, Math.min(32 - radius, px)), cy = Math.max(radius, Math.min(32 - radius, py));
      if (Math.hypot(px - cx, py - cy) > radius) continue;
      let color = blue;
      if (distance(px, py, [9, 16], [23, 8]) < 1.2 || distance(px, py, [9, 16], [23, 24]) < 1.2) color = [255, 255, 255];
      for (const [nx, ny] of [[9, 16], [23, 8], [23, 24]]) { const d = Math.hypot(px - nx, py - ny); if (d < 3.8) color = d < 1.9 ? blue : [255, 255, 255]; }
      rgba[0] += color[0]; rgba[1] += color[1]; rgba[2] += color[2]; rgba[3] += 255;
    }
    const index = y * (1 + size * 4) + 1 + x * 4, covered = rgba[3] / 255;
    for (let i = 0; i < 3; i++) raw[index + i] = covered ? Math.round(rgba[i] / covered) : 0;
    raw[index + 3] = Math.round(rgba[3] / 16);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  await writeFile(new URL(`../icons/${size}.png`, import.meta.url), Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
