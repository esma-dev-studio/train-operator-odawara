/* =========================================================
 * scene/shopsign.js — 店の看板(かな文字の一般的なことばだけ。店名・会社名は使わない)
 *
 * ・1024x512 の1枚の画像にまとめる: 上半分=横長の看板(256x64)16マス / 下半分=縦長の袖看板(64x256)16マス。
 * ・看板の板は 500m ごとに1つの形に焼きこむ(描画は1回)。板の表だけ夜に光る(頂点の自発光フラグ stE)。
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
  /* 縦長の袖看板 64x256(16列×1段)。のばし棒は縦書きの形に */
  SIGN_WORDS.forEach((word, j) => {
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
  redrawWhenFonts(tex, SIGN_WORDS.join(''));
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
  if (kind === 'blade') {
    const x = (i % 16) * 64, y = 256;
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

/* 箱の看板: 中心 c、表の向き f=(fx,fz)(水平)、横 w・高さ h・厚み d。
 * 面ごとに「右 × 上 = 法線」になるように右・上を選ぶ(文字が鏡うつしにならず、表が外を向く)。
 * kind: 'fascia'=表だけ文字 / 'blade'=袖看板(f は壁から外へ突き出す向き。文字は左右の2面) */
function signBox(b, cx, cy, cz, fx, fz, w, h, d, cell, kind) {
  const C = cellUV(kind, cell);
  const E = C.edge;
  const rx = fz, rz = -fx;   // 右 = 上 × 表
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

/* list: [{kind:'fascia'|'blade', s, x, y, z(中心), fx, fz(表/突き出す向き), w, h, d, cell}]
 * → 500m ごとに1つのメッシュ(group に足す) */
export function buildShopSigns(rs, group, list) {
  if (!list || !list.length) return [];
  const mat = signMaterial(rs);
  const bufs = new Map();
  list.forEach((it) => {
    const k = Math.floor(it.s / 500);
    let b = bufs.get(k);
    if (!b) bufs.set(k, (b = newBuf()));
    signBox(b, it.x, it.y, it.z, it.fx, it.fz, it.w, it.h, it.d, it.cell, it.kind);
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
