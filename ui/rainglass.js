/* =========================================================
 * ui/rainglass.js — 雨・雪の日のフロントガラス(水滴・水の膜・雪のつぶ)
 * 3D運転台(scene/cockpit.js)の窓の範囲だけに描き、3Dワイパーが通ったら拭き取る。
 *  ・水滴: ふちが暗く、下に明るい三日月、左上に光の点(明るい空にも暗い地面にも見える)。
 *          大きさは画面の高さにあわせる(iPad でも小さくなりすぎない)
 *  ・はしっているときは風で上と外へ流れ、うすい筋が残る。止まると大きい粒だけ下へ垂れる
 *  ・水の膜(#rain-film): こまかい つぶの もようを ぬれぐあい(wet)の濃さで。ワイパーが ふいた扇形は
 *    いったん きれいになり、1.4秒で また ぬれる(1秒に10回まで描きなおす)
 *  ・雪(setMode('snow')): 遅いときは窓にくっつき、しばらくすると とけて水滴になる。
 *    ワイパーが おしやった雪が 扇形のはしに山になる
 * 軽さ: キャンバスは等倍(DPR 1)で、窓に外接する四角の大きさだけ。粒は使い回し(毎フレームの new なし)、
 *       水滴も筋もない乾いたときは消して何もしない。
 * 外との約束: setActive(on) / setMode('rain'|'snow') / resize(w, h) / render(dt, v, cockpit, dry)
 *   cockpit からは windowRects() / wiperScreen() / sillLevel() / quality を読む(なくても動く)
 * ========================================================= */
const CAP_MAX = 320;        // 粒の最大数(画質「かるい」は CAP_LOW)
const CAP_LOW = 200;
const TRAIL = 6;            // 筋の点の数(50msごと)
const TAU = Math.PI * 2;
const FAN_N = 24;           // ワイパーの扇形を区切る数(ふいた時刻を区切りごとに覚える)
const WIPE_SWEEP = 1.55;    // ワイパーの振れ幅(rad。cockpit.js と同じ)
const RIDGE_ARC = 96, RIDGE_END = 44;   // 雪の山の かたまりの数(扇形の そとのふち / 振りきったはし)

/* 粒の絵(64x64 を2コマ): 0 = 水滴、1 = 雪のつぶ。一度だけ作る */
function makeSprites() {
  const cv = document.createElement('canvas');
  cv.width = 128; cv.height = 64;
  const c = cv.getContext('2d');
  const r = 26, cx = 32, cy = 32;
  const g = c.createRadialGradient(cx, cy + 0.18 * r, 0, cx, cy + 0.18 * r, r);
  g.addColorStop(0, 'rgba(255,255,255,0.10)');
  g.addColorStop(0.68, 'rgba(20,30,40,0.14)');
  g.addColorStop(0.9, 'rgba(8,12,16,0.58)');
  g.addColorStop(1, 'rgba(8,12,16,0)');
  c.fillStyle = g;
  c.beginPath(); c.arc(cx, cy + 0.18 * r, r, 0, TAU); c.fill();
  /* 下の明るい三日月(水滴がレンズになって空の光を集める) */
  c.strokeStyle = 'rgba(255,255,255,0.45)';
  c.lineWidth = 0.14 * r;
  c.beginPath(); c.arc(cx, cy, 0.7 * r, 0.15 * Math.PI, 0.85 * Math.PI); c.stroke();
  /* 左上の光の点 */
  c.fillStyle = 'rgba(255,255,255,0.9)';
  c.beginPath(); c.arc(cx - 0.32 * r, cy - 0.36 * r, 0.17 * r, 0, TAU); c.fill();
  /* 雪のつぶ: やわらかい白。ふちは少し灰色(白い景色の前でも見える)。丸くなりすぎないよう小さなかたまりを2つ足す */
  [[96, 32, 26], [84, 26, 13], [106, 40, 11]].forEach(([x, y, rr]) => {
    const f = c.createRadialGradient(x, y, 0, x, y, rr);
    f.addColorStop(0, 'rgba(255,255,255,0.95)');
    f.addColorStop(0.5, 'rgba(250,252,255,0.7)');
    f.addColorStop(0.8, 'rgba(150,162,175,0.32)');
    f.addColorStop(1, 'rgba(150,162,175,0)');
    c.fillStyle = f;
    c.beginPath(); c.arc(x, y, rr, 0, TAU); c.fill();
  });
  return cv;
}

