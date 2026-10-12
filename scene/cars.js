/* =========================================================
 * scene/cars.js — 自動車(軽・ミニバン・セダン・路線バス): 家の車庫・月極駐車場・踏切待ちの車・道を走る車
 *
 * ・形は「横から見た輪郭」を左右に押し出した角柱。腰(窓の下の線)から下は車の幅いっぱい、上(屋根・窓)は9割の幅で
 *   すぼめる。窓ガラス・タイヤ4つ(十角形・ホイールキャップつき・タイヤハウスの暗いくぼみの中)・前後のバンパー・
 *   ドアミラー・灯火・車の下の接地影(黒い板)。1台およそ190三角形。
 *   種類ごと・700mごとに1つの InstancedMesh にまとめる(描画は種類×かたまりの数だけ)。
 * ・材質は木の材質と同じシェーダ('fc-tree')を使う(新しいシェーダを増やさない):
 *   頂点色が2以上の部分(ガラス・タイヤ・灯火)は「固定色」で、インスタンス色(塗装)に染めない。
 *   固定色のうち とても暗いもの(2.00〜2.05: タイヤ・タイヤハウス・接地影)は つやなし(空を映さない)。
 * ・影は線路の近くの車(sh)だけ。先頭に並べて、影を描くときだけ数を減らす(town.js と同じやり方)。
 * ・夜の灯火: 頂点色の r が 2.45 より大きい部分(前照灯・尾灯)は、インスタンス色の r が 2 以上の車
 *   (走っている車・踏切待ちの車。止めてある車は消灯)だけ uCarLamp の強さで光る。
 *   木と車は同じ patchTreeCar を通すので、'fc-tree' のシェーダは1つのまま。
 * ========================================================= */
import * as THREE from '../vendor/three.module.min.js';
import { uFcAmb } from './facade.js';

/* 灯火の強さ(夜 2.2 / 夕方 1.0 / 昼 0)。town.js の applyLook が書く。木と車の材質で共有 */
export const uCarLamp = { value: 0 };

/* 木と車の材質の onBeforeCompile の中身(1つだけ。'fc-tree' を共有する材質は必ずこれを通す)
 * ・頂点色>=2 はインスタンス色に染めない「固定色」(幹・ガラス・タイヤ・灯火)
 * ・インスタンス色の r>=2 は「灯火をつけている車」の印(塗装の色は 2 を引いた値)
 * ・夜は街の照り返し(uFcAmb)で葉・車体を少しだけ持ち上げる(真っ黒の影絵にしない) */
export function patchTreeCar(sh) {
  sh.uniforms.uCarLamp = uCarLamp;
  sh.uniforms.uFcAmb = uFcAmb;
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nvarying float vLamp;\nvarying float vMatte;')
    .replace('#include <color_vertex>', `#include <color_vertex>
vLamp = 0.;
vMatte = 0.;
#ifdef USE_COLOR
#ifdef USE_INSTANCING_COLOR
float fcOn = step(1.5, instanceColor.r);
vColor.r -= 2. * fcOn * color.r;
vLamp = step(2.45, color.r) * fcOn;
#endif
if (color.r > 1.5) vColor.xyz = color.xyz - 2.0;
vMatte = step(1.5, color.r) * step(color.r, 2.05);
#endif`);
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform float uCarLamp;\nuniform float uFcAmb;\nvarying float vLamp;\nvarying float vMatte;')
    .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 1., vMatte);
metalnessFactor *= 1. - vMatte;`)
    .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
#ifdef USE_COLOR
totalEmissiveRadiance += vColor.rgb * vLamp * uCarLamp;
#endif
totalEmissiveRadiance += diffuseColor.rgb * uFcAmb * .12 * (1. - vLamp);`);
}

