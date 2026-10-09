/* =========================================================
 * scene/traffic.js — 沿線を走るほかの列車と、外から見た自列車
 * ・対向列車(となりの線路を向こうから来る。各停は駅に止まる)
 * ・複々線区間の急行線を追い抜いていく/すれちがう列車
 * ・カメラが外のときに見える自列車(8両)
 * 描画専用(運転の判定には関わらない)。
 * ========================================================= */
import * as THREE from '../vendor/three.module.min.js';
import { frameAt } from './scene.js';

const CAR = 20.0;          // 連結面間(m)
const BOGIE = 6.9;         // 台車中心の前後位置
const RAIL_TOP = 0.19;

const _p1 = new THREE.Vector3(), _p2 = new THREE.Vector3(), _dir = new THREE.Vector3();

/* 1編成を線路に沿わせて置く。headS=先頭の位置、dir=+1(s増える向きに走る)/-1 */
export function placeTrain(rs, train, headS, dir, offset) {
  const L = rs.line.meta.length;
  train.cars.forEach((car, i) => {
    const center = headS - dir * (CAR * (i + 0.5));
    const a = Math.max(1, Math.min(L - 1, center + BOGIE));
    const b = Math.max(1, Math.min(L - 1, center - BOGIE));
    const fa = frameAt(rs.frames, rs.step, a), fb = frameAt(rs.frames, rs.step, b);
    _p1.copy(fa.p).addScaledVector(fa.left, offset);
    _p2.copy(fb.p).addScaledVector(fb.left, offset);
    car.position.copy(_p1).add(_p2).multiplyScalar(0.5);
    car.position.y += RAIL_TOP;
    _dir.copy(_p1).sub(_p2).multiplyScalar(dir);
    car.lookAt(_dir.add(car.position));
  });
}

class AiTrain {
  constructor(rs, opts) {
    this.rs = rs;
    Object.assign(this, opts);   // offset, dir, stops, vmax, cars, kind, dest, zone
    this.model = rs.makeTrainModel(this.nCars, { kind: this.kind, dest: this.dest });
    rs.world.add(this.model.group);
    rs.setTrainLights(this.model, { head: true, tail: true });
    this.v = this.v0 || 0;
    this.dwell = 0;
    this.stoppedAt = null;
    this.done = false;
  }

  /* 次に止まる駅(進行方向の先)の停止点 */
  _nextStop() {
    const st = this.rs.line.stations;
    const term = this.dir < 0 ? st[0] : st[st.length - 1];
    let best = null;
    for (const x of st) {
      /* 通過列車も終点だけは止まる */
      if (!this.stops && x !== term) continue;
      /* 反対線(-s向き)の停止点はホームの逆端(駅のs-140付近)。同方向なら駅のsそのもの */
      const at = this.dir > 0 ? x.s : x.s - 140;
      const ahead = (at - this.s) * this.dir;
      if (ahead > 0.5 && (this.stoppedAt === null || Math.abs(at - this.stoppedAt) > 5)) {
        if (!best || ahead < best.ahead) best = { at, ahead, terminal: x === term };
      }
    }
    return best;
  }

  update(dt) {
    if (this.done || dt <= 0) return;
    const sim = this.rs.sim;
    if (this.dwell > 0) {
      this.dwell -= dt;
      if (this.dwell <= 0) this.v = 0.1;
    } else {
      /* 目標速度: 制限(前方300mまで)と自分の上限 */
      let vt = this.vmax;
      for (let k = 0; k <= 300; k += 75) vt = Math.min(vt, sim.limitAt(this.s + this.dir * k) / 3.6);
      const ns = this._nextStop();
      if (ns) vt = Math.min(vt, Math.max(0.4, Math.sqrt(2 * 0.75 * Math.max(0, ns.ahead - 0.5))));
      if (this.v < vt) this.v = Math.min(vt, this.v + 0.8 * dt);
      else this.v = Math.max(vt, this.v - 1.1 * dt);
      this.s += this.dir * this.v * dt;
      if (ns && ns.ahead < 1.0) {
        /* 終点(頭端)に着いたらそのまま留置 */
        this.v = 0; this.dwell = ns.terminal ? Infinity : 18; this.stoppedAt = ns.at;
      }
    }
    /* 区間(複々線など)の外に出たら消える */
    const tail = this.s - this.dir * this.nCars * CAR;
    const lo = Math.min(this.s, tail), hi = Math.max(this.s, tail);
    if (this.zone && (lo < this.zone.from || hi > this.zone.to)) { this.done = true; }
    if (lo < 2 || hi > this.rs.line.meta.length - 2) this.done = true;
    /* 自列車から十分はなれたら役目終わり */
    const me = sim.pos;
    if (this.dir < 0 && hi < me - 700) this.done = true;
    if (this.dir > 0 && lo > me + 1800) this.done = true;
    if (this.dir > 0 && hi < me - 1500) this.done = true;
    this.model.group.visible = !this.done;
    if (!this.done) placeTrain(this.rs, this.model, this.s, this.dir, this.offset);
  }

