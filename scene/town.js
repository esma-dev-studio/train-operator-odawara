/* =========================================================
 * scene/town.js — 沿線の街(P1): 線路に沿った街区・側道と電柱・戸建て・遠景・森の丘・木のLOD
 *
 * ・占有グリッド rs._occ (3mマス, キーは数値 (ix+16384)*32768+(iz+16384))に線路・ホーム・駅舎・道路・建物を
 *   書き込み、建物どうしや線路との重なりを防ぐ。作るときだけ使い、ワールドができたら捨てる(setWorld)。
 * ・インスタンスは線路の距離 s ごとの「かたまり(チャンク)」に自前で分ける(視錐台カリング用。
 *   _splitInstances には任せず userData.noSplit)。影は「線路の近くのインスタンスだけ」を
 *   先頭に並べ、影描画のときだけ count を減らして描く(メッシュを2つに分けずに済む)。
 * ・毎フレームの処理は updateTown(rs, dt)(_updateCrossings から呼ばれる)。割り当てなし。
 * ・世田谷の区間(代々木上原〜和泉多摩川)は低層の住宅地: 中高層は大きな駅(下北沢・経堂・成城学園前)の前だけ。
 * ・街のにぎわい: 店の看板(shopsign.js)・駐車場と車庫の車(cars.js)・街灯の光だまり(lightpool.js)・道を走る車(roadtraffic.js)。
 *   通りの小物: 自動販売機(駅の近くの家の前と駅前広場。夜は前の面が光る)・T字路のカーブミラーと「止まれ」の標識・
 *   側道の最高速度30の標識・駅の近くの市街地のガードパイプ・駅前の駐輪場の自転車。どれも既存の箱・看板・車のまとまりに入れる。
 *   どれも既存のシェーダ('st-lineside' / 'fc-tree' / 'pool')を使い、シェーダの数は増やさない。
 * ・戸建ては2列ずつ背中合わせ。列のあいだに幅4.5mの路地(白い外側線つき)があり、奥の列の家は路地のほうを向く。
 *   交差道路は いちばん外の路地まで。路地とぶつかる所に「とまれ」と停止線。家の敷地は土間・砂利・芝の区画。
 * ・大きな駅(新百合ヶ丘・向ヶ丘遊園・登戸・下北沢)の前は中層の駅前の街とバスの ロータリー。
 * ・組み立ては buildTownSteps(rs) の手順の列(1つずつ呼べば、あいだで画面を描ける)。buildTown はそれを全部呼ぶ。
 * ========================================================= */
import * as THREE from '../vendor/three.module.min.js';
import { FACADE, facadeMaterial, uFcLit, uFcAmb, HOUSE_DOOR } from './facade.js';
import { makePoolMaterial } from './lightpool.js';
import { addCars as addCarsRaw, carPaint, patchTreeCar, uCarLamp, CAR_TYPES, CAR_LEN, CAR_WID, CAR_PAINTS, geoBike, carMaterial, geoCar } from './cars.js';
import { buildShopSigns, signMaterial, SIGN_WORDS } from './shopsign.js';
import { RoadTraffic } from './roadtraffic.js';

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
const smooth01 = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

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
/* キーは文字列にせず数値で(作り直しのたびに百万回以上よぶので、文字列だと遅くゴミも多い)。
 * ±16384マス(±49km)まで1対1。路線は±11kmくらいなので足りる。小さな整数のままなので速い */
const okey = (x, z) => (Math.floor(x / CELL) + 16384) * 32768 + (Math.floor(z / CELL) + 16384);
function occPut(occ, x, z, v) {
  const k = okey(x, z);
  const o = occ.get(k);
  if (o === undefined || o < v) occ.set(k, v);
}
/* 回転した長方形(中心cx,cz・軸ax=(axx,axz) az=(azx,azz)・半幅hx,hz)を書く */
function fpStamp(occ, cx, cz, axx, axz, azx, azz, hx, hz, v) {
  const nx = Math.max(1, Math.ceil((2 * hx) / 2)), nz = Math.max(1, Math.ceil((2 * hz) / 2));
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
  /* 道路の帯(幅6.6m以上)を見落とさない間隔3mで調べる */
  const nx = Math.max(1, Math.ceil((2 * hx) / 3)), nz = Math.max(1, Math.ceil((2 * hz) / 3));
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
    const mx = Math.max(1, Math.ceil((2 * sx) / 3)), mz = Math.max(1, Math.ceil((2 * sz) / 3));
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

/* ---------- 建物・家の外形どうしの正確な重なり判定(向き付き長方形・分離軸) ----------
 * 占有グリッドは3mマスなので、内側だけを調べる判定では1〜2mのめりこみを見落とす。
 * 家の列は側道の始まり・終わりで横にずれるので、となりの列の家と重なることもある。
 * b: {cx, cz, axx, axz(ローカルx), azx, azz(ローカルz), hx, hz} */
const OBB_CELL = 40;
function obbAdd(T, b) {
  const k = Math.floor(b.cx / OBB_CELL) + ',' + Math.floor(b.cz / OBB_CELL);
  let a = T.obb.get(k);
  if (!a) T.obb.set(k, (a = []));
  a.push(b);
}
function obbOverlap(a, b, tol) {
  const dx = b.cx - a.cx, dz = b.cz - a.cz;
  const axes = [a.axx, a.axz, a.azx, a.azz, b.axx, b.axz, b.azx, b.azz];
  for (let i = 0; i < 8; i += 2) {
    const nx = axes[i], nz = axes[i + 1];
    const ra = Math.abs(a.axx * nx + a.axz * nz) * a.hx + Math.abs(a.azx * nx + a.azz * nz) * a.hz;
    const rb = Math.abs(b.axx * nx + b.axz * nz) * b.hx + Math.abs(b.azx * nx + b.azz * nz) * b.hz;
    if (Math.abs(dx * nx + dz * nz) >= ra + rb - tol) return false;
  }
  return true;
}
function obbHit(T, b, tol) {
  const ix = Math.floor(b.cx / OBB_CELL), iz = Math.floor(b.cz / OBB_CELL);
  for (let u = -1; u <= 1; u++) {
    for (let v = -1; v <= 1; v++) {
      const a = T.obb.get((ix + u) + ',' + (iz + v));
      if (!a) continue;
      for (let i = 0; i < a.length; i++) if (obbOverlap(a[i], b, tol)) return true;
    }
  }
  return false;
}

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
/* 底のない箱(建物・陸屋根の家。地面にめりこんでいて底は見えないので2三角形はぶく) */
function geoUnitBoxOpen() {
  if (!GEO.boxOpen) {
    const b = geoUnitBox();
    const g = new THREE.BufferGeometry();
    ['position', 'normal', 'uv'].forEach((k) => g.setAttribute(k, b.attributes[k]));
    /* BoxGeometry の面の順は +x, -x, +y, -y, +z, -z(各6インデックス)。-y(底)だけ除く */
    const idx = Array.from(b.index.array);
    g.setIndex(idx.slice(0, 18).concat(idx.slice(24)));
    g.computeBoundingSphere();
    GEO.boxOpen = g;
  }
  return GEO.boxOpen;
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
/* 電柱(コンクリート柱+腕金2本)。variant: 'L'=街灯つき 'T'=変圧器つき 'LT'=変圧器と街灯の両方 */
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
  if (variant === 'T' || variant === 'LT') {
    const t = new THREE.CylinderGeometry(0.3, 0.3, 1.0, 8); t.translate(0, 8.3, -0.42);
    parts.push({ g: t, col: srgbLin(0x8f969b) });
  }
  if (variant !== 'T') {
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
  const { shadow = false, receive = true, colors = true, cull = false } = opt;
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
    /* 見え方を切り替えないかたまりは、遠方の間引き(scene.js)の対象にする */
    if (cull) im.userData.cullCell = true;
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
  ['mansion', 'corridor', 'office', 'tower', 'zakkyo', 'shop', 'house'].forEach((k) => { M[k] = keep(facadeMaterial(k)); });
  M.box = keep(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 }));
  M.tank = keep(new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.6, metalness: 0.2 }));
  M.roof = keep(new THREE.MeshStandardMaterial({ map: texRoof(), color: 0xffffff, roughness: 0.78 }));
  M.pole = keep(new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.9 }));
  M.ao = keep(new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false }));
  M.wire = keep(new THREE.LineBasicMaterial({ color: 0x23272b }));
  M.glow = keep(new THREE.PointsMaterial({
    map: texGlowP1(), size: 3, sizeAttenuation: true, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, color: new THREE.Color(0xf3f5ff).multiplyScalar(2.2),
  }));
  /* 観覧車の電飾(街灯と同じ点の材質の色ちがい: シェーダは同じ) */
  M.wheelGlow = keep(new THREE.PointsMaterial({
    map: M.glow.map, size: 3.4, sizeAttenuation: true, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, color: new THREE.Color(0xfff2d8).multiplyScalar(2.6),
  }));
  M.stone = keep(new THREE.MeshStandardMaterial({ color: 0xa9a59c, roughness: 0.95 }));
  M.facades = ['mansion', 'corridor', 'office', 'tower', 'zakkyo', 'shop', 'house'].map((k) => M[k]);
  /* 街灯の光だまり(駅と同じ 'pool' のシェーダ)。昼は material.visible で消す。
   * LEDの防犯灯なので白(窓の暖色と対比)。中心が明るく、ふちに輪の出ない「距離の2乗」の落ち方の絵 */
  const pt = streetPoolTexture();
  rs._keep.add(pt);
  M.lampPool = keep(makePoolMaterial(pt, { color: 0xf2f2ee }));
  M.lampPool.visible = false;
  /* 玄関の明かり(門灯)が前の地面にこぼれる光(夜だけ。同じ 'pool' のシェーダ) */
  M.porchPool = keep(makePoolMaterial(pt, { color: 0xffd2a0 }));
  M.porchPool.visible = false;
  /* 店の看板('st-lineside' のシェーダ)。昼夜は emissiveIntensity だけ */
  M.sign = signMaterial(rs);
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
/* 道路: 128x256。左半分(u 0〜.5)= 幅5m×長さ20mの道路(白い外側線・小石・わだち)。
 * 右半分(u .5〜1)= 路面の表示と敷地の地面: 上から「とまれ」の文字・白一色(停止線・バス乗り場の線)・
 * 芝・砂利・土間コンクリート(家の敷地。道路と同じメッシュに入れるので描画は増えない)・横断歩道のしま。
 * 右半分の地はアスファルトの色(縮小したときに左の道路へにじんでも目立たない) */
export const ROAD_UV = {
  tomare: [0.535, 0.965, 0.6, 0.97],      // [u0, u1, v0(下), v1(上)]
  white: [0.62, 0.88, 0.43, 0.47],
  lawn: [0.6, 0.9, 0.365, 0.405],
  gravel: [0.6, 0.9, 0.295, 0.335],
  concrete: [0.6, 0.9, 0.225, 0.265],
  zebra: [0.5, 1.0, 0.02, 0.19],
};
function texRoad() {
  const cv = canvasOnce('road', 128, 256, (c) => {
    const r = makeRng(55);
    c.fillStyle = '#5d5f61'; c.fillRect(0, 0, 128, 256);
    for (let i = 0; i < 3000; i++) {
      const v = Math.floor(r() * 255);
      c.fillStyle = `rgba(${v},${v},${v},.12)`;
      c.fillRect(r() * 128, r() * 256, 1, 1);
    }
    c.fillStyle = 'rgba(0,0,0,.06)'; c.fillRect(16, 0, 8, 256); c.fillRect(40, 0, 8, 256);   // わだち
    for (let i = 0; i < 6; i++) { c.fillStyle = 'rgba(30,30,30,.08)'; c.fillRect(r() * 60, r() * 256, 4 + r() * 8, 2 + r() * 6); }
    c.fillStyle = '#e9e9e4'; c.fillRect(4, 0, 2, 256); c.fillRect(58, 0, 2, 256);
    /* 「とまれ」(道路の表示らしく、進む向きに長くのばした白い文字。上=停止線の側) */
    const tv = (v) => Math.round((1 - v) * 256);
    const ty0 = tv(ROAD_UV.tomare[3]), ty1 = tv(ROAD_UV.tomare[2]);
    c.save();
    c.fillStyle = 'rgba(236,236,230,.92)';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    const ch = (ty1 - ty0) / 3;
    ['と', 'ま', 'れ'].forEach((t, i) => {
      c.save();
      c.translate(96, ty0 + ch * (i + 0.5));
      c.scale(1, ch / 46);
      c.font = '900 50px sans-serif';
      c.fillText(t, 0, 2);
      c.restore();
    });
    c.restore();
    /* 白一色 */
    c.fillStyle = '#ecece6';
    c.fillRect(70, tv(ROAD_UV.white[3]) - 3, 52, tv(ROAD_UV.white[2]) - tv(ROAD_UV.white[3]) + 6);
    /* 横断歩道のしま(幅0.45m・すき間0.45m) */
    for (let x = 66; x < 126; x += 12) c.fillRect(x, tv(ROAD_UV.zebra[3]) + 2, 6, tv(ROAD_UV.zebra[2]) - tv(ROAD_UV.zebra[3]) - 4);
    /* 敷地の地面(芝・砂利・土間)。使う範囲より少し広く塗る(縮小したときに まわりの色がまざらない) */
    const sw = (uv, base, dots, n) => {
      const y0 = tv(uv[3]) - 3, y1 = tv(uv[2]) + 3;
      c.fillStyle = base; c.fillRect(66, y0, 60, y1 - y0);
      for (let i = 0; i < n; i++) { c.fillStyle = dots[(r() * dots.length) | 0]; c.fillRect(66 + r() * 58, y0 + r() * (y1 - y0 - 2), 1 + r() * 2, 1 + r() * 2); }
    };
    sw(ROAD_UV.lawn, '#7b8a5e', ['rgba(60,80,40,.35)', 'rgba(150,160,110,.3)'], 160);
    sw(ROAD_UV.gravel, '#8a8478', ['rgba(60,58,52,.35)', 'rgba(180,176,166,.4)'], 260);
    sw(ROAD_UV.concrete, '#9a968c', ['rgba(0,0,0,.08)', 'rgba(255,255,255,.08)'], 90);
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
    /* 芯は小さく明るく(灯具の大きさ)、まわりはうすいにじみ。近くの街灯が白い円盤にならないように */
    const g = c.createRadialGradient(32, 32, 0, 32, 32, 31);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.08, 'rgba(255,255,255,.85)');
    g.addColorStop(0.22, 'rgba(255,255,255,.24)');
    g.addColorStop(0.5, 'rgba(255,255,255,.06)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g; c.fillRect(0, 0, 64, 64);
  });
  return texFrom(cv, true, false);
}
/* 街灯の光だまり(128px)。灯具の真下が明るく、距離の2乗で落ちる(ふちに輪が出ないよう最後に少し引く)。
 * lightpool.poolTexture(駅の屋根の灯り)とは別の絵 */
function streetPoolTexture() {
  const cv = canvasOnce('spool', 128, 128, (c) => {
    const img = c.createImageData(128, 128);
    for (let y = 0; y < 128; y++) {
      for (let x = 0; x < 128; x++) {
        const dx = (x + 0.5) / 64 - 1, dy = (y + 0.5) / 64 - 1;
        const rr = Math.min(1, Math.hypot(dx, dy));
        const a = Math.max(0, Math.pow(1 / (1 + 7.3 * rr * rr), 1.5) - 0.035) / 0.965;
        const o = (y * 128 + x) * 4;
        img.data[o] = 255; img.data[o + 1] = 246; img.data[o + 2] = 232;
        img.data[o + 3] = Math.round(255 * a);
      }
    }
    c.putImageData(img, 0, 0);
  });
  return texFrom(cv, true, false);
}
/* 葉のまだら(グレースケール。インスタンス色がそのまま効く): 小さな葉のかたまり600個と、そのすき間の暗いかげ */
export function texLeaf() {
  const cv = canvasOnce('leaf', 128, 128, (c) => {
    const r = makeRng(91);
    c.fillStyle = 'rgb(168,168,168)'; c.fillRect(0, 0, 128, 128);
    const dot = (x, y, rr, fill) => {
      c.fillStyle = fill;
      [[0, 0], [128, 0], [-128, 0], [0, 128], [0, -128]].forEach(([dx, dy]) => { c.beginPath(); c.arc(x + dx, y + dy, rr, 0, 7); c.fill(); });
    };
    for (let i = 0; i < 600; i++) {
      const v = 185 + Math.floor(r() * 66);
      dot(r() * 128, r() * 128, 1.5 + r() * 1.5, `rgb(${v},${v},${v})`);
    }
    for (let i = 0; i < 160; i++) dot(r() * 128, r() * 128, 0.8 + r() * 1.2, 'rgba(40,40,40,.45)');
  });
  return texFrom(cv);
}
/* 森(上から見た樹冠の集まり): 半径6〜16画素の樹冠を約1700個(すき間は暗い割れ目が少し見えるくらい)。
 * 樹冠1つは3〜5個の重なった丸(1つの丸だと水玉・あわの並びに見える)。右下へずらした暗いかげを先に描き、
 * 樹冠全体に左上から1つの光のグラデーション(かたまりごとに丸く光らせない)。画像の上から順に描いて、
 * 下の樹冠が上の樹冠のすそに重なる(林を斜めに見たときの重なり)。7種類の緑(明るさ±12%)。
 * 平均の明るさは前の森の絵と同じ(丘全体の明るさを変えない)。丘に 11×1.6 回くり返して、樹冠1つが4〜8mになる */
