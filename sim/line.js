/* =========================================================
 * sim/line.js — 線形データの方向変換（DOM非依存）
 * data/line.json は「新宿→新百合ヶ丘(くだり)」向きの1本の線形。
 * ここで ①新宿側に引上げ線ぶんの余白を足し ②のぼりは全体を反転 して、
 * エンジン・描画の両方が「進行方向に s が増える」同じ形で扱えるようにする。
 * ========================================================= */

/* 新宿ターミナル(頭端式)の奥行き。駅名標・車止め・ホーム全長を置くための余白 */
export const TERMINAL_PAD = 260;

/* のぼりで停止位置をホーム先端(進行方向の先)に合わせるためのずらし量。
 * くだりは「駅の s = 先頭が止まる位置、ホームは s-155〜s+15」。
 * のぼりは同じホームを逆向きに使うので、先頭は反対側の端の15m手前に止まる */
const UP_STOP_SHIFT = 140;

const cache = new Map();

/* 線形の前(s=0側)に、始点の接線方向へまっすぐ padM メートル延長する */
function padFront(line, padM) {
  const step = line.meta.step;
  const n = Math.round(padM / step);
  const p0 = line.pts[0], p1 = line.pts[1];
  const dx = p0[0] - p1[0], dy = p0[1] - p1[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const pre = [];
  for (let k = n; k >= 1; k--) {
    pre.push([+(p0[0] + ux * step * k).toFixed(2), +(p0[1] + uy * step * k).toFixed(2), p0[2]]);
  }
  const shift = n * step;
  const sh = (o) => ({ ...o, from: o.from + shift, to: o.to + shift });
  return {
    ...line,
    pts: pre.concat(line.pts),
    stations: line.stations.map((st) => ({ ...st, s: st.s + shift })),
    limits: line.limits.map(sh),
    sections: {
      tunnel: line.sections.tunnel.map(sh),
      river: line.sections.river.map(sh),
      quad: sh(line.sections.quad),
      urban: line.sections.urban.map((u, i) => (i === 0 ? { ...sh(u), from: 0 } : sh(u))),
    },
    meta: { ...line.meta, length: (pre.length + line.pts.length - 1) * step, pad: shift },
  };
}

/* 全体を反転（のぼり）。s' = L - s */
function reverse(line) {
  const L = line.meta.length;
  const flip = (o) => ({ ...o, from: +(L - o.to).toFixed(1), to: +(L - o.from).toFixed(1) });
  return {
    ...line,
    pts: line.pts.slice().reverse(),
    stations: line.stations.slice().reverse().map((st) => ({
      ...st, s: +Math.min(L - 30, L - st.s + UP_STOP_SHIFT).toFixed(1),
    })),
    limits: line.limits.map(flip).sort((a, b) => a.from - b.from),
    sections: {
      tunnel: line.sections.tunnel.map(flip).sort((a, b) => a.from - b.from),
      river: line.sections.river.map(flip).sort((a, b) => a.from - b.from),
      quad: flip(line.sections.quad),
      urban: line.sections.urban.map(flip).sort((a, b) => a.from - b.from),
    },
    meta: { ...line.meta, reversed: true },
  };
}

/* direction: 'down'(新宿→新百合ヶ丘) | 'up'(新百合ヶ丘→新宿) */
export function prepareLine(raw, direction = 'down') {
  const key = direction;
  const hit = cache.get(raw);
  if (hit && hit[key]) return hit[key];
  const padded = padFront(raw, TERMINAL_PAD);
  const out = direction === 'up' ? reverse(padded) : padded;
  out.meta = { ...out.meta, direction };
  const ent = hit || {};
  ent[key] = out;
  cache.set(raw, ent);
  return out;
}

/* 終点名(表示用) */
export const terminusOf = (direction) => (direction === 'up' ? '新宿' : '新百合ヶ丘');
