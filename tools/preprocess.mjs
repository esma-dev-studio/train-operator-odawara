/* =========================================================
 * preprocess.mjs — 実線形データの事前処理（開発時に1回だけ実行）
 * 入力: 国土数値情報 N02-24（鉄道）GeoJSON
 * 出力: ../data/line.json（5m間隔の線形・駅・曲線制限・勾配・区間情報）
 *
 * 使い方: node preprocess.mjs <RailroadSection.geojson> <Station.geojson> [--skip-elev]
 * 標高は国土地理院 標高APIを50m間隔で取得（約1分・開発時のみ）。
 * ========================================================= */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const [railPath, stPath] = process.argv.slice(2);
const SKIP_ELEV = process.argv.includes('--skip-elev');

const LINE = '小田原線';
const OPERATOR = '小田急';
const STATIONS = [
  ['新宿', 'Shinjuku'], ['南新宿', 'Minami-Shinjuku'], ['参宮橋', 'Sangubashi'],
  ['代々木八幡', 'Yoyogi-Hachiman'], ['代々木上原', 'Yoyogi-Uehara'], ['東北沢', 'Higashi-Kitazawa'],
  ['下北沢', 'Shimo-Kitazawa'], ['世田谷代田', 'Setagaya-Daita'], ['梅ヶ丘', 'Umegaoka'],
  ['豪徳寺', 'Gotokuji'], ['経堂', 'Kyodo'], ['千歳船橋', 'Chitose-Funabashi'],
  ['祖師ヶ谷大蔵', 'Soshigaya-Okura'], ['成城学園前', 'Seijogakuen-mae'], ['喜多見', 'Kitami'],
  ['狛江', 'Komae'], ['和泉多摩川', 'Izumi-Tamagawa'], ['登戸', 'Noborito'],
  ['向ヶ丘遊園', 'Mukogaoka-Yuen'], ['生田', 'Ikuta'], ['読売ランド前', 'Yomiuriland-mae'],
  ['百合ヶ丘', 'Yurigaoka'], ['新百合ヶ丘', 'Shin-Yurigaoka'],
];

/* ---- 読み込みと路線抽出 ---- */
const rail = JSON.parse(readFileSync(railPath, 'utf8'));
const stGeo = JSON.parse(readFileSync(stPath, 'utf8'));
const segs = rail.features.filter((f) =>
  f.properties.N02_003 === LINE && String(f.properties.N02_004 || '').includes(OPERATOR));
console.log('小田原線セグメント数:', segs.length);

const stFeats = stGeo.features.filter((f) =>
  f.properties.N02_003 === LINE && String(f.properties.N02_004 || '').includes(OPERATOR));
const stMap = new Map();
stFeats.forEach((f) => {
  const name = f.properties.N02_005;
  const cs = f.geometry.coordinates;
  const mid = cs[Math.floor(cs.length / 2)];
  stMap.set(name, mid);
});
console.log('駅数(路線全体):', stMap.size);

/* ---- セグメントを端点一致でつないで 新宿→新百合ヶ丘 の1本にする ---- */
const key = (c) => c[0].toFixed(6) + ',' + c[1].toFixed(6);
const adj = new Map(); // 端点 -> [{seg, reversed}]
segs.forEach((f, i) => {
  const cs = f.geometry.coordinates;
  const a = key(cs[0]), b = key(cs[cs.length - 1]);
  if (!adj.has(a)) adj.set(a, []);
  if (!adj.has(b)) adj.set(b, []);
  adj.get(a).push({ i, rev: false });
  adj.get(b).push({ i, rev: true });
});

const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
const start = stMap.get('新宿');
const goal = stMap.get('新百合ヶ丘');
if (!start || !goal) throw new Error('端点駅が見つからない');

