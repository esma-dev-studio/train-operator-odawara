/* =========================================================
 * audio/synth.js — 効果音の波形合成(DOMを使わない純粋な計算)
 * audio.js(メインスレッドの予備)と synth-worker.js(別スレッド)の両方から使う。
 * 発車メロディ1曲で120〜145msかかるので、ふだんはワーカーで計算して
 * メインスレッド(描画・タップ)を止めない。
 * 戻り値はどれも { sr, ch: [Float32Array, ...] }
 * ========================================================= */

export const TAU = Math.PI * 2;
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const smooth01 = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
export const SR_LO = 22050;     // 大きいループ素材（踏切・雨・メロディ）はこのレートで持つ

/* ---------------------------------------------------------
 * 小道具: 決定的乱数・正弦テーブル・JS版バイクワッド
 * --------------------------------------------------------- */
export function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return ((s >>> 0) / 4294967296) * 2 - 1;      // −1..1
  };
}

const SIN_N = 4096;
const SIN_T = new Float32Array(SIN_N + 1);
for (let i = 0; i <= SIN_N; i++) SIN_T[i] = Math.sin((TAU * i) / SIN_N);
/* 位相(周) → sin。テーブル+線形補間 */
function sn(ph) {
  ph -= Math.floor(ph);
  const x = ph * SIN_N;
  const i = x | 0;
  return SIN_T[i] + (SIN_T[i + 1] - SIN_T[i]) * (x - i);
}

/* RBJ式バイクワッド（オフライン合成用） */
class Bq {
  constructor(type, f, q, sr, db = 0) {
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
    this.set(type, f, q, sr, db);
  }
  set(type, f, q, sr, db = 0) {
    const w = (TAU * Math.min(f, sr * 0.45)) / sr;
    const cs = Math.cos(w), al = Math.sin(w) / (2 * q), A = Math.pow(10, db / 40);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'lp') { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; }
    else if (type === 'hp') { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; }
    else if (type === 'bp') { b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; }
    else { b0 = 1 + al * A; b1 = -2 * cs; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cs; a2 = 1 - al / A; }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
  }
  run(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}


function normalize(chs, peak) {
  let m = 1e-9;
  for (const y of chs) for (let i = 0; i < y.length; i++) { const a = Math.abs(y[i]); if (a > m) m = a; }
  const k = peak / m;
  for (const y of chs) for (let i = 0; i < y.length; i++) y[i] *= k;
}

/* 終端を短くフェード（プチッ防止） */
function fadeEdges(y, sr, fin = 0.002, fout = 0.02) {
  const a = Math.max(1, Math.round(fin * sr)), b = Math.max(1, Math.round(fout * sr));
  for (let i = 0; i < a && i < y.length; i++) y[i] *= i / a;
  for (let i = 0; i < b && i < y.length; i++) y[y.length - 1 - i] *= i / b;
}

/* ---------------------------------------------------------
 * 効果音の波形合成（すべてオリジナル合成）
 * 戻り値: { sr, ch: [Float32Array, ...] }
 * --------------------------------------------------------- */

/* ホワイトノイズのループ素材 */
function renderNoise(sr, sec, chans, seed) {
  const len = Math.round(sr * sec);
  const ch = [];
  for (let c = 0; c < chans; c++) {
    const r = makeRng(seed + c * 7919);
    const y = new Float32Array(len);
    for (let i = 0; i < len; i++) y[i] = r();
    ch.push(y);
  }
  return { sr, ch };
}

/* レールジョイント「タン」: 低いドン+中域のコツ+立ち上がりのカチ+わずかなレールの鳴き */
function renderJoint(sr, seed) {
  const len = Math.round(sr * 0.3);
  const y = new Float32Array(len);
  const r = makeRng(seed * 977 + 13);
  const fT = 80 * (1 + 0.1 * r());
  const fK = 940 * (1 + 0.14 * r());
  const fR1 = 1680 * (1 + 0.05 * r()), fR2 = 2810 * (1 + 0.05 * r());
  const bpK = new Bq('bp', fK, 1.3, sr), bpK2 = new Bq('bp', fK * 2.3, 2.2, sr), hpC = new Bq('hp', 2600, 0.7, sr);
  let ph = 0;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const f = fT * (1 + 0.4 * Math.exp(-t / 0.012));
    ph += f / sr;
    const thump = Math.sin(TAU * ph) * Math.exp(-t / 0.034) * (1 - Math.exp(-t / 0.0008));
    const n = r();
    const knock = (bpK.run(n) + bpK2.run(n) * 0.5) * Math.exp(-t / 0.017) * 3.2;
    const click = hpC.run(n) * Math.exp(-t / 0.0035) * 0.6;
    const ring = (sn(fR1 * t) * 0.5 + sn(fR2 * t) * 0.3) * Math.exp(-t / 0.05) * 0.08;
    y[i] = thump * 0.8 + knock + click + ring;
  }
  fadeEdges(y, sr, 0.0003, 0.03);
  normalize([y], 0.9);
  return { sr, ch: [y] };
}

