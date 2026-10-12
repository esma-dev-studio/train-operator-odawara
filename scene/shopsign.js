/* =========================================================
 * scene/shopsign.js — 店の看板(かな文字の一般的なことばだけ。店名・会社名は使わない)
 *
 * ・1024x512 の1枚の画像にまとめる: 上半分=横長の看板(256x64)16マス / 下半分=縦長の袖看板(64x256)13マスと、
 *   のこりの 192x256 に 通りの小物の絵(自動販売機の前の面2種・「止まれ」の逆三角・最高速度30の丸)。
 *   自動販売機に会社の名前・ロゴは かかない(白い板に飲み物の点が3段・お金を入れる所の暗い帯)。
 * ・看板の板は 1000m ごとに1つの形に焼きこむ(描画は1回)。板の表だけ夜に光る(頂点の自発光フラグ stE)。
 *   自動販売機の前の面も光る。道路の標識は光らない(裏は灰色)。
 * ・材質は線路わきの標識(signage.js の boardAtlas)と同じ部品・同じキー 'st-lineside' なので、
 *   新しいシェーダはできない。昼夜は emissiveIntensity だけを変える(town.js の applyLook)。
 * ========================================================= */
import * as THREE from '../vendor/three.module.min.js';
import { FONT, redrawWhenFonts } from './signage.js';

export const SIGN_WORDS = ['くすり', 'クリーニング', 'パン', 'ラーメン', 'そば', 'やきとり', 'はいしゃ', 'ふどうさん',
  'コーヒー', 'ほんや', 'さかな', 'やおや', 'コインランドリー', 'びよういん', 'じゅく', 'ちゅうしゃじょう'];
/* [地の色, 文字の色] */
const PAIRS = [['#1f4e8c', '#ffffff'], ['#b3261e', '#ffffff'], ['#f2c230', '#222222'], ['#2d6b3c', '#ffffff'], ['#ffffff', '#333333']];
const W = 1024, H = 512;
/* 袖看板のマスの数(のこりの 192x256 は通りの小物の絵) */
const BLADES = 13;
/* 通りの小物の絵の場所(画素): 自動販売機の前の面2種(64x128)・止まれ(128x128)・30(128x128) */
const FURN = { jihanki: [[832, 256, 64, 128], [832, 384, 64, 128]], tomare: [896, 256, 128, 128], sp30: [896, 384, 128, 128] };
/* 止まれ の逆三角(画素。左上・右上・下)と 30 の丸(中心・半径) */
const TRI = [[900, 262], [1020, 262], [960, 372]];
const DISC = [960, 448, 58];

let _cv = null;
function atlasCanvas() {
  if (_cv) return _cv;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  drawAtlas(cv.getContext('2d'));
  _cv = cv;
  return cv;
}
function drawAtlas(c) {
  c.clearRect(0, 0, W, H);
  c.textAlign = 'center'; c.textBaseline = 'middle';
  /* 横長の看板 256x64(4列×4段) */
  SIGN_WORDS.forEach((word, i) => {
    const [bg, fg] = PAIRS[(i * 3) % PAIRS.length];
    const x = (i % 4) * 256, y = Math.floor(i / 4) * 64;
    c.fillStyle = bg; c.fillRect(x, y, 256, 64);
    /* 白い看板は上下に色の帯(地味な業務用の看板らしく) */
    if (bg === '#ffffff') { c.fillStyle = i % 2 ? '#1f4e8c' : '#b3261e'; c.fillRect(x, y + 4, 256, 5); c.fillRect(x, y + 55, 256, 5); }
    c.strokeStyle = 'rgba(0,0,0,.35)'; c.lineWidth = 3; c.strokeRect(x + 1.5, y + 1.5, 253, 61);
    c.fillStyle = fg;
    const size = 40;
    c.font = `700 ${size}px ${FONT}`;
    const tw = c.measureText(word).width;
    const k = Math.min(1, 228 / Math.max(1, tw));
    c.save();
    c.translate(x + 128, y + 33);
    c.scale(k, 1);
    c.fillText(word, 0, 0);
    c.restore();
  });
  /* 縦長の袖看板 64x256(13列×1段)。のばし棒は縦書きの形に */
  SIGN_WORDS.forEach((word, j) => {
    if (j >= BLADES) return;
    const [bg, fg] = PAIRS[(j * 3 + 2) % PAIRS.length];
    const x = j * 64, y = 256;
    c.fillStyle = bg; c.fillRect(x, y, 64, 256);
    if (bg === '#ffffff') { c.fillStyle = j % 2 ? '#b3261e' : '#1f4e8c'; c.fillRect(x + 4, y, 5, 256); c.fillRect(x + 55, y, 5, 256); }
    c.strokeStyle = 'rgba(0,0,0,.35)'; c.lineWidth = 3; c.strokeRect(x + 1.5, y + 1.5, 61, 253);
    const chars = Array.from(word);
    const step = Math.min(46, 236 / chars.length);
    const size = Math.min(40, step * 0.92);
    c.font = `700 ${size}px ${FONT}`;
    c.fillStyle = fg;
    const y0 = y + 128 - (step * chars.length) / 2;
    chars.forEach((ch, k) => {
      const cy = y0 + step * (k + 0.5);
      if (ch === 'ー') c.fillRect(x + 32 - size * 0.06, cy - size * 0.38, size * 0.12, size * 0.76);
      else c.fillText(ch, x + 32, cy + 1);
    });
  });
  drawFurniture(c);
}

