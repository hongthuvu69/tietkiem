// Vẽ icon app (heo đất + đồng xu trên nền xanh) ra PNG, không cần thư viện ngoài.
// Chạy: node tools/make_icons.js   →   docs/icons/{apple-touch-icon,icon-192,icon-512}.png
// Hình vẽ trong hệ tọa độ 512×512, khử răng cưa bằng cách lấy mẫu 4×4 điểm mỗi pixel.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const WHITE = hex("#ffffff");
const SNOUT = hex("#dff3ea");
const DARK = hex("#0a5c44");
const GOLD = hex("#f7c948");
const GOLD_D = hex("#d99a12");
const BG_A = hex("#10936b");
const BG_B = hex("#06443a");

const ellipse = (cx, cy, rx, ry) => (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
const circle = (cx, cy, r) => ellipse(cx, cy, r, r);
const rrect = (x0, y0, x1, y1, r) => (x, y) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const dx = Math.max(x0 + r - x, 0, x - (x1 - r));
  const dy = Math.max(y0 + r - y, 0, y - (y1 - r));
  return dx * dx + dy * dy <= r * r;
};
const tri = (ax, ay, bx, by, cx, cy) => (x, y) => {
  const s = (px, py, qx, qy) => (x - qx) * (py - qy) - (px - qx) * (y - qy);
  const d1 = s(ax, ay, bx, by);
  const d2 = s(bx, by, cx, cy);
  const d3 = s(cx, cy, ax, ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
};
const ring = (cx, cy, r0, r1) => (x, y) => {
  const d = (x - cx) ** 2 + (y - cy) ** 2;
  return d <= r1 * r1 && d >= r0 * r0;
};

// Thứ tự vẽ: hình sau đè lên hình trước.
const DX = -8; // dịch cả hình sang trái cho cân giữa
const shapes = [
  [ellipse(250 + DX, 296, 150, 116), WHITE], // thân
  [tri(296 + DX, 214, 330 + DX, 150, 368 + DX, 222), WHITE], // tai
  [rrect(170 + DX, 360, 210 + DX, 428, 16), WHITE], // chân trước
  [rrect(292 + DX, 360, 332 + DX, 428, 16), WHITE], // chân sau
  [rrect(366 + DX, 262, 432 + DX, 328, 22), SNOUT], // mõm
  [circle(388 + DX, 295, 6.5), DARK], // lỗ mũi
  [circle(410 + DX, 295, 6.5), DARK],
  [circle(338 + DX, 258, 10), DARK], // mắt
  [rrect(206 + DX, 196, 294 + DX, 210, 7), DARK], // khe bỏ tiền
  [circle(250 + DX, 128, 50), GOLD], // đồng xu
  [ring(250 + DX, 128, 33, 39), GOLD_D],
  [rrect(244 + DX, 104, 256 + DX, 152, 6), GOLD_D],
];

function render(size) {
  const k = 512 / size;
  const N = 4;
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < N; sy++) {
        for (let sx = 0; sx < N; sx++) {
          const x = (px + (sx + 0.5) / N) * k;
          const y = (py + (sy + 0.5) / N) * k;
          const t = Math.min(1, Math.max(0, (x + y) / 1024));
          let c = [BG_A[0] + (BG_B[0] - BG_A[0]) * t, BG_A[1] + (BG_B[1] - BG_A[1]) * t, BG_A[2] + (BG_B[2] - BG_A[2]) * t];
          for (const [inside, col] of shapes) if (inside(x, y)) c = col;
          r += c[0];
          g += c[1];
          b += c[2];
        }
      }
      const i = (py * size + px) * 4;
      out[i] = Math.round(r / (N * N));
      out[i + 1] = Math.round(g / (N * N));
      out[i + 2] = Math.round(b / (N * N));
      out[i + 3] = 255;
    }
  }
  return out;
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 8 bit
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const dir = path.join(__dirname, "..", "docs", "icons");
fs.mkdirSync(dir, { recursive: true });
for (const [name, size] of [
  ["apple-touch-icon.png", 180],
  ["icon-192.png", 192],
  ["icon-512.png", 512],
]) {
  fs.writeFileSync(path.join(dir, name), png(size, render(size)));
  console.log("đã tạo", name);
}
