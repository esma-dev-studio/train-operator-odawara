/* =========================================================
 * scene/trains.js — 通勤電車キット（手続き生成・共有ジオメトリ）
 * 架空デザインのステンレス通勤電車(20m・片側4扉)を組み立てる。
 * 実在の会社の塗装・ロゴ・前面デザインは使わない（空色の窓帯+オレンジの細帯）。
 *
 *  - 車体断面は2Dプロファイル(すそすぼまり・丸い肩・平たい屋根)を前後に掃引
 *  - 側面/屋根/屋根上機器はキャンバスで描くアトラス1枚
 *    (色 + 粗さ/金属/AO + 法線 + 夜の窓明かり)
 *  - 1両の描画: 車体 / 床下・台車・パンタ(頂点色) / 表記(編成ごと)
 *    先頭車だけ: 前頭部 + 灯火(前照灯・尾灯・光芒)
 *  - ジオメトリ・材質・テクスチャはキット内で共有(iPad向け)
 *
 * 座標(1両): 原点=車体中心・レール面, +Z=前, +X=進行方向の左, y=レール面からの高さ
 * three.js r152+ の色管理: キャンバスはsRGB指定、頂点色はTHREE.Colorでリニア化して入れる
 * ========================================================= */
import * as THREE from '../vendor/three.module.min.js';

export const CAR_LEN = 20.0;      // 連結面間(m)
export const BODY_LEN = 19.5;     // 車体長(m)
export const BOGIE_Z = 6.9;       // 台車中心(±)
export const WHEELBASE = 2.1;
export const WHEEL_R = 0.43;

const HB = BODY_LEN / 2;          // 9.75
const CAB_Z = 9.28;               // 先頭車: 側面がここで終わり、前頭部がふくらむ
const NOSE = 0.36;                // 前頭部のふくらみ(中央)
const SE_P = 2.6;                 // 前頭部の平面形(超楕円の指数: 中央は平ら・角は丸い)

/* 側面のレイアウト(m) */
const Y_FLOOR = 1.13;
const Y_ROOF = 3.65;
const Y_PIN0 = 1.795, Y_PIN1 = 1.835;     // オレンジの細帯
const Y_BAND0 = 1.88, Y_BAND1 = 3.0;      // 空色の窓帯
const Y_WIN0 = 1.98, Y_WIN1 = 2.90;       // 側窓
const Y_DOOR1 = 2.985;                    // 扉の上端
const DOOR_Z = [-7.23, -2.41, 2.41, 7.23];
const DOOR_HW = 0.65;
const SIDE_WINS = [[-6.44, -4.88], [-4.76, -3.20], [-1.62, -0.06], [0.06, 1.62], [3.20, 4.76], [4.88, 6.44]];
const END_WIN = [8.12, 9.10];
const LED_SIDE = { z0: -9.05, z1: -8.19, y0: 2.70, y1: 2.89 };
const NUM_SIDE = { zc: 8.15, w: 0.34, y0: 1.44, y1: 1.55 };
const CREW_DOOR = [8.42, 9.02];
/* 前面のレイアウト */
const MASK = { x: 1.22, y0: 1.90, y1: 3.27 };
const LED_FRONT = { x: 0.62, y0: 3.02, y1: 3.21 };
const NUM_FRONT = { x: 0.21, y0: 1.40, y1: 1.54 };
const LAMP = { x0: 0.78, x1: 1.18, hy0: 1.34, hy1: 1.49, ty0: 1.535, ty1: 1.60 };

const FONT = '"Zen Kaku Gothic New", "Hiragino Sans", "Hiragino Kaku Gothic ProN", Meiryo, "IPAGothic", sans-serif';

/* 画質ごとの細かさ */
const QUAL = {
  high: { atlas: 2048, nrm: 1, orm: 1, front: 1024, prof: { lower: 6, side: 6, eave: 7, roof: 7 }, faceCols: 20, wheelSeg: 12, cylSeg: 10, detail: 2 },
  mid:  { atlas: 2048, nrm: 0.5, orm: 0.5, front: 1024, prof: { lower: 4, side: 4, eave: 5, roof: 5 }, faceCols: 14, wheelSeg: 10, cylSeg: 8, detail: 1 },
  low:  { atlas: 1024, nrm: 0, orm: 1, front: 512, prof: { lower: 3, side: 2, eave: 3, roof: 3 }, faceCols: 8, wheelSeg: 7, cylSeg: 6, detail: 0 },
};

/* 種別表示(架空の配色) */
const KINDS = {
  local: { label: '各停', bg: '#d8d8d8', fg: '#000000' },
  semi:  { label: '準急', bg: '#2fb24a', fg: '#ffffff' },
  exp:   { label: '急行', bg: '#ff6a1a', fg: '#ffffff' },
  rapid: { label: '快急', bg: '#2f86e8', fg: '#ffffff' },
};
const LABEL_KIND = { 各停: 'local', 各駅停車: 'local', 準急: 'semi', 急行: 'exp', 快急: 'rapid', 快速急行: 'rapid' };

/* ---------- 小さな道具 ---------- */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const lin = (hex) => new THREE.Color(hex);   // sRGB → リニア(頂点色用)
const WHITE = new THREE.Color(1, 1, 1);
const _v = new THREE.Vector3(), _n = new THREE.Vector3();
const AX_Y = new THREE.Vector3(0, 1, 0), AX_Z = new THREE.Vector3(0, 0, 1);
const ROT_PI = new THREE.Matrix4().makeRotationY(Math.PI);   // 後ろ向きの運転台

function mat4(x, y, z, sx = 1, sy = 1, sz = 1) {
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion(), new THREE.Vector3(sx, sy, sz));
}

/* ---------- ジオメトリの寄せ集め(材質ごとに1つへまとめる) ---------- */
class Acc {
  constructor() { this.p = []; this.n = []; this.t = []; this.c = []; this.i = []; this.k = 0; }
  v(x, y, z, nx, ny, nz, u = 0, w = 0, col = WHITE) {
    this.p.push(x, y, z); this.n.push(nx, ny, nz); this.t.push(u, w); this.c.push(col.r, col.g, col.b);
    return this.k++;
  }
  tri(a, b, c) { this.i.push(a, b, c); }
  /* 既存ジオメトリを行列つきで取り込む(uvrでアトラスの区画へ写す) */
  add(geo, m = null, col = null, uvr = null) {
    const P = geo.attributes.position, N = geo.attributes.normal, T = geo.attributes.uv, C = geo.attributes.color;
    const nm = m ? new THREE.Matrix3().getNormalMatrix(m) : null;
    const base = this.k, i0 = this.i.length;
    for (let j = 0; j < P.count; j++) {
      _v.fromBufferAttribute(P, j); if (m) _v.applyMatrix4(m);
      if (N) { _n.fromBufferAttribute(N, j); if (nm) _n.applyMatrix3(nm).normalize(); } else _n.set(0, 1, 0);
      let u = T ? T.getX(j) : 0, w = T ? T.getY(j) : 0;
      if (uvr) { u = uvr.u0 + u * (uvr.u1 - uvr.u0); w = uvr.v0 + w * (uvr.v1 - uvr.v0); }
      const cc = col || (C ? { r: C.getX(j), g: C.getY(j), b: C.getZ(j) } : WHITE);
      this.v(_v.x, _v.y, _v.z, _n.x, _n.y, _n.z, u, w, cc);
    }
    if (geo.index) { const ix = geo.index.array; for (let j = 0; j < ix.length; j++) this.i.push(base + ix[j]); }
    else for (let j = 0; j < P.count; j++) this.i.push(base + j);
    /* 鏡像(行列式<0)なら面の向きを戻す */
    if (m && m.determinant() < 0) {
      for (let j = i0; j < this.i.length; j += 3) { const t = this.i[j + 1]; this.i[j + 1] = this.i[j + 2]; this.i[j + 2] = t; }
    }
    return this;
  }
  /* 単位箱・単位円柱を変形して置く */
  box(cx, cy, cz, sx, sy, sz, col, uvr) { return this.add(UNIT.box(), mat4(cx, cy, cz, sx, sy, sz), col, uvr); }
  beam(p0, p1, w, h, col) {
    const d = new THREE.Vector3().subVectors(p1, p0); const L = d.length();
    const q = new THREE.Quaternion().setFromUnitVectors(AX_Z, d.normalize());
    const m = new THREE.Matrix4().compose(new THREE.Vector3().addVectors(p0, p1).multiplyScalar(0.5), q, new THREE.Vector3(w, h, L));
    return this.add(UNIT.box(), m, col);
  }
  cyl(p0, p1, r, seg, col, caps = true) {
    const d = new THREE.Vector3().subVectors(p1, p0); const L = d.length();
    const q = new THREE.Quaternion().setFromUnitVectors(AX_Y, d.normalize());
    const m = new THREE.Matrix4().compose(new THREE.Vector3().addVectors(p0, p1).multiplyScalar(0.5), q, new THREE.Vector3(r, L, r));
    return this.add(UNIT.cyl(seg, caps), m, col);
  }
  geometry(withColor) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.t, 2));
    if (withColor) g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setIndex(this.k > 65535 ? new THREE.Uint32BufferAttribute(this.i, 1) : new THREE.Uint16BufferAttribute(this.i, 1));
    g.computeBoundingBox(); g.computeBoundingSphere();
    return g;
  }
}

/* 単位形状(使い回し) */
const UNIT = {
  _b: null, _c: {},
  box() { return this._b || (this._b = new THREE.BoxGeometry(1, 1, 1)); },
  cyl(seg, caps) { const k = seg + (caps ? 'c' : 'o'); return this._c[k] || (this._c[k] = new THREE.CylinderGeometry(1, 1, 1, seg, 1, !caps)); },
};

/* BufferGeometryUtils の代わり: position/normal/uv(/color) を1つにまとめる(インデックス有無どちらも可) */
export function mergeGeometries(geos, withColor = false) {
  const a = new Acc();
  geos.forEach((g) => a.add(g));
  return a.geometry(withColor);
}

