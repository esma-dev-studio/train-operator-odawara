/* =========================================================
 * scene/stations.js — 駅: ホーム(へり・点字ブロック・柵)・屋根・柱・照明・駅名標・
 * 時計・ベンチ・自販機・待つ人／乗り降りする人、新宿ターミナル、トンネル照明
 * RailScene(rs)の各 _build* から呼ぶ。描画専用(運転の判定には関わらない)。
 *
 * ホームの寸法(線路中心からの横の距離。+が進行方向の左):
 *   左ホーム: へり 1.58 〜 うしろ 5.0 / 右ホーム: へり -5.38 〜 うしろ -8.8
 *   (車体のはば 1.475 とのすき間は約0.1m。急行線(7.0/10.8)の車体にもかからない)
 *
 * 描画回数を減らすため、1つの駅の動かない部品(ホーム・柵・屋根・柱・支柱・ベンチ・
 * 自販機・時計のふち)は、1枚の画像(アトラス)＋頂点色で1つの形に焼きこむ(駅ごとに描画1回)。
 * 新宿の壁の広告・「↑ でぐち」・「のりかえ」・改札の灯・終点の「しゅうてん」の板は発車標と同じ画像に描き、
 * 発車標といっしょに描く(描画はふえない)。待つ人の足もとの影は駅ごとに1回(光だまりと同じシェーダ)。
 * ほかの係へ: rs._stop8Y / rs._stop8Size(「8」の板の中心の高さ・大きさ)、rs._roofSpans(屋根の下の範囲)
 * ========================================================= */
import * as THREE from '../vendor/three.module.min.js';
import { placeTrain } from './traffic.js';
import { poolTexture, poolStripTexture, makePoolMaterial, addPools } from './lightpool.js';
import {
  newFrame, frameInto, frameOf, flatT, canvasTexture, redrawWhenFonts, fitText, kanaOf,
  texStationSign, texSignPlaceholder, SIGN_UV, Baker, bakerFor, flushSigns, makeSign, finishAtlas,
  buildBoards as buildBoardsAt, buildSignals as buildSignalsAt, updateSignals, texLed, lineBaker, lineBoard,
} from './signage.js';
import { stationStyles, STAIR, quadOffAt, fenceOffL, TUN_LAMP } from './trackbed.js';
import { SERVICES } from '../sim/engine.js';

export { updateSignals };
export const PLAT = { L: { edge: 1.58, back: 5.0 }, R: { edge: -5.38, back: -8.8 } };
/* 停止位置目標「8」の位置(停止位置 st.s から前へ)。0 = 判定の点(engine の stopAt)そのもの。
 * ぴったり止まると、板は運転士の左の窓のよこ(実際の運転と同じ)。近づくあいだは画面の左に見えていて、
 * 最後の数mで窓わくの外へ出ていく。予告(300/200/100/50m)もここから測る。
 * P6 は rs._stop8Ahead / rs._stop8Lat / rs._stop8Y(板の中心の高さ) / rs._stop8Size(板の大きさ) で
 * 光の目印と画面の目印を板にそろえる */
export const STOP8_AHEAD = 0;
/* 「8」の柱の横の位置(左ホームのへりから0.6m)。運転士の目が先頭から1mうしろでも、ぴったり止まったとき
 * 板が窓わくの左はしの外(またはちょうどはし)に出る。近づくあいだは左の手前に見える */
export const STOP8_LAT = PLAT.L.edge + 0.6;
/* 「8」の板の大きさ(0.82m 角)と、板の中心の高さ(レール面から 2.8m = ホーム面 1.05 + 柱 1.75)。
 * 1280x800 の画面(3Dの部分は 1280x604・たての画角58°)で、運転台の目(先頭の1mうしろ)から
 * 10m 手前で 約41px(0.5m の板は 約25px で小さすぎた)。板の内がわのはしは横 1.77m で車体(1.475m)にかからない */
export const STOP8_SIZE = 0.82;
export const STOP8_Y = 2.8;
const P_A = 155, P_B = 15;              // ホームの範囲: st.s-155 〜 st.s+15
/* 屋根: st.s-roofA(駅ごと 95/125/140) 〜 st.s+10(停止位置の運転台の上と、その先の発車標まで)。
 * 屋根の先の端とホームの先の端(st.s+P_B)は同じ5mの目に丸めるので、屋根はいつもホームの端の5m手前で終わる */
const ROOF_B = 10;
/* 8両の電車のドアの位置(各車両の先頭からの距離。先頭車の先頭 = 停止位置) */
const DOOR_OFF = [2.9, 7.7, 12.4, 17.2];
/* 乗る人(動く12人のうち4人)が待つドア(停止位置からの距離)。止まっている人の列は ここには並べない */
const BOARD_DOORS = [17.2, 22.9, 27.7, 32.4];
/* 降りる人(動く12人のうち2人)が歩くところ(停止位置からの距離。運転台から見える先のほう。
 * 運転台の目の前8m以内には入らない) */
const ALIGHT_S = [9.0, 12.2];

/* 駅の見た目の型: { kind: 'over'|'foot'|'house', roofCol, roofA }(駅名から毎回同じに決まる) */
export function stationStyle(rs, st, si) {
  const all = stationStyles(rs);
  return all[si] || { kind: 'house', roofCol: 0x3d4a56, roofA: 125 };
}
/* くだりの終点(路線のいちばん最後の駅。新宿のターミナルはのぞく)か */
export function isGoalStation(rs, si) {
  const sts = rs.line.stations;
  return rs.line.meta.direction !== 'up' && si === sts.length - 1 && sts[si].name !== '新宿';
}
/* 屋根の長さ(st.s-roofA から)。くだりの終点(地上)はホームの はしから はしまで(ゴールの駅らしく。
 * 階段は屋根をつきぬけて上の駅舎へ) */
function roofLen(rs, si) {
  const S = stationStyle(rs, rs.line.stations[si], si);
  return isGoalStation(rs, si) && !rs._inTunnel(rs.line.stations[si].s) ? P_A : S.roofA;
}
const UPV = new THREE.Vector3(0, 1, 0);
const DS = THREE.DoubleSide;
const mid = (P) => (P.edge + P.back) / 2;
const sideOf = (sg) => (sg > 0 ? PLAT.L : PLAT.R);

/* 駅アトラス(512x512。縦512px=線路方向6m)の横の割り当て */
const AT = {
  plat: (t) => 0.5 * t,             //   0〜256px ホーム断面(待避すき間・へり・笠石・舗装・点字ブロック・側面)
  under: (t) => 0.5 + 0.25 * t,     // 256〜384px 屋根の天井(中央に照明の帯)
  top: (t) => 0.75 + 0.0625 * t,    // 384〜416px 屋根の波板
  white: 432 / 512,                 // 416〜448px 白(頂点色だけの部品)
  fence: (t) => 0.875 + 0.125 * t,  // 448〜512px 柵(アルファ抜き)
};
const WHITE = [AT.white, 0.5];
const LAMP_U = [0.48, 0.52];         // 天井の中の照明の帯(断面の割合)

/* ---------- 断面を線路に沿って押し出す ----------
 * prof: [[横u, 高さy, texU], ...]。区間ごとに頂点を分けるので角はとがったまま。
 * UV: x=texU / y=距離/uvScale。userData: rows/cols/i0(P2の帯まとめ処理と同じ約束) */
export function profileStrip(frames, i0, i1, prof, uvScale = 6, step = 5) {
  const nSeg = prof.length - 1, C = nSeg * 2, rows = i1 - i0 + 1;
  const pos = new Float32Array(rows * C * 3), uv = new Float32Array(rows * C * 2);
  const idx = [];
  for (let r = 0; r < rows; r++) {
    const i = i0 + r, f = frames[i];
    const v = (i * step) / uvScale;
    for (let j = 0; j < nSeg; j++) {
      for (let e = 0; e < 2; e++) {
        const P = prof[j + e], o = r * C + j * 2 + e;
        pos[o * 3] = f.p.x + f.left.x * P[0];
        pos[o * 3 + 1] = f.p.y + P[1];
        pos[o * 3 + 2] = f.p.z + f.left.z * P[0];
        uv[o * 2] = P[2];
        uv[o * 2 + 1] = v;
      }
    }
    if (r) {
      for (let j = 0; j < nSeg; j++) {
        const a = (r - 1) * C + j * 2, b = a + 1, c = r * C + j * 2, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.userData.rows = rows; g.userData.cols = C; g.userData.i0 = i0;
  return g;
}

/* 線路に直角な四角(屋根の端のふたなど)。pts: [[横u, 高さy] x4] */
function capGeo(f, pts) {
  const pos = [];
  pts.forEach(([u, y]) => pos.push(f.p.x + f.left.x * u, f.p.y + y, f.p.z + f.left.z * u));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.computeVertexNormals();
  return g;
}

/* ホームの端のふた: 断面の外形を三角形に分けて、線路に直角な面にする。
 * out: 外への向き(+1 = s がふえる側の端、-1 = へる側の端)。法線は ぜんぶ同じ水平の向き(t*out)にして、
 * 三角形ごとに明るさがちがって見える(つぎはぎ模様)のをふせぐ。色はホームの側面と同じ灰色を頂点色で */
function endCap(f, prof, texU, out = 1) {
  const pts = [];
  prof.forEach((P) => {
    const l = pts[pts.length - 1];
    if (!l || Math.abs(l.x - P[0]) > 1e-4 || Math.abs(l.y - P[1]) > 1e-4) pts.push(new THREE.Vector2(P[0], P[1]));
  });
  if (THREE.ShapeUtils.isClockWise(pts)) pts.reverse();
  const tris = THREE.ShapeUtils.triangulateShape(pts, []);
  const pos = [], uv = [], nor = [];
  const nx = f.t.x, nz = f.t.z, nl = Math.hypot(nx, nz) || 1;
  pts.forEach((v) => {
    pos.push(f.p.x + f.left.x * v.x, f.p.y + v.y, f.p.z + f.left.z * v.x);
    uv.push(texU, 0.5);
    nor.push((nx / nl) * out, 0, (nz / nl) * out);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  /* 三角形のまわる向き(表)は (left, 上) の面で左まわり = +t。外向きが -t の端は うら返して、表と法線をそろえる
   * (両面の材質は うらから見ると法線を反転するので、そろっていないと日の当たる面が暗くなる) */
  g.setIndex(out < 0 ? tris.map((t) => [t[0], t[2], t[1]]).flat() : tris.flat());
  return g;
}

/* 頂点色つきでまとめる(人・ベンチなど。色は見た目のsRGBで指定) extra: 追加の頂点属性 {名前: 値(部品ごと)} */
function mergeColored(parts, extraNames = []) {
  const geos = parts.map((pt) => {
    const g = pt[0].index ? pt[0].toNonIndexed() : pt[0];
    return { g, c: new THREE.Color(pt[1]), ex: pt[2] || {} };
  });
  const N = geos.reduce((a, x) => a + x.g.attributes.position.count, 0);
  const pos = new Float32Array(N * 3), nor = new Float32Array(N * 3), col = new Float32Array(N * 3);
  const ex = extraNames.map(() => new Float32Array(N));
  let o = 0;
  geos.forEach(({ g, c, ex: e }) => {
    const n = g.attributes.position.count;
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    for (let i = 0; i < n; i++) { col[(o + i) * 3] = c.r; col[(o + i) * 3 + 1] = c.g; col[(o + i) * 3 + 2] = c.b; }
    extraNames.forEach((nm, k) => ex[k].fill(e[nm] || 0, o, o + n));
    o += n;
  });
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  extraNames.forEach((nm, k) => out.setAttribute(nm, new THREE.BufferAttribute(ex[k], 1)));
  return out;
}

/* a→b を結ぶ細い角棒(太さ w)を駅の形に焼きこむ(手すりなど)。a, b は [x,y,z] */
const _bb = { a: new THREE.Vector3(), b: new THREE.Vector3(), x: new THREE.Vector3(), y: new THREE.Vector3(), z: new THREE.Vector3(), m: new THREE.Matrix4() };
let _barGeo = null;
function bakeBar(B, a, b, w, col) {
  if (!_barGeo) _barGeo = new THREE.BoxGeometry(1, 1, 1);
  const T = _bb;
  T.a.fromArray(a); T.b.fromArray(b);
  T.z.subVectors(T.b, T.a);
  const len = T.z.length();
  if (len < 1e-4) return;
  T.z.divideScalar(len);
  T.x.crossVectors(UPV, T.z);
  if (T.x.lengthSq() < 1e-6) T.x.set(1, 0, 0); else T.x.normalize();
  T.y.crossVectors(T.z, T.x);
  T.m.makeBasis(T.x.multiplyScalar(w), T.y.multiplyScalar(w), T.z.multiplyScalar(len)).setPosition(T.a.add(T.b).multiplyScalar(0.5));
  B.geo(_barGeo, { m: T.m, col, white: true });
}

/* ---------- テクスチャ ---------- */
/* 駅アトラス(512x512, 縦=線路方向6m) */
function texStationAtlas() {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const H = 512, TILE = 25.6;            // 0.3m = 25.6px
  return canvasTexture(512, H, (c) => {
    c.clearRect(0, 0, 512, H);
    /* --- ホーム断面 0〜256 --- */
    c.fillStyle = '#3b3c3a'; c.fillRect(0, 0, 24, H);                  // へりの下の待避すき間(暗い)
    c.fillStyle = '#dcdad3'; c.fillRect(24, 0, 16, H);                 // へりの立ち上がり
    c.fillStyle = 'rgba(0,0,0,0.14)'; c.fillRect(24, 0, 2, H);
    c.fillStyle = '#cfccc4'; c.fillRect(40, 0, 24, H);                 // 笠石
    c.fillStyle = '#f6f5f0'; c.fillRect(44, 0, 2, H);                  // 白線
    c.fillStyle = 'rgba(0,0,0,0.16)'; for (let y = 0; y < H; y += TILE * 2) c.fillRect(40, Math.round(y), 24, 1);
    const paving = (x0, x1, du) => {
      c.fillStyle = '#b9b6ae'; c.fillRect(x0, 0, x1 - x0, H);
      for (let i = 0; i < (x1 - x0) * 9; i++) {
        c.fillStyle = rnd() < 0.5 ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.06)';
        c.fillRect(x0 + rnd() * (x1 - x0), rnd() * H, 1 + rnd() * 2, 1 + rnd() * 2);
      }
      c.fillStyle = 'rgba(40,38,34,0.22)';
      for (let x = x0 + du; x < x1 - 1; x += du) c.fillRect(Math.round(x), 0, 1, H);
      for (let y = 0; y < H; y += TILE) c.fillRect(x0, Math.round(y), x1 - x0, 1);
    };
    paving(64, 112, 24);
    /* 点字ブロック(0.3m角に5x5の点)+内側の線(内方線) */
    c.fillStyle = '#d4ac2c'; c.fillRect(112, 0, 48, H);
    c.fillStyle = 'rgba(0,0,0,0.25)'; for (let y = 0; y < H; y += TILE) c.fillRect(112, Math.round(y), 48, 1);
    for (let ty = 0; ty < H - 1; ty += TILE) {
      for (let iy = 0; iy < 5; iy++) {
        for (let ix = 0; ix < 5; ix++) {
          const x = 116.5 + ix * 8.2, y = ty + 2.6 + iy * 5.12;
          c.fillStyle = 'rgba(110,84,10,0.7)'; c.beginPath(); c.arc(x + 0.6, y + 0.6, 1.9, 0, 7); c.fill();
          c.fillStyle = '#ebc84c'; c.beginPath(); c.arc(x, y, 1.8, 0, 7); c.fill();
          c.fillStyle = 'rgba(255,246,200,0.85)'; c.beginPath(); c.arc(x - 0.6, y - 0.6, 0.7, 0, 7); c.fill();
        }
      }
    }
    c.fillStyle = '#e4bd3c'; c.fillRect(154, 0, 6, H);
    c.fillStyle = 'rgba(110,84,10,0.6)'; c.fillRect(159, 0, 1, H);
    c.fillStyle = 'rgba(255,246,200,0.6)'; c.fillRect(154, 0, 1, H);
    paving(160, 240, 10.5);
    c.fillStyle = '#a9a69e'; c.fillRect(240, 0, 16, H);               // ホームうしろの側面
    c.fillStyle = 'rgba(0,0,0,0.15)'; c.fillRect(240, 0, 1, H);
    /* --- 屋根の天井 256〜384(0.6mのパネル、中央に照明の帯、6mごとに器具の端) --- */
    c.fillStyle = '#cdd1d3'; c.fillRect(256, 0, 128, H);
    c.fillStyle = 'rgba(60,66,70,0.28)';
    for (let y = 0; y < H; y += TILE * 2) c.fillRect(256, Math.round(y), 128, 1);
    for (let x = 256; x < 384; x += 20.4) c.fillRect(Math.round(x), 0, 1, H);
    const l0 = 256 + 128 * LAMP_U[0], l1 = 256 + 128 * LAMP_U[1];
    c.fillStyle = '#9aa1a6'; c.fillRect(l0 - 3, 0, l1 - l0 + 6, H);       // 照明の器具
    c.fillStyle = '#f4f1e6'; c.fillRect(l0, 10, l1 - l0, H - 20);         // 光る帯
    c.fillStyle = '#6f777d'; c.fillRect(l0 - 3, 0, l1 - l0 + 6, 10); c.fillRect(l0 - 3, H - 10, l1 - l0 + 6, 10);
    /* --- 屋根の上 384〜416(波板。線路方向に山がならぶ) --- */
    for (let y = 0; y < H; y++) {
      const k = 0.5 + 0.5 * Math.sin((y / 12.8) * Math.PI * 2);
      const v = Math.round(80 + k * 30);
      c.fillStyle = `rgb(${v},${v + 9},${v + 16})`;
      c.fillRect(384, y, 32, 1);
    }
    /* --- 白 416〜448 --- */
    c.fillStyle = '#ffffff'; c.fillRect(416, 0, 32, H);
    /* --- 柵 448〜512(横=下→上の高さ、縦=線路方向。0.1mごとの縦の桟) --- */
    c.fillStyle = '#e3e6e4';
    c.fillRect(448, 0, 4, H);            // 下の横材
    c.fillRect(505, 0, 7, H);            // 上の手すり
    c.fillRect(478, 0, 3, H);            // 中の横材
    for (let y = 0; y < H; y += 8.533) c.fillRect(448, Math.round(y), 64, 3);
    c.fillStyle = '#8a908e';
    for (let y = 0; y < H; y += 136.5) c.fillRect(448, Math.round(y), 64, 5);   // 1.6mごとの支柱
  }, { wrapT: THREE.RepeatWrapping });
}

/* 駅の時計(128px。外は透明)。ゲーム内時刻を指す */
function drawClock(c, hh, mm) {
  c.clearRect(0, 0, 128, 128);
  c.fillStyle = '#20262c'; c.beginPath(); c.arc(64, 64, 63, 0, 7); c.fill();
  c.fillStyle = '#fbfbf8'; c.beginPath(); c.arc(64, 64, 56, 0, 7); c.fill();
  c.fillStyle = '#1b2228';
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2, big = i % 5 === 0;
    const r0 = big ? 45 : 50, r1 = 54;
    c.save(); c.translate(64, 64); c.rotate(a);
    c.fillRect(big ? -1.6 : -0.6, -r1, big ? 3.2 : 1.2, r1 - r0);
    c.restore();
  }
  c.font = '700 13px "Zen Kaku Gothic New", "Hiragino Sans", Meiryo, sans-serif';
  c.textAlign = 'center'; c.textBaseline = 'middle';
  for (let h = 1; h <= 12; h++) {
    const a = (h / 12) * Math.PI * 2;
    c.fillText(String(h), 64 + Math.sin(a) * 36, 65 - Math.cos(a) * 36);
  }
  const hand = (ang, len, w, col) => {
    c.save(); c.translate(64, 64); c.rotate(ang);
    c.fillStyle = col; c.fillRect(-w / 2, -len, w, len + 8);
    c.restore();
  };
  hand((((hh % 12) + mm / 60) / 12) * Math.PI * 2, 30, 5, '#11161a');
  hand((mm / 60) * Math.PI * 2, 46, 3.4, '#11161a');
  c.fillStyle = '#11161a'; c.beginPath(); c.arc(64, 64, 4, 0, 7); c.fill();
}

/* 新宿ターミナルの柱(0.55m角・高さ7.4m)。256x512 を横に4マス(64px): 0=a の札つき / 1=b の札つき / 2・3=札なし。
 * 札は目の高さ(床から2.2〜2.9m)の白い板に黒い数字・上に黄色の線(線路のほうを向く2面だけ。ターミナルUVで選ぶ)。
 * 下は0.15mの濃い幅木だけ(前の 1.2m の黒い帯は 台座に見えた)。
 * 縦 512px = 7.4m(69px/m)・横 64px = 0.55m(116px/m)なので、字は縦を 0.6倍にちぢめて描く(できあがりで正しい形) */
const COL_PX = 512 / 7.4;
function texTermColumn(a, b) {
  const t = canvasTexture(256, 512, (c) => {
    [[a, 0], [b, 64], [null, 128], [null, 192]].forEach(([label, x]) => {
      c.fillStyle = '#d8dcdf'; c.fillRect(x, 0, 64, 512);
      c.fillStyle = 'rgba(70,76,82,0.25)';
      for (let y = 0; y < 512; y += 20.8) c.fillRect(x, Math.round(y), 64, 1);
      c.fillRect(x + 31, 0, 1, 512);
      c.fillStyle = 'rgba(255,255,255,0.35)'; c.fillRect(x, 0, 3, 512);
      /* 幅木(下0.15m。柱の根元は床より0.05m下) */
      c.fillStyle = '#3a4046'; c.fillRect(x, 512 - Math.round(0.2 * COL_PX), 64, Math.round(0.2 * COL_PX));
      if (!label) return;
      /* 札: 柱の根元から 2.25〜2.95m(床から2.2〜2.9m) */
      const y0 = Math.round(512 - 2.95 * COL_PX), y1 = Math.round(512 - 2.25 * COL_PX);
      c.fillStyle = '#f2f4f5'; c.fillRect(x + 2, y0, 60, y1 - y0);
      c.fillStyle = '#e2b91c'; c.fillRect(x + 2, y0, 60, 4);
      c.fillStyle = 'rgba(0,0,0,0.25)'; c.fillRect(x + 2, y1 - 1, 60, 1);
      c.save();
      c.translate(x + 32, (y0 + 4 + y1) / 2);
      c.scale(1, COL_PX / 116);
      c.fillStyle = '#16191c';
      fitText(c, label, 0, 2, 54, 40, 900);
      c.restore();
    });
  });
  redrawWhenFonts(t, a + b);
  return t;
}

/* 天井の格子(256px=6m角、0.6mのパネル) */
function texCeiling() {
  return canvasTexture(256, 256, (c) => {
    c.fillStyle = '#a7acb0'; c.fillRect(0, 0, 256, 256);
    c.fillStyle = 'rgba(40,46,52,0.45)';
    for (let k = 0; k <= 10; k++) {
      const x = Math.round(k * 25.6);
      c.fillRect(x, 0, 2, 256); c.fillRect(0, x, 256, 2);
    }
    c.fillStyle = 'rgba(255,255,255,0.1)';
    for (let k = 0; k < 10; k++) c.fillRect(Math.round(k * 25.6) + 3, 0, 1, 256);
    c.fillStyle = 'rgba(30,34,38,0.5)';
    for (let k = 1; k < 10; k += 3) c.fillRect(Math.round(k * 25.6) + 9, 9, 8, 8);   // 空調の吹き出し口
  }, { wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping });
}

/* 駅ビルの外壁(12m x 8m で1枚。白いパネルと窓の帯) と夜の窓の光 */
function texTermBuilding(mask) {
  let seed = 41;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  return canvasTexture(192, 128, (c) => {
    c.fillStyle = mask ? '#000' : '#e9e8e3'; c.fillRect(0, 0, 192, 128);
    for (let fl = 0; fl < 2; fl++) {
      const y = fl * 64 + 18;
      for (let x = 0; x < 192; x += 24) {
        if (mask) {
          c.fillStyle = rnd() < 0.62 ? `rgb(${230 + rnd() * 25},${200 + rnd() * 30},${150 + rnd() * 40})` : '#000';
          c.fillRect(x + 2, y, 20, 28);
          continue;
        }
        const g = c.createLinearGradient(0, y, 0, y + 28);
        g.addColorStop(0, '#6f8597'); g.addColorStop(1, '#27313b');
        c.fillStyle = g; c.fillRect(x + 2, y, 20, 28);
        c.fillStyle = 'rgba(255,255,255,0.18)'; c.fillRect(x + 2, y, 20, 3);
      }
      if (!mask) {
        c.fillStyle = 'rgba(0,0,0,0.12)'; c.fillRect(0, y + 28, 192, 3);
        c.fillStyle = 'rgba(0,0,0,0.07)'; c.fillRect(0, fl * 64, 192, 1);
      }
    }
  }, { wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping });
}

/* 新宿の画像(発車標と同じ画像の下 512x512。明るさ2.2倍で光る材質なので、字・絵は明るさを落とした色で描く):
 *  nori: 「のりば」のつり下げ板(濃い地に白・下に黄色の線)2枚 / lamp: 車止めの赤い灯 /
 *  poster: 壁の光る広告(4枚。会社名・字・マークのない、景色や形だけの絵) / deguchi: 「↑ でぐち」(黒地に黄) /
 *  norikae: 「のりかえ」(黒地に緑) / gate: 改札機の上の緑の灯 /
 *  goal: 終点の「しゅうてん」のつり下げ板(青地に白。くだりの終点の駅で使う。新宿の画像の中に描いておくので描画はふえない)
 * [x0, y0, x1, y1](この場所の左上からの画素) */
const TERM_EX = {
  nori: [[0, 0, 320, 80], [0, 96, 320, 176]],
  poster: [[320, 0, 512, 96], [320, 96, 512, 192], [320, 192, 512, 288], [0, 384, 192, 480]],
  deguchi: [0, 192, 320, 258],
  goal: [0, 288, 512, 384],
  norikae: [192, 384, 448, 448],
  lamp: [460, 400, 492, 432],
  gate: [200, 456, 440, 472],
};
/* 壁の広告の絵(4種)。字やマークは描かない。光る材質(2.2倍)なので いちばん明るい所でも 150 くらい */
const POSTER_ART = [
  /* 夕方の山なみ */
  (c, w, h) => {
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#2a4a70'); g.addColorStop(0.55, '#86687a'); g.addColorStop(1, '#94725a');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    c.fillStyle = '#9a8a5a'; c.beginPath(); c.arc(w * 0.68, h * 0.5, h * 0.12, 0, 7); c.fill();
    [['#4c5a6e', 0.55, 0.22], ['#34485a', 0.68, 0.16], ['#22343f', 0.82, 0.1]].forEach(([col, base, amp], k) => {
      c.fillStyle = col; c.beginPath(); c.moveTo(0, h);
      for (let x = 0; x <= w; x += 8) c.lineTo(x, h * base - Math.abs(Math.sin(x * 0.021 + k * 1.7)) * h * amp - Math.sin(x * 0.07 + k) * h * 0.02);
      c.lineTo(w, h); c.closePath(); c.fill();
    });
  },
  /* 海と空 */
  (c, w, h) => {
    const g = c.createLinearGradient(0, 0, 0, h * 0.6);
    g.addColorStop(0, '#24608e'); g.addColorStop(1, '#7096a6');
    c.fillStyle = g; c.fillRect(0, 0, w, h * 0.6);
    const s = c.createLinearGradient(0, h * 0.6, 0, h);
    s.addColorStop(0, '#2e7a8e'); s.addColorStop(1, '#1c4a66');
    c.fillStyle = s; c.fillRect(0, h * 0.6, w, h * 0.4);
    c.fillStyle = 'rgba(160,170,150,0.55)';
    for (let k = 0; k < 9; k++) c.fillRect(w * (0.1 + 0.09 * k), h * (0.66 + 0.035 * (k % 3)), w * 0.06, 1.5);
    c.fillStyle = '#8e8a78'; c.fillRect(0, h * 0.86, w, h * 0.14);
  },
  /* 形の組み合わせ(円と四角) */
  (c, w, h) => {
    c.fillStyle = '#8c8676'; c.fillRect(0, 0, w, h);
    [['#a8442f', 0.22, 0.55, 0.32], ['#2a5680', 0.52, 0.42, 0.26], ['#a8801c', 0.78, 0.62, 0.2]].forEach(([col, x, y, r]) => {
      c.fillStyle = col; c.beginPath(); c.arc(w * x, h * y, h * r, 0, 7); c.fill();
    });
    c.fillStyle = '#2a2e33'; c.fillRect(w * 0.08, h * 0.82, w * 0.84, h * 0.05);
    c.fillStyle = '#4a7a5a'; c.fillRect(w * 0.62, h * 0.12, w * 0.22, h * 0.12);
  },
  /* 緑の丘と畑のすじ */
  (c, w, h) => {
    const g = c.createLinearGradient(0, 0, 0, h * 0.5);
    g.addColorStop(0, '#4a76a0'); g.addColorStop(1, '#7e98a0');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    c.fillStyle = '#4a7634'; c.beginPath(); c.moveTo(0, h);
    for (let x = 0; x <= w; x += 6) c.lineTo(x, h * 0.48 - Math.sin(x * 0.03) * h * 0.08);
    c.lineTo(w, h); c.closePath(); c.fill();
    c.strokeStyle = 'rgba(150,170,70,0.75)'; c.lineWidth = 3;
    for (let k = 0; k < 7; k++) { c.beginPath(); c.moveTo(w * 0.5, h * 0.5); c.lineTo(w * (k / 6) * 1.6 - w * 0.3, h); c.stroke(); }
    c.fillStyle = '#2e4a2a'; c.beginPath(); c.arc(w * 0.18, h * 0.46, h * 0.1, 0, 7); c.fill();
  },
];
function drawTermExtra(c, y0, physLeft, goalName) {
  const R = (r) => [r[0], y0 + r[1], r[2] - r[0], r[3] - r[1]];
  const labs = physLeft ? ['1・2', '3・4'] : ['3・4', '1・2'];
  labs.forEach((no, k) => {
    /* もとの 384x96 の絵を 320x80 にちぢめて描く(板の形 2.6x0.65m と同じ 4:1) */
    const [x, y] = R(TERM_EX.nori[k]);
    c.save(); c.translate(x, y); c.scale(320 / 384, 80 / 96);
    c.fillStyle = '#0e1114'; c.fillRect(0, 0, 384, 96);
    c.fillStyle = '#7a6420'; c.fillRect(0, 88, 384, 8);
    c.fillStyle = '#8f8f8f';
    fitText(c, no, 96, 46, 160, 60, 900);
    fitText(c, 'ばんせん', 238, 30, 140, 26, 700);
    fitText(c, 'のりば', 238, 64, 140, 30, 900);
    c.restore();
  });
  /* 広告(白い縁どり+絵) */
  TERM_EX.poster.forEach((r, k) => {
    const [x, y, w, h] = R(r);
    c.save(); c.translate(x, y);
    c.fillStyle = '#8e908e'; c.fillRect(0, 0, w, h);
    c.beginPath(); c.rect(5, 5, w - 10, h - 10); c.clip();
    c.translate(5, 5);
    POSTER_ART[k](c, w - 10, h - 10);
    c.restore();
  });
  /* 「↑ でぐち」(黒地に黄。矢印は形で描く) */
  {
    const [x, y, w, h] = R(TERM_EX.deguchi);
    c.fillStyle = '#0e1114'; c.fillRect(x, y, w, h);
    c.fillStyle = '#b29400';
    const ax = x + 46, ay = y + h / 2;
    c.beginPath();
    c.moveTo(ax, ay - 26); c.lineTo(ax + 20, ay - 4); c.lineTo(ax + 7, ay - 4); c.lineTo(ax + 7, ay + 26);
    c.lineTo(ax - 7, ay + 26); c.lineTo(ax - 7, ay - 4); c.lineTo(ax - 20, ay - 4); c.closePath(); c.fill();
    fitText(c, 'でぐち', x + 190, ay + 2, 200, 46, 900);
  }
  /* 「のりかえ」(黒地に緑) */
  {
    const [x, y, w, h] = R(TERM_EX.norikae);
    c.fillStyle = '#0e1114'; c.fillRect(x, y, w, h);
    c.fillStyle = '#239a52'; c.fillRect(x + 10, y + 12, 12, h - 24);
    fitText(c, 'のりかえ', x + w / 2 + 10, y + h / 2 + 2, w - 50, 40, 900);
  }
  /* 終点のつり下げ板: 左に黄色の「しゅうてん」、右に駅名のかな(大)と漢字(小) */
  if (goalName) {
    const [x, y, w, h] = R(TERM_EX.goal);
    c.fillStyle = '#133c75'; c.fillRect(x, y, w, h);
    c.fillStyle = '#5a6a80'; c.fillRect(x, y + h - 5, w, 5);
    c.fillStyle = '#b29a2a'; c.fillRect(x + 12, y + 14, 148, h - 28);
    c.fillStyle = '#133c75'; fitText(c, 'しゅうてん', x + 86, y + h / 2 + 1, 136, 32, 900);
    c.fillStyle = '#ababab';
    fitText(c, kanaOf(goalName), x + 338, y + 38, 330, 44, 900);
    fitText(c, goalName, x + 338, y + 78, 200, 20, 700);
  }
  const L = TERM_EX.lamp;
  c.fillStyle = '#ff3020'; c.fillRect(L[0], y0 + L[1], L[2] - L[0], L[3] - L[1]);
  const G = TERM_EX.gate;
  c.fillStyle = '#1fa050'; c.fillRect(G[0], y0 + G[1], G[2] - G[0], G[3] - G[1]);
}

/* 自発光は頂点属性 stE の割合だけ(天井の照明の帯=1、屋根の下の床=0.20、屋根のない床=0.09、天井の板=0.06)。
 * 自発光にも絵(アトラス)を使うので、明るい舗装は明るく・へりの下のすき間は暗いまま光る。
 * 地下駅用は全体をうっすら自発光 */
function stationMaterial(tex, ug) {
  const m = new THREE.MeshStandardMaterial({
    map: tex, vertexColors: true, alphaTest: 0.5, side: DS, roughness: 0.9,
    emissive: ug ? 0xffffff : 0xfff1d6, emissiveMap: tex, emissiveIntensity: ug ? 0.25 : 0,
  });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float stE;\nvarying float vStE;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvStE = stE;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vStE;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= vStE;');
  };
  m.customProgramCacheKey = () => (ug ? 'st-station-ug' : 'st-station');
  return m;
}

/* ---------- 材質(世界ごと) ---------- */
function stationMats() {
  const atlas = texStationAtlas();
  const st = stationMaterial(atlas, false);
  const stUG = stationMaterial(atlas, true);
  const ptex = poolTexture(), stex = poolStripTexture();
  const poolIn = makePoolMaterial(ptex, { color: 0xffffff });
  /* 屋根の灯りの帯(夜・夕方・雨): 6mごとに12mの帯を重ねて、つぎ目のない明るい床に(LEDの白) */
  const poolStrip = makePoolMaterial(stex, { color: 0xeef0ea });
  /* 屋内(地下駅・ターミナル)の床の帯: いつも点灯。強さはインスタンス色で */
  const poolStripIn = makePoolMaterial(stex, { color: 0xffffff });
  const strip = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xfff2d8).multiplyScalar(2.4), side: DS });
  strip.userData.noWeather = true;
  const fixture = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.8, 1.9, 1.7) });
  fixture.userData.noWeather = true;
  const clockCv = document.createElement('canvas');
  clockCv.width = clockCv.height = 128;
  const clockTex = new THREE.CanvasTexture(clockCv);
  clockTex.colorSpace = THREE.SRGBColorSpace;
  clockTex.anisotropy = 4;
  drawClock(clockCv.getContext('2d'), 10, 0);
  const clock = new THREE.MeshBasicMaterial({ map: clockTex, alphaTest: 0.5, color: new THREE.Color(0.95, 0.95, 0.95) });
  const out = { atlas, st, stUG, poolStrip, poolIn, poolStripIn, strip, fixture, clock, clockTex };
  Object.keys(out).forEach((k) => { if (out[k].isMaterial) out[k].name = 'st-' + k; });
  return out;
}

