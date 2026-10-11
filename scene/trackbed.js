/* =========================================================
 * scene/trackbed.js — 線路まわりの形(道床・地面・架線・トンネル・多摩川橋梁)
 * ・複々線の急行線の位置(QUAD_OFF)と、駅の先でなめらかに分かれる「分岐」
 * ・道床の断面(バラストの肩・のり面・犬走り)を1本の帯で作る profileRibbon
 * ・カーブでも折れ返らない多列の地面 groundStrip(市街地は舗装・郊外は砂利と畑)
 * ・門型の架線ビーム(トラス)+可動ブラケット+ジグザグのトロリ線
 * ・トンネルの坑口・土かぶり・掘割、多摩川のワーレントラス橋
 * ・同じ材質の帯を約750mごとに1つにまとめる(描画コールを減らす)
 * DOM には触らない部分(形の計算)は Node でも読み込める(tools/check-*.mjs)。
 * ========================================================= */
import * as THREE from '../vendor/three.module.min.js';
import { LineSegmentsGeometry } from '../vendor/addons/LineSegmentsGeometry.js';
import { LineSegments2 } from '../vendor/addons/LineSegments2.js';
import { LineMaterial } from '../vendor/addons/LineMaterial.js';

/* 複々線の急行線(左=くだり急行 7.0m / 上り急行 10.8m)。車体(半幅1.475m)がホームの背(5.0m)にかからない */
export const QUAD_OFF = [7.0, 10.8];
/* 狭軌のレール頭部中心(scene.js と同じ値) */
export const RAIL_HALF = 1.067 / 2 + 0.032;
/* 架線柱の位置(線路中心から。+が左)。
 * 左の柱は駅でも駅の外でも同じ 4.75m(ホームの背の内側・柵の手前)にそろえる:
 * 線路わきの撮影カメラ(左4.4m)の目の前に柱が立たず、門型ビームの形も1種類で済む */
export const POLE = { L: 4.75, R: -8.45, stL: 4.75, stR: -8.45, quadL: QUAD_OFF[1] + 3.1 };
/* トンネルの壁(左は複々線の外側) */
export const TUN = { L: QUAD_OFF[1] + 2.4, R: -9.5, H: 6.2 };

const UPV = new THREE.Vector3(0, 1, 0);
const FAN = 150;          // 急行線が分かれる長さ(m)
const sstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
export const smoothstep = sstep;

/* ---------------- 複々線(分岐の位置) ----------------
 * 分かれ目が駅のホームに一部だけかかるときはホームの先へずらし、
 * ホームの下にすっぽり入るときはそのまま(ホームの下に隠れる)にする */
const QI = new WeakMap();
let curQI = null;
export function quadInfo(line) {
  let qi = QI.get(line);
  if (qi) { curQI = qi; return qi; }
  const q = line.sections.quad;
  const plats = line.stations.map((st) => [st.s - 160, st.s + 20]);
  let a0 = q.from, b1 = q.to;
  for (let pass = 0; pass < 2; pass++) {
    for (const [pa, pb] of plats) {
      if (pa < a0 + FAN && pb > a0 && !(pa <= a0 && pb >= a0 + FAN)) a0 = Math.max(a0, pb + 5);
      if (pa < b1 && pb > b1 - FAN && !(pa <= b1 - FAN && pb >= b1)) b1 = Math.min(b1, pa - 5);
    }
  }
  qi = { from: q.from, to: q.to, a0, a1: a0 + FAN, b0: b1 - FAN, b1 };
  QI.set(line, qi);
  curQI = qi;
  return qi;
}

/* 急行線 k(0=くだり急行, 1=上り急行)の線路中心からの横位置。複々線の外は0。
 * 上り急行はくだり急行から少し遅れて分かれる(はしご状の分岐) */
export function quadOffAt(s, k, qi = curQI) {
  if (!qi || s <= qi.a0 || s >= qi.b1) return 0;
  const t0 = Math.min(sstep(qi.a0, qi.a1, s), 1 - sstep(qi.b0, qi.b1, s));
  const e0 = QUAD_OFF[0] * t0;
  if (!k) return e0;
  const t1 = Math.min(sstep(qi.a0 + 40, qi.a1, s), 1 - sstep(qi.b0, qi.b1 - 40, s));
  return e0 + (QUAD_OFF[1] - QUAD_OFF[0]) * t1;
}
/* となりの線路との間隔(急行線が「線路として」見えはじめる判定に使う) */
export function quadSep(s, k, qi = curQI) {
  const e0 = quadOffAt(s, 0, qi);
  return k ? quadOffAt(s, 1, qi) - e0 : e0;
}
/* 急行線が全幅(7.0/10.8)で並ぶ区間(AI列車はここだけを走る) */
export function quadFullZone(qi = curQI) {
  return qi ? { from: qi.a1, to: qi.b0 } : null;
}
/* 左側の柵・防音壁の位置(複々線では上り急行の外側へ) */
export function fenceOffL(s, qi = curQI) {
  return Math.max(5.4, quadOffAt(s, 1, qi) + 3.6);
}

/* ---------------- 駅の見た目の型(駅名から毎回同じに決まる) ----------------
 * kind: 'over'(線路の上の駅舎=橋上駅舎) / 'foot'(跨線橋) / 'house'(地上の駅舎)。
 * 地下駅と新宿は 'house'。roofA: 屋根の長さ(st.s-roofA まで) / roofCol: 屋根の色。
 * 階段のある駅(over/foot)は、階段(STAIR)と屋根がぶつからないよう屋根を短めにする */
export const STAIR = { c: 147, top: 141, foot: 128.6 };   // 駅舎の中心 st.s-147、階段は st.s-141(上)〜st.s-128.6(下)
const ROOF_COLS = [0x3d4a56, 0x5f554a, 0xcfd2d4];
const hmix = (x) => {
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
};
export function stationStyleOf(name, plain) {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 16777619); }
  const u1 = hmix(h + 300), u2 = hmix(h + 23), u3 = hmix(h + 37);
  const kind = !plain ? 'house' : u1 < 0.4 ? 'over' : u1 < 0.7 ? 'foot' : 'house';
  const roofs = kind === 'house' ? [95, 125, 140] : [95, 125];
  return { kind, roofCol: ROOF_COLS[Math.floor(u2 * 3) % 3], roofA: roofs[Math.floor(u3 * roofs.length) % roofs.length] };
}
/* 路線ぜんぶの駅の型(rs.stationStyles に作り置き。路線が変わったら作り直す) */
export function stationStyles(rs) {
  if (rs.stationStyles && rs._stationStylesFor === rs.line) return rs.stationStyles;
  const T = rs.terminal;
  rs.stationStyles = rs.line.stations.map((st) => stationStyleOf(st.name, !(T && st.name === '新宿') && !rs._inTunnel(st.s)));
  rs._stationStylesFor = rs.line;
  return rs.stationStyles;
}

/* ---------------- フレーム ---------------- */
/* scene.js の buildFrames と同じ作り方(ツールから使う) */
export function framesFromLine(line) {
  const pts = line.pts.map(([x, y, e]) => new THREE.Vector3(x, e, -y));
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const t = b.clone().sub(a).normalize();
    return { p, t, left: new THREE.Vector3().crossVectors(UPV, t).normalize() };
  });
}

/* 進行方向を前後 R 行で平均した「なめらかな」向き(地面の外側の列に使う) */
export function smoothFrames(F, R = 10) {
  const n = F.length;
  const t = new Array(n), left = new Array(n);
  let sx = 0, sz = 0;
  const add = (i, k) => { if (i >= 0 && i < n) { sx += F[i].t.x * k; sz += F[i].t.z * k; } };
  for (let i = -R; i <= R; i++) add(i, 1);
  for (let i = 0; i < n; i++) {
    const l = Math.hypot(sx, sz) || 1;
    t[i] = new THREE.Vector3(sx / l, 0, sz / l);
    left[i] = new THREE.Vector3(t[i].z, 0, -t[i].x);
    add(i - R, -1); add(i + R + 1, 1);
  }
  /* 行ごとの曲率(+は左カーブ)。前後1行の向きの差から */
  const kap = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = t[Math.max(0, i - 1)], b = t[Math.min(n - 1, i + 1)];
    kap[i] = (a.z * b.x - a.x * b.z) / 10;
  }
  return { t, left, kap };
}

/* 位置 s のフレームを out に書く(毎フレーム使うので new しない) */
export function frameInto(F, step, s, out) {
  const f = s / step;
  const i = Math.max(0, Math.min(F.length - 2, Math.floor(f)));
  const k = Math.min(1, Math.max(0, f - i));
  const a = F[i], b = F[i + 1];
  out.p.lerpVectors(a.p, b.p, k);
  out.t.lerpVectors(a.t, b.t, k).normalize();
  out.left.lerpVectors(a.left, b.left, k).normalize();
  return out;
}
export const newFrame = () => ({ p: new THREE.Vector3(), t: new THREE.Vector3(), left: new THREE.Vector3() });

/* ---------------- 帯の形 ----------------
 * profileRibbon: 断面(左→右の点列 [u(横m), y(高さ), texU])を行ごとに並べた帯。
 * prof は配列か (i)=>配列。opts.offset(数 or (i)=>数)で断面全体を横にずらす。
 * UV は u=texU, v=距離/uvScale (opts.vert=true なら u=距離/uvScale, v=texU: 縦の壁用)。
 * 距離はふつう 行×step。行に f.s があればそれを使う(端の行だけ坑口の位置にずらしたとき、模様がつぶれない)。
 * 三角形の向きは scene.js の ribbon() と同じ(法線が上を向く。材質は両面)。 */
