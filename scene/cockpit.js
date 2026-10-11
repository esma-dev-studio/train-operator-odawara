/* =========================================================
 * scene/cockpit.js — 運転台の窓まわり(3D)
 * 画面比率に合わせて「窓枠・ピラー・運転台の天板・ワイパー」を配置する。
 * 計器はHTML(#cab)側。ここは"窓から見える運転台のふち"だけを担当。
 *
 * 描き方: はじめはカメラの子として本体のシーンで描く。描画側が renderOverlay() を
 * 呼ぶようになると、自分のシーン(this.scene)へ移り、本体を描いたあとに深度だけ消して
 * 上から描く(トーンマッピング・ブルーム・霧の影響を受けない)。
 * 材質はすべて MeshBasic(toneMapped:false)。色は計器盤(#cab)と同じ式で暗くする:
 *   #cab::after は rgb(2,4,7) を (1-明るさ)*0.62 だけ重ねる → shade() も同じ。
 * 外との約束: renderOverlay(renderer, camera) / setHeadOffset(dx,dy,pitch,roll) /
 *   update(dt, {light, night, wiper, snow}) / windowRects() / wiperScreen() / layoutFor(aspect)
 * ========================================================= */
import * as THREE from '../vendor/three.module.min.js';

const TAN = Math.tan(THREE.MathUtils.degToRad(29));   // 縦FOV58°の半分

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
  snow: hexRGB('#e9eef3'),
};
const s2l = (s) => (s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4));

/* sRGB(見た目)の比率をリニアへ(頂点色はリニア解釈) */
const lin = (k) => Math.pow(Math.max(0, k), 2.2);
/* 内装(FRPの化粧板)の明るさの比率: 上ほど20%暗い(見た目の比率) */
const trimK = (yNdc) => 1 - 0.2 * Math.min(1, Math.max(0, (yNdc + 1) / 2));
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

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

/* 内側の輪(a)と外側の輪(b)のあいだを帯にして buf に足す(色は頂点ごと) */
function pushRing(buf, a, b, z, colA, colB) {
  const n = a.length, base = buf.pos.length / 3;
  for (let i = 0; i < n; i++) {
    buf.pos.push(a[i][0], a[i][1], z); buf.col.push(...colA[i]);
    buf.pos.push(b[i][0], b[i][1], z); buf.col.push(...colB[i]);
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, a0 = base + i * 2, b0 = a0 + 1, a1 = base + j * 2, b1 = a1 + 1;
    buf.idx.push(a0, b0, b1, a0, b1, a1);
  }
}

const newBuf = () => ({ pos: [], col: [], idx: [] });
function bufGeo(buf) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(buf.col, 3));
  g.setIndex(buf.idx);
  return g;
}