/* 駅ごとの「動かない部品」の焼きこみ先 */
function stationBaker(rs, si) {
  return rs._signs && rs._signs.get('st' + si);
}

/* 左右のホーム断面(sg=+1 左, -1 右)。texU はアトラス上の位置 */
function sideProfile(sg) {
  const P = sideOf(sg), e = P.edge, b = P.back, s = sg, A = AT.plat;
  return [
    [b, -0.5, A(0.995)], [b, 1.05, A(0.94)],
    [e + 1.13 * s, 1.05, A(0.625)], [e + 0.8 * s, 1.05, A(0.44)], [e + 0.2 * s, 1.05, A(0.25)],
    [e, 1.05, A(0.156)], [e, 0.9, A(0.094)], [e, 0.9, A(0.05)], [e + 0.35 * s, 0.9, A(0.05)],
    [e + 0.35 * s, 0.9, A(0.094)], [e + 0.35 * s, -0.25, A(0.005)],
  ];
}
/* 島式(両側がへり)のホーム断面: eA(内側のへり) 〜 eB(外側のへり) */
function islandProfile(eA, eB) {
  const s = eB > eA ? 1 : -1, A = AT.plat;
  /* d: へりから ホームの内側への向き */
  const half = (e, d) => [
    [e + 0.35 * d, -0.25, A(0.005)], [e + 0.35 * d, 0.9, A(0.094)], [e + 0.35 * d, 0.9, A(0.05)], [e, 0.9, A(0.05)],
    [e, 0.9, A(0.094)], [e, 1.05, A(0.156)], [e + 0.2 * d, 1.05, A(0.25)], [e + 0.8 * d, 1.05, A(0.44)], [e + 1.13 * d, 1.05, A(0.625)],
  ];
  const a = half(eA, s);
  const b = half(eB, -s).reverse();
  return [...a, [(eA + eB) / 2, 1.05, A(0.94)], ...b];
}

/* 5mごとの骨組みにそろえた位置(buildStations の iOf と同じ丸め・はみ出し止め) */
function snapS(rs, s) {
  const N = rs.frames.length - 1;
  return Math.max(0, Math.min(N, Math.round(s / rs.step))) * rs.step;
}
/* ホームの床が実際にある範囲か(buildStations の i0〜i1 と同じ。標識・信号の根元をホーム面に上げる判定) */
export function inPlatform(rs, s) {
  return rs.line.stations.some((st) => s >= snapS(rs, st.s - P_A) && s <= snapS(rs, st.s + P_B));
}

/* ---------- ホームの端(スロープ・柵・とびらの棒・「この さき はいれません」) ----------
 * sEnd: ホームの端の位置 / out: 外への向き(+1 = s がふえる側の端、-1 = へる側の端) */
const _pe = { f0: newFrame(), f1: newFrame(), ff: newFrame(), m4: new THREE.Matrix4(), q: new THREE.Quaternion(), c: new THREE.Vector3(), n: new THREE.Vector3(), nb: new THREE.Vector3() };
let _gateGeo = null;
/* 柵の板(ホームを横切る向き)。アトラスの柵のマス(アルファ抜き)を使う: u=下→上の高さ、v=横の長さ/6m */
function fenceQuad(f, latA, latB, y0, y1) {
  const pos = [], nor = [], uv = [];
  const tn = flatT(f, new THREE.Vector3());
  const v1 = Math.abs(latB - latA) / 6;
  [[latA, y0, AT.fence(0.01), 0], [latB, y0, AT.fence(0.01), v1], [latB, y1, AT.fence(0.99), v1], [latA, y1, AT.fence(0.99), 0]].forEach(([l, y, u, v]) => {
    pos.push(f.p.x + f.left.x * l, f.p.y + y, f.p.z + f.left.z * l);
    nor.push(tn.x, tn.y, tn.z);
    uv.push(u, v);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}
function platformEnd(rs, B, sEnd, sg, out) {
  const P = sideOf(sg), T = _pe;
  frameInto(rs, sEnd, T.f0);
  frameInto(rs, sEnd + out * 5, T.f1);
  /* (a) 係員用のスロープ: ホームのうしろ寄り1m、端から外へ5mで地面近くまで下る */
  const li = P.back - 1.05 * sg, lo = P.back - 0.05 * sg;
  const pt = (f, lat, y) => [f.p.x + f.left.x * lat, f.p.y + y, f.p.z + f.left.z * lat];
  const a1 = pt(T.f0, li, 1.05), a2 = pt(T.f0, lo, 1.05), b1 = pt(T.f1, li, 0.15), b2 = pt(T.f1, lo, 0.15);
  const a1d = pt(T.f0, li, -0.4), a2d = pt(T.f0, lo, -0.4), b1d = pt(T.f1, li, -0.4), b2d = pt(T.f1, lo, -0.4);
  /* 四角(4点)ごとに法線を1つに(2つの三角形の平均): 曲線の上で坂がねじれても、つぎはぎ模様に見えない */
  const _e1 = T.n, _e2 = T.nb, _nq = T.c;
  const mk = (quads) => {
    const pos = [], nor = [];
    quads.forEach(([p, q, r, s]) => {
      _e1.set(r[0] - p[0], r[1] - p[1], r[2] - p[2]);
      _e2.set(s[0] - q[0], s[1] - q[1], s[2] - q[2]);
      _nq.crossVectors(_e1, _e2).normalize();   // (r-p)x(s-q): 三角形のまわる向き(表)と同じ向き
      pos.push(...p, ...q, ...r, ...p, ...r, ...s);
      for (let k = 0; k < 6; k++) nor.push(_nq.x, _nq.y, _nq.z);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    return g;
  };
  /* 坂は暗めの灰色(日の当たる白い くさびに見えない)、側面と小口はもう少し暗く */
  B.geo(mk([[a1, a2, b2, b1]]), { white: true, col: 0x6c6b66 });
  B.geo(mk([[a1, b1, b1d, a1d], [a2, a2d, b2d, b2], [b1, b2, b2d, b1d]]), { white: true, col: 0x5d5c58 });
  /* 坂の線路がわの へり: 黄と黒の しま(0.5mごと) */
  for (let k = 0; k < 10; k++) {
    const t0 = k / 10, t1 = (k + 1) / 10;
    const pa = [a1[0] + (b1[0] - a1[0]) * t0, a1[1] + (b1[1] - a1[1]) * t0 + 0.02, a1[2] + (b1[2] - a1[2]) * t0];
    const pb = [a1[0] + (b1[0] - a1[0]) * t1, a1[1] + (b1[1] - a1[1]) * t1 + 0.02, a1[2] + (b1[2] - a1[2]) * t1];
    bakeBar(B, pa, pb, 0.06, k % 2 ? 0x1c1d1f : 0xe2b91c);
  }
  /* すべり止めの濃い帯(坂を横切る3本) */
  [0.25, 0.5, 0.75].forEach((t) => {
    const fr = frameInto(rs, sEnd + out * 5 * t, T.ff), y = 1.05 - 0.9 * t + 0.015;
    bakeBar(B, pt(fr, li + 0.04 * sg, y), pt(fr, lo - 0.04 * sg, y), 0.05, 0x3a3a37);
  });
  /* 坂の線路がわの手すり: 1.25mごとの柱(高さ1.0m)+上の横棒 */
  const rl = li + 0.05 * sg;
  for (let k = 0; k <= 4; k++) {
    const t = k / 4, ff = frameInto(rs, sEnd + out * 5 * t, T.ff);
    B.post(ff.p.x + ff.left.x * rl, ff.p.y + 1.05 - 0.9 * t, ff.p.z + ff.left.z * rl, 1.0, 0x7d858b, 1.1);
  }
  const ra = pt(T.f0, rl, 2.05), rb = pt(T.f1, rl, 1.15);
  bakeBar(B, ra, rb, 0.045, 0x7d858b);
  /* (b) 端の柵(へりから0.35m 〜 スロープの手前。高さ1.1m) */
  const ff = frameInto(rs, sEnd - out * 0.3, T.ff);
  const la = P.edge + 0.35 * sg, lb = P.back - 1.1 * sg;
  B.geo(fenceQuad(ff, la, lb, 1.05, 2.15));
  /* (c) スロープの入口の黄色い棒(黒い帯3本)と、ちょうつがいの柱 */
  const g0 = P.back - 1.1 * sg, g1 = P.back - 0.05 * sg, gm = (g0 + g1) / 2, gl = Math.abs(g1 - g0);
  if (!_gateGeo) _gateGeo = { bar: new THREE.BoxGeometry(1, 0.05, 0.05), band: new THREE.BoxGeometry(0.12, 0.058, 0.058) };
  T.q.setFromAxisAngle(UPV, Math.atan2(ff.t.x, ff.t.z));      // 箱の x = 線路の左右
  T.c.copy(ff.p).addScaledVector(ff.left, gm); T.c.y = ff.p.y + 2.0;
  B.geo(_gateGeo.bar, { m: T.m4.compose(T.c, T.q, T.n.set(gl, 1, 1)), col: 0xe2b91c, white: true });
  [-0.3, 0, 0.3].forEach((k) => {
    T.c.copy(ff.p).addScaledVector(ff.left, gm + k * gl * sg); T.c.y = ff.p.y + 2.0;
    B.geo(_gateGeo.band, { m: T.m4.compose(T.c, T.q, T.n.set(1, 1, 1)), col: 0x1c1d1f, white: true });
  });
  B.post(ff.p.x + ff.left.x * g0, ff.p.y + 1.05, ff.p.z + ff.left.z * g0, 1.0, 0x6f777d, 1.4);
  /* (d) 「この さき はいれません」: 柵の上に、ホームの内がわ・外がわの両方へ向けて */
  flatT(ff, T.n).multiplyScalar(-out);                          // ホームの内がわ向き
  T.c.copy(ff.p).addScaledVector(ff.left, (la + lb) / 2); T.c.y = ff.p.y + 1.05 + 0.66;
  makeSign(rs, 'noent', 0.42, 0.42, { c: T.c.clone().addScaledVector(T.n, 0.012), n: T.n.clone(), postH: 0 });
  T.nb.copy(T.n).negate();
  makeSign(rs, 'noent', 0.42, 0.42, { c: T.c.clone().addScaledVector(T.nb, 0.012), n: T.nb.clone(), postH: 0 });
}

/* ---------- 発車する側のホームの端: 運転士用のモニター(ITV)とミラー(左ホームだけ) ----------
 * sEnd: ホームの先の端。端の柵の1.2m手前。
 * 止まっているあいだ ずっと見ている画面なので、ほかの物と重ならない すき間に置く
 * (止まった運転台の目から見て: 出発信号の柱(右)・先端の駅名標(左下)・発車標(左上)・屋根のふち(上)のあいだ)。
 *  モニター: 2つの画面を たてに重ねた細い箱(0.5x0.84m・まん中はレール面から3.0m)。へりから0.34mの柱の上。
 *  ミラー: 駅名標の上・発車標の右下(まん中 3.49m・半径0.17m)。暗い鏡の面に明るい映りこみの三日月と
 *  オレンジのふち(白い時計に見えない)。モニターの柱から横へのびる腕の先 */
let _itvGeo = null;
function itvMonitor(rs, B, st, ob, sEnd) {
  const sI = sEnd - 1.2;
  const f = frameOf(rs, sI);
  const lat = PLAT.L.edge + 0.34, yb = f.p.y + 1.05;
  if (!_itvGeo) {
    const A = lineBoard(rs, 'itv').uv;
    const scr = new THREE.PlaneGeometry(0.42, 0.32);
    const uv = scr.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) ? A[2] : A[0], uv.getY(i) ? A[3] : A[1]);
    _itvGeo = {
      house: new THREE.BoxGeometry(0.5, 0.84, 0.3), scr, cap: new THREE.BoxGeometry(0.58, 0.06, 0.4),
      arm: new THREE.BoxGeometry(0.05, 0.05, 1), mirror: new THREE.CircleGeometry(0.17, 18), rim: new THREE.RingGeometry(0.17, 0.2, 18),
      glint: new THREE.CircleGeometry(0.075, 12),
    };
  }
  const G = _itvGeo;
  const mY = 3.49;                                                   // ミラーのまん中の高さ(レール面から)
  B.post(f.p.x + f.left.x * lat, yb, f.p.z + f.left.z * lat, mY + 0.06 - 1.05, 0x4f575d, 1.8);
  ob.push({ s: sI, lat, r: 0.2 });
  const n = flatT(f, new THREE.Vector3()).negate();               // 入ってくる運転台のほう
  const q = new THREE.Quaternion().setFromAxisAngle(UPV, Math.atan2(n.x, n.z));
  q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), THREE.MathUtils.degToRad(10)));   // 10°下向き
  const hc = f.p.clone().addScaledVector(f.left, lat); hc.y = f.p.y + 3.0;
  const one = new THREE.Vector3(1, 1, 1), m4 = new THREE.Matrix4(), mm = new THREE.Matrix4();
  m4.compose(hc, q, one);
  B.geo(G.house, { m: m4, col: 0x24292e, white: true });
  B.geo(G.cap, { m: mm.makeTranslation(0, 0.44, 0.02).premultiply(m4), col: 0x3a4146, white: true });
  const LB = lineBaker(rs);
  [0.19, -0.19].forEach((y) => LB.geo(G.scr, { m: mm.makeTranslation(0, y, 0.152).premultiply(m4), e: 1 }));
  /* 凸面ミラー(モニターの柱から ホームのほうへ のびる腕の先。少し線路のほうへ向ける) */
  const mLat = lat + 0.57;
  const mq = new THREE.Quaternion().setFromAxisAngle(UPV, Math.atan2(n.x, n.z) + 0.45);
  const mc = f.p.clone().addScaledVector(f.left, mLat); mc.y = f.p.y + mY;
  m4.compose(mc, mq, one);
  B.geo(G.mirror, { m: m4, col: 0x4a565f, white: true });
  B.geo(G.glint, { m: mm.makeTranslation(-0.05, 0.05, 0.004).premultiply(m4), col: 0x9fb0bc, white: true });
  B.geo(G.rim, { m: m4, col: 0xd8641e, white: true });
  B.geo(G.mirror, { m: mm.makeTranslation(0, 0, -0.03).premultiply(m4), col: 0x2a2e31, white: true });
  /* ミラーの腕(柱から横へ、ミラーのうしろまで) */
  const ac = f.p.clone().addScaledVector(f.left, (lat + mLat) / 2); ac.y = f.p.y + mY;
  B.geo(G.arm, { m: m4.compose(ac, new THREE.Quaternion().setFromAxisAngle(UPV, Math.atan2(f.left.x, f.left.z)), new THREE.Vector3(1, 1, mLat - lat)), col: 0x4f575d, white: true });
}

