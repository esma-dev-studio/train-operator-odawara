/* =========================================================
 * scene/town.js — 沿線の街(P1): 線路に沿った街区・側道と電柱・戸建て・遠景・森の丘・木のLOD
 *
 * ・占有グリッド rs._occ (3mマス, キー `${ix},${iz}`)に線路・ホーム・駅舎・道路・建物を
 *   書き込み、建物どうしや線路との重なりを防ぐ。
 * ・インスタンスは線路の距離 s ごとの「かたまり(チャンク)」に自前で分ける(視錐台カリング用。
 *   _splitInstances には任せず userData.noSplit)。影は「線路の近くのインスタンスだけ」を
 *   先頭に並べ、影描画のときだけ count を減らして描く(メッシュを2つに分けずに済む)。
 * ・毎フレームの処理は updateTown(rs, dt)(_updateCrossings から呼ばれる)。割り当てなし。
 * ========================================================= */
import * as THREE from '../vendor/three.module.min.js';
import { FACADE, facadeMaterial, uFcLit } from './facade.js';

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const HARD = 2, SOFT = 1;            // 占有の強さ: 2=線路・道路・駅など(絶対に避ける) 1=建物
const CELL = 3;                      // 占有グリッドのマス(m)
const QUAL = { low: 0.5, mid: 0.75, high: 1 };

/* ---------- 小さな道具 ---------- */
export function makeRng(seed) {
  let x = seed % 2147483647;
  if (x <= 0) x += 2147483646;
  return () => (x = (x * 16807) % 2147483647) / 2147483647;
}
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

/* s(m)の位置・水平の接線・左向きを o に書く(割り当てなし) */
function sampleFrame(F, step, s, o) {
  const f = s / step;
  const i = Math.max(0, Math.min(F.length - 2, Math.floor(f)));
  const k = clamp(f - i, 0, 1);
  const a = F[i], b = F[i + 1];
  o.x = a.p.x + (b.p.x - a.p.x) * k;
  o.y = a.p.y + (b.p.y - a.p.y) * k;
  o.z = a.p.z + (b.p.z - a.p.z) * k;
  let tx = a.t.x + (b.t.x - a.t.x) * k, tz = a.t.z + (b.t.z - a.t.z) * k;
  const n = Math.hypot(tx, tz) || 1;
  tx /= n; tz /= n;
  o.tx = tx; o.tz = tz;
  o.lx = tz; o.lz = -tx;               // 左 = UP × t
  o.yaw = Math.atan2(tx, tz);          // ローカル+zを進行方向へ向ける回転
  return o;
}
const FR = () => ({ x: 0, y: 0, z: 0, tx: 0, tz: 1, lx: 1, lz: 0, yaw: 0 });

/* ローカル+xを (dx,dz) に向ける回転角 */
const yawFromX = (dx, dz) => Math.atan2(-dz, dx);

/* ---------- 占有グリッド ---------- */
const okey = (x, z) => Math.floor(x / CELL) + ',' + Math.floor(z / CELL);
function occPut(occ, x, z, v) {
  const k = okey(x, z);
  const o = occ.get(k);
  if (o === undefined || o < v) occ.set(k, v);
}
/* 回転した長方形(中心cx,cz・軸ax=(axx,axz) az=(azx,azz)・半幅hx,hz)を書く */
function fpStamp(occ, cx, cz, axx, axz, azx, azz, hx, hz, v) {
  const nx = Math.max(1, Math.ceil((2 * hx) / 1.5)), nz = Math.max(1, Math.ceil((2 * hz) / 1.5));
  for (let i = 0; i <= nx; i++) {
    const u = -hx + (2 * hx * i) / nx;
    for (let j = 0; j <= nz; j++) {
      const w = -hz + (2 * hz * j) / nz;
      occPut(occ, cx + axx * u + azx * w, cz + axz * u + azz * w, v);
    }
  }
}
/* ぶつかるか: 外形全体で HARD を、内側(inset)で SOFT 以上を調べる */
function fpHit(occ, cx, cz, axx, axz, azx, azz, hx, hz, inset) {
  const nx = Math.max(1, Math.ceil((2 * hx) / 2.5)), nz = Math.max(1, Math.ceil((2 * hz) / 2.5));
  for (let i = 0; i <= nx; i++) {
    const u = -hx + (2 * hx * i) / nx;
    for (let j = 0; j <= nz; j++) {
      const w = -hz + (2 * hz * j) / nz;
      const v = occ.get(okey(cx + axx * u + azx * w, cz + axz * u + azz * w));
      if (v !== undefined && v >= HARD) return true;
    }
  }
  const sx = hx - inset, sz = hz - inset;
  if (sx > 0.2 && sz > 0.2) {
    const mx = Math.max(1, Math.ceil((2 * sx) / 2.5)), mz = Math.max(1, Math.ceil((2 * sz) / 2.5));
    for (let i = 0; i <= mx; i++) {
      const u = -sx + (2 * sx * i) / mx;
      for (let j = 0; j <= mz; j++) {
        const w = -sz + (2 * sz * j) / mz;
        const v = occ.get(okey(cx + axx * u + azx * w, cz + axz * u + azz * w));
        if (v !== undefined && v >= SOFT) return true;
      }
    }
  }
  return false;
}
/* (s, 横オフセット) の長方形を書く(線路に沿って曲がる帯) */
function stampBand(rs, s0, s1, o0, o1, v) {
  const fr = FR();
  const a = Math.min(o0, o1), b = Math.max(o0, o1);
  for (let s = s0; s <= s1; s += 2) {
    sampleFrame(rs.frames, rs.step, s, fr);
    for (let o = a; o <= b; o += 1.5) occPut(rs._occ, fr.x + fr.lx * o, fr.z + fr.lz * o, v);
    occPut(rs._occ, fr.x + fr.lx * b, fr.z + fr.lz * b, v);
  }
}
export function occFree(rs, x, z) { return !rs._occ || !rs._occ.has(okey(x, z)); }

/* ---------- 形状をまとめる(position/normal/uv/color) ---------- */
/* parts: [{ g: BufferGeometry, col?: [r,g,b] (リニア。>=2 は幹などの「固定色」フラグ) }] */
export function mergeParts(parts, withColor = true) {
  const list = parts.map((p) => ({ g: p.g.index ? p.g.toNonIndexed() : p.g, col: p.col }));
  const n = list.reduce((a, p) => a + p.g.attributes.position.count, 0);
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  const col = withColor ? new Float32Array(n * 3) : null;
  let o = 0;
  list.forEach(({ g, col: c }) => {
    const cnt = g.attributes.position.count;
    pos.set(g.attributes.position.array, o * 3);
    if (g.attributes.normal) nor.set(g.attributes.normal.array, o * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array, o * 2);
    if (col) {
      if (c) for (let i = 0; i < cnt; i++) { col[(o + i) * 3] = c[0]; col[(o + i) * 3 + 1] = c[1]; col[(o + i) * 3 + 2] = c[2]; }
      else if (g.attributes.color) col.set(g.attributes.color.array, o * 3);
      else col.fill(1, o * 3, (o + cnt) * 3);
    }
    o += cnt;
  });
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (col) out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return out;
}