/* 空気の排気音「シュー」: 帯域ノイズ。中心周波数は圧力低下とともに下がる */
function renderHiss(sr, o) {
  const len = Math.round(sr * o.dur);
  const y = new Float32Array(len);
  const r = makeRng(o.seed || 5);
  const bp = new Bq('bp', o.f0, 0.6, sr), hp = new Bq('hp', 900, 0.7, sr), lp = new Bq('lp', 220, 0.7, sr);
  let flut = 0;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    if ((i & 63) === 0) bp.set('bp', o.f1 + (o.f0 - o.f1) * Math.exp(-t / o.sweep), 0.6, sr);
    const env = (1 - Math.exp(-t / o.att)) * (t < o.hold ? 1 : Math.exp(-(t - o.hold) / o.rel));
    flut += (r() - flut) * 0.002;                      // 乱流のゆらぎ
    const n = r();
    let s = bp.run(n) * 1.6 + hp.run(n) * 0.22;
    if (o.low) s += lp.run(n) * o.low;
    y[i] = s * env * (1 + flut * 6);
  }
  fadeEdges(y, sr, 0.001, 0.05);
  normalize([y], 0.8);
  return { sr, ch: [y] };
}

/* ドアの戸袋の走行音「スーー…トン」 */
function renderDoorSlide(sr) {
  const len = Math.round(sr * 1.55);
  const y = new Float32Array(len);
  const r = makeRng(77);
  const lp = new Bq('lp', 240, 0.8, sr), bp = new Bq('bp', 650, 1.4, sr), bpK = new Bq('bp', 520, 1.2, sr);
  let am = 0;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const env = smooth01(t / 0.18) * (t < 1.05 ? 1 : Math.exp(-(t - 1.05) / 0.06));
    am += (Math.abs(r()) - am) * 0.004;                // ガラガラとしたゆらぎ
    const n = r();
    let s = lp.run(n) * 3.0 * env + bp.run(n) * env * (0.5 + am) * 1.4;
    const td = t - 1.12;                               // 戸当たり「トン」
    if (td > 0) s += (Math.sin(TAU * 96 * td) * 0.9 + bpK.run(n) * 4) * Math.exp(-td / 0.045);
    y[i] = s;
  }
  fadeEdges(y, sr, 0.002, 0.05);
  normalize([y], 0.8);
  return { sr, ch: [y] };
}

/* 打撃音（ガタン等の素材）を y に加算 */
function addHit(y, sr, t0, fT, fK, amp, r) {
  const s0 = Math.round(t0 * sr), len = Math.min(y.length - s0, Math.round(sr * 0.3));
  const bp = new Bq('bp', fK, 1.4, sr);
  let ph = 0;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    ph += (fT * (1 + 0.5 * Math.exp(-t / 0.01))) / sr;
    const s = Math.sin(TAU * ph) * Math.exp(-t / 0.05) + bp.run(r()) * 3.5 * Math.exp(-t / 0.025);
    y[s0 + i] += s * amp * (1 - Math.exp(-t / 0.0007));
  }
}

/* ドアが閉まりきった「ガタン」 */
function renderDoorThud(sr) {
  const y = new Float32Array(Math.round(sr * 0.6));
  const r = makeRng(31);
  addHit(y, sr, 0, 72, 430, 1.0, r);
  addHit(y, sr, 0.078, 110, 1150, 0.7, r);
  addHit(y, sr, 0.16, 140, 1900, 0.15, r);
  fadeEdges(y, sr, 0.0005, 0.05);
  normalize([y], 0.85);
  return { sr, ch: [y] };
}