/* ---------- 階段(橋上駅舎・跨線橋へ): 各ホームに1つ。駅の形に焼きこむ ----------
 * 下(ホーム面)は st.s-128.6、上(高さ7.9m)は st.s-141。跨線橋は上に踊り場をつけて橋につなぐ。
 * 入ってくる運転台からは階段の「裏」が見えるので、裏は暗い灰色(白い大きな板に見えない)。
 * 横は 下1.1mが灰色の腰壁、その上は屋根までガラス(暗い青灰色)+手すり */
let _stairGeo = null;
function buildStairs(rs, B, st, S, ob) {
  const rise = 7.9 - 1.05, run = STAIR.foot - STAIR.top, len = Math.hypot(rise, run), ang = Math.atan2(rise, run);
  if (!_stairGeo) {
    _stairGeo = {
      tread: new THREE.BoxGeometry(1.8, 0.12, len), soffit: new THREE.BoxGeometry(1.8, 0.2, len),
      wall: new THREE.BoxGeometry(0.08, 1.1, len), glass: new THREE.BoxGeometry(0.03, 1.25, len),
      rail: new THREE.BoxGeometry(0.05, 0.05, len),
      roof: new THREE.BoxGeometry(2.1, 0.12, len), land: new THREE.BoxGeometry(1.8, 0.12, 1), landS: new THREE.BoxGeometry(1.8, 0.2, 1),
      lwall: new THREE.BoxGeometry(0.08, 1.1, 1), lglass: new THREE.BoxGeometry(0.03, 1.25, 1),
      lroof: new THREE.BoxGeometry(2.1, 0.12, 1), col: new THREE.BoxGeometry(0.3, 1, 0.3),
    };
  }
  const G = _stairGeo;
  const sm = st.s - (STAIR.foot + STAIR.top) / 2, f = frameOf(rs, sm);
  const one = new THREE.Vector3(1, 1, 1), m4 = new THREE.Matrix4(), mm = new THREE.Matrix4(), c = new THREE.Vector3();
  const q = new THREE.Quaternion().setFromAxisAngle(UPV, Math.atan2(f.t.x, f.t.z));
  q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), ang));   // +t へ下る
  const qf = new THREE.Quaternion().setFromAxisAngle(UPV, Math.atan2(f.t.x, f.t.z));
  const at = (x, y, base) => mm.makeTranslation(x, y, 0).premultiply(base);
  [1, -1].forEach((sg) => {
    const lat = mid(sideOf(sg)) + 0.15 * sg;
    c.copy(f.p).addScaledVector(f.left, lat); c.y = f.p.y + (1.05 + 7.9) / 2 - 0.15;
    m4.compose(c, q, one);
    B.geo(G.tread, { m: at(0, 0.09, m4), col: 0xa9a8a3, white: true });
    B.geo(G.soffit, { m: at(0, -0.08, m4), col: 0x5f6468, white: true });
    [-0.94, 0.94].forEach((x) => {
      B.geo(G.wall, { m: at(x, 0.7, m4), col: 0x8e959a, white: true });
      B.geo(G.glass, { m: at(x, 1.9, m4), col: 0x4a5c69, white: true });
      B.geo(G.rail, { m: at(x * 0.9, 1.0, m4), col: 0xb9bfc3, white: true });
    });
    B.geo(G.roof, { m: at(0, 2.55, m4), col: S.roofCol, white: true });
    /* 屋根の足(階段の下の端) */
    const fb = frameOf(rs, st.s - STAIR.foot + 0.3);
    [-0.98, 0.98].forEach((x) => {
      const l = lat + x;
      B.post(fb.p.x + fb.left.x * l, fb.p.y + 1.05, fb.p.z + fb.left.z * l, 2.75, 0x8d959b, 1.5);
    });
    /* 跨線橋: 階段の上から橋までの踊り場(屋根つき)と、それをささえる柱 */
    if (S.kind === 'foot') {
      const s0 = st.s - STAIR.c + 1.7, s1 = st.s - STAIR.top, L = s1 - s0;
      const fl = frameOf(rs, (s0 + s1) / 2);
      c.copy(fl.p).addScaledVector(fl.left, lat); c.y = fl.p.y + 7.9 - 0.15;
      m4.compose(c, qf, one);
      const sL = new THREE.Matrix4();
      const part = (g, x, y, col) => B.geo(g, { m: mm.makeScale(1, 1, L).premultiply(sL.makeTranslation(x, y, 0)).premultiply(m4), col, white: true });
      part(G.land, 0, 0.09, 0xa9a8a3);
      part(G.landS, 0, -0.08, 0x5f6468);
      [-0.94, 0.94].forEach((x) => { part(G.lwall, x, 0.7, 0x8e959a); part(G.lglass, x, 1.9, 0x4a5c69); });
      part(G.lroof, 0, 2.55, S.roofCol);
      c.copy(fl.p).addScaledVector(fl.left, lat); c.y = fl.p.y + 1.05 + (7.6 - 1.05) / 2;
      B.geo(G.col, { m: m4.compose(c, qf, new THREE.Vector3(1, 7.6 - 1.05, 1)), col: 0xc4c6c4, white: true });
    }
    ob.push({ s0: st.s - P_A - 5, s1: st.s - STAIR.foot + 2.5 });     // 階段より奥には人・ベンチを置かない
  });
}

/* ---------- 橋上駅舎・跨線橋の下の面(天井のパネル+照明の帯・下がり梁) ----------
 * 駅の建物(外壁は街の担当)の底は高さ7.9m。その下に、ホームの屋根と同じ天井の絵(アトラスの 'under')を
 * 線路と直角の向きに並べ、照明の帯は自発光1(夜に光る)・パネルは0.15。
 * sc: 建物の中心 / a, b: 横のはし(右, 左) / sz: 線路方向の長さ */
export function concourseUnderside(rs, si, sc, a, b, sz) {
  const B = stationBaker(rs, si);
  if (!B) return;
  const f = frameOf(rs, sc);
  const tf = flatT(f, new THREE.Vector3());
  const y = f.p.y + 7.88;
  /* 下向きの四角(横 l0〜l1, 線路方向 d0〜d1) に アトラスの天井の帯(u0〜u1)を貼る */
  const pos = [], nor = [], uv = [], idx = [];
  const quad = (l0, l1, d0, d1, u0, u1) => {
    const base = pos.length / 3;
    [[l0, d0, u0, 0], [l1, d0, u1, 0], [l1, d1, u1, sz / 6], [l0, d1, u0, sz / 6]].forEach(([l, d, u, v]) => {
      pos.push(f.p.x + f.left.x * l + tf.x * d, y, f.p.z + f.left.z * l + tf.z * d);
      nor.push(0, -1, 0);
      uv.push(u, v);
    });
    idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  };
  const panels = [], lamps = [];
  /* 横に約3.4mごとの天井の帯(まん中に照明) */
  const n = Math.max(1, Math.round((b - a) / 3.4)), w = (b - a) / n;
  for (let k = 0; k < n; k++) {
    const l0 = a + k * w, l1 = l0 + w;
    const la = l0 + w * LAMP_U[0], lb = l0 + w * LAMP_U[1];
    panels.push([l0, la, AT.under(0.004), AT.under(LAMP_U[0])], [lb, l1, AT.under(LAMP_U[1]), AT.under(0.996)]);
    lamps.push([la, lb, AT.under(LAMP_U[0]), AT.under(LAMP_U[1])]);
  }
  const mk = (list) => {
    pos.length = 0; nor.length = 0; uv.length = 0; idx.length = 0;
    list.forEach(([l0, l1, u0, u1]) => quad(l0, l1, -sz / 2, sz / 2, u0, u1));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx.slice());
    return g;
  };
  /* 建物の下(日かげ)なので、パネルはホームの屋根の天井より少し暗い灰色 */
  B.geo(mk(panels), { e: 0.15, col: 0x9a9fa3 });
  B.geo(mk(lamps), { e: 1, col: 0xdfe1e2 });
  /* 下がり梁(ホームの中心線の上: 左 2.4m・右 -6.2m)。線路方向に建物の長さぶん */
  const q = new THREE.Quaternion().setFromAxisAngle(UPV, Math.atan2(f.t.x, f.t.z));
  const m4 = new THREE.Matrix4(), c = new THREE.Vector3();
  const beam = new THREE.BoxGeometry(0.45, 0.7, sz);
  [2.4, -6.2].forEach((lat) => {
    c.copy(f.p).addScaledVector(f.left, lat); c.y = f.p.y + 7.9 - 0.35;
    B.geo(beam, { m: m4.compose(c, q, new THREE.Vector3(1, 1, 1)), col: 0x7d8287, white: true });
  });
}

/* 橋上駅舎・跨線橋の柱(門型ビームの梁をよける) */
function concourseColumns(rs, B, st, S, ob) {
  const sc = st.s - STAIR.c;
  const gS = (rs._catSupports || []).filter((sp) => sp.type === 'gantry').map((sp) => sp.s);
  const clear = (s) => {
    for (let k = 0; k < gS.length; k++) if (Math.abs(s - gS[k]) < 0.8) return gS[k] + (s < gS[k] ? -0.8 : 0.8);
    return s;
  };
  const e0 = quadOffAt(sc, 0), e1 = quadOffAt(sc, 1);
  const left = Math.max(7.5, fenceOffL(sc) + 1.5);
  const lats = [[-13.0, -0.5], [left - 0.8, -0.5]];
  if (e1 - e0 > 3.7) lats.push([(e0 + e1) / 2, -0.5]);
  if (S.kind === 'over') { lats.push([mid(PLAT.L), 1.05]); lats.push([mid(PLAT.R), 1.05]); }
  const ss = [sc];
  const geo = _stairGeo ? _stairGeo.col : new THREE.BoxGeometry(0.3, 1, 0.3);
  const m4 = new THREE.Matrix4(), c = new THREE.Vector3(), q = new THREE.Quaternion();
  ss.forEach((s0) => {
    const s = clear(s0), f = frameOf(rs, s);
    q.setFromAxisAngle(UPV, Math.atan2(f.t.x, f.t.z));
    lats.forEach(([lat, y0]) => {
      const h = 7.9 - y0;
      c.copy(f.p).addScaledVector(f.left, lat); c.y = f.p.y + y0 + h / 2;
      B.geo(geo, { m: m4.compose(c, q, new THREE.Vector3(1.4, h, 1.4)), col: 0xb7b9b8, white: true });
      if (y0 > 0) ob.push({ s, lat, r: 0.45 });
    });
  });
}

