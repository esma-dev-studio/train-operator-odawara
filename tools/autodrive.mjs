/* =========================================================
 * autodrive.mjs — 自動運転ボットによるエンジン回帰テスト&ダイヤ校正
 * ・全区間を惰行込みで自走し、停止精度/ATS無違反/完走を検証
 * ・--calibrate で実走タイムから data/timetable.json を生成
 * 使い方: node autodrive.mjs [local|exp|rapid] [clear|rain|snow] [up] [--calibrate]
 *   up = のぼり(新百合ヶ丘→新宿)。--calibrate はくだり・のぼり両方を校正する
 * ========================================================= */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TrainSim } from '../sim/engine.js';
import { makeAutopilot } from '../sim/autopilot.js';
import { prepareLine } from '../sim/line.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rawLine = JSON.parse(readFileSync(join(__dirname, '..', 'data', 'line.json'), 'utf8'));
const DIR = process.argv.includes('up') ? 'up' : 'down';
const line = prepareLine(rawLine, DIR);
const CAL = process.argv.includes('--calibrate');
let timetable = null;
try { timetable = JSON.parse(readFileSync(join(__dirname, '..', 'data', 'timetable.json'), 'utf8')); } catch (e) { /* 未生成 */ }

function run(service, weather, tt, ln = line) {
  const sim = new TrainSim(ln, { service, weather, timetable: tt });
  const events = [];
  sim.onEvent((type, e) => events.push({ t: sim.t, pos: Math.round(sim.pos), v: Math.round(sim.v), type, ...e }));
  const drive = makeAutopilot(sim);
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
    for (const [svc, dir] of [['local', 'down'], ['exp', 'down'], ['rapid', 'down'], ['local', 'up'], ['exp', 'up'], ['rapid', 'up']]) {
      const key = svc + (dir === 'up' ? '_up' : '');
      const { sim } = run(svc, 'clear', ttIn, prepareLine(rawLine, dir));
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
      out[key] = tt;
    }
    return out;
  };
  let tt = calOnce(null);
  tt = calOnce(tt);   // 2パス目: 1パス目のダイヤで走る先行列車のもとで再計測
  tt = calOnce(tt);   // 3パス目で収束させる
  for (const key of Object.keys(tt)) {
    const last = tt[key][tt[key].length - 1][0];
    console.log(key, '所要', Math.floor(last / 60), '分', last % 60, '秒');
  }
  writeFileSync(join(__dirname, '..', 'data', 'timetable.json'), JSON.stringify(tt));
  console.log('data/timetable.json を書き出しました');
  process.exit(0);
}

const service = process.argv[2] || 'local';
const weather = ['clear', 'rain', 'snow'].includes(process.argv[3]) ? process.argv[3] : 'clear';
const { sim, events } = run(service, weather, timetable);
const res = sim.result();
console.log('=== 自動運転結果:', service, weather, DIR, timetable ? '(校正ダイヤ)' : '(仮ダイヤ)', '===');
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