/* 水の膜のもよう 256x256: こまかい水滴 約1800こ(0.6〜1.6px。暗いふち + 明るい点)。
 * 雪(snow)は 白いしもの もよう(白っぽい くもり + 白い つぶ)。どちらも一度だけ作る */
function makeFilm(snow) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 256;
  const c = cv.getContext('2d');
  let seed = snow ? 9 : 5;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  /* ぬれたガラスは光をちらすので、全体を 白っぽく(雪は もっと白く) */
  c.fillStyle = snow ? 'rgba(236,242,248,0.34)' : 'rgba(200,212,222,0.17)';
  c.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 1800; i++) {
    const x = rnd() * 256, y = rnd() * 256, r = (snow ? 0.8 : 0.6) + rnd() * (snow ? 1.4 : 1.0);
    if (snow) {
      c.fillStyle = 'rgba(255,255,255,0.55)';
      c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill();
      continue;
    }
    c.fillStyle = 'rgba(12,20,28,0.42)';
    c.beginPath(); c.arc(x, y + r * 0.2, r, 0, TAU); c.fill();
    c.fillStyle = 'rgba(255,255,255,0.42)';
    c.beginPath(); c.arc(x - r * 0.3, y - r * 0.35, r * 0.45, 0, TAU); c.fill();
  }
  return cv;
}

/* 雪の山の かたまり(位置の割合 t・ふちからの ずれ j・大きさ sz)。決まった乱数で一度だけ */
function makeRidge() {
  const n = RIDGE_ARC + RIDGE_END, B = new Float32Array(n * 3);
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < n; i++) {
    const arc = i < RIDGE_ARC, k = arc ? i / (RIDGE_ARC - 1) : (i - RIDGE_ARC) / (RIDGE_END - 1);
    B[i * 3] = Math.min(1, Math.max(0, k + (rnd() - 0.5) * 0.02));
    B[i * 3 + 1] = rnd();
    /* はしほど小さく(山の すそ) */
    const edge = arc ? Math.min(1, Math.min(k, 1 - k) * 6) : Math.min(1, (1 - k) * 4) * Math.min(1, k * 8 + 0.3);
    B[i * 3 + 2] = (5.5 + 6 * rnd()) * (0.4 + 0.6 * edge);
  }
  return B;
}

function newDrop() {
  return {
    x: 0, y: 0, r: 1, vx: 0, vy: 0, life: 0, snow: false, wi: 0,
    tx: new Float32Array(TRAIL), ty: new Float32Array(TRAIL), tn: 0, ti: 0, tt: 0,
  };
}

export class RainGlass {
  constructor(canvas) {
    this.cv = canvas;
    this.c = canvas.getContext('2d');
    /* 水の膜のキャンバス(#rain-glass と同じ箱。そのすぐ前=下に重ねる) */
    this.fv = null; this.fc = null;
    try {
      const f = document.createElement('canvas');
      f.id = 'rain-film';
      if (canvas.parentNode) canvas.parentNode.insertBefore(f, canvas);
      this.fv = f; this.fc = f.getContext('2d');
    } catch (e) { this.fv = null; this.fc = null; }
    this.active = false;
    this.mode = 'rain';
    this.W = 0; this.H = 0;                 // #gl-wrap の大きさ(CSS px)
    this.bx = 0; this.by = 0; this.bw = 0; this.bh = 0;   // 窓に外接する四角(CSS px)
    this._L = null; this._rects = null; this._dirty = true;
    this.P = [];
    for (let i = 0; i < CAP_MAX; i++) this.P.push(newDrop());
    this.n = 0;
    this.acc = 0;
    this.t = 0;
    this.tw = 0;              // ワイパーと同じ時計(描画側の dt。重い端末で実時間とずれても扇形がワイパーにあう)
    this._clean = true;
    this._wa = null;
    this.spr = null;
    this.scale = 1;
    /* 水の膜: 窓ごとの ぬれぐあい(0..1)と、ワイパーの扇形の区切りごとの ふいた時刻 */
    this.wet = [0, 0];
    this._fanT = new Float32Array(FAN_N).fill(-99);
    this._filmT = 0; this._filmW = -1; this._filmClean = true; this._filmPat = null; this._filmSnow = false;
    /* ワイパーがないときの窓(画面いっぱい) */
    this._full = [{ x0: 0, x1: 1, y0: 0, y1: 1, rTop: 0, rBot: 0 }];
    /* 窓ごとの範囲(キャンバスの座標)。作りなおしのときだけ書きかえる */
    this._R = [{ x0: 0, y0: 0, x1: 0, y1: 0, rt: 0, rb: 0, a: 0 }, { x0: 0, y0: 0, x1: 0, y1: 0, rt: 0, rb: 0, a: 0 }];
    this._nR = 0;
    this._areaK = 1;
  }