/* ---------- 駅(全駅) ---------- */
export function buildStations(rs) {
  /* 世界ごとの作り置きをリセット */
  rs._texCache = new Map();
  rs._atlas = null; rs._signs = null;
  rs.stationLamps = null;           // 旧: 屋根の照明箱(→光る帯+光だまりに置きかえ)
  rs._ledBoards = null;
  rs._stop8Ahead = STOP8_AHEAD;     // P6: 停止位置の光の目印を「8」にそろえる(0 でも「ある」)
  rs._stop8Lat = STOP8_LAT;
  rs._stop8Y = STOP8_Y;             // P6: 画面の目印を板の中心(レール面からの高さ)にかさねる
  rs._stop8Size = STOP8_SIZE;       // P6: 板の大きさ(m)。画面の目印の大きさを板にそろえる
  _itvGeo = null;
  const M = stationMats();
  const W = rs._stw = {
    M, signMats: [], look: undefined, clockMin: -1, termBld: null, indoorPools: [], indoorStrips: [],
    /* 駅名標の画像は近くの駅(6駅)だけ本物を持ち、遠くの駅は小さな代わりの画像(メモリ節約) */
    signInfo: [], signPool: [], signPH: texSignPlaceholder(), poolCenter: -1,
    obst: [],                        // 駅ごとの床のじゃまもの({s,lat,r} / {s0,s1}=その範囲ぜんぶ)。待つ人を置かない
    led: null,
  };
  const sty = stationStyles(rs);
  const F = rs.frames, step = rs.step, N = F.length - 1;
  const T = rs.terminal;
  const up = rs.line.meta.direction === 'up';
  const nSt = rs.line.stations.length;
  const f = newFrame(), n = new THREE.Vector3(), c = new THREE.Vector3(), tf = new THREE.Vector3();
  const pools = [];
  const iOf = (s) => Math.max(0, Math.min(N, Math.round(s / step)));
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
  const qFloor = (fr) => {
    flatT(fr, tf);
    return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(fr.left.clone().negate(), tf, UPV));
  };
  /* 丸柱+45°の方杖2本 */
  const colGeo = [new THREE.CylinderGeometry(0.11, 0.11, 3.0, 10, 1, true).translate(0, 1.5, 0)];
  [1, -1].forEach((sx) => colGeo.push(new THREE.BoxGeometry(0.9, 0.06, 0.06).rotateZ((sx * Math.PI) / 4).translate(sx * 0.43, 2.68, 0)));
  const sosGeo = new THREE.BoxGeometry(0.22, 0.3, 0.12);
  const ugColGeo = new THREE.BoxGeometry(0.5, 5.15, 0.5).translate(0, 5.15 / 2, 0);
  const lampGeo = { head: new THREE.BoxGeometry(0.5, 0.12, 0.25), cap: new THREE.BoxGeometry(0.58, 0.06, 0.32) };
  const rimGeo = new THREE.CylinderGeometry(0.315, 0.315, 0.07, 18, 1, true).rotateX(Math.PI / 2);
  const rail = new THREE.BoxGeometry(1.94, 0.03, 0.05);
  const housGeo = new THREE.BoxGeometry(2.4, 0.55, 0.15);
  const clockB = bakerFor(rs, M.clock, M.clock);
  const stripB = bakerFor(rs, M.strip, M.strip, { build: { recv: false } });
  /* 発車標(LED): 全線(新宿の2台ぶんもふくむ)で画像1枚・描画1回。
   * 画像は4台ぶんを縦に: 0=新宿の左の島 / 1=新宿の右の島 / 2=この電車の向き / 3=反対の向き */
  /* 新宿は のりば案内(2枚)と車止めの赤い灯も、発車標と同じ画像の下のほうに描いて同じ1回で描く */
  const Tm = rs.terminal;
  /* くだりの終点(いちばん最後の駅)の「しゅうてん」の板も同じ画像に(のぼりの終点は新宿のターミナル) */
  const goalSt = !up && nSt > 1 ? rs.line.stations[nSt - 1] : null;
  const goalName = goalSt && !(Tm && goalSt.name === '新宿') ? goalSt.name : null;
  const ledTex = texLed(4, Tm ? { h: 512, draw: (cc, y0) => drawTermExtra(cc, y0, !Tm.up, goalName) } : null);
  if (Tm) redrawWhenFonts(ledTex, '1・234ばんせんのりばでぐちのりかえしゅうてん' + (goalName ? kanaOf(goalName) + goalName : ''));
  W.goal = Tm && goalName ? { si: nSt - 1, uv: ledTex.userData.uvPx(TERM_EX.goal[0], ledTex.userData.extraY + TERM_EX.goal[1], TERM_EX.goal[2], ledTex.userData.extraY + TERM_EX.goal[3]) } : null;
  const ledMat = new THREE.MeshBasicMaterial({ map: ledTex, color: new THREE.Color(2.2, 2.2, 2.2) });
  ledMat.userData.noWeather = true; ledMat.name = 'st-led';
  const LB = bakerFor(rs, 'led', ledMat, { build: { recv: false } });
  W.led = { tex: ledTex, mat: ledMat, key: null };
  const gS = (rs._catSupports || []).filter((sp) => sp.type === 'gantry').map((sp) => sp.s);
  const clearOfGantry = (s, half) => {
    for (let k = 0; k < gS.length; k++) if (Math.abs(s - gS[k]) < half) return gS[k] + (s < gS[k] ? -half : half);
    return s;
  };
  /* 発車標(両面)+つり下げの柱2本 */
  const ledBoard = (B, board, s, lat, y, ceil) => {
    frameInto(rs, s, f);
    flatT(f, n);
    c.copy(f.p).addScaledVector(f.left, lat);
    c.y = f.p.y + y;
    B.geo(housGeo, { m: m4.compose(c, q.setFromAxisAngle(UPV, Math.atan2(n.x, n.z)), one), col: 0x15181b, white: true });
    const uvr = ledTex.userData.uvOf(board);
    LB.quad(c.clone().addScaledVector(n, 0.078), n, 2.24, 0.49, uvr);
    const nb = n.clone().negate();
    LB.quad(c.clone().addScaledVector(nb, 0.078), nb, 2.24, 0.49, uvr);
    tf.crossVectors(UPV, n);
    [-0.9, 0.9].forEach((k) => B.post(c.x + tf.x * k, c.y + 0.27, c.z + tf.z * k, f.p.y + ceil - (c.y + 0.27), 0x6f777d));
  };
  /* 時計(両面・つり下げ) */
  const clockAt = (B, s, lat, ceilY) => {
    frameInto(rs, s, f);
    flatT(f, n).negate();
    c.copy(f.p).addScaledVector(f.left, lat);
    c.y = f.p.y + 3.62;
    clockB.quad(c.clone().addScaledVector(n, 0.037), n, 0.62, 0.62, [0, 0, 1, 1]);
    const nb = n.clone().negate();
    clockB.quad(c.clone().addScaledVector(nb, 0.037), nb, 0.62, 0.62, [0, 0, 1, 1]);
    B.geo(rimGeo, { m: m4.compose(c, q.setFromAxisAngle(UPV, Math.atan2(n.x, n.z)), one), col: 0x2a3036, white: true });
    B.post(c.x, c.y + 0.3, c.z, f.p.y + ceilY - (c.y + 0.3), 0x6f777d);
  };

  rs.line.stations.forEach((st, si) => {
    const isTerm = !!T && st.name === '新宿';
    const under = rs._inTunnel(st.s);
    const S = sty[si];
    const roofA = roofLen(rs, si);
    const stairs = S.kind !== 'house' && !under && !isTerm;
    const ob = W.obst[si] = [];
    const i0 = iOf(st.s - P_A), i1 = iOf(st.s + P_B);
    /* この駅の動かない部品(ホーム・柵・屋根・柱・支柱・ベンチ・自販機・時計のふち)をまとめる */
    const B = bakerFor(rs, 'st' + si, under || isTerm ? M.stUG : M.st, { white: WHITE, e: true, build: { cast: true } });
    /* 駅名標の材質(駅ごと。かなが いちばん大きい) */
    const prev = rs.line.stations[si - 1], next = rs.line.stations[si + 1];
    const num = up ? nSt - si : si + 1;
    W.signInfo.push({ st, prev, next, num });
    /* 駅名標は内照式(中から光る看板): ライトの影響を受けない材質 */
    const smat = new THREE.MeshBasicMaterial({ map: W.signPH, color: new THREE.Color(0.95, 0.95, 0.95) });
    smat.name = 'st-sign';
    W.signMats.push(smat);
    if (isTerm) W.termSign = smat;
    const SB = bakerFor(rs, smat, smat);

    if (!isTerm) {
      /* ホーム(左右)と両端のふた。床の自発光: 屋根の下 0.20・屋根のない端 0.09
       * (夜は床が天井より明るく見える: 照明の下の床が明るく、天井は器具のあいだが暗め。白く飛ばない) */
      [1, -1].forEach((sg) => {
        const prof = sideProfile(sg);
        if (under) B.geo(profileStrip(F, i0, i1, prof), { e: 1 });
        else {
          const ra = Math.max(i0, iOf(st.s - roofA)), rb = Math.min(i1, iOf(st.s + ROOF_B));
          if (ra > i0) B.geo(profileStrip(F, i0, ra, prof), { e: 0.09 });
          B.geo(profileStrip(F, ra, rb, prof), { e: 0.20 });
          if (i1 > rb) B.geo(profileStrip(F, rb, i1, prof), { e: 0.09 });
        }
        [[i0, -1], [i1, 1]].forEach(([ii, o]) => B.geo(endCap(F[ii], prof, AT.plat(0.97), o), { col: 0x8f8c85 }));
        /* ホームの端: スロープ・柵・黄色い棒・「この さき はいれません」 */
        platformEnd(rs, B, i0 * step, sg, -1);
        platformEnd(rs, B, i1 * step, sg, 1);
      });
      /* 発車する側の端: 運転士用モニターとミラー */
      itvMonitor(rs, B, st, ob, i1 * step);
      /* うしろの柵(右は駅舎への出入り口をあける) */
      [1, -1].forEach((sg) => {
        const x = sideOf(sg).back - 0.05 * sg;
        const prof = [[x, 1.05, AT.fence(0.01)], [x, 2.15, AT.fence(0.99)]];
        if (sg < 0 && !under && !stairs) {
          B.geo(profileStrip(F, i0, iOf(st.s - 65), prof));
          B.geo(profileStrip(F, iOf(st.s - 45), i1, prof));
        } else B.geo(profileStrip(F, i0, i1, prof));
      });

      if (!under) {
        /* 屋根: 明るい天井(中央に照明の帯)+波板の上面+鼻隠し+両端のふた。長さと色は駅ごと */
        const ra = iOf(st.s - roofA), rb = iOf(st.s + ROOF_B);
        [1, -1].forEach((sg) => {
          const P = sideOf(sg), e0 = P.edge - 0.15 * sg, b0 = P.back + 0.4 * sg;
          const u0 = P.edge - 0.05 * sg, u1 = P.back + 0.3 * sg;
          const la = u0 + (u1 - u0) * LAMP_U[0], lb = u0 + (u1 - u0) * LAMP_U[1];
          /* 天井の板も照明の照り返しで少しだけ明るく(夜に天井が真っ黒にならないよう。帯の0.06倍。
           * 床(0.20)より暗く: 夜の天井が床より明るく見えない) */
          B.geo(profileStrip(F, ra, rb, [[u0, 4.05, AT.under(0.004)], [la, 4.05, AT.under(LAMP_U[0])]]), { e: 0.06 });
          B.geo(profileStrip(F, ra, rb, [[la, 4.05, AT.under(LAMP_U[0])], [lb, 4.05, AT.under(LAMP_U[1])]]), { e: 1 });
          B.geo(profileStrip(F, ra, rb, [[lb, 4.05, AT.under(LAMP_U[1])], [u1, 4.05, AT.under(0.996)]]), { e: 0.06 });
          B.geo(profileStrip(F, ra, rb, [[e0, 4.47, AT.top(0.05)], [b0, 4.27, AT.top(0.95)]]), { col: S.roofCol });
          const fas = { white: true, col: S.roofCol };
          B.geo(profileStrip(F, ra, rb, [[e0, 3.98, 0], [e0, 4.5, 0]]), fas);
          B.geo(profileStrip(F, ra, rb, [[b0, 3.98, 0], [b0, 4.3, 0]]), fas);
          [ra, rb].forEach((ii) => B.geo(capGeo(F[ii], [[e0, 3.98], [e0, 4.5], [b0, 4.3], [b0, 3.98]]), fas));
          /* 柱(10mごと・ホームの中心線)。3本に1本は赤い「非常停止」の箱。
           * 屋根が階段のところまである駅(終点)は、階段と駅舎の柱(st.s-147)のところには立てない */
          const lat = mid(P);
          let k = 0;
          for (let s = st.s - 10 * Math.floor((roofA - 5) / 10); s <= st.s + 2; s += 10, k++) {
            if (stairs && ((s > st.s - STAIR.top - 1.4 && s < st.s - STAIR.foot + 1.4) || Math.abs(s - (st.s - STAIR.c)) < 1.6)) continue;
            frameInto(rs, s, f);
            q.setFromAxisAngle(UPV, Math.atan2(f.t.x, f.t.z));
            m4.compose(f.p.clone().addScaledVector(f.left, lat).setY(f.p.y + 1.05), q, one);
            colGeo.forEach((g) => B.geo(g, { m: m4, col: 0xd3d6d8, white: true }));
            ob.push({ s, lat, r: 0.3 });
            if (k % 3 === 1) {
              m4.compose(f.p.clone().addScaledVector(f.left, lat - sg * 0.17).setY(f.p.y + 1.05 + 1.9), q, one);
              B.geo(sosGeo, { m: m4, col: 0xc8281e, white: true });
            }
          }
          /* 夜の灯りの帯(6mごとに12mの帯。絶対位置にそろえて天井の器具と合わせる) */
          for (let s = Math.ceil((st.s - roofA + 2) / 6) * 6 + 3; s < st.s + ROOF_B - 1; s += 6) {
            frameInto(rs, s, f);
            pools.push({ p: f.p.clone().addScaledVector(f.left, lat).setY(f.p.y + 1.062), q: qFloor(f), sx: Math.abs(P.back - P.edge) + 0.4, sy: 12 });
          }
          /* ホームの両はしの灯り(柱4m+灯具)。屋根のない端も夜に明るく */
          const nearS = roofA >= P_A ? null : stairs ? st.s - 153 : Math.max(st.s - (roofA + 15), st.s - P_A + 4);
          /* 先の端の灯り: 屋根の先(いつもホームの端の5m手前)とホームの端のまんなか(モニターは端の1.2m手前)。
           * 先端の駅名標(st.s+11)の板に柱がささらないよう、近いときは板のうしろ(まだ屋根の外)へ */
          let farS = i1 * step - 2.5;
          if (Math.abs(farS - (st.s + 11)) < 0.6) farS = st.s + 10.4;
          [farS, nearS].forEach((s) => {
            if (s == null) return;     // 屋根がホームの はしまである(終点): 手前の灯りの柱は屋根にささるので立てない
            frameInto(rs, s, f);
            c.copy(f.p).addScaledVector(f.left, lat);
            B.post(c.x, f.p.y + 1.05, c.z, 4.0, 0x6f777d, 1.6);
            q.setFromAxisAngle(UPV, Math.atan2(f.t.x, f.t.z));
            c.y = f.p.y + 1.05 + 4.0;
            /* 灯具は駅の形に焼きこむ(自発光1=夜は屋根の照明の帯と同じ明るさ。昼は消えた灯具。描画回数はふえない) */
            B.geo(lampGeo.head, { m: m4.compose(c, q, one), white: true, col: 0xfffaf0, e: 1 });
            c.y += 0.08;
            B.geo(lampGeo.cap, { m: m4.compose(c, q, one), col: 0x3a4045, white: true });
            pools.push({ p: f.p.clone().addScaledVector(f.left, lat).setY(f.p.y + 1.062), q: qFloor(f), sx: Math.abs(P.back - P.edge) + 0.4, sy: 7 });
            ob.push({ s, lat, r: 0.25 });
          });
          /* のりば番号の札(いちばん前の柱。くだりで左=1、右=2。のぼりは入れかわる) */
          frameInto(rs, st.s, f);
          flatT(f, n).negate();
          c.copy(f.p).addScaledVector(f.left, lat).addScaledVector(n, 0.13);
          c.y = f.p.y + 1.05 + 2.55;
          makeSign(rs, `nori:${(sg > 0) !== up ? 1 : 2}`, 0.3, 0.3, { c, n, postH: 0 });
        });
        /* 階段と、橋上駅舎・跨線橋の柱 */
        if (stairs) {
          buildStairs(rs, B, st, S, ob);
          concourseColumns(rs, B, st, S, ob);
        }
      } else {
        /* 地下駅: 天井の光る帯(各ホーム2本)+床の灯りの帯+ホームの柱(10mごと) */
        [1, -1].forEach((sg) => {
          const P = sideOf(sg), m0 = mid(P);
          [-0.75, 0.75].forEach((d) => stripB.geo(profileStrip(F, i0 + 1, i1 - 1, [[m0 + d - 0.16, 6.1, 0], [m0 + d + 0.16, 6.1, 1]])));
          for (let s = Math.ceil((st.s - P_A + 4) / 6) * 6 + 3; s < st.s + P_B - 2; s += 6) {
            frameInto(rs, s, f);
            W.indoorStrips.push({ p: f.p.clone().addScaledVector(f.left, m0).setY(f.p.y + 1.062), q: qFloor(f), sx: Math.abs(P.back - P.edge) + 0.4, sy: 12, k: 0.42 });
          }
          for (let s = st.s - 150; s <= st.s + 10; s += 10) {
            frameInto(rs, s, f);
            q.setFromAxisAngle(UPV, Math.atan2(f.t.x, f.t.z));
            m4.compose(f.p.clone().addScaledVector(f.left, m0).setY(f.p.y + 1.05), q, one);
            B.geo(ugColGeo, { m: m4, col: 0xc9ccce, white: true });
            ob.push({ s, lat: m0, r: 0.45 });
          }
        });
      }
    }

    /* ---- 駅名標: ホームのうしろ寄りに線路と平行(2本足)。表も裏も読める ---- */
    const signFace = (cc, nn, w, h, full) => {
      if (!full) { SB.quad(cc, nn, w, h, SIGN_UV.name); return; }
      tf.crossVectors(UPV, nn);                 // 見る人の右手
      const alt = tf.dot(f.t) < 0;              // 右手が進行方向の反対なら、となりの駅を左右入れかえた帯
      const hT = (h * 138) / 176, hB = h - hT;
      const c1 = cc.clone(); c1.y += h / 2 - hT / 2;
      SB.quad(c1, nn, w, hT, SIGN_UV.name);
      const c2 = cc.clone(); c2.y += -h / 2 + hB / 2;
      SB.quad(c2, nn, w, hB, alt ? SIGN_UV.alt : SIGN_UV.band);
    };
    const twoFaced = (cc, nn, w, h, full) => {
      signFace(cc.clone().addScaledVector(nn, 0.012), nn, w, h, full);
      const nb = nn.clone().negate();
      signFace(cc.clone().addScaledVector(nb, 0.012), nb, w, h, full);
      /* 枠(上下の縁) */
      q.setFromAxisAngle(UPV, Math.atan2(nn.x, nn.z));
      [h / 2 + 0.015, -h / 2 - 0.015].forEach((dy) => {
        const cc2 = cc.clone(); cc2.y += dy;
        B.geo(rail, { m: m4.compose(cc2, q, one.set(w / 1.9 + 0.02, 1, 1)), col: 0x8d959b, white: true });
        one.set(1, 1, 1);
      });
    };
    const legs = (cc, nn, yb, hgt, dx) => {
      tf.crossVectors(UPV, nn).normalize();
      [-dx, dx].forEach((d) => B.post(cc.x + tf.x * d, yb, cc.z + tf.z * d, hgt, 0x8d959b, 1.3));
    };
    /* 新宿は島式ホームの中心線の柱(termColumnS)にささらない位置へ */
    const termCols = isTerm ? termColumnS(T) : null;
    [1, -1].forEach((sg) => {
      const P = sideOf(sg);
      const lat = isTerm ? mid(P) : P.back - 0.6 * sg;
      [-40, -110].forEach((ds0) => {
        const ds = isTerm ? clearOfCols(termCols, st.s + ds0, 0.95) - st.s : ds0;
        frameInto(rs, st.s + ds, f);
        n.copy(f.left).multiplyScalar(-sg);     // 線路のほうを向く
        c.copy(f.p).addScaledVector(f.left, lat);
        const yb = f.p.y + 1.05;
        c.y = yb + 1.25 + 0.325;
        twoFaced(c, n, 1.9, 0.65, true);
        legs(c, n, yb, 1.25 + 0.65 + 0.03, 0.82);
        ob.push({ s0: st.s + ds - 1.1, s1: st.s + ds + 1.1, lat, r: 0.3 });
      });
      /* ホームの先端: 線路に直角、入ってくる運転台のほうを向く(停車中の運転台から読める大きさ) */
      frameInto(rs, st.s + 11, f);
      flatT(f, n).negate();
      c.copy(f.p).addScaledVector(f.left, mid(P));
      const yb = f.p.y + 1.05;
      const ww = 2.5, hh = (ww * 138) / 512;
      c.y = yb + 1.2 + hh / 2;
      twoFaced(c, n, ww, hh, false);
      legs(c, n, yb, 1.2 + hh + 0.03, 1.08);
      ob.push({ s0: st.s + 10.6, s1: st.s + 11.4, lat: mid(P), r: 1.45 });   // 板の下は頭がぶつかる
    });

    /* ---- 停止位置目標「8」: STOP8_SIZE 角の板(ねらいやすい大きさ。10m 手前で 40px 以上)、へりから0.6mの柱の上
     * (板の中心はホーム面から1.75m = レール面から 2.8m = STOP8_Y)。板の内がわのはしは横 1.77m で、
     * 車体のはば 1.475m にかからない。判定の点(st.s + STOP8_AHEAD)に立てる。止まった運転台の左の窓のよこ ---- */
    frameInto(rs, st.s + STOP8_AHEAD, f);
    flatT(f, n).negate();
    {
      const yb = f.p.y + 1.05;
      c.copy(f.p).addScaledVector(f.left, STOP8_LAT);
      c.y = yb + 1.75;
      makeSign(rs, 'stop8', STOP8_SIZE, STOP8_SIZE, { c, n, postH: 1.75, yBase: yb });
      /* 待つ人は 柱から0.4m 以上はなれる(人の半径0.2〜0.3 + 0.4) */
      ob.push({ s: st.s + STOP8_AHEAD, lat: STOP8_LAT, r: 0.6 });
    }

    /* ---- 発車標と時計 ----
     * 左ホームの発車標は停止位置の7.5m先・ホームのまん中より少しうしろ寄り(横 3.45m。止まった運転台から見て
     * 「8」の右どなり。「8」にかくれず、ホームの端のモニター・ミラーとも重ならない)。屋根の先の端より手前につるす。
     * 時計は止まった運転台の右の窓から見える右ホームの先と、両ホームの中ほど。右ホームの発車標は中ほど。
     * 中ほどのものは、ホームの中心線の柱(st.s から10mごと)のあいだ(st.s-65 / -75)につるす */
    const ceilY = isTerm ? 7.4 : under ? 6.2 : 4.05;
    if (!isTerm) {
      const sL = under ? st.s + 7.5 : Math.min(st.s + 7.5, iOf(st.s + ROOF_B) * step - 0.45);
      ledBoard(B, 2, sL, 3.45, under ? 5.4 : 3.55, ceilY);
      clockAt(B, sL, mid(PLAT.R), ceilY);
      clockAt(B, st.s - 65, mid(PLAT.L), ceilY);
      ledBoard(B, 3, clearOfGantry(st.s - 75, 0.7), mid(PLAT.R) + 0.1, under ? 5.4 : 3.55, ceilY);
      clockAt(B, st.s - 65, mid(PLAT.R), ceilY);
    } else {
      [[1, st.s + 14], [-1, st.s - 75]].forEach(([sg, s]) => clockAt(B, clearOfCols(termCols, s, 0.35), mid(sideOf(sg)), ceilY));
    }
  });
  /* 灯りの帯(屋根の下とホームの端。夜・夕方・雨の日だけ) */
  addPools(rs, pools, M.poolStrip);
  /* P4: 屋根の下の範囲 [s0, s1](s0 の小さい順)。運転台の日だまりを屋根の下で消す。
   * ホームの屋根・地下駅(ホームぜんぶ)・橋上駅舎/跨線橋(線路の上の建物)・新宿のターミナル(大屋根) */
  const spans = [];
  rs.line.stations.forEach((st, si) => {
    const isTerm = !!T && st.name === '新宿';
    if (isTerm) { spans.push([T.a, T.b]); return; }
    if (rs._inTunnel(st.s)) { spans.push([snapS(rs, st.s - P_A), snapS(rs, st.s + P_B)]); return; }
    spans.push([snapS(rs, st.s - roofLen(rs, si)), snapS(rs, st.s + ROOF_B)]);
    const S = sty[si];
    if (S.kind === 'over' || S.kind === 'foot') {
      const hz = S.kind === 'over' ? 6 : 1.7;
      spans.push([st.s - STAIR.c - hz, st.s - STAIR.c + hz]);
    }
  });
  spans.sort((x, y) => x[0] - y[0]);
  rs._roofSpans = spans;
}

/* ---------- トンネル照明: 壁の灯具(12mごと・絶対位置 s=12k+6)+道床の灯りの帯 ----------
 * 壁を照らす光は壁の材質(trackbed.js の 'tunwall')が同じ位置に描くので、ここでは灯具と床の帯だけ */
export function buildTunnelLights(rs) {
  const W = rs._stw;
  if (!W) return;
  const M = W.M;
  const wl = rs.quadOff ? rs.quadOff[1] + 2.4 : 7.2, wr = -9.5;
  const f = newFrame(), tf = new THREE.Vector3();
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
  const FB = bakerFor(rs, M.fixture, M.fixture, { build: { recv: false } });
  const fixGeo = new THREE.BoxGeometry(0.08, 0.06, 1.2);
  const P = TUN_LAMP.pitch, PH = TUN_LAMP.phase;
  rs.line.sections.tunnel.forEach((t) => {
    for (let s = Math.ceil((t.from + 4 - PH) / P) * P + PH; s < t.to - 4; s += P) {
      frameInto(rs, s, f);
      flatT(f, tf);
      [[wl, -1], [wr, 1]].forEach(([w, inward]) => {
        /* 灯具(壁の高さ4.2m) */
        q.setFromAxisAngle(UPV, Math.atan2(f.t.x, f.t.z));
        FB.geo(fixGeo, { m: m4.compose(f.p.clone().addScaledVector(f.left, w + inward * 0.06).setY(f.p.y + TUN_LAMP.y), q, one), white: true });
        /* 道床の低い灯りの帯(24mの帯を12mごとに重ねる=つぎ目のない帯) */
        W.indoorStrips.push({ p: f.p.clone().addScaledVector(f.left, w + inward * 3.0).setY(f.p.y + 0.07), q: new THREE.Quaternion().setFromRotationMatrix(m4.makeBasis(f.left.clone().negate(), tf, UPV)), sx: 6.5, sy: 2 * P, k: 0.08 });
      });
    }
  });
}

/* 屋内(トンネル・地下駅・ターミナル)の光だまりと灯りの帯: いつも点灯。強さはインスタンス色で */
function flushIndoorPools(rs) {
  const W = rs._stw;
  if (!W) return;
  const col = new THREE.Color();
  [[W.indoorPools, W.M.poolIn], [W.indoorStrips, W.M.poolStripIn]].forEach(([list, mat]) => {
    if (!list.length) return;
    const im = addPools(rs, list, mat);
    list.forEach((a, i) => { col.setRGB(0.93 * a.k, 0.96 * a.k, 0.9 * a.k); im.setColorAt(i, col); });
  });
  W.indoorPools = []; W.indoorStrips = [];
}

/* ---------- 新宿ターミナル ---------- */
/* 島式ホームの範囲(くだりは st.s-168 〜 +15、のぼりは st.s-155 〜 +28) */
const termPlat = (T) => (T.up ? [T.s0 - 155, T.s0 + 28] : [T.s0 - 168, T.s0 + 15]);
/* タイル張りの柱の位置(ホームの中心線に10mごと)。駅名標・発車標・のりば・時計が柱にささらないよう、
 * くだりは s0-165+10k: 駅名標(-40/-110)・発車標(-60)から5m。のりば・時計で柱に近いものは clearOfCols でずらす。
 * 止まっている運転台(目は s0-1)の すぐ前(s0-3 〜 s0+16)には立てない: くだりの出発の最初の画面・
 * のぼりの終点に止まった画面の 目の前に 太い柱が来ないように */
