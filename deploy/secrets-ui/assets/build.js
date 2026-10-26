'use strict';
// Draws the secrets logo (a hexagon with a keyhole, blue-to-violet) from one geometry into every format we need:
//   logo.svg              page header and favicon of the secrets page
//   logo.png              Authelia's login page (server.asset_path)
//   favicon.ico           both (16, 32 and 48 px)
//   apple-touch-icon.png  iOS home screen
// No dependencies: a tiny supersampling rasterizer plus a PNG/ICO writer. Run `node build.js` after changing it and
// commit the outputs. (mask.woff2 is text-security-disc from github.com/noppa/text-security, see mask-font-LICENSE.txt.)
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// Geometry, in a 64x64 box.
const HEX = [[32, 2], [57.98, 17], [57.98, 47], [32, 62], [6.02, 47], [6.02, 17]];
const HOLE = { cx: 32, cy: 26, r: 7, top: 32.32, x1: 29, x2: 35, bottom: 44, b1: 27, b2: 37 };
const FROM = [0x3b, 0x82, 0xf6]; // #3b82f6
const TO = [0x7c, 0x3a, 0xed]; // #7c3aed

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b82f6"/><stop offset="1" stop-color="#7c3aed"/></linearGradient></defs>
<path fill="url(#g)" fill-rule="evenodd" d="M${HEX.map((p) => p.join(' ')).join('L')}Z
M${HOLE.x1} ${HOLE.top}A${HOLE.r} ${HOLE.r} 0 1 1 ${HOLE.x2} ${HOLE.top}L${HOLE.b2} ${HOLE.bottom}L${HOLE.b1} ${HOLE.bottom}Z"/>
</svg>
`;

function inPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const TRAPEZOID = [[HOLE.x1, HOLE.top - 1], [HOLE.x2, HOLE.top - 1], [HOLE.b2, HOLE.bottom], [HOLE.b1, HOLE.bottom]];
const inMark = (x, y) => inPolygon(x, y, HEX)
  && !((x - HOLE.cx) ** 2 + (y - HOLE.cy) ** 2 < HOLE.r ** 2 || inPolygon(x, y, TRAPEZOID));

// RGBA pixels of the mark at `size` px, `pad` px of margin, optional opaque background.
function render(size, pad = 0, bg = null) {
  const px = Buffer.alloc(size * size * 4);
  const scale = (size - 2 * pad) / 64, S = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        if (inMark((x + (sx + 0.5) / S - pad) / scale, (y + (sy + 0.5) / S - pad) / scale)) hits++;
      }
      const a = hits / (S * S);
      const t = Math.min(1, Math.max(0, ((x - pad) / scale + (y - pad) / scale) / 128 - 0.03));
      const c = FROM.map((f, i) => f + (TO[i] - f) * t);
      const o = (y * size + x) * 4;
      if (bg) {
        for (let i = 0; i < 3; i++) px[o + i] = Math.round(bg[i] * (1 - a) + c[i] * a);
        px[o + 3] = 255;
      } else {
        for (let i = 0; i < 3; i++) px[o + i] = Math.round(c[i]);
        px[o + 3] = Math.round(a * 255);
      }
    }
  }
  return px;
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4), crc = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type), data]);
  len.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
// ICO with PNG-compressed entries (supported by every current browser and Windows since Vista).
function ico(images) {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    head[e] = size === 256 ? 0 : size;
    head[e + 1] = size === 256 ? 0 : size;
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...images.map((i) => i.data)]);
}

const out = (name, data) => fs.writeFileSync(path.join(__dirname, name), data);
out('logo.svg', SVG);
out('logo.png', png(256, render(256, 8)));
out('favicon.ico', ico([16, 32, 48].map((size) => ({ size, data: png(size, render(size, size >= 32 ? 1 : 0)) }))));
out('apple-touch-icon.png', png(180, render(180, 34, [0x0d, 0x11, 0x17])));
console.log('wrote logo.svg, logo.png, favicon.ico, apple-touch-icon.png');