/* ---------- 車体断面プロファイル ---------- */
function makeProfile(q) {
  const P = [];
  const cub = (a, b, c, d, n, skip) => {
    for (let i = skip ? 1 : 0; i <= n; i++) {
      const t = i / n, s = 1 - t;
      const k0 = s * s * s, k1 = 3 * s * s * t, k2 = 3 * s * t * t, k3 = t * t * t;
      P.push([k0 * a[0] + k1 * b[0] + k2 * c[0] + k3 * d[0], k0 * a[1] + k1 * b[1] + k2 * c[1] + k3 * d[1]]);
    }
  };
  /* 右半分(x>0)を 裾 → 屋根の中心 の順に。すそすぼまり → まっすぐな側面 → 丸い肩 → 平たい屋根 */
  cub([1.385, 1.0], [1.418, 1.36], [1.475, 1.66], [1.475, 2.0], q.lower);
  for (let i = 1; i <= q.side; i++) { const k = i / q.side; P.push([1.475 - 0.007 * k, 2.0 + 1.08 * k]); }
  cub([1.468, 3.08], [1.463, 3.30], [1.37, 3.471], [1.20, 3.515], q.eave, true);
  const roofStart = P.length - 1;
  cub([1.20, 3.515], [0.85, 3.605], [0.45, 3.65], [0, 3.65], q.roof, true);
  const n = P.length;
  const s = [0];
  for (let i = 1; i < n; i++) s.push(s[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
  /* 外向き法線(反時計回りの多角形: 進む向き(dx,dy) → (dy,-dx)) */
  const N = P.map((_, i) => {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    return [dy / l, -dx / l];
  });
  /* 高さyでの半幅・弧長(yは単調増加) */
  const interp = (y, key) => {
    if (y <= P[0][1]) return key === 'x' ? P[0][0] : 0;
    for (let i = 1; i < n; i++) {
      if (P[i][1] >= y) {
        const k = (y - P[i - 1][1]) / Math.max(1e-6, P[i][1] - P[i - 1][1]);
        return key === 'x' ? P[i - 1][0] + (P[i][0] - P[i - 1][0]) * k : s[i - 1] + (s[i] - s[i - 1]) * k;
      }
    }
    return key === 'x' ? 0 : s[n - 1];
  };
  return {
    P, N, s, n, roofStart,
    sSide: s[roofStart], sRoofHalf: s[n - 1] - s[roofStart],
    xAt: (y) => interp(y, 'x'),
    sOfY: (y) => Math.min(s[roofStart], interp(y, 's')),
  };
}

/* 前頭部のふくらみ(中央の出っ張り量をyの関数で) */
function noseDepth(y) {
  if (y < 1.3) return NOSE - (1.3 - y) * 0.12;          // 下端は少し引っ込める
  if (y < 2.05) return NOSE;
  if (y < 3.22) return NOSE - (y - 2.05) * 0.15;         // 窓部は後ろへ傾ける
  const d0 = NOSE - (3.22 - 2.05) * 0.15;
  const k = Math.min(1, (y - 3.22) / (Y_ROOF - 3.22));
  return d0 * Math.cos(k * Math.PI / 2);                  // 屋根へまるく落とす
}
const se = (t) => Math.pow(Math.max(0, 1 - Math.pow(Math.min(1, Math.abs(t)), SE_P)), 1 / SE_P);

/* ---------- キャンバス道具 ---------- */
function newCanvas(w, h) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  return cv;
}
/* 角丸四角(縦横で半径が違ってよい) */
function rr(c, x, y, w, h, rx, ry) {
  if (w < 0) { x += w; w = -w; }
  if (h < 0) { y += h; h = -h; }
  rx = Math.min(rx || 0, w / 2); ry = Math.min(ry === undefined ? rx : ry, h / 2);
  c.beginPath();
  c.moveTo(x + rx, y);
  c.lineTo(x + w - rx, y); c.quadraticCurveTo(x + w, y, x + w, y + ry);
  c.lineTo(x + w, y + h - ry); c.quadraticCurveTo(x + w, y + h, x + w - rx, y + h);
  c.lineTo(x + rx, y + h); c.quadraticCurveTo(x, y + h, x, y + h - ry);
  c.lineTo(x, y + ry); c.quadraticCurveTo(x, y, x + rx, y);
  c.closePath();
}

/* 塗りの材質表: [色(sRGB), ORM(R=AO,G=粗さ,B=金属), 高さ(法線用)] */
const PAL = {
  steel:  ['#b6bdc2', [255, 80, 205], 128],
  door:   ['#bfc5c9', [255, 70, 210], 121],
  band:   ['#2f9dc4', [255, 95, 45], 128],
  pin:    ['#f08a24', [255, 95, 45], 128],
  frame:  ['#272b2f', [190, 140, 60], 138],
  glass:  ['#121920', [230, 14, 95], 106],
  gap:    ['#18191b', [70, 220, 0], 62],
  black:  ['#0d0f11', [210, 60, 30], 128],
  roof:   ['#80868b', [230, 165, 70], 128],
  walk:   ['#959a9e', [235, 215, 35], 131],
  acbody: ['#a9afb4', [255, 140, 110], 128],
  grille: ['#3b4044', [170, 175, 110], 108],
  lamp:   ['#b8321c', [255, 50, 0], 130],
  fglass: ['#0e1419', [255, 8, 120], 104],
  led:    ['#050607', [255, 60, 20], 120],
};
function fs(c, mode, key) {
  const p = PAL[key];
  if (mode === 'col') c.fillStyle = p[0];
  else if (mode === 'orm') c.fillStyle = `rgb(${p[1][0]},${p[1][1]},${p[1][2]})`;
  else if (mode === 'hgt') c.fillStyle = `rgb(${p[2]},${p[2]},${p[2]})`;
  else c.fillStyle = '#000';
}

/* ステンレスの地肌(細かいヘアライン+ゆるい歪み) */
function grain(c, mode, x, y, w, h, seed, dense = 1) {
  const R = rng(seed);
  if (mode === 'col') {
    const n = Math.floor(w * h / 260 * dense);
    for (let i = 0; i < n; i++) {
      const a = 0.025 + R() * 0.05;
      c.fillStyle = R() < 0.5 ? `rgba(255,255,255,${a})` : `rgba(40,48,56,${a})`;
      c.fillRect(x + R() * w, y + R() * h, 18 + R() * 160, 1);
    }
  }
  if (mode === 'col' || mode === 'orm') {
    /* 板のゆるい波打ち(映り込みのムラになる) */
    for (let i = 0; i < 26 * dense; i++) {
      const cx = x + R() * w, cy = y + R() * h, r = (0.15 + R() * 0.35) * h;
      const g = c.createRadialGradient(cx, cy, 0, cx, cy, r);
      const a = 0.05 + R() * 0.05;
      const col = mode === 'col' ? (R() < 0.5 ? '255,255,255' : '30,36,42') : (R() < 0.5 ? '255,110,210' : '255,55,200');
      g.addColorStop(0, `rgba(${col},${a})`); g.addColorStop(1, `rgba(${col},0)`);
      c.fillStyle = g; c.fillRect(cx - r, cy - r, r * 2, r * 2);
    }
  }
}

/* 高さ → 法線マップ(OpenGL流: +Vが上) */
function heightToNormal(cv, strength) {
  const w = cv.width, h = cv.height;
  const c = cv.getContext('2d');
  const src = c.getImageData(0, 0, w, h).data;
  const out = c.createImageData(w, h), d = out.data;
  const k = strength / 255;
  for (let y = 0; y < h; y++) {
    const yu = Math.max(0, y - 1) * w, yd = Math.min(h - 1, y + 1) * w, yr = y * w;
    for (let x = 0; x < w; x++) {
      const xl = Math.max(0, x - 1), xr = Math.min(w - 1, x + 1);
      const nx = (src[(yr + xl) * 4] - src[(yr + xr) * 4]) * k;
      const ny = (src[(yd + x) * 4] - src[(yu + x) * 4]) * k;
      const l = 1 / Math.hypot(nx, ny, 1);
      const o = (yr + x) * 4;
      d[o] = (nx * l * 0.5 + 0.5) * 255;
      d[o + 1] = (ny * l * 0.5 + 0.5) * 255;
      d[o + 2] = (l * 0.5 + 0.5) * 255;
      d[o + 3] = 255;
    }
  }
  c.putImageData(out, 0, 0);
}

function toTex(cv, srgb, aniso = 8) {
  const t = new THREE.CanvasTexture(cv);
  t.anisotropy = aniso;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ---------- 行先LED(ドット表示) ---------- */
function parseDest(text, kind) {
  const s = String(text || '').trim();
  const tk = s.split(/\s+/);
  if (tk.length > 1 && LABEL_KIND[tk[0]]) return { k: KINDS[LABEL_KIND[tk[0]]], label: tk[0], dest: tk.slice(1).join(' ') };
  if (s === '回送' || kind === 'none') return { k: null, label: '', dest: s };
  const k = KINDS[kind] || KINDS.local;
  return { k, label: k.label, dest: s };
}
/* できあがったドット表示の板をおぼえておく(同じ行先なら描き直さない)。
 * 以前は1枚ごとに約4500個の円を1つずつ塗り、読み戻しもしていたので起動やすれ違いで止まっていた */
const LED_CACHE = new Map();
let LED_FONTS_OK = false;
function ledPanel(W, H, cols, rows, text, kind) {
  const key = `${text}|${kind}|${cols}x${rows}`;
  const hit = LED_CACHE.get(key);
  if (hit && hit.width === W && hit.height === H) return hit;
  const { k, label, dest } = parseDest(text, kind);
  const sc = newCanvas(cols, rows), s = sc.getContext('2d', { willReadFrequently: true });
  s.fillStyle = '#000'; s.fillRect(0, 0, cols, rows);
  s.textAlign = 'center'; s.textBaseline = 'middle';
  let x0 = 0;
  const fh = Math.round(rows * 0.8);
  if (label) {
    const bw = Math.round(cols * (cols > 110 ? 0.29 : 0.36));
    s.fillStyle = k.bg; s.fillRect(0, 1, bw, rows - 2);
    s.fillStyle = k.fg; s.font = `900 ${fh}px ${FONT}`;
    s.fillText(label, bw / 2, rows / 2 + 1, bw - 3);
    x0 = bw + 3;
  }
  s.fillStyle = '#ffa526'; s.font = `700 ${fh}px ${FONT}`;
  s.fillText(dest, (x0 + cols) / 2, rows / 2 + 1, cols - x0 - 2);
  const d = s.getImageData(0, 0, cols, rows).data;
  const cv = newCanvas(W, H), c = cv.getContext('2d');
  c.fillStyle = '#040404'; c.fillRect(0, 0, W, H);
  const px = W / cols, py = H / rows, r = Math.min(px, py) * 0.43;
  /* 点灯ドットは色ごとに1本のパスにまとめ、消灯ドットも1本にまとめて、塗りは数回だけ */
  const lit = new Map(), off = new Path2D();
  const q = (v) => Math.min(255, Math.round(v / 24) * 24);   // 色の段数を減らしてまとめやすく
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const o = (j * cols + i) * 4;
      const m = Math.max(d[o], d[o + 1], d[o + 2]);
      const x = (i + 0.5) * px, y = (j + 0.5) * py;
      let p = off;
      if (m > 90) {
        const f = 255 / m;   // 点灯ドットは最大輝度にそろえる
        const col = `rgb(${q(d[o] * f)},${q(d[o + 1] * f)},${q(d[o + 2] * f)})`;
        p = lit.get(col);
        if (!p) { p = new Path2D(); lit.set(col, p); }
      }
      p.moveTo(x + r, y);
      p.arc(x, y, r, 0, 6.2832);
    }
  }
  c.fillStyle = '#17120c'; c.fill(off);
  lit.forEach((p, col) => { c.fillStyle = col; c.fill(p); });
  LED_CACHE.set(key, cv);
  return cv;
}
function drawLed(c, X, Y, W, H, cols, rows, text, kind) {
  c.drawImage(ledPanel(W, H, cols, rows, text, kind), X, Y);
}

/* =========================================================
 * TrainKit
 * ========================================================= */
export class TrainKit {
  constructor({ quality = 'high', gauge = 1.067 } = {}) {
    this.quality = QUAL[quality] ? quality : 'high';
    this.Q = QUAL[this.quality];
    this.gauge = gauge;
    this.night = false;
    this.prof = makeProfile(this.Q.prof);
    this._geo = new Map();
    this._decals = new Set();
    this._layout();
    this._buildTextures();
    this._buildMaterials();
  }

  /* ---------------- アトラスの区画 ---------------- */
  _layout() {
    const W = this.Q.atlas, H = W / 2;
    const L = { W, H };
    /* 行(上から): 中間車の側面 / 先頭車の側面 / 屋根 / 小物 */
    L.mid = { r0: 4, r1: Math.round(H * 0.375) - 4 };
    L.cab = { r0: Math.round(H * 0.375) + 4, r1: Math.round(H * 0.75) - 4 };
    L.roof = { r0: Math.round(H * 0.75) + 4, r1: Math.round(H * 0.875) - 4 };
    const m0 = Math.round(H * 0.875), m1 = H;
    const cell = (x0f, x1f) => ({ x0: Math.round(W * x0f) + 4, x1: Math.round(W * x1f) - 4, r0: m0 + 4, r1: m1 - 4 });
    L.acTop = cell(0, 0.1875);
    L.acSide = cell(0.1875, 0.375);
    L.end = cell(0.375, 0.5);
    L.steel = cell(0.5, 0.53);
    L.dark = cell(0.53, 0.56);
    L.acPlain = cell(0.56, 0.59);
    /* キャンバス座標 → UV(CanvasTextureはflipYなので v = 1 - 行/H) */
    L.uvr = (c) => ({ u0: c.x0 / W, u1: c.x1 / W, v0: 1 - c.r1 / H, v1: 1 - c.r0 / H });
    L.vSide = (st, s) => 1 - (st.r1 - (s / this.prof.sSide) * (st.r1 - st.r0)) / H;
    L.vRoof = (t) => 1 - (L.roof.r1 - (t / (2 * this.prof.sRoofHalf)) * (L.roof.r1 - L.roof.r0)) / H;
    this.L = L;
  }