/* 電子チャイム系の音: notes = [[開始s, 周波数, 減衰τ, 音量, 明るさ]] */
function renderChime(sr, dur, notes) {
  const y = new Float32Array(Math.round(sr * dur));
  for (const [t0, f, tau, amp, br] of notes) {
    const s0 = Math.round(t0 * sr);
    const len = Math.min(y.length - s0, Math.round(sr * tau * 6));
    let e1 = 1, e2 = 1, e3 = 1;
    const k1 = Math.exp(-1 / (sr * tau)), k2 = Math.exp(-1 / (sr * tau * 0.45)), k3 = Math.exp(-1 / (sr * tau * 0.2));
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const att = 1 - Math.exp(-t / 0.004);
      const s = sn(f * t) * e1 + br * 0.3 * sn(2 * f * t) * e2 + br * 0.12 * sn(3.01 * f * t) * e3;
      y[s0 + i] += s * att * amp;
      e1 *= k1; e2 *= k2; e3 *= k3;
    }
  }
  fadeEdges(y, sr, 0.001, 0.05);
  normalize([y], 0.8);
  return { sr, ch: [y] };
}

/* 帯域制限した矩形波（奇数倍音の加算）のビープ: segs = [[開始, 長さ, 周波数]] */
function renderBeep(sr, dur, segs, fmax = 6000) {
  const y = new Float32Array(Math.round(sr * dur));
  for (const [t0, len0, f] of segs) {
    const s0 = Math.round(t0 * sr), len = Math.min(y.length - s0, Math.round(len0 * sr));
    const K = Math.max(1, Math.floor(fmax / f));
    const ramp = Math.round(sr * 0.006);
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      let s = 0;
      for (let k = 1; k <= K; k += 2) s += sn(k * f * t) / k;
      const env = Math.min(1, i / ramp, (len - i) / ramp);
      y[s0 + i] += s * env;
    }
  }
  normalize([y], 0.7);
  return { sr, ch: [y] };
}

/* 非常ブザー「ブー」: わずかにずらした2つの矩形波でうなりを作る */
function renderBuzzer(sr) {
  const dur = 1.15;
  const y = new Float32Array(Math.round(sr * dur));
  const lp = new Bq('lp', 2600, 0.7, sr);
  for (let i = 0; i < y.length; i++) {
    const t = i / sr;
    let s = 0;
    for (let k = 1; k <= 13; k += 2) s += (sn(k * 415 * t) + 0.8 * sn(k * 419.5 * t)) / k;
    const env = Math.min(1, t / 0.01) * (t > dur - 0.08 ? (dur - t) / 0.08 : 1);
    y[i] = lp.run(s) * env;
  }
  normalize([y], 0.7);
  return { sr, ch: [y] };
}

/* ATSのベル「ジリリリ」: 打撃子(約19回/秒)で鳴る非整数倍音のベル */
function renderAtsBell(sr) {
  const dur = 1.35;
  const y = new Float32Array(Math.round(sr * dur));
  const r = makeRng(404);
  const hp = new Bq('hp', 3000, 0.7, sr);
  const parts = [[1, 1], [1.48, 0.45], [2.72, 0.35], [3.96, 0.18]];
  const f0 = 1180;
  const kd = Math.exp(-1 / (sr * 0.038));
  let a = 0, clk = 0, next = 0;
  for (let i = 0; i < y.length; i++) {
    const t = i / sr;
    if (t >= next && t < 1.15) { a = Math.min(1.4, a + 0.9); clk = 1; next += 1 / 19; }
    a *= kd; clk *= 0.985;
    let s = 0;
    for (const [m, g] of parts) s += sn(f0 * m * t) * g;
    y[i] = s * a + hp.run(r()) * clk * 0.5;
  }
  fadeEdges(y, sr, 0.001, 0.08);
  normalize([y], 0.75);
  return { sr, ch: [y] };
}

/* 二音の空気笛: 倍音加算+フォルマント。立ち上がりで少しピッチが上がり、
 * 揺れ(ビブラート)と息の音を少しだけ足す。耳に痛い高域は抑える */
