/* =========================================================
 * scene/scene.js — three.js 前面展望シーン
 * 実線形(line.json)からレール・架線・駅・信号・街並みを手続き生成。
 * v2: PBR+HDRI環境光+太陽影+実写テクスチャ(CC0)による描画基盤。
 * ゲームロジックは持たない（simの状態を毎フレーム描くだけ）。
 * ========================================================= */
/* importmapは使わない(古いiPadのSafariが非対応のため、相対パスで読み込む) */
import * as THREE from '../vendor/three.module.min.js';
import { RGBELoader } from '../vendor/RGBELoader.js';
import { LOOK, pickLook, prepareClearHdr, horizonRadiance, fogFromHorizon, acesFilmic, makeMacroTex, makeWeatherUniforms, installWeather, makeDuskSky, makeNightSky } from './look.js';
import { EffectComposer } from '../vendor/addons/EffectComposer.js';
import { RenderPass } from '../vendor/addons/RenderPass.js';
import { UnrealBloomPass } from '../vendor/addons/UnrealBloomPass.js';
import { OutputPass } from '../vendor/addons/OutputPass.js';
import { Sky } from '../vendor/addons/Sky.js';
import { STATION_KANA } from '../sim/kana.js';
import { buildStations, buildTunnelLights, buildSignals, updateSignals, buildBoards, buildStopBeam, buildTerminal, buildFurniture, buildCrowds, buildPeople, placeFig, updatePeople } from './stations.js';
import { Cockpit } from './cockpit.js';
import { Traffic, placeTrain } from './traffic.js';
import { buildTown, updateTown, makeTreeGeosP1, plantTreesP1, buildHillsP1, stationBodiesP1, makeRng, occFree } from './town.js';
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
/* 自動軽量化でたどりついた段階の保存先 {q, dpr, shadowLevel, bloom} */
const PERF_KEY = 'trainop_perf';

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

/* 木の形は scene/town.js にまとめた(幹を葉と1つの形にし、遠景用の軽い形も作る) */
function makeTreeGeos() {
  return makeTreeGeosP1();
}

