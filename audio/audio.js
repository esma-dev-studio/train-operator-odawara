/* =========================================================
 * audio/audio.js — WebAudio 合成音（外部ファイルなし）
 * VVVFインバーター音 / 走行音 / レールジョイント / ATS / 警笛 / ドア
 * ========================================================= */

export class CabAudio {
  constructor() {
    this.ctx = null;
    this.enabled = true;
  }

  ensure() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) { return; }
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(ctx.destination);

    /* --- VVVF（のこぎり波+バンドパス） --- */
    this.vvvfOsc = ctx.createOscillator();
    this.vvvfOsc.type = 'sawtooth';
    this.vvvfGain = ctx.createGain(); this.vvvfGain.gain.value = 0;
    const vvvfFil = ctx.createBiquadFilter();
    vvvfFil.type = 'bandpass'; vvvfFil.frequency.value = 900; vvvfFil.Q.value = 1.2;
    this.vvvfOsc.connect(vvvfFil); vvvfFil.connect(this.vvvfGain); this.vvvfGain.connect(this.master);
    this.vvvfOsc.start();

    /* --- 走行音（ノイズループ+ローパス） --- */
    const len = ctx.sampleRate * 1.5;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { last = (last + 0.05 * (Math.random() * 2 - 1)) / 1.05; d[i] = last * 2.4; }
    this.rollSrc = ctx.createBufferSource();
    this.rollSrc.buffer = buf; this.rollSrc.loop = true;
    this.rollFil = ctx.createBiquadFilter();
    this.rollFil.type = 'lowpass'; this.rollFil.frequency.value = 300;
    this.rollGain = ctx.createGain(); this.rollGain.gain.value = 0;
    this.rollSrc.connect(this.rollFil); this.rollFil.connect(this.rollGain); this.rollGain.connect(this.master);
    this.rollSrc.start();

    /* ジョイント用の短いノイズバッファ */
    const jlen = ctx.sampleRate * 0.06;
    this.jointBuf = ctx.createBuffer(1, jlen, ctx.sampleRate);
    const jd = this.jointBuf.getChannelData(0);
    for (let i = 0; i < jlen; i++) jd[i] = (Math.random() * 2 - 1) * (1 - i / jlen) ** 1.6;
  }

  bind(sim) {
    this._lastJoint = Math.floor(sim.pos / 25);
    sim.onEvent((type) => {
      if (!this.ctx) return;
      if (type === 'ats-chime') this.chime();
      if (type === 'ats-brake') this.buzzer();
      if (type === 'door-closing') this.doorChime();
      if (type === 'door-closed') this.bell();
      if (type === 'eb') this.buzzer(0.5);
    });
  }

  tone(freq, dur, delay = 0, type = 'sine', gain = 0.08) {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(this.master);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }

  chime() { this.tone(1180, 0.4, 0, 'sine', 0.07); this.tone(885, 0.4, 0.12, 'sine', 0.06); }
  buzzer(dur = 1.0) { this.tone(320, dur, 0, 'square', 0.05); this.tone(316, dur, 0, 'square', 0.04); }
  doorChime() { [0, 0.45].forEach((d) => { this.tone(830, 0.32, d, 'sine', 0.06); this.tone(660, 0.3, d + 0.14, 'sine', 0.06); }); }
  bell() { this.tone(1560, 0.7, 0, 'triangle', 0.05); }
  horn() {
    this.ensure();
    this.tone(370, 1.0, 0, 'sawtooth', 0.09);
    this.tone(466, 1.0, 0, 'sawtooth', 0.09);
    this.tone(370, 1.0, 0.02, 'square', 0.02);
  }

  joint(v) {
    if (!this.ctx || v < 4) return;
    const g0 = Math.min(0.16, 0.02 + v * 0.0016);
    [0, 0.09].forEach((d) => {
      const src = this.ctx.createBufferSource();
      src.buffer = this.jointBuf;
      const g = this.ctx.createGain();
      g.gain.value = g0;
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = 900 + v * 12;
      src.connect(f); f.connect(g); g.connect(this.master);
      src.start(this.ctx.currentTime + d);
    });
  }

  update(sim, dt) {
    if (!this.ctx || !this.enabled) return;
    const v = sim.v;
    /* VVVF: 加減速時に鳴る。速度でキャリア周波数が段階的に変わる */
    const drive = Math.max(sim.accelCur / 3.3, sim.brakeCur > 0.4 && v > 8 ? 0.5 : 0);
    let f;
    if (v < 13) f = 210 + v * 34;
    else if (v < 24) f = 640 - (v - 13) * 22;
    else if (v < 38) f = 400 + (v - 24) * 12;
    else f = 560 + (v - 38) * 4;
    this.vvvfOsc.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.05);
    this.vvvfGain.gain.setTargetAtTime(drive * Math.min(1, v / 9 + 0.2) * 0.05, this.ctx.currentTime, 0.08);
    /* 走行音 */
    this.rollGain.gain.setTargetAtTime(Math.min(0.14, v * 0.0021), this.ctx.currentTime, 0.15);
    this.rollFil.frequency.setTargetAtTime(280 + v * 9, this.ctx.currentTime, 0.2);
    /* ジョイント（25m毎・タタン） */
    const j = Math.floor(sim.pos / 25);
    if (j !== this._lastJoint) { this._lastJoint = j; this.joint(v); }
    /* 雨 */
    if (sim.weather === 'rain' && !this._rain) {
      this._rain = true;
      this.rollGain.gain.value += 0.02;
    }
  }

  stop() {
    if (!this.ctx) return;
    this.vvvfGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1);
    this.rollGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1);
  }
}
