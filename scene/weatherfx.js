/* =========================================================
 * scene/weatherfx.js — 雨のすじ・雪の粒(カメラのまわりだけ)
 * 粒はカメラ基準の箱の中で動かし、列車の速さぶん後ろへ流す。
 * ========================================================= */
import * as THREE from '../vendor/three.module.min.js';

const BOX = { x: 34, y: 22, z: 70 };   // 幅・高さ・奥行き(カメラ前方へ)
const TOP = BOX.y * 0.7;               // 粒を入れ直す上の高さ(カメラから)
const SNOW_NEAR = 2.2;                 // 雪の粒の いちばん手前(カメラから m。これより近づいたら前方の遠くへ入れ直す)

/* 雨のすじの「先ほど濃く、うしろへ消えていく」形:
 * 同じすじを、先から長さ 1/4・2/4・3/4・4/4 の4本の線で重ねて描く(先の1/4は4回重なって濃く、うしろの1/4は1回だけ)。
 * 1本ごとの濃さ a で、先の濃さは 1-(1-a)^4。頂点ごとの濃さ(頂点カラー)を使うとシェーダが1種類増えるので、
 * 電線と同じ線の材質のまま重ね方で細くしていく */
const LAY = 4;
const layerAlpha = (head) => 1 - Math.pow(1 - head, 1 / LAY);

/* 雪の粒: 中心は白く、ふちへ向かってなめらかに灰色になりながら消える玉(明るいくもり空の前では灰色の点、
 * 家や木の前では白い点に見える。真っ白なぼかしの点だと、白い空にとけて見えなくなる)。
 * ふちは うすい灰色(白い雪の地面の前でも粒の形が見える)。濃い灰色の輪にすると、
 * 手前の大きな粒が「レンズについた よごれ・灰」に見えるので、灰色は うすく・外へ なめらかに消す */