/* ---- テクスチャ ---- */
const texLoader = new THREE.TextureLoader();
/* 同じ画像は1回だけ読み込み、GPUへの転送も1回で済むように元(source)を共有する */
const _photo = new Map();
function photoTex(url, opt = {}) {
  let e = _photo.get(url);
  if (!e) {
    e = { base: null, wait: [] };
    e.base = texLoader.load(url, () => { e.wait.forEach((t) => { t.needsUpdate = true; }); e.wait = null; });
    _photo.set(url, e);
  }
  const t = new THREE.Texture();
  t.source = e.base.source;
  if (e.wait) e.wait.push(t); else t.needsUpdate = true;
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
    /* 自動軽量化の段階(opts.autoQ のときは前回たどりついた段階から始める: localStorage 'trainop_perf') */
    this.autoQ = !!opts.autoQ;
    this._perf = { dpr: Q.dpr, shadowLevel: 0, bloom: Q.bloom };
    if (this.autoQ) {
      try {
        const p = JSON.parse(localStorage.getItem(PERF_KEY) || 'null');
        if (p && p.q === this.quality) {
          if (p.dpr > 0) this._perf.dpr = Math.min(Q.dpr, p.dpr);
          this._perf.shadowLevel = p.shadowLevel ? 1 : 0;
          if (p.bloom === false) this._perf.bloom = false;
        }
      } catch (e) { /* 読めなければ既定のまま */ }
    }

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, this._perf.dpr));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = LOOK.day.exposure;
    if (Q.shadowsOn) {
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }
    this.scene = new THREE.Scene();
    /* 霧は1つだけ作り、あとは色と距離を書きかえるだけ(作り直すと全材質の再判定でカクつく) */
    this.scene.fog = new THREE.Fog(LOOK.day.fogFallback, LOOK.day.fog[1], LOOK.day.fog[2]);
    /* 遠景クリップは霧の終わりに合わせる(_applyLightLevel)。霧の向こうを描かないぶん描画が減る */
    this.camera = new THREE.PerspectiveCamera(58, 16 / 9, 0.3, LOOK.day.fog[2] + 60);
    this.scene.add(this.camera);   // 運転台(cockpit)をカメラの子として描くため
    this.cockpit = new Cockpit(this.camera);
    this.camMode = 'cab';
    this._camBlend = 1;
    this.clockT = 0;
    this.fps = 60;
    this._fpsAcc = 0; this._fpsN = 0;
    this._frame = 0;

    /* ---- 見え方の状態(ほかの部品はこれを見て昼夜・天気・屋内に合わせる) ----
     * rev は時間帯・天気が変わるたびに増える。k は目の慣れ(屋外1、トンネルの奥0.1) */
    this.look = { rev: 0, tod: this.timeOfDay, night: false, eve: false, rain: false, snow: false, wet: false, indoor: false, k: 1 };
    /* ぬれ・雪の共通シェーダ部品の値(全材質で共有。書きかえるだけでコンパイルは起きない) */
    this.U = makeWeatherUniforms();
    this.U.uWxMacro.value = makeMacroTex();
    this._camS = sim ? sim.pos : 0;
    this._k = 1; this._kFog = 1; this._kWx = 1; this._kEnv = 1; this._kInit = false;
    this._envMats = new Set();
    this._fogDirect = new THREE.Color(LOOK.day.fogFallback);
    this._fogPost = new THREE.Color(LOOK.day.fogFallback);
    this._fogIn = new THREE.Color(LOOK.indoor.fog[0]);
    this._bgCol = new THREE.Color();
    this._tv = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    this._resetCamFeel();

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
      sleeper: new THREE.MeshStandardMaterial({ color: 0x6b6862, roughness: 0.95 }),
    };
    this.M.water.envMapIntensity = 0.6;
    this.M.railHead.envMapIntensity = 1.35;
    /* 芝の地面には大きなムラと雪の凹凸を足す。レール頭面は車輪で磨かれるので雪をのせない */
    this.M.ground.userData.wxMacro = true;
    this.M.bank.userData.wxMacro = true;
    this.M.railHead.userData.noWeather = true;
    this.M.water.userData.noWeather = true;   // 川の水面に雪は積もらない
    this._keep = new Set([...Object.values(this.M), ...Object.values(this.T), this.U.uWxMacro.value]);

    /* ---- 光源(強さ・色は LOOK の表から _applyAtmosphere/_applyLightLevel で決める) ---- */
    this.hemi = new THREE.HemisphereLight(LOOK.day.hemi[1], LOOK.day.hemi[2], LOOK.day.hemi[0]);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(LOOK.day.sun[1], LOOK.day.sun[0]);
    this.sun.castShadow = Q.shadowsOn;
    if (Q.shadowsOn) {
      const ms = this._perf.shadowLevel ? 512 : Q.shadow;
      this.sun.shadow.mapSize.set(ms, ms);
      const sc = this.sun.shadow.camera;
      sc.near = 20; sc.far = 950;
      this.sun.shadow.bias = -0.0003;
      this.sun.shadow.normalBias = 0.08;
      if (this._perf.shadowLevel) { this.renderer.shadowMap.autoUpdate = false; this._shadowLite = true; }
    }
    this._shadowBox('cab');
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    /* 晴れのHDRの太陽の向き(読みこんだら一番明るい点から測りなおす) */
    this._sunDir = new THREE.Vector3(0.555, 0.742, 0.377).normalize();
    this._curSunDir = this._sunDir;

    /* 前照灯: 夜・トンネルで軌道を照らす(昼は0)。ライトの数が変わると全シェーダが作り直しに
     * なるので、visible は切りかえず強さだけ変える */
    this.headlight = new THREE.SpotLight(0xfff2dc, 0, 240, 0.24, 0.75, 2.0);
    this.headlight.castShadow = false;
    this.scene.add(this.headlight);
    this.scene.add(this.headlight.target);

    /* ---- 空と環境光: HDRI(晴/曇) + 夕方は大気散乱の空(Sky) + 夜は手続きの夜空 ---- */
    this.env = {};
    this._pmrem = new THREE.PMREMGenerator(this.renderer);
    this._pmrem.compileEquirectangularShader();
    const rl = new RGBELoader();
    [['clear', './assets/sky/sky_clear.hdr'], ['rain', './assets/sky/sky_overcast.hdr']].forEach(([k, url]) => {
      rl.load(url, (t) => {
        t.mapping = THREE.EquirectangularReflectionMapping;
        if (k === 'clear') {
          /* 太陽の円盤を抑えてから環境光を作る(影がはっきり出る) */
          const dir = prepareClearHdr(t);
          if (dir) this._sunDir.copy(dir);
        }
        this.env[k] = { bg: t, ibl: this._pmrem.fromEquirectangular(t).texture, hor: horizonRadiance(t) };
        this._applyWeather();
      });
    });
    this._buildEveningSky();
    this._buildNightSky();

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
      this._installWeatherChunk();
      this._resetCamFeel();
      this._kInit = false;   // 新しい運転の最初のフレームで目の慣れを合わせ直す
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
    /* 占有グリッドは街・木・丘を置くときだけ使う(十数MBあるので捨てる)。
     * これより前に捨てると occFree がどこでも「空き」と答え、線路や道路の上に木が生えるので、丘のあとで */
    this._occ = null;
    this._splitInstances();
    this._splitRibbons();
    this.traffic = new Traffic(this, sim);
    this._installWeatherChunk();
    this._resetCamFeel();
    this._kInit = false;
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
        c.userData = { ...im.userData };
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
    this._envMats = new Set();
    this._tunZones = null;
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
    this.bloom = null;
    if (!Q.bloom || this._perf.bloom === false) return;
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
      this.bloom = null;
    }
    this._needPrewarm = true;
  }

  /* ブルーム経由で描くか(夜・夕方・雨雪・トンネルやターミナルの中) */
  _usePost() {
    return !!this.composer && (this._k < 0.95 || this.timeOfDay !== 'day' || this.weather !== 'clear');
  }

  /* 使うシェーダを走り出す前に全部コンパイルしておく(走行中のカクつき防止)。
   * 直接描く場合とブルーム用の描画先に描く場合でシェーダが別なので、使うほうを両方。
   * 背景(HDRの箱)とブルームの各パスはシーンの外にあって compile() では作られないので、実際に1回描いて作らせる。
   * (背景を空のシーンで描くと、光源0個の使わない版ができ、しかも本番の版への切りかえが起きなくなる) */
  prewarm() {
    this._needPrewarm = false;
    const r = this.renderer;
    if (!r || !this.scene) return;
    const direct = !this.composer || (this.timeOfDay === 'day' && this.weather === 'clear');
    const rt0 = r.getRenderTarget();
    try {
      if (direct) {
        r.setRenderTarget(null);
        r.compile(this.scene, this.camera);
      }
      if (this.composer) {
        r.setRenderTarget(this.composer.renderTarget1);
        r.compile(this.scene, this.camera);
        /* 昼の晴れ(ふだんは直接描く)でも、トンネルやターミナルに入るとブルーム経由に切りかわる。
         * そのときに背景・にじみ・合成・出力のシェーダを作ると止まるので、ここで1回通しておく */
        if (direct) {
          this.composer.render(0);
          /* いまブルーム経由で描いている(ターミナルの中など)なら、外に出たときの直接描く版も */
          if (this._usePost()) { r.setRenderTarget(null); r.render(this.scene, this.camera); }
        }
      }
      if (r.shadowMap.enabled && this.sun && this.sun.castShadow) this._prewarmShadows();
    } catch (e) { /* 失敗しても描画時にコンパイルされるだけ */ }
    r.setRenderTarget(rt0);
  }

  /* 影の深度シェーダも先に作る。compile() は影のぶんを作らず、影は影の箱の中の物しか描かれないので、
   * 遠くにある種類の物は走行中にはじめて作られてカクつく。そこで種類ごとに1つ、カリングを外して1回描く。
   * 共有の深度材質は map/side が変わってもシェーダを選びなおさないので、needsUpdate で毎回選びなおさせる。
   * 遠い木のかたまり(LODで今は影なし)も、近づくと影を落とすので数に入れる。
   * さわった設定(カリング・影・onBeforeShadow)は、描画が失敗しても必ず元にもどす */
  _prewarmShadows() {
    const r = this.renderer;
    const lod = new Map(((this._town && this._town.treeCells) || []).map((c) => [c.mesh, c.shadow]));
    const reps = new Map();
    this.scene.traverseVisible((o) => {
      if (!o.isMesh || !(o.castShadow || lod.get(o))) return;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      if (!m) return;
      const k = [o.isInstancedMesh, !!o.instanceColor, o.customDepthMaterial ? o.customDepthMaterial.uuid : '',
        !!m.map, !!m.alphaMap, m.alphaTest > 0 ? m.uuid : '', m.shadowSide == null ? m.side : m.shadowSide].join('|');
      if (!reps.has(k)) reps.set(k, o);
    });
    if (!reps.size) return;
    const saved = [];
    try {
      reps.forEach((o) => {
        const own = Object.prototype.hasOwnProperty.call(o, 'onBeforeShadow');
        const obs = o.onBeforeShadow;
        saved.push({ o, fc: o.frustumCulled, cs: o.castShadow, own, obs });
        o.frustumCulled = false;
        o.castShadow = true;
        o.onBeforeShadow = function (rr, ob, cam, sc, geo, dm, grp) {
          dm.needsUpdate = true;
          obs.call(this, rr, ob, cam, sc, geo, dm, grp);
        };
      });
      r.shadowMap.needsUpdate = true;
      r.setRenderTarget(this.composer ? this.composer.renderTarget1 : null);
      r.render(this.scene, this.camera);
    } finally {
      saved.forEach(({ o, fc, cs, own, obs }) => {
        o.frustumCulled = fc;
        o.castShadow = cs;
        if (own) o.onBeforeShadow = obs;
        else delete o.onBeforeShadow;
      });
    }
  }

  /* fps低下時に段階的に画質を落とす: 解像度 → 影(小さく・1フレームおき) → ブルーム。
   * 影は shadowMap.enabled を切りかえない(全シェーダの作り直しで数秒止まるため) */
  stepDownQuality() {
    const r = this.renderer, P = this._perf;
    const cur = r.getPixelRatio();
    const next = [1.35, 1.15, 1.0].find((d) => d < cur - 0.01);
    if (next) {
      r.setPixelRatio(next);
      P.dpr = next;
      this._reapplySize();
      this._savePerf();
      return 'dpr';
    }
    if (r.shadowMap.enabled && !this._shadowLite) {
      const sh = this.sun.shadow;
      sh.mapSize.set(512, 512);
      if (sh.map) { sh.map.dispose(); sh.map = null; }
      r.shadowMap.autoUpdate = false;
      r.shadowMap.needsUpdate = true;
      this._shadowLite = true;
      P.shadowLevel = 1;
      this._savePerf();
      return 'shadow';
    }
    if (this.composer && this._usePost()) {
      const c = this.composer;
      c.renderTarget1.dispose();
      c.renderTarget2.dispose();
      c.passes.forEach((p) => { if (p.dispose) p.dispose(); });
      this.composer = null;
      this.bloom = null;
      P.bloom = false;
      this._savePerf();
      this._needPrewarm = true;   // これからは直接描くので、そのシェーダを用意しなおす
      return 'bloom';
    }
    return null;
  }

  _savePerf() {
    const P = this._perf;
    /* 保存するのは自動軽量化が有効(opts.autoQ)のときだけ。古い呼び出し元の1回のカクつきで下げた段階を次回に持ちこまない。
     * 30fpsちょうどで安定しているとき(_capLike: iPadの低電力モードなどで、書きかえが1秒30回に絞られている)は
     * GPUの力不足ではないので、下げるのはこの回だけにして保存しない(保存すると低電力モードをやめても軽いまま) */
    if (!this.autoQ || this._capLike) return;
    try {
      localStorage.setItem(PERF_KEY, JSON.stringify({ q: this.quality, dpr: P.dpr, shadowLevel: P.shadowLevel, bloom: P.bloom !== false }));
      this._perfSaved = true;
    } catch (e) { /* 保存できなくても動く */ }
  }

  /* 自動軽量化の見張り(毎フレーム呼ぶ)。1回のカクつきでは落とさない:
   * 4秒ごとに平均fpsを見て、40未満が2回続き、直近2.5秒にカクつき(0.09秒以上)が無いときだけ1段下げる。
   * 55fps以上が3回(12秒)続いたら、前の起動で保存した軽い段階は忘れる(次の起動はふつうの画質から) */
  autoQualityTick(dt, { busy = false } = {}) {
    const A = this._aq || (this._aq = { t: 0, n: 0, hitch: -1e9, bad: 0, good: 0, mx: 0, forgot: false });
    const now = performance.now();
    if (dt >= 0.09) A.hitch = now;
    A.t += dt; A.n++;
    if (dt > A.mx) A.mx = dt;
    if (A.t < 4 - 1e-6) return null;   // 1/30秒を120回足しても4にわずかに届かないので少し余裕を見る
    const fps = A.n / A.t, mx = A.mx;
    A.t = 0; A.n = 0; A.mx = 0;
    /* 30fps前後で1コマの長さがそろっている = 画面の書きかえの上限(iPadの低電力モードなど)。GPUの限界ではないので保存しない */
    this._capLike = fps > 27 && fps < 32 && mx < 0.045;
    /* なめらかに動いている: 前の起動で保存した軽い段階を消す。
     * ただし、この起動で自分で下げて保存した段階は消さない(下げたから速くなっただけなので) */
    A.good = fps >= 55 ? A.good + 1 : 0;
    if (A.good >= 3 && this.autoQ && !this._perfSaved && !A.forgot) {
      A.forgot = true;
      try { localStorage.removeItem(PERF_KEY); } catch (e) { /* 消せなくても動く */ }
    }
    const bad = fps < 40 && now - A.hitch > 2500 && !busy;
    A.bad = bad ? A.bad + 1 : 0;
    if (A.bad < 2) return null;
    A.bad = 0;
    return this.stepDownQuality();
  }

  _reapplySize() {
    if (this._w) {
      this.renderer.setSize(this._w, this._h, false);
      if (this.composer) {
        this.composer.setPixelRatio(this.renderer.getPixelRatio());
        this.composer.setSize(this._w, this._h);
      }
    }
  }

  setWeather(w) {
    this.weather = w;
    this._applyWeather();
  }

  /* 夕方の空: 金色の夕焼け(手続きシェーダ。look.js makeDuskSky)。環境光もそこから生成 */
  _buildEveningSky() {
    /* 夕日は西南西(くだりの進行方向の先)。高度3.2° */
    const phi = THREE.MathUtils.degToRad(90 - 3.2);
    const theta = THREE.MathUtils.degToRad(-112);
    this._eveSunDir = new THREE.Vector3().setFromSphericalCoords(1, phi, theta).normalize();
    const { mesh, U } = makeDuskSky(new THREE.BoxGeometry(1, 1, 1));
    U.uSun.value.copy(this._eveSunDir);
    mesh.scale.setScalar(2300);
    this._duskU = U;
    const tmp = new THREE.Scene();
    tmp.add(mesh);
    try {
      this.env.evening = { ibl: this._pmrem.fromScene(tmp, 0.02).texture, sky: mesh };
    } catch (e) { /* 失敗しても晴れの環境で代用 */ }
    tmp.remove(mesh);
    mesh.visible = false;
    this.eveSky = mesh;
    this.scene.add(mesh);
  }

  /* 夜空: 紺のグラデーション・地平線の街明かり・星・月(HDR画像は使わない)。環境光もここから作る */
  _buildNightSky() {
    const { mesh, U } = makeNightSky(this.eveSky.geometry);
    mesh.scale.setScalar(2300);
    this._nightU = U;
    /* 月明かり(夜の平行光)の向きは高い空から。見えている低い月の向きにすると、
     * レールの頭がまっすぐこちらへ光って白くにじむため */
    this._moonDir = new THREE.Vector3(-0.35, 0.42, 0.84).normalize();
    /* 地平線の街明かり(都心は茶色がかったオレンジ、郊外は暗い灰色、雨の夜は灰色) */
    this._glowCity = new THREE.Color(0x3a2416);
    this._glowSub = new THREE.Color(0x15141a);
    this._glowWet = new THREE.Color(0x2a2a30);
    this._glowK = 0;
    /* 夜の霧の色(リニア): 都心は茶色がかった灰色、郊外は青みの灰色。遠くの街が黒くならず、空の明かりにかすむ。
     * 直接描く(低画質)用はトーンマップ後の値(_applyAtmosphere で作る) */
    this._nfCity = new THREE.Color(0x2b2c36);
    this._nfSub = new THREE.Color(0x1e2230);
    this._nfCityD = new THREE.Color(0x2b2c36);
    this._nfSubD = new THREE.Color(0x1e2230);
    const tmp = new THREE.Scene();
    tmp.add(mesh);
    try {
      this.env.night = { ibl: this._pmrem.fromScene(tmp, 0.02).texture };
    } catch (e) { /* 失敗したら単色の夜 */ }
    tmp.remove(mesh);
    mesh.visible = false;
    this.nightSky = mesh;
    this.scene.add(mesh);
  }

  /* 天気・時間帯が変わったとき(と、空の読みこみが終わったとき)の入口 */
  _applyWeather() {
    if (!this.M) return;
    this._applyAtmosphere();
    this._applyLightLevel(this._k);
  }

  /* 時間帯・天気で決まるもの(空・環境光・霧の色・光の色・ぬれ/雪)。毎フレームは呼ばない */
  _applyAtmosphere() {
    const rain = this.weather === 'rain';
    const snow = this.weather === 'snow';
    const wet = rain || snow;
    const tod = this.timeOfDay;
    const night = tod === 'night';
    const eve = tod === 'evening';
    const L = pickLook(tod, this.weather);
    this._lk = L;
    const lk = this.look;
    lk.rev++;
    lk.tod = tod; lk.night = night; lk.eve = eve; lk.rain = rain; lk.snow = snow; lk.wet = wet;
    /* --- 空(背景)と環境光 --- */
    const env = night ? this.env.night : wet ? this.env.rain : eve ? this.env.evening : this.env.clear;
    const eveSky = eve && !wet && !!this.env.evening;
    if (this.eveSky) this.eveSky.visible = eveSky;
    if (this.nightSky) this.nightSky.visible = night && !!this.env.night;
    if ((night || eveSky) && env) {
      this.scene.background = null;
      this.scene.environment = env.ibl;
    } else if (env && env.bg) {
      this.scene.background = env.bg;
      this.scene.environment = env.ibl;
      this.scene.backgroundIntensity = L.bg;
    } else {
      this.scene.background = this._bgCol.setHex(night ? 0x0a0f16 : rain ? 0x8d959c : snow ? 0xc9cfd5 : eve ? 0x9a7a6a : 0xa8c4dd);
      this.scene.environment = null;
    }
    if (this._nightU) {
      this._nightU.uStars.value = wet ? 0 : 1;
      if (wet) this._nightU.uGlow.value.copy(this._glowWet);
    }
    /* --- 霧の色: 遠くの物が空の地平線と同じ色に溶けるように。
     * _fogPost はブルーム経由(リニアの光の強さのまま混ざる)、_fogDirect は直接描く低画質用
     * (トーンマップ後の値をリニアのまま持つ。画面へ送るときに sRGB へ1回だけ変換される) --- */
    const hor = env && env.hor;
    const ex = L.exposure;
    const toDirect = (src, out) => {
      const t = acesFilmic([src.r, src.g, src.b], ex);
      return out.setRGB(t[0], t[1], t[2], THREE.LinearSRGBColorSpace);
    };
    if (L.fogLin) {
      /* 夕方: 霧は夕焼けの地平線と同じ色(リニアで直接) */
      this._fogPost.setRGB(L.fogLin[0], L.fogLin[1], L.fogLin[2], THREE.LinearSRGBColorSpace);
      toDirect(this._fogPost, this._fogDirect);
    } else if (L.fog[0] != null) {
      this._fogPost.setHex(L.fog[0]);
      toDirect(this._fogPost, this._fogDirect);
    } else if (hor) {
      fogFromHorizon(hor, L.bg, ex, true, this._fogDirect);
      fogFromHorizon(hor, L.bg, ex, false, this._fogPost);
    } else {
      /* 空の画像の読みこみ前(背景は単色=トーンマップされない色なので、直接描くときはそのまま) */
      this._fogDirect.setHex(L.fogFallback);
      this._fogPost.setHex(L.fogFallback);
    }
    /* 夜(晴れ)の霧は都心⇔郊外で色を変える(_updateLightLevel)。その直接描く用の色 */
    if (this._nfCity) {
      toDirect(this._nfCity, this._nfCityD);
      toDirect(this._nfSub, this._nfSubD);
    }
    /* --- 太陽(夜は月)・空の光 ---
     * 昼の太陽は、空の画像の太陽の方位のまま高さ36°に下げる(影が長くなり、建物の立体感が出る。
     * 画像の太陽の円盤は運転台・追いかけ視点では画面の上の外なので、ずれは見えない) */
    if (!this._sunLow) this._sunLow = new THREE.Vector3();
    const sd = this._sunDir, az = Math.atan2(sd.z, sd.x), el = THREE.MathUtils.degToRad(36);
    this._sunLow.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
    this.sun.color.setHex(L.sun[1]);
    this._curSunDir = night ? (this._moonDir || this._sunLow)
      : eveSky && this._eveSunDir ? this._eveSunDir.clone().setY(Math.max(0.09, this._eveSunDir.y)).normalize() : this._sunLow;
    /* 影はどの時間帯・天気でも落とす(切りかえると全シェーダの作り直しで止まる)。
     * 夜は月の青い影、雨はうすい影になる(強さは太陽の明るさで決まる) */
    this.sun.castShadow = QUALITY[this.quality].shadowsOn;
    /* 空の光の色(トンネルの中では _applyLightLevel で灰色の明かりへ寄せる) */
    if (!this._hemiSky) {
      this._hemiSky = new THREE.Color(); this._hemiGnd = new THREE.Color();
      this._hemiInSky = new THREE.Color(0x8d939a); this._hemiInGnd = new THREE.Color(0x625e58);
    }
    this._hemiSky.setHex(L.hemi[1]);
    this._hemiGnd.setHex(L.hemi[2]);
    /* 霧の照り返しに使う太陽の向き(夕方だけ値が入る。_applyLightLevel) */
    this.U.uSunDirW.value.copy(this._eveSunDir || this._curSunDir);
    /* --- ぬれ・雪(全材質共通の部品の値は _applyLightLevel で。トンネルの中は乾いている) --- */
    this.M.railHead.roughness = wet ? 0.12 : 0.3;
    this.M.water.roughness = night ? 0.22 : wet ? 0.38 : 0.3;
    this.M.water.color.setHex(night ? 0x141c26 : wet ? 0x49525a : eve ? 0x6a5a58 : 0x455e6d);
    const lightsOn = night || eve || this._inTunnelNow;
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
    /* 空の映りこみの強さ(LOOK.env)が変わるので、次の _applyLightLevel で全材質に書き直す */
    this._kEnv = -1;
    /* 状態が変わったので、次に描く前に使うシェーダをまとめて準備する */
    this._needPrewarm = true;
  }

  /* 目の慣れ k(屋外1・トンネルの奥0.1)で決まるもの。毎フレーム呼ぶので値の書きかえだけ(new しない)。
   * 光の強さは k、露出は目の慣れ _kE(暗い所へ入ると約2秒かけて慣れ、明るい所へ出ると約1秒まぶしい) */
  _applyLightLevel(k) {
    const L = this._lk;
    if (!L) return;
    const I = LOOK.indoor, kf = this._kFog;
    const day = this.timeOfDay === 'day';
    const post = this._usePost();
    const kE = this._kE != null ? this._kE : k;
    const boost = Math.min(2, 1 + 0.9 * (1 - kE));
    this.sun.intensity = L.sun[0] * k;
    /* 空の光: トンネル・ターミナルの中は灯りの照り返しのような灰色の明かりを足す(壁・天井が真っ黒につぶれない。
     * 出口で急に消えないよう k だけで決める。ターミナルは天井の灯りが多いので控えめに)。
     * 晴れの夜は、都心はビルで空がかくれて少し暗く、郊外は空が広くて明るい(_glowK: 0=都心 1=郊外) */
    const fill = k < 1 ? (this._inTerminal(this._camS, 30) ? 0.35 : 0.7) * (1 - k) : 0;
    const open = L.key === 'night' ? 0.85 + 0.4 * this._glowK : 1;
    this.hemi.intensity = L.hemi[0] * k * open + fill;
    this.hemi.color.copy(this._hemiSky).lerp(this._hemiInSky, 1 - k);
    this.hemi.groundColor.copy(this._hemiGnd).lerp(this._hemiInGnd, 1 - k);
    this.renderer.toneMappingExposure = L.exposure * boost;
    /* 霧(トンネルの中は暗く近く) */
    const fog = this.scene.fog;
    fog.color.copy(post ? this._fogPost : this._fogDirect);
    if (kf < 1) fog.color.lerp(this._fogIn, 1 - kf);
    fog.near = I.fog[1] + (L.fog[1] - I.fog[1]) * kf;
    fog.far = I.fog[2] + (L.fog[2] - I.fog[2]) * kf;
    /* 上空から: 街の外の何もない地面がかすみに溶けこむよう、霧を近くから濃く */
    if (this.camMode === 'drone') { fog.near = Math.min(fog.near, 20); fog.far = Math.min(fog.far, 1050); }
    /* 霧の照り返し(夕方・ブルーム経由だけ。直接描く霧はトーンマップ後の色なので足さない) */
    if (L.key === 'eve' && post) this.U.uFogSun.value.set(0.9 * kf, 0.1 * kf, 0);
    else this.U.uFogSun.value.set(0, 0, 0);
    /* 遠景クリップ = 霧の終わり+60m(夜は対向列車の灯りが消えないよう1300m以上) */
    const far = Math.round(Math.max(fog.far + 60, this.timeOfDay === 'night' ? 1300 : 0));
    if (far !== this.camera.far) {
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
      const sk = 0.95 * far / 0.866;   // 空の箱の角が遠景クリップの内側に入る大きさ
      if (this.eveSky) this.eveSky.scale.setScalar(sk);
      if (this.nightSky) this.nightSky.scale.setScalar(sk);
    }
    /* ぬれ・雪: トンネルの奥・地下駅・ターミナルの屋根の下では消す(_updateLightLevel で目の慣れと同じ速さでなじませる) */
    const kw = this._kWx;
    this.U.uWet.value = L.wet * kw;
    this.U.uSnow.value = L.snow * kw;
    /* 夜の色のうすさ(灯りのあるトンネルの中では弱める) */
    this.U.uNightDs.value = (L.desat || 0) * k;
    /* 前照灯(昼の屋外は0、トンネルでは点ける) */
    if (this.headlight) this.headlight.intensity = L.head + (I.head - L.head) * (1 - k);
    /* ブルーム: 明るさの境目(しきい値)は表どおり。屋内(昼)は k に合わせてじわっと効かせる。
     * 出口では目が慣れるまで(_kE)屋内の設定のまま(外のまぶしさがにじむ) */
    if (this.bloom) {
      const kb = Math.min(k, kE);
      const inside = day && kb < 0.95;
      const b = inside ? I.bloom : (L.bloom || I.bloom);
      this.bloom.threshold = b[0];
      this.bloom.strength = b[1] * (inside ? Math.min(1, (1 - kb) / 0.3) : 1);
      this.bloom.radius = b[2];
    }
    /* 空の映りこみ(トンネルの中では空が見えない)。k か見え方が変わったときだけ書きかえる。
     * 車両(envKeep)はステンレスのつやを残すので LOOK.env を掛けない */
    if (Math.abs(k - this._kEnv) > 0.01 || (k === 1 && this._kEnv !== 1)) {
      this._kEnv = k;
      const ef = L.env != null ? L.env : 1;
      this._envMats.forEach((m) => { m.envMapIntensity = m.userData.env0 * k * (m.userData.envKeep ? 1 : ef); });
    }
    /* 架線・電線(光の影響を受けない線の材質): 夜やトンネルで空より明るく光らないよう、
     * 明るさ k と露出の上げ幅で割る(トンネルの中では黒いシルエット) */
    const wk = Math.max(0.05, k * (L.wire != null ? L.wire : 1)) / boost;
    for (let i = 0; i < 2; i++) {
      const w = i === 0 ? this.M.wire : (this._p1M ? this._p1M.wire : null);
      if (!w || !w.color) continue;
      if (!w.userData.base) w.userData.base = w.color.clone();
      w.color.copy(w.userData.base).multiplyScalar(wk);
    }
  }

  /* ぬれ・雪の共通部品を、ワールドと車両の標準材質に付ける(運転台=カメラの子は除く)。
   * あわせて k で明るさを変える材質(空の映りこみ)を集める */
  _installWeatherChunk() {
    if (this._hillMat) this._hillMat.userData.wxMacro = true;
    const add = (m) => this._wxAdd(m);
    const walk = (o) => {
      if (o === this.camera) return;
      if (o.material) [].concat(o.material).forEach(add);
      o.children.forEach(walk);
    };
    walk(this.scene);
    /* 車両の材質は空の映りこみを弱めない(ステンレスのつや) */
    if (this.trainKit) Object.values(this.trainKit.M).forEach((m) => { if (m && m.userData) m.userData.envKeep = true; add(m); });
    this._kEnv = -1;
    this._needPrewarm = true;
  }

  _wxAdd(m) {
    if (!m || !m.isMeshStandardMaterial) return;
    /* 雨の日に水たまりができる平らな舗装(ホーム・犬走り・街の地面・道路。駅の材質 st-st は駅の部品の名前で見分ける) */
    const M = this.M;
    if (m === M.apron || m === M.plat || m === M.groundUrban || m === M.roadAsphalt || m.name === 'st-st') m.userData.puddle = true;
    /* 車両の材質(_kit から直接呼ばれたときも分かるように) */
    const tk = this.trainKit;
    if (tk && tk.M) { for (const key in tk.M) if (tk.M[key] === m) m.userData.envKeep = true; }
    if (!m.userData.noWeather) installWeather(m, this.U);
    if (m.userData.puddle && m.userData.wxPudU) m.userData.wxPudU.value = 1;
    if (m.userData.env0 === undefined) m.userData.env0 = m.envMapIntensity;
    this._envMats.add(m);
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
    /* ホーム(へり・笠石・点字ブロック・柵)・屋根・柱・光だまり・駅名標・時計: scene/stations.js */
    buildStations(this);
    this._buildTunnelLights();
  }

  /* トンネルの壁の照明(12mごと)と、壁・床の光だまり */
  _buildTunnelLights() {
    buildTunnelLights(this);
  }

  /* ---------- 信号機 ---------- */
  _buildSignals() {
    /* 4灯式の信号機・番号札・ATS地上子をまとめて描く(scene/signage.js)。
     * this.signalMeshes は空のままにして、render 内の古い現示ループを空回りさせる */
    buildSignals(this);
  }

  /* ---------- 制限標識 ---------- */
  _buildBoards() {
    /* 制限・解除・停止位置の予告(300/200/100/50m)・キロ程。すべて柱に立てる */
    buildBoards(this);
  }

  /* ---------- 街並み(scene/town.js) ----------
   * 占有グリッド・側道/交差道路/電柱/電線・線路と平行な中高層・戸建て・遠景リングを作る */
  _buildTown() {
    /* 昼夜でテクスチャを差し替える旧方式(_bldMats)はターミナルの駅ビルだけが使う */
    this._bldMats = [];
    buildTown(this);
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

  /* ---------- 並木・樹木 ----------
   * 木は this._treeQueue にためて、最後(_buildHills)にまとめて植える(描画コールを減らすため) */
  _buildTrees() {
    const F = this.frames, L = this.line.meta.length;
    const rng = makeRng(7777);
    const T = this._town;
    const kindAt = T ? T.kindAt : () => 2;
    const q = this.line.sections.quad;
    const QO = this.quadOff || [3.8, 7.6];
    const qk = T ? T.q : 1;
    const nearStation = (s) => this.line.stations.some((st) => s > st.s - 165 && s < st.s + 25);
    const inRiver = (s) => this.line.sections.river.some((r) => s > r.from - 80 && s < r.to + 80);
    const list = this._treeQueue || (this._treeQueue = []);
    for (let s = 60; s < L - 60; s += 22) {
      if (this._inTunnel(s) || inRiver(s) || this._inTerminal(s, 40)) continue;
      const k = kindAt(s);
      const f = frameAt(F, this.step, s + rng() * 20);
      const ss = s + 10;
      /* 線路ぎわの木はごくまばらに(郊外のみ・道路や建物のない所) */
      const pNear = k >= 2 ? 0.06 : 0;
      if (this.crossSpots.some((c) => Math.abs(c - s) < 24)) continue;
      for (const side of [1, -1]) {
        const inDepot = side < 0 && this.depotZone && s > this.depotZone.a - 40 && s < this.depotZone.b + 40;
        if (inDepot) continue;
        if (pNear > 0 && rng() < pNear && !nearStation(s)) {
          let base = side > 0 ? 7.2 : 10.4;
          if (side > 0 && s > q.from - 30 && s < q.to + 30) base = QO[1] + 3.8;
          const p = f.p.clone().addScaledVector(f.left, side * (base + rng() * 5.5));
          if (occFree(this, p.x, p.z)) list.push({ p, s: ss, sc: 0.7 + rng() * 0.8, tint: 0.75 + rng() * 0.35 });
        }
        /* 郊外の散在林(家・道路のない所だけ) */
        if (k >= 2) {
          const n = k === 3 ? 3 : 2;
          for (let i = 0; i < n; i++) {
            if (rng() < 0.45 || rng() > qk) continue;
            const p = f.p.clone().addScaledVector(f.left, side * (20 + rng() * 120));
            if (!occFree(this, p.x, p.z)) continue;
            p.y -= 0.5;
            list.push({ p, s: ss, sc: 0.85 + rng() * 0.9, tint: 0.7 + rng() * 0.4, conifer: k === 3 && rng() < 0.3 });
          }
        }
      }
    }
    /* 雑木林・屋敷林のかたまり(約1.2kmごと。場所は _buildTown で確保ずみ) */
    (this._groves || []).forEach((g) => {
      const n = Math.round((25 + rng() * 20) * (0.5 + 0.5 * qk));
      for (let i = 0; i < n; i++) {
        const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * g.r;
        const con = rng() < 0.5;
        list.push({ x: g.x + Math.cos(a) * r, y: g.y - 0.5, z: g.z + Math.sin(a) * r, s: g.s, sc: 1.3 + rng() * 0.8, sy: con ? 1.5 : 1, tint: 0.62 + rng() * 0.35, conifer: con });
      }
    });
  }

  /* 木を植える(広葉樹2種+針葉樹1種)。list: [{p|x,y,z, s, sc, sy?, tint, conifer?}] */
  _plantTrees(list, rng) {
    if (!this._treeGeos) this._treeGeos = makeTreeGeos();
    this._treeGeosP1 = this._treeGeos;
    return plantTreesP1(this, list, rng);
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
      /* 車両の材質(全編成で共有)にも、ぬれ・雪の部品を付ける */
      Object.values(this.trainKit.M).forEach((m) => this._wxAdd(m));
      this._needPrewarm = true;
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
    buildStopBeam(this);
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
    /* 地面に建つ駅ビル・発車標(LED)・タイルの柱・格子の天井・島式ホーム */
    buildTerminal(this);
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
    /* 小さな築山の上に、少し大きめに立てる(壁ごしでも見えるように) */
    const mound = new THREE.Mesh(new THREE.CylinderGeometry(5.2, 6.8, 1.4, 14),
      new THREE.MeshStandardMaterial({ color: 0x6d7a5a, roughness: 1 }));
    mound.position.y = -0.7;
    g.add(mound);
    g.scale.setScalar(1.3);
    g.position.copy(f.p).addScaledVector(f.left, -17.5);
    g.position.y += 1.6;
    g.lookAt(g.position.clone().addScaledVector(f.left, -40));
    g.updateMatrixWorld(true);
    /* 社叢(鳥居の奥の鎮守の森): 針葉樹の多い木立35本 + 石の玉垣(30m四方) */
    const rng = makeRng(1185);
    const q0 = this._treeQueue || (this._treeQueue = []);
    const v = new THREE.Vector3();
    for (let i = 0; i < 35; i++) {
      v.set((rng() - 0.5) * 20, 0, 8 + rng() * 17);
      g.localToWorld(v);
      v.y = f.p.y - 0.5;
      const con = rng() < 0.65;
      q0.push({ x: v.x, y: v.y, z: v.z, s: s0 - 190, sc: 1.6 + rng() * 0.8, sy: con ? 1.4 : 1, tint: 0.55 + rng() * 0.3, conifer: con });
    }
    const posts = [];
    const half = 15 / 1.3;
    for (let k = 0; k < 4; k++) {
      for (let d = -half; d < half; d += 0.8 / 1.3) {
        const lx = k === 0 ? d : k === 1 ? half : k === 2 ? -d : -half;
        const lz = 5.5 + half + (k === 0 ? -half : k === 1 ? d : k === 2 ? half : -d);
        if (k === 0 && Math.abs(lx) < 3.6) continue;   // 鳥居の前はあける
        v.set(lx, 0, lz);
        g.localToWorld(v);
        posts.push(v.clone().setY(f.p.y - 0.5 + 0.45));
      }
    }
    const pm = new THREE.InstancedMesh(new THREE.BoxGeometry(0.3, 0.9, 0.3), new THREE.MeshStandardMaterial({ color: 0xa9a59c, roughness: 0.95 }), posts.length);
    const m4 = new THREE.Matrix4(), qy = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), f.left.clone().negate());
    posts.forEach((p, i) => { m4.compose(p, qy, new THREE.Vector3(1, 1, 1)); pm.setMatrixAt(i, m4); });
    pm.castShadow = true;
    pm.userData.noSplit = true;
    this.world.add(pm);
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
    /* 検車庫: 波板の壁+切妻屋根+線路が入る黒い開口 */
    const fS = frameAt(F, this.step, b - 55);
    const shed = new THREE.Group();
    const corr = canvasTex(64, 64, (c) => {
      c.fillStyle = '#a3a9ad'; c.fillRect(0, 0, 64, 64);
      for (let x = 0; x < 64; x += 4) {
        c.fillStyle = 'rgba(0,0,0,.2)'; c.fillRect(x, 0, 1, 64);
        c.fillStyle = 'rgba(255,255,255,.14)'; c.fillRect(x + 2, 0, 1, 64);
      }
      c.fillStyle = 'rgba(0,0,0,.28)'; c.fillRect(0, 58, 64, 6);
    });
    corr.repeat.set(24, 1);
    const wallM = new THREE.MeshStandardMaterial({ map: corr, roughness: 0.55, metalness: 0.35 });
    const roofM = new THREE.MeshStandardMaterial({ color: 0x5d6468, roughness: 0.6, metalness: 0.3 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(16, 8, 92), wallM);
    body.position.y = 4;
    body.castShadow = true;
    shed.add(body);
    const th = 0.3, half = 8, rise = half * Math.tan(th);
    [-1, 1].forEach((sg) => {
      const slab = new THREE.Mesh(new THREE.BoxGeometry(half / Math.cos(th) + 0.7, 0.22, 93), roofM);
      slab.position.set(sg * half / 2, 8 + rise / 2 + 0.1, 0);
      slab.rotation.z = -sg * th;
      slab.castShadow = true;
      shed.add(slab);
    });
    const gable = new THREE.Shape([new THREE.Vector2(-half, 0), new THREE.Vector2(half, 0), new THREE.Vector2(0, rise)]);
    const gGeo = new THREE.ShapeGeometry(gable);
    [-46.01, 46.01].forEach((z) => {
      const gm = new THREE.Mesh(gGeo, wallM);
      gm.position.set(0, 8, z);
      if (z < 0) gm.rotation.y = Math.PI;
      shed.add(gm);
    });
    /* 線路の入口(手前側の妻面に黒い開口) */
    const door = new THREE.Mesh(new THREE.PlaneGeometry(13, 6.4), new THREE.MeshBasicMaterial({ color: 0x0d0f11 }));
    door.position.set(0, 3.2, -46.03);
    door.rotation.y = Math.PI;
    shed.add(door);
    shed.position.copy(fS.p).addScaledVector(fS.left, -18);
    shed.lookAt(shed.position.clone().add(fS.t));
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
    /* ゴンドラ28台(1回の描画でまとめて) */
    const cols = [0xd6604d, 0xf2b134, 0x4d9dd6, 0x62b56b, 0xb08bd0];
    const gon = new THREE.InstancedMesh(new THREE.BoxGeometry(2.0, 2.4, 2.0), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 }), 28);
    const gm4 = new THREE.Matrix4(), gc = new THREE.Color();
    for (let i = 0; i < 28; i++) {
      const a = (i / 28) * Math.PI * 2;
      gm4.makeTranslation(Math.cos(a) * 26, Math.sin(a) * 26 - 1.4, 0);
      gon.setMatrixAt(i, gm4);
      gon.setColorAt(i, gc.setHex(cols[i % cols.length]));
    }
    gon.userData.noSplit = true;
    spin.add(gon);
    /* 支柱: 前後2本ずつのA字形トラス */
    const legMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a5, roughness: 0.6, metalness: 0.4 });
    [-1, 1].forEach((sgn) => {
      [-3.2, 3.2].forEach((dz) => {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(1.0, 46, 1.0), legMat);
        leg.position.set(sgn * 9.5, -20, dz);
        leg.rotation.z = sgn * 0.42;                    // 上端が軸(ハブ)に集まる
        leg.rotation.x = dz > 0 ? -0.07 : 0.07;
        root.add(leg);
      });
      const brace = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 7.2), legMat);
      brace.position.set(sgn * 9.5, -20, 0);
      root.add(brace);
    });
    const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 8, 10), legMat);
    axle.rotation.x = Math.PI / 2;
    root.add(axle);
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
    buildFurniture(this);
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
    this._updateTown(dt);
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

  /* 街の毎フレーム処理(遠景リングの追従・昼夜の窓明かり・木のLOD)。scene/town.js */
  _updateTown(dt) {
    updateTown(this, dt);
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
    /* 待つ人(腕・脚・くつ・髪)と、屋根から下がる駅名。最後に看板と柱をまとめて世界へ出す */
    buildCrowds(this);
  }

  /* ---------- 丘陵(多摩丘陵らしい郊外の起伏と雑木林) ----------
   * でこぼこの半球3種を線路方向へ引きのばして、重ねて稜線に見せる(森のテクスチャ)。
   * 最後に、ここまでにためた木(並木・雑木林・庭木・社叢・稜線の木)をまとめて植える */
  _buildHills() {
    const trees = buildHillsP1(this);
    const list = (this._treeQueue || []).concat(trees);
    this._treeQueue = [];
    this._plantTrees(list, makeRng(4711));
  }

  /* ---------- 駅舎(駅名看板つき) ---------- */
  _buildStationHouses() {
    const F = this.frames;
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x3d4a56, roughness: 0.8 });
    const bodies = [];
    this.line.stations.forEach((st) => {
      if (this._inTunnel(st.s)) return;
      if (st.name === '新宿') return;   // 新宿は大屋根ターミナルがあるので省略
      const f = frameAt(F, this.step, st.s - 55);
      const g = new THREE.Group();
      /* 2階建ての駅舎(ガラスの外壁は街と同じ外壁シェーダ。全駅で1回の描画) */
      const p = f.p.clone().addScaledVector(f.left, -14.5);
      bodies.push({ x: p.x, y: p.y + 0.1 - 0.6, z: p.z, yaw: Math.atan2(f.t.x, f.t.z), sx: 6.5, sy: 8.4, sz: 15 });
      const roof = new THREE.Mesh(new THREE.BoxGeometry(16, 0.4, 7.5), roofMat);
      roof.position.y = 8.0;
      roof.castShadow = true;
      g.add(roof);
      /* 入口のひさし */
      const canopy = new THREE.Mesh(new THREE.BoxGeometry(15.4, 0.22, 1.8), roofMat);
      canopy.position.set(0, 3.15, 4.1);
      canopy.castShadow = true;
      g.add(canopy);
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(7.2, 1.3),
        new THREE.MeshBasicMaterial({
          map: boardTexture([
            [`${st.name} 駅`, 36, 34],
            [STATION_KANA[st.name] || '', 70, 18, 'normal'],
          ], { bg: '#f5f8fa', border: '#1b56a7', fg: '#16283a', w: 512, h: 96 }),
        }));
      sign.position.set(0, 4.15, 3.29);
      g.add(sign);
      g.position.copy(p);
      g.position.y += 0.1;
      g.lookAt(g.position.clone().addScaledVector(f.left, 30));   // 正面(+z)を線路側へ
      this.world.add(g);
    });
    stationBodiesP1(this, bodies);
  }

  /* ---------- 駅の人々(待つ・乗る・降りる。脚と腕が歩きで振れる) ---------- */
  _buildPeople() {
    buildPeople(this);
  }

  /* 1人分の配置+歩行アニメ。dirWorldは歩く向き(nullなら立ち) */
  _placeFig(fig, pos, dirWorld, dt, speed) {
    placeFig(this, fig, pos, dirWorld, dt, speed);
  }

  _updatePeople(dt) {
    this._updateSignals();
    /* 駅の人々・時計・昼夜の見た目(look が変わったときだけ) */
    updatePeople(this, dt);
  }

  /* 信号の現示(近い信号の灯だけ、変わったときに書きかえる) */
  _updateSignals() {
    updateSignals(this);
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
    this._shadowBox(mode);
  }

  /* 影を落とす範囲(太陽から見た箱)。運転台は前方だけ細かく、そらからは広く */
  _shadowBox(mode) {
    const sc = this.sun && this.sun.shadow.camera;
    if (!sc) return;
    if (mode === 'cab') { sc.left = -110; sc.right = 110; sc.top = 160; sc.bottom = -50; }
    else if (mode === 'drone') { sc.left = -170; sc.right = 170; sc.top = 190; sc.bottom = -120; }
    else { sc.left = -120; sc.right = 120; sc.top = 120; sc.bottom = -120; }
    sc.updateProjectionMatrix();
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

  /* 運転台の体感(ブレーキで前のめり・カーブで内側へ傾く・25mごとのレールの継ぎ目でコトン) */
  _resetCamFeel() {
    this._fv = null; this._accSm = 0; this._roll = 0;
    this._by = 0; this._bv = 0; this._jIdx = null;
  }

  _camFeel(dt, s, f) {
    if (!(dt > 0)) return;
    const sim = this.sim, v = sim.v / 3.6;
    if (this._fv == null) this._fv = v;
    const a = (v - this._fv) / dt;
    this._fv = v;
    if (Math.abs(a) <= 4) this._accSm += (a - this._accSm) * (1 - Math.exp(-dt / 0.35));   // ワープ等の飛びは捨てる
    /* カーブ: 25m先との向きの差(左カーブで負)。カントで車体は内側へ傾くので符号を反転して左へロール */
    const fA = frameAt(this.frames, this.step, Math.min(this.line.meta.length - 2, s + 25));
    const kap = (f.t.x * fA.t.z - f.t.z * fA.t.x) / 25;
    const rollT = -Math.max(-0.035, Math.min(0.035, kap * 12)) * Math.min(1, sim.v / 40);
    this._roll += (rollT - this._roll) * (1 - Math.exp(-dt / 0.8));
    /* 継ぎ目: ばね(固さ900・減衰28)にたたく力を入れる */
    const j = Math.floor((s - 1.2) / 25);
    if (this._jIdx != null && j !== this._jIdx && Math.abs(j - this._jIdx) < 3) this._bv += -0.5 * Math.min(1, sim.v / 70);
    this._jIdx = j;
    const n = Math.min(8, Math.ceil(dt * 240)), h = dt / n;
    for (let i = 0; i < n; i++) {
      this._bv += (-900 * this._by - 28 * this._bv) * h;
      this._by += this._bv * h;
    }
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
      /* 体感: ブレーキで視線が沈み、カーブでは内側へ傾き、継ぎ目で小さくはねる(FOVは変えない) */
      cam.rotateX(this._accSm * 0.01 + this._by * 0.25);
      cam.rotateZ(this._roll);
      cam.position.y += this._by * 0.012;
      cam.fov = 58;
      this._camS = s;
    } else if (mode === 'chase' || mode === 'drone') {
      const back = mode === 'drone' ? 95 : 34, side = mode === 'drone' ? 30 : 4.5;
      /* ターミナルの屋根の下・トンネルの中では天井より低く */
      const low = this._inTerminal(s - back, 8) || this._inTunnel(s - back) || this._inTunnel(s - back + 30);
      const up = mode === 'drone' ? 52 : low ? 5.2 : 8.5;
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
      this._camS = s - back;
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
      this._camS = s - 22;
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
      this._camS = this._frontCamS;
    }
    cam.updateProjectionMatrix();
  }

  /* 目の慣れ: カメラがトンネル・ターミナルにいると暗く(k<1)。
   * 光(k)は出入り口の30mで0.4秒ほどで変わる。目(露出 _kE)は遅れて追いかける:
   * 入るときは約2.2秒(しばらく暗い)、出るときは約0.9秒(しばらくまぶしい=白くにじむ) */
  _updateLightLevel(dt) {
    const s = this._camS;
    let kT = 1, kfT = 1, wxT = 1, indoor = false;
    if (this.camMode !== 'drone' && this.line) {
      const tn = this.line.sections.tunnel.find((t) => s > t.from && s < t.to);
      if (tn) {
        const d = Math.min(s - tn.from, tn.to - s);
        kT = 0.10 + 0.9 * (1 - THREE.MathUtils.smoothstep(d, 0, 30));
        /* 地下駅のホーム(照明あり)は少し明るい */
        if (this.line.stations.some((st) => st.s > tn.from && st.s < tn.to && s > st.s - 175 && s < st.s + 30)) kT = Math.max(kT, 0.30);
        kfT = kT;
        indoor = true;
        /* 雪・ぬれは出入り口の近く(外が見えるところ)だけ。奥や地下駅のホームは乾いている */
        wxT = Math.max(0, 1 - d / 60);
      } else if (this._inTerminal(s)) {
        kT = 0.30;
        indoor = true;
        /* ターミナルの屋根の下も乾いている(線路側の出口に近づくと外の雪・ぬれが見えてくる) */
        const T = this.terminal;
        wxT = Math.max(0, 1 - (T.up ? s - T.a : T.b - s) / 60);
      }
    }
    const jump = !this._kInit || Math.abs(s - this._kLastS) > 60;
    this._kInit = true;
    this._kLastS = s;
    if (jump || this._kE == null) { this._k = kT; this._kFog = kfT; this._kWx = wxT; this._kE = kT; }
    else if (dt > 0) {
      const a = 1 - Math.exp(-dt / 0.4);
      const aw = 1 - Math.exp(-dt * 1.2);
      const ae = 1 - Math.exp(-dt / (kT < this._kE ? 2.2 : 0.9));
      this._k += (kT - this._k) * a;
      this._kFog += (kfT - this._kFog) * a;
      this._kWx += (wxT - this._kWx) * aw;
      this._kE += (kT - this._kE) * ae;
      if (Math.abs(kT - this._k) < 0.002) this._k = kT;
      if (Math.abs(kfT - this._kFog) < 0.002) this._kFog = kfT;
      if (Math.abs(wxT - this._kWx) < 0.002) this._kWx = wxT;
      if (Math.abs(kT - this._kE) < 0.002) this._kE = kT;
    }
    this.look.k = this._k;
    this.look.indoor = indoor;
    /* 夜空の地平線の街明かりと夜の霧の色: 郊外(区分2以上)では弱める(_applyLightLevel より先に決める) */
    if (this._nightU && this.nightSky.visible && !this.look.wet) {
      const urb = this.line.sections.urban;
      const kind = (urb.find((u) => s >= u.from && s < u.to) || { kind: 2 }).kind;
      const g = kind >= 2 ? 1 : 0;
      if (jump) this._glowK = g;
      else if (dt > 0) this._glowK += (g - this._glowK) * (1 - Math.exp(-dt * 0.5));
      this._nightU.uGlow.value.copy(this._glowCity).lerp(this._glowSub, this._glowK);
      if (this._nfCity) {
        this._fogPost.copy(this._nfCity).lerp(this._nfSub, this._glowK);
        this._fogDirect.copy(this._nfCityD).lerp(this._nfSubD, this._glowK);
      }
    }
    this._applyLightLevel(this._k);
  }

  /* 太陽と影の箱を列車に追従させる。箱の位置は影の1画素ぶんずつ動かす(影のふちがちらつかない) */
  _placeSun(s, f) {
    const sun = this.sun, dir = this._curSunDir || this._sunDir;
    const [tgt, lx, ly] = this._tv;
    const mode = this.camMode;
    if (mode === 'front' && this._frontCamS != null) {
      tgt.copy(f.p).lerp(frameAt(this.frames, this.step, Math.min(this.line.meta.length - 2, this._frontCamS)).p, 0.5);
    } else {
      const ahead = mode === 'cab' ? 60 : mode === 'drone' ? 110 : mode === 'chase' ? 30 : -20;
      tgt.copy(f.p).addScaledVector(f.t, ahead);
    }
    if (sun.castShadow) {
      lx.crossVectors(UP, dir).normalize();
      ly.crossVectors(dir, lx);
      const sc = sun.shadow.camera, ms = sun.shadow.mapSize;
      const tx = (sc.right - sc.left) / ms.x, ty = (sc.top - sc.bottom) / ms.y;
      const a = tgt.dot(lx), b = tgt.dot(ly);
      tgt.addScaledVector(lx, Math.round(a / tx) * tx - a).addScaledVector(ly, Math.round(b / ty) * ty - b);
    }
    sun.target.position.copy(tgt);
    sun.position.copy(tgt).addScaledVector(dir, 430);
  }

  /* 毎フレーム描画 */
  render(dt) {
    this.clockT += dt;
    const sim = this.sim;
    const L = this.line.meta.length;
    const s = Math.max(0, Math.min(L - 2, sim.pos));
    const f = frameAt(this.frames, this.step, s);
    this._camFeel(dt, s, f);
    this._placeCamera(s, f, dt);
    const eye = this.camera.position;
    /* 明るさ(トンネル・ターミナルの目の慣れ)・霧・遠景クリップ */
    this._updateLightLevel(dt);

    /* 太陽と影ボックスを自列車に追従させる */
    this._placeSun(s, f);
    if (this.eveSky) this.eveSky.position.copy(eye);
    if (this.nightSky) this.nightSky.position.copy(eye);

    /* 前照灯の追従(自列車の先頭・レール上1.1m。90m先のレール面をねらう) */
    const head = this._tv[3].copy(f.p);
    head.y += 1.1;
    this.headlight.position.copy(head).addScaledVector(f.t, 0.5);
    this.headlight.target.position.copy(head).addScaledVector(f.t, 90);
    this.headlight.target.position.y -= 1.1;

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

    /* 屋内(トンネル・ターミナル)判定: 運転台の明るさ・雨雪の有無・車両の灯り
     * (空や光は k で連続的に変えるので、ここでは _applyWeather を呼ばない=カクつかない) */
    const indoor = this._inTunnel(s) || this._inTerminal(s, -6);
    const indoorEye = this._inTunnel(s + 3) || this._inTerminal(s + 3, -6);
    const tod = this.timeOfDay;
    if (indoor !== this._inTunnelNow) {
      this._inTunnelNow = indoor;
      if (this.trainKit) this.trainKit.setNight(tod !== 'day' || this.weather !== 'clear' || indoor);
    }
    let light = tod === 'night' ? 0.16 : tod === 'evening' ? 0.55 : this.weather === 'rain' ? 0.7 : this.weather === 'snow' ? 0.85 : 1;
    if (indoorEye) light = Math.min(light, 0.3);
    this.cockpit.update(dt, { light, night: tod === 'night', wiper: this.weather === 'rain' && !indoorEye && this.camMode === 'cab' });
    if (this.weatherFx) this.weatherFx.update(dt, sim.v / 3.6, indoorEye && this.camMode === 'cab');

    /* 時間帯・天気が変わった直後は、描く前に使うシェーダをまとめて準備 */
    if (this._needPrewarm) this.prewarm();
    /* 軽量化の段階: 影は1フレームおきに更新 */
    if (this._shadowLite) this.renderer.shadowMap.needsUpdate = (this._frame & 1) === 0;
    this._frame++;
    if (this._usePost()) this.composer.render();
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
