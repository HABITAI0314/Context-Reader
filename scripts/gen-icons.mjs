// 生成应用图标（纯 Node，无依赖）：墨绿渐变底 + 翻开的书 + 一处琥珀色高亮标记
// 输出 public/icon-192.png、icon-512.png、apple-touch-icon.png、favicon.svg
// 所有坐标都是 0..1 的单位坐标，PNG 先按 4 倍超采样绘制再缩小，得到平滑边缘
import { deflateSync, crc32 } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

const C = {
  bgA: hex('#3c8a73'),
  bgB: hex('#1b463b'),
  stack: hex('#cfe2d9'),
  page: hex('#fffdf9'),
  spine: hex('#e2dccf'),
  text: hex('#cbd7d0'),
  mark: hex('#f5bd4a'),
  markText: hex('#b4741a'),
};

/* ---------- 几何 ---------- */
const bez = (p0, p1, p2, t) => [
  (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0],
  (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1],
];

// 左页：上下两条弧线（从书脊到外侧），右页镜像
const TOP = [[0.5, 0.355], [0.34, 0.275], [0.175, 0.315]];
const BOT = [[0.5, 0.745], [0.34, 0.665], [0.175, 0.705]];
const N = 48;

function pagePoly(dx = 0, dy = 0, grow = 0) {
  const top = [], bot = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const a = bez(TOP[0], TOP[1], TOP[2], t), b = bez(BOT[0], BOT[1], BOT[2], t);
    top.push([a[0] - grow * t + dx, a[1] + dy]);
    bot.push([b[0] - grow * t + dx, b[1] + dy]);
  }
  return [...top, ...bot.reverse()];
}
const mirror = (poly) => poly.map(([x, y]) => [1 - x, y]);

// 页面上第 f 行（0=顶，1=底）、从 s0 到 s1（0=书脊，1=外侧）的一段文字线
function textLine(f, s0, s1) {
  const pts = [];
  for (let i = 0; i <= 24; i++) {
    const t = s0 + ((s1 - s0) * i) / 24;
    const a = bez(TOP[0], TOP[1], TOP[2], t), b = bez(BOT[0], BOT[1], BOT[2], t);
    pts.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
  }
  return pts;
}

const leftPage = pagePoly();
const rightPage = mirror(leftPage);
const leftStack = pagePoly(-0.004, 0.028, 0.012);
const rightStack = mirror(leftStack);

const LW = 0.024; // 文字线粗细
const lines = [
  // 左页
  { pts: textLine(0.24, 0.16, 0.86) },
  { pts: textLine(0.40, 0.16, 0.86) },
  { pts: textLine(0.56, 0.16, 0.86) },
  { pts: textLine(0.72, 0.45, 0.86) },
].concat(
  [
    textLine(0.24, 0.16, 0.86),
    textLine(0.56, 0.16, 0.86),
    textLine(0.72, 0.16, 0.62),
  ].map((p) => ({ pts: mirror(p) })),
  // 右页第二行：前半段是被查过、标记出来的词
  [{ pts: mirror(textLine(0.40, 0.63, 0.86)) }]
);
const markBar = mirror(textLine(0.40, 0.13, 0.47));
const markWord = mirror(textLine(0.40, 0.19, 0.41));

/* ---------- 光栅化（扫描线填充 + 超采样） ---------- */
function makeCanvas(size) {
  const S = 4, W = size * S;
  return { W, size, S, buf: new Float32Array(W * W * 3) };
}

function fillPoly(cv, poly, color, alpha = 1) {
  const { W, buf } = cv;
  const pts = poly.map(([x, y]) => [x * W, y * W]);
  let minY = Infinity, maxY = -Infinity;
  for (const [, y] of pts) (minY = Math.min(minY, y)), (maxY = Math.max(maxY, y));
  for (let y = Math.max(0, Math.floor(minY)); y <= Math.min(W - 1, Math.ceil(maxY)); y++) {
    const cy = y + 0.5, xs = [];
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if (yi > cy !== yj > cy) xs.push(xi + ((cy - yi) * (xj - xi)) / (yj - yi));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let x = Math.max(0, Math.ceil(xs[k] - 0.5)); x <= Math.min(W - 1, Math.floor(xs[k + 1] - 0.5)); x++) {
        const c = typeof color === 'function' ? color((x + 0.5) / W, cy / W) : color;
        const o = (y * W + x) * 3;
        for (let n = 0; n < 3; n++) buf[o + n] += (c[n] - buf[o + n]) * alpha;
      }
    }
  }
}

