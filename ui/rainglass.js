/* =========================================================
 * ui/rainglass.js — 雨天のフロントガラスの水滴
 * 3D運転台(scene/cockpit.js)の窓の範囲だけに描き、3Dワイパーが通ったら拭き取る。
 * ========================================================= */
export class RainGlass {
  constructor(canvas) {
    this.cv = canvas;
    this.c = canvas.getContext('2d');
    this.drops = [];
    this.t = 0;
    this.active = false;
  }

  resize(w, h) {
    const dpr = Math.min(1.5, devicePixelRatio || 1);
    this.cv.width = Math.round(w * dpr); this.cv.height = Math.round(h * dpr);
    this.scale = dpr;
  }

  setActive(on) {
    this.active = on;
    this.cv.style.display = on ? 'block' : 'none';
    if (!on) { this.drops = []; this.c.clearRect(0, 0, this.cv.width, this.cv.height); }
  }

  /* v: km/h, cockpit: scene.cockpit(窓の範囲とワイパー角), dry: トンネル内など */
  render(dt, v, cockpit, dry) {
    if (!this.active) return;
    const w = this.cv.width, h = this.cv.height, c = this.c;
    if (!w || !h) return;
    this.t += dt;
    const rects = (cockpit && cockpit.windowRects()) || [{ x0: 0, x1: 1, y0: 0, y1: 1 }];
    if (!dry) {
      for (let i = 0; i < 3; i++) {
        if (this.drops.length > 260) break;
        if (Math.random() < 0.8) {
          const r = rects[Math.random() < 0.75 ? 0 : rects.length - 1];
          this.drops.push({
            x: (r.x0 + Math.random() * (r.x1 - r.x0)) * w,
            y: (r.y0 + Math.random() * (r.y1 - r.y0)) * h,
            r: (0.9 + Math.random() * 2.4) * this.scale, vy: 0, life: 3 + Math.random() * 6,
          });
        }
      }
    }
    c.clearRect(0, 0, w, h);
    const wp = cockpit && cockpit.wiperScreen();
    this.drops = this.drops.filter((d) => {
      d.life -= dt * (dry ? 3 : 1);
      d.vy += dt * (7 + d.r * 8 + v * 0.45);
      d.y += d.vy * dt * this.scale;
      d.x += Math.sin(this.t * 3 + d.y * 0.02) * 0.25;
      /* ワイパーの腕に近い水滴は拭き取る */
      if (wp) {
        const px = wp.px * w, py = wp.py * h, len = wp.len * h;
        const dx = d.x - px, dy = d.y - py;
        const dist = Math.hypot(dx, dy);
        const da = Math.atan2(-dy, -dx);   // 腕は左(-x)向きを0として上へ回る
        if (dist < len && Math.abs(da - wp.ang) < 0.09) return false;
      }
      return d.life > 0 && d.y < h + 12;
    });
    c.save();
    c.beginPath();
    rects.forEach((r) => c.rect(r.x0 * w, r.y0 * h, (r.x1 - r.x0) * w, (r.y1 - r.y0) * h));
    c.clip();
    c.fillStyle = 'rgba(205,218,228,0.30)';
    for (const d of this.drops) {
      c.beginPath(); c.arc(d.x, d.y, d.r, 0, 7); c.fill();
    }
    c.restore();
  }
}
