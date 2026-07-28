/* =========================================================
 * autodrive.mjs — 自動運転ボットによるエンジン回帰テスト&ダイヤ校正
 * ・全区間を惰行込みで自走し、停止精度/ATS無違反/完走を検証
 * ・--calibrate で実走タイムから data/timetable.json を生成
 * 使い方: node autodrive.mjs [local|exp|rapid] [clear|rain] [--calibrate]
 * ========================================================= */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TrainSim, TRAIN } from '../sim/engine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const line = JSON.parse(readFileSync(join(__dirname, '..', 'data', 'line.json'), 'utf8'));
const CAL = process.argv.includes('--calibrate');
let timetable = null;
try { timetable = JSON.parse(readFileSync(join(__dirname, '..', 'data', 'timetable.json'), 'utf8')); } catch (e) { /* 未生成 */ }

/* --- 自動運転ロジック（人間らしい運転: 力行→惰行→ブレーキ） --- */
function makeDriver(sim) {
  let lastChange = -9, lastNotch = 0;
  const set = (n) => {
    if (n === lastNotch) return;
    /* ノッチ操作は0.6秒に1回まで（ガチャガチャ防止）。ただし強いブレーキ要求は即時 */
    if (sim.t - lastChange < 0.6 && !(n < lastNotch && n <= -4)) return;
    lastChange = sim.t; lastNotch = n;
    sim.setNotch(n);
  };
  return () => {
    const h = sim.hud();
    if (h.doorOpen) { set(0); return; }
    const v = h.v;
    const target = sim.stops[sim.stopIdx];
    const d = target ? target.stopAt - sim.pos : 1e9;
    const bGrade = 9.81 * (h.grade / 1000) * 3.6;   // 下り勾配なら負値=加速側

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

    const bWant = Math.max(bNeed > 0.8 && d < 1000 ? bNeed : 0, bRest > 0.72 ? bRest : 0);
    if (bWant > 0) {
      let b = bWant * (d < 45 ? 1.0 : 1.1) - Math.min(0, bGrade);   // 下りは強め
      const step = Math.ceil((b / TRAIN.maxServiceB) * TRAIN.brakeSteps + 0.25);
      /* 停止寸前は弱めて滑らかに、直前で確実に */
      if (d < 2.2 && v < 3.5) { set(-3); return; }
      if (d < 12 && v < 8 && bNeed < 1.6) { set(-1); return; }
      set(-Math.min(7, Math.max(1, step)));
      return;
    }

    /* 停止直前に手前で止まりかけたら追い上げ（突き上げ） */
    if (d > 1.4 && d < 60 && v < 4 && bNeed < 1.2) { set(1); return; }

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

function run(service, weather, tt) {
  const sim = new TrainSim(line, { service, weather, timetable: tt });
  const events = [];
  sim.onEvent((type, e) => events.push({ t: sim.t, pos: Math.round(sim.pos), v: Math.round(sim.v), type, ...e }));
  const drive = makeDriver(sim);
  const DT = 0.05;
  let steps = 0;
  const MAX = (3600 * 2) / DT;
  const arrivals = [];
  sim.onEvent((type, e) => { if (type === 'arrived') arrivals.push({ t: sim.t, name: e.name }); });
  while (!sim.ended && steps++ < MAX) { drive(); sim.tick(DT); }
  return { sim, events, arrivals };
}

if (CAL) {
  /* 実走タイムに+余裕を載せて公式ダイヤ化。
   * 先行列車(信号)の環境がダイヤ自身に依存するため、2パスで収束させる */
  const calOnce = (ttIn) => {
    const out = {};
    for (const svc of ['local', 'exp', 'rapid']) {
      const { sim } = run(svc, 'clear', ttIn);
      if (!sim.finished) { console.error('校正走行が完走できず:', svc); process.exit(1); }
      const dwell = sim.service.dwell;
      const tt = [[0, 30]];
      let prevDep = 30;
      const arrs = sim.log.filter((l) => l.type === 'arrived');
      arrs.forEach((a, i) => {
        const depAbsPrev = i === 0 ? sim.timetable[0].dep : Math.max(arrs[i - 1].t + dwell, sim.timetable[i].dep);
        const runSec = Math.ceil((a.t - depAbsPrev + 8) / 5) * 5;
        const arr = prevDep + runSec;
        tt.push([arr, arr + dwell]);
        prevDep = arr + dwell;
      });
      out[svc] = tt;
    }
    return out;
  };
  let tt = calOnce(null);
  tt = calOnce(tt);   // 2パス目: 1パス目のダイヤで走る先行列車のもとで再計測
  tt = calOnce(tt);   // 3パス目で収束させる
  for (const svc of ['local', 'exp', 'rapid']) {
    const last = tt[svc][tt[svc].length - 1][0];
    console.log(svc, '所要', Math.floor(last / 60), '分', last % 60, '秒');
  }
  writeFileSync(join(__dirname, '..', 'data', 'timetable.json'), JSON.stringify(tt));
  console.log('data/timetable.json を書き出しました');
  process.exit(0);
}

const service = process.argv[2] || 'local';
const weather = process.argv[3] || 'clear';
const { sim, events } = run(service, weather, timetable);
const res = sim.result();
console.log('=== 自動運転結果:', service, weather, timetable ? '(校正ダイヤ)' : '(仮ダイヤ)', '===');
console.log('所要時間:', Math.floor(sim.t / 60), '分', Math.round(sim.t % 60), '秒 / ダイヤ:',
  Math.floor(sim.timetable[sim.timetable.length - 1].arr / 60), '分');
console.log('スコア:', res.total, res.rank, JSON.stringify(res.breakdown));
console.log('ATS照査ブレーキ:', res.overspeed, '回 / EB:', res.ebUsed, '/ ジャーク:', res.jerkEvents);
let bad = 0;
res.stops.forEach((st) => {
  const flag = Math.abs(st.err) > 2 ? ' ★' : '';
  if (Math.abs(st.err) > 2) bad++;
  console.log(` ${st.name.padEnd(7, '　')} 誤差 ${String(st.err.toFixed(2)).padStart(7)}m  遅延 ${st.late}s${flag}`);
});
console.log('停止2m超:', bad, '/ オーバーラン:', events.filter((e) => e.type.startsWith('overrun')).length);
events.filter((e) => e.type === 'ats-brake').forEach((e) => console.log('  ats-brake @', e.pos, 'm v=', e.v));
if (!sim.finished) { console.error('★ 完走できず（位置:', Math.round(sim.pos), 'm 速度:', sim.v.toFixed(1), '）'); process.exit(1); }
if (res.overspeed > 0) { console.error('★ ATS照査が作動'); process.exit(1); }
console.log('OK');