/* 多角形(x-y平面・反時計回り)を z0..z1 に押し出した角柱(面ごとの法線・UVは辺に沿って) */
function prism(poly, z0, z1, { caps = true, skipEdge = -1 } = {}) {
  const pos = [], nor = [], uv = [];
  const tri = (a, b, c, n, ua, ub, uc) => {
    pos.push(...a, ...b, ...c); nor.push(...n, ...n, ...n); uv.push(...ua, ...ub, ...uc);
  };
  const n = poly.length;
  if (caps) {
    for (let k = 1; k < n - 1; k++) {
      const A = poly[0], B = poly[k], C = poly[k + 1];
      tri([A[0], A[1], z1], [B[0], B[1], z1], [C[0], C[1], z1], [0, 0, 1], [A[0] + 0.5, A[1]], [B[0] + 0.5, B[1]], [C[0] + 0.5, C[1]]);
      tri([A[0], A[1], z0], [C[0], C[1], z0], [B[0], B[1], z0], [0, 0, -1], [0.5 - A[0], A[1]], [0.5 - C[0], C[1]], [0.5 - B[0], B[1]]);
    }
  }
  for (let k = 0; k < n; k++) {
    if (k === skipEdge) continue;
    const A = poly[k], B = poly[(k + 1) % n];
    const dx = B[0] - A[0], dy = B[1] - A[1], l = Math.hypot(dx, dy) || 1;
    const nn = [dy / l, -dx / l, 0];
    const Ap = [A[0], A[1], z1], Am = [A[0], A[1], z0], Bp = [B[0], B[1], z1], Bm = [B[0], B[1], z0];
    tri(Ap, Bm, Bp, nn, [0, 1], [1, 0], [1, 1]);
    tri(Ap, Am, Bm, nn, [0, 1], [0, 0], [1, 0]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

const srgbLin = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };

/* ---------- 単位形状(モジュールで1回だけ作る) ---------- */
const GEO = {};
function geoUnitBox() {
  if (!GEO.box) { GEO.box = new THREE.BoxGeometry(1, 1, 1); GEO.box.translate(0, 0.5, 0); }
  return GEO.box;
}
/* 切妻(きりづま)の家: 壁は y .78 まで、棟(むね)は y 1.0 で z方向 */
const EAVE = 0.78;
function geoGable() {
  if (!GEO.gable) GEO.gable = prism([[-0.5, 0], [0.5, 0], [0.5, EAVE], [0, 1], [-0.5, EAVE]], -0.5, 0.5, { skipEdge: 0 });
  return GEO.gable;
}
/* 屋根板2枚(同じ単位空間・軒の出 .06) */
function geoGableRoof() {
  if (GEO.groof) return GEO.groof;
  const ov = 0.06, t = 0.035;
  const sl = (1 - EAVE) / 0.5;
  const nl = [-(1 - EAVE), 0.5]; const ln = Math.hypot(nl[0], nl[1]); nl[0] /= ln; nl[1] /= ln;
  const Le = [-0.5 - ov, EAVE - ov * sl + 0.004], R = [0, 1.004];
  const L2 = [Le[0] + nl[0] * t, Le[1] + nl[1] * t], R2 = [R[0] + nl[0] * t, R[1] + nl[1] * t];
  const left = prism([Le, R, R2, L2], -0.5 - ov, 0.5 + ov);
  const m = (p) => [-p[0], p[1]];
  const right = prism([m(L2), m(R2), m(R), m(Le)], -0.5 - ov, 0.5 + ov);
  GEO.groof = mergeParts([{ g: left }, { g: right }], false);
  return GEO.groof;
}
/* 高架水槽(円筒+4本脚) */
function geoTank() {
  if (GEO.tank) return GEO.tank;
  const cyl = new THREE.CylinderGeometry(1.1, 1.1, 1.8, 10); cyl.translate(0, 1.2 + 0.9, 0);
  const parts = [{ g: cyl, col: srgbLin(0xd2d6d8) }];
  [[-0.75, -0.75], [0.75, -0.75], [-0.75, 0.75], [0.75, 0.75]].forEach(([x, z]) => {
    const l = new THREE.BoxGeometry(0.12, 1.2, 0.12); l.translate(x, 0.6, z);
    parts.push({ g: l, col: srgbLin(0x7e8286) });
  });
  GEO.tank = mergeParts(parts);
  return GEO.tank;
}
/* 電柱(コンクリート柱+腕金2本)。variant: 'L'=街灯つき 'T'=変圧器つき */
function geoPole(variant) {
  const k = 'pole' + variant;
  if (GEO[k]) return GEO[k];
  const conc = srgbLin(0xa3a29c), steel = srgbLin(0x5f6366);
  const p = new THREE.CylinderGeometry(0.13, 0.17, 11, 6, 1, true); p.translate(0, 5.5, 0);
  const a1 = new THREE.BoxGeometry(1.7, 0.1, 0.1); a1.translate(0, 10.2, 0);
  const a2 = new THREE.BoxGeometry(1.2, 0.1, 0.1); a2.translate(0, 9.4, 0);
  const parts = [{ g: p, col: conc }, { g: a1, col: steel }, { g: a2, col: steel }];
  /* 碍子(白い小さな突起) */
  [-0.8, 0, 0.8].forEach((x) => { const g = new THREE.BoxGeometry(0.08, 0.16, 0.08); g.translate(x, 10.33, 0); parts.push({ g, col: srgbLin(0xe8e6e0) }); });
  if (variant === 'T') {
    const t = new THREE.CylinderGeometry(0.3, 0.3, 1.0, 8); t.translate(0, 8.3, -0.42);
    parts.push({ g: t, col: srgbLin(0x8f969b) });
  } else {
    const arm = new THREE.BoxGeometry(1.3, 0.06, 0.06); arm.translate(0.65, 6.45, 0);
    const head = new THREE.BoxGeometry(0.5, 0.12, 0.25); head.translate(1.3, 6.38, 0);
    parts.push({ g: arm, col: steel }, { g: head, col: srgbLin(0xf1efe6) });
  }
  GEO[k] = mergeParts(parts);
  return GEO[k];
}

/* ---------- インスタンスをチャンクに分けて置く ---------- */
const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _sc = new THREE.Vector3(), _c = new THREE.Color();
function shadowNearOnly() { this.userData.fullCount = this.count; this.count = this.userData.nearCount; }
function shadowRestore() { this.count = this.userData.fullCount; }
/* items: {x,y,z,yaw,sx,sy,sz,r,g,b(リニア),s,sh(影を落とす)} */
/* chunk: 数値なら s をその長さで区切る。関数なら item → キー */
function emitInstanced(group, geo, mat, items, chunk, opt = {}) {
  const { shadow = false, receive = true, colors = true } = opt;
  const buckets = new Map();
  const keyOf = typeof chunk === 'function' ? chunk : (it) => Math.floor(it.s / chunk);
  items.forEach((it) => {
    const k = keyOf(it);
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = []));
    b.push(it);
  });
  const out = [];
  buckets.forEach((arr) => {
    if (shadow) arr.sort((a, b) => (b.sh ? 1 : 0) - (a.sh ? 1 : 0));
    const im = new THREE.InstancedMesh(geo, mat, arr.length);
    let near = 0;
    arr.forEach((it, i) => {
      _q.setFromAxisAngle(Y_AXIS, it.yaw || 0);
      _p.set(it.x, it.y, it.z);
      _sc.set(it.sx, it.sy, it.sz);
      _m4.compose(_p, _q, _sc);
      im.setMatrixAt(i, _m4);
      if (colors) { _c.setRGB(it.r, it.g, it.b); im.setColorAt(i, _c); }
      if (it.sh) near++;
    });
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.castShadow = shadow && near > 0;
    im.receiveShadow = receive;
    im.userData.noSplit = true;
    if (im.castShadow && near < arr.length) {
      im.userData.nearCount = near;
      im.onBeforeShadow = shadowNearOnly;
      im.onAfterShadow = shadowRestore;
    }
    im.computeBoundingSphere();
    group.add(im);
    out.push(im);
  });
  return out;
}

/* sRGBの見た目の色 + 明るさのゆらぎ → リニアRGBを it に書く */
function paint(it, hex, jit, rng) {
  _c.setHex(hex);
  const r0 = _c.r, g0 = _c.g, b0 = _c.b;
  /* 見た目(sRGB)でゆらす */
  const k = 1 + (rng() - 0.5) * 2 * jit;
  _c.setRGB(r0, g0, b0);
  const sr = Math.pow(r0, 1 / 2.2) * k, sg = Math.pow(g0, 1 / 2.2) * k * (1 + (rng() - 0.5) * 0.03), sb = Math.pow(b0, 1 / 2.2) * k;
  _c.setRGB(clamp(sr, 0, 1), clamp(sg, 0, 1), clamp(sb, 0, 1), THREE.SRGBColorSpace);
  it.r = _c.r; it.g = _c.g; it.b = _c.b;
  return it;
}
const pick = (arr, rng) => arr[Math.floor(rng() * arr.length) % arr.length];

/* ---------- 材質(RailScene ごとに1回。路線を作り直しても使い回す=再コンパイルしない) ---------- */
function materials(rs) {
  if (rs._p1M) return rs._p1M;
  const keep = (m) => { rs._keep.add(m); if (m.map) rs._keep.add(m.map); (m.userData.fcTex || []).forEach((t) => rs._keep.add(t)); return m; };
  const M = {};
  ['mansion', 'office', 'tower', 'zakkyo', 'shop', 'house'].forEach((k) => { M[k] = keep(facadeMaterial(k)); });
  M.box = keep(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 }));
  M.tank = keep(new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.6, metalness: 0.2 }));
  M.roof = keep(new THREE.MeshStandardMaterial({ map: texRoof(), color: 0xffffff, roughness: 0.78 }));
  M.pole = keep(new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.9 }));
  M.ao = keep(new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false }));
  M.wire = keep(new THREE.LineBasicMaterial({ color: 0x23272b }));
  M.glow = keep(new THREE.PointsMaterial({
    map: texGlowP1(), size: 2.6, sizeAttenuation: true, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, color: new THREE.Color(0xffe2b0).multiplyScalar(2.5),
  }));
  M.stone = keep(new THREE.MeshStandardMaterial({ color: 0xa9a59c, roughness: 0.95 }));
  M.facades = ['mansion', 'office', 'tower', 'zakkyo', 'shop', 'house'].map((k) => M[k]);
  /* 道路のアスファルト(this.M に登録して _keep で守る) */
  if (!rs.M.roadAsphalt) {
    const t = texRoad();
    rs.M.roadAsphalt = new THREE.MeshStandardMaterial({
      map: t, roughness: 0.92, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
    });
    rs._keep.add(rs.M.roadAsphalt); rs._keep.add(t);
  }
  M.road = rs.M.roadAsphalt;
  rs._p1M = M;
  return M;
}

/* ---------- テクスチャ(キャンバスはモジュールで1回だけ描く) ---------- */
const CV = {};
function canvasOnce(key, w, h, draw) {
  if (!CV[key]) {
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    draw(cv.getContext('2d'), w, h);
    CV[key] = cv;
  }
  return CV[key];
}
function texFrom(cv, srgb = true, repeat = true) {
  const t = new THREE.CanvasTexture(cv);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
/* 道路: 64x256 = 幅5m×長さ20m。白い外側線・小石・わだち */
function texRoad() {
  const cv = canvasOnce('road', 64, 256, (c) => {
    const r = makeRng(55);
    c.fillStyle = '#5d5f61'; c.fillRect(0, 0, 64, 256);
    for (let i = 0; i < 1500; i++) {
      const v = Math.floor(r() * 255);
      c.fillStyle = `rgba(${v},${v},${v},.12)`;
      c.fillRect(r() * 64, r() * 256, 1, 1);
    }
    c.fillStyle = 'rgba(0,0,0,.06)'; c.fillRect(16, 0, 8, 256); c.fillRect(40, 0, 8, 256);   // わだち
    for (let i = 0; i < 6; i++) { c.fillStyle = 'rgba(30,30,30,.08)'; c.fillRect(r() * 60, r() * 256, 4 + r() * 8, 2 + r() * 6); }
    c.fillStyle = '#e9e9e4'; c.fillRect(4, 0, 2, 256); c.fillRect(58, 0, 2, 256);
  });
  return texFrom(cv);
}
/* 屋根(スレート/コロニアルの段) */
function texRoof() {
  const cv = canvasOnce('roof', 64, 64, (c) => {
    c.fillStyle = '#d4d4d2'; c.fillRect(0, 0, 64, 64);
    for (let x = 0; x < 64; x += 4) { c.fillStyle = 'rgba(0,0,0,.22)'; c.fillRect(x, 0, 1, 64); c.fillStyle = 'rgba(255,255,255,.12)'; c.fillRect(x + 1, 0, 1, 64); }
    const r = makeRng(77);
    for (let i = 0; i < 40; i++) { c.fillStyle = `rgba(0,0,0,${(r() * 0.06).toFixed(3)})`; c.fillRect(Math.floor(r() * 16) * 4, r() * 64, 4, 3 + r() * 10); }
  });
  return texFrom(cv);
}
/* 街灯のにじみ */
function texGlowP1() {
  const cv = canvasOnce('glow', 64, 64, (c) => {
    const g = c.createRadialGradient(32, 32, 1, 32, 32, 31);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(255,255,255,.45)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g; c.fillRect(0, 0, 64, 64);
  });
  return texFrom(cv, true, false);
}
/* 葉のまだら(グレースケール。インスタンス色がそのまま効く) */
export function texLeaf() {
  const cv = canvasOnce('leaf', 128, 128, (c) => {
    const r = makeRng(91);
    c.fillStyle = 'rgb(205,205,205)'; c.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 300; i++) {
      const v = 160 + Math.floor(r() * 95);
      c.fillStyle = `rgb(${v},${v},${v})`;
      const x = r() * 128, y = r() * 128, rr = 2 + r() * 4;
      [[0, 0], [128, 0], [-128, 0], [0, 128], [0, -128]].forEach(([dx, dy]) => { c.beginPath(); c.arc(x + dx, y + dy, rr, 0, 7); c.fill(); });
    }
  });
  return texFrom(cv);
}
/* 森(上から見た樹冠のまだら) */
function texForest() {
  const cv = canvasOnce('forest', 256, 256, (c) => {
    const r = makeRng(313);
    c.fillStyle = '#2b3a25'; c.fillRect(0, 0, 256, 256);
    const cols = ['#2f4128', '#3b5130', '#4a6239', '#56703f', '#405a34'];
    const blob = (x, y, rr, fill) => {
      c.fillStyle = fill;
      [[0, 0], [256, 0], [-256, 0], [0, 256], [0, -256]].forEach(([dx, dy]) => { c.beginPath(); c.arc(x + dx, y + dy, rr, 0, 7); c.fill(); });
    };
    for (let i = 0; i < 400; i++) blob(r() * 256, r() * 256, 6 + r() * 12, pick(cols, r));
    for (let i = 0; i < 200; i++) blob(r() * 256, r() * 256, 2 + r() * 5, 'rgba(10,16,8,.3)');
    /* 樹冠の上側のハイライト */
    for (let i = 0; i < 160; i++) blob(r() * 256, r() * 256, 2 + r() * 4, 'rgba(140,170,100,.10)');
  });
  return texFrom(cv);
}