/* 輪郭(x=長さ方向 0→前, y=高さ。反時計回り)・幅・ガラスの輪郭・タイヤの位置(x)・前後の灯火の高さ */
const SPEC = {
  kei: {
    prof: [[0, 0.18], [3.39, 0.18], [3.39, 0.75], [3.25, 1.05], [2.75, 1.72], [0.15, 1.72], [0, 1.6]], w: 1.47,
    glass: [[-0.015, 1.02], [3.29, 1.02], [2.83, 1.64], [0.04, 1.64], [-0.015, 1.5]], wheels: [0.55, 2.85], head: 0.66, tail: 0.95,
  },
  minivan: {
    prof: [[0, 0.2], [4.7, 0.2], [4.7, 0.8], [4.45, 1.05], [3.6, 1.85], [0.2, 1.85], [0, 1.7]], w: 1.7,
    glass: [[-0.015, 1.05], [4.47, 1.05], [3.69, 1.78], [0.09, 1.78], [-0.015, 1.6]], wheels: [0.85, 3.85], head: 0.72, tail: 1.0,
  },
  sedan: {
    prof: [[0, 0.2], [4.6, 0.2], [4.6, 0.7], [3.6, 0.85], [2.9, 1.42], [1.2, 1.42], [0.5, 0.9], [0, 0.82]], w: 1.75,
    glass: [[0.51, 0.92], [3.56, 0.92], [2.99, 1.36], [1.1, 1.36]], wheels: [0.95, 3.65], head: 0.6, tail: 0.72,
  },
  /* 路線バス(10.5m): 白い車体・灰色のすそ・つづいた窓の帯。会社の色・文字は付けない */
  bus: {
    prof: [[0, 0.32], [10.5, 0.32], [10.5, 2.92], [10.38, 3.1], [0.1, 3.1], [0, 2.98]], w: 2.5,
    glass: [[-0.015, 1.25], [10.515, 1.25], [10.515, 2.65], [-0.015, 2.65]], wheels: [2.15, 7.85], head: 0.72, tail: 0.95,
    skirt: [[0, 0.32], [10.5, 0.32], [10.5, 0.9], [0, 0.9]], r: 0.5,
  },
};
export const CAR_TYPES = ['kei', 'minivan', 'sedan'];
export const CAR_LEN = { kei: 3.39, minivan: 4.7, sedan: 4.6, bus: 10.5 };
export const CAR_WID = { kei: 1.47, minivan: 1.7, sedan: 1.75, bus: 2.5 };
/* 白・銀が多い日本の街の車の色(sRGBの見た目) */
export const CAR_PAINTS = [0xf2f2f0, 0xf2f2f0, 0xd9dadc, 0xd9dadc, 0x2a2c30, 0x8e939a, 0x9a2a2a, 0x2c4a7a, 0xb8a98c];

/* 固定色(リニア+2)。ガラス・タイヤ・前照灯・尾灯 */
const COL_GLASS = [2.06, 2.08, 2.1], COL_TIRE = [2.03, 2.03, 2.03], COL_HEAD = [2.92, 2.9, 2.8], COL_TAIL = [2.5, 2.04, 2.04];
/* バスのすその灰色(固定色。2.45 より小さいこと: 灯火とまちがえない) */
const COL_SKIRT = [2.2, 2.21, 2.22];
/* タイヤハウスのくぼみ・接地影(とても暗い固定色: つやなし)・ホイールキャップ(銀)・バンパー(樹脂の濃い灰) */
const COL_WELL = [2.02, 2.02, 2.02], COL_SHADOW = [2.015, 2.015, 2.015], COL_HUB = [2.32, 2.33, 2.34], COL_BUMPER = [2.18, 2.18, 2.2];

/* 多角形(x-y平面・反時計回り)を z0..z1 に押し出した角柱。ふたは耳切り(ShapeUtils)で三角形にする(へこみのある輪郭でもよい)。
 * caps: 'both' / 'z0' / 'z1' / 'none'(見えない側のふたを省く)。skip: 側面を作らない辺の番号の配列(k → k+1 の辺。隠れる面) */
