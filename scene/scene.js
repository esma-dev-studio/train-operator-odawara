/* =========================================================
 * scene/scene.js — three.js 前面展望シーン
 * 実線形(line.json)からレール・架線・駅・信号・街並みを手続き生成。
 * v2: PBR+HDRI環境光+太陽影+実写テクスチャ(CC0)による描画基盤。
 * ゲームロジックは持たない（simの状態を毎フレーム描くだけ）。
 * ========================================================= */
/* importmapは使わない(古いiPadのSafariが非対応のため、相対パスで読み込む) */
import * as THREE from '../vendor/three.module.min.js';
import { RGBELoader } from '../vendor/RGBELoader.js';
import { STATION_KANA } from '../sim/kana.js';

THREE.Cache.enabled = true;
const UP = new THREE.Vector3(0, 1, 0);
const DS = THREE.DoubleSide;

/* 画質プリセット */
const QUALITY = {
  high: { dpr: 1.75, shadow: 2048, shadowsOn: true, aniso: 8 },
  mid:  { dpr: 1.35, shadow: 1024, shadowsOn: true, aniso: 4 },
  low:  { dpr: 1.0,  shadow: 0,    shadowsOn: false, aniso: 2 },
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
  return g;
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
  return g;
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

/* ビル外壁: 低彩度+ガラス窓(空の映り込み)+下層のAO */
const texBuilding = (base, opt = {}) => canvasTex(128, 256, (c) => {
  c.fillStyle = base;
  c.fillRect(0, 0, 128, 256);
  const ao = c.createLinearGradient(0, 0, 0, 256);
  ao.addColorStop(0, 'rgba(255,255,255,0.07)');
  ao.addColorStop(0.75, 'rgba(0,0,0,0.10)');
  ao.addColorStop(1, 'rgba(0,0,0,0.34)');
  c.fillStyle = ao; c.fillRect(0, 0, 128, 256);
  for (let y = 12; y < 246; y += 20) {
    for (let x = 7; x < 120; x += 17) {
      const lit = Math.random();
      if (lit < (opt.winRatio || 0.86)) {
        const lum = 92 + Math.random() * 68;
        c.fillStyle = `rgb(${Math.round(lum * 0.74)},${Math.round(lum * 0.84)},${Math.round(lum * 0.95)})`;
      } else {
        c.fillStyle = 'rgba(26,32,38,0.95)';
      }
      c.fillRect(x, y, 11, 12);
      c.fillStyle = 'rgba(235,244,250,0.30)';
      c.fillRect(x, y, 11, 3.5);
      c.fillStyle = 'rgba(0,0,0,0.20)';
      c.fillRect(x, y + 10.5, 11, 1.5);
    }
  }
  c.fillStyle = 'rgba(0,0,0,0.30)'; c.fillRect(0, 0, 128, 7);
  c.fillStyle = 'rgba(255,255,255,0.10)'; c.fillRect(0, 7, 128, 2);
});

/* 戸建て外壁 */
const texHouse = () => canvasTex(64, 64, (c) => {
  c.fillStyle = '#c9c3b8';
  c.fillRect(0, 0, 64, 64);
  for (let y = 8; y < 64; y += 9) { c.fillStyle = 'rgba(0,0,0,0.05)'; c.fillRect(0, y, 64, 1.5); }
  c.fillStyle = 'rgba(52,64,76,0.9)';
  c.fillRect(9, 24, 15, 16); c.fillRect(39, 24, 15, 16);
  c.fillStyle = 'rgba(235,242,248,0.35)';
  c.fillRect(9, 24, 15, 5); c.fillRect(39, 24, 15, 5);
  c.fillStyle = 'rgba(0,0,0,0.18)'; c.fillRect(0, 56, 64, 8);
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
  constructor(canvas, line, sim, opts = {}) {
    this.line = line;
    this.sim = sim;
    this.step = line.meta.step;
    this.frames = buildFrames(line);
    this.quality = QUALITY[opts.quality] ? opts.quality : 'high';
    const Q = QUALITY[this.quality];

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, Q.dpr));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    if (Q.shadowsOn) {
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(58, 16 / 9, 0.3, 2600);
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

    /* ---- 材質レジストリ(天候で調整するものはここに集約) ---- */
    this.M = {
      ballast: new THREE.MeshStandardMaterial({ map: this.T.gravelC, normalMap: this.T.gravelN, normalScale: new THREE.Vector2(0.85, 0.85), color: 0xaaa59b, roughness: 1, side: DS }),
      sub: new THREE.MeshStandardMaterial({ map: this.T.gravelSubC, color: 0x6f6b62, roughness: 1, side: DS }),
      apron: new THREE.MeshStandardMaterial({ map: this.T.concC, color: 0xaaa8a2, roughness: 0.95, side: DS }),
      railHead: new THREE.MeshStandardMaterial({ color: 0xd8dadd, metalness: 1.0, roughness: 0.3, side: DS }),
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
    /* 午前の東寄りの光(進行方向=概ね南西なので、影が進行方向へ長く落ちる) */
    this._sunDir = new THREE.Vector3(0.85, 0.55, -0.1).normalize();

    /* 前照灯(トンネル内で軌道を照らす。日中の屋外では太陽に埋もれる) */
    this.headlight = new THREE.SpotLight(0xfff6e6, 700, 160, 0.34, 0.5, 1.7);
    this.headlight.castShadow = false;
    this.scene.add(this.headlight);
    this.scene.add(this.headlight.target);

    /* ---- HDRI環境(晴/曇) ---- */
    this.env = {};
    this._pmrem = new THREE.PMREMGenerator(this.renderer);
    this._pmrem.compileEquirectangularShader();
    const rl = new RGBELoader();
    [['clear', './assets/sky/sky_clear.hdr'], ['rain', './assets/sky/sky_overcast.hdr']].forEach(([k, url]) => {
      rl.load(url, (t) => {
        t.mapping = THREE.EquirectangularReflectionMapping;
        this.env[k] = { bg: t, ibl: this._pmrem.fromEquirectangular(t).texture };
        this._applyWeather();
      });
    });

    this.setWeather(sim.weather);

    /* 喜多見の車両基地ゾーン(この右側には建物や木を生やさない) */
    const kitami = this.line.stations.find((s) => s.name === '喜多見');
    this.depotZone = kitami ? { a: kitami.s + 300, b: kitami.s + 640 } : null;

    /* 踏切の位置(郊外区間に6箇所。駅・川・トンネル・複々線・基地を避ける) */
    this.crossSpots = this._pickCrossings();

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
    this._buildAiTrain();
    this._buildStopBeam();
    this._buildLandmarks();
    this._buildCrossings();
    this._buildStationHouses();
    this._buildPeople();
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
    for (let s = 8600; s < L - 400 && spots.length < 6; s += 1150) {
      let x = s;
      for (let k = 0; k < 9; k++) {
        if (!bad(x)) { spots.push(x); break; }
        x += 140;
      }
    }
    return spots;
  }

  /* fps低下時に外から段階的に画質を落とす(dpr→影) */
  stepDownQuality() {
    const r = this.renderer;
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
    if (this._w) this.renderer.setSize(this._w, this._h, false);
  }

  setWeather(w) {
    this.weather = w;
    this._applyWeather();
  }

  _applyWeather() {
    const rain = this.weather === 'rain';
    const key = rain ? 'rain' : 'clear';
    const env = this.env[key];
    if (env) {
      this.scene.background = env.bg;
      this.scene.environment = env.ibl;
      this.scene.backgroundIntensity = rain ? 0.85 : 1.0;
    } else {
      this.scene.background = new THREE.Color(rain ? 0x8d959c : 0xa8c4dd);
      this.scene.environment = null;
    }
    this.scene.fog = rain
      ? new THREE.Fog(0x99a1a8, 140, 780)
      : new THREE.Fog(0xcfd9e2, 300, 1500);
    this.renderer.toneMappingExposure = rain ? 0.92 : 1.08;
    this.sun.intensity = rain ? 0.45 : 2.8;
    this.sun.color.setHex(rain ? 0xdfe4ea : 0xfff0da);
    this.sun.castShadow = QUALITY[this.quality].shadowsOn && !rain;
    this.hemi.intensity = rain ? 0.55 : 0.45;
    if (this.headlight) this.headlight.intensity = rain ? 850 : 700;
    /* 濡れ表現 */
    this.M.railHead.roughness = rain ? 0.12 : 0.3;
    this.M.ballast.color.setHex(rain ? 0x6e6b66 : 0xaaa59b);
    this.M.apron.color.setHex(rain ? 0x8a8883 : 0xaaa8a2);
    this.M.apron.roughness = rain ? 0.5 : 0.95;
    this.M.plat.color.setHex(rain ? 0x93908a : 0xc2bfb6);
    this.M.plat.roughness = rain ? 0.45 : 0.95;
    this.M.water.roughness = rain ? 0.38 : 0.3;
    this.M.water.color.setHex(rain ? 0x49525a : 0x455e6d);
  }

  /* ---------- 軌道 ---------- */
  _buildTrack() {
    const F = this.frames, N = F.length - 1;
    const recv = (m) => { m.receiveShadow = true; return m; };

    /* 1本のレール: 頭面(金属)+両側の腹(垂直帯) */
    const addRail = (offset, full) => {
      this.scene.add(recv(new THREE.Mesh(ribbon(F, 0, N, offset, 0.068, 0.19, 8), this.M.railHead)));
      this.scene.add(new THREE.Mesh(vribbon(F, 0, N, offset + 0.034, 0.05, 0.178, 8), this.M.railWeb));
      if (full) this.scene.add(new THREE.Mesh(vribbon(F, 0, N, offset - 0.034, 0.05, 0.178, 8), this.M.railWeb));
    };
    const addTrack = (offset, full) => {
      this.scene.add(recv(new THREE.Mesh(ribbon(F, 0, N, offset, 4.2, 0, 2.5), this.M.ballast)));
      [-0.7175, 0.7175].forEach((o) => addRail(offset + o, full));
    };
    addTrack(0, true);       // 自列車（下り）
    addTrack(-3.8, true);    // 上り線

    /* 複々線区間: 急行線2本を追加(頭面+外側の腹のみ) */
    const q = this.line.sections.quad;
    const qi0 = Math.floor(q.from / this.step), qi1 = Math.ceil(q.to / this.step);
    [3.8, 7.6].forEach((off) => {
      this.scene.add(recv(new THREE.Mesh(ribbon(F, qi0, qi1, off, 4.2, 0, 2.5), this.M.ballast)));
      [-0.7175, 0.7175].forEach((o) => {
        this.scene.add(recv(new THREE.Mesh(ribbon(F, qi0, qi1, off + o, 0.068, 0.19, 8), this.M.railHead)));
        this.scene.add(new THREE.Mesh(vribbon(F, qi0, qi1, off + o + 0.034, 0.05, 0.178, 8), this.M.railWeb));
      });
    });

    /* 軌道間の埋め（複線間・肩） */
    this.scene.add(recv(new THREE.Mesh(ribbon(F, 0, N, -1.9, 3.0, -0.18, 3.0), this.M.sub)));
    /* 保守通路 */
    this.scene.add(recv(new THREE.Mesh(ribbon(F, 0, N, 3.6, 3.0, -0.12, 3.0), this.M.apron)));
    this.scene.add(recv(new THREE.Mesh(ribbon(F, 0, N, -7.2, 3.0, -0.12, 3.0), this.M.apron)));

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
      this.scene.add(new THREE.Mesh(ribbon(F, i0, i1, 264, 512, -0.5, 5, gVcol), this.M.ground));
      this.scene.add(new THREE.Mesh(ribbon(F, i0, i1, -264, 512, -0.5, 5, gVcol), this.M.ground));
    };
    cuts.sort((a, b) => a[0] - b[0]).forEach(([cf, ct]) => {
      addGround(Math.floor(segStart / this.step), Math.floor(cf / this.step));
      segStart = ct;
    });
    addGround(Math.floor(segStart / this.step), N);
    this.scene.children.forEach((o) => { if (o.material === this.M.ground) o.receiveShadow = true; });
  }

  /* ---------- 枕木(自列車近傍のみ実体を置くムービングウィンドウ) ---------- */
  _buildSleepers() {
    const geo = new THREE.BoxGeometry(2.5, 0.13, 0.26);
    /* own: -45..+195, up: -45..+140 (間隔0.625m) */
    this._slpSpec = [
      { off: 0, back: 45, fwd: 195 },
      { off: -3.8, back: 45, fwd: 140 },
    ];
    let total = 0;
    this._slpSpec.forEach((sp) => { sp.count = Math.floor((sp.back + sp.fwd) / 0.625); total += sp.count; });
    this.sleepers = new THREE.InstancedMesh(geo, this.M.sleeper, total);
    this.sleepers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(this.sleepers);
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
      if (inTun) continue;
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
    this.scene.add(poles, arms);

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
      this.scene.add(new THREE.Line(g, wireMat));
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
    this.scene.add(new THREE.LineSegments(wg, wireMat));
  }

  _inTunnel(s) {
    return this.line.sections.tunnel.some((t) => s > t.from && s < t.to);
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
        this.scene.add(plat);
        const edgeOff = off + (off > 0 ? -1.0 : 1.0);
        this.scene.add(new THREE.Mesh(ribbon(F, i0, i1, edgeOff, 0.4, 1.03, 0.64), matTactile));
        /* ホーム側壁(線路側) */
        const sideOff = off + (off > 0 ? -1.2 : 1.2);
        const pside = new THREE.Mesh(vribbon(F, i0, i1, sideOff, -0.15, 1.02, 3), this.M.platSide);
        pside.castShadow = true;
        this.scene.add(pside);
        if (!under) {
          const roof = new THREE.Mesh(ribbon(F, i0 + 3, i1 - 1, off, 3.2, 4.4, 20), matRoof);
          roof.castShadow = true;
          this.scene.add(roof);
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
      this.scene.add(board);
      /* 停止位置目標（8両） */
      const stopTex = boardTexture([['8', 60, 72]], { bg: '#111', fg: '#fff', border: '#fff', w: 96, h: 96 });
      const stop = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.42),
        new THREE.MeshBasicMaterial({ map: stopTex }));
      const fs = frameAt(F, this.step, st.s + 3);
      stop.position.copy(fs.p).addScaledVector(fs.left, 2.75);
      stop.position.y += 1.85;
      stop.lookAt(stop.position.clone().addScaledVector(fs.t, -10));
      this.scene.add(stop);
    });
    /* 屋根柱(全駅まとめてインスタンス描画) */
    const matCol = new THREE.MeshStandardMaterial({ color: 0x9aa0a5, metalness: 0.5, roughness: 0.5 });
    const cols = new THREE.InstancedMesh(colGeo, matCol, colList.length);
    cols.castShadow = true;
    const m4 = new THREE.Matrix4();
    colList.forEach((p, i) => { m4.makeTranslation(p.x, p.y, p.z); cols.setMatrixAt(i, m4); });
    this.scene.add(cols);
  }

  /* ---------- 信号機 ---------- */
  _buildSignals() {
    const F = this.frames;
    this.signalMeshes = [];
    const bodyGeo = new THREE.BoxGeometry(0.42, 1.15, 0.24);
    const poleGeo = new THREE.CylinderGeometry(0.07, 0.09, 4.4, 6);
    const lampGeo = new THREE.CircleGeometry(0.13, 12);
    const matBody = new THREE.MeshStandardMaterial({ color: 0x1f2428, roughness: 0.7 });
    const matPole = new THREE.MeshStandardMaterial({ color: 0x6d757c, metalness: 0.5, roughness: 0.5 });
    const glowT = texGlow();
    this.sim.signals.forEach((sig) => {
      const f = frameAt(F, this.step, sig.s);
      const g = new THREE.Group();
      const pole = new THREE.Mesh(poleGeo, matPole);
      pole.position.y = 2.2;
      pole.castShadow = true;
      g.add(pole);
      const body = new THREE.Mesh(bodyGeo, matBody);
      body.position.y = 4.6;
      body.castShadow = true;
      g.add(body);
      const lamps = [];
      [['G', 0.36, 0x22e06a], ['Y', 0, 0xffc12b], ['R', -0.36, 0xff4838]].forEach(([k, dy, col]) => {
        const lamp = new THREE.Mesh(lampGeo, new THREE.MeshBasicMaterial({ color: 0x14171a }));
        lamp.position.set(0, 4.6 + dy, 0.13);
        g.add(lamp);
        const glow = new THREE.Sprite(new THREE.SpriteMaterial({
          map: glowT, color: col, transparent: true, opacity: 0.55,
          blending: THREE.AdditiveBlending, depthWrite: false,
        }));
        glow.scale.set(0.6, 0.6, 1);
        glow.position.set(0, 4.6 + dy, 0.22);
        glow.visible = false;
        g.add(glow);
        lamps.push({ k, lamp, col, glow });
      });
      g.position.copy(f.p).addScaledVector(f.left, 2.6);
      g.lookAt(g.position.clone().addScaledVector(f.t, -10));
      this.scene.add(g);
      this.signalMeshes.push({ sig, lamps });
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
      this.scene.add(b);
      /* 解除標 */
      const tex2 = boardTexture([['解', 60, 56]], { bg: '#f2f2ee', fg: '#111', border: '#111', w: 96, h: 96 });
      const b2 = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.55), new THREE.MeshBasicMaterial({ map: tex2 }));
      const f2 = frameAt(F, this.step, Math.min(this.line.meta.length - 5, z.to + 10));
      b2.position.copy(f2.p).addScaledVector(f2.left, 2.3);
      b2.position.y += 1.5;
      b2.lookAt(b2.position.clone().addScaledVector(f2.t, -10));
      this.scene.add(b2);
    });
  }

  /* ---------- 街並み ---------- */
  _buildTown() {
    const F = this.frames;
    const rng = (() => { let x = 12345; return () => (x = (x * 16807) % 2147483647) / 2147483647; })();
    const mats = [
      new THREE.MeshStandardMaterial({ map: texBuilding('#8f979e'), roughness: 0.85 }),
      new THREE.MeshStandardMaterial({ map: texBuilding('#a39b90'), roughness: 0.9 }),
      new THREE.MeshStandardMaterial({ map: texBuilding('#79828c', { winRatio: 0.93 }), roughness: 0.7, metalness: 0.15 }),
      new THREE.MeshStandardMaterial({ map: texHouse(), roughness: 0.9 }),
    ];
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0);
    const groups = mats.map((m) => ({ m, list: [] }));
    const urban = this.line.sections.urban;
    const kindAt = (s) => (urban.find((u) => s >= u.from && s < u.to) || { kind: 2 }).kind;
    for (let s = 40; s < this.line.meta.length - 40; s += 26) {
      if (this._inTunnel(s)) continue;
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
          groups[mi].list.push({ p, h, w, dpt, rot: rng() * 0.5 - 0.25 });
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
          groups[Math.floor(rng() * 3)].list.push({
            p: f.p.clone().addScaledVector(f.left, side * dist),
            h, w: 18 + rng() * 26, dpt: 16 + rng() * 22, rot: rng() * 0.6 - 0.3,
          });
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
      this.scene.add(im);
    });
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
      this.scene.add(roofs);
    }
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
        this.scene.add(wMesh);
      } else {
        this.scene.add(new THREE.Mesh(vribbon(F, i0, i1, run.off, -0.25, 1.05, 2), matFence));
      }
    };
    const nearCross = (s) => this.crossSpots.some((c) => Math.abs(c - s) < 14);
    for (const side of [1, -1]) {
      let cur = null;
      for (let s = 25; s < L - 25; s += 5) {
        let type = null;
        if (!this._inTunnel(s) && !nearStation(s) && !inRiver(s) && !nearCross(s)) {
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
      if (this._inTunnel(s) || inRiver(s)) continue;
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
            list.push({ p, sc: 0.85 + rng() * 0.9, tint: 0.7 + rng() * 0.4 });
          }
        }
      }
    }
    const trunkGeo = new THREE.CylinderGeometry(0.13, 0.2, 2.9, 6);
    trunkGeo.translate(0, 1.45, 0);
    const folGeo = new THREE.IcosahedronGeometry(1.7, 1);
    folGeo.scale(1, 1.25, 1);
    folGeo.translate(0, 3.7, 0);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x584736, roughness: 0.95 });
    const folMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 });
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, list.length);
    const fols = new THREE.InstancedMesh(folGeo, folMat, list.length);
    trunks.castShadow = true; fols.castShadow = true;
    const m4 = new THREE.Matrix4(), qt = new THREE.Quaternion(), e = new THREE.Euler();
    const col = new THREE.Color();
    list.forEach((t, i) => {
      e.set(0, rng() * Math.PI, 0); qt.setFromEuler(e);
      m4.compose(t.p, qt, new THREE.Vector3(t.sc, t.sc * (0.9 + rng() * 0.3), t.sc));
      trunks.setMatrixAt(i, m4);
      fols.setMatrixAt(i, m4);
      col.setRGB(t.tint * 0.38, t.tint * 0.46, t.tint * 0.30, THREE.SRGBColorSpace);
      fols.setColorAt(i, col);
    });
    if (fols.instanceColor) fols.instanceColor.needsUpdate = true;
    this.scene.add(trunks, fols);
  }

  /* ---------- トンネル（下北沢地下区間） ---------- */
  _buildTunnel() {
    const F = this.frames;
    const mat = this.M.tunnel;
    const dim = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45, side: DS, depthWrite: false });
    this.line.sections.tunnel.forEach((t) => {
      const i0 = Math.floor(t.from / this.step), i1 = Math.ceil(t.to / this.step);
      this.scene.add(new THREE.Mesh(vribbon(F, i0, i1, 7.2, -0.5, 6.2, 6), mat));
      this.scene.add(new THREE.Mesh(vribbon(F, i0, i1, -9.5, -0.5, 6.2, 6), mat));
      this.scene.add(new THREE.Mesh(ribbon(F, i0, i1, -1.15, 17, 6.2, 6), mat));
      /* 地表の明るさをトンネル内だけ抑える減光膜(駅ホーム部は照明ありとして除外) */
      const stops = this.line.stations.filter((st) => st.s > t.from && st.s < t.to);
      let s0 = t.from;
      const ranges = [];
      stops.forEach((st) => { ranges.push([s0, st.s - 175]); s0 = st.s + 30; });
      ranges.push([s0, t.to]);
      ranges.forEach(([a, b]) => {
        if (b - a < 30) return;
        const ia = Math.max(0, Math.floor(a / this.step)), ib = Math.min(F.length - 1, Math.ceil(b / this.step));
        this.scene.add(new THREE.Mesh(ribbon(F, ia, ib, -1.8, 11.8, 0.3, 40), dim));
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
        this.scene.add(portal);
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
      this.scene.add(lamps);
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
      this.scene.add(new THREE.Mesh(ribbon(F, i0, i1r, 0, 760, -7.5, 200), this.M.water));
      this.scene.add(new THREE.Mesh(ribbon(F, Math.floor((r.from - 260) / this.step), i0 + 6, 0, 760, -6.7, 5, dryVcol), this.M.bank));
      this.scene.add(new THREE.Mesh(ribbon(F, i1r - 6, Math.ceil((r.to + 260) / this.step), 0, 760, -6.7, 5, dryVcol), this.M.bank));
      /* トラス橋（骨組み） */
      const iA = Math.floor(r.from / this.step), iB = Math.ceil(r.to / this.step);
      const truss = new THREE.MeshStandardMaterial({ color: 0x3c5e50, metalness: 0.35, roughness: 0.55, side: DS });
      [6.2, -8.5].forEach((off) => {
        /* 上弦・下弦は縦帯で(横から見て存在感が出るように) */
        const t1 = new THREE.Mesh(vribbon(F, iA, iB, off, 3.0, 3.55, 20), truss);
        const t2 = new THREE.Mesh(vribbon(F, iA, iB, off, 0.25, 0.85, 20), truss);
        t1.castShadow = true; t2.castShadow = true;
        this.scene.add(t1, t2);
      });
      for (let s = r.from; s < r.to; s += 14) {
        const f = frameAt(F, this.step, s);
        [6.2, -8.5].forEach((off) => {
          const post = new THREE.Mesh(new THREE.BoxGeometry(0.35, 4.2, 0.35), truss);
          post.position.copy(f.p).addScaledVector(f.left, off);
          post.position.y += 2.2;
          post.castShadow = true;
          this.scene.add(post);
        });
      }
      /* 橋桁(側面の鋼板) */
      const girder = new THREE.MeshStandardMaterial({ color: 0x474c50, metalness: 0.5, roughness: 0.6, side: DS });
      [5.9, -8.2].forEach((off) => {
        this.scene.add(new THREE.Mesh(vribbon(F, iA, iB, off, -1.5, -0.05, 10), girder));
      });
      /* 橋脚 */
      const pierMat = new THREE.MeshStandardMaterial({ map: this.T.concC, color: 0xd0cec6, roughness: 0.95 });
      for (let s = r.from + 30; s < r.to; s += 60) {
        const f = frameAt(F, this.step, s);
        const pier = new THREE.Mesh(new THREE.BoxGeometry(11, 9, 2.4), pierMat);
        pier.position.copy(f.p).addScaledVector(f.left, -1.2);
        pier.position.y -= 5.2;
        pier.lookAt(pier.position.clone().add(f.t));
        this.scene.add(pier);
      }
    });
  }

  /* ---------- 車両(共通ビルダー) ---------- */
  _trainMats() {
    if (!this._tm) {
      this._tm = {
        side: new THREE.MeshStandardMaterial({ map: texTrainSide(), roughness: 0.35, metalness: 0.4 }),
        roof: new THREE.MeshStandardMaterial({ color: 0xb0b4b7, roughness: 0.6, metalness: 0.3 }),
        dark: new THREE.MeshStandardMaterial({ color: 0x24282c, roughness: 0.85 }),
        front: new THREE.MeshStandardMaterial({ map: texTrainFront(), roughness: 0.4, metalness: 0.3 }),
      };
    }
    return this._tm;
  }

  _makeTrain(nCars, withFront) {
    const m = this._trainMats();
    const g = new THREE.Group();
    for (let i = 0; i < nCars; i++) {
      /* BoxGeometryの面順: +x,-x,+y,-y,+z,-z。+zが編成の前面 */
      const mats = [m.side, m.side, m.roof, m.dark, i === 0 && withFront ? m.front : m.dark, m.dark];
      const car = new THREE.Mesh(new THREE.BoxGeometry(2.85, 3.5, 19.2), mats);
      car.position.z = -i * 19.9;
      car.position.y = 2.05;
      car.castShadow = true;
      g.add(car);
      [-6.4, 6.4].forEach((dz) => {
        const bogie = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.8, 3.2), m.dark);
        bogie.position.set(0, 0.4, -i * 19.9 + dz);
        g.add(bogie);
      });
    }
    return g;
  }

  /* ---------- 複々線を走る対向/追い抜き列車（演出） ---------- */
  _buildAiTrain() {
    this.aiTrain = this._makeTrain(4, true);
    this.scene.add(this.aiTrain);
  }

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
    this.scene.add(this.stopBeam);
  }

  /* ---------- 駅ごとの実在風ランドマーク ---------- */
  _stationS(name) {
    const st = this.line.stations.find((s) => s.name === name);
    return st ? st.s : null;
  }

  _buildLandmarks() {
    this._buildCanopy();
    this._buildTorii();
    this._buildDepot();
    this._buildWheel();
    this._buildUmeGrove();
  }

  /* 新宿: ターミナルの大屋根(照明つきの駅ホール) */
  _buildCanopy() {
    const F = this.frames;
    const s0 = this._stationS('新宿');
    if (s0 === null) return;
    const mat = new THREE.MeshStandardMaterial({
      color: 0x5d656e, roughness: 0.55, metalness: 0.35, side: DS,
      emissive: 0x171b1f,
    });
    mat.envMapIntensity = 1.15;
    for (let s = Math.max(15, s0 - 25); s < s0 + 135; s += 42) {
      const f = frameAt(F, this.step, s + 21);
      const geo = new THREE.CylinderGeometry(10.5, 10.5, 44, 20, 1, true, 0, Math.PI);
      geo.rotateZ(Math.PI / 2);   // 円筒の軸をX(=進行方向に合わせる)へ
      const shell = new THREE.Mesh(geo, mat);
      shell.position.copy(f.p).addScaledVector(f.left, -1.9);
      shell.position.y += 3.4;
      shell.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), f.t);
      this.scene.add(shell);
    }
    /* ホールの照明列 */
    const lampGeo = new THREE.BoxGeometry(0.16, 0.1, 2.4);
    const lampMat = new THREE.MeshBasicMaterial({ color: 0xffeecb });
    const lampS = [];
    for (let s = Math.max(18, s0 - 22); s < s0 + 132; s += 9) lampS.push(s);
    const lamps = new THREE.InstancedMesh(lampGeo, lampMat, lampS.length * 2);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
    let n = 0;
    lampS.forEach((s) => {
      const f = frameAt(F, this.step, s);
      q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), f.t);
      [1.2, -5.0].forEach((off) => {
        m4.compose(
          new THREE.Vector3().copy(f.p).addScaledVector(f.left, off).setY(f.p.y + 8.2),
          q, new THREE.Vector3(1, 1, 1));
        lamps.setMatrixAt(n++, m4);
      });
    });
    this.scene.add(lamps);
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
    this.scene.add(g);
  }

  /* 喜多見: 車両基地(留置線・止まっている電車・検車庫) */
  _buildDepot() {
    const F = this.frames;
    if (!this.depotZone) return;
    const a = this.depotZone.a + 20, b = this.depotZone.b - 20;
    const iA = Math.floor(a / this.step), iB = Math.ceil(b / this.step);
    [-13.5, -17.5, -21.5].forEach((off) => {
      this.scene.add(new THREE.Mesh(ribbon(F, iA, iB, off, 3.6, -0.05, 2.5), this.M.sub));
      [-0.7175, 0.7175].forEach((o) => {
        this.scene.add(new THREE.Mesh(ribbon(F, iA, iB, off + o, 0.068, 0.1, 8), this.M.railHead));
      });
    });
    [[a + 35, -13.5, 3], [a + 130, -21.5, 4]].forEach(([s, off, n]) => {
      const t = this._makeTrain(n, true);
      const f = frameAt(F, this.step, s);
      t.position.copy(f.p).addScaledVector(f.left, off);
      t.lookAt(t.position.clone().addScaledVector(f.t, -30));
      this.scene.add(t);
    });
    const fS = frameAt(F, this.step, b - 55);
    const shed = new THREE.Mesh(new THREE.BoxGeometry(16, 8, 92),
      new THREE.MeshStandardMaterial({ color: 0x8f959b, roughness: 0.8 }));
    shed.position.copy(fS.p).addScaledVector(fS.left, -18);
    shed.position.y += 4;
    shed.lookAt(shed.position.clone().add(fS.t));
    shed.castShadow = true;
    this.scene.add(shed);
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
    this.scene.add(root);
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
    this.scene.add(fols, trs);
  }

  /* AI列車: 複々線区間の急行線を周回 */
  _updateAiTrain(t) {
    const q = this.line.sections.quad;
    const span = q.to - q.from - 200;
    if (span < 500) return;
    const speed = 26;   // m/s ≒ 94km/h
    const cyc = (t * speed) % (span * 2 + 4000);
    let s, dir = 1;
    if (cyc < span) { s = q.to - 100 - cyc; dir = -1; }        // 対向(上り急行線を新宿方面へ)
    else if (cyc < span + 2000) { this.aiTrain.visible = false; return; }
    else if (cyc < span * 2 + 2000) { s = q.from + 100 + (cyc - span - 2000); dir = 1; }
    else { this.aiTrain.visible = false; return; }
    this.aiTrain.visible = true;
    const f = frameAt(this.frames, this.step, Math.max(10, Math.min(this.line.meta.length - 10, s)));
    const off = dir < 0 ? 7.6 : 3.8;
    this.aiTrain.position.copy(f.p).addScaledVector(f.left, off);
    const ahead = f.p.clone().addScaledVector(f.t, dir * 30).addScaledVector(f.left, off);
    this.aiTrain.lookAt(ahead);
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
      this.scene.add(road);
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
        this.scene.add(g);
      });
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
      this.scene.add(g);
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
      this.scene.add(g);
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
    /* 自ホーム(進行左側)の6人: 0-1=降りる人, 2-5=乗る人 */
    for (let i = 0; i < 6; i++) {
      const fig = this.people[i];
      const s = next.stopAt + 8 - i * 13;
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
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /* 毎フレーム: 運転台視点で描画 */
  render(dt) {
    this.clockT += dt;
    const sim = this.sim;
    const s = Math.max(0, Math.min(this.line.meta.length - 2, sim.pos));
    const f = frameAt(this.frames, this.step, s);
    const fAhead = frameAt(this.frames, this.step, Math.min(this.line.meta.length - 2, s + 42));
    /* 運転士の目線（左寄り・レール上3.1m） */
    const eye = f.p.clone().addScaledVector(f.left, 0.85);
    eye.y += 3.05;
    /* 揺れ */
    const sway = Math.sin(this.clockT * 7.3) * 0.012 + Math.sin(this.clockT * 2.1) * 0.02;
    const bob = Math.sin(this.clockT * 9.1) * 0.008;
    const k = Math.min(1, sim.v / 70);
    eye.addScaledVector(f.left, sway * k);
    eye.y += bob * k;
    this.camera.position.copy(eye);
    const look = fAhead.p.clone().addScaledVector(fAhead.left, 0.55);
    look.y += 2.4;
    this.camera.lookAt(look);

    /* 太陽と影ボックスを自列車に追従させる */
    this.sun.target.position.copy(eye).addScaledVector(f.t, 110);
    this.sun.position.copy(this.sun.target.position).addScaledVector(this._sunDir, 430);

    /* 前照灯の追従 */
    this.headlight.position.copy(eye).addScaledVector(f.t, 2.0);
    this.headlight.position.y -= 1.1;
    this.headlight.target.position.copy(eye).addScaledVector(f.t, 70);
    this.headlight.target.position.y -= 2.4;

    this._updateSleepers(s);

    /* 信号現示の更新（近傍だけ） */
    this.signalMeshes.forEach((sm) => {
      const d = sm.sig.s - sim.pos;
      if (d < -50 || d > 900) return;
      const asp = sim.signalAspect(sm.sig);
      sm.lamps.forEach((l) => {
        const on = (asp === 3 && l.k === 'G') || ((asp === 1) && l.k === 'Y') ||
          (asp === 2 && (l.k === 'Y' || l.k === 'G')) || (asp === 0 && l.k === 'R');
        l.lamp.material.color.setHex(on ? l.col : 0x14171a);
        l.glow.visible = on;
      });
    });

    this._updateAiTrain(this.clockT);

    /* 停止位置の光の目印(つぎに とまる駅だけ) */
    const nxt = sim.stops[sim.stopIdx];
    if (nxt && !sim.doorOpen && nxt.stopAt - sim.pos < 650 && nxt.stopAt - sim.pos > -2) {
      const fb = frameAt(this.frames, this.step, Math.min(this.line.meta.length - 2, nxt.stopAt));
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

    this.renderer.render(this.scene, this.camera);

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