function renderHorn(sr) {
  const dur = 1.08, hold = 0.84;
  const y = new Float32Array(Math.round(sr * dur));
  const r = makeRng(2024);
  const formant = (F) => (0.35 + 1.0 * Math.exp(-(((F - 850) / 380) ** 2)) + 0.42 * Math.exp(-(((F - 2200) / 600) ** 2)))
    / (1 + (F / 3200) ** 4);
  const tones = [{ f: 370, a: 1.0 }, { f: 466, a: 0.85 }].map((tn) => {
    const K = Math.floor(6000 / tn.f);
    const amps = [];
    for (let k = 1; k <= K; k++) amps.push(Math.pow(k, -0.85) * formant(k * tn.f) * tn.a);
    return { ...tn, K, amps, ph: 0 };
  });
  const bp = new Bq('bp', 1600, 0.8, sr);
  for (let i = 0; i < y.length; i++) {
    const t = i / sr;
    const att = 1 - Math.exp(-t / 0.035);
    const rel = t > hold ? Math.exp(-(t - hold) / 0.06) : 1;
    const bend = (1 - 0.035 * Math.exp(-t / 0.045)) * (1 + 0.0025 * Math.sin(TAU * 5.3 * t))
      * (t > hold ? 1 - 0.015 * (1 - Math.exp(-(t - hold) / 0.08)) : 1);
    let s = 0;
    for (const tn of tones) {
      tn.ph += (tn.f * bend) / sr;
      for (let k = 1; k <= tn.K; k++) {
        const br = Math.min(1, t / (0.012 + 0.005 * k));   // 高い倍音ほど遅れて立ち上がる
        s += tn.amps[k - 1] * br * sn(k * tn.ph);
      }
    }
    y[i] = (s + bp.run(r()) * 0.15) * att * rel;
  }
  fadeEdges(y, sr, 0.001, 0.03);
  normalize([y], 0.85);
  return { sr, ch: [y] };
}

/* 風圧「ボッ」（すれ違い・トンネル突入） */
function renderPressure(sr) {
  const y = new Float32Array(Math.round(sr * 0.8));
  const r = makeRng(9);
  const lp1 = new Bq('lp', 140, 0.7, sr), lp2 = new Bq('lp', 140, 0.7, sr), bp = new Bq('bp', 450, 0.8, sr);
  for (let i = 0; i < y.length; i++) {
    const t = i / sr;
    const env = (1 - Math.exp(-t / 0.035)) * Math.exp(-t / 0.16);
    const n = r();
    y[i] = (lp2.run(lp1.run(n)) * 6 + bp.run(n) * 0.8) * env;
  }
  fadeEdges(y, sr, 0.002, 0.05);
  normalize([y], 0.9);
  return { sr, ch: [y] };
}

/* 踏切の警報音「カンカン」: 2台の警報機(少し違う音程・違う間隔)が交互に鳴る。
 * 8.7秒でちょうど一周するループ（20回と21回）なので継ぎ目がない */
function renderCrossing(sr) {
  const L = 8.7, len = Math.round(sr * L);
  const y = new Float32Array(len);
  const r = makeRng(1234);
  const parts = [[1, 1, 0.2], [1.594, 0.5, 0.11], [2.136, 0.32, 0.08], [2.83, 0.2, 0.05], [3.92, 0.1, 0.035]];
  const bells = [{ f: 728, n: 20, off: 0 }, { f: 662, n: 21, off: 0.19 }];
  for (const b of bells) {
    for (let k = 0; k < b.n; k++) {
      const s0 = Math.round((b.off + (k * L) / b.n) * sr);
      const n = Math.round(sr * 0.42);
      const es = parts.map(() => 1);
      const ks = parts.map((p) => Math.exp(-1 / (sr * p[2])));
      let clk = 1;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        let s = 0;
        for (let p = 0; p < parts.length; p++) { s += sn(b.f * parts[p][0] * t) * parts[p][1] * es[p]; es[p] *= ks[p]; }
        s += r() * clk * 0.25; clk *= 0.93;
        y[(s0 + i) % len] += s * (1 - Math.exp(-t / 0.0015));
      }
    }
  }
  normalize([y], 0.8);
  return { sr, ch: [y] };
}