const _v2 = (p) => new THREE.Vector2(p[0], p[1]);
function prism(poly, z0, z1, caps = 'both', skip = null) {
  const pos = [], nor = [];
  const tri = (a, b, c, n) => { pos.push(...a, ...b, ...c); nor.push(...n, ...n, ...n); };
  const n = poly.length;
  if (caps !== 'none') {
    const faces = THREE.ShapeUtils.triangulateShape(poly.map(_v2), []);
    faces.forEach(([i, j, k]) => {
      let A = poly[i], B = poly[j], C = poly[k];
      /* 反時計回り(+z から見て)にそろえる */
      if ((B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]) < 0) { const t = B; B = C; C = t; }
      if (caps !== 'z0') tri([A[0], A[1], z1], [B[0], B[1], z1], [C[0], C[1], z1], [0, 0, 1]);
      if (caps !== 'z1') tri([A[0], A[1], z0], [C[0], C[1], z0], [B[0], B[1], z0], [0, 0, -1]);
    });
  }
  for (let k = 0; k < n; k++) {
    if (skip && skip.indexOf(k) >= 0) continue;
    const A = poly[k], B = poly[(k + 1) % n];
    const dx = B[0] - A[0], dy = B[1] - A[1], l = Math.hypot(dx, dy) || 1;
    const nn = [dy / l, -dx / l, 0];
    tri([A[0], A[1], z1], [B[0], B[1], z0], [B[0], B[1], z1], nn);
    tri([A[0], A[1], z1], [A[0], A[1], z0], [B[0], B[1], z0], nn);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}
/* ふただけの板(z の位置に1枚。sd>0 は +z 向き、sd<0 は -z 向き) */
const capAt = (poly, z, sd) => (sd > 0 ? prism(poly, z - 0.001, z, 'z1', poly.map((_, k) => k)) : prism(poly, z, z + 0.001, 'z0', poly.map((_, k) => k)));

/* 前後の灯火: x=一定の面に貼る四角(法線 ±x) */
function lampQuad(x, y, z, w, h, nx) {
  const A = [x, y - h / 2, z + w / 2], B = [x, y - h / 2, z - w / 2], C = [x, y + h / 2, z + w / 2], D = [x, y + h / 2, z - w / 2];
  const pos = nx > 0 ? [...A, ...B, ...C, ...B, ...D, ...C] : [...A, ...C, ...B, ...B, ...C, ...D];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const nor = [];
  for (let i = 0; i < 6; i++) nor.push(nx, 0, 0);
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}
/* 地面に寝かせた四角(上向き。車の長さ方向 x・幅 z。接地影) */
function floorQuad(x0, x1, z0, z1, y) {
  const pos = [x0, y, z0, x0, y, z1, x1, y, z0, x1, y, z0, x0, y, z1, x1, y, z1];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  return g;
}
/* 正多角形(半径 r・n角。反時計回り) */
const ngon = (r, n, rot = 0) => {
  const a = [];
  for (let k = 0; k < n; k++) a.push([r * Math.cos((k * 2 * Math.PI) / n + rot), r * Math.sin((k * 2 * Math.PI) / n + rot)]);
  return a;
};

/* 部品をまとめる(position/normal/uv(0)/color) */
function merge(parts) {
  const list = parts.map((p) => ({ g: p.g.index ? p.g.toNonIndexed() : p.g, col: p.col }));
  const n = list.reduce((a, p) => a + p.g.attributes.position.count, 0);
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2), col = new Float32Array(n * 3);
  let o = 0;
  list.forEach(({ g, col: c }) => {
    const cnt = g.attributes.position.count;
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    for (let i = 0; i < cnt; i++) { col[(o + i) * 3] = c[0]; col[(o + i) * 3 + 1] = c[1]; col[(o + i) * 3 + 2] = c[2]; }
    o += cnt;
  });
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return out;
}

/* 輪郭を高さ yb で上下に切る(above=true で上の部分)。反時計回りのまま。続けて同じ点になったら1つにする */
function clipY(poly, yb, above) {
  const out = [];
  const inside = (p) => (above ? p[1] >= yb - 1e-6 : p[1] <= yb + 1e-6);
  for (let k = 0; k < poly.length; k++) {
    const A = poly[k], B = poly[(k + 1) % poly.length];
    const ia = inside(A), ib = inside(B);
    if (ia) out.push(A);
    if (ia !== ib) {
      const t = (yb - A[1]) / (B[1] - A[1]);
      out.push([A[0] + (B[0] - A[0]) * t, yb]);
    }
  }
  return out.filter((p, i) => { const q = out[(i + out.length - 1) % out.length]; return Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) > 1e-6; });
}
/* 高さ y の水平な辺の番号(腰の線の辺: 隠れるので側面を作らない) */
const flatEdges = (poly, y, tol) => {
  const a = [];
  for (let k = 0; k < poly.length; k++) {
    const A = poly[k], B = poly[(k + 1) % poly.length];
    if (Math.abs(A[1] - y) < tol && Math.abs(B[1] - y) < tol) a.push(k);
  }
  return a;
};

