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

export { updateSignals };
export const PLAT = { L: { edge: 1.58, back: 5.0 }, R: { edge: -5.38, back: -8.8 } };
/* 停止位置目標「8」の位置(停止位置 st.s から前へ)。止まった運転台の左の窓柱のよこに見える。
 * 予告(300/200/100/50m)もここから測る。P6 は rs._stop8Ahead で光の目印をそろえる */
export const STOP8_AHEAD = 1.6;
const P_A = 155, P_B = 15;              // ホームの範囲: st.s-155 〜 st.s+15
const ROOF_B = 8;                       // 屋根: st.s-roofA(駅ごと 95/125/140) 〜 st.s+8(停止位置の運転台の上まで)
/* 8両の電車のドアの位置(各車両の先頭からの距離。先頭車の先頭 = 停止位置) */
const DOOR_OFF = [2.9, 7.7, 12.4, 17.2];
/* 乗る人(動く12人のうち4人)が待つドア(停止位置からの距離)。止まっている人の列は ここには並べない */
const BOARD_DOORS = [17.2, 22.9, 27.7, 32.4];
/* 降りる人(動く12人のうち2人)が歩くところ(停止位置からの距離。運転台から見える先のほう) */
const ALIGHT_S = [6.5, 10.2];

/* 駅の見た目の型: { kind: 'over'|'foot'|'house', roofCol, roofA }(駅名から毎回同じに決まる) */
export function stationStyle(rs, st, si) {
  const all = stationStyles(rs);
  return all[si] || { kind: 'house', roofCol: 0x3d4a56, roofA: 125 };
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

/* ホームの端のふた: 断面の外形を三角形に分けて、線路に直角な面にする */
function endCap(f, prof, texU) {
  const pts = [];
  prof.forEach((P) => {
    const l = pts[pts.length - 1];
    if (!l || Math.abs(l.x - P[0]) > 1e-4 || Math.abs(l.y - P[1]) > 1e-4) pts.push(new THREE.Vector2(P[0], P[1]));
  });
  if (THREE.ShapeUtils.isClockWise(pts)) pts.reverse();
  const tris = THREE.ShapeUtils.triangulateShape(pts, []);
  const pos = [], uv = [];
  pts.forEach((v) => { pos.push(f.p.x + f.left.x * v.x, f.p.y + v.y, f.p.z + f.left.z * v.x); uv.push(texU, 0.5); });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(tris.flat());
  g.computeVertexNormals();
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

/* 新宿ターミナルの柱(下1.2mは濃い帯にのりば番号) */
function texTermColumn(label) {
  const t = canvasTexture(64, 256, (c) => {
    c.fillStyle = '#d8dcdf'; c.fillRect(0, 0, 64, 256);
    c.fillStyle = 'rgba(70,76,82,0.25)';
    for (let y = 0; y < 256; y += 10.4) c.fillRect(0, Math.round(y), 64, 1);
    c.fillRect(31, 0, 1, 256);
    c.fillStyle = 'rgba(255,255,255,0.35)'; c.fillRect(0, 0, 3, 256);
    c.fillStyle = '#2a3138'; c.fillRect(0, 214, 64, 42);
    c.fillStyle = '#f2f4f5'; fitText(c, label, 32, 234, 58, 22, 900);
  });
  redrawWhenFonts(t, label);
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

/* 「のりば」のつり下げ板(濃い地に白) */
function texNoriba(no) {
  const t = canvasTexture(384, 96, (c) => {
    c.fillStyle = '#20272d'; c.fillRect(0, 0, 384, 96);
    c.fillStyle = '#f2c230'; c.fillRect(0, 88, 384, 8);
    c.fillStyle = '#ffffff';
    fitText(c, no, 96, 46, 160, 60, 900);
    fitText(c, 'ばんせん', 238, 30, 140, 26, 700);
    fitText(c, 'のりば', 238, 64, 140, 30, 900);
  });
  redrawWhenFonts(t, no + 'ばんせんのりば');
  return t;
}

/* 自発光は頂点属性 stE の割合だけ(天井の照明の帯=1、屋根の下の床=0.22、屋根のない床=0.1)。
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
  /* (a) 係員用のスロープ: ホームのうしろ寄り1.2m、端から外へ5mで地面近くまで下る */
  const li = P.back - 1.25 * sg, lo = P.back - 0.05 * sg;
  const pt = (f, lat, y) => [f.p.x + f.left.x * lat, f.p.y + y, f.p.z + f.left.z * lat];
  const a1 = pt(T.f0, li, 1.05), a2 = pt(T.f0, lo, 1.05), b1 = pt(T.f1, li, 0.15), b2 = pt(T.f1, lo, 0.15);
  const a1d = pt(T.f0, li, -0.4), a2d = pt(T.f0, lo, -0.4), b1d = pt(T.f1, li, -0.4), b2d = pt(T.f1, lo, -0.4);
  const tri = [];
  const quad = (p, q, r, s) => tri.push(...p, ...q, ...r, ...p, ...r, ...s);
  quad(a1, a2, b2, b1);       // 坂
  quad(a1, b1, b1d, a1d);     // 線路がわの側面
  quad(a2, a2d, b2d, b2);     // うしろの側面
  quad(b1, b2, b2d, b1d);     // 先の小口
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(tri, 3));
  g.computeVertexNormals();
  B.geo(g, { white: true, col: 0x9e9b94 });
  /* (b) 端の柵(へりから0.35m 〜 スロープの手前。高さ1.1m) */
  const ff = frameInto(rs, sEnd - out * 0.3, T.ff);
  const la = P.edge + 0.35 * sg, lb = P.back - 1.3 * sg;
  B.geo(fenceQuad(ff, la, lb, 1.05, 2.15));
  /* (c) スロープの入口の黄色い棒(黒い帯3本)と、ちょうつがいの柱 */
  const g0 = P.back - 1.3 * sg, g1 = P.back - 0.05 * sg, gm = (g0 + g1) / 2, gl = Math.abs(g1 - g0);
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

/* ---------- 発車する側のホームの端: 運転士用のモニター(ITV)とミラー(左ホームだけ) ---------- */
let _itvGeo = null;
function itvMonitor(rs, B, st, ob) {
  const sI = st.s + 12.5;
  const f = frameOf(rs, sI);
  const lat = PLAT.L.edge + 0.5, yb = f.p.y + 1.05;
  if (!_itvGeo) {
    const A = lineBoard(rs, 'itv').uv;
    const scr = new THREE.PlaneGeometry(0.42, 0.32);
    const uv = scr.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) ? A[2] : A[0], uv.getY(i) ? A[3] : A[1]);
    _itvGeo = {
      house: new THREE.BoxGeometry(1.0, 0.62, 0.3), scr, cap: new THREE.BoxGeometry(1.08, 0.06, 0.4),
      arm: new THREE.BoxGeometry(0.06, 0.06, 1), mirror: new THREE.CircleGeometry(0.28, 18), rim: new THREE.RingGeometry(0.28, 0.33, 18),
    };
  }
  const G = _itvGeo;
  B.post(f.p.x + f.left.x * lat, yb, f.p.z + f.left.z * lat, 2.45, 0x4f575d, 1.8);
  ob.push({ s: sI, lat, r: 0.2 });
  const n = flatT(f, new THREE.Vector3()).negate();               // 入ってくる運転台のほう
  const q = new THREE.Quaternion().setFromAxisAngle(UPV, Math.atan2(n.x, n.z));
  q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), THREE.MathUtils.degToRad(10)));   // 10°下向き
  const hc = f.p.clone().addScaledVector(f.left, lat + 0.1); hc.y = f.p.y + 3.65;
  const one = new THREE.Vector3(1, 1, 1), m4 = new THREE.Matrix4(), mm = new THREE.Matrix4();
  m4.compose(hc, q, one);
  B.geo(G.house, { m: m4, col: 0x24292e, white: true });
  B.geo(G.cap, { m: mm.makeTranslation(0, 0.33, 0.02).premultiply(m4), col: 0x3a4146, white: true });
  const LB = lineBaker(rs);
  [-0.235, 0.235].forEach((x) => LB.geo(G.scr, { m: mm.makeTranslation(x, -0.01, 0.152).premultiply(m4), e: 1 }));
  /* 凸面ミラー(モニターのホームがわのとなり。少し線路のほうへ向ける) */
  const mq = new THREE.Quaternion().setFromAxisAngle(UPV, Math.atan2(n.x, n.z) + 0.45);
  const mc = f.p.clone().addScaledVector(f.left, lat + 1.07); mc.y = f.p.y + 3.3;
  m4.compose(mc, mq, one);
  B.geo(G.mirror, { m: m4, col: 0xd9dee2, white: true });
  B.geo(G.rim, { m: m4, col: 0x17191b, white: true });
  B.geo(G.mirror, { m: mm.makeTranslation(0, 0, -0.03).premultiply(m4), col: 0x2a2e31, white: true });
  /* ミラーの腕(柱から横へ) */
  const ac = f.p.clone().addScaledVector(f.left, lat + 0.52); ac.y = f.p.y + 3.3;
  B.geo(G.arm, { m: m4.compose(ac, new THREE.Quaternion().setFromAxisAngle(UPV, Math.atan2(f.left.x, f.left.z)), new THREE.Vector3(1, 1, 1.0)), col: 0x4f575d, white: true });
}

