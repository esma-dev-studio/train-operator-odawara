/* =========================================================
 * tools/check-ground.mjs — 地面の帯がカーブで折れ返っていないか調べる
 * 使い方: node tools/check-ground.mjs
 * 地面の各列について、となりの行への移動が進行方向(なめらかな向き)と同じ向きかを確かめる。
 * 折れ返りがあると、そこに黒い筋(裏返った三角形)が出る。
 * ========================================================= */
import { readFileSync } from 'node:fs';
import { prepareLine } from '../sim/line.js';
import { framesFromLine, smoothFrames, groundStrip, quadInfo, quadOffAt } from '../scene/trackbed.js';

const raw = JSON.parse(readFileSync(new URL('../data/line.json', import.meta.url), 'utf8'));
let bad = 0;
for (const dir of ['down', 'up']) {
  const line = prepareLine(raw, dir);
  const step = line.meta.step;
  const F = framesFromLine(line);
  const FS = smoothFrames(F);
  const qi = quadInfo(line);
  const N = F.length - 1;
  for (const side of [1, -1]) {
    const g = groundStrip(F, FS, 0, N, side, { step, shift: side > 0 ? (i) => quadOffAt(i * step, 1, qi) : null });
    const C = g.userData.cols, P = g.attributes.position.array;
    let fails = 0, worst = Infinity, at = null;
    for (let i = 0; i < N; i++) {
      const t = FS.t[i];
      for (let c = 0; c < C; c++) {
        const a = (i * C + c) * 3, b = ((i + 1) * C + c) * 3;
        const d = (P[b] - P[a]) * t.x + (P[b + 2] - P[a + 2]) * t.z;
        if (d < worst) { worst = d; at = { s: i * step, c }; }
        if (!(d > 0)) fails++;
      }
    }
    bad += fails;
    console.log(`${dir} ${side > 0 ? '左' : '右'}: 列${C} 行${N + 1} 折れ返り ${fails} 箇所 (最小の前進 ${worst.toFixed(2)}m @ s=${at.s} 列${at.c})`);
  }
}
if (bad) { console.error(`★ 折れ返り ${bad} 箇所`); process.exit(1); }
console.log('OK: 地面の折れ返りなし');