const circle = (cx, cy, r, n = 28) =>
  Array.from({ length: n }, (_, i) => [cx + r * Math.cos((i / n) * 2 * Math.PI), cy + r * Math.sin((i / n) * 2 * Math.PI)]);

function strokeLine(cv, pts, width, color) {
  const h = width / 2;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    const len = Math.hypot(x1 - x0, y1 - y0), nx = (-(y1 - y0) / len) * h, ny = ((x1 - x0) / len) * h;
    fillPoly(cv, [[x0 + nx, y0 + ny], [x1 + nx, y1 + ny], [x1 - nx, y1 - ny], [x0 - nx, y0 - ny]], color);
  }
  for (const [x, y] of [pts[0], pts.at(-1)]) fillPoly(cv, circle(x, y, h), color);
  for (let i = 1; i + 1 < pts.length; i++) fillPoly(cv, circle(pts[i][0], pts[i][1], h, 12), color);
}

// 页面颜色：靠近书脊处略暗，模拟纸张弯折
const pageColor = (x) => {
  const d = Math.abs(x - 0.5);
  return mix(C.spine, C.page, Math.min(1, d / 0.09) ** 0.6);
};

function draw(size) {
  const cv = makeCanvas(size);
  // 背景：左上 → 右下渐变
  fillPoly(cv, [[0, 0], [1, 0], [1, 1], [0, 1]], (x, y) => mix(C.bgA, C.bgB, Math.min(1, (x + y) / 2 * 1.1)));
  // 书本投影：多层半透明椭圆模拟柔和阴影
  for (let i = 0; i < 8; i++) {
    const poly = circle(0.5, 0.77, 1, 64).map(([x, y]) => [0.5 + (x - 0.5) * (0.30 + i * 0.012), 0.77 + (y - 0.77) * (0.035 + i * 0.006)]);
    fillPoly(cv, poly, [10, 30, 24], 0.07);
  }
  fillPoly(cv, leftStack, C.stack);
  fillPoly(cv, rightStack, C.stack);
  fillPoly(cv, leftPage, (x) => pageColor(x));
  fillPoly(cv, rightPage, (x) => pageColor(x));
  strokeLine(cv, markBar, 0.062, C.mark);
  for (const l of lines) strokeLine(cv, l.pts, LW, C.text);
  strokeLine(cv, markWord, LW, C.markText);
  return cv;
}

/* ---------- PNG 编码 ---------- */
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

function png(size) {
  const { W, S, buf } = draw(size);
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    for (let x = 0; x < size; x++)
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) sum += buf[((y * S + sy) * W + x * S + sx) * 3 + c];
        raw[row + 1 + x * 3 + c] = Math.round(sum / (S * S));
      }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- SVG（浏览器标签页图标，同一套几何） ---------- */
function svg() {
  const f = (n) => +(n * 100).toFixed(2);
  const rgb = (c) => `rgb(${c.map(Math.round).join(',')})`;
  const path = (poly) => 'M' + poly.map(([x, y]) => `${f(x)} ${f(y)}`).join('L') + 'Z';
  const pl = (pts) => pts.map(([x, y]) => `${f(x)},${f(y)}`).join(' ');
  const stroke = (pts, w, c) => `<polyline points="${pl(pts)}" fill="none" stroke="${rgb(c)}" stroke-width="${f(w)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${rgb(C.bgA)}"/><stop offset="0.9" stop-color="${rgb(C.bgB)}"/></linearGradient>
<linearGradient id="pg" x1="0" x2="1"><stop offset="0.17" stop-color="${rgb(C.page)}"/><stop offset="0.5" stop-color="${rgb(C.spine)}"/><stop offset="0.83" stop-color="${rgb(C.page)}"/></linearGradient>
</defs>
<rect width="100" height="100" rx="22" fill="url(#bg)"/>
<path d="${path(leftStack)}${path(rightStack)}" fill="${rgb(C.stack)}"/>
<path d="${path(leftPage)}${path(rightPage)}" fill="url(#pg)"/>
${stroke(markBar, 0.062, C.mark)}
${lines.map((l) => stroke(l.pts, LW, C.text)).join('\n')}
${stroke(markWord, LW, C.markText)}
</svg>
`;
}

for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  writeFileSync(new URL(`../public/${name}`, import.meta.url), png(size));
  console.log('wrote', name);
}
writeFileSync(new URL('../public/favicon.svg', import.meta.url), svg());
console.log('wrote favicon.svg');