/* =========================================================
 * 街の組み立て(_buildTown から呼ばれる)
 * ========================================================= */
export function buildTown(rs) {
  const L = rs.line.meta.length;
  const T = {
    frame: 0, rev: null, lodX: 1e9, lodZ: 1e9, fb: { tod: null, w: null, rev: '', night: false, eve: false, rain: false, snow: false, wet: false, indoor: false },
    treeCells: [], glows: [], groups: {},
  };
  rs._town = T;
  rs._occ = new Map();
  rs._roadRuns = [];
  rs._crossStreets = [];
  rs._treeQueue = [];
  rs._groves = [];
  const M = materials(rs);
  T.M = M;
  const qk = QUAL[rs.quality] != null ? QUAL[rs.quality] : 1;
  T.q = qk;
  const grp = (name) => {
    const g = new THREE.Group();
    g.userData.p1cat = name;
    rs.world.add(g);
    T.groups[name] = g;
    return g;
  };
  ['town', 'houses', 'streets', 'skyline'].forEach(grp);

  /* 区間の種類(10mごと)と駅の近さ */
  const urban = rs.line.sections.urban;
  const kinds = new Uint8Array(Math.ceil(L / 10) + 2);
  for (let i = 0; i < kinds.length; i++) {
    const s = i * 10;
    kinds[i] = (urban.find((u) => s >= u.from && s < u.to) || { kind: 2 }).kind;
  }
  T.kindAt = (s) => kinds[clamp(Math.floor(s / 10), 0, kinds.length - 1)];
  const sts = rs.line.stations;
  T.nearSt = (s) => {
    let best = 0;
    for (let i = 0; i < sts.length; i++) {
      const d = (s - (sts[i].s - 70)) / 320;
      const v = Math.exp(-d * d);
      if (v > best) best = v;
    }
    return best;
  };
  const sj = sts.find((st) => st.name === '新宿');
  T.sShinjuku = sj ? sj.s : -1e9;
  const QO = rs.quadOff || [3.8, 7.6];
  const q = rs.line.sections.quad;
  T.inQuad = (s) => s > q.from - 30 && s < q.to + 30;
  T.fence = (side, s) => (side > 0 ? (T.inQuad(s) ? QO[1] + 3.6 : 5.4) : 8.9);
  T.inRiver = (s, m) => rs.line.sections.river.some((r) => s > r.from - m && s < r.to + m);
  T.skipS = (s) => rs._inTunnel(s) || rs._inTerminal(s, 45);

  /* --- 線路の回廊・ホーム・駅舎を占有に書く --- */
  const fr = FR();
  for (let s = 0; s <= L; s += 2.5) {
    sampleFrame(rs.frames, rs.step, s, fr);
    const left = T.inQuad(s) ? QO[1] + 5.2 : 8;
    for (let o = -11; o <= left; o += 1.5) occPut(rs._occ, fr.x + fr.lx * o, fr.z + fr.lz * o, HARD);
    occPut(rs._occ, fr.x + fr.lx * left, fr.z + fr.lz * left, HARD);
  }
  sts.forEach((st) => {
    stampBand(rs, st.s - 160, st.s + 20, 1.58, 5.0, HARD);
    stampBand(rs, st.s - 160, st.s + 20, -5.38, -8.8, HARD);
    if (!rs._inTunnel(st.s) && st.name !== '新宿') stampBand(rs, st.s - 78, st.s - 32, -9, -24, HARD);   // 駅舎と駅前
  });
  landmarkZones(rs, T);

  /* --- 森の小島(雑木林)の場所を先に確保 --- */
  planGroves(rs, T);

  buildStreets(rs, T);
  buildBuildings(rs, T);
  buildHouses(rs, T);
  buildSkyline(rs, T);
}

/* ランドマークの敷地(鳥居の社叢・梅林・観覧車・車両基地)を先に押さえる */
function landmarkZones(rs, T) {
  const at = (n) => rs._stationS(n);
  const s1 = at('代々木八幡');
  if (s1 !== null) stampBand(rs, s1 - 215, s1 - 165, -9, -58, HARD);
  const s2 = at('梅ヶ丘');
  if (s2 !== null) stampBand(rs, s2 - 160, s2 + 160, -10, -46, HARD);
  const s3 = at('読売ランド前');
  if (s3 !== null) stampBand(rs, s3 + 200, s3 + 360, 95, 200, HARD);
  if (rs.depotZone) stampBand(rs, rs.depotZone.a - 40, rs.depotZone.b + 40, -9, -45, HARD);
  T.landmarkSkip = (side, s) =>
    (side < 0 && s1 !== null && s > s1 - 225 && s < s1 - 155) ||
    (side < 0 && s2 !== null && s > s2 - 170 && s < s2 + 170) ||
    (side < 0 && rs.depotZone && s > rs.depotZone.a - 40 && s < rs.depotZone.b + 40);
}

function planGroves(rs, T) {
  const L = rs.line.meta.length;
  const rng = makeRng(8642);
  const fr = FR();
  for (let s = 600; s < L - 300; s += 1000 + rng() * 400) {
    const k = T.kindAt(s);
    if (k < 2 || T.skipS(s) || T.inRiver(s, 150)) continue;
    const side = rng() < 0.5 ? 1 : -1;
    if (T.landmarkSkip(side, s)) continue;
    const lat = 45 + rng() * 50;
    sampleFrame(rs.frames, rs.step, s, fr);
    const x = fr.x + fr.lx * side * lat, z = fr.z + fr.lz * side * lat;
    const r = 26 + rng() * 10;
    rs._groves.push({ s, side, lat, x, z, y: fr.y, r });
    stampBand(rs, s - r, s + r, side * (lat - r), side * (lat + r), HARD);
  }
}

