/* =========================================================
 * scene/roadtraffic.js — 側道を走る車(8台をくり返し使う)
 *
 * ・カメラから350m以内の側道(rs._roadRuns)に車を出し、25〜35km/hで左側の車線を走らせる。
 *   400mより遠くなったか道の終わりに来たら、別の場所に出しなおす(手前で急に出ないよう、出す所は60m以上先)。
 * ・踏切の遮断機が下りている間(腕の角度 < 1.0)は、踏切の12m手前で止まる。前の車にも近づきすぎない。
 * ・形と材質は cars.js(木と同じ 'fc-tree' のシェーダ)。種類ごとに1つの InstancedMesh(描画は最大3回。
 *   外接球を出ている車に合わせて毎フレーム置きなおすので、画面に入っていない種類は描かない)。
 *   インスタンス色の r に 2 を足して「灯火をつけている車」にする(夜は前照灯・尾灯が光る)。
 * ・毎フレームの処理は割り当てなし(作業用の行列・ベクトルはモジュールで1つずつ)。
 * ========================================================= */
import * as THREE from '../vendor/three.module.min.js';
import { geoCar, carMaterial, carPaint, CAR_PAINTS, CAR_LEN } from './cars.js';

const TYPES = ['kei', 'sedan', 'minivan', 'kei', 'sedan', 'kei', 'minivan', 'sedan'];
const KINDS = ['kei', 'minivan', 'sedan'];
const NEAR = 350, FAR = 400, MIN_SPAWN = 60;
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _one = new THREE.Vector3(1, 1, 1);
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
const _c = new THREE.Color();
const _fr = { x: 0, y: 0, z: 0, lx: 1, lz: 0, yaw: 0 };

/* s(m)の位置・左向き・向き(town.js の sampleFrame と同じ計算。割り当てなし) */
function frameAt(F, step, s, o) {
  const f = s / step;
  const i = Math.max(0, Math.min(F.length - 2, Math.floor(f)));
  const k = Math.min(1, Math.max(0, f - i));
  const a = F[i], b = F[i + 1];
  o.x = a.p.x + (b.p.x - a.p.x) * k;
  o.y = a.p.y + (b.p.y - a.p.y) * k;
  o.z = a.p.z + (b.p.z - a.p.z) * k;
  let tx = a.t.x + (b.t.x - a.t.x) * k, tz = a.t.z + (b.t.z - a.t.z) * k;
  const n = Math.hypot(tx, tz) || 1;
  tx /= n; tz /= n;
  o.lx = tz; o.lz = -tx;
  o.yaw = Math.atan2(tx, tz);
  return o;
}

export class RoadTraffic {
  constructor(rs) {
    this.meshes = [];
    this.cars = [];
    this._seed = 97531;
    const mat = carMaterial(rs);
    const parent = rs._town ? rs._town.groups.streets : rs.world;
    const ims = {};
    KINDS.forEach((type) => {
      const n = TYPES.filter((t) => t === type).length;
      const im = new THREE.InstancedMesh(geoCar(type), mat, n);
      /* 行列は毎フレーム書きかえる(外接球も毎フレーム、出ている車を包むように置きなおす: _bounds) */
      im.frustumCulled = true;
      im.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
      im.castShadow = false;
      im.receiveShadow = true;
      im.userData.noSplit = true;
      im.userData.noMerge = true;
      im.userData.p1 = 'traffic';
      for (let i = 0; i < n; i++) im.setMatrixAt(i, _zero);
      parent.add(im);
      ims[type] = { im, n: 0 };
      this.meshes.push(im);
    });
    const rnd = () => this._rnd();
    TYPES.forEach((type) => {
      const e = ims[type];
      const car = { type, im: e.im, i: e.n++, run: null, s: 0, dir: 1, v: 0, vmax: 8, lat: 0, on: false, x: 0, y: 0, z: 0 };
      /* 塗装(白・銀が多い)。r に 2 を足して「灯火をつけている」印 */
      const col = carPaint({}, CAR_PAINTS[Math.floor(rnd() * CAR_PAINTS.length)], rnd);
      _c.setRGB(col.r + 2, col.g, col.b);
      e.im.setColorAt(car.i, _c);
      this.cars.push(car);
    });
    this.meshes.forEach((im) => { if (im.instanceColor) im.instanceColor.needsUpdate = true; });
  }

  _rnd() {
    this._seed = (this._seed * 16807) % 2147483647;
    return this._seed / 2147483647;
  }

