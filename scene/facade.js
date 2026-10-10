/* =========================================================
 * scene/facade.js — 建物の外壁(マンション・オフィス・高層・雑居ビル・店先・戸建て)
 *
 * ・外壁テクスチャは「メートル単位で敷き詰める」タイル。単位の箱(BoxGeometry(1,1,1))を
 *   インスタンスごとに拡大しても、窓の大きさ・階の高さが本物どおり(約3m)になるよう、
 *   UVを頂点シェーダで「位置×拡大率」から作り直す(patchFacade)。
 * ・色は白っぽい下地に描き、インスタンス色(instanceColor)で壁の色味を付ける。
 * ・ORM画像を1枚にまとめる: R=夜に灯る窓のマスク / G=粗さ / B=金属度。emissiveMap として
 *   1回だけ読み、粗さ・金属度もそこから取る。ガラスだけ粗さが低く金属度があるので空が映り込む。
 * ・夜の窓明かりは建物ごと・窓ごとにハッシュで点灯/色温度を決める(全部同じ模様にならない)。
 *   昼夜の切り替えは uFcLit(共有ユニフォーム)と emissive の値だけ。シェーダは作り直さない。
 * ========================================================= */
import * as THREE from '../vendor/three.module.min.js';

/* 点灯率(夜 .38 / 夕方 .15 / 昼 0)。外壁の材質すべてで共有する */
export const uFcLit = { value: 0 };

/* ---- キャンバスはモジュールで1回だけ描く(路線を作り直しても使い回す) ---- */
const _cv = {};
function makeCanvas(w, h) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  return cv;
}
/* 決まった乱数(描くたびに同じ模様) */
function rngOf(seed) {
  let x = seed;
  return () => (x = (x * 16807) % 2147483647) / 2147483647;
}

/* 1種類の外壁を「色」と「ORM(+窓マスク)」の2枚に同時に描くための道具 */
function painter(w, h) {
  const col = makeCanvas(w, h), orm = makeCanvas(w, h);
  const c = col.getContext('2d'), o = orm.getContext('2d');
  return {
    col, orm, c, o,
    /* 壁: ORM=(窓0, 粗さ.9, 金属0) */
    wall(x, y, ww, hh, color, rough = 230, metal = 0) {
      c.fillStyle = color; c.fillRect(x, y, ww, hh);
      o.fillStyle = `rgb(0,${rough},${metal})`; o.fillRect(x, y, ww, hh);
    },
    /* ガラス: 縦グラデーション。lit=夜に灯る強さ(0..255) */
    glass(x, y, ww, hh, top, bot, lit = 255, rough = 38, metal = 128) {
      const g = c.createLinearGradient(0, y, 0, y + hh);
      g.addColorStop(0, top); g.addColorStop(1, bot);
      c.fillStyle = g; c.fillRect(x, y, ww, hh);
      o.fillStyle = `rgb(${lit},${rough},${metal})`; o.fillRect(x, y, ww, hh);
    },
    /* 色だけ(陰影・汚れ。ORMは変えない) */
    tint(x, y, ww, hh, color) { c.fillStyle = color; c.fillRect(x, y, ww, hh); },
    /* ORMだけ */
    ormRect(x, y, ww, hh, lit, rough, metal) { o.fillStyle = `rgb(${lit},${rough},${metal})`; o.fillRect(x, y, ww, hh); },
  };
}

