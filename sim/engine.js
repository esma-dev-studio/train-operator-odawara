/* =========================================================
 * sim/engine.js — 運転シミュレーションエンジン（DOM非依存）
 * 物理・保安装置(ATS-P風)・信号・ダイヤ・評定を担当。
 * ブラウザ/Node両対応のESモジュール。描画や音は一切持たない。
 * ========================================================= */

/* ---- 車両諸元（8両編成の通勤型・架空車） ---- */
export const TRAIN = {
  length: 160,          // m
  maxAccel: 3.3,        // km/h/s（起動加速度）
  constPowerV: 42,      // km/h これ以上は特性域で加速度が逓減
  brakeSteps: 7,        // B1..B7
  maxServiceB: 4.0,     // km/h/s（B7）
  ebDecel: 4.6,         // km/h/s
  brakeFill: 1.1,       // s ブレーキ込め時定数
  brakeRelease: 1.5,    // s 緩め時定数
  tractionRise: 1.15,   // s 力行立ち上がり
  notchP: 4,
};

export const SERVICES = {
  local:  { name: '各駅停車', stops: null, dwell: 25 },
  exp:    { name: '急行', dwell: 30,
    stops: ['新宿', '代々木上原', '下北沢', '経堂', '成城学園前', '登戸', '向ヶ丘遊園', '新百合ヶ丘'] },
  rapid:  { name: '快速急行', dwell: 30,
    stops: ['新宿', '代々木上原', '下北沢', '登戸', '新百合ヶ丘'] },
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class TrainSim {
  /* line: data/line.json の内容 / opts: {service:'local'|'exp'|'rapid', weather:'clear'|'rain'} */
  constructor(line, opts = {}) {
    this.line = line;
    this.step = line.meta.step;
    this.service = SERVICES[opts.service || 'local'];
    this.serviceKey = opts.service || 'local';
    this.weather = opts.weather || 'clear';

    /* 停車駅リスト（各停は全駅） */
    const stopNames = this.service.stops;
    this.stops = line.stations.filter((st) => !stopNames || stopNames.includes(st.name));
    this.allStations = line.stations;

    /* 停止位置: ホーム新宿方端から120m地点を目標（8両=160mだが見た目上一律） */
    this.stops = this.stops.map((st) => ({ ...st, stopAt: st.s }));

    /* ダイヤ: 校正済みテーブル(data/timetable.json)があればそれを使う */
    this.timetable = (opts.timetable && opts.timetable[this.serviceKey])
      ? opts.timetable[this.serviceKey].map((x) => ({ arr: x[0], dep: x[1] }))
      : this._buildTimetable();

    /* 信号機の配置: 各駅ホーム先端(出発)+駅間の閉塞（約1km毎） */
    this.signals = this._placeSignals();

    /* 仮想先行列車（同種別・3分前を走る）*/
    this.leadOffset = 180;

    this.reset(0);
  }

  /* ============ 状態リセット（idx番目の停車駅から開始） ============ */
  reset(stopIdx) {
    const st = this.stops[stopIdx];
    this.pos = st.stopAt;          // 先頭位置(m)
    this.v = 0;                    // km/h
    this.notch = 0;                // +4..-8(EB)
    this.accelCur = 0;             // 実効力行加速度（立ち上がり済み）
    this.brakeCur = 0;             // 実効ブレーキ減速度
    this.t = this.timetable[stopIdx].dep - 20;   // 発車20秒前から
    this.startIdx = stopIdx;       // いま停車している駅
    this.stopIdx = stopIdx + 1;    // 次に停まる駅のindex
    this.doorOpen = true;
    this.doorCloseAt = null;
    this.departBell = false;
    this.stoppedAt = null;
    this.finished = false;
    this.ended = false;
    this.slipping = false;

    this.atsLamp = 'normal';       // normal | pattern | brake
    this.atsBrakeUntil = 0;

    this.log = [];
    this.score = {
      stops: [],                   // {name, err, pts(0-30換算前の0-1), late}
      overspeed: 0,                // 照査ブレーキ回数
      overspeedTime: 0,            // 制限超過秒数（照査前の軽微含む）
      ebUsed: 0,
      jerkEvents: 0,
      maxJerkWindow: 0,
      lateSum: 0,
    };
    this._lastA = 0;
    this._doorPhase = 'boarding';  // boarding→closing→ready→run
    this._stopEval = null;
    this._departTime = this.timetable[stopIdx].dep;
    this._eventCb = null;
  }

  onEvent(cb) { (this._eventCbs = this._eventCbs || []).push(cb); }
  _emit(type, data) {
    (this._eventCbs || []).forEach((cb) => cb(type, data || {}));
    this.log.push({ t: this.t, pos: Math.round(this.pos), type, ...data });
  }

  /* ============ ダイヤ ============ */
  _buildTimetable() {
    const table = [];
    let t = 0;
    for (let i = 0; i < this.stops.length; i++) {
      if (i === 0) {
        table.push({ arr: 0, dep: 30 });
        t = 30;
        continue;
      }
      const d = this.stops[i].stopAt - this.stops[i - 1].stopAt;
      /* 駅間所要: 平均速度(種別と距離で変える)+加減速ロス */
      const vAvg = this.serviceKey === 'local' ? 15.5 : (d > 3000 ? 22 : 17);   // m/s
      const run = Math.ceil((d / vAvg + 20) / 5) * 5;
      const arr = t + run;
      const dep = arr + this.service.dwell;
      table.push({ arr, dep });
      t = dep;
    }
    return table;
  }

  /* ============ 信号 ============ */
  _placeSignals() {
    const sigs = [];
    /* 出発信号: 各「停車駅」の先端+40m */
    this.stops.forEach((st, i) => {
      if (i < this.stops.length - 1) sigs.push({ s: st.stopAt + 40, kind: 'dep', stopIdx: i });
    });
    /* 閉塞信号: 全駅間を~1.1kmで分割 */
    for (let s = 900; s < this.line.meta.length - 400; s += 1100) {
      sigs.push({ s, kind: 'block' });
    }
    sigs.sort((a, b) => a.s - b.s);
    return sigs;
  }

  /* 仮想先行列車の位置（同ダイヤを leadOffset 秒先行）
   * 駅間は加減速つきの速度カーブ(smootherstep)で走らせる。
   * 線形（等速）だと快走区間でプレイヤーが追いついてしまうため。 */
  _leadPos(t) {
    const tt = t + this.leadOffset;
    const tb = this.timetable;
    if (tt >= tb[tb.length - 1].arr) return 1e9;   // もう終点到着済み
    for (let i = 0; i < tb.length - 1; i++) {
      if (tt < tb[i].dep) return this.stops[i].stopAt;              // 駅停車中
      if (tt < tb[i + 1].arr) {
        const u = (tt - tb[i].dep) / (tb[i + 1].arr - tb[i].dep);
        const k = u * u * u * (u * (u * 6 - 15) + 10);              // 中間で最高約1.9倍速
        return this.stops[i].stopAt + (this.stops[i + 1].stopAt - this.stops[i].stopAt) * k;
      }
    }
    return 1e9;
  }

  /* 信号現示: 0=R 1=Y 2=YG 3=G */
  signalAspect(sig) {
    /* 出発信号: 自駅停車中は発車時刻-15sまでR */
    if (sig.kind === 'dep' && sig.stopIdx === this.stopIdx - 1 && this.v < 1) {
      if (this.t < this._departTime - 15) return 0;
    }
    const lead = this._leadPos(this.t);
    const tail = lead - TRAIN.length;
    /* この信号の防護区間 = この信号から次の信号まで */
    const idx = this.signals.indexOf(sig);
    const next1 = this.signals[idx + 1] ? this.signals[idx + 1].s : 1e9;
    const next2 = this.signals[idx + 2] ? this.signals[idx + 2].s : 1e9;
    if (tail > sig.s && tail <= next1) return 0;
    if (tail > next1 && tail <= next2) return 1;
    if (tail > next2 && tail <= (this.signals[idx + 3] ? this.signals[idx + 3].s : 1e9)) return 2;
    return 3;
  }

  /* 前方の信号（表示・照査用） */
  nextSignals(count = 3) {
    const out = [];
    for (const sig of this.signals) {
      if (sig.s > this.pos - 5 && out.length < count) {
        out.push({ ...sig, aspect: this.signalAspect(sig), dist: sig.s - this.pos });
      }
    }
    return out;
  }

  /* ============ 制限速度 ============ */
  limitAt(s) {
    let v = this.line.lineMax;
    for (const z of this.line.limits) {
      if (s >= z.from - 0 && s < z.to) v = Math.min(v, z.v);
    }
    return v;
  }

  /* 前方の速度制限（現在位置から先の最初の「より低い」制限） */
  nextRestriction() {
    const cur = this.limitAt(this.pos);
    let best = null;
    for (const z of this.line.limits) {
      if (z.from > this.pos && z.v < cur) {
        if (!best || z.from < best.from) best = z;
      }
      if (best && z.from > best.from + 2500) break;
    }
    /* 停止目標（停車駅）と信号Rも制限として扱う */
    const stopTarget = this.stops[this.stopIdx] && this.pos < this.stops[this.stopIdx].stopAt
      ? { from: this.stops[this.stopIdx].stopAt, v: 0, kind: 'stop' } : null;
    let sigTarget = null;
    for (const sig of this.nextSignals(3)) {
      if (sig.aspect === 0 && sig.dist > 2) { sigTarget = { from: sig.s - 20, v: 0, kind: 'signal' }; break; }
      if (sig.aspect === 1 && sig.dist > 2) { sigTarget = { from: sig.s, v: 45, kind: 'signal' }; break; }
      if (sig.aspect === 2 && sig.dist > 2) { sigTarget = { from: sig.s, v: 75, kind: 'signal' }; break; }
    }
    const cands = [best, stopTarget, sigTarget].filter(Boolean);
    if (!cands.length) return null;
    /* パターンが一番きついものを返す */
    let tightest = null, bestMargin = 1e9;
    for (const c of cands) {
      const margin = this.patternSpeed(c) - this.v;
      if (margin < bestMargin) { bestMargin = margin; tightest = c; }
    }
    return tightest;
  }

  /* ATSパターン速度（この制限に対して現在位置で許される速度） */
  patternSpeed(rest) {
    const d = Math.max(0, rest.from - this.pos);
    const bp = 2.6;                        // パターン勾配 km/h/s 相当
    /* v^2 = vt^2 + 2*b*d の km/h・m 版: v = sqrt(vt^2 + 7.2*b*d*?)
     * a[km/h/s] → a/3.6 m/s^2。 v[m/s]^2 = vt^2 + 2a d → (v/3.6)^2 ... */
    const vt = rest.v / 3.6;
    const a = bp / 3.6;
    const vm = Math.sqrt(vt * vt + 2 * a * d);
    return vm * 3.6;
  }

  /* ============ 勾配 ============ */
  gradeAt(s) {
    const i = clamp(Math.round(s / this.step), 1, this.line.pts.length - 2);
    const dz = this.line.pts[i + 1][2] - this.line.pts[i - 1][2];
    return (dz / (2 * this.step)) * 1000;   // ‰
  }

  /* ============ ノッチ操作 ============ */
  setNotch(n) {
    n = clamp(Math.round(n), -8, 4);
    if (this.notch === n) return;
    /* 停車中でドアが開いていたら力行は入らない */
    if (n > 0 && this.doorOpen) return;
    this.notch = n;
    if (n === -8) { this.score.ebUsed++; this._emit('eb'); }
  }

  /* ============ 毎フレーム ============ */
  tick(dt) {
    if (this.ended) return;
    dt = Math.min(dt, 0.1);
    this.t += dt;

    /* --- ドア・発車フロー --- */
    if (this.doorOpen) {
      const dep = this._departTime;
      if (this._doorPhase === 'boarding' && this.t >= dep - 10) {
        this._doorPhase = 'closing';
        this._emit('door-closing');
      }
      if (this._doorPhase === 'closing' && this.t >= dep - 4) {
        this.doorOpen = false;
        this._doorPhase = 'ready';
        this._emit('door-closed');
      }
    }

    /* --- 力行/ブレーキの実効値（応答遅れ） --- */
    const wantA = this.notch > 0 && !this.doorOpen
      ? TRAIN.maxAccel * (this.notch / TRAIN.notchP) * (this.v <= TRAIN.constPowerV ? 1 : TRAIN.constPowerV / this.v)
      : 0;
    const kA = 1 - Math.exp(-dt / TRAIN.tractionRise);
    this.accelCur += (wantA - this.accelCur) * kA;

    const wantB = this.notch === -8 ? TRAIN.ebDecel
      : this.notch < 0 ? TRAIN.maxServiceB * (-this.notch / TRAIN.brakeSteps)
      : 0;
    const kB = 1 - Math.exp(-dt / (wantB > this.brakeCur ? TRAIN.brakeFill : TRAIN.brakeRelease));
    this.brakeCur += (wantB - this.brakeCur) * kB;

    /* --- ATS照査 --- */
    const rest = this.nextRestriction();
    let atsBrake = 0;
    this.atsInfo = null;
    if (rest) {
      const vp = this.patternSpeed(rest);
      this.atsInfo = { target: rest.v, at: rest.from, pattern: vp, kind: rest.kind || 'limit' };
      if (this.v > vp + 2 && this.v > 8) {   // +2km/hは照査余裕（実物の設計余裕相当）
        if (this.atsLamp !== 'brake') { this._emit('ats-brake'); this.score.overspeed++; }
        this.atsLamp = 'brake';
        this.atsBrakeUntil = this.t + 2;
      } else if (this.v > vp - 5) {
        if (this.atsLamp === 'normal') this._emit('ats-chime');
        if (this.atsLamp !== 'brake') this.atsLamp = 'pattern';
      } else if (this.t > this.atsBrakeUntil) {
        this.atsLamp = 'normal';
      }
    } else if (this.t > this.atsBrakeUntil) {
      this.atsLamp = 'normal';
    }
    if (this.atsLamp === 'brake') atsBrake = TRAIN.maxServiceB;

    /* --- 現在制限の超過（照査+軽微減点） --- */
    const curLimit = this.limitAt(this.pos);
    if (this.v > curLimit + 1) this.score.overspeedTime += dt;
    if (this.v > curLimit + 3) {
      if (this.atsLamp !== 'brake') { this._emit('ats-brake'); this.score.overspeed++; }
      this.atsLamp = 'brake';
      this.atsBrakeUntil = this.t + 2;
      atsBrake = TRAIN.maxServiceB;
    }

    /* --- 粘着（雨） --- */
    const adhesionCap = this.weather === 'rain' ? 3.3 : 4.4;
    let effB = Math.max(this.brakeCur, atsBrake);
    this.slipping = effB > adhesionCap;
    if (this.slipping) effB = adhesionCap * 0.92;

    /* --- 合成加速度 --- */
    const grade = this.gradeAt(this.pos);
    const aGrade = -9.81 * (grade / 1000) * 3.6;                  // km/h/s
    const aRes = -(0.06 + 0.0006 * this.v + 0.000013 * this.v * this.v) * (this.v > 0 ? 1 : 0);
    let a = this.accelCur - effB + aGrade + aRes;
    if (this.v <= 0 && a < 0) a = 0;

    /* --- ジャーク計測（乗り心地）: 通常のノッチ操作では出ない急変だけ数える --- */
    const jerk = Math.abs(a - this._lastA) / dt;
    if (jerk > 4.5 && this.v > 3) {
      if (this.t - (this._lastJerkT || -9) > 1.0) this.score.jerkEvents++;
      this._lastJerkT = this.t;
    }
    this._lastA = a;

    /* --- 積分 --- */
    this.v = Math.max(0, this.v + a * dt);
    this.pos += (this.v / 3.6) * dt;

    /* --- 停車判定 --- */
    const target = this.stops[this.stopIdx] ? this.stops[this.stopIdx].stopAt : null;
    if (this.v > 0.5) this._left = true;   // 一度動き出してから停まったら「到着」扱いにする
    if (target != null && this._left && this.stoppedAt == null && this.v < 0.05) {
      const err = this.pos - target;
      if (err >= -12 && err <= 12) {
        this._arrive(err);
      } else if (err > 12) {
        this._emit('overrun-stop', { err });   // 大オーバーラン: UI側でリトライ案内
        this.stoppedAt = this.t;               // 二重発火防止
      }
    }
    /* オーバーラン警告（通過しはじめた瞬間） */
    if (target != null && this.pos > target + 10 && this._pastWarn !== this.stopIdx && this._left) {
      this._pastWarn = this.stopIdx;
      this._emit('overrun', { err: this.pos - target });
    }

    /* 終端防護（新百合ヶ丘の先） */
    if (this.pos > this.line.meta.length - 60 && this.stopIdx >= this.stops.length - 1 && this.stoppedAt == null) {
      /* 過走で車止めに接近 → 強制EB */
      if (this.pos > this.line.meta.length - 30) {
        this.notch = -8;
      }
    }
  }

  _arrive(err) {
    this.stoppedAt = this.t;
    const sch = this.timetable[this.stopIdx];
    const late = Math.max(0, this.t - sch.arr);
    const early = Math.max(0, sch.arr - this.t);
    this.score.stops.push({
      name: this.stops[this.stopIdx].name,
      err: Math.round(err * 100) / 100,
      late: Math.round(late),
      early: Math.round(early),
    });
    this.score.lateSum += late;
    this._emit('arrived', { name: this.stops[this.stopIdx].name, err, late });

    if (this.stopIdx >= this.stops.length - 1) {
      this.finished = true;
      this.ended = true;
      this._emit('finished', this.result());
      return;
    }
    /* 次駅へ */
    this.stopIdx++;
    this.doorOpen = true;
    this._doorPhase = 'boarding';
    this._left = false;
    this.stoppedAt = null;
    /* 発車時刻: ダイヤ or 遅延時は最短折返し（停車時分確保） */
    const dep = this.timetable[this.stopIdx - 1].dep;
    this._departTime = Math.max(dep, this.t + this.service.dwell);
    this._emit('door-open', { departAt: this._departTime });
  }

  /* ============ 評定 ============ */
  result() {
    const S = this.score;
    /* 停止精度 30点 */
    let stopPts = 0;
    S.stops.forEach((st) => {
      const e = Math.abs(st.err);
      stopPts += e <= 0.35 ? 1 : e <= 1 ? 0.85 : e <= 2 ? 0.6 : e <= 5 ? 0.35 : 0;
    });
    stopPts = S.stops.length ? (stopPts / S.stops.length) * 30 : 0;
    /* 定時 30点（駅平均遅延: 5秒以内満点、60秒で0） */
    const avgLate = S.stops.length ? S.lateSum / S.stops.length : 60;
    const timePts = clamp(1 - Math.max(0, avgLate - 5) / 55, 0, 1) * 30;
    /* 遵守 25点 */
    const compPts = clamp(1 - S.overspeed * 0.34 - S.overspeedTime * 0.02 - S.ebUsed * 0.5, 0, 1) * 25;
    /* 乗り心地 15点 */
    const ridePts = clamp(1 - S.jerkEvents * 0.06, 0, 1) * 15;
    const total = Math.round(stopPts + timePts + compPts + ridePts);
    const rank = total >= 95 ? 'S' : total >= 85 ? 'A' : total >= 70 ? 'B' : total >= 55 ? 'C' : 'D';
    return {
      total, rank,
      breakdown: {
        stop: Math.round(stopPts * 10) / 10,
        time: Math.round(timePts * 10) / 10,
        comp: Math.round(compPts * 10) / 10,
        ride: Math.round(ridePts * 10) / 10,
      },
      stops: S.stops,
      overspeed: S.overspeed,
      ebUsed: S.ebUsed,
      jerkEvents: S.jerkEvents,
    };
  }

  /* ============ 表示用ヘルパー ============ */
  hud() {
    const next = this.stops[this.stopIdx];
    const sch = this.timetable[this.stopIdx];
    return {
      v: this.v,
      pos: this.pos,
      notch: this.notch,
      bc: this.brakeCur,
      doorOpen: this.doorOpen,
      atsLamp: this.atsLamp,
      ats: this.atsInfo,
      limit: this.limitAt(this.pos),
      grade: this.gradeAt(this.pos),
      next: next ? { name: next.name, code: next.code, dist: next.stopAt - this.pos, arr: sch.arr, dep: this._departTime } : null,
      t: this.t,
      slipping: this.slipping,
      finished: this.finished,
    };
  }
}
