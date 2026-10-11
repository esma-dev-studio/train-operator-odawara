/* =========================================================
 * ui/stamps.js — えきスタンプ(駅ごとのオリジナル図柄)
 * 「8」の停止位置に ±1m で止まると すみ色、±35cm で駅の色、±10cm で金色のスタンプがもらえる。
 * 図柄はすべてキャンバスで描くオリジナル(地域の名物をモチーフにした単純な線画)。
 * ========================================================= */
import { STATION_KANA } from '../sim/kana.js';

/* 駅ごとのインクの色とモチーフ */
const DEFS = {
  '新宿': ['#c8352a', 'towers'],
  '南新宿': ['#2f6fb0', 'tree'],
  '参宮橋': ['#3d8a4f', 'bridge'],
  '代々木八幡': ['#c8352a', 'torii'],
  '代々木上原': ['#2a7f8f', 'dome'],
  '東北沢': ['#5b4aa0', 'tunnel'],
  '下北沢': ['#b0408a', 'guitar'],
  '世田谷代田': ['#2f6fb0', 'fuji'],
  '梅ヶ丘': ['#c2457a', 'plum'],
  '豪徳寺': ['#a05a2c', 'cat'],
  '経堂': ['#3d8a4f', 'arch'],
  '千歳船橋': ['#2a6fa0', 'boat'],
  '祖師ヶ谷大蔵': ['#c8352a', 'stars'],
  '成城学園前': ['#b08a1a', 'ginkgo'],
  '喜多見': ['#4a5a6a', 'trainface'],
  '狛江': ['#7a5a2a', 'kofun'],
  '和泉多摩川': ['#2a7fb0', 'river'],
  '登戸': ['#3d7a4f', 'mountain'],
  '向ヶ丘遊園': ['#c2304a', 'rose'],
  '生田': ['#2f7a3a', 'forest'],
  '読売ランド前': ['#d0602a', 'wheel'],
  '百合ヶ丘': ['#8a4ab0', 'lily'],
  '新百合ヶ丘': ['#5a3ab0', 'lilystar'],
};

export const stampColor = (name) => (DEFS[name] || ['#555'])[0];