/* ---------- マンション: 4区画×4階 = 13.6×12m (1階=3m, 1区画=3.4m) ---------- */
function drawMansion() {
  const P = painter(256, 256), r = rngOf(101);
  P.wall(0, 0, 256, 256, '#f3f2ee');
  for (let f = 0; f < 4; f++) {
    const y0 = f * 64;
    for (let b = 0; b < 4; b++) {
      const x0 = b * 64;
      /* 掃き出しの引き違い窓(中央に召し合わせの縦框) */
      P.glass(x0 + 9, y0 + 8, 46, 42, '#a3b6c6', '#3b4752');
      P.tint(x0 + 8, y0 + 7, 48, 1.5, 'rgba(90,96,102,.9)');
      P.tint(x0 + 31, y0 + 8, 2, 42, 'rgba(120,126,130,.95)');
      P.ormRect(x0 + 31, y0 + 8, 2, 42, 0, 110, 150);
      /* レースのカーテン(35%の窓・片側の障子) */
      if (r() < 0.35) {
        const cx = r() < 0.5 ? x0 + 9 : x0 + 33;
        P.tint(cx, y0 + 9, 22, 40, 'rgba(236,230,216,.85)');
        for (let k = 3; k < 22; k += 4) P.tint(cx + k, y0 + 9, 1, 40, 'rgba(0,0,0,.07)');
        P.ormRect(cx, y0 + 9, 22, 40, 230, 200, 0);
      }
      /* 空の映り込み(斜めのハイライト) */
      P.tint(x0 + 12, y0 + 10, 8, 10, 'rgba(255,255,255,.10)');
      /* 室外機(半分の区画。手すり壁の上から上半分がのぞく) */
      if (r() < 0.5) {
        const ax = x0 + 38 - Math.floor(r() * 26);
        P.wall(ax, y0 + 35, 16, 11, '#d9d9d4', 160, 40);
        P.c.strokeStyle = 'rgba(60,64,66,.75)'; P.c.lineWidth = 1;
        P.c.beginPath(); P.c.arc(ax + 6, y0 + 40.5, 3.6, 0, 7); P.c.stroke();
        P.tint(ax, y0 + 45, 16, 1, 'rgba(0,0,0,.25)');
      }
      /* 隣の住戸との隔て板 */
      P.wall(x0, y0 + 6, 3, 58, '#e9e7e1', 200, 0);
      P.tint(x0 + 3, y0 + 6, 1, 58, 'rgba(0,0,0,.10)');
    }
    /* バルコニーの手すり壁(下の20px)+上の床スラブの影 */
    P.wall(0, y0 + 44, 256, 20, '#f3f1ec');
    P.tint(0, y0 + 44, 256, 1, 'rgba(255,255,255,.6)');
    P.tint(0, y0 + 62, 256, 2, 'rgba(0,0,0,.08)');
    P.tint(0, y0, 256, 3, 'rgba(0,0,0,.28)');            // スラブの小口の影
    P.tint(0, y0 + 3, 256, 1, 'rgba(255,255,255,.35)');
    P.tint(0, y0 + 4, 256, 4, 'rgba(0,0,0,.12)');         // 軒裏(ソフィット)の影
  }
  return P;
}

/* ---------- オフィス: 横連窓(階高の6割がガラス) 14.4×15.2m (1階=3.8m, 方立て1.8mおき) ---------- */
function drawOffice() {
  const P = painter(256, 256), r = rngOf(202);
  P.wall(0, 0, 256, 256, '#eeefee', 200, 30);
  for (let f = 0; f < 4; f++) {
    const y0 = f * 64;
    P.glass(0, y0 + 14, 256, 38, '#b3c5d3', '#4d6273', 255, 30, 150);
    for (let x = 0; x < 256; x += 32) {
      /* ガラス1枚ごとに映り込みの明るさを少し変える */
      P.tint(x + 2, y0 + 14, 30, 38, `rgba(255,255,255,${(r() * 0.12).toFixed(3)})`);
      P.tint(x, y0 + 14, 2, 38, 'rgba(70,78,84,.95)');
      P.ormRect(x, y0 + 14, 2, 38, 0, 90, 180);
    }
    P.tint(0, y0 + 12, 256, 2, 'rgba(0,0,0,.25)');
    P.tint(0, y0 + 52, 256, 2, 'rgba(255,255,255,.5)');
    P.tint(0, y0 + 58, 256, 1, 'rgba(0,0,0,.08)');
  }
  return P;
}