  /* ---------------- テクスチャ ---------------- */
  _buildTextures() {
    const L = this.L, Q = this.Q;
    const paint = (mode, scale) => {
      const cv = newCanvas(Math.round(L.W * scale), Math.round(L.H * scale));
      /* 高さは法線へ変換するときに読み戻すので、読み戻し向けのキャンバスにする */
      const c = cv.getContext('2d', mode === 'hgt' ? { willReadFrequently: true } : undefined);
      c.setTransform(scale, 0, 0, scale, 0, 0);
      this._paintAtlas(c, mode);
      return cv;
    };
    this.T = {};
    this.T.col = toTex(paint('col', 1), true);
    this.T.orm = toTex(paint('orm', Q.orm), false);
    this.T.emi = toTex(paint('emi', 0.5), true, 4);
    if (Q.nrm) {
      const cv = paint('hgt', Q.nrm);
      heightToNormal(cv, 3.2 * Q.nrm);
      this.T.nrm = toTex(cv, false);
    }
    /* 前面 */
    const F = Q.front;
    const pf = (mode) => {
      const cv = newCanvas(F, F);
      this._paintFront(cv.getContext('2d'), mode, F);
      return cv;
    };
    this.T.fcol = toTex(pf('col'), true);
    this.T.form = toTex(pf('orm'), false);
    /* 灯火レンズ・光芒 */
    this.T.head = toTex(this._lampCanvas('head'), true, 4);
    this.T.tail = toTex(this._lampCanvas('tail'), true, 4);
    this.T.glow = toTex(this._glowCanvas(), true, 1);
  }

  _paintAtlas(c, mode) {
    const L = this.L;
    fs(c, mode, 'steel'); c.fillRect(0, 0, L.W, L.H);
    this._paintSide(c, mode, L.mid, false);
    this._paintSide(c, mode, L.cab, true);
    this._paintRoof(c, mode);
    this._paintMisc(c, mode);
  }

  /* 側面(1両ぶん: 横=車体の前後 z, 縦=断面の弧長) */
  _paintSide(c, mode, st, cab) {
    const L = this.L, pr = this.prof;
    const X = (z) => (z + HB) / BODY_LEN * L.W;
    const R = (y) => st.r1 - (pr.sOfY(y) / pr.sSide) * (st.r1 - st.r0);
    const pxm = L.W / BODY_LEN, pym = (st.r1 - st.r0) / pr.sSide;
    const shape = (z0, z1, y0, y1, rad = 0) => rr(c, X(z0), R(y1), X(z1) - X(z0), R(y0) - R(y1), rad * pxm, rad * pym);
    const rect = (z0, z1, y0, y1, key, rad = 0) => { fs(c, mode, key); shape(z0, z1, y0, y1, rad); c.fill(); };
    const R0 = rng(cab ? 77 : 33);

    /* 地肌 */
    fs(c, mode, 'steel'); c.fillRect(0, st.r0 - 4, L.W, st.r1 - st.r0 + 8);
    grain(c, mode, 0, st.r0, L.W, st.r1 - st.r0, cab ? 11 : 7);
    /* 屋根肩(上の方)はほんの少し暗く: AOと色 */
    if (mode === 'col' || mode === 'orm') {
      const g = c.createLinearGradient(0, R(3.5), 0, R(3.05));
      g.addColorStop(0, mode === 'col' ? 'rgba(60,66,72,0.28)' : 'rgba(150,90,200,0.5)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g; c.fillRect(0, st.r0 - 4, L.W, R(3.05) - st.r0 + 4);
    }
    /* 裾: 台枠の縁(暗い線)とビード */
    rect(-HB - 1, HB + 1, 0.99, 1.035, 'frame');
    if (mode === 'col') { c.fillStyle = 'rgba(255,255,255,0.22)'; c.fillRect(0, R(1.305), L.W, 1.2); c.fillStyle = 'rgba(30,36,40,0.25)'; c.fillRect(0, R(1.29), L.W, 1.2); }
    if (mode === 'hgt') { c.fillStyle = 'rgb(140,140,140)'; c.fillRect(0, R(1.31), L.W, Math.max(1, R(1.29) - R(1.31))); }

    /* 扉の戸袋(扉板) */
    const doors = DOOR_Z.map((zc) => [zc - DOOR_HW, zc + DOOR_HW]);
    doors.forEach(([a, b]) => rect(a, b, Y_FLOOR, Y_DOOR1, 'door'));
    if (cab) rect(CREW_DOOR[0], CREW_DOOR[1], Y_FLOOR + 0.03, 3.02, 'door');

    /* 帯(扉にもかかる)。高さマップには影響させない */
    if (mode !== 'hgt') {
      const zEnd = cab ? CAB_Z + 0.2 : HB + 1;
      rect(-HB - 1, zEnd, Y_PIN0, Y_PIN1, 'pin');
      rect(-HB - 1, zEnd, Y_BAND0, Y_BAND1, 'band');
      if (mode === 'col') {
        /* 帯の上下に細いハイライト(フィルムの縁) */
        c.fillStyle = 'rgba(255,255,255,0.18)';
        c.fillRect(0, R(Y_BAND1), L.W, 1); c.fillRect(0, R(Y_PIN1), L.W, 1);
      }
    }
    /* スポット溶接の列(ごく薄く) */
    if (mode === 'col') {
      c.fillStyle = 'rgba(60,66,72,0.16)';
      for (let z = -HB; z < HB; z += 0.03) { c.fillRect(X(z), R(3.04), 1.2, 1.2); c.fillRect(X(z), R(1.765), 1.2, 1.2); }
    }

    /* 窓 */
    const win = (z0, z1, y0, y1, people = true, rad = 0.06, dark = false) => {
      rect(z0 - 0.028, z1 + 0.028, y0 - 0.028, y1 + 0.028, 'frame', rad + 0.02);
      if (mode === 'emi') {
        if (dark) return;
        this._paintInterior(c, X(z0), R(y1), X(z1) - X(z0), R(y0) - R(y1), R0, people, pxm);
        return;
      }
      rect(z0, z1, y0, y1, 'glass', rad);
      if (mode === 'col') {
        /* 向こう側の窓が透けて見える明るさと、座席の背もたれ */
        c.save(); shape(z0, z1, y0, y1, rad); c.clip();
        const top = R(y1), bot = R(y0), h = bot - top;
        const g = c.createLinearGradient(0, top, 0, bot);
        g.addColorStop(0, 'rgba(46,58,68,0.9)'); g.addColorStop(0.12, 'rgba(20,27,33,0.6)');
        g.addColorStop(0.45, 'rgba(44,58,70,0.75)'); g.addColorStop(0.72, 'rgba(26,34,41,0.6)');
        g.addColorStop(1, 'rgba(8,11,14,0.9)');
        c.fillStyle = g; c.fillRect(X(z0), top, X(z1) - X(z0), h);
        /* 網棚の線 */
        c.fillStyle = 'rgba(80,90,98,0.35)'; c.fillRect(X(z0), top + h * 0.1, X(z1) - X(z0), Math.max(1, h * 0.02));
        c.restore();
      }
    };
    SIDE_WINS.forEach(([a, b]) => win(a, b, Y_WIN0, Y_WIN1));
    /* 妻側の小窓(-z側は上にLED) */
    win(-END_WIN[1], -END_WIN[0], Y_WIN0, 2.60, false);
    rect(LED_SIDE.z0 - 0.04, LED_SIDE.z1 + 0.04, LED_SIDE.y0 - 0.035, LED_SIDE.y1 + 0.035, 'black', 0.02);
    if (!cab) win(END_WIN[0], END_WIN[1], Y_WIN0, Y_WIN1, false);
    /* 扉の窓・すき間 */
    doors.forEach(([a, b]) => {
      const zc = (a + b) / 2;
      win(a + 0.09, zc - 0.10, 2.02, 2.86, true, 0.05);
      win(zc + 0.10, b - 0.09, 2.02, 2.86, true, 0.05);
      if (mode !== 'emi') {
        fs(c, mode, 'gap');
        const lw = Math.max(1.5, 0.014 * pxm);
        c.fillRect(X(a) - lw, R(Y_DOOR1) - lw, X(b) - X(a) + lw * 2, lw);            // 上
        c.fillRect(X(a) - lw, R(Y_DOOR1) - lw, lw, R(Y_FLOOR) - R(Y_DOOR1) + lw);   // 左
        c.fillRect(X(b), R(Y_DOOR1) - lw, lw, R(Y_FLOOR) - R(Y_DOOR1) + lw);        // 右
        c.fillRect(X(zc) - lw * 0.7, R(Y_DOOR1), lw * 1.4, R(Y_FLOOR) - R(Y_DOOR1)); // 戸当たりゴム
        /* 靴ずり(床の高さ) */
        rect(a - 0.02, b + 0.02, 1.0, Y_FLOOR, 'frame');
        if (mode === 'col') { c.fillStyle = 'rgba(210,214,218,0.6)'; c.fillRect(X(a), R(Y_FLOOR) - 1, X(b) - X(a), 1.5); }
      }
    });
    /* 先頭車: 乗務員扉と手すり */
    if (cab) {
      const [a, b] = CREW_DOOR;
      win(a + 0.10, b - 0.10, 2.10, 2.82, false, 0.05, true);
      if (mode !== 'emi') {
        fs(c, mode, 'gap');
        const lw = Math.max(1.5, 0.014 * pxm);
        c.fillRect(X(a) - lw, R(3.02) - lw, X(b) - X(a) + lw * 2, lw);
        c.fillRect(X(a) - lw, R(3.02) - lw, lw, R(Y_FLOOR + 0.03) - R(3.02) + lw);
        c.fillRect(X(b), R(3.02) - lw, lw, R(Y_FLOOR + 0.03) - R(3.02) + lw);
        rect(a - 0.10, a - 0.07, 1.55, 2.55, 'frame', 0.01);   // 手すり
        rect(b + 0.07, b + 0.10, 1.55, 2.55, 'frame', 0.01);
      }
    }
    /* 車側灯(扉が開くと点く小さなランプ) */
    if (mode !== 'emi') {
      [-9.40, cab ? null : 9.40].forEach((z) => { if (z !== null) { rect(z - 0.07, z + 0.07, 3.025, 3.075, 'black', 0.01); rect(z - 0.055, z + 0.055, 3.032, 3.068, 'lamp', 0.01); } });
    }
  }

  /* 夜の窓: 天井灯で明るく、人のシルエット */
  _paintInterior(c, x, y, w, h, R, people, pxm) {
    /* LEDの天井灯(ほぼ白) → 向かいの窓(暗め) → 座席の背もたれ */
    const g = c.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, '#ffffff'); g.addColorStop(0.1, '#fbf7ee'); g.addColorStop(0.18, '#d9d3c8');
    g.addColorStop(0.3, '#a49d92'); g.addColorStop(0.62, '#8e877c'); g.addColorStop(0.74, '#cfc7b8');
    g.addColorStop(1, '#7d7468');
    c.fillStyle = g; c.fillRect(x, y, w, h);
    /* 網棚の影 */
    c.fillStyle = 'rgba(90,84,76,0.6)'; c.fillRect(x, y + h * 0.11, w, Math.max(1, h * 0.025));
    if (!people) return;
    c.save();
    c.beginPath(); c.rect(x, y, w, h); c.clip();
    const n = Math.floor(R() * 3.4);
    for (let i = 0; i < n; i++) {
      const stand = R() < 0.35;
      const s = (stand ? 0.85 : 1.0) * pxm;            // 立っている人は奥=少し小さい
      const px = x + (0.12 + R() * 0.76) * w;
      const hy = y + h * (stand ? 0.2 + R() * 0.12 : 0.6 + R() * 0.1);   // 頭の中心
      const a = stand ? 0.45 : 0.7;
      const shade = 40 + R() * 25 | 0;
      c.fillStyle = `rgba(${shade},${shade - 4},${shade - 8},${a})`;
      /* 頭・首・肩(角の丸い台形) */
      c.beginPath(); c.ellipse(px, hy, 0.085 * s, 0.105 * s, 0, 0, 6.2832); c.fill();
      c.fillRect(px - 0.04 * s, hy + 0.06 * s, 0.08 * s, 0.08 * s);
      const sw = (0.2 + R() * 0.05) * s, top = hy + 0.13 * s;
      c.beginPath();
      c.moveTo(px - sw * 0.75, top); c.quadraticCurveTo(px - sw, top, px - sw, top + 0.08 * s);
      c.lineTo(px - sw * 1.02, top + 0.6 * s); c.lineTo(px + sw * 1.02, top + 0.6 * s);
      c.lineTo(px + sw, top + 0.08 * s); c.quadraticCurveTo(px + sw, top, px + sw * 0.75, top);
      c.closePath(); c.fill();
    }
    c.restore();
  }