/* 新宿に最も近いセグメント端点から貪欲に歩く（小田原線は一本鎖+分岐は新百合ヶ丘のみ） */
let bestStartKey = null, bestD = 1e9;
for (const k of adj.keys()) {
  const c = k.split(',').map(Number);
  const d = dist2(c, start);
  if (d < bestD) { bestD = d; bestStartKey = k; }
}
const used = new Set();
let path = [];
let cur = bestStartKey;
while (true) {
  const options = (adj.get(cur) || []).filter((o) => !used.has(o.i));
  if (!options.length) break;
  /* 分岐したら「ゴールに近づく方」を選ぶ */
  let pick = options[0];
  if (options.length > 1) {
    let bd = 1e9;
    for (const o of options) {
      const cs = segs[o.i].geometry.coordinates;
      const far = o.rev ? cs[0] : cs[cs.length - 1];
      const d = dist2(far, goal);
      if (d < bd) { bd = d; pick = o; }
    }
  }
  used.add(pick.i);
  let cs = segs[pick.i].geometry.coordinates.slice();
  if (pick.rev) cs.reverse();
  if (path.length) cs = cs.slice(1);
  path.push(...cs);
  cur = key(path[path.length - 1]);
  /* ゴール到達判定（新百合ヶ丘の近くまで来たら止める） */
  if (dist2(path[path.length - 1], goal) < (0.002) ** 2) break;
}
console.log('つないだ頂点数:', path.length);

/* ---- ローカル平面（メートル）へ投影 ---- */
const lat0 = 35.646, lon0 = 139.63;
const mPerLat = 110950, mPerLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
const toXY = ([lon, lat]) => [(lon - lon0) * mPerLon, (lat - lat0) * mPerLat];
let pts = path.map(toXY);

/* ---- 新宿側の始点を新宿駅位置でトリム＆5mリサンプル ---- */
const cum = [0];
for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
const total = cum[cum.length - 1];
console.log('全長(トリム前):', (total / 1000).toFixed(2), 'km');

const projectS = (p) => {
  /* 点pを折れ線に射影して走行位置s(m)を返す */
  let best = { s: 0, d: 1e18 };
  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i - 1][0], ay = pts[i - 1][1];
    const bx = pts[i][0], by = pts[i][1];
    const vx = bx - ax, vy = by - ay;
    const L2 = vx * vx + vy * vy;
    if (L2 === 0) continue;
    let t = ((p[0] - ax) * vx + (p[1] - ay) * vy) / L2;
    t = Math.max(0, Math.min(1, t));
    const qx = ax + vx * t, qy = ay + vy * t;
    const d = (p[0] - qx) ** 2 + (p[1] - qy) ** 2;
    if (d < best.d) best = { s: cum[i - 1] + Math.sqrt(L2) * t, d };
  }
  return best;
};

const sList = STATIONS.map(([name]) => {
  const c = stMap.get(name);
  if (!c) throw new Error('駅が見つからない: ' + name);
  const pr = projectS(toXY(c));
  return { name, s: pr.s, off: Math.sqrt(pr.d) };
});
sList.forEach((st, i) => console.log(st.name, (st.s / 1000).toFixed(3) + 'km', 'off', st.off.toFixed(1) + 'm'));

/* 走行方向確認（新宿→新百合ヶ丘でsが増えること） */
if (sList[0].s > sList[sList.length - 1].s) throw new Error('向きが逆');

const S0 = sList[0].s;             // 新宿を0kmに
const SEND = sList[sList.length - 1].s + 250;  // 新百合ヶ丘の先まで少し

/* 5mリサンプル */
const STEP = 5;
const N = Math.floor((SEND - S0) / STEP) + 1;
const sample = (s) => {
  /* s(グローバル)の座標 */
  let lo = 0, hi = cum.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < s) lo = mid + 1; else hi = mid; }
  const i = Math.max(1, lo);
  const t = (s - cum[i - 1]) / Math.max(1e-9, cum[i] - cum[i - 1]);
  return [
    pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t,
    pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t,
  ];
};
const P = [];
for (let i = 0; i < N; i++) P.push(sample(S0 + i * STEP));