  /* 車を出す: カメラの近くの側道から1つ選び、カメラから60〜350mの所に */
  _spawn(rs, car, eye) {
    const runs = rs._roadRuns, pos = rs.sim.pos;
    car.on = false;
    for (let tries = 0; tries < 6; tries++) {
      const r = runs[Math.floor(this._rnd() * runs.length)];
      const a = Math.max(r.s0 + 6, pos - NEAR), b = Math.min(r.s1 - 6, pos + NEAR);
      if (b - a < 20) continue;
      const s = a + (b - a) * this._rnd();
      const dir = this._rnd() < 0.5 ? 1 : -1;
      frameAt(rs.frames, rs.step, s, _fr);
      const lat = r.side * (r.inner + 2.5) + dir * 1.3;
      const x = _fr.x + _fr.lx * lat, z = _fr.z + _fr.lz * lat;
      const d = Math.hypot(x - eye.x, z - eye.z);
      if (d > NEAR || d < MIN_SPAWN) continue;
      /* ほかの車と重ならない */
      let clash = false;
      for (let k = 0; k < this.cars.length; k++) {
        const o = this.cars[k];
        if (o !== car && o.on && o.run === r && o.dir === dir && Math.abs(o.s - s) < 14) { clash = true; break; }
      }
      if (clash) continue;
      car.run = r; car.s = s; car.dir = dir; car.lat = lat;
      car.vmax = (25 + 10 * this._rnd()) / 3.6; car.v = car.vmax;
      car.on = true;
      return true;
    }
    return false;
  }

  /* 種類ごとのメッシュの外接球を、出ている車だけを包むように毎フレーム置きなおす(画面の外なら描かない) */
  _bounds() {
    for (let m = 0; m < this.meshes.length; m++) {
      const im = this.meshes[m];
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y = 0, n = 0;
      for (let k = 0; k < this.cars.length; k++) {
        const c = this.cars[k];
        if (c.im !== im || !c.on) continue;
        if (c.x < x0) x0 = c.x; if (c.x > x1) x1 = c.x; if (c.z < z0) z0 = c.z; if (c.z > z1) z1 = c.z;
        y += c.y; n++;
      }
      im.visible = n > 0;
      if (!n) continue;
      const bs = im.boundingSphere;
      bs.center.set((x0 + x1) / 2, y / n, (z0 + z1) / 2);
      bs.radius = Math.hypot(x1 - x0, z1 - z0) / 2 + 4;
    }
  }

  update(rs, dt) {
    const runs = rs._roadRuns;
    if (!runs || !runs.length || !rs.sim || !rs.frames) return;
    const eye = rs.camera.position;
    const T = rs._town;
    const rampY = T && typeof T.rampY === 'function' ? T.rampY : null;
    const cr = rs.crossings || [];
    const cars = this.cars;
    for (let n = 0; n < cars.length; n++) {
      const car = cars[n];
      if (car.on && Math.hypot(car.x - eye.x, car.z - eye.z) > FAR) car.on = false;
      if (!car.on && !this._spawn(rs, car, eye)) { car.im.setMatrixAt(car.i, _zero); car.im.instanceMatrix.needsUpdate = true; continue; }
      /* 止まる所: 遮断機の下りている踏切の12m手前・前の車の8m うしろ */
      let lim = Infinity;
      for (let k = 0; k < cr.length; k++) {
        const c = cr[k];
        const ahead = (c.s - car.s) * car.dir;
        if (ahead > 11 && ahead < 40 && c.arms && c.arms.length && c.arms[0].rotation.z < 1.0) lim = Math.min(lim, ahead - 12);
      }
      for (let k = 0; k < cars.length; k++) {
        const o = cars[k];
        if (o === car || !o.on || o.run !== car.run || o.dir !== car.dir) continue;
        const ahead = (o.s - car.s) * car.dir;
        if (ahead > 0 && ahead < 30) lim = Math.min(lim, ahead - (CAR_LEN[o.type] + CAR_LEN[car.type]) / 2 - 3);
      }
      /* 止まる所の手前では減速(ゆるい加減速) */
      const vT = lim < Infinity ? Math.min(car.vmax, Math.sqrt(Math.max(0, 2 * 2.5 * lim))) : car.vmax;
      const dv = vT - car.v;
      car.v += Math.max(-4 * dt, Math.min(1.8 * dt, dv));
      if (car.v < 0) car.v = 0;
      let step = car.v * dt;
      if (step > lim) { step = Math.max(0, lim); car.v = 0; }
      car.s += car.dir * step;
      const r = car.run;
      if (car.s < r.s0 + 3 || car.s > r.s1 - 3) { car.on = false; car.im.setMatrixAt(car.i, _zero); car.im.instanceMatrix.needsUpdate = true; continue; }
      frameAt(rs.frames, rs.step, car.s, _fr);
      car.x = _fr.x + _fr.lx * car.lat; car.z = _fr.z + _fr.lz * car.lat;
      car.y = _fr.y + (rampY ? rampY(car.s) : -0.4);
      _p.set(car.x, car.y, car.z);
      _q.setFromAxisAngle(Y_AXIS, car.dir > 0 ? _fr.yaw : _fr.yaw + Math.PI);
      _m4.compose(_p, _q, _one);
      car.im.setMatrixAt(car.i, _m4);
      car.im.instanceMatrix.needsUpdate = true;
    }
    this._bounds();
  }
}