/* ---------- 階段(橋上駅舎・跨線橋へ): 各ホームに1つ。駅の形に焼きこむ ----------
 * 下(ホーム面)は st.s-128.6、上(高さ7.9m)は st.s-141。跨線橋は上に踊り場をつけて橋につなぐ */
let _stairGeo = null;
function buildStairs(rs, B, st, S, ob) {
  const rise = 7.9 - 1.05, run = STAIR.foot - STAIR.top, len = Math.hypot(rise, run), ang = Math.atan2(rise, run);
  if (!_stairGeo) {
    _stairGeo = {
      slab: new THREE.BoxGeometry(1.8, 0.3, len), wall: new THREE.BoxGeometry(0.08, 1.1, len),
      roof: new THREE.BoxGeometry(2.1, 0.12, len), land: new THREE.BoxGeometry(1.8, 0.3, 1),
      lwall: new THREE.BoxGeometry(0.08, 1.1, 1), lroof: new THREE.BoxGeometry(2.1, 0.12, 1), col: new THREE.BoxGeometry(0.3, 1, 0.3),
    };
  }
  const G = _stairGeo;
  const sm = st.s - (STAIR.foot + STAIR.top) / 2, f = frameOf(rs, sm);
  const one = new THREE.Vector3(1, 1, 1), m4 = new THREE.Matrix4(), mm = new THREE.Matrix4(), c = new THREE.Vector3();
  const q = new THREE.Quaternion().setFromAxisAngle(UPV, Math.atan2(f.t.x, f.t.z));
  q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), ang));   // +t へ下る
  const qf = new THREE.Quaternion().setFromAxisAngle(UPV, Math.atan2(f.t.x, f.t.z));
  [1, -1].forEach((sg) => {
    const lat = mid(sideOf(sg)) + 0.15 * sg;
    c.copy(f.p).addScaledVector(f.left, lat); c.y = f.p.y + (1.05 + 7.9) / 2 - 0.15;
    m4.compose(c, q, one);
    B.geo(G.slab, { m: m4, col: 0xb4b2ab, white: true });
    [-0.94, 0.94].forEach((x) => B.geo(G.wall, { m: mm.makeTranslation(x, 0.7, 0).premultiply(m4), col: 0xcfd3d5, white: true }));
    B.geo(G.roof, { m: mm.makeTranslation(0, 2.55, 0).premultiply(m4), col: S.roofCol, white: true });
    /* 屋根の足(階段の下の端) */
    const fb = frameOf(rs, st.s - STAIR.foot + 0.3);
    [-0.98, 0.98].forEach((x) => {
      const l = lat + x;
      B.post(fb.p.x + fb.left.x * l, fb.p.y + 1.05, fb.p.z + fb.left.z * l, 2.55, 0x8d959b, 1.5);
    });
    /* 跨線橋: 階段の上から橋までの踊り場(屋根つき)と、それをささえる柱 */
    if (S.kind === 'foot') {
      const s0 = st.s - STAIR.c + 1.7, s1 = st.s - STAIR.top, L = s1 - s0;
      const fl = frameOf(rs, (s0 + s1) / 2);
      c.copy(fl.p).addScaledVector(fl.left, lat); c.y = fl.p.y + 7.9 - 0.15;
      m4.compose(c, qf, one);
      B.geo(G.land, { m: mm.makeScale(1, 1, L).premultiply(m4), col: 0xb4b2ab, white: true });
      [-0.94, 0.94].forEach((x) => B.geo(G.lwall, { m: mm.makeScale(1, 1, L).premultiply(new THREE.Matrix4().makeTranslation(x, 0.7, 0)).premultiply(m4), col: 0xe9e8e3, white: true }));
      B.geo(G.lroof, { m: mm.makeScale(1, 1, L).premultiply(new THREE.Matrix4().makeTranslation(0, 2.55, 0)).premultiply(m4), col: S.roofCol, white: true });
      c.copy(fl.p).addScaledVector(fl.left, lat); c.y = fl.p.y + 1.05 + (7.6 - 1.05) / 2;
      B.geo(G.col, { m: m4.compose(c, qf, new THREE.Vector3(1, 7.6 - 1.05, 1)), col: 0xc4c6c4, white: true });
    }
    ob.push({ s0: st.s - P_A - 5, s1: st.s - STAIR.foot + 2.5 });     // 階段より奥には人・ベンチを置かない
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
  rs._stop8Ahead = STOP8_AHEAD;     // P6: 停止位置の光の目印を「8」にそろえる
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
  const FB = bakerFor(rs, M.fixture, M.fixture, { build: { recv: false } });
  /* 発車標(オレンジのLED): 全線で画像2枚(この電車の向き / 反対の向き)・描画2回 */
  const ledMat = (tex) => {
    const m = new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color(2.2, 2.2, 2.2) });
    m.userData.noWeather = true; m.name = 'st-led';
    return m;
  };
  const ledOwn = texLed(), ledOpp = texLed();
  const LO = bakerFor(rs, 'ledOwn', ledMat(ledOwn), { build: { recv: false } });
  const LP = bakerFor(rs, 'ledOpp', ledMat(ledOpp), { build: { recv: false } });
  W.led = { own: ledOwn, opp: ledOpp, key: null };
  const gS = (rs._catSupports || []).filter((sp) => sp.type === 'gantry').map((sp) => sp.s);
  const clearOfGantry = (s, half) => {
    for (let k = 0; k < gS.length; k++) if (Math.abs(s - gS[k]) < half) return gS[k] + (s < gS[k] ? -half : half);
    return s;
  };
  /* 発車標(両面)+つり下げの柱2本 */
  const ledBoard = (B, LB, s, lat, y, ceil) => {
    frameInto(rs, s, f);
    flatT(f, n);
    c.copy(f.p).addScaledVector(f.left, lat);
    c.y = f.p.y + y;
    B.geo(housGeo, { m: m4.compose(c, q.setFromAxisAngle(UPV, Math.atan2(n.x, n.z)), one), col: 0x15181b, white: true });
    LB.quad(c.clone().addScaledVector(n, 0.078), n, 2.24, 0.49, [0, 0, 1, 1]);
    const nb = n.clone().negate();
    LB.quad(c.clone().addScaledVector(nb, 0.078), nb, 2.24, 0.49, [0, 0, 1, 1]);
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
    const roofA = S.roofA;
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
      /* ホーム(左右)と両端のふた。床の自発光: 屋根の下 0.22・屋根のない端 0.1(夜も床が見える) */
      [1, -1].forEach((sg) => {
        const prof = sideProfile(sg);
        if (under) B.geo(profileStrip(F, i0, i1, prof), { e: 1 });
        else {
          const ra = Math.max(i0, iOf(st.s - roofA)), rb = Math.min(i1, iOf(st.s + ROOF_B));
          B.geo(profileStrip(F, i0, ra, prof), { e: 0.1 });
          B.geo(profileStrip(F, ra, rb, prof), { e: 0.22 });
          B.geo(profileStrip(F, rb, i1, prof), { e: 0.1 });
        }
        [i0, i1].forEach((ii) => B.geo(endCap(F[ii], prof, AT.plat(0.97))));
        /* ホームの端: スロープ・柵・黄色い棒・「この さき はいれません」 */
        platformEnd(rs, B, i0 * step, sg, -1);
        platformEnd(rs, B, i1 * step, sg, 1);
      });
      /* 発車する側の端: 運転士用モニターとミラー */
      itvMonitor(rs, B, st, ob);
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
          /* 天井の板も照明の照り返しで少し明るく(夜に天井が真っ黒にならないよう。帯の0.15倍) */
          B.geo(profileStrip(F, ra, rb, [[u0, 4.05, AT.under(0.004)], [la, 4.05, AT.under(LAMP_U[0])]]), { e: 0.15 });
          B.geo(profileStrip(F, ra, rb, [[la, 4.05, AT.under(LAMP_U[0])], [lb, 4.05, AT.under(LAMP_U[1])]]), { e: 1 });
          B.geo(profileStrip(F, ra, rb, [[lb, 4.05, AT.under(LAMP_U[1])], [u1, 4.05, AT.under(0.996)]]), { e: 0.15 });
          B.geo(profileStrip(F, ra, rb, [[e0, 4.47, AT.top(0.05)], [b0, 4.27, AT.top(0.95)]]), { col: S.roofCol });
          const fas = { white: true, col: S.roofCol };
          B.geo(profileStrip(F, ra, rb, [[e0, 3.98, 0], [e0, 4.5, 0]]), fas);
          B.geo(profileStrip(F, ra, rb, [[b0, 3.98, 0], [b0, 4.3, 0]]), fas);
          [ra, rb].forEach((ii) => B.geo(capGeo(F[ii], [[e0, 3.98], [e0, 4.5], [b0, 4.3], [b0, 3.98]]), fas));
          /* 柱(10mごと・ホームの中心線)。3本に1本は赤い「非常停止」の箱 */
          const lat = mid(P);
          let k = 0;
          for (let s = st.s - 10 * Math.floor((roofA - 5) / 10); s <= st.s + 2; s += 10, k++) {
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
          const nearS = stairs ? st.s - 153 : Math.max(st.s - (roofA + 15), st.s - P_A + 4);
          [st.s + 12, nearS].forEach((s) => {
            frameInto(rs, s, f);
            c.copy(f.p).addScaledVector(f.left, lat);
            B.post(c.x, f.p.y + 1.05, c.z, 4.0, 0x6f777d, 1.6);
            q.setFromAxisAngle(UPV, Math.atan2(f.t.x, f.t.z));
            c.y = f.p.y + 1.05 + 4.0;
            FB.geo(lampGeo.head, { m: m4.compose(c, q, one), white: true });
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
    [1, -1].forEach((sg) => {
      const P = sideOf(sg);
      const lat = isTerm ? mid(P) : P.back - 0.6 * sg;
      [-40, -110].forEach((ds) => {
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

    /* ---- 停止位置目標「8」: 白い板に黒い8、へりから0.35mの柱(2.0m)の上。
     * 止まった運転台の左の窓柱のよこ(st.s + STOP8_AHEAD) ---- */
    frameInto(rs, st.s + STOP8_AHEAD, f);
    flatT(f, n).negate();
    {
      const yb = f.p.y + 1.05;
      c.copy(f.p).addScaledVector(f.left, PLAT.L.edge + 0.35);
      c.y = yb + 2.0 + 0.25;
      makeSign(rs, 'stop8', 0.5, 0.5, { c, n, postH: 2.0 + 0.4, yBase: yb });
      ob.push({ s: st.s + STOP8_AHEAD, lat: PLAT.L.edge + 0.35, r: 0.3 });
    }

    /* ---- 発車標と時計: 左ホームは停止位置の6m先(止まった運転台から見える。モニターは12.5m先で
     * 重ならない)。時計は発車標のうしろ寄りのとなり。右ホームは中ほど ---- */
    const ceilY = isTerm ? 7.4 : under ? 6.2 : 4.05;
    if (!isTerm) {
      const sL = clearOfGantry(st.s + 6, 0.7);
      ledBoard(B, LO, sL, 3.15, under ? 5.4 : 3.55, ceilY);
      clockAt(B, sL, 4.64, ceilY);
      ledBoard(B, LP, clearOfGantry(st.s - 70, 0.7), mid(PLAT.R) + 0.1, under ? 5.4 : 3.55, ceilY);
      clockAt(B, st.s - 60, mid(PLAT.R), ceilY);
    } else {
      [[1, st.s + 14], [-1, st.s - 75]].forEach(([sg, s]) => clockAt(B, s, mid(sideOf(sg)), ceilY));
    }
  });
  /* 灯りの帯(屋根の下とホームの端。夜・夕方・雨の日だけ) */
  addPools(rs, pools, M.poolStrip);
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

  /* 外側の線路2本(6.58 / -10.38)と、そこで発車を待つ電車 */
  const RH = 1.067 / 2 + 0.032;
  const trkB = new Baker(rs.M.ballast), headB = new Baker(rs.M.railHead), webB = new Baker(rs.M.railWeb);
  const bandB = rs.M.sleeperBand ? new Baker(rs.M.sleeperBand) : null;
  [TR_L, TR_R].forEach((off) => {
    trkB.geo(profileStrip(F, i0, i1, [[off + 1.9, 0, 0], [off - 1.9, 0, 1]], 2.5));
    [-RH, RH].forEach((o) => {
      headB.geo(profileStrip(F, i0, i1, [[off + o + 0.034, 0.19, 0], [off + o - 0.034, 0.19, 1]], 25));
      webB.geo(profileStrip(F, i0, i1, [[off + o + 0.034, 0.05, 0], [off + o + 0.034, 0.178, 1]], 8));
    });
    if (bandB) bandB.geo(profileStrip(F, i0, i1, [[off + 1.0, 0.004, 0], [off - 1.0, 0.004, 1]], 0.625));
  });
  trkB.build(rs); headB.build(rs); webB.build(rs, { recv: false });
  if (bandB) bandB.build(rs);
  [[TR_L, 'rapid', 10], [TR_R, 'exp', 8]].forEach(([off, kind, nCar]) => {
    const tr = rs.makeTrainModel(nCar, { kind, dest: '新百合ヶ丘' });
    rs.setTrainLights(tr, { head: true, tail: true });
    const head = T.up ? T.s0 - 150 : T.s0 - 4;
    placeTrain(rs, tr, head, T.up ? -1 : 1, off);
    rs.world.add(tr.group);
  });

  /* 島式ホーム2面(両側にへり・点字ブロック) */
  const pa = T.up ? T.s0 - 155 : T.s0 - 168, pb = T.up ? T.s0 + 28 : T.s0 + 15;
  const pi0 = iOf(pa), pi1 = iOf(pb);
  [islandProfile(PLAT.L.edge, PLAT.L.back), islandProfile(PLAT.R.edge, PLAT.R.back)].forEach((prof) => {
    B.geo(profileStrip(F, pi0, pi1, prof), { e: 1 });
    [pi0, pi1].forEach((ii) => B.geo(endCap(F[ii], prof, AT.plat(0.97)), { e: 1 }));
  });

  /* 柱(タイル張り、下の帯にのりば番号) */
  const physLeft = !T.up;   // くだりで左の島 = 1・2番線
  [[1, physLeft ? '1・2' : '3・4'], [-1, physLeft ? '3・4' : '1・2']].forEach(([sg, label]) => {
    const lat = mid(sideOf(sg));
    const geo = new THREE.BoxGeometry(0.55, H, 0.55).translate(0, H / 2, 0);
    const mat = new THREE.MeshStandardMaterial({ map: texTermColumn(label), roughness: 0.55 });
    const ss = [];
    for (let s = pa + 8; s < pb - 4; s += 10) ss.push(s);
    if (W.obst[si]) ss.forEach((s) => W.obst[si].push({ s, lat, r: 0.5 }));
    const im = new THREE.InstancedMesh(geo, mat, ss.length);
    ss.forEach((s, i) => {
      frameInto(rs, s, f);
      q.setFromAxisAngle(UPV, Math.atan2(f.t.x, f.t.z));
      im.setMatrixAt(i, m4.compose(f.p.clone().addScaledVector(f.left, lat).setY(f.p.y + 1.0), q, one));
    });
    im.castShadow = true; im.userData.st = true; im.userData.noSplit = true;
    im.computeBoundingSphere();
    rs.world.add(im);
  });

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

  /* 出口の上の梁 */
  const exitS = T.up ? T.a : T.b;
  const backS = T.up ? T.b : T.a;
  const fx = frameOf(rs, exitS);
  const beam = new THREE.Mesh(new THREE.BoxGeometry(W_L - W_R + 2, 2.6, 2.2),
    new THREE.MeshStandardMaterial({ map: rs.T.concC, color: 0xb6b3ab, roughness: 0.9 }));
  beam.position.copy(fx.p).addScaledVector(fx.left, (W_L + W_R) / 2);
  beam.position.y += H + 1.0;
  beam.quaternion.setFromAxisAngle(UPV, Math.atan2(fx.t.x, fx.t.z));
  beam.castShadow = true;
  rs.world.add(beam);

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

  /* 天井から下がる「のりば」案内(表も裏も読める。左右が逆にならない) */
  [[1, physLeft ? '1・2' : '3・4'], [-1, physLeft ? '3・4' : '1・2']].forEach(([sg, no]) => {
    const tex = texNoriba(no);
    const NB = new Baker(new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.55, roughness: 0.5 }));
    [-30, -95].forEach((d) => {
      frameInto(rs, phys(d), f);
      flatT(f, n);
      c.copy(f.p).addScaledVector(f.left, mid(sideOf(sg)));
      c.y = f.p.y + 4.3;
      NB.quad(c.clone().addScaledVector(n, 0.01), n, 2.6, 0.65, [0, 0, 1, 1]);
      const nb = n.clone().negate();
      NB.quad(c.clone().addScaledVector(nb, 0.01), nb, 2.6, 0.65, [0, 0, 1, 1]);
      tf.crossVectors(UPV, n);
      [-1, 1].forEach((k) => B.post(c.x + tf.x * k, c.y + 0.32, c.z + tf.z * k, f.p.y + H - (c.y + 0.32), 0x6f777d));
    });
    NB.build(rs);
  });

  /* 発車標(オレンジのLED): 各ホームに2台。両面 */
  const ledL = texLed(), ledR = texLed();
  const housB = new Baker(new THREE.MeshStandardMaterial({ color: 0x15181b, roughness: 0.5, metalness: 0.4 }));
  const housGeo = new THREE.BoxGeometry(2.4, 0.55, 0.15);
  [[1, ledL], [-1, ledR]].forEach(([sg, tex]) => {
    const mat = new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color(2.2, 2.2, 2.2) });
    mat.userData.noWeather = true;
    const LB = new Baker(mat);
    [6, -60].forEach((d) => {
      frameInto(rs, phys(d), f);
      flatT(f, n);
      c.copy(f.p).addScaledVector(f.left, mid(sideOf(sg)));
      c.y = f.p.y + 4.45;
      housB.geo(housGeo, { m: m4.compose(c, q.setFromAxisAngle(UPV, Math.atan2(n.x, n.z)), one) });
      LB.quad(c.clone().addScaledVector(n, 0.078), n, 2.24, 0.49, [0, 0, 1, 1]);
      const nb = n.clone().negate();
      LB.quad(c.clone().addScaledVector(nb, 0.078), nb, 2.24, 0.49, [0, 0, 1, 1]);
      tf.crossVectors(UPV, n);
      [-0.9, 0.9].forEach((k) => B.post(c.x + tf.x * k, c.y + 0.27, c.z + tf.z * k, f.p.y + H - (c.y + 0.27), 0x6f777d));
    });
    LB.build(rs, { recv: false });
  });
  housB.build(rs, { cast: true });
  rs._ledBoards = { up: T.up, left: ledL, right: ledR };
  updateLedBoards(rs);

  /* 車止め(各線の終端): 赤白の枠+赤色灯 */
  const fbuf = frameOf(rs, T.buffer);
  const stripe = canvasTexture(64, 16, (cc) => {
    cc.fillStyle = '#f2f2ee'; cc.fillRect(0, 0, 64, 16);
    cc.fillStyle = '#c8281e';
    for (let x = 0; x < 64; x += 16) cc.fillRect(x, 0, 8, 16);
  }, { wrapS: THREE.RepeatWrapping });
  const bMat = new THREE.MeshStandardMaterial({ map: stripe, roughness: 0.6 });
  const redMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff3020).multiplyScalar(2) });
  [0, -3.8, TR_L, TR_R].forEach((off) => {
    const g = new THREE.Group();
    const beamB = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.35, 0.3), bMat);
    beamB.position.y = 1.05;
    g.add(beamB);
    [-0.75, 0.75].forEach((x) => {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.2, 0.18), rs.M.railWeb);
      post.position.set(x, 0.6, -0.4);
      post.rotation.x = 0.5;
      g.add(post);
    });
    const lamp = new THREE.Mesh(new THREE.CircleGeometry(0.12, 12), redMat);
    lamp.position.set(0, 1.45, 0.16);
    g.add(lamp);
    g.position.copy(fbuf.p).addScaledVector(fbuf.left, off);
    g.lookAt(g.position.clone().addScaledVector(fbuf.t, T.up ? -10 : 10));
    rs.world.add(g);
  });
}