function texForest() {
  const cv = canvasOnce('forest', 512, 512, (c) => {
    const r = makeRng(313);
    c.fillStyle = '#26331f'; c.fillRect(0, 0, 512, 512);
    const cols = [[48, 66, 40], [55, 75, 44], [62, 84, 50], [69, 91, 53], [51, 69, 42], [46, 62, 42], [73, 89, 50]];
    const rgb = (b, k) => `rgb(${Math.min(255, Math.round(b[0] * k))},${Math.min(255, Math.round(b[1] * k))},${Math.min(255, Math.round(b[2] * k))})`;
    /* 継ぎ目なしにくり返すため、はしにかかる樹冠は反対側にも描く */
    const wrap = (x, y, rr, fn) => {
      for (let dx = -512; dx <= 512; dx += 512) {
        for (let dy = -512; dy <= 512; dy += 512) {
          const px = x + dx, py = y + dy;
          if (px < -rr * 2 || px > 512 + rr * 2 || py < -rr * 2 || py > 512 + rr * 2) continue;
          fn(px, py);
        }
      }
    };
    const crowns = [];
    for (let i = 0; i < 1700; i++) {
      const rr = 6 + Math.pow(r(), 0.8) * 10;
      const base = cols[Math.floor(r() * cols.length) % cols.length];
      const k = 1 + (r() - 0.5) * 0.24;
      const n = 3 + Math.floor(r() * 3), blobs = [];
      for (let j = 0; j < n; j++) {
        const a = r() * Math.PI * 2, d = j === 0 ? 0 : rr * (0.3 + r() * 0.25);
        blobs.push([Math.cos(a) * d, Math.sin(a) * d * 0.85, rr * (j === 0 ? 0.75 : 0.5 + r() * 0.2)]);
      }
      crowns.push({ x: r() * 512, y: r() * 512, rr, base, k, blobs });
    }
    crowns.sort((p, q) => p.y - q.y);
    crowns.forEach(({ x, y, rr, base, k, blobs }) => {
      wrap(x, y, rr, (px, py) => {
        /* かげ(右下へずらした樹冠の形。まわりの樹冠の上に落ちる) */
        c.fillStyle = 'rgba(10,16,8,.5)';
        blobs.forEach(([ox, oy, br]) => { c.beginPath(); c.arc(px + ox + rr * 0.22, py + oy + rr * 0.3, br, 0, 7); c.fill(); });
        /* 樹冠: 左上から光(樹冠全体で1つのグラデーション) */
        const g = c.createRadialGradient(px - rr * 0.45, py - rr * 0.5, rr * 0.15, px - rr * 0.1, py - rr * 0.1, rr * 1.25);
        g.addColorStop(0, rgb(base, k * 1.25));
        g.addColorStop(0.45, rgb(base, k * 1.04));
        g.addColorStop(1, rgb(base, k * 0.74));
        c.fillStyle = g;
        blobs.forEach(([ox, oy, br]) => { c.beginPath(); c.arc(px + ox, py + oy, br, 0, 7); c.fill(); });
        /* 葉のかたまりの小さな影(右下) */
        c.fillStyle = 'rgba(14,22,10,.2)';
        blobs.forEach(([ox, oy, br], j) => { if (j) { c.beginPath(); c.arc(px + ox + br * 0.35, py + oy + br * 0.4, br * 0.55, 0, 7); c.fill(); } });
      });
    });
  });
  return texFrom(cv);
}

/* =========================================================
 * 街の組み立て(_buildTownSteps / _buildTown から呼ばれる)
 * 手順の列: 下ごしらえ(占有・区間の判定) → 側道・交差道路・電柱 → 中高層 → 戸建てと路地 →
 * 道路の面・車・看板 → 遠景 → 遠くの家並み → 道を走る車。順に全部呼べば buildTown と同じ
 * ========================================================= */
export function buildTownSteps(rs) {
  return [
    () => townPrep(rs),
    () => buildStreets(rs, rs._town),
    () => buildBuildings(rs, rs._town),
    () => buildHouses(rs, rs._town),
    () => townFlush(rs, rs._town),
    () => buildSkyline(rs, rs._town),
    () => buildFarBlocks(rs, rs._town),
    () => { rs._town.traffic = new RoadTraffic(rs); },
  ];
}
export function buildTown(rs) {
  const steps = buildTownSteps(rs);
  for (let i = 0; i < steps.length; i++) steps[i]();
}

function townPrep(rs) {
  const L = rs.line.meta.length;
  const T = {
    frame: 0, rev: null, lodX: 1e9, lodZ: 1e9, fb: { tod: null, w: null, rev: '', night: false, eve: false, rain: false, snow: false, wet: false, indoor: false },
    treeCells: [], wireCells: [], glows: [], groups: {}, obb: new Map(),
    cars: [], signs: [], boxesPre: [], cityLow: false, cross: null,
  };
  rs._town = T;
  rs._occ = new Map();
  rs._roadRuns = [];
  rs._crossStreets = [];
  rs._treeQueue = [];
  rs._groves = [];
  rs._crossCarList = [];
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
  roadBuffers(T);

  /* 区間の種類(10mごと)と駅の近さ */
  const urban = rs.line.sections.urban;
  const kinds = new Uint8Array(Math.ceil(L / 10) + 2);
  for (let i = 0; i < kinds.length; i++) {
    const s = i * 10;
    kinds[i] = (urban.find((u) => s >= u.from && s < u.to) || { kind: 2 }).kind;
  }
  T.kindAt = (s) => kinds[clamp(Math.floor(s / 10), 0, kinds.length - 1)];
  const sts = rs.line.stations;
  const gauss = (list) => (s) => {
    let best = 0;
    for (let i = 0; i < list.length; i++) {
      const d = (s - (list[i].s - 70)) / 320;
      const v = Math.exp(-d * d);
      if (v > best) best = v;
    }
    return best;
  };
  T.nearSt = gauss(sts);
  /* 大きな駅(駅前だけ中高層): 下北沢・経堂・成城学園前・登戸 */
  T.nearBig = gauss(sts.filter((st) => ['下北沢', '経堂', '成城学園前', '登戸'].indexOf(st.name) >= 0));
  /* 乗りかえ・バスの集まる駅(駅前の街とロータリー): 新百合ヶ丘・向ヶ丘遊園・登戸・下北沢 */
  T.hubs = sts.filter((st) => ['新百合ヶ丘', '向ヶ丘遊園', '登戸', '下北沢'].indexOf(st.name) >= 0);
  T.nearHub = gauss(T.hubs);
  /* 世田谷の低層住宅地(代々木上原の先〜和泉多摩川)。駅の s で決めるので のぼり/くだり どちらでも同じ所 */
  const sA = rs._stationS('代々木上原'), sB = rs._stationS('和泉多摩川');
  /* 代々木上原の駅前250mは中高層のまま。のぼりは s の向きが逆なので、代々木上原の側の端をずらす */
  const lrOk = sA !== null && sB !== null;
  const lrLo = lrOk ? (sA < sB ? sA + 250 : sB) : 0, lrHi = lrOk ? (sA < sB ? sB : sA - 250) : -1;
  T.lowRise = (s) => s > lrLo && s < lrHi;
  const sj = sts.find((st) => st.name === '新宿');
  T.sShinjuku = sj ? sj.s : -1e9;
  const QO = rs.quadOff || [3.8, 7.6];
  const q = rs.line.sections.quad;
  T.inQuad = (s) => s > q.from - 30 && s < q.to + 30;
  T.fence = (side, s) => (side > 0 ? (T.inQuad(s) ? QO[1] + 3.6 : 5.4) : 8.9);
  T.inRiver = (s, m) => rs.line.sections.river.some((r) => s > r.from - m && s < r.to + m);
  T.skipS = (s) => rs._inTunnel(s) || rs._inTerminal(s, 45);
  /* 戸建ての並ぶ奥行き(m)。中・高画質は世田谷と郊外で170mまで(9列目から先は簡単な家) */
  const farRows = qk >= 0.75;
  T.farRows = farRows;
  T.maxDAt = (s) => {
    const kind = T.kindAt(s);
    /* 丘陵でも駅の近くは140mまで(その先の「家並みの屋根」の地面へつなぐ) */
    return kind === 0 ? 0 : T.lowRise(s) || kind === 2 ? (farRows ? 170 : 110) : kind === 3 ? (farRows && T.nearSt(s) > 0.3 ? 140 : 90) : 70;
  };
  /* 戸建ての列の手前の線(側道があればその外) */
  T.houseStart = (side, s) => {
    const road = T.roadAt ? T.roadAt(side, s) : null;
    return Math.max(T.fence(side, s) + 6, road ? road.clear + 0.4 : 0);
  };
  /* いちばん外の路地の番号(0=路地なし)。路地 k は手前から 25k+4.5(k-1) 〜 +4.5m。
   * その外の列(2k-1列目: 路地のほうを向く)の敷地が奥行きの中に入るときだけ作る */
  T.laneMax = (side, s) => {
    const md = T.maxDAt(s);
    if (!md) return 0;
    return clamp(Math.floor((md + 8.5 - T.houseStart(side, s)) / 29.5), 0, 6);
  };

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
}

/* 路地を足した道路の面をメッシュにし、車庫・駐車場・バスの車と店の看板を出す */
function townFlush(rs, T) {
  flushRoads(rs, T);
  T.obb = null;   // 配置が終わったら外形の表は不要
  /* 車庫・駐車場の車と店の看板(どちらも かたまりごとに1回の描画)。遠くでは小さすぎるので近いかたまりだけ */
  addCarsRaw(rs, T.cars, T.groups.town).forEach((m) => { nearOnly(T, m, 270); carLod(T, m, 0); });
  buildShopSigns(rs, T.groups.town, T.signs).forEach((m) => nearOnly(T, m, 650));
  /* 駅前の駐輪場の自転車(駅ごとに1つのまとまり。車と同じ材質。250mより遠いと小さすぎるので描かない) */
  if (T.bikes && T.bikes.length) emitInstanced(T.groups.town, geoBike(), carMaterial(rs), T.bikes, (it) => it.k, { colors: true }).forEach((m) => nearOnly(T, m, 250));
  T.bikes = null;
  T.carCount = T.cars.length; T.signCount = T.signs.length;
  T.cars = T.signs = null;
}

/* 踏切待ちの車(scene.js _buildCrossings から1回だけ): 種類ごとのインスタンス。450mより遠い踏切の車は描かない。
 * 踏切が開くと動き出す(updateTown)ので、外接球を道に沿って60mぶん広げておく */
export function addCars(rs, spots) {
  const ms = addCarsRaw(rs, spots);
  ms.forEach((m) => { if (m.boundingSphere) m.boundingSphere.radius += 60; });
  if (rs._town) ms.forEach((m) => { nearOnly(rs._town, m, 450); carLod(rs._town, m, 60); });
  return ms;
}

/* 車のかたまりも木と同じ距離の段階(updateTown の木のLOD: 150mより近いと細かい形・165mより遠いと軽い形)で
 * 形を差しかえる(遠くの車は数画素なので、タイヤハウス・バンパー・ミラーを省いた形で三角形をへらす)。
 * pad: 動く車(踏切待ち)の外接矩形を道に沿って広げる幅(m) */
function carLod(T, m, pad) {
  const type = m.userData.carType;
  if (!type || !T || !T.treeCells) return;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < m.count; i++) {
    m.getMatrixAt(i, _m4);
    const x = _m4.elements[12], z = _m4.elements[14];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  T.treeCells.push({ mesh: m, hi: geoCar(type), lo: geoCar(type, true), x0: x0 - pad, x1: x1 + pad, z0: z0 - pad, z1: z1 + pad, far: false, shadow: m.castShadow });
}

/* 近いときだけ見せるかたまりに登録(外接矩形は形の箱+インスタンスの位置から)。
 * 見え方をここで切り替えるので、遠方の間引き(cullCell)からは外す */