/* ---- 曲率 → 半径 → 制限速度 ---- */
const radiusAt = (i, w = 8) => {
  const a = P[Math.max(0, i - w)], b = P[i], c = P[Math.min(N - 1, i + w)];
  const A = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const B = Math.hypot(c[0] - b[0], c[1] - b[1]);
  const C = Math.hypot(c[0] - a[0], c[1] - a[1]);
  const s2 = (A + B + C) / 2;
  const area = Math.sqrt(Math.max(0, s2 * (s2 - A) * (s2 - B) * (s2 - C)));
  if (area < 1e-6) return 1e9;
  return (A * B * C) / (4 * area);
};
const limitOfR = (r) =>
  r < 140 ? 40 : r < 180 ? 45 : r < 240 ? 55 : r < 320 ? 60 : r < 420 ? 70 :
  r < 550 ? 75 : r < 700 ? 85 : r < 900 ? 90 : r < 1300 ? 95 : 100;
const rawLim = [];
for (let i = 0; i < N; i++) rawLim.push(limitOfR(radiusAt(i)));
/* 前後60m(12pt)の最小値で平滑化（短い緩みを消す） */
const lim = [];
for (let i = 0; i < N; i++) {
  let m = 200;
  for (let j = Math.max(0, i - 12); j <= Math.min(N - 1, i + 12); j++) m = Math.min(m, rawLim[j]);
  lim.push(m);
}
/* ゾーン化（同じ制限が続く区間へ。100はゾーン化しない=線区最高） */
const zones = [];
let zs = 0;
for (let i = 1; i <= N; i++) {
  if (i === N || lim[i] !== lim[zs]) {
    if (lim[zs] < 100) zones.push({ from: zs * STEP, to: i * STEP, v: lim[zs] });
    zs = i;
  }
}
/* 100m未満の孤立ゾーンは前後に吸収（隣の低い方に合わせる） */
const zones2 = zones.filter((z) => z.to - z.from >= 60);
console.log('制限ゾーン数:', zones2.length);

/* ---- 標高（地理院API 50m間隔）---- */
const toLL = (p) => [p[0] / mPerLon + lon0, p[1] / mPerLat + lat0];
let elev50 = [];
const M = Math.floor((N - 1) * STEP / 50) + 1;
const cachePath = join(__dirname, 'elev_cache.json');
let cached = null;
try { cached = JSON.parse(readFileSync(cachePath, 'utf8')); } catch (e) { /* なし */ }
if (SKIP_ELEV) {
  for (let i = 0; i < M; i++) elev50.push(35);
} else if (cached && cached.length === M) {
  elev50 = cached.slice();
  console.log('標高キャッシュを使用');
} else {
  for (let i = 0; i < M; i++) {
    const p = P[Math.min(N - 1, Math.round((i * 50) / STEP))];
    const [lon, lat] = toLL(p);
    const url = `https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?lon=${lon.toFixed(6)}&lat=${lat.toFixed(6)}&outtype=JSON`;
    try {
      const r = await fetch(url);
      const j = await r.json();
      const e = typeof j.elevation === 'number' ? j.elevation : (elev50.length ? elev50[elev50.length - 1] : 35);
      elev50.push(e);
    } catch (e) {
      elev50.push(elev50.length ? elev50[elev50.length - 1] : 35);
    }
    if (i % 40 === 0) console.log('標高取得', i, '/', M);
    await new Promise((ok) => setTimeout(ok, 90));
  }
  writeFileSync(cachePath, JSON.stringify(elev50));
}
/* 平滑化（±10点=±500m 移動平均を2回 → 線路らしい緩い縦断面へ） */
const smooth = (arr, w) => arr.map((_, i) => {
  let s = 0, n = 0;
  for (let j = Math.max(0, i - w); j <= Math.min(arr.length - 1, i + w); j++) { s += arr[j]; n++; }
  return s / n;
});
elev50 = smooth(smooth(elev50, 10), 6);

