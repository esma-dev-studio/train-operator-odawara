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
import { STATION_KANA } from '../sim/kana.js';
import { buildStations, buildTunnelLights, buildSignals, updateSignals, buildBoards, buildStopBeam, buildTerminal, buildFurniture, buildCrowds, buildPeople, placeFig, updatePeople, stationStyle, concourseUnderside, buildCrossingAt, CROSS_LAMP } from './stations.js';
import { Cockpit } from './cockpit.js';
/* 運転台のふちのなめらか処理(COCKPIT_FEATHER)があるかを見るため(なければ キャンバスのMSAAを残す) */
import * as CK from './cockpit.js';
import { Traffic, placeTrain } from './traffic.js';
import { buildTownSteps, updateTown, makeTreeGeosP1, plantTreesP1, buildHillsP1, stationBodiesP1, makeRng, occFree, addCars } from './town.js';
import { TrainKit } from './trains.js';
import { WeatherFx } from './weatherfx.js';
import { QUAD_OFF, quadInfo, quadOffAt, quadSep, fenceOffL, bedRuns, rowRanges, frameInto, newFrame, smoothstep, buildTrackBed, buildCatenary, buildTunnel, buildRiver, updateExitGlow, updateCatenaryLod, mergeRibbons, texPCSleeper, STAIR, updateWireRes, buildTurnouts } from './trackbed.js';

THREE.Cache.enabled = true;
const UP = new THREE.Vector3(0, 1, 0);
/* 軌間1067mm(狭軌・日本の在来線)。レール中心までの半分の幅。車両(TrainKit)の車輪位置と合わせる */
const RAIL_HALF = 1.067 / 2 + 0.032;   // 軌間はレール頭部の内側で測るので、頭部中心は少し外
const DS = THREE.DoubleSide;

/* 画質プリセット。samples = ブルーム経由で描くときの描画先のMSAA(中・高は いつもこの道で描く) */
const QUALITY = {
  high: { dpr: 1.75, shadow: 2048, shadowsOn: true, aniso: 8, bloom: true, samples: 4, trainDetail: 'high' },
  mid:  { dpr: 1.35, shadow: 1024, shadowsOn: true, aniso: 4, bloom: true, samples: 2, trainDetail: 'mid' },
  low:  { dpr: 1.0,  shadow: 0,    shadowsOn: false, aniso: 2, bloom: false, samples: 0, trainDetail: 'low' },
};
/* 自動画質でたどりついた段階の保存先
 * {q, dpr, shadowLite(動く影を1フレームおき), shadowUp(影2048), shadowUpBad, bloomShift(にじみの解像度), drawFarK, maxDpr}
 * (古い保存の shadowLevel 1 は shadowLite として読む) */
const PERF_KEY = 'trainop_perf';
/* 自動画質の解像度(DPR)の段。下げるときも上げるときも1段ずつ */
const DPR_STEPS = [1.05, 1.15, 1.25, 1.35, 1.5, 1.75];
/* シェーダの準備(prewarmAsync)で、1つずつ描いて作るときだけ使うレイヤー(ふだんは だれも使わない) */
const WARM_LAYER = 29;
/* 準備は1回 12ms まで。のこりは つぎのタスクへ(画面の しゅっぱつカード・路線の帯が とまらない) */
const WARM_SLICE_MS = 12;
/* 毎フレームの作業用(new しない) */
const _pinV = new THREE.Vector3();

/* つぎのタスクまで ゆずる(setTimeout 0)。ms を渡すと そのぶん待つ */
function yieldTask(ms) {
  return new Promise((res) => setTimeout(res, ms || 0));
}
/* つぎの描画のタイミングまで ゆずる(裏のタブで rAF が止まっていても 100ms で すすむ) */
function yieldFrame() {
  return new Promise((res) => {
    let done = false;
    const go = () => { if (!done) { done = true; res(); } };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(go);
    setTimeout(go, 100);
  });
}

/* HDR(半精度RGBA)を縦横半分に(2x2の平均)。環境光(PMREM)はこの小さい版から作る
 * (2048x1024 のままだと作業用の描画先だけで約50MB。1024x512 なら256の立方体で約6MB) */