const _bb = new THREE.Box3();
function nearOnly(T, obj, d) {
  obj.userData.cullCell = false;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  if (obj.isInstancedMesh) {
    for (let i = 0; i < obj.count; i++) {
      obj.getMatrixAt(i, _m4);
      const x = _m4.elements[12], z = _m4.elements[14];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
  } else {
    obj.geometry.computeBoundingBox();
    _bb.copy(obj.geometry.boundingBox);
    x0 = _bb.min.x; x1 = _bb.max.x; z0 = _bb.min.z; z1 = _bb.max.z;
  }
  T.wireCells.push({ obj, x0, x1, z0, z1, d2: d * d });
}

/* ランドマークの敷地(鳥居の社叢・梅林・観覧車・車両基地)を先に押さえる */
function landmarkZones(rs, T) {
  const at = (n) => rs._stationS(n);
  const s1 = at('代々木八幡');
  if (s1 !== null) stampBand(rs, s1 - 215, s1 - 165, -9, -58, HARD);
  const s2 = at('梅ヶ丘');
  if (s2 !== null) stampBand(rs, s2 - 160, s2 + 160, -10, -46, HARD);
  const s3 = at('読売ランド前');
  /* 観覧車と足もとの丘(半径70m・線路方向に±95m)。家・路地を丘のすそにうめないよう丘の広さで押さえる */
  if (s3 !== null) stampBand(rs, s3 + 185, s3 + 375, 72, 216, HARD);
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

/* ---------- 道路の面(700mごとに1つのジオメトリ)。路地・駅前広場も同じ入れ物に入れ、最後に flushRoads でメッシュにする ---------- */
const ROAD_CH = 700;
function roadBuffers(T) {
  T.roadBufs = new Map();
  T.rb = (s) => {
    const k = Math.floor(s / ROAD_CH);
    let b = T.roadBufs.get(k);
    if (!b) T.roadBufs.set(k, (b = { pos: [], uv: [], idx: [], n: 0 }));
    return b;
  };
  T.quad = (b, a0, a1, b0, b1, ua, ub, va, vb) => {
    /* a0-a1: 手前の辺(左右) b0-b1: 奥の辺。面が上を向くように巻き順を選ぶ */
    const n = b.n;
    b.pos.push(a0[0], a0[1], a0[2], a1[0], a1[1], a1[2], b0[0], b0[1], b0[2], b1[0], b1[1], b1[2]);
    b.uv.push(ua, va, ub, va, ua, vb, ub, vb);
    const ex = b0[0] - a0[0], ez = b0[2] - a0[2], fx = a1[0] - a0[0], fz = a1[2] - a0[2];
    if (ez * fx - ex * fz > 0) b.idx.push(n, n + 2, n + 1, n + 1, n + 2, n + 3);
    else b.idx.push(n, n + 1, n + 2, n + 1, n + 3, n + 2);
    b.n += 4;
  };
  /* 中心(cx,cz)・半径 r の円(seg の扇)。駅前ロータリー */
  T.disc = (b, cx, y, cz, r, seg) => {
    const n = b.n;
    b.pos.push(cx, y, cz); b.uv.push(0.25, 0);
    for (let k = 0; k <= seg; k++) {
      const a = (k / seg) * Math.PI * 2;
      b.pos.push(cx + Math.cos(a) * r, y, cz + Math.sin(a) * r);
      b.uv.push(0.25 + 0.2 * Math.cos(a), (Math.sin(a) * r) / 20);
    }
    /* 上から見て時計回り(x→z)の順なので、面が上を向くように n, k+1, k の順 */
    for (let k = 0; k < seg; k++) b.idx.push(n, n + 2 + k, n + 1 + k);
    b.n += seg + 2;
  };
}
/* 道路の入れ物をメッシュにする(buildHouses の路地のあと) */
function flushRoads(rs, T) {
  const g = T.groups.streets;
  T.roadBufs.forEach((bf) => {
    if (!bf.n) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(bf.pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(bf.uv, 2));
    const nn = new Float32Array(bf.n * 3);
    for (let i = 0; i < bf.n; i++) nn[i * 3 + 1] = 1;
    geo.setAttribute('normal', new THREE.BufferAttribute(nn, 3));
    geo.setIndex(bf.idx);
    geo.computeBoundingSphere();
    const m = new THREE.Mesh(geo, T.M.road);
    m.receiveShadow = true;
    m.userData.cullCell = true;
    g.add(m);
  });
  T.roadBufs = null;
}

/* ---------- 側道・交差道路・電柱・電線・街灯 ---------- */
function buildStreets(rs, T) {
  const F = rs.frames, step = rs.step, L = rs.line.meta.length;
  const rng = makeRng(2468);
  /* 通りの小物は別の乱数の列で(いままでの道路・電柱の並びを変えない) */
  const rngF = makeRng(2468 + 303);
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
  T.rampY = rampY;
  const roadEdge = (side, s) => T.fence(side, s) + 0.8;
  const CH = ROAD_CH;
  const rb = T.rb, quad = T.quad;

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
  /* 街灯の光だまり(道路の面に寝かせた板) */
  const pools = [];
  /* 電柱はどれも防犯灯つき(3本に1本は変圧器も)。yRoad: 灯具の下の道路面の高さ。
   * pool: 光だまりの中心・大きさ・向き(なければ灯具の真下に11mの円) */
  const addPole = (x, y, z, xdx, xdz, s, sh, yRoad, pool) => {
    const variant = poleN++ % 3 === 2 ? 'LT' : 'L';
    const P = { x, y, z, yaw: yawFromX(xdx, xdz), s, sh, variant, ax: xdx, az: xdz, sx: 1, sy: 1, sz: 1 };
    poles.push(P);
    gb(s).push(x + xdx * 1.3, y + 6.25, z + xdz * 1.3);
    if (pool) pools.push({ x: pool.x, y: yRoad + 0.04, z: pool.z, yaw: pool.yaw, sx: pool.sx, sy: 1, sz: pool.sz, s });
    else pools.push({ x: x + xdx * 1.3, y: yRoad + 0.04, z: z + xdz * 1.3, yaw: 0, sx: 11, sy: 1, sz: 11, s });
    return P;
  };

  /* (a) 側道: 300〜900mの区間を左右交互に(6割は左) */
  const fr = FR();
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
      if (prev) quad(rb(ss), prev.a, prev.b, cur.a, cur.b, side > 0 ? 0 : 0.5, side > 0 ? 0.5 : 0, prev.v, cur.v);
      prev = cur;
    }
    /* 左側は「よこ」カメラ(線路から13.5m)の後ろに電柱・街路樹を置く(画面の手前をふさがない) */
    const poleOff = side > 0 ? Math.max(5.45, 14.4 - edge) : 5.45;
    stampBand(rs, run.s0, run.s1, side * edge, side * (edge + poleOff + 1.2), HARD);
    rs._roadRuns.push({ side, s0: run.s0, s1: run.s1, inner: edge, outer: edge + 5, clear: edge + poleOff + 1.2 });
    /* 電柱: 外側の縁に30mおき(線路側へ腕を出す)。光だまりは道路の中心より少し電柱寄り(縦長: 道に沿って) */
    let pa = null;
    for (let ps = run.s0 + 8; ps <= run.s1 - 4; ps += 30) {
      if (crossS.some((cs) => Math.abs(cs - ps) < 6)) continue;
      sampleFrame(F, step, ps, fr);
      const lat = side * (edge + poleOff);
      const pl = side * (edge + 3.0);
      const P = addPole(fr.x + fr.lx * lat, fr.y - 0.5, fr.z + fr.lz * lat, -side * fr.lx, -side * fr.lz, ps, true, fr.y + rampY(ps),
        { x: fr.x + fr.lx * pl, z: fr.z + fr.lz * pl, yaw: fr.yaw, sx: 9, sz: 15 });
      if (pa && ps - pa.s < 45) span(pa, P, ps);
      pa = P;
    }
    /* 街路樹(3割の側道) */
    if (rng() < 0.3) {
      /* 間隔・大きさを少しずつ変え、ところどころ欠けさせる(ロリポップの行列に見せない) */
      for (let ts = run.s0 + 12; ts <= run.s1 - 6; ts += 7.5 + rng() * 3) {
        if (Math.abs(((ts - run.s0 - 8) % 30)) < 3.5 || rng() < 0.18) continue;
        sampleFrame(F, step, ts, fr);
        const lat = side * (edge + poleOff + 0.5 + rng() * 0.6);
        rs._treeQueue.push({ x: fr.x + fr.lx * lat, y: fr.y - 0.5, z: fr.z + fr.lz * lat, s: ts, sc: 0.68 + rng() * 0.42, tint: 0.8 + rng() * 0.32 });
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

  /* (b) 交差道路: 線路から外へまっすぐ(踏切の位置には必ず両側)。住宅地では いちばん外の路地まで */
  const streets = [];
  for (let s2 = 200; s2 < L - 150;) {
    const k = T.kindAt(s2);
    s2 += k === 3 ? 160 + rng() * 100 : 90 + rng() * 60;
    if (k === 0) continue;
    [1, -1].forEach((side) => { if (rng() < 0.7) streets.push({ s: s2, side, cross: false }); });
  }
  crossS.forEach((cs) => { streets.push({ s: cs, side: 1, cross: true }); streets.push({ s: cs, side: -1, cross: true }); });
  const W = 2.25;
  const RU = ROAD_UV;
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
    /* 住宅地は いちばん外の路地の外の縁まで(路地がなければ150m) */
    const lk = T.laneMax(side, ss);
    const bEnd = lk > 0 && (T.lowRise(ss) || T.kindAt(ss) >= 2) ? Math.max(a + 20, T.houseStart(side, ss) + 29.5 * lk) : 150;
    const yg = fr.y - 0.41;
    const P = (o, y, dt) => [fr.x + fr.lx * side * o + fr.tx * dt, y, fr.z + fr.lz * side * o + fr.tz * dt];
    const b = rb(ss);
    if (st.cross) {
      /* 踏切: 道路板(56m・中心は-1.9m)の端から坂で地面へ */
      const aE = side > 0 ? 26.0 : 29.8;
      const yTop = fr.y + 0.12, mid = aE + 10;
      quad(b, P(aE, yTop, -2.6), P(aE, yTop, 2.6), P(mid, yg, -W), P(mid, yg, W), 0, 0.5, 0, 0.5);
      a = mid;
    }
    /* 地面の起伏に合わせて15mごとに区切る(帯は線路の標高で平ら) */
    const segs = Math.max(1, Math.ceil((bEnd - a) / 15));
    for (let k = 0; k < segs; k++) {
      const o0 = a + ((bEnd - a) * k) / segs, o1 = a + ((bEnd - a) * (k + 1)) / segs;
      quad(b, P(o0, yg, -W), P(o0, yg, W), P(o1, yg, -W), P(o1, yg, W), 0, 0.5, o0 / 20, o1 / 20);
    }
    /* 側道にぶつかる手前: 停止線と「とまれ」(線路へ向かって走る車の側の車線。左側通行なので車から見て左=+side*t)。
     * 文字の上(と)が停止線の側。少し浮かせて道路の面とちらつかないように */
    if (road && !st.cross) {
      const ym = yg + 0.03, dl = side * (W - 0.15), dr = side * 0.12;
      const o0 = a + 3.6;
      quad(b, P(o0, ym, dl), P(o0, ym, dr), P(o0 + 0.45, ym, dl), P(o0 + 0.45, ym, dr), RU.white[0], RU.white[1], RU.white[2], RU.white[3]);
      /* 文字の板は外側線にかからない幅で(線が途切れて見えないように) */
      const o1 = o0 + 1.2, dg = side * (W - 0.6);
      quad(b, P(o1, ym, dg), P(o1, ym, dr), P(o1 + 5.2, ym, dg), P(o1 + 5.2, ym, dr), RU.tomare[0], RU.tomare[1], RU.tomare[3], RU.tomare[2]);
      /* 停止線の左の角に「止まれ」の標識(線路のほうへ走る車に表を向ける)。
       * 側道の向こう側(柵と側道のあいだ)にカーブミラー(オレンジの柱・鏡は交差道路のほうを向く) */
      const yb = fr.y - 0.45, fx = side * fr.lx, fz = side * fr.lz;
      const [tx0, , tz0] = P(o0 + 0.3, 0, side * (W + 0.35));
      T.boxesPre.push(paint({ x: tx0, y: yb, z: tz0, yaw: fr.yaw, sx: 0.06, sy: 2.55, sz: 0.06, s: ss, sh: false }, 0x9a9ea2, 0.03, rngF));
      T.signs.push({ kind: 'tomare', s: ss, x: tx0 + fx * 0.05, y: yb + 2.15, z: tz0 + fz * 0.05, fx, fz, w: 0.8, h: 0.7 });
      const mo = road.inner - 0.4;
      const mx = fr.x + fr.lx * side * mo, mz = fr.z + fr.lz * side * mo;
      T.boxesPre.push(paint({ x: mx, y: yb, z: mz, yaw: fr.yaw, sx: 0.08, sy: 2.6, sz: 0.08, s: ss, sh: false }, 0xd8742a, 0.04, rngF));
      T.boxesPre.push(paint({ x: mx + fx * 0.05, y: yb + 2.1, z: mz + fz * 0.05, yaw: fr.yaw, sx: 0.04, sy: 0.7, sz: 0.7, s: ss, sh: false }, 0xd8742a, 0.04, rngF));
      T.boxesPre.push(paint({ x: mx + fx * 0.09, y: yb + 2.15, z: mz + fz * 0.09, yaw: fr.yaw, sx: 0.06, sy: 0.6, sz: 0.6, s: ss, sh: false }, 0x2a3136, 0.03, rngF));
    }
    rs._crossStreets.push({ s: ss, side, a, b: bEnd, cross: st.cross });
    stampBand(rs, ss - 3.3, ss + 3.3, side * a, side * bEnd, HARD);
    /* 交差道路の片側に電柱(120mまで)。腕は道路の中心へ */
    if (rng() < (T.q >= 1 ? 0.85 : T.q >= 0.75 ? 0.65 : 0.4)) {
      const sideT = rng() < 0.5 ? 1 : -1;
      let pa = null;
      for (let o = a + 6; o <= Math.min(120, bEnd - 2); o += 30) {
        const x = fr.x + fr.lx * side * o + fr.tx * sideT * (W + 0.55);
        const z = fr.z + fr.lz * side * o + fr.tz * sideT * (W + 0.55);
        const P2 = addPole(x, fr.y - 0.5, z, -sideT * fr.tx, -sideT * fr.tz, ss, false, fr.y - 0.41, null);
        if (pa) span(pa, P2, ss);
        pa = P2;
      }
    }
  });

  /* (c) 側道の小物: 最高速度30の標識(外側の縁・300mおき。その側の車線を走る車に表を向ける)と、
   * 駅の近くの市街地のガードパイプ(外側の縁。20mの手すり+4mおきの支柱。交差道路・踏切の所は切る) */
  rs._roadRuns.forEach((run) => {
    const side = run.side;
    const xs = rs._crossStreets.filter((c) => c.side === side);
    const nearX = (q, m) => xs.some((c) => Math.abs(c.s - q) < m) || crossS.some((c) => Math.abs(c - q) < m + 14);
    for (let ps = run.s0 + 23; ps < run.s1 - 10; ps += 300) {
      if (nearX(ps, 6)) continue;
      sampleFrame(F, step, ps, fr);
      const o = run.outer + 0.35, yb = fr.y + rampY(ps) - 0.05;
      const x = fr.x + fr.lx * side * o, z = fr.z + fr.lz * side * o;
      T.boxesPre.push(paint({ x, y: yb, z, yaw: fr.yaw, sx: 0.06, sy: 2.45, sz: 0.06, s: ps, sh: false }, 0x9a9ea2, 0.03, rngF));
      const fd = side > 0 ? -1 : 1;
      T.signs.push({ kind: 'sp30', s: ps, x: x + fr.tx * fd * 0.05, y: yb + 2.1, z: z + fr.tz * fd * 0.05, fx: fr.tx * fd, fz: fr.tz * fd, w: 0.6 });
    }
    const fa = FR();
    for (let gs = run.s0 + 4; gs + 20 <= run.s1 - 2; gs += 20) {
      const mid = gs + 10;
      if (T.kindAt(mid) > 1 || T.nearSt(mid) <= 0.15 || nearX(mid, 10 + W + 1)) continue;
      sampleFrame(F, step, gs, fr); sampleFrame(F, step, gs + 20, fa);
      const o = run.outer + 0.12;
      const ax = fr.x + fr.lx * side * o, az = fr.z + fr.lz * side * o, bx = fa.x + fa.lx * side * o, bz = fa.z + fa.lz * side * o;
      const yb = (fr.y + fa.y) / 2 + rampY(mid) - 0.05;
      const yaw = Math.atan2(bx - ax, bz - az), len = Math.hypot(bx - ax, bz - az);
      T.boxesPre.push({ x: (ax + bx) / 2, y: yb + 0.78, z: (az + bz) / 2, yaw, sx: 0.05, sy: 0.05, sz: len, s: mid, sh: false, r: 0.82, g: 0.82, b: 0.8 });
      for (let k = 0; k <= 5; k++) {
        const t = k / 5;
        T.boxesPre.push({ x: ax + (bx - ax) * t, y: yb, z: az + (bz - az) * t, yaw, sx: 0.05, sy: 0.8, sz: 0.05, s: mid, sh: false, r: 0.82, g: 0.82, b: 0.8 });
      }
    }
  });

  /* (d) 大きな駅の駅前広場(バスのロータリー)。駅舎の側(右)の 26〜52m。駅前の駐輪場(どの駅も) */
  buildPlazas(rs, T);
  buildBikes(rs, T);

  /* --- メッシュ化(道路の面は flushRoads で。路地を足してから) --- */
  const g = T.groups.streets;
  ['L', 'LT'].forEach((v) => {
    const list = poles.filter((p) => p.variant === v);
    /* 電柱は1km先では1画素より細いので、近いかたまりだけ */
    if (list.length) emitInstanced(g, geoPole(v), M.pole, list, CH, { shadow: true, colors: false }).forEach((m) => nearOnly(T, m, 1000));
  });
  wires.forEach((arr) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    geo.computeBoundingSphere();
    const ls = new THREE.LineSegments(geo, M.wire);
    g.add(ls);
    /* 遠い電線は1pxの線がちらつくので隠す(外接矩形で距離判定) */
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < arr.length; i += 3) {
      const x = arr[i], z = arr[i + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    T.wireCells.push({ obj: ls, x0, x1, z0, z1, d2: 450 * 450 });
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
  /* 光だまり(lightpool.js の材質 'pool'): 700mごとの InstancedMesh(地面に寝かせた板)。
   * 昼夜は材質の visible で切り替え、550mより遠いかたまりは描かない(遠くでは霧でほとんど見えないので描画を省く) */
  if (pools.length) {
    emitInstanced(g, geoFlat(), M.lampPool, pools, CH, { colors: false, receive: false }).forEach((m) => { m.renderOrder = 2; nearOnly(T, m, 550); });
  }
}

/* 地面に寝かせた1m四方の板(上向き) */
function geoFlat() {
  if (!GEO.pool) { GEO.pool = new THREE.PlaneGeometry(1, 1); GEO.pool.rotateX(-Math.PI / 2); }
  return GEO.pool;
}

/* 駅前広場: 直径25mのロータリー(道路の円)・中央の植え込み(箱+木3本)・バス乗り場の白線4つ・とまっているバス2台・外への道。
 * 場所は駅舎と駅前(線路の右 9〜24m・st.s-78〜-32)のすぐ外。先に HARD で押さえて、ビル・家がのらないようにする */
function buildPlazas(rs, T) {
  const F = rs.frames, step = rs.step;
  const fr = FR();
  const rng = makeRng(3141);
  const rngP = makeRng(3141 + 7);   // 広場の自動販売機(別の乱数の列)
  T.plazas = [];
  T.hubs.forEach((st) => {
    if (rs._inTunnel(st.s) || rs._inTunnel(st.s - 55)) return;
    const sc = st.s - 55;
    sampleFrame(F, step, sc, fr);
    const lat = -39, R = 12.5;
    /* 高さ: 舗装 -0.43 < 外への道 -0.40 < ロータリー -0.38(重なる面を2cm以上はなす。遠くからの見下ろしでちらつかない) */
    const cx = fr.x + fr.lx * lat, cz = fr.z + fr.lz * lat, y = fr.y - 0.38, yR = fr.y - 0.4;
    /* 広場は手前(線路の向きで手前)に広く空ける(上から見下ろすカメラから見えるように)。舗装は土間の色 */
    stampBand(rs, sc - 46, sc + 19, -24, -57, HARD);
    const b = T.rb(sc);
    const fq = FR();
    const CU = ROAD_UV.concrete;
    for (let k = 0; k < 3; k++) {
      const s0 = sc - 45 + k * 21, s1 = s0 + 21;
      sampleFrame(F, step, s0, fq);
      const a0 = [fq.x + fq.lx * -25, fq.y - 0.43, fq.z + fq.lz * -25], a1 = [fq.x + fq.lx * -56, fq.y - 0.43, fq.z + fq.lz * -56];
      sampleFrame(F, step, s1, fq);
      const b0 = [fq.x + fq.lx * -25, fq.y - 0.43, fq.z + fq.lz * -25], b1 = [fq.x + fq.lx * -56, fq.y - 0.43, fq.z + fq.lz * -56];
      T.quad(b, a0, a1, b0, b1, CU[0], CU[1], CU[2], CU[3]);
    }
    T.disc(b, cx, y, cz, R, 24);
    /* 外への道(幅6m・60m) */
    const P = (o, dt, yy) => [fr.x + fr.lx * o + fr.tx * dt, yy, fr.z + fr.lz * o + fr.tz * dt];
    T.quad(b, P(lat - R + 0.6, -3, yR), P(lat - R + 0.6, 3, yR), P(lat - R - 60, -3, yR), P(lat - R - 60, 3, yR), 0, 0.5, 0, 3);
    stampBand(rs, sc - 3.6, sc + 3.6, -52, -114, HARD);
    /* バス乗り場の白線(円の外周に沿った4本の線) */
    const RU = ROAD_UV.white;
    const a0 = Math.atan2(fr.lz, fr.lx);
    for (let k = 0; k < 4; k++) {
      const ang = Math.PI * (0.15 + k * 0.23) + a0;
      const ox = Math.cos(ang), oz = Math.sin(ang);
      const tx = -oz, tz = ox;
      const r0 = R - 3.0, r1 = R - 2.85, h = 6;
      const A = (rr, tt) => [cx + ox * rr + tx * tt, y + 0.03, cz + oz * rr + tz * tt];
      T.quad(b, A(r0, -h), A(r0, h), A(r1, -h), A(r1, h), RU[0], RU[1], RU[2], RU[3]);
    }
    /* 中央の植え込み(低い箱)と木3本 */
    T.boxesPre.push(paint({ x: cx, y: fr.y - 0.5, z: cz, yaw: fr.yaw, sx: 7, sy: 0.45, sz: 7, s: sc, sh: false }, 0x8a877e, 0.03, rng));
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2 + 0.4;
      rs._treeQueue.push({ x: cx + Math.cos(a) * 1.8, y: fr.y - 0.05, z: cz + Math.sin(a) * 1.8, s: sc, sc: 0.75 + rng() * 0.2, tint: 0.85 + rng() * 0.2 });
    }
    /* 乗り場にとまっているバス2台(円の外周に沿って) */
    for (let k = 0; k < 2; k++) {
      const ang = Math.PI * (0.22 + k * 0.46) + a0;
      const ox = Math.cos(ang), oz = Math.sin(ang);
      const rr = R - 1.6;
      /* 前(+z)を円の接線の向きへ */
      const sp = { x: cx + ox * rr, y: y + 0.02, z: cz + oz * rr, yaw: Math.atan2(-oz, ox), type: 'bus', s: sc, sh: true };
      carPaint(sp, 0xf0f0ec, rng);
      T.cars.push(sp);
    }
    /* 広場のふち(駅の側)に自動販売機を2台ずつ2か所(前の面は広場のほう。夜は光る) */
    [sc - 38, sc + 10].forEach((vs) => {
      sampleFrame(F, step, vs, fq);
      const nx = -fq.lx, nz = -fq.lz;
      for (let k = -1; k <= 1; k += 2) {
        const x = fq.x + fq.lx * -25.6 + fq.tx * k * 0.51, z = fq.z + fq.lz * -25.6 + fq.tz * k * 0.51;
        const v = rngP() < 0.6 ? 0 : 1;
        T.boxesPre.push(paint({ x, y: fq.y - 0.45, z, yaw: fq.yaw, sx: 0.75, sy: 1.83, sz: 1.0, s: sc, sh: false }, v ? 0xc9d2da : 0xeceeea, 0.03, rngP));
        T.signs.push({ kind: 'jihanki', s: sc, x: x + nx * 0.385, y: fq.y - 0.45 + 0.95, z: z + nz * 0.385, fx: nx, fz: nz, w: 0.92, h: 1.6, d: 0, cell: v });
      }
    });
    T.plazas.push({ s: sc, x: cx, z: cz, r: R });
  });
}

/* 駅前の駐輪場: どの駅も駅舎の側(右)の 線路から20〜22m・st.s-76〜-64(駅舎より手前。駅と駅前の HARD の中)に、
 * 自転車を2列(1列19台から15%ぬく。列ごとに前の向きを変える)と、前輪を入れる低い横棒。手前のはしに自動販売機2台。
 * 地下の駅・新宿・ターミナルの中は置かない */
const BIKE_PAINTS = [0xb8bcc0, 0xb8bcc0, 0xe8e8e4, 0x2a2c30, 0x9a2a2a, 0x2c4a7a, 0x4f6b4f, 0xc8c0a8];
function buildBikes(rs, T) {
  const F = rs.frames, step = rs.step;
  const rng = makeRng(4242), rngV = makeRng(4242 + 9);
  const fr = FR();
  T.bikes = [];
  rs.line.stations.forEach((st, si) => {
    if (st.name === '新宿' || rs._inTunnel(st.s) || rs._inTunnel(st.s - 72) || rs._inTerminal(st.s - 72, 20)) return;
    for (let row = 0; row < 2; row++) {
      const lat = row ? -22.3 : -19.9, dir = row ? -1 : 1;
      for (let k = 0; k < 19; k++) {
        if (rng() < 0.15) continue;
        const s = st.s - 75.6 + k * 0.62 + (rng() - 0.5) * 0.08;
        sampleFrame(F, step, s, fr);
        const yaw = Math.atan2(dir * fr.lx, dir * fr.lz) + (rng() - 0.5) * 0.12;
        T.bikes.push(paint({ x: fr.x + fr.lx * lat, y: fr.y - 0.48, z: fr.z + fr.lz * lat, yaw, sx: 1, sy: 1, sz: 1, s: st.s, k: si, sh: false }, pick(BIKE_PAINTS, rng), 0.05, rng));
      }
      /* 前輪を入れる低い横棒(銀) */
      sampleFrame(F, step, st.s - 70.0, fr);
      const rl = lat + dir * 0.62;
      T.boxesPre.push({ x: fr.x + fr.lx * rl, y: fr.y - 0.5 + 0.28, z: fr.z + fr.lz * rl, yaw: fr.yaw, sx: 0.05, sy: 0.05, sz: 11.8, s: st.s, sh: false, r: 0.6, g: 0.61, b: 0.62 });
    }
    /* 駐輪場の手前のはしに自動販売機2台(前の面は駅に入ってくる列車のほう。夜は光る) */
    sampleFrame(F, step, st.s - 77.0, fr);
    const nx = -fr.tx, nz = -fr.tz;
    for (let k = 0; k < 2; k++) {
      const lat = -20.4 - k * 1.02;
      const x = fr.x + fr.lx * lat, z = fr.z + fr.lz * lat;
      const v = rngV() < 0.6 ? 0 : 1;
      T.boxesPre.push(paint({ x, y: fr.y - 0.5, z, yaw: fr.yaw, sx: 1.0, sy: 1.83, sz: 0.75, s: st.s, sh: false }, v ? 0xc9d2da : 0xeceeea, 0.03, rngV));
      T.signs.push({ kind: 'jihanki', s: st.s, x: x + nx * 0.387, y: fr.y - 0.5 + 0.95, z: z + nz * 0.387, fx: nx, fz: nz, w: 0.92, h: 1.6, d: 0, cell: v });
    }
  });
}

/* ---------- 中高層の建物(線路と平行・駅前ほど高く密に) ---------- */
/* 白っぽい色だけだと上から見て「白い箱の海」になるので、3分の1ほどは中間〜濃い色のタイル・打ち放し */
const PAL = {
  mansion: [0xe7e2d8, 0xd9ccb6, 0xcbb89c, 0xb9a68c, 0xefece6, 0xa9a49b, 0xd2c9bb, 0x9c7f6a, 0x86705f, 0xb3a493, 0x7c7b78],
  office: [0xc5c9cb, 0xaab1b6, 0xd7d5d0, 0x8f969c, 0x6c7378],
  tower: [0x9fb0bf, 0x7f93a6, 0xb8c3cc],
  zakkyo: [0xd8cfc0, 0xc4b8a6, 0xb7aa98, 0xe0dbd2, 0x8f7a68, 0xa39b90, 0x6f6e6b],
  shop: [0xf2efe8, 0xe6e2da, 0xdcd8d0],
};
PAL.corridor = PAL.mansion;
function pickType(kind, h, rng) {
  const r = rng();
  if (kind === 0) return h > 60 ? 'tower' : r < 0.5 ? 'office' : 'zakkyo';
  if (kind === 1) return r < 0.25 ? 'mansion' : r < 0.45 ? 'corridor' : r < 0.75 ? 'zakkyo' : 'office';
  if (kind === 2) return r < 0.45 ? 'mansion' : r < 0.8 ? 'corridor' : 'office';
  return r < 0.5 ? 'mansion' : 'corridor';
}
/* 車庫の土間コンクリートの色(リニア。乱数を使わないので、ほかの配置の乱数の並びは変わらない) */
const PAD_COL = new THREE.Color(0x8e8c86);
/* 車の種類。描画の回数をおさえるため、700mのかたまりごとに2種類だけ(となりのかたまりとは組み合わせが変わる) */
const pickCar = (rng, s) => { const k = Math.floor(s / 700); return CAR_TYPES[(k + (rng() < 0.55 ? 0 : 1)) % 3]; };

function buildBuildings(rs, T) {
  const F = rs.frames, step = rs.step, L = rs.line.meta.length;
  /* let: 世田谷のうすい遠景ベルトを置くあいだだけ別の乱数の列に差しかえる(place の中の色・屋上の物の乱数も) */
  let rng = makeRng(12345);
  const lists = { mansion: [], corridor: [], office: [], tower: [], zakkyo: [], shop: [] };
  const boxes = T.boxesPre, tanks = [], aos = [];
  T.boxes = boxes; T.aos = aos; T.boxesPre = null;
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
    obbAdd(T, { cx, cz, axx, axz, azx, azz, hx, hz });
    const D = FACADE[type];
    const base0 = fr.y - 0.5 - 0.6;
    const floors = Math.max(2, Math.round((h - 0.6 - (shop ? 4.2 : 0)) / D.fh));
    const top = base0 + 0.6 + (shop ? 4.2 : 0) + floors * D.fh + 0.6;
    const pal = PAL[type];
    const it = { x: cx, y: shop ? base0 + 4.2 : base0, z: cz, yaw, sx: hx * 2, sz: hz * 2, sy: top - (shop ? base0 + 4.2 : base0), s, sh };
    paint(it, pick(pal, rng), 0.05, rng);
    lists[type].push(it);
    /* 線路側の面の外向き(ローカル+x が「左」なので、左側の建物は -x の面が線路を向く) */
    const fx = -side * axx, fz = -side * axz;
    if (shop) {
      const sp = { x: cx, y: base0, z: cz, yaw, sx: hx * 2 + 0.02, sz: hz * 2 + 0.02, sy: 4.8, s, sh };
      paint(sp, pick(PAL.shop, rng), 0.04, rng);
      lists.shop.push(sp);
      /* 看板: 店先の絵の「看板パネル」(4.8mおき・高さ4.37m)にぴったり重ねる。4分の1は無地のまま。
       * 面の u は (.5 - 法線の向き×ローカルz)×長さ なので、パネルの中心 u=4.8k+2.4 からローカルzを逆算 */
      const len = hz * 2 + 0.02;
      const nb = Math.floor(len / 4.8 + 0.05);
      for (let k = 0; k < nb; k++) {
        if (rng() < 0.25) continue;
        const lz = -side * (len / 2 - (4.8 * k + 2.4));
        const o = hx + 0.01 + 0.03;
        T.signs.push({ kind: 'fascia', s, x: cx + fx * o + azx * lz, y: base0 + 4.37, z: cz + fz * o + azz * lz, fx, fz, w: 4.4, h: 0.66, d: 0.06, cell: Math.floor(rng() * SIGN_WORDS.length) });
      }
      /* 駅前の雑居ビルは袖看板(縦長)を角に1〜2枚(高さ5〜7.6m) */
      if (type === 'zakkyo' && T.nearSt(s) > 0.35) {
        const nbl = rng() < 0.4 ? 2 : 1;
        for (let k = 0; k < nbl; k++) {
          const lz = (k === 0 ? 1 : -1) * (hz - 0.7);
          const o = hx + 0.02 + 0.3;
          T.signs.push({ kind: 'blade', s, x: cx + fx * o + azx * lz, y: base0 + 0.6 + 6.3, z: cz + fz * o + azz * lz, fx, fz, w: 0.6, h: 2.6, d: 0.18, cell: Math.floor(rng() * SIGN_WORDS.length) });
        }
      }
    }
    /* 線路側に張り出したバルコニー(床スラブ+コンクリートの手すり壁を1つの箱で)。日なたで横すじの影ができる。
     * 中・高画質の近くのマンションだけ。小物と同じ白い箱のインスタンス(描画は増えない)。道路・柵にはみ出す所は付けない */
    if ((type === 'mansion' || type === 'corridor') && !far && lat < 55 && qk >= 0.75) {
      const road = T.roadAt(side, s);
      if (lat - hx - 1.2 >= (road ? road.clear : T.fence(side, s) + 1.5)) {
        const len = hz * 2 - 0.3;
        const sr = Math.min(1, it.r * 1.05), sg = Math.min(1, it.g * 1.05), sb = Math.min(1, it.b * 1.05);
        for (let k = 1; k < floors; k++) {
          const yk = it.y + 0.6 + k * D.fh;
          boxes.push({ x: cx + fx * (hx + 0.575), y: yk - 0.18, z: cz + fz * (hx + 0.575), yaw, sx: 1.15, sy: 1.16, sz: len, s, sh, r: sr, g: sg, b: sb });
        }
      }
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
    /* 屋上: 塔屋(75%)・高架水槽(マンション/雑居の35%)・室外機。
     * 塔屋は妻壁と同じ「窓なしの壁」の外壁(マンション・外廊下・雑居)。それ以外は白い箱 */
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
        if (D.side && D.side[0]) lists[type].push(ph);
        else boxes.push(ph);
      }
      if ((type === 'mansion' || type === 'corridor' || type === 'zakkyo') && rng() < 0.35) {
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

  /* 月極(つきぎめ)駐車場: 白線で区切った舗装に4〜8台(バックで入れた車が多い)。s は区画の中心 */
  const placeLot = (s, side, start) => {
    const n = 4 + Math.floor(rng() * 5);
    const len = n * 2.5 + 1.0, dep = 5.6;
    const lat = start + dep / 2 + 0.4;
    sampleFrame(F, step, s, fr);
    const yaw = fr.yaw;
    const axx = Math.cos(yaw), axz = -Math.sin(yaw), azx = Math.sin(yaw), azz = Math.cos(yaw);
    const cx = fr.x + fr.lx * side * lat, cz = fr.z + fr.lz * side * lat;
    if (fpHit(occ, cx, cz, axx, axz, azx, azz, dep / 2, len / 2, 1.0)) return;
    fpStamp(occ, cx, cz, axx, axz, azx, azz, dep / 2, len / 2, SOFT);
    obbAdd(T, { cx, cz, axx, axz, azx, azz, hx: dep / 2, hz: len / 2 });
    const gy = fr.y - 0.5;
    boxes.push(paint({ x: cx, y: gy, z: cz, yaw, sx: dep, sy: 0.08, sz: len, s, sh: false }, 0x6f7173, 0.05, rng));
    for (let k = 0; k <= n; k++) {
      const lz = -len / 2 + 0.5 + k * 2.5;
      boxes.push({ x: cx + azx * lz + axx * side * 0.3, y: gy, z: cz + azz * lz + axz * side * 0.3, yaw, sx: dep * 0.78, sy: 0.1, sz: 0.1, s, sh: false, r: 0.62, g: 0.62, b: 0.6 });
    }
    /* 前を道路(線路側)に向けてバックで入れた車が7割 */
    const back = rng() < 0.7;
    const dx = (back ? -side : side) * axx, dz = (back ? -side : side) * axz;
    const cyaw = Math.atan2(dx, dz);
    for (let k = 0; k < n; k++) {
      if (rng() < 0.25) continue;
      const lz = -len / 2 + 0.5 + (k + 0.5) * 2.5;
      const sp = { x: cx + azx * lz, y: gy + 0.08, z: cz + azz * lz, yaw: cyaw + (rng() - 0.5) * 0.05, type: pickCar(rng, s), s, sh: false };
      T.cars.push(carPaint(sp, pick(CAR_PAINTS, rng), rng));
      /* 車の下の接地影(止めてある車は太陽の影を落とさない: 影の描画を増やさないため。かわりにこれで地面になじませる) */
      aos.push({ x: sp.x, y: sp.y + 0.02, z: sp.z, yaw: sp.yaw, sx: CAR_WID[sp.type] + 0.5, sy: 1, sz: CAR_LEN[sp.type] + 0.4, s });
    }
  };

  /* 行(線路と平行な街区の列)ごとに、線路方向へ建物を並べる */
  for (const side of [1, -1]) {
    for (let row = 0; row < 6; row++) {
      let s = 30 + rng() * 20;
      while (s < L - 40) {
        const kind = T.kindAt(s);
        const near = T.nearSt(s);
        /* 世田谷の低層住宅地: 列は少なく、まばらで低い(大きな駅の前だけ3列) */
        const low = T.lowRise(s);
        /* 丘陵の乗りかえ駅(新百合ヶ丘・向ヶ丘遊園など)の前は4列の駅前の街 */
        const hub = kind === 3 && T.nearHub(s) > 0.5;
        const nRows = hub ? 4 : low ? 1 + (T.nearBig(s) > 0.5 ? 2 : near > 0.5 ? 1 : 0)
          : kind === 0 ? 5 : kind === 1 ? 4 + (near > 0.5 ? 1 : 0) : kind === 2 ? 1 + (near > 0.35 ? 1 : 0) + (near > 0.6 ? 1 : 0) : 1;
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
        const fill = hub ? 0.85 : low ? 0.2 + 0.3 * near : kind === 0 ? 0.92 : kind === 1 ? 0.78 : kind === 2 ? 0.32 + 0.45 * near : 0.05;
        const skipP = (1 - fill) * (1 - (low ? 0.35 : 0.7) * near);
        const sMid = s + (w / 2) / ratio;
        if (rng() > skipP && rng() < qk + (row === 0 ? 0.25 : 0)) {
          let h;
          if (hub) {
            /* 駅前の街: 4〜10階(マンション・雑居ビル) */
            h = 12 + rng() * 20;
          } else if (low) {
            /* 3〜5階が中心。大きな駅の前だけ6〜8階 */
            const nbg = T.nearBig(sMid);
            h = (7 + rng() * 7) * (1 + 0.5 * near + 0.6 * nbg);
            h = Math.min(h, nbg > 0.5 ? 25 : 16);
          } else {
            if (kind === 0) h = Math.abs(sMid - T.sShinjuku) < 1100 ? 22 + rng() * 95 : 25 + rng() * 35;
            else if (kind === 1) h = 8 + rng() * 16;
            else h = 9 + rng() * 6;
            /* 線路ぎわの市街地は高さがまちまち(2〜3階の低い建物もまぜる。上空から線路が見通せる) */
            if (kind <= 1 && lat < 45 && rng() < 0.4 - 0.3 * near) h = 7 + rng() * 5;
            if (kind === 1 || kind === 2) h *= 1 + 1.5 * near;
            if (kind === 1 && lat < 30) h = Math.min(h, 18);
            /* 線路ぎわは中層の谷(超高層は80mより外) */
            if (kind === 0) h = Math.min(h, lat < 45 ? 24 : lat < 80 ? 42 : 999);
          }
          /* 駅前の街: 線路ぎわの2列は店の入った雑居ビルとマンション、奥はマンション(外壁の種類をふやしすぎない=描画の回数) */
          const type = hub ? (row <= 1 ? (rng() < 0.6 ? 'zakkyo' : 'mansion') : (rng() < 0.55 ? 'mansion' : 'corridor')) : pickType(kind, h, rng);
          const D = FACADE[type];
          w = Math.max(2, Math.round(w / D.bay)) * D.bay;
          d = Math.max(2, Math.round(d / D.bay)) * D.bay;
          const shop = row <= 1 && (near > 0.35 || (kind <= 1 && row === 0 && rng() < (type === 'zakkyo' ? 0.6 : type === 'office' ? 0.3 : 0.15)));
          const yaw = fr.yaw + (rng() - 0.5) * 0.06;
          place(sMid, side, lat, w, d, yaw, type, h, shop, lat < 80, false);
        } else if (row <= 1 && rng() < (low ? 0.05 : kind === 3 ? 0.03 : 0.25) * qk) {
          /* 空いた区画のいくつかは月極駐車場 */
          placeLot(sMid, side, start);
        }
        s += (w + gap) / ratio;
      }
    }
  }
  /* 遠景ベルト(市街地のみ、150〜420m帯に大きめの箱。向きは400mごとにそろえる)。
   * 世田谷の低層住宅地は、大きな駅の前だけ低めに近く。ほかは うすいベルト(12m以下・3分の1・260〜420m。
   * 家の屋根の海に中層の箱が ところどころ見えるくらい。選ぶ乱数は別の列で、place の中の乱数も その列にする:
   * もとの列を1つでも多く使うと、あとの遠景の箱がずれ、奥の列の家(140〜170m)とぶつかる所が変わって
   * 家の乱数が全線でずれる(線路ぎわの家並みが いれかわる))。
   * 420mより外へ広げると、外壁の かたまり(800m)の外接球が半径600mをこえて「遠くても描く」あつかいになり
   * (scene.js _registerCells)、描画がふえるので広げない。うすいベルトはカーブの内側では地面が届く所まで(farLatMax)。
   * いままでのベルトの位置は変えない(縮めると線路ぎわの家の列にかかり、家の並びが全線でずれるため) */
  const rngB = makeRng(12345 + 77);
  for (let s = 60; s < L - 60; s += 55) {
    const kind = T.kindAt(s);
    if (kind > 1 || T.inRiver(s, 150)) continue;
    const low = T.lowRise(s);
    const thin = low && T.nearBig(s) < 0.4;
    sampleFrame(F, step, Math.round(s / 400) * 400, fr2);
    const yawB = fr2.yaw;
    for (const side of [1, -1]) {
      const nB = kind === 0 ? 2 : 1;
      const lm = thin ? farLatMax(rs, s, side) : 1e9;
      for (let bi = 0; bi < nB; bi++) {
        if (thin) {
          if (rngB() > 0.33 || rngB() > qk + 0.2) continue;
          const lat = Math.min(lm, 260 + rngB() * 160);
          if (lat < 250) continue;
          const h = 7 + rngB() * 5;
          const keepRng = rng;
          rng = rngB;
          place(s + rngB() * 30, side, lat, 18 + rngB() * 20, 14 + rngB() * 14, yawB + (rngB() - 0.5) * 0.06, pickType(1, h, rngB), h, false, false, true);
          rng = keepRng;
          continue;
        }
        if (rng() < 0.3 || rng() > qk + 0.2) continue;
        const lat = low ? 150 + rng() * 110 : 150 + rng() * 270;
        const h = low ? Math.min(18, 10 + rng() * 20) : kind === 0 ? 25 + rng() * 60 : 10 + rng() * 20;
        const type = kind === 0 ? (rng() < 0.6 ? 'office' : 'zakkyo') : pickType(1, h, rng);
        place(s + rng() * 30, side, lat, 18 + rng() * 26, 16 + rng() * 22, yawB + (rng() - 0.5) * 0.06, type, h, false, false, true);
      }
    }
  }

  /* --- メッシュ化 --- */
  const g = T.groups.town;
  const M = T.M;
  const geo = geoUnitBoxOpen();
  /* 外壁は800mごと(箱は12三角形なので、かたまりを大きくして描画の回数を減らす) */
  Object.keys(lists).forEach((k) => { if (lists[k].length) emitInstanced(g, geo, M[k], lists[k], 800, { shadow: true, cull: true }); });
  /* 高架水槽は遠くでは見えないので近いかたまりだけ */
  if (tanks.length) emitInstanced(g, geoTank(), M.tank, tanks, 700, { colors: false }).forEach((m) => nearOnly(T, m, 500));
  T.bldCount = Object.values(lists).reduce((a, l) => a + l.length, 0);
}

/* ---------- 戸建て(世田谷・多摩の住宅地) ---------- */
/* 壁: 白っぽい7色(2倍の重み)+濃いサイディング・青みの灰・木の色(あわせて約2割) */
const WALLS = [0xece8df, 0xddd6c8, 0xcfc6b4, 0xbdb6aa, 0x8e8a83, 0xe4dccd, 0xc8b9a1, 0xece8df, 0xddd6c8, 0xcfc6b4, 0xbdb6aa, 0x8e8a83, 0xe4dccd, 0xc8b9a1,
  0x3d4046, 0x9fb0b8, 0x9a836c];
/* 屋根: 濃い灰・茶(2倍の重み)+紺・こげ茶・緑・赤茶(あわせて約3分の1)。上から見て色がまざる */
const ROOFS = [0x3a3d41, 0x46423e, 0x2e3236, 0x574a3f, 0x474e56, 0x62564a, 0x3a3d41, 0x46423e, 0x2e3236, 0x574a3f, 0x474e56, 0x62564a,
  0x2f4a66, 0x6e4634, 0x55634f, 0x8b5a42, 0x2f4a66, 0x6e4634];
/* 色の明るさ(リニア。0x3d4046 のような濃いサイディングは .05 ほど) */
const lumLin = (hex) => { _c.setHex(hex); return 0.2126 * _c.r + 0.7152 * _c.g + 0.0722 * _c.b; };
/* 家の表の向き(+1=線路から遠ざかる向き)。偶数の列は線路(側道)のほう、奇数の列は外の路地のほうを向く */
const fDirOf = (odd) => (odd ? 1 : -1);
/* 敷地の地面: 土間コンクリート45%・砂利30%・芝25%(道路の絵の右半分の色見本) */
const lotUV = (rng) => { const r = rng(); return r < 0.45 ? ROAD_UV.concrete : r < 0.75 ? ROAD_UV.gravel : ROAD_UV.lawn; };
/* 家の表の絵(A/B/C)の選び方。外壁シェーダ(facade.js MAIN_V の fcMod)と同じ計算を float32 で */
const F32 = Math.fround, H_A = F32(0.1031), H_B = F32(0.1173);
function houseModule(x, z) {
  const ix = Math.floor(F32(x) * 0.5), iz = Math.floor(F32(z) * 0.5);
  const d = F32(F32(ix * H_A) + F32(iz * H_B));
  return Math.min(2, Math.floor((d - Math.floor(d)) * 3));
}
function buildHouses(rs, T) {
  const F = rs.frames, step = rs.step, L = rs.line.meta.length;
  const rng = makeRng(9753);
  /* あとから足した物(陸屋根の仕上げ・自販機)は別の乱数の列で(いままでの家の並びを変えない) */
  const rngF = makeRng(9753 + 101), rngV = makeRng(9753 + 202);
  const occ = rs._occ;
  const gable = [], flat = [], roofs = [];
  const porch = [], farHouses = [];
  const boxes = T.boxes, aos = T.aos;
  const fr = FR(), fr2 = FR();
  const qk = T.q;
  const stamps = [];
  const NROW = T.farRows ? 13 : 9;
  const sts = rs.line.stations;

  /* --- 路地(幅4.5m): 2列ごとの家のあいだ。交差道路とは T字にぶつかる(道路の縁で止める)。
   * ビル・駐車場・雑木林・駅などの上は通さない。家の列は路地にかからない位置に並ぶので、
   * 占有(3mマス)に書くのは家を置いたあと(先に書くと、マスの粗さで路地のとなりの家まで置けなくなる) --- */
  const lanePts = [];
  for (const side of [1, -1]) {
    const cs = rs._crossStreets.filter((c) => c.side === side);
    /* 5mおき + 交差道路の両側の縁と中心(中心の点は かならず「通さない」になるので、
     * 5mおきの点が道の上に1つもないときでも、路地の帯が交差道路の上にかからない: 同じ高さの面が重なってちらつく) */
    const list = [];
    for (let s = 20; s < L - 30; s += 5) list.push(s);
    cs.forEach((c) => { list.push(c.s - 2.25, c.s, c.s + 2.25); });
    list.sort((a, b) => a - b);
    for (let k = 1; k <= 6; k++) {
      let run = [];
      const flush = () => {
        if (run.length >= 2) lanePts.push({ side, pts: run });
        run = [];
      };
      for (let j = 0; j < list.length; j++) {
        const s = list[j];
        const md = T.maxDAt(s);
        const st = T.houseStart(side, s);
        const l0 = st + 25 * k + 4.5 * (k - 1);
        let ok = md > 0 && st + 29.5 * k <= md + 8.5 && !T.skipS(s) && !T.inRiver(s, 60) && !T.landmarkSkip(side, s);
        /* 交差道路の上は通さない(縁の点はよい)。縁の近くは占有を見ない(交差道路の HARD があるので) */
        let nearX = false;
        for (let i = 0; i < cs.length && ok; i++) {
          const c = cs[i];
          if (l0 + 4.5 < c.a - 1 || l0 > c.b + 1) continue;
          const d = Math.abs(s - c.s);
          if (d < 2.2) ok = false;
          else if (d < 6) nearX = true;
        }
        if (ok) {
          sampleFrame(F, step, s, fr); sampleFrame(F, step, s + 5, fr2);
          const ratio = Math.hypot(fr2.x + fr2.lx * side * l0 - (fr.x + fr.lx * side * l0), fr2.z + fr2.lz * side * l0 - (fr.z + fr.lz * side * l0)) / 5;
          if (ratio < 0.4) ok = false;
          if (ok && !nearX) {
            for (let o = 0.75; o < 4.5; o += 1.5) {
              if (occ.get(okey(fr.x + fr.lx * side * (l0 + o), fr.z + fr.lz * side * (l0 + o))) !== undefined) { ok = false; break; }
            }
          }
        }
        /* 手前の線がずれる所(側道の始まり・終わり)では切る */
        if (ok && run.length && Math.abs(run[run.length - 1].l0 - l0) > 0.3) flush();
        if (ok) run.push({ s, l0 });
        else flush();
      }
      flush();
    }
  }
  lanePts.forEach(({ side, pts }) => {
    let prev = null;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      sampleFrame(F, step, p.s, fr);
      const y = fr.y - 0.41;
      const a = [fr.x + fr.lx * side * p.l0, y, fr.z + fr.lz * side * p.l0];
      const b = [fr.x + fr.lx * side * (p.l0 + 4.5), y, fr.z + fr.lz * side * (p.l0 + 4.5)];
      const cur = { a, b, v: p.s / 20 };
      if (prev) T.quad(T.rb(p.s), prev.a, prev.b, cur.a, cur.b, side > 0 ? 0 : 0.5, side > 0 ? 0.5 : 0, prev.v, cur.v);
      prev = cur;
    }
  });
  T.laneCount = lanePts.length;

  /* --- 家: 列ごとに線路方向へ。偶数の列は線路(側道)のほう、奇数の列は外の路地のほうを向く(背中合わせ) --- */
  for (const side of [1, -1]) {
    for (let row = 0; row < NROW; row++) {
      const odd = row % 2 === 1;
      const farRow = row >= 8;      // 9列目から先は簡単な家(塀・アンテナ・庭木・車・接地影なし。影も落とさない)
      let s = 20 + rng() * 10;
      while (s < L - 30) {
        const kind = T.kindAt(s);
        const maxD = T.maxDAt(s);
        const start = T.houseStart(side, s);
        const jit = ((row * 7 + Math.floor(s / 97)) % 3) * 0.5;   // 列を少しずらして格子に見せない
        const lot0 = start + row * 12.5 + Math.floor(row / 2) * 4.5;
        const front = odd ? lot0 : lot0 + jit;
        const lotEnd = odd ? lot0 + 12.5 - jit : lot0 + 12.5;
        const fits = odd ? lotEnd <= maxD + 4 : front + 8 <= maxD;
        if (!maxD || !fits || T.skipS(s) || T.inRiver(s, 60) || T.landmarkSkip(side, s)) { s += 15; continue; }
        const fw = 8 + rng() * 2.5;              // 間口
        let d = 7 + rng() * 2.5;
        let g = 1.2 + rng() * 1.4;
        /* 車庫(道に面した手前の家: 郊外の3割・市街地の1.5割。ほかは少しだけ): 家を奥へ下げ、手前に頭から入れた車を置く */
        const carP = farRow ? 0 : kind >= 2 ? (row < 3 ? 0.32 : 0.08) : (row < 3 ? 0.16 : 0.03);
        const carType = rng() < carP * qk ? pickCar(rng, s) : null;
        if (carType) g = Math.max(g + 3.6, CAR_LEN[carType] + 0.8);
        if (g + d > 12) d = Math.max(6, 12 - g);
        const lat = odd ? lotEnd - g - d / 2 : front + g + d / 2;
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
        /* ビル・ほかの家と外形が重ならないか(正確な判定) */
        const ob = { cx, cz, axx, axz, azx, azz, hx: d / 2, hz: w / 2 };
        if (obbHit(T, ob, 0.05)) continue;
        obbAdd(T, ob);
        stamps.push([cx, cz, axx, axz, azx, azz, d / 2, w / 2]);
        /* 道の側(表)の縁: 偶数の列は線路の側、奇数の列は外の路地の側 */
        const fDir = odd ? 1 : -1;                    // 表の向き(+1=線路から遠ざかる向き)
        const edgeLat = odd ? lotEnd : front;         // 敷地の表の縁
        /* 車庫の車(左右どちらかに寄せる。前=家の向き) */
        const carZ = carType ? (rng() < 0.5 ? -1 : 1) * (w / 2 - 1.1) : 0;
        if (carType) {
          const clat = edgeLat - fDir * (0.3 + CAR_LEN[carType] / 2);
          const kx = fr.x + fr.lx * side * clat + fr.tx * carZ, kz = fr.z + fr.lz * side * clat + fr.tz * carZ;
          const sp = { x: kx, y: fr.y - 0.45, z: kz, yaw: Math.atan2(-fDir * side * fr.lx, -fDir * side * fr.lz) + (rng() - 0.5) * 0.06, type: carType, s: sMid, sh: false };
          T.cars.push(carPaint(sp, pick(CAR_PAINTS, rng), rng));
          /* 車庫の土間コンクリート(小物の箱なので描画は増えない) */
          boxes.push({ x: kx, y: fr.y - 0.51, z: kz, yaw, sx: CAR_LEN[carType] + 0.9, sy: 0.06, sz: CAR_WID[carType] + 1.0, s: sMid, sh: false, r: PAD_COL.r, g: PAD_COL.g, b: PAD_COL.b });
          aos.push({ x: kx, y: fr.y - 0.425, z: kz, yaw: sp.yaw, sx: CAR_WID[carType] + 0.5, sy: 1, sz: CAR_LEN[carType] + 0.4, s: sMid });
          /* 木や塀が車に重ならないよう、占有にも書く(あとで内側を0.75mけずって書くので大きめに) */
          stamps.push([kx, kz, axx, axz, azx, azz, CAR_LEN[carType] / 2 + 0.75, CAR_WID[carType] / 2 + 0.75]);
        }
        const three = !farRow && rng() < 0.12;
        /* 奥の列は陸屋根(ろくやね)を多めに(三角形の数をおさえる。手前からはほとんど見えない)。
         * 9列目から先は軒のない切妻(壁の形の斜めの面がそのまま屋根: 14三角形・外壁の材質だけで1回の描画) */
        const isGable = farRow ? true : !three && rng() < (lat > 75 ? 0.42 : 0.6) / 0.88;
        const eave = three ? 8.6 : 5.6 + rng() * 0.6;
        const base0 = fr.y - 0.5 - 0.6;
        const sh = !farRow && lat < 45;
        /* 切妻の3割は妻(三角の面)を道に向ける(妻入り)。敷地の形はそのまま */
        const turn = isGable && !farRow && rng() < 0.3;
        /* 奇数の列は表(玄関)を外の路地へ向けるので半回転 */
        const yawH = odd ? yaw + Math.PI : yaw;
        const hy = turn ? yawH + Math.PI / 2 : yawH, hsx = turn ? w : d, hsz = turn ? d : w;
        const it = { x: cx, y: base0, z: cz, yaw: hy, sx: hsx, sz: hsz, sy: isGable ? (eave + 0.6) / EAVE : eave + 0.6 + 0.5, s: sMid, sh };
        let wall = pick(WALLS, rng);
        /* 陸屋根の家は濃いサイディングにしない(日なたの通りに まっ黒な箱が浮いて見える)。選びなおしは別の乱数で */
        for (let k = 0; k < 8 && !isGable && lumLin(wall) < 0.2; k++) wall = pick(WALLS, rngF);
        paint(it, wall, 0.04, rng);
        (farRow ? farHouses : isGable ? gable : flat).push(it);
        if (!isGable && !farRow && row <= 3) {
          /* 陸屋根の家の仕上げ(手前の4列。小物の箱なので描画は増えない): 屋上のふち(笠木のスラブ)と、
           * 3階建ては2階の表にバルコニー(床と手すり壁)。たてどいは外壁の絵にある(三角形をふやさない)。
           * 足した箱は影を落とさない(影を落とす箱のなかった かたまりが影の描画に加わらないように) */
          const top = base0 + it.sy;
          boxes.push(paint({ x: cx, y: top - 0.1, z: cz, yaw: hy, sx: hsx + 0.3, sy: 0.25, sz: hsz + 0.3, s: sMid, sh: false }, 0x6e6f70, 0.05, rngF));
          const nx = fDirOf(odd) * side * fr.lx, nz = fDirOf(odd) * side * fr.lz;   // 表の面の外向き(世界)
          if (three) {
            const yb = base0 + 0.6 + 2.9, bw = hsz - 1.0;
            const sl = paint({ x: cx + nx * (hsx / 2 + 0.5), y: yb, z: cz + nz * (hsx / 2 + 0.5), yaw: hy, sx: 1.0, sy: 0.15, sz: bw, s: sMid, sh: false }, 0x9a9893, 0.04, rngF);
            boxes.push(sl);
            boxes.push({ x: cx + nx * (hsx / 2 + 0.97), y: yb + 0.15, z: cz + nz * (hsx / 2 + 0.97), yaw: hy, sx: 0.06, sy: 1.0, sz: bw, s: sMid, sh: false,
              r: Math.min(1, it.r * 1.06), g: Math.min(1, it.g * 1.06), b: Math.min(1, it.b * 1.06) });
          }
        }
        if (isGable && !farRow) {
          const rf = { x: cx, y: base0, z: cz, yaw: hy, sx: hsx, sz: hsz, sy: it.sy, s: sMid, sh };
          paint(rf, pick(ROOFS, rng), 0.08, rng);
          roofs.push(rf);
        }
        if (farRow) continue;
        aos.push({ x: cx, y: fr.y - 0.46, z: cz, yaw, sx: d + 2.2, sy: 1, sz: w + 2.2, s: sMid });
        /* 敷地の地面(土間・砂利・芝)。家の下から表の縁まで。道路の面と同じ入れ物に入れる(描画は増えない) */
        {
          const pd = d + g + 0.8, hw = (fw - 0.3) / 2;
          const l0 = edgeLat, l1 = edgeLat - fDir * pd, yp = fr.y - 0.47;
          /* 線路の勾配に合わせて傾ける(地面は線路の高さについてくるので、平らな板だと坂の上の側が地面にうまる) */
          sampleFrame(F, step, sMid + 4, fr2);
          const gr = (fr2.y - fr.y) / 4;
          const Q = (o, dt) => [fr.x + fr.lx * side * o + fr.tx * dt, yp + gr * dt, fr.z + fr.lz * side * o + fr.tz * dt];
          const uv = lotUV(rng);
          T.quad(T.rb(sMid), Q(l0, -hw), Q(l0, hw), Q(l1, -hw), Q(l1, hw), uv[0], uv[1], uv[2], uv[3]);
        }
        /* 自動販売機(駅から180m以内の手前4列の家の4分の1・ほかの所は線路に近い2列の家の6%): 敷地の表の縁に2台ならべて、
         * 前の面を道へ向ける(夜は光る)。車庫の車の反対の側。この家は塀を作らず、同じ側の庭木も植えない。別の乱数の列で */
        let vend = 0;
        const vP = row > 3 ? 0 : sts.some((x) => Math.abs(x.s - sMid) < 180) ? 0.25 : row <= 1 ? 0.06 : 0;
        if (vP > 0 && rngV() < vP) {
          vend = carType ? -Math.sign(carZ) : rngV() < 0.5 ? -1 : 1;
          const vz = vend * ((fw - 0.3) / 2 - 1.2), vl = edgeLat - fDir * 0.43;
          const bx0 = fr.x + fr.lx * side * vl + fr.tx * vz, bz0 = fr.z + fr.lz * side * vl + fr.tz * vz;
          const nx = fDir * side * fr.lx, nz = fDir * side * fr.lz;
          for (let k = -1; k <= 1; k += 2) {
            const x = bx0 + fr.tx * k * 0.51, z = bz0 + fr.tz * k * 0.51;
            const v = rngV() < 0.7 ? 0 : 1;
            boxes.push(paint({ x, y: fr.y - 0.5, z, yaw, sx: 0.75, sy: 1.83, sz: 1.0, s: sMid, sh: false }, v ? 0xc9d2da : 0xeceeea, 0.03, rngV));
            T.signs.push({ kind: 'jihanki', s: sMid, x: x + nx * 0.385, y: fr.y - 0.5 + 0.95, z: z + nz * 0.385, fx: nx, fz: nz, w: 0.92, h: 1.6, d: 0, cell: v });
          }
          aos.push({ x: bx0, y: fr.y - 0.46, z: bz0, yaw, sx: 1.4, sy: 1, sz: 2.7, s: sMid });
        }
        /* ブロック塀(手前の6割)。車庫のある家は車の出入り口をあける */
        const flat1 = edgeLat - fDir * 0.15;
        if (lat < 75 && rng() < 0.6) {
          const bo = carType ? -Math.sign(carZ) * (fw / 4) : 0;
          const bx = fr.x + fr.lx * side * flat1 + fr.tx * bo, bz = fr.z + fr.lz * side * flat1 + fr.tz * bo;
          const bw = { x: bx, y: fr.y - 0.55, z: bz, yaw, sx: 0.12, sy: 1.25, sz: carType ? fw / 2 - 0.6 : fw - 0.5, s: sMid, sh: false };
          paint(bw, pick([0xb9b5ab, 0xa9a69e, 0xc4bfb4], rng), 0.05, rng);
          if (!vend) boxes.push(bw);
        }
        /* テレビアンテナ(近くの家の35%) */
        if (lat < 70 && rng() < 0.35) {
          const topY = base0 + it.sy;
          const oz = turn ? 0 : (rng() - 0.5) * w * 0.5;
          const mx = cx + azx * oz, mz = cz + azz * oz;
          const dark = { r: 0.05, g: 0.05, b: 0.055 };
          boxes.push({ x: mx, y: topY - 0.1, z: mz, yaw, sx: 0.04, sy: 1.6, sz: 0.04, s: sMid, sh: false, ...dark });
          boxes.push({ x: mx, y: topY + 1.25, z: mz, yaw, sx: 0.04, sy: 0.04, sz: 1.3, s: sMid, sh: false, ...dark });
          boxes.push({ x: mx, y: topY + 1.0, z: mz, yaw: yaw + 0.8, sx: 0.04, sy: 0.04, sz: 0.9, s: sMid, sh: false, ...dark });
        }
        /* 庭木(手前の家の25%(世田谷は20%)・奥の家は6%) */
        if (rng() < (lat > 60 ? 0.06 : T.lowRise(s) ? 0.2 : 0.25)) {
          const off = flat1 - fDir * 0.9;
          const tz = (carType ? -Math.sign(carZ) : rng() < 0.5 ? -1 : 1) * (w / 2 - 0.4);
          const tree = {
            x: fr.x + fr.lx * side * off + fr.tx * tz, y: fr.y - 0.5, z: fr.z + fr.lz * side * off + fr.tz * tz,
            s: sMid, sc: 0.45 + rng() * 0.15, tint: 0.8 + rng() * 0.3, conifer: rng() < 0.1,
          };
          if (!vend || Math.sign(tz) !== vend) rs._treeQueue.push(tree);
        }
        /* 玄関の明かりが前の地面にこぼれる(線路に近い家の4割・夜だけ)。玄関の位置は外壁の絵(A/B/C)と同じ選び方で */
        if (!turn && lat < 60 && rng() < 0.4) {
          const u = HOUSE_DOOR[houseModule(cx, cz)];
          const pz = (side > 0 ? u - 0.5 : 0.5 - u) * w;
          const nx = fDir * side * fr.lx, nz = fDir * side * fr.lz;   // 表の面の外向き(世界)
          const zx = Math.sin(hy), zz = Math.cos(hy);
          const o = d / 2 + 1.25;
          porch.push({ x: cx + nx * o + zx * pz, y: fr.y - 0.44, z: cz + nz * o + zz * pz, yaw: hy, sx: 2.5, sy: 1, sz: 3.5, s: sMid });
        }
      }
    }
  }
  stamps.forEach((a) => fpStamp(occ, a[0], a[1], a[2], a[3], a[4], a[5], a[6] - 0.75, a[7] - 0.75, SOFT));
  /* 路地を占有に書く(このあと植える木・雑木林が路地にのらないように) */
  lanePts.forEach(({ side, pts }) => {
    for (let i = 1; i < pts.length; i++) stampBand(rs, pts[i - 1].s, pts[i].s, side * (pts[i].l0 + 0.5), side * (pts[i].l0 + 4.0), HARD);
  });
  /* 中低層に混じる3〜5階のマンション(多摩の住宅地にも少しだけ) は buildBuildings で配置済み */
  const g = T.groups.houses;
  const M = T.M;
  if (gable.length) emitInstanced(g, geoGable(), M.house, gable, 500, { shadow: true, cull: true });
  if (flat.length) emitInstanced(g, geoUnitBoxOpen(), M.house, flat, 500, { shadow: true, cull: true });
  if (roofs.length) emitInstanced(g, geoGableRoof(), M.roof, roofs, 500, { shadow: true, cull: true });
  /* 奥の列(9列目から): 遠くの家並み(buildFarBlocks)と同じかたまり(1000m)にまとめて、そちらで出す。影は落とさない */
  const tag = (k) => (m) => { m.userData.p1 = k; return m; };
  T.farHouses = farHouses;
  /* 玄関の光だまり(夜だけ材質を見せる。300mまで) */
  if (porch.length) emitInstanced(g, geoFlat(), M.porchPool, porch, 700, { colors: false, receive: false }).map(tag('porch')).forEach((m) => { m.renderOrder = 2; nearOnly(T, m, 300); });
  /* 屋上の小物・塀・アンテナ(建物ぶんもまとめて)と接地影 */
  /* 屋上の小物・塀: 影は線路から80m以内の塔屋・室外機だけ(並べ替えて影描画のときだけ数を減らす) */
  if (boxes.length) emitInstanced(T.groups.town, geoUnitBox(), M.box, boxes, 500, { shadow: true, cull: true });
  if (aos.length) {
    const ag = new THREE.PlaneGeometry(1, 1); ag.rotateX(-Math.PI / 2);
    emitInstanced(T.groups.town, ag, M.ao, aos, 1000, { colors: false, receive: false, cull: true });
  }
  T.houseCount = gable.length + flat.length + farHouses.length;
  T.boxes = T.aos = null;   // 小物と接地影の表は作るときだけ使う(メモリを返す)
}

/* カーブの内側では地面(trackbed の groundColumnsAt)が曲率半径の0.75倍までしか届かない。
 * 前後40mの向きの変わり方から、その側で家並み・遠景の箱を置いてよい いちばん遠い横の距離(m)を返す */
const _fa = FR(), _fb = FR(), _fc = FR();
function farLatMax(rs, s, side) {
  sampleFrame(rs.frames, rs.step, s - 40, _fa);
  sampleFrame(rs.frames, rs.step, s + 40, _fb);
  sampleFrame(rs.frames, rs.step, s, _fc);
  const dx = _fb.tx - _fa.tx, dz = _fb.tz - _fa.tz;
  const k = Math.hypot(dx, dz) / 80;
  /* 曲がる中心の側(向きの変化と左の向きの内積の符号)だけ制限する */
  if (k < 1e-5 || (dx * _fc.lx + dz * _fc.lz) * side <= 0) return 1e9;
  return 0.75 / k - 25;
}

/* ---------- 遠くの家並み(線路から175〜560m) ----------
 * 家並みの屋根の地面の所(trackbed の rs._roofsAt: 世田谷の低層住宅地・郊外・丘陵の駅の前後500m)に、
 * 2〜3軒つながった切妻の列(遠くの家と同じ形と外壁の材質。シェーダは増えない)を 26m×12m のます目にまばらに置く。
 * 高画質だけ(5割)。中・低画質は置かない: iPad(中)の三角形の予算(世田谷の夕方で +11k)と描画の回数(ゴールで +1)をこえるため。
 * FAR_MID を 0.12 にすると中画質でも丘陵の駅の前後500mだけ置く(世田谷・郊外は数が多いので置かない)。
 * ほかの物の上・川・トンネル・ランドマーク・丘のすそ(半径+20m)はよける。
 * 9列目から先の家(buildHouses の T.farHouses)と同じ1000mのかたまりにまとめて出す(描画はほとんど増えない)。影は落とさない */
const FAR_MID = 0;
function buildFarBlocks(rs, T) {
  const far = T.farHouses || [];
  T.farHouses = null;
  const hiQ = T.q >= 1;
  const keep = hiQ ? 0.5 : T.q >= 0.75 ? FAR_MID : 0;
  if (keep > 0) {
    const F = rs.frames, step = rs.step, L = rs.line.meta.length;
    const rng = makeRng(6171);
    const roofsAt = typeof rs._roofsAt === 'function' ? rs._roofsAt : (s, k) => k === 2 || (k === 1 && T.lowRise(s));
    const plan = hillPlan(rs, T, hillGeos(rs));
    const hills = [];
    plan.lists.forEach((a) => { for (let i = 0; i < a.length; i++) hills.push(a[i]); });
    const inHill = (x, z) => {
      for (let i = 0; i < hills.length; i++) {
        const h = hills[i];
        const dx = x - h.x, dz = z - h.z;
        if (Math.abs(dx) > h.sz * 1.2 + 40 || Math.abs(dz) > h.sz * 1.2 + 40) continue;
        /* 丘のローカル(x: 横 sx・z: 長い向き sz)。回転は yaw(ローカル+z = (sin, cos)) */
        const c = Math.cos(h.yaw), sn = Math.sin(h.yaw);
        const lx = dx * c - dz * sn, lz = dx * sn + dz * c;
        const ax = h.sx * 1.15 + 20, az = h.sz * 1.15 + 20;
        if ((lx * lx) / (ax * ax) + (lz * lz) / (az * az) < 1) return true;
      }
      return false;
    };
    const fr = FR();
    for (let s = 20; s < L - 20; s += 26) {
      const kind = T.kindAt(s);
      if (!roofsAt(s, kind) || (!hiQ && kind !== 3) || T.skipS(s) || T.inRiver(s, 150) || rs._inTunnel(s + 80) || rs._inTunnel(s - 80)) continue;
      for (const side of [1, -1]) {
        if (T.landmarkSkip(side, s)) continue;
        const lm = Math.min(560, farLatMax(rs, s, side));
        for (let lat = 175; lat < lm; lat += 12) {
          if (rng() > keep) continue;
          const ss = s + (rng() - 0.5) * 8, ll = lat + (rng() - 0.5) * 4;
          sampleFrame(F, step, ss, fr);
          const x = fr.x + fr.lx * side * ll, z = fr.z + fr.lz * side * ll;
          const len = 16 + rng() * 8;
          if (!occFree(rs, x, z) || !occFree(rs, x + fr.tx * len * 0.45, z + fr.tz * len * 0.45) ||
            !occFree(rs, x - fr.tx * len * 0.45, z - fr.tz * len * 0.45) || inHill(x, z)) continue;
          const it = { x, y: fr.y - 0.5 - 0.9, z, yaw: fr.yaw + (rng() - 0.5) * 0.1, sx: 8, sz: len, sy: (5.8 + 0.3 + rng() * 0.6) / EAVE, s: ss, sh: false };
          paint(it, pick(WALLS, rng), 0.05, rng);
          far.push(it);
        }
      }
    }
  }
  if (far.length) {
    emitInstanced(T.groups.houses, geoGable(), T.M.house, far, 1000, { shadow: false })
      .forEach((m) => { m.userData.p1 = 'far'; nearOnly(T, m, hiQ ? 1100 : 900); });
  }
}

/* ---------- 遠景: 街並みと丘の稜線のリング + 新宿の高層ビル群(看板) ---------- */
function ringCanvas(kind) {
  const W = kind === 'low' ? 1024 : 2048;
  return canvasOnce('ring-' + kind, W, 256, (c, w, h) => {
    const r = makeRng(kind === 'hills' ? 41 : kind === 'low' ? 23 : 17);
    c.clearRect(0, 0, w, h);
    if (kind === 'hills') {
      const layers = [['#93a39a', 0.45, 120, 40], ['#748a74', 0.7, 92, 34], ['#57704f', 0.9, 66, 26]];
      layers.forEach(([col, a, base, amp]) => {
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
      });
      c.globalAlpha = 1;
      return;
    }
    if (kind === 'low') {
      /* 低い街並み(世田谷・多摩の住宅地の向こう): 背の低い箱がまばらに。高層の塔はない */
      [['#a3afba', 0.3, 6, 16], ['#8b97a2', 0.5, 8, 20], ['#77828c', 0.7, 6, 24]].forEach(([col, a, h0, h1], li) => {
        let x = 0;
        while (x < w) {
          const bw = 5 + r() * 16;
          if (x + bw > w) break;
          if (r() < 0.3) { x += bw; continue; }   // すき間
          const bh = h0 + r() * (h1 - h0);
          c.globalAlpha = a; c.fillStyle = col;
          c.fillRect(x, h - 60 + li * 18 - bh, bw, bh + 60);
          x += bw + (r() < 0.3 ? r() * 8 : 0);
        }
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
/* 新宿の高層ビル群の看板(512x256)。昼と夜は同じ塔の形(同じ乱数)。夜は暗い塔に窓の灯りの点と赤い航空障害灯 */
let SJ_TOWERS = null;
function sjTowers() {
  if (SJ_TOWERS) return SJ_TOWERS;
  const r = makeRng(1964);
  /* 12本の高層ビル(屋上の形がそれぞれちがう)。座標は 1024x512 の大きさで決めて、半分に縮めて描く */
  const towers = [];
  for (let i = 0; i < 12; i++) towers.push({ x: 60 + i * 76 + (r() - 0.5) * 30, w: 40 + r() * 40, h: 150 + r() * 170, crown: i % 4 });
  towers.sort((a, b) => a.h - b.h);
  SJ_TOWERS = towers;
  return towers;
}
function shinjukuCanvas(kind) {
  const night = kind === 'night';
  return canvasOnce('shinjuku-' + kind, 512, 256, (c, w, h) => {
    const towers = sjTowers();
    c.clearRect(0, 0, w, h);
    const base = 512 - 20;
    const crownPath = (t, top) => {
      c.beginPath();
      if (t.crown === 0) { c.fillRect(t.x + t.w * 0.2, top - 26, t.w * 0.6, 26); c.fillRect(t.x + t.w * 0.38, top - 44, t.w * 0.24, 18); }   // 段々
      else if (t.crown === 1) { c.fillRect(t.x + 2, top - 30, t.w * 0.35, 30); c.fillRect(t.x + t.w * 0.63, top - 30, t.w * 0.35, 30); } // 双塔
      else if (t.crown === 2) { c.moveTo(t.x + t.w / 2 - 2, top - 70); c.lineTo(t.x + t.w / 2 + 2, top - 70); c.lineTo(t.x + t.w * 0.8, top); c.lineTo(t.x + t.w * 0.2, top); c.fill(); } // 尖塔
      else { c.moveTo(t.x, top); c.lineTo(t.x + t.w, top); c.lineTo(t.x + t.w, top - 18); c.lineTo(t.x, top - 4); c.fill(); }  // 斜め屋根
    };
    /* いちばん高い所(航空障害灯の位置。1024x512 の座標) */
    const crownTop = (t, top) => (t.crown === 0 ? top - 44 : t.crown === 1 ? top - 30 : t.crown === 2 ? top - 70 : top - 18);
    c.save();
    c.scale(0.5, 0.5);
    towers.forEach((t, i) => {
      const top = base - t.h;
      if (night) {
        c.globalAlpha = 1;
        c.fillStyle = '#121820';
      } else {
        c.globalAlpha = 0.78 + 0.22 * (i / 12);
        c.fillStyle = i % 2 ? '#6d7b88' : '#7f8c98';
      }
      c.fillRect(t.x, top, t.w, t.h + 20);
      crownPath(t, top);
      if (!night) {
        c.globalAlpha = 0.16; c.fillStyle = '#ffffff';
        for (let y = top + 6; y < base; y += 7) c.fillRect(t.x + 3, y, t.w - 6, 1);
        c.globalAlpha = 0.12; c.fillStyle = '#000000';
        c.fillRect(t.x + t.w * 0.7, top, t.w * 0.3, t.h + 20);   // 影になる側面
      }
    });
    c.restore();
    c.globalAlpha = 1;
    if (night) {
      /* 窓の灯り: 3x4 画素のます目の約15%に点(塔の中だけ。手前の塔が奥の塔をかくすので、塔ごとに上から描き直す) */
      const r = makeRng(77);
      towers.forEach((t) => {
        const x0 = Math.ceil(t.x * 0.5) + 1, x1 = Math.floor((t.x + t.w) * 0.5) - 1;
        const y0 = Math.ceil((base - t.h) * 0.5) + 2, y1 = Math.floor(base * 0.5);
        c.fillStyle = '#ffd9a0';
        for (let y = y0; y < y1; y += 4) {
          for (let x = x0; x < x1; x += 3) {
            if (r() < 0.15) { c.globalAlpha = 0.55 * (0.6 + 0.4 * r()); c.fillRect(x, y, 2, 2); }
          }
        }
      });
      /* 航空障害灯(赤): 屋上のいちばん高い所と、高い塔は中ほどにも */
      c.globalAlpha = 1;
      c.fillStyle = '#ff3a2a';
      towers.forEach((t) => {
        const top = base - t.h;
        const cx = Math.round((t.x + t.w / 2) * 0.5);
        c.fillRect(cx - 1, Math.round(crownTop(t, top) * 0.5) - 1, 2, 2);
        if (t.crown !== 2) { c.fillRect(Math.round(t.x * 0.5) + 1, Math.round(top * 0.5) - 1, 2, 2); c.fillRect(Math.round((t.x + t.w) * 0.5) - 3, Math.round(top * 0.5) - 1, 2, 2); }
        if (t.h > 250) c.fillRect(Math.round(t.x * 0.5) + 1, Math.round((top + t.h * 0.5) * 0.5), 2, 2);
      });
    }
  });
}
function buildSkyline(rs, T) {
  const g = T.groups.skyline;
  const M = materials(rs);
  if (!M.ringCity) {
    const mk = (cv, rep) => { const t = texFrom(cv); t.repeat.set(rep, 1); t.wrapT = THREE.ClampToEdgeWrapping; return t; };
    const keep = (m) => { rs._keep.add(m); return m; };
    M.ringTex = { city: mk(ringCanvas('city'), 3), night: mk(ringCanvas('night'), 3), hills: mk(ringCanvas('hills'), 3), low: mk(ringCanvas('low'), 6) };
    Object.values(M.ringTex).forEach((t) => rs._keep.add(t));
    const rm = (map) => keep(new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, fog: false, side: THREE.BackSide }));
    M.ringCity = rm(M.ringTex.city);
    M.ringHills = rm(M.ringTex.hills);
    M.sjDay = texFrom(shinjukuCanvas('day'), true, false);
    M.sjNight = texFrom(shinjukuCanvas('night'), true, false);
    rs._keep.add(M.sjDay); rs._keep.add(M.sjNight);
    M.billboard = keep(new THREE.MeshBasicMaterial({ map: M.sjDay, transparent: true, depthWrite: false, fog: false }));
  }
  if (!GEO.ring) { GEO.ring = new THREE.CylinderGeometry(1, 1, 1, 96, 1, true); GEO.ring.translate(0, 0.5, 0); }
  if (!GEO.board) GEO.board = new THREE.PlaneGeometry(700, 320);
  const hills = new THREE.Mesh(GEO.ring, M.ringHills);
  const city = new THREE.Mesh(GEO.ring, M.ringCity);
  const board = new THREE.Mesh(GEO.board, M.billboard);
  /* 毎フレーム視点について動く(行列の更新を止めない)。遠くでも消さない */
  [hills, city, board].forEach((m, i) => { m.frustumCulled = false; m.userData.noMerge = true; m.userData.dyn = true; m.userData.keepFar = true; m.renderOrder = -3 + i; g.add(m); });
  T.ringHills = hills; T.ringCity = city; T.board = board;
  /* 区間の種類 → リングの濃さ(±400mでならす)。世田谷の低層住宅地は街のリングをうすく、丘を少し濃く */
  const L = rs.line.meta.length, n = Math.ceil(L / 20) + 1;
  const cityK = [1, 1, 0.7, 0.25], hillK = [0, 0.15, 0.55, 1];
  const rawC = (s) => cityK[T.kindAt(s)] * (T.lowRise(s) ? 0.4 : 1);
  const rawH = (s) => hillK[T.kindAt(s)] + (T.lowRise(s) ? 0.15 : 0);
  T.cityOp = new Float32Array(n); T.hillOp = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let a = 0, b = 0, c = 0;
    for (let ds = -400; ds <= 400; ds += 40) { const s = clamp(i * 20 + ds, 0, L); a += rawC(s); b += rawH(s); c++; }
    T.cityOp[i] = a / c; T.hillOp[i] = Math.min(1, b / c);
  }
  const sj = rs.line.stations.find((x) => x.name === '新宿');
  if (sj) { const f = FR(); sampleFrame(rs.frames, rs.step, sj.s, f); T.sjX = f.x; T.sjZ = f.z; } else T.sjX = null;
}

/* 駅舎の本体(全駅ぶんを1つのインスタンスに。外壁はオフィスのガラス連窓) */
export function stationBodiesP1(rs, list) {
  if (!list.length) return;
  const M = materials(rs);
  const rng = makeRng(555);
  const g = rs._town ? rs._town.groups.town : rs.world;
  const items = list.map((b) => paint({ ...b, s: 0, sh: true }, pick([0xe4e2dc, 0xd9dcdf, 0xcfc9bd], rng), 0.03, rng));
  /* 駅の上の橋上駅舎(P2)は下から見えるので、底のある箱のまま */
  emitInstanced(g, geoUnitBox(), M.office, items, () => 0, { shadow: true });
}

/* =========================================================
 * 木(広葉樹2種+針葉樹)。幹は葉と1つの形にまとめ、遠いかたまりは軽い形に差し替える
 * ========================================================= */
export function makeTreeGeosP1() {
  const rnd = makeRng(31);
  /* 遠景用の葉のかたまり(いままでどおり: ハッシュで少しでこぼこにした球) */
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
  /* 近景用の小さな葉のかたまり: 単位球の上のゆるい3次元の波で 0.7〜1.3倍にふくらませてから大きさをかける。
   * 法線は樹冠全体の中心からの向きを強くまぜる(かたまりの集まりが1つの丸い樹冠として やわらかい陰影になる)。
   * UV は樹冠の中心からの球の座標(u=方位×3, v=高さ/1.6): 葉の模様がかたまりの面の向きで切れずに樹冠全体へ流れる。
   * かたまりは八面体の分割1(32三角形)。高画質だけ上の4つを分割2(72三角形)にする */
  const lump = (sp, detail, cx, cy, cz) => {
    const { r, x, y, z, a, b, c } = sp;
    const g = new THREE.OctahedronGeometry(1, detail);
    const p = g.attributes.position;
    const nr = new Float32Array(p.count * 3), uv = new Float32Array(p.count * 2);
    let ox = x - cx, oy = y - cy, oz = z - cz;
    const ol = Math.hypot(ox, oy, oz) || 1;
    ox /= ol; oy /= ol; oz /= ol;
    for (let i = 0; i < p.count; i++) {
      const nx = p.getX(i), ny = p.getY(i), nz = p.getZ(i);
      const k = clamp(1 + 0.3 * (0.6 * Math.sin(2.3 * nx + a) * Math.sin(2.1 * ny + b) + 0.5 * Math.sin(3.1 * nz + c)), 0.7, 1.3);
      const px = x + nx * k * r, py = y + ny * k * r, pz = z + nz * k * r;
      p.setXYZ(i, px, py, pz);
      let mx = nx + ox * 1.2, my = ny + oy * 1.2, mz = nz + oz * 1.2;
      const ml = Math.hypot(mx, my, mz) || 1;
      nr[i * 3] = mx / ml; nr[i * 3 + 1] = my / ml; nr[i * 3 + 2] = mz / ml;
      uv[i * 2] = (Math.atan2(pz - cz, px - cx) / (2 * Math.PI)) * 3;
      uv[i * 2 + 1] = (py - cy) / 1.6;
    }
    /* 方位の切れ目(u が ±1.5 で とぶ所)をまたぐ三角形は、負の側に 3(模様3枚ぶん=同じ模様)を足してつなぐ */
    for (let t = 0; t + 2 < p.count; t += 3) {
      const u0 = uv[t * 2], u1 = uv[t * 2 + 2], u2 = uv[t * 2 + 4];
      if (Math.max(u0, u1, u2) - Math.min(u0, u1, u2) > 1.5) {
        for (let j = 0; j < 3; j++) if (uv[(t + j) * 2] < 0) uv[(t + j) * 2] += 3;
      }
    }
    g.setAttribute('normal', new THREE.BufferAttribute(nr, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    return g;
  };
  /* 樹冠の設計図: 芯のかたまり1つ + だ円の殻の上に7〜9個(上の外側の4つは大きめ)。ex,ey,ez: 殻の半径。
   * 形(位置・大きさ・ゆらぎ)は1回だけ決めて、中画質用と高画質用の2つの細かさで同じ形を作る */
  const lumpSpec = (r, x, y, z) => ({ r, x, y, z, a: rnd() * 6.28, b: rnd() * 6.28, c: rnd() * 6.28 });
  const crownSpec = (cx, cy, cz, ex, ey, ez, n) => {
    const parts = [lumpSpec(Math.min(ex, ey, ez) * 0.85, cx, cy, cz)];
    for (let i = 0; i < n; i++) {
      const up = i < 4;
      const az = (i / (up ? 4 : n - 4)) * Math.PI * 2 + (up ? Math.PI / 4 : 0) + (rnd() - 0.5) * 0.5;
      const el = up ? 0.55 + (rnd() - 0.5) * 0.3 : -0.15 + (rnd() - 0.5) * 0.4;
      const j = 0.85 + rnd() * 0.3;
      const x = cx + Math.cos(az) * Math.cos(el) * ex * j, y = cy + Math.sin(el) * ey * j, z = cz + Math.sin(az) * Math.cos(el) * ez * j;
      parts.push(lumpSpec(up ? 0.75 + rnd() * 0.25 : 0.5 + rnd() * 0.3, x, y, z));
    }
    return { cx, cy, cz, parts };
  };
  /* hiQ: 高画質(上の4つだけ分割2)。芯(0番)はまわりのかたまりに かくれるので いちばん粗く(8三角形) */
  const crown = (spec, hiQ) => spec.parts.map((sp, i) => lump(sp, i === 0 ? 0 : hiQ && i >= 1 && i <= 4 ? 2 : 1, spec.cx, spec.cy, spec.cz));
  /* 頂点色: 下ほど暗い(樹冠の下側は かげで沈む。幹は「2+色」= 固定色のフラグ) */
  const shade = (g, y0, y1) => {
    const p = g.attributes.position;
    const c = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const t = clamp((p.getY(i) - y0) / (y1 - y0), 0, 1);
      const v = Math.pow(0.45 + 0.6 * t, 2.2);
      c[i * 3] = v; c[i * 3 + 1] = v; c[i * 3 + 2] = v;
    }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return g;
  };
  const tc = srgbLin(0x584736).map((v) => v + 2);
  const trunk = () => { const t = new THREE.CylinderGeometry(0.13, 0.2, 2.9, 6); t.translate(0, 1.45, 0); return { g: t, col: tc }; };
  const trunkC = () => { const t = new THREE.CylinderGeometry(0.1, 0.16, 2.0, 5); t.translate(0, 1.0, 0); return { g: t, col: tc }; };
  /* 遠景用: いままでの大きい葉のかたまり(粗い) */
  const broad = (spec, detail) => spec.map(([r, x, y, z, sy], i) => ({ g: shade(blob(r, x, y, z, sy || 1.15, i < 3 ? detail : 0), 2.2, 5.5) }));
  const A = [[1.55, 0, 3.7, 0], [1.1, 0.95, 3.1, 0.35], [1.0, -0.85, 3.25, -0.3], [0.9, 0.1, 4.6, -0.5]];
  const B = [[1.25, 0, 3.3, 0, 1.3], [1.15, 0.2, 4.4, 0.2, 1.2], [0.85, -0.7, 3.0, 0.5], [0.8, 0.75, 3.6, -0.55]];
  /* 杉(すぎ): 細長い円すい1つ。輪ごとに半径を少しゆらし、1つおきの輪を15%外へ出して 枝の段を作る(紙のクリスマスツリーにしない)。
   * 輪の半径は (先からの割合)^0.7 にふくらませて、先を丸みのある細い円すいにする(まっすぐな円すいだと、夕方の空に
   * 細い塔のような とがった影になる)。先の2つの輪は ゆらさない(先が針のように折れて見えないように)。
   * 先は少しだけ横へずらす。葉のかたまりを外に足すと こぶに見えるので足さない。hash: 輪と頂点の番号から決まる 0..1 */
  const hash2 = (i, k) => { const h = Math.sin(i * 127.1 + k * 311.7 + 17.3) * 43758.5453; return h - Math.floor(h); };
  const sugiCone = (r, h, seg, rows, y, open) => {
    const g = new THREE.ConeGeometry(r, h, seg, rows, open);
    const p = g.attributes.position;
    const ax = (rnd() - 0.5) * 0.16, az = (rnd() - 0.5) * 0.16;
    /* 頂点は 上(先)の輪から順に (seg+1) 個ずつ(最後は継ぎ目の重複)。ふたの頂点は輪の後ろ */
    const side = (rows + 1) * (seg + 1);
    const top = h / 2;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), yy = p.getY(i), z = p.getZ(i);
      if (Math.abs(yy - top) < 1e-4) { p.setXYZ(i, x + ax, yy, z + az); continue; }
      const iy = i < side ? Math.floor(i / (seg + 1)) : rows;
      const ix = i < side ? (i % (seg + 1)) % seg : Math.round(((Math.atan2(z, x) / (2 * Math.PI)) * seg + seg) % seg) % seg;
      const t = iy / rows;
      const prof = Math.pow(t, -0.3);
      const k = iy <= 2 && rows > 2 ? prof : prof * (0.88 + 0.24 * hash2(iy, ix)) * (iy % 2 === 1 ? 1.15 : 1);
      p.setXYZ(i, x * k, yy, z * k);
    }
    g.translate(0, y, 0);
    g.computeVertexNormals();
    return g;
  };
  const sugi = () => [{ g: shade(sugiCone(1.3, 6.6, 8, 7, 3.55, true), 0.3, 6.9) }];
  /* 近景用: 広がった樹冠(A)と、背の高い樹冠(B) */
  const sA = crownSpec(0, 3.75, 0, 1.45, 1.15, 1.4, 8), sB = crownSpec(0, 3.95, 0, 1.15, 1.55, 1.15, 9);
  const crowns = (hiQ) => [
    mergeParts([...crown(sA, hiQ).map((g) => ({ g: shade(g, 2.2, 5.5) })), trunk()]),
    mergeParts([...crown(sB, hiQ).map((g) => ({ g: shade(g, 2.2, 5.8) })), trunk()]),
  ];
  const conifer = mergeParts([...sugi(), trunkC()]);
  const hi = crowns(false).concat([conifer]);
  /* 高画質だけの近景(上の4つのかたまりが細かい)。杉は同じ形を使う */
  const hiQ = crowns(true).concat([conifer]);
  /* 遠景(165mより先・丘の稜線)の広葉樹は3つのかたまり(60三角形)。いちばん数が多いので軽く */
  const lo = [mergeParts(broad([A[0], A[1], A[3]], 0)), mergeParts(broad([B[0], B[1], B[3]], 0)), mergeParts([{ g: shade(sugiCone(1.25, 6.4, 6, 2, 3.45, true), 0.25, 6.65) }])];
  return { hi, hiQ, lo };
}

/* list: [{x,y,z|p, s, sc, sy?, tint, conifer?}] → チャンク(300m)ごとの InstancedMesh */
export function plantTreesP1(rs, list, rng) {
  if (!rs._treeGeosP1) rs._treeGeosP1 = makeTreeGeosP1();
  const G = rs._treeGeosP1;
  if (!rs._treeFolMatP1) {
    const leaf = texLeaf();
    leaf.repeat.set(2, 2);
    const m = new THREE.MeshStandardMaterial({ map: leaf, color: 0xffffff, vertexColors: true, roughness: 0.92 });
    /* 幹(頂点色>=2)はインスタンス色に染めず、そのままの色で。車の材質と同じ patchTreeCar(シェーダは1つ) */
    m.onBeforeCompile = patchTreeCar;
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
  /* 線路から200mより外(丘の稜線の木など。いつも軽い形)は大きなかたまりで(描画の回数をおさえる) */
  const keyNum = (s, band) => (band === 0 ? Math.floor(s / 350) : band === 1 ? Math.floor(s / 600) : Math.floor(s / 2400));
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
    /* 杉は青みのある濃い緑 */
    if (t.conifer) _c.setRGB(k * 0.22, k * 0.33, k * 0.26, THREE.SRGBColorSpace);
    else _c.setRGB(k * 0.49, k * 0.6, k * 0.35, THREE.SRGBColorSpace);
    it.r = _c.r; it.g = _c.g; it.b = _c.b;
    groups[t.conifer ? 2 : (keyNum(s, band) + band) % 2].push(it);
  });
  const cells = [];
  /* 近景の形: 高画質だけ樹冠の上のかたまりが細かい組(hiQ) */
  const HI = rs.quality === 'high' && G.hiQ ? G.hiQ : G.hi;
  groups.forEach((all, gi) => {
    if (!all.length) return;
    /* 線路から200mより外(丘の稜線・遠くの林)はいつも軽い形(かたまりの外接矩形は大きいので、
     * 近いと判定されて細かい形にならないように) */
    const near = all.filter((it) => it.band < 2), farI = all.filter((it) => it.band === 2);
    const meshes = [];
    if (near.length) emitInstanced(g, HI[gi], mat, near, bandKey, { shadow: true }).forEach((m) => { m.userData.treeHi = HI[gi]; meshes.push(m); });
    if (farI.length) emitInstanced(g, G.lo[gi], mat, farI, bandKey, { shadow: true }).forEach((m) => { m.userData.treeHi = G.lo[gi]; meshes.push(m); });
    meshes.forEach((im) => {
      const hiG = im.userData.treeHi;
      im.userData.treeLo = G.lo[gi];
      /* かたまりの外接矩形(XZ)。LODの距離判定に使う */
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let i = 0; i < im.count; i++) {
        im.getMatrixAt(i, _m4);
        const x = _m4.elements[12], z = _m4.elements[14];
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z;
      }
      cells.push({ mesh: im, hi: hiG, lo: G.lo[gi], x0, x1, z0, z1, far: false, shadow: im.castShadow });
    });
  });
  if (T) T.treeCells.push(...cells);
  return g;
}

/* ---------- 丘(多摩丘陵): でこぼこの半球3種を線路方向に引きのばして稜線に ----------
 * 上のほう(y>.45)は方位の細かい波で ふくらませ・持ち上げて、稜線を樹冠のでこぼこにする(なめらかな おわん形にしない) */
function hillGeo(seed, seg) {
  const g = new THREE.SphereGeometry(1, seg, 12, 0, Math.PI * 2, 0, Math.PI / 2);
  const p = g.attributes.position;
  const r = makeRng(seed);
  const ph = [r() * 6, r() * 6, r() * 6];
  const pc = [r() * 6, r() * 6, r() * 6];
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
    /* 樹冠のでこぼこ(上のほうだけ。すそは地面になじませる)。てっぺんの点(方位が決まらない)は動かさない(すき間を作らない) */
    if (y > 0.45 && x * x + z * z > 1e-8) {
      const b = 1 + 0.035 * Math.sin(th * 23 + pc[0]) * Math.sin(th * 41 + pc[1]);
      x *= b; z *= b;
      y += 0.025 * (0.5 + 0.5 * Math.sin(th * 29 + pc[2]));
    }
    p.setXYZ(i, x, y, z);
    /* すその15%は明るい草地・畑の色へ */
    const t = clamp(1 - (y + 0.04) / 0.15, 0, 1);
    const sh = 0.9 + 0.1 * clamp(y, 0, 1);
    col[i * 3] = lerp(sh, lf[0], t); col[i * 3 + 1] = lerp(sh, lf[1], t); col[i * 3 + 2] = lerp(sh, lf[2], t);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  /* 急な斜面ほど少し暗く(上から光の当たる頂上は明るい)。かげの側が石板のように沈まないよう、暗さは控えめ */
  const nr = g.attributes.normal;
  for (let i = 0; i < p.count; i++) {
    const k = 0.84 + 0.16 * clamp(nr.getY(i), 0, 1);
    col[i * 3] *= k; col[i * 3 + 1] *= k; col[i * 3 + 2] *= k;
  }
  /* 稜線の木を植えてよい頂点(上のほう)。edge: その中で斜面の頂点(法線の上向きが .85 未満 = 横から見た輪郭の上) */
  const top = [], edge = [];
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) < 0.62) continue;
    top.push(i);
    if (nr.getY(i) < 0.85) edge.push(i);
  }
  g.userData.top = top;
  g.userData.edge = edge.length ? edge : top;
  return g;
}
/* 丘ごとの色味(明るさはそろえて色相だけ少し変える: 黄緑・青緑・オリーブ)。3色の平均が白(1,1,1)になるように */
const HILL_TINT = (() => {
  const t = [0x8fa070, 0x7f9a74, 0x9a9a6a].map((h) => {
    const c = new THREE.Color(h);
    const l = (c.r + c.g + c.b) / 3;
    return [c.r / l, c.g / l, c.b / l];
  });
  const m = [0, 1, 2].map((k) => (t[0][k] + t[1][k] + t[2][k]) / 3);
  return t.map((a) => a.map((v, k) => v / m[k]));
})();
/* 丘の置き場所と稜線の木(乱数 777 の列)。遠くの家並み(buildFarBlocks)が丘のすそをよけるために先に使うので、
 * 結果を rs._hillPlan に置いておき、buildHillsP1 が同じものを使う(乱数の並びは前と同じ) */