function termColumnS(T) {
  const [pa, pb] = termPlat(T);
  const out = [];
  for (let s = T.up ? pa + 8 : pa + 3; s < pb - 4; s += 10) out.push(s);
  return out.filter((s) => s < T.s0 - 3 || s > T.s0 + 16);
}
/* 柱(0.55m角)にかからない位置へ 0.5mずつずらす。half: 板の線路方向の半分の長さ */
function clearOfCols(cols, s, half) {
  const need = half + 0.275 + 0.15;
  for (let k = 0; k <= 40; k++) {
    const x = s + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.5;
    let ok = true;
    for (let j = 0; j < cols.length; j++) if (Math.abs(x - cols[j]) < need) { ok = false; break; }
    if (ok) return x;
  }
  return s;
}
let _bufGeo = null;
export function buildTerminal(rs) {
  const T = rs._terminalInfo();
  if (!T) return;
  const W = rs._stw;
  const M = W.M;
  const F = rs.frames, step = rs.step, N = F.length - 1;
  const iOf = (s) => Math.max(0, Math.min(N, Math.round(s / step)));
  const i0 = Math.floor(T.a / step), i1 = Math.ceil(T.b / step);
  const W_L = 8.9, W_R = -12.6, H = 7.4;
  const TR_L = PLAT.L.back + PLAT.L.edge, TR_R = PLAT.R.back - PLAT.L.edge;   // 外側の線路(6.58 / -10.38)
  /* くだりの位置関係で決めた場所を、のぼりでも同じ「物理的な位置」に置く */
  const phys = (d) => (T.up ? T.s0 - 140 - d : T.s0 + d);
  const f = newFrame(), n = new THREE.Vector3(), c = new THREE.Vector3(), tf = new THREE.Vector3();
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
  const si = rs.line.stations.findIndex((s) => s.name === '新宿');
  const B = stationBaker(rs, si) || bakerFor(rs, 'term', M.stUG, { white: WHITE, e: true, build: { cast: true } });
  const SB = W.termSign ? bakerFor(rs, W.termSign, W.termSign) : null;

  /* 天井(0.6mの格子)と壁 */
  const ceilB = new Baker(new THREE.MeshStandardMaterial({ map: texCeiling(), roughness: 0.85, side: DS }));
  ceilB.geo(profileStrip(F, i0, i1, [[W_R - 0.3, H, -0.05], [W_L + 0.3, H, (W_L - W_R + 0.3) / 6]]));
  ceilB.build(rs, { cast: true });
  const wallB = new Baker(new THREE.MeshStandardMaterial({ map: rs.T.concWallC, color: 0x8e9298, roughness: 0.95, side: DS }));
  [W_L, W_R].forEach((w) => wallB.geo(profileStrip(F, i0, i1, [[w, -0.3, 0], [w, H, 1]])));

  /* 外側の線路2本(6.58 / -10.38)と、そこで発車を待つ電車。
   * 道床・レール・枕木の帯は線路の帯と同じ材質・同じ作りなので、帯の合体(mergeRibbons)で
   * 本線の帯といっしょに描く(ターミナルのぶんの描画はふえない) */
  const RH = 1.067 / 2 + 0.032;
  const addR = (g, mat) => { if (!mat) return; const m = new THREE.Mesh(g, mat); m.receiveShadow = true; rs.world.add(m); };
  [TR_L, TR_R].forEach((off) => {
    addR(profileStrip(F, i0, i1, [[off + 1.9, 0, 0], [off - 1.9, 0, 1]], 2.5), rs.M.ballast);
    [-RH, RH].forEach((o) => {
      addR(profileStrip(F, i0, i1, [[off + o + 0.034, 0.19, 0], [off + o - 0.034, 0.19, 1]], 25), rs.M.railHead);
      addR(profileStrip(F, i0, i1, [[off + o + 0.034, 0.05, 0], [off + o + 0.034, 0.178, 1]], 8), rs.M.railWeb);
    });
    addR(profileStrip(F, i0, i1, [[off + 1.0, 0.004, 0], [off - 1.0, 0.004, 1]], 0.625), rs.M.sleeperBand);
  });
  [[TR_L, 'rapid', 10], [TR_R, 'exp', 8]].forEach(([off, kind, nCar]) => {
    const tr = rs.makeTrainModel(nCar, { kind, dest: '新百合ヶ丘' });
    rs.setTrainLights(tr, { head: true, tail: true });
    const head = T.up ? T.s0 - 150 : T.s0 - 4;
    placeTrain(rs, tr, head, T.up ? -1 : 1, off);
    rs.world.add(tr.group);
  });

  /* 島式ホーム2面(両側にへり・点字ブロック)。床の自発光は0.38(夜の屋内でも床が白く飛ばない。
   * 昼は屋根の下の明るさ合わせ(_applyLightLevel)で明るくなるので、0.55 では白いプラスチックのように見えた) */
  const [pa, pb] = termPlat(T);
  const pi0 = iOf(pa), pi1 = iOf(pb);
  [islandProfile(PLAT.L.edge, PLAT.L.back), islandProfile(PLAT.R.edge, PLAT.R.back)].forEach((prof) => {
    B.geo(profileStrip(F, pi0, pi1, prof), { e: 0.38 });
    [[pi0, -1], [pi1, 1]].forEach(([ii, o]) => B.geo(endCap(F[ii], prof, AT.plat(0.97), o), { e: 0.38, col: 0x8f8c85 }));
  });

  /* 柱(タイル張り、目の高さに のりば番号の白い札)。位置は termColumnS(看板がささらない列)。
   * 左右の島の柱は1枚の画像(4マス)で、まとめて描画1回。札は線路のほうを向く2面(箱の ±x = ±left)だけ、
   * 線路に沿った向きの2面(運転台のほうを向く面)と上下は 札のないタイル */
  const physLeft = !T.up;   // くだりで左の島 = 1・2番線
  const colS = termColumnS(T);
  const colTex = texTermColumn(physLeft ? '1・2' : '3・4', physLeft ? '3・4' : '1・2');
  const colB = new Baker(new THREE.MeshStandardMaterial({ map: colTex, roughness: 0.55 }));
  [[1, 0], [-1, 0.25]].forEach(([sg, u0]) => {
    const lat = mid(sideOf(sg));
    const geo = new THREE.BoxGeometry(0.55, H, 0.55).translate(0, H / 2, 0);
    const uv = geo.attributes.uv;
    /* BoxGeometry の面の順: +x, -x, +y, -y, +z, -z(4頂点ずつ) */
    for (let k = 0; k < uv.count; k++) uv.setX(k, (Math.floor(k / 4) < 2 ? u0 : 0.5) + uv.getX(k) * 0.25);
    if (W.obst[si]) colS.forEach((s) => W.obst[si].push({ s, lat, r: 0.5 }));
    colS.forEach((s) => {
      frameInto(rs, s, f);
      q.setFromAxisAngle(UPV, Math.atan2(f.t.x, f.t.z));
      colB.geo(geo, { m: m4.compose(f.p.clone().addScaledVector(f.left, lat).setY(f.p.y + 1.0), q, one) });
    });
  });
  colB.build(rs, { cast: true });

  /* 天井の照明(線路と平行の光の帯。格子のパネル中央にそろえる) */
  const snap = (x) => W_R + 0.6 * (Math.round((x - W_R) / 0.6 - 0.5) + 0.5);
  const stripB = bakerFor(rs, M.strip, M.strip, { build: { recv: false } });
  [mid(PLAT.L) - 0.9, mid(PLAT.L) + 0.9, -1.9, mid(PLAT.R) - 0.9, mid(PLAT.R) + 0.9].forEach((x) => {
    const sx = snap(x);
    stripB.geo(profileStrip(F, i0 + 1, i1 - 1, [[sx - 0.16, H - 0.05, 0], [sx + 0.16, H - 0.05, 1]]));
  });
  /* ホームの床の灯りの帯(屋内なので いつも。つぎ目のない帯) */
  [mid(PLAT.L), mid(PLAT.R)].forEach((lat) => {
    for (let s = Math.ceil((pa + 4) / 6) * 6 + 3; s < pb - 2; s += 6) {
      frameInto(rs, s, f);
      flatT(f, tf);
      W.indoorStrips.push({ p: f.p.clone().addScaledVector(f.left, lat).setY(f.p.y + 1.062), q: new THREE.Quaternion().setFromRotationMatrix(m4.makeBasis(f.left.clone().negate(), tf, UPV)), sx: Math.abs(PLAT.L.back - PLAT.L.edge) + 0.4, sy: 12, k: 0.36 });
    }
  });

  /* 出口の上の梁(下の基壇と同じ材質にまとめて描く。描画は基壇といっしょ) */
  const exitS = T.up ? T.a : T.b;
  const backS = T.up ? T.b : T.a;
  const fx = frameOf(rs, exitS);
  const beamP = fx.p.clone().addScaledVector(fx.left, (W_L + W_R) / 2);
  beamP.y += H + 1.0;
  const beamQ = new THREE.Quaternion().setFromAxisAngle(UPV, Math.atan2(fx.t.x, fx.t.z));
  const beamM = new THREE.Matrix4().compose(beamP, beamQ, new THREE.Vector3(1, 1, 1));

  /* 駅ビル: 屋根の上に、壁の幅+2mで。両わきは地面まで届く基壇で支える(宙に浮かない) */
  const fm = frameOf(rs, (T.a + T.b) / 2);
  const len = T.b - T.a;
  const bW = W_L - W_R + 2, bH = 38;
  const bldMat = new THREE.MeshStandardMaterial({ map: texTermBuilding(false), emissive: 0xfff0d0, emissiveMap: texTermBuilding(true), emissiveIntensity: 0, roughness: 0.75 });
  W.termBld = bldMat;
  /* 面ごとに 12m x 8m で1枚になるUV(箱の長い面でも引き伸ばさない) */
  const worldUV = (g, tw, th) => {
    const p = g.attributes.position, nr = g.attributes.normal, uv = g.attributes.uv;
    for (let i = 0; i < p.count; i++) {
      const ax = Math.abs(nr.getX(i)), ay = Math.abs(nr.getY(i));
      if (ay > 0.5) uv.setXY(i, 0.5, 0.03);    // 屋上: 窓のない無地のところ
      else uv.setXY(i, (ax > 0.5 ? p.getZ(i) : p.getX(i)) / tw, p.getY(i) / th);
    }
    return g;
  };
  /* 低層(ホームの上いっぱい)+高層棟(少し引っこめて中ほどに)の2段にして、ただの箱に見せない */
  const bq = new THREE.Quaternion().setFromAxisAngle(UPV, Math.atan2(fm.t.x, fm.t.z));
  const bldB = new Baker(bldMat);
  [[bW, 14, len, 0], [bW - 4, bH, len * 0.42, len * 0.12 * (T.up ? 1 : -1)]].forEach(([w, h, l, dz]) => {
    const p = fm.p.clone().addScaledVector(fm.left, (W_L + W_R) / 2).addScaledVector(fm.t, dz);
    p.y += H + 0.4;
    bldB.geo(worldUV(new THREE.BoxGeometry(w, h, l).translate(0, h / 2, 0), 12, 8), { m: m4.compose(p, bq, one) });
  });
  bldB.build(rs, { cast: true });
  const bld = { quaternion: bq };
  const podB = new Baker(new THREE.MeshStandardMaterial({ map: rs.T.concC, color: 0xc9c6bd, roughness: 0.9 }));
  podB.geo(new THREE.BoxGeometry(W_L - W_R + 2, 2.6, 2.2), { m: beamM });
  const podH = H + 0.4 + 0.6;
  [W_L + 0.5, W_R - 0.5].forEach((lat) => {
    [-1, 1].forEach((k) => {
      const pl = len / 2 - 5;
      const p = fm.p.clone().addScaledVector(fm.left, lat).addScaledVector(fm.t, k * (pl / 2 + 5));
      p.y += podH / 2 - 0.6;
      podB.geo(new THREE.BoxGeometry(1.0, podH, pl), { m: m4.compose(p, bld.quaternion, one) });
    });
  });
  podB.build(rs, { cast: true });

  /* 奥の壁(コンコース側)と大きな駅名(かなが大きい) */
  const fb = frameOf(rs, backS);
  const backC = fb.p.clone().addScaledVector(fb.left, (W_L + W_R) / 2);
  backC.y += (H + 0.4) / 2 - 0.3;
  wallB.geo(new THREE.BoxGeometry(W_L - W_R + 1, H + 0.4, 0.8), { m: m4.compose(backC, q.setFromAxisAngle(UPV, Math.atan2(fb.t.x, fb.t.z)), one) });
  wallB.build(rs, { cast: true });
  flatT(fb, n).multiplyScalar(T.up ? -1 : 1);
  c.copy(backC).addScaledVector(n, 0.45);
  c.y = fb.p.y + 5.0;
  if (SB) SB.quad(c, n, 6.0, (6.0 * 138) / 512, SIGN_UV.name);

  /* 天井から下がる「のりば」案内(表も裏も読める。左右が逆にならない)。
   * 絵は発車標と同じ画像の下の段(内照式の看板として同じ材質で光る)・描画は発車標といっしょ */
  const ledT0 = W.led.tex, ey = ledT0.userData.extraY;
  const NB = bakerFor(rs, 'led', W.led.mat);
  const nuv = TERM_EX.nori.map(([x0, y0, x1, y1]) => ledT0.userData.uvPx(x0, ey + y0, x1, ey + y1));
  [[1, nuv[0]], [-1, nuv[1]]].forEach(([sg, uvr]) => {
    [-30, -95].forEach((d) => {
      frameInto(rs, clearOfCols(colS, phys(d), 0.3), f);
      flatT(f, n);
      c.copy(f.p).addScaledVector(f.left, mid(sideOf(sg)));
      c.y = f.p.y + 4.3;
      NB.quad(c.clone().addScaledVector(n, 0.01), n, 2.6, 0.65, uvr);
      const nb = n.clone().negate();
      NB.quad(c.clone().addScaledVector(nb, 0.01), nb, 2.6, 0.65, uvr);
      tf.crossVectors(UPV, n);
      [-1, 1].forEach((k) => B.post(c.x + tf.x * k, c.y + 0.32, c.z + tf.z * k, f.p.y + H - (c.y + 0.32), 0x6f777d));
    });
  });

  /* ---- 駅らしさ: 壁の光る広告・「↑ でぐち」・奥の「のりかえ」・改札・奥のコンコースの床 ----
   * 絵はみな発車標と同じ画像(TERM_EX)・同じ材質で、描画は発車標といっしょ(ふえない)。枠・改札機は駅の形に焼きこむ */
  const exUV = (r) => ledT0.userData.uvPx(r[0], ey + r[1], r[2], ey + r[3]);
  const posterUV = TERM_EX.poster.map(exUV);
  /* 壁の広告(3.2x1.4m・まん中はレール面から2.2m)を12mごとに両がわの壁へ。柱と同じ位置はよける。
   * 黒い枠(3.4x1.6x0.12)の前に、内がわを向けて */
  const frameGeo = new THREE.BoxGeometry(0.12, 1.6, 3.4);
  let pk = 0;
  for (let s = T.s0 + 6 - 12 * Math.floor((T.s0 + 6 - (T.a + 6)) / 12); s < T.b - 3; s += 12) {
    if (colS.some((x) => Math.abs(x - s) < 2.2)) continue;
    frameInto(rs, s, f);
    q.setFromAxisAngle(UPV, Math.atan2(f.t.x, f.t.z));
    [[W_L, -1], [W_R, 1]].forEach(([w, inward]) => {
      n.copy(f.left).multiplyScalar(inward).setY(0).normalize();
      c.copy(f.p).addScaledVector(f.left, w + inward * 0.06);
      c.y = f.p.y + 2.2;
      B.geo(frameGeo, { m: m4.compose(c, q, one), col: 0x23282d, white: true });
      c.addScaledVector(n, 0.065);
      NB.quad(c, n, 3.2, 1.4, posterUV[pk % 4]);
      pk++;
    });
  }
  /* 「↑ でぐち」(2.4x0.5)を島の上に2枚ずつ。出口(奥の壁)へ歩く人に見える向き(表は出口と反対を向く)。
   * 裏は黒い箱。天井から2本の棒でつるす */
  const dgUV = exUV(TERM_EX.deguchi);
  const dgBox = new THREE.BoxGeometry(2.5, 0.6, 0.08);
  [-20, -120].forEach((d) => {
    frameInto(rs, clearOfCols(colS, phys(d), 1.3), f);
    flatT(f, n).multiplyScalar(T.up ? -1 : 1);
    q.setFromAxisAngle(UPV, Math.atan2(n.x, n.z));
    [1, -1].forEach((sg) => {
      c.copy(f.p).addScaledVector(f.left, mid(sideOf(sg)));
      c.y = f.p.y + 4.35;
      B.geo(dgBox, { m: m4.compose(c, q, one), col: 0x1b1f23, white: true });
      NB.quad(c.clone().addScaledVector(n, 0.045), n, 2.4, 0.5, dgUV);
      tf.crossVectors(UPV, n);
      [-1, 1].forEach((k) => B.post(c.x + tf.x * k, c.y + 0.3, c.z + tf.z * k, f.p.y + H - (c.y + 0.3), 0x6f777d));
    });
  });
  /* 奥のコンコース: 線路の終わり(車止め)の先から奥の壁まで、ホームの高さの床を はばいっぱいに。
   * くだりは車止めがホームの はしより奥にあるので、島をコンコースまでのばす */
  const dirOut = backS > T.buffer ? 1 : -1;
  const sA = dirOut > 0 ? Math.max(pb, T.buffer + 1.5) : Math.min(pa, T.buffer - 1.5);
  const ia = iOf(sA), ib = iOf(backS);
  if (ia !== ib) {
    const k0 = Math.min(ia, ib), k1 = Math.max(ia, ib);
    /* 舗装の絵(アトラスの 160〜240px)を 約1mごとにくりかえす */
    const prof = [];
    for (let x = W_R; x < W_L - 0.01; x += 1.0) {
      const x1 = Math.min(W_L, x + 1.0);
      prof.push([x, 1.05, AT.plat(0.64)], [x1, 1.05, AT.plat(0.93)]);
    }
    B.geo(profileStrip(F, k0, k1, prof), { e: 0.38 });
    B.geo(capGeo(F[ia], [[W_R, -0.3], [W_R, 1.05], [W_L, 1.05], [W_L, -0.3]]), { white: true, col: 0x8f8c85 });
    /* くだり: 島のはしからコンコースまで */
    if (dirOut < 0 && iOf(pa) > ia) {
      [islandProfile(PLAT.L.edge, PLAT.L.back), islandProfile(PLAT.R.edge, PLAT.R.back)].forEach((pr) => B.geo(profileStrip(F, ia, iOf(pa), pr), { e: 0.38 }));
    }
  }
  /* 改札: 奥の壁の6m手前(のぼりは島のはしの2m手前)に、島ごとに改札機5台(0.22x1.0x1.6)。
   * ホームがわの はしに 緑の灯(入れる) */
  const gateS = dirOut > 0 ? pb - 2 : backS + 6;
  const gateGeo = new THREE.BoxGeometry(0.22, 1.0, 1.6), gTop = new THREE.BoxGeometry(0.24, 0.04, 0.4);
  const gu = TERM_EX.gate, guv = exUV(gu), gWhite = [(guv[0] + guv[2]) / 2, (guv[1] + guv[3]) / 2];
  frameInto(rs, gateS, f);
  q.setFromAxisAngle(UPV, Math.atan2(f.t.x, f.t.z));
  flatT(f, tf);
  [1, -1].forEach((sg) => {
    const P = sideOf(sg), w = Math.abs(P.back - P.edge), n5 = 5;
    for (let k = 0; k < n5; k++) {
      const lat = P.edge + sg * (0.3 + (k * (w - 0.6)) / (n5 - 1));
      c.copy(f.p).addScaledVector(f.left, lat);
      c.y = f.p.y + 1.05 + 0.5;
      B.geo(gateGeo, { m: m4.compose(c, q, one), col: 0x9aa3a8, white: true });
      c.y += 0.52;
      c.addScaledVector(tf, -dirOut * 0.6);
      const w0 = NB.white;
      NB.white = gWhite;
      NB.geo(gTop, { m: m4.compose(c, q, one), white: true });
      NB.white = w0;
    }
  });
  /* 奥の壁の「のりかえ」(2.0x0.5。島の上・改札のむこう) */
  {
    const nkUV = exUV(TERM_EX.norikae);
    const fbk = frameOf(rs, backS);
    const nb2 = flatT(fbk, new THREE.Vector3()).multiplyScalar(T.up ? -1 : 1);
    [1, -1].forEach((sg) => {
      c.copy(fbk.p).addScaledVector(fbk.left, mid(sideOf(sg))).addScaledVector(nb2, 0.42);
      c.y = fbk.p.y + 3.35;
      NB.quad(c, nb2, 2.0, 0.5, nkUV);
    });
  }

  /* 発車標(LED): 各ホームに2台。両面。前の台は停止位置の9m先
   * (止まった運転台から見て、停止位置目標「8」(判定の点=運転台の左の窓のよこ)にかくれない)。
   * 画像と描画は全線の発車標と同じ1枚・1回(上から0台目=左の島 / 1台目=右の島)。箱は駅の形に焼きこむ */
  const ledT = W.led.tex;
  const LB = bakerFor(rs, 'led', W.led.mat);
  const housGeo = new THREE.BoxGeometry(2.4, 0.55, 0.15);
  [[1, ledT.userData.uvOf(0)], [-1, ledT.userData.uvOf(1)]].forEach(([sg, uvr]) => {
    [9, -60].forEach((d) => {
      frameInto(rs, clearOfCols(colS, phys(d), 0.3), f);
      flatT(f, n);
      c.copy(f.p).addScaledVector(f.left, mid(sideOf(sg)));
      c.y = f.p.y + 4.45;
      B.geo(housGeo, { m: m4.compose(c, q.setFromAxisAngle(UPV, Math.atan2(n.x, n.z)), one), col: 0x15181b, white: true });
      LB.quad(c.clone().addScaledVector(n, 0.078), n, 2.24, 0.49, uvr);
      const nb = n.clone().negate();
      LB.quad(c.clone().addScaledVector(nb, 0.078), nb, 2.24, 0.49, uvr);
      tf.crossVectors(UPV, n);
      [-0.9, 0.9].forEach((k) => B.post(c.x + tf.x * k, c.y + 0.27, c.z + tf.z * k, f.p.y + H - (c.y + 0.27), 0x6f777d));
    });
  });
  rs._ledBoards = { up: T.up, tex: ledT };
  updateLedBoards(rs);

  /* 車止め(各線の終端): 赤白の枠+支柱(駅の形に焼きこむ)+赤色灯(4つで描画1回) */
  const fbuf = frameOf(rs, T.buffer);
  if (!_bufGeo) {
    _bufGeo = {
      beam: new THREE.BoxGeometry(2.0, 0.35, 0.3), band: new THREE.BoxGeometry(0.25, 0.36, 0.31),
      post: new THREE.BoxGeometry(0.18, 1.2, 0.18), lamp: new THREE.CircleGeometry(0.12, 12),
    };
  }
  const BG = _bufGeo;
  /* 赤色灯は発車標の画像の赤い四角を指す(発車標と同じ材質・同じ描画) */
  const lu = TERM_EX.lamp, luv = ledT0.userData.uvPx(lu[0], ey + lu[1], lu[2], ey + lu[3]);
  const lampB = bakerFor(rs, 'led', W.led.mat);
  const lampUV = [(luv[0] + luv[2]) / 2, (luv[1] + luv[3]) / 2];
  const zb = flatT(fbuf, new THREE.Vector3()).multiplyScalar(T.up ? -1 : 1);   // 正面(+z)はホームのほう
  const xb = new THREE.Vector3().crossVectors(UPV, zb);
  const G = new THREE.Matrix4(), L4 = new THREE.Matrix4();
  [0, -3.8, TR_L, TR_R].forEach((off) => {
    G.makeBasis(xb, UPV, zb).setPosition(fbuf.p.x + fbuf.left.x * off, fbuf.p.y, fbuf.p.z + fbuf.left.z * off);
    B.geo(BG.beam, { m: L4.makeTranslation(0, 1.05, 0).premultiply(G), col: 0xe8e6e0, white: true });
    [-0.75, -0.25, 0.25, 0.75].forEach((x) => B.geo(BG.band, { m: L4.makeTranslation(x, 1.05, 0).premultiply(G), col: 0xc8281e, white: true }));
    [-0.75, 0.75].forEach((x) => B.geo(BG.post, { m: L4.makeRotationX(0.5).setPosition(x, 0.6, -0.4).premultiply(G), col: 0x4f575d, white: true }));
    const w0 = lampB.white;
    lampB.white = lampUV;
    lampB.geo(BG.lamp, { m: L4.makeTranslation(0, 1.45, 0.16).premultiply(G), white: true });
    lampB.white = w0;
  });
}