/* ---------- 側道・交差道路・電柱・電線・街灯 ---------- */
function buildStreets(rs, T) {
  const F = rs.frames, step = rs.step, L = rs.line.meta.length;
  const rng = makeRng(2468);
  const M = T.M;
  const crossS = rs.crossSpots || [];
  const sts = rs.line.stations;
  const nearHouse = (s) => sts.some((st) => s > st.s - 170 && s < st.s + 30);
  /* 側道を置けない所 */
  const blocked = (side, s) =>
    T.skipS(s) || T.inRiver(s, 60) || T.kindAt(s) === 0 || T.landmarkSkip(side, s) ||
    (side < 0 && nearHouse(s)) || rs._inTunnel(s + 30) || rs._inTunnel(s - 30);
  /* 踏切の近くは道路を踏切の高さまで上げる(段差をなくす) */
  const rampY = (s) => {
    let y = -0.4;
    for (let i = 0; i < crossS.length; i++) {
      const d = Math.abs(s - crossS[i]);
      if (d < 16) y = Math.max(y, -0.4 + 0.52 * clamp((16 - d) / 12, 0, 1));
    }
    return y;
  };
  const roadEdge = (side, s) => T.fence(side, s) + 0.8;

  /* 道路面はチャンク(700m)ごとに1つのジオメトリにまとめる */
  const CH = 700;
  const roadBufs = new Map();
  const rb = (s) => {
    const k = Math.floor(s / CH);
    let b = roadBufs.get(k);
    if (!b) roadBufs.set(k, (b = { pos: [], uv: [], idx: [], n: 0 }));
    return b;
  };
  const quad = (b, a0, a1, b0, b1, ua, ub, va, vb) => {
    /* a0-a1: 手前の辺(左右) b0-b1: 奥の辺。面が上を向くように巻き順を選ぶ */
    const n = b.n;
    b.pos.push(...a0, ...a1, ...b0, ...b1);
    b.uv.push(ua, va, ub, va, ua, vb, ub, vb);
    const ex = b0[0] - a0[0], ez = b0[2] - a0[2], fx = a1[0] - a0[0], fz = a1[2] - a0[2];
    if (ez * fx - ex * fz > 0) b.idx.push(n, n + 2, n + 1, n + 1, n + 2, n + 3);
    else b.idx.push(n, n + 1, n + 2, n + 1, n + 3, n + 2);
    b.n += 4;
  };

  /* 電柱・電線・街灯 */
  const poles = [];                 // {x,y,z,yaw,s,sh,variant,ax,az}
  const wires = new Map();          // chunk → [] 線分
  const glowPts = new Map();        // chunk → []
  const wb = (s) => { const k = Math.floor(s / CH); let a = wires.get(k); if (!a) wires.set(k, (a = [])); return a; };
  const gb = (s) => { const k = Math.floor(s / CH); let a = glowPts.get(k); if (!a) glowPts.set(k, (a = [])); return a; };
  /* 2本の電柱の間に、たるんだ電線(電力3本+通信1本)を張る */
  const ATT = [[-0.8, 10.33], [0, 10.33], [0.8, 10.33], [0.3, 7.4]];
  const span = (A, B, s) => {
    const arr = wb(s);
    ATT.forEach(([ox, oy]) => {
      const ax = A.x + A.ax * ox, az = A.z + A.az * ox, ay = A.y + oy;
      const bx = B.x + B.ax * ox, bz = B.z + B.az * ox, by = B.y + oy;
      let px = ax, py = ay, pz = az;
      for (let k = 1; k <= 4; k++) {
        const t = k / 4;
        const x = lerp(ax, bx, t), z = lerp(az, bz, t), y = lerp(ay, by, t) - 0.35 * 4 * t * (1 - t);
        arr.push(px, py, pz, x, y, z);
        px = x; py = y; pz = z;
      }
    });
  };
  let poleN = 0;
  const addPole = (x, y, z, xdx, xdz, s, sh) => {
    const variant = poleN++ % 2 === 0 ? 'L' : 'T';
    const P = { x, y, z, yaw: yawFromX(xdx, xdz), s, sh, variant, ax: xdx, az: xdz, sx: 1, sy: 1, sz: 1 };
    poles.push(P);
    if (variant === 'L') gb(s).push(x + xdx * 1.3, y + 6.25, z + xdz * 1.3);
    return P;
  };

  /* (a) 側道: 300〜900mの区間を左右交互に(6割は左) */
  const fr = FR(), fr2 = FR();
  const runs = [];
  let s = 150, lastSide = 0;
  while (s < L - 120) {
    const len = 300 + rng() * 600;
    let side = rng() < 0.6 ? 1 : -1;
    if (side === lastSide && rng() < 0.6) side = -side;
    lastSide = side;
    /* 置ける所だけに切り分ける(柵の位置が変わる所でも切る) */
    let cur = null;
    for (let x = s; x <= Math.min(L - 60, s + len); x += 5) {
      const ok = !blocked(side, x);
      const e = roadEdge(side, x);
      if (ok && cur && Math.abs(cur.edge - e) < 0.01) { cur.s1 = x; continue; }
      if (cur && cur.s1 - cur.s0 >= 80) runs.push(cur);
      cur = ok ? { side, s0: x, s1: x, edge: e } : null;
    }
    if (cur && cur.s1 - cur.s0 >= 80) runs.push(cur);
    s += len + (rng() < 0.45 ? 0 : 40 + rng() * 160);
  }
  runs.forEach((run) => {
    const { side, edge } = run;
    const c = edge + 2.5;
    const i0 = Math.ceil(run.s0 / step), i1 = Math.floor(run.s1 / step);
    let prev = null;
    for (let i = i0; i <= i1; i++) {
      const ss = i * step;
      sampleFrame(F, step, ss, fr);
      const y = fr.y + rampY(ss);
      const a = [fr.x + fr.lx * side * (c - 2.5), y, fr.z + fr.lz * side * (c - 2.5)];
      const b = [fr.x + fr.lx * side * (c + 2.5), y, fr.z + fr.lz * side * (c + 2.5)];
      const cur = { a, b, v: ss / 20 };
      if (prev) quad(rb(ss), prev.a, prev.b, cur.a, cur.b, side > 0 ? 0 : 1, side > 0 ? 1 : 0, prev.v, cur.v);
      prev = cur;
    }
    /* 左側は「よこ」カメラ(線路から13.5m)の後ろに電柱・街路樹を置く(画面の手前をふさがない) */
    const poleOff = side > 0 ? Math.max(5.45, 14.4 - edge) : 5.45;
    stampBand(rs, run.s0, run.s1, side * edge, side * (edge + poleOff + 1.2), HARD);
    rs._roadRuns.push({ side, s0: run.s0, s1: run.s1, inner: edge, outer: edge + 5, clear: edge + poleOff + 1.2 });
    /* 電柱: 外側の縁に30mおき(線路側へ腕を出す) */
    let pa = null;
    for (let ps = run.s0 + 8; ps <= run.s1 - 4; ps += 30) {
      if (crossS.some((cs) => Math.abs(cs - ps) < 6)) continue;
      sampleFrame(F, step, ps, fr);
      const lat = side * (edge + poleOff);
      const P = addPole(fr.x + fr.lx * lat, fr.y - 0.5, fr.z + fr.lz * lat, -side * fr.lx, -side * fr.lz, ps, true);
      if (pa && ps - pa.s < 45) span(pa, P, ps);
      pa = P;
    }
    /* 街路樹(3割の側道) */
    if (rng() < 0.3) {
      for (let ts = run.s0 + 12; ts <= run.s1 - 6; ts += 9) {
        if (Math.abs(((ts - run.s0 - 8) % 30)) < 3.5) continue;
        sampleFrame(F, step, ts, fr);
        const lat = side * (edge + poleOff + 0.7);
        rs._treeQueue.push({ x: fr.x + fr.lx * lat, y: fr.y - 0.5, z: fr.z + fr.lz * lat, s: ts, sc: 0.8 + rng() * 0.25, tint: 0.85 + rng() * 0.25 });
      }
    }
  });
  const roadAt = (side, ss) => {
    for (let i = 0; i < rs._roadRuns.length; i++) {
      const r = rs._roadRuns[i];
      if (r.side === side && ss >= r.s0 && ss <= r.s1) return r;
    }
    return null;
  };
  T.roadAt = roadAt;

  /* (b) 交差道路: 線路から外へまっすぐ(踏切の位置には必ず両側) */
  const streets = [];
  for (let s2 = 200; s2 < L - 150;) {
    const k = T.kindAt(s2);
    s2 += k === 3 ? 160 + rng() * 100 : 90 + rng() * 60;
    if (k === 0) continue;
    [1, -1].forEach((side) => { if (rng() < 0.7) streets.push({ s: s2, side, cross: false }); });
  }
  crossS.forEach((cs) => { streets.push({ s: cs, side: 1, cross: true }); streets.push({ s: cs, side: -1, cross: true }); });
  const W = 2.25;
  streets.forEach((st) => {
    const { s: ss, side } = st;
    if (!st.cross) {
      if (T.skipS(ss) || T.inRiver(ss, 70) || T.landmarkSkip(side, ss) || T.kindAt(ss) === 0) return;
      if (side < 0 && sts.some((x) => ss > x.s - 90 && ss < x.s - 20)) return;
      if (crossS.some((cs) => Math.abs(cs - ss) < 40)) return;
    }
    sampleFrame(F, step, ss, fr);
    const road = roadAt(side, ss);
    let a = road ? road.outer : T.fence(side, ss) + 1.0;
    const bEnd = 150;
    const yg = fr.y - 0.41;
    const P = (o, y, dt) => [fr.x + fr.lx * side * o + fr.tx * dt, y, fr.z + fr.lz * side * o + fr.tz * dt];
    const b = rb(ss);
    if (st.cross) {
      /* 踏切: 道路板(56m・中心は-1.9m)の端から坂で地面へ */
      const aE = side > 0 ? 26.0 : 29.8;
      const yTop = fr.y + 0.12, mid = aE + 10;
      quad(b, P(aE, yTop, -2.6), P(aE, yTop, 2.6), P(mid, yg, -W), P(mid, yg, W), 0, 1, 0, 0.5);
      a = mid;
    }
    /* 地面の起伏に合わせて15mごとに区切る(帯は線路の標高で平ら) */
    const segs = Math.max(1, Math.ceil((bEnd - a) / 15));
    for (let k = 0; k < segs; k++) {
      const o0 = a + ((bEnd - a) * k) / segs, o1 = a + ((bEnd - a) * (k + 1)) / segs;
      quad(b, P(o0, yg, -W), P(o0, yg, W), P(o1, yg, -W), P(o1, yg, W), 0, 1, o0 / 20, o1 / 20);
    }
    rs._crossStreets.push({ s: ss, side, a, b: bEnd, cross: st.cross });
    stampBand(rs, ss - 3.3, ss + 3.3, side * a, side * bEnd, HARD);
    /* 交差道路の片側に電柱(120mまで)。腕は道路の中心へ */
    if (rng() < (T.q >= 1 ? 0.85 : T.q >= 0.75 ? 0.65 : 0.4)) {
      const sideT = rng() < 0.5 ? 1 : -1;
      let pa = null;
      for (let o = a + 6; o <= 120; o += 30) {
        const x = fr.x + fr.lx * side * o + fr.tx * sideT * (W + 0.55);
        const z = fr.z + fr.lz * side * o + fr.tz * sideT * (W + 0.55);
        const P2 = addPole(x, fr.y - 0.5, z, -sideT * fr.tx, -sideT * fr.tz, ss, false);
        if (pa) span(pa, P2, ss);
        pa = P2;
      }
    }
  });
  void fr2;

  /* --- メッシュ化 --- */
  const g = T.groups.streets;
  roadBufs.forEach((bf) => {
    if (!bf.n) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(bf.pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(bf.uv, 2));
    const nn = new Float32Array(bf.n * 3);
    for (let i = 0; i < bf.n; i++) nn[i * 3 + 1] = 1;
    geo.setAttribute('normal', new THREE.BufferAttribute(nn, 3));
    geo.setIndex(bf.idx);
    geo.computeBoundingSphere();
    const m = new THREE.Mesh(geo, M.road);
    m.receiveShadow = true;
    g.add(m);
  });
  ['L', 'T'].forEach((v) => {
    const list = poles.filter((p) => p.variant === v);
    if (list.length) emitInstanced(g, geoPole(v), M.pole, list, CH, { shadow: true, colors: false });
  });
  wires.forEach((arr) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    geo.computeBoundingSphere();
    g.add(new THREE.LineSegments(geo, M.wire));
  });
  glowPts.forEach((arr) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    geo.computeBoundingSphere();
    const pts = new THREE.Points(geo, M.glow);
    pts.renderOrder = 2;
    g.add(pts);
    T.glows.push(pts);
  });
}

/* ---------- 中高層の建物(線路と平行・駅前ほど高く密に) ---------- */
const PAL = {
  mansion: [0xe7e2d8, 0xd9ccb6, 0xcbb89c, 0xb9a68c, 0xefece6, 0xa9a49b, 0xd2c9bb],
  office: [0xc5c9cb, 0xaab1b6, 0xd7d5d0, 0x8f969c],
  tower: [0x9fb0bf, 0x7f93a6, 0xb8c3cc],
  zakkyo: [0xd8cfc0, 0xc4b8a6, 0xb7aa98, 0xe0dbd2],
  shop: [0xf2efe8, 0xe6e2da, 0xdcd8d0],
};
function pickType(kind, h, rng) {
  const r = rng();
  if (kind === 0) return h > 60 ? 'tower' : r < 0.5 ? 'office' : 'zakkyo';
  if (kind === 1) return r < 0.45 ? 'mansion' : r < 0.75 ? 'zakkyo' : 'office';
  if (kind === 2) return r < 0.8 ? 'mansion' : 'office';
  return 'mansion';
}