  resize(w, h) {
    this.W = w; this.H = h;
    /* 粒の大きさ: 画面の高さ 520px を 1 として(iPad・大きい画面でも小さくなりすぎない) */
    this.scale = Math.min(2.2, Math.max(1, h / 520));
    this._dirty = true;
  }

  setMode(m) {
    const mm = m === 'snow' ? 'snow' : 'rain';
    if (mm !== this.mode) { this.wet[0] = this.wet[1] = 0; this._filmW = -1; }
    this.mode = mm;
  }

  setActive(on) {
    this.active = !!on;
    this.cv.style.display = on ? 'block' : 'none';
    if (this.fv) this.fv.style.display = on ? 'block' : 'none';
    if (!on) {
      this.n = 0; this.acc = 0; this._wa = null; this._lt = null;
      if (this.cv.width) this.c.clearRect(0, 0, this.cv.width, this.cv.height);
      this._clean = true;
      this.wet[0] = this.wet[1] = 0;
      this._fanT.fill(-99);
      if (this.fc && this.fv.width) this.fc.clearRect(0, 0, this.fv.width, this.fv.height);
      this._filmClean = true; this._filmW = -1;
    } else {
      /* 雨・雪の中を走りはじめるときは、ガラスは もう ぬれている(しもが ついている) */
      const w0 = this.mode === 'snow' ? 0.6 : 0.7;
      this.wet[0] = Math.max(this.wet[0], w0); this.wet[1] = Math.max(this.wet[1], w0);
      /* ワイパーは さっき ふいたところ(扇形は きれいな状態から) */
      this._fanT.fill(this.tw);
      this._filmW = -1;
    }
  }