/* ---------- 超高層: 縦フィン(0.8mおき)+ガラス 12.8×16m (1階=4m) ---------- */
function drawTower() {
  const P = painter(256, 256);
  P.glass(0, 0, 256, 256, '#b9c9d6', '#6f8698', 255, 25, 160);
  for (let f = 0; f < 4; f++) {
    const y0 = f * 64;
    P.wall(0, y0 + 56, 256, 8, '#c9d0d6', 170, 60);     // 階の境(スパンドレル)
    P.tint(0, y0 + 56, 256, 1, 'rgba(0,0,0,.18)');
  }
  /* 斜めの映り込みの筋 */
  P.c.save();
  P.c.globalCompositeOperation = 'source-over';
  const g = P.c.createLinearGradient(0, 0, 256, 256);
  g.addColorStop(0.0, 'rgba(255,255,255,0)');
  g.addColorStop(0.42, 'rgba(255,255,255,0)');
  g.addColorStop(0.5, 'rgba(255,255,255,.22)');
  g.addColorStop(0.58, 'rgba(255,255,255,0)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  P.c.fillStyle = g; P.c.fillRect(0, 0, 256, 256);
  P.c.restore();
  for (let x = 0; x < 256; x += 16) {
    P.wall(x, 0, 4, 256, '#e6eaee', 120, 120);
    P.tint(x + 4, 0, 1, 256, 'rgba(0,0,0,.18)');
  }
  return P;
}

/* ---------- 雑居ビル: タイル張り+縦長の窓 9.6×13.2m (1階=3.3m, 3区画) ---------- */
function drawZakkyo() {
  const P = painter(256, 256), r = rngOf(303);
  P.wall(0, 0, 256, 256, '#f0ede7');
  /* タイルの目地 */
  for (let y = 0; y < 256; y += 6) P.tint(0, y, 256, 1, 'rgba(0,0,0,.05)');
  for (let x = 0; x < 256; x += 12) P.tint(x, 0, 1, 256, 'rgba(0,0,0,.035)');
  for (let f = 0; f < 4; f++) {
    const y0 = f * 64;
    for (let b = 0; b < 3; b++) {
      const x0 = Math.round(b * 85.33);
      const two = r() < 0.6;
      const wins = two ? [[x0 + 12, 26], [x0 + 47, 26]] : [[x0 + 14, 56]];
      wins.forEach(([wx, ww]) => {
        P.wall(wx - 2, y0 + 10, ww + 4, 44, '#9aa0a4', 120, 120);   // サッシ枠
        P.glass(wx, y0 + 12, ww, 40, '#a7b8c4', '#46525c');
        P.tint(wx, y0 + 12, ww, 2, 'rgba(0,0,0,.25)');
        if (r() < 0.3) { P.tint(wx + 1, y0 + 13, ww - 2, 38, 'rgba(232,228,214,.8)'); P.ormRect(wx + 1, y0 + 13, ww - 2, 38, 220, 200, 0); }
      });
      /* 窓下の水切り */
      P.tint(x0 + 8, y0 + 54, 70, 2, 'rgba(0,0,0,.18)');
    }
    P.tint(0, y0 + 62, 256, 2, 'rgba(0,0,0,.10)');
  }
  return P;
}

/* ---------- 1階の店先: 14.4×4.2m に3軒(看板は文字なしの無地パネル) ---------- */
const AWN = ['#8c5b4e', '#4f6b7d', '#6b7a55', '#a08a5c', '#6e6370'];
function drawShop() {
  const P = painter(256, 64), r = rngOf(404);
  P.wall(0, 0, 256, 64, '#e9e7e2');
  for (let b = 0; b < 3; b++) {
    const x0 = Math.round(b * 85.33), w = 85;
    /* 看板パネル(無地・夜はほんのり灯る) */
    P.wall(x0 + 3, 1, w - 6, 11, ['#f4f2ec', '#e9eef2', '#f1ece2'][b % 3]);
    P.ormRect(x0 + 3, 1, w - 6, 11, 150, 160, 0);
    P.tint(x0 + 3, 11, w - 6, 1, 'rgba(0,0,0,.2)');
    /* ひさし(落ち着いた5色) */
    P.wall(x0 + 2, 12, w - 4, 7, AWN[Math.floor(r() * AWN.length)], 200, 0);
    P.tint(x0 + 2, 18, w - 4, 1, 'rgba(0,0,0,.35)');
    if (r() < 0.3) {
      /* シャッター */
      P.wall(x0 + 4, 20, w - 8, 40, '#c4c5c2', 150, 90);
      for (let y = 22; y < 60; y += 3) P.tint(x0 + 4, y, w - 8, 1, 'rgba(0,0,0,.12)');
    } else {
      /* ガラスの店先(中の棚がうっすら見える) */
      P.glass(x0 + 4, 20, w - 8, 40, '#7d8c96', '#2a3138', 255, 40, 110);
      for (let k = 0; k < 4; k++) P.tint(x0 + 8 + k * 19, 34 + (k % 2) * 6, 14, 18, `rgba(${180 + Math.floor(r() * 60)},${170 + Math.floor(r() * 50)},${150 + Math.floor(r() * 40)},.18)`);
      P.tint(x0 + 4 + (w - 8) / 2, 20, 2, 40, 'rgba(60,66,70,.9)');
      P.tint(x0 + 10, 22, 10, 30, 'rgba(255,255,255,.08)');
    }
    P.tint(x0, 0, 3, 64, 'rgba(0,0,0,.12)');
  }
  P.wall(0, 60, 256, 4, '#6d6c69', 220, 0);
  return P;
}

/* ---------- 戸建て(サイディング): 8m×9m。1階=掃き出し窓+玄関ドア / 2階=窓2つ+バルコニー ---------- */
function drawHouse() {
  const P = painter(128, 128);
  const Y = (m) => Math.round(128 - m * 14.22);    // 高さ(m)→キャンバスのy
  P.wall(0, 0, 128, 128, '#f2f1ed');
  for (let y = 0; y < 128; y += 4) P.tint(0, y, 128, 1, 'rgba(0,0,0,.06)');   // サイディングの目地
  P.wall(0, Y(0.35), 128, 128 - Y(0.35), '#b9b6ae');                           // 基礎
  /* 1階: 掃き出し窓(左)と玄関ドア(右) */
  P.wall(9, Y(2.25), 38, Y(0.35) - Y(2.25), '#8d9195', 120, 120);
  P.glass(11, Y(2.15), 34, Y(0.4) - Y(2.15), '#a4b5c2', '#3e4952');
  P.tint(27, Y(2.15), 2, Y(0.4) - Y(2.15), 'rgba(110,116,120,.95)');
  P.wall(86, Y(2.2), 20, Y(0.35) - Y(2.2), '#6b5844', 180, 0);
  P.tint(88, Y(2.1), 3, Y(0.5) - Y(2.1), 'rgba(255,255,255,.12)');
  P.tint(100, Y(1.2), 2, 3, 'rgba(220,210,170,.9)');
  P.tint(84, Y(2.45), 24, 3, 'rgba(0,0,0,.3)');                                 // 玄関ひさしの影
  /* 2階: 窓2つ + バルコニーの白い手すり */
  [[18, 3.55, 26, 1.45], [66, 3.75, 18, 1.15]].forEach(([x, y1, w, h]) => {
    P.wall(x - 2, Y(y1 + h + 0.1), w + 4, Y(y1 - 0.1) - Y(y1 + h + 0.1), '#8d9195', 120, 120);
    P.glass(x, Y(y1 + h), w, Y(y1) - Y(y1 + h), '#a4b5c2', '#3e4952');
  });
  P.wall(14, Y(3.85), 36, Y(2.95) - Y(3.85), '#f7f7f4');                       // バルコニー
  P.tint(14, Y(2.95), 36, 2, 'rgba(0,0,0,.25)');
  for (let x = 16; x < 50; x += 4) P.tint(x, Y(3.8), 1, Y(3.0) - Y(3.8), 'rgba(0,0,0,.06)');
  /* 3階(3階建てだけ見える高さ)・妻壁の小窓 */
  P.wall(48, Y(7.7), 26, Y(6.5) - Y(7.7), '#8d9195', 120, 120);
  P.glass(50, Y(7.6), 22, Y(6.6) - Y(7.6), '#a4b5c2', '#3e4952');
  /* 雨どい */
  P.wall(123, 0, 2, 128, '#8a8780', 200, 30);
  return P;
}

/* 種類ごとの設定。tile=1枚の大きさ(m) grid=1枚の窓の数(列,階) steps=建物ごとにずらす刻み */
export const FACADE = {
  mansion: { draw: drawMansion, tile: [13.6, 12], grid: [4, 4], steps: [4, 4], roof: 0x5a5854, bay: 3.4, fh: 3.0 },
  office:  { draw: drawOffice,  tile: [14.4, 15.2], grid: [4, 4], steps: [8, 4], roof: 0x56585a, bay: 3.6, fh: 3.8 },
  tower:   { draw: drawTower,   tile: [12.8, 16], grid: [4, 4], steps: [4, 4], roof: 0x4e5256, bay: 3.2, fh: 4.0 },
  zakkyo:  { draw: drawZakkyo,  tile: [9.6, 13.2], grid: [3, 4], steps: [3, 4], roof: 0x585550, bay: 3.2, fh: 3.3 },
  shop:    { draw: drawShop,    tile: [14.4, 4.2], grid: [3, 1], steps: [3, 1], roof: 0x8f8d88, bay: 4.8, fh: 4.2 },
  house:   { draw: drawHouse,   tile: [8, 9], grid: [2, 3], steps: [2, 1], roof: 0x55534f, bay: 4.0, fh: 2.9 },
};

function canvasesOf(name) {
  if (!_cv[name]) {
    const P = FACADE[name].draw();
    /* 左下の数画素は必ず「壁」(屋上がここを読む: 粗く金属でない) */
    P.ormRect(0, P.orm.height - 4, 6, 4, 0, 225, 0);
    _cv[name] = P;
  }
  return _cv[name];
}

/* 外壁シェーダ: 世界スケールUV・屋上(パラペット)・コーニス・夜の窓明かり */
const PARS_V = /* glsl */`
uniform vec2 uFcTile;
uniform vec2 uFcSteps;
uniform float uFcV0;
varying vec2 vFcUv;
varying float vFcSeed;
varying float vFcRoof;
varying float vFcTop;
varying float vFcEdge;
`;
const MAIN_V = /* glsl */`
#ifdef USE_INSTANCING
{
  vec3 fcSc = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
  float fcU = abs(normal.x) > .5 ? (.5 - sign(normal.x) * position.z) * fcSc.z : (.5 + sign(normal.z) * position.x) * fcSc.x;
  vec2 fcW = vec2(fcU, position.y * fcSc.y - uFcV0) / uFcTile;
  /* 建物ごとの乱数。補間の誤差で窓の中がざらつかないよう 1/4096 の刻みの真ん中にそろえる */
  vFcSeed = (floor(fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898, 78.233))) * 43758.5453) * 4096.) + .5) / 4096.;
  fcW += floor(vec2(vFcSeed, fract(vFcSeed * 13.)) * uFcSteps) / max(uFcSteps, vec2(1.));
  vFcRoof = step(.5, normal.y);
  vFcTop = (1. - position.y) * fcSc.y;
  vFcEdge = (.5 - max(abs(position.x), abs(position.z))) * min(fcSc.x, fcSc.z);
  vFcUv = fcW;
  /* 屋上は壁の画素(タイル左下=腰壁)を読ませる(ガラスの映り込みを出さない) */
  fcW = mix(fcW, vec2(.002), vFcRoof);
  #ifdef USE_MAP
  vMapUv = fcW;
  #endif
  #ifdef USE_EMISSIVEMAP
  vEmissiveMapUv = fcW;
  #endif
  #ifdef USE_ROUGHNESSMAP
  vRoughnessMapUv = fcW;
  #endif
  #ifdef USE_METALNESSMAP
  vMetalnessMapUv = fcW;
  #endif
}
#endif
`;
const PARS_F = /* glsl */`
uniform vec3 uFcRoof;
uniform vec2 uFcGrid;
uniform float uFcLit;
uniform float uFcBoost;
varying vec2 vFcUv;
varying float vFcSeed;
varying float vFcRoof;
varying float vFcTop;
varying float vFcEdge;
float fcH12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
`;
const COLOR_F = /* glsl */`
if (vFcRoof > .5) {
  /* 屋上: 防水シートの色 + 縁の立ち上がり(パラペット35cm)を明るく */
  float fcRs = fract(floor(vFcSeed * 4096.) * .00179);
  vec3 fcR = uFcRoof * (.75 + .5 * fcRs);
  fcR *= mix(vec3(1.), vec3(.86, 1., .9), step(.82, fract(fcRs * 7.3)));   // 緑っぽい防水塗装もまぜる
  diffuseColor.rgb = mix(fcR, fcR * 1.4, step(vFcEdge, .35));
} else if (vFcTop < .6) {
  diffuseColor.rgb *= .78;   // 最上部のコーニス(笠木)
}
`;
const EMIT_F = /* glsl */`
{
  /* 窓ごと・建物ごとに点灯と色温度を変える(暖色/昼白色/テレビの青) */
  vec2 fcCell = floor(vFcUv * uFcGrid);
  float fcSd = floor(vFcSeed * 4096.) / 4096.;
  float fcL = uFcLit * uFcBoost;
  float fcOn = step(fcH12(fcCell + fcSd * 91.7), fcL);
  fcOn = max(fcOn, step(fcH12(vec2(fcCell.y, fcSd * 7.)), .12 * step(.001, fcL)));
  float fcHu = fcH12(fcCell * 1.73 + fcSd * 13.1);
  vec3 fcWc = fcHu < .55 ? vec3(1., .78, .45) : fcHu < .85 ? vec3(.85, .93, 1.) : vec3(.33, .39, .6);
  #ifdef USE_EMISSIVEMAP
  /* ORM(R=窓マスク G=粗さ B=金属度)は emissiveMap として1回だけ読む(粗さ・金属度もここから) */
  totalEmissiveRadiance = emissive * emissiveColor.r;
  roughnessFactor *= emissiveColor.g;
  metalnessFactor *= emissiveColor.b;
  #endif
  totalEmissiveRadiance *= fcWc * fcOn * (.7 + .6 * fcH12(fcCell + 3.1)) * (1. - vFcRoof);
}
`;

/* mat: MeshStandardMaterial。opt: {tile:[m,m], grid:[列,階], steps, roofCol, key, v0, boost} */
export function patchFacade(mat, opt) {
  const u = {
    uFcTile: { value: new THREE.Vector2(opt.tile[0], opt.tile[1]) },
    uFcGrid: { value: new THREE.Vector2(opt.grid[0], opt.grid[1]) },
    uFcSteps: { value: new THREE.Vector2(...(opt.steps || opt.grid)) },
    uFcRoof: { value: new THREE.Color(opt.roofCol != null ? opt.roofCol : 0x8f8d88) },
    uFcV0: { value: opt.v0 != null ? opt.v0 : 0.6 },
    uFcBoost: { value: opt.boost || 1 },
    uFcLit,
  };
  mat.userData.fc = u;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + PARS_V)
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n' + MAIN_V);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + PARS_F)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + COLOR_F)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + EMIT_F);
  };
  const key = 'fc-' + (opt.key || 'bld');
  mat.customProgramCacheKey = () => key;
  return mat;
}

