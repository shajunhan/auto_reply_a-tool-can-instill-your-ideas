/**
 * 生成大脑形状图标：
 *  - icon.ico       （多尺寸，用于桌面快捷方式）
 *  - public\favicon.png （网页端图标）
 * 纯 Node.js 实现，无第三方依赖。
 */
'use strict';

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

/* ------------------------- 调色板 ------------------------- */
const BASE = [247, 199, 180]; // 大脑主体（浅桃粉，接近 🧠 表情）
const FOLD = [222, 150, 133]; // 脑沟（深一档）
const SHADE = [236, 180, 160]; // 底部阴影
const RIM = [196, 120, 104]; // 边缘描边

/* ------------------------- 512 画布渲染 ------------------------- */
const W = 512;
const data = new Uint8ClampedArray(W * W * 4);

function ellipse(x, y, cx, cy, rx, ry) {
  const dx = (x - cx) / rx;
  const dy = (y - cy) / ry;
  return dx * dx + dy * dy <= 1;
}

// 大脑轮廓：左右两个大脑半球 + 底部小脑
function inBrain(x, y) {
  return (
    ellipse(x, y, 210, 252, 124, 156) ||
    ellipse(x, y, 302, 252, 124, 156) ||
    ellipse(x, y, 256, 394, 58, 34)
  );
}

// 判断是否为轮廓边缘（用于描边）
function onRim(x, y) {
  if (inBrain(x, y)) return false;
  for (let dy = -2; dy <= 2; dy++)
    for (let dx = -2; dx <= 2; dx++)
      if (dx * dx + dy * dy <= 4 && inBrain(x + dx, y + dy)) return true;
  return false;
}

function setPix(x, y, color) {
  x = Math.round(x);
  y = Math.round(y);
  if (x < 0 || y < 0 || x >= W || y >= W) return;
  const i = (y * W + x) * 4;
  data[i] = color[0];
  data[i + 1] = color[1];
  data[i + 2] = color[2];
  data[i + 3] = 255;
}

// 画一条带厚度的折线（脑沟）
function drawLine(points, thickness, color) {
  const r = thickness / 2;
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 0.6);
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const cx = x0 + (x1 - x0) * t;
      const cy = y0 + (y1 - y0) * t;
      for (let dy = -r; dy <= r; dy += 0.5)
        for (let dx = -r; dx <= r; dx += 0.5)
          if (dx * dx + dy * dy <= r * r) {
            const gx = cx + dx;
            const gy = cy + dy;
            if (inBrain(gx, gy)) setPix(gx, gy, color);
          }
    }
  }
}

/* ---------- 逐像素填充 ---------- */
for (let y = 0; y < W; y++) {
  for (let x = 0; x < W; x++) {
    if (inBrain(x, y)) {
      // 底部轻微阴影
      let c = BASE;
      if (y > 330) {
        const k = Math.min(1, (y - 330) / 130);
        c = [
          Math.round(BASE[0] * (1 - k * 0.5) + SHADE[0] * k * 0.5),
          Math.round(BASE[1] * (1 - k * 0.5) + SHADE[1] * k * 0.5),
          Math.round(BASE[2] * (1 - k * 0.5) + SHADE[2] * k * 0.5),
        ];
      }
      setPix(x, y, c);
    } else if (onRim(x, y)) {
      setPix(x, y, RIM);
    }
  }
}

/* ---------- 脑沟（左右半球各 4 条波浪线） ---------- */
const rowsL = [
  [186, 11, 0.3],
  [238, 13, 1.6],
  [298, 12, 2.8],
  [352, 10, 0.9],
];
const rowsR = [
  [190, 11, 0.3],
  [242, 13, 1.6],
  [302, 12, 2.8],
  [356, 10, 0.9],
];
function gyriRows(rows, x0, x1) {
  for (const [cy, amp, ph] of rows) {
    const pts = [];
    for (let x = x0; x <= x1; x += 2) {
      pts.push([x, cy + amp * Math.sin((x - x0) * 0.055 + ph)]);
    }
    drawLine(pts, 5, FOLD);
  }
}
gyriRows(rowsL, 100, 250);
gyriRows(rowsR, 262, 412);

/* 中央纵裂 */
const fissure = [];
for (let y = 108; y <= 368; y += 2) {
  fissure.push([256 + 4 * Math.sin((y - 108) * 0.03), y]);
}
drawLine(fissure, 5, FOLD);

/* 小脑上的短弧线 */
drawLine([[226, 392], [256, 404], [286, 392]], 4, FOLD);

/* ------------------------- 工具：降采样 / PNG / ICO ------------------------- */

function downsample(src, sw, sh, dw, dh) {
  const out = new Uint8ClampedArray(dw * dh * 4);
  const sx = sw / dw;
  const sy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++)
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * sw + xx) * 4;
          const aa = src[i + 3] / 255;
          r += src[i] * aa;
          g += src[i + 1] * aa;
          b += src[i + 2] * aa;
          a += aa;
          n += aa;
        }
      const idx = (y * dw + x) * 4;
      if (n > 0) {
        out[idx] = Math.round(r / n);
        out[idx + 1] = Math.round(g / n);
        out[idx + 2] = Math.round(b / n);
        out[idx + 3] = Math.min(255, Math.round(a / n * 255));
      }
    }
  }
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    const srcStart = y * width * 4;
    for (let i = 0; i < width * 4; i++) raw[y * (width * 4 + 1) + 1 + i] = rgba[srcStart + i];
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function encodeICO(pngs) {
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  const entries = [];
  let offset = 6 + 16 * count;
  for (const p of pngs) {
    const e = Buffer.alloc(16);
    e[0] = p.size >= 256 ? 0 : p.size;
    e[1] = p.size >= 256 ? 0 : p.size;
    e[2] = 0;
    e[3] = 0;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(p.data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += p.data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

/* ------------------------- 输出 ------------------------- */

const p256 = downsample(data, W, W, 256, 256);
const sizes = [16, 32, 48, 64, 128, 256];
const pngs = [];
let prev = p256;
let prevSize = 256;
for (const s of sizes) {
  if (s === prevSize) {
    pngs.push({ size: s, data: encodePNG(s, s, prev) });
  } else {
    prev = downsample(prev, prevSize, prevSize, s, s);
    prevSize = s;
    pngs.push({ size: s, data: encodePNG(s, s, prev) });
  }
}

fs.writeFileSync(path.join(__dirname, 'icon.ico'), encodeICO(pngs));
fs.writeFileSync(path.join(__dirname, 'public', 'favicon.png'), encodePNG(256, 256, p256));
console.log('OK: icon.ico (' + sizes.join('/') + 'px) + public/favicon.png (256px)');
