/* =========================================================
 * scene/cockpit.js — 運転台の窓まわり(3D)
 * 画面比率に合わせて「窓枠・ピラー・運転台の天板・ワイパー」を配置する。
 * 計器はHTML(#cab)側。ここは"窓から見える運転台のふち"だけを担当。
 *
 * 描き方: はじめはカメラの子として本体のシーンで描く。描画側が useOverlay() か renderOverlay() を
 * 呼ぶと、自分のシーン(this.scene)へ移り、本体を描いたあとに深度だけ消して
 * 上から描く(トーンマッピング・ブルーム・霧の影響を受けない)。
 * 材質はすべて MeshBasic(toneMapped:false)。色は計器盤(#cab)と同じ式で暗くする:
 *   #cab::after は rgb(2,4,7) を (1-明るさ)*0.62 だけ重ねる → shade() も同じ。
 * ガラスらしさ: ふちの黒いセラミック(フリット)・運転士窓の上の遮光幕・天板のうすい映り込み。
 * ふちのギザギザ: 窓のふちはフリットの帯(テクスチャで ぼける)、ワイパーは 1.5画素の ぼかしの帯でかくす
 *   (COCKPIT_FEATHER。描画側はこれを見て キャンバスのアンチエイリアスを切ってよい)。
 * 天板の上: 立てた時刻表(上に大きな 時:分。いまの駅の行は だいだい。分・駅が かわったときだけ描く)と、
 *   晴れの日の 日だまり(sunPatch。カーブで 天板の上を すべる。加算の板1枚)。
 * 外との約束: useOverlay() / renderOverlay(renderer, camera) / setHeadOffset(dx,dy,pitch,roll) /
 *   update(dt, {light, flash, tr,tg,tb, night, wiper, snow, clockMin, sunK, sunX, sunEve}) / setTimetable(names, idx, times) /
 *   windowRects() / wiperScreen() / sillLevel() / layoutFor(aspect) / light(なめらかにした明るさ。flash は入らない) /
 *   sunK・sunX(なめらかにした日だまりの こさ 0..1 と 横の位置 -1..1。計器盤の cab.setSun にも使う)
 * ========================================================= */
import * as THREE from '../vendor/three.module.min.js';

const TAN = Math.tan(THREE.MathUtils.degToRad(29));   // 縦FOV58°の半分

/* 窓のふち(フリット)とワイパーの ぼかしの帯がある = キャンバスのアンチエイリアスなしでも ふちがギザギザにならない */
export const COCKPIT_FEATHER = true;

/* ---- 計器盤と同じ減光(sRGBで rgb(2,4,7) へ寄せる) ---- */
export const CAB_DIM = 0.62;
const DIM = [2 / 255, 4 / 255, 7 / 255];
const hexRGB = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
/* hex(見た目の色) を 明るさ light(0..1) で暗くした sRGB の値 [r,g,b](0..1) */
export function shade(hex, light, out) {
  const l = light < 0 ? 0 : light > 1 ? 1 : light;
  const a = (1 - l) * CAB_DIM;
  const c = typeof hex === 'string' ? hexRGB(hex) : hex;
  const o = out || [0, 0, 0];
  for (let i = 0; i < 3; i++) o[i] = c[i] + (DIM[i] - c[i]) * a;
  return o;
}
/* 各部の色(見た目の値)。天板はテクスチャの地 #2a2e31 を #2c3237 に合わせる */
const COL = {
  frame: hexRGB('#3a4046'), seal: hexRGB('#060708'), dash: hexRGB('#2c3237'), dashBase: hexRGB('#2a2e31'),
  dashEdge: hexRGB('#15191c'), wiper: hexRGB('#0c0d0f'), rubber: hexRGB('#050506'), chrome: hexRGB('#6c747a'),
  snow: hexRGB('#e9eef3'), hem: hexRGB('#2b3034'),
};
const s2l = (s) => (s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4));

/* sRGB(見た目)の比率をリニアへ(頂点色はリニア解釈) */
const lin = (k) => Math.pow(Math.max(0, k), 2.2);
/* 内装(FRPの化粧板)の明るさの比率: 上ほど20%暗い(見た目の比率) */
const trimK = (yNdc) => 1 - 0.2 * Math.min(1, Math.max(0, (yNdc + 1) / 2));
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
/* ±m におさめる(数でないときは 0) */
const clampM = (v, m) => (v > m ? m : v < -m ? -m : (v || 0));

/* 角を丸めた多角形の点列(平面の単位)。各角は2次ベジェ(手前の辺を r もどった点 → 角 → つぎの辺を r すすんだ点) */
function roundedPoly(pts, rad, seg) {
  const out = [], n = pts.length;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i + n - 1) % n], p1 = pts[i], p2 = pts[(i + 1) % n];
    const d0x = p1[0] - p0[0], d0y = p1[1] - p0[1], l0 = Math.hypot(d0x, d0y);
    const d1x = p2[0] - p1[0], d1y = p2[1] - p1[1], l1 = Math.hypot(d1x, d1y);
    const r = Math.min(rad[i], l0 * 0.45, l1 * 0.45);
    if (!(r > 1e-6)) { out.push([p1[0], p1[1]]); continue; }
    const ax = p1[0] - (d0x / l0) * r, ay = p1[1] - (d0y / l0) * r;
    const bx = p1[0] + (d1x / l1) * r, by = p1[1] + (d1y / l1) * r;
    for (let k = 0; k <= seg; k++) {
      const t = k / seg, u = 1 - t;
      out.push([u * u * ax + 2 * u * t * p1[0] + t * t * bx, u * u * ay + 2 * u * t * p1[1] + t * t * by]);
    }
  }
  return out;
}

/* 閉じた点列の各頂点の外向きの向き(角の二等分線。長さは辺から1になるよう伸ばす) */
function outwardNormals(pts) {
  const n = pts.length;
  let area = 0;
  for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; area += a[0] * b[1] - b[0] * a[1]; }
  const sgn = area > 0 ? 1 : -1;   // 反時計回りなら辺の右側が外
  const en = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    en.push([(dy / l) * sgn, (-dx / l) * sgn]);
  }
  return pts.map((p, i) => {
    const e0 = en[(i + n - 1) % n], e1 = en[i];
    let nx = e0[0] + e1[0], ny = e0[1] + e1[1];
    const l = Math.hypot(nx, ny) || 1;
    nx /= l; ny /= l;
    const c = Math.max(0.35, nx * e1[0] + ny * e1[1]);
    return [nx, ny, 1 / c];
  });
}

/* 点列を外へ w(頂点ごと) だけずらす */
const offsetPts = (pts, nrm, w) => pts.map((p, i) => [p[0] + nrm[i][0] * nrm[i][2] * w[i], p[1] + nrm[i][1] * nrm[i][2] * w[i]]);

/* 内側の輪(a)と外側の輪(b)のあいだを帯にして buf に足す(色は頂点ごと)。uvA/uvB を渡すと UV も。
 * open: 最後の点から最初の点へ つながない(UV をくりかえす帯は 最初の点を最後にもう一度 足して閉じる) */
function pushRing(buf, a, b, z, colA, colB, uvA, uvB, open) {
  const n = a.length, base = buf.pos.length / 3;
  for (let i = 0; i < n; i++) {
    buf.pos.push(a[i][0], a[i][1], z); buf.col.push(...colA[i]);
    buf.pos.push(b[i][0], b[i][1], z); buf.col.push(...colB[i]);
    if (uvA) buf.uv.push(uvA[i][0], uvA[i][1], uvB[i][0], uvB[i][1]);
  }
  for (let i = 0; i < (open ? n - 1 : n); i++) {
    const j = (i + 1) % n, a0 = base + i * 2, b0 = a0 + 1, a1 = base + j * 2, b1 = a1 + 1;
    buf.idx.push(a0, b0, b1, a0, b1, a1);
  }
}

