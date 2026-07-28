/* =========================================================
 * cab/cab.js — 運転台の計器盤（DOM+Canvas 2D）
 * 針式速度計 / ノッチ表示 / ATS表示灯 / TIMS風モニタ
 * ========================================================= */
import { STATION_KANA } from '../sim/kana.js';

const $ = (s) => document.querySelector(s);

export class Cab {
  constructor(sim) {
    this.sim = sim;
    this.speedo = $('#speedo');
    this.ctx = this.speedo.getContext('2d');
    this.els = {
      notchList: $('#notch-list'),
      lampPat: $('#lamp-pattern'),
      lampBrk: $('#lamp-brake'),
      lampDoor: $('#lamp-door'),
      lampSlip: $('#lamp-slip'),
      timsNext: $('#tims-next'),
      timsDist: $('#tims-dist'),
      timsSch: $('#tims-sch'),
      timsClock: $('#tims-clock'),
      timsDelay: $('#tims-delay'),
      limNow: $('#lim-now'),
      limNext: $('#lim-next'),
      grade: $('#grade-ind'),
      bcBar: $('#bc-fill'),
      leverGrip: $('#lever-grip'),
    };
    this._buildNotch();
  }

  _buildNotch() {
    const items = [];
    for (let n = 4; n >= 1; n--) items.push(['P' + n, n]);
    items.push(['N', 0]);
    for (let n = 1; n <= 7; n++) items.push(['B' + n, -n]);
    items.push(['EB', -8]);
    this.els.notchList.innerHTML = items.map(([label, val]) =>
      `<div class="nt nt-${val < 0 ? (val === -8 ? 'eb' : 'b') : val > 0 ? 'p' : 'n'}" data-n="${val}">${label}</div>`).join('');
  }