  /* 屋根(横=z, 縦=右の肩→左の肩) */
  _paintRoof(c, mode) {
    const L = this.L, pr = this.prof, st = L.roof;
    const half = pr.sRoofHalf;
    const Rt = (t) => st.r1 - t / (2 * half) * (st.r1 - st.r0);
    const pym = (st.r1 - st.r0) / (2 * half);
    fs(c, mode, 'roof'); c.fillRect(0, st.r0 - 4, L.W, st.r1 - st.r0 + 8);
    const R = rng(5);
    /* 波板(長手方向のリブ) */
    for (let t = 0.06; t < 2 * half; t += 0.085) {
      if (Math.abs(t - half) < 0.3) continue;
      if (mode === 'col') { c.fillStyle = 'rgba(255,255,255,0.08)'; c.fillRect(0, Rt(t), L.W, 1); c.fillStyle = 'rgba(0,0,0,0.1)'; c.fillRect(0, Rt(t) + 1.5, L.W, 1); }
      if (mode === 'hgt') { c.fillStyle = 'rgb(150,150,150)'; c.fillRect(0, Rt(t) - 0.6, L.W, 1.6); }
    }
    /* 歩み板(中央) */
    fs(c, mode, 'walk'); c.fillRect(0, Rt(half + 0.26), L.W, Rt(half - 0.26) - Rt(half + 0.26));
    if (mode === 'col' || mode === 'hgt') {
      c.fillStyle = mode === 'col' ? 'rgba(60,64,68,0.35)' : 'rgb(118,118,118)';
      const step = 0.05 * L.W / BODY_LEN;
      for (let x = 0; x < L.W; x += step) c.fillRect(x, Rt(half + 0.26), Math.max(1, step * 0.3), Rt(half - 0.26) - Rt(half + 0.26));
    }
    /* 汚れ(肩の方ほど茶色っぽく) */
    if (mode === 'col') {
      [[0, 0.5], [2 * half, 2 * half - 0.5]].forEach(([a, b]) => {
        const g = c.createLinearGradient(0, Rt(a), 0, Rt(b));
        g.addColorStop(0, 'rgba(80,70,60,0.45)'); g.addColorStop(1, 'rgba(80,70,60,0)');
        c.fillStyle = g; c.fillRect(0, Math.min(Rt(a), Rt(b)), L.W, Math.abs(Rt(b) - Rt(a)));
      });
      for (let i = 0; i < 160; i++) {
        c.fillStyle = `rgba(${70 + R() * 30 | 0},${62 + R() * 20 | 0},${55 + R() * 15 | 0},${0.05 + R() * 0.08})`;
        c.fillRect(R() * L.W, st.r0 + R() * (st.r1 - st.r0), 30 + R() * 300, 1 + R() * 3 * pym * 0.02);
      }
    }
    /* 車体の継ぎ目(横方向の細い線) */
    if (mode !== 'emi') {
      for (let z = -HB + 1.2; z < HB; z += 2.4) {
        if (mode === 'col') { c.fillStyle = 'rgba(40,44,48,0.35)'; c.fillRect((z + HB) / BODY_LEN * L.W, st.r0, 1.5, st.r1 - st.r0); }
        if (mode === 'hgt') { c.fillStyle = 'rgb(112,112,112)'; c.fillRect((z + HB) / BODY_LEN * L.W, st.r0, 1.5, st.r1 - st.r0); }
      }
    }
  }

  /* 小物(冷房装置の上面・側面、妻面、無地) */
  _paintMisc(c, mode) {
    const L = this.L;
    /* 冷房装置 上面: 横=z(2.5m) 縦=x(1.68m) */
    {
      const C = L.acTop, w = C.x1 - C.x0, h = C.r1 - C.r0;
      fs(c, mode, 'acbody'); c.fillRect(C.x0 - 4, C.r0 - 4, w + 8, h + 8);
      grain(c, mode, C.x0, C.r0, w, h, 21, 0.4);
      const sx = w / 2.5, sy = h / 1.68;
      /* 点検ふたの継ぎ目 */
      if (mode === 'col' || mode === 'hgt') {
        c.fillStyle = mode === 'col' ? 'rgba(40,44,48,0.5)' : 'rgb(96,96,96)';
        [0.34, 0.66].forEach((f) => c.fillRect(C.x0 + w * f, C.r0, 1.5, h));
        c.fillRect(C.x0, C.r0 + h * 0.08, w, 1.2); c.fillRect(C.x0, C.r0 + h * 0.92, w, 1.2);
      }
      /* 送風機の丸いグリル×2 */
      [-0.62, 0.62].forEach((zl) => {
        const cx = C.x0 + (zl + 1.25) * sx, cy = C.r0 + h / 2;
        fs(c, mode, 'grille');
        c.beginPath(); c.ellipse(cx, cy, 0.33 * sx, 0.33 * sy, 0, 0, 6.2832); c.fill();
        if (mode === 'col' || mode === 'hgt') {
          c.strokeStyle = mode === 'col' ? 'rgba(120,126,131,0.8)' : 'rgb(140,140,140)';
          c.lineWidth = Math.max(1, 0.012 * sx);
          for (let r = 0.06; r < 0.33; r += 0.045) { c.beginPath(); c.ellipse(cx, cy, r * sx, r * sy, 0, 0, 6.2832); c.stroke(); }
          for (let a = 0; a < 4; a++) {
            const an = a * Math.PI / 4;
            c.beginPath(); c.moveTo(cx - Math.cos(an) * 0.33 * sx, cy - Math.sin(an) * 0.33 * sy); c.lineTo(cx + Math.cos(an) * 0.33 * sx, cy + Math.sin(an) * 0.33 * sy); c.stroke();
          }
          c.fillStyle = mode === 'col' ? '#5a6066' : 'rgb(140,140,140)';
          c.beginPath(); c.ellipse(cx, cy, 0.06 * sx, 0.06 * sy, 0, 0, 6.2832); c.fill();
        }
      });
    }
    /* 冷房装置 側面: よろい戸 */
    {
      const C = L.acSide, w = C.x1 - C.x0, h = C.r1 - C.r0;
      fs(c, mode, 'acbody'); c.fillRect(C.x0 - 4, C.r0 - 4, w + 8, h + 8);
      grain(c, mode, C.x0, C.r0, w, h, 23, 0.4);
      if (mode === 'col' || mode === 'hgt' || mode === 'orm') {
        [[0.08, 0.46], [0.54, 0.92]].forEach(([f0, f1]) => {
          fs(c, mode, 'grille'); c.fillRect(C.x0 + w * f0, C.r0 + h * 0.18, w * (f1 - f0), h * 0.6);
          if (mode !== 'orm') {
            c.fillStyle = mode === 'col' ? 'rgba(135,141,146,0.9)' : 'rgb(146,146,146)';
            for (let y = C.r0 + h * 0.2; y < C.r0 + h * 0.76; y += Math.max(3, h * 0.06)) c.fillRect(C.x0 + w * f0, y, w * (f1 - f0), Math.max(1.5, h * 0.025));
          }
        });
      }
    }
    /* 妻面(連結側の端): 横=x(-1.5..1.5) 縦=y(0.95..3.7) */
    {
      const C = L.end, w = C.x1 - C.x0, h = C.r1 - C.r0;
      const X = (x) => C.x0 + (x + 1.5) / 3 * w, Y = (y) => C.r0 + (1 - (y - 0.95) / 2.75) * h;
      fs(c, mode, 'steel'); c.fillRect(C.x0 - 4, C.r0 - 4, w + 8, h + 8);
      grain(c, mode, C.x0, C.r0, w, h, 29, 0.4);
      fs(c, mode, 'door'); c.fillRect(X(-0.45), Y(3.05), X(0.45) - X(-0.45), Y(1.13) - Y(3.05));
      fs(c, mode, 'frame'); c.fillRect(X(-0.22), Y(2.86), X(0.22) - X(-0.22), Y(2.18) - Y(2.86));
      fs(c, mode, 'glass'); c.fillRect(X(-0.19), Y(2.83), X(0.19) - X(-0.19), Y(2.21) - Y(2.83));
      fs(c, mode, 'roof'); c.fillRect(C.x0 - 4, C.r0 - 4, w + 8, Y(3.5) - C.r0 + 4);
      fs(c, mode, 'frame'); c.fillRect(C.x0 - 4, Y(1.08), w + 8, C.r1 - Y(1.08) + 4);
      if (mode !== 'emi') { fs(c, mode, 'gap'); [-1.3, 1.3].forEach((x) => c.fillRect(X(x), Y(3.3), 1.5, Y(1.1) - Y(3.3))); }
    }
    /* 無地(雨樋など) */
    fs(c, mode, 'steel'); c.fillRect(L.steel.x0 - 4, L.steel.r0 - 4, L.steel.x1 - L.steel.x0 + 8, L.steel.r1 - L.steel.r0 + 8);
    fs(c, mode, 'black'); c.fillRect(L.dark.x0 - 4, L.dark.r0 - 4, L.dark.x1 - L.dark.x0 + 8, L.dark.r1 - L.dark.r0 + 8);
    fs(c, mode, 'acbody'); c.fillRect(L.acPlain.x0 - 4, L.acPlain.r0 - 4, L.acPlain.x1 - L.acPlain.x0 + 8, L.acPlain.r1 - L.acPlain.r0 + 8);
  }

  /* 前面(平行投影: 横=x -1.5..1.5, 縦=y 0.95..3.70) */
  _paintFront(c, mode, S) {
    const X = (x) => (x + 1.5) / 3 * S, Y = (y) => (1 - (y - 0.95) / 2.75) * S;
    const pm = S / 3;  // px/m(横)
    const pmy = S / 2.75;
    const rect = (x0, x1, y0, y1, key, rad = 0) => { fs(c, mode, key); rr(c, X(x0), Y(y1), X(x1) - X(x0), Y(y0) - Y(y1), rad * pm, rad * pmy); c.fill(); };
    fs(c, mode, 'steel'); c.fillRect(0, 0, S, S);
    grain(c, mode, 0, 0, S, S, 41, 1.5);
    /* 屋根へのつながり(上の方は屋根色) */
    rect(-2, 2, 3.50, 3.8, 'roof');
    if (mode === 'col') {
      const g = c.createLinearGradient(0, Y(3.5), 0, Y(3.38));
      g.addColorStop(0, 'rgba(70,76,82,0.5)'); g.addColorStop(1, 'rgba(70,76,82,0)');
      c.fillStyle = g; c.fillRect(0, Y(3.5), S, Y(3.38) - Y(3.5));
    }
    /* 側面から回り込む帯 */
    if (mode !== 'hgt') {
      rect(-2, 2, Y_PIN0, Y_PIN1, 'pin');
      rect(-2, 2, Y_BAND0, Y_BAND1, 'band');
    }
    /* 空色の縁どり + 黒いマスク(ガラス・行先・前照灯の上まで) */
    rect(-MASK.x - 0.05, MASK.x + 0.05, MASK.y0 - 0.05, MASK.y1 + 0.05, 'band', 0.2);
    rect(-MASK.x, MASK.x, MASK.y0, MASK.y1, 'black', 0.16);
    /* 窓ガラス */
    rect(-1.12, 1.12, 2.03, 2.97, 'fglass', 0.09);
    if (mode === 'col') {
      c.save(); rr(c, X(-1.12), Y(2.97), X(1.12) - X(-1.12), Y(2.03) - Y(2.97), 0.09 * pm, 0.09 * pmy); c.clip();
      const g = c.createLinearGradient(0, Y(2.97), 0, Y(2.03));
      g.addColorStop(0, 'rgba(40,52,62,0.8)'); g.addColorStop(0.5, 'rgba(18,24,30,0.3)'); g.addColorStop(1, 'rgba(4,6,8,0.9)');
      c.fillStyle = g; c.fillRect(0, Y(2.97), S, Y(2.03) - Y(2.97));
      /* 運転台の机(下辺の黒い影)と運転士側の計器 */
      c.fillStyle = 'rgba(0,0,0,0.75)'; c.fillRect(0, Y(2.17), S, Y(2.03) - Y(2.17));
      c.fillStyle = 'rgba(60,70,78,0.5)'; c.fillRect(X(0.25), Y(2.2), X(0.95) - X(0.25), Y(2.17) - Y(2.2));
      c.restore();
    }
    /* 行先表示の枠 */
    rect(-0.70, 0.70, 2.99, 3.24, 'led', 0.025);
    /* 灯具ケース */
    [-1, 1].forEach((sd) => {
      const a = sd < 0 ? -1.22 : 0.74, b = sd < 0 ? -0.74 : 1.22;
      rect(a, b, 1.30, 1.64, 'black', 0.07);
    });
    /* 番号板の下地(少し暗い) */
    rect(-0.25, 0.25, 1.37, 1.57, 'frame', 0.02);
    /* 前面下部の継ぎ目 */
    if (mode === 'col' || mode === 'hgt') {
      c.fillStyle = mode === 'col' ? 'rgba(50,56,60,0.45)' : 'rgb(100,100,100)';
      c.fillRect(0, Y(1.20), S, 1.5);
    }
  }