const newBuf = () => ({ pos: [], col: [], idx: [], uv: [] });
/* 三角形を すべてカメラ向き(+z から見て反時計回り)にそろえる。片面の材質(FrontSide)で描くため */
function faceCamera(buf) {
  const p = buf.pos, ix = buf.idx;
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
    const cz = (p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[b + 1] - p[a + 1]) * (p[c] - p[a]);
    if (cz < 0) { const k = ix[t + 1]; ix[t + 1] = ix[t + 2]; ix[t + 2] = k; }
  }
  return buf;
}
function bufGeo(buf) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(buf.col, 3));
  if (buf.uv.length) g.setAttribute('uv', new THREE.Float32BufferAttribute(buf.uv, 2));
  g.setIndex(buf.idx);
  return g;
}

/* 同じ材質の小さな部品(箱・円柱)を1つのジオメトリにまとめる(描画回数を減らす)。
 * k: [下, 上] を渡すと、部品の下の面から上の面へ明るさの比(見た目の比率)を頂点色でつける */
function mergeParts(parts) {
  const pos = [], idx = [], col = [];
  const v = new THREE.Vector3();
  const useCol = parts.some((pt) => pt.k);
  parts.forEach(({ geo, m, k }) => {
    const base = pos.length / 3;
    const p = geo.attributes.position;
    if (useCol && !geo.boundingBox) geo.computeBoundingBox();
    const y0 = useCol ? geo.boundingBox.min.y : 0, yh = useCol ? Math.max(1e-6, geo.boundingBox.max.y - y0) : 1;
    const kk = k || [1, 1];
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      if (useCol) { const c = lin(kk[0] + (kk[1] - kk[0]) * ((v.y - y0) / yh)); col.push(c, c, c); }
      v.applyMatrix4(m); pos.push(v.x, v.y, v.z);
    }
    const ix = geo.index;
    for (let i = 0; i < ix.count; i++) idx.push(base + ix.getX(i));
    geo.dispose();
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (useCol) g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}
const mat4 = (x, y, z, rx = 0) => new THREE.Matrix4().makeRotationX(rx).setPosition(x, y, z);
const I4 = new THREE.Matrix4();

const canvasTex = (cv, srgb) => {
  const t = new THREE.CanvasTexture(cv);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
};

/* 立てた時刻表(スタフ)の板の位置: 天板の u .095〜.21(画面の左はしで切れないよう少し内寄り)、
 * 台は天板の v .36(手前より。板が窓の景色に かかりすぎない) */
const STAFF = { u0: 0.095, u1: 0.205, v: 0.36, lean: 0.2 };
/* 板の絵の大きさ(上に 時:分、下に 3行の時刻表)。板の3Dの高さは はばの半分(絵と同じ比)。
 * 板は 台から うしろへ lean(rad, 約11°)だけ ねかせる(ほぼ目のほうを向く: 字が読める) */
const STAFF_W = 256, STAFF_H = 128;
/* 数字の書体(計器盤と同じ) */
const NUM_FONT = '"DIN Alternate","DIN Condensed",Bahnschrift,"Roboto Condensed","Zen Kaku Gothic New",sans-serif';
const JP_FONT = '"Zen Kaku Gothic New","Hiragino Sans","Yu Gothic UI",Meiryo,sans-serif';

/* 天板の表面 1024x128(一度だけ)。画像の上が奥(窓の下)、下が手前(計器盤とのさかい)。
 * 左に 立てた時刻表の台(黒い台座だけ。板は別の1枚)。まん中(u .33〜.67)は「いまやること」の帯がかかるので何も置かない */
function dashTexture() {
  const W = 1024, H = 128;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  c.fillStyle = '#2a2e31';
  c.fillRect(0, 0, W, H);
  /* しぼ(細かい凹凸)は乱数の点で */
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 9000; i++) {
    c.fillStyle = i & 1 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.06)';
    c.fillRect((rnd() * W) | 0, (rnd() * H) | 0, 1, 1);
  }
  /* 奥の縁: デフロスタの吹き出し口(まん中の帯にかからない左右だけ) */
  for (let i = 0; i < 64; i++) {
    const x = 14 + i * (996 / 64);
    if (x > W * 0.31 && x < W * 0.69) continue;
    c.fillStyle = '#0a0b0c';
    c.fillRect(x, 9, 10, 3);
    c.fillStyle = 'rgba(255,255,255,0.08)';
    c.fillRect(x, 12, 10, 1);
  }
  /* (化粧板の継ぎ目は描かない: 台形の天板では ななめの線に見えて「いまやること」の帯のわきが きずのように見えた) */
  /* 立てた時刻表の台座(黒い台・落ち影・上のふちの光)。板そのものは drawStaff の絵を 立てた1枚で */
  {
    const x0 = Math.round(STAFF.u0 * W) - 6, x1 = Math.round(STAFF.u1 * W) + 6, yc = Math.round((1 - STAFF.v) * H);
    c.fillStyle = 'rgba(0,0,0,0.38)'; c.fillRect(x0 + 3, yc - 7, x1 - x0, 20);   // 落ち影
    c.fillStyle = '#15181b'; c.fillRect(x0, yc - 10, x1 - x0, 18);
    c.fillStyle = 'rgba(255,255,255,0.10)'; c.fillRect(x0, yc - 10, x1 - x0, 1);
    c.fillStyle = '#0b0c0d'; c.fillRect(x0 + 4, yc - 2, x1 - x0 - 8, 3);         // 板を差しこむ みぞ
  }
  /* 奥ほど暗く(上30%) / 奥の見切りの影 / 手前のふちのハイライト */
  const g = c.createLinearGradient(0, 0, 0, H * 0.3);
  g.addColorStop(0, 'rgba(0,0,0,0.25)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = g; c.fillRect(0, 0, W, H * 0.3);
  c.fillStyle = 'rgba(0,0,0,0.35)'; c.fillRect(0, 0, W, 4);
  c.fillStyle = 'rgba(255,255,255,0.10)'; c.fillRect(0, H - 3, W, 2);
  const tex = canvasTex(cv, true);
  tex.anisotropy = 8;
  return { tex, c };
}

/* 角丸の四角(古いSafariには ctx.roundRect がないので arcTo で) */
function rrect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

/* 立てた時刻表(スタフ)の板 256x128: 黒い板の上に 時:分(大きく)、下に紙(いまの駅・そのつぎ・そのつぎの3行。
 * いまの駅の行は だいだいで大きく)。画面では 約150x90px。分か駅が かわったときだけ描きなおす。
 * tt: { names, times, idx }(なければ 線だけの紙) */
function drawStaff(c, min, tt) {
  const W = STAFF_W, H = STAFF_H;
  c.clearRect(0, 0, W, H);
  /* 板(黒い金属のホルダー。上のふちが少し明るい) */
  c.fillStyle = '#171a1d'; rrect(c, 0, 0, W, H, 9); c.fill();
  c.fillStyle = 'rgba(255,255,255,0.13)'; c.fillRect(8, 1, W - 16, 1.5);
  /* 時計: 黒い窓に 白い 時:分 */
  c.fillStyle = '#060708'; rrect(c, 6, 5, W - 12, 37, 5); c.fill();
  const m = ((min % 1440) + 1440) % 1440;
  c.fillStyle = '#eef4f7';
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.font = `700 31px ${NUM_FONT}`;
  c.fillText(`${(m / 60) | 0}:${String(m % 60).padStart(2, '0')}`, W / 2, 25);
  /* 紙(押さえ金具の下) */
  const py = 46, ph = H - py - 5;
  c.fillStyle = '#dcd8cb'; c.fillRect(6, py, W - 12, ph);
  const n = tt && tt.names ? tt.names.length : 0;
  const rowsH = [32, 22, 22];
  let y = py + 2;
  for (let r = 0; r < 3; r++) {
    const h = rowsH[r], i = (tt ? tt.idx : 0) + r;
    if (r === 0) { c.fillStyle = 'rgba(255,170,40,0.92)'; c.fillRect(8, y, W - 16, h - 2); }
    else { c.fillStyle = 'rgba(0,0,0,0.22)'; c.fillRect(10, y - 1, W - 20, 1); }
    if (n && i < n) {
      c.fillStyle = r === 0 ? '#1d1300' : '#2a2c30';
      c.textBaseline = 'middle';
      c.textAlign = 'left';
      c.font = `700 ${r === 0 ? 20 : 15}px ${JP_FONT}`;
      c.fillText(String(tt.names[i]), 14, y + h / 2, W - 92);
      const t = tt.times && tt.times[i];
      if (t) {
        c.textAlign = 'right';
        c.font = `700 ${r === 0 ? 20 : 15}px ${NUM_FONT}`;
        c.fillText(t, W - 14, y + h / 2);
      }
    } else if (!n) {
      /* 運転の前: 字のかわりの線 */
      c.fillStyle = 'rgba(20,20,20,0.5)';
      c.fillRect(14, y + h / 2 - 2, 70 + r * 12, 4);
      c.fillRect(W - 60, y + h / 2 - 2, 46, 4);
    }
    y += h;
  }
  /* 紙の上の押さえ金具 */
  c.fillStyle = '#0b0c0d'; c.fillRect(4, py - 2, W - 8, 4);
}

