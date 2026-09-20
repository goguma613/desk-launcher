/**
 * 앱 아이콘 원본(1024×1024 PNG)을 만듭니다.
 *
 *   node scripts/make-icon.mjs
 *   npx tauri icon scripts/app-icon.png
 *
 * 두 번째 명령이 src-tauri/icons/ 아래의 모든 크기와 .ico를 다시 생성합니다.
 * 시안에서 앱 아이콘을 받으면 이 스크립트 대신 그 파일을 tauri icon에
 * 넘기면 됩니다.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 1024;
const OUT = join(dirname(fileURLToPath(import.meta.url)), "app-icon.png");

/* --- 모양 ---------------------------------------------------------------- */

/** 둥근 사각형의 부호 있는 거리. 음수면 내부. */
function roundedRect(x, y, cx, cy, hx, hy, r) {
  const qx = Math.abs(x - cx) - (hx - r);
  const qy = Math.abs(y - cy) - (hy - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

/** 거리 → 0~1 커버리지 (1px 안티에일리어싱) */
function coverage(d) {
  return Math.min(1, Math.max(0, 0.5 - d));
}

/* --- 색 ------------------------------------------------------------------ */

/* 시안 팔레트를 따릅니다.
   바탕은 패널색(--panel #14161A ~ --panel-raise #22262D),
   타일은 액센트 앰버(--accent #E0A458).
   작업 표시줄이 대개 어두우므로, 대비는 앰버 타일이 냅니다. */
const BG_TOP = [26, 30, 36];
const BG_BOTTOM = [37, 42, 50];
const TILE_TOP = [234, 176, 106];
const TILE_BOTTOM = [216, 155, 78];

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/* --- 픽셀 ---------------------------------------------------------------- */

const half = SIZE / 2;
const pixels = Buffer.alloc(SIZE * SIZE * 4);

// 타일 2×2
const TILE_SIZE = 300;
const TILE_GAP = 64;
const span = TILE_SIZE * 2 + TILE_GAP;
const origin = (SIZE - span) / 2;
const tiles = [];
for (let row = 0; row < 2; row += 1) {
  for (let col = 0; col < 2; col += 1) {
    tiles.push({
      cx: origin + col * (TILE_SIZE + TILE_GAP) + TILE_SIZE / 2,
      cy: origin + row * (TILE_SIZE + TILE_GAP) + TILE_SIZE / 2,
    });
  }
}

for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    const px = x + 0.5;
    const py = y + 0.5;

    const bgCov = coverage(roundedRect(px, py, half, half, half, half, 224));
    if (bgCov <= 0) continue;

    let [r, g, b] = mix(BG_TOP, BG_BOTTOM, py / SIZE);
    let a = bgCov;

    let tileCov = 0;
    for (const t of tiles) {
      const c = coverage(
        roundedRect(px, py, t.cx, t.cy, TILE_SIZE / 2, TILE_SIZE / 2, 74)
      );
      if (c > tileCov) tileCov = c;
    }

    if (tileCov > 0) {
      const [tr, tg, tb] = mix(TILE_TOP, TILE_BOTTOM, py / SIZE);
      r = Math.round(r + (tr - r) * tileCov);
      g = Math.round(g + (tg - g) * tileCov);
      b = Math.round(b + (tb - b) * tileCov);
      a = Math.max(a, tileCov * bgCov);
    }

    const i = (y * SIZE + x) * 4;
    pixels[i] = r;
    pixels[i + 1] = g;
    pixels[i + 2] = b;
    pixels[i + 3] = Math.round(a * 255);
  }
}

/* --- PNG 인코딩 ---------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
ihdr[10] = 0; // deflate
ihdr[11] = 0; // adaptive filtering
ihdr[12] = 0; // no interlace

// 스캔라인마다 필터 바이트(0) 붙이기
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y += 1) {
  const src = y * SIZE * 4;
  const dst = y * (SIZE * 4 + 1);
  raw[dst] = 0;
  pixels.copy(raw, dst + 1, src, src + SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, png);
console.log(`${OUT} (${SIZE}×${SIZE}, ${(png.length / 1024).toFixed(1)} KB)`);