function hillPlan(rs, T, HG) {
  if (rs._hillPlan && rs._hillPlan.line === rs.line && rs._hillPlan.HG === HG) return rs._hillPlan;
  const F = rs.frames, step = rs.step, L = rs.line.meta.length;
  const rng = makeRng(777);
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
      tintHill(it, rng);
      lists[vi].push(it);
      /* 稜線の木(上のほうの頂点に。稜線の形をでこぼこにする)。中・高画質は輪郭にのる斜面の頂点だけから選ぶ
       * (平らな頂上の まん中に植えても横からは見えない)。針葉樹は2割(多いとクリスマスツリーの並びに見える) */
      const qh = T ? T.q : 1;
      const pg = HG[vi].attributes.position, top = qh >= 0.75 ? HG[vi].userData.edge : HG[vi].userData.top;
      const nT = Math.floor((rb / 6) * qh);
      _q.setFromAxisAngle(Y_AXIS, it.yaw);
      for (let i = 0; i < nT && top.length; i++) {
        const vi2 = top[Math.floor(rng() * top.length)];
        v.set(pg.getX(vi2) * it.sx, pg.getY(vi2) * it.sy, pg.getZ(vi2) * it.sz).applyQuaternion(_q);
        /* 樹冠の下の端(幹の高さ ≈ 1.6×大きさ)まで地面にうめる(稜線の上に棒つきの丸い木が浮いて見えないように) */
        const sc = 1.8 + rng() * 1.2;
        trees.push({ x: it.x + v.x, y: it.y + v.y - 0.4 - 1.6 * sc, z: it.z + v.z, s, sc, tint: 0.6 + rng() * 0.35, conifer: rng() < 0.2 });
      }
    }
  }
  rs._hillPlan = { line: rs.line, HG, lists, trees, rng };
  return rs._hillPlan;
}
/* 丘の形(品質ごと。モジュールで1回だけ作る) */
function hillGeos(rs) {
  /* 方位の分け方: 高画質は56(稜線のでこぼこが細かい)、中・低は44(三角形の数をおさえる) */
  const hseg = rs.quality === 'high' ? 56 : 44, hk = 'hills' + hseg;
  if (!GEO[hk]) GEO[hk] = [hillGeo(11, hseg), hillGeo(23, hseg), hillGeo(37, hseg)];
  return GEO[hk];
}
export function buildHillsP1(rs) {
  const T = rs._town;
  if (!rs._p1HillMat) {
    const t = texForest();
    /* 樹冠1つが4〜8mになる細かさ(細かいと芝生に、粗いと迷彩柄に見える) */
    t.repeat.set(11, 1.6);
    rs._p1HillMat = new THREE.MeshStandardMaterial({ map: t, vertexColors: true, roughness: 1 });
    rs._keep.add(rs._p1HillMat); rs._keep.add(t);
  }
  const HG = hillGeos(rs);
  const plan = hillPlan(rs, T, HG);
  rs._hillPlan = null;   // 1回だけ使う(つぎの路線では作りなおす)
  const lists = plan.lists, trees = plan.trees.slice(), rng = plan.rng;
  const v = new THREE.Vector3();
  /* ほかの担当がたのんだ丘(観覧車の足もとの丘など) */
  (rs._extraHills || []).forEach((h) => {
    const it = { x: h.x, y: h.y, z: h.z, yaw: h.yaw, sx: h.rb, sy: h.h, sz: h.sz || h.rb, s: h.s || 0, sh: false };
    tintHill(it, rng);
    lists[0].push(it);
    /* すその林(頂上のまわりは空ける: 観覧車の脚が立つ所) */
    const pg = HG[0].attributes.position;
    _q.setFromAxisAngle(Y_AXIS, it.yaw);
    for (let i = 0, n = 0; i < 400 && n < Math.floor((h.rb / 4) * (T ? T.q : 1)); i++) {
      const vi2 = Math.floor(rng() * pg.count);
      const ux = pg.getX(vi2), uz = pg.getZ(vi2), uy = pg.getY(vi2);
      if (Math.hypot(ux, uz) < 0.45 || uy < 0.08) continue;
      v.set(ux * it.sx, uy * it.sy, uz * it.sz).applyQuaternion(_q);
      trees.push({ x: it.x + v.x, y: it.y + v.y - 0.4, z: it.z + v.z, s: it.s, sc: 1.6 + rng() * 1.0, tint: 0.6 + rng() * 0.35, conifer: rng() < 0.2 });
      n++;
    }
  });
  const g = new THREE.Group();
  g.userData.p1cat = 'hills';
  rs.world.add(g);
  lists.forEach((arr, i) => {
    if (!arr.length) return;
    /* 大きな輪郭なので、描く距離の段階で消さない */
    emitInstanced(g, HG[i], rs._p1HillMat, arr, 1500, { colors: true, receive: true }).forEach((m) => { m.userData.keepFar = true; });
  });
  return trees;
}
function tintHill(it, rng) {
  const t = HILL_TINT[Math.floor(rng() * HILL_TINT.length) % HILL_TINT.length];
  const k = 1 + (rng() - 0.5) * 0.12;
  it.r = t[0] * k; it.g = t[1] * k; it.b = t[2] * k;
  return it;
}