/* 日だまり 128x32: まん中が あたたかい白(#fff1d6)、ふちへ透明(横長の だ円) */
function sunTexture() {
  const cv = document.createElement('canvas');
  cv.width = 128; cv.height = 32;
  const c = cv.getContext('2d');
  c.setTransform(64, 0, 0, 16, 64, 16);
  const g = c.createRadialGradient(0, 0, 0, 0, 0, 1);
  g.addColorStop(0, 'rgba(255,241,214,1)');
  g.addColorStop(0.45, 'rgba(255,241,214,0.6)');
  g.addColorStop(1, 'rgba(255,241,214,0)');
  c.fillStyle = g;
  c.fillRect(-1, -1, 2, 2);
  const t = canvasTex(cv, true);
  t.generateMipmaps = false;
  t.minFilter = THREE.LinearFilter;
  return t;
}

/* フリット(ガラスのふちの黒いセラミック) 64x32: 横(u)は窓のふちにそってくりかえし、縦は 絵の上(v=1)が ふち → 下(v=0)が内。
 * ふちの1/4はべた塗り、その内は小さくなっていく網点、いちばん内は透明 */
function fritTexture() {
  const W = 64, H = 32, cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  c.fillStyle = '#fff';
  c.fillRect(0, 0, W, 8);
  const rows = [[12, 3.2, 0], [18, 2.3, 4], [24, 1.4, 0]];
  rows.forEach(([y, r, ox]) => {
    for (let x = ox; x < W + 8; x += 8) { c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill(); }
  });
  const t = canvasTex(cv, false);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = 4;
  return t;
}

/* 遮光幕(運転士窓の上) 512x64: 半透明の黒い布(3pxごとの織り目)・下に 6px の すそ(金具) */
const BLIND = { fabric: 44, hem: 6 };
function blindTexture() {
  const W = 512, H = 64, cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  c.fillStyle = 'rgba(18,22,26,0.70)';
  c.fillRect(0, 0, W, BLIND.fabric);
  c.fillStyle = 'rgba(0,0,0,0.22)';
  for (let y = 1; y < BLIND.fabric; y += 3) c.fillRect(0, y, W, 1);
  c.fillStyle = 'rgba(255,255,255,0.035)';
  for (let x = 0; x < W; x += 3) c.fillRect(x, 0, 1, BLIND.fabric);
  /* すそ: 金属の棒(上のふちが少し明るい) */
  c.fillStyle = '#2b3034'; c.fillRect(0, BLIND.fabric, W, BLIND.hem);
  c.fillStyle = 'rgba(255,255,255,0.16)'; c.fillRect(0, BLIND.fabric, W, 1);
  c.fillStyle = 'rgba(0,0,0,0.5)'; c.fillRect(0, BLIND.fabric + BLIND.hem - 1, W, 1);
  /* (引き手は描かない: 上の帯(HUD)で布がかくれると、黒い引き手だけが ガラスの まん中に うかんで見えた) */
  const t = canvasTex(cv, true);
  t.anisotropy = 4;
  return t;
}

/* ぼかしの帯 2x16: 絵の上(v=1)が不透明、下(v=0)が透明(ワイパーのふちのアンチエイリアス) */
function featherTexture() {
  const cv = document.createElement('canvas');
  cv.width = 2; cv.height = 16;
  const c = cv.getContext('2d');
  const g = c.createLinearGradient(0, 0, 0, 16);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g; c.fillRect(0, 0, 2, 16);
  const t = canvasTex(cv, false);
  t.generateMipmaps = false;
  t.minFilter = THREE.LinearFilter;
  return t;
}