/* フロントガラスに当たる雨: ざーっという地のノイズ＋無数の小さな水滴 */
function renderRain(sr) {
  const len = Math.round(sr * 3);
  const ch = [];
  for (let c = 0; c < 2; c++) {
    const y = new Float32Array(len);
    const r = makeRng(555 + c * 99);
    const bp = new Bq('bp', 3600, 0.45, sr);
    for (let i = 0; i < len; i++) y[i] = bp.run(r()) * 0.22;
    const drop = (fq, tau, amp) => {
      const s0 = Math.floor((r() * 0.5 + 0.5) * len), n = Math.round(tau * 6 * sr);
      const k = Math.exp(-1 / (sr * tau));
      let e = amp;
      for (let i = 0; i < n; i++) { y[(s0 + i) % len] += sn((fq * i) / sr) * e; e *= k; }
    };
    for (let k = 0; k < 3 * 420; k++) {
      const u = r() * 0.5 + 0.5;
      drop(1600 + 4300 * (r() * 0.5 + 0.5), 0.0015 + 0.004 * u, 0.04 + 0.4 * u * u * u);
    }
    for (let k = 0; k < 3 * 35; k++) {
      const u = r() * 0.5 + 0.5;
      drop(500 + 900 * u, 0.006 + 0.006 * u, 0.25 + 0.35 * u);
    }
    ch.push(y);
  }
  normalize(ch, 0.9);
  return { sr, ch };
}

/* トンネルの残響インパルス応答（ステレオ）: 壁の往復によるフラッターエコー＋
 * 低域が長く残る拡散残響（時間とともに暗くなる＝こもった響き） */
function renderTunnelIR(sr) {
  const len = Math.round(sr * 1.3);
  const ch = [];
  for (let c = 0; c < 2; c++) {
    const y = new Float32Array(len);
    const r = makeRng(101 + c * 31);
    let t = 0.004 + c * 0.0017, a = 0.7, sg = 1;
    while (t < 0.25) {
      const i = Math.round(t * sr);
      if (i < len) y[i] += a * sg;
      t += 0.0125 + 0.004 * Math.abs(r()); a *= 0.83; sg = -sg;
    }
    let lp = 0;
    for (let i = Math.round(0.006 * sr); i < len; i++) {
      const tt = i / sr;
      const k = 0.55 * Math.exp(-tt / 0.08) + 0.04;          // 1次ローパス係数（だんだん暗く）
      lp += (r() - lp) * k;
      y[i] += lp * Math.sqrt((2 - k) / k) * Math.exp(-tt / 0.28) * 0.35;
    }
    fadeEdges(y, sr, 0, 0.1);
    ch.push(y);
  }
  /* エネルギーを1に正規化（ウェット量を予測しやすく） */
  let e = 0;
  for (const y of ch) for (let i = 0; i < y.length; i++) e += y[i] * y[i];
  const k = 1 / Math.sqrt(e / ch.length);
  for (const y of ch) for (let i = 0; i < y.length; i++) y[i] *= k;
  return { sr, ch };
}

/* ---------------------------------------------------------
 * 発車メロディ（オリジナル作曲・メジャーペンタトニック）
 * notes: "音名 長さ(8分音符)" の並び。R=休符。chords: 4拍(8分×4)ごとの和音
 * --------------------------------------------------------- */
