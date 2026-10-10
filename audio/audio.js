/* =========================================================
 * audio/audio.js — WebAudio 合成音エンジン（外部ファイルなし・すべて合成）
 *
 *  ・VVVFインバーター音: AudioWorklet(vvvf-worklet.js)で三相PWMを実計算。
 *    非対応/読込前は発振器による近似へ自動で切り替える
 *  ・走行音(低いゴー/中域のロードノイズ/高域)・25mレールのジョイント音(タタン)
 *  ・空気ブレーキ(込め/緩め/停車後のプシュー)・ドア(エア/戸袋/チャイム/ガタン)
 *  ・運転台(送風/補助電源のうなり/コンプレッサー)・ATS・警笛・発車メロディ
 *  ・環境(env): トンネル残響・曲線のきしみ・踏切・すれ違い列車・雨
 *
 * 一発ものの効果音は最初に一度だけ JS で波形を計算して AudioBuffer に
 * キャッシュし、鳴らすたびに「BufferSource+Gain」の2ノードだけを作る。
 * 毎フレームはパラメータを動かすだけでノードは作らない（iPad対策）。
 * 波形計算は起動後に少しずつ（1回8ms以内）先回りで済ませる。
 * ========================================================= */

const TAU = Math.PI * 2;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smooth01 = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
const SR_LO = 22050;     // 大きいループ素材（踏切・雨・メロディ）はこのレートで持つ
const MIX_TRIM = 0.22;   // 全体の基準レベル（旧エンジンと同程度の音量になるよう実測で合わせた）

/* 車軸位置（先頭からの距離 m）と音量: 1両目の前台車・後台車＋2両目の前台車 */
const AXLES = [
  { off: 1.6, g: 1.0 }, { off: 3.7, g: 0.84 },
  { off: 15.6, g: 0.5 }, { off: 17.7, g: 0.44 },
  { off: 21.6, g: 0.2 }, { off: 23.7, g: 0.17 },
];
const RAIL = 25;          // 定尺レール長 m

/* ---------------------------------------------------------
 * 小道具: 決定的乱数・正弦テーブル・JS版バイクワッド
 * --------------------------------------------------------- */
