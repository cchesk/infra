'use strict';
// Draws the logo (a hexagon with a keyhole) from one geometry into every format we need:
//   logo.svg, logo.png    the full-colour logo (blue to violet): page headers, Authelia's portal (server.asset_path)
//   favicon.svg/.ico      monochrome: white mark on a black rounded square (.ico has 16, 32 and 48 px)
//   apple-touch-icon.png  monochrome, full square (iOS rounds the corners itself)
// The same files are copied into the loginpage repo (assets/).
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

const MARK = `M${HEX.map((p) => p.join(' ')).join('L')}Z
M${HOLE.x1} ${HOLE.top}A${HOLE.r} ${HOLE.r} 0 1 1 ${HOLE.x2} ${HOLE.top}L${HOLE.b2} ${HOLE.bottom}L${HOLE.b1} ${HOLE.bottom}Z`;
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b82f6"/><stop offset="1" stop-color="#7c3aed"/></linearGradient></defs>
<path fill="url(#g)" fill-rule="evenodd" d="${MARK}"/>
</svg>
`;
// Monochrome favicon: the mark at 80% inside a black square with 22% corner radius.
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<rect width="64" height="64" rx="14" fill="#000"/>
<path fill="#fff" fill-rule="evenodd" transform="translate(6.4 6.4) scale(0.8)" d="${MARK}"/>
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

// RGBA pixels of the mark at `size` px with `pad` px of margin. Options: color (RGB; default the gradient),
// bg (RGB background) and radius (corner radius of the background as a fraction of size; 0 = full square).
function render(size, pad = 0, { color = null, bg = null, radius = 0 } = {}) {
  const r = radius * size;
  const inBg = (x, y) => {
    const dx = Math.max(r - x, x - (size - r), 0), dy = Math.max(r - y, y - (size - r), 0);
    return dx * dx + dy * dy <= r * r;
  };
  const px = Buffer.alloc(size * size * 4);
  const scale = (size - 2 * pad) / 64, S = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0, bgHits = 0;
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        const px_ = x + (sx + 0.5) / S, py_ = y + (sy + 0.5) / S;
        if (inMark((px_ - pad) / scale, (py_ - pad) / scale)) hits++;
        if (bg && inBg(px_, py_)) bgHits++;
      }
      const a = hits / (S * S), bgA = bgHits / (S * S);
      const t = Math.min(1, Math.max(0, ((x - pad) / scale + (y - pad) / scale) / 128 - 0.03));
      const c = color || FROM.map((f, i) => f + (TO[i] - f) * t);
      const o = (y * size + x) * 4;
      if (bg) {
        // The mark lies inside the background, so coverage of the two composes simply.
        for (let i = 0; i < 3; i++) px[o + i] = Math.round(a ? (bg[i] * (bgA - a) + c[i] * a) / bgA : bg[i]);
        px[o + 3] = Math.round(bgA * 255);
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
const WHITE = [255, 255, 255], BLACK = [0, 0, 0];
out('logo.svg', SVG);
out('logo.png', png(256, render(256, 8)));
out('favicon.svg', FAVICON_SVG);
out('favicon.ico', ico([16, 32, 48].map((size) => ({ size, data: png(size, render(size, size * 0.1, { color: WHITE, bg: BLACK, radius: 0.22 })) }))));
out('apple-touch-icon.png', png(180, render(180, 36, { color: WHITE, bg: BLACK })));
console.log('wrote logo.svg, logo.png, favicon.svg, favicon.ico, apple-touch-icon.png');