export const MELODIES = [
  { key: 62, notes: 'A4 1 D5 1 F#5 1 A5 1 B5 2 A5 2 F#5 1 A5 1 B5 1 D6 1 B5 1 A5 1 F#5 2 E5 1 F#5 1 A5 1 E5 1 D5 4', chords: 'I I IV vi V I' },
  { key: 65, notes: 'C5 1 F5 1 A5 1 G5 1 F5 1 D5 1 C5 2 D5 1 F5 1 G5 1 A5 1 C6 1 D6 1 C6 2 A5 1 G5 1 F5 1 G5 1 F5 4', chords: 'I vi IV V V I' },
  { key: 67, notes: 'G5 1 B5 1 D6 1 E6 1 D6 1 B5 1 A5 2 B5 1 D6 1 E6 1 G6 1 E6 1 D6 1 B5 2 A5 1 B5 1 D6 1 A5 1 G5 4', chords: 'I V vi IV V I' },
  { key: 63, notes: 'Bb4 2 Eb5 2 G5 2 F5 1 Eb5 1 C5 2 Eb5 1 F5 1 G5 2 Bb5 2 G5 1 F5 1 Eb5 1 F5 1 Eb5 4', chords: 'I I vi IV V I' },
  { key: 69, notes: 'E5 1 A5 1 E5 1 A5 1 B5 1 C#6 1 B5 2 F#5 1 B5 1 F#5 1 B5 1 C#6 1 E6 1 C#6 2 B5 1 A5 1 F#5 1 B5 1 A5 4', chords: 'I I ii V V I' },
  { key: 60, notes: 'G5 1 E5 1 G5 1 A5 1 R 1 G5 1 E5 1 D5 1 C5 1 D5 1 E5 1 G5 1 E5 2 D5 2 E5 1 G5 1 A5 1 D6 1 C6 4', chords: 'I vi IV V V I' },
  { key: 70, notes: 'F6 1 D6 1 C6 1 Bb5 1 G5 1 F5 1 G5 1 Bb5 1 C6 1 Bb5 1 G5 1 F5 1 D5 1 F5 1 G5 2 Bb5 1 C6 1 D6 1 F6 1 Bb5 4', chords: 'I vi IV ii V I' },
  { key: 64, notes: 'B4 1 E5 1 F#5 1 G#5 1 B5 2 G#5 2 C#6 1 B5 1 G#5 1 F#5 1 E5 2 F#5 2 G#5 1 B5 1 C#6 1 B5 1 E6 4', chords: 'I I vi V V I' },
];
const CHORD = { I: [0, 4, 7], ii: [2, 5, 9], iii: [4, 7, 11], IV: [5, 9, 12], V: [7, 11, 14], vi: [9, 12, 16] };
const NOTE_BASE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function noteMidi(s) {
  const m = /^([A-G])(#|b)?(\d)$/.exec(s);
  if (!m) return null;
  return 12 * (Number(m[3]) + 1) + NOTE_BASE[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
}
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

/* FM音源の1音を y に加算。kind: 'cel'(チェレスタ風) / 'ep'(エレピ風) / 'bass' */
function addVoice(y, sr, t0, f, tau, amp, kind) {
  const s0 = Math.round(t0 * sr);
  if (s0 >= y.length) return;
  const len = Math.min(y.length - s0, Math.round(sr * Math.min(tau * 5, 2.6)));
  const kA = Math.exp(-1 / (sr * tau));
  let eA = 1;
  if (kind === 'cel') {
    let eI = 1, eT = 1, e2 = 1;
    const kI = Math.exp(-1 / (sr * 0.08)), kT = Math.exp(-1 / (sr * 0.05)), k2 = Math.exp(-1 / (sr * 0.3));
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const I = 1.4 * eI + 0.35;
      const s = sn(f * t + (I * sn(f * t)) / TAU) + 0.22 * sn(3.98 * f * t) * eT + 0.12 * sn(2 * f * t) * e2;
      y[s0 + i] += s * eA * amp * (1 - Math.exp(-t / 0.0015));
      eA *= kA; eI *= kI; eT *= kT; e2 *= k2;
    }
  } else if (kind === 'ep') {
    let eI = 1;
    const kI = Math.exp(-1 / (sr * 0.3));
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const s = sn(f * t + ((1.0 * eI + 0.1) * sn(f * t)) / TAU);
      y[s0 + i] += s * eA * amp * (1 - Math.exp(-t / 0.003));
      eA *= kA; eI *= kI;
    }
  } else {
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const s = sn(f * t) + 0.3 * sn(2 * f * t) + 0.1 * sn(3 * f * t);
      y[s0 + i] += s * eA * amp * (1 - Math.exp(-t / 0.004));
      eA *= kA;
    }
  }
}