/* 発車標の中身(種別・行き先・時刻・両数)。中身が変わったときだけ書き直す */
/* ゲーム内の秒 → 「10:24」(時間帯ごとの始発の時刻から) */
function hm(rs, sec) {
  const base = rs.timeOfDay === 'night' ? 19 : rs.timeOfDay === 'evening' ? 16 : 10;
  const tot = Math.floor(sec) + base * 3600;
  return `${Math.floor(tot / 3600) % 24}:${String(Math.floor((tot % 3600) / 60)).padStart(2, '0')}`;
}
/* 種別のじゅんばん(かくえき → きゅうこう → かいそくきゅうこう → …)。
 * 「そのつぎ」は つぎの種別のうち、その駅に止まるもの(止まらない種別はとばす) */
const KIND_CYCLE = ['local', 'exp', 'rapid'];
function stopsAt(kind, name) {
  const sv = SERVICES[kind];
  return !sv || !sv.stops || sv.stops.indexOf(name) >= 0;
}
function nextKind(kind, name) {
  let i = KIND_CYCLE.indexOf(kind);
  for (let k = 0; k < 3; k++) {
    i = (i + 1) % 3;
    if (!name || stopsAt(KIND_CYCLE[i], name)) return KIND_CYCLE[i];
  }
  return 'local';
}
const ledEnt = (rs, kind, destName, sec, cars) => ({ kind, dest: kanaOf(destName), time: hm(rs, sec), cars });
export function updateLedBoards(rs) {
  const B = rs._ledBoards, sim = rs.sim;
  if (!B || !sim || !sim.timetable || !sim.timetable.length) return;
  const tt = sim.timetable;
  const yuri = '新百合ヶ丘';
  const T = B.tex.userData;
  if (!B.up) {
    const dep = tt[0].dep;
    const own = sim.serviceKey || 'local', dest = sim.stops[sim.stops.length - 1].name;
    const k2 = nextKind(own, '新宿');
    T.setBoard(0, ledEnt(rs, own, dest, dep, 8), ledEnt(rs, k2, yuri, dep + 300, k2 === 'rapid' ? 10 : 8));
    const k3 = nextKind(k2, '新宿');
    T.setBoard(1, ledEnt(rs, 'exp', yuri, dep + 240, 8), ledEnt(rs, k3, yuri, dep + 540, k3 === 'rapid' ? 10 : 8));
  } else {
    const arr = tt[tt.length - 1].arr;
    T.setBoard(0, ledEnt(rs, 'rapid', yuri, arr + 180, 10), ledEnt(rs, 'local', yuri, arr + 480, 8));
    T.setBoard(1, ledEnt(rs, 'exp', yuri, arr + 420, 8), ledEnt(rs, 'rapid', yuri, arr + 720, 10));
  }
}

/* 途中の駅の発車標: この電車(左ホーム)と、反対の向きの各停(右ホーム)。それぞれ「そのつぎ」も。
 * 次の駅・ドア・時間帯が変わったときだけ書き直す(毎フレームの絵の処理はしない) */
export function updateStationLed(rs) {
  const W = rs._stw, sim = rs.sim;
  if (!W || !W.led || !sim || !sim.timetable || !sim.timetable.length || !sim.stops || !sim.stops.length) return;
  const L = W.led;
  if (L.sim === sim && L.idx === sim.stopIdx && L.door === !!sim.doorOpen && L.tod === rs.timeOfDay && L.kind === sim.serviceKey) return;
  L.sim = sim; L.idx = sim.stopIdx; L.door = !!sim.doorOpen; L.tod = rs.timeOfDay; L.kind = sim.serviceKey;
  const tt = sim.timetable;
  /* ドア開放中は いま停まっている駅(stopIdx はもう次の駅を指している) */
  const i = Math.max(0, Math.min(tt.length - 1, sim.doorOpen ? sim.stopIdx - 1 : sim.stopIdx));
  const dep = (tt[i].dep != null ? tt[i].dep : tt[i].arr) || 0;
  const here = sim.stops[i] ? sim.stops[i].name : null;
  const last = sim.stops[sim.stops.length - 1];
  const sts = rs.line.stations;
  const own = sim.serviceKey || 'local';
  const k2 = nextKind(own, here);
  /* 自分の電車はいつも8両(traffic.js)。「そのつぎ」は路線の終点ゆき(かいそくきゅうこうは10両) */
  L.tex.userData.setBoard(2, ledEnt(rs, own, last.name, dep, 8), ledEnt(rs, k2, sts[sts.length - 1].name, dep + 300, k2 === 'rapid' ? 10 : 8));
  const oppDest = sts[0].name;
  const k3 = nextKind('local', here);
  L.tex.userData.setBoard(3, ledEnt(rs, 'local', oppDest, dep + 180, 8), ledEnt(rs, k3, oppDest, dep + 480, k3 === 'rapid' ? 10 : 8));
}

/* ---------- 踏切(道路・白線・とまれ・遮断機の柱・警報機・踏切警標) ----------
 * 動かない部品は線路わきの標識と同じ1つの形(アトラス+頂点色)に焼きこむ(踏切ごとの描画はふえない)。
 * 警報灯は交互に点滅する2組(A: 左の灯 / B: 右の灯。表と裏)で描画2回、遮断機の腕2本で描画2回。
 * 腕は rotation.z が 0 で下りている(しまっている)・1.25 で上がっている */
export const CROSS_LAMP = { on: new THREE.Color(0xff3b30).multiplyScalar(2.2), off: new THREE.Color(0x33110e) };
function crossRes(rs) {
  /* 標識のアトラスは世界ごとに作り直すので、アトラスが同じあいだだけ使い回す */
  const buckUV = lineBoard(rs, 'xbuck').uv, tomareUV = lineBoard(rs, 'tomare').uv;
  if (rs._crossRes && rs._crossRes.atlas === rs._atlas) return rs._crossRes;
  const stripe = canvasTexture(64, 16, (c) => {
    c.fillStyle = '#e8e13a'; c.fillRect(0, 0, 64, 16);
    c.fillStyle = '#16161a';
    for (let x = 0; x < 64; x += 16) c.fillRect(x, 0, 8, 16);
  });
  const armGeo = new THREE.BoxGeometry(5.6, 0.2, 0.2);
  armGeo.translate(2.8, 0, 0);
  const remap = (g, uv) => {
    const a = g.attributes.uv;
    for (let i = 0; i < a.count; i++) a.setXY(i, uv[0] + a.getX(i) * (uv[2] - uv[0]), uv[1] + a.getY(i) * (uv[3] - uv[1]));
    return g;
  };
  rs._crossRes = {
    atlas: rs._atlas,
    armMat: new THREE.MeshStandardMaterial({ map: stripe, roughness: 0.6 }),
    armGeo,
    lampGeo: new THREE.CircleGeometry(0.15, 12),
    slab: new THREE.BoxGeometry(56, 0.08, 5.2),
    pole: new THREE.CylinderGeometry(0.09, 0.11, 3.0, 8, 1, true),
    head: new THREE.BoxGeometry(0.65, 0.5, 0.2),
    buck: remap(new THREE.BoxGeometry(1.5, 0.2, 0.06), buckUV),
    tomareUV,
  };
  return rs._crossRes;
}
export function buildCrossingAt(rs, f, s) {
  const R = crossRes(rs);
  const B = lineBaker(rs);
  const one = new THREE.Vector3(1, 1, 1), m4 = new THREE.Matrix4(), L4 = new THREE.Matrix4(), q = new THREE.Quaternion(), c = new THREE.Vector3();
  const tf = flatT(f, new THREE.Vector3());
  /* 道路(線路を横切る。x=道路の向き=left、z=線路の向き): 舗装・両はしの白線・とまる線・「とまれ」 */
  const o = f.p.clone().addScaledVector(f.left, -1.9);
  o.y += 0.1;
  q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), f.left);
  B.geo(R.slab, { m: m4.compose(o, q, one), col: 0x54585c, white: true });
  const yM = o.y + 0.042;
  const at = (x, z) => c.copy(o).addScaledVector(f.left, x).addScaledVector(tf, z).setY(yM);
  const negT = tf.clone().negate();
  [-2.35, 2.35].forEach((z) => B.quadFlat(at(0, z), f.left, 56, 0.22, null, 0xcfcfc8));
  /* とまる線: 遮断機の1m外(左は線路から9.0m・右は-12.8m)の、線路へ向かってくる車線(左側通行)。
   * 線路の左(+left)から線路へ向かう車の左手は +t、右から向かう車の左手は -t(scene.js _crossCars の lane と同じ) */
  [[1, 10.9, 1.25], [-1, -10.9, -1.25]].forEach(([sd, x, z]) => {
    B.quadFlat(at(x, z), f.left, 0.45, 2.4, null, 0xecece6);
    /* 「とまれ」: 字の上が線路のほう(近づく車から読める)。たてに長い路面の字 */
    B.quadFlat(at(x + sd * 3.0, z), sd > 0 ? negT : tf, 1.7, 3.2, R.tomareUV, 0xffffff);
  });
  /* 遮断機の柱・警報機・踏切警標(左右)と、点滅する灯・腕 */
  const lampA = new Baker(new THREE.MeshBasicMaterial({ color: CROSS_LAMP.off.clone() }));
  const lampB = new Baker(new THREE.MeshBasicMaterial({ color: CROSS_LAMP.off.clone() }));
  lampA.mat.userData.noWeather = lampB.mat.userData.noWeather = true;
  const arms = [];
  const xb = new THREE.Vector3(), zb = new THREE.Vector3(), G = new THREE.Matrix4(), RY = new THREE.Matrix4().makeRotationY(Math.PI);
  [[7.6, 3.4], [-11.2, -3.4]].forEach(([off, roadSide]) => {
    const p = f.p.clone().addScaledVector(f.left, off).addScaledVector(f.t, roadSide);
    /* x = 腕がのびる向き(線路と平行)、z = 警報機の表(線路のほう) */
    xb.copy(tf).multiplyScalar(off > 0 ? 1 : -1);
    zb.crossVectors(xb, UPV);
    G.makeBasis(xb, UPV, zb).setPosition(p);
    B.geo(R.pole, { m: L4.makeTranslation(0, 1.5, 0).premultiply(G), col: 0x565e63, white: true });
    B.geo(R.head, { m: L4.makeTranslation(0, 2.6, 0).premultiply(G), col: 0x2b2f33, white: true });
    [-0.6, 0.6].forEach((rot) => B.geo(R.buck, { m: L4.makeRotationZ(rot).setPosition(0, 3.25, 0).premultiply(G) }));
    [[lampA, -0.2], [lampB, 0.2]].forEach(([LB, x]) => {
      LB.geo(R.lampGeo, { m: L4.makeTranslation(x, 2.6, 0.105).premultiply(G) });
      LB.geo(R.lampGeo, { m: L4.makeTranslation(-x, 2.6, -0.105).multiply(RY).premultiply(G) });
    });
    /* 腕(根元を軸に回る。動かない柱の組とは別の小さな組) */
    const g = new THREE.Group();
    g.position.copy(p);
    g.quaternion.setFromRotationMatrix(L4.makeBasis(xb, UPV, zb));
    const arm = new THREE.Mesh(R.armGeo, R.armMat);
    arm.position.y = 1.05;
    arm.rotation.z = 1.25;
    arm.userData.dyn = true;   // 毎フレーム動く(行列の更新を止めない)
    arms.push(arm);
    g.add(arm);
    rs.world.add(g);
  });
  const la = lampA.build(rs, { recv: false }), lb = lampB.build(rs, { recv: false });
  return { arms, lamps: [la, lb] };
}

/* ---------- 線路わきの標識(制限・解除・予告・キロ程) ---------- */
export function buildBoards(rs) {
  buildBoardsAt(rs, PLAT, (s) => inPlatform(rs, s), STOP8_AHEAD);
}

/* ---------- 信号機(種別が変わるたびに作り直す) ---------- */
export function buildSignals(rs) {
  const T = rs.terminal;
  /* 信号の上にある天井の高さ(レール面から): トンネル・地下駅は天井の光る帯 6.1 /
   * ホームの屋根は鼻隠しの下端 3.98 / なにもなければ Infinity。灯器がこの下に収まるようにする */
  const cover = (s) => {
    if (rs._inTunnel(s)) return 6.1;
    return rs.line.stations.some((st, si) => !(T && st.name === '新宿') && !rs._inTunnel(st.s)
      && s > snapS(rs, st.s - roofLen(rs, si)) - 1 && s < snapS(rs, st.s + ROOF_B) + 1) ? 3.98 : Infinity;
  };
  /* 反対の線路(上り)の信号機の裏: 坑口の近く・トンネル・ターミナルには立てない */
  const nearPortal = (s) => rs.line.sections.tunnel.some((t) => Math.abs(s - t.from) < 15 || Math.abs(s - t.to) < 15);
  const backOk = (s) => !rs._inTerminal(s, 10) && !nearPortal(s) && !rs._inTunnel(s);
  buildSignalsAt(rs, (s) => inPlatform(rs, s), cover, backOk);
  updateLedBoards(rs);
}

/* ---------- 停止位置の光の目印 ---------- */
export function buildStopBeam(rs) {
  const cv = document.createElement('canvas');
  cv.width = 32; cv.height = 128;
  const c = cv.getContext('2d');
  const g = c.createLinearGradient(0, 0, 0, 128);
  g.addColorStop(0, 'rgba(120,220,255,0)');
  g.addColorStop(0.75, 'rgba(120,220,255,0.55)');
  g.addColorStop(1, 'rgba(170,240,255,0.95)');
  c.fillStyle = g; c.fillRect(0, 0, 32, 128);
  const tex = new THREE.CanvasTexture(cv);
  rs._beamMat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, opacity: 0.5,
    blending: THREE.AdditiveBlending, depthWrite: false, side: DS, forceSinglePass: true,
  });
  rs._beamMat.userData.noWeather = true;
  /* 十字に組んだ2枚を1つの形に(描画1回) */
  const a = new THREE.PlaneGeometry(1.05, 9), b = new THREE.PlaneGeometry(1.05, 9).rotateY(Math.PI / 2);
  const geo = new THREE.BufferGeometry();
  ['position', 'normal', 'uv'].forEach((k) => {
    const A = a.attributes[k].array, Bv = b.attributes[k].array;
    const arr = new Float32Array(A.length + Bv.length); arr.set(A); arr.set(Bv, A.length);
    geo.setAttribute(k, new THREE.BufferAttribute(arr, a.attributes[k].itemSize));
  });
  const na = a.attributes.position.count;
  geo.setIndex(Array.from(a.index.array).concat(Array.from(b.index.array).map((x) => x + na)));
  rs.stopBeam = new THREE.Group();
  rs.stopBeam.add(new THREE.Mesh(geo, rs._beamMat));
  rs.stopBeam.visible = false;
  rs.stopBeam.userData.dyn = true;     // 毎フレーム「8」の柱の位置へ動かす(行列の更新を止めない)
  rs.world.add(rs.stopBeam);
}

/* ---------- ホームの備品(ベンチ・自販機・ごみ箱)。駅の形に焼きこむ ----------
 * 門型ビームの柱・駅名標の足・階段・駅舎への出入り口・予告の標識をよけて、線路方向へずらして置く */
export function buildFurniture(rs) {
  const T = rs.terminal;
  const W = rs._stw;
  const vendCols = [0xc23b2e, 0x2e5fc2, 0xe8e6e0];
  const binCols = [0x5c6670, 0x2f6d9e, 0x3c8a55];
  const f = newFrame();
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
  /* 3人がけベンチ(座面・背もたれ・脚) */
  if (!rs._benchParts) {
    const parts = [];
    for (let k = -1; k <= 1; k++) {
      parts.push([new THREE.BoxGeometry(0.46, 0.05, 0.42).translate(k * 0.5, 0.44, 0.02), 0x3f6d8a]);
      parts.push([new THREE.BoxGeometry(0.46, 0.36, 0.04).rotateX(-0.12).translate(k * 0.5, 0.68, -0.2), 0x3f6d8a]);
    }
    [-0.72, 0.72].forEach((x) => {
      parts.push([new THREE.BoxGeometry(0.05, 0.42, 0.05).translate(x, 0.21, 0.12), 0x6f777d]);
      parts.push([new THREE.BoxGeometry(0.05, 0.62, 0.05).translate(x, 0.31, -0.2), 0x6f777d]);
    });
    parts.push([new THREE.BoxGeometry(1.5, 0.05, 0.06).translate(0, 0.4, -0.04), 0x6f777d]);
    rs._benchParts = parts;
    rs._vendGeo = new THREE.BoxGeometry(0.85, 1.7, 0.68);
    rs._vendFront = new THREE.BoxGeometry(0.6, 1.1, 0.05);
    rs._binGeo = new THREE.BoxGeometry(0.38, 0.9, 0.38);
  }
  rs._vendFrontMat = new THREE.MeshStandardMaterial({ color: 0xdfe6ea, roughness: 0.35, metalness: 0.2 });
  const VF = bakerFor(rs, rs._vendFrontMat, rs._vendFrontMat);
  const gS = (rs._catSupports || []).filter((sp) => sp.type === 'gantry').map((sp) => sp.s);
  const sty = stationStyles(rs);
  rs.line.stations.forEach((st, si) => {
    if (T && st.name === '新宿') return;    // ターミナルは島式ホーム(ベンチは置かない)
    const B = stationBaker(rs, si);
    if (!B) return;
    const ob = (W && W.obst[si]) || [];
    const house = sty[si].kind === 'house' && !rs._inTunnel(st.s);
    const appr = [STOP8_AHEAD - 50, STOP8_AHEAD - 100].map((d) => st.s + d);
    /* [横の位置, 置いたもの(線路方向の中心・半分の長さ)] */
    [[1, 4.45], [-1, -8.4]].forEach(([dir, off]) => {
      const placed = [];
      const hit = (s, half) => {
        if (s < st.s - P_A + 3 + half || s > st.s + 8) return true;
        for (let k = 0; k < gS.length; k++) if (Math.abs(s - gS[k]) < half + 0.35) return true;
        for (let k = 0; k < appr.length; k++) if (Math.abs(s - appr[k]) < half + 0.5) return true;
        if (dir < 0 && house && s > st.s - 66 - half && s < st.s - 44 + half) return true;   // 駅舎への出入り口
        for (let k = 0; k < placed.length; k++) if (Math.abs(s - placed[k][0]) < half + placed[k][1] + 0.3) return true;
        for (let k = 0; k < ob.length; k++) {
          const o = ob[k];
          if (o.s0 != null) {
            if ((o.lat == null || Math.abs(o.lat - off) < o.r + 0.5) && s > o.s0 - half && s < o.s1 + half) return true;
          } else if (Math.abs(o.lat - off) < o.r + 0.5 && Math.abs(s - o.s) < o.r + half) return true;
        }
        return false;
      };
      /* 近くの空いているところ(なければ置かない) */
      const spot = (s0, half) => {
        for (let k = 0; k <= 40; k++) {
          const s = s0 + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.5;
          if (!hit(s, half)) { placed.push([s, half]); ob.push({ s, lat: off, r: half + 0.15 }); return s; }
        }
        return null;
      };
      const face = () => q.setFromAxisAngle(UPV, Math.atan2(-dir * f.left.x, -dir * f.left.z));   // 線路のほうを向く
      /* 自販機(本体は駅の形に、光る前面は全線まとめて) */
      const sv = spot(st.s - 68, 0.43);
      if (sv !== null) {
        frameInto(rs, sv, f); face();
        m4.compose(p.copy(f.p).addScaledVector(f.left, off).setY(f.p.y + 1.05 + 0.85), q, one);
        B.geo(rs._vendGeo, { m: m4, col: vendCols[(si + (dir > 0 ? 0 : 1)) % vendCols.length], white: true });
        m4.compose(p.copy(f.p).addScaledVector(f.left, off - dir * 0.36).setY(f.p.y + 1.05 + 0.93), q, one);
        VF.geo(rs._vendFront, { m: m4 });
      }
      /* ごみ箱3つ(もえる・びん缶・ペットボトルの色) */
      const sb = spot(st.s - 62, 0.65);
      if (sb !== null) {
        [-0.42, 0, 0.42].forEach((d, k) => {
          frameInto(rs, sb + d, f); face();
          m4.compose(p.copy(f.p).addScaledVector(f.left, off + dir * 0.05).setY(f.p.y + 1.05 + 0.45), q, one);
          B.geo(rs._binGeo, { m: m4, col: binCols[k], white: true });
        });
      }
      /* ベンチ4つ */
      [-30, -54, -86, -118].forEach((ds) => {
        const s = spot(st.s + ds, 0.78);
        if (s === null) return;
        frameInto(rs, s, f); face();
        m4.compose(p.copy(f.p).addScaledVector(f.left, off).setY(f.p.y + 1.05), q, one);
        rs._benchParts.forEach(([g, col]) => B.geo(g, { m: m4, col, white: true }));
      });
    });
  });
}