/* 発車標の文字(種別・行き先・時刻・両数)。種別が変わるたびに書き直す */
const KIND_KANA = { local: 'かくえきていしゃ', exp: 'きゅうこう', rapid: 'かいそくきゅうこう' };
/* ゲーム内の秒 → 「10:24」(時間帯ごとの始発の時刻から) */
function hm(rs, sec) {
  const base = rs.timeOfDay === 'night' ? 19 : rs.timeOfDay === 'evening' ? 16 : 10;
  const tot = Math.floor(sec) + base * 3600;
  return `${Math.floor(tot / 3600) % 24}:${String(Math.floor((tot % 3600) / 60)).padStart(2, '0')}`;
}
export function updateLedBoards(rs) {
  const B = rs._ledBoards, sim = rs.sim;
  if (!B || !sim || !sim.timetable || !sim.timetable.length) return;
  const tt = sim.timetable;
  const yuri = kanaOf('新百合ヶ丘');
  if (!B.up) {
    const dep = tt[0].dep;
    const dest = kanaOf(sim.stops[sim.stops.length - 1].name);
    B.left.userData.set(`${KIND_KANA[sim.serviceKey] || KIND_KANA.local} ${dest}`, hm(rs, dep), '8りょう');
    B.right.userData.set(`${KIND_KANA.exp} ${yuri}`, hm(rs, dep + 240), '8りょう');
  } else {
    const arr = tt[tt.length - 1].arr;
    B.left.userData.set(`${KIND_KANA.rapid} ${yuri}`, hm(rs, arr + 180), '10りょう');
    B.right.userData.set(`${KIND_KANA.exp} ${yuri}`, hm(rs, arr + 420), '8りょう');
  }
}