function renderMelody(idx, sr) {
  const def = MELODIES[((idx % MELODIES.length) + MELODIES.length) % MELODIES.length];
  const e8 = 0.17;                         // 8分音符の長さ s（4.5秒前後に収まる）
  const dur = 4.6;
  const y = new Float32Array(Math.round(sr * dur));
  const tok = def.notes.split(/\s+/);
  const seq = [];
  let pos = 0;
  for (let i = 0; i + 1 < tok.length; i += 2) {
    const len = Number(tok[i + 1]);
    if (tok[i] !== 'R') seq.push({ m: noteMidi(tok[i]), at: pos, len });
    pos += len;
  }
  seq.forEach((n, i) => {
    const last = i === seq.length - 1;
    const tau = last ? 1.15 : Math.min(0.55, 0.28 + n.len * 0.1);
    const f = mtof(n.m);
    addVoice(y, sr, n.at * e8, f, tau, 0.3, 'cel');
    addVoice(y, sr, n.at * e8 + 0.004, f * 2, last ? 0.5 : 0.22, 0.05, 'ep');   // 1オクターブ上のきらめき
  });
  /* 伴奏: 4拍ごとに和音（エレピ）＋裏で軽く刻む＋ベース */
  def.chords.split(/\s+/).forEach((c, k) => {
    const deg = CHORD[c] || CHORD.I;
    const t = k * 4 * e8;
    const last = k === 5;
    deg.forEach((d) => {
      let m = def.key + d;
      while (m > 69) m -= 12;
      while (m < 55) m += 12;
      addVoice(y, sr, t, mtof(m), last ? 1.0 : 0.55, 0.1, 'ep');
      if (!last) addVoice(y, sr, t + 2 * e8, mtof(m), 0.3, 0.05, 'ep');
    });
    let b = def.key + deg[0];
    while (b > 52) b -= 12;
    while (b < 40) b += 12;
    addVoice(y, sr, t, mtof(b), last ? 0.9 : 0.5, 0.24, 'bass');
  });
  /* ホームのスピーカーらしい帯域＋ほんの少しの歪み */
  const hp1 = new Bq('hp', 260, 0.7, sr), hp2 = new Bq('hp', 260, 0.7, sr), lp = new Bq('lp', 5200, 0.7, sr);
  normalize([y], 1);
  for (let i = 0; i < y.length; i++) y[i] = Math.tanh(1.3 * lp.run(hp2.run(hp1.run(y[i]))));
  const fo = Math.round(sr * 0.35);
  for (let i = 0; i < fo; i++) y[y.length - 1 - i] *= i / fo;
  normalize([y], 0.85);
  return { sr, ch: [y] };
}

