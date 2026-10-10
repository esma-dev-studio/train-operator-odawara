/* =========================================================
 * scene/facade.js — 建物の外壁(マンション・オフィス・高層・雑居ビル・店先・戸建て)
 *
 * ・外壁テクスチャは「メートル単位で敷き詰める」タイル。単位の箱(BoxGeometry(1,1,1))を
 *   インスタンスごとに拡大しても、窓の大きさ・階の高さが本物どおり(約3m)になるよう、
 *   UVを頂点シェーダで「位置×拡大率」から作り直す(patchFacade)。
 * ・色は白っぽい下地に描き、インスタンス色(instanceColor)で壁の色味を付ける。
 * ・ORM画像を1枚にまとめる: R=夜に灯る窓のマスク / G=粗さ / B=金属度。emissiveMap として
 *   1回だけ読み(emissivemap_fragment を置きかえ)、粗さ・金属度もそこから取る。ガラスだけ粗さが低く金属度があるので空が映り込む。
 *   R が .35〜.65 で G が .94 以上の画素は「常夜灯」(看板・ひさしの下・門灯・外廊下の灯り): 夜は部屋の点灯に関係なく光る。
 * ・夜の窓明かりは建物ごと・窓ごとにハッシュで点灯/色温度を決める(全部同じ模様にならない)。
 *   部屋の中(天井の灯り・カーテン・ブラインド・家具の影)もハッシュで描き分ける。低い階の壁は街の照り返しで暖かく。
 *   昼夜の切り替えは uFcLit・uFcAmb(共有ユニフォーム)と emissive の値だけ。シェーダは作り直さない。
 * ・妻壁(線路方向の端の面)と塔屋は窓なしの壁(uFcSide)。ガラスは壁の色に染めすぎない。地面ぎわの汚れと雨だれの筋。
 * ========================================================= */
import * as THREE from '../vendor/three.module.min.js';

/* 点灯率(夜 .38 / 夕方 .15 / 昼 0)。外壁の材質すべてで共有する */
export const uFcLit = { value: 0 };
/* 街の照り返し(低い階の壁を道の灯りで暖かく。夜 1 / 夕方 .25 / 昼 0)。外壁の材質すべてで共有する */
export const uFcAmb = { value: 0 };

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

/* ---------- マンション: 2住戸×4階 = 13.6×12m (1住戸=6.8m, 1階=3m) ----------
 * 1住戸 = 掃き出し窓(居間)+腰窓(個室)+となりとの隔て板1枚。
 * 夜に灯る区画(64px=3.4m)は「掃き出し窓」「腰窓」に1つずつ。室外機は手すり壁の上に置き、ガラスには重ねない */