export class Cockpit {
  constructor(camera) {
    this.camera = camera;
    this.root = new THREE.Group();
    this.root.renderOrder = 10;
    camera.add(this.root);
    /* 上に重ねて描くとき用の自分のシーン(はじめは空。useOverlay か 最初の renderOverlay で移る) */
    this.scene = new THREE.Scene();
    this._own = false;
    /* 頭の動き(運転台は車体に固定。目は少しだけ動く) */
    this._off = new THREE.Matrix4();
    this._offP = new THREE.Vector3();
    this._offQ = new THREE.Quaternion();
    this._offE = new THREE.Euler();
    this._one = new THREE.Vector3(1, 1, 1);
    this._offV = [0, 0, 0, 0];
    this._dbV = new THREE.Vector2();
    this._dbH = 0;
    /* 材質はすべて Basic(光・トーンマッピング・霧なし)。色は update() で計器盤と同じ式で決める */
    const basic = (o) => new THREE.MeshBasicMaterial(Object.assign({ toneMapped: false, fog: false }, o));
    this.matFrame = basic({ vertexColors: true, side: THREE.DoubleSide });
    this.matSeal = basic({ side: THREE.DoubleSide });
    const dt = dashTexture();
    this._dashTex = dt.tex;
    this._dashC = dt.c;
    this.matDash = basic({ map: dt.tex, vertexColors: true });
    this.matDashEdge = basic({});
    /* ワイパー: 黒い腕・ブレード / ゴム / 根元のメッキ */
    this.matWiper = basic({ vertexColors: true, side: THREE.DoubleSide });   // 枠と同じシェーダ(頂点色・両面)
    this.matRubber = basic({});
    this.matChrome = basic({});
    /* 雪の日の窓の下のふちの雪(雪のときだけ、だんだん積もる) */
    this.matSill = basic({ vertexColors: true, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
    /* ガラスまわり(フリット・遮光幕・映り込み・ぼかし・時計)は ぜんぶ「テクスチャ+頂点色+半透明・片面」の
     * 同じシェーダ(重ね描きで ふえるシェーダは これ1つ) */
    const glassM = (o) => basic(Object.assign({ vertexColors: true, transparent: true, depthWrite: false }, o));
    this.matFrit = glassM({ map: fritTexture() });
    this.matBlind = glassM({ map: blindTexture() });
    /* 映り込みは天板の絵を 128x16 に縮めたもの(ぼやけた うつり。時刻表を描きなおしたときだけ 作りなおす) */
    this._reflCv = document.createElement('canvas');
    this._reflCv.width = 128; this._reflCv.height = 16;
    this._reflTex = canvasTex(this._reflCv, true);
    this._reflTex.generateMipmaps = false;
    this._reflTex.minFilter = THREE.LinearFilter;
    this._updRefl();
    this.matRefl = glassM({ map: this._reflTex, blending: THREE.AdditiveBlending });
    this.matFeather = glassM({ map: featherTexture() });
    /* 立てた時刻表(上に 時:分)。分・つぎの駅が かわったときだけ描きなおす */
    this._staffCv = document.createElement('canvas');
    this._staffCv.width = STAFF_W; this._staffCv.height = STAFF_H;
    this._staffC = this._staffCv.getContext('2d');
    this._clockMin = 600;
    this._tt = null;
    drawStaff(this._staffC, this._clockMin, null);
    this._staffTex = canvasTex(this._staffCv, true);
    this._staffTex.anisotropy = 4;
    this.matClock = glassM({ map: this._staffTex, depthTest: false });
    /* 日だまり(加算。天板の上に のせる板。ほかのガラスまわりと同じシェーダ) */
    this.matSun = glassM({ map: sunTexture(), blending: THREE.AdditiveBlending, depthTest: false });
    this.matSun.color.setRGB(0, 0, 0);
    this.sunK = 0;           // 日だまりの こさ(なめらか 0..1)
    this.sunX = 0;           // 日だまりの 横の位置(なめらか -1..1。右が +)
    this._sunC = -1; this._sunPX = 0;
    this._tmpS = [0, 0, 0];
    this._tmpC = new THREE.Color();
    this.light = 1;          // 室内の明るさ(昼1・夜/トンネル小)。なめらか・flash なし(計器盤もこれを使う)
    this.flash = 0;          // トンネルの灯具の速い明かり(3Dの枠と天板だけ)
    this._tR = 1; this._tG = 1; this._tB = 1;   // 枠の色み(なめらか)
    this._shadeL = -1; this._shadeF = 0; this._shadeT = [1, 1, 1];
    this.wiperOn = false;
    this.wiperT = 0;
    this.wiperRest = 0.012;   // 休止角(ほぼ水平・左向き。窓の下のゴムの上に寝かせる)
    this.wiperAng = this.wiperRest;
    this._ph0 = 0;
    this._rest = 0;
    this._sill = 0;
    this._noSnowT = Infinity;
    this.layout = null;
    this.aspect = 0;
    this.quality = 'mid';
    this._ttNames = null; this._ttIdx = -1;
    this._applyShade();
  }

  setVisible(v) { this.root.visible = v; }

  /* 窓の下のふちの雪の量(0..1)。雨のガラス(ui/rainglass.js)がワイパーのはしの雪の山に使う */
  sillLevel() { return this._sill; }

  /* 頭の位置のずれ(m)と傾き(rad)。運転台が画面の中で少しだけ動き、車体に固定された物に見える */
  setHeadOffset(dx, dy, pitch, roll) {
    dx = clampM(dx, 0.004); dy = clampM(dy, 0.004); pitch = clampM(pitch, 0.003); roll = clampM(roll, 0.003);
    const o = this._offV;
    if (o[0] === dx && o[1] === dy && o[2] === pitch && o[3] === roll) return;
    o[0] = dx; o[1] = dy; o[2] = pitch; o[3] = roll;
    this._offP.set(dx, dy, 0);
    this._offE.set(pitch, 0, roll);
    this._offQ.setFromEuler(this._offE);
    this._off.compose(this._offP, this._offQ, this._one);
    /* まだカメラの子のとき(描画側が renderOverlay を呼ばない): 位置と向きに直接 */
    if (!this._own) {
      this.root.position.copy(this._offP);
      this.root.rotation.set(pitch, 0, roll);
    }
  }

  /* 重ね描き(自分のシーン)に切りかえる。描画側が最初の準備(prewarm)より前に呼んでおけば、
   * まだ何もコンパイルしていないので捨てるシェーダがない(呼ばなければ最初の renderOverlay で切りかえる) */
  useOverlay() {
    if (this._own) return;
    this._own = true;
    if (this.root.parent) this.root.parent.remove(this.root);
    this.root.position.set(0, 0, 0);
    this.root.rotation.set(0, 0, 0);
    this.root.updateMatrix();
    this.scene.add(this.root);
    this.root.matrixAutoUpdate = false;
    /* 本体のシーン用に作られていたシェーダは もう使わないので手放す(材質ごとに作りおきされて残るため)。
     * 次に描くときに上描き用だけが作られる */
    [this.matFrame, this.matSeal, this.matDash, this.matDashEdge, this.matWiper, this.matRubber, this.matChrome, this.matSill,
      this.matFrit, this.matBlind, this.matRefl, this.matFeather, this.matClock, this.matSun]
      .forEach((m) => m.dispose());
  }

  /* 本体を描いたあとに呼ぶ: 深度だけ消して運転台を上から描く(トーンマッピング・ブルームなし) */
  renderOverlay(renderer, camera) {
    if (!renderer || !camera) return;
    if (!this._own) this.useOverlay();
    if (!this.root.visible) return;
    /* ワイパーのぼかしの帯は 描画バッファの 1.5画素の幅(大きさが変わったときだけ作りなおす) */
    const dbH = renderer.getDrawingBufferSize(this._dbV).y;
    if (dbH > 0 && dbH !== this._dbH) { this._dbH = dbH; this._buildWiperFeather(); }
    this.root.matrix.multiplyMatrices(camera.matrixWorld, this._off);
    this.root.matrixWorldNeedsUpdate = true;
    renderer.setRenderTarget(null);
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.scene, camera);
    renderer.autoClear = true;
  }

  /* 画面比率が変わったら作り直す(要素は少ないので軽い) */
  layoutFor(aspect) {
    if (Math.abs(aspect - this.aspect) < 1e-3 && this.layout) return;
    this.aspect = aspect;
    this.root.children.slice().forEach((c) => {
      this.root.remove(c);
      c.traverse((o) => { if (o.geometry) o.geometry.dispose(); });   // ワイパー(グループ)の中も
    });
    /* 縦長(ポートレート)ほど枠を細くして視界を確保する */
    const narrow = aspect < 1.25;
    const L = {
      aPillar: narrow ? 0.06 : 0.075,         // 左ピラーの幅(ndc,下端)
      cX: narrow ? 0.66 : 0.52,               // 中央ピラーの位置(ndc x)
      cW: narrow ? 0.045 : 0.05,              // 中央ピラー幅
      top: narrow ? 0.885 : 0.86,             // 窓の上端(ndc y)
      dash: narrow ? -0.86 : -0.82,           // 天板の奥の縁(ndc y)
    };
    const z = -0.9;
    const hw = -z * TAN * aspect, hh = -z * TAN;
    const P = (x, y) => [x * hw, y * hh];
    /* ピラーは天板の奥の縁で止める。窓(ガラス)の下の端は、下のゴムの上の縁 */
    const yB = L.dash - 0.01, yG = L.dash + 0.012;
    const ap = L.aPillar, cx = L.cX, cw = L.cW;
    const xAt = (xa, ya, xb, yb, y) => xa + ((xb - xa) * (y - ya)) / (yb - ya);
    /* --- ガラスの形(角の丸い四角): 運転士窓と右の窓 --- */
    const rT = 0.05 * hh, rBt = 0.025 * hh;
    const gl = [
      P(xAt(-1 + ap, yB, -1 + ap * 0.55, L.top, yG), yG),
      P(xAt(cx - cw * 0.5, yB, cx - cw * 0.42, L.top, yG), yG),
      P(cx - cw * 0.42, L.top), P(-1 + ap * 0.55, L.top),
    ];
    const gr = [
      P(xAt(cx + cw * 0.62, yB, cx + cw * 0.52, L.top, yG), yG), P(1.15, yG),
      P(1.15, L.top), P(cx + cw * 0.52, L.top),
    ];
    const rad = [rBt, rBt, rT, rT];
    const winL = roundedPoly(gl, rad, 5), winR = roundedPoly(gr, rad, 5);
    L.glass = [gl, gr];
    L.rTop = rT / hh / 2; L.rBot = rBt / hh / 2;
    this.layout = L;

    /* 帯の幅(平面の単位): 窓ゴム / 窓の内側の見込み(上が明るい) / 化粧板のふちの影。
     * 中央ピラーは細いので、両側の帯の合計がピラー幅の 9割 をこえないよう縮める */
    const pillarW = (cx + cw * 0.52 - (cx - cw * 0.42)) * hw;
    const g0 = 0.0065 * hh, rv0 = 0.024 * hh, fb0 = 0.04 * hh;
    const sc = Math.min(1, (pillarW * 0.45) / (g0 + rv0 + 0.012 * hh));
    const fbC = Math.max(0.002 * hh, pillarW * 0.45 - (g0 + rv0) * sc);
    /* フリットの帯の幅(ガラスの内へ。下の辺は 35%)。u は ふちにそった長さ(帯の幅の2倍で1くりかえし) */
    const fritW = 0.034 * hh;
    const fr = newBuf(), sl = newBuf(), ft = newBuf();
    const holes = [];
    const ringFor = (win, side) => {
      const nrm = outwardNormals(win);
      /* 下の辺(下向き)は帯なし(天板と下のゴムがある)。中央ピラー側は細い帯 */
      const wb = nrm.map(([, ny]) => smooth(-0.95, -0.35, ny));
      const cen = nrm.map(([nx]) => smooth(0.3, 0.9, nx * side));
      const g = wb.map((w) => g0 * sc * w);
      const rv = wb.map((w) => rv0 * sc * w);
      const fb = wb.map((w, i) => w * (fb0 + (fbC - fb0) * cen[i]));
      const a1 = offsetPts(win, nrm, g);
      const a2 = offsetPts(win, nrm, g.map((v, i) => v + rv[i]));
      const a3 = offsetPts(win, nrm, g.map((v, i) => v + rv[i] + fb[i]));
      const yN = (p) => p[1] / hh;
      /* 窓ゴム(黒)。帯どうしは同じ平面で頂点を共有し、すき間ができないようにする */
      pushRing(sl, win, a1, z, win.map(() => [1, 1, 1]), a1.map(() => [1, 1, 1]));
      /* 見込み: 上の辺 ×1.45、横 ×1.15、下 ×0.7 */
      const rvK = (i) => { const ny = nrm[i][1]; return ny > 0 ? 1.15 + 0.3 * ny : 1.15 - 0.45 * -ny; };
      const cRv1 = a1.map((p, i) => { const k = lin(trimK(yN(p)) * rvK(i)); return [k, k, k]; });
      const cRv2 = a2.map((p, i) => { const k = lin(trimK(yN(p)) * rvK(i) * 0.94); return [k, k, k]; });
      pushRing(fr, a1, a2, z, cRv1, cRv2);
      /* 化粧板のふち: 見込みのきわ 0.75 → 外へ 1.0 */
      const cF1 = a2.map((p) => { const k = lin(trimK(yN(p)) * 0.75); return [k, k, k]; });
      const cF2 = a3.map((p) => { const k = lin(trimK(yN(p))); return [k, k, k]; });
      pushRing(fr, a2, a3, z, cF1, cF2);
      holes.push(a3);
      /* フリット: ガラスのふちから内へ。外のふち(窓ゴムとの さかい)は ゴムと同じ黒なので、
       * 見えるふちはテクスチャの網点のぼかしになる(ふちのギザギザが出ない) */
      const fw = wb.map((w) => -fritW * (0.35 + 0.65 * w));
      const inn = offsetPts(win, nrm, fw);
      const wo = win.concat([win[0]]), wi = inn.concat([inn[0]]);
      let acc = 0;
      /* v: ふち(窓ゴムがわ)=1(テクスチャの上のべた塗り) → 内=0(透明) */
      const uO = wo.map((p, i) => { if (i) acc += Math.hypot(p[0] - wo[i - 1][0], p[1] - wo[i - 1][1]); return [acc / (fritW * 2), 1]; });
      const uI = uO.map((u) => [u[0], 0]);
      const one = wo.map(() => [1, 1, 1]);
      pushRing(ft, wo, wi, z + 0.0005, one, one, uO, uI, true);
    };
    ringFor(winL, 1);
    ringFor(winR, -1);
    /* --- 枠の面(外の四角 − 2つの窓)を三角形に。色は上ほど暗い縦のグラデーションだけ --- */
    {
      const outer = [P(-1.05, yB), P(1.25, yB), P(1.25, 1.05), P(-1.05, 1.05)];
      const v2 = (p) => new THREE.Vector2(p[0], p[1]);
      const tris = THREE.ShapeUtils.triangulateShape(outer.map(v2), holes.map((h) => h.map(v2)));
      const all = outer.concat(...holes), base = fr.pos.length / 3;
      all.forEach((p) => { const k = lin(trimK(p[1] / hh)); fr.pos.push(p[0], p[1], z); fr.col.push(k, k, k); });
      tris.forEach((t) => fr.idx.push(base + t[0], base + t[1], base + t[2]));
    }
    /* 窓の下の端から端までのゴム(天板との継ぎ目を隠す) */
    {
      const base = sl.pos.length / 3;
      [P(-1.05, yB), P(1.25, yB), P(1.25, yG), P(-1.05, yG)].forEach((p) => { sl.pos.push(p[0], p[1], z + 0.001); sl.col.push(1, 1, 1); });
      sl.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    const frame = new THREE.Mesh(bufGeo(fr), this.matFrame);
    const seals = new THREE.Mesh(bufGeo(sl), this.matSeal);
    [frame, seals].forEach((m) => { m.renderOrder = 12; m.frustumCulled = false; this.root.add(m); });
    const frit = new THREE.Mesh(bufGeo(faceCamera(ft)), this.matFrit);
    frit.renderOrder = 12;
    frit.frustumCulled = false;
    this.root.add(frit);

    /* --- 遮光幕(運転士窓の上。枠のうしろ z -0.9005 に置き、窓の上のふちから 0.2 下まで。上の帯(HUD)の下に すそが見える) --- */
    {
      const zb = -0.9005, kz = zb / z;
      const yT = L.top + 0.02, yBt = L.top - 0.2;
      const xl = gl[3][0] * kz, xr = gl[2][0] * kz;
      const yt = yT * hh * kz, yb = yBt * hh * kz;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([xl, yb, zb, xr, yb, zb, xr, yt, zb, xl, yt, zb], 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], 3));
      g.setIndex([0, 1, 2, 0, 2, 3]);
      const blind = new THREE.Mesh(g, this.matBlind);
      blind.renderOrder = 12;
      blind.frustumCulled = false;
      this.root.add(blind);
      /* 雨つぶを描かない上のはし: 布と すその下のふち(ndc) */
      L.blindBot = yT - (yT - yBt) * ((BLIND.fabric + BLIND.hem) / 64);
    }

    /* --- 天板のうすい映り込み(運転士窓の下のほう。天板の絵を上下さかさに、加算で。夜は出さない) ---
     * 天板の奥の縁(画像の上 v=1)がガラスの下に、手前(v=0)が上に うつる。u は天板の横の位置にあわせる */
    {
      const zr = -0.95, kz = zr / z;
      const xl = gl[0][0] / hw, xr = gl[1][0] / hw;   // ndc
      const y0 = yG, y1 = yG + 0.16;
      const uOf = (xn) => (xn / 1.12 + 1) / 2;
      const vTop = 1 - 0.16 / Math.max(0.05, L.dash + 1.04);
      const pos = [xl * hw * kz, y0 * hh * kz, zr, xr * hw * kz, y0 * hh * kz, zr, xr * hw * kz, y1 * hh * kz, zr, xl * hw * kz, y1 * hh * kz, zr];
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute([uOf(xl), 1, uOf(xr), 1, uOf(xr), vTop, uOf(xl), vTop], 2));
      const k = 0.09;
      g.setAttribute('color', new THREE.Float32BufferAttribute([k, k, k, k, k, k, 0, 0, 0, 0, 0, 0], 3));
      g.setIndex([0, 1, 2, 0, 2, 3]);
      this.refl = new THREE.Mesh(g, this.matRefl);
      this.refl.renderOrder = 12;
      this.refl.frustumCulled = false;
      this.refl.visible = this._reflK > 0.02;
      this.root.add(this.refl);
    }