/* =========================================================
 * 毎フレーム(割り当てなし)
 * ========================================================= */
/* 窓明かりの強さ: 色温度(電球色・蛍光灯・テレビ)は外壁シェーダが決めるので、ここは白(色をにごらせない)。
 * 夜は 1.25: とくに明るい窓(1〜2割)だけが にじみ(ブルーム)のしきい値をこえる */
const EMI_N = new THREE.Color(1.25, 1.25, 1.25), EMI_E = new THREE.Color(1, 1, 1).multiplyScalar(0.3), BLACK = new THREE.Color(0);
/* 夕方の遠景(夕焼けのもやに合わせた暖色) */
const COL_EVE_CITY = new THREE.Color(0xd8a088), COL_EVE_HILL = new THREE.Color(0xe0a890), COL_EVE_BOARD = new THREE.Color(0xc89080);
const COL_W = new THREE.Color(0xffffff), COL_NH = new THREE.Color(0x2c3540);

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

/* 街のリングの絵: 夜は灯りの街 / 昼・夕方は高層まじり(都心寄り)か低い街並み(住宅地) */
function setRingMap(T, L) {
  const M = T.M;
  const want = L.night ? M.ringTex.night : T.cityLow ? M.ringTex.low : M.ringTex.city;
  if (M.ringCity.map !== want) M.ringCity.map = want;
}