function buildBuildings(rs, T) {
  const F = rs.frames, step = rs.step, L = rs.line.meta.length;
  const rng = makeRng(12345);
  const lists = { mansion: [], office: [], tower: [], zakkyo: [], shop: [] };
  const boxes = [], tanks = [], aos = [];
  T.boxes = boxes; T.aos = aos;
  const fr = FR(), fr2 = FR();
  const occ = rs._occ;
  const qk = T.q;

  /* 1棟を置く(中心・向き・寸法)。うまく置けたら true */
  const place = (s, side, lat, w, d, yaw, type, h, shop, sh, far) => {
    sampleFrame(F, step, s, fr);
    let cx = fr.x + fr.lx * side * lat, cz = fr.z + fr.lz * side * lat;
    const axx = Math.cos(yaw), axz = -Math.sin(yaw), azx = Math.sin(yaw), azz = Math.cos(yaw);
    let hx = d / 2, hz = w / 2;
    /* ぶつかったら: 外へ1.5m・3mずらして試す → だめなら0.75倍に縮めて1回だけ */
    let cx2 = cx, cz2 = cz, ok = false;
    for (let k = 0; k < 3 && !ok; k++) {
      cx2 = cx + fr.lx * side * k * 1.5; cz2 = cz + fr.lz * side * k * 1.5;
      ok = !fpHit(occ, cx2, cz2, axx, axz, azx, azz, hx, hz, 1.5);
    }
    if (!ok) {
      hx *= 0.75; hz *= 0.75;
      if (fpHit(occ, cx2, cz2, axx, axz, azx, azz, hx, hz, 1.5)) return false;
    }
    cx = cx2; cz = cz2;
    fpStamp(occ, cx, cz, axx, axz, azx, azz, hx, hz, SOFT);
    const D = FACADE[type];
    const base0 = fr.y - 0.5 - 0.6;
    const floors = Math.max(2, Math.round((h - 0.6 - (shop ? 4.2 : 0)) / D.fh));
    const top = base0 + 0.6 + (shop ? 4.2 : 0) + floors * D.fh + 0.6;
    const pal = PAL[type];
    const it = { x: cx, y: shop ? base0 + 4.2 : base0, z: cz, yaw, sx: hx * 2, sz: hz * 2, sy: top - (shop ? base0 + 4.2 : base0), s, sh };
    paint(it, pick(pal, rng), 0.05, rng);
    lists[type].push(it);
    if (shop) {
      const sp = { x: cx, y: base0, z: cz, yaw, sx: hx * 2 + 0.02, sz: hz * 2 + 0.02, sy: 4.8, s, sh };
      paint(sp, pick(PAL.shop, rng), 0.04, rng);
      lists.shop.push(sp);
    }
    aos.push({ x: cx, y: fr.y - 0.46, z: cz, yaw, sx: hx * 2 * 1.28 + 2, sy: 1, sz: hz * 2 * 1.28 + 2, s });
    /* 超高層のセットバック(上に細い塔) */
    const hTot = top - base0;
    if (type === 'tower' && hTot > 60 && rng() < 0.55 && !far) {
      const k = Math.round((hTot * 0.7) / D.fh);
      const by = base0 + k * D.fh;
      const fl2 = Math.max(4, Math.round((hTot * 0.42) / D.fh));
      const it2 = { x: cx, y: by, z: cz, yaw, sx: hx * 2 * 0.72, sz: hz * 2 * 0.72, sy: fl2 * D.fh + 1.2, s, sh };
      it2.r = it.r; it2.g = it.g; it2.b = it.b;
      lists.tower.push(it2);
    }
    /* 屋上: 塔屋(75%)・高架水槽(マンション/雑居の35%)・室外機 */
    if (hTot > 10) {
      const roofY = top;
      const end = rng() < 0.5 ? 1 : -1;
      let ph = null;
      if (rng() < 0.75) {
        const pw = 3.2 + rng() * 1.3, pd = 4 + rng() * 2;
        const oz = end * Math.max(0, hz - pd / 2 - 0.8), ox = (rng() - 0.5) * Math.max(0, hx * 2 - pw - 1.6);
        ph = { x: cx + axx * ox + azx * oz, y: roofY - 0.05, z: cz + axz * ox + azz * oz, yaw, sx: pw, sy: 3, sz: pd, s, sh };
        paint(ph, pick(pal, rng), 0.06, rng);
        ph.r *= 0.8; ph.g *= 0.8; ph.b *= 0.8;
        boxes.push(ph);
      }
      if ((type === 'mansion' || type === 'zakkyo') && rng() < 0.35) {
        const onPh = ph && rng() < 0.6;
        const tx = onPh ? ph.x : cx + azx * (-end * hz * 0.4), tz = onPh ? ph.z : cz + azz * (-end * hz * 0.4);
        tanks.push({ x: tx, y: onPh ? ph.y + 3 : roofY, z: tz, yaw, sx: 1, sy: 1, sz: 1, s, sh });
      }
      const nu = 1 + Math.floor(rng() * 3);
      for (let u = 0; u < nu; u++) {
        const ox = (rng() - 0.5) * hx * 1.2, oz = (rng() - 0.5) * hz * 1.2;
        const ac = { x: cx + axx * ox + azx * oz, y: roofY - 0.05, z: cz + axz * ox + azz * oz, yaw, sx: 1.1 + rng() * 1.8, sy: 0.8 + rng() * 1.0, sz: 1.0 + rng() * 1.5, s, sh };
        paint(ac, 0x989da0, 0.08, rng);
        boxes.push(ac);
      }
    }
    return true;
  };

  /* 行(線路と平行な街区の列)ごとに、線路方向へ建物を並べる */
  for (const side of [1, -1]) {
    for (let row = 0; row < 6; row++) {
      let s = 30 + rng() * 20;
      while (s < L - 40) {
        const kind = T.kindAt(s);
        const near = T.nearSt(s);
        const nRows = kind === 0 ? 5 : kind === 1 ? 4 + (near > 0.5 ? 1 : 0) : kind === 2 ? 1 + (near > 0.35 ? 1 : 0) + (near > 0.6 ? 1 : 0) : 1;
        if (row >= nRows || T.skipS(s) || T.inRiver(s, 60) || T.landmarkSkip(side, s)) { s += 20; continue; }
        const pitch = kind === 0 ? 27 : kind === 1 ? 21 : 19;
        /* 行の手前の線: 側道があればその外、なければ柵+3m */
        const road = T.roadAt(side, s);
        const start = (road ? road.clear + 1.0 : T.fence(side, s) + 3) + row * pitch;
        const isM = kind >= 2;
        const bay = isM ? 3.4 : 3.2;
        const nb = kind === 0 ? 4 + Math.floor(rng() * 4) : kind === 1 ? 3 + Math.floor(rng() * 3) : 3 + Math.floor(rng() * 3);
        let w = nb * bay;
        let d = kind === 0 ? 12 + rng() * 10 : kind === 1 ? 9 + rng() * 7 : 8.5 + rng() * 4;
        const lat = start + d / 2 + rng() * 1.5;
        /* 列の弧長に合わせて s を進める(カーブの内側でつまらない) */
        sampleFrame(F, step, s, fr); sampleFrame(F, step, s + 5, fr2);
        const ax = fr.x + fr.lx * side * lat, az = fr.z + fr.lz * side * lat;
        const bx = fr2.x + fr2.lx * side * lat, bz = fr2.z + fr2.lz * side * lat;
        const ratio = Math.hypot(bx - ax, bz - az) / 5;
        if (ratio < 0.35) { s += 20; continue; }
        const gap = kind === 0 ? 2 + rng() * 4 : 1.6 + rng() * 3;
        const fill = kind === 0 ? 0.92 : kind === 1 ? 0.78 : kind === 2 ? 0.32 + 0.45 * near : 0.05;
        const skipP = (1 - fill) * (1 - 0.7 * near);
        const sMid = s + (w / 2) / ratio;
        if (rng() > skipP && rng() < qk + (row === 0 ? 0.25 : 0)) {
          let h;
          if (kind === 0) h = Math.abs(sMid - T.sShinjuku) < 1100 ? 22 + rng() * 95 : 25 + rng() * 35;
          else if (kind === 1) h = 8 + rng() * 16;
          else h = 9 + rng() * 6;
          /* 線路ぎわの市街地は高さがまちまち(2〜3階の低い建物もまぜる。上空から線路が見通せる) */
          if (kind <= 1 && lat < 45 && rng() < 0.4 - 0.3 * near) h = 7 + rng() * 5;
          if (kind === 1 || kind === 2) h *= 1 + 1.5 * near;
          if (kind === 1 && lat < 30) h = Math.min(h, 18);
          /* 線路ぎわは中層の谷(超高層は80mより外) */
          if (kind === 0) h = Math.min(h, lat < 45 ? 24 : lat < 80 ? 42 : 999);
          const type = pickType(kind, h, rng);
          const D = FACADE[type];
          w = Math.max(2, Math.round(w / D.bay)) * D.bay;
          d = Math.max(2, Math.round(d / D.bay)) * D.bay;
          const shop = row <= 1 && (near > 0.35 || (kind <= 1 && row === 0 && rng() < (type === 'zakkyo' ? 0.6 : type === 'office' ? 0.3 : 0.15)));
          const yaw = fr.yaw + (rng() - 0.5) * 0.06;
          place(sMid, side, lat, w, d, yaw, type, h, shop, lat < 80, false);
        }
        s += (w + gap) / ratio;
      }
    }
  }
  /* 遠景ベルト(市街地のみ、150〜420m帯に大きめの箱。向きは400mごとにそろえる) */
  for (let s = 60; s < L - 60; s += 55) {
    const kind = T.kindAt(s);
    if (kind > 1 || T.inRiver(s, 150)) continue;
    sampleFrame(F, step, Math.round(s / 400) * 400, fr2);
    const yawB = fr2.yaw;
    for (const side of [1, -1]) {
      const nB = kind === 0 ? 2 : 1;
      for (let bi = 0; bi < nB; bi++) {
        if (rng() < 0.3 || rng() > qk + 0.2) continue;
        const lat = 150 + rng() * 270;
        const h = kind === 0 ? 25 + rng() * 60 : 10 + rng() * 20;
        const type = kind === 0 ? (rng() < 0.6 ? 'office' : 'zakkyo') : pickType(1, h, rng);
        place(s + rng() * 30, side, lat, 18 + rng() * 26, 16 + rng() * 22, yawB + (rng() - 0.5) * 0.06, type, h, false, false, true);
      }
    }
  }

  /* --- メッシュ化 --- */
  const g = T.groups.town;
  const M = T.M;
  const geo = geoUnitBox();
  Object.keys(lists).forEach((k) => { if (lists[k].length) emitInstanced(g, geo, M[k], lists[k], 500, { shadow: true }); });
  if (tanks.length) emitInstanced(g, geoTank(), M.tank, tanks, 700, { colors: false });
  T.bldCount = Object.values(lists).reduce((a, l) => a + l.length, 0);
}