  _lampCanvas(kind) {
    const cv = newCanvas(128, 64), c = cv.getContext('2d');
    if (kind === 'head') {
      c.fillStyle = '#1a1d20'; rr(c, 0, 0, 128, 64, 14); c.fill();
      for (let j = 0; j < 2; j++) {
        for (let i = 0; i < 5; i++) {
          const x = 16 + i * 24, y = 18 + j * 28;
          const g = c.createRadialGradient(x, y, 1, x, y, 10);
          g.addColorStop(0, '#ffffff'); g.addColorStop(0.6, '#dfe6ec'); g.addColorStop(1, '#6d757c');
          c.fillStyle = g; c.beginPath(); c.arc(x, y, 9.5, 0, 6.2832); c.fill();
        }
      }
    } else {
      c.fillStyle = '#2a0706'; rr(c, 0, 0, 128, 64, 20); c.fill();
      for (let i = 0; i < 6; i++) {
        const x = 12 + i * 20.8, y = 32;
        const g = c.createRadialGradient(x, y, 1, x, y, 12);
        g.addColorStop(0, '#ff6a50'); g.addColorStop(0.7, '#e3200f'); g.addColorStop(1, '#5a0a06');
        c.fillStyle = g; c.beginPath(); c.arc(x, y, 10, 0, 6.2832); c.fill();
      }
    }
    return cv;
  }

  _glowCanvas() {
    const cv = newCanvas(128, 128), c = cv.getContext('2d');
    const g = c.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.08, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.25, 'rgba(255,255,255,0.28)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.07)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g; c.fillRect(0, 0, 128, 128);
    return cv;
  }