function applyLook(rs, T, L) {
  const M = T.M;
  uFcLit.value = L.night ? 0.38 : L.eve ? 0.15 : 0;
  const e = L.night ? EMI_N : L.eve ? EMI_E : BLACK;
  for (let i = 0; i < M.facades.length; i++) M.facades[i].emissive.copy(e);
  const lamps = !!(L.night || L.eve);
  for (let i = 0; i < T.glows.length; i++) T.glows[i].visible = lamps;
  /* 街灯の光だまり(材質で切り替える: メッシュは _splitInstances で作り直されるので参照を持たない)。ぬれた道は少し明るく */
  M.lampPool.visible = lamps;
  M.lampPool.opacity = (L.night ? 0.34 : 0.11) * (L.wet ? 1.3 : 1);
  /* 玄関の明かり(夜だけ) */
  M.porchPool.visible = !!L.night;
  M.porchPool.opacity = 0.42 * (L.wet ? 1.3 : 1);
  /* 走る車・踏切待ちの車の前照灯・尾灯 */
  uCarLamp.value = L.night ? 3.0 : L.eve ? 1.2 : 0;
  /* 店の看板(表だけ光る) */
  M.sign.emissiveIntensity = L.night ? 1.1 : L.eve ? 0.45 : 0;
  if (M.ringCity) {
    setRingMap(T, L);
    M.ringCity.color.copy(L.eve && !L.night ? COL_EVE_CITY : COL_W);
    M.ringHills.color.copy(L.night ? COL_NH : L.eve ? COL_EVE_HILL : COL_W);
    /* 新宿の高層ビル群: 夜は窓の灯りと航空障害灯の絵に(絵はいつもあるので作り直しにはならない) */
    const sjm = L.night ? M.sjNight : M.sjDay;
    if (M.billboard.map !== sjm) { M.billboard.map = sjm; M.billboard.needsUpdate = true; }
    M.billboard.color.copy(L.eve && !L.night ? COL_EVE_BOARD : COL_W);
  }
  /* 観覧車の電飾(夕方・夜)とゴンドラのほのかな明かり(夜) */
  if (rs._wheelLights) rs._wheelLights.visible = lamps;
  if (rs._wheelGonMat && rs._wheelGonMat.emissive) rs._wheelGonMat.emissive.setHex(L.night ? 0x3a3a3a : 0x000000);
}