/* 1台の形(モジュールで1回だけ作る)。原点=車体の中心の真下(地面)、前=+z、幅=x。
 * lo=true は遠く(150mより先)の軽い形: 車体・窓・タイヤ(八角形のふただけ)・灯火・接地影(およそ80三角形)。
 * town.js が木と同じしくみ(かたまりごとの距離)で形を差しかえる */
const GEO = {};
export function geoCar(type, lo = false) {
  const key = lo ? type + ':lo' : type;
  if (GEO[key]) return GEO[key];
  const S = SPEC[type], hw = S.w / 2, L = CAR_LEN[type];
  const belt = S.glass[0][1];                       // 腰の線(窓の下の端)
  const sill = S.prof[0][1];                        // 車体の下の端
  const cw = hw * (type === 'bus' ? 0.97 : 0.9);    // 屋根・窓の半幅(すぼめる。バスは箱形なので少しだけ)
  const parts = [];
  /* 腰から下: 車の幅いっぱい。上の面(腰の線)は 屋根の幅の外だけ見える肩になる */
  parts.push({ g: prism(clipY(S.prof, belt, false), -hw, hw), col: [1, 1, 1] });
  /* 腰から上(キャビン): 9割の幅。下の面(腰の線)は下の箱に隠れるので作らない */
  const upper = clipY(S.prof, belt, true);
  parts.push({ g: prism(upper, -cw, cw, 'both', flatEdges(upper, belt, 1e-6)), col: [1, 1, 1] });
  /* 窓ガラス: キャビンより少しだけ外に出して、横の窓・前後のガラスとして見せる(屋根の縁は塗装のまま) */
  parts.push({ g: prism(S.glass, -cw - 0.005, cw + 0.005, 'both', flatEdges(S.glass, belt, 0.02)), col: COL_GLASS });
  /* バスのすそ(灰色の帯) */
  if (S.skirt) parts.push({ g: prism(S.skirt, -hw - 0.008, hw + 0.008), col: COL_SKIRT });
  /* タイヤ(十角形。軸は幅の向き)。タイヤハウスの暗いくぼみ(上が半円の形)を車体の横に重ね、その上にタイヤとホイールキャップ。
   * 車体の横から1〜3cmだけ外なので、出っぱった六角形には見えない。タイヤの踏み面は地面に近い下の2辺だけ(ほかは車体とくぼみに隠れる) */
  const tr = S.r || 0.3, R = tr + 0.07;
  const TIRE = ngon(tr, 10, Math.PI / 10), HUB = ngon(tr * 0.55, 8, Math.PI / 8);
  const noTread = [0, 1, 2, 3, 4, 5, 8, 9];   // 角度 234°〜306° の2辺(6・7番)だけ踏み面を作る
  if (lo) {
    const T8 = ngon(tr, 8, Math.PI / 8);
    S.wheels.forEach((x) => {
      const tire = T8.map(([px, py]) => [x + px, tr + py]);
      [-1, 1].forEach((sd) => parts.push({ g: capAt(tire, sd * (hw + 0.02), sd), col: COL_TIRE }));
    });
  }
  if (!lo) S.wheels.forEach((x) => {
    const yb = Math.max(0.02, sill - 0.02);
    const well = [[x - R, yb], [x + R, yb]];
    for (let k = 0; k <= 4; k++) { const a = (k / 4) * Math.PI; well.push([x + R * Math.cos(a), tr + R * Math.sin(a)]); }
    const tire = TIRE.map(([px, py]) => [x + px, tr + py]);
    const hub = HUB.map(([px, py]) => [x + px, tr + py]);
    [-1, 1].forEach((sd) => {
      const zt = sd * (hw + 0.02), zi = sd * (hw - 0.2);
      parts.push({ g: capAt(well, sd * (hw + 0.008), sd), col: COL_WELL });
      parts.push({ g: sd > 0 ? prism(tire, zi, zt, 'z1', noTread) : prism(tire, zt, zi, 'z0', noTread), col: COL_TIRE });
      parts.push({ g: capAt(hub, sd * (hw + 0.03), sd), col: COL_HUB });
    });
  });
  /* バンパー(前後。長さ0.25m・高さ0.3m・車体より1.5cm広い)。車体に隠れる内側の面は作らない */
  const by0 = Math.max(0.16, sill - 0.03), by1 = by0 + 0.3, bw = hw + 0.015;
  if (!lo) {
    parts.push({ g: prism([[L - 0.23, by0], [L + 0.02, by0], [L + 0.02, by1], [L - 0.23, by1]], -bw, bw, 'both', [3]), col: COL_BUMPER });
    parts.push({ g: prism([[-0.02, by0], [0.23, by0], [0.23, by1], [-0.02, by1]], -bw, bw, 'both', [1]), col: COL_BUMPER });
  }
  /* ドアミラー(塗装の色。前の窓の下の角の少し後ろで、車体の外へ張り出す)。バスは付けない */
  if (type !== 'bus' && !lo) {
    let gf = 0;
    S.glass.forEach((p) => { if (Math.abs(p[1] - belt) < 0.02 && p[0] > gf) gf = p[0]; });
    const mx = gf - 0.32, my = belt + 0.1;
    const box = [[mx - 0.05, my - 0.06], [mx + 0.05, my - 0.06], [mx + 0.05, my + 0.06], [mx - 0.05, my + 0.06]];
    parts.push({ g: prism(box, cw, cw + 0.18, 'z1'), col: [1, 1, 1] });
    parts.push({ g: prism(box, -cw - 0.18, -cw, 'z0'), col: [1, 1, 1] });
  }
  /* 前照灯・尾灯(前後の面より少し前に貼る) */
  [-1, 1].forEach((sd) => {
    parts.push({ g: lampQuad(L + 0.02, S.head, sd * (hw - 0.24), 0.34, 0.16, 1), col: COL_HEAD });
    parts.push({ g: lampQuad(-0.02, S.tail, sd * (hw - 0.17), 0.24, 0.18, -1), col: COL_TAIL });
  });
  /* 接地影: 車の下の黒い板(太陽の影を落とさない止めてある車も地面になじむ。固定色なので塗装に染まらない) */
  parts.push({ g: floorQuad(-0.125, L + 0.125, -hw - 0.125, hw + 0.125, 0.025), col: COL_SHADOW });
  const g = merge(parts);
  /* 長さ方向(x)を +z に、中心を原点へ */
  g.rotateY(-Math.PI / 2);
  g.translate(0, 0, -L / 2);
  g.computeBoundingSphere();
  GEO[key] = g;
  return g;
}

