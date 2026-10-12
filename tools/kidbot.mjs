/* =========================================================
 * kidbot.mjs — 「こどもボット」: コーチの ことばどおりに レバーを おす 小2 を まねて、
 * スタンプ(±1m 以内)が いくつ とれるかを しらべる(ui/coachplan.js の ためし)
 *   (a) いまの コーチ: 予想が ±1m より ずれたら その向きに 1段(main.js _updateCoach の ルール)
 *   (b) ブレーキの けいかく: brakePlan の めあての段へ(ui/coachplan.js)
 * こどもは「はんのう時間」(0.6 / 0.8 / 1.0 / 1.2 秒)ごとに 1回だけ おす。駅の 650m 手前までは
 * 自動運転(sim/autopilot.js)が はしらせ、そこから こどもに かわる。
 * 使い方: node tools/kidbot.mjs [local|exp|rapid] [clear|rain|snow] [up] [-v]
 *         node tools/kidbot.mjs --signals   … ホームの上に立つ閉そく信号を くだり・のぼりで さがす(あれば 終了コード1)
 * くだり・各停・晴れ(よびだし なし)では (b) が どの はんのう時間でも
 *   スタンプ 13駅以上・ずれの中央値 0.7m 以下 でないと 終了コード1
 * ========================================================= */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TrainSim } from '../sim/engine.js';
import { makeAutopilot } from '../sim/autopilot.js';
import { prepareLine } from '../sim/line.js';
import { makePlanState, brakePlan } from '../ui/coachplan.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rawLine = JSON.parse(readFileSync(join(root, 'data', 'line.json'), 'utf8'));
const timetable = JSON.parse(readFileSync(join(root, 'data', 'timetable.json'), 'utf8'));
const args = process.argv.slice(2);

/* ---- --signals: ホーム(scene/stations.js の st.s-155 〜 st.s+15)の上の 信号機 ---- */
if (args.includes('--signals')) {
  let bad = 0;
  for (const dir of ['down', 'up']) {
    const line = prepareLine(rawLine, dir);
    for (const service of ['local', 'exp', 'rapid']) {
      const sim = new TrainSim(line, { service, timetable });
      const on = [];
      sim.signals.forEach((g) => line.stations.forEach((x) => {
        if (g.s >= x.s - 155 && g.s <= x.s + 15) on.push(`${x.name} ${Math.round(g.s - x.s)}m (${g.kind})`);
      }));
      bad += on.length;
      console.log(dir, service.padEnd(5), on.length ? '★ ホームの上: ' + on.join(', ') : 'ホームの上の信号機 なし');
    }
  }
  process.exit(bad ? 1 : 0);
}

const service = ['local', 'exp', 'rapid'].find((s) => args.includes(s)) || 'local';
const weather = ['clear', 'rain', 'snow'].find((s) => args.includes(s)) || 'clear';
const DIR = args.includes('up') ? 'up' : 'down';
const VERBOSE = args.includes('-v');
const line = prepareLine(rawLine, DIR);