export function profileRibbon(F, i0, i1, prof, opts = {}) {
  const uvScale = opts.uvScale || 5, step = opts.step || 5, vcol = opts.vcol || null;
  const pf = typeof prof === 'function' ? prof : () => prof;
  const off = opts.offset || 0;
  const of = typeof off === 'function' ? off : () => off;
  const C = pf(i0).length;
  const rows = i1 - i0 + 1;
  const nv = rows * C;
  const pos = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  const col = vcol ? new Float32Array(nv * 3) : null;
  const idx = new (nv > 65535 ? Uint32Array : Uint16Array)((rows - 1) * (C - 1) * 6);
  let n = 0, k = 0;
  for (let i = i0; i <= i1; i++) {
    const f = F[i], P = pf(i), o = of(i), v = (f.s != null ? f.s : i * step) / uvScale;   // 端を坑口などにそろえた行は f.s(m)を持つ
    for (let c = 0; c < C; c++) {
      const pt = P[c], lat = pt[0] + o;
      pos[n * 3] = f.p.x + f.left.x * lat;
      pos[n * 3 + 1] = f.p.y + pt[1];
      pos[n * 3 + 2] = f.p.z + f.left.z * lat;
      if (opts.vert) { uv[n * 2] = v; uv[n * 2 + 1] = pt[2]; } else { uv[n * 2] = pt[2]; uv[n * 2 + 1] = v; }
      if (col) { const cc = vcol(i, c); col[n * 3] = cc[0]; col[n * 3 + 1] = cc[1]; col[n * 3 + 2] = cc[2]; }
      n++;
    }
    if (i > i0) {
      const r = i - i0;
      for (let c = 0; c < C - 1; c++) {
        const a = (r - 1) * C + c, b = a + 1, c2 = r * C + c, d = c2 + 1;
        idx[k++] = a; idx[k++] = b; idx[k++] = c2; idx[k++] = b; idx[k++] = d; idx[k++] = c2;
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (col) g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  g.userData.rows = rows; g.userData.cols = C; g.userData.i0 = i0;
  return g;
}

/* 平らな帯(ribbon と同じ)と縦の帯(vribbon と同じ)の短縮形 */
export const flatStrip = (F, i0, i1, off, w, y, uvScale, step = 5) =>
  profileRibbon(F, i0, i1, [[w / 2, y, 0], [-w / 2, y, 1]], { offset: off, uvScale, step });
export const wallStrip = (F, i0, i1, off, y0, y1, uvScale, step = 5) => {
  const y0f = typeof y0 === 'function' ? y0 : () => y0;
  const y1f = typeof y1 === 'function' ? y1 : () => y1;
  return profileRibbon(F, i0, i1, (i) => [[0, y1f(i), 1], [0, y0f(i), 0]], { offset: off, uvScale, step, vert: true });
};

/* ---------------- 地面 ----------------
 * 線路の片側(side=+1左/-1右)に、横に何列も頂点を持つ地面の帯を作る。
 * ・内側の数列(12mまで)は線路と同じ向き、遠くの列はなめらかな向きを使う(ガタつきで折れない)
 * ・カーブの内側では、列が曲率半径の0.75倍より外に出ないように寄せる(折れ返り防止)
 * ・UV はメートル(u=横, v=距離)。テクスチャの repeat で1枚の大きさを決める */
export const GROUND_COLS = { L: [3.9, 12, 30, 70, 140, 260, 600], R: [8.2, 12, 30, 70, 140, 260, 600] };
export function groundColumnsAt(F, FS, i, side, shift = 0) {
  const n = F.length;
  /* 前後40mのうち、この側が「カーブの内側」になる一番きつい曲率 */
  let kin = 0;
  for (let j = Math.max(0, i - 8); j <= Math.min(n - 1, i + 8); j++) kin = Math.max(kin, FS.kap[j] * side);
  const base = side > 0 ? GROUND_COLS.L : GROUND_COLS.R;
  /* 先頭に「のり面の下へもぐる」隠れ列を足す(継ぎ目のすき間をなくす) */
  const cols = [base[0] - 0.6, ...base].map((c) => c + shift);
  if (kin > 0) {
    const lim = 0.75 / kin;
    for (let j = 0; j < cols.length; j++) cols[j] = Math.min(cols[j], Math.max(lim, base[1] + shift + 4));
  }
  for (let j = 1; j < cols.length; j++) cols[j] = Math.max(cols[j], cols[j - 1]);
  return cols;
}
/* 地面の高さ: 内側の列 -0.42 → 12m(右は線路中心から12m)で -0.5。隠れ列は -0.45 */
const GY = (c, inner, out) => {
  if (c <= inner - 0.3) return -0.45;
  if (out - inner < 0.5) return -0.5;
  return -0.42 - 0.08 * Math.min(1, Math.max(0, (c - inner) / (out - inner)));
};
/* opts.cols = [c0, c1]: groundColumnsAt の列のうち c0〜c1 番だけを出す(のり面の下の隠れ列は c0 が0のときだけ)。
 * 頂点色 vcol(i, c, C) の c と C は全部の列での番号・数のまま(となりの帯と境目の色がそろう) */
export function groundStrip(F, FS, i0, i1, side, opts = {}) {
  const step = opts.step || 5;
  const shiftF = opts.shift || (() => 0);
  const vcol = opts.vcol || null;
  const CA = GROUND_COLS.L.length + 1;
  const c0 = opts.cols ? opts.cols[0] : 0, c1 = opts.cols ? opts.cols[1] : CA - 1;
  const C = c1 - c0 + 1;
  /* 地面は2行(10m)おきで十分(三角形を半分に)。最後の行は必ず入れる */
  const rowStep = opts.rowStep || 2;
  const list = [];
  for (let i = i0; i < i1; i += rowStep) list.push(i);
  list.push(i1);
  const rows = list.length, nv = rows * C;
  const pos = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  const col = vcol ? new Float32Array(nv * 3) : null;
  const idx = new Uint32Array((rows - 1) * (C - 1) * 6);
  let n = 0, k = 0;
  const L = new THREE.Vector3();
  for (let ri = 0; ri < rows; ri++) {
    const i = list[ri];
    const f = F[i], sh = shiftF(i);
    const cols = groundColumnsAt(F, FS, i, side, sh);
    const inner = cols[1], out = cols[2];
    const ls = FS.left[i];
    for (let c = c0; c <= c1; c++) {
      const off = cols[c];
      /* 12mまでは線路の向き、45mから先はなめらかな向き */
      const w = sstep(12 + sh, 45 + sh, off);
      L.copy(f.left).lerp(ls, w).normalize();
      const lat = side * off;
      pos[n * 3] = f.p.x + L.x * lat;
      pos[n * 3 + 1] = f.p.y + GY(off, inner, out);
      pos[n * 3 + 2] = f.p.z + L.z * lat;
      uv[n * 2] = lat; uv[n * 2 + 1] = i * step;
      if (col) { const cc = vcol(i, c, CA); col[n * 3] = cc[0]; col[n * 3 + 1] = cc[1]; col[n * 3 + 2] = cc[2]; }
      n++;
    }
    if (ri > 0) {
      const r = ri;
      for (let c = 0; c < C - 1; c++) {
        /* 左側は列の並びが「右→左」なので、法線が上を向くように入れかえる */
        let a = (r - 1) * C + c, b = a + 1, c2 = r * C + c, d = c2 + 1;
        if (side > 0) { [a, b] = [b, a]; [c2, d] = [d, c2]; }
        idx[k++] = a; idx[k++] = b; idx[k++] = c2; idx[k++] = b; idx[k++] = d; idx[k++] = c2;
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (col) g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  g.userData.rows = rows; g.userData.cols = C; g.userData.i0 = i0; g.userData.rowStep = rowStep;
  return g;
}

/* ---------------- 帯の結合(描画コール削減) ----------------
 * world 直下の「行のある帯」(userData.rows/cols/i0)を、材質・影の設定ごとに
 * 全線共通の区切り(rowsPer 行ごと)で切って1つのメッシュにまとめる。
 * 位置・回転・拡大がない(単位行列の)メッシュだけが対象。userData.noMerge は触らない。 */
export function mergeRibbons(world, rowsPer = 150) {
  const buckets = new Map();
  const victims = [];
  const isIdentity = (o) => o.position.x === 0 && o.position.y === 0 && o.position.z === 0 &&
    o.quaternion.x === 0 && o.quaternion.y === 0 && o.quaternion.z === 0 && o.quaternion.w === 1 &&
    o.scale.x === 1 && o.scale.y === 1 && o.scale.z === 1;
  for (const o of world.children) {
    if (!o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || o.children.length) continue;
    const g = o.geometry, ud = g.userData;
    if (!ud || !ud.rows || ud.rows < 2 || (o.userData && o.userData.noMerge) || ud.noMerge) continue;
    if (Array.isArray(o.material) || !g.index || g.groups.length || g.morphAttributes.position) continue;
    if (!isIdentity(o) || !o.visible || !o.frustumCulled) continue;
    const C = ud.cols || 2, i0 = ud.i0 || 0, rows = ud.rows, rstep = ud.rowStep || 1;
    if (g.attributes.position.count !== rows * C) continue;
    const names = Object.keys(g.attributes).sort();
    if (names.some((nm) => g.attributes[nm].isInterleavedBufferAttribute)) continue;
    /* 三角形を「最小の行」で全線共通の区切りへ振り分ける(隣り合う2行にまたがる帯だけ) */
    const ix = g.index.array;
    const tri = new Map();
    let ok = true;
    for (let t = 0; t < ix.length; t += 3) {
      const ra = (ix[t] / C) | 0, rb = (ix[t + 1] / C) | 0, rc = (ix[t + 2] / C) | 0;
      const r = Math.min(ra, rb, rc);
      if (Math.max(ra, rb, rc) - r > 1) { ok = false; break; }
      const ch = Math.floor((i0 + r * rstep) / rowsPer);
      let e = tri.get(ch);
      if (!e) { e = { tl: [], rmin: r, rmax: r + 1 }; tri.set(ch, e); }
      e.tl.push(t);
      if (r < e.rmin) e.rmin = r;
      if (r + 1 > e.rmax) e.rmax = Math.min(rows - 1, r + 1);
    }
    if (!ok) continue;
    victims.push(o);
    const kb = `${o.material.uuid}|${o.castShadow}|${o.receiveShadow}|${o.renderOrder}|${names.join(',')}`;
    tri.forEach(({ tl, rmin: r0, rmax: r1 }, ch) => {
      const key = kb + '|' + ch;
      let b = buckets.get(key);
      if (!b) { b = { o, names, parts: [], nv: 0, ni: 0 }; buckets.set(key, b); }
      b.parts.push({ g, C, r0, r1, tl });
      b.nv += (r1 - r0 + 1) * C;
      b.ni += tl.length * 3;
    });
  }
  buckets.forEach((b) => {
    const ng = new THREE.BufferGeometry();
    b.names.forEach((nm) => {
      const it = b.parts[0].g.attributes[nm].itemSize;
      const arr = new Float32Array(b.nv * it);
      let o = 0;
      b.parts.forEach((p) => {
        const src = p.g.attributes[nm].array;
        const a = p.r0 * p.C * it, e = (p.r1 + 1) * p.C * it;
        arr.set(src.subarray(a, e), o);
        o += e - a;
      });
      ng.setAttribute(nm, new THREE.BufferAttribute(arr, it));
    });
    const idx = new (b.nv > 65535 ? Uint32Array : Uint16Array)(b.ni);
    let k = 0, base = 0;
    b.parts.forEach((p) => {
      const ix = p.g.index.array, sub = p.r0 * p.C;
      for (const t of p.tl) {
        idx[k++] = ix[t] - sub + base; idx[k++] = ix[t + 1] - sub + base; idx[k++] = ix[t + 2] - sub + base;
      }
      base += (p.r1 - p.r0 + 1) * p.C;
    });
    ng.setIndex(new THREE.BufferAttribute(idx, 1));
    ng.computeBoundingSphere();
    ng.computeBoundingBox();
    const m = new THREE.Mesh(ng, b.o.material);
    m.castShadow = b.o.castShadow; m.receiveShadow = b.o.receiveShadow; m.renderOrder = b.o.renderOrder;
    m.userData.merged = true;
    world.add(m);
  });
  victims.forEach((o) => { world.remove(o); o.geometry.dispose(); });
  return { removed: victims.length, added: buckets.size };
}

/* ---------------- テクスチャ(キャンバスで描く。ブラウザでだけ呼ぶ) ---------------- */
const rngOf = (seed) => { let x = seed; return () => (x = (x * 16807) % 2147483647) / 2147483647; };
function canvasTex(w, h, draw, o = {}) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  draw(cv.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = o.aniso || 4;
  if (o.srgb !== false) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
/* 端からはみ出した図形を反対側にも描く(タイルの継ぎ目を消す) */
function wrapRect(c, w, h, x, y, rw, rh) {
  for (const dx of [0, -w, w]) for (const dy of [0, -h, h]) c.fillRect(x + dx, y + dy, rw, rh);
}
function speckle(c, w, h, n, R, alpha, light = 0.5) {
  for (let i = 0; i < n; i++) {
    c.fillStyle = R() < light ? `rgba(255,255,255,${alpha})` : `rgba(0,0,0,${alpha})`;
    const s = 1 + R() * 1.6;
    c.fillRect(R() * w, R() * h, s, s);
  }
}

/* 枕木の帯: 横=枕木の長さ2.0m、縦=枕木1本ぶんの間隔0.625m。遠くまで枕木のリズムを描く */
export const texSleeperBand = (aniso) => canvasTex(64, 256, (c) => {
  const R = rngOf(11);
  c.fillStyle = '#7b766d'; c.fillRect(0, 0, 64, 256);
  const cols = ['#5d5952', '#958f85', '#6c675f', '#a9a397'];
  for (let i = 0; i < 1500; i++) {
    c.fillStyle = cols[(R() * 4) | 0];
    const s = 1 + R();
    c.fillRect(R() * 64, R() * 256, s, s);
  }
  /* レールの下の砂利はさびで茶色っぽい */
  [[10, 18], [46, 54]].forEach(([a, b]) => {
    const g = c.createLinearGradient(a - 3, 0, b + 3, 0);
    g.addColorStop(0, 'rgba(104,72,46,0)'); g.addColorStop(0.5, 'rgba(104,72,46,0.45)'); g.addColorStop(1, 'rgba(104,72,46,0)');
    c.fillStyle = g; c.fillRect(a - 3, 48, b - a + 6, 160);
  });
  /* 枕木(v=0 をはさんで上下に分かれて描く=タイルの継ぎ目で1本になる) */
  c.fillStyle = '#85817a'; c.fillRect(0, 0, 64, 48); c.fillRect(0, 208, 64, 48);
  for (let i = 0; i < 260; i++) {
    c.fillStyle = R() < 0.5 ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.06)';
    const y = R() < 0.5 ? R() * 46 : 210 + R() * 46;
    c.fillRect(R() * 64, y, 1.5, 1.5);
  }
  c.fillStyle = 'rgba(38,36,32,0.6)'; c.fillRect(0, 46, 64, 2); c.fillRect(0, 208, 64, 2);
  /* 締結装置の台座 */
  [[11, 17], [47, 53]].forEach(([a, b]) => {
    c.fillStyle = '#4a4743'; c.fillRect(a, 0, b - a, 22); c.fillRect(a, 234, b - a, 22);
    const g = c.createLinearGradient(0, 22, 0, 40);
    g.addColorStop(0, 'rgba(120,78,44,0.55)'); g.addColorStop(1, 'rgba(120,78,44,0)');
    c.fillStyle = g; c.fillRect(a - 1, 22, b - a + 2, 18);
  });
}, { aniso });

/* 橋の上のまくら木(木製・すき間は抜く=下の川が見える) */
export const texBridgeTies = (aniso) => canvasTex(64, 256, (c) => {
  const R = rngOf(23);
  c.clearRect(0, 0, 64, 256);
  const tie = (y0, y1) => {
    c.fillStyle = '#5a4634'; c.fillRect(0, y0, 64, y1 - y0);
    for (let i = 0; i < 40; i++) {
      c.fillStyle = R() < 0.5 ? 'rgba(30,22,16,0.25)' : 'rgba(120,96,72,0.25)';
      c.fillRect(0, y0 + R() * (y1 - y0), 64, 1);
    }
  };
  tie(0, 56); tie(200, 256);
  c.fillStyle = 'rgba(20,16,12,0.6)'; c.fillRect(0, 54, 64, 2); c.fillRect(0, 200, 64, 2);
  [[11, 17], [47, 53]].forEach(([a, b]) => {
    c.fillStyle = '#3d3a37'; c.fillRect(a - 2, 0, b - a + 4, 26); c.fillRect(a - 2, 230, b - a + 4, 26);
  });
}, { aniso });

/* PCまくら木(上面: 中央は明るく、端ほどよごれる。レール座2つ) */
export const texPCSleeper = () => canvasTex(64, 16, (c) => {
  const R = rngOf(5);
  c.fillStyle = '#8f8b84'; c.fillRect(0, 0, 64, 16);
  const g = c.createLinearGradient(0, 0, 64, 0);
  g.addColorStop(0, 'rgba(60,54,46,0.45)'); g.addColorStop(0.2, 'rgba(60,54,46,0)');
  g.addColorStop(0.8, 'rgba(60,54,46,0)'); g.addColorStop(1, 'rgba(60,54,46,0.45)');
  c.fillStyle = g; c.fillRect(0, 0, 64, 16);
  speckle(c, 64, 16, 120, R, 0.1);
  c.fillStyle = '#4a4743'; c.fillRect(11, 2, 6, 12); c.fillRect(47, 2, 6, 12);
  c.fillStyle = 'rgba(0,0,0,0.25)'; c.fillRect(0, 0, 64, 1); c.fillRect(0, 15, 64, 1);
});

/* 犬走り(バラストの外の土と細かい砂利) */
export const texCess = (aniso) => canvasTex(128, 128, (c) => {
  const R = rngOf(77);
  c.fillStyle = '#b3a891'; c.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 26; i++) {
    c.fillStyle = R() < 0.5 ? 'rgba(120,104,80,0.35)' : 'rgba(200,192,176,0.3)';
    c.beginPath(); c.ellipse(R() * 128, R() * 128, 6 + R() * 16, 4 + R() * 10, R() * 3, 0, 7); c.fill();
  }
  const cols = ['#8e877b', '#c9c2b4', '#77706a', '#a39c90'];
  for (let i = 0; i < 1400; i++) { c.fillStyle = cols[(R() * 4) | 0]; c.fillRect(R() * 128, R() * 128, 1 + R() * 1.5, 1 + R() * 1.5); }
  for (let i = 0; i < 18; i++) { c.fillStyle = 'rgba(92,104,64,0.5)'; c.fillRect(R() * 128, R() * 128, 1, 3 + R() * 4); }
}, { aniso });

/* ケーブルトラフのふた(0.6mごとの継ぎ目) */
export const texTroughLid = () => canvasTex(32, 64, (c) => {
  const R = rngOf(9);
  c.fillStyle = '#aeaba3'; c.fillRect(0, 0, 32, 64);
  speckle(c, 32, 64, 160, R, 0.12);
  c.fillStyle = 'rgba(40,38,34,0.7)'; c.fillRect(0, 0, 32, 2);
  c.fillStyle = 'rgba(0,0,0,0.18)'; c.fillRect(0, 0, 2, 64); c.fillRect(30, 0, 2, 64);
  c.fillStyle = 'rgba(0,0,0,0.25)'; c.fillRect(14, 30, 4, 4);
});

/* 防音壁(2m×2.3m): 明るいパネル・継ぎ目・H形鋼の柱・下のほうのよごれ */
export const texSoundWall = (aniso) => canvasTex(256, 128, (c) => {
  const R = rngOf(31);
  c.fillStyle = '#d9d8d2'; c.fillRect(0, 0, 256, 128);
  speckle(c, 256, 128, 500, R, 0.05);
  for (let y = 28; y < 128; y += 28) {
    c.fillStyle = 'rgba(70,72,72,0.55)'; c.fillRect(0, y, 256, 2);
    c.fillStyle = 'rgba(255,255,255,0.35)'; c.fillRect(0, y + 2, 256, 1);
  }
  const g = c.createLinearGradient(0, 100, 0, 128);
  g.addColorStop(0, 'rgba(90,84,70,0)'); g.addColorStop(1, 'rgba(90,84,70,0.55)');
  c.fillStyle = g; c.fillRect(0, 100, 256, 28);
  for (let i = 0; i < 14; i++) { c.fillStyle = 'rgba(80,76,64,0.12)'; c.fillRect(R() * 256, 0, 1 + R() * 2, 20 + R() * 100); }
  c.fillStyle = '#8e959b'; c.fillRect(0, 0, 10, 128);
  c.fillStyle = 'rgba(0,0,0,0.35)'; c.fillRect(10, 0, 2, 128);
  c.fillStyle = 'rgba(255,255,255,0.25)'; c.fillRect(0, 0, 2, 128);
  c.fillStyle = 'rgba(40,40,40,0.25)'; c.fillRect(0, 0, 256, 3);
}, { aniso });

/* トンネルの壁(4m×6.7m): コンクリート・型枠の目地・ケーブル受け3段・床ぎわの湿り */
export const texTunnelWall = (aniso) => canvasTex(256, 128, (c) => {
  const R = rngOf(57);
  c.fillStyle = '#7d8184'; c.fillRect(0, 0, 256, 128);
  for (let i = 0; i < 24; i++) {
    c.fillStyle = R() < 0.5 ? 'rgba(0,0,0,0.035)' : 'rgba(255,255,255,0.03)';
    c.beginPath(); c.ellipse(R() * 256, R() * 128, 10 + R() * 30, 4 + R() * 10, 0, 0, 7); c.fill();
  }
  speckle(c, 256, 128, 900, R, 0.07);
  c.fillStyle = 'rgba(30,32,34,0.55)'; c.fillRect(0, 0, 3, 128);
  c.fillStyle = 'rgba(30,32,34,0.25)'; c.fillRect(0, 40, 256, 1); c.fillRect(0, 74, 256, 1);
  const dmp = c.createLinearGradient(0, 104, 0, 128);
  dmp.addColorStop(0, 'rgba(28,30,26,0)'); dmp.addColorStop(1, 'rgba(28,30,26,0.5)');
  c.fillStyle = dmp; c.fillRect(0, 104, 256, 24);
  const py = (h) => 128 - ((h + 0.5) * 128) / 6.7;
  [1.4, 1.7, 2.0].forEach((h, k) => {
    const y = py(h);
    /* ケーブルの束と受け金具 */
    c.fillStyle = '#2f3336'; c.fillRect(0, y - 2, 256, 4 + (k === 0 ? 2 : 0));
    c.fillStyle = 'rgba(20,22,24,0.9)'; c.fillRect(0, y + 2, 256, 2);
    for (let x = 4; x < 256; x += 16) { c.fillStyle = '#3c4144'; c.fillRect(x, y - 3, 2, 9); }
  });
}, { aniso });

/* 市街地の地面(64m四方): 舗装・敷地・駐車場・植え込み・マンホール */
export const texUrbanGround = (aniso) => canvasTex(512, 512, (c) => {
  const R = rngOf(41);
  c.fillStyle = '#74736e'; c.fillRect(0, 0, 512, 512);
  const lot = ['#8a8780', '#66676a', '#9a968c', '#7d7a72'];
  for (let i = 0; i < 40; i++) {
    const w = 30 + R() * 110, h = 30 + R() * 110, x = R() * 512, y = R() * 512;
    c.fillStyle = lot[(R() * 4) | 0]; wrapRect(c, 512, 512, x, y, w, h);
    c.fillStyle = 'rgba(40,40,38,0.18)';
    wrapRect(c, 512, 512, x, y, w, 1.5); wrapRect(c, 512, 512, x, y, 1.5, h);
  }
  for (let i = 0; i < 4; i++) {
    const x = R() * 512, y = R() * 512, w = 50 + R() * 60, h = 44 + R() * 24;
    c.fillStyle = '#6a6c6e'; wrapRect(c, 512, 512, x, y, w, h);
    c.fillStyle = 'rgba(232,232,226,0.42)';
    for (let xx = 0; xx <= w - 4; xx += 20) {
      wrapRect(c, 512, 512, x + xx, y + 2, 1, h * 0.4);
      wrapRect(c, 512, 512, x + xx, y + h * 0.58, 1, h * 0.4);
    }
  }
  for (let i = 0; i < 10; i++) {
    const w = 6 + R() * 22, h = 6 + R() * 14;
    c.fillStyle = '#4f5f3c'; wrapRect(c, 512, 512, R() * 512, R() * 512, w, h);
  }
  speckle(c, 512, 512, 3000, R, 0.08);
  for (let i = 0; i < 6; i++) {
    const x = 6 + R() * 500, y = 6 + R() * 500;
    c.fillStyle = '#4a4a48'; c.beginPath(); c.arc(x, y, 3, 0, 7); c.fill();
  }
}, { aniso });

/* 郊外の地面(48m四方): 乾いた庭土・砂利の敷地・生け垣・畑 */
export const texSuburbGround = (aniso) => canvasTex(512, 512, (c) => {
  const R = rngOf(43);
  c.fillStyle = '#6d7353'; c.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 40; i++) {
    c.fillStyle = R() < 0.5 ? 'rgba(120,112,80,0.25)' : 'rgba(70,84,52,0.25)';
    c.beginPath(); c.ellipse(R() * 512, R() * 512, 10 + R() * 40, 8 + R() * 30, R() * 3, 0, 7); c.fill();
  }
  const lots = ['#8d8a83', '#9a968c', '#7a7770', '#85827a'];
  for (let i = 0; i < 16; i++) {
    const w = 40 + R() * 80, h = 40 + R() * 60, x = R() * 512, y = R() * 512;
    c.fillStyle = lots[(R() * 4) | 0]; wrapRect(c, 512, 512, x, y, w, h);
    c.fillStyle = '#3f4d31';
    if (R() < 0.7) wrapRect(c, 512, 512, x, y - 5, w, 5);
    if (R() < 0.5) wrapRect(c, 512, 512, x - 5, y, 5, h);
  }
  for (let i = 0; i < 3; i++) {
    const w = 70 + R() * 50, h = 70 + R() * 50, x = R() * 512, y = R() * 512;
    c.fillStyle = '#6b5a45'; wrapRect(c, 512, 512, x, y, w, h);
    c.fillStyle = '#5a4a38';
    for (let yy = 2; yy < h; yy += 6) wrapRect(c, 512, 512, x, y + yy, w, 2);
    c.fillStyle = 'rgba(96,120,64,0.5)';
    for (let yy = 5; yy < h; yy += 12) wrapRect(c, 512, 512, x + 3, y + yy, w - 6, 1);
  }
  speckle(c, 512, 512, 2600, R, 0.07);
}, { aniso });

/* 家並みの屋根(64m四方。上から見た住宅地): 線路の140mより外の地面に貼る(本物の家を置かない遠く)。
 * 縦(v)=線路の向き。32mごとに幅4.5mの路地(白い外側線)、64mごとに横の道。路地のあいだに背中合わせの2列の家。
 * 屋根は town.js の家と同じ色(地面の頂点色で暗くなるぶん明るめに描く)、棟の線と日の当たる半分。
 * 1割は白・灰色の陸屋根のマンション(14×20m・パラペット)、すき間の1割強は庭木の緑 */
const ROOFSCAPE_COLS = ['#3a3d41', '#46423e', '#2e3236', '#574a3f', '#474e56', '#62564a', '#2f4a66', '#6e4634', '#55634f', '#8b5a42'];
const ROOFSCAPE_W = [2, 2, 2, 2, 2, 2, 1, 1.5, 1, 1];
export const texRoofscape = (aniso) => canvasTex(512, 512, (c) => {
  const R = rngOf(4747);
  const PX = 8;                                 // 1m = 8画素
  const lift = (hex, k) => {                    // 地面の頂点色(約0.46倍)で暗くなるぶん、見た目(sRGB)で明るく
    const n = parseInt(hex.slice(1), 16);
    const f = (v) => Math.min(255, Math.round(v * k));
    return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
  };
  const pickRoof = () => {
    let t = R() * ROOFSCAPE_W.reduce((a, b) => a + b, 0);
    for (let i = 0; i < ROOFSCAPE_COLS.length; i++) { t -= ROOFSCAPE_W[i]; if (t <= 0) return ROOFSCAPE_COLS[i]; }
    return ROOFSCAPE_COLS[0];
  };
  /* 地(庭・土間・砂利。手前の郊外・市街地の地面と平均の色がそろうように: 境目の140mで色がとばない) */
  c.fillStyle = '#7d7e66'; c.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 60; i++) {
    c.fillStyle = ['#737a58', '#86836f', '#8d8a7c', '#78765f'][(R() * 4) | 0];
    wrapRect(c, 512, 512, R() * 512, R() * 512, 20 + R() * 60, 20 + R() * 60);
  }
  /* 路地(縦・32mごと)と横の道(64mごと) */
  const LW = 4.5 * PX;
  const road = (x, y, w, h, vert) => {
    c.fillStyle = '#5d5f61'; c.fillRect(x, y, w, h);
    c.fillStyle = 'rgba(232,232,226,.85)';
    if (vert) { c.fillRect(x + 2, y, 1, h); c.fillRect(x + w - 3, y, 1, h); } else { c.fillRect(x, y + 2, w, 1); c.fillRect(x, y + h - 3, w, 1); }
  };
  [0, 256].forEach((x) => road(x, 0, LW, 512, true));
  road(0, 0, 512, LW, false);
  /* 家の列: ブロック(路地のあいだ 27.5m)に背中合わせの2列。表は路地のほう */
  const roofRect = (x, y, w, h, col, ridgeV) => {
    c.fillStyle = 'rgba(0,0,0,.28)'; c.fillRect(x + 2, y + 2, w, h);   // 影(右下)
    c.fillStyle = lift(col, 1.3); c.fillRect(x, y, w, h);
    c.fillStyle = 'rgba(255,255,255,.13)';
    if (ridgeV) c.fillRect(x, y, Math.floor(w / 2), h); else c.fillRect(x, y, w, Math.floor(h / 2));
    c.fillStyle = 'rgba(0,0,0,.35)';
    if (ridgeV) c.fillRect(x + Math.floor(w / 2), y, 1, h); else c.fillRect(x, y + Math.floor(h / 2), w, 1);
  };
  const block = (bx) => {
    const x0 = bx + LW, x1 = bx + 256;            // ブロックの横の範囲(画素)
    const mid = (x0 + x1) / 2;
    [[x0, 1], [x1, -1]].forEach(([edge, dir]) => {
      let y = LW + 2;
      while (y < 512 - 8 * PX) {
        if (R() < 0.035) {
          /* 陸屋根のマンション(14×20m) */
          const w = 14 * PX, h = 20 * PX;
          if (y + h > 512 - 2) break;
          const x = dir > 0 ? edge + 2 : edge - 2 - w;
          c.fillStyle = 'rgba(0,0,0,.3)'; c.fillRect(x + 3, y + 3, w, h);
          c.fillStyle = R() < 0.5 ? '#a8a8a2' : '#8f908b'; c.fillRect(x, y, w, h);
          c.fillStyle = 'rgba(255,255,255,.35)'; c.fillRect(x, y, w, 2); c.fillRect(x, y, 2, h);
          c.fillStyle = 'rgba(0,0,0,.18)'; c.fillRect(x, y + h - 2, w, 2); c.fillRect(x + w - 2, y, 2, h);
          c.fillStyle = 'rgba(0,0,0,.12)'; c.fillRect(x + w * 0.3, y + h * 0.2, 14, 10);
          y += h + 3 * PX;
          continue;
        }
        const fw = (7 + R() * 3) * PX, d = (7 + R() * 2) * PX, g = (1.5 + R() * 3) * PX;
        if (y + fw > 512 - 2) break;
        if (R() > 0.1) {
          const x = dir > 0 ? edge + g : edge - g - d;
          if (Math.abs(x + d / 2 - mid) < 110) roofRect(Math.round(x), Math.round(y + 0.6 * PX), Math.round(d), Math.round(fw - 1.2 * PX), pickRoof(), R() < 0.7);
        }
        /* 庭木 */
        if (R() < 0.14) {
          c.fillStyle = R() < 0.5 ? '#3d5331' : '#34482c';
          const tx = dir > 0 ? edge + g + d + 10 + R() * 12 : edge - g - d - 10 - R() * 12;
          c.beginPath(); c.arc(tx, y + R() * fw, 6 + R() * 8, 0, 7); c.fill();
        }
        y += fw;
      }
    });
  };
  block(0); block(256);
}, { aniso });

/* トンネルの出口の明るさ(上ほど少し明るい) */
/* グレーチング(0.5m角): 細い鋼の板が3cmごと、その直角に10cmごとの棒。すき間は暗い */
const texGrating = () => canvasTex(64, 64, (c) => {
  c.fillStyle = '#1d1f21'; c.fillRect(0, 0, 64, 64);
  c.fillStyle = '#6d7377';
  for (let x = 0; x < 64; x += 4) c.fillRect(x, 0, 2, 64);
  c.fillStyle = '#5a6064';
  for (let y = 0; y < 64; y += 13) c.fillRect(0, y, 64, 2);
  c.fillStyle = 'rgba(0,0,0,0.25)'; c.fillRect(0, 62, 64, 2);
});
const texGlowGrad = () => canvasTex(4, 64, (c) => {
  const g = c.createLinearGradient(0, 0, 0, 64);
  g.addColorStop(0, '#ffffff'); g.addColorStop(1, '#c8c8c8');
  c.fillStyle = g; c.fillRect(0, 0, 4, 64);
});

/* ---------------- 材質(一度だけ作って路線を作り直しても使い回す) ---------------- */
const srgbLin = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };

/* トンネルの壁: 灯具(12mごと・高さ4.2m。駅の担当の buildTunnelLights が s=12k+6 に置く)の光が
 * 壁を下へ扇形に照らすようすを、壁の材質の中で描く(加算の板を使わない=重ね塗りが減る)。
 * 壁の UV: x = 距離(m)/TUN_WALL_UV、y = 0(-0.5m)〜1(天井 TUN.H) */
export const TUN_WALL_UV = 4;
export const TUN_LAMP = { pitch: 12, phase: 6, y: 4.2 };
function tunnelWallMaterial(tex) {
  const m = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, side: THREE.DoubleSide, envMapIntensity: 0.5 });
  const f = (x) => x.toFixed(3);
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
#ifdef USE_MAP
  {
    float tS = vMapUv.x * ${f(TUN_WALL_UV)};
    float tD = ( fract( ( tS - ${f(TUN_LAMP.phase)} ) / ${f(TUN_LAMP.pitch)} + 0.5 ) - 0.5 ) * ${f(TUN_LAMP.pitch)};
    float tH = vMapUv.y * ${f(TUN.H + 0.5)} - 0.5;
    float tB = max( ${f(TUN_LAMP.y)} - tH, 0.0 ), tA = max( tH - ${f(TUN_LAMP.y)}, 0.0 );
    float tW = 0.9 + 0.75 * tB;
    float tF = exp( - tD * tD / ( 2.0 * tW * tW ) ) * exp( - tA * tA * 1.5 ) * exp( - tB * 0.35 );
    totalEmissiveRadiance += diffuseColor.rgb * ( 0.06 + 0.55 * tF );
  }
#endif`);
  };
  m.customProgramCacheKey = () => 'tunwall';
  return m;
}
/* 架線(トロリ線・吊架線・ハンガー・き電線)の線: 太さはメートル(近くでは太いケーブルに見える)。
 * 遠くで細くなりすぎて とぎれ・ちらつきが出ないよう、画面の上の太さを最低 lwA.y×uMinPx 画素にする
 * (uMinPx = 画素密度。トロリ線・き電線は1.15、吊架線は1.0・ハンガーは0.8で、それより細いところはうすくする)。
 * 線ごとの太さ(m)・最低の画素・うすくするか を 線分ごとの属性 lwA にもつ = 全部の線を1回で描ける */