function flakeTex() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 32;
  const c = cv.getContext('2d');
  const g = c.createRadialGradient(16, 16, 0, 16, 16, 15);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(238,242,248,0.9)');
  g.addColorStop(0.7, 'rgba(176,184,196,0.35)');
  g.addColorStop(1, 'rgba(176,184,196,0)');
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
    /* 粒が消える高さ(カメラから。地面の高さが分からないときは今までどおり 4m 下) */
    this._floor = -4.3;
    /* 雨: 線分。近い(20m未満)すじと遠いすじで濃さを変える(遠くは うすい雨のかすみ)。
     * 近いすじは配列の前から、遠いすじは後ろから詰めて、2つの区切り(group)で2回に分けて描く */
    this.nRain = 2200;
    this.rainP = new Float32Array(this.nRain * 3);
    this.rainV = new Float32Array(this.nRain * LAY * 6);
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(this.rainV, 3).setUsage(THREE.DynamicDrawUsage));
    rg.addGroup(0, 0, 0);
    rg.addGroup(0, 0, 1);
    /* すじは細い線なので、濃さは重ね方で(先 0.35 → うしろ 0)。遠いすじは 0.6 倍 */
    const lm = (head) => new THREE.LineBasicMaterial({ color: 0x9aa2ab, transparent: true, opacity: layerAlpha(head), depthWrite: false });
    this.rainMats = [lm(0.33), lm(0.21)];
    this.rainMat = this.rainMats[0];
    this.rain = new THREE.LineSegments(rg, this.rainMats);
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    scene.add(this.rain);
    /* 雪: 点スプライト(手前に多めに置く=大きく見える粒をふやす。白い空でも見えるよう少し灰色) */
    this.nSnow = 3600;
    this.snowP = new Float32Array(this.nSnow * 3);
    this.snowPh = new Float32Array(this.nSnow);
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.nSnow * 3), 3).setUsage(THREE.DynamicDrawUsage));
    /* 粒の大きさ 0.10m(いちばん手前 2.2m で 画面に約35画素まで。もっと近い粒は置かない: _seed・update) */
    this.snowMat = new THREE.PointsMaterial({
      map: flakeTex(), size: 0.10, sizeAttenuation: true, transparent: true, opacity: 1,
      depthWrite: false, color: 0xffffff,
    });
    this.snow = new THREE.Points(sg, this.snowMat);
    this.snow.frustumCulled = false;
    this.snow.visible = false;
    scene.add(this.snow);
    for (let i = 0; i < this.nRain; i++) this._seed(this.rainP, i, true, false, true);
    for (let i = 0; i < this.nSnow; i++) { this._seed(this.snowP, i, true, true); this.snowPh[i] = this._r() * 6.28; }
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._dC = new THREE.Vector3();
    this._lastC = new THREE.Vector3();
    this._hasLast = false;
  }

  _r() { this.rnd = (this.rnd * 16807) % 2147483647; return this.rnd / 2147483647; }

  /* 粒をカメラ座標(右・上・前)の箱に置く。anyY=falseなら上端から(anyY は地面〜上端のどこか)。
   * near=true(雪)は奥行きを手前に寄せる(遠くの粒は1〜2画素で見えないので、近くを多く)。
   * 雨は遠くに多め(遠くのすじは短く うすい「雨のかすみ」になる)。
   * 近くの粒は、横は画面に入る幅に寄せ、上端は画面の上のすぐ外にする
   * (箱いっぱいに散らすと近くの粒の多くが画面の外になり、上端から入れ直すと画面に入るまで十数秒かかる)。
   * view=true(雨): 近くのすじも、横は画面に入る幅(運転台の画角の少し外まで)に置く
   * (箱の幅いっぱいだと、近くのすじの半分以上が画面の外で、雨がほとんど見えない) */
  _seed(arr, i, anyY, near, view) {
    /* 雪(near)は カメラから 2.2m より手前に置かない(手前すぎる粒は 画面に大きな ぼやけた玉になる) */
    const z = (near ? SNOW_NEAR : 1) + (near ? Math.pow(this._r(), 1.8) : Math.pow(this._r(), 0.7)) * BOX.z;
    const w = near ? Math.min(BOX.x, 4 + 1.4 * z) : view ? Math.min(BOX.x, 4 + 1.8 * z) : BOX.x;
    const fl = this._floor;
    arr[i * 3] = (this._r() - 0.5) * w;
    arr[i * 3 + 1] = anyY ? fl + this._r() * (TOP - fl) : near ? Math.min(TOP, 1 + 0.6 * z) : TOP;
    arr[i * 3 + 2] = z;
  }

  set(weather, tod) {
    this.mode = weather;
    this.rain.visible = weather === 'rain';
    this.snow.visible = weather === 'snow';
    const dark = tod === 'night' ? 0.45 : tod === 'evening' ? 0.75 : 1;
    /* 雨のすじは明るい空よりわずかに明るい灰色(空の前ではほとんど見えず、建物や砂利の前で見える) */
    for (let k = 0; k < this.rainMats.length; k++) this.rainMats[k].color.setRGB(0.55 * dark, 0.58 * dark, 0.62 * dark);
    /* 雪の粒は真っ白にしない(明るいくもり空の前でも見え、家や木の前では明るく見える) */
    this.snowMat.color.setHex(tod === 'night' ? 0xb4bcc8 : 0xd0d6de);
  }

  setVisible(v) {
    this.rain.visible = v && this.mode === 'rain';
    this.snow.visible = v && this.mode === 'snow';
  }

  /* v: 列車速度(m/s。雨に使う。雪はカメラの動きから流す)、indoors: トンネル内なら降らない、
   * groundY: 足もとの地面(線路)の高さ(世界座標。わかれば、粒はそこまで落ちる=高い視点でも地面の前に降る) */
  update(dt, v, indoors, groundY) {
    if (this.mode !== 'rain' && this.mode !== 'snow') return;
    const cam = this.camera;
    const fwd = this._fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    fwd.y = 0; fwd.normalize();
    const right = this._right.crossVectors(fwd, this._up).normalize();
    const C = cam.position;
    const show = !indoors;
    /* 粒が消える高さ(カメラから): 地面の少し下。地面が分からないときは 4m 下 */
    const fl = (groundY != null && isFinite(groundY) ? Math.min(-0.5, groundY - C.y) : -4) - 0.3;
    this._floor = fl;
    if (this.mode === 'rain') {
      this.rain.visible = show;
      if (!show) return;
      const fall = 9.5, P = this.rainP, V = this.rainV, n = this.nRain;
      const streak = 0.05, SEG = LAY * 6;
      /* すじの向き = 相対速度(落下 + 列車の速さで手前へ)。先(いまの位置)から うしろ(少し前にいた所)へ */
      const sx = fwd.x * v * streak, sy = fall * streak, sz = fwd.z * v * streak;
      let nNear = 0, nFar = 0;
      for (let i = 0; i < n; i++) {
        let x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
        y -= fall * dt; z -= v * dt;
        if (z < 0.5) {
          /* 追いこしたすじは、前方の遠くに高さもばらばらで入れ直す(上端から入れ直すと、
           * 走っている間は近くのすじが画面の上の外にかたより、画面の上のほうに雨のない帯ができる) */
          x = (this._r() - 0.5) * BOX.x;
          y = fl + this._r() * (TOP - fl);
          z = BOX.z * (0.55 + 0.45 * this._r());
        } else if (y < fl) { this._seed(P, i, false, false, true); x = P[i * 3]; y = P[i * 3 + 1]; z = P[i * 3 + 2]; }
        if (z > BOX.z + 1) z -= BOX.z;
        P[i * 3] = x; P[i * 3 + 1] = y; P[i * 3 + 2] = z;
        const wx = C.x + right.x * x + fwd.x * z, wy = C.y + y, wz = C.z + right.z * x + fwd.z * z;
        /* 近いすじは前から、遠いすじは後ろから詰める */
        const o = z < 20 ? (nNear++) * SEG : (n - 1 - nFar++) * SEG;
        for (let k = 1; k <= LAY; k++) {
          const f = k / LAY, p = o + (k - 1) * 6;
          V[p] = wx; V[p + 1] = wy; V[p + 2] = wz;
          V[p + 3] = wx + sx * f; V[p + 4] = wy + sy * f; V[p + 5] = wz + sz * f;
        }
      }
      const g = this.rain.geometry, vp = LAY * 2;
      g.groups[0].start = 0; g.groups[0].count = nNear * vp;
      g.groups[1].start = (n - nFar) * vp; g.groups[1].count = nFar * vp;
      g.attributes.position.needsUpdate = true;
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
        if (z < SNOW_NEAR) {
          /* 追いこした粒は、前方の遠くに高さもばらばらで入れ直す(近づくにつれて大きく見える)。
           * 上端から入れ直すと、走っている間は近くの粒がずっと画面の上の外にいて、雪がほとんど見えない */
          x0 = (this._r() - 0.5) * BOX.x;
          y = fl + this._r() * (TOP - fl);
          z = BOX.z * (0.55 + 0.45 * this._r());
        } else if (y < fl) { this._seed(P, i, false, true); x0 = P[i * 3]; y = P[i * 3 + 1]; z = P[i * 3 + 2]; }
        if (z > BOX.z + 1) z -= BOX.z;
        /* 横へ流れて箱から出た粒は反対側へ(横から見る視点で、粒が流れつづける)。
         * 近くの粒は置いたときと同じ せまい幅の中でまわす(箱の幅いっぱいに散ると、横から見る視点で手前の粒が4分の1に減る) */
        const hw = Math.min(hx, 2 + 0.7 * z);
        if (x0 < -hw) x0 += 2 * hw; else if (x0 > hw) x0 -= 2 * hw;
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
