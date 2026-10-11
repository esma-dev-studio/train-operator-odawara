/* =========================================================
 * ui/rainglass.js — 雨・雪の日のフロントガラス(水滴・雪のつぶ)
 * 3D運転台(scene/cockpit.js)の窓の範囲だけに描き、3Dワイパーが通ったら拭き取る。
 *  ・水滴: ふちが暗く、下に明るい三日月、左上に光の点(明るい空にも暗い地面にも見える)
 *  ・はしっているときは風で上と外へ流れ、うすい筋が残る。止まると大きい粒だけ下へ垂れる
 *  ・雪(setMode('snow')): 遅いときは窓にくっつき、しばらくすると とけて水滴になる
 * 軽さ: キャンバスは等倍(DPR 1)で、窓に外接する四角の大きさだけ。粒は使い回し(毎フレームの new なし)、
 *       水滴も筋もない乾いたときは消して何もしない。
 * 外との約束: setActive(on) / setMode('rain'|'snow') / resize(w, h) / render(dt, v, cockpit, dry)
 * ========================================================= */
const CAP = 260;            // 粒の最大数
const TRAIL = 6;            // 筋の点の数(50msごと)
const TAU = Math.PI * 2;

/* 粒の絵(64x64 を2コマ): 0 = 水滴、1 = 雪のつぶ。一度だけ作る */
function makeSprites() {
  const cv = document.createElement('canvas');
  cv.width = 128; cv.height = 64;
  const c = cv.getContext('2d');
  const r = 26, cx = 32, cy = 32;
  const g = c.createRadialGradient(cx, cy + 0.18 * r, 0, cx, cy + 0.18 * r, r);
  g.addColorStop(0, 'rgba(255,255,255,0.08)');
  g.addColorStop(0.7, 'rgba(20,30,40,0.10)');
  g.addColorStop(0.92, 'rgba(8,12,16,0.45)');
  g.addColorStop(1, 'rgba(8,12,16,0)');
  c.fillStyle = g;
  c.beginPath(); c.arc(cx, cy + 0.18 * r, r, 0, TAU); c.fill();
  /* 下の明るい三日月(水滴がレンズになって空の光を集める) */
  c.strokeStyle = 'rgba(255,255,255,0.35)';
  c.lineWidth = 0.12 * r;
  c.beginPath(); c.arc(cx, cy, 0.7 * r, 0.15 * Math.PI, 0.85 * Math.PI); c.stroke();
  /* 左上の光の点 */
  c.fillStyle = 'rgba(255,255,255,0.85)';
  c.beginPath(); c.arc(cx - 0.32 * r, cy - 0.36 * r, 0.16 * r, 0, TAU); c.fill();
  /* 雪のつぶ: やわらかい白 */
  const f = c.createRadialGradient(96, 32, 0, 96, 32, 30);
  f.addColorStop(0, 'rgba(255,255,255,0.95)');
  f.addColorStop(0.5, 'rgba(255,255,255,0.6)');
  f.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = f;
  c.beginPath(); c.arc(96, 32, 30, 0, TAU); c.fill();
  return cv;
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
    this.active = false;
    this.mode = 'rain';
    this.W = 0; this.H = 0;                 // #gl-wrap の大きさ(CSS px)
    this.bx = 0; this.by = 0; this.bw = 0; this.bh = 0;   // 窓に外接する四角(CSS px)
    this._L = null; this._rects = null; this._dirty = true;
    this.P = [];
    for (let i = 0; i < CAP; i++) this.P.push(newDrop());
    this.n = 0;
    this.acc = 0;
    this.t = 0;
    this._clean = true;
    this._wa = null;
    this.spr = null;
    this.scale = 1;
    /* ワイパーがないときの窓(画面いっぱい) */
    this._full = [{ x0: 0, x1: 1, y0: 0, y1: 1, rTop: 0, rBot: 0 }];
    /* 窓ごとの範囲(キャンバスの座標)。作りなおしのときだけ書きかえる */
    this._R = [{ x0: 0, y0: 0, x1: 0, y1: 0, rt: 0, rb: 0, a: 0 }, { x0: 0, y0: 0, x1: 0, y1: 0, rt: 0, rb: 0, a: 0 }];
    this._nR = 0;
  }

  resize(w, h) {
    this.W = w; this.H = h;
    this._dirty = true;
  }

  setMode(m) { this.mode = m === 'snow' ? 'snow' : 'rain'; }

  setActive(on) {
    this.active = !!on;
    this.cv.style.display = on ? 'block' : 'none';
    if (!on) {
      this.n = 0; this.acc = 0; this._wa = null; this._lt = null;
      if (this.cv.width) this.c.clearRect(0, 0, this.cv.width, this.cv.height);
      this._clean = true;
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
    const st = this.cv.style;
    st.left = bx + 'px'; st.top = by + 'px'; st.width = bw + 'px'; st.height = bh + 'px';
    this.cv.width = bw; this.cv.height = bh;
    this._nR = Math.min(2, rects.length);
    for (let i = 0; i < this._nR; i++) {
      const r = rects[i], R = this._R[i];
      R.x0 = r.x0 * W - bx; R.x1 = r.x1 * W - bx; R.y0 = r.y0 * H - by; R.y1 = r.y1 * H - by;
      const m = Math.min(R.x1 - R.x0, R.y1 - R.y0) * 0.45;
      R.rt = Math.min(m, (r.rTop || 0) * H); R.rb = Math.min(m, (r.rBot || 0) * H);
      R.a = Math.max(0, (R.x1 - R.x0) * (R.y1 - R.y0));
    }
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

  _spawn(snow) {
    if (this.n >= CAP) return;
    const R0 = this._R[0], R1 = this._R[1];
    const wi = this._nR > 1 && Math.random() * (R0.a + R1.a) > R0.a ? 1 : 0;
    const R = this._R[wi];
    const d = this.P[this.n++];
    d.x = R.x0 + Math.random() * (R.x1 - R.x0);
    d.y = R.y0 + Math.random() * (R.y1 - R.y0);
    d.wi = wi;
    d.snow = snow;
    d.r = snow ? 1.3 + 2.8 * Math.pow(Math.random(), 1.6) : 1.1 + 3.9 * Math.pow(Math.random(), 1.8);
    d.vx = 0; d.vy = 0;
    d.life = snow ? 2.5 + Math.random() * 2.5 : 4 + Math.random() * 5;
    d.tn = 0; d.ti = 0; d.tt = 0;
  }

  /* v: km/h, cockpit: scene.cockpit(窓の範囲とワイパー角), dry: トンネル内など */
  render(dt, v, cockpit, dry) {
    if (!this.active || !(this.W > 0) || !(this.H > 0)) return;
    if (!this.spr) this.spr = makeSprites();
    const rects = (cockpit && cockpit.windowRects && cockpit.windowRects()) || this._full;
    if (rects !== this._rects || this._dirty) { this._rects = rects; this._fit(rects); }
    const c = this.c, P = this.P, snowMode = this.mode === 'snow';
    /* 描画が重い端末でも、雨の量・流れは実時間で(dt は描画側で0.1秒に切られている) */
    const now = typeof performance !== 'undefined' ? performance.now() : 0;
    if (this._lt != null && dt > 0) dt = Math.max(dt, Math.min(0.5, (now - this._lt) / 1000));
    this._lt = now;
    this.t += dt;
    /* 降ってくる量(1秒あたり): 雨は速いほどたくさん当たる。雪は少なめ */
    if (!dry && dt > 0) {
      this.acc += (snowMode ? 15 + v * 0.3 : 40 + v * 1.2) * dt;
      while (this.acc >= 1) { this.acc -= 1; this._spawn(snowMode); }
    } else this.acc = 0;
    /* ワイパー: 前のフレームからの角度のあいだを通った粒を拭き取る(重い端末でもとりこぼさない) */
    const wp = cockpit && cockpit.wiperScreen ? cockpit.wiperScreen() : null;
    let wpx = 0, wpy = 0, wl = 0, a0 = 0, a1 = 0, wiping = false;
    if (wp) {
      wpx = wp.px * this.W - this.bx; wpy = wp.py * this.H - this.by; wl = wp.len * this.H;
      const prev = this._wa == null ? wp.ang : this._wa;
      wiping = Math.abs(wp.ang - prev) > 1e-4;
      a0 = Math.min(prev, wp.ang) - 0.05; a1 = Math.max(prev, wp.ang) + 0.05;
      this._wa = wp.ang;
    }
    /* 動き: 20km/hより速いと 風で上と外へ。遅いと 大きい粒だけ下へ垂れる。雪は40km/hまでくっついたまま */
    const fast = v > 20, wind = (v - 20) * 0.9;
    let w = 0;
    for (let i = 0; i < this.n; i++) {
      const d = P[i];
      d.life -= dt * (dry ? 3 : 1);
      if (d.snow && d.life <= 0 && !dry) { d.snow = false; d.r *= 0.7; d.life = 2; d.vx = 0; d.vy = 0; }
      const R = this._R[d.wi] || this._R[0];
      if (d.snow ? v > 40 : fast) {
        const k = 0.45 + 0.55 * Math.min(1, d.r / 2.4);
        d.vy = -wind * k;
        d.vx = ((d.x - (R.x0 + R.x1) * 0.5) / Math.max(1, R.x1 - R.x0)) * v * 0.8 * k;
      } else if (!d.snow && d.r > 2.4) {
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
    c.strokeStyle = 'rgba(210,225,235,0.10)';
    c.lineCap = 'round'; c.lineJoin = 'round';
    for (let b = 0; b < 3; b++) {
      let any = false;
      c.beginPath();
      for (let i = 0; i < this.n; i++) {
        const d = P[i];
        if (d.tn < 2) continue;
        const bb = d.r < 1.6 ? 0 : d.r < 2.8 ? 1 : 2;
        if (bb !== b) continue;
        let j = (d.ti - d.tn + TRAIL) % TRAIL;
        c.moveTo(d.tx[j], d.ty[j]);
        for (let q = 1; q < d.tn; q++) { j = (j + 1) % TRAIL; c.lineTo(d.tx[j], d.ty[j]); }
        c.lineTo(d.x, d.y);
        any = true;
      }
      if (any) { c.lineWidth = b === 0 ? 0.6 : b === 1 ? 1.1 : 1.8; c.stroke(); }
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
    if (wiping && wp) {
      const an = wp.ang - 0.06, ca = Math.cos(an), sa = Math.sin(an);
      c.strokeStyle = 'rgba(200,215,225,0.08)';
      c.lineWidth = 3;
      c.beginPath();
      c.moveTo(wpx - ca * wl * 0.22, wpy - sa * wl * 0.22);
      c.lineTo(wpx - ca * wl, wpy - sa * wl);
      c.stroke();
    }
    c.restore();
  }
}
