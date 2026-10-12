/* =========================================================
 * ui/rainglass.js — 雨・雪の日のフロントガラス(水滴・水の膜・雪のつぶ)
 * 3D運転台(scene/cockpit.js)の窓の範囲だけに描き、3Dワイパーが通ったら拭き取る。
 *  ・水滴: ふちが暗く、下に明るい三日月、左上に光の点(明るい空にも暗い地面にも見える)。
 *          大きさは画面の高さにあわせる(iPad でも小さくなりすぎない)
 *  ・はしっているときは風で上と外へ流れ、うすい筋が残る。止まると大きい粒だけ下へ垂れる
 *  ・水の膜(#rain-film): こまかい つぶの もようを ぬれぐあい(wet)の濃さで。ワイパーが ふいた扇形は
 *    いったん きれいになり、1.4秒で また ぬれる(1秒に10回まで描きなおす)
 *  ・雪(setMode('snow')): 遅いときは窓にくっつき、しばらくすると とけて水滴(ふちの うすい絵)になる。
 *    ワイパーが おしやった雪が 扇形のはしに山になる(白い帯 + かたまり 約24こ)。
 *    しもは うすく、窓のふちに寄せる(まん中は 0.25 倍: 景色が白くかすまない)
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
const RIDGE_E0 = 0.62, RIDGE_E1 = 0.97; // 振りきったはしの山の はんい(腕の長さに対する比。根元のほうは描かない)

/* 粒の絵(64x64 を5コマ。一度だけ作る):
 *  0 = 水滴 / 1〜3 = 雪のつぶ(形のちがう3つ) / 4 = 雪がとけた水滴(ふちは うすい灰色。黒い輪にしない)
 * 雪のつぶは 小さな丸(5〜7こ)の かたまり。ふちは白 → 透明(灰色の輪をつけない: シャボン玉に見えた)。
 * 白い景色の前でも形がわかるよう、右下に 1.5〜2px ずらした うすい かげ(0.16)を先に描く */
