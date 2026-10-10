/* =========================================================
 * scene/scene.js — three.js 前面展望シーン
 * 実線形(line.json)からレール・架線・駅・信号・街並みを手続き生成。
 * v2: PBR+HDRI環境光+太陽影+実写テクスチャ(CC0)による描画基盤。
 * ゲームロジックは持たない（simの状態を毎フレーム描くだけ）。
 * ========================================================= */
/* importmapは使わない(古いiPadのSafariが非対応のため、相対パスで読み込む) */
import * as THREE from '../vendor/three.module.min.js';
import { RGBELoader } from '../vendor/RGBELoader.js';
import { EffectComposer } from '../vendor/addons/EffectComposer.js';
import { RenderPass } from '../vendor/addons/RenderPass.js';
import { UnrealBloomPass } from '../vendor/addons/UnrealBloomPass.js';
import { OutputPass } from '../vendor/addons/OutputPass.js';
import { Sky } from '../vendor/addons/Sky.js';
import { STATION_KANA } from '../sim/kana.js';
import { Cockpit } from './cockpit.js';
import { Traffic, placeTrain } from './traffic.js';
import { TrainKit } from './trains.js';
import { WeatherFx } from './weatherfx.js';
import { QUAD_OFF, quadInfo, quadOffAt, quadSep, fenceOffL, bedRuns, rowRanges, frameInto, newFrame, smoothstep, buildTrackBed, buildCatenary, buildTunnel, buildRiver, updateExitGlow, updateCatenaryLod, mergeRibbons, texPCSleeper } from './trackbed.js';

THREE.Cache.enabled = true;
const UP = new THREE.Vector3(0, 1, 0);
/* 軌間1067mm(狭軌・日本の在来線)。レール中心までの半分の幅。車両(TrainKit)の車輪位置と合わせる */
const RAIL_HALF = 1.067 / 2 + 0.032;   // 軌間はレール頭部の内側で測るので、頭部中心は少し外
const DS = THREE.DoubleSide;

/* 画質プリセット */
const QUALITY = {
  high: { dpr: 1.75, shadow: 2048, shadowsOn: true, aniso: 8, bloom: true, trainDetail: 'high' },
  mid:  { dpr: 1.35, shadow: 1024, shadowsOn: true, aniso: 4, bloom: true, trainDetail: 'mid' },
  low:  { dpr: 1.0,  shadow: 0,    shadowsOn: false, aniso: 2, bloom: false, trainDetail: 'low' },
};

/* 路線データから5mごとのフレーム（位置・進行方向・左方向）を作る */
function buildFrames(line) {
  const pts = line.pts.map(([x, y, e]) => new THREE.Vector3(x, e, -y));
  const frames = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const t = b.clone().sub(a).normalize();
    const left = new THREE.Vector3().crossVectors(UP, t).normalize();
    frames.push({ p: pts[i], t, left });
  }
  return frames;
}

/* 進行位置s(m)のフレームを補間 */
export function frameAt(frames, step, s) {
  const f = s / step;
  const i = Math.max(0, Math.min(frames.length - 2, Math.floor(f)));
  const k = Math.min(1, Math.max(0, f - i));
  const p = frames[i].p.clone().lerp(frames[i + 1].p, k);
  const t = frames[i].t.clone().lerp(frames[i + 1].t, k).normalize();
  const left = frames[i].left.clone().lerp(frames[i + 1].left, k).normalize();
  return { p, t, left };
}

/* 中心線から横にoffsetした帯状ジオメトリ（UV: u=横, v=距離/uvScale）
 * offset は数か (i)=>数(複々線の分岐のように行ごとに横位置が変わる帯)。
 * vcol(i, u01) を渡すと頂点色を付ける（地面のムラ・市街地の色調に使用）。
 * 三角形は法線が上を向く向き(材質は両面)。userData.rows/cols/i0 は帯の結合で使う */
function ribbon(frames, i0, i1, offset, width, lift, uvScale, vcol) {
  const pos = [], uv = [], idx = [], col = [];
  const of = typeof offset === 'function' ? offset : () => offset;
  let n = 0;
  for (let i = i0; i <= i1; i++) {
    const f = frames[i];
    const c = f.p.clone().addScaledVector(f.left, of(i));
    const l = c.clone().addScaledVector(f.left, width / 2);
    const r = c.clone().addScaledVector(f.left, -width / 2);
    pos.push(l.x, l.y + lift, l.z, r.x, r.y + lift, r.z);
    const v = (i * 5) / uvScale;
    uv.push(0, v, 1, v);
    if (vcol) { const a = vcol(i, 0), b = vcol(i, 1); col.push(a[0], a[1], a[2], b[0], b[1], b[2]); }
    if (i > i0) {
      const a = n - 2, b = n - 1, c2 = n, d = n + 1;
      idx.push(a, b, c2, b, d, c2);
    }
    n += 2;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  if (vcol) g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.userData.rows = i1 - i0 + 1;
  g.userData.cols = 2;
  g.userData.i0 = i0;
  return g;
}

/* 長い帯(1行に cols 個の頂点が並ぶ形)を行単位でいくつかに切り分ける */
function splitRows(g, rowsPer) {
  const rows = g.userData.rows, C = g.userData.cols || 2;
  const out = [];
  const A = g.attributes;
  const ix = g.index.array;
  for (let r0 = 0; r0 < rows - 1; r0 += rowsPer) {
    const r1 = Math.min(rows - 1, r0 + rowsPer);
    const ng = new THREE.BufferGeometry();
    Object.keys(A).forEach((k) => {
      const it = A[k].itemSize;
      ng.setAttribute(k, new THREE.Float32BufferAttribute(A[k].array.slice(r0 * C * it, (r1 + 1) * C * it), it));
    });
    /* 元の三角形のうち、この行範囲に入るものだけを番号をずらして使う(向きはそのまま) */
    const idx = [];
    const lo = r0 * C, hi = (r1 + 1) * C;
    for (let t = 0; t < ix.length; t += 3) {
      const a = ix[t], b = ix[t + 1], c = ix[t + 2];
      if (Math.min(a, b, c) >= lo && Math.max(a, b, c) < hi) idx.push(a - lo, b - lo, c - lo);
    }
    ng.setIndex(idx);
    ng.computeBoundingSphere();
    ng.userData.rows = r1 - r0 + 1; ng.userData.cols = C; ng.userData.i0 = (g.userData.i0 || 0) + r0;
    out.push(ng);
  }
  return out;
}

/* 縦の帯（壁・レール腹・柵など。UV: u=距離/uvScale, v=縦0..1）
 * offset・y0・y1 は数か (i)=>数 */
function vribbon(frames, i0, i1, offset, y0, y1, uvScale) {
  const pos = [], uv = [], idx = [];
  const of = typeof offset === 'function' ? offset : () => offset;
  const y0f = typeof y0 === 'function' ? y0 : () => y0;
  const y1f = typeof y1 === 'function' ? y1 : () => y1;
  let n = 0;
  for (let i = i0; i <= i1; i++) {
    const f = frames[i];
    const b = f.p.clone().addScaledVector(f.left, of(i));
    pos.push(b.x, b.y + y0f(i), b.z, b.x, b.y + y1f(i), b.z);
    const u = (i * 5) / uvScale;
    uv.push(u, 0, u, 1);
    if (i > i0) idx.push(n - 2, n, n - 1, n - 1, n, n + 1);
    n += 2;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.userData.rows = i1 - i0 + 1;
  g.userData.cols = 2;
  g.userData.i0 = i0;
  g.userData.vr = true;
  return g;
}

/* ---- 木の形(葉のかたまりを凸凹させ、下ほど暗い頂点色で立体感を出す) ---- */
function mergeNonIndexed(geos) {
  const parts = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  const n = parts.reduce((a, g) => a + g.attributes.position.count, 0);
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3);
  let o = 0;
  parts.forEach((g) => {
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    if (g.attributes.color) col.set(g.attributes.color.array, o * 3); else col.fill(1, o * 3, (o + g.attributes.position.count) * 3);
    o += g.attributes.position.count;
  });
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return out;
}

function makeTreeGeos() {
  let seed = 31;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const blob = (r, x, y, z, sy = 1.15) => {
    const g = new THREE.IcosahedronGeometry(r, 1);
    const p = g.attributes.position;
    /* 同じ頂点(面ごとに複製されている)は同じだけ動かして、すき間を作らない */
    const salt = rnd() * 1000;
    for (let i = 0; i < p.count; i++) {
      const hx = Math.round(p.getX(i) * 1000), hy = Math.round(p.getY(i) * 1000), hz = Math.round(p.getZ(i) * 1000);
      const h = Math.sin(hx * 12.9898 + hy * 78.233 + hz * 37.719 + salt) * 43758.5453;
      const k = 0.82 + (h - Math.floor(h)) * 0.32;
      p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * sy, p.getZ(i) * k);
    }
    /* 法線は球の中心から外向き(なめらかな陰影) */
    const nr = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const vx = p.getX(i), vy = p.getY(i) / sy, vz = p.getZ(i);
      const l = Math.hypot(vx, vy, vz) || 1;
      nr[i * 3] = vx / l; nr[i * 3 + 1] = vy / l; nr[i * 3 + 2] = vz / l;
    }
    g.setAttribute('normal', new THREE.BufferAttribute(nr, 3));
    g.translate(x, y, z);
    return g;
  };
  /* 頂点色: 下(幹側)ほど暗く、上ほど明るい */
  const shade = (g, y0, y1) => {
    const p = g.attributes.position;
    const c = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const t = Math.min(1, Math.max(0, (p.getY(i) - y0) / (y1 - y0)));
      const v = Math.pow(0.55 + 0.5 * t, 2.2);
      c[i * 3] = v; c[i * 3 + 1] = v; c[i * 3 + 2] = v;
    }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return g;
  };
  const broadA = shade(mergeNonIndexed([blob(1.55, 0, 3.7, 0), blob(1.1, 0.95, 3.1, 0.35), blob(1.0, -0.85, 3.25, -0.3), blob(0.9, 0.1, 4.6, -0.5)]), 2.2, 5.4);
  const broadB = shade(mergeNonIndexed([blob(1.25, 0, 3.3, 0, 1.3), blob(1.15, 0.2, 4.4, 0.2, 1.2), blob(0.85, -0.7, 3.0, 0.5), blob(0.8, 0.75, 3.6, -0.55)]), 2.2, 5.6);
  /* 針葉樹: 円錐を3段に重ねる */
  const cones = [];
  [[1.5, 2.2, 2.6], [1.15, 1.9, 3.9], [0.75, 1.6, 5.0]].forEach(([r, h, y]) => {
    const c = new THREE.ConeGeometry(r, h, 7, 1);
    c.translate(0, y, 0);
    cones.push(c);
  });
  const conifer = shade(mergeNonIndexed(cones), 1.5, 6.0);
  const trunk = new THREE.CylinderGeometry(0.13, 0.2, 2.9, 6);
  trunk.translate(0, 1.45, 0);
  const trunkC = new THREE.CylinderGeometry(0.1, 0.16, 2.0, 5);
  trunkC.translate(0, 1.0, 0);
  return { fol: [broadA, broadB, conifer], trunk, trunkC };
}

/* ---- テクスチャ ---- */
const texLoader = new THREE.TextureLoader();
function photoTex(url, opt = {}) {
  const t = texLoader.load(url);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(opt.rx || 1, opt.ry || 1);
  t.anisotropy = opt.aniso || 8;
  if (opt.srgb !== false) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function canvasTex(w, h, draw, repeatY) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  draw(cv.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  if (repeatY) tex.repeat.set(1, repeatY);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ビル外壁v3: 1階店舗・階スラブ影・窓の空映りグラデ・バルコニーまで描き込む */
const texBuilding = (base, opt = {}) => canvasTex(128, 256, (c) => {
  const seed = opt.seed || 0;
  c.fillStyle = base;
  c.fillRect(0, 0, 128, 256);
  const ao = c.createLinearGradient(0, 0, 0, 256);
  ao.addColorStop(0, 'rgba(255,255,255,0.09)');
  ao.addColorStop(0.7, 'rgba(0,0,0,0.07)');
  ao.addColorStop(1, 'rgba(0,0,0,0.30)');
  c.fillStyle = ao; c.fillRect(0, 0, 128, 256);
  const N = !!opt.night;
  if (N) { c.fillStyle = 'rgba(8,10,14,0.85)'; c.fillRect(0, 0, 128, 256); }   // 夜: 壁を沈める
  const bottom = opt.shop ? 204 : 246;
  for (let y = 12; y < bottom - 8; y += 20) {
    /* 階スラブの影とハイライト */
    c.fillStyle = N ? 'rgba(0,0,0,0.3)' : 'rgba(0,0,0,0.22)'; c.fillRect(0, y + 15, 128, 3);
    c.fillStyle = N ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.07)'; c.fillRect(0, y + 18, 128, 1.5);
    for (let x = 7; x < 118; x += 17) {
      const lit = ((x * 7 + y * 13 + seed * 5) % 23) / 23;
      if (N) {
        /* 夜: 4割の窓が暖色に灯る */
        if (lit < 0.4) {
          const g = c.createLinearGradient(0, y, 0, y + 12);
          g.addColorStop(0, 'rgba(255,220,158,0.98)');
          g.addColorStop(1, 'rgba(232,168,86,0.98)');
          c.fillStyle = g;
        } else {
          c.fillStyle = 'rgba(14,18,24,0.96)';
        }
      } else if (lit < (opt.winRatio || 0.86)) {
        const g = c.createLinearGradient(0, y, 0, y + 12);
        g.addColorStop(0, `rgba(${Math.round(150 + lit * 45)},${Math.round(175 + lit * 30)},210,0.95)`);
        g.addColorStop(1, `rgba(${Math.round(58 + lit * 30)},${Math.round(78 + lit * 30)},104,0.95)`);
        c.fillStyle = g;
      } else {
        c.fillStyle = 'rgba(24,30,36,0.95)';
      }
      c.fillRect(x, y, 12, 12);
      c.fillStyle = 'rgba(0,0,0,0.28)'; c.fillRect(x, y + 11, 12, 1.6);
      if (opt.balcony) { c.fillStyle = N ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.34)'; c.fillRect(x - 2, y + 13, 15, 2); }
    }
  }
  if (opt.shop) {
    /* 1階: ガラスの店先+色ちがいのひさし+看板(夜はこうこうと灯る) */
    c.fillStyle = N ? '#f2c87e' : '#18222e'; c.fillRect(3, 214, 122, 40);
    if (N) {
      c.fillStyle = 'rgba(255,244,214,0.85)'; c.fillRect(3, 214, 122, 14);
    } else {
      c.fillStyle = 'rgba(160,190,215,0.22)';
      c.beginPath(); c.moveTo(12, 254); c.lineTo(44, 214); c.lineTo(62, 214); c.lineTo(30, 254); c.fill();
    }
    const awn = ['#a8503e', '#3e64a8', '#3e8a58', '#b08a3a'];
    for (let x = 3, i = 0; x < 120; x += 41, i++) {
      c.fillStyle = awn[(seed + i) % awn.length];
      c.fillRect(x, 206, 36, 9);
      if (N) { c.fillStyle = 'rgba(0,0,0,0.35)'; c.fillRect(x, 206, 36, 9); }
    }
    c.fillStyle = N ? '#fff6dc' : '#ece8de'; c.fillRect(26, 191, 76, 12);
    c.fillStyle = N ? 'rgba(60,50,30,0.85)' : 'rgba(40,50,60,0.8)';
    for (let x = 32; x < 96; x += 9) c.fillRect(x, 194, 5, 6);
  }
  c.fillStyle = 'rgba(0,0,0,0.32)'; c.fillRect(0, 0, 128, 7);
  c.fillStyle = N ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.12)'; c.fillRect(0, 7, 128, 2);
});

/* 戸建て外壁 */
const texHouse = (opt = {}) => canvasTex(64, 64, (c) => {
  const N = !!opt.night;
  c.fillStyle = N ? '#33363c' : '#c9c3b8';
  c.fillRect(0, 0, 64, 64);
  for (let y = 8; y < 64; y += 9) { c.fillStyle = 'rgba(0,0,0,0.05)'; c.fillRect(0, y, 64, 1.5); }
  if (N) {
    c.fillStyle = 'rgba(255,222,160,0.98)';
    c.fillRect(9, 24, 15, 16);                       // 灯りのついた窓
    c.fillStyle = 'rgba(12,15,20,0.95)';
    c.fillRect(39, 24, 15, 16);                      // 消えている窓
  } else {
    c.fillStyle = 'rgba(52,64,76,0.9)';
    c.fillRect(9, 24, 15, 16); c.fillRect(39, 24, 15, 16);
    c.fillStyle = 'rgba(235,242,248,0.35)';
    c.fillRect(9, 24, 15, 5); c.fillRect(39, 24, 15, 5);
  }
  c.fillStyle = 'rgba(0,0,0,0.18)'; c.fillRect(0, 56, 64, 8);
});

