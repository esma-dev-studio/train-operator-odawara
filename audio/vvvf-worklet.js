/* =========================================================
 * audio/vvvf-worklet.js — VVVFインバーター音（AudioWorkletProcessor）
 * 三相の正弦波PWM（変調波 × 三角波キャリアの比較）を1サンプルずつ計算し、
 * 線間電圧(U−V)＋少しの相電圧（キャリアの「ピー」成分）を出力する。
 *   ・スイッチングの段差は polyBLEP で帯域制限（折り返しノイズ対策）
 *   ・変調波の位相はモードが変わっても連続。同期モードへの切替時は
 *     キャリア位相のずれを数十msかけて吸収するのでブツッと鳴らない
 * パラメータ（k-rate。ブロック内は直線補間）:
 *   fm      変調波(=インバーター出力)周波数 Hz
 *   fc      非同期モードのキャリア周波数 Hz
 *   pulses  0=非同期 / 1=1パルス / N≥2 = 同期Nパルス(fc=N·fm)
 *   mi      変調率（1超は過変調）
 *   active  0.5未満で無音出力（惰行中のCPU節約）
 * 外部ファイルは読まない。ここで合成するだけ。
 * ========================================================= */

const TAU = Math.PI * 2;

/* 三角波キャリア: 位相(周)→ −1..+1 */
function tri(ph) {
  ph -= Math.floor(ph);
  return 1 - 4 * Math.abs(ph - 0.5);
}

/* パラメータ配列の値（k-rate/a-rate どちらでも末尾値を使う） */
function pv(arr) { return arr.length > 1 ? arr[arr.length - 1] : arr[0]; }

class VVVFProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'fm', defaultValue: 0.5, minValue: 0, maxValue: 500, automationRate: 'k-rate' },
      { name: 'fc', defaultValue: 520, minValue: 20, maxValue: 8000, automationRate: 'k-rate' },
      { name: 'pulses', defaultValue: 0, minValue: 0, maxValue: 99, automationRate: 'k-rate' },
      { name: 'mi', defaultValue: 0.08, minValue: 0, maxValue: 2, automationRate: 'k-rate' },
      { name: 'active', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.phM = 0;          // 変調波位相（周）
    this.phC = 0;          // キャリア位相（周）
    this.cOff = 0;         // 同期切替時のキャリア位相ずれ（徐々に0へ）
    this.pulses = 0;
    this.fm = 0.5; this.fc = 520; this.mi = 0.08;
    this.dU = 0; this.dV = 0;     // 前サンプルの (変調波−キャリア)
    this.sU = 1; this.sV = -1;    // 前サンプルのスイッチ状態
    this.prev = 0;                // polyBLEP用の1サンプル遅延
    this.silent = false;
    this.lp = 0;                  // ごく軽いローパス（耳障りな最上域を丸める）
    this.wP = 0.62;               // 相電圧の混合比（1パルスで下げる）
    /* 同期切替の位相ずれ吸収: 約25msで1/e */
    this.offDecay = Math.exp(-1 / (0.025 * sampleRate));
  }

  process(inputs, outputs, parameters) {
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    const n = out.length;

    if (pv(parameters.active) < 0.5) {
      /* 無音中も変調波の位相は進めておく（再開時に不連続にしない） */
      if (!this.silent) {
        /* 直前の出力から短くフェードして無音へ */
        let y = this.prev;
        for (let i = 0; i < n; i++) { y *= 0.95; out[i] = y; }
        this.prev = 0; this.lp = 0;
        this.silent = true;
      } else {
        out.fill(0);
      }
      this.phM = (this.phM + this.fm * n / sampleRate) % 1;
      return true;
    }
    this.silent = false;

    /* 目標値（ブロック内で直線補間） */
    const fm1 = Math.max(0, pv(parameters.fm));
    const fc1 = Math.max(20, pv(parameters.fc));
    const mi1 = Math.max(0, pv(parameters.mi));
    const pulses = Math.round(pv(parameters.pulses));
    const fm0 = this.fm, fc0 = this.fc, mi0 = this.mi;
    const inv = 1 / n;

    /* モード切替: 変調波位相はそのまま。同期へ入るときはキャリア位相の
     * ずれを記録して徐々に吸収（位相連続） */
    if (pulses !== this.pulses) {
      if (pulses >= 2) {
        let off = this.phC - pulses * this.phM;
        off -= Math.round(off);
        this.cOff = off;
      } else if (this.pulses >= 2) {
        /* 同期→非同期: 現在のキャリア位相から自走を続ける */
        this.phC = this.pulses * this.phM + this.cOff;
        this.phC -= Math.floor(this.phC);
      }
      this.pulses = pulses;
    }

    const sr = sampleRate;
    const offDecay = this.offDecay;
    let phM = this.phM, phC = this.phC, cOff = this.cOff;
    let dU0 = this.dU, dV0 = this.dV, sU0 = this.sU, sV0 = this.sV;
    let prev = this.prev, lp = this.lp, wP = this.wP;

    for (let i = 0; i < n; i++) {
      const k = (i + 1) * inv;
      const fm = fm0 + (fm1 - fm0) * k;
      const mi = mi0 + (mi1 - mi0) * k;

      phM += fm / sr;
      if (phM >= 1) phM -= 1;

      /* キャリア */
      let c;
      if (pulses === 1) {
        c = 0;                                   // 1パルス: 変調波の符号そのもの
      } else if (pulses >= 2) {
        cOff *= offDecay;
        c = tri(pulses * phM + cOff);            // 同期: 変調波にロック
      } else {
        phC += (fc0 + (fc1 - fc0) * k) / sr;     // 非同期: 自走
        if (phC >= 1) phC -= 1;
        c = tri(phC);
      }

      /* 比較器（U相・V相） */
      const refU = mi * Math.sin(TAU * phM);
      const refV = mi * Math.sin(TAU * (phM - 1 / 3));
      const dU = refU - c, dV = refV - c;
      const sU = dU >= 0 ? 1 : -1;
      const sV = dV >= 0 ? 1 : -1;

      /* 出力 = 相電圧U × wP + 線間電圧(U−V)/2 × 0.5
       * 線間電圧だけだとキャリア基本波(fc)が打ち消し合い 2fc±fm が主になるため、
       * fc を含む相電圧を主にして「キャリアの音程」が聞こえるようにする。
       * 1パルスでは相電圧の3次(3fm)が濁るので線間電圧寄りへ（約10msで移行） */
      wP += ((pulses === 1 ? 0.12 : 0.62) - wP) * 0.002;
      const a = wP + 0.25, b = -0.25;
      let cur = a * sU + b * sV;

      /* polyBLEP: 段差がサンプル間のどこで起きたかを線形補間で求めて補正 */
      if (sU !== sU0) {
        const den = dU0 - dU;
        const f = den !== 0 ? dU0 / den : 0.5;              // n−1 から段差までの割合
        const d = 1 - (f < 0 ? 0 : f > 1 ? 1 : f);          // 段差から n までの距離
        const h = a * (sU - sU0);
        prev += h * d * d * 0.5;
        cur -= h * (1 - d) * (1 - d) * 0.5;
      }
      if (sV !== sV0) {
        const den = dV0 - dV;
        const f = den !== 0 ? dV0 / den : 0.5;
        const d = 1 - (f < 0 ? 0 : f > 1 ? 1 : f);
        const h = b * (sV - sV0);
        prev += h * d * d * 0.5;
        cur -= h * (1 - d) * (1 - d) * 0.5;
      }

      /* 1サンプル遅れで出力（補正を前サンプルにも入れるため） */
      lp += (prev - lp) * 0.72;
      out[i] = lp * 0.7;
      prev = cur;
      dU0 = dU; dV0 = dV; sU0 = sU; sV0 = sV;
    }

    this.phM = phM; this.phC = phC; this.cOff = cOff;
    this.dU = dU0; this.dV = dV0; this.sU = sU0; this.sV = sV0;
    this.prev = prev; this.lp = lp; this.wP = wP;
    this.fm = fm1; this.fc = fc1; this.mi = mi1;
    return true;
  }
}

registerProcessor('vvvf-pwm', VVVFProcessor);