/* 同じ材質の小さな部品(箱・円柱)を1つのジオメトリにまとめる(描画回数を減らす) */
function mergeParts(parts) {
  const pos = [], idx = [];
  const v = new THREE.Vector3();
  parts.forEach(({ geo, m }) => {
    const base = pos.length / 3;
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(m); pos.push(v.x, v.y, v.z); }
    const ix = geo.index;
    for (let i = 0; i < ix.count; i++) idx.push(base + ix.getX(i));
    geo.dispose();
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}
const mat4 = (x, y, z, rx = 0) => new THREE.Matrix4().makeRotationX(rx).setPosition(x, y, z);

/* 天板の表面 1024x128(一度だけ)。画像の上が奥(窓の下)、下が手前(計器盤とのさかい)。
 * 左に時刻表(スタフ)差し、右に時計置き。まん中(u .33〜.67)は「いまやること」の帯がかかるので何も置かない */
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
  /* 化粧板の継ぎ目(u .30 / .70) */
  [0.30, 0.70].forEach((u) => {
    const x = Math.round(u * W);
    c.fillStyle = '#121518'; c.fillRect(x, 0, 1, H);
    c.fillStyle = 'rgba(255,255,255,0.06)'; c.fillRect(x + 1, 0, 1, H);
  });
  /* 時刻表差し(u .09〜.215, v .25〜.85。画面の左はしで切れないよう少し内寄り): 黒い枠・紙・罫線・上の押さえ金具 */
  {
    const x0 = Math.round(0.09 * W), x1 = Math.round(0.215 * W), y0 = Math.round(0.25 * H), y1 = Math.round(0.85 * H);
    c.fillStyle = 'rgba(0,0,0,0.35)'; c.fillRect(x0 + 2, y0 + 3, x1 - x0, y1 - y0);   // 落ち影
    c.fillStyle = '#15181b'; c.fillRect(x0, y0, x1 - x0, y1 - y0);
    c.fillStyle = '#d9d5c8'; c.fillRect(x0 + 3, y0 + 3, x1 - x0 - 6, y1 - y0 - 6);
    c.fillStyle = 'rgba(0,0,0,0.35)';
    const lh = (y1 - y0 - 10) / 7;
    for (let k = 1; k <= 6; k++) c.fillRect(x0 + 6, Math.round(y0 + 4 + k * lh), x1 - x0 - 12, 1);
    c.fillStyle = 'rgba(0,0,0,0.22)';
    c.fillRect(x0 + Math.round((x1 - x0) * 0.32), y0 + 6, 1, y1 - y0 - 10);
    c.fillStyle = '#0b0c0d'; c.fillRect(x0 - 2, y0, x1 - x0 + 4, 6);
    c.fillStyle = 'rgba(255,255,255,0.12)'; c.fillRect(x0 - 2, y0 + 6, x1 - x0 + 4, 1);
  }
  /* 時計置き(u .82〜.86): 黒い台・白い文字盤・針2本 */
  {
    const cx = Math.round(0.84 * W), cy = Math.round(0.55 * H);
    c.fillStyle = 'rgba(0,0,0,0.35)';
    c.beginPath(); c.arc(cx + 2, cy + 3, 18, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#0e1012';
    c.beginPath(); c.arc(cx, cy, 18, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#cfd3d6';
    c.beginPath(); c.arc(cx, cy, 11, 0, Math.PI * 2); c.fill();
    c.strokeStyle = '#15181b'; c.lineWidth = 1;
    c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + 6, cy - 5); c.moveTo(cx, cy); c.lineTo(cx - 1, cy - 9); c.stroke();
    c.fillStyle = 'rgba(255,255,255,0.10)';
    c.fillRect(cx - 16, cy - 19, 32, 1);
  }
  /* 奥ほど暗く(上30%) / 奥の見切りの影 / 手前のふちのハイライト */
  const g = c.createLinearGradient(0, 0, 0, H * 0.3);
  g.addColorStop(0, 'rgba(0,0,0,0.25)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = g; c.fillRect(0, 0, W, H * 0.3);
  c.fillStyle = 'rgba(0,0,0,0.35)'; c.fillRect(0, 0, W, 4);
  c.fillStyle = 'rgba(255,255,255,0.10)'; c.fillRect(0, H - 3, W, 2);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export class Cockpit {
  constructor(camera) {
    this.camera = camera;
    this.root = new THREE.Group();
    this.root.renderOrder = 10;
    camera.add(this.root);
    /* 上に重ねて描くとき用の自分のシーン(はじめは空。renderOverlay がはじめて呼ばれたら移る) */
    this.scene = new THREE.Scene();
    this._own = false;
    /* 頭の動き(運転台は車体に固定。目は少しだけ動く) */
    this._off = new THREE.Matrix4();
    this._offP = new THREE.Vector3();
    this._offQ = new THREE.Quaternion();
    this._offE = new THREE.Euler();
    this._one = new THREE.Vector3(1, 1, 1);
    this._offV = [0, 0, 0, 0];
    /* 材質はすべて Basic(光・トーンマッピング・霧なし)。色は update() で計器盤と同じ式で決める */
    const basic = (o) => new THREE.MeshBasicMaterial(Object.assign({ toneMapped: false, fog: false }, o));
    this.matFrame = basic({ vertexColors: true, side: THREE.DoubleSide });
    this.matSeal = basic({ side: THREE.DoubleSide });
    this.matDash = basic({ map: dashTexture(), vertexColors: true });
    this.matDashEdge = basic({});
    /* ワイパー: 黒い腕・ブレード / ゴム / 根元のメッキ */
    this.matWiper = basic({});
    this.matRubber = basic({});
    this.matChrome = basic({});
    /* 雪の日の窓の下のふちの雪(雪のときだけ、だんだん積もる) */
    this.matSill = basic({ transparent: true, opacity: 0, depthWrite: false });
    this._tmpS = [0, 0, 0];
    this._tmpC = new THREE.Color();
    this.light = 1;          // 室内の明るさ(昼1・夜/トンネル小)
    this._shadeL = -1;
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
    this._applyShade();
  }

  setVisible(v) { this.root.visible = v; }

  /* 頭の位置のずれ(m)と傾き(rad)。運転台が画面の中で少しだけ動き、車体に固定された物に見える */
  setHeadOffset(dx, dy, pitch, roll) {
    const cl = (v, m) => (v > m ? m : v < -m ? -m : (v || 0));
    dx = cl(dx, 0.004); dy = cl(dy, 0.004); pitch = cl(pitch, 0.003); roll = cl(roll, 0.003);
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

  /* 本体を描いたあとに呼ぶ: 深度だけ消して運転台を上から描く(トーンマッピング・ブルームなし) */
  renderOverlay(renderer, camera) {
    if (!renderer || !camera) return;
    if (!this._own) {
      this._own = true;
      if (this.root.parent) this.root.parent.remove(this.root);
      this.root.position.set(0, 0, 0);
      this.root.rotation.set(0, 0, 0);
      this.root.updateMatrix();
      this.scene.add(this.root);
      this.root.matrixAutoUpdate = false;
    }
    if (!this.root.visible) return;
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
    const fr = newBuf(), sl = newBuf();
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
          const h = 0.012 + 0.02 * corner * corner + (rnd() - 0.5) * 0.012;
          const pb = P(x, yG - 0.004), pt = P(x, yG + Math.max(0.004, h));
          sb.pos.push(pb[0], pb[1], z + 0.0015, pt[0], pt[1], z + 0.0015);
          sb.col.push(1, 1, 1, 1, 1, 1);
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
    const dashShape = new THREE.BufferGeometry();
    dashShape.setAttribute('position', new THREE.Float32BufferAttribute([
      -hwFar, yTop, zFar, hwFar, yTop, zFar, hwN, yN, zNear, -hwN, yN, zNear,
    ], 3));
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

    /* --- ワイパー(根元は運転士窓の右下。休止位置は窓の下のゴムに沿って寝ている) --- */
    const pivotNdc = [cx - cw * 0.9, L.dash + 0.024];
    const zw = -1.0;
    const hwW = -zw * TAN * aspect, hhW = -zw * TAN;
    this.wiper = new THREE.Group();
    this.wiper.position.set(pivotNdc[0] * hwW, pivotNdc[1] * hhW, zw);
    const armLen = hhW * 1.2;
    /* 腕(黒い板)とブレードの背骨は同じ材質なので1つに */
    const armGeo = mergeParts([
      { geo: new THREE.BoxGeometry(armLen * 0.95, 0.016, 0.01), m: mat4(-armLen * 0.475, 0, 0) },
      { geo: new THREE.BoxGeometry(armLen * 0.8, 0.008, 0.012), m: mat4(-armLen * 0.52, 0.011, -0.004) },
      { geo: new THREE.CylinderGeometry(0.022, 0.024, 0.02, 12), m: mat4(0, 0, 0, Math.PI / 2) },
    ]);
    const arm = new THREE.Mesh(armGeo, this.matWiper);
    /* ブレードのゴム(窓に当たる黒い帯) */
    const rubber = new THREE.Mesh(new THREE.BoxGeometry(armLen * 0.8, 0.004, 0.006), this.matRubber);
    rubber.position.set(-armLen * 0.52, 0.017, -0.007);
    /* 根元のメッキのキャップ */
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.03, 12), this.matChrome);
    cap.rotation.x = Math.PI / 2;
    cap.position.z = 0.006;
    this.wiper.add(arm, rubber, cap);
    this.wiper.traverse((o) => { o.renderOrder = 13; });
    this.wiper.rotation.z = -this.wiperAng;
    this.root.add(this.wiper);
    this._wiperLen = armLen;
    this._pivotNdc = pivotNdc;
    this._rects = null;
  }

  /* 雨滴を描く範囲(画面の正規化座標 0..1, 左上原点)と角の丸み(rTop/rBot: 画面の高さに対する比)。
   * 窓の形はななめの辺があるので、かならずガラスの内側になるよう内寄りの四角にする。
   * 作りなおしたときだけ新しい配列(毎フレーム同じものを返す) */
  windowRects() {
    const L = this.layout;
    if (!L) return null;
    if (this._rects && this._rectsL === L) return this._rects;
    const toU = (x) => (x + 1) / 2, toV = (y) => (1 - y) / 2;
    const ap = L.aPillar, cx = L.cX, cw = L.cW, m = 0.004;
    this._rectsL = L;
    this._rects = [
      { x0: toU(-1 + ap + m), x1: toU(cx - cw * 0.5 - m), y0: toV(L.top), y1: toV(L.dash + 0.012), rTop: L.rTop, rBot: L.rBot },
      { x0: toU(cx + cw * 0.62 + m), x1: 1, y0: toV(L.top), y1: toV(L.dash + 0.012), rTop: L.rTop, rBot: L.rBot },
    ];
    return this._rects;
  }

  /* ワイパーの根元・長さ(画面の高さに対する比)・角度。毎フレーム呼ばれるので同じ箱を書きかえて返す */
  wiperScreen() {
    if (!this.layout) return null;
    const o = this._wpS || (this._wpS = { px: 0, py: 0, len: 0, ang: 0 });
    o.px = (this._pivotNdc[0] + 1) / 2;
    o.py = (1 - this._pivotNdc[1]) / 2;
    o.len = (this._wiperLen / TAN) / 2;   // ndcでの腕の長さ(縦基準)
    o.ang = this.wiperAng;
    return o;
  }

  /* 明るさが変わったときだけ、各部の色を計器盤と同じ式で決めなおす */
  _applyShade() {
    const l = this.light, s = this._tmpS, c = this._tmpC;
    const set = (m, col) => { shade(col, l, s); m.color.setRGB(s[0], s[1], s[2], THREE.SRGBColorSpace); };
    set(this.matFrame, COL.frame);
    set(this.matSeal, COL.seal);
    set(this.matDashEdge, COL.dashEdge);
    set(this.matWiper, COL.wiper);
    set(this.matRubber, COL.rubber);
    set(this.matChrome, COL.chrome);
    set(this.matSill, COL.snow);
    /* 天板: テクスチャの地(#2a2e31)が shade('#2c3237') になる倍率(リニア) */
    shade(COL.dash, l, s);
    const b = COL.dashBase;
    c.setRGB(s2l(s[0]) / s2l(b[0]), s2l(s[1]) / s2l(b[1]), s2l(s[2]) / s2l(b[2]), THREE.LinearSRGBColorSpace);
    this.matDash.color.copy(c);
    this._shadeL = l;
  }

  /* light: 0..1 室内の明るさ(計器盤 #cab の減光にも使う: cab.setLight)
   * wiper: false / true / 'on' / 'int'(5秒休んで1回ふく)。snow: 目が外の雪の中にいる */
  update(dt, opt) {
    const o = opt || {};
    const light = o.light == null ? 1 : o.light;
    const wiper = o.wiper === 'int' ? 'int' : o.wiper ? 'on' : false;
    /* なめらかに追従(時定数0.33秒)。dt は描画側で0.1秒に切られるので、
     * 描画が重い端末でも実時間で追いつくよう経過時間の大きいほうを使う */
    const now = typeof performance !== 'undefined' ? performance.now() : 0;
    const rdt = this._lt != null ? Math.min(2, (now - this._lt) / 1000) : dt;
    this._lt = now;
    this.light += (light - this.light) * Math.min(1, Math.max(dt, rdt) * 3);
    if (Math.abs(this.light - light) < 0.002) this.light = light;
    if (Math.abs(this.light - this._shadeL) > 0.005 || (this.light === light && this._shadeL !== light)) this._applyShade();
    /* 雪: 外にいるあいだ20秒かけて積もり、屋内・雪なしでは8秒でとける。
     * 雪の日の運転のはじめ(1分以上 雪を見ていなかった)は、もう少し積もっているところから */
    if (dt > 0) {
      const want = o.snow ? 1 : 0;
      if (want && this._noSnowT > 60) this._sill = Math.max(this._sill, 0.6);
      this._noSnowT = want ? 0 : this._noSnowT + dt;
      this._sill += (want - this._sill) * Math.min(1, dt / (want ? 20 : 8));
      if (!want && this._sill < 0.01) this._sill = 0;
    }
    if (this.sill) {
      const vis = this._sill > 0.01;
      if (this.sill.visible !== vis) this.sill.visible = vis;
      if (vis) this.matSill.opacity = Math.min(0.92, this._sill);
    }
    /* ワイパー: 1往復1.4秒。'int' は5秒休んでから1往復。止めるときは往復の終わり(位相が一周した)で止める */
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
        const swing = 0.5 - 0.5 * Math.cos(ph * Math.PI * 2);
        this.wiperAng = this.wiperRest + swing * 1.55;
      }
    } else {
      this.wiperAng = this.wiperRest;
      if (wiper !== 'int') this._rest = 0;
    }
    if (this.wiper) this.wiper.rotation.z = -this.wiperAng;
  }
}