/* ---------- 踏切が開いたら、待っていた車が走り出す(いちばん近い踏切だけ) ----------
 * 車ごとに「進んだ向きの位置」x(m)を持つ(x = -side*o: 線路へ向かって増え、線路をこえても増える)。
 * 遮断機が上がって2秒たつと 20km/h で進み、とまる線の75m先まで行ったら列のいちばん後ろ(線の45m以上手前)へもどる。
 * 遮断機が下りはじめたら、まだ とまる線をこえていない車は線の手前(か前の車のうしろ)で止まり、
 * もう線をこえた車はそのまま渡りきる(列ごと動かすと、うしろの車が下りてくる遮断機をくぐってしまう)。
 * 行列は addCars が書いた sp._im / sp._i に直接書く(割り当てなし) */
const XC_V = 20 / 3.6, XC_BACK = 45, XC_FWD = 75;
/* とまる線(x。線路の中心から左は9.0m・右は12.8m。遮断機の1m外) */
const xStopOf = (side) => (side > 0 ? -9.0 : -12.8);
const _xq = new THREE.Quaternion(), _xp = new THREE.Vector3(), _xs = new THREE.Vector3(1, 1, 1), _xm = new THREE.Matrix4();
function crossGroups(rs, T) {
  const list = rs._crossCarList || [];
  /* 踏切と車がそろってから1回だけ作る(ワールドを少しずつ作っている途中でよばれても空のまま固定しない) */
  if (T.xGroups && T.xN === list.length && T.xCr === rs.crossings) return T.xGroups;
  T.xN = list.length; T.xCr = rs.crossings;
  const map = new Map();
  for (let i = 0; i < list.length; i++) {
    const sp = list[i];
    if (!sp._im || sp._xs == null) continue;
    let g = map.get(sp._xs);
    if (!g) map.set(sp._xs, (g = { s: sp._xs, cars: [], cr: null, upT: 0, home: true }));
    sp._x0 = -sp._side * sp._o0;
    sp._x = sp._x0;
    sp._hl = (CAR_LEN[sp.type] || 4) / 2;
    g.cars.push(sp);
  }
  const cr = rs.crossings || [];
  T.xGroups = [];
  map.forEach((g) => {
    for (let k = 0; k < cr.length; k++) if (Math.abs(cr[k].s - g.s) < 0.5) g.cr = cr[k];
    T.xGroups.push(g);
  });
  return T.xGroups;
}
/* 踏切の道の高さ(左への距離 o。道路板は -29.8〜26.0m、その外10mで地面の高さへ) */
function xRoadY(sp, o) {
  const top = sp._fy + 0.14, low = sp._fy - 0.39;
  const t = o > 26 ? (o - 26) / 10 : o < -29.8 ? (-29.8 - o) / 10 : 0;
  return top + (low - top) * (t > 1 ? 1 : t);
}
function placeXCar(sp) {
  const o = -sp._side * sp._x;
  _xp.set(sp._fx + sp._lx * o + sp._tx * sp._lane, xRoadY(sp, o), sp._fz + sp._lz * o + sp._tz * sp._lane);
  _xq.setFromAxisAngle(Y_AXIS, sp.yaw);
  _xm.compose(_xp, _xq, _xs);
  sp._im.setMatrixAt(sp._i, _xm);
  sp._im.instanceMatrix.needsUpdate = true;
}
/* 列の場所にもどす(ほかの踏切がいちばん近くなったとき) */
function homeXCars(g) {
  for (let i = 0; i < g.cars.length; i++) {
    const sp = g.cars[i];
    if (sp._x !== sp._x0) { sp._x = sp._x0; placeXCar(sp); }
  }
  g.upT = 0; g.home = true;
}
/* 1コマぶん進める。go: 遮断機が上がって2秒たった */
function stepXCars(g, go, dt) {
  const cars = g.cars;
  let moved = false;
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i];
    const xs = xStopOf(c._side);
    let lim = Infinity;
    /* 遮断機が下りている(下りはじめた): 前の端がまだ線を1mこえていなければ、線の手前で止まる */
    if (!go && c._x + c._hl <= xs + 1.0) lim = xs + 0.3 - c._hl;
    /* 前の車に1.5mより近づかない(同じ側の列。線路をこえた車も同じ車線) */
    for (let k = 0; k < cars.length; k++) {
      const o = cars[k];
      if (o === c || o._side !== c._side || o._x <= c._x) continue;
      const gap = o._x - o._hl - c._hl - 1.5;
      if (gap < lim) lim = gap;
    }
    let x = c._x + XC_V * dt;
    if (x > lim) x = Math.max(c._x, lim);
    if (x > xs + XC_FWD) {
      /* 走り去った: 列のいちばん後ろの車のさらに後ろ(線の45m以上手前)へ */
      let back = xs - XC_BACK;
      for (let k = 0; k < cars.length; k++) {
        const o = cars[k];
        if (o !== c && o._side === c._side) back = Math.min(back, o._x - o._hl - c._hl - 3);
      }
      x = back;
    }
    if (x !== c._x) { c._x = x; placeXCar(c); moved = true; }
  }
  return moved;
}
function updateCrossCars(rs, T, dt) {
  const gs = crossGroups(rs, T);
  if (!gs.length || !rs.sim) return;
  /* いちばん近い踏切(線路の距離で) */
  const pos = rs.sim.pos;
  let best = null, bd = 1e9;
  for (let i = 0; i < gs.length; i++) {
    const d = Math.abs(gs[i].s - pos);
    if (d < bd) { bd = d; best = gs[i]; }
  }
  if (bd > 700) best = null;
  /* 前の踏切の車は列にもどす */
  if (T.xAct && T.xAct !== best) homeXCars(T.xAct);
  T.xAct = best;
  if (!best || !best.cr || !best.cr.arms || !best.cr.arms.length) return;
  const up = best.cr.arms[0].rotation.z > 1.2;
  best.upT = up ? best.upT + dt : 0;
  const go = up && best.upT >= 2;
  /* 列で止まって待っているあいだは何もしない */
  if (!go && best.home) return;
  best.home = !stepXCars(best, go, dt) && !go;
}