/* 地下区間（東北沢〜世田谷代田）: 地表DEMを線路レベルに補正 */
const sOf = (name) => sList.find((x) => x.name === name).s - S0;
const tun0 = sOf('代々木上原') + 450;
const tun1 = sOf('世田谷代田') + 420;
const shimokita = sOf('下北沢');
const elevAt50 = (s) => elev50[Math.max(0, Math.min(M - 1, Math.round(s / 50)))];
const e0 = elevAt50(tun0), e1 = elevAt50(tun1);
for (let i = 0; i < M; i++) {
  const s = i * 50;
  if (s > tun0 && s < tun1) {
    const t = (s - tun0) / (tun1 - tun0);
    const base = e0 + (e1 - e0) * t;
    const depth = 22 * Math.sin(Math.PI * Math.min(1, Math.max(0, t))) ** 0.7; // 下北沢付近が最深
    elev50[i] = base - depth;
  }
}
/* 鉄道の縦断面らしく勾配を±25‰にクランプ（前進/後退パスで斜面制限。坑口の急勾配もならす） */
const MAXG = 0.025 * 50;   // 50mあたり最大1.25m
for (let pass = 0; pass < 3; pass++) {
  for (let i = 1; i < elev50.length; i++) {
    if (elev50[i] - elev50[i - 1] > MAXG) elev50[i] = elev50[i - 1] + MAXG;
    if (elev50[i - 1] - elev50[i] > MAXG) elev50[i] = elev50[i - 1] - MAXG;
  }
  for (let i = elev50.length - 2; i >= 0; i--) {
    if (elev50[i] - elev50[i + 1] > MAXG) elev50[i] = elev50[i + 1] + MAXG;
    if (elev50[i + 1] - elev50[i] > MAXG) elev50[i] = elev50[i + 1] - MAXG;
  }
  elev50 = smooth(elev50, 2);
}

/* 5m点へ補間して勾配も計算 */
const E = [];
for (let i = 0; i < N; i++) {
  const s = i * STEP;
  const f = s / 50;
  const i0 = Math.max(0, Math.min(M - 1, Math.floor(f)));
  const i1 = Math.min(M - 1, i0 + 1);
  const t = f - i0;
  E.push(elev50[i0] + (elev50[i1] - elev50[i0]) * t);
}

/* ---- 区間情報 ---- */
const sections = {
  tunnel: [{ from: Math.round(tun0), to: Math.round(tun1) }],
  river: [{ from: Math.round(sOf('和泉多摩川') + 260), to: Math.round(sOf('和泉多摩川') + 680) }],
  quad: { from: Math.round(sOf('代々木上原')), to: Math.round(sOf('登戸')) },
  /* 街なみ密度: 0=超高層 1=高密 2=中密 3=丘陵住宅 */
  urban: [
    { from: 0, to: 1800, kind: 0 },
    { from: 1800, to: Math.round(sOf('経堂')), kind: 1 },
    { from: Math.round(sOf('経堂')), to: Math.round(sOf('登戸')), kind: 2 },
    { from: Math.round(sOf('登戸')), to: Math.round(SEND - S0), kind: 3 },
  ],
};

/* ---- 出力 ---- */
const out = {
  meta: {
    name: '小田原線 新宿—新百合ヶ丘',
    source: '国土数値情報（鉄道データ N02-24, 国土交通省） / 標高: 国土地理院 標高API',
    generated: new Date().toISOString().slice(0, 10),
    step: STEP,
    length: Math.round(SEND - S0),
  },
  pts: P.map((p, i) => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100, Math.round(E[i] * 100) / 100]),
  stations: sList.map((st, i) => ({
    name: st.name,
    en: STATIONS[i][1],
    code: 'OH' + String(i + 1).padStart(2, '0'),
    s: Math.round((st.s - S0) * 10) / 10,
  })),
  limits: zones2.map((z) => ({ from: Math.round(z.from), to: Math.round(z.to), v: z.v })),
  lineMax: 100,
  sections,
};
mkdirSync(join(__dirname, '..', 'data'), { recursive: true });
writeFileSync(join(__dirname, '..', 'data', 'line.json'), JSON.stringify(out));
console.log('書き出し完了: data/line.json',
  'points', out.pts.length,
  'stations', out.stations.length,
  'limits', out.limits.length,
  'length', (out.meta.length / 1000).toFixed(2) + 'km');