function downsampleHdr(t) {
  const img = t.image, W = img.width, H = img.height, d = img.data;
  const w = W >> 1, h = H >> 1;
  const out = new Uint16Array(w * h * 4);
  const f16 = THREE.DataUtils.fromHalfFloat, t16 = THREE.DataUtils.toHalfFloat;
  for (let y = 0; y < h; y++) {
    const r0 = 2 * y * W * 4, r1 = r0 + W * 4;
    for (let x = 0; x < w; x++) {
      const a = r0 + x * 8, b = r1 + x * 8, o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        out[o + c] = t16((f16(d[a + c]) + f16(d[a + 4 + c]) + f16(d[b + c]) + f16(d[b + 4 + c])) * 0.25);
      }
      out[o + 3] = d[a + 3];
    }
  }
  const s = new THREE.DataTexture(out, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
  s.mapping = THREE.EquirectangularReflectionMapping;
  s.colorSpace = t.colorSpace;
  s.minFilter = s.magFilter = THREE.LinearFilter;
  s.generateMipmaps = false;
  s.flipY = t.flipY;
  s.needsUpdate = true;
  return s;
}

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
  /* opts: { quality, timeOfDay:'day'|'evening'|'night', weather, autoQ, debug,
   *         deferWorld(ワールドは あとで setWorldAsync で作る。それまで描かない) } */
  constructor(canvas, line, sim, opts = {}) {
    this.quality = QUALITY[opts.quality] ? opts.quality : 'high';
    this.timeOfDay = opts.timeOfDay || (opts.night ? 'night' : 'day');
    this.weather = opts.weather || (sim && sim.weather) || 'clear';
    this._debug = !!opts.debug;
    const Q = QUALITY[this.quality];
    /* 自動画質の段階(opts.autoQ のときは前回たどりついた段階から始める: localStorage 'trainop_perf')。
     * 下げる: DPR・にじみの解像度(GPU) / 遠くを描く距離・影の間引き(CPU)。上げる: DPR・影2048 */
    this.autoQ = !!opts.autoQ;
    this._perf = this._loadPerf(Q);
    /* 遠くを描く距離の倍率(CPUが重いときに下げる。_cullTick が掛ける) */
    this._drawFarK = this._perf.drawFarK;
    /* 運転台の重ね描き(renderOverlay)はキャンバスに直接描く。ふちのなめらか処理(COCKPIT_FEATHER)が
     * あれば、中・高はキャンバスのMSAAを切る(シーンはブルーム用の描画先のMSAAで描く)。低は直接描くので残す */
    const feather = CK.COCKPIT_FEATHER === true;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !(feather && Q.bloom), powerPreference: 'high-performance' });
    /* シェーダのエラー確認(ログの取り出し)は1本ごとに完成を待つので重い。?debug=1 のときだけ */
    this.renderer.debug.checkShaderErrors = !!opts.debug;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, this._perf.dpr));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = LOOK.day.exposure;
    if (Q.shadowsOn) {
      this.renderer.shadowMap.enabled = true;
      /* 影のふちのぼかし: 高はやわらかい PCFSoft、中・低は PCF(画面じゅうの影の画素が軽くなる)。
       * 作るときに1回だけ決める(走っている途中で変えると全シェーダの作り直しになる) */
      this.renderer.shadowMap.type = this.quality === 'high' ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
      /* 影は「何かが動いたときだけ」描きなおす(render の moving 判定)。止まっている間は前の影をそのまま使う */
      this.renderer.shadowMap.autoUpdate = false;
    }
    /* WebGLの文脈が消えた(iPadが裏で回収した)ら描かない。もどったら glLost を下ろす。
     * 作り直し(ステージごと)は ui/glguard.js が受けもつ */
    this.glLost = false;
    this._onCtxLost = (e) => {
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      this.glLost = true;
      if (this._fences) this._fences = [null, null];   // 消えた文脈のフェンスは もう使えない
    };
    this._onCtxRestored = () => { this.glLost = false; this._shadowDirty = true; };
    try {
      canvas.addEventListener('webglcontextlost', this._onCtxLost, false);
      canvas.addEventListener('webglcontextrestored', this._onCtxRestored, false);
    } catch (e) { /* noop */ }
    /* 運転台の画面に出す「8」の目印の位置(render が毎フレーム書く。オブジェクトは使い回す)。
     * vis: 見えている / x,y: 画面の割合(0..1, 左上が0) / d: 停止位置までの距離(m) */
    this.stopPin = { vis: false, x: 0, y: 0, d: 0 };
    /* 毎フレームの作業用のフレーム(位置・向き・左)。frameAt の new を避ける */
    this._fr = newFrame();
    this._frA = newFrame();
    this._frB = newFrame();
    this._shadowDirty = true;
    this._shadowHold = 0;
    this._shAge = 0;                 // 前に影を描いてからの時間(秒)。中画質で動いている間は 1秒30回まで(_updateShadow)
    this._dead = false;              // 捨てたステージ(cancelAsync)。少しずつの作業は つぎの確認で やめる
    this._backdrop = false;          // メニュー・一時停止の背景(影もブルームも止める)
    this._staleMats = [];            // 作り直しで外した材質(次の準備のあとで捨てる=同じシェーダを使い回す)
    this._staleTex = [];
    this._cellReg = [];              // 遠いと描かないメッシュの一覧 {obj, cx, cz, r}
    this._cullX = 1e9; this._cullZ = 1e9; this._cullFar = -1;
    this._nSetSize = 0;              // 実際に大きさを変えた回数(確認用)
    this._booted = false;            // 最初の準備(prewarm)が済んだか。済んだあとに届いた空は、すぐには差しかえない
    this._envLate = {}; this._lateN = 0;
    this._envLoad = {};
    this.scene = new THREE.Scene();
    /* 霧は1つだけ作り、あとは色と距離を書きかえるだけ(作り直すと全材質の再判定でカクつく) */
    this.scene.fog = new THREE.Fog(LOOK.day.fogFallback, LOOK.day.fog[1], LOOK.day.fog[2]);
    /* 遠景クリップは霧の終わりに合わせる(_applyLightLevel)。霧の向こうを描かないぶん描画が減る */
    this.camera = new THREE.PerspectiveCamera(58, 16 / 9, 0.3, LOOK.day.fog[2] + 60);
    this.scene.add(this.camera);   // 運転台(cockpit)は作るときだけカメラの子(すぐ下の useOverlay で自分のシーンへ移る)
    this.cockpit = new Cockpit(this.camera);
    /* 運転台は最初から重ね描き用の自分のシーンへ移す(まだ何もコンパイルしていないので捨てるシェーダがない。
     * 最初の renderOverlay で移すと、prewarm が作った重ね描き用のシェーダまで捨ててしまう) */
    if (typeof this.cockpit.useOverlay === 'function') this.cockpit.useOverlay();
    this.camMode = 'cab';
    this._camBlend = 1;
    this.clockT = 0;
    this.fps = 60;
    this._fpsAcc = 0; this._fpsN = 0;
    this._frame = 0;
    /* 実際に描いたコマの数(テスト・自動画質用)と、GPUの おくれ見張り(_paceSkip)のフェンス */
    this.drawCount = 0;
    this._skipN = 0; this._skipDt = 0; this._skipT0 = 0;
    this._fences = [null, null]; this._fi = 0;

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
      /* 影の大きさ: ふつうは画質どおり。自動画質で上げた(shadowUp)ときは 2048 */
      const ms = this._perf.shadowUp ? Math.max(2048, Q.shadow) : Q.shadow;
      this.sun.shadow.mapSize.set(ms, ms);
      const sc = this.sun.shadow.camera;
      sc.near = 20; sc.far = 950;
      this.sun.shadow.bias = -0.0003;
      this.sun.shadow.normalBias = 0.08;
      /* CPUが重いときの段: 動いている間の影は1フレームおき(_updateShadow) */
      if (this._perf.shadowLite) this._shadowLite = true;
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

    /* ---- 空と環境光: HDRI(晴/曇) + 夕方は大気散乱の空(Sky) + 夜は手続きの夜空 ----
     * 晴れのHDRは起動時に読む。曇り(雨・雪)は使うときに読む(ensureEnv)。
     * 環境光はどれも 256 の立方体にそろえる(大きさが同じならシェーダも同じ=昼夜・天気の切替でコンパイルしない) */
    this.env = {};
    this._pmrem = new THREE.PMREMGenerator(this.renderer);
    this._pmrem.compileEquirectangularShader();
    this._wetBg = new THREE.Color(this.weather === 'snow' ? 0xc9cfd5 : 0x8d959c);   // 曇りの空がまだ無いときの雨・雪の背景色
    /* 夕焼け・夜空(どちらも重いシェーダを1回描いて環境光を作る)。opts.deferWorld のときは
     * ワールドを少しずつ作る最初の手順で1つずつ(_skySteps。起動の1つの長い処理にしない) */
    this._skyLater = !!opts.deferWorld;
    if (!this._skyLater) {
      this._buildEveningSky();
      this._buildNightSky();
    }
    /* 晴れの空(HDR)が届くまでの代わり: 青空のグラデーションから作った環境光と背景(どちらも本物と同じ種類)。
     * 届いて差しかえてもシェーダは変わらない(環境光の立方体の大きさ・背景の描き方が同じ) */
    this._buildStandInSky();
    this.ensureEnv('clear');
    if (this.weather !== 'clear' && this.timeOfDay !== 'night') this.ensureEnv('rain');

    /* ---- 雨・雪の粒(カメラ近傍だけ) ---- */
    this.weatherFx = new WeatherFx(this.scene, this.camera);

    /* ---- 路線(ワールド)は作り直せるようにグループにまとめる ----
     * 動かないものの行列は作ったあとに固める(_freezeStatic)。シーンとワールドの箱そのものは動かないので
     * 自分の行列を毎フレーム作りなおさない(作りなおすと子の全部に「更新」が伝わって、固めた意味がなくなる) */
    this.scene.matrixAutoUpdate = false;
    this.world = new THREE.Group();
    this.world.matrixAutoUpdate = false;
    this.scene.add(this.world);
    this._worldGen = 0;
    this._buildQ = null;
    if (opts.deferWorld) {
      /* ワールドは あとで(setWorldAsync)。できるまで描かない */
      this.sim = sim;
      this._deferHold = true;
      this._warming = (this._warming || 0) + 1;
    } else {
      this.setWorld(line, sim);
    }

    /* ---- ポストエフェクト(光のにじみ=ブルーム) ---- */
    this._initPost();
    if (!this._skyLater) this._applyWeather();
  }

  /* opts.deferWorld のとき: 夕焼け・夜空を作る手順(ワールドの手順の前に入れる)。もう作ってあれば空 */
  _skySteps() {
    if (!this._skyLater) return [];
    const pm = () => {
      /* 晴れのHDRが先に届くと、環境光づくりの道具(_pmrem)は もう捨ててある */
      if (!this._pmrem) { this._pmrem = new THREE.PMREMGenerator(this.renderer); this._pmremOwn = true; }
    };
    return [
      () => { if (this._skyLater && !this.eveSky) { pm(); this._buildEveningSky(); } },
      () => { if (this._skyLater && !this.nightSky) { pm(); this._buildNightSky(); } },
      () => {
        if (!this._skyLater) return;
        this._skyLater = false;
        /* 晴れの空がもう届いていれば、道具は ここで捨てる(届いていなければ _onHdr が使って捨てる) */
        if (this._pmrem && this.env.clear && !this.env.clear.placeholder) { this._pmrem.dispose(); this._pmrem = null; }
        this._applyWeather();
      },
    ];
  }

  /* 晴れの空の代わり(HDRが届くまで): 上は青・地平線は白っぽい・下は灰緑のグラデーションの箱を
   * 立方体の背景(64)と環境光(PMREM 256)にする。作業用の材質はすぐ捨てる(シェーダの数は増えない) */
  _buildStandInSky() {
    this._standIn = null;
    let geo = null, mat = null, cube = null, iblRT = null;
    try {
      geo = new THREE.SphereGeometry(10, 24, 12);
      const pos = geo.attributes.position, col = [];
      const top = new THREE.Color(0x6f9fd6), hor = new THREE.Color(0xd5e1ea), gnd = new THREE.Color(0x6d7466), c = new THREE.Color();
      for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i) / 10;
        if (y >= 0) c.copy(hor).lerp(top, Math.pow(y, 0.6));
        else c.copy(hor).lerp(gnd, Math.min(1, -y * 4));
        col.push(c.r, c.g, c.b);
      }
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      /* 色はリニアで 1.0 前後(晴れのHDRの空とだいたい同じ明るさ) */
      mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, toneMapped: false });
      const tmp = new THREE.Scene();
      tmp.add(new THREE.Mesh(geo, mat));
      iblRT = this._pmrem.fromScene(tmp, 0.04);
      cube = new THREE.WebGLCubeRenderTarget(64, { type: THREE.HalfFloatType });
      const cc = new THREE.CubeCamera(0.1, 100, cube);
      cc.update(this.renderer, tmp);
      /* iblRT・cube は 晴れの空が届いて使わなくなったら _promoteEnv が捨てる */
      this._standIn = { ibl: iblRT.texture, bg: cube.texture, cube, iblRT };
    } catch (e) {
      if (cube) cube.dispose();
      if (iblRT) iblRT.dispose();
      this._standIn = null;
    }
    if (geo) geo.dispose();
    if (mat) mat.dispose();
  }

  get night() { return this.timeOfDay === 'night'; }
  set night(n) { this.setTimeOfDay(n ? 'night' : 'day'); }
  setNight(n) { this.setTimeOfDay(n ? 'night' : 'day'); }

  setTimeOfDay(t) {
    this.timeOfDay = t;
    /* 雨・雪のまま昼・夕方になったら曇りの空が要る(夜は夜空だけなので読まない) */
    if (t !== 'night' && this.weather !== 'clear') this.ensureEnv('rain');
    /* 走行中に届いて待たせていた空は、ここ(運転開始・タイトルへ戻る暗転の中)で使いはじめる */
    if (this._lateN) this._promoteEnv(false);
    this._shadowDirty = true;
    this._applyWeather();
  }

  /* 路線(方向)が変わったときはワールドを作り直す。同じ路線なら信号(種別で変わる)だけ。
   * 作り直しは _worldSteps の手順を順に(ここでは一気に)。setWorldAsync は同じ手順を1コマずつ */
  setWorld(line, sim) {
    if (this._dead) return;   // 捨てたステージには もう作らない
    /* 少しずつ作っている途中(setWorldAsync)に呼ばれた: 同じ路線なら残りをここで一気に作ってから、ちがえば作りなおし */
    if (this._buildQ) {
      const q = this._buildQ;
      this._buildQ = null;
      this._worldGen++;   // 少しずつ作る側は ここで おしまい(続きは作らない)
      if (line === this._buildLine) { this._runSteps(q); this._endDeferHold(); }
      else this.line = null;
      this._buildLine = null;
      this._endBuildHold();
    }
    this.sim = sim;
    this._shadowDirty = true;
    if (this._lateN) this._promoteEnv(false);
    if (line === this.line && this.world.children.length) {
      this._sameLine(sim);
      return;
    }
    this._worldGen++;
    this._runSteps(this._worldSteps(line, sim));
    this._endDeferHold();
  }

  /* 同じ路線のまま運転だけ変わった(信号・ほかの列車・体感・目の慣れを合わせなおす) */
  _sameLine(sim) {
    this._buildSignals();
    if (this.traffic) this.traffic.reset(sim);
    this._installWeatherChunk();
    this._resetCamFeel();
    this._kInit = false;   // 新しい運転の最初のフレームで目の慣れを合わせ直す
    this._cullX = 1e9;
  }

  /* 手順の列を順に実行する。手順が配列を返したら(街の小分け _buildTownSteps)その場に差しこむ */
  _runSteps(q) {
    while (q.length) {
      const out = q.shift()();
      if (Array.isArray(out) && out.length) q.unshift(...out);
    }
  }

  /* ワールドの作り直しの手順(決まった順番。それぞれ引数なしの関数)。
   * 街(_buildTown)は、小分けの _buildTownSteps があればその手順に開く(なければ一気に) */
  _worldSteps(line, sim) {
    let cells = null;
    return [
      ...this._skySteps(),
      () => {
        this.sim = sim;
        this._disposeWorld();
        this.line = line;
        this.step = line.meta.step;
        this.frames = buildFrames(line);
        /* 喜多見の車両基地ゾーン(この右側には建物や木を生やさない) */
        const kitami = this.line.stations.find((st) => st.name === '喜多見');
        this.depotZone = kitami ? { a: kitami.s + 300, b: kitami.s + 640 } : null;
        /* 踏切の位置(郊外区間に6箇所。駅・川・トンネル・複々線・基地を避ける) */
        this.crossSpots = this._pickCrossings();
        this.terminal = this._terminalInfo();
      },
      () => this._buildTrack(),
      () => this._buildSleepers(),
      () => this._buildLineside(),
      () => this._buildStations(),
      () => { this._buildSignals(); this._buildBoards(); },
      () => {
        if (typeof this._buildTownSteps === 'function') {
          const a = this._buildTownSteps();
          if (Array.isArray(a)) return a;
        }
        this._buildTown();
        return null;
      },
      () => this._buildFences(),
      () => this._buildTrees(),
      () => { this._buildTunnel(); this._buildRiver(); this._buildStopBeam(); },
      () => this._buildLandmarks(),
      () => this._buildCrossings(),
      () => { this._buildStationHouses(); this._buildRailsideDetails(); },
      () => { this._buildPlatformFurniture(); this._buildPeople(); },
      () => this._buildCrowds(),
      () => {
        this._buildHills();
        /* 占有グリッドは街・木・丘を置くときだけ使う(十数MBあるので捨てる)。
         * これより前に捨てると occFree がどこでも「空き」と答え、線路や道路の上に木が生えるので、丘のあとで */
        this._occ = null;
      },
      () => { cells = this._splitInstances(); },
      () => {
        /* 帯の結合で増えたメッシュ(差分)も、遠ければ描かない対象にする */
        const pre = new Set(this.world.children);
        this._splitRibbons();
        this.world.children.forEach((o) => { if (!pre.has(o)) cells.push(o); });
        this._registerCells(cells);
        cells = null;
      },
      () => {
        this.traffic = new Traffic(this, sim);
        this._installWeatherChunk();
        this._resetCamFeel();
        this._kInit = false;
        this._applyWeather();
        /* 動かないものの行列を固める(毎フレームの行列計算をはぶく) */
        this._freezeStatic();
        this._worldNew = true;   // 新しいワールド: つぎの準備(prewarm)は省略しない
      },
    ];
  }

  /* ワールドを少しずつ作る(起動・のぼり/くだりの切替の暗転中。1手順ごとに1コマゆずる)。
   * 作り終わるまで描かない(_warming)。onProgress(0..1) で進み具合を知らせる。
   * 同じ路線なら setWorld と同じ軽い道ですぐ終わる */
  async setWorldAsync(line, sim, onProgress) {
    const prog = typeof onProgress === 'function' ? onProgress : null;
    /* 捨てたステージ(cancelAsync)には もう作らない */
    if (this._dead) { if (prog) prog(1); return; }
    if (!this._buildQ && line === this.line && this.world.children.length) {
      this.setWorld(line, sim);
      if (prog) prog(1);
      return;
    }
    /* もう同じ路線を作っている途中なら、そちらが終わるのを待つ */
    if (this._buildQ && line === this._buildLine && this._buildP) {
      await this._buildP;
      if (this._dead) return;
      if (this.sim !== sim) this.setWorld(line, sim);
      if (prog) prog(1);
      return;
    }
    const gen = ++this._worldGen;
    /* 「描かない」は作っている間ずっと1つだけ(前の作りかけを追いこしても数がずれない) */
    if (!this._buildHold) { this._buildHold = true; this._warming = (this._warming || 0) + 1; }
    this.sim = sim;
    this._shadowDirty = true;
    if (this._lateN) this._promoteEnv(false);
    const q = this._worldSteps(line, sim);
    this._buildQ = q;
    this._buildLine = line;
    let done = 0, last = 0;
    const run = async () => {
      try {
        while (q.length) {
          if (gen !== this._worldGen) return;   // あとから作り直し(setWorld)が来た
          const out = q.shift()();
          if (Array.isArray(out) && out.length) q.unshift(...out);
          done++;
          const k = Math.max(last, done / (done + q.length));
          last = k;
          if (prog) { try { prog(k); } catch (e) { /* noop */ } }
          /* 1コマゆずる。GPUの重い手順(空の環境光づくりなど)のあとは、GPUが終わるまで待つ
           * (待たずに進むと、あとの何かの「待ち合わせ」で まとめて止まる) */
          if (q.length) { await yieldFrame(); await this._gpuIdle(gen); }
        }
      } finally {
        if (gen === this._worldGen && this._buildQ === q) {
          this._buildQ = null;
          this._buildLine = null;
          this._endBuildHold();
          this._endDeferHold();
        }
      }
    };
    this._buildP = run();
    try { await this._buildP; } finally { if (this._buildQ === null) this._buildP = null; }
  }

  /* 少しずつ作るあいだの「描かない」を下ろす(1回だけ) */
  _endBuildHold() {
    if (!this._buildHold) return;
    this._buildHold = false;
    this._warming = Math.max(0, (this._warming || 0) - 1);
  }

  /* opts.deferWorld の「ワールドができるまで描かない」を下ろす(最初のワールドができたとき1回だけ) */
  _endDeferHold() {
    if (!this._deferHold) return;
    this._deferHold = false;
    this._warming = Math.max(0, (this._warming || 0) - 1);
  }

  /* このステージを捨てる前に(画質の作りなおし・文脈が消えたときの作りなおし。main.js の _rebuildScene)。
   * 少しずつ作っている途中のワールド(setWorldAsync)・シェーダの準備(prewarmAsync)・空(HDR)の仕上げを やめさせ、
   * 作ったワールドも手ばなす(新しいステージを作るあいだ、2つぶんの町を メモリに もたない)。2回 呼んでもよい */
  cancelAsync() {
    if (this._dead) return;
    this._dead = true;
    this._worldGen++;   // run()・_warmSliced・_gpuIdle は つぎの確認で ぬける
    this._buildQ = null;
    this._buildLine = null;
    this._buildHold = false;
    this._deferHold = false;
    this._warming = 0;   // 待っている側(_untilDrawable など)を 止めたままにしない
    try { this._disposeWorld(); } catch (e) { /* noop */ }
    this._town = null;
    this._occ = null;
    this.frames = null;   // もう描かない(render は frames がないと すぐ戻る)
  }

  /* 動くもの(作ったあとに位置・向き・大きさが変わる物)の目印 userData.dyn を、
   * 知っている物にも付けておく(作る側が付けわすれても止まらないように) */
  _markMovers() {
    const mark = (o) => { if (o && o.isObject3D) o.userData.dyn = true; };
    mark(this.stopBeam);
    mark(this.wheelSpin);
    const T = this._town;
    if (T) { mark(T.ringCity); mark(T.ringHills); mark(T.board); }
    const cr = this.crossings;
    if (cr) for (let i = 0; i < cr.length; i++) { const a = cr[i] && cr[i].arms; if (a) for (let k = 0; k < a.length; k++) mark(a[k]); }
    if (this.traffic && this.traffic.own) mark(this.traffic.own.group);
  }

  /* 動かないものの行列を固める: ワールドの子のうち、中に userData.dyn の物が1つもないものは
   * いまの行列を計算してから、毎フレームの更新(matrixAutoUpdate / matrixWorldAutoUpdate)を止める。
   * ?debug=1 のときは 固めた物が動いていないかを ときどき確かめる(_freezeCheck) */
  _freezeStatic() {
    this._markMovers();
    const w = this.world;
    w.updateMatrix();
    w.updateMatrixWorld(true);
    const frozen = [];
    let dynRoots = 0;
    for (let i = 0; i < w.children.length; i++) {
      const c = w.children[i];
      let dyn = false;
      c.traverse((o) => { if (o.userData && o.userData.dyn) dyn = true; });
      if (dyn) { dynRoots++; continue; }
      c.updateMatrixWorld(true);
      c.traverse((o) => { o.matrixAutoUpdate = false; });
      c.matrixWorldAutoUpdate = false;
      frozen.push(c);
    }
    this._frozen = frozen;
    let nObj = 0;
    for (let i = 0; i < frozen.length; i++) frozen[i].traverse(() => { nObj++; });
    this._frzStat = { frozen: frozen.length, dyn: dynRoots, objects: nObj };
    this._frzSnap = null;
    if (this._debug) this._freezeSnap();
  }

  /* (debug) 固めた物の位置・向き・大きさを覚える */
  _freezeSnap() {
    const objs = [];
    for (let i = 0; i < this._frozen.length; i++) this._frozen[i].traverse((o) => { objs.push(o); });
    const v = new Float64Array(objs.length * 10);
    for (let i = 0; i < objs.length; i++) {
      const o = objs[i], b = i * 10;
      v[b] = o.position.x; v[b + 1] = o.position.y; v[b + 2] = o.position.z;
      v[b + 3] = o.quaternion.x; v[b + 4] = o.quaternion.y; v[b + 5] = o.quaternion.z; v[b + 6] = o.quaternion.w;
      v[b + 7] = o.scale.x; v[b + 8] = o.scale.y; v[b + 9] = o.scale.z;
    }
    this._frzSnap = { objs, v, warned: new Set(), n: objs.length };
  }

  /* (debug) 120フレームごと: 固めた物が動いていたら console.warn(名前か、ワールドからの道すじ) */
  _freezeCheck() {
    const S = this._frzSnap;
    if (!S) return;
    const { objs, v } = S;
    /* 固めたグループに あとから子が足された(その子は行列が更新されない) */
    let n = 0;
    for (let i = 0; i < this._frozen.length; i++) this._frozen[i].traverse(() => { n++; });
    if (n !== S.n && !S.warnedAdd) {
      S.warnedAdd = true;
      console.warn('[freeze] frozen group changed: ' + S.n + ' -> ' + n + ' objects (あとから足す物は world 直下か userData.dyn の中へ)');
    }
    for (let i = 0; i < objs.length; i++) {
      const o = objs[i], b = i * 10;
      if (v[b] === o.position.x && v[b + 1] === o.position.y && v[b + 2] === o.position.z &&
        v[b + 3] === o.quaternion.x && v[b + 4] === o.quaternion.y && v[b + 5] === o.quaternion.z && v[b + 6] === o.quaternion.w &&
        v[b + 7] === o.scale.x && v[b + 8] === o.scale.y && v[b + 9] === o.scale.z) continue;
      if (S.warned.has(o)) continue;
      S.warned.add(o);
      let path = '', p = o;
      while (p && p !== this.world && p !== this.scene) {
        const idx = p.parent ? p.parent.children.indexOf(p) : -1;
        path = (p.name ? p.name : p.type + '[' + idx + ']') + (path ? '/' + path : '');
        p = p.parent;
      }
      console.warn('[freeze] frozen object moved: world/' + path + ' (userData.dyn = true を付けてください)');
    }
  }

  /* 帯(ribbon など行のある形)を、全線共通の区切り(5m×150行=750m)で切り、
   * 同じ材質・同じ影の設定のものを区切りごとに1つのメッシュへまとめる。
   * 画面に入る区切りだけが描かれ、しかも材質ごとに1回の描画で済む(描画コールが大きく減る)。
   * 参照を持ち続ける帯には userData.noMerge を付けておくこと */
  _splitRibbons() {
    this._mergeStat = mergeRibbons(this.world, 150);
  }

  /* 戻り値: 作ったセル(InstancedMesh)の一覧。遠いと描かない対象(_registerCells)にする */
  _splitInstances() {
    const CELL = 700;
    const m4 = new THREE.Matrix4(), p = new THREE.Vector3(), col = new THREE.Color();
    const targets = [], made = [];
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
        c.userData.cullCell = true;   // 遠いと描かない(visible はこちらで決める。切りかえたいときは material.visible で)
        c.computeBoundingSphere();
        g.add(c);
        made.push(c);
      });
      g.visible = im.visible;
      this.world.remove(im);
      im.dispose();
      this.world.add(g);
      if (this.stationLamps === im) this.stationLamps = g;
    });
    return made;
  }

  /* 形はすぐ捨てる。材質(とそのテクスチャ)は _staleMats に入れておき、新しいワールドの準備(prewarm)の
   * あとで捨てる。同じ種類のシェーダが一度0本になって作り直される(リンクしなおし)のを防ぐ */
  _disposeWorld() {
    const keep = this._keep;
    const geos = new Set(), mats = new Set(), texs = new Set();
    this._cellReg = [];
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
      this._staleMats.push(m);
    });
    geos.forEach((g) => g.dispose());
    texs.forEach((t) => this._staleTex.push(t));
    this.world.clear();
    this._frozen = [];
    this._frzSnap = null;
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

  /* ---------- 描画の道(中・高はいつもブルーム用の描画先→出力パス。低は直接描く) ----------
   * 道を1本にすると、材質ごとのシェーダも1組で済む(直接描く版とブルーム版の2組を作らない)。
   * ブルームは要るときだけ bloom.enabled で通す(_bloomOn)。切りかえてもシェーダは変わらない */
  _initPost() {
    const Q = QUALITY[this.quality];
    this.composer = null;
    this.bloom = null;
    if (!Q.bloom) return;
    try {
      const gl = this.renderer.getContext();
      const isGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
      const rt = new THREE.WebGLRenderTarget(8, 8, { type: THREE.HalfFloatType, samples: isGL2 ? Q.samples : 0 });
      const comp = new EffectComposer(this.renderer, rt);
      comp.addPass(new RenderPass(this.scene, this.camera));
      const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.55, 0.82);
      /* 中: にじみの計算は1/4の解像度で(最後の重ね合わせは元の解像度のまま)。
       * 1/4 にすると いちばん粗い段が画面ぜんたいに広がって明るくなりすぎる(ターミナルで平均+7)ので、
       * 各段の重みを0.74倍にして 1/2 のときの明るさにそろえる(ターミナル・夜とも平均の差0.1以内で実測)。
       * 自動画質で重いとき(bloomShift 2)は 1/8 の解像度(シェーダは同じ。_reapplySize で大きさだけ変わる) */
      const ss = bloom.setSize.bind(bloom);
      bloom.setSize = (w, h) => {
        const sh = this._perf ? this._perf.bloomShift : 0;
        ss(Math.max(1, w >> sh), Math.max(1, h >> sh));
      };
      this._bloomTinted = false;
      if (this._perf && this._perf.bloomShift > 0) { bloom.bloomTintColors.forEach((c) => c.multiplyScalar(0.74)); this._bloomTinted = true; }
      comp.addPass(bloom);
      comp.addPass(new OutputPass());
      bloom.enabled = false;
      this.composer = comp;
      this.bloom = bloom;
      if (this._w) this.composer.setSize(this._w, this._h);
    } catch (e) {
      this.composer = null;
      this.bloom = null;
    }
    this._needPrewarm = true;
  }

  /* ブルーム用の描画先を通して描くか(中・高はいつも。霧の色の選び方もこれで決まる) */
  _usePost() {
    return !!this.composer;
  }

  /* ブルームを効かせるか(夜・夕方・雨雪・トンネルやターミナルの中)。メニューの背景では止める。
   * _kE は目の慣れ(露出)の値(なければ 1) */
  _bloomOn() {
    const kk = Math.min(this._k, this._kE != null ? this._kE : 1);
    return this._perf.bloom !== false && !this._backdrop && (kk < 0.95 || this.timeOfDay !== 'day' || this.weather !== 'clear');
  }

  /* 使うシェーダを走り出す前に全部コンパイルしておく(走行中のカクつき防止)。
   * 中・高はブルーム用の描画先に描く版だけ(直接描く版は作らない)。低は直接描く版。
   * 背景(HDRの箱)とブルームの各パスはシーンの外にあって compile() では作られないので、実際に1回描いて作らせる。
   * placed: 呼び出し元(render)がもう今の運転の位置にカメラを置いた */
  prewarm(placed) {
    this._needPrewarm = false;
    this._worldNew = false;
    this._booted = true;
    const r = this.renderer;
    if (!r || !this.scene) return;
    if (placed !== true) this._placeView();
    const rt0 = r.getRenderTarget();
    try {
      r.setRenderTarget(this.composer ? this.composer.renderTarget1 : null);
      this._compileMain(false);
      this._prewarmTail();
    } catch (e) { /* 失敗しても描画時にコンパイルされるだけ */ }
    r.setRenderTarget(rt0);
    this._flushStale();
    this._warmDone = { sig: this._warmSig(), gen: this._worldGen };
  }

  /* 運転台を別に重ね描きする(renderOverlay がある)ときは、その部品をシーン本体のコンパイルから外す
   * (ブルーム用の描画先の版を作っても使わないため)。戻り値は compileAsync の Promise か null */
  _compileMain(async) {
    const r = this.renderer, ck = this.cockpit;
    const ovl = ck && typeof ck.renderOverlay === 'function' && ck.scene && ck.scene.isScene && ck.root ? ck : null;
    let par = null;
    if (ovl && ovl.root.parent && ovl.root.parent !== ovl.scene) { par = ovl.root.parent; par.remove(ovl.root); }
    /* いま使っていない夕焼け・夜空の箱と ほかの天気の粒は作らない(分けて作る準備 _warmReps と同じ決まり。
     * 時間帯・天気を変えると かならず準備しなおすので、そのときに作る)。
     * シーンから外さずに、それらをとばして たどる入れ物を渡す(光はシーンの側から集める) */
    const sc = this.scene, skip = this._warmSkipTop();
    const root = !skip.size ? sc : {
      traverse: (cb) => { cb(sc); const ch = sc.children; for (let i = 0; i < ch.length; i++) if (!skip.has(ch[i])) ch[i].traverse(cb); },
      traverseVisible: () => { /* 光はシーンの側から集める */ },
    };
    try {
      if (async && typeof r.compileAsync === 'function') return r.compileAsync(root, this.camera, sc);
      r.compile(root, this.camera, sc);
      return null;
    } finally {
      if (par) par.add(ovl.root);
    }
  }

  /* 準備(シェーダを作る)で とばす、本体のシーンの直下の物: いま見えていない夕焼け・夜空の箱と、
   * いまの天気ではない雨・雪の粒。ほかの物(見えていない物も)は ぜんぶ準備する
   * (トンネルで かくれている いまの天気の粒・あとから足される物が 走っている途中で作られないように) */
  _warmSkipTop() {
    const skip = new Set();
    if (this.eveSky && !this.eveSky.visible) skip.add(this.eveSky);
    if (this.nightSky && !this.nightSky.visible) skip.add(this.nightSky);
    const fx = this.weatherFx;
    if (fx) {
      if (fx.rain && fx.mode !== 'rain') skip.add(fx.rain);
      if (fx.snow && fx.mode !== 'snow') skip.add(fx.snow);
    }
    return skip;
  }

  /* シェーダの種類に かかわる見え方の目印(時間帯・天気・環境光と背景の形式・ぬれの部品を付けた材質の数)。
   * 準備のあいだに晴れの空が届いて差しかわっても、これが同じなら シェーダは同じ(準備しなおさない) */
  _warmSig() {
    const sc = this.scene;
    const t = (x) => (!x ? '-' : x.isColor ? 'c' : x.isTexture ? x.mapping + ':' + (x.image && x.image.height ? x.image.height : 0) + (x.isCubeTexture ? 'C' : 'T') : '?');
    return this.timeOfDay + '|' + this.weather + '|' + t(sc.environment) + '|' + t(sc.background) + '|' +
      (this._envMats ? this._envMats.size : 0);
  }

  /* 運転開始・起動・タイトルへ戻るときの暗転中に使う版。ほかの処理(画面の しゅっぱつカード・路線の帯)を止めない。
   * ・並行コンパイル(KHR_parallel_shader_compile)がある: compileAsync で完成を待つ
   * ・ない(iPadのSafari・ソフト描画): 材質ごとに「作る→リンクを待つ→1回描く」を 12ms ずつに分けて、
   *   あいだで ほかのタスクに ゆずる(_warmSliced)。描くところまでしないと、GPU側の準備が最初のコマに残る
   * ワールドも見え方も変わっていなければ(_needPrewarm も _worldNew もない)カメラを置くだけで すぐ終わる。
   * onProgress(0..1) で進み具合を知らせる。完成を待っている間に届いた描画(render)は描かずに戻る。
   * 先に はじまった準備(タイトルへ戻る暗転の中など)が まだ描画を止めていれば、それが終わるまで返さない
   * (返すと 呼んだ側が暗転を明けて、絵が止まったまま運転が はじまる)。
   * maxMs: 空まちも ふくめた 全体の時間の めやす(呼ぶ側の 10秒の保険より 前に終わる)。
   *   分けて準備しているうちに こえたら、のこりは 仕上げで いっきに作る(暗転の中。ふつうの prewarm と同じ) */
  async prewarmAsync(onProgress, maxMs) {
    const prog = typeof onProgress === 'function' ? onProgress : null;
    const tell = (k) => { if (prog) { try { prog(k); } catch (e) { /* noop */ } } };
    const r = this.renderer;
    if (!r || !this.scene || this.glLost || this._dead) { tell(1); return; }
    const deadline = performance.now() + (maxMs > 0 ? maxMs : 8500);
    if (!this._needPrewarm && !this._worldNew && this._booted && !this._lateN) {
      this._placeView();
      /* 準備は いらないが、先に はじまった準備が まだ続いていれば 描けるようになるまで待つ */
      if (this._warming) await this._untilDrawable(15000);
      tell(1);
      return;
    }
    this._needPrewarm = false;
    this._booted = true;
    /* 空を待つ間も描かない(_needPrewarm を下ろしたまま描くと、新しいワールドのシェーダをそのコマで全部作って止まる) */
    this._warming = (this._warming || 0) + 1;   // 数で持つ(2回重ねて呼ばれても、先に終わった側が描画を再開しない)
    const cap = (ms) => new Promise((res) => setTimeout(res, ms));
    let env0 = null, sliced = false, cut = false;
    const gen = this._worldGen;
    try {
      /* 使う空(HDR)を読みこみ中なら、少しだけ待ってから(あとで差しかえると全部コンパイルしなおしになる)。
       * どの空を使うかは _applyAtmosphere と同じ決め方: 夜は夜空・晴れの夕方は夕焼けの空(どちらも待つ物がない) */
      const tod = this.timeOfDay, wet = this.weather !== 'clear';
      const wk = tod === 'night' ? null : wet ? 'rain' : tod === 'evening' ? null : 'clear';
      const ld = wk ? this._envLoad[wk] : null;
      if (ld && !this._envLate[wk] && !(this.env[wk] && !this.env[wk].placeholder)) {
        await Promise.race([ld, cap(3000)]);
        if (this._dead) return;   // 待つあいだに捨てられた(cancelAsync)
      }
      if (this._lateN) this._promoteEnv(true);
      this._needPrewarm = false;
      /* シェーダの完成を待つ間に空が届いて差しかわったら、仕上げの準備(_needPrewarm)を消さない */
      env0 = this.scene.environment;
      this._placeView();
      const ex = r.extensions;
      const par = !!(ex && typeof ex.has === 'function' && ex.has('KHR_parallel_shader_compile'));
      if (par) {
        const prev = r.getRenderTarget();
        let p = null;
        try {
          r.setRenderTarget(this.composer ? this.composer.renderTarget1 : null);
          p = this._compileMain(true);
        } catch (e) { p = null; }
        r.setRenderTarget(prev);
        /* 完成の知らせが来ない(文脈を失ったなど)ときも6秒(全体の めやすの のこり)で先へ(描かないまま止まらないように)。
         * まだのものは 仕上げの1回の描画で そろう */
        const left = Math.max(1000, Math.min(6000, deadline - performance.now()));
        if (p) { try { await Promise.race([p, cap(left)]); } catch (e) { /* 描画時にコンパイルされるだけ */ } }
      } else {
        sliced = true;
        const sig0 = this._warmSig();
        cut = await this._warmSliced(gen, tell, deadline);
        /* 準備のあいだに 晴れの空(HDR)が届いて差しかわるなどで _needPrewarm がまた立った:
         * 見え方の目印(_warmSig)が同じなら シェーダは同じなので そのまま下ろす。ちがえば もう1回だけ分けて準備する
         * (立てたままにすると、つぎの render が いっきに準備して止まる) */
        if (this._needPrewarm && gen === this._worldGen && !this.glLost) {
          this._needPrewarm = false;
          if (this._warmSig() !== sig0) {
            /* 時間切れなら 分けずに 仕上げで いっきに */
            if (performance.now() < deadline) {
              this._placeView();
              cut = await this._warmSliced(gen, tell, deadline);
            } else {
              cut = true;
            }
          }
          env0 = this.scene.environment;
        }
      }
    } finally {
      this._warming = Math.max(0, (this._warming || 0) - 1);
    }
    /* ほかの準備(先に はじまった prewarmAsync・少しずつ作るワールド)がまだ続いている: 仕上げは そちらで。
     * ここは 描けるようになるまで待ってから返す(すぐ返すと、呼んだ側が 描けないまま 暗転を明ける) */
    if (this._warming) { await this._untilDrawable(15000); return; }
    if (this.glLost || this._dead) return;
    const rt0 = r.getRenderTarget();
    try {
      this._placeView();   // 待っている間に動いたかもしれないので置きなおす
      if (sliced && !cut) {
        /* 分けて作ったときは、仕上げ(にじみ・影)も もう作ってある。のこりの確認に1回描くだけ */
        this._prewarmFinal();
      } else {
        /* 時間切れ(cut)なら、のこりを ここで いっきに作る(ふつうの prewarm と同じ。まだ暗転の中) */
        if (cut) { r.setRenderTarget(this.composer ? this.composer.renderTarget1 : null); this._compileMain(false); }
        this._prewarmTail();
      }
    } catch (e) { /* noop */ }
    r.setRenderTarget(rt0);
    this._flushStale();
    if (this.scene.environment === env0) this._needPrewarm = false;
    if (gen === this._worldGen) {
      this._worldNew = false;
      /* 準備が そろったときの見え方の目印(render が 同じ見え方で いっきに準備しなおさないように) */
      if (!this._needPrewarm) this._warmDone = { sig: this._warmSig(), gen };
    }
    tell(1);
    try { this.render(0); } catch (e) { /* noop */ }
    /* 仕上げの絵をGPUが描き終えるまで待ってから返す(呼び出し側が暗転を明けたときに絵ができている。
     * 待たずに進むと、つぎの何かの「待ち合わせ」で止まる) */
    await this._gpuIdle(gen);
  }

  /* 分けて準備する(並行コンパイルがないとき)。準備するもの:
   * A 本体のシーン: 材質ごと(と 物の種類・形の並びごと)の代表を1つずつ
   * B 運転台の重ね描き: 同じように1つずつ
   * C にじみ(ブルーム)と出力のパス: 1つずつ、本番と同じ描画先へ
   * D 影の深度: 影を落とす種類ごとに1つずつ影の地図へ
   * 1回分(12ms まで・新しいシェーダ2本まで・8個まで)ごとに:
   *   1) シェーダを作る命令だけ出す(compile。待たない)
   *   2) GPU側が終わるのを待つ(フェンスを ほかのタスクの合間に のぞく。待つあいだ画面は止まらない)
   *   3) 三角形1つだけ本番と同じ描画先・同じ光の数で描く(リンク結果の読みとりとGPUの描画の準備)
   *   4) もう一度 GPU側を待つ
   * フェンスがない(WebGL1)ときは 3) で1つずつ待つことになるが、1回分が小さいので長くは止まらない。
   * ワールドが作り直されたら(gen)・文脈が消えたら やめる。
   * deadline(performance.now() の時刻)を こえたら やめて true を返す(のこりは 呼んだ側の仕上げで いっきに) */
  async _warmSliced(gen, tell, deadline) {
    const until = deadline > 0 ? deadline : Infinity;
    const r = this.renderer;
    const gl = r.getContext();
    const fences = !!(gl && typeof gl.fenceSync === 'function');
    const ck = this.cockpit;
    const ovl = ck && typeof ck.renderOverlay === 'function' && ck.scene && ck.scene.isScene && ck.root ? ck : null;
    const mainRT = this.composer ? this.composer.renderTarget1 : null;
    const items = [];
    this._warmReps(this.scene, ovl ? ovl.root : null).forEach((o) => items.push({ k: 'A', o }));
    if (ovl) this._warmReps(ovl.scene, null).forEach((o) => items.push({ k: 'B', o }));
    this._warmPostSteps().forEach((p) => items.push({ k: 'C', p }));
    this._warmShadowReps().forEach((o) => items.push({ k: 'D', o }));
    const total = items.length + 1;
    /* 全体の状態を一時的に: カメラは WARM_LAYER だけを見る(光も同じレイヤーに入れて、光の数を本番と同じに) */
    const cam = this.camera;
    const camMask = cam.layers.mask;
    const lights = [];
    const addLights = (sc) => sc.traverse((o) => { if (o.isLight) lights.push([o, o.layers.mask]); });
    addLights(this.scene);
    if (ovl) addLights(ovl.scene);
    const sm = r.shadowMap;
    /* 背景は 1回分ごとに覚えて もどす(最初に覚えた物に もどすと、あいだに届いて差しかわった空(HDR)を
     * 古い空(捨てた代わりの青空・雨の灰色)に もどしてしまう) */
    const st = { ac: true, smAuto: false, smNeed: false, rt: null, bg: null };
    const set = () => {
      st.ac = r.autoClear; st.smAuto = sm.autoUpdate; st.smNeed = sm.needsUpdate; st.rt = r.getRenderTarget();
      st.bg = this.scene.background;
      cam.layers.set(WARM_LAYER);
      for (let i = 0; i < lights.length; i++) lights[i][0].layers.enable(WARM_LAYER);
      r.autoClear = false;
      sm.autoUpdate = false; sm.needsUpdate = false;
    };
    const unset = () => {
      cam.layers.mask = camMask;
      for (let i = 0; i < lights.length; i++) lights[i][0].layers.mask = lights[i][1];
      this.scene.background = st.bg;
      r.autoClear = st.ac;
      sm.autoUpdate = st.smAuto; sm.needsUpdate = st.smNeed;
      r.setRenderTarget(st.rt);
    };
    /* 1つ分の「作る命令だけ」(待たない): compile に その1つだけを渡す */
    const one = { o: null };
    const fake = { traverse: (cb) => { cb(one.o); }, traverseVisible: () => { /* 光はシーンの側から集める */ } };
    const compileItem = (it) => {
      if (it.k === 'A') { one.o = it.o; r.setRenderTarget(mainRT); r.compile(fake, cam, this.scene); }
      else if (it.k === 'B') { one.o = it.o; r.setRenderTarget(null); r.compile(fake, cam, ovl.scene); }
      else if (it.k === 'C' && it.p.compile) it.p.compile();
    };
    let bgDone = false;
    const drawItem = (it) => {
      if (it.k === 'A') {
        this._warmOne(it.o, () => {
          /* 背景(空の箱)は最初の1回だけ描く(あとは毎回の全画面ぶんが むだ) */
          if (bgDone) this.scene.background = null;
          r.setRenderTarget(mainRT);
          r.render(this.scene, cam);
          bgDone = true;
        }, false);
      } else if (it.k === 'B') {
        this._warmOne(it.o, () => { r.setRenderTarget(null); r.render(ovl.scene, cam); }, false);
      } else if (it.k === 'C') {
        it.p.draw();
      } else {
        /* 影の深度: ふつうの描画(render)の中で影の地図を描かせる(render の外で shadowMap.render を呼ぶと
         * 光の状態がなくて何も作られない)。カメラは WARM_LAYER だけなので、影も本体も その1つだけ */
        this._warmOne(it.o, () => {
          this.scene.background = null;
          r.setRenderTarget(mainRT);
          r.render(this.scene, cam);
        }, true);
      }
    };
    const prog = () => (r.info.programs ? r.info.programs.length : 0);
    let i = 0, waits = 0, longest = 0, cut = false;
    while (i < items.length) {
      if (gen !== this._worldGen || this.glLost) break;
      if (performance.now() > until) { cut = true; break; }
      const t = performance.now(), p0 = prog(), i0 = i;
      set();
      try {
        while (i < items.length && i - i0 < 8 && performance.now() - t < WARM_SLICE_MS && prog() - p0 < 2) {
          try { compileItem(items[i]); } catch (e) { /* その1つは描くときに作られるだけ */ }
          i++;
        }
      } finally { unset(); }
      longest = Math.max(longest, performance.now() - t);
      if (fences && prog() > p0) { await this._gpuIdle(gen, until); waits++; }
      if (gen !== this._worldGen || this.glLost) break;
      const t2 = performance.now();
      set();
      try {
        for (let k = i0; k < i; k++) { try { drawItem(items[k]); } catch (e) { /* noop */ } }
      } finally { unset(); }
      longest = Math.max(longest, performance.now() - t2);
      if (fences) { await this._gpuIdle(gen, until); waits++; } else await yieldTask(0);
      tell(Math.min(0.99, i / total));
    }
    this._shadowDirty = true;
    if (this._debug) {
      const c = { A: 0, B: 0, C: 0, D: 0 };
      items.forEach((it) => { c[it.k]++; });
      console.log('[p6] warm sliced: main ' + c.A + ' / overlay ' + c.B + ' / post ' + c.C + ' / shadow ' + c.D +
        ' / programs ' + prog() + ' / gpu waits ' + waits + ' / longest slice ' + Math.round(longest) + 'ms' +
        (cut ? ' / time up at ' + i + '/' + items.length : ''));
    }
    return cut;
  }

  /* GPU側(シェーダのリンク・描画の準備)が いま出した命令まで終わるのを待つ。
   * フェンスの状態は ほかのタスクの合間に のぞくだけなので、待つあいだ画面(しゅっぱつカードなど)は止まらない。
   * 30秒・deadline(performance.now() の時刻。なければ なし)・ワールドの作り直し・文脈が消えたら 待つのをやめる */
  async _gpuIdle(gen, deadline) {
    const gl = this.renderer.getContext();
    let sync = null;
    try { sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); gl.flush(); } catch (e) { sync = null; }
    if (!sync) { await yieldTask(0); return; }
    const t0 = performance.now();
    try {
      for (let n = 0; ; n++) {
        await yieldTask(n < 2 ? 0 : 6);
        if (gen !== this._worldGen || this.glLost || gl.isContextLost()) break;
        if (gl.getSyncParameter(sync, gl.SYNC_STATUS) === gl.SIGNALED) break;
        if (performance.now() - t0 > 30000 || (deadline > 0 && performance.now() > deadline)) break;
      }
    } catch (e) { /* noop */ } finally {
      try { gl.deleteSync(sync); } catch (e) { /* noop */ }
    }
  }

  /* ほかの準備(先に はじまった prewarmAsync・少しずつ作るワールド)が終わって 描けるようになる(_warming が 0)まで待つ。
   * 文脈が消えた・捨てたステージ・maxMs を こえたら やめる */
  async _untilDrawable(maxMs) {
    const t0 = performance.now();
    while (this._warming && !this.glLost && !this._dead && performance.now() - t0 < maxMs) await yieldTask(16);
  }

  /* 準備で描く代表(材質・物の種類・形の並びが同じなら1つだけ)。ワールドの中の見えていない物
   * (遠いセル・トンネルで点く灯りなど。走っているうちに見えてくる)も入れる。
   * 本体のシーンの直下の、いま使っていない夕焼け・夜空の箱と ほかの天気の粒(_warmSkipTop)は入れない:
   * 時間帯・天気が変わるときは必ず準備しなおすので、そのときに作る(いま作ると重いシェーダのぶん待たされる)。
   * ほかの物は見えていなくても入れる(トンネル・屋内で かくれている いまの天気の粒は、外に出たとたんに見える)。
   * 運転台の重ね描きのシーン(root が本体のシーンでない)も、見えていなくても全部入れる
   * (タイトルのデモは外の視点から始まり、とちゅうで運転台の視点に切りかわる。そこで作ると止まる)。
   * skip(運転台の重ね描きの根)の中は入れない */
  _warmReps(root, skip) {
    const reps = [], seen = new Set();
    const top = root === this.scene;
    const skipTop = top ? this._warmSkipTop() : null;
    const walk = (o) => {
      if (o === skip) return;
      if (skipTop && o.parent === root && skipTop.has(o)) return;
      if ((o.isMesh || o.isLine || o.isPoints || o.isSprite) && o.material && o.geometry) {
        const g = o.geometry;
        let gk = '';
        const A = g.attributes;
        for (const k in A) {
          const a = A[k];
          gk += k + a.itemSize + (a.normalized ? 'n' : '') + (a.isInterleavedBufferAttribute ? 'i' : '') + (a.array ? a.array.BYTES_PER_ELEMENT : 0) + ',';
        }
        if (g.morphAttributes && Object.keys(g.morphAttributes).length) gk += 'm';
        if (g.index) gk += 'x' + g.index.array.BYTES_PER_ELEMENT;
        if (g.isInstancedBufferGeometry) gk += 'I';
        const kind = (o.isInstancedMesh ? (o.instanceColor ? 'IC' : 'I') : '') + (o.isSkinnedMesh ? 'S' : '') +
          (o.isPoints ? 'P' : o.isLineSegments ? 'LS' : o.isLine ? 'L' : o.isSprite ? 'Sp' : 'M');
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        let mk = '';
        for (let i = 0; i < mats.length; i++) mk += (mats[i] ? mats[i].id : 0) + ';';
        const key = mk + '|' + kind + '|' + gk;
        if (!seen.has(key)) { seen.add(key); reps.push(o); }
      }
      const ch = o.children;
      for (let i = 0; i < ch.length; i++) walk(ch[i]);
    };
    walk(root);
    return reps;
  }

  /* 代表を1つだけ描く(または影の地図へ)。見えるようにして、カメラの外でも描き、形は三角形1つに。終わったら全部もどす */
  _warmOne(o, draw, shadow) {
    const saved = [];
    let p = o;
    while (p) { if (!p.visible) { saved.push(p); p.visible = true; } p = p.parent; }
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const mv = [];
    for (let i = 0; i < mats.length; i++) if (mats[i] && mats[i].visible === false) { mv.push(mats[i]); mats[i].visible = true; }
    const g = o.geometry;
    const dr0 = g.drawRange.start, dr1 = g.drawRange.count;
    g.setDrawRange(0, o.isPoints ? 1 : o.isLine ? 2 : 3);
    const ic0 = g.isInstancedBufferGeometry ? g.instanceCount : null;
    if (ic0 !== null) g.instanceCount = 1;
    const cnt0 = o.isInstancedMesh ? o.count : null;
    if (cnt0 !== null && o.instanceMatrix && o.instanceMatrix.count > 0) o.count = 1;
    const lm = o.layers.mask, fc = o.frustumCulled, cs = o.castShadow;
    o.layers.enable(WARM_LAYER);
    o.frustumCulled = false;
    const own = Object.prototype.hasOwnProperty.call(o, 'onBeforeShadow');
    const obs = o.onBeforeShadow;
    try {
      if (shadow) {
        /* 影: 共有の深度材質は map/side などが変わっても選びなおさないので needsUpdate で選びなおさせる */
        o.castShadow = true;
        o.onBeforeShadow = function (rr, ob, cm, sc, geo, dm, grp) { dm.needsUpdate = true; obs.call(this, rr, ob, cm, sc, geo, dm, grp); };
        const sm = this.renderer.shadowMap;
        sm.needsUpdate = true;
        if (draw) draw();
        sm.needsUpdate = false;
      } else if (draw) {
        draw();
      }
    } finally {
      if (shadow) { o.castShadow = cs; if (own) o.onBeforeShadow = obs; else delete o.onBeforeShadow; }
      o.layers.mask = lm;
      o.frustumCulled = fc;
      if (cnt0 !== null) o.count = cnt0;
      if (ic0 !== null) g.instanceCount = ic0;
      g.setDrawRange(dr0, dr1);
      for (let i = 0; i < mv.length; i++) mv[i].visible = false;
      for (let i = 0; i < saved.length; i++) saved[i].visible = false;
    }
  }

  /* 影の深度の代表(_prewarmShadows と同じ見分け方)。影の地図がないとき(低・影なし)は空 */
  _warmShadowReps() {
    const r = this.renderer;
    if (!r.shadowMap.enabled || !this.sun || !this.sun.castShadow || typeof r.shadowMap.render !== 'function') return [];
    const lod = new Map(((this._town && this._town.treeCells) || []).map((c) => [c.mesh, c.shadow]));
    /* 遠いあいだ影を落とさないセル(登録の cs0 = もともと影を落とす)も、近づくと落とすので数に入れる */
    const cs0 = new Set();
    const reg = this._cellReg || [];
    for (let i = 0; i < reg.length; i++) if (reg[i].cs0) cs0.add(reg[i].obj);
    const reps = new Map();
    this.world.traverse((o) => {
      if (!o.isMesh || !(o.castShadow || lod.get(o) || cs0.has(o))) return;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      if (!m) return;
      const k = [o.isInstancedMesh, !!o.instanceColor, o.customDepthMaterial ? o.customDepthMaterial.uuid : '',
        !!m.map, !!m.alphaMap, m.alphaTest > 0 ? m.uuid : '', m.shadowSide == null ? m.side : m.shadowSide].join('|');
      if (!reps.has(k)) reps.set(k, o);
    });
    return [...reps.values()];
  }

  /* にじみ(ブルーム)と出力のパスを1つずつ、本番と同じ描画先へ描く手順(中・高)。{compile, draw} の並び。
   * 中身(材質の名前)が想定とちがうときは何もしない(仕上げの1回の描画で作られる) */
  _warmPostSteps() {
    const r = this.renderer, C = this.composer, B = this.bloom;
    const steps = [];
    if (!C) return steps;
    const quad = (q, mat, rt) => {
      if (!q || !mat || !rt) return;
      const use = (fn) => { const m0 = q.material; q.material = mat; try { r.setRenderTarget(rt); fn(); } finally { q.material = m0; } };
      steps.push({
        compile: q._mesh && q._mesh.isMesh ? () => use(() => r.compile(q._mesh, this.camera)) : null,
        draw: () => use(() => q.render(r)),
      });
    };
    if (B && B.fsQuad && typeof B.fsQuad.render === 'function') {
      const H = B.renderTargetsHorizontal || [];
      quad(B.fsQuad, B.materialHighPassFilter, B.renderTargetBright);
      (B.separableBlurMaterials || []).forEach((m, i) => quad(B.fsQuad, m, H[i] || B.renderTargetBright));
      quad(B.fsQuad, B.compositeMaterial, H[0]);
      quad(B.fsQuad, B.blendMaterial, C.renderTarget1);
    }
    /* 出力パス(トーンマップ・色空間)は画面へ(最後のパスなので本番は renderToScreen) */
    const passes = C.passes || [];
    for (let i = 0; i < passes.length; i++) {
      const ps = passes[i];
      if (ps instanceof OutputPass) {
        steps.push({
          compile: null,
          draw: () => {
            const ts = ps.renderToScreen;
            ps.renderToScreen = true;
            try { ps.render(r, C.renderTarget2, C.renderTarget1, 0, false); } finally { ps.renderToScreen = ts; }
          },
        });
      }
    }
    return steps;
  }

  /* 分けて準備したあとの仕上げ: 1回ふつうに描いて(にじみも通す)のこりがないか確かめる */
  _prewarmFinal() {
    const r = this.renderer;
    if (this.composer) {
      const be = this.bloom ? this.bloom.enabled : false;
      if (this.bloom) this.bloom.enabled = true;
      try { this.composer.render(0); } finally { if (this.bloom) this.bloom.enabled = be; }
    } else {
      r.setRenderTarget(null);
      r.render(this.scene, this.camera);
    }
    const ck = this.cockpit;
    if (ck && typeof ck.renderOverlay === 'function' && ck.root && ck.root.visible) ck.renderOverlay(r, this.camera);
    this._shadowDirty = true;
  }

  /* prewarm の後半(同期): 運転台の重ね描き・背景とブルーム各パス・影の深度シェーダ */
  _prewarmTail() {
    const r = this.renderer;
    /* 運転台の重ね描き(キャンバスへ直接描く)の材質。まだカメラの子のままでも、重ね描き用の版を作る */
    const ck = this.cockpit;
    if (ck && ck.scene && ck.scene.isScene) {
      r.setRenderTarget(null);
      r.compile(ck.root && typeof ck.renderOverlay === 'function' ? ck.root : ck.scene, this.camera, ck.scene);
    }
    const shadows = r.shadowMap.enabled && this.sun && this.sun.castShadow;
    if (this.composer) {
      /* 背景・にじみ・合成・出力のシェーダは描いて作る(ブルームを一時的に通す)。
       * 影の深度シェーダの準備も同じ1コマで(コマを1つ減らす) */
      const be = this.bloom ? this.bloom.enabled : false;
      if (this.bloom) this.bloom.enabled = true;
      try {
        if (shadows) this._prewarmShadowsWith(() => this.composer.render(0));
        else this.composer.render(0);
      } finally { if (this.bloom) this.bloom.enabled = be; }
    } else if (shadows) {
      this._prewarmShadowsWith(null);
    }
    /* 低(直接描く)は背景の箱のシェーダが最初のコマで作られる(暗転の中なので、ここでは描かない) */
    this._shadowDirty = true;
  }

  /* 遠くて描かないことにしているセルも、影の種類を数えるために一時的に見せてから _prewarmShadows */
  _prewarmShadowsWith(draw) {
    const reg = this._cellReg, hid = [];
    for (let i = 0; i < reg.length; i++) if (!reg[i].obj.visible) { reg[i].obj.visible = true; hid.push(reg[i].obj); }
    try { this._prewarmShadows(draw); } finally { for (let i = 0; i < hid.length; i++) hid[i].visible = false; }
  }

  /* いまの運転(sim)の位置にカメラ・太陽・光の慣れを置く(render(0) と同じ置き方)。
   * 準備(prewarm)を古いカメラ位置(タイトルのデモ)でしないため */
  _placeView() {
    const sim = this.sim;
    if (!sim || !this.line || !this.frames) return;
    const L = this.line.meta.length;
    const s = Math.max(0, Math.min(L - 2, sim.pos));
    const f = frameAt(this.frames, this.step, s);
    this._camFeel(0, s, f);
    this._placeCamera(s, f, 0);
    this._updateLightLevel(0);
    this._placeSun(s, f);
    this._updateSleepers(s);
    const eye = this.camera.position;
    if (this.eveSky) this.eveSky.position.copy(eye);
    if (this.nightSky) this.nightSky.position.copy(eye);
    this.camera.updateMatrixWorld();
    this._cullTick(true);
  }

  /* 作り直しで外した材質・テクスチャを、新しいワールドの準備が済んでから捨てる */
  _flushStale() {
    this._dropStandIn();   // 準備のあと(暗転中): 使わなくなった代わりの青空も ここで
    if (!this._staleMats.length && !this._staleTex.length) return;
    const mats = this._staleMats, texs = this._staleTex;
    this._staleMats = []; this._staleTex = [];
    /* 新しいワールドでも使っている(部品ごとに使い回している)材質・テクスチャは捨てない */
    const used = new Set();
    this.scene.traverse((o) => {
      if (!o.material) return;
      [].concat(o.material).forEach((m) => {
        used.add(m);
        ['map', 'normalMap', 'emissiveMap', 'alphaMap', 'roughnessMap'].forEach((k) => { if (m[k]) used.add(m[k]); });
      });
    });
    mats.forEach((m) => { if (!used.has(m)) { try { m.dispose(); } catch (e) { /* noop */ } } });
    texs.forEach((t) => { if (!used.has(t)) { try { t.dispose(); } catch (e) { /* noop */ } } });
  }

  /* メニュー・一時停止の背景として描く(on): 影の描きなおしとブルームを止める(最後の影はそのまま) */
  setBackdrop(on) {
    const b = !!on;
    if (b === this._backdrop) return;
    this._backdrop = b;
    if (!b) this._shadowDirty = true;
  }

  /* 空(HDR)を用意する: 'clear'(晴れ) / 'rain'・'snow'(曇り)。読みこみ済みなら何もしない。
   * 戻り値は Promise(読めたら true)。曇りは使うまで読まない(メモリと通信の節約) */
  ensureEnv(key) {
    const k = key === 'snow' || key === 'rain' ? 'rain' : key === 'clear' ? 'clear' : null;
    if (!k) return Promise.resolve(false);
    if ((this.env[k] && !this.env[k].placeholder) || this._envLate[k]) return Promise.resolve(true);
    /* 届くまでの代わり: 背景は色、環境光は曇りなら晴れ(なければ夕方)、晴れなら夕方のもの(どれも 256 の立方体)。
     * 環境光を null にすると全シェーダが別の版になり、届いたときに全部コンパイルしなおしになるため */
    if (!this.env[k]) {
      /* 晴れは青空のグラデーション(_standIn)。曇りは晴れ(か代わり)の環境光+灰色の背景 */
      const si = this._standIn;
      const st = (k === 'rain' && this.env.clear && this.env.clear.ibl) || (si && si.ibl) || (this.env.evening && this.env.evening.ibl) || null;
      const bg = k === 'rain' ? this._wetBg : (si && si.bg) || new THREE.Color(0xa8c4dd);
      if (st) this.env[k] = { bg, ibl: st, placeholder: true };
    }
    if (!this._envLoad[k]) this._envLoad[k] = this._loadHdr(k);
    return this._envLoad[k];
  }

  _loadHdr(k) {
    const url = k === 'clear' ? './assets/sky/sky_clear.hdr' : './assets/sky/sky_overcast.hdr';
    return new Promise((resolve) => {
      new RGBELoader().load(url, (t) => {
        let ok = false;
        try { ok = this._onHdr(k, url, t); } catch (e) { ok = false; }
        resolve(ok);
      }, undefined, () => resolve(false));
    });
  }

  /* HDRが届いた: 背景は立方体に変換し、環境光は小さくした版から作る。元の画像はGPU・CPUとも捨てる */
  _onHdr(k, url, t) {
    if (this._dead) {
      /* 捨てたステージ(cancelAsync): 空は作らない。読めた画像も すぐ手ばなす */
      try { t.dispose(); t.image.data = null; } catch (e) { /* noop */ }
      try { THREE.Cache.remove(url); } catch (e) { /* noop */ }
      return false;
    }
    const r = this.renderer;
    t.mapping = THREE.EquirectangularReflectionMapping;
    /* 太陽の円盤を抑えてから環境光を作る(影がはっきり出る) */
    const sunDir = k === 'clear' ? prepareClearHdr(t) : null;
    const hor = horizonRadiance(t);
    let bg = null, cube = null;
    try {
      cube = new THREE.WebGLCubeRenderTarget(Math.max(16, t.image.height >> 1), { type: THREE.HalfFloatType });
      cube.fromEquirectangularTexture(r, t);
      bg = cube.texture;
    } catch (e) { if (cube) cube.dispose(); cube = null; }
    const own = k !== 'clear' || !this._pmrem;
    const pm = own ? new THREE.PMREMGenerator(r) : this._pmrem;
    let ibl = null, small = null;
    try {
      small = t.image.width > 1024 ? downsampleHdr(t) : null;
      ibl = pm.fromEquirectangular(small || t).texture;
    } catch (e) { ibl = null; }
    if (small) small.dispose();
    /* 環境光づくりの道具(と作業用の大きな描画先)は、晴れ・夕方・夜がそろったら捨てる */
    pm.dispose();
    if (!own) this._pmrem = null;
    if (bg) {
      t.dispose();
      t.image.data = null;
    } else {
      bg = t;   // 立方体にできなかったときは元の画像を背景に
    }
    try { THREE.Cache.remove(url); } catch (e) { /* noop */ }
    if (!ibl) return false;
    this._envLate[k] = { env: { bg, ibl, hor, cube }, sunDir };
    this._lateN++;
    /* 最初の準備の前・止まっているときは すぐ使う。走っている最中なら、つぎの時間帯・天気・路線の切替(暗転中)まで待つ */
    const sim = this.sim;
    /* いまは使っていない(先読み): 見た目は変えない。待たせているほかの空(晴れは太陽の向きも変わる)は巻きこまない。
     * 使うかどうかは _applyAtmosphere と同じ決め方: 夜は夜空だけ・曇りは雨雪のときだけ・
     * 晴れの空は昼と、雨雪の夕方(太陽の向き・曇りの代わりの環境光)で使う(晴れの夕方は夕焼けの空) */
    const tod = this.timeOfDay, wet = this.weather !== 'clear';
    const used = tod !== 'night' && (k === 'rain' ? wet : (wet || tod !== 'evening'));
    if (!used) this._promoteEnv(false, k);
    else if (!this._booted || !sim || sim.ended || sim.v < 0.05) this._promoteEnv(true);
    return true;
  }

  /* 届いて待たせていた空を使いはじめる。apply: すぐ見た目に反映する / only: その空だけ(なければ全部) */
  _promoteEnv(apply, only) {
    if (!this._lateN) return;
    const L = this._envLate;
    Object.keys(L).forEach((k) => {
      if (only && k !== only) return;
      const e = L[k];
      const old = this.env[k];
      this.env[k] = e.env;
      if (e.sunDir) this._sunDir.copy(e.sunDir);
      /* 曇りの代わりに晴れの環境光を使っていたら、晴れの側も差しかえておく */
      if (k === 'clear' && this.env.rain && this.env.rain.placeholder) this.env.rain.ibl = e.env.ibl;
      if (old && old.cube && old.cube !== e.env.cube) old.cube.dispose();
      delete L[k];
    });
    this._lateN = Object.keys(L).length;
    this._shadowDirty = true;
    if (apply) this._applyWeather();
    this._dropStandIn();
  }

  /* 晴れの空(HDR)が届いたあと、代わりの青空(_standIn)を どこも使っていなければ捨てる(GPUの約6MB)。
   * 背景・環境光・曇りの代わり(env.rain)のどれかが まだ使っていれば、つぎの機会まで残す */
  _dropStandIn() {
    const si = this._standIn;
    if (!si || !this.env.clear || this.env.clear.placeholder) return;
    const sc = this.scene;
    if (sc.environment === si.ibl || sc.background === si.bg) return;
    if (this.env.rain && (this.env.rain.ibl === si.ibl || this.env.rain.bg === si.bg)) return;
    this._standIn = null;
    try { if (si.iblRT) si.iblRT.dispose(); } catch (e) { /* noop */ }
    try { if (si.cube) si.cube.dispose(); } catch (e) { /* noop */ }
  }

  /* 遠いセル(全線を約700m/750mごとに分けたメッシュ)を登録する。
   * 登録するのは _splitInstances と mergeRibbons が作ったものと、userData.cullCell の付いたものだけ
   * (木・架線・駅の灯り・人など、ほかで visible を切りかえる物は入れない) */
  _registerCells(added) {
    this._cellReg = [];
    this.world.updateMatrixWorld(true);
    const v = new THREE.Vector3();
    const seen = new Set();
    const reg = (o) => {
      if (seen.has(o) || !o.isMesh || !o.geometry) return;
      seen.add(o);
      let bs = null;
      if (o.isInstancedMesh) {
        if (!o.boundingSphere) o.computeBoundingSphere();
        bs = o.boundingSphere;
      } else {
        if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
        bs = o.geometry.boundingSphere;
      }
      if (!bs || !(bs.radius >= 0)) return;
      v.copy(bs.center).applyMatrix4(o.matrixWorld);
      const sc = o.matrixWorld.getMaxScaleOnAxis();
      const r = bs.radius * sc;
      /* keep: 遠くても描く(大きな丘・目印の建物・とても大きなかたまり) / cs0: もともと影を落とすか */
      this._cellReg.push({ obj: o, cx: v.x, cz: v.z, r, keep: !!(o.userData && o.userData.keepFar) || r > 600, cs0: !!o.castShadow });
    };
    added.forEach(reg);
    this.world.traverse((o) => { if (o.userData && o.userData.cullCell) reg(o); });
    this._cullX = 1e9; this._cullFar = -1;
  }

  /* 遠いセルは描かない(視錐台の判定も影の判定もしない)。
   * ・遠景クリップ(camera.far)より遠いもの
   * ・視点ごとの描く距離(_drawFar: 霧で84%以上かすむ所)より遠いもの(大きな丘・目印 keep は除く)
   * 出入りのくり返しでチラつかないよう、消すのは 40m 先・出すのはその手前(ヒステリシス)。
   * 影を落とすのは近いセルだけ(影の箱のあたり。castShadow の切りかえはシェーダを作り直さない)。
   * 8フレームに1回か、視点が40m以上動いたとき・遠景クリップや視点が変わったときだけ。
   * force(準備の前): 影の深度シェーダをすべての種類で作れるよう、影はもとの設定にもどす(次の回で また間引く) */
  _cullTick(force) {
    const reg = this._cellReg;
    if (!reg.length) return;
    const eye = this.camera.position, far = this.camera.far, mode = this.camMode;
    const dx = eye.x - this._cullX, dz = eye.z - this._cullZ;
    if (!force && (this._frame & 7) !== 0 && dx * dx + dz * dz < 1600 && far === this._cullFar && mode === this._cullMode) return;
    this._cullX = eye.x; this._cullZ = eye.z; this._cullFar = force ? -1 : far; this._cullMode = mode;
    /* 視点ごとの描く距離(中画質の値。高は +250・低は -180)。昼の霧(30〜1300m)で 84% かすむのが約980m。
     * 霧が遠い時間帯(夕方)は、その時間帯の霧で 84% かすむ距離まで延ばす(遠くの物がいきなり現れない) */
    const base = mode === 'cab' ? 980 : mode === 'drone' ? 1250 : 1100;
    const qa = this.quality === 'high' ? 250 : this.quality === 'low' ? -180 : 0;
    const fg = this.scene.fog;
    const f84 = fg && this.camMode !== 'drone' ? fg.near + 0.75 * (fg.far - fg.near) : 0;
    this._drawFar = (Math.max(base, f84) + qa) * (this._drawFarK || 1);
    const limK = far + 50, limD = Math.min(limK, this._drawFar), ex = eye.x, ez = eye.z;
    /* 影を落とすセル: 影の箱の中心(太陽の真下の点)のまわり。低い太陽(夕方)の長い影のために、
     * 太陽の側へ広げる(高さ15mの物の影の長さの半分だけ中心を太陽の側へずらし、そのぶん半径も足す) */
    const tg = this.sun ? this.sun.target.position : eye;
    const sd = this._curSunDir || this._sunDir || UP;
    const sh = Math.hypot(sd.x, sd.z), sy = Math.max(0.09, sd.y);
    const shift = sh > 1e-3 ? Math.min(150, 7.5 * sh / sy) : 0;
    const gx = tg.x + (sh > 1e-3 ? sd.x / sh * shift : 0), gz = tg.z + (sh > 1e-3 ? sd.z / sh * shift : 0);
    const shR = (mode === 'drone' ? 340 : 260) + shift;
    for (let i = 0; i < reg.length; i++) {
      const c = reg[i], o = c.obj;
      const d = Math.hypot(c.cx - ex, c.cz - ez) - c.r;
      const lim = c.keep ? limK : limD;
      if (force) o.visible = d < lim + (o.visible ? 40 : 0);
      else if (o.visible) { if (d > lim + 40) o.visible = false; }
      else if (d < lim) o.visible = true;
      if (c.cs0) o.castShadow = force || Math.hypot(c.cx - gx, c.cz - gz) - c.r < shR;
    }
  }

  /* 準備(prewarm)の印を立てたとき: 遠くて影を間引いたセルの影をもとにもどす。
   * 準備は影を落とす物の種類ごとに影の深度シェーダを作るので、間引いたままだと遠くにしかない種類が抜け、
   * 走行中に近づいたときに作られてカクつく(描画の中の prewarm(true) は _cullTick(true) を通らない)。
   * 次の _cullTick で また間引く */
  _shadowCastAll() {
    const reg = this._cellReg;
    for (let i = 0; i < reg.length; i++) if (reg[i].cs0) reg[i].obj.castShadow = true;
    this._cullFar = -1;
  }

  /* 影の深度シェーダも先に作る。compile() は影のぶんを作らず、影は影の箱の中の物しか描かれないので、
   * 遠くにある種類の物は走行中にはじめて作られてカクつく。そこで種類ごとに1つ、カリングを外して1回描く。
   * 共有の深度材質は map/side が変わってもシェーダを選びなおさないので、needsUpdate で毎回選びなおさせる。
   * 遠い木のかたまり(LODで今は影なし)も、近づくと影を落とすので数に入れる。
   * さわった設定(カリング・影・onBeforeShadow)は、描画が失敗しても必ず元にもどす。
   * draw: 描く関数(ブルーム用のパスまで通す composer.render など)。なければシーンを1回描く */
  _prewarmShadows(draw) {
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
      if (typeof draw === 'function') draw();
      else {
        r.setRenderTarget(this.composer ? this.composer.renderTarget1 : null);
        r.render(this.scene, this.camera);
      }
    } finally {
      saved.forEach(({ o, fc, cs, own, obs }) => {
        o.frustumCulled = fc;
        o.castShadow = cs;
        if (own) o.onBeforeShadow = obs;
        else delete o.onBeforeShadow;
      });
    }
  }

  /* 影は動くものがあるときだけ描きなおす(止まった駅・一時停止・メニューでは前の影のまま)。
   * 動くもの: 自列車(速度・ドア開閉と人の動き)・近くのほかの列車・踏切・影の箱の移動・明示の作りなおし(_shadowDirty) */
  _updateShadow(dt) {
    const r = this.renderer, sun = this.sun;
    if (!r.shadowMap.enabled || !sun || !sun.castShadow) { this._shadowDirty = false; return; }
    const sim = this.sim;
    const tg = sun.target.position;
    if (!this._shTgt) this._shTgt = new THREE.Vector3(1e9, 0, 0);
    /* act: 速く動くもの(毎フレーム) / slow: ゆっくり動くもの(ホームを歩く人・踏切の棒。3フレームに1回で足りる) */
    let act = false, slow = false;
    /* 影の箱が動いた(2cm以上。止まっていても位置が計算の誤差でわずかにゆれるので、小さい差は数えない) */
    if (tg.distanceToSquared(this._shTgt) > 0.0004) { this._shTgt.copy(tg); act = true; }
    if (!act && dt > 0 && sim) {
      /* ほかの列車は「影の箱が地面にとどく範囲」の中で動いていたら描きなおす(カメラのまわりだけ見ると、
       * そらからの視点などで箱の先のほうに動かない影が残る)。
       * 太陽の向きの前後は 上下の幅÷sin(高さ)(太陽から 430m の所に置くので far で打ち切り)、横は左右の幅 */
      const sc = sun.shadow.camera, sd = this._curSunDir || this._sunDir;
      const sinE = Math.max(0.09, Math.min(0.99, sd.y / sd.length()));
      const reach = 30 + Math.hypot(Math.max(sc.right, -sc.left),
        Math.min(Math.max(sc.top, -sc.bottom) / sinE, (sc.far - 430) / Math.sqrt(1 - sinE * sinE)));
      const shS = this._shS != null ? this._shS : this._camS;
      if (sim.v > 0.5) act = true;
      else if (this.traffic && typeof this.traffic.anyNear === 'function' && this.traffic.anyNear(shS, reach)) act = true;
      else if (sim.doorOpen) slow = true;
      else {
        const cs = this.crossSpots;
        if (cs) for (let i = 0; i < cs.length; i++) if (Math.abs(cs[i] - sim.pos) < 450) { slow = true; break; }
      }
    }
    const force = this._shadowDirty;
    /* 動きが止まっても数フレームは描く(ドアが閉まった瞬間に人が立ち位置へ移るなど) */
    if (act || force) this._shadowHold = 4;
    else if (slow && this._frame % 3 === 0) this._shadowHold = Math.max(this._shadowHold, 1);
    /* 中画質(と軽量化の段階)では、動いている間の描きなおしは 1秒30回まで(60fps なら1コマおき)。
     * 描いたコマの数ではなく時間で決める(タッチ端末のタイトルは 1秒30コマに おさえて描くので、
     * コマの数で1つおきにすると 1秒15回になって 走るデモ列車の影が ちらつく)。
     * 止まっている物の影は、描いたときの影の行列で見るので ずれない
     * (自列車と 近くを動く ほかの列車の影は 最大1コマ遅れる)。
     * dt が 0 の 1回だけの描きなおし(一時停止中など)は 時間が すすまないので、またずに描く */
    const alt = this._shadowLite || this.quality !== 'high';
    this._shAge = (this._shAge || 0) + (dt > 0 ? dt : 0);
    const want = !this._backdrop && (force || (this._shadowHold > 0 && (!alt || !act || !(dt > 0) || this._shAge >= 0.028)));
    if (want) this._shAge = 0;
    r.shadowMap.needsUpdate = want;
    if (this._shadowHold > 0) this._shadowHold--;
    this._shadowDirty = false;
  }

  /* 自動画質の段階を読む(opts.autoQ のときだけ前回の保存分。なければ画質の既定) */
  _loadPerf(Q) {
    const P = { dpr: Q.dpr, shadowLite: false, shadowUp: false, bloom: Q.bloom, bloomShift: this.quality === 'mid' ? 1 : 0,
      drawFarK: 1, maxDpr: 0, shadowUpBad: false };
    P.base = { dpr: P.dpr, bloomShift: P.bloomShift };
    if (!this.autoQ) return P;
    try {
      const p = JSON.parse(localStorage.getItem(PERF_KEY) || 'null');
      if (p && p.q === this.quality) {
        const top = Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, 1.75);
        if (p.maxDpr > 0) P.maxDpr = p.maxDpr;
        /* 前回あげた段(既定より高いDPR)も もどす。ただし画面の画素密度と、合わなかった上限(maxDpr)まで */
        if (p.dpr > 0) P.dpr = Math.min(Math.max(p.dpr, 0.75), Math.max(Q.dpr, top), P.maxDpr > 0 ? P.maxDpr : 9);
        /* 古い保存(shadowLevel 1 = 影512+1フレームおき)は「1フレームおき」だけ引きつぐ(512 の段はもう使わない) */
        P.shadowLite = !!(p.shadowLite || p.shadowLevel === 1);
        P.shadowUp = !!(p.shadowUp || p.shadowLevel === 2) && !p.shadowUpBad;
        P.shadowUpBad = !!p.shadowUpBad;
        if (p.bloomShift > P.bloomShift && p.bloomShift <= 2) P.bloomShift = p.bloomShift;
        if (p.drawFarK > 0) P.drawFarK = Math.min(1, Math.max(0.6, p.drawFarK));
      }
    } catch (e) { /* 読めなければ既定のまま */ }
    return P;
  }

  /* GPUが重いときに1段下げる: 解像度(DPR) 1.35→1.25→1.15→1.05 → にじみの計算を1/8の解像度に。
   * 影の地図は小さくしない(画素ごとの影の計算の重さは地図の大きさで変わらない)。
   * にじみ(ブルーム)は止めない(夜・夕方の見た目の要。止めても描画の道は同じで軽くならない)。
   * 影は shadowMap.enabled を切りかえない(全シェーダの作り直しで数秒止まるため) */
  stepDownQuality() {
    const r = this.renderer, P = this._perf;
    const cur = r.getPixelRatio();
    let next = 0;
    for (let i = DPR_STEPS.length - 1; i >= 0; i--) if (DPR_STEPS[i] < cur - 0.01) { next = DPR_STEPS[i]; break; }
    if (next) {
      r.setPixelRatio(next);
      P.dpr = next;
      this._reapplySize();
      this._savePerf();
      return 'dpr';
    }
    /* にじみ: 計算の解像度だけ下げる(段の数・シェーダは同じ。重ね合わせは元の解像度のまま) */
    if (this.bloom && this.composer && P.bloomShift < 2) {
      P.bloomShift++;
      if (!this._bloomTinted) { this.bloom.bloomTintColors.forEach((c) => c.multiplyScalar(0.74)); this._bloomTinted = true; }
      this._reapplySize();
      this._savePerf();
      return 'bloomRes';
    }
    return null;
  }

  /* CPUが重いときに1段下げる: 遠くを描く距離を 0.8倍(0.6倍まで) → (高画質だけ)動いている間の影を1フレームおき。
   * 解像度は下げない(CPUの重さは画素の数で変わらない) */
  _stepCpu() {
    const P = this._perf;
    if (P.drawFarK > 0.6 + 1e-3) {
      P.drawFarK = Math.max(0.6, Math.round(P.drawFarK * 0.8 * 100) / 100);
      this._drawFarK = P.drawFarK;
      this._cullX = 1e9;   // つぎのコマで遠いセルを選びなおす
      this._savePerf();
      return 'drawFar';
    }
    /* 影の1フレームおきが効くのは高画質だけ(中は はじめから 1秒30回まで。_updateShadow)。
     * 中では この段を とばして、すぐ GPU側の段(stepDownQuality)へ(むだな8秒を待たない) */
    if (!this._shadowLite && this.quality === 'high' && this.renderer.shadowMap.enabled) {
      this._shadowLite = true;
      P.shadowLite = true;
      this._savePerf();
      return 'shadowLite';
    }
    return null;
  }

  /* 軽く動いているときに1段上げる: 解像度を1段(画面の画素密度・1.75・合わなかった上限まで) → 影2048。
   * 上げたあと2回(8秒)のうちに 52fps を切ったら もどして、その上限を覚える(_aq.trial) */
  _stepUp() {
    const r = this.renderer, P = this._perf, A = this._aq;
    const top = Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, 1.75, P.maxDpr > 0 ? P.maxDpr : 9);
    const cur = r.getPixelRatio();
    let next = 0;
    for (let i = 0; i < DPR_STEPS.length; i++) if (DPR_STEPS[i] > cur + 0.01) { next = DPR_STEPS[i]; break; }
    if (next && next <= top + 1e-3) {
      A.trial = { kind: 'dpr', prev: cur, n: 0 };
      r.setPixelRatio(next);
      P.dpr = next;
      this._reapplySize();
      return 'dprUp';
    }
    const sh = this.sun && this.sun.shadow;
    if (sh && r.shadowMap.enabled && this.sun.castShadow && sh.mapSize.x < 2048 && !P.shadowUpBad) {
      A.trial = { kind: 'shadow', prev: sh.mapSize.x, n: 0 };
      this._setShadowSize(2048);
      P.shadowUp = true;
      return 'shadowUp';
    }
    return null;
  }

  /* 影の地図の大きさを変える(地図を捨てて作りなおすだけ。シェーダは同じ) */
  _setShadowSize(n) {
    const sh = this.sun && this.sun.shadow;
    if (!sh) return;
    sh.mapSize.set(n, n);
    if (sh.map) { sh.map.dispose(); sh.map = null; }
    this._shadowDirty = true;
  }

  /* 上げてみた段が重かった: もどして、その上限を保存する(つぎからは上げない) */
  _revertUp(t) {
    const r = this.renderer, P = this._perf;
    if (t.kind === 'dpr') {
      r.setPixelRatio(t.prev);
      P.dpr = t.prev;
      P.maxDpr = t.prev;
      this._reapplySize();
    } else {
      this._setShadowSize(t.prev);
      P.shadowUp = false;
      P.shadowUpBad = true;
    }
    this._aq.locked = true;
    this._savePerf();
    return 'revert';
  }

  _savePerf() {
    const P = this._perf;
    /* 保存するのは自動画質が有効(opts.autoQ)のときだけ。古い呼び出し元の1回のカクつきで下げた段階を次回に持ちこまない。
     * 30fpsちょうどで安定しているとき(_capLike: iPadの低電力モードなどで、書きかえが1秒30回に絞られている)は
     * GPUの力不足ではないので、下げるのはこの回だけにして保存しない(保存すると低電力モードをやめても軽いまま) */
    if (!this.autoQ || this._capLike) return;
    try {
      localStorage.setItem(PERF_KEY, JSON.stringify({
        q: this.quality, dpr: P.dpr, shadowLite: !!P.shadowLite, shadowUp: !!P.shadowUp, shadowUpBad: !!P.shadowUpBad,
        bloom: true, bloomShift: P.bloomShift, drawFarK: P.drawFarK, maxDpr: P.maxDpr || 0,
      }));
      this._perfSaved = true;
    } catch (e) { /* 保存できなくても動く */ }
  }

  /* 自動画質の見張り(毎フレーム呼ぶ)。opts: {busy, cpuMs}
   * busy: 間引いて描く画面・ポーズ・暗転・出発直後・運転台以外のカメラ(はからない。はかりかけの4秒も捨てる)
   * cpuMs: そのコマのJSの重さ(描画+計器+コーチ)。4秒の平均で CPU と GPU のどちらが重いかを見分ける。
   * 下げる: 平均 45fps 未満が2回続き、直近2.5秒にカクつき(0.09秒以上)が無いとき1段。
   *         CPUが平均9ms以上なら CPU の段(遠くの距離・影の間引き)、ほかは GPU の段(解像度・にじみ)
   * 上げる: 58fps以上が3回(12秒)続き、CPUが7ms未満なら1段(解像度 → 影2048)。上げたあと52fpsを切ったら もどす。
   * 戻り値: 変えた段の名前(なければ null) */
  autoQualityTick(dt, opts) {
    const o = opts || {};
    const busy = !!o.busy;
    const cpu = typeof o.cpuMs === 'number' && o.cpuMs >= 0 && o.cpuMs < 1000 ? o.cpuMs : -1;
    const A = this._aq || (this._aq = { t: 0, n: 0, hitch: -1e9, bad: 0, good: 0, mx: 0, forgot: false, cs: 0, cn: 0, up: 0, trial: null, locked: false });
    const now = performance.now();
    if (dt >= 0.09) A.hitch = now;
    if (busy) { A.t = 0; A.n = 0; A.mx = 0; A.cs = 0; A.cn = 0; A.d0 = -1; return null; }
    if (!(A.d0 >= 0)) A.d0 = this.drawCount;
    A.t += dt; A.n++;
    if (dt > A.mx) A.mx = dt;
    if (cpu >= 0) { A.cs += cpu; A.cn++; }
    if (A.t < 4 - 1e-6) return null;   // 1/30秒を120回足しても4にわずかに届かないので少し余裕を見る
    /* fps は実際に描いたコマで(GPUが追いつかずに描かなかったコマは数えない) */
    const drawn = this.drawCount - A.d0;
    const fps = Math.min(A.n, drawn > 0 ? drawn : A.n) / A.t, mx = A.mx, cpuAvg = A.cn ? A.cs / A.cn : -1;
    A.t = 0; A.n = 0; A.mx = 0; A.cs = 0; A.cn = 0; A.d0 = this.drawCount;
    this._aqLast = { fps, cpu: cpuAvg };
    /* 30fps前後で1コマの長さがそろっている = 画面の書きかえの上限(iPadの低電力モードなど)。GPUの限界ではないので保存しない */
    this._capLike = fps > 27 && fps < 32 && mx < 0.045;
    /* 上げてみた段の見きわめ(2回) */
    if (A.trial) {
      const t = A.trial;
      if (fps < 52) { A.trial = null; A.good = 0; return this._revertUp(t); }
      if (++t.n >= 2) { A.trial = null; this._savePerf(); }
      return null;
    }
    /* なめらかに動いている: 前の起動で保存した軽い段階は忘れる(つぎの起動はふつうの画質から。合わなかった上限は覚えておく)。
     * ただし、この起動で自分で変えて保存した段階は消さない(下げたから速くなっただけなので) */
    A.good = fps >= 55 ? A.good + 1 : 0;
    if (A.good >= 3 && this.autoQ && !this._perfSaved && !A.forgot) {
      A.forgot = true;
      try {
        const P = this._perf;
        if (P.maxDpr > 0 || P.shadowUpBad) localStorage.setItem(PERF_KEY, JSON.stringify({ q: this.quality, maxDpr: P.maxDpr || 0, shadowUpBad: !!P.shadowUpBad }));
        else localStorage.removeItem(PERF_KEY);
      } catch (e) { /* 消せなくても動く */ }
    }
    /* 上げる */
    A.up = fps >= 58 && (cpuAvg < 0 || cpuAvg < 7) ? A.up + 1 : 0;
    if (A.up >= 3 && !A.locked) {
      A.up = 0;
      const u = this._stepUp();
      if (u) return u;
      A.locked = true;   // もう上げる段がない
    }
    /* 下げる */
    const bad = fps < 45 && now - A.hitch > 2500;
    A.bad = bad ? A.bad + 1 : 0;
    if (A.bad < 2) return null;
    A.bad = 0;
    A.up = 0;
    /* 一度 下げたら、この起動のあいだは もう上げない(軽い場面で上げて 重い場面で下げる、の くりかえしは
     * そのたびに画面の大きさの作りなおしで止まる) */
    A.locked = true;
    if (cpuAvg > 9) {
      const c = this._stepCpu();
      if (c) return c;
    }
    return this.stepDownQuality();
  }

  _reapplySize() {
    if (this._w) {
      this.renderer.setSize(this._w, this._h, false);
      if (this.composer) {
        this.composer.setPixelRatio(this.renderer.getPixelRatio());
        this.composer.setSize(this._w, this._h);
      }
      this._dprApplied = this.renderer.getPixelRatio();
      this._nSetSize++;
      this._shadowDirty = true;
    }
  }

  setWeather(w) {
    this.weather = w;
    /* 雨・雪の空(曇り)は使うときに読む。届くまでは代わりの背景色・環境光 */
    if (w === 'snow') this._wetBg.setHex(0xc9cfd5);
    else if (w === 'rain') this._wetBg.setHex(0x8d959c);
    if (w !== 'clear' && this.timeOfDay !== 'night') this.ensureEnv('rain');
    if (this._lateN) this._promoteEnv(false);
    this._shadowDirty = true;
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
    /* 環境光(建物の日かげを照らす空の光)は、見える空より青い値で作る。
     * 壁は地平線近くの空の光をいちばん受けるので、見える空の だいだい・ばら色のままだと日かげが全部ピンクになる。
     * 日かげは青紫・日なたは太陽で だいだい、にする(見える空の色は作ったあとで元にもどす) */
    const keep = ['uHor', 'uMid', 'uAnti', 'uZen'].map((k) => [k, U[k].value.clone()]);
    const lin = THREE.LinearSRGBColorSpace;
    U.uHor.value.setRGB(0.70, 0.34, 0.22, lin);
    U.uMid.value.setRGB(0.20, 0.19, 0.30, lin);
    U.uAnti.value.setRGB(0.16, 0.16, 0.27, lin);
    U.uZen.value.multiplyScalar(1.6);
    try {
      this.env.evening = { ibl: this._pmrem.fromScene(tmp, 0.02).texture, sky: mesh };
    } catch (e) { /* 失敗しても晴れの環境で代用 */ }
    keep.forEach(([k, c]) => U[k].value.copy(c));
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
    /* (昼夜で材質のテクスチャを差しかえる旧方式 _bldMats・旧ホーム照明 stationLamps は使わなくなった。
     * 街・駅の明かりは それぞれの部品が look.rev を見て値だけ書きかえる) */
    /* 自販機 */
    if (this._vendFrontMat) this._vendFrontMat.emissive.setHex(night || eve ? 0xcfe0ee : 0x000000);
    if (this.weatherFx) this.weatherFx.set(this.weather, tod);
    if (this.trainKit) this.trainKit.setNight(night || eve || wet || !!this._inTunnelNow);
    /* 空の映りこみの強さ(LOOK.env)が変わるので、次の _applyLightLevel で全材質に書き直す */
    this._kEnv = -1;
    /* 使うシェーダの組が本当に変わったときだけ、次に描く前にまとめて準備する。
     * 変わるのは: 夜空・夕焼けの空の表示、ぬれ、背景が画像か色か、環境光(空の映りこみ)の差しかえ。
     * 同じ時間帯・天気のままタイトルへもどるときなどは準備しない(数秒止まるのを防ぐ)。
     * 下ろすのは準備(prewarm)だけ(ワールドの作り直しで立てた印は消さない) */
    const env0 = this.scene.environment;
    const pk = (night ? 'n' : '-') + (eveSky ? 'e' : '-') + (wet ? 'w' : '-') +
      (this.scene.background && this.scene.background.isTexture ? 'b' : '-') + '|' + (env0 ? env0.uuid : '');
    if (pk !== this._progKey) { this._needPrewarm = true; this._shadowCastAll(); }
    this._progKey = pk;
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
    /* 太陽: ターミナルの中から見る外は、屋根の下より明るい(まぶしい出口)。影がある画質では、太陽は弱めない
     * (屋根の影で中には日が入らない。目の慣れで露出が上がるぶん、外が白くにじむ)。影のない画質は今までどおり */
    const kSun = (this._termCam || this._termSun) && this.renderer.shadowMap.enabled ? 1 : k;
    this.sun.intensity = L.sun[0] * kSun;
    /* 空の光: トンネル・ターミナルの中は灯りの照り返しのような灰色の明かりを足す(壁・天井が真っ黒につぶれない。
     * 出口で急に消えないよう k だけで決める。ターミナルは天井の灯りが多いので控えめに)。
     * 晴れの夜の空の光は、郊外ほど暗い(街灯・看板の照り返しが少ない。_glowK: 0=都心 1=郊外) */
    const fill = k < 1 ? (this._inTerminal(this._camS, 30) ? 0.35 : 0.7) * (1 - k) : 0;
    const open = L.key === 'night' ? 1.05 - 0.2 * this._glowK : 1;
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
    /* ターミナルの中から出口の先を見ると、外は明るい空の色に白っぽくかすむ(暗い所から見る外はまぶしい)。
     * 霧を出口の少し先から濃くする(屋根の下は変わらない)。出たあとは目の慣れ(k)にあわせて元の霧へもどす */
    const tw = this._termW || 0;
    if (tw > 0) {
      const n0 = Math.max(fog.near, (this._termD || 0) + 5);
      fog.near += (n0 - fog.near) * tw;
      fog.far += (n0 + 300 - fog.far) * tw;
      fog.color.multiplyScalar(1 + tw);
    }
    /* 霧の照り返し(夕方・ブルーム経由だけ。直接描く霧はトーンマップ後の色なので足さない)。
     * 太陽の側だけ明るく(せまい範囲)、反対側は地平線と同じ青みの灰色へ(_duskU.uHorAnti) */
    const eveP = L.key === 'eve' && post;
    if (eveP) this.U.uFogSun.value.set(0.55 * kf, 0.12 * kf, 0.02 * kf);
    else this.U.uFogSun.value.set(0, 0, 0);
    this.U.uFogDir.value = eveP ? kf : 0;
    if (eveP && this._duskU && this._duskU.uHorAnti) this.U.uFogAnti.value.copy(this._duskU.uHorAnti.value);
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
    /* 夜の色のうすさ(灯りのあるトンネルの中では弱める)。色をぬくのは暗い所だけ:
     * ブルーム経由はトーンマップ前のリニアの明るさ、直接描く(低画質)はトーンマップ後の明るさで判定 */
    this.U.uNightDs.value = (L.desat || 0) * k;
    this.U.uDsLo.value = post ? 0.01 : 0.08;
    this.U.uDsHi.value = post ? 0.12 : 0.45;
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
    /* 線路の架線・街の電線・駅などの線の材質(rs._wireMats: ほかの部品が登録する配列) */
    const wm = Array.isArray(this._wireMats) ? this._wireMats : null;
    const nw = 2 + (wm ? wm.length : 0);
    for (let i = 0; i < nw; i++) {
      const w = i === 0 ? this.M.wire : i === 1 ? (this._p1M ? this._p1M.wire : null) : wm[i - 2];
      if (!w || !w.color || (i > 1 && (w === this.M.wire || (this._p1M && w === this._p1M.wire)))) continue;
      if (!w.userData.base) w.userData.base = w.color.clone();
      w.color.copy(w.userData.base).multiplyScalar(wk);
    }
  }

  /* ぬれ・雪の共通部品を、ワールドと車両の標準材質に付ける(運転台=カメラの子は除く)。
   * あわせて k で明るさを変える材質(空の映りこみ)を集める */
  _installWeatherChunk() {
    /* 新しい材質(まだシェーダを作っていないもの)があったときだけ、次に描く前にまとめて準備する */
    let fresh = false;
    const add = (m) => { if (this._wxAdd(m)) fresh = true; };
    const walk = (o) => {
      if (o === this.camera) return;
      if (o.material) [].concat(o.material).forEach(add);
      o.children.forEach(walk);
    };
    walk(this.scene);
    /* 車両の材質は空の映りこみを弱めない(ステンレスのつや) */
    if (this.trainKit) Object.values(this.trainKit.M).forEach((m) => { if (m && m.userData) m.userData.envKeep = true; add(m); });
    this._kEnv = -1;
    if (fresh) { this._needPrewarm = true; this._shadowCastAll(); }
  }

  /* 戻り値: はじめて見た材質なら true(this._envMats にまだ無かった) */
  _wxAdd(m) {
    if (!m || !m.isMeshStandardMaterial) return false;
    if (this._envMats.has(m)) return false;
    /* 雨の日に水たまりができる平らな舗装(ホーム・犬走り・街の地面・道路。駅の材質 st-st は駅の部品の名前で見分ける) */
    const M = this.M;
    if (m === M.apron || m === M.plat || m === M.groundUrban || m === M.roadAsphalt || m.name === 'st-st') m.userData.puddle = true;
    /* 車両の材質(_kit から直接呼ばれたときも分かるように) */
    const tk = this.trainKit;
    if (tk && tk.M) { for (const key in tk.M) if (tk.M[key] === m) m.userData.envKeep = true; }
    if (!m.userData.noWeather) installWeather(m, this.U);
    if (m.userData.puddle && m.userData.wxPudU) m.userData.wxPudU.value = 1;
    /* 駅の材質(st-st)は屋根の天井・屋根の上・ベンチなども同じ材質なので、水たまりは屋根のない床だけ。
     * 見分けは駅の頂点属性 stE(屋根のない床=0.1 / 屋根の下の床=0.22 / 天井0.15・照明の帯1 / ほか0) */
    if (m.name === 'st-st' && m.userData.wx && !m.userData.wxPudMask) {
      m.userData.wxPudMask = true;
      const prevPm = m.onBeforeCompile, keyPm = m.customProgramCacheKey;
      m.onBeforeCompile = (sh, r) => {
        prevPm.call(m, sh, r);
        if (sh.fragmentShader.indexOf('varying float vStE;') < 0) return;   // stE が無い作り方なら今までどおり
        sh.fragmentShader = sh.fragmentShader.replace('wxPud = uWet *',
          'wxPud = step( 0.05, vStE ) * ( 1.0 - step( 0.125, vStE ) ) * uWet *');
      };
      m.customProgramCacheKey = () => keyPm.call(m) + '|pm';
      m.needsUpdate = true;
    }
    if (m.userData.env0 === undefined) m.userData.env0 = m.envMapIntensity;
    this._envMats.add(m);
    return true;
  }

  /* ---------- 軌道 ----------
   * 道床(バラストの肩・犬走り)・レール(頭面/腹/底)・枕木の帯・地面は scene/trackbed.js で作る。
   * 複々線の急行線は QUAD_OFF(7.0 / 10.8m)。駅の先で分岐器のようになめらかに分かれる */
  _buildTrack() {
    this.quadOff = QUAD_OFF;
    this._qi = quadInfo(this.line);
    this._exitGlow = null; this._brkCells = null; this._gHidden = null; this._gHideKey = undefined;   // 前の路線の分は使わない
    buildTrackBed(this, { aniso: QUALITY[this.quality].aniso });
    /* 急行線が分かれる・合わさるところの分岐器(長い枕木・トングレール・クロッシング・転てつ機) */
    buildTurnouts(this);
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
      one: new THREE.Vector3(1, 1, 1), zero: new THREE.Matrix4().makeScale(0, 0, 0), X: new THREE.Vector3(1, 0, 0), sc: new THREE.Vector3(1, 1, 1),
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
    /* 架線の線(メートルの太さ)に描画バッファの大きさを教える(変わったときだけ。数の比べっこだけ) */
    const cv = this.renderer && this.renderer.domElement;
    if (cv && (cv.width !== this._wireW || cv.height !== this._wireH)) {
      this._wireW = cv.width; this._wireH = cv.height;
      updateWireRes(this, cv.width, cv.height, this.renderer.getPixelRatio());
    }
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
        /* 分岐器の下: もとの線路の枕木を、分かれていく線路の下までのばす(長さ 2+間隔、中心を間隔/2 だけ左へ) */
        let sx = 1;
        const kk = sp.zone ? (sp.k === 0 ? 1 : -1) : sp.off === 0 ? 0 : -1;
        if (kk >= 0) {
          const sep = quadSep(ss, kk, qi);
          if (sep >= 0.15 && sep < 2.0) { sx = (2 + sep) / 2; off += sep / 2; }
        }
        frameInto(this.frames, this.step, ss, f);
        p.copy(f.p).addScaledVector(f.left, off);
        p.y -= 0.01;
        q.setFromUnitVectors(T.X, f.left);
        m.compose(p, q, sx === 1 ? T.one : T.sc.set(sx, 1, 1));
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
   * 占有グリッド・側道/交差道路/電柱/電線・路地・線路と平行な中高層・戸建て・駅前広場・遠景リング・道を走る車を作る。
   * _buildTownSteps は手順の列(引数なしの関数の配列)。順に全部呼ぶと _buildTown と同じ(あいだで画面を描いてよい) */
  _buildTownSteps() {
    /* 昼夜でテクスチャを差し替える旧方式(_bldMats)はターミナルの駅ビルだけが使う */
    return [() => { this._bldMats = []; this._extraHills = []; }].concat(buildTownSteps(this));
  }

  _buildTown() {
    const steps = this._buildTownSteps();
    for (let i = 0; i < steps.length; i++) steps[i]();
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
    /* 遠くからの目印なので、描く距離の段階で消さない */
    g.traverse((o) => { o.userData.keepFar = true; });
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
    shed.traverse((o) => { o.userData.keepFar = true; });
    this.world.add(shed);
  }

  /* 読売ランド前: まわる観覧車(丘の上。夕方・夜は輪とスポークに電飾) */
  _buildWheel() {
    const F = this.frames;
    this._wheelLights = null; this._wheelGonMat = null;
    const s0 = this._stationS('読売ランド前');
    if (s0 === null) return;
    /* 駅の少し先・左手の丘の上(接近中ずっと前方視界に入る位置) */
    const f = frameAt(F, this.step, s0 + 280);
    const root = new THREE.Group();
    root.position.copy(f.p).addScaledVector(f.left, 145);
    /* 足もとの丘(丘陵と同じ形。_buildHills が植える): 高さ20m。脚の下の端(軸から約41m下)が丘の上に立つように */
    const HILL_H = 20;
    if (!this._extraHills) this._extraHills = [];
    this._extraHills.push({ x: root.position.x, y: f.p.y - 3, z: root.position.z, yaw: Math.atan2(f.t.x, f.t.z), rb: 70, h: HILL_H, sz: 95, s: s0 + 280 });
    root.position.y = f.p.y - 3 + HILL_H * 0.86 + 40;
    root.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), f.left.clone().negate());
    const spin = new THREE.Group();
    spin.userData.dyn = true;   // 毎フレーム回る(行列の更新を止めない)
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
    /* ゴンドラ28台(1回の描画でまとめて)。夜はほのかに明るく(town.js の applyLook) */
    const cols = [0xd6604d, 0xf2b134, 0x4d9dd6, 0x62b56b, 0xb08bd0];
    const gonMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 });
    const gon = new THREE.InstancedMesh(new THREE.BoxGeometry(2.0, 2.4, 2.0), gonMat, 28);
    const gm4 = new THREE.Matrix4(), gc = new THREE.Color();
    for (let i = 0; i < 28; i++) {
      const a = (i / 28) * Math.PI * 2;
      gm4.makeTranslation(Math.cos(a) * 26, Math.sin(a) * 26 - 1.4, 0);
      gon.setMatrixAt(i, gm4);
      gon.setColorAt(i, gc.setHex(cols[i % cols.length]));
    }
    gon.userData.noSplit = true;
    spin.add(gon);
    this._wheelGonMat = gonMat;
    /* 電飾: 輪に64個・スポークに6個ずつ(線路の側の面)。街灯と同じ点の材質の色ちがい(シェーダは同じ) */
    const TM = this._town && this._town.M;
    if (TM && TM.wheelGlow) {
      const pts = [];
      for (let k = 0; k < 64; k++) { const a = (k / 64) * Math.PI * 2; pts.push(Math.cos(a) * 26, Math.sin(a) * 26, 0.75); }
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI + Math.PI / 2;
        [-21, -14, -7, 7, 14, 21].forEach((r) => pts.push(Math.cos(a) * r, Math.sin(a) * r, 0.5));
      }
      const pg = new THREE.BufferGeometry();
      pg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      pg.computeBoundingSphere();
      const lights = new THREE.Points(pg, TM.wheelGlow);
      lights.renderOrder = 2;
      spin.add(lights);
      this._wheelLights = lights;
    }
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
    /* 遠くからの目印なので、描く距離の段階で消さない */
    root.traverse((o) => { o.userData.keepFar = true; });
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

  /* ---------- 踏切(遮断機・警報灯つき) ----------
   * 道路・白線・とまる線・「とまれ」・柱・警報機・踏切警標は線路わきの標識と1つの形に(scene/stations.js)。
   * 踏切ごとの描画は 警報灯2組+腕2本 の4回 */
  _buildCrossings() {
    const F = this.frames;
    this.crossings = [];
    /* 踏切待ちの車は全踏切ぶんを集めて、種類ごとのインスタンスで1回ずつ描く(scene/cars.js) */
    this._crossCarSpots = [];
    this.crossSpots.forEach((s) => {
      const f = frameAt(F, this.step, s);
      const cr = buildCrossingAt(this, f, s);
      /* 踏切待ちの車(両側に1〜3台) */
      this._crossCars(f, s);
      this.crossings.push({ s, arms: cr.arms, lamps: cr.lamps });
    });
    addCars(this, this._crossCarSpots);
    this._crossCarSpots = null;
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
        if (!l) return;
        const on = i % 2 === 0 ? blink : blink2;
        l.material.color.copy(on ? CROSS_LAMP.on : CROSS_LAMP.off);
      });
    });
  }

  /* 街の毎フレーム処理(遠景リングの追従・昼夜の窓明かり・木のLOD)。scene/town.js */
  _updateTown(dt) {
    updateTown(this, dt);
  }

  /* 踏切待ちの車の位置を集める(形・材質は scene/cars.js。左側通行で、線路のほうを向いて止まっている)。
   * 灯火をつけて待っている(インスタンス色の r+2)。踏切が開くと走り出すので(town.js updateTown)、
   * 踏切の位置・向き・道に沿った距離も覚えておく(this._crossCarList: 街の担当) */
  _crossCars(f, s) {
    const TYPES = ['kei', 'minivan', 'sedan'];
    const COLS = [0xf2f2f0, 0xd9dadc, 0x2a2c30, 0x9a2a2a, 0x2c4a7a, 0x8e939a, 0xb8a98c];
    const col = new THREE.Color();
    let seed = Math.floor(s);
    const rnd = () => (seed = (seed * 16807 + 11) % 2147483647) / 2147483647;
    if (!this._crossCarList) this._crossCarList = [];
    [-1, 1].forEach((side) => {
      const n = 1 + Math.floor(rnd() * 2.6);
      for (let i = 0; i < n; i++) {
        const along = side * (13 + i * 5.6 + rnd() * 1.2);   // 線路からの距離(道路方向)
        const lane = side > 0 ? -1.3 : 1.3;                  // 左側通行
        const p = f.p.clone().addScaledVector(f.left, along - 1.9).addScaledVector(f.t, lane);
        /* 前(+z)を線路のほうへ */
        const dx = -side * f.left.x, dz = -side * f.left.z;
        col.setHex(COLS[Math.floor(rnd() * COLS.length)]);
        const sp = {
          x: p.x, y: p.y + 0.14, z: p.z, yaw: Math.atan2(dx, dz), type: TYPES[Math.floor(rnd() * 3) % 3],
          r: col.r + 2, g: col.g, b: col.b, s, sh: true,
          _xs: s, _side: side, _o0: along - 1.9, _lane: lane, _fx: f.p.x, _fy: f.p.y, _fz: f.p.z,
          _lx: f.left.x, _lz: f.left.z, _tx: f.t.x, _tz: f.t.z,
        };
        this._crossCarSpots.push(sp);
        this._crossCarList.push(sp);
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

  /* ---------- 駅舎(駅名看板つき) ----------
   * 駅ごとの型(stationStyle): 'house' = 地上の駅舎(右がわ) / 'over' = 線路の上の駅舎(橋上駅舎) /
   * 'foot' = 跨線橋。over・foot は ホームの奥(st.s-147)で線路をまたぎ、入ってくる運転台のほうへ駅名を出す
   * (外壁は街の事務所ビルと同じ材質で、まとめて1回の描画。柱と階段は駅の形に焼きこみ済み) */
  _buildStationHouses() {
    const F = this.frames;
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x3d4a56, roughness: 0.8 });
    const bodies = [];
    const signOf = (st) => new THREE.MeshBasicMaterial({
      map: boardTexture([
        [`${st.name} 駅`, 36, 34],
        [STATION_KANA[st.name] || '', 70, 18, 'normal'],
      ], { bg: '#f5f8fa', border: '#1b56a7', fg: '#16283a', w: 512, h: 96 }),
    });
    this.line.stations.forEach((st, si) => {
      if (this._inTunnel(st.s)) return;
      if (st.name === '新宿') return;   // 新宿は大屋根ターミナルがあるので省略
      const sty = stationStyle(this, st, si);
      if (sty.kind === 'over' || sty.kind === 'foot') {
        /* 線路をまたぐ駅舎・跨線橋(下は門型ビームの上 7.9m)。右は駅前まで、左は柵の外まで */
        const over = sty.kind === 'over';
        const sc = st.s - STAIR.c, f = frameAt(F, this.step, sc);
        const a = -16, b = Math.max(7.5, fenceOffL(sc, this._qi) + 1.5);
        const sz = over ? 12 : 3.4, sy = over ? 4.4 : 3.0;
        const p = f.p.clone().addScaledVector(f.left, (a + b) / 2);
        bodies.push({ x: p.x, y: f.p.y + 7.9, z: p.z, yaw: Math.atan2(f.t.x, f.t.z), sx: b - a, sy, sz });
        /* 下の面: 天井のパネルと照明の帯・下がり梁(駅の形に焼きこむ。白い板に見えない) */
        concourseUnderside(this, si, sc, a, b, sz);
        /* 駅名の看板: 入ってくる運転台のほうの面(線路の真上) */
        const fs = frameAt(F, this.step, sc - sz / 2 - 0.06);
        const sw = over ? 10 : 8;
        const sign = new THREE.Mesh(new THREE.PlaneGeometry(sw, sw * 0.18), signOf(st));
        sign.position.copy(fs.p);
        sign.position.y += 7.9 + Math.min(2.2, sy - 0.75);
        sign.lookAt(sign.position.clone().addScaledVector(fs.t, -10));
        this.world.add(sign);
        return;
      }
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
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(7.2, 1.3), signOf(st));
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

  /* 大きさが変わっていなければ何もしない(キャンバスの大きさを書きなおすと、描画バッファを取りなおして消すため) */
  resize(w, h) {
    if (w === this._w && h === this._h && this._dprApplied === this.renderer.getPixelRatio()) return;
    this._w = w; this._h = h;
    this.renderer.setSize(w, h, false);
    if (this.composer) this.composer.setSize(w, h);
    this._dprApplied = this.renderer.getPixelRatio();
    this._nSetSize++;
    this._shadowDirty = true;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.cockpit.layoutFor(w / h);
  }

  /* カメラ: 'cab'(運転台) / 'chase'(うしろ上) / 'side'(よこ) / 'front'(線路わきで待ちかまえる) / 'drone'(上空) */
  setCameraMode(mode) {
    this.camMode = mode;
    this._shadowDirty = true;
    this._cullX = 1e9;
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
    /* ターミナルの中: 屋根の奥のはしまで影の箱に入れる(外の太陽を弱めないので、屋根の影で中を暗く保つ) */
    if (this._termCam) sc.top = Math.max(sc.top, 200);
    /* 奥行き: 太陽は箱の中心から430mの所。中心の向こう190m(そらからの箱の大きさ)まで描けば足りる
     * (それより奥の物の影は、見えている地面に落ちない) */
    sc.far = 620;
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
    const fA = frameInto(this.frames, this.step, Math.min(this.line.meta.length - 2, s + 25), this._frA);
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
      /* 運転士の目は 車両の先頭(sim.pos)より 1.0m うしろ(運転台の中)。
       * 停止位置の判定は sim.pos のままなので、ここでは見る位置だけ。毎フレームの new をしない(使い回しの箱) */
      const Lc = L - 2;
      const fe = frameInto(this.frames, this.step, Math.max(1, Math.min(Lc, s - 1.0)), this._eyeF || (this._eyeF = newFrame()));
      const fAhead = frameInto(this.frames, this.step, Math.max(1, Math.min(Lc, s + 42)), this._aheadF || (this._aheadF = newFrame()));
      /* 運転士の目線（左寄り・レール上3.05m）+ 速度に応じた揺れ */
      const eye = (this._eyeV || (this._eyeV = new THREE.Vector3())).copy(fe.p).addScaledVector(fe.left, 0.85);
      eye.y += 3.05;
      const sway = Math.sin(this.clockT * 7.3) * 0.012 + Math.sin(this.clockT * 2.1) * 0.02;
      const bob = Math.sin(this.clockT * 9.1) * 0.008;
      const k = Math.min(1, sim.v / 70);
      eye.addScaledVector(fe.left, sway * k);
      eye.y += bob * k;
      cam.position.copy(eye);
      const look = (this._lookV || (this._lookV = new THREE.Vector3())).copy(fAhead.p).addScaledVector(fAhead.left, 0.55);
      look.y += 2.4;
      cam.lookAt(look);
      /* 体感: ブレーキで視線が沈み、カーブでは内側へ傾き、継ぎ目で小さくはねる(FOVは変えない) */
      cam.rotateX(this._accSm * 0.01 + this._by * 0.25);
      cam.rotateZ(this._roll);
      cam.position.y += this._by * 0.012;
      /* 運転台は車体に固定、目(カメラ)はその中で少し動く: 揺れの一部だけ逆向きに枠をずらす(1〜3px)。
       * f.left はカメラの -x なので、左へのゆれ sway はカメラ座標では +x に。
       * 横ゆれは大きいので係数を小さく(上限 4mm に張りついて カクッと動かないように) */
      if (typeof this.cockpit.setHeadOffset === 'function') {
        this.cockpit.setHeadOffset(sway * k * 0.12, -(bob * k) * 0.5 - this._by * 0.006,
          -(this._accSm * 0.01 + this._by * 0.25) * 0.5, -this._roll * 0.5);
      }
      cam.fov = 58;
      this._camS = s - 1.0;
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
    /* 外からの視点では運転台を描かないので、頭のずれはもどしておく */
    if (mode !== 'cab' && typeof this.cockpit.setHeadOffset === 'function') this.cockpit.setHeadOffset(0, 0, 0, 0);
    cam.updateProjectionMatrix();
  }

  /* 運転台(3Dの窓まわり)の明かり・ワイパー・雪・時計・時刻表。render() から毎フレーム呼ばれる。
   *  light: 室内の明るさ(なめらかにするのは cockpit 側。計器盤 #cab も cockpit.light で同じ明るさになる)
   *    昼1 / 雨.7 / 雪.85 / 夕方.55 / 夜.16。ターミナル(明るい屋根の下)は .72 以上、トンネルは .3 以下、
   *    ホームに いるあいだは 夜.46・夕方.62 以上(地下のホームは .5 以上)
   *  flash: トンネルの灯具(12mごと)が窓の上を通るときの 速い明かり(3Dの枠と天板だけ。計器盤には入れない)
   *  tint: 枠の色み(屋内は青白・夕方は だいだい・夜は青・雨は少し青)
   * 毎フレームの new をしない(渡す箱は使い回し) */
  _updateCockpit(dt, s, indoorEye) {
    const ck = this.cockpit, sim = this.sim;
    if (!ck || !sim) return;
    const tod = this.timeOfDay, night = tod === 'night', eve = tod === 'evening';
    const wx = this.weather, rain = wx === 'rain', snow = wx === 'snow';
    const inTerm = this._inTerminal(s + 3, -6), inTun = this._inTunnel(s + 3);
    const ie = typeof indoorEye === 'boolean' ? indoorEye : (inTerm || inTun);
    let light = night ? 0.16 : eve ? 0.55 : rain ? 0.7 : snow ? 0.85 : 1;
    if (inTerm) light = Math.max(light, 0.72);
    else if (inTun) light = Math.min(light, 0.3);
    /* ホーム(停止位置の175m手前〜30m先)にいるか(毎フレームなので for で。関数を作らない) */
    let atPlat = false;
    const sts = this.line.stations;
    for (let i = 0; i < sts.length; i++) {
      const st = sts[i];
      if (s > st.s - 175 && s < st.s + 30) { atPlat = true; break; }
    }
    if (atPlat && !inTun) light = Math.max(light, night ? 0.46 : eve ? 0.62 : light);
    if (atPlat && inTun) light = Math.max(light, 0.5);
    /* トンネルの灯具の明かり: 灯具は s = 12k + 6 (trackbed.js の TUN_LAMP の pitch 12 / phase 6 と同じ数。
     * 駅の担当の buildTunnelLights が置く)。目(先頭の1mうしろ)の 2mほど前を灯具が通るときに いちばん明るい。
     * 速いほど はっきり(止まっているときは 0) */
    let flash = 0;
    if (inTun && !atPlat && this.camMode === 'cab') {
      const e = s - 1.0;
      let x = ((((6 - e) % 12) + 12) % 12) - 2;   // つぎの灯具までの前向きの距離 - 2m
      if (x > 6) x -= 12;
      const g = x * (7 / 12);
      flash = 0.16 * Math.exp(-g * g) * Math.min(1, sim.v / 30);
    }
    const o = this._ckO || (this._ckO = { light: 1, flash: 0, tr: 1, tg: 1, tb: 1, night: false, wiper: false, snow: false, clockMin: 0 });
    o.light = light;
    o.flash = flash;
    /* 枠の色み(見た目の比率)。屋内 → 夕方 → 夜 → ぬれ の順にきめる */
    if (inTerm || inTun) { o.tr = 0.95; o.tg = 1; o.tb = 1.06; }
    else if (eve) { o.tr = 1.14; o.tg = 0.96; o.tb = 0.8; }
    else if (night) { o.tr = 0.9; o.tg = 0.95; o.tb = 1.08; }
    else if (rain || snow) { o.tr = 0.97; o.tg = 0.99; o.tb = 1.02; }
    else { o.tr = 1; o.tg = 1; o.tb = 1; }
    o.night = night;
    /* ワイパー: 雨は 'on'(つづけて)、雪は 'int'(間をあけて)、屋内・外のカメラでは止める */
    o.wiper = ie || this.camMode !== 'cab' ? false : rain ? 'on' : snow ? 'int' : false;
    o.snow = snow && !ie;
    /* 天板の時計(ゲーム内の 時:分。計器盤のモニタと同じ: 夜19時・夕方16時・昼10時はじまり) */
    const baseHour = night ? 19 : eve ? 16 : 10;
    o.clockMin = Math.floor((sim.t + baseHour * 3600) / 60);
    /* 雨のガラス(ui/rainglass.js)が 粒の数の上限を きめるのに使う */
    ck.quality = this.quality;
    /* 天板の時刻表: 運転・つぎの駅が かわったときだけ書きなおす */
    if (typeof ck.setTimetable === 'function' && (this._ttSim !== sim || this._ttIdx !== sim.stopIdx)) {
      this._ttSim = sim;
      this._ttIdx = sim.stopIdx;
      const names = [];
      const stops = sim.stops || [];
      for (let i = 0; i < stops.length; i++) names.push(stops[i].name);
      ck.setTimetable(names, sim.stopIdx);
    }
    ck.update(dt, o);
  }

  /* 目の慣れ: カメラがトンネル・ターミナルにいると暗く(k<1)。
   * 光(k)は出入り口の30mで0.4秒ほどで変わる。目(露出 _kE)は遅れて追いかける:
   * 入るときは約2.2秒(しばらく暗い)、出るときは約0.9秒(しばらくまぶしい=白くにじむ) */
  _updateLightLevel(dt) {
    const s = this._camS;
    let kT = 1, kfT = 1, wxT = 1, indoor = false, term = false;
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
        term = true;
        /* ターミナルの屋根の下も乾いている(線路側の出口に近づくと外の雪・ぬれが見えてくる) */
        const T = this.terminal;
        wxT = Math.max(0, 1 - (T.up ? s - T.a : T.b - s) / 60);
      }
    }
    /* ターミナルの中にいるか(外の太陽を弱めない・影の箱を屋根の奥まで)。変わったら影の箱を作りなおす */
    if (term !== !!this._termCam) {
      this._termCam = term;
      this._shadowBox(this.camMode);
      this._shadowDirty = true;
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
    /* ターミナルを出た直後も、目の慣れ(k)が外にもどるまでは太陽を弱めない(出口で外が一瞬暗くならないように) */
    this._termSun = term || (!jump && !!this._termSun && this._k < 0.99);
    /* 出口の先の白いかすみ(昼・夕方の くだり=前方に出口があるときだけ。夜の外は暗いので しない。_termD: 出口までの距離) */
    const T = this.terminal;
    if (T && !T.up && this.timeOfDay !== 'night' && (term || this._termSun)) {
      this._termD = Math.max(0, T.b - s);
      this._termW = term ? 1 : Math.max(0, Math.min(1, (1 - this._k) / 0.7));
    } else this._termW = 0;
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
    /* _shS: 影の箱の中心の線路上の位置(ほかの列車が影の箱の中で動いているかを見るのに使う) */
    if (mode === 'front' && this._frontCamS != null) {
      tgt.copy(f.p).lerp(frameAt(this.frames, this.step, Math.min(this.line.meta.length - 2, this._frontCamS)).p, 0.5);
      this._shS = (s + this._frontCamS) / 2;
    } else {
      const ahead = mode === 'cab' ? 60 : mode === 'drone' ? 110 : mode === 'chase' ? 30 : -20;
      tgt.copy(f.p).addScaledVector(f.t, ahead);
      this._shS = s + ahead;
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

  /* GPUの おくれ見張り: 2コマ前に入れたフェンスが まだなら true(このコマは描かない)。
   * GPUが追いつかない(ソフト描画・重い場面)ときに 命令が何秒ぶんも たまると、画面の大きさを変えるなどの
   * 「待ち合わせ」で その全部を待って止まる。2コマまでに おさえて、入力から絵までの おくれも小さくする。
   * 2秒以上まっても終わらないときは描く(止まりつづけない)。フェンスのない環境(WebGL1)では何もしない */
  _paceSkip(dt) {
    const f = this._fences[this._fi];
    if (!f) return false;
    const gl = this.renderer.getContext();
    let done = true;
    const t0 = performance.now();
    try { done = gl.getSyncParameter(f, gl.SYNC_STATUS) === gl.SIGNALED; } catch (e) { done = true; }
    const now = performance.now();
    /* フェンスをのぞくだけで待たされる環境(問い合わせがGPUとの待ち合わせになる)では、見張りをやめる
     * (30回のうち半分より多く 2ms 以上かかったら) */
    this._paceN = (this._paceN || 0) + 1;
    if (now - t0 > 2) this._paceSlow = (this._paceSlow || 0) + 1;
    if (this._paceN >= 30) {
      if ((this._paceSlow || 0) > 15) { this._paceOff = true; this._fences = [null, null]; return false; }
      this._paceN = 0; this._paceSlow = 0;
    }
    if (!done) {
      if (!this._skipT0) this._skipT0 = now;
      if (now - this._skipT0 < 2000) {
        this._skipDt = Math.min(0.25, this._skipDt + (dt > 0 ? dt : 0));
        this._skipN++;
        return true;
      }
    }
    this._skipT0 = 0;
    try { gl.deleteSync(f); } catch (e) { /* noop */ }
    this._fences[this._fi] = null;
    return false;
  }

  /* 描いたコマの終わりにフェンスを入れる(2つを交互に使う) */
  _paceMark() {
    if (this._paceOff) return;
    const gl = this.renderer.getContext();
    if (!gl || typeof gl.fenceSync !== 'function') return;
    const i = this._fi;
    if (this._fences[i]) { try { gl.deleteSync(this._fences[i]); } catch (e) { /* noop */ } }
    let f = null;
    try { f = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); } catch (e) { f = null; }
    this._fences[i] = f;
    this._fi = i ^ 1;
  }

  /* 毎フレーム描画 */
  render(dt) {
    /* 準備中(prewarmAsync・少しずつ作るワールド)・文脈が消えた・ワールドがまだない ときは描かない */
    if (this._warming || this.glLost || !this.frames || !this.sim) return;
    /* GPUが2コマ前の絵を まだ描き終えていなければ、このコマは描かない(描かなかった時間は次のコマに足す)。
     * dt=0 の1回だけの描きなおし(一時停止・成績票の うしろ・準備のあと)は かならず描く */
    if (dt > 0 && this._paceSkip(dt)) return;
    if (this._skipDt > 0) { dt += this._skipDt; this._skipDt = 0; }
    this.clockT += dt;
    const sim = this.sim;
    const L = this.line.meta.length;
    const s = Math.max(0, Math.min(L - 2, sim.pos));
    const f = frameInto(this.frames, this.step, s, this._fr);
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

    /* 信号の現示は _updatePeople → _updateSignals(scene/signage.js)で、近くの変わった灯だけ書きかえる */

    /* ほかの列車・自列車 */
    if (this.traffic) this.traffic.update(dt);

    /* 停止位置の光の目印(つぎに とまる駅だけ) */
    this._updateStopPin(s, L);
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
    /* 運転台の明るさ・ワイパー・雪(scene の _updateCockpit があればそちらで。なければ ここで) */
    if (typeof this._updateCockpit === 'function') {
      this._updateCockpit(dt, s, indoorEye);
    } else {
      let light = tod === 'night' ? 0.16 : tod === 'evening' ? 0.55 : this.weather === 'rain' ? 0.7 : this.weather === 'snow' ? 0.85 : 1;
      if (indoorEye) light = Math.min(light, 0.3);
      /* ワイパー: 雨は 'on'(つづけて)、雪は 'int'(間をあけて)、屋内・外のカメラでは止める */
      const wiper = indoorEye || this.camMode !== 'cab' ? false : this.weather === 'rain' ? 'on' : this.weather === 'snow' ? 'int' : false;
      this.cockpit.update(dt, { light, night: tod === 'night', wiper, snow: this.weather === 'snow' && !indoorEye });
    }
    /* 雨・雪の粒(4つめ: 線路の高さ。雪の床の高さに使う) */
    if (this.weatherFx) this.weatherFx.update(dt, sim.v / 3.6, indoorEye && this.camMode === 'cab', f.p.y);

    /* 走っている間に届いた空(HDR)は、止まっているときに使いはじめる */
    if (this._lateN && (sim.ended || sim.v < 0.05)) this._promoteEnv(true);
    /* 時間帯・天気が変わった直後は、描く前に使うシェーダをまとめて準備 */
    if (this._needPrewarm) {
      /* 同じ路線・時間帯・天気・空の形式のまま(タイトルへ もどる・同じ条件で もう一回 など)で
       * 前の準備が そろっているなら シェーダは同じ。いっきに準備しなおさない(iPadで止まる) */
      const W = this._warmDone;
      if (W && W.gen === this._worldGen && !this._worldNew && W.sig === this._warmSig()) this._needPrewarm = false;
      else this.prewarm(true);
    }
    this._updateShadow(dt);
    /* 遠景クリップより遠いセルは描かない */
    this._cullTick(false);
    this._frame++;
    /* (debug) 固めた物が動いていないか(120フレームごと) */
    if (this._frzSnap && this._frame % 120 === 0) this._freezeCheck();
    if (this.composer) {
      if (this.bloom) this.bloom.enabled = this._bloomOn();
      this.composer.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
    /* 運転台の重ね描き(キャンバスへ直接。あれば) */
    const ck = this.cockpit;
    if (ck && typeof ck.renderOverlay === 'function') ck.renderOverlay(this.renderer, this.camera);
    this.drawCount++;
    this._paceMark();

    /* fps計測(自動軽量化・デバッグ用) */
    if (dt > 0) {
      this._fpsAcc += dt; this._fpsN++;
      if (this._fpsAcc > 1.2) {
        this.fps = this._fpsN / this._fpsAcc;
        this._fpsAcc = 0; this._fpsN = 0;
      }
    }
  }

  /* 停止位置の光の目印(つぎに とまる駅だけ)と、画面の「8」の目印(ui/stoppin.js)の位置 scene.stopPin。
   * stopPin: { vis, x, y(画面の 0〜1), d(「8」まで m), dist(カメラから 板の中心まで 視線の向きの m),
   *            fov(カメラの たての画角 度), size(板の大きさ m) }
   * 目印は 板の中心(レール面から _stop8Y m)を さす。近づくと stoppin.js が 目印を 板に かさねて 消す */
  _updateStopPin(s, L) {
    const sim = this.sim;
    const nxt = sim.stops[sim.stopIdx];
    const pin = this.stopPin;
    if (this.guide !== false && nxt && !sim.doorOpen && nxt.stopAt - sim.pos < 650 && nxt.stopAt - sim.pos > -2) {
      /* 「8」の標識が停止位置より a8 m 先に立つとき(駅の側で _stop8Ahead を決める)は、その柱の位置に。
       * 横の位置は駅の側の _stop8Lat(なければ 標識の柱 1.93m / 標識なし 2.3m) */
      const hasB = this._stop8Ahead != null;
      const a8 = hasB ? this._stop8Ahead : 0;
      const lat = this._stop8Lat != null ? this._stop8Lat : (a8 ? 1.93 : 2.3);
      const fb = frameInto(this.frames, this.step, Math.min(L - 2, nxt.stopAt + a8), this._frB);
      this.stopBeam.position.copy(fb.p).addScaledVector(fb.left, lat);
      this.stopBeam.position.y += 4.4;
      /* 運転台から見て のこり 30m からは 光の柱も うすくして 12m で消す(黒い「8」の板だけが のこる) */
      const d8 = nxt.stopAt - sim.pos;
      const u8 = this.camMode === 'cab' ? Math.min(1, Math.max(0, (d8 - 12) / 18)) : 1;
      const k8 = u8 * u8 * (3 - 2 * u8);
      this._beamMat.opacity = (0.5 + 0.22 * Math.sin(this.clockT * 4)) * k8;
      this.stopBeam.visible = k8 > 0.01;
      /* 画面の目印(ui/stoppin.js)の位置: 板の中心(駅の側の _stop8Y。なければ レール面から2.8m)を、いまのカメラで画面へ写す */
      if (this.camMode === 'cab') {
        const cam = this.camera;
        cam.updateMatrixWorld();
        _pinV.copy(fb.p).addScaledVector(fb.left, lat);
        _pinV.y = fb.p.y + (this._stop8Y != null ? this._stop8Y : 2.8);
        /* project() と同じ2段(先に 視線の向きの きょりを とる。板が画面で何pxになるかに使う) */
        _pinV.applyMatrix4(cam.matrixWorldInverse);
        pin.dist = -_pinV.z;
        _pinV.applyMatrix4(cam.projectionMatrix);
        pin.vis = pin.dist > 0.1 && _pinV.z < 1 && Math.abs(_pinV.x) < 1 && Math.abs(_pinV.y) < 1;
        pin.x = (_pinV.x + 1) / 2;
        pin.y = (1 - _pinV.y) / 2;
        pin.d = d8;
        pin.fov = cam.fov;
        pin.size = this._stop8Size || 0.5;
      } else {
        pin.vis = false;
      }
    } else {
      this.stopBeam.visible = false;
      pin.vis = false;
    }
  }
}