  /* 窓の範囲が変わったら、キャンバスを外接する四角にあわせる(等倍) */
  _fit(rects) {
    const W = this.W, H = this.H;
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      if (r.x0 < x0) x0 = r.x0; if (r.y0 < y0) y0 = r.y0;
      if (r.x1 > x1) x1 = r.x1; if (r.y1 > y1) y1 = r.y1;
    }
    const bx = Math.max(0, Math.floor(x0 * W)), by = Math.max(0, Math.floor(y0 * H));
    const bw = Math.max(1, Math.min(W, Math.ceil(x1 * W)) - bx), bh = Math.max(1, Math.min(H, Math.ceil(y1 * H)) - by);
    /* 前の位置で持っていた粒は、新しいキャンバスの座標へずらす */
    const dx = this.bx - bx, dy = this.by - by;
    for (let i = 0; i < this.n; i++) { this.P[i].x += dx; this.P[i].y += dy; this.P[i].tn = 0; }
    this.bx = bx; this.by = by; this.bw = bw; this.bh = bh;
    [this.cv, this.fv].forEach((cv) => {
      if (!cv) return;
      const st = cv.style;
      st.left = bx + 'px'; st.top = by + 'px'; st.width = bw + 'px'; st.height = bh + 'px';
      cv.width = bw; cv.height = bh;
    });
    this._filmPat = null;   // 大きさを変えると文脈がリセットされるので作りなおす
    this._filmW = -1;
    this._nR = Math.min(2, rects.length);
    let area = 0;
    for (let i = 0; i < this._nR; i++) {
      const r = rects[i], R = this._R[i];
      R.x0 = r.x0 * W - bx; R.x1 = r.x1 * W - bx; R.y0 = r.y0 * H - by; R.y1 = r.y1 * H - by;
      const m = Math.min(R.x1 - R.x0, R.y1 - R.y0) * 0.45;
      R.rt = Math.min(m, (r.rTop || 0) * H); R.rb = Math.min(m, (r.rBot || 0) * H);
      R.a = Math.max(0, (R.x1 - R.x0) * (R.y1 - R.y0));
      area += R.a;
    }
    /* 降ってくる量は窓の面積に比例(1200x480 を 1 として) */
    this._areaK = Math.max(0.35, area / (1200 * 480));
    this._clean = true;
    this._dirty = false;
  }

  /* 角の丸い四角(古いSafariには roundRect がないので arcTo で)。上と下で丸みがちがう */
  _rr(c, R) {
    const x = R.x0, y = R.y0, w = R.x1 - R.x0, h = R.y1 - R.y0, rt = R.rt, rb = R.rb;
    c.moveTo(x + rt, y);
    c.arcTo(x + w, y, x + w, y + h, rt);
    c.arcTo(x + w, y + h, x, y + h, rb);
    c.arcTo(x, y + h, x, y, rb);
    c.arcTo(x, y, x + w, y, rt);
    c.closePath();
  }

  _spawn(snow, cap) {
    if (this.n >= cap) return;
    const R0 = this._R[0], R1 = this._R[1];
    const wi = this._nR > 1 && Math.random() * (R0.a + R1.a) > R0.a ? 1 : 0;
    const R = this._R[wi];
    const d = this.P[this.n++];
    d.x = R.x0 + Math.random() * (R.x1 - R.x0);
    d.y = R.y0 + Math.random() * (R.y1 - R.y0);
    d.wi = wi;
    d.snow = snow;
    d.r = (snow ? 3 + 5 * Math.pow(Math.random(), 1.4) : 1.3 + 4.2 * Math.pow(Math.random(), 1.7)) * this.scale;
    d.vx = 0; d.vy = 0;
    d.life = snow ? 2.5 + Math.random() * 2.5 : 4 + Math.random() * 5;
    d.tn = 0; d.ti = 0; d.tt = 0;
  }

  /* 水の膜(1秒に10回まで): 窓ごとに もようを ぬれぐあいの濃さで。運転士窓は ワイパーが ふいた扇形を うすく。
   * 雪のときは しも(ワイパーが ふいたあと 6秒で もどる。間をあけて ふくので 扇形は ほぼ きれい) */
  _drawFilm(wpx, wpy, wl, rest, sill) {
    const c = this.fc;
    if (!c) return;
    const snow = this.mode === 'snow';
    if (!this._filmPat || this._filmSnow !== snow) {
      this._filmSnow = snow;
      const key = snow ? '_frostCv' : '_filmCv';
      this._filmPat = c.createPattern(this[key] || (this[key] = makeFilm(snow)), 'repeat');
    }
    const regrow = snow ? 6 : 1.4;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;
    c.clearRect(0, 0, this.bw, this.bh);
    let any = false;
    for (let i = 0; i < this._nR; i++) {
      const w = this.wet[i];
      if (w < 0.01) continue;
      any = true;
      const R = this._R[i];
      c.save();
      c.beginPath(); this._rr(c, R); c.clip();
      c.globalAlpha = Math.min(1, w * (snow ? 0.8 : 0.65));
      c.fillStyle = this._filmPat;
      c.fillRect(R.x0, R.y0, R.x1 - R.x0, R.y1 - R.y0);
      c.restore();
    }
    /* ワイパーが ふいたところ: 区切りごとに 1 - (いま - ふいた時刻)/1.4 の濃さで けす */
    if (any && wl > 0 && this.wet[0] >= 0.01) {
      c.globalCompositeOperation = 'destination-out';
      const da = WIPE_SWEEP / FAN_N, r0 = wl * 0.12, r1 = wl * 0.99;
      for (let k = 0; k < FAN_N; k++) {
        const age = this.tw - this._fanT[k];
        if (!(age < regrow)) continue;
        c.globalAlpha = 1 - age / regrow;
        const t0 = Math.PI + rest + k * da - 0.01, t1 = t0 + da + 0.02;
        c.beginPath();
        c.arc(wpx, wpy, r1, t0, t1);
        c.arc(wpx, wpy, r0, t1, t0, true);
        c.closePath();
        c.fill();
      }
      c.globalCompositeOperation = 'source-over';
      c.globalAlpha = 1;
    }
    /* 雪: ワイパーが おしやった雪の山(扇形の そとのふちと、振りきったはし)。窓の下のふちの雪と同じ量。
     * 細い線だと ガラスのひびに見えるので、雪のつぶの絵を ならべた やわらかい かたまりで */
    if (snow && sill >= 0.05 && wl > 0 && this.spr && this._nR > 0) {
      const B = this._ridge || (this._ridge = makeRidge());
      const sc = this.scale, tA = Math.PI + rest + 0.02, tE = Math.PI + rest + WIPE_SWEEP + 0.03;
      const k = Math.min(1, sill), grow = 0.55 + 0.45 * k;
      c.save();
      c.beginPath(); this._rr(c, this._R[0]); c.clip();
      /* 下地: 少し下に灰色の かげ(白い景色の前でも形が見える) → 白の帯(かたまりの すきまを うめる) */
      c.lineCap = 'round';
      const ce = Math.cos(tE + 0.02), se = Math.sin(tE + 0.02);
      for (let p = 0; p < 2; p++) {
        const oy = p ? 0 : 2.2 * sc;
        c.globalAlpha = (p ? 0.5 : 0.3) * k;
        c.strokeStyle = p ? '#eef2f6' : '#7d8994';
        c.lineWidth = (p ? 9 : 10) * sc * grow;
        c.beginPath(); c.arc(wpx, wpy + oy, wl * 1.015, tA, tE); c.stroke();
        c.beginPath();
        c.moveTo(wpx + ce * wl * 0.16, wpy + se * wl * 0.16 + oy);
        c.lineTo(wpx + ce * wl * 0.97, wpy + se * wl * 0.97 + oy);
        c.stroke();
      }
      c.globalAlpha = 0.95 * k;
      for (let i = 0; i < RIDGE_ARC + RIDGE_END; i++) {
        const t = B[i * 3], j = B[i * 3 + 1], r = B[i * 3 + 2] * sc * grow;
        let a, d;
        if (i < RIDGE_ARC) { a = tA + (tE - tA) * t; d = wl * (1.005 + j * 0.03); }
        else { a = tE + 0.012 + j * 0.03; d = wl * (0.16 + 0.81 * t); }
        c.drawImage(this.spr, 64, 0, 64, 64, wpx + Math.cos(a) * d - r, wpy + Math.sin(a) * d - r, r * 2, r * 2);
      }
      c.restore();
      any = true;
    }
    this._filmClean = !any;
  }

  /* v: km/h, cockpit: scene.cockpit(窓の範囲とワイパー角), dry: トンネル内など */
  render(dt, v, cockpit, dry) {
    if (!this.active || !(this.W > 0) || !(this.H > 0)) return;
    if (!this.spr) this.spr = makeSprites();
    const rects = (cockpit && cockpit.windowRects && cockpit.windowRects()) || this._full;
    if (rects !== this._rects || this._dirty) { this._rects = rects; this._fit(rects); }
    const c = this.c, P = this.P, snowMode = this.mode === 'snow';
    const cap = cockpit && cockpit.quality === 'low' ? CAP_LOW : CAP_MAX;
    /* 描画が重い端末でも、雨の量・流れは実時間で(dt は描画側で0.1秒に切られている)。
     * ワイパーの扇形だけは ワイパーと同じ dt0 で数える */
    const dt0 = dt > 0 ? dt : 0;
    const now = typeof performance !== 'undefined' ? performance.now() : 0;
    if (this._lt != null && dt > 0) dt = Math.max(dt, Math.min(0.5, (now - this._lt) / 1000));
    this._lt = now;
    this.tw += dt0;
    this.t += dt;
    /* 降ってくる量(1秒あたり): 雨は速いほどたくさん当たる。雪は少なめ。窓の面積に比例 */
    if (!dry && dt > 0) {
      this.acc += (snowMode ? 15 + v * 0.3 : 40 + v * 1.2) * this._areaK * dt;
      while (this.acc >= 1) { this.acc -= 1; this._spawn(snowMode, cap); }
    } else this.acc = 0;
    /* 水の膜の ぬれぐあい: 雨の中では (0.06 + 速さ×0.002)/秒 で ぬれ、トンネルでは 0.18/秒 で かわく。
     * 雪の しもは ゆっくり(0.03/秒)つく */
    if (dt > 0) {
      const up = snowMode ? 0.03 : 0.06 + v * 0.002;
      for (let i = 0; i < 2; i++) {
        if (!dry) this.wet[i] = Math.min(1, this.wet[i] + up * dt);
        else this.wet[i] = Math.max(0, this.wet[i] - 0.18 * dt);
      }
    }
    /* ワイパー: 前のフレームからの角度のあいだを通った粒を拭き取る(重い端末でもとりこぼさない) */
    const wp = cockpit && cockpit.wiperScreen ? cockpit.wiperScreen() : null;
    let wpx = 0, wpy = 0, wl = 0, a0 = 0, a1 = 0, wiping = false;
    const rest = cockpit && cockpit.wiperRest != null ? cockpit.wiperRest : 0.012;
    if (wp) {
      wpx = wp.px * this.W - this.bx; wpy = wp.py * this.H - this.by; wl = wp.len * this.H;
      const prev = this._wa == null ? wp.ang : this._wa;
      wiping = Math.abs(wp.ang - prev) > 1e-4;
      a0 = Math.min(prev, wp.ang) - 0.05; a1 = Math.max(prev, wp.ang) + 0.05;
      this._wa = wp.ang;
      /* 扇形の区切りごとに「いま ふいた」を覚える(水の膜を けす) */
      if (wiping) {
        const da = WIPE_SWEEP / FAN_N;
        for (let k = 0; k < FAN_N; k++) {
          const ak = rest + (k + 0.5) * da;
          if (ak > a0 && ak < a1) this._fanT[k] = this.tw;
        }
      }
    }
    /* 雪の日: 窓の下のふちの雪の量(ワイパーが おしやった雪の山も 同じ量。水の膜のキャンバスに描く) */
    const sill = snowMode && wp && cockpit.sillLevel ? cockpit.sillLevel() : 0;
    /* 水の膜は 1秒に10回まで(ぬれぐあい・雪の量が変わったとき・扇形が ぬれもどる間だけ) */
    this._filmT += dt;
    if (this.fc && this._filmT >= 0.1) {
      let fanBusy = false;
      const rg = snowMode ? 6.1 : 1.5;
      for (let k = 0; k < FAN_N; k++) if (this.tw - this._fanT[k] < rg) { fanBusy = true; break; }
      const wq = Math.round((this.wet[0] + this.wet[1]) * 50), sq = sill >= 0.05 ? Math.round(sill * 20) : 0;
      const fq = wq * 32 + sq;
      if (fq !== this._filmW || fanBusy) {
        this._filmT = 0;
        this._filmW = fq;
        if (fq === 0 && this._filmClean) { /* 乾いている */ } else this._drawFilm(wpx, wpy, wl, rest, sill);
      }
    }
    /* 動き: 20km/hより速いと 風で上と外へ。遅いと 大きい粒だけ下へ垂れる。雪は40km/hまでくっついたまま */
    const fast = v > 20, wind = (v - 20) * 0.9, big = 2.4 * this.scale;
    let w = 0;
    for (let i = 0; i < this.n; i++) {
      const d = P[i];
      d.life -= dt * (dry ? 3 : 1);
      if (d.snow && d.life <= 0 && !dry) { d.snow = false; d.r *= 0.7; d.life = 2; d.vx = 0; d.vy = 0; }
      const R = this._R[d.wi] || this._R[0];
      if (d.snow ? v > 40 : fast) {
        const k = 0.45 + 0.55 * Math.min(1, d.r / big);
        d.vy = -wind * k;
        d.vx = ((d.x - (R.x0 + R.x1) * 0.5) / Math.max(1, R.x1 - R.x0)) * v * 0.8 * k;
      } else if (!d.snow && d.r > big) {
        d.vx *= 0.9;
        d.vy = Math.min(40, d.vy + 18 * dt);
      } else { d.vx = 0; d.vy = 0; }
      d.x += d.vx * dt; d.y += d.vy * dt;
      /* 筋: 8px/秒より速い粒は 50msごとに通った点を6つまで覚える */
      if (d.vx * d.vx + d.vy * d.vy > 64) {
        d.tt += dt;
        if (d.tt >= 0.05 || d.tn === 0) {
          d.tt = 0; d.tx[d.ti] = d.x; d.ty[d.ti] = d.y;
          d.ti = (d.ti + 1) % TRAIL; if (d.tn < TRAIL) d.tn++;
        }
      } else d.tn = 0;
      let keep = d.life > 0 && d.y > R.y0 - 6 && d.y < R.y1 + 8 && d.x > R.x0 - 6 && d.x < R.x1 + 6;
      if (keep && wiping && d.wi === 0) {
        const dx = d.x - wpx, dy = d.y - wpy;
        if (dx * dx + dy * dy < wl * wl) {
          const da = Math.atan2(-dy, -dx);
          if (da > a0 && da < a1) keep = false;
        }
      }
      /* 生きている粒を前につめる(配列はそのまま使い回す) */
      if (keep) { if (w !== i) { P[i] = P[w]; P[w] = d; } w++; }
    }
    this.n = w;
    if (this.n === 0 && !wiping) {
      if (!this._clean) { c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, this.bw, this.bh); this._clean = true; }
      return;
    }
    this._clean = false;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.bw, this.bh);
    c.save();
    c.beginPath();
    for (let i = 0; i < this._nR; i++) this._rr(c, this._R[i]);
    c.clip();
    /* 筋(太さ3段にまとめて3回で描く) */
    c.strokeStyle = 'rgba(210,225,235,0.12)';
    c.lineCap = 'round'; c.lineJoin = 'round';
    const sc = this.scale;
    for (let b = 0; b < 3; b++) {
      let any = false;
      c.beginPath();
      for (let i = 0; i < this.n; i++) {
        const d = P[i];
        if (d.tn < 2) continue;
        const bb = d.r < 1.6 * sc ? 0 : d.r < 2.8 * sc ? 1 : 2;
        if (bb !== b) continue;
        let j = (d.ti - d.tn + TRAIL) % TRAIL;
        c.moveTo(d.tx[j], d.ty[j]);
        for (let q = 1; q < d.tn; q++) { j = (j + 1) % TRAIL; c.lineTo(d.tx[j], d.ty[j]); }
        c.lineTo(d.x, d.y);
        any = true;
      }
      if (any) { c.lineWidth = (b === 0 ? 0.6 : b === 1 ? 1.1 : 1.8) * sc; c.stroke(); }
    }
    /* 粒 */
    const spr = this.spr;
    for (let i = 0; i < this.n; i++) {
      const d = P[i];
      const s = d.r * 1.23;
      const fade = d.life < 0.5 ? Math.max(0, d.life * 2) : 1;
      if (fade < 1) c.globalAlpha = fade;
      c.drawImage(spr, d.snow ? 64 : 0, 0, 64, 64, d.x - s, d.y - s, s * 2, s * 2);
      if (fade < 1) c.globalAlpha = 1;
    }
    /* ワイパーのあとに残る うすい水の膜 */
    if (wiping && wp && !snowMode) {
      const an = wp.ang - 0.06, ca = Math.cos(an), sa = Math.sin(an);
      c.strokeStyle = 'rgba(200,215,225,0.10)';
      c.lineWidth = 3 * sc;
      c.beginPath();
      c.moveTo(wpx - ca * wl * 0.22, wpy - sa * wl * 0.22);
      c.lineTo(wpx - ca * wl, wpy - sa * wl);
      c.stroke();
    }
    c.restore();
    /* ワイパーの腕とブレードの上には粒を描かない(ガラスに押しつけられたブレードの下に水滴はない)。
     * 腕の中心から 下 b0 〜 上 b1 の帯を けす */
    if (wp && wl > 0) {
      const ca = Math.cos(wp.ang), sa = Math.sin(wp.ang);
      const b0 = (wp.b0 != null ? wp.b0 : -0.006) * this.H, b1 = (wp.b1 != null ? wp.b1 : 0.006) * this.H;
      /* 腕の向き(キャンバス): (-cos, -sin)。腕の「上」(ブレードがわ): (sin, -cos) */
      const ux = -ca, uy = -sa, nx = sa, ny = -ca;
      c.globalCompositeOperation = 'destination-out';
      c.beginPath();
      c.moveTo(wpx + nx * b0, wpy + ny * b0);
      c.lineTo(wpx + ux * wl + nx * b0, wpy + uy * wl + ny * b0);
      c.lineTo(wpx + ux * wl + nx * b1, wpy + uy * wl + ny * b1);
      c.lineTo(wpx + nx * b1, wpy + ny * b1);
      c.closePath();
      c.fill();
      c.globalCompositeOperation = 'source-over';
    }
  }
}
