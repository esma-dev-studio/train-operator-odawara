/* =========================================================
 * audio/synth-worker.js — 効果音の波形を別スレッドで計算する(モジュールワーカー)
 * {name, sr} を受けとり、{name, sr, ch} を返す(Float32Array の中身は転送で渡す)。
 * メインスレッド(描画・タップ)を止めないため。失敗したら {name, error} を返す
 * (audio.js がその音だけメインスレッドで計算しなおす)。
 * ========================================================= */
import { RENDER } from './synth.js';

self.onmessage = (ev) => {
  const d = ev.data || {};
  const name = d.name;
  try {
    const fn = RENDER[name];
    if (!fn) { self.postMessage({ name, error: 'unknown' }); return; }
    const r = fn(d.sr);
    self.postMessage({ name, sr: r.sr, ch: r.ch }, r.ch.map((a) => a.buffer));
  } catch (e) {
    self.postMessage({ name, error: String((e && e.message) || e) });
  }
};