/* 名前 → 合成関数 */
export const RENDER = {
  noise: (sr) => renderNoise(sr, 2.0, 2, 11),
  noiseM: (sr) => renderNoise(sr, 1.7, 1, 23),
  joint0: (sr) => renderJoint(sr, 1),
  joint1: (sr) => renderJoint(sr, 2),
  joint2: (sr) => renderJoint(sr, 3),
  hissShort: (sr) => renderHiss(sr, { dur: 0.5, f0: 3600, f1: 2600, sweep: 0.2, att: 0.008, hold: 0.08, rel: 0.12, seed: 3 }),
  hissLong: (sr) => renderHiss(sr, { dur: 1.5, f0: 3800, f1: 2100, sweep: 0.5, att: 0.012, hold: 0.25, rel: 0.38, seed: 4 }),
  ebHiss: (sr) => renderHiss(sr, { dur: 2.3, f0: 3000, f1: 1700, sweep: 0.8, att: 0.01, hold: 0.6, rel: 0.55, low: 1.2, seed: 6 }),
  doorSlide: () => renderDoorSlide(SR_LO),
  doorThud: (sr) => renderDoorThud(sr),
  /* ドアチャイム: 「ピンポーン」を1秒おきに3回 */
  doorChime: (sr) => renderChime(sr, 3.3, [0, 1, 2].flatMap((k) => [
    [k * 1.0, 988, 0.28, 0.9, 0.8], [k * 1.0 + 0.22, 784, 0.62, 1.0, 0.7]])),
  /* ATS接近: 明るい「ピンポン」 */
  atsChime: (sr) => renderChime(sr, 1.0, [[0, 1568, 0.2, 0.9, 1.2], [0.13, 1318, 0.32, 1.0, 1.0]]),
  atsBell: (sr) => renderAtsBell(sr),
  /* 停車の判定チャイム(機器の報知音ふう): ぴったり=3音のぼり / よい=2音 / いまいち=低い2音 */
  stopPerfect: (sr) => renderChime(sr, 1.6, [[0, 1318.5, 0.32, 0.85, 0.7], [0.11, 1661, 0.34, 0.9, 0.7], [0.22, 1975.5, 0.62, 1.0, 0.6]]),
  stopGood: (sr) => renderChime(sr, 1.3, [[0, 1318.5, 0.3, 0.9, 0.7], [0.13, 1760, 0.55, 1.0, 0.6]]),
  stopNg: (sr) => renderBeep(sr, 0.8, [[0, 0.2, 587], [0.27, 0.38, 440]], 3200),
  /* 金(±10cm以内): 4音のぼり C6-E6-G6-C7。最後のCを長くのばす(ぴったりより1音多く、高く) */
  stopGold: (sr) => renderChime(sr, 1.8, [[0, 1046.5, 0.3, 0.78, 0.7], [0.1, 1318.5, 0.3, 0.84, 0.7],
    [0.2, 1568, 0.32, 0.9, 0.65], [0.32, 2093, 0.72, 1.0, 0.55], [0.32, 1568, 0.5, 0.32, 0.4]]),
  /* 終点ゴール: 5音ののぼり分散和音 G5-C6-E6-G6-C7 と、最後に和音(ド・ソ)をひびかせる */
  goal: (sr) => renderChime(sr, 2.4, [[0, 784, 0.26, 0.72, 0.6], [0.14, 1046.5, 0.26, 0.78, 0.6],
    [0.28, 1318.5, 0.28, 0.84, 0.6], [0.42, 1568, 0.3, 0.9, 0.55], [0.6, 2093, 0.95, 1.0, 0.5],
    [0.6, 1568, 0.85, 0.5, 0.4], [0.6, 1046.5, 0.85, 0.34, 0.35]]),
  /* 「いま！ブレーキ」の合図: 0.18秒の短い2音(シ→ミ のぼり)。ATSの「ピンポン」(下がる・1秒)・ベルとは別の音 */
  coachPing: (sr) => renderChime(sr, 0.18, [[0, 988, 0.045, 0.85, 0.25], [0.075, 1319, 0.06, 1.0, 0.25]]),
  /* 過走: 「ピピピッ」×2 */
  beep: (sr) => renderBeep(sr, 0.95, [0, 0.15, 0.3, 0.5, 0.65, 0.8].map((t) => [t, 0.09, 2093])),
  beepLow: (sr) => renderBeep(sr, 1.0, [[0, 0.32, 880], [0.45, 0.45, 698]]),
  buzzer: (sr) => renderBuzzer(sr),
  horn: (sr) => renderHorn(sr),
  pressure: () => renderPressure(SR_LO),
  cross: () => renderCrossing(SR_LO),
  rain: () => renderRain(SR_LO),
  ir: (sr) => renderTunnelIR(sr),
  /* 主幹制御器(レバー)のノッチの手ごたえ「カチャ」: 1段ごとに鳴らす */
  notch: (sr) => {
    const y = new Float32Array(Math.round(sr * 0.12));
    const r = makeRng(41);
    addHit(y, sr, 0, 240, 3000, 0.6, r);
    addHit(y, sr, 0.009, 380, 5200, 0.22, r);
    fadeEdges(y, sr, 0.0003, 0.03);
    normalize([y], 0.7);
    return { sr, ch: [y] };
  },
  /* 非常(EB)の位置に入れたときの重い「ガチャン」 */
  notchEB: (sr) => {
    const y = new Float32Array(Math.round(sr * 0.3));
    const r = makeRng(43);
    addHit(y, sr, 0, 120, 1400, 1.0, r);
    addHit(y, sr, 0.035, 90, 900, 0.6, r);
    fadeEdges(y, sr, 0.0003, 0.05);
    normalize([y], 0.75);
    return { sr, ch: [y] };
  },
  /* 点数のカウントアップ「ピッ」(短く小さい) */
  tick: (sr) => renderBeep(sr, 0.05, [[0, 0.028, 1568]]),
  /* スタンプを押す「ポン」(ゴム印を紙に押す、低くやわらかい音) */
  stampPress: (sr) => {
    const y = new Float32Array(Math.round(sr * 0.35));
    const r = makeRng(53);
    addHit(y, sr, 0, 58, 700, 1.0, r);
    addHit(y, sr, 0.018, 90, 2600, 0.35, r);
    fadeEdges(y, sr, 0.0005, 0.05);
    normalize([y], 0.85);
    return { sr, ch: [y] };
  },
};
for (let i = 0; i < MELODIES.length; i++) RENDER['mel' + i] = () => renderMelody(i, SR_LO);