/* ---------- 人の形(肩の丸い胴・腰・脚・腕と手・首・頭・髪) ----------
 * 1人約330三角形。服(stCloth=1)はインスタンス色、ズボン・スカート(stPants=1)は5色の中から人ごと、
 * 着こなし(stVar: 1=コート / 2=スカート / 3=長い髪)はインスタンス番号で5通り。
 * かばん(stBag)は3人に1人ずつ。使わない部品は頂点をつぶして描かない(シェーダは1つ 'st-crowd')。
 * 画質「低」は前の軽い形(1人約170三角形) */
const SKIN = 0xd8b49a;
const HAIR = 0x1d1915;
/* ズボン・スカートの色(紺・チャコール・ベージュ・デニム・黒)。シェーダに書くのでリニアの値に */
const PANTS = [0x2b3550, 0x3a3c40, 0xb5a585, 0x4a6a8e, 0x1c1d20].map((h) => new THREE.Color(h));
const v3 = (c) => `vec3( ${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)} )`;
/* 動く人の数 */
const FIG_N = 12;
/* 同じ頂点属性の形(mergeColored の出力)をつなぎ、部品番号 stPart(first から)をつける */
function concatParts(list, first) {
  const names = Object.keys(list[0].attributes);
  const N = list.reduce((a, g) => a + g.attributes.position.count, 0);
  const out = new THREE.BufferGeometry();
  names.forEach((nm) => {
    const it = list[0].attributes[nm].itemSize, arr = new Float32Array(N * it);
    let o = 0;
    list.forEach((g) => { arr.set(g.attributes[nm].array, o); o += g.attributes[nm].array.length; });
    out.setAttribute(nm, new THREE.BufferAttribute(arr, it));
  });
  const part = new Float32Array(N);
  let o = 0;
  list.forEach((g, k) => { const n = g.attributes.position.count; part.fill(k + first, o, o + n); o += n; });
  out.setAttribute('stPart', new THREE.BufferAttribute(part, 1));
  return out;
}
function crowdRes(rs) {
  const low = rs.quality === 'low';
  if (rs._crowdRes && rs._crowdRes.v6 && rs._crowdRes.low === low) return rs._crowdRes;
  const EXN = ['stCloth', 'stBag', 'stVar', 'stPants', 'stPart'];
  const CL = { stCloth: 1 }, PA = { stPants: 1 };
  let crowd, fig, hip, sh;
  if (low) {
    /* 軽い形(前の形) */
    const torso = () => new THREE.CylinderGeometry(0.19, 0.16, 0.6, 6).scale(1, 1, 0.62).translate(0, 1.12, 0);
    const arm = (sx) => new THREE.CylinderGeometry(0.045, 0.04, 0.56, 4, 1, true).translate(0, -0.28, 0).rotateZ(sx * 0.08).translate(sx * 0.23, 1.38, 0);
    const leg = (sx) => new THREE.CylinderGeometry(0.06, 0.055, 0.78, 4, 1, true).translate(sx * 0.08, 0.43, 0);
    const shoe = (sx) => new THREE.BoxGeometry(0.1, 0.06, 0.24).translate(sx * 0.08, 0.03, 0.04);
    const head = () => [
      [new THREE.CylinderGeometry(0.05, 0.055, 0.1, 4, 1, true).translate(0, 1.46, 0), SKIN],
      [new THREE.SphereGeometry(0.115, 6, 4).translate(0, 1.6, 0), SKIN],
    ];
    const hair = () => new THREE.SphereGeometry(0.118, 6, 2, 0, Math.PI * 2, 0, Math.PI * 0.6).scale(1.05, 1.0, 1.08).translate(0, 1.618, -0.018);
    crowd = mergeColored([
      [torso(), 0xffffff, CL], [arm(1), 0xffffff, CL], [arm(-1), 0xffffff, CL],
      [leg(1), 0x2c3138, PA], [leg(-1), 0x2c3138, PA], [shoe(1), 0x1c1d20], [shoe(-1), 0x1c1d20],
      ...head(), [hair(), HAIR],
      [new THREE.BoxGeometry(0.28, 0.36, 0.14).translate(0, 1.15, -0.19), 0x23272d, { stBag: 1 }],
      [new THREE.BoxGeometry(0.08, 0.26, 0.3).translate(0.27, 0.92, 0), 0x6b4a32, { stBag: 2 }],
    ], EXN);
    fig = {
      body: mergeColored([[torso(), 0xffffff, CL], ...head(), [hair(), HAIR]], EXN),
      leg: mergeColored([
        [new THREE.CylinderGeometry(0.06, 0.055, 0.78, 6, 1, true).translate(0, -0.39, 0), 0xffffff, CL],
        [new THREE.BoxGeometry(0.1, 0.06, 0.24).translate(0, -0.79, 0.04), 0x2e2f33],
      ], EXN),
      arm: mergeColored([[new THREE.CylinderGeometry(0.045, 0.04, 0.56, 5, 1, true).translate(0, -0.28, 0), 0xffffff, CL]], EXN),
    };
    hip = [0.08, 0.82]; sh = [0.23, 1.38];
  } else {
    /* 胴: 肩の丸い回転体(8角)を前後にうすく。腰・脚・腕・手・首・頭(少したて長)・髪 */
    const torso = () => new THREE.LatheGeometry([[0.13, 0.86], [0.165, 0.95], [0.15, 1.12], [0.19, 1.36], [0.17, 1.44], [0.07, 1.47]]
      .map(([x, y]) => new THREE.Vector2(x, y)), 8).scale(1, 1, 0.62);
    const pelvis = () => new THREE.CylinderGeometry(0.135, 0.14, 0.16, 8, 1, true).scale(1, 1, 0.68).translate(0, 0.86, 0);
    const legG = () => new THREE.CylinderGeometry(0.072, 0.055, 0.84, 6, 1, true);
    const shoeG = () => new THREE.BoxGeometry(0.1, 0.07, 0.25);
    const armG = () => new THREE.CylinderGeometry(0.05, 0.042, 0.58, 6, 1, true).translate(0, -0.29, 0);
    const handG = () => new THREE.OctahedronGeometry(0.046).scale(0.8, 1.25, 0.9).translate(0, -0.62, 0);
    const neck = () => new THREE.CylinderGeometry(0.05, 0.056, 0.1, 6, 1, true).translate(0, 1.5, 0);
    const head = () => new THREE.SphereGeometry(0.112, 8, 6).scale(0.92, 1.08, 1).translate(0, 1.63, 0);
    const hair = () => new THREE.SphereGeometry(0.117, 8, 2, 0, Math.PI * 2, 0, Math.PI * 0.55).scale(0.96, 1.08, 1.05).translate(0, 1.645, -0.012);
    /* 着こなしの部品: コート(腰から下へ広がる)・スカート・長い髪(頭のうしろ半分) */
    const coat = () => new THREE.CylinderGeometry(0.17, 0.2, 0.62, 8, 1, true).scale(1, 1, 0.72).translate(0, 0.93, 0);
    const skirt = () => new THREE.CylinderGeometry(0.12, 0.2, 0.36, 8, 1, true).scale(1, 1, 0.78).translate(0, 0.8, 0);
    const longHair = () => new THREE.CylinderGeometry(0.118, 0.14, 0.32, 6, 1, true, Math.PI * 0.5, Math.PI).translate(0, 1.5, -0.01);
    const armAt = (sx, g) => g.rotateZ(sx * 0.1).translate(sx * 0.215, 1.4, 0);
    crowd = mergeColored([
      [torso(), 0xffffff, CL], [pelvis(), 0xffffff, PA],
      [armAt(1, armG()), 0xffffff, CL], [armAt(-1, armG()), 0xffffff, CL],
      [armAt(1, handG()), SKIN], [armAt(-1, handG()), SKIN],
      [legG().translate(0.085, 0.48, 0), 0xffffff, PA], [legG().translate(-0.085, 0.48, 0), 0xffffff, PA],
      [shoeG().translate(0.085, 0.035, 0.04), 0x1c1d20], [shoeG().translate(-0.085, 0.035, 0.04), 0x1c1d20],
      [neck(), SKIN], [head(), SKIN], [hair(), HAIR],
      [coat(), 0xb4b4b4, { stCloth: 1, stVar: 1 }],
      [skirt(), 0xffffff, { stPants: 1, stVar: 2 }],
      [longHair(), HAIR, { stVar: 3 }],
      [new THREE.BoxGeometry(0.28, 0.36, 0.14).translate(0, 1.18, -0.2), 0x23272d, { stBag: 1 }],
      [new THREE.BoxGeometry(0.08, 0.26, 0.3).translate(0.27, 0.95, 0), 0x6b4a32, { stBag: 2 }],
    ], EXN);
    /* 動く人: 同じ部品を、肩・股関節がまわる中心で分ける(胴と頭は同じ動きなので1つの形) */
    fig = {
      body: mergeColored([[torso(), 0xffffff, CL], [pelvis(), 0x343a42], [coat(), 0xb4b4b4, { stCloth: 1, stVar: 1 }], [skirt(), 0x3a3c40, { stVar: 2 }],
        [neck(), SKIN], [head(), SKIN], [hair(), HAIR], [longHair(), HAIR, { stVar: 3 }]], EXN),
      leg: mergeColored([[legG().translate(0, -0.42, 0), 0xffffff, CL], [shoeG().translate(0, -0.865, 0.04), 0x2e2f33]], EXN),
      arm: mergeColored([[armG(), 0xffffff, CL], [handG(), SKIN]], EXN),
    };
    hip = [0.085, 0.9]; sh = [0.215, 1.4];
  }
  /* 動く人の脚と腕は1つの形にまとめ(stPart 2/3)、インスタンス番号の範囲で部品を選ぶ:
   * 0〜2NF-1 = 脚 / 2NF〜4NF-1 = 腕(描画1回)。胴と頭は別の1回 */
  fig.limbs = concatParts([fig.leg, fig.arm], 2);
  /* 頂点の処理: 服の部分だけインスタンス色、ズボン・スカートは5色、かばんは3種、着こなしは5通り */
  const vsPars = '#include <common>\nattribute float stCloth;\nattribute float stBag;\nattribute float stVar;\nattribute float stPants;\nattribute float stPart;';
  const vsBag = `#include <begin_vertex>
#ifdef USE_INSTANCING
  #if __VERSION__ >= 300
    if ( stPart > 0.5 ) {
      float stId = float( gl_InstanceID );
      float stWant = stId < ${(FIG_N * 2 - 0.5).toFixed(1)} ? 2.0 : 3.0;
      if ( abs( stPart - stWant ) > 0.5 ) transformed = vec3( 0.0 );
    }
    if ( stBag > 0.5 && abs( stBag - mod( float( gl_InstanceID ), 3.0 ) ) > 0.5 ) transformed = vec3( 0.0 );
    if ( stVar > 0.5 ) {
      float stV = floor( mod( float( gl_InstanceID ) * 7.0, 5.0 ) + 0.5 );
      bool stShow = stVar < 1.5 ? abs( stV - 1.0 ) < 0.5 : stVar < 2.5 ? ( stV > 1.5 && stV < 3.5 ) : stV > 2.5;
      if ( !stShow ) transformed = vec3( 0.0 );
    }
  #else
    if ( stBag > 0.5 || stVar > 0.5 || stPart > 0.5 ) transformed = vec3( 0.0 );
  #endif
#endif`;
  const vsCol = `#include <color_vertex>
#if defined( USE_INSTANCING_COLOR ) && defined( USE_COLOR )
  vColor.xyz = mix( color.xyz, vColor.xyz, stCloth );
  #if __VERSION__ >= 300
  {
    float stI = float( gl_InstanceID );
    float stP = floor( mod( stI * 3.0 + floor( stI / 5.0 ), 5.0 ) + 0.5 );
    vec3 stPc = stP < 0.5 ? ${v3(PANTS[0])} : stP < 1.5 ? ${v3(PANTS[1])} : stP < 2.5 ? ${v3(PANTS[2])} : stP < 3.5 ? ${v3(PANTS[3])} : ${v3(PANTS[4])};
    vColor.xyz = mix( vColor.xyz, stPc, stPants );
  }
  #endif
#endif`;
  const matCrowd = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.88 });
  /* uStLit: ホームの灯りに照らされた明るさ(夜・夕方)。自分の色(服・はだ)のまま明るくする */
  const uLit = { value: 0 };
  matCrowd.onBeforeCompile = (shd) => {
    shd.uniforms.uStLit = uLit;
    shd.vertexShader = shd.vertexShader.replace('#include <common>', vsPars).replace('#include <begin_vertex>', vsBag)
      .replace('#include <color_vertex>', vsCol);
    shd.fragmentShader = shd.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uStLit;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * uStLit;');
  };
  matCrowd.customProgramCacheKey = () => 'st-crowd';
  matCrowd.name = 'st-crowd';
  matCrowd.userData.noWeather = true;     // 屋根の下で待つ人の頭・肩に雪が積もらないように
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.onBeforeCompile = (shd) => {
    shd.vertexShader = shd.vertexShader.replace('#include <common>', vsPars).replace('#include <begin_vertex>', vsBag);
  };
  depth.customProgramCacheKey = () => 'st-crowd-d';
  /* 動く人も待つ人と同じ材質(同じプログラム): 服の部分(stCloth=1)だけインスタンス色 */
  const matFig = matCrowd;
  /* 遠くの駅の人(箱3つ・36三角形)。頂点属性は同じなので matCrowd のプログラムをそのまま使う */
  const crowdLite = mergeColored([
    [new THREE.BoxGeometry(0.36, 0.62, 0.24).translate(0, 1.12, 0), 0xffffff, { stCloth: 1 }],
    [new THREE.BoxGeometry(0.26, 0.82, 0.18).translate(0, 0.41, 0), 0x2c3138, { stPants: 1 }],
    [new THREE.BoxGeometry(0.2, 0.26, 0.21).translate(0, 1.58, 0), 0x6b5444],
  ], EXN);
  /* 足もとの影: 黒い だ円のぼかし(光だまりと同じ材質の作り・合成はふつう。プログラムは光だまりと同じ 'pool')。
   * 光だまりの絵(まん中だけ濃い)では くつにかくれて見えないので、ふちまで なだらかに濃い絵を使う */
  const shTex = canvasTexture(64, 64, (c) => {
    const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.8)');
    g.addColorStop(0.8, 'rgba(255,255,255,0.28)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g; c.fillRect(0, 0, 64, 64);
  });
  const shMat = makePoolMaterial(shTex, { color: 0x000000, opacity: 0.38 });
  shMat.blending = THREE.NormalBlending;
  shMat.name = 'st-footshadow';
  const shGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const R = rs._crowdRes = { v6: true, low, crowd, crowdLite, matCrowd, depth, fig, matFig, uLit, hip, sh, shMat, shGeo };
  rs._keep.add(matCrowd); rs._keep.add(depth); rs._keep.add(shMat); rs._keep.add(shGeo);
  return R;
}

/* ---------- ホームで待つ人たち(静止)。駅ごとに InstancedMesh 1つ ----------
 * あわせて、屋根から下がる駅名と、看板・駅の形のまとめ描きを世界に出す(このパッケージの最後の建設) */