  /* ---------------- 材質 ---------------- */
  _buildMaterials() {
    const T = this.T;
    const body = new THREE.MeshStandardMaterial({
      map: T.col, roughnessMap: T.orm, metalnessMap: T.orm, aoMap: T.orm, aoMapIntensity: 1,
      roughness: 1, metalness: 1,
      emissiveMap: T.emi, emissive: 0xfff1e0, emissiveIntensity: 0.05,
    });
    if (T.nrm) { body.normalMap = T.nrm; body.normalScale = new THREE.Vector2(0.9, 0.9); }
    const front = new THREE.MeshStandardMaterial({
      map: T.fcol, roughnessMap: T.form, metalnessMap: T.form, aoMap: T.form,
      roughness: 1, metalness: 1,
    });
    const dark = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.35 });
    const lens = (map, emissive) => new THREE.MeshStandardMaterial({
      map, emissiveMap: emissive ? map : null, emissive: emissive || 0x000000, emissiveIntensity: 1,
      roughness: 0.12, metalness: 0.1,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    /* 光芒: 灯具の中心から画面に向けて広げるビルボード。
     * 正面から見るほど明るく、横・後ろからは消える(大きさ・濃さは昼夜でuniformを切替) */
    const halo = (col) => new THREE.ShaderMaterial({
      uniforms: { uMap: { value: T.glow }, uColor: { value: col }, uOpacity: { value: 0.3 }, uSize: { value: 1.0 } },
      vertexShader: `uniform float uSize; varying vec2 vUv; varying float vFace;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vec3 toCam = normalize(-mv.xyz);
          vFace = dot(normalize(normalMatrix * normal), toCam);
          mv.xyz += toCam * 0.4;            // 車体にめり込まないよう少し手前へ
          mv.xy += (uv - 0.5) * uSize;
          vUv = uv;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `uniform sampler2D uMap; uniform vec3 uColor; uniform float uOpacity; varying vec2 vUv; varying float vFace;
        void main() {
          float a = texture2D(uMap, vUv).a * uOpacity * smoothstep(0.05, 0.6, vFace);
          gl_FragColor = vec4(uColor * a, 1.0);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.M = {
      body, front, dark,
      headOn: lens(T.head, 0xfff6e8), headOff: lens(T.head, null),
      tailOn: lens(T.tail, 0xff2a14), tailOff: lens(T.tail, null),
      haloHead: halo(new THREE.Color(1.0, 0.96, 0.88)),
      haloTail: halo(new THREE.Color(1.0, 0.12, 0.06)),
    };
    this.setNight(false);
  }

  /* ---------------- 前頭部の形 ---------------- */
  _faceZ(x, y) {
    const xm = this.prof.xAt(y);
    return CAB_Z + noseDepth(y) * se(xm > 1e-4 ? x / xm : 0);
  }
  _facePoint(x, y) { return new THREE.Vector3(x, y, this._faceZ(x, y)); }
  _faceNormal(x, y) {
    const e = 0.01;
    const px = new THREE.Vector3(2 * e, 0, this._faceZ(x + e, y) - this._faceZ(x - e, y));
    const py = new THREE.Vector3(0, 2 * e, this._faceZ(x, y + e) - this._faceZ(x, y - e));
    return new THREE.Vector3().crossVectors(px, py).normalize();
  }
  /* 前面に沿う四角(表記・レンズ用) */
  _faceQuad(acc, x0, x1, y0, y1, off, cols, uvr = { u0: 0, u1: 1, v0: 0, v1: 1 }) {
    const base = acc.k;
    for (let j = 0; j <= 1; j++) {
      for (let i = 0; i <= cols; i++) {
        const x = x0 + (x1 - x0) * i / cols, y = j ? y1 : y0;
        const p = this._facePoint(x, y), n = this._faceNormal(x, y);
        p.addScaledVector(n, off);
        acc.v(p.x, p.y, p.z, n.x, n.y, n.z, uvr.u0 + (uvr.u1 - uvr.u0) * i / cols, j ? uvr.v1 : uvr.v0);
      }
    }
    for (let i = 0; i < cols; i++) {
      const a = base + i, b = a + 1, d = base + cols + 1 + i, c2 = d + 1;
      acc.tri(a, b, c2); acc.tri(a, c2, d);
    }
  }
  /* 光芒の四角: 4頂点とも灯具の中心に置き、シェーダで画面向きに広げる(法線=灯具の向き) */
  _haloQuad(acc, x, y, off) {
    const c = this._facePoint(x, y), n = this._faceNormal(x, y);
    c.addScaledVector(n, off);
    const base = acc.k;
    [[0, 0], [1, 0], [1, 1], [0, 1]].forEach(([uu, vv]) => acc.v(c.x, c.y, c.z, n.x, n.y, n.z, uu, vv));
    acc.tri(base, base + 1, base + 2); acc.tri(base, base + 2, base + 3);
  }

  /* ---------------- 共有ジオメトリ ---------------- */
  _cached(key, fn) {
    if (!this._geo.has(key)) this._geo.set(key, fn());
    return this._geo.get(key);
  }

  /* 車体(掃引した断面+妻面+雨樋+冷房装置) */
  _bodyGeo(front, rear) {
    return this._cached(`body${+front}${+rear}`, () => {
      const pr = this.prof, L = this.L, acc = new Acc();
      const z0 = rear ? -CAB_Z : -HB, z1 = front ? CAB_Z : HB;
      const mz = (z) => (front && rear ? Math.abs(z) : rear ? -z : z);
      const zs = front && rear ? [z0, 0, z1] : [z0, z1];
      const st = front || rear ? L.cab : L.mid;
      const U = (z) => (mz(z) + HB) / BODY_LEN;
      const { P, N, s, n, roofStart: rs } = pr;
      const right = [], roof = [], left = [];
      for (let i = 0; i <= rs; i++) right.push({ x: P[i][0], y: P[i][1], nx: N[i][0], ny: N[i][1], v: L.vSide(st, s[i]) });
      for (let i = rs; i < n; i++) roof.push({ x: P[i][0], y: P[i][1], nx: N[i][0], ny: N[i][1], v: L.vRoof(s[i] - s[rs]) });
      for (let i = n - 2; i >= rs; i--) roof.push({ x: -P[i][0], y: P[i][1], nx: -N[i][0], ny: N[i][1], v: L.vRoof(2 * pr.sRoofHalf - (s[i] - s[rs])) });
      for (let i = rs; i >= 0; i--) left.push({ x: -P[i][0], y: P[i][1], nx: -N[i][0], ny: N[i][1], v: L.vSide(st, s[i]) });
      [right, roof, left].forEach((pts) => {
        const base = acc.k, K = pts.length;
        zs.forEach((z) => { const u = U(z); pts.forEach((p) => acc.v(p.x, p.y, z, p.nx, p.ny, 0, u, p.v)); });
        for (let r = 0; r < zs.length - 1; r++) {
          for (let k = 0; k < K - 1; k++) {
            const a0 = base + r * K + k, b0 = a0 + 1, a1 = a0 + K, b1 = a1 + 1;
            acc.tri(a0, b0, b1); acc.tri(a0, b1, a1);
          }
        }
      });
      /* 妻面(連結側) */
      const outline = [];
      for (let i = 0; i < n; i++) outline.push(P[i]);
      for (let i = n - 2; i >= 0; i--) outline.push([-P[i][0], P[i][1]]);
      const E = L.uvr(L.end);
      const cap = (z, dir) => {
        const c0 = acc.v(0, 2.3, z, 0, 0, dir, E.u0 + 0.5 * (E.u1 - E.u0), E.v0 + (2.3 - 0.95) / 2.75 * (E.v1 - E.v0));
        const ids = outline.map(([x, y]) => acc.v(x, y, z, 0, 0, dir,
          E.u0 + (x + 1.5) / 3 * (E.u1 - E.u0), E.v0 + (y - 0.95) / 2.75 * (E.v1 - E.v0)));
        for (let k = 0; k < ids.length; k++) {
          const a = ids[k], b = ids[(k + 1) % ids.length];
          if (dir > 0) acc.tri(c0, a, b); else acc.tri(c0, b, a);
        }
      };
      if (!front) cap(z1, 1);
      if (!rear) cap(z0, -1);
      /* 雨樋(肩の細いでっぱり) */
      const S = L.uvr(L.steel);
      const yg = 3.24, xg = pr.xAt(yg);
      [1, -1].forEach((sd) => {
        const poly = [[xg - 0.01, yg - 0.025], [xg + 0.022, yg - 0.025], [xg + 0.026, yg + 0.02], [xg - 0.01, yg + 0.03]];
        this._sweepFlat(acc, poly.map(([x, y]) => [x * sd, y]), z0 + 0.03, z1 - 0.03, () => S, sd < 0);
      });
      /* 冷房装置×2 */
      const AT = L.uvr(L.acTop), AS = L.uvr(L.acSide), AP = L.uvr(L.acPlain);
      [-3.7, 3.7].forEach((zc) => {
        const poly = [[0.95, 3.555], [0.95, 3.80], [0.915, 3.885], [0.83, 3.94], [-0.83, 3.94], [-0.915, 3.885], [-0.95, 3.80], [-0.95, 3.555]];
        this._sweepFlat(acc, poly, zc - 1.25, zc + 1.25, (e) => (e === 3 ? AT : e === 0 || e === 6 ? AS : AP), false);
        [[zc + 1.25, 1], [zc - 1.25, -1]].forEach(([z, dir]) => {
          const c0 = acc.v(0, 3.8, z, 0, 0, dir, AS.u0 + 0.5 * (AS.u1 - AS.u0), AS.v0 + 0.5 * (AS.v1 - AS.v0));
          const ids = poly.map(([x, y]) => acc.v(x, y, z, 0, 0, dir, AS.u0 + (x + 0.95) / 1.9 * (AS.u1 - AS.u0), AS.v0 + (y - 3.555) / 0.385 * (AS.v1 - AS.v0)));
          for (let k = 0; k < ids.length; k++) {
            const a = ids[k], b = ids[(k + 1) % ids.length];
            if (dir > 0) acc.tri(c0, a, b); else acc.tri(c0, b, a);
          }
        });
      });
      return acc.geometry(false);
    });
  }

  /* 角の立った断面を前後に伸ばす(辺ごとに法線を分ける)。uvOf(辺番号)で区画を選ぶ */
  _sweepFlat(acc, poly, za, zb, uvOf, reverse) {
    const pts = reverse ? poly.slice().reverse() : poly;
    for (let e = 0; e < pts.length - 1; e++) {
      const [x0, y0] = pts[e], [x1, y1] = pts[e + 1];
      const dx = x1 - x0, dy = y1 - y0, l = Math.hypot(dx, dy) || 1;
      const nx = dy / l, ny = -dx / l;
      const R = uvOf(reverse ? pts.length - 2 - e : e);
      const a0 = acc.v(x0, y0, za, nx, ny, 0, R.u0, R.v0);
      const b0 = acc.v(x1, y1, za, nx, ny, 0, R.u0, R.v1);
      const b1 = acc.v(x1, y1, zb, nx, ny, 0, R.u1, R.v1);
      const a1 = acc.v(x0, y0, zb, nx, ny, 0, R.u1, R.v0);
      acc.tri(a0, b0, b1); acc.tri(a0, b1, a1);
    }
  }

  /* 前頭部(断面の輪郭から前へふくらむ格子) */
  _faceGeo(front, rear) {
    return this._cached(`face${+front}${+rear}`, () => {
      const pr = this.prof, C = this.Q.faceCols;
      const pos = [], uv = [], idx = [];
      for (let k = 0; k < pr.n; k++) {
        const [xk, yk] = pr.P[k];
        for (let j = 0; j <= C; j++) {
          const t = Math.sin(-Math.PI / 2 + Math.PI * j / C);   // 端ほど細かく
          const x = t * xk;
          pos.push(x, yk, CAB_Z + noseDepth(yk) * se(t));
          uv.push((x + 1.5) / 3, (yk - 0.95) / 2.75);
        }
      }
      for (let k = 0; k < pr.n - 1; k++) {
        for (let j = 0; j < C; j++) {
          const a = k * (C + 1) + j, b = a + 1, d = a + C + 1, c2 = d + 1;
          idx.push(a, b, c2, a, c2, d);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      /* 側面との継ぎ目は車体と同じ法線にそろえる */
      const nr = g.attributes.normal;
      for (let k = 0; k < pr.n; k++) {
        nr.setXYZ(k * (C + 1), -pr.N[k][0], pr.N[k][1], 0);
        nr.setXYZ(k * (C + 1) + C, pr.N[k][0], pr.N[k][1], 0);
      }
      const acc = new Acc();
      if (front) acc.add(g);
      if (rear) acc.add(g, ROT_PI);
      g.dispose();
      return acc.geometry(false);
    });
  }

  /* 床下・台車・連結器・幌・スカート・パンタグラフ(頂点色の暗い材質) */
  _underGeo(front, rear, motor, panto) {
    return this._cached(`under${+front}${+rear}${+motor}${+panto}`, () => {
      const acc = new Acc(), Q = this.Q, G = this.gauge;
      const R = rng(1000 + (+front) * 1 + (+rear) * 2 + (+motor) * 4 + (+panto) * 8);
      const col = {
        floor: lin(0x26292c), frame: lin(0x2b2e31), bogie: lin(0x303336), wheel: lin(0x3a3634),
        axle: lin(0x3c3a38), spring: lin(0x2c2e30), rubber: lin(0x161718), box: [lin(0x3a3e42), lin(0x45494e), lin(0x323639), lin(0x50555a)],
        tank: lin(0x5a5f64), skirt: lin(0x63696e), coupler: lin(0x2c2f32), panto: lin(0x737a80),
        pantoDark: lin(0x3e4347), insul: lin(0xd9d5c9), shoe: lin(0x2d2f31), pipe: lin(0x7a8086),
      };
      const z0 = rear ? -CAB_Z : -HB, z1 = front ? CAB_Z : HB;
      /* 床板(車体の底を閉じる)と台枠の縁 */
      acc.box(0, 0.975, (z0 + z1) / 2, 2.74, 0.04, z1 - z0, col.floor);
      [-1, 1].forEach((sd) => acc.box(sd * 1.33, 0.93, (z0 + z1) / 2, 0.08, 0.1, z1 - z0 - 0.4, col.frame));
      /* 台車 */
      [-BOGIE_Z, BOGIE_Z].forEach((bz) => this._bogie(acc, bz, motor, col));
      /* 床下機器(台車の間) */
      const big = motor ? { s: 1, a: -1.7, b: 1.3 } : { s: 1, a: -0.9, b: 1.5 };
      [-1, 1].forEach((sd) => {
        let z = -5.1;
        while (z < 5.0) {
          let len = 0.5 + R() * 1.6;
          let xin = 0.25 + R() * 0.7, h = 0.28 + R() * 0.26;
          let c = col.box[Math.floor(R() * col.box.length)];
          if (sd === big.s && z < big.b && z + len > big.a) { z = big.a; len = big.b - big.a; xin = 0.15; h = 0.52; c = col.box[0]; }
          len = Math.min(len, 5.1 - z);
          if (len > 0.3) {
            const x0 = 1.24, x1 = Math.max(0.12, xin);
            acc.box(sd * (x0 + x1) / 2, 0.955 - h / 2, z + len / 2, x0 - x1, h, len, c);
            /* 箱のふた・取っ手(細い帯) */
            if (Q.detail >= 1 && len > 0.8) acc.box(sd * (x0 + 0.004), 0.955 - h * 0.45, z + len / 2, 0.012, h * 0.08, len * 0.9, col.frame);
            if (Q.detail >= 2 && z === big.a && motor) {
              /* 主制御器の冷却フィン */
              for (let f = 0; f < 9; f++) acc.box(sd * (x0 + 0.03), 0.955 - h * 0.5, z + 0.4 + f * 0.26, 0.06, h * 0.7, 0.025, col.box[3]);
            }
          }
          z += len + 0.12 + R() * 0.35;
        }
      });
      /* 空気だめ(円筒タンク) */
      const ts = Q.cylSeg;
      if (Q.detail >= 1) [[-0.45, -4.6, -2.9], [0.5, 2.6, 4.3]].forEach(([x, a, b]) => {
        acc.cyl(new THREE.Vector3(x, 0.74, a), new THREE.Vector3(x, 0.74, b), 0.17, ts, col.tank, true);
      });
      /* 配管・ケーブルダクト */
      [-1, 1].forEach((sd) => acc.box(sd * 1.18, 0.91, 0, 0.06, 0.05, 10.2, col.pipe));
      /* 連結側: 連結器と幌 */
      const ends = [];
      if (!front) ends.push(1);
      if (!rear) ends.push(-1);
      ends.forEach((dir) => {
        acc.box(0, 0.86, dir * (HB + 0.11), 0.22, 0.2, 0.26, col.coupler);
        acc.box(0, 0.86, dir * (HB - 0.25), 0.36, 0.26, 0.5, col.frame);
        this._bellows(acc, dir, col.rubber);
      });
      /* 運転台側: スカート・密着連結器・ワイパー・アンテナ */
      if (front) this._cabUnder(acc, null, col);
      if (rear) this._cabUnder(acc, ROT_PI, col);
      /* 屋根: 母線の配管(冷房装置の外側) */
      [1].forEach((sd) => {
        const yr = 3.575;
        acc.box(sd * 1.04, yr, 0, 0.05, 0.05, BODY_LEN - 1.4, col.pipe);
      });
      if (panto) this._pantograph(acc, 7.15, col);
      return acc.geometry(true);
    });
  }

  _bogie(acc, bz, motor, col) {
    const Q = this.Q, G = this.gauge;
    const wx = G / 2 + 0.035, fx = G / 2 + 0.32;
    const wheel = this._wheelGeo();
    [-WHEELBASE / 2, WHEELBASE / 2].forEach((az) => {
      const z = bz + az;
      [-1, 1].forEach((sd) => {
        acc.add(wheel, mat4(sd * wx, WHEEL_R, z, sd, 1, 1));
        /* 軸箱と軸ばね */
        acc.box(sd * fx, WHEEL_R, z, 0.2, 0.26, 0.34, col.bogie);
        if (Q.detail >= 1) {
          acc.cyl(new THREE.Vector3(sd * fx, 0.56, z), new THREE.Vector3(sd * fx, 0.70, z), 0.085, Q.cylSeg, col.spring, false);
          /* ブレーキ */
          acc.box(sd * wx, 0.62, z - Math.sign(az) * 0.5, 0.12, 0.2, 0.16, col.frame);
        }
      });
      if (Q.detail >= 2) acc.cyl(new THREE.Vector3(-wx, WHEEL_R, z), new THREE.Vector3(wx, WHEEL_R, z), 0.08, 6, col.axle, false);
      if (motor && Q.detail >= 1) {
        acc.cyl(new THREE.Vector3(-0.42, WHEEL_R + 0.02, z - Math.sign(az) * 0.52), new THREE.Vector3(0.3, WHEEL_R + 0.02, z - Math.sign(az) * 0.52), 0.23, Q.cylSeg, col.bogie, true);
      }
    });
    /* 側ばり(中央が下がった魚腹形) */
    [-1, 1].forEach((sd) => {
      if (Q.detail >= 1) {
        acc.box(sd * fx, 0.655, bz, 0.16, 0.3, 1.0, col.bogie);
        [-1, 1].forEach((e) => {
          acc.box(sd * fx, 0.765, bz + e * 0.92, 0.15, 0.13, 0.84, col.bogie);
          acc.box(sd * fx, 0.71, bz + e * 1.38, 0.15, 0.22, 0.1, col.bogie);
        });
      } else acc.box(sd * fx, 0.7, bz, 0.16, 0.26, 2.8, col.bogie);
      /* 空気ばね */
      acc.cyl(new THREE.Vector3(sd * 0.95, 0.82, bz), new THREE.Vector3(sd * 0.95, 0.955, bz), 0.25, Q.cylSeg + 2, col.rubber, false);
      if (Q.detail >= 2) {
        /* ヨーダンパ */
        acc.cyl(new THREE.Vector3(sd * 1.17, 0.8, bz - 0.1), new THREE.Vector3(sd * 1.17, 0.86, bz + 0.85), 0.045, 6, col.frame, false);
      }
    });
    /* 横ばり */
    acc.box(0, 0.63, bz, fx * 2, 0.16, 0.36, col.bogie);
  }

  /* 車輪(踏面+フランジ、x軸まわりの回転体。フランジは-x側=内側) */
  _wheelGeo() {
    if (!this._wheel) {
      const pts = this.Q.detail >= 1
        ? [[0.12, 0.065], [0.395, 0.065], [0.418, 0.065], [0.43, -0.03], [0.458, -0.05], [0.13, -0.07]]
        : [[0.0, 0.065], [0.40, 0.065], [0.43, 0.065], [0.43, -0.07], [0.0, -0.07]];
      /* LatheGeometryは点の順で面の向きが決まる: 内側→外側の順に並べ直して外向きにする */
      const lathe = new THREE.LatheGeometry(pts.reverse().map(([r, h]) => new THREE.Vector2(r, h)), this.Q.wheelSeg);
      lathe.rotateZ(-Math.PI / 2);   // 回転軸 y → x
      /* 円板は黒っぽく、踏面(レールに当たる面)は磨かれて明るい */
      const P = lathe.attributes.position, cols = [];
      const disc = lin(0x34302e), tread = lin(0x9a948e);
      for (let j = 0; j < P.count; j++) {
        const c = Math.hypot(P.getY(j), P.getZ(j)) > 0.41 ? tread : disc;
        cols.push(c.r, c.g, c.b);
      }
      lathe.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
      this._wheel = lathe;
    }
    return this._wheel;
  }

  /* 幌(黒いじゃばら) */
  _bellows(acc, dir, c) {
    const w = 0.62, y0 = 1.12, y1 = 3.12, rc = 0.12;
    const loop = [];
    const lo = this.Q.detail < 1;
    const corner = (cx, cy, a0) => {
      for (let i = lo ? 1 : 0; i <= (lo ? 1 : 2); i++) { const a = a0 + i * Math.PI / 4; loop.push([cx + Math.cos(a) * rc, cy + Math.sin(a) * rc, Math.cos(a), Math.sin(a)]); }
    };
    corner(w - rc, y0 + rc, -Math.PI / 2); corner(w - rc, y1 - rc, 0); corner(-w + rc, y1 - rc, Math.PI / 2); corner(-w + rc, y0 + rc, Math.PI);
    const steps = lo ? [0, 0.25] : [0, 0.05, 0.1, 0.15, 0.2, 0.25];
    const scl = lo ? [1, 1] : [1, 0.95, 1, 0.95, 1, 0.97];
    const K = loop.length, base = acc.k;
    steps.forEach((dz, si) => {
      loop.forEach(([x, y, nx, ny]) => {
        const s = scl[si];
        acc.v(x * s, 2.12 + (y - 2.12) * s, dir * (HB - 0.02 + dz), nx, ny, 0, 0, 0, c);
      });
    });
    for (let si = 0; si < steps.length - 1; si++) {
      for (let k = 0; k < K; k++) {
        const a0 = base + si * K + k, b0 = base + si * K + (k + 1) % K, a1 = a0 + K, b1 = b0 + K;
        if (dir > 0) { acc.tri(a0, b0, b1); acc.tri(a0, b1, a1); } else { acc.tri(a0, b1, b0); acc.tri(a0, a1, b1); }
      }
    }
  }

  /* 運転台の床下まわり(前向きで作り、後ろ向きは行列で回す) */
  _cabUnder(acc, m, col) {
    const sub = new Acc();
    /* スカート: 前頭部の平面形に沿って弧を描く板(中央に連結器の切り欠き) */
    const cols = this.Q.detail >= 1 ? 16 : 8;
    const rows = [0, 0.42, 1.0];      // 下端からの割合(下端は中央が低く、両端は上がる)
    const xs = [];
    for (let j = 0; j <= cols; j++) xs.push(Math.sin(-Math.PI / 2 + Math.PI * j / cols));
    const P = (t, f) => {
      const yb = 0.30 + 0.24 * t * t;
      const y = yb + (1.0 - yb) * f;
      const lean = (1.0 - y) * 0.11;
      return new THREE.Vector3(t * 1.30, y, CAB_Z + 0.26 * se(t) + 0.05 * (1 - Math.abs(t)) * (1 - f) + lean - 0.03);
    };
    for (let r = 0; r < rows.length - 1; r++) {
      for (let j = 0; j < cols; j++) {
        const tm = (xs[j] + xs[j + 1]) / 2;
        if (r === 1 && Math.abs(tm * 1.3) < 0.3) continue;
        const a = P(xs[j], rows[r]), b = P(xs[j + 1], rows[r]), c2 = P(xs[j + 1], rows[r + 1]), d = P(xs[j], rows[r + 1]);
        const nrm = new THREE.Vector3().crossVectors(new THREE.Vector3().subVectors(b, a), new THREE.Vector3().subVectors(d, a)).normalize();
        const back = nrm.clone().multiplyScalar(-0.035);
        const ids = [a, b, c2, d].map((p) => sub.v(p.x, p.y, p.z, nrm.x, nrm.y, nrm.z, 0, 0, col.skirt));
        sub.tri(ids[0], ids[1], ids[2]); sub.tri(ids[0], ids[2], ids[3]);
        const bk = [a, b, c2, d].map((p) => sub.v(p.x + back.x, p.y + back.y, p.z + back.z, -nrm.x, -nrm.y, -nrm.z, 0, 0, col.frame));
        sub.tri(bk[0], bk[2], bk[1]); sub.tri(bk[0], bk[3], bk[2]);
        if (r === 0) {
          /* 下の縁 */
          const e = [a, b].map((p) => sub.v(p.x, p.y, p.z, 0, -1, 0, 0, 0, col.frame));
          const f = [a, b].map((p) => sub.v(p.x + back.x, p.y + back.y, p.z + back.z, 0, -1, 0, 0, 0, col.frame));
          sub.tri(e[0], f[0], f[1]); sub.tri(e[0], f[1], e[1]);
        }
      }
    }
    /* あご(前頭部の下面をふさぐ) */
    {
      const pr = this.prof, C = 12, y = 1.0;
      const c0 = sub.v(0, y - 0.005, CAB_Z, 0, -1, 0, 0, 0, col.floor);
      const ids = [];
      for (let j = 0; j <= C; j++) {
        const t = Math.sin(-Math.PI / 2 + Math.PI * j / C);
        const x = t * pr.P[0][0];
        ids.push(sub.v(x, y - 0.005, CAB_Z + noseDepth(y) * se(t), 0, -1, 0, 0, 0, col.floor));
      }
      for (let j = 0; j < C; j++) sub.tri(c0, ids[j + 1], ids[j]);
    }
    /* 密着連結器(スカートの切り欠きから顔を出す) */
    sub.box(0, 0.86, CAB_Z + 0.25, 0.18, 0.18, 0.6, col.coupler);
    sub.box(0, 0.86, 9.89, 0.34, 0.3, 0.22, col.coupler);
    sub.box(0, 0.86, 9.99, 0.2, 0.16, 0.04, col.frame);
    if (this.Q.detail >= 1) {
      /* 排障器の下の補強 */
      sub.box(0, 0.36, CAB_Z + 0.2, 1.6, 0.06, 0.12, col.frame);
    }
    /* ワイパー(運転士側= +x) */
    const wp = (x, y) => this._facePoint(x, y).addScaledVector(this._faceNormal(x, y), 0.03);
    sub.beam(wp(0.98, 2.09), wp(0.22, 2.13), 0.022, 0.018, col.rubber);
    sub.beam(wp(0.98, 2.075), wp(0.62, 2.11), 0.03, 0.03, col.rubber);
    /* 列車無線アンテナ */
    sub.box(-0.55, 3.66, CAB_Z - 1.4, 0.3, 0.04, 0.5, col.pantoDark);
    sub.box(-0.55, 3.78, CAB_Z - 1.4, 0.05, 0.22, 0.42, col.pantoDark);
    acc.add(sub.geometry(true), m);
  }

  /* シングルアーム・パンタグラフ(上昇時: すり板の上面 ≒ 4.8m) */
  _pantograph(acc, zc, col) {
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    const Q = this.Q, seg = Math.max(6, Q.cylSeg - 2);
    /* がいし×4と台枠 */
    [[-0.42, -0.58], [0.42, -0.58], [-0.42, 0.58], [0.42, 0.58]].forEach(([x, dz]) => {
      acc.cyl(V(x, 3.6, zc + dz), V(x, 3.84, zc + dz), 0.06, seg, col.insul, false);
      if (Q.detail >= 2) [3.68, 3.76].forEach((y) => acc.cyl(V(x, y, zc + dz), V(x, y + 0.02, zc + dz), 0.1, seg, col.insul, true));
    });
    [-0.42, 0.42].forEach((x) => acc.box(x, 3.87, zc, 0.07, 0.06, 1.36, col.pantoDark));
    [-0.62, 0.62].forEach((dz) => acc.box(0, 3.87, zc + dz, 0.9, 0.06, 0.07, col.pantoDark));
    /* 主軸と駆動ばね箱 */
    acc.cyl(V(-0.36, 3.93, zc + 0.55), V(0.36, 3.93, zc + 0.55), 0.04, seg, col.pantoDark, true);
    acc.box(0, 3.94, zc + 0.3, 0.26, 0.1, 0.4, col.pantoDark);
    /* 下わく(2本)・上わく・つり合い棒 */
    const knee = V(0, 4.38, zc - 0.82), head = V(0, 4.71, zc + 0.08);
    [-1, 1].forEach((sd) => acc.beam(V(sd * 0.28, 3.93, zc + 0.55), V(sd * 0.05, 4.38, zc - 0.80), 0.065, 0.065, col.panto));
    acc.beam(V(-0.07, 4.38, zc - 0.82), V(0.07, 4.38, zc - 0.82), 0.12, 0.06, col.panto);
    acc.beam(knee, head, 0.06, 0.055, col.panto);
    if (Q.detail >= 1) acc.beam(V(0, 3.96, zc + 0.36), V(0, 4.32, zc - 0.74), 0.02, 0.02, col.panto);
    /* 舟(すり板2本+ホーン) */
    acc.beam(V(-0.36, 4.72, zc + 0.08), V(0.36, 4.72, zc + 0.08), 0.04, 0.04, col.panto);
    [-0.13, 0.13].forEach((dz) => {
      const z = zc + 0.08 + dz;
      acc.box(0, 4.775, z, 1.1, 0.045, 0.06, col.shoe);
      [-1, 1].forEach((sd) => {
        acc.beam(V(sd * 0.55, 4.775, z), V(sd * 0.78, 4.70, z), 0.03, 0.03, col.panto);
        if (Q.detail >= 1) acc.beam(V(sd * 0.78, 4.70, z), V(sd * 0.86, 4.6, z), 0.025, 0.025, col.panto);
      });
    });
    [-0.36, 0.36].forEach((x) => acc.beam(V(x, 4.72, zc - 0.07), V(x, 4.72, zc + 0.23), 0.035, 0.035, col.panto));
    /* 避雷器と引き下ろし線 */
    acc.cyl(V(0.75, 3.6, zc - 1.1), V(0.75, 3.82, zc - 1.1), 0.07, seg, col.insul, true);
    acc.beam(V(0.42, 3.9, zc - 0.62), V(0.75, 3.84, zc - 1.1), 0.025, 0.025, col.pipe);
    acc.beam(V(0.42, 3.9, zc + 0.62), V(1.04, 3.62, zc + 1.2), 0.03, 0.03, col.pipe);
  }

  /* 灯火のジオメトリ(前向き・両側ぶん) */
  _lampGeo(kind) {
    return this._cached(`lamp_${kind}`, () => {
      const acc = new Acc();
      [-1, 1].forEach((sd) => {
        const xa = sd < 0 ? -LAMP.x1 : LAMP.x0, xb = sd < 0 ? -LAMP.x0 : LAMP.x1;
        const xc = (xa + xb) / 2;
        if (kind === 'head') this._faceQuad(acc, xa, xb, LAMP.hy0, LAMP.hy1, 0.012, 3);
        else if (kind === 'tail') this._faceQuad(acc, xa, xb, LAMP.ty0, LAMP.ty1, 0.012, 3);
        else if (kind === 'headHalo') this._haloQuad(acc, xc, (LAMP.hy0 + LAMP.hy1) / 2, 0.05);
        else if (kind === 'tailHalo') this._haloQuad(acc, xc, (LAMP.ty0 + LAMP.ty1) / 2, 0.05);
      });
      return acc.geometry(false);
    });
  }

  /* ---------------- 編成ごとの表記(行先LED+車番) ---------------- */
  _newDecal(numbers, text, kind) {
    const cv = newCanvas(512, 512);
    const tex = toTex(cv, true, 4);
    const mat = new THREE.MeshBasicMaterial({
      map: tex, alphaTest: 0.5,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    mat.color.setScalar(this.night ? 1.3 : 1.0);
    const rec = { cv, tex, mat, numbers: numbers.slice(), text, kind };
    this._drawDecal(rec, true);
    this._decals.add(rec);
    /* Webフォントが後から届いたら描き直す(最初は代わりのフォントで描かれるため) */
    if (typeof document !== 'undefined' && document.fonts && document.fonts.status !== 'loaded') {
      document.fonts.ready.then(() => {
        /* 代わりのフォントで描いた板は捨てる(最初の1回だけ) */
        if (!LED_FONTS_OK) { LED_FONTS_OK = true; LED_CACHE.clear(); }
        if (this._decals.has(rec)) this._drawDecal(rec, true);
      });
    }
    return rec;
  }
  _drawDecal(rec, numbersToo) {
    const c = rec.cv.getContext('2d');
    c.clearRect(0, 0, 512, 160);
    drawLed(c, 0, 0, 512, 80, 128, 20, rec.text, rec.kind);
    drawLed(c, 0, 80, 384, 80, 96, 20, rec.text, rec.kind);
    if (numbersToo) {
      c.clearRect(0, 160, 512, 352);
      c.textAlign = 'center'; c.textBaseline = 'middle';
      rec.numbers.forEach((num, i) => {
        const x = (i % 4) * 128, y = 160 + Math.floor(i / 4) * 44;
        c.fillStyle = '#1b1f23';
        c.font = `700 34px "Helvetica Neue", Arial, ${FONT}`;
        c.fillText(String(num), x + 64, y + 23, 120);
      });
    }
    rec.tex.needsUpdate = true;
  }
  static _decalUV(kind, i = 0) {
    const r = (x0, y0, x1, y1) => ({ u0: x0 / 512, u1: x1 / 512, v0: 1 - y1 / 512, v1: 1 - y0 / 512 });
    if (kind === 'front') return r(1, 1, 511, 79);
    if (kind === 'side') return r(1, 81, 383, 159);
    const x = (i % 4) * 128, y = 160 + Math.floor(i / 4) * 44;
    return r(x + 2, y + 2, x + 126, y + 42);
  }

  _decalGeo(front, rear, idx) {
    return this._cached(`decal${+front}${+rear}_${idx}`, () => {
      const acc = new Acc(), pr = this.prof;
      const sgn = rear && !front ? -1 : 1;
      const sideQuad = (sd, za, zb, y0, y1, uvr) => {
        const x = Math.max(pr.xAt(y0), pr.xAt(y1)) + 0.006;
        const zmin = Math.min(za, zb), zmax = Math.max(za, zb);
        /* 外から見て文字が左→右に読めるように並べる */
        const pts = sd > 0
          ? [[zmax, y0], [zmin, y0], [zmin, y1], [zmax, y1]]
          : [[zmin, y0], [zmax, y0], [zmax, y1], [zmin, y1]];
        const uvs = [[uvr.u0, uvr.v0], [uvr.u1, uvr.v0], [uvr.u1, uvr.v1], [uvr.u0, uvr.v1]];
        const b = acc.k;
        pts.forEach(([z, y], k) => acc.v(sd * x, y, z, sd, 0, 0, uvs[k][0], uvs[k][1]));
        acc.tri(b, b + 1, b + 2); acc.tri(b, b + 2, b + 3);
      };
      [-1, 1].forEach((sd) => {
        if (!(front && rear)) sideQuad(sd, sgn * LED_SIDE.z0, sgn * LED_SIDE.z1, LED_SIDE.y0, LED_SIDE.y1, TrainKit._decalUV('side'));
        sideQuad(sd, sgn * (NUM_SIDE.zc - NUM_SIDE.w / 2), sgn * (NUM_SIDE.zc + NUM_SIDE.w / 2), NUM_SIDE.y0, NUM_SIDE.y1, TrainKit._decalUV('num', idx));
      });
      const cab = (m) => {
        const sub = new Acc();
        this._faceQuad(sub, -LED_FRONT.x, LED_FRONT.x, LED_FRONT.y0, LED_FRONT.y1, 0.01, 6, TrainKit._decalUV('front'));
        this._faceQuad(sub, -NUM_FRONT.x, NUM_FRONT.x, NUM_FRONT.y0, NUM_FRONT.y1, 0.008, 2, TrainKit._decalUV('num', idx));
        acc.add(sub.geometry(false), m);
      };
      if (front) cab(null);
      if (rear) cab(ROT_PI);
      return acc.geometry(false);
    });
  }

  /* ---------------- 組み立て ---------------- */
  /** 1両を作る。lead=前(+Z)に運転台、tail=後ろ(−Z)に運転台 */
  makeCar({ lead = false, tail = false, pantograph = false, number = '1101', dest = '各停 新百合ヶ丘', kind = 'local', motor, _decal, _idx = 0 } = {}) {
    const front = !!lead, rear = !!tail;
    const isMotor = motor === undefined ? !!pantograph : !!motor;
    const decal = _decal || this._newDecal([number], dest, kind);
    const idx = _decal ? _idx : 0;
    const car = new THREE.Group();
    car.name = `car${number}`;
    const body = new THREE.Mesh(this._bodyGeo(front, rear), this.M.body);
    body.castShadow = true; body.receiveShadow = true;
    const under = new THREE.Mesh(this._underGeo(front, rear, isMotor, !!pantograph), this.M.dark);
    under.castShadow = true; under.receiveShadow = true;
    const marks = new THREE.Mesh(this._decalGeo(front, rear, idx), decal.mat);
    car.add(body, under, marks);
    const rigs = [];
    if (front || rear) {
      const face = new THREE.Mesh(this._faceGeo(front, rear), this.M.front);
      face.castShadow = true; face.receiveShadow = true;
      car.add(face);
      if (front) rigs.push(this._makeRig('front'));
      if (rear) rigs.push(this._makeRig('rear'));
      rigs.forEach((r) => car.add(r.group));
    }
    /* decal: 表記(編成で共有)。ownDecal: 単独で作った車両だけが持つ(release用) */
    car.userData = { isCar: true, lead: front, tail: rear, number: String(number), decal, rigs };
    if (!_decal) car.userData.ownDecal = decal;
    rigs.forEach((r) => this._applyRig(r, r.role === 'front', r.role === 'rear'));
    return car;
  }

  _makeRig(role) {
    const g = new THREE.Group();
    g.name = `lights_${role}`;
    if (role === 'rear') g.rotation.y = Math.PI;
    const headLens = new THREE.Mesh(this._lampGeo('head'), this.M.headOff);
    const tailLens = new THREE.Mesh(this._lampGeo('tail'), this.M.tailOff);
    const headHalo = new THREE.Mesh(this._lampGeo('headHalo'), this.M.haloHead);
    const tailHalo = new THREE.Mesh(this._lampGeo('tailHalo'), this.M.haloTail);
    headHalo.renderOrder = tailHalo.renderOrder = 10;
    g.add(headLens, tailLens, headHalo, tailHalo);
    const rig = { role, group: g, headLens, tailLens, headHalo, tailHalo };
    g.userData.rig = rig;
    return rig;
  }
  _applyRig(rig, head, tail) {
    rig.headLens.material = head ? this.M.headOn : this.M.headOff;
    rig.tailLens.material = tail ? this.M.tailOn : this.M.tailOff;
    rig.headHalo.visible = !!head;
    rig.tailHalo.visible = !!tail;
  }

  /** 編成を作る。cars[0]が先頭(+Z向き)、cars[i].position.z = -i*CAR_LEN */
  makeTrain(nCars = 8, { dest = '各停 新百合ヶ丘', kind = 'local', numberBase = 1101 } = {}) {
    const n = Math.max(1, Math.floor(nCars));
    const numbers = [];
    for (let i = 0; i < n; i++) numbers.push(String(numberBase + i * 100));
    const decal = this._newDecal(numbers, dest, kind);
    const group = new THREE.Group();
    group.name = 'train';
    const cars = [];
    for (let i = 0; i < n; i++) {
      const m4 = i % 4;
      const car = this.makeCar({
        lead: i === 0, tail: i === n - 1,
        pantograph: n > 2 && m4 === 1 && i < n - 1,
        motor: n > 2 && (m4 === 1 || m4 === 2) && i < n - 1,
        number: numbers[i], dest, kind, _decal: decal, _idx: i,
      });
      car.position.z = -i * CAR_LEN;
      group.add(car);
      cars.push(car);
    }
    const train = { group, cars, decal };
    group.userData.train = train;
    group.userData.decal = decal;
    this.setLights(train, { head: true, tail: true });
    return train;
  }

  /** 夜: 窓明かり・LED・灯火を強める(材質は共有なので全編成に効く) */
  setNight(on) {
    this.night = !!on;
    const n = this.night, M = this.M;
    M.body.emissiveIntensity = n ? 1.25 : 0.05;
    M.headOn.emissiveIntensity = n ? 6.0 : 3.0;
    M.tailOn.emissiveIntensity = n ? 4.0 : 2.4;
    M.haloHead.uniforms.uOpacity.value = n ? 1.0 : 0.4;
    M.haloHead.uniforms.uSize.value = n ? 3.2 : 1.1;
    M.haloTail.uniforms.uOpacity.value = n ? 0.9 : 0.3;
    M.haloTail.uniforms.uSize.value = n ? 1.5 : 0.55;
    this._decals.forEach((r) => r.mat.color.setScalar(n ? 1.3 : 1.0));
  }

  /** 灯火: head=前の運転台の前照灯, tail=後ろの運転台の尾灯。reverse=trueで逆向き運転 */
  setLights(trainOrCar, { head = true, tail = false, reverse = false } = {}) {
    const root = trainOrCar && (trainOrCar.group || trainOrCar);
    if (!root || !root.traverse) return;
    root.traverse((o) => {
      const rig = o.userData && o.userData.rig;
      if (!rig) return;
      const isFront = (rig.role === 'front') !== !!reverse;
      this._applyRig(rig, isFront && head, !isFront && tail);
    });
  }

  /** 行先LEDの文字を変える(例: '急行 小田原')。kindは省略可 */
  setDest(train, text, kind) {
    const root = train && (train.group || train);
    const rec = (train && train.decal) || (root && root.userData && (root.userData.decal || root.userData.ownDecal));
    if (!rec) return;
    rec.text = text;
    if (kind) rec.kind = kind;
    this._drawDecal(rec, false);
  }

  /** 編成ごとの表記テクスチャを解放(編成を捨てるとき) */
  release(train) {
    const root = train && (train.group || train);
    const recs = new Set();
    if (train && train.decal) recs.add(train.decal);
    if (root && root.traverse) root.traverse((o) => { if (o.userData && o.userData.ownDecal) recs.add(o.userData.ownDecal); });
    recs.forEach((r) => { r.tex.dispose(); r.mat.dispose(); this._decals.delete(r); });
  }

  dispose() {
    this._geo.forEach((g) => g.dispose());
    this._geo.clear();
    if (this._wheel) { this._wheel.dispose(); this._wheel = null; }
    Object.values(this.T).forEach((t) => t && t.dispose());
    Object.values(this.M).forEach((m) => m.dispose());
    this._decals.forEach((r) => { r.tex.dispose(); r.mat.dispose(); });
    this._decals.clear();
  }

  /** 1両あたりの描画数・三角形数(検証用) */
  static stats(car) {
    let calls = 0, tris = 0;
    car.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      let vis = true;
      for (let p = o.parent; p && p !== car.parent; p = p.parent) if (!p.visible) vis = false;
      if (!vis) return;
      calls++;
      const g = o.geometry;
      tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    });
    return { calls, tris };
  }
}