  /* 自列車との位置関係(音用): 0=横にいる、±=前後の距離、相対速度 */
  /* 音用: 相手の編成中心までの距離(+前方)と、近づく速さ(+接近/−遠ざかる) */
  passing(me, vMe) {
    const center = this.s - this.dir * this.nCars * CAR * 0.5;
    const dist = center - (me - 80);
    const vRel = this.dir * this.v - vMe;
    const closing = dist === 0 ? 0 : -Math.sign(dist) * vRel;
    return { dist, relSpeed: closing, offset: this.offset };
  }

  dispose() {
    this.rs.world.remove(this.model.group);
    this.rs.disposeTrainModel(this.model);
  }
}

export class Traffic {
  constructor(rs, sim) {
    this.rs = rs;
    this.list = [];
    this.cool = { opp: 8, quadSame: 25, quadOpp: 40 };
    this.rng = 1234567;
    /* 自列車(外から見るカメラ用) */
    const dest = rs.line.meta.direction === 'up' ? '新宿' : '新百合ヶ丘';
    this.own = rs.makeTrainModel(8, { kind: sim ? sim.serviceKey : 'local', dest, own: true });
    this.own.group.visible = false;
    rs.world.add(this.own.group);
    rs.setTrainLights(this.own, { head: true, tail: true });
    this.reset(sim);
  }

  _rand() { this.rng = (this.rng * 16807) % 2147483647; return this.rng / 2147483647; }

  reset(sim) {
    this.list.forEach((t) => t.dispose());
    this.list = [];
    this.cool = { opp: 6, quadSame: 25, quadOpp: 40 };
    if (sim && this.own && this.rs.setTrainDest) {
      this.rs.setTrainDest(this.own, sim.serviceKey, this.rs.line.meta.direction === 'up' ? '新宿' : '新百合ヶ丘');
    }
  }

  setNight() { /* 窓明かりなどは TrainKit 側で一括切替 */ }

  showOwn(v) { this.own.group.visible = v; }

  _spawn(rule, sim) {
    const L = this.rs.line.meta.length;
    const me = sim.pos;
    const q = this.rs.line.sections.quad;
    const thereDest = this.rs.line.meta.direction === 'up' ? '新百合ヶ丘' : '新宿';
    const hereDest = this.rs.line.meta.direction === 'up' ? '新宿' : '新百合ヶ丘';
    if (rule === 'opp') {
      const s = Math.min(L - 20, me + 1700 + this._rand() * 900);
      if (s < me + 600) return null;
      const local = this._rand() < 0.55;
      return new AiTrain(this.rs, {
        offset: -3.8, dir: -1, stops: local, vmax: (local ? 85 : 95) / 3.6, v0: 20,
        nCars: local ? 8 : 10, kind: local ? 'local' : (this._rand() < 0.5 ? 'exp' : 'rapid'), dest: thereDest, s,
      });
    }
    if (rule === 'quadSame') {
      /* 自列車が複々線内でゆっくり(または停車)しているとき、急行が追い抜いていく */
      if (me < q.from + 400 || me > q.to - 900 || sim.v > 70) return null;
      const s = Math.max(q.from + 220, me - 650);
      return new AiTrain(this.rs, {
        offset: 3.8, dir: 1, stops: false, vmax: 96 / 3.6, v0: 24, nCars: 10,
        kind: 'rapid', dest: hereDest, s, zone: q,
      });
    }
    if (rule === 'quadOpp') {
      if (me < q.from + 200 || me > q.to - 1200) return null;
      const s = Math.min(q.to - 20, me + 1500 + this._rand() * 600);
      return new AiTrain(this.rs, {
        offset: 7.6, dir: -1, stops: false, vmax: 96 / 3.6, v0: 25, nCars: 10,
        kind: 'exp', dest: thereDest, s, zone: q,
      });
    }
    return null;
  }

  update(dt) {
    const sim = this.rs.sim;
    if (!sim) return;
    /* 自列車 */
    if (this.own.group.visible) placeTrain(this.rs, this.own, sim.pos, 1, 0);
    if (dt <= 0) return;
    for (const t of this.list) t.update(dt);
    const alive = [];
    this.list.forEach((t) => { if (t.done) t.dispose(); else alive.push(t); });
    this.list = alive;
    for (const rule of ['opp', 'quadSame', 'quadOpp']) {
      if (this.list.some((t) => t.rule === rule)) continue;
      this.cool[rule] -= dt;
      if (this.cool[rule] > 0) continue;
      const t = this._spawn(rule, sim);
      if (t) {
        t.rule = rule;
        this.list.push(t);
        t.update(1e-3);
      }
      this.cool[rule] = rule === 'opp' ? 35 + this._rand() * 70 : 50 + this._rand() * 60;
    }
  }

  passingInfo() {
    const sim = this.rs.sim;
    return this.list.map((t) => t.passing(sim.pos, sim.v / 3.6)).filter((p) => Math.abs(p.dist) < 700);
  }

  dispose() {
    this.list.forEach((t) => t.dispose());
    this.list = [];
    if (this.own) { this.rs.world.remove(this.own.group); this.rs.disposeTrainModel(this.own); this.own = null; }
  }
}