/* 途中の駅の発車標: この電車(左ホーム)と、反対の向きの各停(右ホーム)。
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
  const dep = tt[i].dep != null ? tt[i].dep : tt[i].arr;
  const last = sim.stops[sim.stops.length - 1];
  const cars = 8;     // 自分の電車はいつも8両(traffic.js)
  L.own.userData.set(`${KIND_KANA[sim.serviceKey] || KIND_KANA.local} ${kanaOf(last.name)}`, hm(rs, dep || 0), `${cars}りょう`);
  const oppDest = rs.line.meta.direction === 'up' ? kanaOf('新百合ヶ丘') : kanaOf('新宿');
  L.opp.userData.set(`${KIND_KANA.local} ${oppDest}`, hm(rs, (dep || 0) + 180), '8りょう');
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
  const sty = stationStyles(rs);
  const cover = (s) => {
    if (rs._inTunnel(s)) return 6.1;
    return rs.line.stations.some((st, si) => !(T && st.name === '新宿') && !rs._inTunnel(st.s)
      && s > snapS(rs, st.s - sty[si].roofA) - 1 && s < snapS(rs, st.s + ROOF_B) + 1) ? 3.98 : Infinity;
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

/* ---------- 人の形(腕・脚・くつ・首・髪) ---------- */
const SKIN = 0xd8b49a;
function crowdRes(rs) {
  if (rs._crowdRes && rs._crowdRes.v4) return rs._crowdRes;
  const torso = () => new THREE.CylinderGeometry(0.19, 0.16, 0.6, 7).scale(1, 1, 0.62).translate(0, 1.12, 0);
  const arm = (sx) => new THREE.CylinderGeometry(0.045, 0.04, 0.56, 5, 1, true).translate(0, -0.28, 0).rotateZ(sx * 0.08).translate(sx * 0.23, 1.38, 0);
  const leg = (sx) => new THREE.CylinderGeometry(0.06, 0.055, 0.78, 5, 1, true).translate(sx * 0.08, 0.43, 0);
  const shoe = (sx) => new THREE.BoxGeometry(0.1, 0.06, 0.24).translate(sx * 0.08, 0.03, 0.04);
  const head = () => [
    [new THREE.CylinderGeometry(0.05, 0.055, 0.1, 6, 1, true).translate(0, 1.46, 0), SKIN],
    [new THREE.SphereGeometry(0.115, 7, 5).translate(0, 1.6, 0), SKIN],
  ];
  const hair = () => new THREE.SphereGeometry(0.118, 7, 3, 0, Math.PI * 2, 0, Math.PI * 0.6).scale(1.05, 1.0, 1.08).translate(0, 1.618, -0.018);
  /* 待つ人: 服(インスタンス色)+脚・くつ・頭・髪(頂点色)+リュック/肩かけかばん(3人に1人ずつ) */
  const crowd = mergeColored([
    [torso(), 0xffffff, { stCloth: 1 }], [arm(1), 0xffffff, { stCloth: 1 }], [arm(-1), 0xffffff, { stCloth: 1 }],
    [leg(1), 0x2c3138], [leg(-1), 0x2c3138], [shoe(1), 0x1c1d20], [shoe(-1), 0x1c1d20],
    ...head(), [hair(), 0x1d1915],
    [new THREE.BoxGeometry(0.28, 0.36, 0.14).translate(0, 1.15, -0.19), 0x23272d, { stBag: 1 }],
    [new THREE.BoxGeometry(0.08, 0.26, 0.3).translate(0.27, 0.92, 0), 0x6b4a32, { stBag: 2 }],
    [new THREE.BoxGeometry(0.03, 0.62, 0.03).rotateZ(-0.62).translate(0.06, 1.18, 0.0), 0x4a3424, { stBag: 2 }],
  ], ['stCloth', 'stBag']);
  /* 頂点の処理: 服の部分だけインスタンス色、かばんは インスタンス番号で3種に */
  const vsPars = '#include <common>\nattribute float stCloth;\nattribute float stBag;';
  const vsBag = `#include <begin_vertex>
#ifdef USE_INSTANCING
  #if __VERSION__ >= 300
    if ( stBag > 0.5 && abs( stBag - mod( float( gl_InstanceID ), 3.0 ) ) > 0.5 ) transformed = vec3( 0.0 );
  #else
    if ( stBag > 0.5 ) transformed = vec3( 0.0 );
  #endif
#endif`;
  const matCrowd = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.88 });
  /* uStLit: ホームの灯りに照らされた明るさ(夜・夕方)。自分の色(服・はだ)のまま明るくする */
  const uLit = { value: 0 };
  matCrowd.onBeforeCompile = (sh) => {
    sh.uniforms.uStLit = uLit;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', vsPars).replace('#include <begin_vertex>', vsBag)
      .replace('#include <color_vertex>', '#include <color_vertex>\n#if defined( USE_INSTANCING_COLOR ) && defined( USE_COLOR )\n  vColor.xyz = mix( color.xyz, vColor.xyz, stCloth );\n#endif');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uStLit;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * uStLit;');
  };
  matCrowd.customProgramCacheKey = () => 'st-crowd';
  matCrowd.name = 'st-crowd';
  matCrowd.userData.noWeather = true;     // 屋根の下で待つ人の頭・肩に雪が積もらないように
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', vsPars).replace('#include <begin_vertex>', vsBag);
  };
  depth.customProgramCacheKey = () => 'st-crowd-d';
  /* 動く人(12人)用: 部品ごとの形(肩・股関節がまわる中心) */
  /* 動く人も待つ人と同じ材質(同じプログラム): 服の部分(stCloth=1)だけインスタンス色 */
  const CL = { stCloth: 1 }, EXN = ['stCloth', 'stBag'];
  const fig = {
    torso: mergeColored([[torso(), 0xffffff, CL]], EXN),
    head: mergeColored([...head(), [hair(), 0x1d1915]], EXN),
    leg: mergeColored([
      [new THREE.CylinderGeometry(0.06, 0.055, 0.78, 6, 1, true).translate(0, -0.39, 0), 0xffffff, CL],
      [new THREE.BoxGeometry(0.1, 0.06, 0.24).translate(0, -0.79, 0.04), 0x2e2f33],
    ], EXN),
    arm: mergeColored([[new THREE.CylinderGeometry(0.045, 0.04, 0.56, 5, 1, true).translate(0, -0.28, 0), 0xffffff, CL]], EXN),
  };
  const matFig = matCrowd;
  /* 遠くの駅の人(箱3つ・36三角形)。頂点属性は同じなので matCrowd のプログラムをそのまま使う */
  const crowdLite = mergeColored([
    [new THREE.BoxGeometry(0.36, 0.62, 0.24).translate(0, 1.12, 0), 0xffffff, { stCloth: 1 }],
    [new THREE.BoxGeometry(0.26, 0.82, 0.18).translate(0, 0.41, 0), 0x2c3138],
    [new THREE.BoxGeometry(0.2, 0.26, 0.21).translate(0, 1.58, 0), 0x6b5444],
  ], ['stCloth', 'stBag']);
  const R = rs._crowdRes = { v4: true, crowd, crowdLite, matCrowd, depth, fig, matFig, uLit };
  rs._keep.add(matCrowd); rs._keep.add(depth);
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
  const LB = lineBaker(rs);
  const doorUV = lineBoard(rs, 'door').uv;
  const tn = new THREE.Vector3(), dc = new THREE.Vector3();
  rs._crowdMeshes = [];
  rs.line.stations.forEach((st, si) => {
    const isTerm = !!T && st.name === '新宿';
    const ob = (W && W.obst[si]) || [];
    const stairs = sty[si].kind !== 'house' && !isTerm && !rs._inTunnel(st.s);
    /* ホームのはし(ターミナルは島式ホームの範囲) */
    const sMin = isTerm ? st.s - (T.up ? 150 : 163) : st.s - (stairs ? STAIR.foot - 2.5 : P_A - 5);
    const sMax = isTerm ? st.s + (T.up ? 24 : 12) : st.s + P_B - 3;
    const busy = isTerm ? 0.55 : 0.45;
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
      items.push({ p: f.p.clone().addScaledVector(f.left, lat).setY(f.p.y + 1.05), yaw, sc: 0.88 + rnd() * 0.2, col: cloth[Math.floor(rnd() * cloth.length)] });
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
          /* 足もとの印: へりから1.45m(点字ブロックのすぐうしろ) */
          frameInto(rs, ds, f);
          flatT(f, tn).multiplyScalar(-side);
          dc.copy(f.p).addScaledVector(f.left, P.edge + 1.45 * side);
          dc.y = f.p.y + 1.05 + 0.006;
          LB.quadFlat(dc, tn, 0.55, 0.45, doorUV);
          /* 運転台の窓の横(停止位置の前後)・乗る人(動く)が使うドアには並べない */
          if (side > 0 && ds > st.s - 16 && ds < st.s + 14) return;
          if (side > 0 && BOARD_DOORS.some((b) => Math.abs(st.s - b - ds) < 0.5)) return;
          if (rnd() > busy) return;
          const r = rnd();
          const nP = r < 0.4 ? 1 : r < 0.75 ? 2 : r < 0.9 ? 3 : 4;
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
      const nFree = (isTerm ? 15 : 0) + 6 + Math.floor(rnd() * 5);
      for (let i = 0, tries = 0; i < nFree && tries < 80; tries++) {
        const s = sMin + rnd() * (sMax - sMin);
        if (side > 0 && s > st.s - 16 && s < st.s + 14) continue;
        const lat = side > 0 ? 3.7 + rnd() * 0.9 : -6.75 - rnd() * 0.5;
        if (!free(s, lat, 0.3)) continue;
        put(s, lat, side, (rnd() - 0.5) * 2.2);
        i++;
      }
      /* ホームの先のほう(止まった運転台の前に見えるところ)にも数人。
       * 左は窓のすぐ横ではなく 7.5m 以上先の うしろ寄り(視界をふさがない) */
      const nFront = isTerm ? 0 : 3 + Math.floor(rnd() * 2);
      for (let i = 0, tries = 0; i < nFront && tries < 40; tries++) {
        const s = side > 0 ? st.s + 7.5 + rnd() * 6 : st.s + 4 + rnd() * 9.5;
        const lat = side > 0 ? 3.95 + rnd() * 0.65 : -6.6 - rnd() * 0.7;
        if (!free(s, lat, 0.3)) continue;
        put(s, lat, side, (rnd() - 0.5) * 2.6);
        i++;
      }
    });
    if (!items.length) return;
    const im = new THREE.InstancedMesh(R.crowd, R.matCrowd, items.length);
    items.forEach((it, i) => {
      q.setFromAxisAngle(UPV, it.yaw); sc.setScalar(it.sc);
      im.setMatrixAt(i, m4.compose(it.p, q, sc));
      col.setHex(it.col); im.setColorAt(i, col);
    });
    im.castShadow = true;
    im.customDepthMaterial = R.depth;
    im.userData.noSplit = true; im.userData.st = true;
    im.computeBoundingSphere();
    rs.world.add(im);
    /* 遠近の切りかえ(updatePeople): カメラから160m以内の駅だけ細かい形+影 */
    rs._crowdMeshes.push({ im, a: st.s - P_A - 10, b: st.s + P_B + 10, lite: false });
  });

  /* 屋根から下がる駅名(表も裏も読める。なまえの部分だけ) */
  const n = new THREE.Vector3(), c = new THREE.Vector3(), tf = new THREE.Vector3();
  const rail = new THREE.BoxGeometry(1.94, 0.03, 0.05);
  rs.line.stations.forEach((st, si) => {
    if (T && st.name === '新宿') return;
    const SB = bakerFor(rs, W.signMats[si], W.signMats[si]);
    const B = stationBaker(rs, si);
    const under = rs._inTunnel(st.s);
    /* 屋根の下だけにつるす(屋根の短い駅は奥の1枚を手前に) */
    const far = under ? -112 : -Math.min(112, sty[si].roofA - 13);
    [1, -1].forEach((sg) => {
      [-28, far].forEach((ds) => {
        frameInto(rs, st.s + ds, f);
        flatT(f, n).negate();
        c.copy(f.p).addScaledVector(f.left, mid(sideOf(sg)));
        const hh = (1.9 * 138) / 512;
        c.y = f.p.y + 3.85 - hh / 2;
        SB.quad(c.clone().addScaledVector(n, 0.01), n, 1.9, hh, SIGN_UV.name);
        const nb = n.clone().negate();
        SB.quad(c.clone().addScaledVector(nb, 0.01), nb, 1.9, hh, SIGN_UV.name);
        if (!B) return;
        tf.crossVectors(UPV, n);
        const top = f.p.y + (under ? 6.2 : 4.4);
        [-0.7, 0.7].forEach((k) => B.post(c.x + tf.x * k, f.p.y + 3.85, c.z + tf.z * k, top - (f.p.y + 3.85), 0x6f777d));
        /* 板の上下の縁 */
        q.setFromAxisAngle(UPV, Math.atan2(n.x, n.z));
        [hh / 2 + 0.015, -hh / 2 - 0.015].forEach((dy) => B.geo(rail, { m: m4.compose(p.copy(c).setY(c.y + dy), q, sc.set(1, 1, 1)), col: 0x8d959b, white: true }));
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

/* ---------- 駅の人々(待つ・乗る・降りる)。12人を部品ごとのInstancedMeshで(描画4回) ---------- */
export function buildPeople(rs) {
  const R = crowdRes(rs);
  const shirt = [0x3e5a78, 0x7a4a42, 0x4a6b4e, 0x6b5a7c, 0x8a6d3b, 0x455a64, 0xa05a6e, 0x37657a, 0x94502e, 0x2e6e62, 0x714a71, 0x4f6636];
  const pants = [0x2b3138, 0x3a3f46, 0x4a4038, 0x333a42, 0x26303a];
  const NF = 12;
  const mk = (geo, n) => {
    const im = new THREE.InstancedMesh(geo, R.matFig, n);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.frustumCulled = false;
    im.userData.noSplit = true; im.userData.st = true;
    im.castShadow = true;
    rs.world.add(im);
    return im;
  };
  const P = rs._ppl = {
    torso: mk(R.fig.torso, NF), head: mk(R.fig.head, NF), leg: mk(R.fig.leg, NF * 2), arm: mk(R.fig.arm, NF * 2),
    m: new THREE.Matrix4(), m2: new THREE.Matrix4(), m3: new THREE.Matrix4(),
    q: new THREE.Quaternion(), sc: new THREE.Vector3(), pos: new THREE.Vector3(), tmp: new THREE.Vector3(),
    fr: newFrame(), dir: new THREE.Vector3(), any: true,
  };
  const col = new THREE.Color();
  rs.people = [];
  for (let i = 0; i < NF; i++) {
    col.setHex(shirt[i % shirt.length]);
    P.torso.setColorAt(i, col);
    P.arm.setColorAt(i * 2, col); P.arm.setColorAt(i * 2 + 1, col);
    col.setHex(pants[i % pants.length]);
    P.leg.setColorAt(i * 2, col); P.leg.setColorAt(i * 2 + 1, col);
    P.head.setColorAt(i, col.setRGB(1, 1, 1));   // 頭はインスタンス色なし(白)=待つ人と同じプログラム
    rs.people.push({ pos: new THREE.Vector3(), yaw: 0, ph: i * 1.7, legA: 0, armA: 0, bob: 0, vis: false, sc: 0.88 + (i % 5) * 0.05 });
  }
  hideAllPeople(rs);
}

function hideAllPeople(rs) {
  const P = rs._ppl;
  if (!P || !P.any) return;
  P.any = false;
  P.torso.visible = P.head.visible = P.leg.visible = P.arm.visible = false;
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
  const P = rs._ppl;
  const { m, m2, m3, q, sc, pos } = P;
  for (let i = 0; i < rs.people.length; i++) {
    const fig = rs.people[i];
    if (!fig.vis) {
      m.makeScale(0, 0, 0);
      P.torso.setMatrixAt(i, m); P.head.setMatrixAt(i, m);
      P.leg.setMatrixAt(i * 2, m); P.leg.setMatrixAt(i * 2 + 1, m);
      P.arm.setMatrixAt(i * 2, m); P.arm.setMatrixAt(i * 2 + 1, m);
      continue;
    }
    q.setFromAxisAngle(UPV, fig.yaw);
    sc.setScalar(fig.sc);
    pos.copy(fig.pos); pos.y += fig.bob;
    m.compose(pos, q, sc);
    P.torso.setMatrixAt(i, m);
    P.head.setMatrixAt(i, m);
    for (let k = 0; k < 2; k++) {
      const sx = k ? 1 : -1;
      m3.makeRotationX(k ? -fig.legA : fig.legA);
      m2.makeTranslation(sx * 0.08, 0.82, 0).multiply(m3).premultiply(m);
      P.leg.setMatrixAt(i * 2 + k, m2);
      m3.makeRotationX(k ? -fig.armA : fig.armA);
      m2.makeRotationZ(sx * 0.08).multiply(m3);
      m3.makeTranslation(sx * 0.23, 1.38, 0).multiply(m2).premultiply(m);
      P.arm.setMatrixAt(i * 2 + k, m3);
    }
  }
  P.torso.visible = P.head.visible = P.leg.visible = P.arm.visible = true;
  P.torso.instanceMatrix.needsUpdate = true; P.head.instanceMatrix.needsUpdate = true;
  P.leg.instanceMatrix.needsUpdate = true; P.arm.instanceMatrix.needsUpdate = true;
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
  /* 向かいホームの6人: 接近中は立って待ち、停車中は歩く流れ */
  for (let i = 6; i < 12; i++) {
    const fig = rs.people[i];
    const k = i - 6;
    let s, walking = 0;
    if (sim.doorOpen) {
      s = next.stopAt + 12 - ((rs.clockT * 8 + k * 29) % 172);
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
function updateCrowdLod(rs) {
  const list = rs._crowdMeshes, R = rs._crowdRes;
  if (!list || !R || !R.crowdLite) return;
  const cs = rs._camS != null ? rs._camS : rs.sim ? rs.sim.pos : 0;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    const d = cs < e.a ? e.a - cs : cs > e.b ? cs - e.b : 0;
    const lite = d > 160;
    if (lite === e.lite) continue;
    e.lite = lite;
    e.im.geometry = lite ? R.crowdLite : R.crowd;
    e.im.castShadow = !lite;
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
  M.poolStrip.opacity = night ? 0.7 : eve ? 0.25 : 0.12;
  /* 内照式の駅名標・時計: 夜は少しだけ1をこえて、ほんのりにじむ(いちばん明るい看板) */
  const lit = night ? 1.15 : eve ? 1.0 : 0.95;
  M.clock.color.setScalar(lit);
  W.signMats.forEach((m) => m.color.setScalar(lit));
  if (rs._atlas) rs._atlas.mat.emissiveIntensity = night || eve ? 0.5 : 0.12;   // 停止位置「8」などの標識
  if (W.termBld) W.termBld.emissiveIntensity = night ? 1.0 : eve ? 0.35 : 0;
  /* ホームの人: 夜・夕方はホームの灯りに照らされた明るさを足す(黒い影絵にならない) */
  if (rs._crowdRes && rs._crowdRes.uLit) rs._crowdRes.uLit.value = night ? 0.32 : eve ? 0.12 : 0;
  /* 信号の灯: 昼はあざやかな色(明るすぎると白っぽくなる)、夜は明るくしてにじませる */
  if (rs._sigRes && rs._sigRes.glowMat) rs._sigRes.glowMat.color.setScalar(night ? 1.3 : eve ? 0.95 : 0.5);
}
