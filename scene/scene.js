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
import { buildTown, updateTown, makeTreeGeosP1, plantTreesP1, buildHillsP1, stationBodiesP1, makeRng, occFree } from './town.js';
import { TrainKit } from './trains.js';
import { WeatherFx } from './weatherfx.js';

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
 * vcol(i, u01) を渡すと頂点色を付ける（地面のムラ・市街地の色調に使用） */
function ribbon(frames, i0, i1, offset, width, lift, uvScale, vcol) {
  const pos = [], uv = [], idx = [], col = [];
  let n = 0;
  for (let i = i0; i <= i1; i++) {
    const f = frames[i];
    const c = f.p.clone().addScaledVector(f.left, offset);
    const l = c.clone().addScaledVector(f.left, width / 2);
    const r = c.clone().addScaledVector(f.left, -width / 2);
    pos.push(l.x, l.y + lift, l.z, r.x, r.y + lift, r.z);
    const v = (i * 5) / uvScale;
    uv.push(0, v, 1, v);
    if (vcol) { const a = vcol(i, 0), b = vcol(i, 1); col.push(a[0], a[1], a[2], b[0], b[1], b[2]); }
    if (i > i0) {
      const a = n - 2, b = n - 1, c2 = n, d = n + 1;
      idx.push(a, c2, b, b, c2, d);
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
  return g;
}

/* 長い帯(ribbon/vribbon)を行単位でいくつかに切り分ける(視錐台カリングを効かせるため) */
function splitRows(g, rowsPer) {
  const rows = g.userData.rows;
  const out = [];
  const A = g.attributes;
  for (let r0 = 0; r0 < rows - 1; r0 += rowsPer) {
    const r1 = Math.min(rows - 1, r0 + rowsPer);
    const ng = new THREE.BufferGeometry();
    Object.keys(A).forEach((k) => {
      const it = A[k].itemSize;
      ng.setAttribute(k, new THREE.Float32BufferAttribute(A[k].array.slice(r0 * 2 * it, (r1 + 1) * 2 * it), it));
    });
    const idx = [];
    const flip = g.userData.vr;
    for (let r = 1; r <= r1 - r0; r++) {
      const n = r * 2;
      if (flip) idx.push(n - 2, n, n - 1, n - 1, n, n + 1);
      else idx.push(n - 2, n, n - 1, n - 1, n, n + 1);
    }
    ng.setIndex(idx);
    ng.computeBoundingSphere();
    out.push(ng);
  }
  return out;
}

/* 縦の帯（壁・レール腹・柵など。UV: u=距離/uvScale, v=縦0..1） */
function vribbon(frames, i0, i1, offset, y0, y1, uvScale) {
  const pos = [], uv = [], idx = [];
  let n = 0;
  for (let i = i0; i <= i1; i++) {
    const f = frames[i];
    const b = f.p.clone().addScaledVector(f.left, offset);
    pos.push(b.x, b.y + y0, b.z, b.x, b.y + y1, b.z);
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

  /* 全線ぶんを1つにまとめた InstancedMesh は視錐台カリングが効かず、21kmぶんの
   * 木やビルを毎フレーム全部描いてしまう。約700m四方のマスごとに分割して、
   * 画面に入るマスだけ描かれるようにする(三角形数がおよそ1/5になる) */
  _splitRibbons() {
    const ROWS = 150;   // 5m×150 = 750m ごと
    this.world.children.slice().forEach((o) => {
      if (!o.isMesh || o.isInstancedMesh || !o.geometry.userData.rows || o.geometry.userData.rows <= ROWS * 1.5) return;
      const parts = splitRows(o.geometry, ROWS);
      parts.forEach((ng) => {
        const m = new THREE.Mesh(ng, o.material);
        m.castShadow = o.castShadow; m.receiveShadow = o.receiveShadow; m.renderOrder = o.renderOrder;
        m.position.copy(o.position); m.quaternion.copy(o.quaternion); m.scale.copy(o.scale);
        this.world.add(m);
      });
      this.world.remove(o);
      o.geometry.dispose();
    });
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

  /* ---------- 軌道 ---------- */
  _buildTrack() {
    const F = this.frames, N = F.length - 1;
    const recv = (m) => { m.receiveShadow = true; return m; };

    /* 1本のレール: 頭面(金属)+両側の腹(垂直帯) */
    const addRail = (offset, full) => {
      this.world.add(recv(new THREE.Mesh(ribbon(F, 0, N, offset, 0.068, 0.19, 25), this.M.railHead)));
      this.world.add(new THREE.Mesh(vribbon(F, 0, N, offset + 0.034, 0.05, 0.178, 8), this.M.railWeb));
      if (full) this.world.add(new THREE.Mesh(vribbon(F, 0, N, offset - 0.034, 0.05, 0.178, 8), this.M.railWeb));
    };
    const addTrack = (offset, full) => {
      this.world.add(recv(new THREE.Mesh(ribbon(F, 0, N, offset, 4.2, 0, 2.5), this.M.ballast)));
      [-RAIL_HALF, RAIL_HALF].forEach((o) => addRail(offset + o, full));
    };
    addTrack(0, true);       // 自列車（下り）
    addTrack(-3.8, true);    // 上り線

    /* 複々線区間: 急行線2本を追加(頭面+外側の腹のみ) */
    const q = this.line.sections.quad;
    const qi0 = Math.floor(q.from / this.step), qi1 = Math.ceil(q.to / this.step);
    [3.8, 7.6].forEach((off) => {
      this.world.add(recv(new THREE.Mesh(ribbon(F, qi0, qi1, off, 4.2, 0, 2.5), this.M.ballast)));
      [-RAIL_HALF, RAIL_HALF].forEach((o) => {
        this.world.add(recv(new THREE.Mesh(ribbon(F, qi0, qi1, off + o, 0.068, 0.19, 25), this.M.railHead)));
        this.world.add(new THREE.Mesh(vribbon(F, qi0, qi1, off + o + 0.034, 0.05, 0.178, 8), this.M.railWeb));
      });
    });

    /* 軌道間の埋め（複線間・肩） */
    this.world.add(recv(new THREE.Mesh(ribbon(F, 0, N, -1.9, 3.0, -0.18, 3.0), this.M.sub)));
    /* 保守通路 */
    this.world.add(recv(new THREE.Mesh(ribbon(F, 0, N, 3.6, 3.0, -0.12, 3.0), this.M.apron)));
    this.world.add(recv(new THREE.Mesh(ribbon(F, 0, N, -7.2, 3.0, -0.12, 3.0), this.M.apron)));

    /* 地形（線路に沿った広い帯。標高に追従するので遠くまで地面がある）
     * 多摩川の区間だけは水面が見えるように帯を切る */
    const urban = this.line.sections.urban;
    const kindOf = (s) => (urban.find((u) => s >= u.from && s < u.to) || { kind: 2 }).kind;
    const gVcol = (i, u) => {
      const s = i * this.step;
      const n = 0.86 + 0.11 * Math.sin(s * 0.013 + u * 2.1) * Math.sin(s * 0.0047 + 3.1)
        + 0.05 * Math.sin(s * 0.041 + u * 5.3);
      const k = kindOf(s);
      /* 市街地ほど芝の緑を殺して乾いた土色に寄せる */
      const urb = k === 0 ? 0.88 : k === 1 ? 0.7 : k === 2 ? 0.36 : 0.18;
      const r = n * (1 + (0.66 - 1) * urb);
      const g = n * (1 + (0.63 - 1) * urb);
      const b = n * (1 + (0.55 - 1) * urb);
      /* 頂点色はリニア解釈なので、見た目(sRGB)の減光率に合わせてガンマ変換 */
      return [Math.pow(r, 2.2), Math.pow(g, 2.2), Math.pow(b, 2.2)];
    };
    const cuts = this.line.sections.river.map((r) => [r.from - 240, r.to + 240]);
    let segStart = 0;
    const addGround = (i0, i1) => {
      if (i1 - i0 < 4) return;
      this.world.add(new THREE.Mesh(ribbon(F, i0, i1, 260.5, 512, -0.5, 5, gVcol), this.M.ground));
      this.world.add(new THREE.Mesh(ribbon(F, i0, i1, -264, 512, -0.5, 5, gVcol), this.M.ground));
    };
    cuts.sort((a, b) => a[0] - b[0]).forEach(([cf, ct]) => {
      addGround(Math.floor(segStart / this.step), Math.floor(cf / this.step));
      segStart = ct;
    });
    addGround(Math.floor(segStart / this.step), N);
    this.world.children.forEach((o) => { if (o.material === this.M.ground) o.receiveShadow = true; });
  }

  /* ---------- 枕木(自列車近傍のみ実体を置くムービングウィンドウ) ---------- */
  _buildSleepers() {
    const geo = new THREE.BoxGeometry(2.0, 0.14, 0.24);   // 狭軌用の枕木
    /* own: -45..+195, up: -45..+140 (間隔0.625m) */
    this._slpSpec = [
      { off: 0, back: 45, fwd: 195 },
      { off: -3.8, back: 45, fwd: 140 },
    ];
    let total = 0;
    this._slpSpec.forEach((sp) => { sp.count = Math.floor((sp.back + sp.fwd) / 0.625); total += sp.count; });
    this.sleepers = new THREE.InstancedMesh(geo, this.M.sleeper, total);
    this.sleepers.userData.noSplit = true;
    this.sleepers.frustumCulled = false;
    this.sleepers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.world.add(this.sleepers);
    this._slpBase = -1e9;
    this._updateSleepers(0);
  }

  _updateSleepers(s) {
    if (Math.abs(s - this._slpBase) < 12) return;
    this._slpBase = s;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(1, 1, 1);
    const X = new THREE.Vector3(1, 0, 0);
    let n = 0;
    const L = this.line.meta.length;
    this._slpSpec.forEach((sp) => {
      const s0 = Math.floor((s - sp.back) / 0.625) * 0.625;
      for (let i = 0; i < sp.count; i++) {
        const ss = s0 + i * 0.625;
        if (ss < 2 || ss > L - 2) {   // 範囲外は潰して非表示に
          m.makeScale(0, 0, 0);
          this.sleepers.setMatrixAt(n++, m);
          continue;
        }
        const f = frameAt(this.frames, this.step, ss);
        const p = f.p.clone().addScaledVector(f.left, sp.off);
        p.y -= 0.01;
        q.setFromUnitVectors(X, f.left);
        m.compose(p, q, sc);
        this.sleepers.setMatrixAt(n++, m);
      }
    });
    this.sleepers.instanceMatrix.needsUpdate = true;
  }

  /* ---------- 架線柱と架線 ---------- */
  _buildLineside() {
    const F = this.frames;
    const poleGeo = new THREE.CylinderGeometry(0.14, 0.17, 7.6, 6);
    const armGeo = new THREE.BoxGeometry(8.4, 0.14, 0.14);
    const mat = new THREE.MeshStandardMaterial({ color: 0x565e63, metalness: 0.6, roughness: 0.55 });
    const count = Math.floor(this.line.meta.length / 45);
    const poles = new THREE.InstancedMesh(poleGeo, mat, count);
    const arms = new THREE.InstancedMesh(armGeo, mat, count);
    poles.castShadow = true; arms.castShadow = true;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(1, 1, 1);
    let n = 0;
    const poleS = [];
    for (let s = 20; s < this.line.meta.length - 20 && n < count; s += 45) {
      const f = frameAt(F, this.step, s);
      const inTun = this._inTunnel(s);
      if (inTun || this._inTerminal(s, 4)) continue;
      poleS.push(s);
      const side = -6.4;   // 上り線の外側
      const p = f.p.clone().addScaledVector(f.left, side);
      p.y += 3.8;
      q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), f.left);
      m.compose(p, q, sc);
      poles.setMatrixAt(n, m);
      const pa = f.p.clone().addScaledVector(f.left, -2.2);
      pa.y += 6.4;
      m.compose(pa, q, sc);
      arms.setMatrixAt(n, m);
      n++;
    }
    poles.count = n; arms.count = n;
    this.world.add(poles, arms);

    /* トロリ線（自線と上り線の上・全線） */
    const wireMat = new THREE.LineBasicMaterial({ color: 0x2b2f33 });
    [0, -3.8].forEach((off) => {
      const pos = [];
      for (let i = 0; i < F.length; i += 2) {
        const f = F[i];
        const p = f.p.clone().addScaledVector(f.left, off);
        pos.push(p.x, p.y + 5.1, p.z);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      this.world.add(new THREE.Line(g, wireMat));
    });

    /* 吊架線(径間で垂れる)+ハンガー: 架線柱の径間ごとに生成 */
    const segs = [];
    const sag = 0.5, topY = 6.1, troY = 5.1;
    [0, -3.8].forEach((off) => {
      for (let i = 0; i + 1 < poleS.length; i++) {
        const a = poleS[i], b = poleS[i + 1];
        if (b - a > 60) continue;   // トンネル等で径間が飛んだ所は張らない
        let prev = null;
        for (let k = 0; k <= 4; k++) {
          const t = k / 4;
          const s = a + (b - a) * t;
          const f = frameAt(F, this.step, s);
          const p = f.p.clone().addScaledVector(f.left, off);
          const yy = p.y + topY - sag * (4 * t * (1 - t));
          const pt = [p.x, yy, p.z];
          if (prev) segs.push(prev[0], prev[1], prev[2], pt[0], pt[1], pt[2]);
          prev = pt;
          if (k > 0 && k < 4) segs.push(p.x, yy, p.z, p.x, p.y + troY, p.z);   // ハンガー
        }
      }
    });
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3));
    this.world.add(new THREE.LineSegments(wg, wireMat));
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

  /* ---------- 街並み(scene/town.js) ----------
   * 占有グリッド・側道/交差道路/電柱/電線・線路と平行な中高層・戸建て・遠景リングを作る */
  _buildTown() {
    /* 昼夜でテクスチャを差し替える旧方式(_bldMats)はターミナルの駅ビルだけが使う */
    this._bldMats = [];
    buildTown(this);
  }

  /* ---------- 沿線の柵・防音壁 ---------- */
  _buildFences() {
    const F = this.frames, L = this.line.meta.length;
    const urban = this.line.sections.urban;
    const kindAt = (s) => (urban.find((u) => s >= u.from && s < u.to) || { kind: 2 }).kind;
    const q = this.line.sections.quad;
    const nearStation = (s) => this.line.stations.some((st) => s > st.s - 170 && s < st.s + 30);
    const inRiver = (s) => this.line.sections.river.some((r) => s > r.from - 30 && s < r.to + 30);
    const matWall = new THREE.MeshStandardMaterial({ map: this.T.concWallC, color: 0xc8c6be, roughness: 0.95, side: DS });
    matWall.envMapIntensity = 1.35;
    const matFence = new THREE.MeshStandardMaterial({
      map: texFence(), alphaTest: 0.3, side: DS, roughness: 0.8, metalness: 0.3,
    });
    const emit = (run) => {
      const i0 = Math.floor(run.s0 / this.step), i1 = Math.ceil(run.s1 / this.step);
      if (i1 - i0 < 3) return;
      if (run.type === 'wall') {
        const wMesh = new THREE.Mesh(vribbon(F, i0, i1, run.off, -0.4, 1.9, 3), matWall);
        wMesh.castShadow = true;
        this.world.add(wMesh);
      } else {
        this.world.add(new THREE.Mesh(vribbon(F, i0, i1, run.off, -0.25, 1.05, 2), matFence));
      }
    };
    const nearCross = (s) => this.crossSpots.some((c) => Math.abs(c - s) < 14);
    for (const side of [1, -1]) {
      let cur = null;
      for (let s = 25; s < L - 25; s += 5) {
        let type = null;
        if (!this._inTunnel(s) && !nearStation(s) && !inRiver(s) && !nearCross(s) && !this._inTerminal(s, 5)) {
          type = kindAt(s) <= 1 ? 'wall' : 'fence';
        }
        let off = side > 0 ? 5.4 : -8.9;
        if (side > 0 && s > q.from - 30 && s < q.to + 30) off = 9.6;
        if (type === null) {
          if (cur) { emit(cur); cur = null; }
        } else if (!cur || cur.type !== type || cur.off !== off) {
          if (cur) emit(cur);
          cur = { s0: s, s1: s, type, off };
        } else {
          cur.s1 = s;
        }
      }
      if (cur) emit(cur);
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

  /* ---------- トンネル（下北沢地下区間） ---------- */
  _buildTunnel() {
    const F = this.frames;
    const mat = this.M.tunnel;
    const dim = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45, side: DS, depthWrite: false });
    this.line.sections.tunnel.forEach((t) => {
      const i0 = Math.floor(t.from / this.step), i1 = Math.ceil(t.to / this.step);
      this.world.add(new THREE.Mesh(vribbon(F, i0, i1, 7.2, -0.5, 6.2, 6), mat));
      this.world.add(new THREE.Mesh(vribbon(F, i0, i1, -9.5, -0.5, 6.2, 6), mat));
      this.world.add(new THREE.Mesh(ribbon(F, i0, i1, -1.15, 17, 6.2, 6), mat));
      /* 地表の明るさをトンネル内だけ抑える減光膜(駅ホーム部は照明ありとして除外) */
      const stops = this.line.stations.filter((st) => st.s > t.from && st.s < t.to);
      let s0 = t.from;
      const ranges = [];
      stops.forEach((st) => { ranges.push([s0, st.s - 175]); s0 = st.s + 30; });
      ranges.push([s0, t.to]);
      ranges.forEach(([a, b]) => {
        if (b - a < 30) return;
        const ia = Math.max(0, Math.floor(a / this.step)), ib = Math.min(F.length - 1, Math.ceil(b / this.step));
        this.world.add(new THREE.Mesh(ribbon(F, ia, ib, -1.8, 11.8, 0.3, 40), dim));
      });
      /* 坑口 */
      [t.from, t.to].forEach((s) => {
        const f = frameAt(F, this.step, s);
        const portal = new THREE.Mesh(new THREE.BoxGeometry(19, 9.5, 1.2),
          new THREE.MeshStandardMaterial({ map: this.T.concC, color: 0xc7c5bd, roughness: 0.95 }));
        portal.position.copy(f.p).addScaledVector(f.left, -1.15);
        portal.position.y += 3.6;
        portal.lookAt(portal.position.clone().add(f.t));
        portal.castShadow = true;
        this.world.add(portal);
      });
      /* トンネル照明 */
      const lampGeo = new THREE.BoxGeometry(0.12, 0.12, 1.3);
      const lampMat = new THREE.MeshBasicMaterial({ color: 0xd8e6c8 });
      const count = Math.floor((t.to - t.from) / 18);
      const lamps = new THREE.InstancedMesh(lampGeo, lampMat, count);
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
      for (let i = 0; i < count; i++) {
        const f = frameAt(F, this.step, t.from + i * 18);
        q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), f.t);
        m4.compose(new THREE.Vector3().copy(f.p).addScaledVector(f.left, 3.1).setY(f.p.y + 5.4), q, new THREE.Vector3(1, 1, 1));
        lamps.setMatrixAt(i, m4);
      }
      this.world.add(lamps);
    });
  }

  /* ---------- 多摩川橋梁 ---------- */
  _buildRiver() {
    const F = this.frames;
    const dryVcol = (i, u) => {
      const s = i * this.step;
      const n = 0.85 + 0.1 * Math.sin(s * 0.021 + u * 3.3) * Math.sin(s * 0.006 + 1.2);
      return [Math.pow(n * 1.02, 2.2), Math.pow(n * 0.97, 2.2), Math.pow(n * 0.86, 2.2)];
    };
    this.line.sections.river.forEach((r) => {
      const i0 = Math.floor((r.from - 130) / this.step), i1r = Math.ceil((r.to + 130) / this.step);
      /* 水面と河川敷は線路に沿った幅広リボンで（橋の角度に自然に追従する） */
      this.world.add(new THREE.Mesh(ribbon(F, i0, i1r, 0, 760, -7.5, 200), this.M.water));
      this.world.add(new THREE.Mesh(ribbon(F, Math.floor((r.from - 260) / this.step), i0 + 6, 0, 760, -6.7, 5, dryVcol), this.M.bank));
      this.world.add(new THREE.Mesh(ribbon(F, i1r - 6, Math.ceil((r.to + 260) / this.step), 0, 760, -6.7, 5, dryVcol), this.M.bank));
      /* トラス橋（骨組み） */
      const iA = Math.floor(r.from / this.step), iB = Math.ceil(r.to / this.step);
      const truss = new THREE.MeshStandardMaterial({ color: 0x3c5e50, metalness: 0.35, roughness: 0.55, side: DS });
      [6.2, -8.5].forEach((off) => {
        /* 上弦・下弦は縦帯で(横から見て存在感が出るように) */
        const t1 = new THREE.Mesh(vribbon(F, iA, iB, off, 3.0, 3.55, 20), truss);
        const t2 = new THREE.Mesh(vribbon(F, iA, iB, off, 0.25, 0.85, 20), truss);
        t1.castShadow = true; t2.castShadow = true;
        this.world.add(t1, t2);
      });
      for (let s = r.from; s < r.to; s += 14) {
        const f = frameAt(F, this.step, s);
        [6.2, -8.5].forEach((off) => {
          const post = new THREE.Mesh(new THREE.BoxGeometry(0.35, 4.2, 0.35), truss);
          post.position.copy(f.p).addScaledVector(f.left, off);
          post.position.y += 2.2;
          post.castShadow = true;
          this.world.add(post);
        });
      }
      /* 橋桁(側面の鋼板) */
      const girder = new THREE.MeshStandardMaterial({ color: 0x474c50, metalness: 0.5, roughness: 0.6, side: DS });
      [5.9, -8.2].forEach((off) => {
        this.world.add(new THREE.Mesh(vribbon(F, iA, iB, off, -1.5, -0.05, 10), girder));
      });
      /* 橋脚 */
      const pierMat = new THREE.MeshStandardMaterial({ map: this.T.concC, color: 0xd0cec6, roughness: 0.95 });
      for (let s = r.from + 30; s < r.to; s += 60) {
        const f = frameAt(F, this.step, s);
        const pier = new THREE.Mesh(new THREE.BoxGeometry(11, 9, 2.4), pierMat);
        pier.position.copy(f.p).addScaledVector(f.left, -1.2);
        pier.position.y -= 5.2;
        pier.lookAt(pier.position.clone().add(f.t));
        this.world.add(pier);
      }
    });
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

  /* ---------- 線路ぎわの小物(ケーブルトラフ・継電箱・キロポスト) ---------- */
  _buildRailsideDetails() {
    const F = this.frames, N = F.length - 1, L = this.line.meta.length;
    /* ケーブルトラフ(線路脇を走る細いコンクリの列) */
    const trough = new THREE.Mesh(ribbon(F, 0, N, 2.62, 0.36, 0.05, 3),
      new THREE.MeshStandardMaterial({ map: this.T.concC, color: 0xb2afa7, roughness: 0.95, side: DS }));
    this.world.add(trough);
    /* 継電箱(信号機器の箱) */
    const nearStation = (s) => this.line.stations.some((st) => Math.abs(st.s - s) < 90);
    const inRiver = (s) => this.line.sections.river.some((r) => s > r.from - 60 && s < r.to + 60);
    const boxes = [];
    for (let s = 140; s < L - 100; s += 173) {
      if (this._inTunnel(s) || nearStation(s) || inRiver(s)) continue;
      boxes.push(s);
    }
    const bGeo = new THREE.BoxGeometry(0.85, 1.05, 0.5);
    bGeo.translate(0, 0.52, 0);
    const bMat = new THREE.MeshStandardMaterial({ color: 0x8f959b, roughness: 0.6, metalness: 0.25 });
    const bIm = new THREE.InstancedMesh(bGeo, bMat, boxes.length);
    bIm.castShadow = true;
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
    boxes.forEach((s, i) => {
      const f = frameAt(F, this.step, s);
      q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), f.left);
      m4.compose(f.p.clone().addScaledVector(f.left, -7.7), q, new THREE.Vector3(1, 1, 1));
      bIm.setMatrixAt(i, m4);
    });
    this.world.add(bIm);
    /* キロポスト(1kmごと。数字を数えながら走れる) */
    const postGeo = new THREE.CylinderGeometry(0.045, 0.05, 1.15, 6);
    const postMat = new THREE.MeshStandardMaterial({ color: 0xe8e6de, roughness: 0.8 });
    for (let km = 1; km <= Math.floor((L - 100) / 1000); km++) {
      const s = km * 1000;
      if (this._inTunnel(s)) continue;
      const f = frameAt(F, this.step, s);
      const g = new THREE.Group();
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.y = 0.57;
      g.add(post);
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.4),
        new THREE.MeshBasicMaterial({
          map: boardTexture([[String(km), 40, 40]], { bg: '#f2f2ee', fg: '#16283a', border: '#16283a', w: 64, h: 64 }),
        }));
      plate.position.y = 1.05;
      g.add(plate);
      g.position.copy(f.p).addScaledVector(f.left, 2.35);
      g.lookAt(g.position.clone().addScaledVector(f.t, -10));
      this.world.add(g);
    }
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