    /* --- 雪(窓の下のふち。ふちのでこぼこは決まった乱数で) --- */
    {
      const sb = newBuf();
      let seed = 3;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      [gl, gr].forEach((w) => {
        const x0 = w[0][0] / hw, x1 = Math.min(1.02, w[1][0] / hw), N = 28, base = sb.pos.length / 3;
        for (let i = 0; i <= N; i++) {
          const t = i / N, x = x0 + (x1 - x0) * t;
          const corner = Math.max(0, 1 - Math.min(t, 1 - t) / 0.12);
          const h = 0.028 + 0.05 * corner * corner + (rnd() - 0.5) * 0.012;
          const pb = P(x, yG - 0.004), pt = P(x, yG + Math.max(0.008, h));
          sb.pos.push(pb[0], pb[1], z + 0.0015, pt[0], pt[1], z + 0.0015);
          /* 下(ゴムぎわ)は影で灰色、上の縁は白(白い景色の前でも形がわかる) */
          sb.col.push(0.5, 0.53, 0.58, 1, 1, 1);
          if (i < N) { const a = base + i * 2; sb.idx.push(a, a + 1, a + 3, a, a + 3, a + 2); }
        }
      });
      this.sill = new THREE.Mesh(bufGeo(sb), this.matSill);
      this.sill.renderOrder = 14;
      this.sill.frustumCulled = false;
      this.sill.visible = this._sill > 0.01;
      this.root.add(this.sill);
    }