/* dt: 前のフレームからの秒(道を走る車・踏切の車を動かす。木のLODの判定はフレーム数で数える) */
export function updateTown(rs, dt) {
  const T = rs._town;
  if (!T || !rs.sim) return;
  T.frame++;
  const L = rs.look || fallbackLook(rs, T);
  /* 最初の数フレームは街灯も見せておく(夜に切り替えたとき新しいシェーダを作らないため) */
  if (T.frame > 2 && L.rev !== T.rev) { T.rev = L.rev; applyLook(rs, T, L); }
  /* 街の照り返し: 夜は都心ほど強く郊外は弱い(_glowK: 0=都心 1=郊外。郊外でも 0.6 は残す)、夕方は少し、昼はなし */
  uFcAmb.value = L.night ? 1 - 0.4 * (rs._glowK || 0) : L.eve ? 0.25 : 0;
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
    /* 低い街並みの絵との切りかえは、濃さが 0.5 を下回る/0.6 を上回るときだけ(行ったり来たりしない) */
    const c0 = T.cityOp[i];
    if (!T.cityLow && c0 < 0.5) { T.cityLow = true; if (T.rev !== null) setRingMap(T, L); }
    else if (T.cityLow && c0 > 0.6) { T.cityLow = false; if (T.rev !== null) setRingMap(T, L); }
    const oc = c0 * wetK, oh = T.hillOp[i] * wetK;
    T.ringCity.visible = !hide && oc > 0.02;
    T.ringHills.visible = !hide && oh > 0.02;
    T.ringCity.position.set(eye.x, baseY, eye.z);
    T.ringCity.scale.set(r * 0.97, 240, r * 0.97);
    T.ringHills.position.set(eye.x, baseY, eye.z);
    T.ringHills.scale.set(r, 240, r);
    T.M.ringCity.opacity = oc;
    T.M.ringHills.opacity = oh;
    /* 新宿の高層ビル群(新宿から1.3km以上はなれている時だけ、新宿の方角の地平に)。
     * 本当の距離に合わせて小さくし(2.3kmで原寸)、下の端を地平線にそろえる。遠いほど もやでうすく */
    const B = T.board;
    if (T.sjX !== null) {
      const dx = T.sjX - eye.x, dz = T.sjZ - eye.z;
      const d = Math.hypot(dx, dz);
      const vis = !hide && d > 1300;
      B.visible = vis;
      if (vis) {
        const k = Math.min(0.85 * far, 0.95 * r) / d;
        const sK = clamp(2300 / d, 0.07, 1);
        const by = baseY + 21 + 160 * sK;
        B.scale.set(sK, sK, 1);
        B.position.set(eye.x + dx * k, by, eye.z + dz * k);
        B.lookAt(eye.x, by, eye.z);
        T.M.billboard.opacity = clamp((d - 1300) / 900, 0, 1) * (1 - 0.7 * smooth01(5000, 17000, d)) * 0.92 * wetK;
      }
    } else B.visible = false;
  }

  /* --- 道を走る車・踏切が開いたら走り出す車 --- */
  if (dt > 0) {
    if (T.traffic) T.traffic.update(rs, dt);
    updateCrossCars(rs, T, Math.min(dt, 0.1));
  }

  /* --- 木と車のLOD(10フレームに1回。165mより遠いかたまりは軽い形・幹なし・影なし) --- */
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
      if (c.far && d2 < 150 * 150) {
        c.far = false; c.mesh.geometry = c.hi; c.mesh.castShadow = c.shadow;
      } else if (!c.far && d2 > 165 * 165) {
        c.far = true; c.mesh.geometry = c.lo; c.mesh.castShadow = false;
      }
    }
    /* 近いときだけ見せるかたまり(電線450m・車400m・看板650m): 遠くでは数画素なので描画を省く */
    const wc = T.wireCells;
    for (let i = 0; i < wc.length; i++) {
      const c = wc[i];
      const dx = ex < c.x0 ? c.x0 - ex : ex > c.x1 ? ex - c.x1 : 0;
      const dz = ez < c.z0 ? c.z0 - ez : ez > c.z1 ? ez - c.z1 : 0;
      c.obj.visible = dx * dx + dz * dz < c.d2;
    }
  }
}