/* ---------- 戸建て(世田谷・多摩の住宅地) ---------- */
const WALLS = [0xece8df, 0xddd6c8, 0xcfc6b4, 0xbdb6aa, 0x8e8a83, 0xe4dccd, 0xc8b9a1];
const ROOFS = [0x3a3d41, 0x46423e, 0x2e3236, 0x574a3f, 0x44505c, 0x62564a];
function buildHouses(rs, T) {
  const F = rs.frames, step = rs.step, L = rs.line.meta.length;
  const rng = makeRng(9753);
  const occ = rs._occ;
  const gable = [], flat = [], roofs = [];
  const boxes = T.boxes, aos = T.aos;
  const fr = FR(), fr2 = FR();
  const qk = T.q;
  const stamps = [];
  for (const side of [1, -1]) {
    for (let row = 0; row < 9; row++) {
      let s = 20 + rng() * 10;
      while (s < L - 30) {
        const kind = T.kindAt(s);
        const maxD = kind === 2 ? 110 : kind === 3 ? 90 : kind === 1 ? 70 : 0;
        const road = T.roadAt(side, s);
        const start = Math.max(T.fence(side, s) + 6, road ? road.clear + 0.4 : 0);
        const front = start + row * 12.5;
        if (!maxD || front + 8 > maxD || T.skipS(s) || T.inRiver(s, 60) || T.landmarkSkip(side, s)) { s += 15; continue; }
        const fw = 8 + rng() * 2.5;              // 間口
        const d = 7 + rng() * 2.5, g = 1.2 + rng() * 1.4;
        const lat = front + g + d / 2;
        sampleFrame(F, step, s, fr); sampleFrame(F, step, s + 5, fr2);
        const ax = fr.x + fr.lx * side * lat, az = fr.z + fr.lz * side * lat;
        const ratio = Math.hypot(fr2.x + fr2.lx * side * lat - ax, fr2.z + fr2.lz * side * lat - az) / 5;
        if (ratio < 0.4) { s += 15; continue; }
        const sMid = s + (fw / 2) / ratio;
        s += fw / ratio;
        if (rng() > 0.88 || rng() > qk) continue;
        sampleFrame(F, step, sMid, fr);
        const yaw = fr.yaw + (rng() - 0.5) * 0.08;
        const cx = fr.x + fr.lx * side * lat, cz = fr.z + fr.lz * side * lat;
        const axx = Math.cos(yaw), axz = -Math.sin(yaw), azx = Math.sin(yaw), azz = Math.cos(yaw);
        const w = fw - 1.2;
        if (fpHit(occ, cx, cz, axx, axz, azx, azz, d / 2, w / 2, 1.8)) continue;
        stamps.push([cx, cz, axx, axz, azx, azz, d / 2, w / 2]);
        const three = rng() < 0.12;
        const isGable = !three && rng() < 0.6 / 0.88;
        const eave = three ? 8.6 : 5.6 + rng() * 0.6;
        const base0 = fr.y - 0.5 - 0.6;
        const sh = lat < 45;
        const it = { x: cx, y: base0, z: cz, yaw, sx: d, sz: w, sy: isGable ? (eave + 0.6) / EAVE : eave + 0.6 + 0.5, s: sMid, sh };
        paint(it, pick(WALLS, rng), 0.04, rng);
        (isGable ? gable : flat).push(it);
        if (isGable) {
          const rf = { x: cx, y: base0, z: cz, yaw, sx: d, sz: w, sy: it.sy, s: sMid, sh };
          paint(rf, pick(ROOFS, rng), 0.08, rng);
          roofs.push(rf);
        }
        aos.push({ x: cx, y: fr.y - 0.46, z: cz, yaw, sx: d + 2.2, sy: 1, sz: w + 2.2, s: sMid });
        /* ブロック塀(手前の6割) */
        const flat1 = front + 0.15;
        if (lat < 60 && rng() < 0.6) {
          const bx = fr.x + fr.lx * side * flat1, bz = fr.z + fr.lz * side * flat1;
          const bw = { x: bx, y: fr.y - 0.55, z: bz, yaw, sx: 0.12, sy: 1.25, sz: fw - 0.5, s: sMid, sh: false };
          paint(bw, pick([0xb9b5ab, 0xa9a69e, 0xc4bfb4], rng), 0.05, rng);
          boxes.push(bw);
        }
        /* テレビアンテナ(近くの家の35%) */
        if (lat < 70 && rng() < 0.35) {
          const topY = base0 + it.sy;
          const oz = (rng() - 0.5) * w * 0.5;
          const mx = cx + azx * oz, mz = cz + azz * oz;
          const dark = { r: 0.05, g: 0.05, b: 0.055 };
          boxes.push({ x: mx, y: topY - 0.1, z: mz, yaw, sx: 0.04, sy: 1.6, sz: 0.04, s: sMid, sh: false, ...dark });
          boxes.push({ x: mx, y: topY + 1.25, z: mz, yaw, sx: 0.04, sy: 0.04, sz: 1.3, s: sMid, sh: false, ...dark });
          boxes.push({ x: mx, y: topY + 1.0, z: mz, yaw: yaw + 0.8, sx: 0.04, sy: 0.04, sz: 0.9, s: sMid, sh: false, ...dark });
        }
        /* 庭木(25%) */
        if (rng() < 0.25) {
          const off = flat1 + 0.9;
          const tz = (rng() < 0.5 ? -1 : 1) * (w / 2 - 0.4);
          rs._treeQueue.push({
            x: fr.x + fr.lx * side * off + fr.tx * tz, y: fr.y - 0.5, z: fr.z + fr.lz * side * off + fr.tz * tz,
            s: sMid, sc: 0.45 + rng() * 0.15, tint: 0.8 + rng() * 0.3, conifer: rng() < 0.2,
          });
        }
      }
    }
  }
  stamps.forEach((a) => fpStamp(occ, a[0], a[1], a[2], a[3], a[4], a[5], a[6] - 0.75, a[7] - 0.75, SOFT));
  /* 中低層に混じる3〜5階のマンション(多摩の住宅地にも少しだけ) は buildBuildings で配置済み */
  const g = T.groups.houses;
  const M = T.M;
  if (gable.length) emitInstanced(g, geoGable(), M.house, gable, 400, { shadow: true });
  if (flat.length) emitInstanced(g, geoUnitBox(), M.house, flat, 400, { shadow: true });
  if (roofs.length) emitInstanced(g, geoGableRoof(), M.roof, roofs, 400, { shadow: true });
  /* 屋上の小物・塀・アンテナ(建物ぶんもまとめて)と接地影 */
  /* 屋上の小物・塀は影を落とさない(運転台からは見えず、影の描画コールだけ増えるため) */
  if (boxes.length) emitInstanced(T.groups.town, geoUnitBox(), M.box, boxes, 500);
  if (aos.length) {
    const ag = new THREE.PlaneGeometry(1, 1); ag.rotateX(-Math.PI / 2);
    emitInstanced(T.groups.town, ag, M.ao, aos, 500, { colors: false, receive: false });
  }
  T.houseCount = gable.length + flat.length;
}