function wireLineMaterial() {
  const m = new LineMaterial({ color: 0x3a3f44, worldUnits: true, linewidth: 0.014, transparent: true });
  m.fog = true;
  m.name = 'wire-line';
  const uMin = m.userData.minPx = { value: 1 };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uMinPx = uMin;
    sh.vertexShader = sh.vertexShader
      .replace('uniform float linewidth;', 'uniform float linewidth;\nuniform float uMinPx;\nattribute vec3 lwA;\nvarying float vLw;\nvarying float vCov;')
      .replace('float hw = linewidth * 0.5;', `float lwZ = max( - worldPos.z, 0.05 );
				float lwPx = 2.0 * lwZ / ( projectionMatrix[ 1 ][ 1 ] * resolution.y );
				float lwMin = uMinPx * lwA.y * lwPx;
				vLw = max( lwA.x, lwMin );
				vCov = lwA.z > 0.5 ? clamp( lwA.x / lwMin, 0.0, 1.0 ) : 1.0;
				float hw = vLw * 0.5;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('uniform float linewidth;', 'uniform float linewidth;\nvarying float vLw;\nvarying float vCov;')
      .replace('float norm = len / linewidth;', 'float norm = len / vLw;')
      .replace('vec4 diffuseColor = vec4( diffuse, alpha );', 'alpha *= vCov;\n\t\t\tvec4 diffuseColor = vec4( diffuse, alpha );');
  };
  m.customProgramCacheKey = () => 'line-wu';
  return m;
}
/* 線の材質に描画バッファの大きさと画素密度を教える(大きさが変わったときだけ。scene.js の _updateSleepers から) */
export function updateWireRes(rs, w, h, dpr) {
  const m = rs.M && rs.M.wireLine;
  if (!m) return;
  m.resolution.set(Math.max(1, w), Math.max(1, h));
  m.userData.minPx.value = Math.max(1, dpr || 1);
}

export function ensureTrackMats(rs, aniso = 4) {
  const M = rs.M;
  if (M.sleeperBand) return M;
  const DS = THREE.DoubleSide;
  const keep = (k, m) => { M[k] = m; rs._keep.add(m); if (m.map) rs._keep.add(m.map); return m; };
  keep('sleeperBand', new THREE.MeshStandardMaterial({ map: texSleeperBand(aniso), roughness: 1, side: DS, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }));
  keep('bridgeTie', new THREE.MeshStandardMaterial({ map: texBridgeTies(aniso), roughness: 0.95, alphaTest: 0.5, side: DS, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }));
  keep('slab', new THREE.MeshStandardMaterial({ map: rs.T.concC, color: 0x7a7873, roughness: 0.9, side: DS }));
  keep('drain', new THREE.MeshStandardMaterial({ color: 0x34332f, roughness: 0.95, side: DS, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }));
  keep('trough', new THREE.MeshStandardMaterial({ map: texTroughLid(), color: 0xc8c5be, roughness: 0.95, side: DS }));
  const gu = texUrbanGround(aniso); gu.repeat.set(1 / 64, 1 / 64);
  keep('groundUrban', new THREE.MeshStandardMaterial({ map: gu, vertexColors: true, roughness: 0.95, side: DS }));
  const gs = texSuburbGround(aniso); gs.repeat.set(1 / 48, 1 / 48);
  keep('groundSuburb', new THREE.MeshStandardMaterial({ map: gs, vertexColors: true, roughness: 1, side: DS }));
  keep('tunnelWall', tunnelWallMaterial(texTunnelWall(aniso)));
  /* トンネルの天井の帯: 壁と同じ材質の作り(同じシェーダ)で、色だけ暗く(灯具は壁にあるので天井は暗め) */
  keep('tunnelCeilW', tunnelWallMaterial(M.tunnelWall.map));
  M.tunnelCeilW.color.setHex(0xc4c4c4);
  /* トンネルの柱: 壁と同じコンクリートに、弱い自発光(真っ黒につぶれない。プログラムは M.tunnel と同じ)。
   * 天井の帯は壁の材質(tunwall)で描く(灯具の近くの天井のすみが照らされて、箱の形がわかる) */
  const tn = rs.M.tunnel;
  keep('tunnelCeil', new THREE.MeshStandardMaterial({
    map: tn.map, color: tn.color.clone(), roughness: tn.roughness, side: tn.side, envMapIntensity: tn.envMapIntensity, emissive: 0x15181b,
  }));
  keep('soundWall', new THREE.MeshStandardMaterial({ map: texSoundWall(aniso), color: 0xb3b1aa, roughness: 0.9, side: DS, envMapIntensity: 1.0 }));
  keep('catenary', new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.45, roughness: 0.55 }));
  keep('bracket', new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.3, roughness: 0.5 }));
  keep('truss', new THREE.MeshStandardMaterial({ color: 0x56756a, metalness: 0.3, roughness: 0.6 }));
  keep('pier', new THREE.MeshStandardMaterial({ map: rs.T.concC, color: 0xc9c6bd, roughness: 0.95 }));
  keep('deckSteel', new THREE.MeshStandardMaterial({ color: 0x3e4246, metalness: 0.4, roughness: 0.7, side: DS }));
  /* 橋の点検通路の床: 鋼のグレーチング(すのこ状の格子。UVは2mで1なので、1枚0.5mになるようにくり返す) */
  const gr = texGrating(); gr.repeat.set(4, 4);
  keep('deckGrate', new THREE.MeshStandardMaterial({ map: gr, color: 0x9aa0a4, metalness: 0.4, roughness: 0.7, side: DS }));
  keep('wire', new THREE.LineBasicMaterial({ color: 0x3a3f44 }));
  keep('wireLine', wireLineMaterial());
  /* 犬走りは土と細かい砂利に(地図だけ差し替え。材質の構成は変わらないので再コンパイルなし) */
  const ct = texCess(aniso); rs._keep.add(ct); M.sub.map = ct;
  /* 地面の材質は P4 の大きなムラ(マクロ)の対象 */
  [M.ground, M.bank, M.groundUrban, M.groundSuburb].forEach((m) => { m.userData.wxMacro = true; });
  /* 芝の地面(郊外の奥): UVをメートルにしたので1枚5mに */
  rs.T.grassC.repeat.set(1 / 4.92, 1 / 5);
  return M;
}

/* ---------------- 道床の区分(行ごと: 'bed'=バラスト, 'slab'=トンネル・ターミナルのコンクリ, 'deck'=橋) ---------------- */
export function bedRuns(rs) {
  if (rs._bedRunsFor === rs.line && rs._bedRuns) return rs._bedRuns;
  const step = rs.step, N = rs.frames.length - 1;
  const rivers = rs.line.sections.river;
  const typeAt = (s) => (rivers.some((r) => s >= r.from && s <= r.to) ? 'deck'
    : rs._inTunnel(s) || rs._inTerminal(s) ? 'slab' : 'bed');
  const runs = [];
  let cur = null;
  for (let q = 0; q < N; q++) {
    const ty = typeAt((q + 0.5) * step);
    if (!cur || cur.type !== ty) { cur = { type: ty, i0: q, i1: q + 1 }; runs.push(cur); } else cur.i1 = q + 1;
  }
  rs._bedRuns = runs; rs._bedRunsFor = rs.line;
  return runs;
}
/* 行の範囲 [i0,i1] のうち、条件を満たす行が続く区間に分ける */
export function rowRanges(i0, i1, ok) {
  const out = [];
  let a = null;
  for (let i = i0; i <= i1; i++) {
    if (ok(i)) { if (a === null) a = i; } else if (a !== null) { if (i - 1 > a) out.push([a, i - 1]); a = null; }
  }
  if (a !== null && i1 > a) out.push([a, i1]);
  return out;
}
const plus = (off, d) => (typeof off === 'function' ? (i) => off(i) + d : off + d);

/* ---------------- 道床・レール・枕木の帯・地面 ---------------- */
export function buildTrackBed(rs, o = {}) {
  const F = rs.frames, step = rs.step, N = F.length - 1;
  const qi = quadInfo(rs.line);
  const M = ensureTrackMats(rs, o.aniso);
  const FS = smoothFrames(F);
  rs._framesS = FS;
  const e0 = (i) => quadOffAt(i * step, 0, qi), e1 = (i) => quadOffAt(i * step, 1, qi);
  const add = (g, mat, recv = true) => { const m = new THREE.Mesh(g, mat); m.receiveShadow = recv; rs.world.add(m); return m; };
  const runs = bedRuns(rs);
  /* 行 i と i+1 のあいだが橋の上か */
  const deckQ = new Uint8Array(N + 1);
  runs.forEach((r) => { if (r.type === 'deck') for (let q = r.i0; q < r.i1; q++) deckQ[q] = 1; });

  /* 道床の断面: バラストの肩(1.3mののり面)+犬走り。複々線では左の肩が急行線の外へ広がる */
  const crestL = (i) => Math.max(1.65, e1(i) + 1.65);
  runs.forEach(({ type, i0, i1 }) => {
    if (type === 'bed') {
      add(profileRibbon(F, i0, i1, (i) => {
        const cl = crestL(i), tl = cl + 1.3;
        return [[tl, -0.33, tl / 4.2], [cl, 0, cl / 4.2], [-5.45, 0, -5.45 / 4.2], [-6.75, -0.33, -6.75 / 4.2]];
      }, { uvScale: 2.5, step }), M.ballast);
      add(profileRibbon(F, i0, i1, (i) => {
        const tl = crestL(i) + 1.3;
        return [[tl + 0.95, -0.39, (tl + 0.95) / 1.6], [tl, -0.335, tl / 1.6]];
      }, { uvScale: 1.6, step }), M.sub);
      add(profileRibbon(F, i0, i1, [[-6.75, -0.335, -6.75 / 1.6], [-8.2, -0.39, -8.2 / 1.6]], { uvScale: 1.6, step }), M.sub);
    } else if (type === 'slab') {
      /* トンネル・ターミナル: コンクリートの床+線路のあいだの排水溝 */
      const inTun = rs._inTunnel((i0 + i1) * 0.5 * step);
      const wl = inTun ? TUN.L : 2.2, wr = inTun ? TUN.R : -6.0;
      add(profileRibbon(F, i0, i1, [[wl, 0, wl / 3], [wr, 0, wr / 3]], { uvScale: 3, step }), M.slab);
      add(flatStrip(F, i0, i1, -1.9, 0.3, 0.004, 2, step), M.drain);
      if (inTun) {
        rowRanges(i0, i1, (i) => e0(i) > 2.5).forEach(([a, b]) => {
          add(flatStrip(F, a, b, (i) => e0(i) / 2, 0.3, 0.004, 2, step), M.drain);
          add(flatStrip(F, a, b, (i) => (e0(i) + e1(i)) / 2, 0.3, 0.004, 2, step), M.drain);
        });
      }
    }
  });

  /* レール: 頭面+両側の腹+底(フット) */
  /* side: 腹を両側に付けるか(0)、外側だけか(+1/-1。遠くを走る急行線は外側だけで十分) */
  const rail = (a, b, off, side = 0) => {
    add(flatStrip(F, a, b, off, 0.068, 0.19, 25, step), M.railHead);
    if (side >= 0) add(wallStrip(F, a, b, plus(off, 0.034), 0.05, 0.178, 8, step), M.railWeb);
    if (side <= 0) add(wallStrip(F, a, b, plus(off, -0.034), 0.05, 0.178, 8, step), M.railWeb);
    add(flatStrip(F, a, b, off, 0.127, 0.065, 25, step), M.railWeb);
  };
  /* 枕木の帯(3Dの枕木とちょうど重なる位置。橋の上は木のまくら木で、すき間から川が見える) */
  const band = (a, b, off) => {
    rowRanges(a, b, (i) => !(deckQ[i] && (i === 0 || deckQ[i - 1]))).forEach(([x, y]) => add(flatStrip(F, x, y, off, 2.0, 0.004, 0.625, step), M.sleeperBand));
    rowRanges(a, b, (i) => deckQ[i] || (i > 0 && deckQ[i - 1])).forEach(([x, y]) => add(flatStrip(F, x, y, off, 2.0, 0.006, 0.625, step), M.bridgeTie));
  };
  [0, -3.8].forEach((off) => {
    [-RAIL_HALF, RAIL_HALF].forEach((d) => rail(0, N, off + d));
    band(0, N, off);
  });
  [0, 1].forEach((k) => {
    const offk = k ? e1 : e0;
    rowRanges(0, N, (i) => quadSep(i * step, k, qi) >= 0.15).forEach(([a, b]) => {
      [-RAIL_HALF, RAIL_HALF].forEach((d) => rail(a, b, plus(offk, d), Math.sign(d)));
    });
    rowRanges(0, N, (i) => quadSep(i * step, k, qi) >= 2.0).forEach(([a, b]) => band(a, b, offk));
  });

  /* 地面: 区画の種類(都心・市街地=舗装 / 郊外=砂利と庭 / 丘陵=草)ごとに材質を分ける。川の前後は切る */
  const urban = rs.line.sections.urban;
  const kindAt = (s) => (urban.find((u) => s >= u.from && s < u.to) || { kind: 2 }).kind;
  /* 丘陵の芝: 緑をおさえて落ち着いた色に。黄みの色(#c9cdb4)をかけると逆に黄緑があざやかになるので、
   * 緑だけ少し弱く青を残した灰色をかける(写真の芝の彩度が 0.35 → 約0.22) */
  const grassTint = srgbLin(0xc4c3cc);
  /* 頂点色: ゆるい明暗のムラ(タイルのくり返しを目立たなくする)。舗装・庭は少し沈めた明るさに */
  const hash = (x) => { const h = Math.sin(x * 127.1 + 311.7) * 43758.5453; return h - Math.floor(h); };
  const vnoise = (x) => { const a = Math.floor(x), f = x - a, w = f * f * (3 - 2 * f); return hash(a) * (1 - w) + hash(a + 1) * w; };
  const gcol = (i, c, C) => {
    const s = i * step, u = c / (C - 1);
    const n = 0.9 + 0.07 * Math.sin(s * 0.013 + u * 2.1) * Math.sin(s * 0.0047 + 3.1) + 0.04 * Math.sin(s * 0.041 + u * 5.3);
    const patch = 0.8 + 0.3 * vnoise(s / 45 + c * 7.31);
    const k = kindAt(s);
    const t = k === 3 ? grassTint : k === 2 ? [0.6, 0.6, 0.6] : [0.55, 0.55, 0.55];
    const l = Math.pow(n * patch, 2.2);
    return [l * t[0], l * t[1], l * t[2]];
  };
  const cuts = rs.line.sections.river.map((r) => [r.from - 240, r.to + 240]);
  const inCut = (q) => cuts.some(([a, b]) => (q + 0.5) * step > a && (q + 0.5) * step < b);
  /* 140mより外を「家並みの屋根」にする所: 世田谷の低層住宅地(代々木上原の先〜和泉多摩川)・郊外と、丘陵では駅の前後500m。
   * 都心寄りの市街地は中高層と遠景のビルで埋まるので、いままでの舗装の地面のまま */
  const sts = rs.line.stations;
  const stS = (n) => { const st = sts.find((x) => x.name === n); return st ? st.s : null; };
  const sA = stS('代々木上原'), sB = stS('和泉多摩川');
  const lrLo = sA !== null && sB !== null ? Math.min(sA, sB) : 1e9, lrHi = sA !== null && sB !== null ? Math.max(sA, sB) : -1e9;
  const roofsAt = (s, k) => (k === 1 && s > lrLo && s < lrHi) || k === 2 || (k === 3 && sts.some((st) => Math.abs(st.s - s) < 500));
  const segs = [];
  let cur = null;
  for (let q = 0; q < N; q++) {
    if (inCut(q)) { cur = null; continue; }
    const sq = (q + 0.5) * step;
    const k = kindAt(sq);
    const mk = k <= 1 ? 0 : k === 2 ? 1 : 2;
    const rf = roofsAt(sq, k);
    if (!cur || cur.mk !== mk || cur.rf !== rf) { cur = { mk, rf, i0: q, i1: q + 1 }; segs.push(cur); } else cur.i1 = q + 1;
  }
  const gm = [M.groundUrban, M.groundSuburb, M.ground];
  /* 家並みの屋根の地面(groundUrban と同じ作り=同じシェーダ)。路線を作り直しても使い回す */
  if (!M.groundRoofs) {
    const tr = texRoofscape(o.aniso || 4); tr.repeat.set(1 / 64, 1 / 64);
    M.groundRoofs = new THREE.MeshStandardMaterial({ map: tr, vertexColors: true, roughness: 0.95, side: THREE.DoubleSide });
    M.groundRoofs.userData.wxMacro = true;
    rs._keep.add(M.groundRoofs); rs._keep.add(tr);
  }
  const gcolR = (i, c, C) => { const v = gcol(i, c, C); return [v[0] * 1.1, v[1] * 1.1, v[2] * 1.1]; };
  /* 家並みの屋根の帯は三角形が少ない(10mごとに2列)ので、約3kmごと・両側を1つのメッシュにまとめる
   * (750mごとの帯の結合にかけると、前方の見える範囲だけで4回ほど描くことになる) */
  const BLK = Math.round(3000 / step);
  const roofBlocks = new Map();
  segs.forEach(({ mk, rf, i0, i1 }) => {
    [1, -1].forEach((side) => {
      const sh = side > 0 ? e1 : null;
      if (!rf) { add(groundStrip(F, FS, i0, i1, side, { step, shift: sh, vcol: gcol }), gm[mk]); return; }
      add(groundStrip(F, FS, i0, i1, side, { step, shift: sh, vcol: gcol, cols: [0, 5] }), gm[mk]);
      for (let a = i0; a < i1;) {
        const b = Math.min(i1, (Math.floor(a / BLK) + 1) * BLK);
        if (b - a >= 2) {
          const k = Math.floor(a / BLK);
          if (!roofBlocks.has(k)) roofBlocks.set(k, []);
          roofBlocks.get(k).push(groundStrip(F, FS, a, b, side, { step, shift: sh, vcol: gcolR, cols: [5, 7] }));
        }
        a = b;
      }
    });
  });
  roofBlocks.forEach((list) => {
    const g = mergeIndexed(list);
    g.userData.noMerge = true;
    const m = add(g, M.groundRoofs);
    m.userData.cullCell = true;
  });
}

/* 添字つきの形(同じ属性)を1つにまとめる(家並みの屋根の帯用) */
function mergeIndexed(list) {
  const names = Object.keys(list[0].attributes);
  let nv = 0, ni = 0;
  list.forEach((g) => { nv += g.attributes.position.count; ni += g.index.count; });
  const out = new THREE.BufferGeometry();
  names.forEach((nm) => {
    const it = list[0].attributes[nm].itemSize;
    const arr = new Float32Array(nv * it);
    let o = 0;
    list.forEach((g) => { arr.set(g.attributes[nm].array, o); o += g.attributes[nm].array.length; });
    out.setAttribute(nm, new THREE.BufferAttribute(arr, it));
  });
  const idx = new Uint32Array(ni);
  let k = 0, base = 0;
  list.forEach((g) => {
    const src = g.index.array;
    for (let i = 0; i < src.length; i++) idx[k++] = src[i] + base;
    base += g.attributes.position.count;
    g.dispose();
  });
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

/* ---------------- 小さな部材を1つの形にまとめる道具 ---------------- */
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
/* 両端のふたのない角材(長さ方向=Z)。細い部材はふたが見えないので三角形を節約 */
const UNIT_TUBE = (() => {
  const g = new THREE.BufferGeometry();
  ['position', 'normal', 'uv'].forEach((k) => {
    const a = UNIT_BOX.attributes[k];
    g.setAttribute(k, new THREE.BufferAttribute(a.array.slice(0, 24 * a.itemSize), a.itemSize));
  });
  return g;
})();
const _v = new THREE.Vector3(), _n = new THREE.Vector3(), _nm = new THREE.Matrix3();
const _X = new THREE.Vector3(), _Y = new THREE.Vector3(), _Z = new THREE.Vector3(), _mid = new THREE.Vector3();
const newAcc = () => ({ pos: [], nor: [], col: [], uv: [] });
function accGeo(acc, g, m4, col) {
  const P = g.attributes.position.array, Nn = g.attributes.normal.array, U = g.attributes.uv && g.attributes.uv.array;
  _nm.getNormalMatrix(m4);
  for (let i = 0, j = 0; i < P.length; i += 3, j += 2) {
    _v.set(P[i], P[i + 1], P[i + 2]).applyMatrix4(m4);
    _n.set(Nn[i], Nn[i + 1], Nn[i + 2]).applyMatrix3(_nm).normalize();
    acc.pos.push(_v.x, _v.y, _v.z); acc.nor.push(_n.x, _n.y, _n.z);
    if (col) acc.col.push(col.r, col.g, col.b);
    acc.uv.push(U ? U[j] : 0, U ? U[j + 1] : 0);
  }
}
function accToGeometry(acc, { color = true, uv = false } = {}) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(acc.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(acc.nor, 3));
  if (color) g.setAttribute('color', new THREE.Float32BufferAttribute(acc.col, 3));
  if (uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(acc.uv, 2));
  g.computeBoundingSphere();
  return g;
}
/* a→b を結ぶ角材(断面 w×h)の行列。hint は断面の w 方向のめやす */
function barMatrix(a, b, w, h, hint, out) {
  _Z.subVectors(b, a);
  const len = _Z.length() || 1e-6;
  _Z.divideScalar(len);
  _X.copy(hint);
  if (Math.abs(_X.dot(_Z)) > 0.9) { if (Math.abs(_Z.y) < 0.9) _X.crossVectors(UPV, _Z); else _X.set(1, 0, 0); }
  _X.addScaledVector(_Z, -_X.dot(_Z)).normalize();
  _Y.crossVectors(_Z, _X);
  _mid.addVectors(a, b).multiplyScalar(0.5);
  return out.makeBasis(_X.multiplyScalar(w), _Y.multiplyScalar(h), _Z.multiplyScalar(len)).setPosition(_mid);
}
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const AX = V3(1, 0, 0), AZ = V3(0, 0, 1);
function accBar(acc, a, b, w, h, hint, col) { accGeo(acc, UNIT_TUBE, barMatrix(a, b, w, h, hint, new THREE.Matrix4()), col); }
function accBox(acc, cx, cy, cz, sx, sy, sz, col) {
  accGeo(acc, UNIT_BOX, new THREE.Matrix4().makeScale(sx, sy, sz).setPosition(cx, cy, cz), col);
}
/* 円柱(a→b、半径r、6角) */
function accCyl(acc, a, b, r, col, caps = false, seg = 6) {
  const g = new THREE.CylinderGeometry(r, r, 1, seg, 1, !caps).toNonIndexed();
  g.rotateX(Math.PI / 2);   // 長さ方向を +Z に
  accGeo(acc, g, barMatrix(a, b, 1, 1, AX, new THREE.Matrix4()), col);
}

/* ---------------- 分岐器(急行線が分かれる・合わさるところ) ----------------
 * 急行線(k=0: 自線から / k=1: くだり急行から)が分かれはじめるところに、
 * ・長い枕木(帯: 分かれていく線路の下まで枕木の帯をのばす。3Dの枕木は _updateSleepers で長くする)
 * ・トングレール(先が細くなった可動レール)と、外へ曲がっていく基本レール
 * ・クロッシング(レールが交わるところ: 暗い床板・ノーズ・翼レール)と、反対がわのガードレール
 * ・転てつ機の箱と動かす棒
 * を置く。道床(buildTrackBed)は描きかえない。分かれる側・合わさる側(dir=-1)とも同じ作り。
 * 描画は1か所につき2回(レールの頭 / それ以外)。 */
export function buildTurnouts(rs) {
  const F = rs.frames, step = rs.step, N = F.length - 1;
  const qi = quadInfo(rs.line);
  if (!qi || !(qi.b1 > qi.a0)) return;
  const M = ensureTrackMats(rs);
  const RH = RAIL_HALF;
  const offK = (s, k) => quadOffAt(s, k, qi);
  const baseK = (s, k) => (k ? quadOffAt(s, 0, qi) : 0);
  const sepK = (s, k) => quadSep(s, k, qi);
  /* 1) 分岐の下の長い枕木の帯: もとの線路の帯の左はし(base+1m)から、分かれる線路の左はし(off+1m)まで。
   * 帯の模様(枕木の長さ2m)がつながるよう u はもとの帯の続き */
  [0, 1].forEach((k) => {
    rowRanges(0, N, (i) => { const sp = sepK(i * step, k); return sp >= 0.15 && sp < 2.0; }).forEach(([a, b]) => {
      if (a > 0 && sepK((a - 1) * step, k) >= 2.0) a--;
      if (b < N && sepK((b + 1) * step, k) >= 2.0) b++;
      const g = profileRibbon(F, a, b, (i) => {
        const s = i * step, bo = baseK(s, k), o = offK(s, k);
        return [[o + 1.0, 0.004, -(o - bo) / 2], [bo + 1.0, 0.004, 0]];
      }, { uvScale: 0.625, step });
      const m = new THREE.Mesh(g, M.sleeperBand);
      m.receiveShadow = true;
      rs.world.add(m);
    });
  });
  /* 2) 金物 */
  const fr = newFrame();
  const P = (s, lat, y) => { frameInto(F, step, s, fr); return new THREE.Vector3().copy(fr.p).addScaledVector(fr.left, lat).setY(fr.p.y + y); };
  const LEFT = (s) => { frameInto(F, step, s, fr); return fr.left.clone(); };
  const cDark = new THREE.Color(0x2a2b2d), cWeb = new THREE.Color(0x5a4c40), cBox = new THREE.Color(0x6f7478), cRod = new THREE.Color(0x4a4d50);
  const sites = [[qi.a0, Math.min(qi.a1 + 10, qi.b1), 1], [Math.max(qi.b0 - 10, qi.a0), qi.b1, -1]];
  sites.forEach(([s0, s1, dir]) => {
    const head = newAcc(), dark = newAcc();
    /* 頭(上面 0.19m)の角材 / 腹・床板などの角材 */
    const hBar = (sa, la, sb, lb, w, top) => accBar(head, P(sa, la, top - 0.01), P(sb, lb, top - 0.01), w, 0.02, LEFT(sa), null);
    const dBar = (sa, la, sb, lb, w, y, h, col) => accBar(dark, P(sa, la, y), P(sb, lb, y), w, h, LEFT(sa), col);
    [0, 1].forEach((k) => {
      /* 外のはしから内へたどって、間隔がしきい値をこえる位置 */
      const cross = (th) => {
        if (dir > 0) { for (let s = s0; s < s1; s += 0.05) if (sepK(s, k) >= th) return s; }
        else { for (let s = s1; s > s0; s -= 0.05) if (sepK(s, k) >= th) return s; }
        return null;
      };
      const sTip = cross(0.04), sBend = cross(0.07), sToe = cross(0.15), sFrog = cross(2 * RH);
      if (sTip == null || sToe == null || sFrog == null) return;
      /* 分かれる線路のレール(道床の担当の帯)が描かれはじめる行 */
      const sR = dir > 0 ? Math.ceil(sToe / step) * step : Math.floor(sToe / step) * step;
      const n = Math.max(2, Math.ceil(Math.abs(sR - sTip) / 0.5));
      /* (a) トングレール: もとの線路の右レールの内がわにぴったりつく細い先から、分かれる線路の右レールへ */
      const bladeAt = (s) => {
        const sp = sepK(s, k), w = Math.min(0.068, Math.max(0.012, 2 * (sp - 0.034)));
        return [baseK(s, k) - RH + Math.max(sp, 0.034 + w / 2), w];
      };
      for (let j = 0; j < n; j++) {
        const sa = sTip + ((sR - sTip) * j) / n, sb = sTip + ((sR - sTip) * (j + 1)) / n;
        const [la, wa] = bladeAt(sa), [lb, wb] = bladeAt(sb);
        hBar(sa, la, sb, lb, (wa + wb) / 2, 0.19);
        dBar(sa, la, sb, lb, 0.016, 0.11, 0.13, cWeb);
      }
      /* 外へ曲がっていく基本レール(分かれる線路の左レール)の、帯が描かれる前の部分 */
      if (sBend != null) {
        const m2 = Math.max(2, Math.ceil(Math.abs(sR - sBend) / 0.5));
        for (let j = 0; j < m2; j++) {
          const sa = sBend + ((sR - sBend) * j) / m2, sb = sBend + ((sR - sBend) * (j + 1)) / m2;
          hBar(sa, offK(sa, k) + RH, sb, offK(sb, k) + RH, 0.068, 0.19);
          dBar(sa, offK(sa, k) + RH, sb, offK(sb, k) + RH, 0.016, 0.11, 0.13, cWeb);
        }
      }
      /* (b) クロッシング: 分かれる線路の右レールが、もとの線路の左レールと交わるところ */
      const xF = baseK(sFrog, k) + RH;
      dBar(sFrog - 2, xF, sFrog + 2, xF, 0.4, 0.07, 0.03, cDark);                 // 床板
      dBar(sFrog - 1.35, xF, sFrog + 1.35, xF, 0.18, 0.186, 0.012, cDark);        // 交わるところのふた(ちらつき止め)
      hBar(sFrog + dir * 0.1, xF, sFrog + dir * 1.9, xF, 0.05, 0.197);              // ノーズ
      [-1, 1].forEach((sd) => hBar(sFrog - dir * 1.6, xF + sd * 0.085, sFrog + dir * 1.4, xF + sd * 0.1, 0.04, 0.196));   // 翼レール
      /* (c) ガードレール(6m): もとの線路の右レールと、分かれる線路の左レールの内がわ */
      hBar(sFrog - 3, baseK(sFrog - 3, k) - RH + 0.113, sFrog + 3, baseK(sFrog + 3, k) - RH + 0.113, 0.05, 0.185);
      hBar(sFrog - 3, offK(sFrog - 3, k) + RH - 0.113, sFrog + 3, offK(sFrog + 3, k) + RH - 0.113, 0.05, 0.185);
      /* (d) 転てつ機(もとの線路の外がわ1.7m)と、トングレールを動かす棒 */
      const bo = baseK(sToe, k), side = k ? 1 : -1;
      accBar(dark, P(sToe - 0.5, bo + side * 1.7, 0.2), P(sToe + 0.5, bo + side * 1.7, 0.2), 0.35, 0.3, LEFT(sToe), cBox);
      const sRod = sTip + dir * 0.6, bR = baseK(sRod, k);
      dBar(sRod, bR + side * 1.52, sRod, bR - RH + 0.15, 0.04, 0.09, 0.04, cRod);
    });
    if (!head.pos.length) return;
    const hg = accToGeometry(head, { color: false, uv: true });
    hg.attributes.uv.array.fill(0.5);
    const hm = new THREE.Mesh(hg, M.railHead);
    hm.receiveShadow = true; hm.userData.noMerge = true;
    rs.world.add(hm);
    const dg = accToGeometry(dark);
    const dm = new THREE.InstancedMesh(dg, M.bracket, 1);
    dm.setMatrixAt(0, new THREE.Matrix4());
    dm.receiveShadow = true; dm.userData.noSplit = true;
    dm.computeBoundingSphere();
    rs.world.add(dm);
  });
}

/* ---------------- 架線: 門型ビーム・可動ブラケット・トロリ線 ---------------- */
const BRK = {
  normal: { top: 6.9, pipeBot: 5.75, msgY: 6.15, wireY: 5.1 },
  tunnel: { top: 6.2, pipeBot: 5.55, msgY: 5.85, wireY: 5.1 },
  /* ターミナル: トロリ線は外と同じ高さ(とまっている電車のパンタグラフのすぐ上)。吊り下げ管を天井(7.4m)まで */
  term: { top: 7.35, pipeBot: 5.75, msgY: 6.15, wireY: 5.1 },
};
const brkDX = (b) => Math.sqrt(Math.max(0.04, 1.1 * 1.1 - (b.pipeBot - b.wireY) ** 2));
/* き電線・配電線: 柱から外へ 0.45 / 0.9m、高さ7.4m(がいしの上)。径間で0.55mたるむ */
const FEEDER_DX = [0.45, 0.9], FEEDER_Y = 7.4, FEEDER_SAG = 0.55;
/* ターミナルの外側の線路(駅の担当の TR_L / TR_R と同じ: ホームのうしろ+へり) */
const TERM_TR = { tl: 5.0 + 1.58, tr: -8.8 - 1.58 };

/* 門型ビーム(柱2本+ワーレントラスの梁)。x=横(+左), y=上, z=線路方向 */
function gantryGeo(xL, xR) {
  const acc = newAcc();
  const steel = new THREE.Color(0x9a9c98), dark = new THREE.Color(0x7f8280), conc = new THREE.Color(0xa8a59d);
  for (const x of [xL, xR]) {
    accBox(acc, x, 3.55, 0, 0.30, 7.4, 0.24, steel);           // H形鋼の柱
    accBox(acc, x, -0.4, 0, 0.72, 0.5, 0.62, conc);            // 基礎
  }
  const x0 = xR - 0.12, x1 = xL + 0.12, yb = 6.635, yt = 7.165, zz = 0.225;
  for (const z of [-zz, zz]) for (const y of [yb, yt]) accBar(acc, V3(x0, y, z), V3(x1, y, z), 0.07, 0.07, AZ, steel);
  const n = Math.max(4, Math.round((x1 - x0) / 1.0)), P = (x1 - x0) / n;
  for (let j = 0; j < n; j++) {
    const xa = x0 + j * P, xb = xa + P, up = j % 2 === 0;
    for (const z of [-zz, zz]) accBar(acc, V3(xa, up ? yb : yt, z), V3(xb, up ? yt : yb, z), 0.045, 0.045, AZ, steel);
    if (j % 4 === 0) {
      accBar(acc, V3(xa, yt, -zz), V3(xa, yt, zz), 0.04, 0.04, AX, steel);
      accBar(acc, V3(xa, yb, -zz), V3(xa, yb, zz), 0.04, 0.04, AX, steel);
    }
  }
  /* 梁の両端の取付け板 */
  for (const x of [x0, x1]) accBar(acc, V3(x, yb - 0.05, 0), V3(x, yt + 0.05, 0), 0.06, 0.56, AX, dark);
  /* 柱の上の腕(外向き1m)と、き電線・配電線をささえる茶色のがいし2個 */
  const ins = new THREE.Color(0x6b3f2a);
  for (const x of [xL, xR]) {
    const side = Math.sign(x) || 1;
    accBar(acc, V3(x, 7.18, 0), V3(x + side * 1.0, 7.18, 0), 0.08, 0.08, AZ, steel);
    for (const d of FEEDER_DX) accBox(acc, x + side * d, (7.22 + FEEDER_Y) / 2, 0, 0.13, FEEDER_Y - 7.22, 0.13, ins);
  }
  return accToGeometry(acc);
}

/* 可動ブラケット: 吊り下げ管・がいし(茶色)・吊架線の受け・曲線引き(トロリ線を横に引く腕) */
function bracketGeo(b) {
  const acc = newAcc();
  const steel = new THREE.Color(0x7d8287), ins = new THREE.Color(0x6b3f2a);
  const DX = brkDX(b);
  /* 吊り下げ管(太さ約8cm)と、懸垂がいし3連(直径約22cm・茶色の磁器) */
  accCyl(acc, V3(0, b.top + 0.05, 0), V3(0, b.pipeBot, 0), 0.04, steel, false, 6);
  for (let k = 0; k < 3; k++) {
    const y = b.top - 0.17 - k * 0.085;
    accCyl(acc, V3(0, y - 0.03, 0), V3(0, y + 0.03, 0), 0.11, ins, true, 6);
  }
  accBar(acc, V3(0, b.msgY, 0), V3(DX + 0.05, b.msgY, 0), 0.055, 0.055, AZ, steel);
  for (let k = 0; k < 3; k++) {
    const x = 0.14 + k * 0.08;
    accCyl(acc, V3(x - 0.025, b.msgY, 0), V3(x + 0.025, b.msgY, 0), 0.085, ins, true, 6);
  }
  accBar(acc, V3(0, b.pipeBot, 0), V3(DX, b.wireY, 0), 0.045, 0.045, AZ, steel);
  accBar(acc, V3(DX - 0.05, b.wireY + 0.02, 0), V3(DX + 0.05, b.wireY + 0.02, 0), 0.06, 0.06, AZ, steel);
  return accToGeometry(acc);
}

/* 多摩川橋梁の径間割り(約60mのトラスを並べる。パネルは約7.5m) */
export function bridgeLayout(r) {
  const len = r.to - r.from;
  const n = Math.max(1, Math.round(len / 62)), SL = len / n;
  const np = Math.max(4, Math.round(SL / 7.5)), P = SL / np;
  const spans = [], top = [];
  for (let j = 0; j < n; j++) {
    const a = r.from + j * SL;
    spans.push({ a, b: a + SL, P, np });
    for (let k = 0; k < np; k++) top.push(a + P * (k + 0.5));
  }
  return { spans, top };
}

/* 門型ビームの種類: 急行線が少しでも分かれていれば4線用(左の柱は上り急行の外) */
export function gantryVariant(s, inStation, qi = curQI) {
  return quadOffAt(s, 1, qi) > 0.3 ? 'quad' : inStation ? 'station' : 'double';
}
export const GANTRY_POLES = { double: [POLE.L, POLE.R], station: [POLE.stL, POLE.stR], quad: [POLE.quadL, POLE.R] };
const sameSpan = POLE.L === POLE.stL && POLE.R === POLE.stR;

export function buildCatenary(rs, o = {}) {
  const F = rs.frames, step = rs.step, L = rs.line.meta.length, qi = quadInfo(rs.line);
  const M = ensureTrackMats(rs, o.aniso);
  const T = rs.terminal;
  const bl = rs.line.sections.river.map((r) => ({ r, lay: bridgeLayout(r) }));
  const inStation = (s) => rs.line.stations.some((st) => s > st.s - 160 && s < st.s + 20);
  const nearCross = (s) => (rs.crossSpots || []).some((c) => Math.abs(c - s) < 9);
  /* トンネルの中と、坑口の外3mまで。坑口の面ちょうどの支持点を門型にすると、梁が坑口に埋まって柱だけ口の中に立つ */
  const inTunnel3 = (s) => rs.line.sections.tunnel.some((t) => s > t.from - 3 && s < t.to + 3);
  /* 階段のある駅(橋上駅舎・跨線橋): 階段の上のほう(屋根が梁の高さに届くところ)には門型ビームを立てない */
  const sty = stationStyles(rs);
  const stairAt = (s) => {
    for (let i = 0; i < rs.line.stations.length; i++) {
      const st = rs.line.stations[i];
      /* 近いほうへ逃がす(となりの支持点との間が60mをこえると架線が張れないので、ずらすのは9mまで) */
      if (sty[i].kind !== 'house' && s > st.s - STAIR.top - 2 && s < st.s - STAIR.foot - 4.5) {
        return s < st.s - 136 ? st.s - STAIR.top - 4 : st.s - STAIR.foot + 1.6;
      }
    }
    return null;
  };
  /* 1) 支持点(約45mごと) */
  const sup = [];
  for (let s0 = 20; s0 < L - 20; s0 += 45) {
    let s = s0, type = 'gantry', dy = 0;
    const b = bl.find(({ r }) => s0 > r.from - 6 && s0 < r.to + 6);
    if (b) {
      /* 橋の上: いちばん近いトラスの上横桁からぶら下げる */
      s = b.lay.top.reduce((best, x) => (Math.abs(x - s0) < Math.abs(best - s0) ? x : best), b.lay.top[0]);
      type = 'bridge'; dy = 0.3;
    } else if (inTunnel3(s0)) type = 'tunnel';
    else if (T && s0 > T.a && s0 < T.b) type = 'terminal';
    else if (nearCross(s0)) s = s0 + 12;
    if (type === 'gantry') { const sa = stairAt(s); if (sa !== null) s = sa; }
    sup.push({ s, type, dy, k: sup.length });
  }
  /* 2) 門型ビームと、線路ごとのブラケット */
  const fr = newFrame();
  const m4 = new THREE.Matrix4(), bx = new THREE.Vector3(), by = new THREE.Vector3(), bz = new THREE.Vector3(), pp = new THREE.Vector3();
  const gList = { double: [], station: [], quad: [] };
  const bList = { normal: [], tunnel: [], term: [] }, bS = { normal: [], tunnel: [], term: [] };
  const offOf = (key, s) => (key === 'own' ? 0 : key === 'up' ? -3.8 : key === 'tl' || key === 'tr' ? TERM_TR[key] : quadOffAt(s, key === 'q0' ? 0 : 1, qi));
  sup.forEach((sp) => {
    frameInto(F, step, sp.s, fr);
    const keys = ['own', 'up'];
    if (sp.type !== 'terminal') { if (quadSep(sp.s, 0, qi) >= 2.5) keys.push('q0'); if (quadSep(sp.s, 1, qi) >= 2.5) keys.push('q1'); }
    /* ターミナル: 外側の2線(発車を待つ電車のパンタグラフの上)にも架線を張る */
    else keys.push('tl', 'tr');
    if (sp.type === 'gantry') {
      const v0 = gantryVariant(sp.s, inStation(sp.s), qi);
      const v = sameSpan && v0 === 'station' ? 'double' : v0;
      sp.v = v;   // き電線の位置(柱の位置)に使う
      gList[v].push({ m: m4.makeBasis(fr.left, UPV, fr.t).setPosition(fr.p).clone(), s: sp.s });
    }
    const bv = sp.type === 'tunnel' ? 'tunnel' : sp.type === 'terminal' ? 'term' : 'normal';
    const B = BRK[bv], DX = brkDX(B);
    const zig = sp.k % 2 ? 0.2 : -0.2;
    sp.w = {};
    keys.forEach((key) => {
      const wx = offOf(key, sp.s) + zig;
      const dir = zig > 0 ? 1 : -1;   // 腕を伸ばす向き(+左)
      bx.copy(fr.left).multiplyScalar(dir); by.copy(UPV); bz.copy(fr.t).multiplyScalar(dir);
      pp.copy(fr.p).addScaledVector(fr.left, wx - dir * DX); pp.y += sp.dy;
      bList[bv].push(m4.makeBasis(bx, by, bz).setPosition(pp).clone());
      bS[bv].push(sp.s);
      sp.w[key] = { zig, wy: B.wireY + sp.dy, my: B.msgY + sp.dy };
    });
  });
  const shadows = !!o.shadows;
  /* 門型ビームは450mごとのまとまりにして、カメラから約800m以内だけ描く(遠くは霧でほとんど見えない) */
  rs._brkCells = [];
  [['double', POLE.L, POLE.R], ['station', POLE.stL, POLE.stR], ['quad', POLE.quadL, POLE.R]].forEach(([k, xl, xr]) => {
    if (!gList[k].length) return;
    const geo = gantryGeo(xl, xr);
    const cells = new Map();
    gList[k].forEach((g) => {
      const c = Math.floor(g.s / 450);
      if (!cells.has(c)) cells.set(c, []);
      cells.get(c).push(g);
    });
    cells.forEach((list, c) => {
      const im = new THREE.InstancedMesh(geo, M.catenary, list.length);
      list.forEach((g, i) => im.setMatrixAt(i, g.m));
      im.castShadow = shadows;
      im.userData.noSplit = true;
      im.computeBoundingSphere();
      rs.world.add(im);
      rs._brkCells.push({ mesh: im, s0: c * 450, s1: c * 450 + 450, r: 800, sList: list.map((g) => g.s) });
    });
  });
  /* ブラケットは小さいので、カメラから約400m以内の区間だけ描く(300mごとのまとまり) */
  [['normal', bracketGeo(BRK.normal)], ['tunnel', bracketGeo(BRK.tunnel)], ['term', bracketGeo(BRK.term)]].forEach(([k, geo]) => {
    const cells = new Map();
    bList[k].forEach((m, i) => {
      const c = Math.floor(bS[k][i] / 300);
      if (!cells.has(c)) cells.set(c, []);
      cells.get(c).push(m);
    });
    cells.forEach((list, c) => {
      const im = new THREE.InstancedMesh(geo, M.bracket, list.length);
      list.forEach((m, i) => im.setMatrixAt(i, m));
      im.castShadow = shadows;
      im.userData.noSplit = true;
      im.computeBoundingSphere();
      rs.world.add(im);
      rs._brkCells.push({ mesh: im, s0: c * 300, s1: c * 300 + 300, r: 420 });
    });
  });

  /* 3) トロリ線(ジグザグ)・吊架線(径間でたるむ)・ハンガー(約5.6mごと)・き電線。
   * 径間を8つに分けてなめらかに。約700mごとに1つの線のまとまり(描画1回)。
   * 線分ごとに [太さm, 最低の画素(×画素密度), うすくするか] をもつ */
  const W_CONTACT = [0.014, 1.15, 0], W_MSG = [0.012, 1.0, 1], W_DROP = [0.006, 0.8, 1], W_FEED = [0.02, 1.15, 0];
  const NSEG = 8;
  const chunks = new Map();
  const P = new THREE.Vector3();
  const pt = (s, x, y) => { frameInto(F, step, s, fr); return P.copy(fr.p).addScaledVector(fr.left, x).setY(fr.p.y + y).toArray(); };
  for (let j = 0; j + 1 < sup.length; j++) {
    const a = sup[j], b = sup[j + 1];
    if (b.s - a.s > 60) continue;
    const ck = Math.floor(a.s / 700);
    let ch = chunks.get(ck);
    if (!ch) { ch = { pos: [], lw: [] }; chunks.set(ck, ch); }
    const seg = (p, q, w) => { ch.pos.push(p[0], p[1], p[2], q[0], q[1], q[2]); ch.lw.push(w[0], w[1], w[2]); };
    Object.keys(a.w).forEach((key) => {
      const wa = a.w[key], wb = b.w[key];
      if (!wb) return;
      const gap = Math.min(wa.my - wa.wy, wb.my - wb.wy);
      const sag = 0.45 * Math.min(1, Math.max(0, (gap - 0.3) / 0.75));
      let pc = null, pm = null;
      for (let k = 0; k <= NSEG; k++) {
        const t = k / NSEG, s = a.s + (b.s - a.s) * t;
        const x = offOf(key, s) + wa.zig + (wb.zig - wa.zig) * t;
        const c = pt(s, x, wa.wy + (wb.wy - wa.wy) * t);
        const m = pt(s, x, wa.my + (wb.my - wa.my) * t - sag * 4 * t * (1 - t));
        if (pc) { seg(pc, c, W_CONTACT); seg(pm, m, W_MSG); }
        if (k > 0 && k < NSEG && m[1] - c[1] > 0.05) seg(m, c, W_DROP);
        pc = c; pm = m;
      }
    });
    /* き電線・配電線(左右の柱の上の腕から2本ずつ。門型ビームどうしの径間だけ。放物線にたるむ) */
    if (a.type === 'gantry' && b.type === 'gantry' && a.v && b.v) {
      for (let side = 0; side < 2; side++) {
        const out = side ? -1 : 1;
        for (let k = 0; k < FEEDER_DX.length; k++) {
          const xa = GANTRY_POLES[a.v][side] + out * FEEDER_DX[k], xb = GANTRY_POLES[b.v][side] + out * FEEDER_DX[k];
          let prev = null;
          for (let i = 0; i <= NSEG; i++) {
            const t = i / NSEG;
            const cur = pt(a.s + (b.s - a.s) * t, xa + (xb - xa) * t, FEEDER_Y - FEEDER_SAG * 4 * t * (1 - t));
            if (prev) seg(prev, cur, W_FEED);
            prev = cur;
          }
        }
      }
    }
  }
  const wm = M.wireLine;
  chunks.forEach((ch) => {
    if (!ch.pos.length) return;
    const g = new LineSegmentsGeometry();
    /* 線分ごとの四角はまん中の2枚だけ(はしの丸めの4枚は細い線では見えない。三角形を1/3に) */
    g.setIndex([2, 4, 3, 4, 5, 3]);
    g.setPositions(new Float32Array(ch.pos));
    g.setAttribute('lwA', new THREE.InstancedBufferAttribute(new Float32Array(ch.lw), 3));
    const ls = new LineSegments2(g, wm);
    ls.userData.noMerge = true;
    rs.world.add(ls);
  });
  /* 架線の線の材質(P3 が夜・トンネルで暗くする)。最初の描画の前に画面の大きさを入れておく */
  rs._wireMats = [wm, M.wire];
  if (rs.renderer && rs.renderer.domElement) {
    const cv = rs.renderer.domElement;
    updateWireRes(rs, cv.width, cv.height, rs.renderer.getPixelRatio ? rs.renderer.getPixelRatio() : 1);
  }
  rs._catSupports = sup;
}

/* ---------------- トンネル(坑口・土かぶり・掘割・出口の明るさ) ---------------- */
export function buildTunnel(rs, o = {}) {
  const F = rs.frames, step = rs.step, N = F.length - 1;
  const M = ensureTrackMats(rs, o.aniso);
  const WL = TUN.L, WR = TUN.R, H = TUN.H, RAMP = 160;
  const add = (g, mat, cast = true, recv = true) => { const m = new THREE.Mesh(g, mat); m.castShadow = cast; m.receiveShadow = recv; rs.world.add(m); return m; };
  const bankCol = srgbLin(0xb9b79c);
  const glowMat = new THREE.MeshBasicMaterial({
    color: 0xd8dde2, map: texGlowGrad(), transparent: true, opacity: 0.9,
    depthWrite: false, fog: false, forceSinglePass: true,
  });
  rs._exitGlow = { mat: glowMat, items: [], key: null };
  rs._tunCurtain = null;
  const portalParts = [];
  /* 外から見た坑口の暗さ: 坑口から 5 / 16 / 40m 奥に、外を向いた黒い幕(だんだん濃く)。
   * 全部の坑口で1つの形(頂点色RGBA)・描画1回。列車が入ると奥へ溶けこむように暗くなる */
  const cur = { pos: [], col: [], idx: [] };
  const curC = new THREE.Color(0x05070a);
  const qi = quadInfo(rs.line);
  const cols = [];
  const fr = newFrame(), m4 = new THREE.Matrix4(), nl = new THREE.Vector3(), nt = new THREE.Vector3();
  rs.line.sections.tunnel.forEach((t) => {
    const i0 = Math.max(0, Math.floor(t.from / step)), i1 = Math.min(N, Math.ceil(t.to / step));
    /* 両はしの行だけ坑口の面(t.from / t.to)にずらしたフレーム列。
     * 5mの行のままだと、内張りが坑口の前に最大5mはみ出す(t.from が5の倍数でないとき) */
    const FT = F.slice();
    FT[i0] = Object.assign(frameInto(F, step, t.from, newFrame()), { s: t.from });
    const sEnd = Math.min(t.to, N * step);
    FT[i1] = Object.assign(frameInto(F, step, sEnd, newFrame()), { s: sEnd });
    /* 壁(型枠の目地・ケーブル受け)と天井。天井も壁と同じ作りの材質: UVの「高さ」を 壁ぎわ4.55m → まん中6.2m にして、
     * 灯具(高さ4.2m)の光が天井のすみをうっすら照らす(壁と同じ計算。まん中は暗いまま) */
    add(wallStrip(FT, i0, i1, WL, -0.5, H, TUN_WALL_UV, step), M.tunnelWall);
    add(wallStrip(FT, i0, i1, WR, -0.5, H, TUN_WALL_UV, step), M.tunnelWall);
    const vH = (h) => (h + 0.5) / (H + 0.5);
    add(profileRibbon(FT, i0, i1, [[WL + 0.3, H, vH(4.55)], [(WL + WR) / 2, H, vH(H)], [WR - 0.3, H, vH(4.55)]], { uvScale: TUN_WALL_UV, step, vert: true }), M.tunnelCeilW || M.tunnelWall);
    /* 柱の列(5mごと): 自線と上り線のあいだ(-1.9m)と、複々線の線路のあいだ(排水溝と同じ線)。
     * 地下駅のホーム(駅の担当が別に柱を立てる)と、坑口から12mの内側は立てない */
    const tunSt = rs.line.stations.filter((st) => st.s > t.from && st.s < t.to);
    for (let s = Math.ceil((t.from + 12) / 5) * 5; s < t.to - 12; s += 5) {
      if (tunSt.some((st) => s > st.s - 165 && s < st.s + 25)) continue;
      const e0 = quadOffAt(s, 0, qi), e1 = quadOffAt(s, 1, qi);
      cols.push([s, -1.9]);
      /* 車体(半幅1.475m)どうしのあいだに柱(0.35m)+すき間が入るときだけ */
      if (e0 > 3.7) cols.push([s, e0 / 2]);
      if (e1 - e0 > 3.7) cols.push([s, (e0 + e1) / 2]);
    }
    /* 土かぶり(トンネルの上の盛り土)と、出入口の掘割 */
    const hAt = (s) => (s < t.from ? 6.8 * sstep(t.from - RAMP, t.from, s) : s > t.to ? 6.8 * (1 - sstep(t.to, t.to + RAMP, s)) : 6.8);
    const vc = () => bankCol;
    const tu = (x) => x / 760;
    add(profileRibbon(FT, i0, i1, [[WL + 18, -0.6, tu(WL + 18)], [WL + 1.2, 6.8, tu(WL + 1.2)], [WR - 1.2, 6.8, tu(WR - 1.2)], [WR - 18, -0.6, tu(WR - 18)]],
      { uvScale: 5, step, vcol: vc }), rs.M.bank);
    [[Math.max(0, Math.floor((t.from - RAMP) / step)), i0], [i1, Math.min(N, Math.ceil((t.to + RAMP) / step))]].forEach(([ra, rb]) => {
      if (rb - ra < 2) return;
      const h = (i) => hAt(FT[i].s != null ? FT[i].s : i * step);
      add(profileRibbon(FT, ra, rb, (i) => [[WL + 18, -0.6, tu(WL + 18)], [WL + 0.3, h(i) + 0.3, tu(WL + 0.3)]], { uvScale: 5, step, vcol: vc }), rs.M.bank);
      add(profileRibbon(FT, ra, rb, (i) => [[WR - 0.3, h(i) + 0.3, tu(WR - 0.3)], [WR - 18, -0.6, tu(WR - 18)]], { uvScale: 5, step, vcol: vc }), rs.M.bank);
      /* 掘割の擁壁(上端は少しだけ地面より高い) */
      add(wallStrip(FT, ra, rb, WL + 0.3, -0.5, (i) => h(i) + 0.35, 4, step), rs.M.tunnel);
      add(wallStrip(FT, ra, rb, WR - 0.3, -0.5, (i) => h(i) + 0.35, 4, step), rs.M.tunnel);
    });
    /* 坑口: 柱2本+梁(まぐさ)+笠石。線路の上は開いている */
    [[t.from, 1], [t.to, -1]].forEach(([s, dir]) => {
      frameInto(F, step, s, fr);
      const acc = newAcc();
      const box = (x0, x1, y0, y1, z0, z1) => {
        const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0).toNonIndexed();
        g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
        /* 箱の面ごとにメートル単位のUV(写真テクスチャが伸びないように) */
        const p = g.attributes.position, nrm = g.attributes.normal, uv = g.attributes.uv;
        for (let k = 0; k < p.count; k++) {
          const ax = Math.abs(nrm.getX(k)), ay = Math.abs(nrm.getY(k));
          const u = ax > 0.5 ? p.getZ(k) : p.getX(k), v = ay > 0.5 ? p.getZ(k) : p.getY(k);
          uv.setXY(k, u / 3, v / 3);
        }
        accGeo(acc, g, new THREE.Matrix4(), null);
      };
      /* 柱の内側の面と梁の下の面は、内張り(壁・天井)と同じ面にならないよう4cmだけ内へ出す(ちらつき防止) */
      box(WR - 1.2, WR + 0.04, -0.6, 8.6, -0.6, 0.6);
      box(WL - 0.04, WL + 1.2, -0.6, 8.6, -0.6, 0.6);
      box(WR - 1.2, WL + 1.2, H - 0.04, 8.6, -0.6, 0.6);
      box(WR - 1.5, WL + 1.5, 8.6, 9.0, -0.75, 0.75);
      /* 扁額(社名や駅名は入れない。無地の銘板)。トンネルの外側の面に付ける */
      box(-3.2, 1.2, 7.0, 7.9, dir > 0 ? -0.7 : 0.6, dir > 0 ? -0.6 : 0.7);
      const g = accToGeometry(acc, { color: false, uv: true });
      g.applyMatrix4(m4.makeBasis(fr.left, UPV, fr.t).setPosition(fr.p.x, fr.p.y, fr.p.z));
      nl.copy(fr.left).multiplyScalar(dir); nt.copy(fr.t).multiplyScalar(dir);
      portalParts.push(g);
      /* 出口の明るさ(トンネルの中から見たときだけ) */
      const glow = new THREE.Mesh(new THREE.PlaneGeometry(WL - WR, H + 0.6), glowMat);
      glow.position.copy(fr.p).addScaledVector(fr.left, (WL + WR) / 2).addScaledVector(fr.t, -dir * 0.7);
      glow.position.y += (H - 0.6) / 2;
      glow.quaternion.setFromRotationMatrix(m4.makeBasis(nl, UPV, nt));
      glow.visible = false;
      glow.userData.noMerge = true;
      glow.renderOrder = 2;
      glow.userData.dyn = true;
      rs.world.add(glow);
      rs._exitGlow.items.push({ mesh: glow, from: t.from, to: t.to });
      /* 暗い幕(表は外向き = 坑口から外へ -dir) */
      [[5, 0.5], [16, 0.75], [40, 0.96]].forEach(([d, al]) => {
        const sc = s + dir * d;
        if (sc <= t.from || sc >= t.to) return;
        const fc = frameInto(F, step, sc, newFrame());
        const b = cur.pos.length / 3;
        [[WR, -0.6], [WL, -0.6], [WL, H], [WR, H]].forEach(([l, y]) => {
          cur.pos.push(fc.p.x + fc.left.x * l, fc.p.y + y, fc.p.z + fc.left.z * l);
          cur.col.push(curC.r, curC.g, curC.b, al);
        });
        if (dir > 0) cur.idx.push(b, b + 3, b + 2, b, b + 2, b + 1);
        else cur.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
      });
    });
  });
  if (cur.idx.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(cur.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(cur.col, 4));
    g.setIndex(cur.idx);
    g.computeBoundingSphere();
    const cm = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, fog: true }));
    cm.material.name = 'tun-curtain';
    cm.renderOrder = 1;
    cm.userData.noMerge = true;
    rs.world.add(cm);
    rs._tunCurtain = cm;
  }
  /* 柱の列: 1つの InstancedMesh(world 直下・noSplit なし → 700mマスに分けて見えるところだけ描く) */
  if (cols.length) {
    const cg = new THREE.BoxGeometry(0.35, H + 0.5, 0.5).translate(0, (H + 0.5) / 2 - 0.25, 0);
    const im = new THREE.InstancedMesh(cg, M.tunnelCeil || rs.M.tunnel, cols.length);
    const q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
    cols.forEach(([s, lat], k) => {
      frameInto(F, step, s, fr);
      q.setFromAxisAngle(UPV, Math.atan2(fr.t.x, fr.t.z));
      im.setMatrixAt(k, m4.compose(p.copy(fr.p).addScaledVector(fr.left, lat), q, one));
    });
    im.castShadow = false; im.receiveShadow = true;
    im.computeBoundingSphere();
    rs.world.add(im);
  }
  if (portalParts.length) {
    const acc = newAcc();
    portalParts.forEach((g) => accGeo(acc, g, new THREE.Matrix4(), null));
    const pm = new THREE.MeshStandardMaterial({ map: rs.T.concC, color: 0xc4c2ba, roughness: 0.95 });
    const mesh = new THREE.Mesh(accToGeometry(acc, { color: false, uv: true }), pm);
    mesh.castShadow = true; mesh.receiveShadow = true;
    rs.world.add(mesh);
    portalParts.forEach((g) => g.dispose());
  }
}

/* ブラケットの遠近(毎フレーム): カメラの位置から遠い区間は描かない */
const _hideM = new THREE.Matrix4().makeScale(0, 0, 0);
export function updateCatenaryLod(rs) {
  const cells = rs._brkCells;
  if (!cells) return;
  const front = rs.camMode === 'front';
  const cs = front && rs._frontCamS != null ? rs._frontCamS : rs._camS != null ? rs._camS : rs.sim ? rs.sim.pos : 0;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    c.mesh.visible = c.s1 > cs - c.r && c.s0 < cs + c.r;
  }
  /* 線路わきの撮影カメラ(左4.4m)のすぐ横に立つ門型ビームは隠す(柱が画面の真ん中をふさがないように)。
   * カメラの場所が変わったときだけ行列を書きかえる */
  const hk = front ? Math.round(cs) : null;
  if (hk === rs._gHideKey) return;
  rs._gHideKey = hk;
  const H = rs._gHidden || (rs._gHidden = []);
  for (let i = 0; i < H.length; i++) { H[i].mesh.setMatrixAt(H[i].j, H[i].m); H[i].mesh.instanceMatrix.needsUpdate = true; }
  H.length = 0;
  if (!front) return;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (!c.sList || c.s1 < cs - 10 || c.s0 > cs + 10) continue;
    for (let j = 0; j < c.sList.length; j++) {
      if (Math.abs(c.sList[j] - cs) > 7) continue;
      const m = new THREE.Matrix4();
      c.mesh.getMatrixAt(j, m);
      H.push({ mesh: c.mesh, j, m });
      c.mesh.setMatrixAt(j, _hideM);
      c.mesh.instanceMatrix.needsUpdate = true;
    }
  }
}

/* 出口の明るさの更新(毎フレーム): カメラがトンネルの中にいるときだけ表示。
 * 色は「外にいるときの霧の色」×1.3(見た目の設定が変わったときだけ取り直す) */
const GLOW_FALLBACK = { day: 0xcfd9e2, evening: 0xd9a27a, night: 0x0c1119 };
export function updateExitGlow(rs) {
  const eg = rs._exitGlow;
  if (!eg || !eg.items.length) return;
  const cs = rs._camS != null ? rs._camS : rs.sim ? rs.sim.pos : 0;
  const look = rs.look;
  /* 見た目の設定の番号(P4 の look.rev。無いときは時間帯・天気が変わったら番号を進める。文字列は作らない) */
  if (!look && (eg.tod !== rs.timeOfDay || eg.wx !== rs.weather)) { eg.tod = rs.timeOfDay; eg.wx = rs.weather; eg.fk = (eg.fk || 0) + 1; }
  const key = look ? look.rev : eg.fk;
  const indoor = look ? (look.indoor || (look.k != null && look.k < 0.95)) : !!rs._inTunnelNow;
  if (key !== eg.key) {
    if (!indoor && rs.scene.fog && rs.scene.fog.color) {
      eg.key = key;
      /* トンネルの中はポストエフェクトの道(リニアの明るさ)なので、外の霧(リニア)の4.5倍にして
       * 屋内のにじみ(ブルーム)の しきい値をこえさせる=出口が白く光って見える */
      if (rs._fogPost && rs._fogPost.isColor) eg.mat.color.copy(rs._fogPost).multiplyScalar(4.5);
      else eg.mat.color.copy(rs.scene.fog.color).multiplyScalar(1.3);
    } else if (eg.key === null) {
      eg.mat.color.setHex(GLOW_FALLBACK[rs.timeOfDay] || GLOW_FALLBACK.day).multiplyScalar(1.3);
      eg.key = -1;
    }
  }
  const items = eg.items;
  for (let i = 0; i < items.length; i++) items[i].mesh.visible = cs > items[i].from && cs < items[i].to;
  /* 坑口の暗い幕: カメラがトンネルの中(±1m)なら消す。外から近づくときは坑口の13m手前から
   * うすくしていく(運転台が入る直前に急に明るくならない)。夜・夕方は奥の灯りが見えるよう うすめ */
  const cm = rs._tunCurtain;
  if (cm) {
    let dmin = 1e9;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (cs > it.from - 1 && cs < it.to + 1) { dmin = 0; break; }
      const d = cs < it.from ? it.from - cs : cs - it.to;
      if (d < dmin) dmin = d;
    }
    const k = Math.min(1, Math.max(0, (dmin - 1) / 12));
    const base = rs.timeOfDay === 'night' ? 0.55 : rs.timeOfDay === 'evening' ? 0.8 : 1;
    cm.visible = k > 0;
    cm.material.opacity = base * k;
  }
}

/* ---------------- 多摩川橋梁(ワーレントラス2連・堤防・橋脚) ---------------- */
export function buildRiver(rs, o = {}) {
  const F = rs.frames, step = rs.step, N = F.length - 1, qi = quadInfo(rs.line);
  const M = ensureTrackMats(rs, o.aniso);
  const add = (g, mat, cast = false, recv = true) => { const m = new THREE.Mesh(g, mat); m.castShadow = cast; m.receiveShadow = recv; rs.world.add(m); return m; };
  const e1 = (i) => quadOffAt(i * step, 1, qi);
  const fr = newFrame();
  const members = [], blocks = [];
  /* 部材の明るさ(インスタンス色): 弦材・床桁は見た目で1割暗く、ガセットは少しだけ。
   * インスタンス色はリニアで掛かるので、見た目(sRGB)の割合を2.2乗して入れる */
  const CH = Math.pow(0.9, 2.2), GU = Math.pow(0.94, 2.2);
  const rail = [];      // 点検通路の手すり(線): [始点, 終点, 太さm]
  const node = (s, off, y) => { frameInto(F, step, s, fr); return new THREE.Vector3().copy(fr.p).addScaledVector(fr.left, off).setY(fr.p.y + y); };
  const block = (s, off, y, sx, sy, sz) => {
    frameInto(F, step, s, fr);
    const c = new THREE.Vector3().copy(fr.p).addScaledVector(fr.left, off).setY(fr.p.y + y);
    blocks.push(new THREE.Matrix4().makeBasis(fr.left.clone().multiplyScalar(sx), UPV.clone().multiplyScalar(sy), fr.t.clone().multiplyScalar(sz)).setPosition(c));
  };
  const dryVcol = (i, c) => {
    const s = i * step;
    const n = 0.85 + 0.1 * Math.sin(s * 0.021 + c * 3.3) * Math.sin(s * 0.006 + 1.2);
    return [Math.pow(n * 1.02, 2.2), Math.pow(n * 0.97, 2.2), Math.pow(n * 0.86, 2.2)];
  };
  const clampI = (i) => Math.max(0, Math.min(N, i));
  rs.line.sections.river.forEach((r) => {
    const i0 = clampI(Math.floor((r.from - 130) / step)), i1r = clampI(Math.ceil((r.to + 130) / step));
    /* 水面 */
    add(flatStrip(F, i0, i1r, 0, 760, -7.5, 200, step), rs.M.water);
    /* 河川敷と堤防(地面の高さから河川敷へ下る) */
    const bankY = (s) => -6.7 + 6.15 * sstep(170, 240, Math.max(r.from - s, s - r.to));
    const bank = (a, b) => add(profileRibbon(F, a, b, (i) => { const y = bankY(i * step); return [[380, y, 0], [-380, y, 1]]; },
      { uvScale: 5, step, vcol: dryVcol }), rs.M.bank);
    bank(clampI(Math.floor((r.from - 260) / step)), i0 + 6);
    bank(i1r - 6, clampI(Math.ceil((r.to + 260) / step)));
    /* 橋の前後の盛り土(犬走りの外から 1:1.5 で下る) */
    const emb = (sa, sb) => {
      const a = clampI(Math.floor(sa / step)), b = clampI(Math.ceil(sb / step));
      add(profileRibbon(F, a, b, (i) => {
        const x = Math.max(1.65, e1(i) + 1.65) + 2.25;
        return [[x + 11, -7.8, (x + 11) / 760], [x, -0.42, x / 760]];
      }, { uvScale: 5, step, vcol: dryVcol }), rs.M.bank);
      add(profileRibbon(F, a, b, [[-8.2, -0.42, -8.2 / 760], [-19.2, -7.8, -19.2 / 760]], { uvScale: 5, step, vcol: dryVcol }), rs.M.bank);
    };
    emb(r.from - 240, r.from + 2);
    emb(r.to - 2, r.to + 240);

    /* トラス: 自線・上り線の組と、急行線の組(複々線) */
    const exp = qi && r.from >= qi.a1 && r.to <= qi.b0;
    const bridges = [{ pl: 2.45, pr: -6.25, tr: [0, -3.8] }];
    if (exp) bridges.push({ pl: QUAD_OFF[1] + 2.45, pr: QUAD_OFF[0] - 2.45, tr: [QUAD_OFF[1], QUAD_OFF[0]] });
    const lay = bridgeLayout(r);
    const YB = -0.1, YT = 7.4;
    const ia = clampI(Math.floor(r.from / step)), ib = clampI(Math.ceil(r.to / step));
    bridges.forEach(({ pl, pr, tr }) => {
      lay.spans.forEach(({ a, P, np }) => {
        for (const off of [pl, pr]) {
          const outS = Math.sign(off - (pl + pr) / 2);       // トラスの面の外向き
          for (let k = 0; k < np; k++) {
            const sb0 = a + k * P, st = sb0 + P / 2, sb1 = sb0 + P;
            const B0 = node(sb0, off, YB), Tk = node(st, off, YT), B1 = node(sb1, off, YB);
            members.push([B0, Tk, k === 0 ? 0.42 : 0.3, k === 0 ? 0.46 : 0.36, k === 0 ? CH : 1]);   // 斜材(端は端柱)
            members.push([Tk, B1, k === np - 1 ? 0.42 : 0.3, k === np - 1 ? 0.46 : 0.36, k === np - 1 ? CH : 1]);
            members.push([node(st, off, YB), Tk, 0.2, 0.24, 1]);                              // 垂直材
            members.push([B0, B1, 0.38, 0.55, CH]);                                           // 下弦材(弦材は1割暗い)
            if (k < np - 1) members.push([Tk, node(st + P, off, YT), 0.42, 0.46, CH]);       // 上弦材
            /* ガセットプレート(節点の板 0.9x0.8。部材をはさむ両面の板を、厚み0.5の1つの箱で): 上の節点と下の節点 */
            members.push([node(st - 0.45, off, YT - 0.1), node(st + 0.45, off, YT - 0.1), 0.5, 0.8, GU]);
            members.push([node(sb0 - 0.45, off, YB + 0.1), node(sb0 + 0.45, off, YB + 0.1), 0.5, 0.8, GU]);
            if (k === np - 1) members.push([node(sb1 - 0.45, off, YB + 0.1), node(sb1 + 0.45, off, YB + 0.1), 0.5, 0.8, GU]);
          }
          /* 点検通路の手すり(トラスの面の内がわ0.42m): 1.5mごとの柱+上と中の横棒。
           * 細いので架線と同じ「メートルの太さの線」で描く(三角形が少ない・影なし) */
          const hl = off - outS * 0.42;
          const hp = (x, y) => node(x, hl, y).toArray();
          for (let x = a + 0.75; x < a + np * P - 0.5; x += 1.5) rail.push([hp(x, 0.0), hp(x, 1.1), 0.05]);
          for (let x = a + 0.4; x < a + np * P - 0.5; x += 7.5) {
            const x1 = Math.min(x + 7.5, a + np * P - 0.4);
            rail.push([hp(x, 1.1), hp(x1, 1.1), 0.05], [hp(x, 0.6), hp(x1, 0.6), 0.035]);
          }
        }
        /* 端の門構(橋門構): 径間の両はしの上の節点に、横に深さ0.9mの板の梁+両はしの方づえ */
        for (const sP of [a + P / 2, a + (np - 0.5) * P]) {
          members.push([node(sP, pl, YT - 0.9), node(sP, pr, YT - 0.9), 0.22, 0.9, 1]);
          const dIn = Math.sign(pr - pl);
          members.push([node(sP, pl, YT - 2.7), node(sP, pl + dIn * 1.6, YT - 1.35), 0.2, 0.2, 1]);
          members.push([node(sP, pr, YT - 2.7), node(sP, pr - dIn * 1.6, YT - 1.35), 0.2, 0.2, 1]);
        }
        for (let k = 0; k < np; k++) {
          const st = a + (k + 0.5) * P;
          members.push([node(st, pl, YT + 0.05), node(st, pr, YT + 0.05), 0.26, 0.4, 1]);    // 上横桁
          if (k < np - 1 && k % 2 === 0) {                                                  // 上横構(X)
            members.push([node(st, pl, YT + 0.1), node(st + P, pr, YT + 0.1), 0.12, 0.12, 1]);
            members.push([node(st, pr, YT + 0.1), node(st + P, pl, YT + 0.1), 0.12, 0.12, 1]);
          }
        }
        for (let k = 0; k <= np; k++) members.push([node(a + k * P, pl, -0.5), node(a + k * P, pr, -0.5), 0.3, 0.55, CH]);   // 床桁
      });
      /* 橋脚(径間の継ぎ目)と橋台 */
      const mid = (pl + pr) / 2, wid = Math.abs(pl - pr) + 1.6;
      lay.spans.forEach(({ a }, j) => { if (j > 0) { block(a, mid, -6.0, wid, 10.6, 2.6); block(a, mid, -0.95, wid + 0.6, 0.5, 3.2); } });
      /* 縦桁(レールの下)・護輪軌条・点検通路の床 */
      tr.forEach((off) => {
        [-0.55, 0.55].forEach((d) => add(wallStrip(F, ia, ib, off + d, -0.78, -0.1, 6, step), M.deckSteel));
        [-1, 1].forEach((sg) => add(flatStrip(F, ia, ib, off + sg * (RAIL_HALF - 0.2), 0.06, 0.15, 25, step), rs.M.railWeb));
      });
      const [ta, tb] = tr;
      [[pl - Math.sign(pl - pr) * 0.25, ta + 1.1], [ta - 1.1, tb + 1.1], [tb - 1.1, pr + Math.sign(pl - pr) * 0.25]].forEach(([x0, x1]) => {
        add(profileRibbon(F, ia, ib, [[x0, -0.08, x0 / 2], [x1, -0.08, x1 / 2]], { uvScale: 2, step }), M.deckGrate);
      });
    });
    /* 橋台(両端) */
    const lft = (exp ? QUAD_OFF[1] + 2.45 : 2.45) + 1.4, rgt = -6.25 - 1.4;
    [r.from - 1.6, r.to + 1.6].forEach((s) => block(s, (lft + rgt) / 2, -4.2, lft - rgt, 7.7, 3.2));
  });
  if (members.length) {
    const im = new THREE.InstancedMesh(UNIT_BOX, M.truss, members.length);
    const m = new THREE.Matrix4(), hint = new THREE.Vector3(), col = new THREE.Color();
    members.forEach(([a, b, w, h, k], i) => {
      /* 断面の向き: 線路の横方向を基準に */
      hint.subVectors(b, a); const len = hint.length();
      hint.set(-(b.z - a.z), 0, b.x - a.x);
      if (len < 1e-3 || hint.lengthSq() < 1e-6) hint.set(1, 0, 0);
      im.setMatrixAt(i, barMatrix(a, b, w, h, hint.normalize(), m));
      im.setColorAt(i, col.setScalar(k != null ? k : 1));
    });
    im.castShadow = true; im.receiveShadow = true;
    im.computeBoundingSphere();
    rs.world.add(im);
  }
  if (rail.length) {
    const pos = new Float32Array(rail.length * 6), lw = new Float32Array(rail.length * 3);
    rail.forEach(([p, q, w], i) => { pos.set(p, i * 6); pos.set(q, i * 6 + 3); lw[i * 3] = w; lw[i * 3 + 1] = 1.0; lw[i * 3 + 2] = 1; });
    const g = new LineSegmentsGeometry();
    g.setIndex([2, 4, 3, 4, 5, 3]);
    g.setPositions(pos);
    g.setAttribute('lwA', new THREE.InstancedBufferAttribute(lw, 3));
    const ls = new LineSegments2(g, M.wireLine);
    ls.userData.noMerge = true;
    rs.world.add(ls);
  }
  if (blocks.length) {
    const im = new THREE.InstancedMesh(UNIT_BOX, M.pier, blocks.length);
    blocks.forEach((m, i) => im.setMatrixAt(i, m));
    im.castShadow = true; im.receiveShadow = true;
    im.computeBoundingSphere();
    rs.world.add(im);
  }
}
/* s が橋の上か(枕木を木製にする判定) */
export function onBridge(rs, s) {
  return rs.line.sections.river.some((r) => s >= r.from && s <= r.to);
}