  fmtClock(t) {
    /* ゲーム内時刻: 昼は10:00発、夜は19:00発 */
    const total = Math.floor(t) + (this.baseHour || 10) * 3600;
    const h = Math.floor(total / 3600) % 24;
    const m = Math.floor((total % 3600) / 60);
    const s = Math.floor(total % 60);
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  render() {
    const sim = this.sim;
    const h = sim.hud();

    /* ---- レバーの持ち手を現在ノッチ位置へ動かす ---- */
    if (this._lastNotch !== sim.notch) {
      this._lastNotch = sim.notch;
      const idx = sim.notch === -8 ? 12 : 4 - sim.notch;
      const frac = idx / 12;
      this.els.leverGrip.style.top = `calc(${(frac * 100).toFixed(2)}% - ${(frac * 34).toFixed(1)}px)`;
      this.els.leverGrip.textContent = sim.notch === -8 ? 'EB'
        : sim.notch > 0 ? 'P' + sim.notch
        : sim.notch < 0 ? 'B' + (-sim.notch) : 'N';
      this.els.leverGrip.className = 'lever-grip ' + (sim.notch === -8 ? 'lg-eb'
        : sim.notch > 0 ? 'lg-p' : sim.notch < 0 ? 'lg-b' : 'lg-n');
    }

    /* ---- 速度計 ---- */
    const c = this.ctx, W = this.speedo.width, R = W / 2;
    c.clearRect(0, 0, W, W);
    c.save();
    c.translate(R, R);
    /* 文字盤 */
    c.fillStyle = '#101315';
    c.beginPath(); c.arc(0, 0, R - 2, 0, Math.PI * 2); c.fill();
    c.strokeStyle = '#3a4147'; c.lineWidth = 2;
    c.beginPath(); c.arc(0, 0, R - 3, 0, Math.PI * 2); c.stroke();
    const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
    const angOf = (v) => a0 + (a1 - a0) * (v / 120);
    /* 制限速度の赤アーク */
    c.strokeStyle = 'rgba(255,70,60,.8)'; c.lineWidth = 5;
    c.beginPath(); c.arc(0, 0, R - 12, angOf(Math.min(120, h.limit)), a1); c.stroke();
    /* ATSパターンの橙マーク */
    if (h.ats && h.ats.pattern < 130) {
      c.strokeStyle = '#ff9d2e'; c.lineWidth = 5;
      const pa = angOf(Math.min(119, h.ats.pattern));
      c.beginPath(); c.arc(0, 0, R - 12, pa - 0.03, pa + 0.03); c.stroke();
    }
    /* 目盛り */
    for (let v = 0; v <= 120; v += 5) {
      const a = angOf(v);
      const big = v % 20 === 0;
      c.strokeStyle = big ? '#cfd6da' : '#5c656b';
      c.lineWidth = big ? 2.4 : 1.2;
      c.beginPath();
      c.moveTo(Math.cos(a) * (R - 16), Math.sin(a) * (R - 16));
      c.lineTo(Math.cos(a) * (R - (big ? 30 : 24)), Math.sin(a) * (R - (big ? 30 : 24)));
      c.stroke();
      if (big) {
        c.fillStyle = '#cfd6da';
        c.font = `600 ${R * 0.155}px "Zen Kaku Gothic New", sans-serif`;
        c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(String(v), Math.cos(a) * (R - 45), Math.sin(a) * (R - 45));
      }
    }
    /* 針 */
    const av = angOf(Math.min(120, h.v));
    c.strokeStyle = '#ff5f4e'; c.lineWidth = 4; c.lineCap = 'round';
    c.beginPath(); c.moveTo(Math.cos(av + Math.PI) * 14, Math.sin(av + Math.PI) * 14);
    c.lineTo(Math.cos(av) * (R - 34), Math.sin(av) * (R - 34)); c.stroke();
    c.fillStyle = '#2b3237';
    c.beginPath(); c.arc(0, 0, 9, 0, Math.PI * 2); c.fill();
    /* デジタル速度 */
    c.fillStyle = '#e8f2f6';
    c.font = `700 ${R * 0.30}px "Zen Kaku Gothic New", sans-serif`;
    c.textAlign = 'center';
    c.fillText(String(Math.floor(h.v)), 0, R * 0.48);
    c.font = `500 ${R * 0.11}px sans-serif`;
    c.fillStyle = '#7d8890';
    c.fillText('km/h', 0, R * 0.66);
    c.restore();

    /* ---- BC圧（ブレーキシリンダ相当） ---- */
    this.els.bcBar.style.width = `${Math.min(100, (h.bc / 4.6) * 100)}%`;

    /* ---- ノッチ ---- */
    [...this.els.notchList.children].forEach((el) => {
      el.classList.toggle('on', Number(el.dataset.n) === h.notch);
    });

    /* ---- 表示灯 ---- */
    this.els.lampPat.classList.toggle('on', h.atsLamp === 'pattern' || h.atsLamp === 'brake');
    this.els.lampBrk.classList.toggle('on', h.atsLamp === 'brake');
    this.els.lampDoor.classList.toggle('on', h.doorOpen);
    this.els.lampSlip.classList.toggle('on', !!h.slipping);

    /* ---- TIMS ---- */
    if (h.next) {
      if (this._nextName !== h.next.name) {
        this._nextName = h.next.name;
        this.els.timsNext.innerHTML = `${h.next.name}<span class="tims-kana">${STATION_KANA[h.next.name] || ''}</span>`;
      }
      const d = Math.max(0, h.next.dist);
      this.els.timsDist.textContent = d >= 1000 ? (d / 1000).toFixed(2) + ' km' : Math.round(d) + ' m';
      this.els.timsSch.textContent = '着 ' + this.fmtClock(h.next.arr);
      const delta = Math.round(sim.t - h.next.arr + Math.min(0, 0));
      const early = h.next.arr - sim.t;
      this.els.timsDelay.textContent = early >= 0
        ? `じかんまで ${Math.floor(early / 60)}:${String(Math.floor(early % 60)).padStart(2, '0')}`
        : `おくれ ${Math.floor(-early / 60)}:${String(Math.floor(-early % 60)).padStart(2, '0')}`;
      this.els.timsDelay.classList.toggle('late', early < 0);
    } else {
      this._nextName = null;
      this.els.timsNext.textContent = '—';
      this.els.timsDist.textContent = '';
      this.els.timsSch.textContent = '';
      this.els.timsDelay.textContent = '';
    }
    this.els.timsClock.textContent = this.fmtClock(sim.t);

    /* ---- 制限表示 ---- */
    this.els.limNow.textContent = h.limit;
    if (h.ats && h.ats.kind === 'limit') {
      const d = Math.max(0, Math.round(h.ats.at - h.pos));
      this.els.limNext.textContent = `▼${h.ats.target}  ${d}m`;
      this.els.limNext.classList.remove('hidden');
    } else if (h.ats && h.ats.kind === 'signal') {
      const d = Math.max(0, Math.round(h.ats.at - h.pos));
      this.els.limNext.textContent = `信号 ${h.ats.target === 0 ? '停止' : h.ats.target}  ${d}m`;
      this.els.limNext.classList.remove('hidden');
    } else {
      this.els.limNext.classList.add('hidden');
    }

    /* ---- 勾配 ---- */
    const g = h.grade;
    this.els.grade.textContent = Math.abs(g) < 1.5 ? 'ー 平坦' : (g > 0 ? `／ 上り ${g.toFixed(0)}‰` : `＼ 下り ${(-g).toFixed(0)}‰`);
  }
}
