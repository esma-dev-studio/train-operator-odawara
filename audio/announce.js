/* =========================================================
 * audio/announce.js — 車内放送（speechSynthesis の薄いラッパー）
 * ・日本語(ja-JP)の声を自動で選ぶ（声の一覧は後から届くことがある: voiceschanged）
 * ・自前のキューで1つずつ読み上げる。priority=true は割り込み（キューを捨てる）
 * ・ブラウザの癖への対策:
 *    - 発話オブジェクトがGCされると onend が来ない → 終わるまで参照を保持
 *    - onend が来ないことがある → 文字数から見積もった時間で次へ進む見張り
 *    - Safari は cancel() 直後の speak() を落とすことがある → 少し待ってから話す
 *    - iOS は最初の発話をユーザー操作の中で行う必要がある → unlock()
 * 文言は呼び出し側（main.js）が用意する。
 * ========================================================= */

const PREFERRED = /Kyoko|O-ren|Otoya|Hattori|Google 日本語|Nanami|Haruka|Ayumi|Ichiro|Sayaka/i;

export class Announcer {
  constructor() {
    const w = typeof window !== 'undefined' ? window : null;
    this.synth = w && w.speechSynthesis ? w.speechSynthesis : null;
    this.Utter = w && w.SpeechSynthesisUtterance ? w.SpeechSynthesisUtterance : null;
    this.enabled = true;
    this.volume = 1;
    this.voice = null;
    this.queue = [];
    this.current = null;
    this.onstate = null;          // (speaking: boolean) => void  BGMを下げたい時などに
    this._watch = null;
    this._gen = 0;
    if (this.available) {
      this._pickVoice();
      const h = () => this._pickVoice();
      try {
        if (this.synth.addEventListener) this.synth.addEventListener('voiceschanged', h);
        else this.synth.onvoiceschanged = h;
      } catch (e) { /* 無視 */ }
    }
  }

  get available() {
    return !!(this.synth && this.Utter);
  }

  get speaking() {
    return !!this.current;
  }

  _pickVoice() {
    let list = [];
    try { list = this.synth.getVoices() || []; } catch (e) { list = []; }
    const ja = list.filter((v) => /^ja([-_]|$)/i.test(v.lang || ''));
    if (!ja.length) return;
    this.voice = ja.find((v) => PREFERRED.test(v.name) && v.localService)
      || ja.find((v) => PREFERRED.test(v.name))
      || ja.find((v) => v.localService)
      || ja[0];
  }

  setEnabled(b) {
    this.enabled = !!b;
    if (!this.enabled) this.cancel();
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, Number(v) || 0));
  }

  /* iOS対策: ユーザー操作の中で一度だけ呼ぶ（無音の発話で読み上げを解放） */
  unlock() {
    if (!this.available || this._unlocked) return;
    this._unlocked = true;
    try {
      const u = new this.Utter(' ');
      u.volume = 0;
      u.lang = 'ja-JP';
      this.synth.speak(u);
    } catch (e) { /* 無視 */ }
  }

  speak(text, { rate = 1.0, pitch = 1.0, priority = false } = {}) {
    if (!this.available || !this.enabled || !text) return false;
    const item = { text: String(text), rate, pitch };
    if (priority) {
      this.queue = [item];
      if (this.current) {
        this._stopCurrent();
        /* Safari: cancel直後のspeakは落ちることがあるので少し待つ */
        const g = this._gen;
        setTimeout(() => { if (g === this._gen && !this.current) this._next(); }, 80);
        return true;
      }
    } else {
      this.queue.push(item);
    }
    if (!this.current) this._next();
    return true;
  }

  cancel() {
    this.queue = [];
    this._stopCurrent();
  }

  _stopCurrent() {
    this._gen++;
    clearTimeout(this._watch);
    this.current = null;
    try { this.synth.cancel(); } catch (e) { /* 無視 */ }
    this._state(false);
  }

  _state(on) {
    if (this._on === on) return;
    this._on = on;
    if (typeof this.onstate === 'function') {
      try { this.onstate(on); } catch (e) { /* 無視 */ }
    }
  }

  _next() {
    const item = this.queue.shift();
    if (!item) { this.current = null; this._state(false); return; }
    let u;
    try {
      u = new this.Utter(item.text);
      u.lang = 'ja-JP';
      if (this.voice) u.voice = this.voice;
      u.rate = item.rate;
      u.pitch = item.pitch;
      u.volume = this.volume;
    } catch (e) {
      this._next();
      return;
    }
    const gen = ++this._gen;
    const done = () => {
      if (gen !== this._gen) return;       // 割り込まれた古い発話
      clearTimeout(this._watch);
      this.current = null;
      this._next();
    };
    u.onend = done;
    u.onerror = done;
    this.current = u;                      // 参照を保持（GC対策）
    this._state(true);
    /* onend が来ないときの見張り: 日本語はおよそ1文字0.16秒（rate=1） */
    const est = (item.text.length * 0.16) / Math.max(0.3, item.rate) + 3;
    clearTimeout(this._watch);
    this._watch = setTimeout(() => {
      if (gen !== this._gen) return;
      try { this.synth.cancel(); } catch (e) { /* 無視 */ }
      done();
    }, est * 1000);
    try {
      /* Chrome: 一時停止状態に入っていることがあるので念のため再開 */
      if (this.synth.paused) this.synth.resume();
      this.synth.speak(u);
    } catch (e) {
      done();
    }
  }
}