/* レールの継ぎ目(縦方向に1周=25m。端に暗い隙間) */
const texRailJoint = () => canvasTex(4, 256, (c) => {
  c.fillStyle = '#ffffff'; c.fillRect(0, 0, 4, 256);
  c.fillStyle = '#3a3836'; c.fillRect(0, 0, 4, 2);
  c.fillStyle = '#8e8c88'; c.fillRect(0, 2, 4, 2);
});

/* 点字ブロック(ホーム縁の黄色警告ブロック) */
const texTactile = () => canvasTex(64, 64, (c) => {
  c.fillStyle = '#ab8e33';
  c.fillRect(0, 0, 64, 64);
  c.fillStyle = 'rgba(240,220,140,0.5)';
  for (let y = 6; y < 64; y += 16) for (let x = 6; x < 64; x += 16) {
    c.beginPath(); c.arc(x + 5, y + 5, 4.4, 0, 7); c.fill();
  }
  c.fillStyle = 'rgba(0,0,0,0.15)'; c.fillRect(0, 0, 64, 2); c.fillRect(0, 62, 64, 2);
});

/* 金網フェンス(アルファ抜き) */
const texFence = () => {
  const cv = document.createElement('canvas');
  cv.width = 128; cv.height = 64;
  const c = cv.getContext('2d');
  c.clearRect(0, 0, 128, 64);
  c.strokeStyle = 'rgba(118,126,122,0.9)';
  c.lineWidth = 1.6;
  c.beginPath();
  for (let x = -64; x < 128; x += 16) {
    c.moveTo(x, 64); c.lineTo(x + 64, 0);
    c.moveTo(x + 64, 64); c.lineTo(x, 0);
  }
  c.stroke();
  c.lineWidth = 3.5;
  c.beginPath(); c.moveTo(0, 2.5); c.lineTo(128, 2.5); c.moveTo(0, 61.5); c.lineTo(128, 61.5); c.stroke();
  c.fillStyle = 'rgba(102,110,106,1)';
  c.fillRect(0, 0, 4, 64);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
};

/* AI列車の車体側面(窓帯・ドア・帯) */
const texTrainSide = () => canvasTex(512, 96, (c) => {
  c.fillStyle = '#c9ced2'; c.fillRect(0, 0, 512, 96);
  c.fillStyle = 'rgba(255,255,255,0.25)'; c.fillRect(0, 5, 512, 9);
  c.fillStyle = '#22303c'; c.fillRect(0, 22, 512, 22);
  for (let x = 8; x < 512; x += 64) {
    c.fillStyle = 'rgba(150,180,205,0.85)';
    c.fillRect(x, 24, 40, 18);
  }
  for (let x = 52; x < 512; x += 128) {
    c.fillStyle = '#aab0b5'; c.fillRect(x, 16, 26, 60);
    c.fillStyle = '#2b3844'; c.fillRect(x + 4, 24, 7, 18); c.fillRect(x + 15, 24, 7, 18);
  }
  c.fillStyle = '#1f5fa6'; c.fillRect(0, 62, 512, 8);
  c.fillStyle = 'rgba(0,0,0,0.22)'; c.fillRect(0, 84, 512, 12);
});

/* AI列車の前面(黒窓帯+前照灯) */
const texTrainFront = () => canvasTex(128, 128, (c) => {
  c.fillStyle = '#d5d9dc'; c.fillRect(0, 0, 128, 128);
  c.fillStyle = '#10161c'; c.fillRect(14, 16, 100, 40);
  c.fillStyle = 'rgba(160,190,215,0.35)'; c.fillRect(18, 20, 40, 14);
  c.fillStyle = '#1f5fa6'; c.fillRect(0, 78, 128, 10);
  c.fillStyle = '#ffe9a8';
  c.beginPath(); c.arc(24, 100, 7, 0, 7); c.fill();
  c.beginPath(); c.arc(104, 100, 7, 0, 7); c.fill();
  c.fillStyle = 'rgba(0,0,0,0.3)'; c.fillRect(0, 116, 128, 12);
});