/* 通りの小物の絵 */
function drawFurniture(c) {
  /* 自動販売機の前の面(64x128 = 0.92x1.6m)。上の6割は飲み物の見本が3段(明るい窓)、その下にボタンの点、
   * お金を入れる所の暗い帯、いちばん下に取り出し口。v: 0=白 1=うすい灰青 */
  FURN.jihanki.forEach(([x, y, w, h], v) => {
    c.fillStyle = v ? '#d9e0e6' : '#f1f2ef'; c.fillRect(x, y, w, h);
    c.fillStyle = 'rgba(0,0,0,.18)'; c.fillRect(x, y, 3, h); c.fillRect(x + w - 3, y, 3, h);
    c.fillStyle = '#fbfbf6'; c.fillRect(x + 5, y + 6, w - 10, 66);
    const BOT = ['#c8392e', '#2f6db3', '#e8b73a', '#3f9a52', '#ece7dc', '#7a4a2c', '#e07a2e', '#5aa0c8'];
    for (let row = 0; row < 3; row++) {
      const ry = y + 9 + row * 21;
      for (let k = 0; k < 6; k++) {
        c.fillStyle = BOT[(row * 5 + k * 3 + v * 2) % BOT.length];
        c.fillRect(x + 7 + k * 8.5, ry, 6, 13);
        c.fillStyle = 'rgba(255,255,255,.55)'; c.fillRect(x + 8 + k * 8.5, ry + 1, 1.5, 9);
        c.fillStyle = k % 2 ? '#2a8a3a' : '#c43a2e'; c.fillRect(x + 8 + k * 8.5, ry + 15, 3, 2);   // ボタンの点
      }
    }
    c.fillStyle = '#34383b'; c.fillRect(x + 5, y + 76, w - 10, 9);
    c.fillStyle = '#9aa3a8'; c.fillRect(x + w - 16, y + 78, 8, 5);
    c.fillStyle = '#202326'; c.fillRect(x + 8, y + 104, w - 16, 14);
    c.fillStyle = 'rgba(255,255,255,.25)'; c.fillRect(x + 8, y + 104, w - 16, 1);
  });
  /* 止まれ(赤い逆三角・白いふち・白い字)。マスの地は白(縮小したときにふちが暗くにじまない)。左下のすみは標識の裏の灰色 */
  {
    const [x, y, w, h] = FURN.tomare;
    c.fillStyle = '#f4f4f0'; c.fillRect(x, y, w, h);
    c.fillStyle = '#8c9094'; c.fillRect(x, y + h - 18, 18, 18);
    const tri = (pts, col) => { c.fillStyle = col; c.beginPath(); c.moveTo(pts[0][0], pts[0][1]); c.lineTo(pts[1][0], pts[1][1]); c.lineTo(pts[2][0], pts[2][1]); c.closePath(); c.fill(); };
    tri(TRI, '#f4f4f0');
    tri([[TRI[0][0] + 11, TRI[0][1] + 6], [TRI[1][0] - 11, TRI[1][1] + 6], [TRI[2][0], TRI[2][1] - 13]], '#c4161c');
    c.fillStyle = '#ffffff';
    c.font = `700 22px ${FONT}`;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText('止まれ', x + 64, y + 31);
  }
  /* 最高速度30(白い地・赤い輪・青い数字)。マスの地は輪の赤 */
  {
    const [x, y, w, h] = FURN.sp30;
    c.fillStyle = '#c4161c'; c.fillRect(x, y, w, h);
    const [cx, cy, r] = DISC;
    c.fillStyle = '#c4161c'; c.beginPath(); c.arc(cx, cy, r + 4, 0, 7); c.fill();
    c.fillStyle = '#f6f6f2'; c.beginPath(); c.arc(cx, cy, r - 12, 0, 7); c.fill();
    c.fillStyle = '#1d4f9c';
    c.font = `700 52px ${FONT}`;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.save(); c.translate(cx, cy + 2); c.scale(0.86, 1.12); c.fillText('30', 0, 0); c.restore();
  }
}

