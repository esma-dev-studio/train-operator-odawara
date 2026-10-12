/* =========================================================
 * ui/coachplan.js — 「8」に ぴったり とめるための ブレーキの けいかく(DOM非依存・import なし)
 * いまの ブレーキ(B1〜B7)の となり ±2段 を エンジンの stopDistance で ためし、
 * いちばん「8」に ちかく とまる段を さがす。コーチ(main.js)が「KDN を 2かい」のように
 * 「なんかい おすか」を 出すのに使う。tools/kidbot.mjs で こどもの うごきを まねて ためしてある
 * (1かいずつ おす こどもでも スタンプ(±1m)が とれる)。
 *
 * 使い方:
 *   const st = makePlanState();                 // 1つ作って つかいまわす
 *   const r = brakePlan(sim, dist, st);         // dist = 「8」まで(m)。r は st の中の おなじ物
 *   r.kind: 'ok'    いまの段で ±1.5m 以内に とまる(そのまま)
 *           'wait'  いまの段が いちばん よい(でも まだ ずれる。ちかづいたら また けいさん)
 *           'press' r.steps 段 かえる(負=つよく ↓ / 正=よわく ↑)。r.best が めあての段
 *           'early' B1 でも 30m より てまえで とまる → いったん N(best=0)に もどす
 *           'none'  ブレーキ中ではない・どの段でも とまれない(下り坂)・止まっている
 *   r.cur / r.best: 段(-7..-1、early の best は 0) / r.eCur / r.eBest: とまる位置の ずれ(m。+=いきすぎ / -=てまえ / null=とまれない)
 * 計算は sim.t で 150ms に1回(stopDistance は 1回に 5回まで)。段が かわったら すぐ けいさんしなおす。
 * 1回目のあとは 新しい物を作らない(毎フレームよんでも ごみが出ない)。
 * ========================================================= */

export const PLAN_VERSION = 1;

/* いまの段を つづけるのは、べつの段のほうが この m より ちかく とまるとき まで(行ったり来たりしない) */
const HYST = 0.8;
/* とおくでは ゆとりを 「8」までの きょり × HYST_K だけ ふやす */
const HYST_K = 0.2;
/* 1回で かえる段の上限(4.5 km/h/s の「ガクン」を出さない) */
const MAX_STEP = 3;
/* 「そのまま」で よい ずれ(m) */
const OK_ERR = 1.5;
/* B1 でも この m より てまえで とまるなら「まだ はやい」 */
const EARLY = 30;
/* けいさんしなおす間隔(sim.t の秒) */
const EVERY = 0.15;

export function makePlanState() {
  return {
    t: -1e9, notch: 99, dist: 1e9, kind: 'none', best: 0,
    res: { kind: 'none', cur: 0, best: 0, steps: 0, eCur: null, eBest: null },
  };
}

export function brakePlan(sim, dist, st) {
  const r = st.res;
  const notch = sim.notch;
  const t = sim.t;
  /* まえの けいさんを つかう(150ms たっていない・段が おなじ・やりなおしで 位置が とんでいない) */
  if (t >= st.t && t - st.t < EVERY && notch === st.notch && Math.abs(dist - st.dist) < 20) return r;
  /* しばらく よばれなかった・位置が とんだ(つぎの駅・やりなおし)ときは、まえの めあてを わすれる */
  if (t < st.t || t - st.t > 1 || Math.abs(dist - st.dist) >= 20) st.kind = 'none';
  st.t = t; st.notch = notch; st.dist = dist;

  r.cur = notch; r.best = notch; r.steps = 0; r.eCur = null; r.eBest = null;
  if (!(notch <= -1 && notch >= -7) || sim.doorOpen || !(sim.v >= 0.5) || typeof dist !== 'number' || !isFinite(dist)) {
    r.kind = 'none';
    st.kind = 'none';
    return r;
  }
  const lo = Math.max(-7, notch - 2), hi = Math.min(-1, notch + 2);
  /* まえに「おして」と言った段(とちゅうまで おした)が まだ ためす はんいなら、それを ひきつづき めあてにする */
  const inc = st.kind === 'press' && st.best >= lo && st.best <= hi && st.best !== notch ? st.best : notch;
  let best = 0, bestAbs = 1e9, bestE = 0, pCur = null, pInc = null, p1 = null;
  for (let n = lo; n <= hi; n++) {
    const p = sim.stopDistance(n);
    if (p == null) continue;
    const e = p - dist;
    const a = e < 0 ? -e : e;
    if (n === notch) pCur = p;
    if (n === inc) pInc = p;
    if (n === -1) p1 = p;
    if (a < bestAbs) { bestAbs = a; best = n; bestE = e; }
  }
  if (bestAbs >= 1e9) { r.kind = 'none'; st.kind = 'none'; return r; }   // どの段でも とまれない
  const eCur = pCur == null ? null : pCur - dist;
  r.eCur = eCur;
  /* B1 でも ずっと てまえで とまる: ブレーキを いったん ゆるめて N へ */
  if (p1 != null && p1 < dist - EARLY) {
    r.kind = 'early';
    r.best = 0;
    r.steps = Math.min(MAX_STEP, -notch);
    r.eBest = null;
    st.kind = 'early'; st.best = 0;
    return r;
  }
  /* いまの めあて(ふつうは いまの段)で とまれて、ほかの段との ちがいが ゆとり以下なら そのまま。
   * ゆとりは「8」に ちかいほど小さい(10m より ちかいと HYST)。とおくでは どちらの段も まだ大きく ずれるので、
   * 小さな ちがいで 段を行ったり来たり させない(こどもが おす回数が へる) */
  const eInc = pInc == null ? null : pInc - dist;
  const aInc = eInc == null ? 1e9 : (eInc < 0 ? -eInc : eInc);
  const hy = HYST + HYST_K * (dist > 10 ? dist - 10 : 0);
  if (eInc != null && aInc - bestAbs <= hy) { best = inc; bestE = eInc; }
  let steps = best - notch;
  if (steps > MAX_STEP) steps = MAX_STEP;
  if (steps < -MAX_STEP) steps = -MAX_STEP;
  r.best = notch + steps;
  r.steps = steps;
  r.eBest = bestE;
  if (steps === 0) r.kind = (bestE < 0 ? -bestE : bestE) <= OK_ERR ? 'ok' : 'wait';
  else r.kind = 'press';
  st.kind = r.kind; st.best = r.best;
  return r;
}
