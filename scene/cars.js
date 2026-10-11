/* =========================================================
 * scene/cars.js — 自動車(軽・ミニバン・セダン・路線バス): 家の車庫・月極駐車場・踏切待ちの車・道を走る車
 *
 * ・形は「横から見た輪郭」を左右に押し出した角柱 + 窓ガラス(グリーンハウス) + タイヤ4つ + 灯火。
 *   1台およそ110三角形。種類ごと・700mごとに1つの InstancedMesh にまとめる(描画は種類×かたまりの数だけ)。
 * ・材質は木の材質と同じシェーダ('fc-tree')を使う(新しいシェーダを増やさない):
 *   頂点色が2以上の部分(ガラス・タイヤ・灯火)は「固定色」で、インスタンス色(塗装)に染めない。
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
    .replace('#include <common>', '#include <common>\nvarying float vLamp;')
    .replace('#include <color_vertex>', `#include <color_vertex>
vLamp = 0.;
#ifdef USE_COLOR
#ifdef USE_INSTANCING_COLOR
float fcOn = step(1.5, instanceColor.r);
vColor.r -= 2. * fcOn * color.r;
vLamp = step(2.45, color.r) * fcOn;
#endif
if (color.r > 1.5) vColor.xyz = color.xyz - 2.0;
#endif`);
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform float uCarLamp;\nuniform float uFcAmb;\nvarying float vLamp;')
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

/* 多角形(x-y平面・反時計回り。0番の頂点から全体が見えること)を z0..z1 に押し出した角柱。
 * caps: 'both' / 'z0' / 'z1'(見えない側のふたを省く) */
function prism(poly, z0, z1, caps = 'both') {
  const pos = [], nor = [];
  const tri = (a, b, c, n) => { pos.push(...a, ...b, ...c); nor.push(...n, ...n, ...n); };
  const n = poly.length;
  for (let k = 1; k < n - 1; k++) {
    const A = poly[0], B = poly[k], C = poly[k + 1];
    if (caps !== 'z0') tri([A[0], A[1], z1], [B[0], B[1], z1], [C[0], C[1], z1], [0, 0, 1]);
    if (caps !== 'z1') tri([A[0], A[1], z0], [C[0], C[1], z0], [B[0], B[1], z0], [0, 0, -1]);
  }
  for (let k = 0; k < n; k++) {
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
/* タイヤ(六角柱・外側のふただけ。半径 r) */
const hexOf = (r) => {
  const a = [];
  for (let k = 0; k < 6; k++) a.push([r * Math.cos((k * Math.PI) / 3 + Math.PI / 6), r * Math.sin((k * Math.PI) / 3 + Math.PI / 6)]);
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

/* 1台の形(モジュールで1回だけ作る)。原点=車体の中心の真下(地面)、前=+z、幅=x */
const GEO = {};
export function geoCar(type) {
  if (GEO[type]) return GEO[type];
  const S = SPEC[type], hw = S.w / 2, L = CAR_LEN[type];
  const parts = [{ g: prism(S.prof, -hw, hw), col: [1, 1, 1] }];
  /* 窓ガラス: 車体より少しだけ外に出して、横の窓・前後のガラスとして見せる(屋根の縁は塗装のまま) */
  parts.push({ g: prism(S.glass, -hw - 0.005, hw + 0.005), col: COL_GLASS });
  /* バスのすそ(灰色の帯) */
  if (S.skirt) parts.push({ g: prism(S.skirt, -hw - 0.008, hw + 0.008), col: COL_SKIRT });
  /* タイヤ(軸は幅の向き。外側のふただけ) */
  const tr = S.r || 0.3, HEX = hexOf(tr);
  S.wheels.forEach((x) => {
    [-1, 1].forEach((sd) => {
      const poly = HEX.map(([px, py]) => [x + px, tr + py]);
      const zi = sd * (hw - 0.18), zo = sd * (hw + 0.02);
      parts.push({ g: sd > 0 ? prism(poly, zi, zo, 'z1') : prism(poly, zo, zi, 'z0'), col: COL_TIRE });
    });
  });
  /* 前照灯・尾灯(車体の前後の面に貼る) */
  [-1, 1].forEach((sd) => {
    parts.push({ g: lampQuad(L + 0.006, S.head, sd * (hw - 0.24), 0.34, 0.16, 1), col: COL_HEAD });
    parts.push({ g: lampQuad(-0.006, S.tail, sd * (hw - 0.17), 0.24, 0.18, -1), col: COL_TAIL });
  });
  const g = merge(parts);
  /* 長さ方向(x)を +z に、中心を原点へ */
  g.rotateY(-Math.PI / 2);
  g.translate(0, 0, -L / 2);
  g.computeBoundingSphere();
  GEO[type] = g;
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
    /* 自前でかたまりに分けてあるので _splitInstances にはかけない。見え方を切り替えないので遠方の間引き(cullCell)の対象 */
    im.userData.noSplit = true;
    im.userData.cullCell = true;
    im.computeBoundingSphere();
    g.add(im);
    out.push(im);
  });
  return out;
}