function drive(policy, react) {
  const sim = new TrainSim(line, { service, weather, timetable });
  const auto = makeAutopilot(sim);
  const plan = makePlanState();
  const DT = 0.05;
  let nextAct = 0, lastDir = 0, creepWait = 0;
  const stops = [];
  let per = { presses: 0, rev: 0 };
  sim.onEvent((type, e) => {
    if (type === 'arrived') { stops.push({ name: e.name, err: e.err, presses: per.presses, rev: per.rev }); per = { presses: 0, rev: 0 }; lastDir = 0; }
    if (type === 'overrun-stop') { stops.push({ name: sim.stops[sim.stopIdx].name, err: e.err, over: true }); sim.acceptOverrun(); }
  });
  const press = (dir) => {
    sim.setNotch(Math.max(-7, Math.min(4, sim.notch + dir)));
    per.presses++;
    if (lastDir && dir !== lastDir) per.rev++;
    lastDir = dir;
  };
  /* こどもが いま ねらう段(null = 自動運転に まかせる) */
  const want = () => {
    const nx = sim.stops[sim.stopIdx];
    if (!nx || sim.doorOpen) return null;
    const dist = nx.stopAt - sim.pos;
    if (dist > 650 || sim.v < 0.5) return null;
    if (sim.notch >= 0) {
      /* ブレーキまで(main.js _brakeCalc / _toBrake と おなじ): B4 で止まれる距離+よゆう */
      let dB = sim.stopDistance(-4);
      if (dB == null) { const vms = sim.v / 3.6; dB = (vms * vms) / (2 * ((4 / 7) * 4.0 / 3.6)) + vms * 1.2; }
      const toBrake = dist - dB - Math.min(12, 3 + sim.v * 0.15);
      return toBrake > 40 ? 'coast' : -4;
    }
    if (policy === 'b') {
      const r = brakePlan(sim, dist, plan);
      if (r.kind === 'none') return Math.max(-7, sim.notch - 1);   // とまれない → もっと つよく
      return r.best;
    }
    const pred = sim.predictStop();
    if (pred == null) return Math.max(-7, sim.notch - 1);
    const d = pred - dist;
    if (Math.abs(d) <= 1) return sim.notch;
    return d > 1 ? Math.max(-7, sim.notch - 1) : Math.min(-1, sim.notch + 1);
  };
  let steps = 0;
  while (!sim.ended && steps++ < (2 * 3600) / DT) {
    const w = want();
    if (w === null || w === 'coast') {
      if (!(sim.v < 0.5 && sim._left)) auto();
      /* 「ブレーキまで あと ◯m」の あいだ: 自動運転は 制限・信号のためだけ ブレーキを つかう(駅のための
       * ブレーキは こどもが「いま！」で かける) */
      if (w === 'coast' && sim.notch < 0) {
        const a = sim.atsInfo;
        if (!(a && a.kind !== 'stop' && sim.v > a.target - 1)) sim.setNotch(0);
      }
    }
    else if (sim.t >= nextAct && w !== sim.notch) {
      press(w > sim.notch ? 1 : -1);   // 「◯かい」でも 1回ずつ(つぎは また はんのう時間のあと)
      nextAct = sim.t + react;
    }
    /* 手前で止まった: コーチの「すこし すすもう」で P1 まで あげる(のぼり坂で うごかなければ もう1段) */
    if (sim.v < 0.05 && sim._left && !sim.doorOpen) {
      const nx = sim.stops[sim.stopIdx];
      const dist = nx ? nx.stopAt - sim.pos : 0;
      if (dist > 0.5 && dist < 250 && sim.t >= nextAct) {
        if (sim.notch < 1 || (sim.notch < 4 && ++creepWait >= 3)) { press(1); creepWait = 0; }
        nextAct = sim.t + react;
      }
    } else creepWait = 0;
    sim.tick(DT);
  }
  const errs = stops.filter((s) => !s.over).map((s) => Math.abs(s.err)).sort((a, b) => a - b);
  const res = sim.result();
  return {
    stops,
    n: stops.length,
    stamp: errs.filter((a) => a <= 1).length,
    gold: errs.filter((a) => a <= 0.1).length,
    median: errs.length ? errs[Math.floor(errs.length / 2)] : 99,
    presses: stops.reduce((a, s) => a + (s.presses || 0), 0) / Math.max(1, stops.length),
    rev: stops.reduce((a, s) => a + (s.rev || 0), 0) / Math.max(1, stops.length),
    total: res.total, rank: res.rank, finished: sim.finished,
  };
}

console.log(`=== こどもボット: ${service} ${weather} ${DIR} ===`);
console.log('方針 はんのう  駅  スタンプ(±1m) きん(±10cm) ずれ中央値  おす回数/駅  もどし/駅  点数');
let fail = false;
for (const policy of ['a', 'b']) {
  for (const react of [0.6, 0.8, 1.0, 1.2]) {
    const r = drive(policy, react);
    console.log(`(${policy})   ${react.toFixed(1)}秒   ${String(r.n).padStart(2)}   ${String(r.stamp).padStart(6)}        ${String(r.gold).padStart(4)}       ${r.median.toFixed(2).padStart(5)}m`
      + `      ${r.presses.toFixed(1).padStart(4)}       ${r.rev.toFixed(1).padStart(4)}    ${r.total} ${r.rank}${r.finished ? '' : ' (完走できず)'}`);
    if (VERBOSE) console.log('   ', r.stops.map((s) => `${s.name}${s.over ? '!' : ''} ${s.err.toFixed(2)}`).join(' / '));
    if (policy === 'b' && (r.stamp < 13 || r.median > 0.7 || !r.finished)) fail = true;
  }
}
const strict = service === 'local' && weather === 'clear' && DIR === 'down';
if (strict && fail) { console.error('★ (b) が めやす(スタンプ13駅以上・中央値0.7m以下)に とどかない'); process.exit(1); }
console.log(strict ? 'OK' : '(めやすの判定は くだり・各停・晴れ だけ)');
