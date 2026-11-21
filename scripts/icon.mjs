import { deflateSync } from 'node:zlib';
import { writeFile } from 'node:fs/promises';
// A small geometric tree mark. Supersampling keeps the packaged icon crisp.
const size = 128, scale = 4, width = size * scale;
const pixels = new Uint8Array(width * width * 4);
function rect(x, y, w, h, color, radius = 0) {
  for (let py = Math.floor(y * scale); py < (y + h) * scale; py++) for (let px = Math.floor(x * scale); px < (x + w) * scale; px++) {
    const dx = Math.max(x + radius - px / scale, 0, px / scale - (x + w - radius));
    const dy = Math.max(y + radius - py / scale, 0, py / scale - (y + h - radius));
    if (dx * dx + dy * dy <= radius * radius) pixels.set(color, (py * width + px) * 4);
  }
}
rect(0, 0, 128, 128, [34, 30, 51, 255], 26);
rect(33, 28, 6, 75, [170, 147, 248, 255], 3);
rect(37, 47, 35, 6, [170, 147, 248, 255], 2);
rect(37, 83, 35, 6, [170, 147, 248, 255], 2);
rect(66, 35, 31, 30, [184, 163, 255, 255], 6);
rect(66, 71, 31, 30, [115, 183, 224, 255], 6);
rect(74, 43, 15, 3, [67, 51, 109, 255], 1);
rect(74, 51, 10, 3, [67, 51, 109, 255], 1);
rect(74, 80, 15, 3, [36, 79, 107, 255], 1);
rect(74, 88, 10, 3, [36, 79, 107, 255], 1);
const rows = Buffer.alloc((size * 4 + 1) * size);
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) for (let c = 0; c < 4; c++) {
  let value = 0; for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) value += pixels[(((y * scale + sy) * width) + x * scale + sx) * 4 + c];
  rows[y * (size * 4 + 1) + 1 + x * 4 + c] = Math.round(value / (scale * scale));
}
function chunk(type, data) {
  const content = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
  for (const byte of content) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
  const out = Buffer.alloc(data.length + 12); out.writeUInt32BE(data.length); content.copy(out, 4); out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4); return out;
}
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
await writeFile('media/icon.png', Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]));