/* ---------- 自転車(駅前の駐輪場。ママチャリ: 前かご・低いフレーム) ----------
 * 原点=地面の中心、前=+z、車輪は y-z の面(幅 x)。車輪は八角形の輪(両面)・フレームは細い角棒・かごとサドルは小さな箱。
 * 1台およそ120三角形。材質は車と同じ(フレームは塗装の色、ほかは固定色) */
function bar(a, b, t) {
  /* a→b の細い角棒(4つの側面だけ。端のふたは見えないので省く) */
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  d[0] /= l; d[1] /= l; d[2] /= l;
  /* 棒に直角な2つの向き(x軸か y軸との外積から) */
  const ref = Math.abs(d[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0];
  let u = [d[1] * ref[2] - d[2] * ref[1], d[2] * ref[0] - d[0] * ref[2], d[0] * ref[1] - d[1] * ref[0]];
  const ul = Math.hypot(u[0], u[1], u[2]) || 1;
  u = u.map((v) => v / ul);
  const v = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
  const pos = [], nor = [];
  const P = (p, s1, s2) => [p[0] + (u[0] * s1 + v[0] * s2) * t, p[1] + (u[1] * s1 + v[1] * s2) * t, p[2] + (u[2] * s1 + v[2] * s2) * t];
  const C = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
  for (let k = 0; k < 4; k++) {
    const c0 = C[k], c1 = C[(k + 1) % 4];
    const nx = (c0[0] + c1[0]) / 2, ny = (c0[1] + c1[1]) / 2;
    const n = [u[0] * nx + v[0] * ny, u[1] * nx + v[1] * ny, u[2] * nx + v[2] * ny];
    const nl = Math.hypot(n[0], n[1], n[2]) || 1;
    const nn = [n[0] / nl, n[1] / nl, n[2] / nl];
    const A0 = P(a, c0[0], c0[1]), A1 = P(a, c1[0], c1[1]), B0 = P(b, c0[0], c0[1]), B1 = P(b, c1[0], c1[1]);
    /* 外向きの法線と同じ回りに */
    const tri = (p, q, r) => {
      const e1 = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], e2 = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
      const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      if (cr[0] * nn[0] + cr[1] * nn[1] + cr[2] * nn[2] < 0) { const s = q; q = r; r = s; }
      pos.push(...p, ...q, ...r); nor.push(...nn, ...nn, ...nn);
    };
    tri(A0, A1, B1); tri(A0, B1, B0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}
/* 車輪: 中心(y, z)・外の半径 R・内の半径 r の八角形の輪(両面) */
function wheelRing(cy, cz, R, r) {
  const pos = [], nor = [];
  const pt = (rad, k) => { const a = (k / 8) * Math.PI * 2; return [0, cy + Math.sin(a) * rad, cz + Math.cos(a) * rad]; };
  for (let k = 0; k < 8; k++) {
    const o0 = pt(R, k), o1 = pt(R, k + 1), i0 = pt(r, k), i1 = pt(r, k + 1);
    [1, -1].forEach((sx) => {
      const off = (p) => [p[0] + sx * 0.015, p[1], p[2]];
      const q = [off(o0), off(o1), off(i1), off(i0)];
      [[q[0], q[1], q[2]], [q[0], q[2], q[3]]].forEach((t) => {
        /* 面の向き(x 成分)が sx と同じ回りに */
        const cx = (t[1][1] - t[0][1]) * (t[2][2] - t[0][2]) - (t[1][2] - t[0][2]) * (t[2][1] - t[0][1]);
        if (cx * sx < 0) { const s = t[1]; t[1] = t[2]; t[2] = s; }
        pos.push(...t[0], ...t[1], ...t[2]); nor.push(sx, 0, 0, sx, 0, 0, sx, 0, 0);
      });
    });
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}
/* 小さな箱(底なし) */
function boxNoBottom(cx, cy, cz, sx, sy, sz) {
  const b = new THREE.BoxGeometry(sx, sy, sz);
  const g = new THREE.BufferGeometry();
  ['position', 'normal'].forEach((k) => g.setAttribute(k, b.attributes[k]));
  const idx = Array.from(b.index.array);
  g.setIndex(idx.slice(0, 18).concat(idx.slice(24)));
  g.translate(cx, cy, cz);
  return g;
}
const COL_SILVER = [2.3, 2.3, 2.31];
export function geoBike() {
  if (GEO.bike) return GEO.bike;
  const RA = [0, 0.33, -0.52], FA = [0, 0.33, 0.52], BB = [0, 0.28, -0.02], ST = [0, 0.82, -0.2], HT = [0, 0.9, 0.36];
  const parts = [
    { g: wheelRing(0.33, -0.52, 0.33, 0.27), col: COL_TIRE },
    { g: wheelRing(0.33, 0.52, 0.33, 0.27), col: COL_TIRE },
    { g: bar(BB, HT, 0.022), col: [1, 1, 1] },            // 下の低いフレーム(またぎやすい形)
    { g: bar(BB, ST, 0.02), col: [1, 1, 1] },             // シートの柱
    { g: bar(ST, RA, 0.014), col: [1, 1, 1] },            // 後ろの支え
    { g: bar(HT, FA, 0.018), col: [1, 1, 1] },            // 前のフォーク
    { g: bar([-0.28, 0.98, 0.32], [0.28, 0.98, 0.32], 0.014), col: COL_SILVER },   // ハンドル
    { g: boxNoBottom(0, 0.84, 0.6, 0.34, 0.24, 0.28), col: COL_SILVER },            // 前かご
    { g: boxNoBottom(0, 0.86, -0.22, 0.13, 0.06, 0.25), col: COL_TIRE },            // サドル
  ];
  const g = merge(parts);
  g.computeBoundingSphere();
  GEO.bike = g;
  return g;
}

/* 材質(RailScene ごとに1回)。木と同じ 'fc-tree' の部品・キーなので新しいシェーダはできない */
export function carMaterial(rs) {
  if (rs._carMatP1) return rs._carMatP1;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 4;
  const c = cv.getContext('2d');
  c.fillStyle = '#ffffff'; c.fillRect(0, 0, 4, 4);
  const white = new THREE.CanvasTexture(cv);
  white.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.MeshStandardMaterial({ map: white, color: 0xffffff, vertexColors: true, roughness: 0.35, metalness: 0.45 });
  /* 頂点色>=2 はインスタンス色に染めず、そのままの色で(木の幹と同じしくみ。木と同じ patchTreeCar) */
  m.onBeforeCompile = patchTreeCar;
  m.customProgramCacheKey = () => 'fc-tree';
  rs._keep.add(m); rs._keep.add(white);
  rs._carMatP1 = m;
  return m;
}

/* sRGBの見た目の色(16進)+ゆらぎ → リニア */
const _c = new THREE.Color();
export function carPaint(spot, hex, rnd) {
  _c.setHex(hex);
  const k = 0.94 + rnd() * 0.12;
  spot.r = Math.min(1, _c.r * k); spot.g = Math.min(1, _c.g * k); spot.b = Math.min(1, _c.b * k);
  return spot;
}

/* spots: [{x, y(地面), z, yaw(前=+zの向き), type, r,g,b(リニア。r+2 で灯火をつける), s, sh}] → 種類ごと・700mごとの InstancedMesh。
 * 各 spot に、入ったメッシュ(sp._im)と番号(sp._i)を書きもどす(踏切待ちの車を動かすため) */
const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _one = new THREE.Vector3(1, 1, 1);
const _y = new THREE.Vector3(0, 1, 0);
function shadowNearOnly() { this.userData.fullCount = this.count; this.count = this.userData.nearCount; }
function shadowRestore() { this.count = this.userData.fullCount; }
export function addCars(rs, spots, group) {
  if (!spots || !spots.length) return [];
  const g = group || (rs._town ? rs._town.groups.town : rs.world);
  const mat = carMaterial(rs);
  const buckets = new Map();
  spots.forEach((sp) => {
    const k = sp.type + ':' + Math.floor((sp.s || 0) / 700);
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = []));
    b.push(sp);
  });
  const out = [];
  buckets.forEach((arr) => {
    arr.sort((a, b) => (b.sh ? 1 : 0) - (a.sh ? 1 : 0));
    const im = new THREE.InstancedMesh(geoCar(arr[0].type), mat, arr.length);
    let near = 0;
    arr.forEach((sp, i) => {
      _q.setFromAxisAngle(_y, sp.yaw || 0);
      _p.set(sp.x, sp.y, sp.z);
      _m4.compose(_p, _q, _one);
      im.setMatrixAt(i, _m4);
      _c.setRGB(sp.r, sp.g, sp.b);
      im.setColorAt(i, _c);
      if (sp.sh) near++;
      sp._im = im; sp._i = i;
    });
    im.instanceColor.needsUpdate = true;
    im.castShadow = near > 0;
    im.receiveShadow = true;
    if (near > 0 && near < arr.length) {
      im.userData.nearCount = near;
      im.onBeforeShadow = shadowNearOnly;
      im.onAfterShadow = shadowRestore;
    }
    /* 自前でかたまりに分けてあるので _splitInstances にはかけない。見え方を切り替えないので遠方の間引き(cullCell)の対象。
     * carType: 遠くで軽い形に差しかえるとき(town.js carLod)に使う */
    im.userData.noSplit = true;
    im.userData.carType = arr[0].type;
    im.userData.cullCell = true;
    im.computeBoundingSphere();
    g.add(im);
    out.push(im);
  });
  return out;
}