/* 材質(RailScene ごとに1回)。onBeforeCompile は signage.js boardAtlas() と一字一句同じ(キー 'st-lineside' を共有) */
export function signMaterial(rs) {
  if (rs._signMatP1) return rs._signMatP1;
  const cv = atlasCanvas();
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  /* Webフォントが後から届いたら1回だけ描き直す */
  tex.userData.redraw = () => { drawAtlas(cv.getContext('2d')); tex.needsUpdate = true; };
  redrawWhenFonts(tex, SIGN_WORDS.join('') + '止まれ30');
  const mat = new THREE.MeshStandardMaterial({
    map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0, roughness: 0.6, vertexColors: true,
    envMapIntensity: 0.3,
  });
  mat.name = 'st-lineside';
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float stE;\nvarying float vStE;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvStE = stE;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vStE;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= vStE;');
  };
  mat.customProgramCacheKey = () => 'st-lineside';
  rs._keep.add(mat); rs._keep.add(tex);
  rs._signMatP1 = mat;
  return mat;
}

/* 画像の中のマスの UV([u0,v0,u1,v1]。v は下から) と、ふち用の「地の色」の1点 */
function cellUV(kind, i) {
  if (kind === 'jihanki') {
    const [x, y, w, h] = FURN.jihanki[i % 2];
    return { uv: [(x + 1) / W, 1 - (y + h - 1) / H, (x + w - 1) / W, 1 - (y + 1) / H], edge: [(x + 4) / W, 1 - (y + 100) / H] };
  }
  if (kind === 'blade') {
    const x = (i % BLADES) * 64, y = 256;
    return { uv: [(x + 1) / W, 1 - (y + 255) / H, (x + 63) / W, 1 - (y + 1) / H], edge: [(x + 20) / W, 1 - (y + 6) / H] };
  }
  const x = (i % 4) * 256, y = Math.floor((i % 16) / 4) * 64;
  return { uv: [(x + 1) / W, 1 - (y + 63) / H, (x + 255) / W, 1 - (y + 1) / H], edge: [(x + 10) / W, 1 - (y + 12) / H] };
}

/* 焼きこみ用のバッファ(500mごと) */
function newBuf() { return { P: [], N: [], U: [], E: [], I: [], n: 0 }; }
/* 四角形: 中心 c、右 r(単位)、上 u(単位)、法線 n、幅 w・高さ h、uv=[u0,v0,u1,v1] または 1点 */
function quad(b, cx, cy, cz, rx, ry, rz, ux, uy, uz, nx, ny, nz, w, h, uv, e) {
  const base = b.n;
  [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([sx, sy]) => {
    b.P.push(cx + rx * sx * w / 2 + ux * sy * h / 2, cy + ry * sx * w / 2 + uy * sy * h / 2, cz + rz * sx * w / 2 + uz * sy * h / 2);
    b.N.push(nx, ny, nz);
    if (uv.length === 4) b.U.push(sx < 0 ? uv[0] : uv[2], sy < 0 ? uv[1] : uv[3]);
    else b.U.push(uv[0], uv[1]);
    b.E.push(e);
  });
  b.I.push(base, base + 1, base + 2, base, base + 2, base + 3);
  b.n += 4;
}

/* 平らな多角形(表と、少し後ろに裏)。pts: 板の上の点 [右, 上](m)・uvs: 画素の点。裏は灰色の1点 */
const BACK_UV = [(FURN.tomare[0] + 6) / W, 1 - (FURN.tomare[1] + FURN.tomare[3] - 6) / H];
function flatSign(b, cx, cy, cz, fx, fz, pts, uvs, e) {
  const rx = fz, rz = -fx;   // 右 = 上 × 表
  const n = pts.length;
  [1, -1].forEach((side) => {
    const base = b.n;
    const o = side > 0 ? 0.004 : -0.004;
    for (let k = 0; k < n; k++) {
      const [pr, pu] = pts[k];
      b.P.push(cx + rx * pr + fx * o, cy + pu, cz + rz * pr + fz * o);
      b.N.push(fx * side, 0, fz * side);
      if (side > 0) b.U.push(uvs[k][0] / W, 1 - uvs[k][1] / H); else b.U.push(BACK_UV[0], BACK_UV[1]);
      b.E.push(side > 0 ? e : 0);
    }
    /* 扇形(0番の点から)。表は 右×上 で反時計回り、裏は逆回り */
    for (let k = 1; k < n - 1; k++) {
      if (side > 0) b.I.push(base, base + k, base + k + 1);
      else b.I.push(base, base + k + 1, base + k);
    }
    b.n += n;
  });
}
/* 止まれ(逆三角: 上の辺 w・高さ h)と 30(丸: 直径 w) */
function roadSign(b, it) {
  if (it.kind === 'tomare') {
    const w = it.w, h = it.h;
    flatSign(b, it.x, it.y, it.z, it.fx, it.fz, [[-w / 2, h / 2], [0, -h / 2], [w / 2, h / 2]], [TRI[0], TRI[2], TRI[1]], 0);
    return;
  }
  const r = it.w / 2, pts = [], uvs = [];
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
    uvs.push([DISC[0] + Math.cos(a) * DISC[2], DISC[1] - Math.sin(a) * DISC[2]]);
  }
  flatSign(b, it.x, it.y, it.z, it.fx, it.fz, pts, uvs, 0);
}