function drawMansion() {
  const P = painter(256, 256), r = rngOf(101);
  P.wall(0, 0, 256, 256, '#f3f2ee');
  for (let f = 0; f < 4; f++) {
    const y0 = f * 64;
    for (let u = 0; u < 2; u++) {
      const x0 = u * 128;
      /* 掃き出しの引き違い窓(中央に召し合わせの縦框) */
      P.glass(x0 + 10, y0 + 8, 52, 42, '#a3b6c6', '#3b4752');
      P.tint(x0 + 9, y0 + 7, 54, 1.5, 'rgba(90,96,102,.9)');
      P.tint(x0 + 35, y0 + 8, 2, 42, 'rgba(120,126,130,.95)');
      P.ormRect(x0 + 35, y0 + 8, 2, 42, 0, 110, 150);
      /* レースのカーテン(35%の窓・片側の障子) */
      if (r() < 0.35) {
        const cx = r() < 0.5 ? x0 + 10 : x0 + 37;
        P.tint(cx, y0 + 9, 25, 40, 'rgba(236,230,216,.85)');
        for (let k = 3; k < 25; k += 4) P.tint(cx + k, y0 + 9, 1, 40, 'rgba(0,0,0,.07)');
        P.ormRect(cx, y0 + 9, 25, 40, 230, 200, 0);
      }
      /* 空の映り込み(斜めのハイライト) */
      P.tint(x0 + 13, y0 + 10, 8, 10, 'rgba(255,255,255,.10)');
      /* 腰窓(個室)。サッシ枠+召し合わせ */
      P.wall(x0 + 74, y0 + 12, 40, 30, '#9aa0a4', 120, 120);
      P.glass(x0 + 76, y0 + 14, 36, 26, '#a7b8c4', '#46525c');
      P.tint(x0 + 93, y0 + 14, 2, 26, 'rgba(120,126,130,.95)');
      P.ormRect(x0 + 93, y0 + 14, 2, 26, 0, 110, 150);
      P.tint(x0 + 76, y0 + 14, 36, 2, 'rgba(0,0,0,.25)');
      if (r() < 0.3) { P.tint(x0 + 77, y0 + 16, 34, 23, 'rgba(232,228,214,.8)'); P.ormRect(x0 + 77, y0 + 16, 34, 23, 220, 200, 0); }
      /* となりの住戸との隔て板(1住戸に1枚) */
      P.wall(x0 + 122, y0 + 6, 6, 58, '#e9e7e1', 200, 0);
      P.tint(x0 + 121, y0 + 6, 1, 58, 'rgba(0,0,0,.10)');
    }
    /* バルコニーの手すり壁(下の20px) */
    P.wall(0, y0 + 44, 256, 20, '#f3f1ec');
    P.tint(0, y0 + 44, 256, 1, 'rgba(255,255,255,.6)');
    P.tint(0, y0 + 62, 256, 2, 'rgba(0,0,0,.08)');
    /* 室外機: 手すり壁の上(y0+44..55)。ガラスの画素には重ねない(夜の窓に黒い欠けが出ないように) */
    for (let u = 0; u < 2; u++) {
      if (r() < 0.6) {
        const ax = u * 128 + 64 + Math.floor(r() * 40);
        P.wall(ax, y0 + 44, 16, 11, '#d9d9d4', 160, 40);
        P.c.strokeStyle = 'rgba(60,64,66,.75)'; P.c.lineWidth = 1;
        P.c.beginPath(); P.c.arc(ax + 6, y0 + 49.5, 3.6, 0, 7); P.c.stroke();
        P.tint(ax, y0 + 54, 16, 1, 'rgba(0,0,0,.25)');
      }
    }
    P.tint(0, y0, 256, 3, 'rgba(0,0,0,.28)');            // スラブの小口の影
    P.tint(0, y0 + 3, 256, 1, 'rgba(255,255,255,.35)');
    P.tint(0, y0 + 4, 256, 4, 'rgba(0,0,0,.12)');         // 軒裏(ソフィット)の影
  }
  return P;
}

/* ---------- 外廊下(そとろうか)のマンション: 2住戸×4階 = 13.6×12m ----------
 * 1住戸 = 鋼製の玄関ドア+メーターボックス+面格子つきのすりガラス窓+ブラケット灯。
 * ブラケット灯と天井の照り返しは ORM R=150/96・G=250(いつも点く灯りの帯)。夜は部屋が暗くても廊下の灯りが列になる。
 * 左はしの数px(妻壁が読む列)には灯り・窓を置かない */
