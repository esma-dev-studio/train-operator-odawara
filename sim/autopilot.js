/* =========================================================
 * sim/autopilot.js — 自動運転（DOM非依存）
 * 回帰テスト(tools/autodrive.mjs)・ダイヤ校正・デバッグ自動運転・
 * タイトル画面のデモ走行で共通に使う「人間らしい」運転則:
 *   力行 → 惰行 → 先読みブレーキ → 停止直前に緩めて滑らかに止める
 * ========================================================= */
import { TRAIN, ADHESION } from './engine.js';

export function makeAutopilot(sim) {
  let lastChange = -9, lastNotch = 0;
  const set = (n) => {
    if (sim.t < lastChange) lastChange = -9;   // やりなおし等で時計が戻ったとき
    if (n === lastNotch && sim.notch === n) return;
    /* ノッチ操作は0.6秒に1回まで（ガチャガチャ防止）。ただし強いブレーキ要求は即時 */
    if (sim.t - lastChange < 0.6 && !(n < lastNotch && n <= -4)) return;
    lastChange = sim.t; lastNotch = n;
    sim.setNotch(n);
  };
  /* 粘着限界(雨・雪)を超えるブレーキは滑走するので、計画減速度の上限にする */
  const bCap = () => Math.min(TRAIN.maxServiceB, (ADHESION[sim.weather] || ADHESION.clear) * 0.9);

  return () => {
    const h = sim.hud();
    if (h.doorOpen) { set(0); return; }
    const v = h.v;
    const target = sim.stops[sim.stopIdx];
    const d = target ? target.stopAt - sim.pos : 1e9;
    const bGrade = 9.81 * (h.grade / 1000) * 3.6;   // 下り勾配なら負値=加速側
    const cap = bCap();
    /* 滑りやすい日は早めに・弱めに(必要減速度を大きく見積もる) */
    const slick = TRAIN.maxServiceB / cap;

    /* 停止に必要な減速度(km/h/s) */
    const bNeed = d > 0.3 ? ((v / 3.6) ** 2 / (2 * d)) * 3.6 : 9;

    /* 前方制限(カーブ・信号)への必要減速度。停止目標はbNeed側で扱う。
     * ブレーキ込め遅れ(約1.1s)+操作間隔ぶんを距離で先読みする */
    let bRest = 0;
    if (h.ats && h.ats.kind !== 'stop' && v > h.ats.target - 1) {
      const lag = 22 + (v / 3.6) * 1.7;
      const dr = h.ats.at - sim.pos - lag;
      const vt = Math.max(0, h.ats.target - 1);
      if (dr > 1) bRest = (((v / 3.6) ** 2 - (vt / 3.6) ** 2) / (2 * dr)) * 3.6;
      else if (v > h.ats.target + 0.5) bRest = 2.2;
    }

    /* 赤信号の直前: 手前で止まって待つ（力行とブレーキの行ったり来たりを防ぐ） */
    if (h.ats && h.ats.kind === 'signal' && h.ats.target === 0 && h.ats.at - sim.pos < 70 && bNeed < 2.5) {
      set(v > 2 ? -4 : -2);
      return;
    }

    const startB = 0.8 / slick;
    const bWant = Math.max(bNeed > startB && d < 1000 ? bNeed : 0, bRest > 0.72 / slick ? bRest : 0);
    if (bWant > 0) {
      const b = bWant * (d < 45 ? 1.0 : 1.1) - Math.min(0, bGrade);   // 下りは強め
      const step = Math.ceil((b / TRAIN.maxServiceB) * TRAIN.brakeSteps + 0.25);
      const maxStep = Math.max(1, Math.floor((cap / TRAIN.maxServiceB) * TRAIN.brakeSteps));
      /* 停止寸前は弱めて滑らかに、直前で確実に(急な下り坂では勾配ぶん強める) */
      const gradeStep = Math.ceil(Math.max(0, -bGrade) / TRAIN.maxServiceB * TRAIN.brakeSteps);
      if (d < 2.2 && v < 3.5) { set(-Math.min(maxStep, Math.max(3, gradeStep + 2))); return; }
      if (d < 12 && v < 8 && bNeed < 1.6) { set(-Math.min(maxStep, Math.max(1, gradeStep + 1))); return; }
      set(-Math.min(maxStep, Math.max(1, step)));
      return;
    }

    /* 停止直前に手前で止まりかけたら追い上げ（突き上げ）。遠めに止まったら少し強めに */
    if (d > 1.4 && d < 60 && v < 4 && bNeed < 1.2) { set(1); return; }
    if (d >= 60 && d < 250 && v < 14 && bNeed < 0.6) { set(2); return; }

    /* 巡航: 現在制限-2 かつ 前方パターン-5 を上限に、力行→惰行 */
    let cruise = h.limit - 2;
    if (h.ats && h.ats.kind !== 'stop') {
      cruise = Math.min(cruise, Math.max(h.ats.target - 1, h.ats.pattern - 5));
    }
    cruise = Math.max(20, cruise);
    if (v > cruise + 0.5) { set(v > cruise + 5 ? -2 : -1); return; }
    if (v < cruise - 6 && d > 250) { set(4); return; }
    if (v < cruise - 1.5 && d > 250) { set(2); return; }
    set(0);
  };
}
