/* =========================================================
 * tools/check-quad.mjs — 複々線の急行線が、ホーム・柵・トンネルの壁・架線柱にぶつからないか調べる
 * 使い方: node tools/check-quad.mjs
 * 車体の半幅 1.475m、すき間 0.5m を見込んで、くだり・のぼりの両方を 1m ごとに確かめる。
 * ========================================================= */
import { readFileSync } from 'node:fs';
import { prepareLine } from '../sim/line.js';
import { QUAD_OFF, TUN, quadInfo, quadOffAt, quadFullZone, fenceOffL, gantryVariant, GANTRY_POLES } from '../scene/trackbed.js';

const HALF = 1.475, GAP = 0.5;
const PLAT_BACK = 5.0;   // 左ホームの背(駅の担当と同じ数字)
const raw = JSON.parse(readFileSync(new URL('../data/line.json', import.meta.url), 'utf8'));
const fails = [];
let nFail = 0;
const ng = (msg) => { nFail++; if (fails.length < 40) fails.push(msg); };

if (!(QUAD_OFF[0] - HALF > PLAT_BACK + 0.4)) ng(`くだり急行の車体がホームの背にかかる: ${QUAD_OFF[0] - HALF} <= ${PLAT_BACK + 0.4}`);
if (!(TUN.L >= QUAD_OFF[1] + HALF + GAP)) ng(`トンネルの左壁が上り急行に近すぎる: ${TUN.L}`);

for (const dir of ['down', 'up']) {
  const line = prepareLine(raw, dir);
  const qi = quadInfo(line);
  const L = line.meta.length;
  const inSt = (s) => line.stations.some((st) => s > st.s - 160 && s < st.s + 20);
  const plat = (s) => line.stations.find((st) => s >= st.s - 160 && s <= st.s + 20);
  const inTun = (s) => line.sections.tunnel.some((t) => s > t.from && s < t.to);
  let n = 0;
  for (let s = 0; s < L; s += 1) {
    const e0 = quadOffAt(s, 0, qi), e1 = quadOffAt(s, 1, qi);
    if (e1 < e0 - 1e-6) ng(`${dir} s=${s}: 上り急行がくだり急行の内側`);
    /* 柵・防音壁(内側の面 = 位置-0.2m) */
    const fence = fenceOffL(s, qi) - 0.2;
    if (fence - e1 < HALF + GAP) ng(`${dir} s=${s}: 柵が上り急行に近い (${(fence - e1).toFixed(2)}m)`);
    /* トンネルの壁 */
    if (inTun(s) && TUN.L - e1 < HALF + GAP) ng(`${dir} s=${s}: トンネルの壁が近い`);
    /* 架線柱(左の柱の内側 = 位置-0.15m) */
    const pl = GANTRY_POLES[gantryVariant(s, inSt(s), qi)][0] - 0.15;
    if (pl - Math.max(e0, e1) < HALF + GAP) ng(`${dir} s=${s}: 架線柱が急行線に近い (${(pl - e1).toFixed(2)}m)`);
    /* ホーム: 急行線が全幅でないところは、分かれ目がホームの下に隠れている場合だけ許す */
    const st = plat(s);
    if (st && e0 > 0.15 && e0 < QUAD_OFF[0] - 1e-6) {
      const fan = s < (qi.a1 + qi.b0) / 2 ? [qi.a0, qi.a1] : [qi.b0, qi.b1];
      if (!(fan[0] >= st.s - 160 && fan[1] <= st.s + 20)) ng(`${dir} s=${s}: 分かれ目が ${st.name} のホームに一部だけかかる`);
    }
    if (st && e0 >= QUAD_OFF[0] - 1e-6 && e0 - HALF <= PLAT_BACK) ng(`${dir} s=${s}: 急行線が ${st.name} のホームにかかる`);
    n++;
  }
  const z = quadFullZone(qi);
  console.log(`${dir}: 複々線 ${qi.from}〜${qi.to} / 分かれ目 ${qi.a0.toFixed(0)}〜${qi.a1.toFixed(0)}, ${qi.b0.toFixed(0)}〜${qi.b1.toFixed(0)} / AI列車の区間 ${z.from.toFixed(0)}〜${z.to.toFixed(0)} (${n}点)`);
}
if (nFail) { console.error(`★ NG ${nFail}件\n` + fails.join('\n')); process.exit(1); }
console.log(`OK: 急行線(${QUAD_OFF.join(' / ')}m)はホームの背・柵・トンネルの壁・架線柱から ${HALF + GAP}m 以上はなれている`);