function drawCorridor() {
  const P = painter(256, 256), r = rngOf(505);
  P.wall(0, 0, 256, 256, '#ecebe6');
  for (let f = 0; f < 4; f++) {
    const y0 = f * 64;
    P.tint(0, y0, 256, 10, 'rgba(0,0,0,.35)');          // 廊下の天井の影(奥まって暗い)
    P.tint(0, y0 + 10, 256, 34, 'rgba(0,0,0,.05)');     // 廊下の奥の壁
    for (let u = 0; u < 2; u++) {
      const x0 = u * 128;
      /* 玄関ドア(鋼製・2色) */
      P.wall(x0 + 14, y0 + 12, 19, 43, r() < 0.5 ? '#6b5e52' : '#7a7f84', 120, 120);
      P.tint(x0 + 14, y0 + 12, 19, 1, 'rgba(255,255,255,.18)');
      P.tint(x0 + 15, y0 + 13, 1, 31, 'rgba(0,0,0,.18)');
      P.tint(x0 + 29, y0 + 29, 2, 5, 'rgba(214,208,192,.95)');   // ドアノブ
      /* メーターボックス */
      P.wall(x0 + 36, y0 + 20, 14, 20, '#d9d9d2', 200, 20);
      P.tint(x0 + 36, y0 + 29, 14, 1, 'rgba(0,0,0,.15)');
      P.tint(x0 + 36, y0 + 39, 14, 1, 'rgba(0,0,0,.2)');
      /* 面格子(めんごうし)つきのすりガラス窓(粗いガラス: 空は映らない) */
      P.wall(x0 + 56, y0 + 20, 44, 22, '#9aa0a4', 120, 120);
      P.glass(x0 + 58, y0 + 22, 40, 18, '#d3d8da', '#b2b9bd', 255, 170, 0);
      for (let x = x0 + 59; x < x0 + 98; x += 4) {
        P.tint(x, y0 + 21, 1, 20, 'rgba(78,82,86,.9)');
        P.ormRect(x, y0 + 21, 1, 20, 0, 120, 120);
      }
      /* ブラケット灯(ドアの横。夜はいつも点く) */
      P.wall(x0 + 36, y0 + 12, 8, 5, '#f7f3e6', 250, 0);
      P.ormRect(x0 + 36, y0 + 12, 8, 5, 150, 250, 0);
    }
    /* 天井の照り返し(灯りの帯。妻壁が読む左はしは空ける) */
    P.ormRect(8, y0 + 10, 240, 3, 96, 250, 0);
    /* 廊下の手すり壁(笠木のハイライトつき) */
    P.wall(0, y0 + 44, 256, 20, '#f1efe9');
    P.tint(0, y0 + 44, 256, 2, 'rgba(255,255,255,.7)');
    P.tint(0, y0 + 46, 256, 1, 'rgba(0,0,0,.08)');
    P.tint(0, y0 + 62, 256, 2, 'rgba(0,0,0,.10)');
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

/* ---------- 1階の店先: 14.4×4.2m に3軒(看板は文字なしの無地パネル。文字の看板は shopsign.js で上に重ねる) ----------
 * 看板パネル(R=130)と ひさしの下の帯(R=105)は G=250 の「いつも点く灯りの帯」: 夜は お店の明かりが道にこぼれる */
const AWN = ['#8c5b4e', '#4f6b7d', '#6b7a55', '#a08a5c', '#6e6370'];
function drawShop() {
  const P = painter(256, 64), r = rngOf(404);
  P.wall(0, 0, 256, 64, '#e9e7e2');
  for (let b = 0; b < 3; b++) {
    const x0 = Math.round(b * 85.33), w = 85;
    /* 看板パネル(無地・夜はほんのり灯る) */
    P.wall(x0 + 3, 1, w - 6, 11, ['#f4f2ec', '#e9eef2', '#f1ece2'][b % 3]);
    P.ormRect(x0 + 3, 1, w - 6, 11, 130, 250, 0);
    P.tint(x0 + 3, 11, w - 6, 1, 'rgba(0,0,0,.2)');
    /* ひさし(落ち着いた5色) */
    P.wall(x0 + 2, 12, w - 4, 7, AWN[Math.floor(r() * AWN.length)], 200, 0);
    P.tint(x0 + 2, 18, w - 4, 1, 'rgba(0,0,0,.35)');
    P.ormRect(x0 + 4, 19, w - 8, 2, 105, 250, 0);         // ひさしの下の灯り(夜だけ。看板より暗め)
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
  /* 門灯(もんとう。夜はいつも点く灯りの帯 R=140) */
  P.wall(80, Y(2.4), 4, 4, '#f4efe0', 250, 0);
  P.ormRect(80, Y(2.4), 4, 4, 140, 250, 0);
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

/* 種類ごとの設定。tile=1枚の大きさ(m) grid=1枚の窓の数(列,階) steps=建物ごとにずらす刻み
 * side=[妻壁を窓なしにするか, 妻壁が読む「壁だけの列」のu]: 線路方向の端の面(となりの建物とくっつく側)と塔屋 */
export const FACADE = {
  mansion:  { draw: drawMansion,  tile: [13.6, 12], grid: [4, 4], steps: [2, 4], roof: 0x5a5854, bay: 3.4, fh: 3.0, side: [1, 1.5 / 256] },
  corridor: { draw: drawCorridor, tile: [13.6, 12], grid: [2, 4], steps: [2, 4], roof: 0x5a5854, bay: 3.4, fh: 3.0, side: [1, 1.5 / 256] },
  office:   { draw: drawOffice,   tile: [14.4, 15.2], grid: [4, 4], steps: [8, 4], roof: 0x56585a, bay: 3.6, fh: 3.8, side: [0, 0] },
  tower:    { draw: drawTower,    tile: [12.8, 16], grid: [4, 4], steps: [4, 4], roof: 0x4e5256, bay: 3.2, fh: 4.0, side: [0, 0] },
  zakkyo:   { draw: drawZakkyo,   tile: [9.6, 13.2], grid: [3, 4], steps: [3, 4], roof: 0x585550, bay: 3.2, fh: 3.3, side: [1, 4 / 256] },
  shop:     { draw: drawShop,     tile: [14.4, 4.2], grid: [3, 1], steps: [3, 1], roof: 0x8f8d88, bay: 4.8, fh: 4.2, side: [0, 0] },
  house:    { draw: drawHouse,    tile: [8, 9], grid: [2, 3], steps: [2, 1], roof: 0x55534f, bay: 4.0, fh: 2.9, side: [0, 0] },
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

/* 外壁シェーダ: 世界スケールUV・屋上(パラペット)・コーニス・妻壁・汚れ・夜の窓明かりと常夜灯・街の照り返し */
const PARS_V = /* glsl */`
uniform vec2 uFcTile;
uniform vec2 uFcSteps;
uniform vec2 uFcSide;
uniform float uFcV0;
varying vec2 vFcUv;
varying float vFcSeed;
varying float vFcRoof;
varying float vFcTop;
varying float vFcEdge;
varying float vFcH;
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
  vFcH = position.y * fcSc.y;   // インスタンスの足もとからの高さ(m)
  vFcUv = fcW;
  /* 妻壁(線路方向の端の面。となりの建物とくっつく側)は7割の建物で窓なし、塔屋(高さ3.6m以下の箱)も窓なし:
   * 「壁だけの列」(uFcSide.y)を縦に読んで、階の帯だけを出す。vFcUv はそのまま(マスクがR=0なので夜も灯らない) */
  float fcPh = step(fcSc.y, 3.6) * uFcSide.x;
  float fcSide = max(step(.5, abs(normal.z)) * uFcSide.x * step(.3, fract(vFcSeed * 31.7)), fcPh * (1. - vFcRoof));
  fcW.x = mix(fcW.x, uFcSide.y, fcSide);
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
uniform float uFcAmb;
varying vec2 vFcUv;
varying float vFcSeed;
varying float vFcRoof;
varying float vFcTop;
varying float vFcEdge;
varying float vFcH;
float fcH12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
`;
const COLOR_F = /* glsl */`
/* ORM(R=窓マスク・常夜灯 / G=粗さ / B=金属度)は emissiveMap として ここで1回だけ読む */
vec4 fcOrm = vec4(0., 1., 0., 0.);
#ifdef USE_EMISSIVEMAP
fcOrm = texture2D(emissiveMap, vEmissiveMapUv);
#endif
if (vFcRoof > .5) {
  /* 屋上: 防水シートの色 + 縁の立ち上がり(パラペット35cm)を明るく */
  float fcRs = fract(floor(vFcSeed * 4096.) * .00179);
  vec3 fcR = uFcRoof * (.75 + .5 * fcRs);
  fcR *= mix(vec3(1.), vec3(.86, 1., .9), step(.82, fract(fcRs * 7.3)));   // 緑っぽい防水塗装もまぜる
  diffuseColor.rgb = mix(fcR, fcR * 1.4, step(vFcEdge, .35));
} else {
  /* ガラス(粗さ<.25)は壁の色に4分の1しか染めない(濃いタイルの建物でもガラスが茶色にならない) */
  float fcGl = step(fcOrm.g, .25);
  #if defined(USE_MAP) && defined(USE_COLOR)
  diffuseColor.rgb = mix(diffuseColor.rgb, sampledDiffuseColor.rgb * mix(vec3(1.), vColor.rgb, .25), fcGl);
  #endif
  /* 汚れ: 地面ぎわ2mが暗く、各階のスラブの下に雨だれの筋(ガラスは除く) */
  float fcSt = fcH12(vec2(floor(vFcUv.x * uFcGrid.x * 5.), floor(vFcSeed * 4096.) * .0091));
  float fcDirt = (1. - .12 * (1. - smoothstep(.6, 2.8, vFcH))) * (1. - .07 * step(.72, fcSt) * fract(vFcUv.y * uFcGrid.y));
  diffuseColor.rgb *= mix(fcDirt, 1., fcGl);
  if (vFcTop < .6) diffuseColor.rgb *= .78;   // 最上部のコーニス(笠木)
}
`;
/* emissivemap_fragment の「かわり」に入れる(ORMを2回読まない)。この材質だけの置きかえ */
const EMIT_F = /* glsl */`
{
  /* 窓ごと・建物ごとに点灯と色温度を変える(電球色/温白色/昼光の蛍光灯/テレビの青) */
  vec2 fcCell = floor(vFcUv * uFcGrid);
  float fcSd = floor(vFcSeed * 4096.) / 4096.;
  float fcL = uFcLit * uFcBoost;
  float fcOn = step(fcH12(fcCell + fcSd * 91.7), fcL);
  fcOn = max(fcOn, step(fcH12(vec2(fcCell.y, fcSd * 7.)), .12 * step(.001, fcL)));
  float fcHu = fcH12(fcCell * 1.73 + fcSd * 13.1);
  vec3 fcWc = fcHu < .42 ? vec3(1., .62, .30) : fcHu < .68 ? vec3(1., .80, .56) : fcHu < .92 ? vec3(.858, .968, 1.1) : vec3(.193, .264, .55);
  /* 部屋の中: 天井の灯りで上が明るく窓台が暗い。カーテンのひだ/ブラインド/片側だけ閉めた窓/家具の影。
   * 細かい模様は遠くでちらつくので、窓の大きさが数画素になったら消す(fcAa) */
  vec2 fcLc = fract(vFcUv * uFcGrid);
  float fcT = fcH12(fcCell * 2.31 + fcSd * 5.7);
  float fcAa = clamp(1. - 6. * fwidth(vFcUv.x * uFcGrid.x), 0., 1.);
  float fcI = mix(.55, 1.1, smoothstep(.15, .85, fcLc.y));
  fcI *= fcT < .3 ? 1. - fcAa * .18 * (.5 + .5 * sin(fcLc.x * 75.))
       : fcT < .48 ? 1. - fcAa * .45 * step(.5, fract(fcLc.y * 20.))
       : fcT < .6 ? mix(1., .3, step(.5, fcLc.x))
       : 1. - .5 * step(fcLc.y, .32) * step(.3, fract(fcLc.x * 2.7 + fcT * 3.));
  if (fcT < .3) fcWc *= mix(vec3(1., .86, .72), vec3(1., .8, .78), fract(fcT * 11.));   // カーテンの色
  fcI *= 1. + .6 * step(.9, fract(fcT * 3.7));   // 1割の部屋はとくに明るい(少しにじむ)
  /* 常夜灯の帯(R .35〜.65 かつ G>.94): 看板・ひさしの下・門灯・廊下の灯り。部屋の点灯に関係なく夜は点く。
   * Gも見るのは、ガラスと壁のさかいめ(R が中間になる)を灯りとまちがえないため */
  float fcM = fcOrm.r;
  float fcLm = step(.35, fcM) * step(fcM, .65) * step(.94, fcOrm.g);
  float fcLamp = fcLm * step(.001, fcL);
  float fcWin = fcOn * fcM * (1. - fcLm);
  totalEmissiveRadiance = emissive * (fcWin * fcWc * fcI * (.6 + .9 * fcH12(fcCell + 3.1))
    + fcLamp * vec3(1., .92, .78) * mix(.6, 1.6, smoothstep(.4, .6, fcM))) * (1. - vFcRoof);
  /* 街の照り返し: 低い階の壁ほど道の灯りで暖かく照らされる(夜1・夕方.25)。窓とガラスには足さない */
  float fcWall = (1. - step(.35, fcM)) * (1. - vFcRoof);
  totalEmissiveRadiance += diffuseColor.rgb * uFcAmb * fcWall * (vec3(1., .86, .66) * .26 * exp(-.32 * vFcH) + vec3(.55, .62, .8) * .035);
  roughnessFactor *= fcOrm.g;
  metalnessFactor *= fcOrm.b;
}
`;

/* mat: MeshStandardMaterial。opt: {tile:[m,m], grid:[列,階], steps, side, roofCol, key, v0, boost} */
export function patchFacade(mat, opt) {
  const side = opt.side || [0, 0];
  const u = {
    uFcTile: { value: new THREE.Vector2(opt.tile[0], opt.tile[1]) },
    uFcGrid: { value: new THREE.Vector2(opt.grid[0], opt.grid[1]) },
    uFcSteps: { value: new THREE.Vector2(...(opt.steps || opt.grid)) },
    uFcSide: { value: new THREE.Vector2(side[0], side[1]) },
    uFcRoof: { value: new THREE.Color(opt.roofCol != null ? opt.roofCol : 0x8f8d88) },
    uFcV0: { value: opt.v0 != null ? opt.v0 : 0.6 },
    uFcBoost: { value: opt.boost || 1 },
    uFcLit,
    uFcAmb,
  };
  mat.userData.fc = u;
  /* fwidth を使う(WebGL1 でも使えるように) */
  mat.extensions = { derivatives: true };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + PARS_V)
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n' + MAIN_V);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + PARS_F)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + COLOR_F)
      .replace('#include <emissivemap_fragment>', EMIT_F);
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
  patchFacade(mat, { tile: d.tile, grid: d.grid, steps: d.steps, side: d.side, roofCol: d.roof, key: 'bld', boost: name === 'shop' ? 1.9 : name === 'house' ? 1.1 : 1 });
  mat.userData.fcTex = [map, orm];
  return mat;
}

/* 外壁キャンバスのメモリ量(確認用。w*h*4 の合計) */
export function facadeCanvasBytes() {
  let n = 0;
  Object.keys(FACADE).forEach((k) => { const P = canvasesOf(k); n += (P.col.width * P.col.height + P.orm.width * P.orm.height) * 4; });
  return n;
}
