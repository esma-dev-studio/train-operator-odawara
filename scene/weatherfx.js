/* =========================================================
 * scene/weatherfx.js — 雨のすじ・雪の粒(カメラのまわりだけ)
 * 粒はカメラ基準の箱の中で動かし、列車の速さぶん後ろへ流す。
 * ========================================================= */
import * as THREE from '../vendor/three.module.min.js';

const BOX = { x: 34, y: 22, z: 70 };   // 幅・高さ・奥行き(カメラ前方へ)

function flakeTex() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 32;
  const c = cv.getContext('2d');
  const g = c.createRadialGradient(16, 16, 0, 16, 16, 15);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.75)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g; c.fillRect(0, 0, 32, 32);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class WeatherFx {
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    this.mode = 'clear';
    this.rnd = 98765;
    /* 雨: 線分 */
    this.nRain = 1400;
    this.rainP = new Float32Array(this.nRain * 3);
    this.rainV = new Float32Array(this.nRain * 6);
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(this.rainV, 3).setUsage(THREE.DynamicDrawUsage));
    this.rainMat = new THREE.LineBasicMaterial({ color: 0xaab4bf, transparent: true, opacity: 0.38, depthWrite: false });
    this.rain = new THREE.LineSegments(rg, this.rainMat);
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    scene.add(this.rain);
    /* 雪: 点スプライト */
    this.nSnow = 2200;
    this.snowP = new Float32Array(this.nSnow * 3);
    this.snowPh = new Float32Array(this.nSnow);
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.nSnow * 3), 3).setUsage(THREE.DynamicDrawUsage));
    this.snowMat = new THREE.PointsMaterial({
      map: flakeTex(), size: 0.11, sizeAttenuation: true, transparent: true, opacity: 0.95,
      depthWrite: false, color: 0xffffff,
    });
    this.snow = new THREE.Points(sg, this.snowMat);
    this.snow.frustumCulled = false;
    this.snow.visible = false;
    scene.add(this.snow);
    for (let i = 0; i < this.nRain; i++) this._seed(this.rainP, i, true);
    for (let i = 0; i < this.nSnow; i++) { this._seed(this.snowP, i, true); this.snowPh[i] = this._r() * 6.28; }
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  _r() { this.rnd = (this.rnd * 16807) % 2147483647; return this.rnd / 2147483647; }

  /* 粒をカメラ座標(右・上・前)の箱に置く。anyY=falseなら上端から */
  _seed(arr, i, anyY) {
    arr[i * 3] = (this._r() - 0.5) * BOX.x;
    arr[i * 3 + 1] = anyY ? (this._r() - 0.3) * BOX.y : BOX.y * 0.7;
    arr[i * 3 + 2] = 1 + this._r() * BOX.z;
  }

  set(weather, tod) {
    this.mode = weather;
    this.rain.visible = weather === 'rain';
    this.snow.visible = weather === 'snow';
    const dark = tod === 'night' ? 0.45 : tod === 'evening' ? 0.75 : 1;
    this.rainMat.color.setRGB(0.62 * dark, 0.67 * dark, 0.72 * dark);
    this.snowMat.color.setScalar(tod === 'night' ? 0.62 : 1);
  }

  setVisible(v) {
    this.rain.visible = v && this.mode === 'rain';
    this.snow.visible = v && this.mode === 'snow';
  }

  /* v: 列車速度(m/s)、indoors: トンネル内なら降らない */
  update(dt, v, indoors) {
    if (this.mode !== 'rain' && this.mode !== 'snow') return;
    const cam = this.camera;
    const fwd = this._fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    fwd.y = 0; fwd.normalize();
    const right = this._right.crossVectors(fwd, this._up).normalize();
    const C = cam.position;
    const show = !indoors;
    if (this.mode === 'rain') {
      this.rain.visible = show;
      if (!show) return;
      const fall = 9.5, P = this.rainP, V = this.rainV;
      const streak = 0.045;
      for (let i = 0; i < this.nRain; i++) {
        let x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
        y -= fall * dt; z -= v * dt;
        if (y < -4 || z < 0.5) { this._seed(P, i, false); x = P[i * 3]; y = P[i * 3 + 1]; z = P[i * 3 + 2]; if (z < 0.5) z += BOX.z; }
        if (z > BOX.z + 1) z -= BOX.z;
        P[i * 3 + 1] = y; P[i * 3 + 2] = z;
        /* すじの向き = 相対速度(落下 + 列車の速さで手前へ) */
        const wx = C.x + right.x * x + fwd.x * z, wy = C.y + y, wz = C.z + right.z * x + fwd.z * z;
        V[i * 6] = wx; V[i * 6 + 1] = wy; V[i * 6 + 2] = wz;
        V[i * 6 + 3] = wx + fwd.x * v * streak; V[i * 6 + 4] = wy + fall * streak; V[i * 6 + 5] = wz + fwd.z * v * streak;
      }
      this.rain.geometry.attributes.position.needsUpdate = true;
    } else {
      this.snow.visible = show;
      if (!show) return;
      const P = this.snowP, out = this.snow.geometry.attributes.position.array;
      const t = performance.now() / 1000;
      for (let i = 0; i < this.nSnow; i++) {
        let y = P[i * 3 + 1], z = P[i * 3 + 2];
        y -= 1.25 * dt; z -= v * dt;
        if (y < -4 || z < 0.3) { this._seed(P, i, false); y = P[i * 3 + 1]; z = P[i * 3 + 2]; if (z < 0.3) z += BOX.z; }
        if (z > BOX.z + 1) z -= BOX.z;
        P[i * 3 + 1] = y; P[i * 3 + 2] = z;
        const sway = Math.sin(t * 1.3 + this.snowPh[i]) * 0.35;
        const x = P[i * 3] + sway;
        out[i * 3] = C.x + right.x * x + fwd.x * z;
        out[i * 3 + 1] = C.y + y;
        out[i * 3 + 2] = C.z + right.z * x + fwd.z * z;
      }
      this.snow.geometry.attributes.position.needsUpdate = true;
    }
  }
}