/* ---------- 遠景: 街並みと丘の稜線のリング + 新宿の高層ビル群(看板) ---------- */
function ringCanvas(kind) {
  return canvasOnce('ring-' + kind, 2048, 256, (c, w, h) => {
    const r = makeRng(kind === 'hills' ? 41 : 17);
    c.clearRect(0, 0, w, h);
    if (kind === 'hills') {
      const layers = [['#93a39a', 0.45, 120, 40], ['#748a74', 0.7, 92, 34], ['#57704f', 0.9, 66, 26]];
      layers.forEach(([col, a, base, amp], li) => {
        const ph = [r() * 7, r() * 7, r() * 7];
        c.globalAlpha = a; c.fillStyle = col;
        c.beginPath(); c.moveTo(0, h);
        for (let x = 0; x <= w; x += 4) {
          /* 3つのsin+ノイズで稜線(端でつながるよう周期をそろえる) */
          const t = (x / w) * Math.PI * 2;
          const y = h - base - amp * (0.5 * Math.sin(t * 3 + ph[0]) + 0.3 * Math.sin(t * 7 + ph[1]) + 0.2 * Math.sin(t * 17 + ph[2])) - r() * 3;
          c.lineTo(x, y);
        }
        c.lineTo(w, h); c.closePath(); c.fill();
        /* 樹冠のでこぼこ */
        for (let x = 0; x < w; x += 6 + r() * 8) {
          const t = (x / w) * Math.PI * 2;
          const y = h - base - amp * (0.5 * Math.sin(t * 3 + ph[0]) + 0.3 * Math.sin(t * 7 + ph[1]) + 0.2 * Math.sin(t * 17 + ph[2]));
          c.beginPath(); c.arc(x, y + 1, 2 + r() * 3, 0, 7); c.fill();
        }
        void li;
      });
      c.globalAlpha = 1;
      return;
    }
    const night = kind === 'night';
    const layers = night
      ? [['#10151c', 0.55, 16, 50, 0], ['#10151c', 0.75, 24, 80, 0.02], ['#10151c', 0.92, 10, 40, 0]]
      : [['#a3afba', 0.35, 16, 50, 0], ['#8b97a2', 0.55, 24, 80, 0.02], ['#77828c', 0.8, 10, 40, 0]];
    layers.forEach(([col, a, h0, h1, tall], li) => {
      let x = 0;
      while (x < w) {
        const bw = 6 + r() * (li === 2 ? 18 : 26);
        let bh = h0 + r() * (h1 - h0);
        if (r() < tall) bh = 110;
        if (x + bw > w) break;
        c.globalAlpha = a; c.fillStyle = col;
        c.fillRect(x, h - 60 + li * 18 - bh, bw, bh + 60);
        /* 窓の点(昼はうっすら、夜は灯り) */
        if (li === 2 || night) {
          c.fillStyle = night ? '#ffd9a0' : '#ffffff';
          c.globalAlpha = night ? 0.6 : 0.12;
          for (let yy = h - 60 + li * 18 - bh + 3; yy < h - 4; yy += 4) {
            for (let xx = x + 2; xx < x + bw - 2; xx += 3) if (r() < (night ? 0.18 : 0.3)) c.fillRect(xx, yy, 1, 1);
          }
        }
        x += bw + (r() < 0.3 ? r() * 10 : 0);
      }
    });
    c.globalAlpha = 1;
  });
}
function shinjukuCanvas() {
  return canvasOnce('shinjuku', 1024, 512, (c, w, h) => {
    const r = makeRng(1964);
    c.clearRect(0, 0, w, h);
    const base = h - 20;
    /* 12本の高層ビル(屋上の形がそれぞれちがう) */
    const towers = [];
    for (let i = 0; i < 12; i++) towers.push({ x: 60 + i * 76 + (r() - 0.5) * 30, w: 40 + r() * 40, h: 150 + r() * 170, crown: i % 4 });
    towers.sort((a, b) => a.h - b.h);
    towers.forEach((t, i) => {
      const col = i % 2 ? '#6d7b88' : '#7f8c98';
      c.globalAlpha = 0.78 + 0.22 * (i / 12);
      c.fillStyle = col;
      const top = base - t.h;
      c.fillRect(t.x, top, t.w, t.h + 20);
      c.beginPath();
      if (t.crown === 0) { c.fillRect(t.x + t.w * 0.2, top - 26, t.w * 0.6, 26); c.fillRect(t.x + t.w * 0.38, top - 44, t.w * 0.24, 18); }   // 段々
      else if (t.crown === 1) { c.fillRect(t.x + 2, top - 30, t.w * 0.35, 30); c.fillRect(t.x + t.w * 0.63, top - 30, t.w * 0.35, 30); } // 双塔
      else if (t.crown === 2) { c.moveTo(t.x + t.w / 2 - 2, top - 70); c.lineTo(t.x + t.w / 2 + 2, top - 70); c.lineTo(t.x + t.w * 0.8, top); c.lineTo(t.x + t.w * 0.2, top); c.fill(); } // 尖塔
      else { c.moveTo(t.x, top); c.lineTo(t.x + t.w, top); c.lineTo(t.x + t.w, top - 18); c.lineTo(t.x, top - 4); c.fill(); }  // 斜め屋根
      c.globalAlpha = 0.16; c.fillStyle = '#ffffff';
      for (let y = top + 6; y < base; y += 7) c.fillRect(t.x + 3, y, t.w - 6, 1);
      c.globalAlpha = 0.12; c.fillStyle = '#000000';
      c.fillRect(t.x + t.w * 0.7, top, t.w * 0.3, t.h + 20);   // 影になる側面
    });
    c.globalAlpha = 1;
  });
}
function buildSkyline(rs, T) {
  const g = T.groups.skyline;
  const M = materials(rs);
  if (!M.ringCity) {
    const mk = (cv) => { const t = texFrom(cv); t.repeat.set(3, 1); t.wrapT = THREE.ClampToEdgeWrapping; return t; };
    const keep = (m) => { rs._keep.add(m); return m; };
    M.ringTex = { city: mk(ringCanvas('city')), night: mk(ringCanvas('night')), hills: mk(ringCanvas('hills')) };
    Object.values(M.ringTex).forEach((t) => rs._keep.add(t));
    const rm = (map) => keep(new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, fog: false, side: THREE.BackSide }));
    M.ringCity = rm(M.ringTex.city);
    M.ringHills = rm(M.ringTex.hills);
    const st = texFrom(shinjukuCanvas(), true, false);
    rs._keep.add(st);
    M.billboard = keep(new THREE.MeshBasicMaterial({ map: st, transparent: true, depthWrite: false, fog: false }));
  }
  if (!GEO.ring) { GEO.ring = new THREE.CylinderGeometry(1, 1, 1, 96, 1, true); GEO.ring.translate(0, 0.5, 0); }
  if (!GEO.board) GEO.board = new THREE.PlaneGeometry(700, 320);
  const hills = new THREE.Mesh(GEO.ring, M.ringHills);
  const city = new THREE.Mesh(GEO.ring, M.ringCity);
  const board = new THREE.Mesh(GEO.board, M.billboard);
  [hills, city, board].forEach((m, i) => { m.frustumCulled = false; m.userData.noMerge = true; m.renderOrder = -3 + i; g.add(m); });
  T.ringHills = hills; T.ringCity = city; T.board = board;
  /* 区間の種類 → リングの濃さ(±400mでならす) */
  const L = rs.line.meta.length, n = Math.ceil(L / 20) + 1;
  const cityK = [1, 1, 0.7, 0.25], hillK = [0, 0.15, 0.55, 1];
  const raw = (arr, s) => arr[T.kindAt(s)];
  T.cityOp = new Float32Array(n); T.hillOp = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let a = 0, b = 0, c = 0;
    for (let ds = -400; ds <= 400; ds += 40) { const s = clamp(i * 20 + ds, 0, L); a += raw(cityK, s); b += raw(hillK, s); c++; }
    T.cityOp[i] = a / c; T.hillOp[i] = b / c;
  }
  const sj = rs.line.stations.find((x) => x.name === '新宿');
  if (sj) { const f = FR(); sampleFrame(rs.frames, rs.step, sj.s, f); T.sjX = f.x; T.sjZ = f.z; } else T.sjX = null;
}

/* =========================================================
 * 木(広葉樹2種+針葉樹)。幹は葉と1つの形にまとめ、遠いかたまりは軽い形に差し替える
 * ========================================================= */
export function makeTreeGeosP1() {
  const rnd = makeRng(31);
  const blob = (r, x, y, z, sy, detail) => {
    const g = new THREE.IcosahedronGeometry(r, detail);
    const p = g.attributes.position;
    const salt = rnd() * 1000;
    for (let i = 0; i < p.count; i++) {
      const hx = Math.round(p.getX(i) * 1000), hy = Math.round(p.getY(i) * 1000), hz = Math.round(p.getZ(i) * 1000);
      const h = Math.sin(hx * 12.9898 + hy * 78.233 + hz * 37.719 + salt) * 43758.5453;
      const k = 0.82 + (h - Math.floor(h)) * 0.32;
      p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * sy, p.getZ(i) * k);
    }
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
  /* 頂点色: 下ほど暗い(幹は「2+色」= 固定色のフラグ) */
  const shade = (g, y0, y1) => {
    const p = g.attributes.position;
    const c = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const t = clamp((p.getY(i) - y0) / (y1 - y0), 0, 1);
      const v = Math.pow(0.55 + 0.5 * t, 2.2);
      c[i * 3] = v; c[i * 3 + 1] = v; c[i * 3 + 2] = v;
    }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return g;
  };
  const tc = srgbLin(0x584736).map((v) => v + 2);
  const trunk = () => { const t = new THREE.CylinderGeometry(0.13, 0.2, 2.9, 6); t.translate(0, 1.45, 0); return { g: t, col: tc }; };
  const trunkC = () => { const t = new THREE.CylinderGeometry(0.1, 0.16, 2.0, 5); t.translate(0, 1.0, 0); return { g: t, col: tc }; };
  const broad = (spec, detail) => spec.map(([r, x, y, z, sy]) => ({ g: shade(blob(r, x, y, z, sy || 1.15, detail), 2.2, 5.5) }));
  const A = [[1.55, 0, 3.7, 0], [1.1, 0.95, 3.1, 0.35], [1.0, -0.85, 3.25, -0.3], [0.9, 0.1, 4.6, -0.5]];
  const B = [[1.25, 0, 3.3, 0, 1.3], [1.15, 0.2, 4.4, 0.2, 1.2], [0.85, -0.7, 3.0, 0.5], [0.8, 0.75, 3.6, -0.55]];
  const cones = (seg) => [[1.5, 2.2, 2.6], [1.15, 1.9, 3.9], [0.75, 1.6, 5.0]].map(([r, h, y]) => {
    const c = new THREE.ConeGeometry(r, h, seg, 1); c.translate(0, y, 0); return { g: shade(c, 1.5, 6.0) };
  });
  const hi = [mergeParts([...broad(A, 1), trunk()]), mergeParts([...broad(B, 1), trunk()]), mergeParts([...cones(7), trunkC()])];
  const lo = [mergeParts(broad(A, 0)), mergeParts(broad(B, 0)), mergeParts(cones(5))];
  return { hi, lo };
}

/* list: [{x,y,z|p, s, sc, sy?, tint, conifer?}] → チャンク(300m)ごとの InstancedMesh */
export function plantTreesP1(rs, list, rng) {
  if (!rs._treeGeosP1) rs._treeGeosP1 = makeTreeGeosP1();
  const G = rs._treeGeosP1;
  if (!rs._treeFolMatP1) {
    const leaf = texLeaf();
    leaf.repeat.set(2, 2);
    const m = new THREE.MeshStandardMaterial({ map: leaf, color: 0xffffff, vertexColors: true, roughness: 0.92 });
    /* 幹(頂点色>=2)はインスタンス色に染めず、そのままの色で */
    m.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <color_vertex>', `#include <color_vertex>
#ifdef USE_COLOR
if (color.r > 1.5) vColor.xyz = color.xyz - 2.0;
#endif`);
    };
    m.customProgramCacheKey = () => 'fc-tree';
    rs._keep.add(m); rs._keep.add(leaf);
    rs._treeFolMatP1 = m;
  }
  const mat = rs._treeFolMatP1;
  const T = rs._town;
  const g = new THREE.Group();
  g.userData.p1cat = 'trees';
  rs.world.add(g);
  /* 広葉樹は「かたまりごと」にA/Bの形を交互に使う(1かたまり2コール: 広葉樹+針葉樹) */
  const fr = FR();
  const keyNum = (s, band) => (band === 0 ? Math.floor(s / 350) : band === 1 ? Math.floor(s / 600) : Math.floor(s / 1200));
  const bandKey = (it) => ['a', 'b', 'c'][it.band] + keyNum(it.s, it.band);
  const groups = [[], [], []];
  list.forEach((t) => {
    if (t.p) { t.x = t.p.x; t.y = t.p.y; t.z = t.p.z; }
    const s = t.s || 0;
    sampleFrame(rs.frames, rs.step, s, fr);
    const lat = Math.abs((t.x - fr.x) * fr.lx + (t.z - fr.z) * fr.lz);
    const band = lat < 70 ? 0 : lat < 200 ? 1 : 2;
    const sc = t.sc;
    const it = { x: t.x, y: t.y, z: t.z, yaw: rng() * Math.PI * 2, sx: sc, sy: sc * (t.sy || 1) * (0.88 + rng() * 0.3), sz: sc, s, sh: band === 0, band };
    const k = t.tint;
    /* 葉の模様(平均0.8)ぶん明るめに */
    if (t.conifer) _c.setRGB(k * 0.28, k * 0.41, k * 0.31, THREE.SRGBColorSpace);
    else _c.setRGB(k * 0.49, k * 0.6, k * 0.35, THREE.SRGBColorSpace);
    it.r = _c.r; it.g = _c.g; it.b = _c.b;
    groups[t.conifer ? 2 : (keyNum(s, band) + band) % 2].push(it);
  });
  const cells = [];
  groups.forEach((items, gi) => {
    if (!items.length) return;
    const meshes = emitInstanced(g, G.hi[gi], mat, items, bandKey, { shadow: true });
    meshes.forEach((im) => {
      im.userData.treeHi = G.hi[gi]; im.userData.treeLo = G.lo[gi];
      /* かたまりの外接矩形(XZ)。LODの距離判定に使う */
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let i = 0; i < im.count; i++) {
        im.getMatrixAt(i, _m4);
        const x = _m4.elements[12], z = _m4.elements[14];
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z;
      }
      cells.push({ mesh: im, hi: G.hi[gi], lo: G.lo[gi], x0, x1, z0, z1, far: false, shadow: im.castShadow });
    });
  });
  if (T) T.treeCells.push(...cells);
  return g;
}

