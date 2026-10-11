/* =========================================================
 * scene/weatherfx.js — 雨のすじ・雪の粒(カメラのまわりだけ)
 * 粒はカメラ基準の箱の中で動かし、列車の速さぶん後ろへ流す。
 * ========================================================= */
import * as THREE from '../vendor/three.module.min.js';

const BOX = { x: 34, y: 22, z: 70 };   // 幅・高さ・奥行き(カメラ前方へ)

/* 雪の粒: 中心は白く、ふちへ向かってなめらかに灰色になりながら消える玉(明るいくもり空の前では灰色の点、
 * 家や木の前では白い点に見える。真っ白なぼかしの点だと、白い空にとけて見えなくなる)。
 * ふちを濃いまま急に切ると、手前の大きな粒が「輪のあるシャボン玉」に見えるので、濃さもなめらかに下げる */
function flakeTex() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 32;
  const c = cv.getContext('2d');
  const g = c.createRadialGradient(16, 16, 0, 16, 16, 15);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.3, 'rgba(214,218,226,0.95)');
  g.addColorStop(0.6, 'rgba(150,156,168,0.6)');
  g.addColorStop(1, 'rgba(136,142,154,0)');
  c.fillStyle = g; c.fillRect(0, 0, 32, 32);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  /* 縮小版(ミップマップ)を使わない: 遠くの2〜4画素の粒が、透明なすみまで平均された うすい点になって消えるため */
  t.generateMipmaps = false;
  t.minFilter = THREE.LinearFilter;
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
    /* すじは細い線なので、高解像度の画面でも見えるよう濃いめ・長め */
    this.rainMat = new THREE.LineBasicMaterial({ color: 0xaab4bf, transparent: true, opacity: 0.55, depthWrite: false });
    this.rain = new THREE.LineSegments(rg, this.rainMat);
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    scene.add(this.rain);
    /* 雪: 点スプライト(手前に多めに置く=大きく見える粒をふやす。白い空でも見えるよう少し灰色) */
    this.nSnow = 3000;
    this.snowP = new Float32Array(this.nSnow * 3);
    this.snowPh = new Float32Array(this.nSnow);
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.nSnow * 3), 3).setUsage(THREE.DynamicDrawUsage));
    this.snowMat = new THREE.PointsMaterial({
      map: flakeTex(), size: 0.15, sizeAttenuation: true, transparent: true, opacity: 1,
      depthWrite: false, color: 0xffffff,
    });
    this.snow = new THREE.Points(sg, this.snowMat);
    this.snow.frustumCulled = false;
    this.snow.visible = false;
    scene.add(this.snow);
    for (let i = 0; i < this.nRain; i++) this._seed(this.rainP, i, true);
    for (let i = 0; i < this.nSnow; i++) { this._seed(this.snowP, i, true, true); this.snowPh[i] = this._r() * 6.28; }
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._dC = new THREE.Vector3();
    this._lastC = new THREE.Vector3();
    this._hasLast = false;
  }

  _r() { this.rnd = (this.rnd * 16807) % 2147483647; return this.rnd / 2147483647; }

  /* 粒をカメラ座標(右・上・前)の箱に置く。anyY=falseなら上端から。
   * near=true(雪)は奥行きを手前に寄せる(遠くの粒は1〜2画素で見えないので、近くを多く)。
   * 近くの粒は、横は画面に入る幅に寄せ、上端は画面の上のすぐ外にする
   * (箱いっぱいに散らすと近くの粒の多くが画面の外になり、上端から入れ直すと画面に入るまで十数秒かかる) */
  _seed(arr, i, anyY, near) {
    const z = 1 + (near ? Math.pow(this._r(), 1.8) : this._r()) * BOX.z;
    const w = near ? Math.min(BOX.x, 4 + 1.4 * z) : BOX.x;
    arr[i * 3] = (this._r() - 0.5) * w;
    arr[i * 3 + 1] = anyY ? (this._r() - 0.3) * BOX.y : near ? Math.min(BOX.y * 0.7, 1 + 0.6 * z) : BOX.y * 0.7;
    arr[i * 3 + 2] = z;
  }

  set(weather, tod) {
    this.mode = weather;
    this.rain.visible = weather === 'rain';
    this.snow.visible = weather === 'snow';
    const dark = tod === 'night' ? 0.45 : tod === 'evening' ? 0.75 : 1;
    this.rainMat.color.setRGB(0.62 * dark, 0.67 * dark, 0.72 * dark);
    /* 雪の粒は真っ白にしない(明るいくもり空の前でも見え、家や木の前では明るく見える) */
    this.snowMat.color.setHex(tod === 'night' ? 0xb4bcc8 : 0xd0d6de);
  }

  setVisible(v) {
    this.rain.visible = v && this.mode === 'rain';
    this.snow.visible = v && this.mode === 'snow';
  }

  /* v: 列車速度(m/s。雨に使う。雪はカメラの動きから流す)、indoors: トンネル内なら降らない */
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
      const streak = 0.075;
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
      /* 粒は空気に止まっている: カメラが前のフレームから動いたぶんを、カメラの右・前の向きに分けて逆へ動かす。
       * (列車の速さを前向きに当てるだけだと、横から見る視点では粒がカメラへ突っこんで すぐ消える)
       * 視点の切りかえなどで大きく飛んだときは動かさない */
      const dC = this._dC.subVectors(C, this._lastC);
      let mx = 0, mz = 0, my = 0;
      if (this._hasLast && dC.lengthSq() < 900) { mx = dC.dot(right); mz = dC.dot(fwd); my = dC.y; }
      this._lastC.copy(C);
      this._hasLast = true;
      const hx = BOX.x / 2;
      for (let i = 0; i < this.nSnow; i++) {
        let x0 = P[i * 3] - mx, y = P[i * 3 + 1] - 1.0 * dt - my, z = P[i * 3 + 2] - mz;
        if (z < 0.3) {
          /* 追いこした粒は、前方の遠くに高さもばらばらで入れ直す(近づくにつれて大きく見える)。
           * 上端から入れ直すと、走っている間は近くの粒がずっと画面の上の外にいて、雪がほとんど見えない */
          x0 = (this._r() - 0.5) * BOX.x;
          y = (this._r() - 0.3) * BOX.y;
          z = BOX.z * (0.55 + 0.45 * this._r());
        } else if (y < -4) { this._seed(P, i, false, true); x0 = P[i * 3]; y = P[i * 3 + 1]; z = P[i * 3 + 2]; }
        if (z > BOX.z + 1) z -= BOX.z;
        /* 横へ流れて箱から出た粒は反対側へ(横から見る視点で、粒が流れつづける) */
        if (x0 < -hx) x0 += BOX.x; else if (x0 > hx) x0 -= BOX.x;
        P[i * 3] = x0; P[i * 3 + 1] = y; P[i * 3 + 2] = z;
        const sway = Math.sin(t * 1.3 + this.snowPh[i]) * 0.35;
        const x = x0 + sway;
        out[i * 3] = C.x + right.x * x + fwd.x * z;
        out[i * 3 + 1] = C.y + y;
        out[i * 3 + 2] = C.z + right.z * x + fwd.z * z;
      }
      this.snow.geometry.attributes.position.needsUpdate = true;
    }
  }
}