const SPR = 64, SPR_MELT = 4;
function waterDrop(c, cx, cy, rim, ink, mid, center, crescent, dot) {
  const r = 26;
  const g = c.createRadialGradient(cx, cy + 0.18 * r, 0, cx, cy + 0.18 * r, r);
  g.addColorStop(0, `rgba(255,255,255,${center})`);
  g.addColorStop(0.68, mid);
  g.addColorStop(0.9, `rgba(${ink},${rim})`);
  g.addColorStop(1, `rgba(${ink},0)`);
  c.fillStyle = g;
  c.beginPath(); c.arc(cx, cy + 0.18 * r, r, 0, TAU); c.fill();
  /* 下の明るい三日月(水滴がレンズになって空の光を集める) */
  c.strokeStyle = `rgba(255,255,255,${crescent})`;
  c.lineWidth = 0.14 * r;
  c.beginPath(); c.arc(cx, cy, 0.7 * r, 0.15 * Math.PI, 0.85 * Math.PI); c.stroke();
  /* 左上の光の点 */
  c.fillStyle = `rgba(255,255,255,${dot})`;
  c.beginPath(); c.arc(cx - 0.32 * r, cy - 0.36 * r, 0.17 * r, 0, TAU); c.fill();
}
/* 雪のつぶ1つぶんの形(64x64・白)。決まった乱数で 5〜7この丸を まん中のまわりに */
function flakeMask(seed) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = SPR;
  const c = cv.getContext('2d');
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const n = 5 + ((rnd() * 3) | 0);
  for (let i = 0; i < n; i++) {
    const a = rnd() * TAU, d = i === 0 ? 0 : 6 + rnd() * 9;
    const x = 32 + Math.cos(a) * d, y = 32 + Math.sin(a) * d, rr = i === 0 ? 11 : 5 + rnd() * 6;
    const f = c.createRadialGradient(x, y, 0, x, y, rr);
    f.addColorStop(0, 'rgba(255,255,255,0.95)');
    f.addColorStop(0.6, 'rgba(255,255,255,0.75)');
    f.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = f;
    c.beginPath(); c.arc(x, y, rr, 0, TAU); c.fill();
  }
  return cv;
}
function makeSprites() {
  const cv = document.createElement('canvas');
  cv.width = SPR * 5; cv.height = SPR;
  const c = cv.getContext('2d');
  waterDrop(c, 32, 32, 0.58, '8,12,16', 'rgba(20,30,40,0.14)', 0.10, 0.45, 0.9);
  /* 雪がとけた水滴: ふちは うすい灰青 0.2・まん中は白っぽく(白い景色の前で 黒い輪・シャボン玉にならない) */
  waterDrop(c, SPR * SPR_MELT + 32, 32, 0.2, '70,80,92', 'rgba(150,160,172,0.06)', 0.14, 0.24, 0.42);
  const tmp = document.createElement('canvas');
  tmp.width = tmp.height = SPR;
  const tc = tmp.getContext('2d');
  [7, 23, 41].forEach((seed, k) => {
    const m = flakeMask(seed), x0 = SPR * (1 + k);
    /* かげ: 同じ形を うすい灰青で(重なっても 0.16 をこえない: 1枚の絵にしてから うすく置く) */
    tc.globalCompositeOperation = 'source-over';
    tc.clearRect(0, 0, SPR, SPR);
    tc.drawImage(m, 0, 0);
    tc.globalCompositeOperation = 'source-in';
    tc.fillStyle = 'rgb(70,80,92)';
    tc.fillRect(0, 0, SPR, SPR);
    c.save();
    c.beginPath(); c.rect(x0, 0, SPR, SPR); c.clip();
    c.globalAlpha = 0.16;
    c.drawImage(tmp, x0 + 1.5, 2);
    c.globalAlpha = 1;
    c.drawImage(m, x0, 0);
    c.restore();
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
  /* ぬれたガラスは光をちらすので、全体を 白っぽく(雪の しもは うすく: 景色が白くかすまないように) */
  c.fillStyle = snow ? 'rgba(236,242,248,0.10)' : 'rgba(200,212,222,0.17)';
  c.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 1800; i++) {
    const x = rnd() * 256, y = rnd() * 256, r = (snow ? 0.8 : 0.6) + rnd() * (snow ? 1.4 : 1.0);
    if (snow) {
      c.fillStyle = 'rgba(255,255,255,0.35)';
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

/* 扇形の そとのふち(弧)の こさ: 両はし 1 → まん中 0.4(t: 弧の はじめ 0 〜 おわり 1) */
const RIDGE_STOPS = [[0, 1], [0.14, 1], [0.38, 0.4], [0.62, 0.4], [0.86, 1], [1, 1]];
function ridgeEnds(t) {
  for (let i = 1; i < RIDGE_STOPS.length; i++) {
    const a = RIDGE_STOPS[i - 1], b = RIDGE_STOPS[i];
    if (t <= b[0]) return a[1] + (b[1] - a[1]) * ((t - a[0]) / (b[0] - a[0]));
  }
  return 1;
}

function newDrop() {
  return {
    x: 0, y: 0, r: 1, vx: 0, vy: 0, life: 0, snow: false, wi: 0, v: 0,
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
    /* 雪の しもを 窓のふちに寄せる型(窓ごと。大きさが変わったときだけ作りなおす) */
    this._masks = [null, null];
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
    this._masks[0] = this._masks[1] = null;
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

  /* 雪の山の弧の色(白・かげ)。弧の はじめ → おわりの向きの グラデーションで、まん中を うすく。
   * ワイパーの位置・長さが変わったときだけ作りなおす(1秒に10回の描きなおしで 毎回は作らない) */
  _ridgeGrads(c, wpx, wpy, wl, tA, tE) {
    const key = wpx.toFixed(1) + ',' + wpy.toFixed(1) + ',' + wl.toFixed(1);
    if (this._rgKey === key && this._rg) return this._rg;
    const r = wl * 1.015;
    const x0 = wpx + Math.cos(tA) * r, y0 = wpy + Math.sin(tA) * r, x1 = wpx + Math.cos(tE) * r, y1 = wpy + Math.sin(tE) * r;
    const mk = (rgb) => {
      const g = c.createLinearGradient(x0, y0, x1, y1);
      RIDGE_STOPS.forEach(([t, a]) => g.addColorStop(t, `rgba(${rgb},${a})`));
      return g;
    };
    this._rg = { w: mk('238,242,246'), s: mk('125,137,148') };
    this._rgKey = key;
    return this._rg;
  }

  /* 雪の しもの型(窓 i の四角の大きさ): まん中の だ円(四角の 55%)の内は 0.25、窓のふちで 1。
   * 'destination-in' で しもに かける。大きさが変わったあと 最初に使うときに一度だけ作る */
  _edgeMask(i) {
    if (this._masks[i]) return this._masks[i];
    const R = this._R[i];
    const w = Math.max(1, Math.round(R.x1 - R.x0)), h = Math.max(1, Math.round(R.y1 - R.y0));
    try {
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const c = cv.getContext('2d');
      /* 単位円 → 窓の四角に内接する だ円(四すみは 1 のまま) */
      c.setTransform(w / 2, 0, 0, h / 2, w / 2, h / 2);
      const g = c.createRadialGradient(0, 0, 0, 0, 0, 1);
      g.addColorStop(0, 'rgba(0,0,0,0.25)');
      g.addColorStop(0.55, 'rgba(0,0,0,0.25)');
      g.addColorStop(1, 'rgba(0,0,0,1)');
      c.fillStyle = g;
      c.fillRect(-1.5, -1.5, 3, 3);
      this._masks[i] = cv;
    } catch (e) { this._masks[i] = null; }
    return this._masks[i];
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
    d.v = (Math.random() * 3) | 0;   // 雪のつぶの形(3つのうち どれか)
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
      c.globalAlpha = Math.min(1, w * (snow ? 0.45 : 0.65));
      c.fillStyle = this._filmPat;
      c.fillRect(R.x0, R.y0, R.x1 - R.x0, R.y1 - R.y0);
      /* 雪の しもは 窓のふちに寄せる(まん中は 0.25 倍。暖かいガラスの まん中は くもりにくい) */
      if (snow) {
        const m = this._edgeMask(i);
        if (m) {
          c.globalAlpha = 1;
          c.globalCompositeOperation = 'destination-in';
          c.drawImage(m, R.x0, R.y0, R.x1 - R.x0, R.y1 - R.y0);
          c.globalCompositeOperation = 'source-over';
        }
      }
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
     * 白い帯1本(下に うすい かげ) + 雪のつぶの絵を 24こ ほど そとがわに(つぶを ならべると シャボン玉の列に見えた)。
     * 振りきったはしの山は 先のほう(0.62〜0.97)だけ(根元から引くと 画面のまん中を ななめに横切る) */
    if (snow && sill >= 0.05 && wl > 0 && this.spr && this._nR > 0) {
      const B = this._ridge || (this._ridge = makeRidge());
      const sc = this.scale, tA = Math.PI + rest + 0.02, tE = Math.PI + rest + WIPE_SWEEP + 0.03;
      const k = Math.min(1, sill), grow = 0.55 + 0.45 * k;
      const ce = Math.cos(tE + 0.02), se = Math.sin(tE + 0.02), e0 = RIDGE_E0, e1 = RIDGE_E1;
      c.save();
      c.beginPath(); this._rr(c, this._R[0]); c.clip();
      c.lineCap = 'round';
      const G = this._ridgeGrads(c, wpx, wpy, wl, tA, tE);
      for (let p = 0; p < 2; p++) {
        /* p=0: 少し下に灰色の かげ(白い景色の前でも形が見える) / p=1: 白の帯。
         * 扇形の そとのふち(弧)は 両はしが こく、まん中(線路の先が見えるところ)は うすい */
        const oy = p ? 0 : 2.2 * sc;
        c.globalAlpha = p ? Math.min(0.75, 0.8 * k) : 0.18 * k;
        c.lineWidth = (p ? 6 : 8) * sc * grow;
        c.strokeStyle = p ? G.w : G.s;
        c.beginPath();
        c.arc(wpx, wpy + oy, wl * 1.015, tA, tE);
        c.stroke();
        c.strokeStyle = p ? '#eef2f6' : '#7d8994';
        c.beginPath();
        c.moveTo(wpx + ce * wl * e0, wpy + se * wl * e0 + oy);
        c.lineTo(wpx + ce * wl * e1, wpy + se * wl * e1 + oy);
        c.stroke();
      }
      /* かたまり: 6こに1こ(約24こ)。帯の そとがわだけ。はしの山は 根元に近いほど うすく、弧は まん中ほど うすく */
      for (let i = 0; i < RIDGE_ARC + RIDGE_END; i += 6) {
        const t = B[i * 3], j = B[i * 3 + 1], r = B[i * 3 + 2] * sc * grow;
        let a, d, f;
        if (i < RIDGE_ARC) { a = tA + (tE - tA) * t; d = wl * (1.02 + j * 0.02); f = ridgeEnds(t); }
        else { a = tE + 0.03 + j * 0.025; d = wl * (e0 + (e1 - e0) * t); f = t < 0.25 ? (t / 0.25) * (t / 0.25) * (3 - 2 * (t / 0.25)) : 1; }
        c.globalAlpha = Math.min(0.75, 0.9 * k * f);
        if (c.globalAlpha < 0.02) continue;
        c.drawImage(this.spr, SPR * (1 + (((i / 6) | 0) % 3)), 0, SPR, SPR, wpx + Math.cos(a) * d - r, wpy + Math.sin(a) * d - r, r * 2, r * 2);
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
      if (d.snow && d.life <= 0 && !dry) { d.snow = false; d.r *= 0.6; d.life = 2; d.vx = 0; d.vy = 0; }
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
    /* 粒(雪のつぶは3つの形。雪の日の水滴は 雪がとけたもの: ふちの うすい絵) */
    const spr = this.spr, meltX = snowMode ? SPR * SPR_MELT : 0;
    for (let i = 0; i < this.n; i++) {
      const d = P[i];
      const s = d.r * 1.23;
      const fade = d.life < 0.5 ? Math.max(0, d.life * 2) : 1;
      if (fade < 1) c.globalAlpha = fade;
      c.drawImage(spr, d.snow ? SPR * (1 + d.v) : meltX, 0, SPR, SPR, d.x - s, d.y - s, s * 2, s * 2);
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