export function buildCrowds(rs) {
  const R = crowdRes(rs);
  let seed = 2024;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const cloth = [0x3e5a78, 0x7a4a42, 0x4a6b4e, 0x6b5a7c, 0x8a6d3b, 0x455a64, 0xa05a6e, 0x37657a, 0x94502e, 0xd8d4c8, 0x2b2f36, 0x714a71, 0xc9a24a, 0x5d7f9a];
  const f = newFrame();
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), col = new THREE.Color(), p = new THREE.Vector3();
  const W = rs._stw;
  const T = rs.terminal;
  const sty = stationStyles(rs);
  const tn = new THREE.Vector3(), dc = new THREE.Vector3(), mk = new THREE.Matrix4();
  rs._crowdMeshes = [];
  /* ドアの印の ▲▲(上から見た三角形2つ。+z が線路のほう) */
  const arrow = new THREE.BufferGeometry();
  arrow.setAttribute('position', new THREE.Float32BufferAttribute([
    -0.24, 0, -0.16, -0.06, 0, -0.16, -0.15, 0, 0.17, 0.06, 0, -0.16, 0.24, 0, -0.16, 0.15, 0, 0.17,
  ], 3));
  arrow.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  rs.line.stations.forEach((st, si) => {
    const isTerm = !!T && st.name === '新宿';
    const ob = (W && W.obst[si]) || [];
    const SBk = stationBaker(rs, si);
    const stairs = sty[si].kind !== 'house' && !isTerm && !rs._inTunnel(st.s);
    /* ホームのはし(ターミナルは島式ホームの範囲) */
    const sMin = isTerm ? st.s - (T.up ? 150 : 163) : st.s - (stairs ? STAIR.foot - 2.5 : P_A - 5);
    const sMax = isTerm ? st.s + (T.up ? 24 : 12) : st.s + P_B - 3;
    /* 急行の止まる駅(乗りかえの多い大きな駅)は人が多い */
    const expStop = !isTerm && SERVICES.exp && SERVICES.exp.stops && SERVICES.exp.stops.indexOf(st.name) >= 0;
    const busy = isTerm ? 0.55 : expStop ? 0.7 : 0.45;
    const free = (s, lat, r) => {
      if (s < sMin || s > sMax) return false;
      for (let k = 0; k < ob.length; k++) {
        const o = ob[k];
        if (o.s0 != null) {
          if (s > o.s0 - r && s < o.s1 + r && (o.lat == null || Math.abs(lat - o.lat) < o.r + r)) return false;
        } else if (Math.hypot(s - o.s, lat - o.lat) < o.r + r) return false;
      }
      return true;
    };
    const items = [];
    const put = (s, lat, side, yawJ) => {
      frameInto(rs, Math.max(2, s), f);
      const yaw = Math.atan2(-side * f.left.x, -side * f.left.z) + yawJ;
      /* 10人に1人は子ども(背の高さ0.62〜0.72倍) */
      const sc = rnd() < 0.1 ? 0.62 + rnd() * 0.1 : 0.88 + rnd() * 0.2;
      items.push({ s, p: f.p.clone().addScaledVector(f.left, lat).setY(f.p.y + 1.05), yaw, sc, col: cloth[Math.floor(rnd() * cloth.length)] });
      ob.push({ s, lat, r: 0.22 });
    };
    [1, -1].forEach((side) => {
      const P = sideOf(side);
      /* ドアの位置の足もとの印(▲▲)と、ドアの前に2列で並ぶ人。
       * 左(この電車)は停止位置 st.s から後ろへ。右は反対向きの電車(ホームの奥 st.s-150 に先頭が止まる)の
       * ドアなので、奥から手前へならぶ(止まった運転台の右の窓からも見える) */
      const upSide = side < 0 && !isTerm;
      for (let cI = 0; cI < 8; cI++) {
        DOOR_OFF.forEach((off) => {
          const ds = upSide ? st.s - P_A + 5 + 20 * cI + off : st.s - 20 * cI - off;
          if (ds < st.s - P_A + 2 || ds > st.s + P_B - 2) return;
          /* 足もとの印: へりから1.45m(点字ブロックのすぐうしろ)。うすい板+水色の ▲▲(駅の形に焼きこむ) */
          frameInto(rs, ds, f);
          flatT(f, tn).multiplyScalar(-side);
          dc.copy(f.p).addScaledVector(f.left, P.edge + 1.45 * side);
          dc.y = f.p.y + 1.05 + 0.006;
          if (SBk) {
            SBk.quadFlat(dc, tn, 0.55, 0.45, null, 0xdfe6ea);
            dc.y += 0.002;
            /* ▲ の先を線路のほうへ: 箱の z = 線路のほう(左ホームは -left、右ホームは +left) */
            mk.makeBasis(tn, UPV, dc.clone().set(f.left.x * -side, 0, f.left.z * -side)).setPosition(dc);
            SBk.geo(arrow, { m: mk, col: 0x3d8fd6, white: true });
          }
          /* 運転台の窓の横(停止位置の前後)・乗る人(動く)が使うドアには並べない */
          if (side > 0 && ds > st.s - 16 && ds < st.s + 14) return;
          if (side > 0 && BOARD_DOORS.some((b) => Math.abs(st.s - b - ds) < 0.5)) return;
          if (rnd() > busy) return;
          const r = rnd();
          const nP = r < 0.55 ? 1 : r < 0.85 ? 2 : r < 0.95 ? 3 : 4;      // 平均 約1.6人
          const rows = [2.9, 3.45];
          for (let k = 0; k < nP; k++) {
            const u = rows[k >> 1] + (rnd() - 0.5) * 0.08;
            const lat = side > 0 ? u : -3.8 - u;
            const s = ds + (k & 1 ? 0.33 : -0.33) + (rnd() - 0.5) * 0.1;
            if (free(s, lat, 0.2)) put(s, lat, side, (rnd() - 0.5) * 0.5);
          }
        });
      }
      /* 乗る人(動く4人)が待つ場所をあけておく */
      if (side > 0) {
        BOARD_DOORS.forEach((b) => ob.push({ s: st.s - b - 0.33, lat: 2.9, r: 0.25 }));
        ALIGHT_S.forEach((a) => ob.push({ s0: st.s + a - 0.5, s1: st.s + a + 0.5, lat: 2.9, r: 1.5 }));
      }
      /* 列にならばない人(ばらばらの向き)。左はホームのうしろ寄り、右は列のあいだ
       * (右のうしろ寄り -7.8m は停車中に歩く人の通り道) */
      const nFree = (isTerm ? 15 : expStop ? 6 : 0) + 6 + Math.floor(rnd() * 5);
      for (let i = 0, tries = 0; i < nFree && tries < 80; tries++) {
        const s = sMin + rnd() * (sMax - sMin);
        if (side > 0 && s > st.s - 16 && s < st.s + 14) continue;
        if (isTerm && s > st.s - 3 && s < st.s + 9) continue;     // 発車を待つ運転台の目の前はあける
        const lat = side > 0 ? 3.7 + rnd() * 0.9 : -6.75 - rnd() * 0.5;
        if (!free(s, lat, 0.3)) continue;
        put(s, lat, side, (rnd() - 0.5) * 2.2);
        i++;
      }
      /* ホームの先のほう(止まった運転台の前に見えるところ)にも数人。
       * 左は窓のすぐ横ではなく 7.5m 以上先の うしろ寄り(「8」の柱から横に1.2m以上はなれる。視界をふさがない) */
      /* 新宿(島式ホーム)は人が多い: 発車を待つ運転台の前の島にも。ただし運転台の目の前(9m以内)と
       * 窓に近いへり寄りにはいない(左の島は 3.2m より奥、右の島は -6.9m より奥) */
      const nFront = isTerm ? 6 + Math.floor(rnd() * 3) : 3 + Math.floor(rnd() * 2);
      const frontLen = isTerm ? sMax - st.s - 4 : 9.5;
      for (let i = 0, tries = 0; i < nFront && tries < 60; tries++) {
        const s = side > 0 && !isTerm ? st.s + 7.5 + rnd() * 6 : isTerm ? st.s + 9 + rnd() * (frontLen - 5) : st.s + 4 + rnd() * frontLen;
        const lat = isTerm ? (side > 0 ? 3.2 + rnd() * 1.1 : -6.9 - rnd() * 1.1) : side > 0 ? 3.95 + rnd() * 0.65 : -6.6 - rnd() * 0.7;
        if (!free(s, lat, 0.3)) continue;
        put(s, lat, side, (rnd() - 0.5) * 2.6);
        i++;
      }
    });
    if (!items.length) return;
    /* 前(s が大きい)から順に並べる: 前を向いたカメラのうしろの人は count を減らして描かない */
    items.sort((x, y) => y.s - x.s);
    const im = new THREE.InstancedMesh(R.crowd, R.matCrowd, items.length);
    items.forEach((it, i) => {
      q.setFromAxisAngle(UPV, it.yaw); sc.setScalar(it.sc);
      im.setMatrixAt(i, m4.compose(it.p, q, sc));
      col.setHex(it.col); im.setColorAt(i, col);
    });
    /* 待つ人は日の影を落とさない: ほとんどが屋根の下(屋根の影の中)・ターミナル・地下で、影は見えない。
     * 影の描画(人の数×三角形)をはぶく。動く12人だけは影を落とす */
    const noSh = true;
    im.castShadow = !noSh;
    im.customDepthMaterial = R.depth;
    im.userData.noSplit = true; im.userData.st = true;
    im.computeBoundingSphere();
    rs.world.add(im);
    /* 足もとの影(ぼかした黒い だ円。床に立って見える)。待つ人と同じ順番・同じ数だけ描く。
     * 光だまりと同じプログラム('pool')で、合成だけ ふつう(加算でない)。歩く人には つけない */
    const shIm = new THREE.InstancedMesh(R.shGeo, R.shMat, items.length);
    items.forEach((it, i) => {
      sc.set(0.75 * it.sc, 1, 0.55 * it.sc);      // 肩のはばの向きに長い だ円
      p.copy(it.p); p.y += 0.012;
      shIm.setMatrixAt(i, m4.compose(p, q.setFromAxisAngle(UPV, it.yaw), sc));
    });
    shIm.renderOrder = 2;
    shIm.userData.noSplit = true; shIm.userData.st = true;
    shIm.computeBoundingSphere();
    rs.world.add(shIm);
    /* 遠近の切りかえ(updatePeople): カメラから160m以内の駅だけ細かい形+影 */
    rs._crowdMeshes.push({ im, sh: shIm, a: st.s - P_A - 10, b: st.s + P_B + 10, lite: false, noSh, n: items.length, sArr: Float32Array.from(items.map((it) => it.s)) });
  });

  /* 屋根から下がる駅名(表も裏も読める。なまえの部分だけ) */
  const n = new THREE.Vector3(), c = new THREE.Vector3(), tf = new THREE.Vector3();
  const rail = new THREE.BoxGeometry(1.94, 0.03, 0.05);
  /* くだりの終点は、手前のつり下げの駅名のかわりに 青地に白の「しゅうてん しんゆりがおか」(2.6x0.5m)。
   * 絵は発車標と同じ画像の中(W.goal.uv)・同じ材質で、描画はふえない */
  const LBg = W.goal ? bakerFor(rs, 'led', W.led.mat) : null;
  rs.line.stations.forEach((st, si) => {
    if (T && st.name === '新宿') return;
    const SB = bakerFor(rs, W.signMats[si], W.signMats[si]);
    const B = stationBaker(rs, si);
    const under = rs._inTunnel(st.s);
    /* 屋根の下だけにつるす(屋根の短い駅は奥の1枚を手前に) */
    const far = under ? -112 : -Math.min(112, roofLen(rs, si) - 13);
    [1, -1].forEach((sg) => {
      [-28, far].forEach((ds) => {
        const goal = !!LBg && W.goal.si === si && ds === -28 && !under;
        const bw = goal ? 2.6 : 1.9;
        frameInto(rs, st.s + ds, f);
        flatT(f, n).negate();
        c.copy(f.p).addScaledVector(f.left, mid(sideOf(sg)));
        const hh = goal ? 0.5 : (1.9 * 138) / 512;
        c.y = f.p.y + 3.85 - hh / 2;
        const nb = n.clone().negate();
        if (goal) {
          LBg.quad(c.clone().addScaledVector(n, 0.01), n, bw, hh, W.goal.uv);
          LBg.quad(c.clone().addScaledVector(nb, 0.01), nb, bw, hh, W.goal.uv);
        } else {
          SB.quad(c.clone().addScaledVector(n, 0.01), n, bw, hh, SIGN_UV.name);
          SB.quad(c.clone().addScaledVector(nb, 0.01), nb, bw, hh, SIGN_UV.name);
        }
        if (!B) return;
        tf.crossVectors(UPV, n);
        const top = f.p.y + (under ? 6.2 : 4.4);
        const px = goal ? 1.0 : 0.7;
        [-px, px].forEach((k) => B.post(c.x + tf.x * k, f.p.y + 3.85, c.z + tf.z * k, top - (f.p.y + 3.85), 0x6f777d));
        /* 板の上下の縁 */
        q.setFromAxisAngle(UPV, Math.atan2(n.x, n.z));
        [hh / 2 + 0.015, -hh / 2 - 0.015].forEach((dy) => B.geo(rail, { m: m4.compose(p.copy(c).setY(c.y + dy), q, sc.set((bw + 0.04) / 1.94, 1, 1)), col: 0x8d959b, white: true }));
      });
    });
  });
  /* 看板・駅の形をまとめて世界へ */
  finishAtlas(rs);
  flushIndoorPools(rs);
  flushSigns(rs);
  /* このパッケージの材質に目印(計測用。700mマスに分けたあとでも見分けられるように) */
  const shared = new Set(Object.values(rs.M));
  rs.world.traverse((o) => {
    if (!o.userData.st || !o.material || Array.isArray(o.material) || shared.has(o.material)) return;
    const m = o.material;
    m.userData.st = true;
    if (!m.name) m.name = `st:${o.isInstancedMesh ? 'IM' : 'M'}:${o.geometry.type}:${m.map && m.map.image ? m.map.image.width + 'x' + m.map.image.height : '-'}`;
  });
}

/* ---------- 駅の人々(待つ・乗る・降りる)。12人の胴と頭で1回、脚と腕で1回の InstancedMesh ---------- */
export function buildPeople(rs) {
  const R = crowdRes(rs);
  const shirt = [0x3e5a78, 0x7a4a42, 0x4a6b4e, 0x6b5a7c, 0x8a6d3b, 0x455a64, 0xa05a6e, 0x37657a, 0x94502e, 0x2e6e62, 0x714a71, 0x4f6636];
  const pants = [0x2b3138, 0x3a3f46, 0x4a4038, 0x333a42, 0x26303a];
  const NF = FIG_N;
  const mk = (geo, n) => {
    const im = new THREE.InstancedMesh(geo, R.matFig, n);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.frustumCulled = false;
    im.userData.noSplit = true; im.userData.st = true; im.userData.dyn = true;   // 歩く人(毎フレーム動く)
    im.castShadow = true;
    im.customDepthMaterial = R.depth;   // 影も、使わない部品(脚/腕・着こなし)をつぶした形で
    rs.world.add(im);
    return im;
  };
  const P = rs._ppl = {
    body: mk(R.fig.body, NF), limbs: mk(R.fig.limbs, NF * 4),
    m: new THREE.Matrix4(), m2: new THREE.Matrix4(), m3: new THREE.Matrix4(),
    q: new THREE.Quaternion(), sc: new THREE.Vector3(), pos: new THREE.Vector3(), tmp: new THREE.Vector3(),
    fr: newFrame(), dir: new THREE.Vector3(), any: true, hip: R.hip, sh: R.sh,
  };
  const col = new THREE.Color();
  rs.people = [];
  for (let i = 0; i < NF; i++) {
    col.setHex(shirt[i % shirt.length]);
    P.body.setColorAt(i, col);      // 服の部分(stCloth=1)だけに効く。頭・首は頂点色のまま
    P.limbs.setColorAt(NF * 2 + i * 2, col); P.limbs.setColorAt(NF * 2 + i * 2 + 1, col);   // 腕(そで)
    col.setHex(pants[i % pants.length]);
    P.limbs.setColorAt(i * 2, col); P.limbs.setColorAt(i * 2 + 1, col);                     // 脚(ズボン)
    rs.people.push({ pos: new THREE.Vector3(), yaw: 0, ph: i * 1.7, legA: 0, armA: 0, bob: 0, vis: false, sc: 0.88 + (i % 5) * 0.05 });
  }
  hideAllPeople(rs);
}

function hideAllPeople(rs) {
  const P = rs._ppl;
  if (!P || !P.any) return;
  P.any = false;
  P.body.visible = P.limbs.visible = false;
  for (let i = 0; i < rs.people.length; i++) rs.people[i].vis = false;
}

/* 1人分の配置+歩行アニメ。dirWorldは歩く向き(nullなら立ち) */
export function placeFig(rs, fig, pos, dirWorld, dt, speed) {
  fig.pos.copy(pos);
  if (dirWorld && speed > 0.05) {
    fig.yaw = Math.atan2(dirWorld.x, dirWorld.z);
    fig.ph += dt * (4.5 + speed * 2.2);
    const sw = Math.sin(fig.ph);
    fig.legA = sw * 0.5;
    fig.armA = -sw * 0.38;
    fig.bob = Math.abs(Math.cos(fig.ph)) * 0.025;
  } else {
    /* 立ち: 手足を下ろして小さくゆれる */
    fig.legA *= 0.8;
    fig.armA *= 0.8;
    fig.bob = Math.sin(rs.clockT * 1.6 + fig.ph) * 0.008;
  }
  fig.vis = true;
}

/* 12人の行列を書く(割り当てなし) */
function writePeople(rs) {
  const P = rs._ppl, A = P.limbs, NF = FIG_N;
  const { m, m2, m3, q, sc, pos } = P;
  for (let i = 0; i < rs.people.length; i++) {
    const fig = rs.people[i];
    if (!fig.vis) {
      m.makeScale(0, 0, 0);
      P.body.setMatrixAt(i, m);
      A.setMatrixAt(i * 2, m); A.setMatrixAt(i * 2 + 1, m);
      A.setMatrixAt(NF * 2 + i * 2, m); A.setMatrixAt(NF * 2 + i * 2 + 1, m);
      continue;
    }
    q.setFromAxisAngle(UPV, fig.yaw);
    sc.setScalar(fig.sc);
    pos.copy(fig.pos); pos.y += fig.bob;
    m.compose(pos, q, sc);
    P.body.setMatrixAt(i, m);
    for (let k = 0; k < 2; k++) {
      const sx = k ? 1 : -1;
      m3.makeRotationX(k ? -fig.legA : fig.legA);
      m2.makeTranslation(sx * P.hip[0], P.hip[1], 0).multiply(m3).premultiply(m);
      A.setMatrixAt(i * 2 + k, m2);
      m3.makeRotationX(k ? -fig.armA : fig.armA);
      m2.makeRotationZ(sx * 0.08).multiply(m3);
      m3.makeTranslation(sx * P.sh[0], P.sh[1], 0).multiply(m2).premultiply(m);
      A.setMatrixAt(NF * 2 + i * 2 + k, m3);
    }
  }
  P.body.visible = A.visible = true;
  P.body.instanceMatrix.needsUpdate = true; A.instanceMatrix.needsUpdate = true;
  P.any = true;
}

/* ---------- 毎フレーム: 駅の人々・時計・昼夜の見た目(割り当てなし) ---------- */
export function updatePeople(rs, dt) {
  stationLook(rs);
  updateClock(rs);
  updateSignPool(rs);
  if (rs._ledTod !== rs.timeOfDay) { rs._ledTod = rs.timeOfDay; updateLedBoards(rs); }
  updateStationLed(rs);
  updateCrowdLod(rs);
  if (!rs.people || !rs._ppl) return;
  const sim = rs.sim;
  /* ドア開放中は「いま停まっている駅」(到着でstopIdxはもう次を指している) */
  const cur = sim.doorOpen ? sim.stops[sim.stopIdx - 1] : null;
  const next = cur || sim.stops[sim.stopIdx];
  const d = next ? next.stopAt - sim.pos : 1e9;
  if (!next || d > 430 || d < -40) { hideAllPeople(rs); return; }
  const P = rs._ppl, fr = P.fr, dir = P.dir, pos = P.tmp;
  const f01 = sim.doorOpen ? Math.min(1, Math.max(0, 1 - (rs._departOf() - sim.t) / 20)) : 0;
  const edge = PLAT.L.edge + 0.12;
  /* 自ホーム(進行左側)の6人: 0-1=降りる人(運転台の すこし先), 2-5=乗る人(ドアの前の列の先頭) */
  for (let i = 0; i < 6; i++) {
    const fig = rs.people[i];
    const s = i < 2 ? next.stopAt + ALIGHT_S[i] : next.stopAt - BOARD_DOORS[i - 2] - 0.33;
    frameInto(rs, Math.max(2, s), fr);
    let lat, walking = 0, dw = null;
    if (!sim.doorOpen) {
      lat = 2.9;
      if (i < 2) { fig.vis = false; continue; }
    } else if (i < 2) {
      const pk = Math.min(1, Math.max(0, f01 * 1.7 - i * 0.25));
      lat = edge + pk * 2.3;
      if (pk > 0 && pk < 1) { walking = 1; dw = dir.copy(fr.left); }
    } else {
      const pk = Math.min(1, Math.max(0, f01 * 1.6 - (i - 2) * 0.18));
      const w0 = 2.9;
      lat = w0 - pk * (w0 - edge);
      if (pk >= 1) { fig.vis = false; continue; }
      if (pk > 0) { walking = 1; dw = dir.copy(fr.left).negate(); }
    }
    pos.copy(fr.p).addScaledVector(fr.left, lat);
    pos.y += 1.05;
    placeFig(rs, fig, pos, dw, dt, walking);
  }
  /* 向かいホームの6人: 接近中は立って待ち、停車中は歩く流れ
   * (運転台の目の前に急に現れないよう、歩きはじめは運転台より9mうしろ。そこから奥へ歩いていく) */
  for (let i = 6; i < 12; i++) {
    const fig = rs.people[i];
    const k = i - 6;
    let s, walking = 0;
    if (sim.doorOpen) {
      s = next.stopAt - 9 - ((rs.clockT * 8 + k * 25) % 150);
      walking = 1;
    } else {
      s = next.stopAt - 12 - k * 21;
    }
    frameInto(rs, Math.max(2, s), fr);
    const dw = walking ? dir.copy(fr.t).negate() : null;
    /* 列(-6.7/-7.25m)のうしろの通り道を歩く */
    pos.copy(fr.p).addScaledVector(fr.left, -7.82 + (i % 2) * 0.06);
    pos.y += 1.05;
    placeFig(rs, fig, pos, dw, dt, walking);
  }
  writePeople(rs);
}

/* 待つ人の遠近: カメラから160m以内の駅は細かい形+影、それより遠い駅は箱3つの形(影なし)。
 * 変わったときだけ形を差しかえる(材質・プログラムは同じ) */
const _lodDir = new THREE.Vector3(), _lodFr = newFrame();
function updateCrowdLod(rs) {
  const list = rs._crowdMeshes, R = rs._crowdRes;
  if (!list || !R || !R.crowdLite) return;
  const cs = rs._camS != null ? rs._camS : rs.sim ? rs.sim.pos : 0;
  /* カメラが線路の前(s がふえる向き)を向いているか(運転台・うしろ・上空・よこ)。線路わきのカメラは反対を向く */
  let fwd = 0;
  if (rs.camera && rs.frames) {
    rs.camera.getWorldDirection(_lodDir);
    frameInto(rs, cs, _lodFr);
    fwd = _lodDir.x * _lodFr.t.x + _lodDir.z * _lodFr.t.z;
  }
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    const d = cs < e.a ? e.a - cs : cs > e.b ? cs - e.b : 0;
    const lite = d > 160;
    if (lite !== e.lite) {
      e.lite = lite;
      e.im.geometry = lite ? R.crowdLite : R.crowd;
      e.im.castShadow = !lite && !e.noSh;
      if (e.sh) e.sh.visible = !lite;     // 遠い駅の足もとの影は見えないので描かない
    }
    /* 前を向いているときは、カメラより8m以上うしろの人は描かない(見えない・影も落とさない) */
    let cnt = e.n;
    if (fwd > 0.35 && !lite) { cnt = 0; while (cnt < e.n && e.sArr[cnt] >= cs - 8) cnt++; }
    if (e.im.count !== cnt) e.im.count = cnt;
    if (e.sh && e.sh.count !== cnt) e.sh.count = cnt;
  }
}

/* 駅名標の画像を、カメラに近い駅へ割りあてなおす(いちばん近い駅が変わったときだけ) */
const SIGN_POOL = 6;
function updateSignPool(rs) {
  const W = rs._stw;
  if (!W || !W.signInfo.length) return;
  const s = rs._camS != null ? rs._camS : rs.sim ? rs.sim.pos : 0;
  const sts = rs.line.stations;
  let best = 0, bd = 1e12;
  for (let i = 0; i < sts.length; i++) { const d = Math.abs(sts[i].s - s); if (d < bd) { bd = d; best = i; } }
  if (best === W.poolCenter) return;
  W.poolCenter = best;
  /* うしろ1駅〜前4駅(運転台は前を見ている) */
  const hi = Math.min(sts.length - 1, Math.max(best - 1, 0) + SIGN_POOL - 1);
  const lo = Math.max(0, hi - SIGN_POOL + 1);
  W.signPool.forEach((e) => {
    if (e.si >= 0 && (e.si < lo || e.si > hi)) {
      W.signMats[e.si].map = W.signPH;
      e.si = -1;
    }
  });
  for (let i = lo; i <= hi; i++) {
    if (W.signPool.some((e) => e.si === i)) continue;
    let e = W.signPool.find((x) => x.si < 0);
    if (!e) { e = { tex: texStationSign(), si: -1 }; W.signPool.push(e); }
    e.si = i;
    e.tex.userData.setStation(W.signInfo[i]);
    W.signMats[i].map = e.tex;
  }
}

/* 駅の時計: ゲーム内の「分」が変わったときだけ描き直す */
function updateClock(rs) {
  const W = rs._stw;
  if (!W || !rs.sim) return;
  const min = Math.floor(rs.sim.t / 60);
  if (min === W.clockMin && rs.timeOfDay === W.clockTod) return;
  W.clockMin = min; W.clockTod = rs.timeOfDay;
  const base = rs.timeOfDay === 'night' ? 19 : rs.timeOfDay === 'evening' ? 16 : 10;
  const tot = min + base * 60;
  drawClock(W.M.clockTex.image.getContext('2d'), Math.floor(tot / 60) % 24, tot % 60);
  W.M.clockTex.needsUpdate = true;
}

/* 昼・夕方・夜・雨雪の見た目(look が変わったときだけ。値の書きかえのみ・作り直しなし) */
function stationLook(rs) {
  const W = rs._stw;
  if (!W) return;
  let night, eve, wet;
  const lk = rs.look;
  if (lk) {
    if (lk.rev === W.look) return;
    W.look = lk.rev;
    night = !!lk.night; eve = !!lk.eve; wet = !!lk.wet;
  } else {
    if (W.tod === rs.timeOfDay && W.wx === rs.weather) return;
    W.tod = rs.timeOfDay; W.wx = rs.weather;
    night = W.tod === 'night'; eve = W.tod === 'evening'; wet = W.wx !== 'clear';
  }
  const M = W.M;
  M.st.emissiveIntensity = night ? 1.6 : eve ? 0.8 : wet ? 0.5 : 0;     // 屋根の照明の帯・ホームの床
  M.poolStrip.visible = night || eve || wet;
  M.poolStrip.opacity = night ? 0.5 : eve ? 0.25 : 0.12;
  /* 内照式の駅名標・時計: 夜も白い地がにじみの しきい値(夜1.0)をこえないくらい(字がにじんで消えない) */
  const lit = night ? 1.02 : eve ? 1.0 : 0.95;
  M.clock.color.setScalar(lit);
  W.signMats.forEach((m) => m.color.setScalar(lit));
  /* 停止位置「8」などの標識: 夜もほんのり(昼より明るく見えない。灯りに照らされた白い板の明るさ) */
  if (rs._atlas) rs._atlas.mat.emissiveIntensity = night ? 0.18 : eve ? 0.2 : 0.12;
  if (W.termBld) W.termBld.emissiveIntensity = night ? 1.0 : eve ? 0.35 : 0;
  /* ホームの人: 夜・夕方はホームの灯りに照らされた明るさを足す(黒い影絵にならない) */
  if (rs._crowdRes && rs._crowdRes.uLit) rs._crowdRes.uLit.value = night ? 0.32 : eve ? 0.12 : 0;
  /* 信号の灯: 昼はあざやかな色(明るすぎると白っぽくなる)、夜は明るくしてにじませる */
  if (rs._sigRes && rs._sigRes.glowMat) rs._sigRes.glowMat.color.setScalar(night ? 1.3 : eve ? 0.95 : 0.5);
}