    /* --- 運転台の天板(3D: 奥の縁が L.dash、手前の縁は画面の下の端より少し下) ---
     * 画面に見えるぶんにテクスチャ全体がのるよう、手前の縁は画面の下(ndc -1.04)に置く */
    const zFar = -1.25;
    const yTop = L.dash * TAN * -zFar;
    const yN = yTop - 0.01;                       // 手前へわずかに下がる
    const zNear = yN / (1.04 * TAN);              // ndc y = -1.04 になる奥行き
    const hwFar = -zFar * TAN * aspect * 1.12;
    const hwN = -zNear * TAN * aspect * 1.2;
    const dp = [-hwFar, yTop, zFar, hwFar, yTop, zFar, hwN, yN, zNear, -hwN, yN, zNear];
    const dashShape = new THREE.BufferGeometry();
    dashShape.setAttribute('position', new THREE.Float32BufferAttribute(dp, 3));
    /* UV: 奥の縁(窓の下)が画像の上側。dp の頂点順(奥左・奥右・手前右・手前左)に合わせる */
    dashShape.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 0], 2));
    /* 奥ほど暗く(0.82)、手前は計器盤の上端と同じ(1.0) */
    dashShape.setAttribute('color', new THREE.Float32BufferAttribute([0.82, 0.82, 0.82, 0.82, 0.82, 0.82, 1, 1, 1, 1, 1, 1], 3));
    dashShape.setIndex([0, 2, 1, 0, 3, 2]);
    const dash = new THREE.Mesh(dashShape, this.matDash);
    dash.renderOrder = 12;
    dash.frustumCulled = false;
    this.root.add(dash);
    /* 天板の奥の縁(窓下の見切り) */
    const lip = new THREE.Mesh(new THREE.BoxGeometry(hwFar * 2, 0.035, 0.05), this.matDashEdge);
    lip.position.set(0, yTop + 0.012, zFar - 0.01);
    lip.renderOrder = 12;
    this.root.add(lip);

    /* 天板の上の (u,v) の点を 3Dへ(天板の三角形(奥左・手前右・奥右 / 奥左・手前左・手前右)の割合で) */
    const V = (i) => [dp[i * 3], dp[i * 3 + 1], dp[i * 3 + 2]];
    const fl = V(0), fR = V(1), nr = V(2), nl = V(3);
    const onDash = (u, v) => {
      let a, b, A, B;
      if (u + v >= 1) { a = 1 - v; b = u - a; A = nr; B = fR; }
      else { b = u; a = 1 - v - u; A = nl; B = nr; }
      return [0, 1, 2].map((k) => fl[k] + a * (A[k] - fl[k]) + b * (B[k] - fl[k]));
    };
    const quad = (cps, mat, order) => {
      const pos = [];
      cps.forEach((p) => pos.push(p[0], p[1], p[2]));
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], 3));
      const b = { pos, idx: [0, 1, 2, 0, 2, 3], col: [], uv: [] };
      faceCamera(b);
      g.setIndex(b.idx);
      const m = new THREE.Mesh(g, mat);
      m.renderOrder = order;
      m.frustumCulled = false;
      this.root.add(m);
      return m;
    };

    /* --- 日だまり: 天板の まん中に のせた 横長の だ円(加算)。update() で 横へ すべらせ、こさを かえる --- */
    {
      const v0 = 0.12, v1 = 0.92, u0 = 0.3, u1 = 0.7, lift = 0.0008;
      const cps = [onDash(u0, v0), onDash(u1, v0), onDash(u1, v1), onDash(u0, v1)];
      cps.forEach((p) => { p[1] += lift; });
      this.sunPatch = quad(cps, this.matSun, 12);
      this.sunPatch.visible = this.sunK > 0.005;
      this._hwFar = hwFar;
      this._sunPX = NaN;
    }

    /* --- 立てた時刻表(上に 時:分)。台(天板の絵の みぞ)から 少し うしろへ ねかせて立てる。
     * 縦長の画面では けいてきボタンの下になるので置かない --- */
    this.staff = null;
    if (!narrow) {
      const pl = onDash(STAFF.u0, STAFF.v), pr = onDash(STAFF.u1, STAFF.v);
      const H = Math.hypot(pr[0] - pl[0], pr[2] - pl[2]) * (STAFF_H / STAFF_W);
      const dy = H * Math.cos(STAFF.lean), dz = -H * Math.sin(STAFF.lean);
      this.staff = quad([pl, pr, [pr[0], pr[1] + dy, pr[2] + dz], [pl[0], pl[1] + dy, pl[2] + dz]], this.matClock, 13);
    }

    /* --- ワイパー(根元は運転士窓の右下。休止位置は窓の下のゴムに沿って寝ている) --- */
    const pivotNdc = [cx - cw * 0.9, L.dash + 0.024];
    const zw = -1.0;
    const hwW = -zw * TAN * aspect, hhW = -zw * TAN;
    this.wiper = new THREE.Group();
    this.wiper.position.set(pivotNdc[0] * hwW, pivotNdc[1] * hhW, zw);
    const armLen = hhW * 1.2;
    /* 腕: 根元 0.012 → 0.55 のところで 0.007 まで細くなる板(先は同じ太さ)。
     * ブレード: 腕の上(窓がわ z -0.008)に べつの背骨(上のふちが明るい)・腕とつなぐ金具2つ・背骨の上のゴム。
     * 光の当たらない材質なので、頂点色で上のふちほど明るくして 平らな黒い棒に見えないように。
     * ゴムも同じ材質(頂点色で #050506 の暗さ)にまとめて 1回で描く(細いゴムだけの箱は ふちが点線のようにちらつく) */
    const armBox = new THREE.BoxGeometry(armLen * 0.95, 0.012, 0.01);
    armBox.translate(-armLen * 0.475, 0, 0);
    {
      const p = armBox.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const t = Math.min(1, -p.getX(i) / (armLen * 0.55));
        p.setY(i, p.getY(i) * (1 - t * (1 - 0.007 / 0.012)));
      }
    }
    const bladeX = -armLen * 0.55, bladeL = armLen * 0.85, bY = 0.0125;
    const kR = Math.pow(s2l(COL.rubber[0]) / s2l(COL.wiper[0]), 1 / 2.2);   // ゴムの暗さ(見た目の比率)
    const armGeo = mergeParts([
      { geo: armBox, m: I4, k: [1.3, 2.4] },
      { geo: new THREE.CylinderGeometry(0.022, 0.024, 0.02, 12), m: mat4(0, 0, 0, Math.PI / 2), k: [1.4, 1.4] },
      { geo: new THREE.BoxGeometry(bladeL, 0.010, 0.006), m: mat4(bladeX, bY, -0.008), k: [2.0, 4.2] },
      { geo: new THREE.BoxGeometry(0.03, 0.012, 0.006), m: mat4(bladeX - bladeL * 0.2, bY * 0.55, -0.004), k: [1.6, 3.0] },
      { geo: new THREE.BoxGeometry(0.03, 0.012, 0.006), m: mat4(bladeX + bladeL * 0.2, bY * 0.55, -0.004), k: [1.6, 3.0] },
      { geo: new THREE.BoxGeometry(bladeL * 0.98, 0.0045, 0.005), m: mat4(bladeX, bY + 0.00725, -0.0085), k: [kR, kR] },
    ]);
    const arm = new THREE.Mesh(armGeo, this.matWiper);
    /* 根元のメッキのキャップ */
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.03, 12), this.matChrome);
    cap.rotation.x = Math.PI / 2;
    cap.position.z = 0.006;
    this.wiper.add(arm, cap);
    this.wiper.traverse((o) => { o.renderOrder = 13; });
    this.wiper.rotation.z = -this.wiperAng;
    this.root.add(this.wiper);
    this._wiperLen = armLen;
    this._bladeX = bladeX; this._bladeL = bladeL; this._bladeY = bY;
    this._pivotNdc = pivotNdc;
    this._wFeather = null;
    this._buildWiperFeather();
    this._rects = null;
    this._sheenVars(L);
  }

  /* ワイパーのふちの ぼかしの帯(腕の下のふち・ブレードの上のふち。描画バッファの1.5画素の幅) */
  _buildWiperFeather() {
    if (!this.wiper || !(this._dbH > 0)) return;
    if (this._wFeather) { this.wiper.remove(this._wFeather); this._wFeather.geometry.dispose(); this._wFeather = null; }
    const L = this._wiperLen, w = (1.5 * 2 / this._dbH) * 1.0 * TAN;   // z=-1 の平面での 1.5画素
    const half = (x) => 0.006 * (1 - Math.min(1, -x / (L * 0.55)) * (1 - 0.007 / 0.012));
    const b = newBuf();
    const zf = 0.0055;
    /* 腕の下のふち: 根元から先まで 8つに区切る(細くなるので) */
    const N = 8, x1 = -L * 0.95;
    for (let i = 0; i <= N; i++) {
      const x = (x1 * i) / N, y = -half(x);
      b.pos.push(x, y, zf, x, y - w, zf);
      b.uv.push(0, 1, 0, 0);   // ふち=1(不透明) → 外=0(透明)
      const c = lin(1.3);
      b.col.push(c, c, c, c, c, c);
      if (i < N) { const a = i * 2; b.idx.push(a, a + 1, a + 3, a, a + 3, a + 2); }
    }
    /* ブレードの上のふち(ゴムの上) */
    {
      const base = b.pos.length / 3, yT = this._bladeY + 0.0095, xa = this._bladeX - this._bladeL / 2, xb = this._bladeX + this._bladeL / 2;
      b.pos.push(xa, yT, -0.002, xb, yT, -0.002, xb, yT + w, -0.002, xa, yT + w, -0.002);
      b.uv.push(0, 1, 0, 1, 0, 0, 0, 0);
      /* ゴム(#050506)の色: ワイパーの色(#0c0d0f)に対するリニアの比 */
      const c = s2l(COL.rubber[0]) / s2l(COL.wiper[0]);
      for (let k = 0; k < 4; k++) b.col.push(c, c, c);
      b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    const m = new THREE.Mesh(bufGeo(faceCamera(b)), this.matFeather);
    m.renderOrder = 13;
    m.frustumCulled = false;
    this._wFeather = m;
    this.wiper.add(m);
  }

  /* フロントガラスの映り込み(#glass-sheen)の帯の位置を 窓の上のふち・天板の奥の縁にあわせる(CSS の calc で使う) */
  _sheenVars(L) {
    if (typeof document === 'undefined') return;
    const el = document.getElementById('glass-sheen');
    if (!el) return;
    el.style.setProperty('--gl-top', (((1 - L.top) / 2) * 100).toFixed(2) + '%');
    el.style.setProperty('--gl-bot', (((1 + L.dash) / 2) * 100).toFixed(2) + '%');
  }

  /* 雨滴を描く範囲(画面の正規化座標 0..1, 左上原点)と角の丸み(rTop/rBot: 画面の高さに対する比)。
   * 窓の形はななめの辺があるので、かならずガラスの内側になるよう内寄りの四角にする。
   * 運転士窓は遮光幕の下から(幕の上には描かない)。作りなおしたときだけ新しい配列(毎フレーム同じものを返す) */
  windowRects() {
    const L = this.layout;
    if (!L) return null;
    if (this._rects && this._rectsL === L) return this._rects;
    const toU = (x) => (x + 1) / 2, toV = (y) => (1 - y) / 2;
    const ap = L.aPillar, cx = L.cX, cw = L.cW, m = 0.004;
    this._rectsL = L;
    this._rects = [
      { x0: toU(-1 + ap + m), x1: toU(cx - cw * 0.5 - m), y0: toV(L.blindBot != null ? L.blindBot : L.top), y1: toV(L.dash + 0.012), rTop: 0, rBot: L.rBot },
      { x0: toU(cx + cw * 0.62 + m), x1: 1, y0: toV(L.top), y1: toV(L.dash + 0.012), rTop: L.rTop, rBot: L.rBot },
    ];
    return this._rects;
  }

  /* ワイパーの根元・長さ(画面の高さに対する比)・角度・ブレードの帯(腕の中心から 下 b0 〜 上 b1。画面の高さに対する比)。
   * 毎フレーム呼ばれるので同じ箱を書きかえて返す */
  wiperScreen() {
    if (!this.layout) return null;
    const o = this._wpS || (this._wpS = { px: 0, py: 0, len: 0, ang: 0, b0: 0, b1: 0 });
    o.px = (this._pivotNdc[0] + 1) / 2;
    o.py = (1 - this._pivotNdc[1]) / 2;
    o.len = (this._wiperLen / TAN) / 2;   // ndcでの腕の長さ(縦基準)
    o.ang = this.wiperAng;
    o.b0 = -0.0075 / TAN / 2;
    o.b1 = (this._bladeY + 0.011) / TAN / 2;
    return o;
  }

  /* 映り込み用の 小さな天板の絵 */
  _updRefl() {
    const c = this._reflCv.getContext('2d');
    c.clearRect(0, 0, 128, 16);
    c.drawImage(this._dashC.canvas, 0, 0, 128, 16);
    this._reflTex.needsUpdate = true;
  }

  /* 立てた時刻表: 運転の停車駅の名前・つく時刻(時:分の文字)と つぎに止まる駅の番号。かわったときだけ描きなおす */
  setTimetable(names, idx, times) {
    if (!this._staffC) return;
    const key = (names ? names.join('|') : '') + '/' + (times ? times.join('|') : '');
    if (key === this._ttKey && idx === this._ttIdx) return;
    this._ttKey = key; this._ttIdx = idx;
    this._tt = names && names.length ? { names, times: times || null, idx: Math.max(0, idx | 0) } : null;
    drawStaff(this._staffC, this._clockMin, this._tt);
    this._staffTex.needsUpdate = true;
  }

  /* 明るさが変わったときだけ、各部の色を計器盤と同じ式で決めなおす */
  _shadeMat(m, col, l) {
    const s = shade(col, l == null ? this.light : l, this._tmpS);
    m.color.setRGB(s[0], s[1], s[2], THREE.SRGBColorSpace);
  }

  /* テクスチャの地の色 base が shade(col, l) になる倍率(リニア)を c に */
  _ratio(c, col, base, l) {
    const s = shade(col, l, this._tmpS);
    c.setRGB(s2l(s[0]) / s2l(base[0]), s2l(s[1]) / s2l(base[1]), s2l(s[2]) / s2l(base[2]), THREE.LinearSRGBColorSpace);
    return c;
  }

  _applyShade() {
    const l = this.light, s = this._tmpS, c = this._tmpC;
    /* 枠・天板は トンネルの灯具の明かり(flash)も足す。色み(tint)は枠と遮光幕だけ(計器盤とのさかいに色の段がつかない) */
    const lf = Math.min(1, l + this.flash);
    shade(COL.frame, lf, s);
    this.matFrame.color.setRGB(s[0] * this._tR, s[1] * this._tG, s[2] * this._tB, THREE.SRGBColorSpace);
    this._shadeMat(this.matSeal, COL.seal);
    this._shadeMat(this.matFrit, COL.seal);
    this._shadeMat(this.matDashEdge, COL.dashEdge, lf);
    this._shadeMat(this.matWiper, COL.wiper);
    this._shadeMat(this.matFeather, COL.wiper);
    this._shadeMat(this.matRubber, COL.rubber);
    this._shadeMat(this.matChrome, COL.chrome);
    this._shadeMat(this.matSill, COL.snow);
    /* 天板・時計: テクスチャの地(#2a2e31)が shade('#2c3237') になる倍率(リニア) */
    this.matDash.color.copy(this._ratio(c, COL.dash, COL.dashBase, lf));
    this.matClock.color.copy(c);
    /* 遮光幕: すそ(#2b3034)が枠と同じ式で暗くなる倍率 × 色み */
    this._ratio(c, COL.hem, COL.hem, lf);
    this.matBlind.color.setRGB(c.r * lin(this._tR), c.g * lin(this._tG), c.b * lin(this._tB), THREE.LinearSRGBColorSpace);
    /* 映り込み: 明るいほど(夜・トンネルは出さない) */
    const rk = Math.min(1, Math.max(0, (l - 0.3) / 0.7));
    this._reflK = rk;
    this.matRefl.color.setRGB(rk, rk, rk, THREE.LinearSRGBColorSpace);
    if (this.refl) this.refl.visible = rk > 0.02;
    this._shadeL = l;
    this._shadeF = this.flash;
    this._shadeT[0] = this._tR; this._shadeT[1] = this._tG; this._shadeT[2] = this._tB;
  }

  /* light: 0..1 室内の明るさ(計器盤 #cab の減光にも使う: cab.setLight)
   * flash: トンネルの灯具の速い明かり(なめらかにしない。枠と天板だけ) / tr,tg,tb: 枠の色み(見た目の比率)
   * wiper: false / true / 'on' / 'int'(5秒休んで1回ふく)。snow: 目が外の雪の中にいる / clockMin: 天板の時計(分) */
  update(dt, opt) {
    const o = opt || {};
    const light = o.light == null ? 1 : o.light;
    const wiper = o.wiper === 'int' ? 'int' : o.wiper ? 'on' : false;
    /* なめらかに追従(時定数0.33秒)。dt は描画側で0.1秒に切られるので、
     * 描画が重い端末でも実時間で追いつくよう経過時間の大きいほうを使う */
    const now = typeof performance !== 'undefined' ? performance.now() : 0;
    const rdt = this._lt != null ? Math.min(2, (now - this._lt) / 1000) : dt;
    this._lt = now;
    const a = Math.min(1, Math.max(dt, rdt) * 3);
    this.light += (light - this.light) * a;
    if (Math.abs(this.light - light) < 0.002) this.light = light;
    this.flash = o.flash > 0 ? o.flash : 0;
    /* 枠の色みも同じ速さで(トンネルに入ったとき色がぱっと変わらない) */
    const tr = o.tr > 0 ? o.tr : 1, tg = o.tg > 0 ? o.tg : 1, tb = o.tb > 0 ? o.tb : 1;
    this._tR += (tr - this._tR) * a; this._tG += (tg - this._tG) * a; this._tB += (tb - this._tB) * a;
    if (Math.abs(this._tR - tr) + Math.abs(this._tG - tg) + Math.abs(this._tB - tb) < 0.002) { this._tR = tr; this._tG = tg; this._tB = tb; }
    const T = this._shadeT;
    const tintMoved = Math.abs(this._tR - T[0]) > 0.003 || Math.abs(this._tG - T[1]) > 0.003 || Math.abs(this._tB - T[2]) > 0.003
      || ((this._tR !== T[0] || this._tG !== T[1] || this._tB !== T[2]) && this._tR === tr && this._tG === tg && this._tB === tb);
    if (Math.abs(this.light - this._shadeL) > 0.005 || (this.light === light && this._shadeL !== light)
      || Math.abs(this.flash - this._shadeF) > 0.005 || (this.flash === 0 && this._shadeF !== 0) || tintMoved) this._applyShade();
    /* 立てた時刻表の 時:分: 分が変わったときだけ描きなおす */
    if (o.clockMin != null && o.clockMin !== this._clockMin) {
      this._clockMin = o.clockMin;
      drawStaff(this._staffC, o.clockMin, this._tt);
      this._staffTex.needsUpdate = true;
    }
    /* 日だまり: こさ(sunK)・横の位置(sunX)を 明るさと同じ速さで追いかける。
     * 色(加算: 見た目で k×0.16)と位置は 変わったときだけ書く */
    {
      const kT = o.sunK > 0 ? Math.min(1, o.sunK) : 0;
      const xT = o.sunX > 1 ? 1 : o.sunX < -1 ? -1 : (o.sunX || 0);
      this.sunK += (kT - this.sunK) * a;
      this.sunX += (xT - this.sunX) * a;
      if (Math.abs(this.sunK - kT) < 0.002) this.sunK = kT;
      if (Math.abs(this.sunX - xT) < 0.002) this.sunX = xT;
      if (this.sunPatch) {
        const vis = this.sunK > 0.005;
        if (this.sunPatch.visible !== vis) this.sunPatch.visible = vis;
        if (vis) {
          /* 見た目(sRGB)で k×0.16(加算なので 画面では +35 ほど)。昼は あたたかい白、夕方は だいだい */
          const cc = this.sunK * 0.16, eve = !!o.sunEve;
          if (Math.abs(cc - this._sunC) > 0.0005 || eve !== this._sunEve) {
            this._sunC = cc; this._sunEve = eve;
            this.matSun.color.setRGB(cc, cc * (eve ? 0.7 : 0.9), cc * (eve ? 0.42 : 0.72), THREE.SRGBColorSpace);
          }
          const px = this.sunX * (this._hwFar || 1) * 0.6;
          if (!(Math.abs(px - this._sunPX) < 0.001)) { this._sunPX = px; this.sunPatch.position.x = px; }
        }
      }
    }
    /* 雪: 外にいるあいだ20秒かけて積もり、屋内・雪なしでは8秒でとける。
     * 雪の日の運転のはじめ(1分以上 雪を見ていなかった)は、もう少し積もっているところから
     * (運転開始の暗転の中の1コマ(dt=0)でも決めて、雪のシェーダを暗転の中で作らせる) */
    const want = o.snow ? 1 : 0;
    if (want && this._noSnowT > 60) this._sill = Math.max(this._sill, 0.6);
    if (want) this._noSnowT = 0;
    if (dt > 0) {
      if (!want) this._noSnowT += dt;
      this._sill += (want - this._sill) * Math.min(1, dt / (want ? 20 : 8));
      if (!want && this._sill < 0.01) this._sill = 0;
    }
    if (this.sill) {
      const vis = this._sill > 0.01;
      if (this.sill.visible !== vis) this.sill.visible = vis;
      if (vis) this.matSill.opacity = Math.min(0.92, this._sill);
    }
    /* ワイパー: 1往復1.4秒。'int' は5秒休んでから1往復。止めるときは往復の終わり(位相が一周した)で止める。
     * 両はしで少し止まる(smoothstep 2つ: 0.08〜0.42 で上がり、0.58〜0.92 で もどる) */
    if (wiper === 'on') this.wiperOn = true;
    else if (wiper === 'int' && !this.wiperOn) {
      this._rest += dt;
      if (this._rest >= 5) { this.wiperOn = true; this.wiperT = 0; this._ph0 = 0; }
    }
    if (this.wiperOn) {
      this.wiperT += dt;
      const ph = (this.wiperT % 1.4) / 1.4;
      if (wiper !== 'on' && ph < this._ph0) {
        this.wiperOn = false; this.wiperT = 0; this._ph0 = 0; this._rest = 0;
        this.wiperAng = this.wiperRest;
      } else {
        this._ph0 = ph;
        const swing = smooth(0.08, 0.42, ph) - smooth(0.58, 0.92, ph);
        this.wiperAng = this.wiperRest + swing * 1.55;
      }
    } else {
      this.wiperAng = this.wiperRest;
      if (wiper !== 'int') this._rest = 0;
    }
    if (this.wiper) this.wiper.rotation.z = -this.wiperAng;
  }
}