/* 箱の看板: 中心 c、表の向き f=(fx,fz)(水平)、横 w・高さ h・厚み d。
 * 面ごとに「右 × 上 = 法線」になるように右・上を選ぶ(文字が鏡うつしにならず、表が外を向く)。
 * kind: 'fascia'=表だけ文字 / 'blade'=袖看板(f は壁から外へ突き出す向き。文字は左右の2面) */
function signBox(b, cx, cy, cz, fx, fz, w, h, d, cell, kind) {
  const C = cellUV(kind, cell);
  const E = C.edge;
  const rx = fz, rz = -fx;   // 右 = 上 × 表
  if (kind === 'jihanki') {
    /* 自動販売機の前の面(箱の前に1枚。夜は光る) */
    quad(b, cx, cy, cz, rx, 0, rz, 0, 1, 0, fx, 0, fz, w, h, C.uv, 1);
    return;
  }
  if (kind === 'fascia') {
    /* 表(文字・光る) */
    quad(b, cx + fx * d / 2, cy, cz + fz * d / 2, rx, 0, rz, 0, 1, 0, fx, 0, fz, w, h, C.uv, 1);
    /* 上・下・左右のふち(地の色・光らない) */
    quad(b, cx, cy + h / 2, cz, rx, 0, rz, -fx, 0, -fz, 0, 1, 0, w, d, E, 0);
    quad(b, cx, cy - h / 2, cz, rx, 0, rz, fx, 0, fz, 0, -1, 0, w, d, E, 0);
    quad(b, cx + rx * w / 2, cy, cz + rz * w / 2, -fx, 0, -fz, 0, 1, 0, rx, 0, rz, d, h, E, 0);
    quad(b, cx - rx * w / 2, cy, cz - rz * w / 2, fx, 0, fz, 0, 1, 0, -rx, 0, -rz, d, h, E, 0);
    return;
  }
  /* 袖看板: 文字は左右の面(±右)、外側のふちと上下は地の色 */
  quad(b, cx + rx * d / 2, cy, cz + rz * d / 2, -fx, 0, -fz, 0, 1, 0, rx, 0, rz, w, h, C.uv, 1);
  quad(b, cx - rx * d / 2, cy, cz - rz * d / 2, fx, 0, fz, 0, 1, 0, -rx, 0, -rz, w, h, C.uv, 1);
  quad(b, cx + fx * w / 2, cy, cz + fz * w / 2, rx, 0, rz, 0, 1, 0, fx, 0, fz, d, h, E, 0);
  quad(b, cx, cy + h / 2, cz, rx, 0, rz, -fx, 0, -fz, 0, 1, 0, d, w, E, 0);
  quad(b, cx, cy - h / 2, cz, rx, 0, rz, fx, 0, fz, 0, -1, 0, d, w, E, 0);
}

/* list: [{kind:'fascia'|'blade'|'jihanki'|'tomare'|'sp30', s, x, y, z(中心), fx, fz(表/突き出す向き), w, h, d, cell}]
 * → 1000m ごとに1つのメッシュ(group に足す。通りの小物の板も同じメッシュに入るので描画は増えない) */
export function buildShopSigns(rs, group, list) {
  if (!list || !list.length) return [];
  const mat = signMaterial(rs);
  const bufs = new Map();
  list.forEach((it) => {
    const k = Math.floor(it.s / 1000);
    let b = bufs.get(k);
    if (!b) bufs.set(k, (b = newBuf()));
    if (it.kind === 'tomare' || it.kind === 'sp30') roadSign(b, it);
    else signBox(b, it.x, it.y, it.z, it.fx, it.fz, it.w, it.h, it.d, it.cell, it.kind);
  });
  const out = [];
  bufs.forEach((b) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(b.N, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(b.U, 2));
    const col = new Float32Array(b.n * 3); col.fill(1);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('stE', new THREE.Float32BufferAttribute(b.E, 1));
    g.setIndex(b.n > 65535 ? new THREE.Uint32BufferAttribute(b.I, 1) : new THREE.Uint16BufferAttribute(b.I, 1));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mat);
    m.receiveShadow = true;
    /* 帯の合体(mergeRibbons)にかけない。見え方を切り替えないので遠方の間引き(cullCell)の対象 */
    m.userData.noMerge = true;
    m.userData.cullCell = true;
    group.add(m);
    out.push(m);
  });
  return out;
}