/* 外壁材質(種類ごとに1つ)。テクスチャ・材質は RailScene ごとに1回作って使い回す */
export function facadeMaterial(name, aniso = 4) {
  const d = FACADE[name];
  const P = canvasesOf(name);
  const map = new THREE.CanvasTexture(P.col);
  map.colorSpace = THREE.SRGBColorSpace;
  const orm = new THREE.CanvasTexture(P.orm);   // データなので色空間なし(リニア)
  [map, orm].forEach((t) => { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = aniso; });
  /* roughnessMap/metalnessMap は付けない(同じ画像を3回読まないよう、シェーダで emissiveMap から取り出す) */
  const mat = new THREE.MeshStandardMaterial({
    map, emissiveMap: orm,
    roughness: 1, metalness: 1, emissive: 0x000000, envMapIntensity: 1,
  });
  patchFacade(mat, { tile: d.tile, grid: d.grid, steps: d.steps, roofCol: d.roof, key: 'bld', boost: name === 'shop' ? 1.9 : name === 'house' ? 1.1 : 1 });
  mat.userData.fcTex = [map, orm];
  return mat;
}

/* 外壁キャンバスのメモリ量(確認用。w*h*4 の合計) */
export function facadeCanvasBytes() {
  let n = 0;
  Object.keys(FACADE).forEach((k) => { const P = canvasesOf(k); n += (P.col.width * P.col.height + P.orm.width * P.orm.height) * 4; });
  return n;
}