/* ---------- 丘(多摩丘陵): でこぼこの半球3種を線路方向に引きのばして稜線に ---------- */
function hillGeo(seed) {
  const g = new THREE.SphereGeometry(1, 40, 12, 0, Math.PI * 2, 0, Math.PI / 2);
  const p = g.attributes.position;
  const r = makeRng(seed);
  const ph = [r() * 6, r() * 6, r() * 6];
  const col = new Float32Array(p.count * 3);
  const low = srgbLin(0x7d8a63), mid = srgbLin(0x3b5130);
  const lf = [low[0] / mid[0], low[1] / mid[1], low[2] / mid[2]];
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const th = Math.atan2(z, x);
    const n = 0.85 + 0.25 * (0.5 + 0.5 * (0.5 * Math.sin(th * 3 + ph[0]) + 0.3 * Math.sin(th * 5 + ph[1]) + 0.2 * Math.sin(th * 11 + ph[2])));
    x *= n; z *= n;
    y = Math.min(y, 0.82) / 0.82;
    y = y * (0.9 + 0.2 * (0.5 + 0.5 * Math.sin(th * 2 + ph[1]))) - 0.04;
    p.setXYZ(i, x, y, z);
    /* すその15%は明るい草地・畑の色へ */
    const t = clamp(1 - (y + 0.04) / 0.15, 0, 1);
    const sh = 0.9 + 0.1 * clamp(y, 0, 1);
    col[i * 3] = lerp(sh, lf[0], t); col[i * 3 + 1] = lerp(sh, lf[1], t); col[i * 3 + 2] = lerp(sh, lf[2], t);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}
export function buildHillsP1(rs) {
  const F = rs.frames, step = rs.step, L = rs.line.meta.length;
  const T = rs._town;
  const rng = makeRng(777);
  if (!rs._p1HillMat) {
    const t = texForest();
    t.repeat.set(10, 3);
    rs._p1HillMat = new THREE.MeshStandardMaterial({ map: t, vertexColors: true, roughness: 1 });
    rs._keep.add(rs._p1HillMat); rs._keep.add(t);
  }
  if (!GEO.hills) GEO.hills = [hillGeo(11), hillGeo(23), hillGeo(37)];
  const lists = [[], [], []];
  const trees = [];
  const fr = FR();
  const v = new THREE.Vector3();
  const kindAt = T ? T.kindAt : () => 2;
  for (let s = 300; s < L - 200;) {
    const k = kindAt(s);
    s += k === 3 ? 180 + rng() * 80 : 330 + rng() * 120;
    if (k < 2) continue;
    if (rs.line.sections.river.some((r) => s > r.from - 500 && s < r.to + 500)) continue;
    for (const side of [1, -1]) {
      if (rng() > (k === 3 ? 0.92 : 0.4)) continue;
      const rb = k === 3 ? 90 + rng() * 80 : 80 + rng() * 60;
      const h = k === 3 ? 28 + rng() * 34 : 16 + rng() * 18;
      const lat = Math.max(220, rb + 130) + rng() * (k === 3 ? 260 : 200);
      sampleFrame(F, step, s, fr);
      const vi = Math.floor(rng() * 3);
      const it = {
        x: fr.x + fr.lx * side * lat, y: fr.y - 3, z: fr.z + fr.lz * side * lat,
        yaw: fr.yaw + (rng() - 0.5) * 0.3, sx: rb, sy: h, sz: rb * (1.8 + rng() * 1.2), s, sh: false,
      };
      lists[vi].push(it);
      /* 稜線の木(上半分にだけ、まばらに) */
      const pg = GEO.hills[vi].attributes.position;
      const nT = Math.floor((rb / 9) * 0.6 * (T ? T.q : 1));
      _q.setFromAxisAngle(Y_AXIS, it.yaw);
      for (let i = 0; i < nT; i++) {
        const vi2 = Math.floor(rng() * pg.count);
        if (pg.getY(vi2) < 0.55) continue;
        v.set(pg.getX(vi2) * it.sx, pg.getY(vi2) * it.sy, pg.getZ(vi2) * it.sz).applyQuaternion(_q);
        trees.push({ x: it.x + v.x, y: it.y + v.y - 0.3, z: it.z + v.z, s, sc: 1.6 + rng() * 1.0, tint: 0.6 + rng() * 0.35, conifer: rng() < 0.35 });
      }
    }
  }
  const g = new THREE.Group();
  g.userData.p1cat = 'hills';
  rs.world.add(g);
  lists.forEach((arr, i) => { if (arr.length) emitInstanced(g, GEO.hills[i], rs._p1HillMat, arr, 1500, { colors: false, receive: true }); });
  return trees;
}

/* =========================================================
 * 毎フレーム(割り当てなし)
 * ========================================================= */
const EMI_N = new THREE.Color(0xd8c8a8), EMI_E = new THREE.Color(0xd8c8a8).multiplyScalar(0.3), BLACK = new THREE.Color(0);
const COL_EVE = new THREE.Color(0x8a6f68), COL_W = new THREE.Color(0xffffff), COL_NH = new THREE.Color(0x2c3540), COL_NB = new THREE.Color(0x1c232c);

function fallbackLook(rs, T) {
  const fb = T.fb;
  const tod = rs.timeOfDay, w = rs.weather;
  if (fb.tod !== tod || fb.w !== w) {
    fb.tod = tod; fb.w = w; fb.rev = tod + '|' + w;
    fb.night = tod === 'night'; fb.eve = tod === 'evening';
    fb.rain = w === 'rain'; fb.snow = w === 'snow'; fb.wet = fb.rain || fb.snow;
  }
  fb.indoor = !!rs._inTunnelNow;
  return fb;
}

function applyLook(rs, T, L) {
  const M = T.M;
  uFcLit.value = L.night ? 0.38 : L.eve ? 0.15 : 0;
  const e = L.night ? EMI_N : L.eve ? EMI_E : BLACK;
  M.facades.forEach((m) => m.emissive.copy(e));
  const lamps = !!(L.night || L.eve);
  for (let i = 0; i < T.glows.length; i++) T.glows[i].visible = lamps;
  if (M.ringCity) {
    M.ringCity.map = L.night ? M.ringTex.night : M.ringTex.city;
    M.ringCity.color.copy(L.eve && !L.night ? COL_EVE : COL_W);
    M.ringHills.color.copy(L.night ? COL_NH : L.eve ? COL_EVE : COL_W);
    M.billboard.color.copy(L.night ? COL_NB : L.eve ? COL_EVE : COL_W);
  }
}

export function updateTown(rs, dt) {
  const T = rs._town;
  if (!T || !rs.sim) return;
  T.frame++;
  const L = rs.look || fallbackLook(rs, T);
  /* 最初の数フレームは街灯も見せておく(夜に切り替えたとき新しいシェーダを作らないため) */
  if (T.frame > 2 && L.rev !== T.rev) { T.rev = L.rev; applyLook(rs, T, L); }
  const cam = rs.camera, eye = cam.position;
  const far = cam.far;

  /* --- 遠景リング --- */
  if (T.ringCity) {
    const Ln = rs.line.meta.length;
    const s = clamp(rs.sim.pos, 0, Ln - 1);
    const i = clamp(Math.floor(s / 20), 0, T.cityOp.length - 1);
    const fi = clamp(Math.floor(s / rs.step), 0, rs.frames.length - 1);
    const baseY = rs.frames[fi].p.y - 25;
    const r = Math.min(1350, 0.9 * far);
    const hide = L.snow || L.indoor;
    const wetK = L.rain ? 0.7 : 1;
    const oc = T.cityOp[i] * wetK, oh = T.hillOp[i] * wetK;
    T.ringCity.visible = !hide && oc > 0.02;
    T.ringHills.visible = !hide && oh > 0.02;
    T.ringCity.position.set(eye.x, baseY, eye.z);
    T.ringCity.scale.set(r * 0.97, 240, r * 0.97);
    T.ringHills.position.set(eye.x, baseY, eye.z);
    T.ringHills.scale.set(r, 240, r);
    T.M.ringCity.opacity = oc;
    T.M.ringHills.opacity = oh;
    /* 新宿の高層ビル群(新宿から1.8km以上はなれている時だけ、新宿の方角の地平に) */
    const B = T.board;
    if (T.sjX !== null) {
      const dx = T.sjX - eye.x, dz = T.sjZ - eye.z;
      const d = Math.hypot(dx, dz);
      const vis = !hide && d > 1300;
      B.visible = vis;
      if (vis) {
        const k = Math.min(0.85 * far, 0.95 * r) / d;
        B.position.set(eye.x + dx * k, baseY + 150, eye.z + dz * k);
        B.lookAt(eye.x, baseY + 150, eye.z);
        T.M.billboard.opacity = clamp((d - 1300) / 900, 0, 1) * 0.92 * wetK;
      }
    } else B.visible = false;
  }

  /* --- 木のLOD(10フレームに1回。240mより遠いかたまりは軽い形・幹なし・影なし) --- */
  const jump = (eye.x - T.lodX) * (eye.x - T.lodX) + (eye.z - T.lodZ) * (eye.z - T.lodZ) > 40 * 40;   // 視点の切替・ワープ直後はすぐ判定
  if (T.frame % 10 === 0 || jump) {
    const ex = eye.x, ez = eye.z;
    T.lodX = ex; T.lodZ = ez;
    const cells = T.treeCells;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      const dx = ex < c.x0 ? c.x0 - ex : ex > c.x1 ? ex - c.x1 : 0;
      const dz = ez < c.z0 ? c.z0 - ez : ez > c.z1 ? ez - c.z1 : 0;
      const d2 = dx * dx + dz * dz;
      if (c.far && d2 < 220 * 220) {
        c.far = false; c.mesh.geometry = c.hi; c.mesh.castShadow = c.shadow;
      } else if (!c.far && d2 > 240 * 240) {
        c.far = true; c.mesh.geometry = c.lo; c.mesh.castShadow = false;
      }
    }
  }
  void dt;
}