/* 信号灯のグロー */
const texGlow = () => {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const c = cv.getContext('2d');
  const g = c.createRadialGradient(32, 32, 2, 32, 32, 30);
  g.addColorStop(0, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g; c.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(cv);
  return t;
};

function boardTexture(lines, opts = {}) {
  return canvasTex(opts.w || 256, opts.h || 128, (c, w, h) => {
    c.fillStyle = opts.bg || '#ffffff';
    c.fillRect(0, 0, w, h);
    if (opts.border) { c.strokeStyle = opts.border; c.lineWidth = 8; c.strokeRect(4, 4, w - 8, h - 8); }
    c.fillStyle = opts.fg || '#111';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    lines.forEach(([text, y, size, weight]) => {
      c.font = `${weight || 'bold'} ${size}px "Zen Kaku Gothic New", "Hiragino Sans", Meiryo, sans-serif`;
      c.fillText(text, w / 2, y);
    });
  });
}

export class RailScene {
  /* opts: { quality, timeOfDay:'day'|'evening'|'night', weather } */
  constructor(canvas, line, sim, opts = {}) {
    this.quality = QUALITY[opts.quality] ? opts.quality : 'high';
    this.timeOfDay = opts.timeOfDay || (opts.night ? 'night' : 'day');
    this.weather = opts.weather || (sim && sim.weather) || 'clear';
    const Q = QUALITY[this.quality];

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, Q.dpr));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    if (Q.shadowsOn) {
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(58, 16 / 9, 0.3, 2600);
    this.scene.add(this.camera);   // 運転台(cockpit)をカメラの子として描くため
    this.cockpit = new Cockpit(this.camera);
    this.camMode = 'cab';
    this._camBlend = 1;
    this.clockT = 0;
    this.fps = 60;
    this._fpsAcc = 0; this._fpsN = 0;

    /* ---- 実写系テクスチャ(CC0: ambientCG) ---- */
    const A = Q.aniso;
    this.T = {
      gravelC: photoTex('./assets/tex/gravel_c.jpg', { rx: 1.7, aniso: A }),
      gravelN: photoTex('./assets/tex/gravel_n.jpg', { rx: 1.7, aniso: A, srgb: false }),
      gravelSubC: photoTex('./assets/tex/gravel_c.jpg', { rx: 1, aniso: A }),
      grassC: photoTex('./assets/tex/grass_c.jpg', { rx: 104, aniso: A }),
      grassBankC: photoTex('./assets/tex/grass_c.jpg', { rx: 152, aniso: A }),
      concC: photoTex('./assets/tex/concrete_c.jpg', { rx: 1, aniso: A }),
      concN: photoTex('./assets/tex/concrete_n.jpg', { rx: 1, aniso: A, srgb: false }),
      concPlatC: photoTex('./assets/tex/concrete_c.jpg', { rx: 0.6, aniso: A }),
      concWallC: photoTex('./assets/tex/concrete_c.jpg', { rx: 1, aniso: A }),
    };

    /* ---- 材質レジストリ(天候で調整するものはここに集約。路線を作り直しても使い回す) ---- */
    this.M = {
      ballast: new THREE.MeshStandardMaterial({ map: this.T.gravelC, normalMap: this.T.gravelN, normalScale: new THREE.Vector2(0.85, 0.85), color: 0xaaa59b, roughness: 1, side: DS }),
      sub: new THREE.MeshStandardMaterial({ map: this.T.gravelSubC, color: 0x6f6b62, roughness: 1, side: DS }),
      apron: new THREE.MeshStandardMaterial({ map: this.T.concC, color: 0xaaa8a2, roughness: 0.95, side: DS }),
      /* レール頭面: 25mごとの継ぎ目(ジョイント音「タタン」と同じ間隔)を暗い線で */
      railHead: new THREE.MeshStandardMaterial({ map: texRailJoint(), color: 0xd8dadd, metalness: 1.0, roughness: 0.3, side: DS }),
      railWeb: new THREE.MeshStandardMaterial({ color: 0x6b5c4d, metalness: 0.35, roughness: 0.9, side: DS }),
      ground: new THREE.MeshStandardMaterial({ map: this.T.grassC, vertexColors: true, roughness: 1, side: DS }),
      bank: new THREE.MeshStandardMaterial({ map: this.T.grassBankC, vertexColors: true, roughness: 1, side: DS }),
      water: new THREE.MeshStandardMaterial({ color: 0x455e6d, metalness: 0, roughness: 0.3, side: DS }),
      plat: new THREE.MeshStandardMaterial({ map: this.T.concPlatC, color: 0xc2bfb6, roughness: 0.95, side: DS }),
      platSide: new THREE.MeshStandardMaterial({ map: this.T.concWallC, color: 0xb9b7b0, roughness: 0.95, side: DS }),
      tunnel: new THREE.MeshStandardMaterial({ map: this.T.concWallC, color: 0x85898d, roughness: 0.95, side: DS, envMapIntensity: 0.5 }),
      sleeper: new THREE.MeshStandardMaterial({ color: 0x7a766e, roughness: 0.95 }),
    };
    this.M.water.envMapIntensity = 0.6;
    this.M.railHead.envMapIntensity = 1.35;
    this._keep = new Set([...Object.values(this.M), ...Object.values(this.T)]);

    /* ---- 光源 ---- */
    this.hemi = new THREE.HemisphereLight(0xbfd0e0, 0x6a6f64, 0.35);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff0da, 2.8);
    this.sun.castShadow = Q.shadowsOn;
    if (Q.shadowsOn) {
      this.sun.shadow.mapSize.set(Q.shadow, Q.shadow);
      const sc = this.sun.shadow.camera;
      sc.left = -170; sc.right = 170; sc.top = 190; sc.bottom = -120; sc.near = 20; sc.far = 950;
      sc.updateProjectionMatrix();
      this.sun.shadow.bias = -0.00015;
      this.sun.shadow.normalBias = 0.35;
    }
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this._sunDir = new THREE.Vector3(0.85, 0.55, -0.1).normalize();

    /* 前照灯(トンネル内・夜に軌道を照らす。日中の屋外では太陽に埋もれる) */
    this.headlight = new THREE.SpotLight(0xfff6e6, 700, 160, 0.34, 0.5, 1.7);
    this.headlight.castShadow = false;
    this.scene.add(this.headlight);
    this.scene.add(this.headlight.target);

    /* ---- 空と環境光: HDRI(晴/曇/夜) + 夕方は大気散乱の空(Sky)から作る ---- */
    this.env = {};
    this._pmrem = new THREE.PMREMGenerator(this.renderer);
    this._pmrem.compileEquirectangularShader();
    const rl = new RGBELoader();
    [['clear', './assets/sky/sky_clear.hdr'], ['rain', './assets/sky/sky_overcast.hdr'], ['night', './assets/sky/sky_night.hdr']].forEach(([k, url]) => {
      rl.load(url, (t) => {
        t.mapping = THREE.EquirectangularReflectionMapping;
        this.env[k] = { bg: t, ibl: this._pmrem.fromEquirectangular(t).texture };
        this._applyWeather();
      });
    });
    this._buildEveningSky();

    /* ---- 雨・雪の粒(カメラ近傍だけ) ---- */
    this.weatherFx = new WeatherFx(this.scene, this.camera);

    /* ---- 路線(ワールド)は作り直せるようにグループにまとめる ---- */
    this.world = new THREE.Group();
    this.scene.add(this.world);
    this.setWorld(line, sim);

    /* ---- ポストエフェクト(光のにじみ=ブルーム) ---- */
    this._initPost();
    this._applyWeather();
  }

  get night() { return this.timeOfDay === 'night'; }
  set night(n) { this.setTimeOfDay(n ? 'night' : 'day'); }
  setNight(n) { this.setTimeOfDay(n ? 'night' : 'day'); }

  setTimeOfDay(t) {
    this.timeOfDay = t;
    this._applyWeather();
  }

  /* 路線(方向)が変わったときはワールドを作り直す。同じ路線なら信号(種別で変わる)だけ */
  setWorld(line, sim) {
    this.sim = sim;
    if (line === this.line && this.world.children.length) {
      this._buildSignals();
      if (this.traffic) this.traffic.reset(sim);
      return;
    }
    this._disposeWorld();
    this.line = line;
    this.step = line.meta.step;
    this.frames = buildFrames(line);
    /* 喜多見の車両基地ゾーン(この右側には建物や木を生やさない) */
    const kitami = this.line.stations.find((s) => s.name === '喜多見');
    this.depotZone = kitami ? { a: kitami.s + 300, b: kitami.s + 640 } : null;
    /* 踏切の位置(郊外区間に6箇所。駅・川・トンネル・複々線・基地を避ける) */
    this.crossSpots = this._pickCrossings();
    this.terminal = this._terminalInfo();

    this._buildTrack();
    this._buildSleepers();
    this._buildLineside();
    this._buildStations();
    this._buildSignals();
    this._buildBoards();
    this._buildTown();
    this._buildFences();
    this._buildTrees();
    this._buildTunnel();
    this._buildRiver();
    this._buildStopBeam();
    this._buildLandmarks();
    this._buildCrossings();
    this._buildStationHouses();
    this._buildRailsideDetails();
    this._buildPlatformFurniture();
    this._buildPeople();
    this._buildCrowds();
    this._buildHills();
    this._splitInstances();
    this._splitRibbons();
    this.traffic = new Traffic(this, sim);
    this._applyWeather();
  }

  /* 帯(ribbon など行のある形)を、全線共通の区切り(5m×150行=750m)で切り、
   * 同じ材質・同じ影の設定のものを区切りごとに1つのメッシュへまとめる。
   * 画面に入る区切りだけが描かれ、しかも材質ごとに1回の描画で済む(描画コールが大きく減る)。
   * 参照を持ち続ける帯には userData.noMerge を付けておくこと */
  _splitRibbons() {
    this._mergeStat = mergeRibbons(this.world, 150);
  }

  _splitInstances() {
    const CELL = 700;
    const m4 = new THREE.Matrix4(), p = new THREE.Vector3(), col = new THREE.Color();
    const targets = [];
    this.world.children.forEach((o) => {
      if (o.isInstancedMesh && o.count > 48 && !o.userData.noSplit) targets.push(o);
    });
    targets.forEach((im) => {
      const cells = new Map();
      for (let i = 0; i < im.count; i++) {
        im.getMatrixAt(i, m4);
        p.setFromMatrixPosition(m4);
        const k = Math.floor(p.x / CELL) + ',' + Math.floor(p.z / CELL);
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(i);
      }
      const g = new THREE.Group();
      cells.forEach((idx) => {
        const c = new THREE.InstancedMesh(im.geometry, im.material, idx.length);
        idx.forEach((src, j) => {
          im.getMatrixAt(src, m4); c.setMatrixAt(j, m4);
          if (im.instanceColor) { im.getColorAt(src, col); c.setColorAt(j, col); }
        });
        c.castShadow = im.castShadow; c.receiveShadow = im.receiveShadow;
        c.renderOrder = im.renderOrder;
        c.computeBoundingSphere();
        g.add(c);
      });
      g.visible = im.visible;
      this.world.remove(im);
      im.dispose();
      this.world.add(g);
      if (this.stationLamps === im) this.stationLamps = g;
    });
  }

  _disposeWorld() {
    const keep = this._keep;
    const geos = new Set(), mats = new Set(), texs = new Set();
    /* 車両(TrainKit)の形状・材質は共有なので捨てず、編成ごとの表記だけ解放する */
    if (this.traffic) this.traffic.dispose();
    this.traffic = null;
    const walk = (o) => {
      if (o.userData && o.userData.train) { this.disposeTrainModel(o.userData.train); return; }
      if (o.isInstancedMesh) o.dispose();   // インスタンス行列・色のバッファ
      if (o.geometry) geos.add(o.geometry);
      if (o.material) [].concat(o.material).forEach((m) => mats.add(m));
      o.children.forEach(walk);
    };
    this.world.children.forEach(walk);
    /* 昼/夜で差し替えているビルのテクスチャ(使っていない側も) */
    (this._bldMats || []).forEach((b) => { texs.add(b.day); texs.add(b.night); });
    this._bldMats = [];
    mats.forEach((m) => {
      if (keep.has(m)) return;
      ['map', 'normalMap', 'emissiveMap', 'alphaMap', 'roughnessMap'].forEach((k) => { if (m[k] && !keep.has(m[k])) texs.add(m[k]); });
      m.dispose();
    });
    geos.forEach((g) => g.dispose());
    texs.forEach((t) => t.dispose());
    this.world.clear();
    this.signalMeshes = [];
    this._sigGroup = null;
  }

  /* 踏切候補の選定 */
  _pickCrossings() {
    const L = this.line.meta.length;
    const q = this.line.sections.quad;
    const bad = (s) =>
      this._inTunnel(s) ||
      this.line.stations.some((st) => Math.abs(st.s - s) < 230) ||
      this.line.sections.river.some((r) => s > r.from - 130 && s < r.to + 130) ||
      (this.depotZone && s > this.depotZone.a - 70 && s < this.depotZone.b + 70) ||
      (s > q.from - 60 && s < q.to + 60);
    const spots = [];
    const s0 = this.line.meta.direction === 'up' ? 1500 : 8600;
    for (let s = s0; s < L - 400 && spots.length < 6; s += 1150) {
      let x = s;
      for (let k = 0; k < 9; k++) {
        if (!bad(x)) { spots.push(x); break; }
        x += 140;
      }
    }
    return spots;
  }

  /* ---------- ブルーム(夜・夕方の灯りのにじみ) ---------- */
  _initPost() {
    const Q = QUALITY[this.quality];
    this.composer = null;
    if (!Q.bloom) return;
    try {
      const gl = this.renderer.getContext();
      const isGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
      const rt = new THREE.WebGLRenderTarget(8, 8, { type: THREE.HalfFloatType, samples: isGL2 ? (this.quality === 'high' ? 4 : 2) : 0 });
      this.composer = new EffectComposer(this.renderer, rt);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.55, 0.82);
      this.composer.addPass(this.bloom);
      this.composer.addPass(new OutputPass());
      if (this._w) this.composer.setSize(this._w, this._h);
    } catch (e) {
      this.composer = null;
    }
  }

  /* fps低下時に外から段階的に画質を落とす(ブルーム→dpr→影) */
  stepDownQuality() {
    const r = this.renderer;
    if (this.composer) { this.composer = null; return 'bloom'; }
    const cur = r.getPixelRatio();
    if (cur > 1.28) { r.setPixelRatio(Math.max(1.2, cur - 0.35)); this._reapplySize(); return 'dpr'; }
    if (cur > 1.02) { r.setPixelRatio(1); this._reapplySize(); return 'dpr'; }
    if (r.shadowMap.enabled) {
      r.shadowMap.enabled = false;
      this.sun.castShadow = false;
      this.scene.traverse((o) => { if (o.material) [].concat(o.material).forEach((m) => { m.needsUpdate = true; }); });
      return 'shadow';
    }
    return null;
  }

  _reapplySize() {
    if (this._w) {
      this.renderer.setSize(this._w, this._h, false);
      if (this.composer) this.composer.setSize(this._w, this._h);
    }
  }

  setWeather(w) {
    this.weather = w;
    this._applyWeather();
  }

  /* 夕方の空: 大気散乱モデル(Sky)で夕焼けを作り、環境光もそこから生成 */
  _buildEveningSky() {
    const sky = new Sky();
    sky.scale.setScalar(2300);
    const u = sky.material.uniforms;
    u.turbidity.value = 7.5;
    u.rayleigh.value = 2.6;
    u.mieCoefficient.value = 0.006;
    u.mieDirectionalG.value = 0.86;
    /* 夕日は西南西(くだりの進行方向の先)。高度3° */
    const phi = THREE.MathUtils.degToRad(90 - 3.2);
    const theta = THREE.MathUtils.degToRad(-112);
    const sunV = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
    u.sunPosition.value.copy(sunV);
    this._eveSunDir = sunV.clone().normalize();
    const tmp = new THREE.Scene();
    tmp.add(sky);
    try {
      this.env.evening = { ibl: this._pmrem.fromScene(tmp, 0.02).texture, sky };
    } catch (e) { /* 失敗しても晴れの環境で代用 */ }
    tmp.remove(sky);
    sky.material.depthWrite = false;
    sky.frustumCulled = false;
    sky.visible = false;
    this.eveSky = sky;
    this.scene.add(sky);
  }

  _applyWeather() {
    if (!this.M) return;
    const rain = this.weather === 'rain';
    const snow = this.weather === 'snow';
    const wet = rain || snow;
    const tod = this.timeOfDay;
    const night = tod === 'night';
    const eve = tod === 'evening';
    /* --- 空(背景)と環境光 --- */
    let key = night ? 'night' : wet ? 'rain' : eve ? 'evening' : 'clear';
    let env = this.env[key];
    if (key === 'evening' && !env) env = this.env.clear;
    if (this.eveSky) this.eveSky.visible = key === 'evening' && !!this.env.evening;
    if (key === 'evening' && this.env.evening) {
      this.scene.background = null;
      this.scene.environment = this.env.evening.ibl;
    } else if (env && env.bg) {
      this.scene.background = env.bg;
      this.scene.environment = env.ibl;
      this.scene.backgroundIntensity = night ? (wet ? 0.55 : 0.8) : eve ? 0.42 : snow ? 1.05 : rain ? 0.85 : 1.0;
    } else {
      this.scene.background = new THREE.Color(night ? 0x0a0f16 : rain ? 0x8d959c : snow ? 0xc9cfd5 : eve ? 0x9a7a6a : 0xa8c4dd);
      this.scene.environment = null;
    }
    /* --- 霧 --- */
    const fogCol = night ? (wet ? 0x0a0e13 : 0x0c1119)
      : eve ? (wet ? 0x5a5250 : 0xd9a27a)
      : snow ? 0xdde3e8 : rain ? 0x99a1a8 : 0xcfd9e2;
    const fogNear = night ? (wet ? 110 : 180) : snow ? 60 : rain ? 140 : eve ? 250 : 300;
    const fogFar = night ? (wet ? 560 : 1050) : snow ? 520 : rain ? 780 : eve ? 1700 : 1500;
    this.scene.fog = new THREE.Fog(fogCol, fogNear, fogFar);
    /* --- 露出・太陽 --- */
    this.renderer.toneMappingExposure = night ? (wet ? 0.8 : 0.9) : eve ? (wet ? 0.75 : 0.95) : snow ? 0.95 : rain ? 0.92 : 1.08;
    this.sun.intensity = night ? 0.32 : eve ? (wet ? 0.25 : 2.1) : wet ? 0.45 : 2.8;
    this.sun.color.setHex(night ? 0xa8bcd8 : eve ? 0xffa766 : wet ? 0xdfe4ea : 0xfff0da);
    this._curSunDir = eve && !wet && this._eveSunDir ? this._eveSunDir.clone().setY(Math.max(0.09, this._eveSunDir.y)).normalize() : this._sunDir;
    this.sun.castShadow = QUALITY[this.quality].shadowsOn && !wet && !night;
    this.hemi.intensity = night ? 0.14 : eve ? 0.55 : snow ? 0.7 : rain ? 0.55 : 0.45;
    this.hemi.color.setHex(eve ? 0xd8a888 : 0xbfd0e0);
    const lightsOn = night || eve || this._inTunnelNow;
    if (this.headlight) this.headlight.intensity = night ? (wet ? 950 : 850) : eve ? 900 : wet ? 750 : 700;
    /* --- 濡れ・雪の表現 --- */
    this.M.railHead.roughness = wet ? 0.12 : 0.3;
    this.M.ballast.color.setHex(snow ? 0xd9dde2 : rain ? 0x6e6b66 : 0xaaa59b);
    this.M.sub.color.setHex(snow ? 0xc8ccd2 : 0x6f6b62);
    this.M.apron.color.setHex(snow ? 0xd2d6da : rain ? 0x8a8883 : 0xaaa8a2);
    this.M.apron.roughness = rain ? 0.5 : 0.95;
    this.M.plat.color.setHex(snow ? 0xd8dbde : rain ? 0x93908a : 0xc2bfb6);
    this.M.plat.roughness = rain ? 0.45 : 0.95;
    /* 雪: 地面は芝テクスチャを外して一面の雪原に(頂点色のムラだけ残す) */
    const gMap = snow ? null : this.T.grassC;
    if (this.M.ground.map !== gMap) { this.M.ground.map = gMap; this.M.ground.needsUpdate = true; }
    this.M.ground.color.setHex(snow ? 0xeef2f6 : eve ? 0xf0dcc4 : 0xffffff);
    const bMap = snow ? null : this.T.grassBankC;
    if (this.M.bank.map !== bMap) { this.M.bank.map = bMap; this.M.bank.needsUpdate = true; }
    this.M.bank.color.setHex(snow ? 0xe6eaee : 0xffffff);
    if (this._hillMat) {
      const hm = snow ? null : this._hillTex;
      if (this._hillMat.map !== hm) { this._hillMat.map = hm; this._hillMat.needsUpdate = true; }
      this._hillMat.color.setHex(snow ? 0xe8ecf0 : eve ? 0xb09a82 : 0xb9c4a0);
    }
    this.M.water.roughness = night ? 0.22 : wet ? 0.38 : 0.3;
    this.M.water.color.setHex(night ? 0x141c26 : wet ? 0x49525a : eve ? 0x6a5a58 : 0x455e6d);
    /* 夜・夕方: ビル・住宅を窓明かりテクスチャへ切替(夕方は控えめに灯る) */
    if (this._bldMats) {
      this._bldMats.forEach(({ m, day, night: nt }) => {
        const lit = night || eve;
        m.map = night ? nt : day;
        m.emissiveMap = lit ? nt : null;
        m.emissive.setHex(night ? 0x9a8968 : eve ? 0x3a3020 : 0x000000);
        m.needsUpdate = true;
      });
    }
    /* 駅ホームの照明・自販機 */
    if (this.stationLamps) this.stationLamps.visible = lightsOn || wet;
    if (this._vendFrontMat) this._vendFrontMat.emissive.setHex(night || eve ? 0xcfe0ee : 0x000000);
    if (this.weatherFx) this.weatherFx.set(this.weather, tod);
    if (this.trainKit) this.trainKit.setNight(night || eve || wet || !!this._inTunnelNow);
    /* ブルームの強さ(昼は控えめ) */
    if (this.bloom) {
      this.bloom.strength = night ? 0.85 : eve ? 0.55 : 0.22;
      this.bloom.threshold = night ? 0.72 : 0.86;
    }
  }

  /* ---------- 軌道 ----------
   * 道床(バラストの肩・犬走り)・レール(頭面/腹/底)・枕木の帯・地面は scene/trackbed.js で作る。
   * 複々線の急行線は QUAD_OFF(7.0 / 10.8m)。駅の先で分岐器のようになめらかに分かれる */
  _buildTrack() {
    this.quadOff = QUAD_OFF;
    this._qi = quadInfo(this.line);
    this._exitGlow = null; this._brkCells = null; this._gHidden = null; this._gHideKey = undefined;   // 前の路線の分は使わない
    buildTrackBed(this, { aniso: QUALITY[this.quality].aniso });
  }

  /* ---------- 枕木(自列車近傍のみ実体を置くムービングウィンドウ) ----------
   * 遠くは枕木の帯(テクスチャ)が同じ位置に描かれているので、近くだけ立体の枕木を重ねる */
  _buildSleepers() {
    const geo = new THREE.BoxGeometry(2.0, 0.14, 0.24);   // 狭軌用のPCまくら木
    /* 底面は見えないので三角形を省く(BoxGeometry の面の順: +x,-x,+y,-y,+z,-z) */
    geo.setIndex(Array.from(geo.index.array).filter((v, k) => k < 18 || k >= 24));
    geo.clearGroups();
    if (!this._slpCol) {
      const t = texPCSleeper();
      this._keep.add(t);
      this.M.sleeper.map = t;
      this.M.sleeper.roughness = 1;
      /* 帯の枕木(#85817a)と同じ明るさに見える色。速いときは砂利の明るさへ寄せる */
      this._slpCol = {
        base: new THREE.Color(0xe6e2da), far: new THREE.Color(0xbdb9b1),
        white: new THREE.Color(1, 1, 1), timber: new THREE.Color().setRGB(0.34, 0.22, 0.14),
      };
      this.M.sleeper.color.copy(this._slpCol.base);
    }
    /* own: -45..+195, up: -45..+140, 急行線: -20..+110 (間隔0.625m) */
    this._slpSpec = [
      { off: 0, back: 45, fwd: 195 },
      { off: -3.8, back: 45, fwd: 140 },
      { k: 0, back: 20, fwd: 110, zone: 'quad' },
      { k: 1, back: 20, fwd: 110, zone: 'quad' },
    ];
    let total = 0;
    this._slpSpec.forEach((sp) => { sp.count = Math.floor((sp.back + sp.fwd) / 0.625); total += sp.count; });
    this.sleepers = new THREE.InstancedMesh(geo, this.M.sleeper, total);
    this.sleepers.userData.noSplit = true;
    this.sleepers.frustumCulled = false;
    this.sleepers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < total; i++) this.sleepers.setColorAt(i, this._slpCol.white);
    this.sleepers.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.world.add(this.sleepers);
    /* 毎フレームの更新で new しないための作業用 */
    this._slpTmp = {
      f: newFrame(), m: new THREE.Matrix4(), q: new THREE.Quaternion(), p: new THREE.Vector3(),
      one: new THREE.Vector3(1, 1, 1), zero: new THREE.Matrix4().makeScale(0, 0, 0), X: new THREE.Vector3(1, 0, 0),
    };
    this._slpBase = -1e9;
    this._updateSleepers(0);
  }

  /* 毎フレーム(render から): 枕木の明るさ・トンネル出口の明るさ・近くの枕木の並べ直し */
  _updateSleepers(s) {
    const C = this._slpCol;
    if (C) {
      /* 速度が上がったら枕木を砂利の明るさに近づける(細かい縞のちらつきを抑える) */
      const v = this.sim ? this.sim.v : 0;
      this.M.sleeper.color.lerpColors(C.base, C.far, 0.55 * smoothstep(45, 100, v));
    }
    updateExitGlow(this);
    updateCatenaryLod(this);
    if (Math.abs(s - this._slpBase) < 12) return;
    this._slpBase = s;
    const T = this._slpTmp, f = T.f, m = T.m, q = T.q, p = T.p;
    const L = this.line.meta.length, qi = this._qi, rivers = this.line.sections.river;
    const im = this.sleepers;
    let n = 0;
    for (let si = 0; si < this._slpSpec.length; si++) {
      const sp = this._slpSpec[si];
      const s0 = Math.floor((s - sp.back) / 0.625) * 0.625;
      for (let i = 0; i < sp.count; i++) {
        const ss = s0 + i * 0.625;
        let off = sp.off || 0;
        let ok = ss >= 2 && ss <= L - 2;
        /* 急行線: となりの線路から十分はなれたところだけ(分岐の手前は本線の枕木が受け持つ) */
        if (ok && sp.zone) { ok = quadSep(ss, sp.k, qi) >= 2.0; off = quadOffAt(ss, sp.k, qi); }
        if (!ok) continue;   // 範囲外は描かない(描く数を詰める)
        frameInto(this.frames, this.step, ss, f);
        p.copy(f.p).addScaledVector(f.left, off);
        p.y -= 0.01;
        q.setFromUnitVectors(T.X, f.left);
        m.compose(p, q, T.one);
        im.setMatrixAt(n, m);
        let br = false;
        for (let r = 0; r < rivers.length; r++) if (ss >= rivers[r].from && ss <= rivers[r].to) br = true;
        im.setColorAt(n, br ? C.timber : C.white);
        n++;
      }
    }
    im.count = n;
    im.instanceMatrix.needsUpdate = true;
    im.instanceColor.needsUpdate = true;
  }

  /* ---------- 架線(門型のトラスビーム・可動ブラケット・ジグザグのトロリ線) ---------- */
  _buildLineside() {
    const Q = QUALITY[this.quality];
    buildCatenary(this, { aniso: Q.aniso, shadows: Q.shadowsOn });
  }

  _inTunnel(s) {
    return this.line.sections.tunnel.some((t) => s > t.from && s < t.to);
  }

  /* 新宿ターミナルの屋根の下か */
  _inTerminal(s, margin = 0) {
    const T = this.terminal;
    return !!T && s > T.a - margin && s < T.b + margin;
  }

  /* ---------- 駅 ---------- */
  _buildStations() {
    const F = this.frames;
    const matRoof = new THREE.MeshStandardMaterial({ color: 0x525c66, metalness: 0.25, roughness: 0.65, side: DS });
    matRoof.envMapIntensity = 1.25;
    const matTactile = new THREE.MeshStandardMaterial({ map: texTactile(), roughness: 0.9, side: DS });
    matTactile.map.repeat.set(1, 1);
    const colGeo = new THREE.CylinderGeometry(0.09, 0.09, 3.35, 8);
    const colList = [];
    this.line.stations.forEach((st, si) => {
      const i0 = Math.max(0, Math.floor((st.s - 155) / this.step));
      const i1 = Math.min(F.length - 1, Math.ceil((st.s + 15) / this.step));
      const under = this._inTunnel(st.s);
      /* ホーム（自線の左側=島式風・上り線側にも） */
      [[3.05, 1], [-6.85, -1]].forEach(([off]) => {
        const plat = new THREE.Mesh(ribbon(F, i0, i1, off, 2.4, 1.02, 4), this.M.plat);
        plat.receiveShadow = true;
        plat.castShadow = true;
        this.world.add(plat);
        const edgeOff = off + (off > 0 ? -1.0 : 1.0);
        this.world.add(new THREE.Mesh(ribbon(F, i0, i1, edgeOff, 0.4, 1.03, 0.64), matTactile));
        /* ホーム側壁(線路側) */
        const sideOff = off + (off > 0 ? -1.2 : 1.2);
        const pside = new THREE.Mesh(vribbon(F, i0, i1, sideOff, -0.15, 1.02, 3), this.M.platSide);
        pside.castShadow = true;
        this.world.add(pside);
        if (!under && !this._inTerminal(st.s)) {
          const roof = new THREE.Mesh(ribbon(F, i0 + 3, i1 - 1, off, 3.2, 4.4, 20), matRoof);
          roof.castShadow = true;
          this.world.add(roof);
          /* 屋根柱 */
          for (let s = st.s - 140; s < st.s + 8; s += 14) {
            const f = frameAt(F, this.step, s);
            const p = f.p.clone().addScaledVector(f.left, off);
            p.y += 1.02 + 3.35 / 2;
            colList.push(p);
          }
        }
      });
      /* 駅名標(漢字+ひらがな。実物の駅名標もかな併記) */
      const prev = this.line.stations[si - 1], next = this.line.stations[si + 1];
      const tex = boardTexture([
        [st.name, 38, 36],
        [STATION_KANA[st.name] || '', 70, 17, 'normal'],
        [st.code, 92, 13, 'normal'],
        [`${prev ? '◀ ' + prev.name : ''}    ${next ? next.name + ' ▶' : ''}`, 114, 14, 'normal'],
      ], { bg: '#f5f8fa', border: '#1b56a7', fg: '#16283a', w: 512, h: 128 });
      const board = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 0.85),
        new THREE.MeshBasicMaterial({ map: tex }));
      const f = frameAt(F, this.step, st.s - 55);
      board.position.copy(f.p).addScaledVector(f.left, 3.0);
      board.position.y += 2.5;
      board.lookAt(board.position.clone().addScaledVector(f.t, -10));
      this.world.add(board);
      /* 停止位置目標（8両） */
      const stopTex = boardTexture([['8', 60, 72]], { bg: '#111', fg: '#fff', border: '#fff', w: 96, h: 96 });
      const stop = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.42),
        new THREE.MeshBasicMaterial({ map: stopTex }));
      /* 運転台の窓から見やすいよう、停止位置の少し先・目の高さ寄りに置く */
      const fs = frameAt(F, this.step, st.s + 4.5);
      stop.position.copy(fs.p).addScaledVector(fs.left, 2.6);
      stop.position.y += 2.15;
      stop.lookAt(stop.position.clone().addScaledVector(fs.t, -10));
      this.world.add(stop);
    });
    /* 屋根柱(全駅まとめてインスタンス描画) */
    const matCol = new THREE.MeshStandardMaterial({ color: 0x9aa0a5, metalness: 0.5, roughness: 0.5 });
    const cols = new THREE.InstancedMesh(colGeo, matCol, colList.length);
    cols.castShadow = true;
    const m4 = new THREE.Matrix4();
    colList.forEach((p, i) => { m4.makeTranslation(p.x, p.y, p.z); cols.setMatrixAt(i, m4); });
    this.world.add(cols);

    /* ホーム屋根下の照明(夜モードで点灯) */
    const lampSpots = [];
    this.line.stations.forEach((st) => {
      if (this._inTunnel(st.s) || this._inTerminal(st.s)) return;
      [3.05, -6.85].forEach((off) => {
        for (let s = st.s - 140; s < st.s + 6; s += 12) {
          const f = frameAt(F, this.step, s);
          lampSpots.push({ f, off });
        }
      });
    });
    const slGeo = new THREE.BoxGeometry(0.14, 0.08, 1.7);
    const slMat = new THREE.MeshBasicMaterial({ color: 0xfff3d2 });
    this.stationLamps = new THREE.InstancedMesh(slGeo, slMat, lampSpots.length);
    const q4 = new THREE.Quaternion(), one4 = new THREE.Vector3(1, 1, 1), m4b = new THREE.Matrix4();
    lampSpots.forEach((a, i) => {
      q4.setFromUnitVectors(new THREE.Vector3(0, 0, 1), a.f.t);
      m4b.compose(a.f.p.clone().addScaledVector(a.f.left, a.off).setY(a.f.p.y + 4.15), q4, one4);
      this.stationLamps.setMatrixAt(i, m4b);
    });
    this.stationLamps.visible = false;
    this.world.add(this.stationLamps);
  }

  /* ---------- 信号機 ---------- */
  _buildSignals() {
    const F = this.frames;
    if (this._sigGroup) {
      this.world.remove(this._sigGroup);
      this._sigGroup.traverse((o) => { if (o.material && o.material.isSpriteMaterial) o.material.dispose(); });
    }
    this._sigGroup = new THREE.Group();
    this.world.add(this._sigGroup);
    this.signalMeshes = [];
    if (!this._sigRes) {
      const hood = new THREE.CylinderGeometry(0.17, 0.17, 0.22, 14, 1, true, -Math.PI * 0.62, Math.PI * 1.24);
      hood.rotateX(Math.PI / 2);
      hood.translate(0, 0, 0.22);
      this._sigRes = {
        bodyGeo: new THREE.BoxGeometry(0.46, 1.2, 0.24),
        plateGeo: new THREE.CircleGeometry(0.36, 20),
        poleGeo: new THREE.CylinderGeometry(0.07, 0.09, 4.4, 6),
        lampGeo: new THREE.CircleGeometry(0.13, 14),
        hoodGeo: hood,
        matBody: new THREE.MeshStandardMaterial({ color: 0x1f2428, roughness: 0.7 }),
        matPlate: new THREE.MeshStandardMaterial({ color: 0x111316, roughness: 0.8, side: DS }),
        matPole: new THREE.MeshStandardMaterial({ color: 0x6d757c, metalness: 0.5, roughness: 0.5 }),
        glowT: texGlow(),
        off: new THREE.MeshBasicMaterial({ color: 0x14171a }),
        on: { G: new THREE.MeshBasicMaterial({ color: new THREE.Color(0x22e06a).multiplyScalar(2.2) }),
          Y: new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffc12b).multiplyScalar(2.2) }),
          R: new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff4838).multiplyScalar(2.2) }) },
      };
      [this._sigRes.matBody, this._sigRes.matPlate, this._sigRes.matPole, this._sigRes.off,
        ...Object.values(this._sigRes.on)].forEach((m) => this._keep.add(m));
    }
    const R = this._sigRes;
    this.sim.signals.forEach((sig) => {
      const f = frameAt(F, this.step, sig.s);
      const g = new THREE.Group();
      const pole = new THREE.Mesh(R.poleGeo, R.matPole);
      pole.position.y = 2.2;
      pole.castShadow = true;
      g.add(pole);
      const body = new THREE.Mesh(R.bodyGeo, R.matBody);
      body.position.y = 4.6;
      body.castShadow = true;
      g.add(body);
      /* 背板(現示を見やすくする黒い丸板) */
      [0.36, -0.36].forEach((dy) => {
        const pl = new THREE.Mesh(R.plateGeo, R.matPlate);
        pl.position.set(0, 4.6 + dy * 0.5, 0.125);
        pl.scale.set(1, 1.5, 1);
        g.add(pl);
      });
      const lamps = [];
      [['G', 0.36, 0x22e06a], ['Y', 0, 0xffc12b], ['R', -0.36, 0xff4838]].forEach(([k, dy, col]) => {
        const lamp = new THREE.Mesh(R.lampGeo, R.off);
        lamp.position.set(0, 4.6 + dy, 0.13);
        g.add(lamp);
        const hd = new THREE.Mesh(R.hoodGeo, R.matBody);
        hd.position.set(0, 4.6 + dy, 0.0);
        g.add(hd);
        const glow = new THREE.Sprite(new THREE.SpriteMaterial({
          map: R.glowT, color: col, transparent: true, opacity: 0.55,
          blending: THREE.AdditiveBlending, depthWrite: false,
        }));
        glow.scale.set(0.7, 0.7, 1);
        glow.position.set(0, 4.6 + dy, 0.24);
        glow.visible = false;
        g.add(glow);
        lamps.push({ k, lamp, col, glow });
      });
      g.position.copy(f.p).addScaledVector(f.left, 2.6);
      g.lookAt(g.position.clone().addScaledVector(f.t, -10));
      this._sigGroup.add(g);
      this.signalMeshes.push({ sig, lamps, asp: -1 });
    });
  }

  /* ---------- 制限標識 ---------- */
  _buildBoards() {
    const F = this.frames;
    this.line.limits.forEach((z) => {
      const tex = boardTexture([[String(z.v), 62, 66]], { bg: '#e6bd1d', fg: '#111', border: '#111', w: 112, h: 112 });
      const b = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.7), new THREE.MeshBasicMaterial({ map: tex }));
      const f = frameAt(F, this.step, Math.max(5, z.from - 15));
      b.position.copy(f.p).addScaledVector(f.left, 2.3);
      b.position.y += 1.6;
      b.lookAt(b.position.clone().addScaledVector(f.t, -10));
      this.world.add(b);
      /* 解除標 */
      const tex2 = boardTexture([['解', 60, 56]], { bg: '#f2f2ee', fg: '#111', border: '#111', w: 96, h: 96 });
      const b2 = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.55), new THREE.MeshBasicMaterial({ map: tex2 }));
      const f2 = frameAt(F, this.step, Math.min(this.line.meta.length - 5, z.to + 10));
      b2.position.copy(f2.p).addScaledVector(f2.left, 2.3);
      b2.position.y += 1.5;
      b2.lookAt(b2.position.clone().addScaledVector(f2.t, -10));
      this.world.add(b2);
    });
  }

  /* ---------- 街並み ---------- */
  _buildTown() {
    const F = this.frames;
    const rng = (() => { let x = 12345; return () => (x = (x * 16807) % 2147483647) / 2147483647; })();
    /* 昼テクスチャと夜テクスチャ(窓明かり)の両方を用意し、夜モードで差し替える */
    const bldDefs = [
      ['#8f979e', { shop: true, seed: 1 }, { roughness: 0.85 }],
      ['#a39b90', { balcony: true, winRatio: 0.8, seed: 2 }, { roughness: 0.9 }],
      ['#79828c', { shop: true, winRatio: 0.95, seed: 3 }, { roughness: 0.7, metalness: 0.15 }],
    ];
    this._bldMats = [];
    const mats = bldDefs.map(([base, o, mo]) => {
      const day = texBuilding(base, o);
      const nightT = texBuilding(base, { ...o, night: true });
      const m = new THREE.MeshStandardMaterial({ map: day, ...mo });
      this._bldMats.push({ m, day, night: nightT });
      return m;
    });
    {
      const day = texHouse();
      const nightT = texHouse({ night: true });
      const m = new THREE.MeshStandardMaterial({ map: day, roughness: 0.9 });
      this._bldMats.push({ m, day, night: nightT });
      mats.push(m);
    }
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0);
    const groups = mats.map((m) => ({ m, list: [] }));
    const aoList = [];      // 建物の接地影(擬似AO)
    const roofUnits = [];   // 屋上の室外機・機械
    const urban = this.line.sections.urban;
    const kindAt = (s) => (urban.find((u) => s >= u.from && s < u.to) || { kind: 2 }).kind;
    for (let s = 40; s < this.line.meta.length - 40; s += 26) {
      if (this._inTunnel(s) || this._inTerminal(s, 45)) continue;
      const inRiver = this.line.sections.river.some((r) => s > r.from - 60 && s < r.to + 60);
      if (inRiver) continue;
      const kind = kindAt(s);
      const f = frameAt(F, this.step, s + rng() * 18);
      for (const side of [1, -1]) {
        if (side < 0 && this.depotZone && s > this.depotZone.a - 40 && s < this.depotZone.b + 40) continue;
        const nBld = kind === 0 ? 3 : kind === 1 ? 2 : kind === 2 ? 2 : 1;
        for (let bi = 0; bi < nBld; bi++) {
          if (rng() < (kind === 3 ? 0.45 : 0.25)) continue;
          const dist = 16 + rng() * (kind === 0 ? 90 : 70) + bi * 22;
          const h = kind === 0 ? 22 + rng() * 95
            : kind === 1 ? 8 + rng() * 22
            : kind === 2 ? 5 + rng() * 13
            : 4 + rng() * 5;
          const w = kind === 3 ? 7 + rng() * 4 : 9 + rng() * 16;
          const dpt = kind === 3 ? 7 + rng() * 3 : 9 + rng() * 14;
          const p = f.p.clone().addScaledVector(f.left, side * (dist + (side > 0 ? 0 : 4)));
          const mi = kind === 3 && h < 9 ? 3 : Math.floor(rng() * 3);
          const rot = rng() * 0.5 - 0.25;
          groups[mi].list.push({ p, h, w, dpt, rot });
          aoList.push({ p, w, dpt, rot });
          /* 屋上の機械(近いビルだけ) */
          if (mi < 3 && dist < 80 && h > 10) {
            const nu = 1 + Math.floor(rng() * 2);
            for (let u = 0; u < nu; u++) {
              roofUnits.push({
                x: p.x + (rng() - 0.5) * w * 0.5, y: p.y - 1.5 + h + 0.45,
                z: p.z + (rng() - 0.5) * dpt * 0.5,
                sx: 1.1 + rng() * 1.8, sy: 0.8 + rng() * 1.0, sz: 1.0 + rng() * 1.5, rot,
              });
            }
          }
          /* 超高層はセットバック(上に細い塔を重ねる) */
          if (kind === 0 && h > 60 && rng() < 0.55) {
            const p2 = p.clone();
            p2.y += h * 0.7;
            groups[mi].list.push({ p: p2, h: h * 0.42, w: w * 0.72, dpt: dpt * 0.72, rot });
          }
        }
      }
    }
    /* 遠景ベルト(市街地のみ、150〜420m帯に大きめの箱) */
    for (let s = 60; s < this.line.meta.length - 60; s += 55) {
      const kind = kindAt(s);
      if (kind > 1) continue;
      if (this.line.sections.river.some((r) => s > r.from - 150 && s < r.to + 150)) continue;
      const f = frameAt(F, this.step, s + rng() * 30);
      for (const side of [1, -1]) {
        const nB = kind === 0 ? 2 : 1;
        for (let bi = 0; bi < nB; bi++) {
          if (rng() < 0.3) continue;
          const dist = 150 + rng() * 270;
          const h = kind === 0 ? 25 + rng() * 70 : 10 + rng() * 20;
          const bp = f.p.clone().addScaledVector(f.left, side * dist);
          const bw = 18 + rng() * 26, bd = 16 + rng() * 22, brot = rng() * 0.6 - 0.3;
          groups[Math.floor(rng() * 3)].list.push({ p: bp, h, w: bw, dpt: bd, rot: brot });
          aoList.push({ p: bp, w: bw, dpt: bd, rot: brot });
        }
      }
    }
    const houseTf = [];
    groups.forEach(({ m, list }, gi) => {
      const im = new THREE.InstancedMesh(geo, m, list.length);
      im.castShadow = true;
      const mat4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
      const col = new THREE.Color();
      list.forEach((b, i) => {
        e.set(0, b.rot, 0); q.setFromEuler(e);
        mat4.compose(new THREE.Vector3(b.p.x, b.p.y - 1.5, b.p.z), q, new THREE.Vector3(b.w, b.h, b.dpt));
        im.setMatrixAt(i, mat4);
        const l = gi === 3 ? 0.76 + rng() * 0.16 : 0.82 + rng() * 0.24;
        col.setRGB(Math.min(1, l), Math.min(1, l * (0.97 + rng() * 0.05)), Math.min(1, l * (0.94 + rng() * 0.08)), THREE.SRGBColorSpace);
        im.setColorAt(i, col);
        if (gi === 3) houseTf.push(b);
      });
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      this.world.add(im);
    });
    /* 建物の接地影(擬似AO。地面に薄黒い板を敷いて「浮き」を消す) */
    if (aoList.length) {
      const aoGeo = new THREE.PlaneGeometry(1, 1);
      aoGeo.rotateX(-Math.PI / 2);
      const aoMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.24, depthWrite: false });
      const aoIm = new THREE.InstancedMesh(aoGeo, aoMat, aoList.length);
      const m4a = new THREE.Matrix4(), qa = new THREE.Quaternion(), ea = new THREE.Euler();
      aoList.forEach((a, i) => {
        ea.set(0, a.rot, 0); qa.setFromEuler(ea);
        m4a.compose(new THREE.Vector3(a.p.x, a.p.y - 0.46, a.p.z), qa, new THREE.Vector3(a.w * 1.28, 1, a.dpt * 1.28));
        aoIm.setMatrixAt(i, m4a);
      });
      this.world.add(aoIm);
    }
    /* 屋上の室外機・機械 */
    if (roofUnits.length) {
      const ruGeo = new THREE.BoxGeometry(1, 1, 1);
      ruGeo.translate(0, 0.5, 0);
      const ruMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a4, roughness: 0.7, metalness: 0.3 });
      const ruIm = new THREE.InstancedMesh(ruGeo, ruMat, roofUnits.length);
      const m4r = new THREE.Matrix4(), qr = new THREE.Quaternion(), er = new THREE.Euler();
      roofUnits.forEach((u, i) => {
        er.set(0, u.rot, 0); qr.setFromEuler(er);
        m4r.compose(new THREE.Vector3(u.x, u.y, u.z), qr, new THREE.Vector3(u.sx, u.sy, u.sz));
        ruIm.setMatrixAt(i, m4r);
      });
      this.world.add(ruIm);
    }
    /* 戸建ての寄棟屋根 */
    if (houseTf.length) {
      const roofGeo = new THREE.ConeGeometry(0.74, 1, 4);
      roofGeo.rotateY(Math.PI / 4);
      const roofMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
      const roofs = new THREE.InstancedMesh(roofGeo, roofMat, houseTf.length);
      roofs.castShadow = true;
      /* 屋根の色に瓦らしいバリエーションを付ける(街の見分けやすさ) */
      const roofCols = [0x6e4438, 0x44546a, 0x4e6248, 0x5c4f42, 0x4c5258];
      const mat4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
      const rcol = new THREE.Color();
      houseTf.forEach((b, i) => {
        e.set(0, b.rot, 0); q.setFromEuler(e);
        mat4.compose(
          new THREE.Vector3(b.p.x, b.p.y - 1.5 + b.h + 0.9, b.p.z), q,
          new THREE.Vector3(b.w * 1.04, 2.0, b.dpt * 1.04));
        roofs.setMatrixAt(i, mat4);
        rcol.setHex(roofCols[i % roofCols.length]);
        const jit = 0.85 + rng() * 0.3;
        rcol.multiplyScalar(jit);
        roofs.setColorAt(i, rcol);
      });
      if (roofs.instanceColor) roofs.instanceColor.needsUpdate = true;
      this.world.add(roofs);
    }
  }

  /* ---------- 沿線の柵・防音壁 ----------
   * 市街地は厚みのある防音壁(パネルの継ぎ目・H形鋼の柱・笠木)、郊外は金網フェンス。
   * 左側は複々線では上り急行線の外(QUAD_OFF[1]+3.6m)。トンネルの掘割・駅・川・踏切では切る */
  _buildFences() {
    const F = this.frames, L = this.line.meta.length, step = this.step;
    const urban = this.line.sections.urban;
    const kindAt = (s) => (urban.find((u) => s >= u.from && s < u.to) || { kind: 2 }).kind;
    const qi = this._qi || quadInfo(this.line);
    const nearStation = (s) => this.line.stations.some((st) => s > st.s - 170 && s < st.s + 30);
    const inRiver = (s) => this.line.sections.river.some((r) => s > r.from - 30 && s < r.to + 30);
    /* 川の前後は盛り土の上なので、足元を深くする */
    const onEmb = (s) => this.line.sections.river.some((r) => s > r.from - 245 && s < r.to + 245);
    const inCut = (s) => this.line.sections.tunnel.some((t) => s > t.from - 165 && s < t.to + 165);
    const matFence = new THREE.MeshStandardMaterial({
      map: texFence(), alphaTest: 0.3, side: DS, roughness: 0.8, metalness: 0.3,
    });
    const ends = [];
    const emit = (run, side) => {
      const i0 = Math.floor(run.s0 / step), i1 = Math.ceil(run.s1 / step);
      if (i1 - i0 < 3) return;
      const off = side > 0 ? (i) => fenceOffL(i * step, qi) : () => -8.9;
      const y0 = (i) => (onEmb(i * step) ? -1.7 : -0.55);
      if (run.type === 'wall') {
        /* 外の面と、0.2m内側の面(厚み)+上の笠木 */
        [off, (i) => off(i) - side * 0.2].forEach((o) => {
          const w = new THREE.Mesh(vribbon(F, i0, i1, o, y0, 1.9, 2), this.M.soundWall);
          w.castShadow = true; w.receiveShadow = true;
          this.world.add(w);
        });
        const cap = new THREE.Mesh(ribbon(F, i0, i1, (i) => off(i) - side * 0.1, 0.32, 1.93, 0.6), this.M.trough);
        cap.receiveShadow = true;
        this.world.add(cap);
        [i0, i1].forEach((i) => ends.push({ i, off: off(i) - side * 0.1 }));
      } else {
        this.world.add(new THREE.Mesh(vribbon(F, i0, i1, off, y0, 1.05, 2), matFence));
      }
    };
    const nearCross = (s) => this.crossSpots.some((c) => Math.abs(c - s) < 14);
    for (const side of [1, -1]) {
      let cur = null;
      for (let s = 25; s < L - 25; s += 5) {
        let type = null;
        if (!this._inTunnel(s) && !inCut(s) && !nearStation(s) && !inRiver(s) && !nearCross(s) && !this._inTerminal(s, 5)) {
          type = kindAt(s) <= 1 ? 'wall' : 'fence';
        }
        if (type === null) {
          if (cur) { emit(cur, side); cur = null; }
        } else if (!cur || cur.type !== type) {
          if (cur) emit(cur, side);
          cur = { s0: s, s1: s, type };
        } else {
          cur.s1 = s;
        }
      }
      if (cur) emit(cur, side);
    }
    /* 防音壁の端の柱(H形鋼) */
    if (ends.length) {
      const g = new THREE.BoxGeometry(0.34, 2.6, 0.3);
      g.translate(0, 1.3 - 0.65, 0);
      const im = new THREE.InstancedMesh(g, new THREE.MeshStandardMaterial({ color: 0x8e959b, metalness: 0.4, roughness: 0.6 }), ends.length);
      const m4 = new THREE.Matrix4(), qq = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), X = new THREE.Vector3(1, 0, 0);
      ends.forEach(({ i, off }, k) => {
        const f = F[Math.max(0, Math.min(F.length - 1, i))];
        qq.setFromUnitVectors(X, f.left);
        m4.compose(f.p.clone().addScaledVector(f.left, off), qq, one);
        im.setMatrixAt(k, m4);
      });
      im.castShadow = true;
      this.world.add(im);
    }
  }

  /* ---------- 並木・樹木 ---------- */
  _buildTrees() {
    const F = this.frames, L = this.line.meta.length;
    const rng = (() => { let x = 7777; return () => (x = (x * 16807) % 2147483647) / 2147483647; })();
    const urban = this.line.sections.urban;
    const kindAt = (s) => (urban.find((u) => s >= u.from && s < u.to) || { kind: 2 }).kind;
    const q = this.line.sections.quad;
    const nearStation = (s) => this.line.stations.some((st) => s > st.s - 165 && s < st.s + 25);
    const inRiver = (s) => this.line.sections.river.some((r) => s > r.from - 80 && s < r.to + 80);
    const list = [];
    for (let s = 60; s < L - 60; s += 22) {
      if (this._inTunnel(s) || inRiver(s) || this._inTerminal(s, 40)) continue;
      const k = kindAt(s);
      const f = frameAt(F, this.step, s + rng() * 20);
      /* 線路際の並木(郊外のみ。防音壁区間には置かない) */
      const pNear = k === 3 ? 0.55 : k === 2 ? 0.38 : 0;
      if (this.crossSpots.some((c) => Math.abs(c - s) < 24)) continue;
      for (const side of [1, -1]) {
        const inDepot = side < 0 && this.depotZone && s > this.depotZone.a - 40 && s < this.depotZone.b + 40;
        if (inDepot) continue;
        if (pNear > 0 && rng() < pNear && !nearStation(s)) {
          let base = side > 0 ? 7.2 : 10.4;
          if (side > 0 && s > q.from - 30 && s < q.to + 30) base = 11.4;
          const off = side * (base + rng() * 5.5);
          const p = f.p.clone().addScaledVector(f.left, off);
          list.push({ p, sc: 0.7 + rng() * 0.8, tint: 0.75 + rng() * 0.35 });
        }
        /* 郊外の散在林 */
        if (k >= 2) {
          const n = k === 3 ? (rng() < 0.6 ? 2 : 3) : (rng() < 0.5 ? 1 : 2);
          for (let i = 0; i < n; i++) {
            if (rng() < 0.4) continue;
            const off = side * (20 + rng() * 78);
            const p = f.p.clone().addScaledVector(f.left, off);
            p.y -= 0.5;
            list.push({ p, sc: 0.85 + rng() * 0.9, tint: 0.7 + rng() * 0.4, conifer: k === 3 && rng() < 0.3 });
          }
        }
      }
    }
    this._plantTrees(list, rng);
  }

  /* 木を植える(広葉樹2種+針葉樹1種)。list: [{p, sc, tint, conifer?}] */
  _plantTrees(list, rng) {
    if (!this._treeGeos) this._treeGeos = makeTreeGeos();
    const G = this._treeGeos;
    const trunkMat = this._treeTrunkMat || (this._treeTrunkMat = new THREE.MeshStandardMaterial({ color: 0x584736, roughness: 0.95 }));
    const folMat = this._treeFolMat || (this._treeFolMat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.92 }));
    this._keep.add(trunkMat); this._keep.add(folMat);
    const groups = [[], [], []];
    list.forEach((t) => groups[t.conifer ? 2 : (rng() < 0.5 ? 0 : 1)].push(t));
    const m4 = new THREE.Matrix4(), qt = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3();
    const col = new THREE.Color();
    groups.forEach((arr, gi) => {
      if (!arr.length) return;
      const trunks = new THREE.InstancedMesh(gi === 2 ? G.trunkC : G.trunk, trunkMat, arr.length);
      const fol = new THREE.InstancedMesh(G.fol[gi], folMat, arr.length);
      trunks.castShadow = true; fol.castShadow = true;
      arr.forEach((t, i) => {
        e.set(0, rng() * Math.PI * 2, 0); qt.setFromEuler(e);
        sc.set(t.sc, t.sc * (0.88 + rng() * 0.3), t.sc);
        m4.compose(t.p, qt, sc);
        trunks.setMatrixAt(i, m4);
        fol.setMatrixAt(i, m4);
        if (gi === 2) col.setRGB(t.tint * 0.24, t.tint * 0.36, t.tint * 0.27, THREE.SRGBColorSpace);
        else col.setRGB(t.tint * 0.42, t.tint * 0.52, t.tint * 0.30, THREE.SRGBColorSpace);
        fol.setColorAt(i, col);
      });
      if (fol.instanceColor) fol.instanceColor.needsUpdate = true;
      this.world.add(trunks, fol);
    });
  }

  /* ---------- トンネル（下北沢地下区間） ----------
   * 坑口は線路の上が開いた門形(柱+梁+笠石)。上には土かぶり、出入口には掘割。
   * 壁は型枠の目地とケーブル受け。中から見た出口は明るく抜ける(scene/trackbed.js)。
   * 照明(灯具・光だまり)は駅の担当(_buildTunnelLights)で作る */
  _buildTunnel() {
    buildTunnel(this, { aniso: QUALITY[this.quality].aniso });
  }

  /* ---------- 多摩川橋梁 ----------
   * 自線・上り線の組と急行線の組、2本並んだワーレントラス(斜材・上横構・端柱)。
   * 橋の上は木のまくら木のすき間から川面が見える。前後は堤防と盛り土 */
  _buildRiver() {
    buildRiver(this, { aniso: QUALITY[this.quality].aniso });
  }

  /* ---------- 車両(TrainKit: scene/trains.js) ---------- */
  _kit() {
    if (!this.trainKit) {
      this.trainKit = new TrainKit({ quality: QUALITY[this.quality].trainDetail });
      this.trainKit.setNight(this.timeOfDay !== 'day' || this.weather !== 'clear');
    }
    return this.trainKit;
  }

  /* kind: 'local'|'exp'|'rapid' */
  makeTrainModel(nCars, { kind = 'local', dest = '新百合ヶ丘' } = {}) {
    const label = { local: '各停', exp: '急行', rapid: '快急' }[kind] || '各停';
    return this._kit().makeTrain(nCars, { kind, dest: `${label} ${dest}` });
  }

  setTrainLights(train, o) { this._kit().setLights(train, o); }

  setTrainDest(train, kind, dest) {
    const label = { local: '各停', exp: '急行', rapid: '快急' }[kind] || '各停';
    this._kit().setDest(train, `${label} ${dest}`, kind);
  }

  /* 形状・材質は TrainKit で共有。編成ごとの表記テクスチャだけ解放する */
  disposeTrainModel(train) { if (this.trainKit && train) this.trainKit.release(train); }

  /* ---------- 停止位置の光の目印(こどもサポート) ---------- */
  _buildStopBeam() {
    const cv = document.createElement('canvas');
    cv.width = 32; cv.height = 128;
    const c = cv.getContext('2d');
    const g = c.createLinearGradient(0, 0, 0, 128);
    g.addColorStop(0, 'rgba(120,220,255,0)');
    g.addColorStop(0.75, 'rgba(120,220,255,0.55)');
    g.addColorStop(1, 'rgba(170,240,255,0.95)');
    c.fillStyle = g; c.fillRect(0, 0, 32, 128);
    const tex = new THREE.CanvasTexture(cv);
    this._beamMat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false, side: DS,
    });
    const geo = new THREE.PlaneGeometry(1.05, 9);
    const p1 = new THREE.Mesh(geo, this._beamMat);
    const p2 = new THREE.Mesh(geo, this._beamMat);
    p2.rotation.y = Math.PI / 2;
    this.stopBeam = new THREE.Group();
    this.stopBeam.add(p1, p2);
    this.stopBeam.visible = false;
    this.world.add(this.stopBeam);
  }

  /* ---------- 駅ごとの実在風ランドマーク ---------- */
  _stationS(name) {
    const st = this.line.stations.find((s) => s.name === name);
    return st ? st.s : null;
  }

  _buildLandmarks() {
    this._buildTerminal();
    this._buildTorii();
    this._buildDepot();
    this._buildWheel();
    this._buildUmeGrove();
  }

  /* 新宿: 頭端式ターミナル(駅ビルの下の薄暗いホーム・車止め・発車を待つ電車) */
  _terminalInfo() {
    const st = this.line.stations.find((x) => x.name === '新宿');
    if (!st) return null;
    const up = this.line.meta.direction === 'up';
    const L = this.line.meta.length;
    return {
      s0: st.s, up,
      a: Math.max(2, st.s - 195), b: Math.min(L - 2, st.s + 32),
      buffer: up ? st.s + 24 : st.s - 172,        // 車止めの位置
    };
  }

  _buildTerminal() {
    const T = this._terminalInfo();
    if (!T) return;
    const F = this.frames;
    const i0 = Math.floor(T.a / this.step), i1 = Math.ceil(T.b / this.step);
    const W_L = 8.9, W_R = -12.6;                   // 左右の壁(線路中心からの距離)
    const H = 7.4;                                  // 天井の高さ
    const ceilMat = new THREE.MeshStandardMaterial({ color: 0x4a5056, roughness: 0.9, side: DS });
    const wallMat = new THREE.MeshStandardMaterial({ map: this.T.concWallC, color: 0x8e9298, roughness: 0.95, side: DS });
    /* 天井スラブ(厚み: 下面+上面) */
    const ceil = new THREE.Mesh(ribbon(F, i0, i1, (W_L + W_R) / 2, W_L - W_R + 0.6, H, 6), ceilMat);
    ceil.castShadow = true; ceil.receiveShadow = true;
    this.world.add(ceil);
    /* 左右の壁 */
    [W_L, W_R].forEach((off) => {
      const w = new THREE.Mesh(vribbon(F, i0, i1, off, -0.3, H, 6), wallMat);
      w.castShadow = true;
      this.world.add(w);
    });
    /* 追加の線路(左: 6.1 / 右: -10.1)と、そこで発車を待つ電車 */
    [6.1, -10.1].forEach((off) => {
      this.world.add(new THREE.Mesh(ribbon(F, i0, i1, off, 3.8, 0, 2.5), this.M.ballast));
      [-RAIL_HALF, RAIL_HALF].forEach((o) => {
        this.world.add(new THREE.Mesh(ribbon(F, i0, i1, off + o, 0.068, 0.19, 25), this.M.railHead));
        this.world.add(new THREE.Mesh(vribbon(F, i0, i1, off + o + 0.034, 0.05, 0.178, 8), this.M.railWeb));
      });
    });
    const dest = T.up ? '新百合ヶ丘' : '新百合ヶ丘';
    [[6.1, 'rapid', 10], [-10.1, 'exp', 8]].forEach(([off, kind, n]) => {
      const tr = this.makeTrainModel(n, { kind, dest });
      this.setTrainLights(tr, { head: true, tail: true });
      /* 出口のほうを向いて止まっている */
      const head = T.up ? T.s0 - 150 : T.s0 - 4;
      placeTrain(this, tr, head, T.up ? -1 : 1, off);
      this.world.add(tr.group);
    });
    /* 右側のホーム(-10.1線と-3.8線のあいだ)の続き: 既存の -6.85 ホームを使う。左は既存 3.05 */
    /* 柱(ホームの中心線上に10m間隔・角柱) */
    const colGeo = new THREE.BoxGeometry(0.55, H, 0.55);
    colGeo.translate(0, H / 2, 0);
    const colMat = new THREE.MeshStandardMaterial({ color: 0xb8bcc0, roughness: 0.7, metalness: 0.1 });
    const cols = [];
    for (let s = T.a + 8; s < T.b - 4; s += 10) [3.05, -6.85].forEach((off) => cols.push([s, off]));
    const cim = new THREE.InstancedMesh(colGeo, colMat, cols.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
    cols.forEach(([ss, off], i) => {
      const f = frameAt(F, this.step, ss);
      q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), f.t);
      m4.compose(f.p.clone().addScaledVector(f.left, off).setY(f.p.y + 1.0), q, one);
      cim.setMatrixAt(i, m4);
    });
    cim.castShadow = true;
    this.world.add(cim);
    /* 天井の照明(線路と平行の光の帯。夜でなくてもホームは明るい) */
    const lightMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xfff2d8).multiplyScalar(1.6), side: DS });
    [4.6, 1.4, -2.0, -5.4, -8.3].forEach((off) => {
      this.world.add(new THREE.Mesh(ribbon(F, i0 + 1, i1 - 1, off, 0.32, H - 0.05, 4), lightMat));
    });
    /* 出口(駅ビルの外壁): 開口部の上に厚い梁と、上にそびえる駅ビル */
    const exitS = T.up ? T.a : T.b;
    const backS = T.up ? T.b : T.a;
    const fx = frameAt(F, this.step, exitS);
    const beam = new THREE.Mesh(new THREE.BoxGeometry(W_L - W_R + 6, 2.6, 2.2),
      new THREE.MeshStandardMaterial({ map: this.T.concC, color: 0xb6b3ab, roughness: 0.9 }));
    beam.position.copy(fx.p).addScaledVector(fx.left, (W_L + W_R) / 2);
    beam.position.y += H + 1.0;
    beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), fx.t);
    beam.castShadow = true;
    this.world.add(beam);
    /* 駅ビル(ホームの真上に建つ大きな建物) */
    const mid = frameAt(F, this.step, (T.a + T.b) / 2);
    const bt = texBuilding('#8c949b', { seed: 7, winRatio: 0.9 });
    bt.repeat.set(9, 2.6);
    const btn = texBuilding('#8c949b', { seed: 7, winRatio: 0.9, night: true });
    btn.repeat.set(9, 2.6);
    const bldMat = new THREE.MeshStandardMaterial({ map: bt, roughness: 0.8 });
    this._bldMats.push({ m: bldMat, day: bt, night: btn });
    const bld = new THREE.Mesh(new THREE.BoxGeometry(46, 38, T.b - T.a + 30), bldMat);
    bld.position.copy(mid.p).addScaledVector(mid.left, (W_L + W_R) / 2);
    bld.position.y += H + 0.4 + 19;
    bld.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), mid.t);
    bld.castShadow = true;
    this.world.add(bld);
    /* 奥の壁(コンコース側)と大きな駅名の看板 */
    const fb = frameAt(F, this.step, backS);
    const back = new THREE.Mesh(new THREE.BoxGeometry(W_L - W_R + 1, H + 0.4, 0.8), wallMat);
    back.position.copy(fb.p).addScaledVector(fb.left, (W_L + W_R) / 2);
    back.position.y += (H + 0.4) / 2 - 0.3;
    back.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), fb.t);
    this.world.add(back);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(9, 1.6), new THREE.MeshBasicMaterial({
      map: boardTexture([['新宿', 60, 70], ['しんじゅく  SHINJUKU', 112, 24, 'normal']], { bg: '#f5f8fa', border: '#1b56a7', fg: '#16283a', w: 512, h: 140 }),
      side: DS,
    }));
    sign.position.copy(back.position).addScaledVector(fb.t, T.up ? -0.5 : 0.5);
    sign.position.y = fb.p.y + 5.2;
    sign.lookAt(sign.position.clone().addScaledVector(fb.t, T.up ? -10 : 10));
    this.world.add(sign);
    /* 天井から下がる「のりば」案内(ホームごと) */
    [[3.05, '1・2'], [-6.85, '3・4']].forEach(([off, no]) => {
      for (const ds of [-30, -95]) {
        const ss = T.up ? T.s0 + ds * -1 - 150 : T.s0 + ds;
        const f = frameAt(F, this.step, ss);
        const board = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.62), new THREE.MeshBasicMaterial({
          map: boardTexture([[`${no} 番線  のりば`, 40, 34]], { bg: '#20262c', fg: '#f0f4f6', w: 256, h: 64 }), side: DS,
        }));
        board.position.copy(f.p).addScaledVector(f.left, off);
        board.position.y += 4.3;
        board.lookAt(board.position.clone().addScaledVector(f.t, T.up ? 10 : -10));
        this.world.add(board);
      }
    });
    /* 車止め(各線の終端): 赤白の枠+赤色灯 */
    const fbuf = frameAt(F, this.step, T.buffer);
    const stripe = canvasTex(64, 16, (c) => {
      c.fillStyle = '#f2f2ee'; c.fillRect(0, 0, 64, 16);
      c.fillStyle = '#c8281e';
      for (let x = 0; x < 64; x += 16) c.fillRect(x, 0, 8, 16);
    });
    const bMat = new THREE.MeshStandardMaterial({ map: stripe, roughness: 0.6 });
    const redMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff3020).multiplyScalar(2) });
    [0, -3.8, 6.1, -10.1].forEach((off) => {
      const g = new THREE.Group();
      const beamB = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.35, 0.3), bMat);
      beamB.position.y = 1.05;
      g.add(beamB);
      [-0.75, 0.75].forEach((x) => {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.2, 0.18), this.M.railWeb);
        post.position.set(x, 0.6, -0.4);
        post.rotation.x = 0.5;
        g.add(post);
      });
      const lamp = new THREE.Mesh(new THREE.CircleGeometry(0.12, 12), redMat);
      lamp.position.set(0, 1.45, 0.16);
      g.add(lamp);
      g.position.copy(fbuf.p).addScaledVector(fbuf.left, off);
      g.lookAt(g.position.clone().addScaledVector(fbuf.t, T.up ? -10 : 10));
      this.world.add(g);
    });
  }

  /* 代々木八幡: 朱の鳥居と社叢 */
  _buildTorii() {
    const F = this.frames;
    const s0 = this._stationS('代々木八幡');
    if (s0 === null) return;
    const f = frameAt(F, this.step, s0 - 190);
    const g = new THREE.Group();
    const red = new THREE.MeshStandardMaterial({ color: 0xb5372a, roughness: 0.5 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2e2a26, roughness: 0.7 });
    [-2.6, 2.6].forEach((dx) => {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.38, 6.2, 10), red);
      p.position.set(dx, 3.1, 0);
      p.castShadow = true;
      g.add(p);
    });
    const kasagi = new THREE.Mesh(new THREE.BoxGeometry(8.4, 0.62, 0.8), red);
    kasagi.position.y = 6.3; kasagi.castShadow = true; g.add(kasagi);
    const shimaki = new THREE.Mesh(new THREE.BoxGeometry(7.6, 0.34, 0.6), dark);
    shimaki.position.y = 5.9; g.add(shimaki);
    const nuki = new THREE.Mesh(new THREE.BoxGeometry(7.0, 0.4, 0.5), red);
    nuki.position.y = 4.6; g.add(nuki);
    /* 社叢(濃い緑の木立) */
    const gm = new THREE.MeshStandardMaterial({ color: 0x35503a, roughness: 0.95 });
    for (let i = 0; i < 9; i++) {
      const sp = new THREE.Mesh(new THREE.SphereGeometry(2.4 + (i % 3), 10, 8), gm);
      sp.position.set(-7 + (i % 3) * 7 + (i * 7) % 4, 2.6 + (i % 3) * 1.3, 4 + Math.floor(i / 3) * 5);
      sp.castShadow = true;
      g.add(sp);
    }
    /* 小さな築山の上に、少し大きめに立てる(壁ごしでも見えるように) */
    const mound = new THREE.Mesh(new THREE.CylinderGeometry(6.5, 8.5, 1.4, 12),
      new THREE.MeshStandardMaterial({ color: 0x6d7a5a, roughness: 1 }));
    mound.position.y = -0.7;
    g.add(mound);
    g.scale.setScalar(1.3);
    g.position.copy(f.p).addScaledVector(f.left, -14.5);
    g.position.y += 1.6;
    g.lookAt(g.position.clone().addScaledVector(f.left, -40));
    this.world.add(g);
  }

  /* 喜多見: 車両基地(留置線・止まっている電車・検車庫) */
  _buildDepot() {
    const F = this.frames;
    if (!this.depotZone) return;
    const a = this.depotZone.a + 20, b = this.depotZone.b - 20;
    const iA = Math.floor(a / this.step), iB = Math.ceil(b / this.step);
    [-13.5, -17.5, -21.5].forEach((off) => {
      this.world.add(new THREE.Mesh(ribbon(F, iA, iB, off, 3.6, -0.05, 2.5), this.M.sub));
      [-RAIL_HALF, RAIL_HALF].forEach((o) => {
        this.world.add(new THREE.Mesh(ribbon(F, iA, iB, off + o, 0.068, 0.1, 25), this.M.railHead));
      });
    });
    [[a + 95, -13.5, 4], [a + 210, -21.5, 6]].forEach(([s, off, n]) => {
      const t = this.makeTrainModel(n, { kind: 'local', dest: '回送' });
      this.setTrainLights(t, { head: false, tail: false });
      placeTrain(this, t, s, -1, off);
      this.world.add(t.group);
    });
    const fS = frameAt(F, this.step, b - 55);
    const shed = new THREE.Mesh(new THREE.BoxGeometry(16, 8, 92),
      new THREE.MeshStandardMaterial({ color: 0x8f959b, roughness: 0.8 }));
    shed.position.copy(fS.p).addScaledVector(fS.left, -18);
    shed.position.y += 4;
    shed.lookAt(shed.position.clone().add(fS.t));
    shed.castShadow = true;
    this.world.add(shed);
  }

  /* 読売ランド前: まわる観覧車 */
  _buildWheel() {
    const F = this.frames;
    const s0 = this._stationS('読売ランド前');
    if (s0 === null) return;
    /* 駅の少し先・左手の丘の上(接近中ずっと前方視界に入る位置) */
    const f = frameAt(F, this.step, s0 + 280);
    const root = new THREE.Group();
    root.position.copy(f.p).addScaledVector(f.left, 145);
    root.position.y += 34;
    root.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), f.left.clone().negate());
    const spin = new THREE.Group();
    root.add(spin);
    const white = new THREE.MeshStandardMaterial({ color: 0xe8eaec, roughness: 0.5, metalness: 0.4 });
    spin.add(new THREE.Mesh(new THREE.TorusGeometry(26, 0.6, 8, 32), white));
    const spokeGeo = new THREE.BoxGeometry(0.42, 52, 0.42);
    for (let i = 0; i < 8; i++) {
      const sp = new THREE.Mesh(spokeGeo, white);
      sp.rotation.z = (i / 8) * Math.PI;
      spin.add(sp);
    }
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(2.0, 2.0, 3.0, 12), white);
    hub.rotation.x = Math.PI / 2;
    spin.add(hub);
    const cols = [0xd6604d, 0xf2b134, 0x4d9dd6, 0x62b56b, 0xb08bd0];
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      const gm = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.7, 2.4),
        new THREE.MeshStandardMaterial({ color: cols[i % cols.length], roughness: 0.6 }));
      gm.position.set(Math.cos(a) * 26, Math.sin(a) * 26, 0);
      spin.add(gm);
    }
    const legMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a5, roughness: 0.6, metalness: 0.4 });
    [-1, 1].forEach((sgn) => {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(1.7, 48, 2.1), legMat);
      leg.position.set(sgn * 10, -20, 0);
      leg.rotation.z = sgn * -0.3;
      root.add(leg);
    });
    this.wheelSpin = spin;
    this.world.add(root);
  }

  /* 梅ヶ丘: 梅林の丘(うすもも色の木立) */
  _buildUmeGrove() {
    const F = this.frames;
    const s0 = this._stationS('梅ヶ丘');
    if (s0 === null) return;
    const rng = (() => { let x = 4242; return () => (x = (x * 16807) % 2147483647) / 2147483647; })();
    const folGeo = new THREE.IcosahedronGeometry(1.35, 1);
    folGeo.scale(1, 0.95, 1);
    folGeo.translate(0, 2.6, 0);
    const trunkGeo = new THREE.CylinderGeometry(0.11, 0.16, 2.0, 6);
    trunkGeo.translate(0, 1.0, 0);
    const folMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4e4034, roughness: 0.95 });
    const n = 26;
    const fols = new THREE.InstancedMesh(folGeo, folMat, n);
    const trs = new THREE.InstancedMesh(trunkGeo, trunkMat, n);
    fols.castShadow = true; trs.castShadow = true;
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), col = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const s = s0 - 150 + rng() * 300;
      const f = frameAt(F, this.step, s);
      const p = f.p.clone().addScaledVector(f.left, -(12 + rng() * 30));
      const sc = 0.75 + rng() * 0.5;
      m4.compose(p, q, new THREE.Vector3(sc, sc, sc));
      fols.setMatrixAt(i, m4); trs.setMatrixAt(i, m4);
      const t = 0.9 + rng() * 0.1;
      col.setRGB(t, t * (0.7 + rng() * 0.1), t * (0.76 + rng() * 0.08), THREE.SRGBColorSpace);
      fols.setColorAt(i, col);
    }
    if (fols.instanceColor) fols.instanceColor.needsUpdate = true;
    this.world.add(fols, trs);
  }

  /* ---------- 線路ぎわの小物(ケーブルトラフ・継電箱) ----------
   * キロポスト・100m標は駅・標識の担当で作り直す */
  _buildRailsideDetails() {
    const F = this.frames, L = this.line.meta.length, step = this.step;
    const qi = this._qi || quadInfo(this.line);
    /* ケーブルトラフ: 犬走りの上に置いた、ふた付きのコンクリートの箱(右は全線、左は複線の区間) */
    const trough = (a, b, off) => {
      const top = new THREE.Mesh(ribbon(F, a, b, off, 0.3, -0.3, 0.6), this.M.trough);
      top.receiveShadow = true;
      this.world.add(top);
      /* 側面は線路から見える側だけ */
      const sd = new THREE.Mesh(vribbon(F, a, b, off - Math.sign(off) * 0.15, -0.43, -0.3, 0.6), this.M.trough);
      sd.receiveShadow = true;
      this.world.add(sd);
    };
    bedRuns(this).forEach(({ type, i0, i1 }) => {
      if (type !== 'bed') return;
      trough(i0, i1, -7.3);
      rowRanges(i0, i1, (i) => quadOffAt(i * step, 1, qi) < 0.05).forEach(([a, b]) => trough(a, b, 3.2));
    });
    /* 継電箱(信号機器の箱): 右側の犬走りの外、架線柱の足元は避ける */
    const nearStation = (s) => this.line.stations.some((st) => Math.abs(st.s - s) < 90);
    const inRiver = (s) => this.line.sections.river.some((r) => s > r.from - 250 && s < r.to + 250);
    const inCut = (s) => this.line.sections.tunnel.some((t) => s > t.from - 165 && s < t.to + 165);
    const poles = (this._catSupports || []).map((sp) => sp.s);
    const boxes = [];
    for (let s0 = 140; s0 < L - 100; s0 += 173) {
      const s = poles.some((x) => Math.abs(x - s0) < 2.5) ? s0 + 5 : s0;
      if (this._inTunnel(s) || inCut(s) || nearStation(s) || inRiver(s) || this._inTerminal(s, 20)) continue;
      boxes.push(s);
    }
    const bGeo = new THREE.BoxGeometry(0.5, 1.05, 0.85);
    bGeo.translate(0, 0.52, 0);
    const bMat = new THREE.MeshStandardMaterial({ color: 0x8f959b, roughness: 0.6, metalness: 0.25 });
    const bIm = new THREE.InstancedMesh(bGeo, bMat, Math.max(1, boxes.length));
    bIm.count = boxes.length;
    bIm.castShadow = true;
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
    boxes.forEach((s, i) => {
      const f = frameAt(F, step, s);
      q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), f.left);
      const p = f.p.clone().addScaledVector(f.left, -8.45);
      p.y -= 0.42;
      m4.compose(p, q, new THREE.Vector3(1, 1, 1));
      bIm.setMatrixAt(i, m4);
    });
    this.world.add(bIm);
  }

  /* ---------- ホームの備品(ベンチ・自販機) ---------- */
  _buildPlatformFurniture() {
    const F = this.frames;
    const seats = [], backs = [], vends = [], fronts = [];
    const vendCols = [0xc23b2e, 0x2e5fc2, 0xe8e6e0];
    this.line.stations.forEach((st, si) => {
      if (this._inTunnel(st.s)) return;
      [[3.8, 1], [-7.55, -1]].forEach(([off, dir]) => {
        [-45, -95].forEach((ds) => {
          const f = frameAt(F, this.step, st.s + ds);
          seats.push({ f, off });
          backs.push({ f, off: off + dir * 0.2 });
        });
        const fv = frameAt(F, this.step, st.s - 68);
        vends.push({ f: fv, off, col: vendCols[(si + (dir > 0 ? 0 : 1)) % vendCols.length] });
        fronts.push({ f: fv, off: off - dir * 0.36 });
      });
    });
    const X = new THREE.Vector3(1, 0, 0);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
    const put = (im, arr, y) => {
      arr.forEach((a, i) => {
        q.setFromUnitVectors(X, a.f.t);
        m4.compose(a.f.p.clone().addScaledVector(a.f.left, a.off).setY(a.f.p.y + y), q, one);
        im.setMatrixAt(i, m4);
      });
      this.world.add(im);
    };
    const seatIm = new THREE.InstancedMesh(new THREE.BoxGeometry(1.5, 0.08, 0.42),
      new THREE.MeshStandardMaterial({ color: 0x2e5245, roughness: 0.7 }), seats.length);
    put(seatIm, seats, 1.44);
    const backIm = new THREE.InstancedMesh(new THREE.BoxGeometry(1.5, 0.4, 0.06),
      new THREE.MeshStandardMaterial({ color: 0x376050, roughness: 0.7 }), backs.length);
    put(backIm, backs, 1.72);
    const vendIm = new THREE.InstancedMesh(new THREE.BoxGeometry(0.85, 1.7, 0.68),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.15 }), vends.length);
    const vc = new THREE.Color();
    vends.forEach((v, i) => { vc.setHex(v.col); vendIm.setColorAt(i, vc); });
    if (vendIm.instanceColor) vendIm.instanceColor.needsUpdate = true;
    vendIm.castShadow = true;
    put(vendIm, vends, 1.87);
    this._vendFrontMat = new THREE.MeshStandardMaterial({ color: 0xdfe6ea, roughness: 0.35, metalness: 0.2 });
    const frontIm = new THREE.InstancedMesh(new THREE.BoxGeometry(0.6, 1.1, 0.05), this._vendFrontMat, fronts.length);
    put(frontIm, fronts, 1.95);
  }

  /* ---------- 踏切(遮断機・警報灯つき) ---------- */
  _buildCrossings() {
    const F = this.frames;
    const roadMat = new THREE.MeshStandardMaterial({ color: 0x3f4245, roughness: 0.95 });
    const lineMat = new THREE.MeshBasicMaterial({ color: 0xcfcfc8 });
    const stripeTex = canvasTex(64, 16, (c) => {
      c.fillStyle = '#e8e13a'; c.fillRect(0, 0, 64, 16);
      c.fillStyle = '#16161a';
      for (let x = 0; x < 64; x += 16) c.fillRect(x, 0, 8, 16);
    });
    const armMat = new THREE.MeshStandardMaterial({ map: stripeTex, roughness: 0.6 });
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x565e63, roughness: 0.6, metalness: 0.4 });
    const boxMat = new THREE.MeshStandardMaterial({ color: 0x2b2f33, roughness: 0.7 });
    this.crossings = [];
    this.crossSpots.forEach((s) => {
      const f = frameAt(F, this.step, s);
      /* 道路(線路を横切る) */
      const road = new THREE.Group();
      const slab = new THREE.Mesh(new THREE.BoxGeometry(56, 0.08, 5.2), roadMat);
      slab.material = new THREE.MeshStandardMaterial({ color: 0x54585c, roughness: 0.95 });
      slab.receiveShadow = true;
      road.add(slab);
      [-2.35, 2.35].forEach((dz) => {
        const ln = new THREE.Mesh(new THREE.BoxGeometry(56, 0.02, 0.22), lineMat);
        ln.position.set(0, 0.05, dz);
        road.add(ln);
      });
      road.position.copy(f.p).addScaledVector(f.left, -1.9);
      road.position.y += 0.1;
      road.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), f.left);
      this.world.add(road);
      /* 遮断機(両側)。腕は列車接近で下りる */
      const arms = [], lamps = [];
      [[7.6, 3.4], [-11.2, -3.4]].forEach(([off, roadSide]) => {
        const g = new THREE.Group();
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 3.0, 8), poleMat);
        pole.position.y = 1.5;
        pole.castShadow = true;
        g.add(pole);
        const head = new THREE.Mesh(new THREE.BoxGeometry(0.65, 0.5, 0.2), boxMat);
        head.position.y = 2.6;
        g.add(head);
        /* 踏切警標(×印) */
        const buckMat = new THREE.MeshStandardMaterial({ map: stripeTex, roughness: 0.7 });
        [-0.6, 0.6].forEach((rot) => {
          const buck = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.2, 0.06), buckMat);
          buck.position.set(0, 3.25, 0);
          buck.rotation.z = rot;
          g.add(buck);
        });
        /* 警報灯2つ(交互点滅) */
        const lampGeo = new THREE.CircleGeometry(0.15, 10);
        const la = new THREE.Mesh(lampGeo, new THREE.MeshBasicMaterial({ color: 0x33110e }));
        const lb = new THREE.Mesh(lampGeo, new THREE.MeshBasicMaterial({ color: 0x33110e }));
        la.position.set(-0.2, 2.6, 0.11);
        lb.position.set(0.2, 2.6, 0.11);
        g.add(la, lb);
        lamps.push(la, lb);
        /* 腕(根元を軸に回転) */
        const armGeo = new THREE.BoxGeometry(5.6, 0.2, 0.2);
        armGeo.translate(2.8, 0, 0);
        const arm = new THREE.Mesh(armGeo, armMat);
        arm.position.y = 1.05;
        arm.rotation.z = 1.25;
        arms.push(arm);
        g.add(arm);
        const p = f.p.clone().addScaledVector(f.left, off).addScaledVector(f.t, roadSide);
        g.position.copy(p);
        /* 腕が道路をふさぐ向き(=線路と平行)に置く */
        g.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), f.t.clone().multiplyScalar(off > 0 ? 1 : -1));
        this.world.add(g);
      });
      /* 踏切待ちの車(両側に2〜3台) */
      this._crossCars(f, s);
      this.crossings.push({ s, arms, lamps });
    });
  }

  _updateCrossings(dt) {
    if (!this.crossings) return;
    const pos = this.sim.pos;
    this.crossings.forEach((cr) => {
      const d = Math.abs(cr.s - pos);
      if (d > 1500) return;
      const closed = d < 420;
      const target = closed ? 0 : 1.25;
      cr.arms.forEach((a) => {
        a.rotation.z += (target - a.rotation.z) * Math.min(1, dt * 2.6);
      });
      const blink = closed && (this.clockT * 2.4) % 1 < 0.5;
      const blink2 = closed && !blink;
      cr.lamps.forEach((l, i) => {
        const on = i % 2 === 0 ? blink : blink2;
        l.material.color.setHex(on ? 0xff3b30 : 0x33110e);
      });
    });
  }

  _crossCars(f, s) {
    if (!this._carRes) {
      const body = new THREE.BoxGeometry(1.7, 0.75, 4.2); body.translate(0, 0.62, 0);
      const cabin = new THREE.BoxGeometry(1.5, 0.62, 2.2); cabin.translate(0, 1.3, -0.2);
      const wheels = new THREE.BoxGeometry(1.76, 0.5, 3.0); wheels.translate(0, 0.25, 0);
      this._carRes = {
        body: mergeNonIndexed([body, cabin]), wheels,
        glass: new THREE.MeshStandardMaterial({ color: 0x1a232b, roughness: 0.15, metalness: 0.6 }),
        paint: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.5 }),
        tire: new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.9 }),
        cols: [0xd8dadc, 0x23272b, 0xa8242a, 0x2b4f8a, 0xe6e2d6, 0x6f7479, 0x3d6b4a],
      };
      [this._carRes.glass, this._carRes.paint, this._carRes.tire].forEach((m) => this._keep.add(m));
    }
    const R = this._carRes;
    let seed = Math.floor(s);
    const rnd = () => (seed = (seed * 16807 + 11) % 2147483647) / 2147483647;
    [-1, 1].forEach((side) => {
      const n = 1 + Math.floor(rnd() * 2.6);
      for (let i = 0; i < n; i++) {
        const along = side * (13 + i * 5.6 + rnd() * 1.2);   // 線路からの距離(道路方向)
        const lane = side > 0 ? -1.3 : 1.3;                  // 左側通行
        const g = new THREE.Group();
        const car = new THREE.Mesh(R.body, R.paint.clone());
        car.material.color.setHex(R.cols[Math.floor(rnd() * R.cols.length)]);
        car.castShadow = true;
        const w = new THREE.Mesh(R.wheels, R.tire);
        g.add(car, w);
        g.position.copy(f.p).addScaledVector(f.left, along - 1.9).addScaledVector(f.t, lane);
        g.position.y += 0.12;
        /* 車は線路のほうを向いて止まっている */
        g.lookAt(g.position.clone().addScaledVector(f.left, -side * 10));
        this.world.add(g);
      }
    });
  }

  /* ---------- ホームで待つ人たち(静止。インスタンス描画) ---------- */
  _buildCrowds() {
    if (!this._crowdRes) {
      const torso = new THREE.CylinderGeometry(0.17, 0.2, 0.62, 7); torso.translate(0, 1.0, 0);
      const legs = new THREE.BoxGeometry(0.3, 0.7, 0.2); legs.translate(0, 0.35, 0);
      const head = new THREE.SphereGeometry(0.12, 8, 6); head.translate(0, 1.45, 0);
      const hair = new THREE.SphereGeometry(0.125, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.55); hair.translate(0, 1.47, -0.01);
      const colorize = (g, hex) => {
        const c = new THREE.Color(hex); const n = g.attributes.position.count; const a = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
        g.setAttribute('color', new THREE.BufferAttribute(a, 3)); return g;
      };
      this._crowdRes = {
        cloth: torso,
        rest: mergeNonIndexed([colorize(legs, 0x2a2f36), colorize(head, 0xd8b49a), colorize(hair, 0x1d1915)]),
        matCloth: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 }),
        matRest: new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.85 }),
      };
      this._keep.add(this._crowdRes.matCloth); this._keep.add(this._crowdRes.matRest);
    }
    const R = this._crowdRes;
    const F = this.frames;
    let seed = 2024;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const cloth = [0x3e5a78, 0x7a4a42, 0x4a6b4e, 0x6b5a7c, 0x8a6d3b, 0x455a64, 0xa05a6e, 0x37657a, 0x94502e, 0xd8d4c8, 0x2b2f36, 0x714a71, 0xc9a24a, 0x5d7f9a];
    const items = [];
    this.line.stations.forEach((st) => {
      [[3.05, 1], [-6.85, -1]].forEach(([off, side]) => {
        const n = 10 + Math.floor(rnd() * 14);
        for (let i = 0; i < n; i++) {
          const ss = st.s - 150 + rnd() * 158;
          /* 停車位置まわりの乗り降りする人(アニメ)とは重ならないように */
          if (Math.abs(ss - st.s) < 50 && side > 0 && rnd() < 0.7) continue;
          /* 運転台の窓のすぐ横(停止位置の前後)には立たせない(視界をふさがない) */
          if (side > 0 && ss > st.s - 16 && ss < st.s + 14) continue;
          const lat = off + side * (-0.15 + rnd() * 1.05);
          const f = frameAt(F, this.step, Math.max(2, ss));
          const p = f.p.clone().addScaledVector(f.left, lat);
          p.y += 1.02;
          /* 多くは線路の方を向き、少しばらつかせる */
          const yaw = Math.atan2(-side * f.left.x, -side * f.left.z) + (rnd() - 0.5) * 1.6;
          items.push({ p, yaw, sc: 0.86 + rnd() * 0.22, col: cloth[Math.floor(rnd() * cloth.length)] });
        }
      });
    });
    const imC = new THREE.InstancedMesh(R.cloth, R.matCloth, items.length);
    const imR = new THREE.InstancedMesh(R.rest, R.matRest, items.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3(), c = new THREE.Color();
    items.forEach((it, i) => {
      e.set(0, it.yaw, 0); q.setFromEuler(e); sc.setScalar(it.sc);
      m4.compose(it.p, q, sc);
      imC.setMatrixAt(i, m4); imR.setMatrixAt(i, m4);
      c.setHex(it.col); imC.setColorAt(i, c);
    });
    imC.castShadow = true;
    this.world.add(imC, imR);
    /* 屋根から下がる駅名の案内板(ホームごとに2枚) */
    const F2 = this.frames;
    this.line.stations.forEach((st) => {
      if (this._inTerminal(st.s)) return;
      const tex = boardTexture([[st.name, 44, 46], [STATION_KANA[st.name] || '', 96, 22, 'normal']],
        { bg: '#20272d', fg: '#eef3f6', w: 384, h: 128 });
      const mat = new THREE.MeshBasicMaterial({ map: tex, side: DS });
      [[3.05], [-6.85]].forEach(([off]) => {
        [-28, -112].forEach((ds) => {
          const f = frameAt(F2, this.step, st.s + ds);
          const b = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 0.63), mat);
          b.position.copy(f.p).addScaledVector(f.left, off);
          b.position.y += this._inTunnel(st.s) ? 3.7 : 3.55;
          b.lookAt(b.position.clone().addScaledVector(f.t, -10));
          this.world.add(b);
        });
      });
    });
  }

  /* ---------- 丘陵(多摩丘陵らしい郊外の起伏と雑木林) ---------- */
  _buildHills() {
    const F = this.frames, L = this.line.meta.length;
    const urban = this.line.sections.urban;
    const kindAt = (s) => (urban.find((u) => s >= u.from && s < u.to) || { kind: 2 }).kind;
    let seed = 777;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    if (!this._hillMat) {
      const t = photoTex('./assets/tex/grass_c.jpg', { rx: 18, ry: 18, aniso: 4 });
      this._hillTex = t;
      this._hillMat = new THREE.MeshStandardMaterial({ map: t, color: 0xb9c4a0, vertexColors: true, roughness: 1 });
      this._keep.add(this._hillMat); this._keep.add(t);
    }
    const geo = new THREE.SphereGeometry(1, 28, 10, 0, Math.PI * 2, 0, Math.PI / 2);
    {
      const p = geo.attributes.position, c = new Float32Array(p.count * 3);
      for (let i = 0; i < p.count; i++) {
        const v = Math.pow(0.62 + 0.38 * p.getY(i), 2.2);
        c[i * 3] = v; c[i * 3 + 1] = v; c[i * 3 + 2] = v;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
    }
    const trees = [];
    for (let s = 300; s < L - 300; s += 330) {
      const k = kindAt(s);
      if (k < 2) continue;
      if (this.line.sections.river.some((r) => s > r.from - 500 && s < r.to + 500)) continue;
      for (const side of [1, -1]) {
        if (rnd() > (k === 3 ? 0.75 : 0.35)) continue;
        const r = 110 + rnd() * 170, h = (k === 3 ? 28 : 16) + rnd() * (k === 3 ? 38 : 18);
        const dist = r + 90 + rnd() * 220;
        const f = frameAt(F, this.step, s + rnd() * 150);
        const c = f.p.clone().addScaledVector(f.left, side * dist);
        c.y -= 3;
        const m = new THREE.Mesh(geo, this._hillMat);
        m.position.copy(c);
        m.scale.set(r, h, r * (0.7 + rnd() * 0.5));
        m.rotation.y = rnd() * Math.PI;
        m.receiveShadow = true;
        this.world.add(m);
        /* 斜面の雑木林 */
        const nT = Math.floor(r / 9);
        for (let i = 0; i < nT; i++) {
          const a = rnd() * Math.PI * 2, u = Math.sqrt(rnd()) * 0.85;
          const lx = Math.cos(a) * u, lz = Math.sin(a) * u;
          const local = new THREE.Vector3(lx, Math.sqrt(Math.max(0, 1 - u * u)), lz);
          local.multiply(m.scale).applyAxisAngle(UP, m.rotation.y);
          const p = c.clone().add(local);
          trees.push({ p, sc: 1.4 + rnd() * 1.3, tint: 0.65 + rnd() * 0.4, conifer: rnd() < 0.45 });
        }
      }
    }
    this._plantTrees(trees, rnd);
  }

  /* ---------- 駅舎(駅名看板つき) ---------- */
  _buildStationHouses() {
    const F = this.frames;
    const wallMat = new THREE.MeshStandardMaterial({ map: this.T.concC, color: 0xd8d5cc, roughness: 0.9 });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x3d4a56, roughness: 0.8 });
    this.line.stations.forEach((st) => {
      if (this._inTunnel(st.s)) return;
      if (st.name === '新宿') return;   // 新宿は大屋根ターミナルがあるので省略
      const f = frameAt(F, this.step, st.s - 55);
      const g = new THREE.Group();
      const bld = new THREE.Mesh(new THREE.BoxGeometry(15, 4.4, 6.5), wallMat);
      bld.position.y = 2.2;
      bld.castShadow = true;
      g.add(bld);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(16, 0.5, 7.5), roofMat);
      roof.position.y = 4.65;
      roof.castShadow = true;
      g.add(roof);
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(7.2, 1.3),
        new THREE.MeshBasicMaterial({
          map: boardTexture([
            [`${st.name} 駅`, 36, 34],
            [STATION_KANA[st.name] || '', 70, 18, 'normal'],
          ], { bg: '#f5f8fa', border: '#1b56a7', fg: '#16283a', w: 512, h: 96 }),
        }));
      sign.position.set(0, 3.4, 3.3);
      g.add(sign);
      g.position.copy(f.p).addScaledVector(f.left, -14.5);
      g.position.y += 0.1;
      g.lookAt(g.position.clone().addScaledVector(f.left, 30));   // 正面(+z)を線路側へ
      this.world.add(g);
    });
  }

  /* ---------- 駅の人々(待つ・乗る・降りる。脚と腕が歩きで振れる) ---------- */
  _buildPeople() {
    const shirt = [0x3e5a78, 0x7a4a42, 0x4a6b4e, 0x6b5a7c, 0x8a6d3b, 0x455a64, 0xa05a6e, 0x37657a, 0x94502e, 0x2e6e62, 0x714a71, 0x4f6636];
    const pants = [0x2b3138, 0x3a3f46, 0x4a4038, 0x333a42, 0x26303a];
    const hairs = [0x201a16, 0x3a2c20, 0x4a3a2a, 0x14161a];
    const skinMat = new THREE.MeshStandardMaterial({ color: 0xd8b49a, roughness: 0.8 });
    this.people = [];
    for (let i = 0; i < 12; i++) {
      const g = new THREE.Group();
      const bodyMat = new THREE.MeshStandardMaterial({ color: shirt[i % shirt.length], roughness: 0.9 });
      const pantMat = new THREE.MeshStandardMaterial({ color: pants[i % pants.length], roughness: 0.9 });
      const hairMat = new THREE.MeshStandardMaterial({ color: hairs[i % hairs.length], roughness: 0.85 });
      /* 胴(上着) */
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.145, 0.175, 0.55, 8), bodyMat);
      body.position.y = 0.96;
      body.castShadow = true;
      g.add(body);
      /* 脚2本(股関節で振る) */
      const legGeo = new THREE.CylinderGeometry(0.055, 0.062, 0.62, 6);
      legGeo.translate(0, -0.31, 0);
      const legL = new THREE.Mesh(legGeo, pantMat);
      legL.position.set(-0.075, 0.68, 0);
      legL.castShadow = true;
      const legR = legL.clone();
      legR.position.x = 0.075;
      g.add(legL, legR);
      /* 腕2本(肩で振る) */
      const armGeo = new THREE.CylinderGeometry(0.038, 0.042, 0.5, 6);
      armGeo.translate(0, -0.25, 0);
      const armL = new THREE.Mesh(armGeo, bodyMat);
      armL.position.set(-0.21, 1.2, 0);
      const armR = armL.clone();
      armR.position.x = 0.21;
      g.add(armL, armR);
      /* 頭+髪 */
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.135, 9, 8), skinMat);
      head.position.y = 1.42;
      head.castShadow = true;
      g.add(head);
      const hair = new THREE.Mesh(new THREE.SphereGeometry(0.14, 9, 8), hairMat);
      hair.scale.set(1, 0.72, 1);
      hair.position.set(0, 1.49, -0.025);
      g.add(hair);
      g.scale.setScalar(0.86 + (i % 5) * 0.05);
      g.visible = false;
      this.world.add(g);
      this.people.push({ g, legL, legR, armL, armR, ph: i * 1.7 });
    }
    this._tmpPrev = new THREE.Vector3();
  }

  /* 1人分の配置+歩行アニメ。dirWorldは歩く向き(nullなら立ち) */
  _placeFig(fig, pos, dirWorld, dt, speed) {
    fig.g.position.copy(pos);
    if (dirWorld && speed > 0.05) {
      fig.g.rotation.y = Math.atan2(dirWorld.x, dirWorld.z);
      fig.ph += dt * (4.5 + speed * 2.2);
      const sw = Math.sin(fig.ph);
      fig.legL.rotation.x = sw * 0.5;
      fig.legR.rotation.x = -sw * 0.5;
      fig.armL.rotation.x = -sw * 0.38;
      fig.armR.rotation.x = sw * 0.38;
      fig.g.position.y += Math.abs(Math.cos(fig.ph)) * 0.025;
    } else {
      /* 立ち: 手足を下ろして小さくゆれる */
      fig.legL.rotation.x *= 0.8;
      fig.legR.rotation.x *= 0.8;
      fig.armL.rotation.x *= 0.8;
      fig.armR.rotation.x *= 0.8;
      fig.g.position.y += Math.sin(this.clockT * 1.6 + fig.ph) * 0.008;
    }
    fig.g.visible = true;
  }

  _updatePeople(dt) {
    if (!this.people) return;
    const sim = this.sim;
    /* ドア開放中は「いま停まっている駅」(到着でstopIdxはもう次を指している) */
    const cur = sim.doorOpen ? sim.stops[sim.stopIdx - 1] : null;
    const next = cur || sim.stops[sim.stopIdx];
    const d = next ? next.stopAt - sim.pos : 1e9;
    if (!next || d > 430 || d < -40) {
      this.people.forEach((p) => { p.g.visible = false; });
      return;
    }
    const F = this.frames;
    const f01 = sim.doorOpen ? Math.min(1, Math.max(0, 1 - (this._departOf() - sim.t) / 20)) : 0;
    const P = new THREE.Vector3();
    /* 自ホーム(進行左側)の6人: 0-1=降りる人(すこし先), 2-5=乗る人(後方寄り) */
    for (let i = 0; i < 6; i++) {
      const fig = this.people[i];
      const s = i < 2 ? next.stopAt + 14 + i * 9 : next.stopAt + 2 - (i - 2) * 13;
      const fr = frameAt(F, this.step, Math.max(2, s));
      let lat, walking = 0, dir = null;
      if (!sim.doorOpen) {
        lat = 3.5 + (i % 3) * 0.35;
        if (i < 2) { fig.g.visible = false; continue; }
      } else if (i < 2) {
        const pk = Math.min(1, Math.max(0, f01 * 1.7 - i * 0.25));
        lat = 1.95 + pk * 2.3;
        if (pk > 0 && pk < 1) { walking = 1; dir = fr.left.clone(); }
      } else {
        const pk = Math.min(1, Math.max(0, f01 * 1.6 - (i - 2) * 0.18));
        lat = 3.6 - pk * 1.65;
        if (pk >= 1) { fig.g.visible = false; continue; }
        if (pk > 0) { walking = 1; dir = fr.left.clone().negate(); }
      }
      P.copy(fr.p).addScaledVector(fr.left, lat);
      P.y += 1.02;
      this._placeFig(fig, P, dir, dt, walking);
    }
    /* 向かいホームの6人: 接近中は立って待ち、停車中は歩く流れ */
    for (let i = 6; i < 12; i++) {
      const fig = this.people[i];
      const k = i - 6;
      let s, walking = 0, dir = null;
      if (sim.doorOpen) {
        s = next.stopAt + 12 - ((this.clockT * 8 + k * 29) % 172);
        walking = 1;
      } else {
        s = next.stopAt - 12 - k * 21;
      }
      const fr = frameAt(F, this.step, Math.max(2, s));
      if (walking) dir = fr.t.clone().negate();
      P.copy(fr.p).addScaledVector(fr.left, -6.4 - (i % 3) * 0.3);
      P.y += 1.02;
      this._placeFig(fig, P, dir, dt, walking);
    }
  }

  _departOf() {
    return this.sim._departTime || this.sim.t;
  }

  resize(w, h) {
    this._w = w; this._h = h;
    this.renderer.setSize(w, h, false);
    if (this.composer) this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.cockpit.layoutFor(w / h);
  }

  /* カメラ: 'cab'(運転台) / 'chase'(うしろ上) / 'side'(よこ) / 'front'(線路わきで待ちかまえる) / 'drone'(上空) */
  setCameraMode(mode) {
    this.camMode = mode;
    this._frontCamS = null;
    this._camPos = null;   // 切り替えたら補間せずに新しい位置へ
    const ext = mode !== 'cab';
    this.cockpit.setVisible(!ext);
    if (this.traffic) this.traffic.showOwn(ext);
  }

  /* 音の環境(audio.update に渡す) */
  audioEnv() {
    const sim = this.sim;
    const s = sim.pos;
    return {
      inTunnel: this._inTunnel(s - 40) || this._inTerminal(s, -10),
      curveRadius: sim.radiusAt ? sim.radiusAt(s - 40) : Infinity,
      crossings: (this.crossSpots || []).map((c) => c - s).filter((d) => Math.abs(d) < 400),
      passing: this.traffic ? this.traffic.passingInfo() : [],
      rain: this.weather === 'rain',
      snow: this.weather === 'snow',
      external: this.camMode !== 'cab',
    };
  }

  _placeCamera(s, f, dt) {
    const sim = this.sim;
    const L = this.line.meta.length;
    const at = (ss) => frameAt(this.frames, this.step, Math.max(1, Math.min(L - 2, ss)));
    const cam = this.camera;
    const mode = this.camMode;
    if (mode === 'cab') {
      const fAhead = at(s + 42);
      /* 運転士の目線（左寄り・レール上3.05m）+ 速度に応じた揺れ */
      const eye = f.p.clone().addScaledVector(f.left, 0.85);
      eye.y += 3.05;
      const sway = Math.sin(this.clockT * 7.3) * 0.012 + Math.sin(this.clockT * 2.1) * 0.02;
      const bob = Math.sin(this.clockT * 9.1) * 0.008;
      const k = Math.min(1, sim.v / 70);
      eye.addScaledVector(f.left, sway * k);
      eye.y += bob * k;
      cam.position.copy(eye);
      const look = fAhead.p.clone().addScaledVector(fAhead.left, 0.55);
      look.y += 2.4;
      cam.lookAt(look);
      cam.fov = 58;
    } else if (mode === 'chase' || mode === 'drone') {
      const back = mode === 'drone' ? 95 : 34, side = mode === 'drone' ? 30 : 4.5;
      /* ターミナルの屋根の下では天井より低く */
      const up = mode === 'drone' ? 52 : this._inTerminal(s - back, 8) ? 5.2 : 8.5;
      const fb = at(s - back), fl = at(s + (mode === 'drone' ? 30 : 48));
      const want = fb.p.clone().addScaledVector(fb.left, side);
      want.y += up;
      if (!this._camPos || this._camJump) { this._camPos = want.clone(); this._camJump = false; }
      this._camPos.lerp(want, Math.min(1, dt * 3));
      cam.position.copy(this._camPos);
      const look = fl.p.clone();
      look.y += mode === 'drone' ? 0 : 2.2;
      cam.lookAt(look);
      cam.fov = mode === 'drone' ? 50 : 55;
    } else if (mode === 'side') {
      /* 防音壁(高さ1.9m)ごしでも車体が見えるよう、少し高い位置から */
      const fc = at(s - 22);
      const inT = this._inTunnel(s - 22) || this._inTerminal(s - 22, 6);
      const p = fc.p.clone().addScaledVector(fc.left, inT ? 4.4 : 13.5);
      p.y += inT ? 2.6 : 6.2;
      cam.position.copy(p);
      const look = at(s - 14).p.clone();
      look.y += 2.0;
      cam.lookAt(look);
      cam.fov = 55;
    } else if (mode === 'front') {
      /* 線路わきの「撮影地」: 先頭が通りすぎたら次の地点へ */
      /* 近すぎず遠すぎず(カーブの内側の壁で隠れないよう 150m 前後) */
      if (this._frontCamS == null || s > this._frontCamS + 40) this._frontCamS = Math.min(L - 10, s + 120 + (sim.v / 3.6) * 2.5);
      /* 線路のすぐ左(ホームの端・柵の内側)から列車を迎える */
      const fc = at(this._frontCamS);
      const p = fc.p.clone().addScaledVector(fc.left, 4.4);
      p.y += 2.7;
      cam.position.copy(p);
      const look = f.p.clone();
      look.y += 2.2;
      cam.lookAt(look);
      cam.fov = Math.max(18, Math.min(50, 50 - Math.max(0, (this._frontCamS - s) - 60) * 0.12));
    }
    cam.updateProjectionMatrix();
  }

  /* 毎フレーム描画 */
  render(dt) {
    this.clockT += dt;
    const sim = this.sim;
    const L = this.line.meta.length;
    const s = Math.max(0, Math.min(L - 2, sim.pos));
    const f = frameAt(this.frames, this.step, s);
    this._placeCamera(s, f, dt);
    const eye = this.camera.position;

    /* 太陽と影ボックスを自列車に追従させる */
    this.sun.target.position.copy(f.p).addScaledVector(f.t, 110);
    this.sun.position.copy(this.sun.target.position).addScaledVector(this._curSunDir || this._sunDir, 430);
    if (this.eveSky) this.eveSky.position.copy(eye);

    /* 前照灯の追従(自列車の先頭から) */
    const head = f.p.clone().addScaledVector(f.left, 0.0);
    head.y += 1.95;
    this.headlight.position.copy(head).addScaledVector(f.t, 1.0);
    this.headlight.target.position.copy(head).addScaledVector(f.t, 70);
    this.headlight.target.position.y -= 2.4;

    this._updateSleepers(s);

    /* 信号現示の更新（近傍・変化したときだけ） */
    const R = this._sigRes;
    this.signalMeshes.forEach((sm) => {
      const d = sm.sig.s - sim.pos;
      if (d < -50 || d > 1100) return;
      const asp = sim.signalAspect(sm.sig);
      if (asp === sm.asp) return;
      sm.asp = asp;
      sm.lamps.forEach((l) => {
        const on = (asp === 3 && l.k === 'G') || ((asp === 1) && l.k === 'Y') ||
          (asp === 2 && (l.k === 'Y' || l.k === 'G')) || (asp === 0 && l.k === 'R');
        l.lamp.material = on ? R.on[l.k] : R.off;
        l.glow.visible = on;
      });
    });

    /* ほかの列車・自列車 */
    if (this.traffic) this.traffic.update(dt);

    /* 停止位置の光の目印(つぎに とまる駅だけ) */
    const nxt = sim.stops[sim.stopIdx];
    if (this.guide !== false && nxt && !sim.doorOpen && nxt.stopAt - sim.pos < 650 && nxt.stopAt - sim.pos > -2) {
      const fb = frameAt(this.frames, this.step, Math.min(L - 2, nxt.stopAt));
      this.stopBeam.position.copy(fb.p).addScaledVector(fb.left, 2.3);
      this.stopBeam.position.y += 4.4;
      this._beamMat.opacity = 0.5 + 0.22 * Math.sin(this.clockT * 4);
      this.stopBeam.visible = true;
    } else {
      this.stopBeam.visible = false;
    }
    /* 観覧車をゆっくり回す */
    if (this.wheelSpin) this.wheelSpin.rotation.z += dt * 0.05;
    /* 踏切と駅の人々 */
    this._updateCrossings(dt);
    this._updatePeople(dt);

    /* 屋内(トンネル・ターミナル)判定: 運転台の明るさ・雨雪の有無 */
    const indoor = this._inTunnel(s) || this._inTerminal(s, -6);
    const indoorEye = this._inTunnel(s + 3) || this._inTerminal(s + 3, -6);
    if (indoor !== this._inTunnelNow) { this._inTunnelNow = indoor; this._applyWeather(); }
    const tod = this.timeOfDay;
    const wet = this.weather !== 'clear';
    let light = tod === 'night' ? 0.16 : tod === 'evening' ? 0.55 : this.weather === 'rain' ? 0.7 : this.weather === 'snow' ? 0.85 : 1;
    if (indoorEye) light = Math.min(light, 0.3);
    this.cockpit.update(dt, { light, night: tod === 'night', wiper: this.weather === 'rain' && !indoorEye && this.camMode === 'cab' });
    if (this.weatherFx) this.weatherFx.update(dt, sim.v / 3.6, indoorEye && this.camMode === 'cab');

    if (this.composer && (tod !== 'day' || wet || indoor)) this.composer.render();
    else this.renderer.render(this.scene, this.camera);

    /* fps計測(自動軽量化・デバッグ用) */
    if (dt > 0) {
      this._fpsAcc += dt; this._fpsN++;
      if (this._fpsAcc > 1.2) {
        this.fps = this._fpsN / this._fpsAcc;
        this._fpsAcc = 0; this._fpsN = 0;
      }
    }
  }
}