/* モチーフを描く(中心0,0・半径1の正規化座標。線の色は ctx.strokeStyle/fillStyle) */
function motif(c, kind) {
  const L = (pts) => { c.beginPath(); pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.stroke(); };
  const circ = (x, y, r, fill) => { c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); fill ? c.fill() : c.stroke(); };
  switch (kind) {
    case 'towers':
      [[-0.55, 0.1, 0.28, 0.75], [-0.2, -0.35, 0.34, 1.2], [0.22, -0.1, 0.3, 0.95], [0.55, 0.2, 0.22, 0.65]].forEach(([x, y, w, h]) => {
        c.strokeRect(x - w / 2, y - h / 2 + 0.05, w, h);
        for (let yy = y - h / 2 + 0.15; yy < y + h / 2 - 0.05; yy += 0.14) L([[x - w / 2 + 0.06, yy], [x + w / 2 - 0.06, yy]]);
      });
      break;
    case 'tree':
      circ(0, -0.25, 0.42); L([[0, 0.17], [0, 0.6]]); L([[-0.5, 0.6], [0.5, 0.6]]);
      break;
    case 'bridge':
      c.beginPath(); c.arc(0, 0.75, 0.75, Math.PI * 1.05, Math.PI * 1.95); c.stroke();
      L([[-0.8, 0.12], [0.8, 0.12]]);
      for (let x = -0.6; x <= 0.61; x += 0.3) L([[x, 0.12], [x, 0.12 - Math.sqrt(Math.max(0, 0.56 - x * x)) * 0.5]]);
      for (let i = 0; i < 3; i++) L([[-0.7 + i * 0.1, 0.45 + i * 0.1], [0.7 - i * 0.1, 0.45 + i * 0.1]]);
      break;
    case 'torii':
      c.lineWidth *= 1.4;
      L([[-0.75, -0.45], [0.75, -0.45]]); L([[-0.6, -0.25], [0.6, -0.25]]);
      L([[-0.42, -0.45], [-0.48, 0.65]]); L([[0.42, -0.45], [0.48, 0.65]]);
      c.lineWidth /= 1.4;
      L([[0, -0.45], [0, -0.25]]);
      break;
    case 'dome':
      c.beginPath(); c.arc(0, 0.05, 0.45, Math.PI, 0); c.stroke();
      L([[-0.5, 0.05], [0.5, 0.05]]); c.strokeRect(-0.5, 0.05, 1.0, 0.5);
      L([[0, -0.4], [0, -0.6]]); L([[-0.72, 0.55], [-0.72, -0.55]]); L([[0.72, 0.55], [0.72, -0.55]]);
      break;
    case 'tunnel':
      c.beginPath(); c.arc(0, 0.25, 0.55, Math.PI, 0); c.lineTo(0.55, 0.6); c.lineTo(-0.55, 0.6); c.closePath(); c.stroke();
      L([[-0.2, 0.6], [-0.08, 0.05]]); L([[0.2, 0.6], [0.08, 0.05]]);
      L([[-0.8, -0.45], [0.8, -0.45]]);
      break;
    case 'guitar':
      circ(-0.2, 0.25, 0.32); circ(0.08, -0.02, 0.22);
      L([[0.18, -0.12], [0.62, -0.62]]); c.strokeRect(0.55, -0.75, 0.18, 0.2);
      circ(-0.12, 0.17, 0.08, true);
      break;
    case 'fuji':
      L([[-0.85, 0.5], [-0.25, -0.4], [0.25, -0.4], [0.85, 0.5]]);
      L([[-0.25, -0.4], [-0.12, -0.18], [0, -0.3], [0.12, -0.18], [0.25, -0.4]]);
      L([[-0.85, 0.62], [0.85, 0.62]]);
      break;
    case 'plum':
      for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2 - Math.PI / 2; circ(Math.cos(a) * 0.36, Math.sin(a) * 0.36, 0.25); }
      circ(0, 0, 0.1, true);
      break;
    case 'cat':
      circ(0, 0.12, 0.48);
      L([[-0.42, -0.1], [-0.38, -0.62], [-0.12, -0.33]]); L([[0.42, -0.1], [0.38, -0.62], [0.12, -0.33]]);
      circ(-0.18, 0.05, 0.05, true); circ(0.18, 0.05, 0.05, true);
      L([[-0.1, 0.28], [0, 0.34], [0.1, 0.28]]);
      L([[0.55, 0.0], [0.72, -0.4]]); L([[0.55, 0.0], [0.82, -0.22]]);
      break;
    case 'arch':
      c.beginPath(); c.arc(0, 0.1, 0.7, Math.PI * 1.08, Math.PI * 1.92); c.stroke();
      L([[-0.66, -0.05], [-0.66, 0.65]]); L([[0.66, -0.05], [0.66, 0.65]]);
      c.strokeRect(-0.35, -0.42, 0.7, 0.2);
      break;
    case 'boat':
      L([[-0.7, 0.2], [0.7, 0.2], [0.45, 0.5], [-0.45, 0.5], [-0.7, 0.2]]);
      L([[0, 0.2], [0, -0.6]]); L([[0, -0.6], [0.45, 0.1], [0, 0.1]]);
      L([[-0.85, 0.65], [-0.5, 0.58], [-0.15, 0.65], [0.2, 0.58], [0.55, 0.65], [0.85, 0.6]]);
      break;
    case 'stars': {
      const star = (x, y, r) => {
        c.beginPath();
        for (let i = 0; i < 10; i++) { const a = (i / 10) * Math.PI * 2 - Math.PI / 2; const rr = i % 2 ? r * 0.45 : r; c.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); }
        c.closePath(); c.stroke();
      };
      star(0, -0.05, 0.5); star(-0.55, 0.4, 0.2); star(0.55, 0.4, 0.2);
      break;
    }
    case 'ginkgo':
      c.beginPath(); c.moveTo(0, 0.55); c.lineTo(-0.6, -0.25); c.quadraticCurveTo(0, -0.75, 0.6, -0.25); c.closePath(); c.stroke();
      L([[0, -0.4], [0, -0.1]]); L([[0, 0.55], [0, 0.8]]);
      break;
    case 'trainface':
      c.beginPath(); c.moveTo(-0.55, 0.6); c.lineTo(-0.55, -0.35); c.quadraticCurveTo(0, -0.7, 0.55, -0.35); c.lineTo(0.55, 0.6); c.closePath(); c.stroke();
      c.strokeRect(-0.4, -0.3, 0.8, 0.4);
      circ(-0.32, 0.35, 0.08, true); circ(0.32, 0.35, 0.08, true);
      L([[-0.7, 0.75], [0.7, 0.75]]);
      break;
    case 'kofun':
      circ(0.25, 0, 0.42);
      L([[-0.15, -0.2], [-0.75, -0.45], [-0.75, 0.45], [-0.15, 0.2]]);
      c.beginPath(); c.arc(0.25, 0, 0.58, 0, Math.PI * 2); c.stroke();
      break;
    case 'river':
      for (let k = 0; k < 3; k++) {
        c.beginPath();
        for (let x = -0.85; x <= 0.85; x += 0.05) c.lineTo(x, 0.2 + k * 0.22 + Math.sin(x * 9 + k) * 0.06);
        c.stroke();
      }
      L([[-0.85, -0.2], [0.85, -0.2]]);
      for (let x = -0.75; x <= 0.76; x += 0.25) L([[x, -0.2], [x + 0.125, -0.5], [x + 0.25, -0.2]]);
      L([[-0.85, -0.5], [0.85, -0.5]]);
      break;
    case 'mountain':
      L([[-0.85, 0.55], [-0.3, -0.35], [0.05, 0.1], [0.35, -0.55], [0.85, 0.55]]);
      L([[-0.7, 0.55], [-0.2, 0.25], [0.2, 0.35], [0.5, 0.0]]);
      break;
    case 'rose':
      c.beginPath(); for (let a = 0; a < Math.PI * 6; a += 0.1) { const r = 0.05 + a * 0.024; c.lineTo(Math.cos(a) * r, -0.1 + Math.sin(a) * r); } c.stroke();
      L([[0, 0.38], [0, 0.85]]); L([[0, 0.6], [-0.3, 0.45]]); L([[0, 0.7], [0.3, 0.55]]);
      break;
    case 'forest':
      [[-0.45, 0.15, 0.5], [0, -0.1, 0.7], [0.45, 0.15, 0.5]].forEach(([x, y, h]) => {
        L([[x - h * 0.5, y + h * 0.5], [x, y - h * 0.6], [x + h * 0.5, y + h * 0.5], [x - h * 0.5, y + h * 0.5]]);
        L([[x, y + h * 0.5], [x, y + h * 0.75]]);
      });
      break;
    case 'wheel':
      circ(0, -0.1, 0.58);
      for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; L([[0, -0.1], [Math.cos(a) * 0.58, -0.1 + Math.sin(a) * 0.58]]); circ(Math.cos(a) * 0.58, -0.1 + Math.sin(a) * 0.58, 0.07, true); }
      L([[-0.35, 0.75], [0, -0.1], [0.35, 0.75]]);
      break;
    case 'lily':
    case 'lilystar':
      for (let i = 0; i < 3; i++) {
        const a = -Math.PI / 2 + (i - 1) * 0.75;
        c.beginPath(); c.moveTo(0, 0.1);
        c.quadraticCurveTo(Math.cos(a - 0.4) * 0.6, 0.1 + Math.sin(a - 0.4) * 0.6, Math.cos(a) * 0.7, 0.1 + Math.sin(a) * 0.7);
        c.quadraticCurveTo(Math.cos(a + 0.4) * 0.6, 0.1 + Math.sin(a + 0.4) * 0.6, 0, 0.1);
        c.stroke();
      }
      L([[0, 0.1], [0, 0.8]]); L([[0, 0.5], [0.3, 0.35]]);
      if (kind === 'lilystar') {
        [[-0.6, -0.5], [0.62, -0.42]].forEach(([x, y]) => { L([[x - 0.12, y], [x + 0.12, y]]); L([[x, y - 0.12], [x, y + 0.12]]); });
      }
      break;
    default:
      circ(0, 0, 0.5);
  }
}