function makeRng(seed) {
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

/* フィルタ/発振器の周波数などはブロック単位(k-rate)で十分。毎フレーム動かしても
 * サンプル毎の係数再計算が起きないので軽い（未対応ブラウザでは何もしない） */
function kRate(...params) {
  for (const p of params) {
    try { if (p && 'automationRate' in p) p.automationRate = 'k-rate'; } catch (e) { /* 無視 */ }
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
const MELODIES = [
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
const RENDER = {
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
  /* 過走: 「ピピピッ」×2 */
  beep: (sr) => renderBeep(sr, 0.95, [0, 0.15, 0.3, 0.5, 0.65, 0.8].map((t) => [t, 0.09, 2093])),
  beepLow: (sr) => renderBeep(sr, 1.0, [[0, 0.32, 880], [0.45, 0.45, 698]]),
  buzzer: (sr) => renderBuzzer(sr),
  horn: (sr) => renderHorn(sr),
  pressure: () => renderPressure(SR_LO),
  cross: () => renderCrossing(SR_LO),
  rain: () => renderRain(SR_LO),
  ir: (sr) => renderTunnelIR(sr),
};
for (let i = 0; i < MELODIES.length; i++) RENDER['mel' + i] = () => renderMelody(i, SR_LO);

/* ---------------------------------------------------------
 * VVVFパターン（架空の最新IGBT車）
 *   0–6 km/h   非同期 fc≈520Hz
 *   6–38       非同期 fc 520→1250Hz（上昇していく定番の音）
 *   38–50      同期9パルス (fc=9·fm)
 *   50–60      同期3パルス（過変調へ）
 *   60–        1パルス
 * v[km/h], slip[Hz](力行+/回生−), prevMode: 前回のmode（境界のチャタリング防止）
 * --------------------------------------------------------- */
const VV_EDGES = [6, 38, 50, 60];
const VV_NAMES = ['非同期 520Hz', '非同期 上昇', '同期9パルス', '同期3パルス', '1パルス'];
export function vvvfPattern(v, slip = 0, prevMode = null) {
  v = Math.max(0, +v || 0);
  let m = 0;
  while (m < VV_EDGES.length && v >= VV_EDGES[m]) m++;
  if (prevMode != null) {
    const H = 0.8;
    if (m === prevMode + 1 && v < VV_EDGES[prevMode] + H) m = prevMode;
    else if (m === prevMode - 1 && v > VV_EDGES[m] - H) m = prevMode;
  }
  const fm = Math.max(0.3, 1.45 * v + slip);
  let fc, pulses, mi;
  if (m <= 1) {
    const u = clamp((v - 6) / 32, 0, 1);
    fc = 520 + 730 * Math.pow(u, 1.1);
    pulses = 0;
    mi = clamp(fm / 88, 0.06, 1);
  } else if (m === 2) {
    pulses = 9; fc = 9 * fm; mi = clamp(fm / 88, 0.06, 1);
  } else if (m === 3) {
    pulses = 3; fc = 3 * fm; mi = clamp(0.82 + (v - 50) * 0.035, 0.8, 1.2);
  } else {
    pulses = 1; fc = fm; mi = 1.27;
  }
  return { fm, fc, pulses, mi, mode: m, name: VV_NAMES[m] };
}

/* =========================================================
 * CabAudio 本体
 * ========================================================= */
export class CabAudio {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.volume = 0.8;
    this.muted = false;
    this.paused = false;
    this.ready = Promise.resolve(false);   // ワークレット読込の完了（テスト用）
    this.info = { worklet: 'none', mode: '', fm: 0, fc: 0, gate: 0, voices: 0 };
    this._bufs = {};
    this._sim = null;
    this._bound = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
    this._voices = 0;
    this._running = false;
    this._ext = false;
    this._tun = false;
    this._tunMix = 0;
    this._rw = 0;
    this._resetRun(null);
  }

  /* ---------------- 起動（ユーザー操作から呼ぶ・何度呼んでもよい） ---------------- */
  ensure() {
    try {
      if (this.ctx) { this._resume(); return; }
      const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
      if (!AC) return;
      let ctx;
      try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { ctx = new AC(); }
      try { this._init(ctx); } catch (e) {
        try { ctx.close(); } catch (e2) { /* 無視 */ }
        throw e;
      }
      this._resume();
      /* iOS: 無音を1つ鳴らして出力を確実に解放 */
      try {
        const s = ctx.createBufferSource();
        s.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
        s.connect(ctx.destination); s.start(0);
      } catch (e) { /* 無視 */ }
    } catch (e) {
      this.ctx = null;
    }
  }

  /* テスト用: 外部の(Offline)AudioContextを使う */
  _useContext(ctx) {
    if (this.ctx) return this.ready;
    try { this._init(ctx); } catch (e) { this.ctx = null; }
    return this.ready;
  }

  _resume() {
    const c = this.ctx;
    if (!c || typeof c.resume !== 'function') return;
    if (c.state === 'suspended' || c.state === 'interrupted') {
      try { const p = c.resume(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* 無視 */ }
    }
  }

  _gain(v, to) {
    const g = this.ctx.createGain();
    g.gain.value = v;
    if (to) g.connect(to);
    return g;
  }

  _filter(type, f, q, to, gainDb) {
    const b = this.ctx.createBiquadFilter();
    kRate(b.frequency, b.Q, b.gain, b.detune);
    b.type = type; b.frequency.value = f; b.Q.value = q;
    if (gainDb != null) b.gain.value = gainDb;
    if (to) b.connect(to);
    return b;
  }

  _osc(type, f, to) {
    const o = this.ctx.createOscillator();
    kRate(o.frequency, o.detune);
    o.type = type; o.frequency.value = f;
    if (to) o.connect(to);
    o.start(0);
    return o;
  }

  _panner(p, to) {
    let n;
    if (this.ctx.createStereoPanner) { n = this.ctx.createStereoPanner(); n.pan.value = p; }
    else n = this.ctx.createGain();       // 古いSafari: 定位なし
    if (to) n.connect(to);
    return n;
  }

  _loop(name, offset = 0, to) {
    const s = this.ctx.createBufferSource();
    s.buffer = this._buf(name);
    s.loop = true;
    if (to) s.connect(to);
    s.start(this.ctx.currentTime, offset % s.buffer.duration);
    return s;
  }

  /* 目標値へなめらかに（ほぼ同じ値なら呼び出しを省く） */
  _set(param, v, tau = 0.05) {
    if (!param || !Number.isFinite(v)) return;
    if (param._tv !== undefined && Math.abs(param._tv - v) <= 1e-5 + Math.abs(v) * 0.004) return;
    param._tv = v;
    try { param.setTargetAtTime(v, this.ctx.currentTime, tau); } catch (e) { param.value = v; }
  }

  /* 素材バッファ（初回のみ合成してキャッシュ） */
  _buf(name) {
    let b = this._bufs[name];
    if (b) return b;
    const fn = RENDER[name];
    if (!fn) return null;
    const r = fn(this.ctx.sampleRate);
    b = this.ctx.createBuffer(r.ch.length, r.ch[0].length, r.sr);
    r.ch.forEach((d, i) => b.getChannelData(i).set(d));
    this._bufs[name] = b;
    return b;
  }

  /* 一発ものを鳴らす（BufferSource+Gainの2ノード。終わったら切り離す） */
  _play(name, bus, gain = 1, opt = {}) {
    const ctx = this.ctx;
    if (!ctx || !bus || this._voices > 64) return null;
    const buf = this._buf(name);
    if (!buf) return null;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    if (opt.rate) src.playbackRate.value = opt.rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g); g.connect(bus);
    const at = opt.at != null ? Math.max(opt.at, ctx.currentTime) : ctx.currentTime + (opt.delay || 0);
    this._voices++;
    src.onended = () => {
      this._voices--;
      try { src.disconnect(); g.disconnect(); } catch (e) { /* 無視 */ }
    };
    src.start(at);
    return { src, g };
  }

  /* ---------------- 音の配線 ---------------- */
  _init(ctx) {
    this.ctx = ctx;
    /* マスター: 合流 → 一時停止ダッキング → 基準レベル → コンプレッサー → 音量 */
    this.master = this._gain(this.muted ? 0 : this.volume, ctx.destination);
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -20; this.comp.knee.value = 8; this.comp.ratio.value = 4;
    this.comp.attack.value = 0.003; this.comp.release.value = 0.2;
    this.comp.connect(this.master);
    this.trim = this._gain(MIX_TRIM, this.comp);
    this.pauseBus = this._gain(this.paused ? 0 : 1, this.trim);

    /* 3系統: 車内(cab) / 床下・車外(ext) / どちらでも同じに聞こえる合図(ui) */
    this.uiBus = this._gain(1, this.pauseBus);
    this.cabIn = this._gain(1, this.pauseBus);
    this.extOut = this._gain(1, this.pauseBus);
    this.extLP = this._filter('lowpass', 5200, 0.5, this.extOut);       // 車内では床・壁ごしにこもる
    this.extTone = this._filter('lowshelf', 220, 0.7, this.extLP, 0);   // トンネルで低域がふくらむ
    this.extIn = this._gain(1, this.extTone);
    /* 連続音はここを通す（stop()でまとめてフェード） */
    this.extRun = this._gain(0, this.extIn);
    this.cabRun = this._gain(0, this.cabIn);
    this.neuRun = this._gain(0, this.uiBus);
    /* トンネル残響の送り（畳み込みは使うときだけ接続） */
    this.tunnelSend = this._gain(0);
    this.extOut.connect(this.tunnelSend);
    /* 警笛: 屋根上なので車内では少しこもる */
    this.hornLP = this._filter('lowpass', 3800, 0.6, this.pauseBus);
    this.hornBus = this._gain(1, this.hornLP);
    this.hornBus.connect(this.tunnelSend);

    /* ノイズ源（ループ）: ステレオ1本+モノラル1本を使い回す */
    this.nSt = this._loop('noise', 0);
    this.nMo = this._loop('noiseM', 0);

    this._buildVVVF();
    this._buildRolling();
    this._buildBrake();
    this._buildCab();
    this.jointLP = this._filter('lowpass', 3000, 0.5, this.extIn);

    this.ready = this._loadWorklet();
    this._warm();
  }

  _buildVVVF() {
    /* 整形: 低域(基本波)を落とし、1–2.5kHzを持ち上げ、5kHz以上を丸める */
    this.vGate = this._gain(0, this.extRun);
    this.vLP = this._filter('lowpass', 5000, 0.6, this.vGate);
    this.vPk = this._filter('peaking', 1700, 0.8, this.vLP, 5);
    this.vPk2 = this._filter('peaking', 950, 1.2, this.vPk, 2.5);
    this.vHP = this._filter('highpass', 170, 0.7, this.vPk2);
    this.vIn = this._gain(1, this.vHP);
    this._makeFallback();
    /* 主電動機のうなり（2·fm と 6·fm） */
    this.humGate = this._gain(0, this.extRun);
    this.humA = this._osc('sine', 20, this._gain(0.6, this.humGate));
    this.humB = this._osc('triangle', 60, this._gain(0.22, this.humGate));
    /* 歯車のうなり（速度比例） */
    this.gearG = this._gain(0, this.extRun);
    this.gear = this._osc('triangle', 20, this.gearG);
  }

  /* ワークレットが無い/読込前の近似: キャリア付近の2音（のこぎり+矩形） */
  _makeFallback() {
    if (this.fb) return;
    const mix = this._gain(1, this.vIn);
    const ga = this._gain(0.5, mix), gb = this._gain(0.18, mix);
    const a = this._osc('sawtooth', 520, ga);
    const b = this._osc('square', 540, gb);
    this.fb = { mix, a, b, srcs: [a, b], nodes: [ga, gb, mix] };
  }

  _killFallback() {
    const fb = this.fb;
    if (!fb) return;
    this.fb = null;
    const t = this.ctx.currentTime;
    try { fb.mix.gain.setTargetAtTime(0, t, 0.03); } catch (e) { /* 無視 */ }
    this._dropChain(fb, t + 0.3);
  }

  async _loadWorklet() {
    const ctx = this.ctx;
    if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') {
      this.info.worklet = 'fallback';
      return false;
    }
    this.info.worklet = 'loading';
    try {
      await ctx.audioWorklet.addModule(new URL('./vvvf-worklet.js', import.meta.url).href);
      if (this.ctx !== ctx) return false;
      const node = new AudioWorkletNode(ctx, 'vvvf-pwm', {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1],
      });
      const P = (n) => node.parameters.get(n);
      this.wk = node;
      this.wkP = { fm: P('fm'), fc: P('fc'), pulses: P('pulses'), mi: P('mi'), active: P('active') };
      node.onprocessorerror = () => {
        /* 処理中に落ちたら発振器版へ戻す */
        try { node.disconnect(); } catch (e) { /* 無視 */ }
        if (this.wk === node) { this.wk = null; this.wkP = null; this._makeFallback(); this.info.worklet = 'fallback'; }
      };
      node.connect(this.vIn);
      this._killFallback();
      this.info.worklet = 'ready';
      return true;
    } catch (e) {
      this.info.worklet = 'fallback';
      return false;
    }
  }

  _buildRolling() {
    const src = this.nSt;
    /* 低いゴー（2段ローパス） */
    this.rRumG = this._gain(0, this.extRun);
    this.rLP2 = this._filter('lowpass', 120, 0.6, this.rRumG);
    this.rLP1 = this._filter('lowpass', 120, 0.6, this.rLP2);
    src.connect(this.rLP1);
    /* 中域のロードノイズ（車輪1回転ごとのわずかなうなりを乗せる） */
    this.rRoadG = this._gain(0, this.extRun);
    this.rAM = this._gain(1, this.rRoadG);
    this.rBP = this._filter('bandpass', 600, 0.8, this.rAM);
    src.connect(this.rBP);
    this.rWheelD = this._gain(0, this.rAM.gain);
    this.rWheel = this._osc('sine', 1, this.rWheelD);
    /* 高域（風切り・車輪の高い成分） */
    this.rHissG = this._gain(0, this.extRun);
    this.rHP = this._filter('highpass', 2600, 0.6, this.rHissG);
    src.connect(this.rHP);
  }

  _buildBrake() {
    this.bG = this._gain(0, this.neuRun);
    this.bBP = this._filter('bandpass', 3000, 0.7, this.bG);
    this.nMo.connect(this.bBP);
  }

  _buildCab() {
    /* 送風・空調のサー */
    this.cFanG = this._gain(0.1, this.cabRun);
    this.cFanLP = this._filter('lowpass', 520, 0.5, this.cFanG);
    this.nMo.connect(this.cFanLP);
    /* 補助電源装置のかすかなうなり */
    this.cSivG = this._gain(0.0025, this.cabRun);
    this.cSiv = this._osc('sine', 1960, this.cSivG);
    this.cSiv2 = this._osc('sine', 3920, this._gain(0.4, this.cSivG));
    /* 空気圧縮機は動くときだけ配線する（_compStart） */
  }

  /* 遅延生成した連続音のチェーンを片付ける: 音源を at で止め、全部止まったら切断 */
  _dropChain(ch, at) {
    if (!ch) return;
    let left = ch.srcs.length;
    const fin = () => {
      if (--left > 0) return;
      for (const n of ch.srcs.concat(ch.nodes)) { try { n.disconnect(); } catch (e) { /* 無視 */ } }
    };
    for (const s of ch.srcs) {
      s.onended = fin;
      try { s.stop(at); } catch (e) { fin(); }
    }
  }

  _drop(key) {
    const ch = this[key];
    this[key] = null;
    if (ch && this.ctx) this._dropChain(ch, this.ctx.currentTime + 0.05);
  }

  /* 使われない状態が hold 秒続いたチェーンは片付ける（CPU節約。次に要る時また作る） */
  _idle(key, active, dt, hold = 4) {
    const ch = this[key];
    if (!ch) return;
    ch.idle = active ? 0 : ch.idle + dt;
    if (ch.idle > hold) this._drop(key);
  }

  /* 空気圧縮機「ドドドド」: 低いのこぎり波+ノイズを矩形LFOで断続→ローパスで角を丸める */
  _compStart(now) {
    if (this.kc) this._drop('kc');
    const g = this._gain(0, this.cabRun);
    const lp = this._filter('lowpass', 240, 0.8, g);
    const am = this._gain(0.5, lp);
    const osc = this._osc('sawtooth', 24, am);
    const gn = this._gain(0.9, am);
    const bp = this._filter('bandpass', 170, 1.0, gn);
    const src = this._loop('noiseM', Math.random() * 1.5, bp);
    const lfoD = this._gain(0.5, am.gain);
    const lfo = this._osc('square', 6, lfoD);
    try {
      osc.frequency.setValueAtTime(24, now); osc.frequency.linearRampToValueAtTime(41, now + 0.9);   // 回り始め
      lfo.frequency.setValueAtTime(6, now); lfo.frequency.linearRampToValueAtTime(12.5, now + 0.9);
      g.gain.setTargetAtTime(0.2, now, 0.25);
    } catch (e) { g.gain.value = 0.2; }
    this.kc = { g, osc, lfo, srcs: [osc, lfo, src], nodes: [g, lp, am, gn, bp, lfoD], idle: 0 };
  }

  _compStop(now) {
    const k = this.kc;
    if (!k) return;
    this.kc = null;
    try {
      k.osc.frequency.cancelScheduledValues(now); k.osc.frequency.setValueAtTime(41, now); k.osc.frequency.linearRampToValueAtTime(22, now + 1.0);
      k.lfo.frequency.cancelScheduledValues(now); k.lfo.frequency.setValueAtTime(12.5, now); k.lfo.frequency.linearRampToValueAtTime(5, now + 1.0);
      k.g.gain.cancelScheduledValues(now); k.g.gain.setTargetAtTime(0, now, 0.35);
    } catch (e) { /* 無視 */ }
    this._dropChain(k, now + 1.8);
  }

  /* 起動直後から少しずつ素材を先に合成（1回8ms以内） */
  _warm() {
    const names = ['joint0', 'joint1', 'joint2', 'hissShort', 'hissLong', 'doorThud', 'doorSlide',
      'doorChime', 'atsChime', 'horn', 'atsBell', 'beep', 'beepLow', 'buzzer', 'ebHiss', 'pressure', 'ir', 'cross', 'rain',
      'stopPerfect', 'stopGood', 'stopNg',
      ...MELODIES.map((m, i) => 'mel' + i)];
    const ctx = this.ctx;
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const step = () => {
      if (this.ctx !== ctx) return;
      const t0 = now();
      while (names.length && now() - t0 < 8) {
        const n = names.shift();
        try { this._buf(n); } catch (e) { /* 無視 */ }
      }
      if (names.length) setTimeout(step, 45);
    };
    setTimeout(step, 80);
  }

  /* 名前つきの音を1回鳴らす(UI用。例: cue('stopPerfect')) */
  cue(name, gain = 1, rate = 1) {
    if (!this.ctx || !this.enabled) return null;
    try { return this._play(name, this.uiBus, gain, rate !== 1 ? { rate } : {}); } catch (e) { return null; }
  }

  /* ---------------- sim との接続 ---------------- */
  bind(sim) {
    if (!sim) return;
    this._sim = sim;
    this._resetRun(sim);
    if (this.paused) this.pause(false);    // 新しい運転は一時停止なしで始まる
    if (this._bound) {
      if (this._bound.has(sim)) return;
      this._bound.add(sim);
    }
    if (typeof sim.onEvent === 'function') {
      sim.onEvent((type, data) => {
        if (this._sim !== sim) return;     // 捨てられた古い sim は無視
        try { this._onEvent(type, data || {}); } catch (e) { /* 音で落とさない */ }
      });
    }
  }

  _resetRun(sim) {
    const pos = sim && Number.isFinite(sim.pos) ? sim.pos : 0;
    this._axle = AXLES.map((a) => Math.floor((pos - a.off) / RAIL));
    this._lastPos = pos;
    this._lastBC = sim ? +sim.brakeCur || 0 : 0;
    this._lastV = sim ? +sim.v || 0 : 0;
    this._vMode = null;
    this._vOffT = 0;
    this._compT = 26 + Math.random() * 8;
    this._compOn = 0;
    if (this.kc && this.ctx) this._compStop(this.ctx.currentTime);   // 動作中の圧縮機は止める
    this._heldBrake = false;
    this._moving = this._lastV > 0.5;
    this._slipT = 0;
    this._sqS = { on: false, timer: 0, f: 3400, wob: 0 };
    this._psNear = false;
    this._psPh = 0;
  }

  _onEvent(type, d) {
    if (!this.ctx) return;
    switch (type) {
      case 'door-open':
        this._play('hissLong', this.uiBus, 0.24, { rate: 0.92 });
        this._play('doorSlide', this.uiBus, 0.5, { delay: 0.2 });
        break;
      case 'door-closing':
        this._play('doorChime', this.uiBus, 0.3);
        break;
      case 'door-closed':
        this._play('doorThud', this.uiBus, 0.48);
        this._play('hissShort', this.uiBus, 0.18, { delay: 0.12 });
        break;
      case 'melody':
        this.playMelody(d.seed);
        break;
      case 'ats-chime':
        this._play('atsChime', this.uiBus, 0.36);
        break;
      case 'ats-brake':
        this._play('atsBell', this.uiBus, 0.38);
        break;
      case 'eb':
        /* 止まっているときの非常ブレーキは、空気の音だけを小さく(ブザーは鳴らさない) */
        if (d && d.moving === false) {
          this._play('ebHiss', this.uiBus, 0.15);
          break;
        }
        this._play('ebHiss', this.uiBus, 0.4);
        this._play('buzzer', this.uiBus, 0.2);
        break;
      case 'arrived': {
        /* 停止位置の判定チャイム(ドアの音と重ならないよう少しおくらせる) */
        const e = Math.abs(Number(d.err));
        const name = !Number.isFinite(e) ? null : e <= 0.35 ? 'stopPerfect' : e <= 1 ? 'stopGood' : 'stopNg';
        if (name) this._play(name, this.uiBus, 0.34, { delay: 0.25 });
        break;
      }
      case 'overrun':
        this._play('beep', this.uiBus, 0.26);
        break;
      case 'overrun-stop':
        this._play('beepLow', this.uiBus, 0.26);
        break;
      default:
        break;     // finished / 未知のイベントは無視
    }
  }

  /* ---------------- 毎フレーム ---------------- */
  update(sim, dt, env = {}) {
    if (!this.ctx || !sim || !this.enabled) return;
    try {
      this._update(sim, dt, env || {});
    } catch (e) {
      if (!this._warned) { this._warned = true; console.warn('[audio] update error', e); }
    }
  }

  _update(sim, dt, env) {
    dt = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.25) : 0;
    if (sim !== this._sim) { this._sim = sim; this._resetRun(sim); }
    if (sim.ended) return;                  // 終了後は鳴らし直さない（stop()済み）
    if (!this._running) this._revive();
    const now = this.ctx.currentTime;
    const v = Math.max(0, +sim.v || 0);
    const rain = env.rain != null ? !!env.rain : sim.weather === 'rain';
    const snow = env.snow != null ? !!env.snow : sim.weather === 'snow';
    const R = Number.isFinite(env.curveRadius) && env.curveRadius > 0 ? env.curveRadius : Infinity;

    this._updView(!!env.external, !!env.inTunnel, v, dt, now);
    this._updVVVF(sim, v, dt, now);
    this._updRolling(v, dt, snow);
    if (dt > 0) this._updJoints(sim, v, dt, now, snow);
    this._updBrake(sim, v, dt);
    this._updCab(v, dt, now);
    this._updSqueal(v, R, dt, rain, now);
    this._updCrossing(env.crossings, v, dt);
    this._updPassing(env.passing, v, dt, now);
    this._updRain(rain, v, dt);
    this._lastV = v;
    this.info.voices = this._voices;
  }

  _revive() {
    this._running = true;
    this._set(this.extRun.gain, 1, 0.25);
    this._set(this.cabRun.gain, 1, 0.25);
    this._set(this.neuRun.gain, 1, 0.25);
    if (this.wkP) {
      const p = this.wkP.active;
      p._tv = 1;
      try { p.cancelScheduledValues(this.ctx.currentTime); p.setValueAtTime(1, this.ctx.currentTime); } catch (e) { p.value = 1; }
    }
  }

  /* 車内/車外カメラ・トンネル */
  _updView(external, tunnel, v, dt, now) {
    if (external !== this._ext) {
      this._ext = external;
      this._set(this.extLP.frequency, external ? 16000 : 5200, 0.12);
      this._set(this.extOut.gain, external ? 1.35 : 1, 0.15);
      this._set(this.cabIn.gain, external ? 0.3 : 1, 0.15);
      this._set(this.hornLP.frequency, external ? 12000 : 3800, 0.1);
    }
    if (tunnel !== this._tun) {
      this._tun = tunnel;
      if (tunnel) {
        this._ensureTunnel();
        this._convLink(true);
        if (v > 35) this._play('pressure', this.extIn, clamp(0.12 + v / 400, 0, 0.4));   // 突入の風圧
      } else {
        this._tunOff = now;
      }
      this._set(this.tunnelSend.gain, tunnel ? 0.4 : 0, 0.25);
      this._set(this.extTone.gain, tunnel ? 4 : 0, 0.3);
    }
    if (dt > 0) this._tunMix += ((tunnel ? 1 : 0) - this._tunMix) * (1 - Math.exp(-dt / 0.5));
    /* トンネルを出て残響が消えたら畳み込みを外す（CPU節約） */
    if (!tunnel && this._convOn && now - (this._tunOff || 0) > 3 && now > (this._melUntil || 0)) this._convLink(false);
  }

  _ensureTunnel() {
    if (this.conv) return;
    const conv = this.ctx.createConvolver();
    conv.normalize = false;
    conv.buffer = this._buf('ir');
    this.convWet = this._gain(0.4, this.pauseBus);
    conv.connect(this.convWet);
    this.conv = conv;
    this._convOn = false;
  }

  _convLink(on) {
    if (!this.conv || on === this._convOn) return;
    try {
      if (on) this.tunnelSend.connect(this.conv);
      else this.tunnelSend.disconnect();
      this._convOn = on;
    } catch (e) { /* 無視 */ }
  }

  /* VVVF: トルク（力行 or 回生）で鳴り、惰行で消える */
  _updVVVF(sim, v, dt, now) {
    /* ノッチ指令でゲート（accelCur は切っても1秒以上残るので、それだけだと惰行で鳴り続ける） */
    const n = Number.isFinite(sim.notch) ? sim.notch : null;
    const powerCmd = n == null || n > 0;
    const regenCmd = n == null || (n < 0 && n > -8);   // 非常(−8)は回生しない
    const pw = powerCmd ? clamp((+sim.accelCur || 0) / 3.3, 0, 1) : 0;
    const rg = regenCmd && v > 4 ? clamp((+sim.brakeCur || 0) / 4.0, 0, 1) * smooth01((v - 4) / 5) : 0;
    const drive = Math.max(pw, rg * 0.6);  // 回生は力行の6割の音量
    const on = pw > 0.004 || rg > 0.025;
    const powering = pw >= rg * 0.6;
    const slip = powering ? 0.8 + 2.2 * pw : -(0.6 + 1.6 * rg);
    const p = vvvfPattern(v, slip, this._vMode);
    this._vMode = p.mode;

    if (this.wkP) {
      this._set(this.wkP.fm, p.fm, 0.02);
      this._set(this.wkP.fc, p.fc, 0.03);
      this._set(this.wkP.mi, p.mi, 0.03);
      if (this.wkP.pulses._tv !== p.pulses) {
        this.wkP.pulses._tv = p.pulses;
        try { this.wkP.pulses.setValueAtTime(p.pulses, now); } catch (e) { this.wkP.pulses.value = p.pulses; }
      }
      /* 消音が続いたらワークレットを休ませる */
      if (on) this._vOffT = 0; else this._vOffT += dt;
      const act = this._vOffT < 0.6 ? 1 : 0;
      const ap = this.wkP.active;
      if (ap._tv !== act) {
        ap._tv = act;
        try { ap.cancelScheduledValues(now); ap.setValueAtTime(act, now); } catch (e) { ap.value = act; }
      }
    } else if (this.fb) {
      let fa, fb;
      if (p.pulses === 1) { fa = 5 * p.fm; fb = 7 * p.fm; }
      else { const fc = p.pulses >= 2 ? p.pulses * p.fm : p.fc; fa = fc; fb = fc + 2 * p.fm; }
      this._set(this.fb.a.frequency, fa, 0.02);
      this._set(this.fb.b.frequency, fb, 0.02);
    }
    this._set(this.humA.frequency, 2 * p.fm, 0.03);
    this._set(this.humB.frequency, 6 * p.fm, 0.03);

    const lvl = on ? 0.3 + 0.7 * Math.sqrt(drive) : 0;
    const spd = 1 - 0.2 * smooth01((v - 40) / 60);
    const modeK = p.pulses === 1 ? 2.2 : 1;                      // 1パルスは線間電圧主体で小さいので補う
    const gate = lvl * spd * modeK * 0.1;
    this._set(this.vGate.gain, gate, on ? 0.05 : 0.08);          // 解放は約0.25秒
    this._set(this.vLP.frequency, p.pulses === 1 ? 2800 : 5000, 0.1);   // 1パルスは高次倍音を丸めて「ウーン」に
    this._set(this.humGate.gain, lvl * 0.03, on ? 0.06 : 0.09);
    /* 歯車音は速度で常に（力行中は少し大きく） */
    this._set(this.gear.frequency, Math.max(10, v * 9.4), 0.05);
    this._set(this.gearG.gain, 0.012 * Math.pow(v / 100, 1.5) * (1 + 0.5 * drive), 0.1);

    this.info.mode = p.name;
    this.info.fm = p.fm;
    this.info.fc = p.pulses === 1 ? 0 : p.pulses >= 2 ? p.pulses * p.fm : p.fc;
    this.info.gate = gate;
  }

  /* 走行音: 速度で音量・音色。トンネルで低域が増え、雪でこもる */
  _updRolling(v, dt, snow) {
    if (dt > 0) {
      this._rw += (Math.random() * 2 - 1) * dt * 1.6;
      this._rw *= 1 - Math.min(1, dt * 0.7);
      this._rw = clamp(this._rw, -1, 1);
    }
    const wob = 1 + 0.12 * this._rw;
    const tm = this._tunMix;
    const s = Math.min(1.25, v / 100);
    const muff = snow ? 0.6 : 1;
    const moving = v > 0.2 ? 1 : 0;
    this._set(this.rRumG.gain, moving * 1.1 * Math.pow(s, 0.8) * (1 + 0.6 * tm) * wob * (snow ? 0.9 : 1), 0.12);
    this._set(this.rLP1.frequency, (70 + 170 * s) * muff * (1 + 0.25 * tm), 0.2);
    this._set(this.rLP2.frequency, (70 + 170 * s) * muff * (1 + 0.25 * tm), 0.2);
    this._set(this.rRoadG.gain, moving * 0.3 * Math.pow(s, 1.1) * (1 + 0.35 * tm) * (2 - wob) * (snow ? 0.85 : 1), 0.12);
    this._set(this.rBP.frequency, (320 + 950 * s) * muff, 0.2);
    this._set(this.rHissG.gain, moving * 0.045 * s * s * (1 + 0.3 * tm) * (snow ? 0.5 : 1), 0.15);
    this._set(this.rWheel.frequency, Math.max(0.1, 0.1028 * v), 0.1);   // 車輪径0.86m
    this._set(this.rWheelD.gain, 0.18 * smooth01(v / 20), 0.2);
  }

  /* ジョイント: 各車軸が25m毎の継目を通る時刻を予測して正確に予約する */
  _updJoints(sim, v, dt, now, snow) {
    const pos = +sim.pos || 0;
    let vms = v / 3.6;
    const meas = (pos - this._lastPos) / dt;
    if (meas > vms * 1.6 + 1) vms = meas;      // デバッグ倍速など
    const jump = pos < this._lastPos - 0.5 || pos - this._lastPos > Math.max(60, vms * dt * 3 + 30);
    this._lastPos = pos;
    /* 位置が飛んだ(やり直し等)・デバッグの超倍速 → 継目番号だけ合わせて鳴らさない */
    if (jump || vms > 60) { this._axle = AXLES.map((a) => Math.floor((pos - a.off) / RAIL)); return; }
    this._set(this.jointLP.frequency, (900 + 50 * v) * (snow ? 0.65 : 1), 0.1);
    const audible = v > 1.2;
    const sp = Math.pow(clamp(v / 70, 0, 1.35), 0.9);
    const base = 0.42 * sp * (snow ? 0.75 : 1) * (1 + 0.25 * this._tunMix);
    const horizon = dt * 1.6 + 0.012;
    const lat = 0.03;                          // 予約遅延（全車軸で一定なのでリズムは正確）
    for (let a = 0; a < AXLES.length; a++) {
      const rel = pos - AXLES[a].off;
      const cur = Math.floor(rel / RAIL);
      if (cur > this._axle[a]) {               // 予約し損ねた → 今すぐ1回だけ
        this._axle[a] = cur;
        if (audible) this._joint(a, base, now + 0.005);
      }
      const next = this._axle[a] + 1;
      const dist = next * RAIL - rel;
      if (vms > 0.3 && dist / vms < horizon) {
        this._axle[a] = next;
        if (audible) this._joint(a, base, now + lat + dist / vms);
      }
    }
  }

  _joint(a, base, at) {
    const g = base * AXLES[a].g;
    if (g < 0.002) return;
    const k = (a + Math.floor(Math.random() * 3)) % 3;
    this._play('joint' + k, this.jointLP, g * (0.85 + 0.3 * Math.random()), { at, rate: 0.94 + 0.12 * Math.random() });
  }

  /* 空気ブレーキ: シリンダ圧の変化で「シュー」。停車後の緩めで「プシュー」 */
  _updBrake(sim, v, dt) {
    const bc = Math.max(0, +sim.brakeCur || 0);
    if (dt > 0) {
      const d = (bc - this._lastBC) / dt;
      const rel = Math.max(0, -d), app = Math.max(0, d);
      let g = clamp(rel * 0.075 + app * 0.02, 0, 0.32);
      if (g < 0.004) g = 0;
      this._set(this.bG.gain, g, 0.05);
      this._set(this.bBP.frequency, rel > app ? 2500 : 4200, 0.1);
      /* 停まった瞬間: 圧力調整の「プシュッ」 */
      if (v > 0.5) this._moving = true;
      else if (this._moving && v <= 0.05) {
        this._moving = false;
        if (bc > 0.5) this._play('hissShort', this.uiBus, 0.2, { delay: 0.45, rate: 1.15 });
      }
      /* 停車中(〜発車直後)にブレーキを緩めた → 「プシュー」 */
      if (v < 3) {
        if (bc > 0.9) this._heldBrake = true;
        if (this._heldBrake && bc < 0.35) { this._heldBrake = false; this._play('hissLong', this.uiBus, 0.28, { rate: 1.05 }); }
      } else {
        this._heldBrake = false;
      }
      /* 滑走: 滑走防止弁の断続的な排気 */
      if (sim.slipping && v > 3) {
        this._slipT -= dt;
        if (this._slipT <= 0) { this._slipT = 0.28 + Math.random() * 0.2; this._play('hissShort', this.uiBus, 0.16, { rate: 1.5 }); }
      } else {
        this._slipT = 0;
      }
    }
    this._lastBC = bc;
  }

  /* 運転台: コンプレッサーは停車中にときどき（約40秒おきに約6秒） */
  _updCab(v, dt, now) {
    this._compT += dt;
    if (this._compOn <= 0 && v < 1 && this._compT > 40) {
      this._compOn = 6;
      this._compStart(now);
    } else if (this._compOn > 0) {
      this._compOn -= dt;
      if (this._compOn <= 0) {
        this._compT = 0;
        this._compStop(now);
      }
    }
  }

  /* 曲線のきしみ（キーキー）: R<450m・12km/h超。半径が小さいほど強く、断続的 */
  _updSqueal(v, R, dt, rain, now) {
    let want = 0;
    if (R < 450 && v > 12) want = Math.pow(clamp((450 - R) / 330, 0, 1), 0.8) * smooth01((v - 12) / 18) * (rain ? 0.35 : 1);
    if (want > 0.01) this._ensureSqueal();
    this._idle('sq', want > 0.01, dt);
    const q = this.sq;
    if (!q) return;
    const s = this._sqS;
    s.timer -= dt;
    if (want <= 0.01) {
      s.on = false;
    } else if (s.timer <= 0) {
      s.on = !s.on || Math.random() < want * 0.3;
      s.timer = s.on ? 0.35 + Math.random() * (0.8 + 2.4 * want) : 0.25 + Math.random() * (2.8 * (1 - want) + 0.3);
      if (s.on) s.f = 2900 + Math.random() * 1700;
    }
    if (dt > 0) { s.wob += (Math.random() * 2 - 1) * dt * 2; s.wob *= 1 - Math.min(1, dt); s.wob = clamp(s.wob, -1, 1); }
    const f = s.f * (1 + 0.012 * s.wob);
    this._set(q.o1.frequency, f, 0.05);
    this._set(q.o2.frequency, f * 2.01, 0.05);
    const amp = s.on ? want * (0.75 + 0.25 * Math.sin(now * 37)) : 0;
    this._set(q.g.gain, amp * 0.12 * (this._ext ? 1.6 : 1), s.on ? 0.08 : 0.15);
  }

  _ensureSqueal() {
    if (this.sq) return;
    const g = this._gain(0, this.neuRun);
    const g2 = this._gain(0.3, g), gn = this._gain(0.35, g);
    const o1 = this._osc('sine', 3400, g);
    const o2 = this._osc('sine', 6800, g2);
    const nh = this._filter('highpass', 5500, 0.7, gn);
    const src = this._loop('noiseM', Math.random() * 1.5, nh);   // フランジがこすれるシャー
    this.sq = { g, o1, o2, srcs: [o1, o2, src], nodes: [g, g2, gn, nh], idle: 0 };
  }

  /* 踏切: いちばん近い踏切(|d|<350m)の警報音。距離で減衰+こもり、通過でドップラー */
  _updCrossing(list, v, dt) {
    let best = null;
    if (Array.isArray(list)) {
      for (const d of list) if (Number.isFinite(d) && Math.abs(d) < 350 && (best === null || Math.abs(d) < Math.abs(best))) best = d;
    }
    if (best === null) {
      if (this.cx) { this._set(this.cx.g.gain, 0, 0.25); this._idle('cx', false, dt); }
      return;
    }
    this._ensureCrossing();
    this._idle('cx', true, dt);
    const ad = Math.abs(best);
    let g = 0.95 / (1 + Math.pow(ad / 40, 1.5));
    g *= 1 - Math.pow(ad / 350, 4);
    if (best < 0) g *= 0.85;
    this._set(this.cx.g.gain, g, 0.08);
    this._set(this.cx.lp.frequency, 9000 / (1 + ad / 60) + 1200, 0.1);
    const cos = best / Math.sqrt(best * best + 64);              // 線路から約8m脇
    this._set(this.cx.src.playbackRate, 1 + clamp(((v / 3.6) * cos) / 343, -0.12, 0.12), 0.05);
  }

  _ensureCrossing() {
    if (this.cx) return;
    const g = this._gain(0, this.extRun);
    const pan = this._panner(0.12, g);
    const lp = this._filter('lowpass', 8000, 0.5, pan);
    const src = this._loop('cross', Math.random() * 8, lp);
    this.cx = { g, lp, src, srcs: [src], nodes: [g, pan, lp], idle: 0 };
  }

  /* すれ違い列車: ゴーッ+風切り+台車のタタン。近いほど大きく、軽いドップラー */
  _updPassing(list, v, dt, now) {
    let best = null;
    if (Array.isArray(list)) {
      for (const p of list) {
        if (p && Number.isFinite(p.dist) && Math.abs(p.dist) < 700 && (!best || Math.abs(p.dist) < Math.abs(best.dist))) best = p;
      }
    }
    if (!best) {
      if (this.ps) { this._set(this.ps.rumG.gain, 0, 0.3); this._set(this.ps.whG.gain, 0, 0.3); this._idle('ps', false, dt); }
      this._psNear = false;
      return;
    }
    this._ensurePassing();
    this._idle('ps', true, dt);
    const d = best.dist, rs = Number.isFinite(best.relSpeed) ? best.relSpeed : 0;
    const de = Math.max(0, Math.abs(d) - 55);                  // 編成の長さぶんは横並び扱い
    const w = 1 / (1 + Math.pow(de / 32, 2));
    const spd = clamp(Math.abs(rs) / 30, 0.25, 1.3);
    this._set(this.ps.rumG.gain, 0.55 * w * spd, 0.08);
    this._set(this.ps.whG.gain, 0.22 * w * Math.pow(spd, 1.5), 0.08);
    this._set(this.ps.lp.frequency, 500 + 2200 * w, 0.1);
    const cos = Math.abs(d) / Math.sqrt(d * d + 16);           // 隣の線路まで約4m
    const rate = clamp(343 / (343 - rs * cos), 0.85, 1.18);
    this._set(this.ps.src.playbackRate, rate, 0.05);
    /* 先頭どうしがすれ違う瞬間の風圧 */
    if (!this._psNear && w > 0.6 && Math.abs(rs) > 12) { this._psNear = true; this._play('pressure', this.ps.bus, 0.45 * spd); }
    if (w < 0.2) this._psNear = false;
    /* 相手の台車が横を通るリズム（1両20m: 台車内2.1m・台車間13.8m） */
    if (w > 0.15 && Math.abs(rs) > 2 && dt > 0) {
      const ars = Math.abs(rs);
      this._psPh += (ars * dt) / 20;
      while (this._psPh >= 1) {
        this._psPh -= 1;
        [0, 2.1, 13.8, 15.9].forEach((off, i) => {
          const k = (i + Math.floor(Math.random() * 3)) % 3;
          this._play('joint' + k, this.ps.cl, 0.16 * w * spd * (i % 2 ? 0.8 : 1), { at: now + 0.02 + off / ars, rate: rate * (0.95 + 0.1 * Math.random()) });
        });
      }
    }
  }

  _ensurePassing() {
    if (this.ps) return;
    const pan = this._panner(0.45, this.extRun);    // 隣の線路（右側）
    const bus = this._gain(1, pan);
    const rumG = this._gain(0, bus);
    const lp = this._filter('lowpass', 900, 0.6, rumG);
    const whG = this._gain(0, bus);
    const bp = this._filter('bandpass', 2200, 0.5, whG);
    const cl = this._filter('lowpass', 2500, 0.5, bus);
    const src = this._loop('noise', 0.77);
    src.connect(lp); src.connect(bp);
    this.ps = { g: bus, bus, rumG, lp, whG, bp, cl, src, srcs: [src], nodes: [pan, bus, rumG, lp, whG, bp, cl], idle: 0 };
  }

  /* 雨: フロントガラスに当たる雨音（速いほど少し強く） */
  _updRain(rain, v, dt) {
    if (!rain) {
      if (this.rn) { this._set(this.rn.g.gain, 0, 0.5); this._idle('rn', false, dt); }
      return;
    }
    if (!this.rn) {
      const g = this._gain(0, this.cabRun);
      const hp = this._filter('highpass', 350, 0.7, g);
      const src = this._loop('rain', 0, hp);
      this.rn = { g, hp, src, srcs: [src], nodes: [g, hp], idle: 0 };
    }
    this._set(this.rn.g.gain, 0.45 * (0.7 + 0.45 * Math.min(1, v / 90)) * (this._ext ? 0.45 : 1), 0.4);
  }

  /* ---------------- 公開API（一発もの・制御） ---------------- */
  horn() {
    this.ensure();
    if (!this.ctx) return;
    try {
      const now = this.ctx.currentTime;
      if (this._hornV) {
        const o = this._hornV;
        try { o.g.gain.setTargetAtTime(0, now, 0.02); o.src.stop(now + 0.12); } catch (e) { /* 無視 */ }
      }
      this._hornV = this._play('horn', this.hornBus, this._ext ? 0.7 : 0.53);
    } catch (e) { /* 無視 */ }
  }

  playMelody(seed) {
    if (!this.ctx) return;
    try {
      const n = MELODIES.length;
      const idx = ((Math.round(+seed || 0) % n) + n) % n;
      this._ensureMelodyChain();
      const now = this.ctx.currentTime;
      if (this._mel) {
        const o = this._mel;
        try { o.g.gain.setTargetAtTime(0, now, 0.04); o.src.stop(now + 0.25); } catch (e) { /* 無視 */ }
      }
      const v = this._play('mel' + idx, this.melIn, 1, { delay: 0.02 });
      this._mel = v;
      if (v) this._melUntil = now + v.src.buffer.duration + 2;
      this.info.melody = idx;
    } catch (e) { /* 無視 */ }
  }

  /* ホームのスピーカー: 直接音+離れたスピーカー2つ分のこだま（左右） */
  _ensureMelodyChain() {
    if (this.melIn) return;
    const ctx = this.ctx;
    this.melIn = this._gain(0.28, this.pauseBus);
    const tap = (delay, gain, pan) => {
      const dl = ctx.createDelay(1);
      dl.delayTime.value = delay;
      this.melIn.connect(dl);
      dl.connect(this._gain(gain, this._panner(pan, this.pauseBus)));
    };
    tap(0.105, 0.32, 0.6);
    tap(0.235, 0.2, -0.55);
    this.melIn.connect(this.tunnelSend);     // 地下駅ではトンネル残響にも送る
  }

  stop() {
    this._running = false;
    if (!this.ctx) return;
    try {
      const now = this.ctx.currentTime;
      for (const p of [this.extRun.gain, this.cabRun.gain, this.neuRun.gain, this.vGate.gain, this.humGate.gain, this.bG.gain]) this._set(p, 0, 0.12);
      /* 環境音のチェーンはフェード後に片付ける */
      for (const key of ['sq', 'cx', 'ps', 'rn']) {
        const ch = this[key];
        if (!ch) continue;
        this[key] = null;
        try { ch.g.gain.setTargetAtTime(0, now, 0.1); } catch (e) { /* 無視 */ }
        this._dropChain(ch, now + 0.8);
      }
      this._compOn = 0;
      this._compStop(now);
      if (this.wkP) {
        const ap = this.wkP.active;
        ap._tv = 0;
        try { ap.cancelScheduledValues(now); ap.setValueAtTime(0, now + 0.8); } catch (e) { ap.value = 0; }
      }
    } catch (e) { /* 無視 */ }
  }

  setVolume(v) {
    this.volume = clamp(Number.isFinite(+v) ? +v : 0.8, 0, 1);
    this._applyMaster();
  }

  setMuted(b) {
    this.muted = !!b;
    this._applyMaster();
  }

  _applyMaster() {
    if (!this.ctx || !this.master) return;
    this._set(this.master.gain, this.muted ? 0 : this.volume, 0.04);
  }

  pause(b) {
    this.paused = !!b;
    if (!this.ctx || !this.pauseBus) return;
    this._set(this.pauseBus.gain, this.paused ? 0 : 1, this.paused ? 0.05 : 0.12);
  }
}
