/* 仮実装(本実装に置き換わる) */
export class Announcer {
  constructor() { this.enabled = true; }
  get available() { return typeof speechSynthesis !== 'undefined'; }
  setEnabled(b) { this.enabled = b; if (!b) this.cancel(); }
  speak(text, { rate = 1.0, pitch = 1.0, priority = false } = {}) {
    if (!this.enabled || !this.available) return;
    if (priority) speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ja-JP'; u.rate = rate; u.pitch = pitch;
    speechSynthesis.speak(u);
  }
  cancel() { if (this.available) speechSynthesis.cancel(); }
}