/* スタンプ1つを描く。
 * tier: 0=まだ(点線の丸と うすい図柄) 1=くろ(±1m・すみ色) 2=いろ(±35cm・駅の色) 3=きん(±10cm・金色+内側の輪)
 * (前の呼び方 got:true/false も使える: true→2, false→0) */
export function drawStamp(cv, name, { tier = null, got = true, size = 160, seed = 0 } = {}) {
  if (tier == null) tier = got ? 2 : 0;
  const dpr = Math.min(2, (typeof devicePixelRatio !== 'undefined' && devicePixelRatio) || 1);
  cv.width = size * dpr; cv.height = size * dpr;
  cv.style.width = size + 'px'; cv.style.height = size + 'px';
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, size, size);
  const [col, kind] = DEFS[name] || ['#555', 'circle'];
  const R = size / 2;
  c.save();
  c.translate(R, R);
  /* まだ: 点線の丸と、うすい図柄の「かげ」(なにが もらえるか わかる しずかな目標。台紙は クリーム色) */
  if (tier <= 0) {
    c.globalAlpha = 0.55;
    c.strokeStyle = '#a89a7e';
    c.setLineDash([size * 0.035, size * 0.03]);
    c.lineWidth = size * 0.02;
    c.beginPath(); c.arc(0, 0, R * 0.9, 0, Math.PI * 2); c.stroke();
    c.setLineDash([]);
    c.globalAlpha = 0.22;
    c.strokeStyle = c.fillStyle = '#8a7a5a';
    c.save();
    c.translate(0, -R * 0.2);
    c.scale(R * 0.36, R * 0.36);
    c.lineWidth = 0.06;
    c.lineJoin = 'round'; c.lineCap = 'round';
    motif(c, kind);
    c.restore();
    c.restore();
    return;
  }
  c.rotate(((seed % 7) - 3) * 0.025);
  /* きん: クリーム色の 台紙の上でも しずまない こい金色の グラデーション(輪と図柄) */
  const gold = (a, b) => {
    const g = c.createLinearGradient(-a, -a, b, b);
    g.addColorStop(0, '#5a3f06'); g.addColorStop(0.5, '#b8901f'); g.addColorStop(1, '#6b4c08');
    return g;
  };
  let ink = col;
  if (tier === 1) { ink = '#2e2e2e'; c.globalAlpha = 0.85; }
  if (tier >= 3) {
    /* 内側に うすい金の 地色 */
    c.fillStyle = 'rgba(233, 199, 90, 0.20)';
    c.beginPath(); c.arc(0, 0, R * 0.82, 0, Math.PI * 2); c.fill();
    ink = gold(R, R);
  }
  c.strokeStyle = ink; c.fillStyle = ink;
  /* 外枠(二重丸。きんは さらに内側にもう1本) */
  c.lineWidth = size * 0.035;
  c.beginPath(); c.arc(0, 0, R * 0.92, 0, Math.PI * 2); c.stroke();
  c.lineWidth = size * 0.012;
  c.beginPath(); c.arc(0, 0, R * 0.82, 0, Math.PI * 2); c.stroke();
  if (tier >= 3) { c.beginPath(); c.arc(0, 0, R * 0.765, 0, Math.PI * 2); c.stroke(); }
  /* 上: 駅名(漢字) 下: かな */
  c.textAlign = 'center'; c.textBaseline = 'middle';
  /* 文字は内側の輪に収まるよう、測って縮める */
  const fit = (text, weight, px, maxW) => {
    c.font = `${weight} ${px}px "Zen Kaku Gothic New", "Hiragino Sans", sans-serif`;
    const w = c.measureText(text).width;
    if (w > maxW) c.font = `${weight} ${px * (maxW / w)}px "Zen Kaku Gothic New", "Hiragino Sans", sans-serif`;
  };
  /* きんの 文字は さらに こい金(いちばん明るい所でも 台紙と 5:1 いじょう) */
  if (tier >= 3) {
    const gt = c.createLinearGradient(-R, -R, R, R);
    gt.addColorStop(0, '#4a3304'); gt.addColorStop(0.5, '#7a5a0e'); gt.addColorStop(1, '#56390a');
    c.fillStyle = gt;
  }
  fit(name, 900, size * 0.185, R * 1.36);
  c.fillText(name, 0, R * 0.40);
  const kana = STATION_KANA[name] || '';
  fit(kana, 700, size * 0.075, R * 1.0);
  c.fillText(kana, 0, R * 0.665);
  c.font = `700 ${size * 0.06}px "Zen Kaku Gothic New", sans-serif`;
  c.fillText('えき スタンプ', 0, -R * 0.66);
  /* モチーフ */
  c.save();
  c.translate(0, -R * 0.2);
  c.scale(R * 0.36, R * 0.36);
  c.lineWidth = 0.075;
  c.lineJoin = 'round'; c.lineCap = 'round';
  if (tier >= 3) { const g2 = gold(1, 1); c.strokeStyle = g2; c.fillStyle = g2; }
  motif(c, kind);
  c.restore();
  c.restore();
  /* インクのかすれ(ハンコらしさ。すみ色は すこし多めに かすれる) */
  let x = 12345 + seed * 77;
  const rnd = () => (x = (x * 16807) % 2147483647) / 2147483647;
  c.globalCompositeOperation = 'destination-out';
  const n = size * (tier === 1 ? 2.6 : tier >= 3 ? 1.0 : 1.6);
  for (let i = 0; i < n; i++) {
    c.fillStyle = `rgba(0,0,0,${0.25 + rnd() * 0.5})`;
    c.fillRect(rnd() * size, rnd() * size, 1 + rnd() * 2.2, 1 + rnd() * 1.5);
  }
  c.globalCompositeOperation = 'source-over';
}
