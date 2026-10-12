/* =========================================================
 * scene/signage.js — 標識・駅名標・信号機・ATS地上子・発車標(LED)
 * ・看板はすべて「支柱に立つ／つり下がる」。裏は灰色の金属板(裏から見ても消えない)
 * ・同じ材質の板は1つのジオメトリにまとめて描く(描画回数を減らす)
 * ・線路わきの小さな標識(制限・解除・8・予告・キロ程)は1枚の画像(アトラス)にまとめる
 * ・信号機は全線ぶんを数回の描画で(4灯式: 上から 黄・緑・赤・黄)
 * 文字はかな優先(小2でも読める)。鉄道会社の駅番号(英字+数字)は出さない。
 * ========================================================= */
import * as THREE from '../vendor/three.module.min.js';
import { STATION_KANA } from '../sim/kana.js';
import { fixAdditiveFog } from './lightpool.js';
import { quadInfo, quadOffAt, quadSep } from './trackbed.js';

export const FONT = '"Zen Kaku Gothic New", "Hiragino Sans", "Hiragino Kaku Gothic ProN", Meiryo, sans-serif';
export const kanaOf = (name) => STATION_KANA[name] || name || '';
const UPV = new THREE.Vector3(0, 1, 0);

/* ---------- 線形の補間(割り当てなし。毎フレームの処理でも使える) ---------- */
export const newFrame = () => ({ p: new THREE.Vector3(), t: new THREE.Vector3(), left: new THREE.Vector3() });
export function frameInto(rs, s, out) {
  const F = rs.frames;
  const f = s / rs.step;
  const i = Math.max(0, Math.min(F.length - 2, Math.floor(f)));
  const k = Math.min(1, Math.max(0, f - i));
  out.p.copy(F[i].p).lerp(F[i + 1].p, k);
  out.t.copy(F[i].t).lerp(F[i + 1].t, k).normalize();
  out.left.copy(F[i].left).lerp(F[i + 1].left, k).normalize();
  return out;
}
export const frameOf = (rs, s) => frameInto(rs, s, newFrame());

/* 水平にならした進行方向(勾配で看板や柱が傾かないように) */
export function flatT(f, out = new THREE.Vector3()) {
  return out.set(f.t.x, 0, f.t.z).normalize();
}

/* ---------- キャンバス ---------- */
export function canvasTexture(w, h, draw, opt = {}) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const c = cv.getContext('2d');
  draw(c, w, h);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = opt.aniso || 4;
  t.wrapS = opt.wrapS || THREE.ClampToEdgeWrapping;
  t.wrapT = opt.wrapT || THREE.ClampToEdgeWrapping;
  /* 文字のフォントが読み込まれたあとに描き直す用 */
  t.userData.redraw = () => { c.clearRect(0, 0, w, h); draw(c, w, h); t.needsUpdate = true; };
  return t;
}

/* Webフォント(Zen Kaku Gothic New)が後から届いたら、文字の入ったキャンバスを1回だけ描き直す。
 * 3つの太さが そろっていると わかった文字は おぼえて(_fontOk)、つぎからは しらべない
 * (毎回の document.fonts.check をやめる。日本語のフォントは 文字の グループごとに 読みこむので、
 *  ひとつの フラグではなく 文字ごとに おぼえる。全部 わかっている文字なら すぐ もどる) */
const _fontOk = new Set();
const fontsKnown = (text) => {
  for (const ch of text) if (!_fontOk.has(ch)) return false;
  return true;
};
let _fontQ = null;
export function redrawWhenFonts(tex, text) {
  if (typeof document === 'undefined' || !document.fonts || !document.fonts.load) return;
  if (fontsKnown(text || '')) return;
  if (!_fontQ) {
    const q = _fontQ = { texs: new Set(), text: '' };
    Promise.resolve().then(() => {
      _fontQ = null;
      const specs = ['900', '700', '500'].map((w) => `${w} 40px "Zen Kaku Gothic New"`);
      const txt = q.text || 'あ';
      const ok = () => { for (const ch of txt) _fontOk.add(ch); };
      if (specs.every((s) => { try { return document.fonts.check(s, txt); } catch (e) { return false; } })) { ok(); return; }
      Promise.all(specs.map((s) => document.fonts.load(s, txt))).then(() => {
        ok();
        q.texs.forEach((t) => { if (t.userData.redraw) t.userData.redraw(); });
      }).catch(() => {});
    });
  }
  _fontQ.texs.add(tex);
  _fontQ.text += text;
}

/* 幅に収まるよう文字を縮めて書く */
export function fitText(c, text, x, y, maxW, size, weight = 700, align = 'center') {
  let s = size;
  c.font = `${weight} ${s}px ${FONT}`;
  const w = c.measureText(text).width;
  if (w > maxW) { s = Math.max(8, Math.floor((s * maxW) / w)); c.font = `${weight} ${s}px ${FONT}`; }
  c.textAlign = align;
  c.textBaseline = 'middle';
  c.fillText(text, x, y);
}

/* 字間をあけて書く(英字の駅名) */
function spacedText(c, text, cx, y, size, weight, gap) {
  c.font = `${weight} ${size}px ${FONT}`;
  c.textAlign = 'left';
  c.textBaseline = 'middle';
  const ws = [...text].map((ch) => c.measureText(ch).width);
  const total = ws.reduce((a, b) => a + b, 0) + gap * Math.max(0, ws.length - 1);
  let x = cx - total / 2;
  [...text].forEach((ch, i) => { c.fillText(ch, x, y); x += ws[i] + gap; });
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

/* ---------- 駅名標(ひらがなが いちばん大きい) ----------
 * 512x216: 上0〜176=表(なまえ+となりの駅の帯)、178〜216=となりの駅を左右入れかえた帯(裏面用)
 * 裏から見ると左右が逆になるので、帯だけ差し替えて矢印の向きを実際の方向に合わせる */
export const SIGN_H = 216;
export const SIGN_UV = {
  name: [0, 1 - 138 / SIGN_H, 1, 1],          // なまえの部分だけ(つり下げ・ホーム端の看板)
  band: [0, 1 - 176 / SIGN_H, 1, 1 - 138 / SIGN_H],
  alt: [0, 1 - 216 / SIGN_H, 1, 1 - 178 / SIGN_H],
};
export function texStationSign(st, prev, next, num) {
  const band = (c, y0, l, r) => {
    c.fillStyle = '#2d3a46'; c.fillRect(0, y0, 512, 38);
    c.fillStyle = '#ffffff';
    if (l) {
      fitText(c, `◀ ${kanaOf(l.name)}`, 14, y0 + 13, 230, 17, 700, 'left');
      c.fillStyle = '#c3ccd4'; fitText(c, l.name, 34, y0 + 29, 210, 11, 500, 'left'); c.fillStyle = '#ffffff';
    }
    if (r) {
      fitText(c, `${kanaOf(r.name)} ▶`, 498, y0 + 13, 230, 17, 700, 'right');
      c.fillStyle = '#c3ccd4'; fitText(c, r.name, 478, y0 + 29, 210, 11, 500, 'right');
    }
  };
  const t = canvasTexture(512, SIGN_H, () => {});
  const c = t.image.getContext('2d');
  const draw = () => {
    const d = t.userData.sta;
    if (!d) return;
    c.fillStyle = '#f7f8f6'; c.fillRect(0, 0, 512, SIGN_H);
    /* ならび順の番号だけの小さな札(会社の記号はつけない) */
    c.fillStyle = '#2b3640'; roundRect(c, 14, 12, 40, 30, 7); c.fill();
    c.fillStyle = '#ffffff'; fitText(c, String(d.num), 34, 28, 34, 20, 700);
    c.fillStyle = '#16212b'; fitText(c, kanaOf(d.st.name), 256, 56, 400, 58, 900);
    c.fillStyle = '#16212b'; fitText(c, d.st.name, 256, 99, 440, 28, 700);
    c.fillStyle = '#56616b'; spacedText(c, d.st.en || '', 256, 124, 15, 500, 1);
    band(c, 138, d.prev, d.next);
    c.strokeStyle = '#2b3640'; c.lineWidth = 4; c.strokeRect(2, 2, 508, 172);
    band(c, 178, d.next, d.prev);
    t.needsUpdate = true;
  };
  t.userData.redraw = draw;
  /* 駅を差しかえて描き直す(近くの駅だけ本物の画像を持つため) */
  t.userData.setStation = (sta) => {
    t.userData.sta = sta;
    draw();
    const { st: s0, prev: p, next: n } = sta;
    redrawWhenFonts(t, kanaOf(s0.name) + s0.name + (s0.en || '') + (p ? kanaOf(p.name) + p.name : '') + (n ? kanaOf(n.name) + n.name : '') + '◀▶0123456789');
  };
  if (st) t.userData.setStation({ st, prev, next, num });
  return t;
}

/* 遠くの駅用の代わりの小さな画像(白い板+下の濃い帯。遠くでは文字は読めないので) */
export function texSignPlaceholder() {
  return canvasTexture(64, 27, (c) => {
    c.fillStyle = '#f7f8f6'; c.fillRect(0, 0, 64, 27);
    c.fillStyle = '#7d858c'; c.fillRect(18, 5, 28, 6);
    c.fillStyle = '#a3aab0'; c.fillRect(22, 13, 20, 3);
    c.fillStyle = '#2d3a46'; c.fillRect(0, 17, 64, 5);
    c.fillStyle = '#2d3a46'; c.fillRect(0, 22, 64, 5);
  });
}

/* ---------- まとめ描き(Baker) ----------
 * 同じ材質の部品を、世界座標の1つのジオメトリに焼きこむ(描画1回)。
 * 頂点色(sRGBで指定→リニア)・UV(白いマスを指せば頂点色だけの部品になる)・自発光フラグ stE をもつ */
const _bv = new THREE.Vector3(), _bnv = new THREE.Vector3(), _nm = new THREE.Matrix3(), _bcol = new THREE.Color();
const _r = new THREE.Vector3(), _q = new THREE.Vector3(), _pm = new THREE.Matrix4();
let POST_GEO = null;
export class Baker {
  constructor(mat, o = {}) {
    this.mat = mat; this.o = o;
    this.white = o.white || [0.5, 0.5];
    this.P = []; this.N = []; this.U = []; this.C = []; this.E = []; this.I = []; this.n = 0;
  }
  /* o.m: 行列 / o.col: 色(16進。頂点色があれば掛け合わせ) / o.white: UVを白いマスへ / o.e: 自発光 */
  geo(g, o = {}) {
    const pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv, gc = g.attributes.color;
    if (o.m) _nm.getNormalMatrix(o.m);
    let cr = 1, cg = 1, cb = 1;
    if (o.col != null) { _bcol.set(o.col); cr = _bcol.r; cg = _bcol.g; cb = _bcol.b; }
    const base = this.n, e = o.e || 0, wu = this.white[0], wv = this.white[1];
    for (let i = 0; i < pos.count; i++) {
      _bv.fromBufferAttribute(pos, i);
      if (o.m) _bv.applyMatrix4(o.m);
      this.P.push(_bv.x, _bv.y, _bv.z);
      if (nor) { _bnv.fromBufferAttribute(nor, i); if (o.m) _bnv.applyMatrix3(_nm).normalize(); } else _bnv.set(0, 1, 0);
      this.N.push(_bnv.x, _bnv.y, _bnv.z);
      if (o.white || !uv) this.U.push(wu, wv); else this.U.push(uv.getX(i), uv.getY(i));
      if (gc) this.C.push(gc.getX(i) * cr, gc.getY(i) * cg, gc.getZ(i) * cb); else this.C.push(cr, cg, cb);
      this.E.push(e);
    }
    if (g.index) { const a = g.index.array; for (let k = 0; k < a.length; k++) this.I.push(base + a[k]); } else for (let k = 0; k < pos.count; k++) this.I.push(base + k);
    this.n += pos.count;
    return this;
  }
  /* 四角い板。c=中心, n=表の向き(水平), uv=[u0,v0,u1,v1](nullなら白いマス), e=自発光(0〜1) */
  quad(c, n, w, h, uv, col, e = 0) {
    _r.crossVectors(UPV, n).normalize();
    const base = this.n;
    if (col != null) _bcol.set(col); else _bcol.setRGB(1, 1, 1);
    [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([sx, sy]) => {
      _q.copy(c).addScaledVector(_r, (sx * w) / 2);
      _q.y += (sy * h) / 2;
      this.P.push(_q.x, _q.y, _q.z);
      this.N.push(n.x, n.y, n.z);
      if (uv) this.U.push(sx < 0 ? uv[0] : uv[2], sy < 0 ? uv[1] : uv[3]); else this.U.push(this.white[0], this.white[1]);
      this.C.push(_bcol.r, _bcol.g, _bcol.b);
      this.E.push(e);
    });
    this.I.push(base, base + 1, base + 2, base, base + 2, base + 3);
    this.n += 4;
    return this;
  }
  /* 床に寝かせた四角(上向き)。c=中心, t=横(u)の向き(水平), w=t方向の長さ, d=奥行き(v。t の左手側が +v) */
  quadFlat(c, t, w, d, uv, col, e = 0) {
    _r.copy(t).setY(0).normalize();
    _q.crossVectors(UPV, _r);              // t の左手(上から見て反時計まわり90°)
    const base = this.n;
    if (col != null) _bcol.set(col); else _bcol.setRGB(1, 1, 1);
    [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([sx, sy]) => {
      this.P.push(c.x + _r.x * (sx * w) / 2 + _q.x * (sy * d) / 2, c.y, c.z + _r.z * (sx * w) / 2 + _q.z * (sy * d) / 2);
      this.N.push(0, 1, 0);
      if (uv) this.U.push(sx < 0 ? uv[0] : uv[2], sy < 0 ? uv[1] : uv[3]); else this.U.push(this.white[0], this.white[1]);
      this.C.push(_bcol.r, _bcol.g, _bcol.b);
      this.E.push(e);
    });
    this.I.push(base, base + 1, base + 2, base, base + 2, base + 3);
    this.n += 4;
    return this;
  }
  /* 細い支柱(根元x,y,z・高さh) */
  post(x, y, z, h, col = 0x9da3a8, r = 1) {
    if (!(h > 0.02)) return this;
    if (!POST_GEO) POST_GEO = new THREE.CylinderGeometry(0.035, 0.035, 1, 6, 1, true).translate(0, 0.5, 0);
    _pm.makeScale(r, h, r).setPosition(x, y, z);
    return this.geo(POST_GEO, { m: _pm, col, white: true });
  }
  build(rs, o = {}) {
    if (!this.n) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.U, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.C, 3));
    if (this.o.e) g.setAttribute('stE', new THREE.Float32BufferAttribute(this.E, 1));
    g.setIndex(this.n > 65535 ? new THREE.Uint32BufferAttribute(this.I, 1) : new THREE.Uint16BufferAttribute(this.I, 1));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, this.mat);
    m.castShadow = !!o.cast; m.receiveShadow = o.recv !== false;
    m.userData.st = true; m.userData.noMerge = true;
    if (o.order != null) m.renderOrder = o.order;
    rs.world.add(m);
    this.P = this.N = this.U = this.C = this.E = this.I = null;
    return m;
  }
}

/* 世界ごとのまとめ描き置き場: key(材質など) → Baker */
export function bakerFor(rs, key, mat, o) {
  if (!rs._signs) rs._signs = new Map();
  let b = rs._signs.get(key);
  if (!b) { b = new Baker(mat || key, o); b.buildOpt = (o && o.build) || {}; rs._signs.set(key, b); }
  return b;
}
/* 置き場のぶんを世界に出す(建設の最後に1回) */
export function flushSigns(rs) {
  if (!rs._signs) return;
  rs._signs.forEach((b) => b.build(rs, b.buildOpt));
  rs._signs = null;
}

/* ---------- 線路わきの小さな標識(1枚の画像にまとめる) ----------
 * 1024x512 を 128px のマスに分け、キロ程・番線は 64px の小マス。右下のマスは白(支柱・裏板の頂点色用)。
 * 板の表・灰色の裏・支柱を全線で1つの形にまとめる(描画1回)。
 * rs._texCache: key → { tex, mat, uv }  (lim:速度 / kai / stop8 / appr:距離 / km:キロ / nori:番線) */
function boardAtlas(rs) {
  if (rs._atlas) return rs._atlas;
  const W = 1024, H = 512, C = 128;
  const cells = [];          // [x, y, size, draw]
  let next = 0, small = null;
  const draw = (c) => {
    c.fillStyle = '#8a9096'; c.fillRect(0, 0, W, H);
    c.fillStyle = '#ffffff'; c.fillRect(W - C, H - C, C, C);
    cells.forEach(([x, y, s, fn]) => { c.save(); c.translate(x, y); fn(c, s); c.restore(); });
  };
  const tex = canvasTexture(W, H, draw, { aniso: 4 });
  const ctx = tex.image.getContext('2d');
  const mat = new THREE.MeshStandardMaterial({
    map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.12, roughness: 0.6, vertexColors: true,
    /* 空の映りこみで黒い数字が灰色に・黄色が白っぽくならないよう、環境光の反射は控えめに */
    envMapIntensity: 0.3,
  });
  mat.name = 'st-lineside';
  /* 光るのは板の表(絵)だけ。支柱・灰色の裏・キロ程の杭は アトラスの白いマスを指すので、
   * そのままだと夜に白く光ってしまう → 頂点の自発光フラグ stE を掛けて消す */
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float stE;\nvarying float vStE;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvStE = stE;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vStE;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= vStE;');
  };
  mat.customProgramCacheKey = () => 'st-lineside';
  const A = rs._atlas = { tex, mat, text: '', white: [1 - C / 2 / W, C / 2 / H] };
  const CELLS = (W / C) * (H / C) - 1;   // 右下の白いマスの ぶんを のこす
  /* 新しいマスが まだ入るか(reserve = あとで作る標識のために のこしておく 大きいマスの数) */
  A.room = (isSmall, reserve) => (isSmall && small && small.k < 4) || next < CELLS - (reserve || 0);
  A.used = () => next;
  A.cell = (key, fn, isSmall) => {
    let x, y, s;
    if (isSmall) {
      if (!small || small.k >= 4) { small = { x: (next % 8) * C, y: Math.floor(next / 8) * C, k: 0 }; next++; }
      x = small.x + (small.k % 2) * 64; y = small.y + Math.floor(small.k / 2) * 64; s = 64; small.k++;
    } else {
      x = (next % 8) * C; y = Math.floor(next / 8) * C; s = C; next++;
    }
    cells.push([x, y, s, fn]);
    ctx.save(); ctx.translate(x, y); fn(ctx, s); ctx.restore();
    tex.needsUpdate = true;
    const g = 1.5;   // にじみ止めのすき間
    return [(x + g) / W, 1 - (y + s - g) / H, (x + s - g) / W, 1 - (y + g) / H];
  };
  return A;
}
/* 線路わきの標識の置き場(全線で1つ) */
export function lineBaker(rs) {
  const A = boardAtlas(rs);
  return bakerFor(rs, 'line', A.mat, { white: A.white, e: true, build: {} });
}

/* 四角い標識の絵(背景・枠・文字) */
const boardDraw = (bg, fg, text, size, weight = 900, border = '#111') => (c, s) => {
  const k = s / 128;
  c.fillStyle = bg; c.fillRect(0, 0, s, s);
  c.strokeStyle = border; c.lineWidth = 7 * k; c.strokeRect(6 * k, 6 * k, s - 12 * k, s - 12 * k);
  c.fillStyle = fg;
  fitText(c, text, s / 2, s / 2 + 4 * k, s - 20 * k, size * k, weight);
};

/* 停止位置の予告: 大きな数字(板の高さの2/3)と小さな m。100・50 は上に紺の帯「とまる まで」
 * (速度制限の黄色い板と見まちがえない)。300・200 は帯なしで数字をいちばん大きく(遠くから読める) */
const drawAppr = (val) => (c, s) => {
  const k = s / 128;
  const band = val === '100' || val === '50';
  c.fillStyle = '#f6f6f2'; c.fillRect(0, 0, s, s);
  c.strokeStyle = '#1f3a5f'; c.lineWidth = 6 * k; c.strokeRect(3 * k, 3 * k, s - 6 * k, s - 6 * k);
  if (band) {
    c.fillStyle = '#1f3a5f'; c.fillRect(0, 0, s, 27 * k);
    c.fillStyle = '#ffffff'; fitText(c, 'とまる まで', s / 2, 15 * k, s - 18 * k, 18 * k, 700);
  }
  const maxW = s - 12 * k, gap = 2 * k, ms = 26 * k;
  let ns = 84 * k;
  c.font = `900 ${ns}px ${FONT}`;
  let nw = c.measureText(val).width;
  c.font = `700 ${ms}px ${FONT}`;
  const mw = c.measureText('m').width;
  /* 3けたは横だけ少し細くして、字の高さ(84px)を保つ */
  let sx = 1;
  if (nw + gap + mw > maxW) sx = Math.max(0.62, (maxW - gap - mw) / nw);
  if (nw * sx + gap + mw > maxW) { ns = Math.floor((ns * (maxW - gap - mw)) / (nw * sx)); c.font = `900 ${ns}px ${FONT}`; nw = c.measureText(val).width; }
  const tw = nw * sx + gap + mw;
  const x0 = s / 2 - tw / 2, yb = (band ? 27 + (128 - 27) / 2 + 30 : 64 + 30) * k;
  c.fillStyle = '#111111'; c.textAlign = 'left'; c.textBaseline = 'alphabetic';
  c.save(); c.translate(x0, yb); c.scale(sx, 1);
  c.font = `900 ${ns}px ${FONT}`; c.fillText(val, 0, 0);
  c.restore();
  c.font = `700 ${ms}px ${FONT}`; c.fillText('m', x0 + nw * sx + gap, yb);
};
/* 踏切警標(×印)の黄と黒のななめの しま */
const drawXbuck = (c, s) => {
  c.fillStyle = '#e8d22c'; c.fillRect(0, 0, s, s);
  c.fillStyle = '#16161a';
  const k = s / 8;
  for (let x = -s; x < 2 * s; x += 2 * k) {
    c.beginPath(); c.moveTo(x, s); c.lineTo(x + k, s); c.lineTo(x + k + s, 0); c.lineTo(x + s, 0); c.closePath(); c.fill();
  }
};
/* 道路の「とまれ」(踏切の手前の路面。舗装の色の地に白い字。上が とまる線のほう) */
const drawTomare = (c, s) => {
  c.fillStyle = '#54585c'; c.fillRect(0, 0, s, s);
  c.fillStyle = 'rgba(0,0,0,0.08)';
  for (let i = 0; i < 40; i++) c.fillRect((i * 37) % s, (i * 61) % s, 2, 2);
  c.fillStyle = '#ecece6';
  fitText(c, 'とまれ', s / 2, s / 2 + 2, s - 8, s * 0.42, 900);
};
/* 勾配標(こうばいひょう): 白い板に 黒い腕(のぼり=右上がり / くだり=右下がり / たいら=水平)と、
 * 1000m で なんm のぼる(くだる)かの数字(‰。運転台は数字を出さず 棒1〜3本で きつさを出す)。0 は「たいら」 */
const drawGrad = (g) => (c, s) => {
  const k = s / 64;
  c.fillStyle = '#f4f4f0'; c.fillRect(0, 0, s, s);
  c.strokeStyle = '#16191c'; c.lineWidth = 3 * k; c.strokeRect(2 * k, 2 * k, s - 4 * k, s - 4 * k);
  const dy = g > 0 ? -7 : g < 0 ? 7 : 0;
  c.lineCap = 'round'; c.lineWidth = 5 * k;
  c.beginPath(); c.moveTo(11 * k, (17 - dy) * k); c.lineTo(53 * k, (17 + dy) * k); c.stroke();
  c.fillStyle = '#111111';
  if (g === 0) fitText(c, 'たいら', s / 2, 45 * k, s - 10 * k, 18 * k, 900);
  else fitText(c, String(Math.abs(g)), s / 2, 45 * k, s - 12 * k, 34 * k, 900);
};
/* ホームの端の柵の札「この さき はいれません」(白地に赤いふち) */
const drawNoEntry = (c, s) => {
  const k = s / 128;
  c.fillStyle = '#ffffff'; c.fillRect(0, 0, s, s);
  c.strokeStyle = '#c8281e'; c.lineWidth = 10 * k; c.strokeRect(5 * k, 5 * k, s - 10 * k, s - 10 * k);
  c.fillStyle = '#1a1d20'; fitText(c, 'この さき', s / 2, 44 * k, s - 30 * k, 26 * k, 900);
  c.fillStyle = '#c8281e'; fitText(c, 'はいれません', s / 2, 84 * k, s - 26 * k, 25 * k, 900);
};
/* 運転士用モニターの画面: 停まっている電車の横とホーム(遠近)・黄色い線・人が3人 */
const drawItv = (c, s) => {
  const k = s / 128;
  c.fillStyle = '#0d1620'; c.fillRect(0, 0, s, s);
  const x0 = 6 * k, y0 = 6 * k, w = s - 12 * k, h = s - 12 * k;
  c.fillStyle = '#4b5d6e'; c.fillRect(x0, y0, w, h);                         // 屋根の下のかべ
  c.fillStyle = '#9fa5a8';                                                    // ホーム(手前が広い)
  c.beginPath(); c.moveTo(x0 + w * 0.42, y0 + h * 0.42); c.lineTo(x0 + w, y0 + h * 0.42); c.lineTo(x0 + w, y0 + h); c.lineTo(x0, y0 + h); c.closePath(); c.fill();
  c.fillStyle = '#c9cdd0';                                                    // 電車の横
  c.beginPath(); c.moveTo(x0, y0 + h * 0.12); c.lineTo(x0 + w * 0.42, y0 + h * 0.36); c.lineTo(x0 + w * 0.42, y0 + h * 0.48); c.lineTo(x0, y0 + h * 0.86); c.closePath(); c.fill();
  c.fillStyle = '#2b3a48';
  for (let i = 0; i < 4; i++) { const t0 = i * 0.24 + 0.02, t1 = t0 + 0.12; c.fillRect(x0 + w * 0.42 * t0, y0 + h * (0.3 + 0.12 * (1 - t0)) - 4 * k, w * 0.42 * (t1 - t0), 9 * k * (1.4 - t0)); }
  c.strokeStyle = '#e0c03a'; c.lineWidth = 4 * k;                             // 黄色い線
  c.beginPath(); c.moveTo(x0 + w * 0.44, y0 + h * 0.46); c.lineTo(x0 + w * 0.18, y0 + h); c.stroke();
  c.fillStyle = '#2a2f36';
  [[0.62, 0.62, 1], [0.78, 0.55, 0.8], [0.55, 0.8, 1.3]].forEach(([u, v, z]) => {
    c.fillRect(x0 + w * u - 3 * k * z, y0 + h * v - 16 * k * z, 6 * k * z, 16 * k * z);
    c.beginPath(); c.arc(x0 + w * u, y0 + h * v - 19 * k * z, 3.2 * k * z, 0, 7); c.fill();
  });
  c.fillStyle = 'rgba(255,255,255,0.08)'; c.fillRect(x0, y0, w, h * 0.5);    // 画面の映りこみ
};

export function lineBoard(rs, key) {
  if (!rs._texCache) rs._texCache = new Map();
  const hit = rs._texCache.get(key);
  if (hit) return hit;
  const A = boardAtlas(rs);
  let fn, small = false;
  const [kind, val] = key.split(':');
  if (kind === 'lim') fn = boardDraw('#e8bf1f', '#111111', val, val.length > 2 ? 72 : 88);
  else if (kind === 'kai') fn = boardDraw('#f4f4f0', '#111111', '解', 78);
  /* 停止位置目標: 黒い板に白い8・白いふち(画面の「8」の目印・判定カード・ブレーキめやすと おなじ見た目。
   * 夜は 線路わきの自発光で 白い数字が すこし光る) */
  else if (kind === 'stop8') fn = boardDraw('#0b0d0f', '#ffffff', '8', 100, 900, '#ffffff');
  else if (kind === 'appr') fn = drawAppr(val);
  else if (kind === 'noent') fn = drawNoEntry;
  else if (kind === 'itv') fn = drawItv;
  else if (kind === 'xbuck') fn = drawXbuck;
  else if (kind === 'tomare') fn = drawTomare;
  else if (kind === 'km') { fn = boardDraw('#f2f2ee', '#16283a', val, val.length > 1 ? 70 : 84, 900, '#16283a'); small = true; }
  else if (kind === 'nori') { fn = boardDraw('#20272d', '#ffffff', val, 88, 900, '#f2c230'); small = true; }
  else if (kind === 'grad') { fn = drawGrad(+val); small = true; }
  else fn = boardDraw('#ffffff', '#111111', val || key, 60);
  const uv = A.cell(key, fn, small);
  A.text += (val || '') + '解8' + (kind === 'appr' ? 'とまるでm' : kind === 'noent' ? 'このさきはいれません' : kind === 'tomare' ? 'とまれ' : kind === 'grad' ? 'たいら' : '');
  const ent = { tex: A.tex, mat: A.mat, uv };
  rs._texCache.set(key, ent);
  return ent;
}
export function finishAtlas(rs) {
  if (rs._atlas) redrawWhenFonts(rs._atlas.tex, rs._atlas.text);
}

/* 看板1枚(線路わきの標識): 表(絵)＋灰色の金属の裏＋支柱。裏から見ても消えない
 * o: { c:中心, n:表の向き, postH, yBase, legs:[横のずれ...] } */
export function makeSign(rs, key, w, h, o) {
  const b = lineBoard(rs, key);
  const B = lineBaker(rs);
  B.quad(o.c, o.n, w, h, b.uv, null, 1);        // 表だけ光る(裏・支柱は光らない)
  _bn.copy(o.n).negate();
  _bc.copy(o.c).addScaledVector(o.n, -0.02);
  B.quad(_bc, _bn, w, h, null, 0x8a9096);
  if (o.postH > 0) {
    _r.crossVectors(UPV, o.n).normalize();
    (o.legs || [0]).forEach((dx) => {
      B.post(o.c.x + _r.x * dx - o.n.x * 0.05, o.yBase, o.c.z + _r.z * dx - o.n.z * 0.05, o.postH);
    });
  }
}
const _bn = new THREE.Vector3(), _bc = new THREE.Vector3();

/* ---------- 線路わきの標識の配置(制限・解除・予告・キロ程) ----------
 * plat: { L:{edge,back} } / inPlat(s): ホームの範囲か / ahead: 停止位置目標「8」の停止位置からの位置 */
export function buildBoards(rs, plat, inPlat, ahead) {
  const A8 = typeof ahead === 'number' ? ahead : 4.5;
  const L = rs.line.meta.length;
  const f = newFrame(), n = new THREE.Vector3(), c = new THREE.Vector3();
  const face = (s, lat, yBase, key, w, postGap, noPost) => {
    frameInto(rs, s, f);
    flatT(f, n).negate();               // 近づいてくる列車のほうを向く
    c.copy(f.p).addScaledVector(f.left, lat);
    c.y += yBase + postGap + w / 2;
    makeSign(rs, key, w, w, { c, n, postH: noPost ? 0 : postGap + w * 0.85, yBase: f.p.y + yBase });
  };
  /* 制限速度と解除(板の下端はレール面から1.25m。ホームの上ならホーム面から) */
  rs.line.limits.forEach((z) => {
    const s1 = Math.max(5, z.from - 15), s2 = Math.min(L - 5, z.to + 10);
    face(s1, 2.3, inPlat(s1) ? 1.05 : 0, `lim:${z.v}`, 0.7, 1.25);
    face(s2, 2.3, inPlat(s2) ? 1.05 : 0, 'kai', 0.55, 1.25);
  });
  /* 停止位置の予告(「8」まで 300/200/100/50m): ブレーキをかけはじめる目安。
   * ホームの上では「8」と同じ列(へりから0.6m)に立てて、100 → 50 → 8 が一直線に見えるように */
  /* 300・200 は 1.1m の板を 1.3m の柱に(線路から2.6m)、100・50 は 0.95m */
  rs.line.stations.forEach((st) => {
    [300, 200, 100, 50].forEach((d) => {
      const s = st.s + A8 - d;
      if (s < 20 || rs._inTerminal(s, 4)) return;
      const on = inPlat(s), big = d >= 200;
      face(s, on ? plat.L.edge + 0.6 : big ? 2.6 : 2.4, on ? 1.05 : 0, `appr:${d}`, big ? 1.1 : 0.95, big && !on ? 1.3 : 1.1);
    });
  });
  /* キロ程(100mごとの白い杭と50mごとの短い杭。1kmごとに数字の札) */
  const pad = rs.line.meta.pad || 0;
  const up = rs.line.meta.direction === 'up';
  const river = rs.line.sections.river;
  const qi = quadInfo(rs.line);
  /* 杭はホームの端から5mは立てない・急行線が分かれていくところ(杭がレールのあいだに入る)も立てない */
  const skip = (s) => inPlat(s) || inPlat(s - 5) || inPlat(s + 5) || rs._inTunnel(s) || rs._inTerminal(s, 10) ||
    river.some((r) => s > r.from - 25 && s < r.to + 25) ||
    [0, 1].some((k) => quadSep(s, k, qi) >= 0.15 && Math.abs(quadOffAt(s, k, qi) - 2.0) < 1.3);
  const physToS = (d) => (up ? L - pad - d : d + pad);
  const peg = new THREE.BoxGeometry(0.1, 1, 0.1).translate(0, 0.5, 0);
  const B = lineBaker(rs);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
  for (let d = 50; ; d += 50) {
    const s = physToS(d);
    if (s < 10 || s > L - 10) { if ((up && s < 10) || (!up && s > L - 10)) break; continue; }
    if (skip(s)) continue;
    const km = d % 1000 === 0;
    const h = d % 100 === 0 ? (km ? 0.84 : 0.7) : 0.4;
    frameInto(rs, s, f);
    q.setFromAxisAngle(UPV, Math.atan2(f.t.x, f.t.z));
    p.copy(f.p).addScaledVector(f.left, 2.0);
    p.y -= 0.05;
    sc.set(1, h + 0.05, 1);
    B.geo(peg, { m: m4.compose(p, q, sc), col: 0xe9e9e4, white: true });
    /* 数字の札は白い杭の、列車が来る側の面に */
    if (km) face(s - 0.08, 2.0, 0, `km:${d / 1000}`, 0.3, 0.52, true);
  }

  /* 勾配標: 坂の かわりめに 小さな白い板(キロ程の杭と おなじ列・線路から2.0m・細い柱)。
   * ホーム・トンネル・橋・踏切・ほかの板(制限・予告・信号)・キロ程の杭の そばは 6m ずつ ずらし、だめなら立てない */
  const busy = [];
  rs.line.limits.forEach((z) => busy.push(z.from - 15, z.to + 10));
  rs.line.stations.forEach((st) => [300, 200, 100, 50].forEach((dd) => busy.push(st.s + A8 - dd)));
  /* 信号機(と 25m 手前の 地上子)。種別を かえても 路線(ワールド)は 作りなおさないので、
   * どの種別でも 立ちうる位置(閉そく信号の候補 sim.blockSpots・すべての駅の 出発信号 st.s+40)を よける */
  const sigAt = (s) => busy.push(s, s - 25);
  if (rs.sim && rs.sim.blockSpots) rs.sim.blockSpots.forEach(sigAt);
  else if (rs.sim && rs.sim.signals) rs.sim.signals.forEach((g) => sigAt(g.s));
  rs.line.stations.forEach((st) => sigAt(st.s + 40));
  const cross = rs.crossSpots || [];
  const pegGap = (s) => { const d = up ? L - pad - s : s - pad; return Math.abs(d - Math.round(d / 50) * 50); };
  const free = (s) => s > 30 && s < L - 30 && !skip(s) && pegGap(s) > 2 &&
    busy.every((b) => Math.abs(b - s) > 4) && cross.every((x) => Math.abs(x - s) > 16);
  const A = boardAtlas(rs);
  let nGrad = 0;
  if (rs._debug) rs._gradS = [];
  gradePosts(rs).forEach((g) => {
    let s = null;
    for (const o of [0, 6, -6, 12, -12, 18, -18]) if (free(g.s + o)) { s = g.s + o; break; }
    if (s == null) return;
    const key = `grad:${g.g}`;
    /* アトラスの マスが たりなければ 立てない(あとで作る踏切の板などの ぶんを 4マス のこす) */
    if (!rs._texCache.has(key) && !A.room(true, 4)) return;
    frameInto(rs, s, f);
    flatT(f, n).negate();
    c.copy(f.p).addScaledVector(f.left, 2.0);
    c.y += 0.9 + 0.225;
    makeSign(rs, key, 0.45, 0.45, { c, n, postH: 0 });
    B.post(c.x - n.x * 0.05, f.p.y - 0.05, c.z - n.z * 0.05, 0.9 + 0.45 * 0.85 + 0.05, 0x9da3a8, 1.15);
    nGrad++;
    if (rs._gradS) rs._gradS.push([Math.round(s), g.g]);
  });
  if (rs._debug) console.log('[signage] 勾配標', nGrad, '本 / 線路わきのアトラス', A.used(), 'マス');
}

/* 勾配標の位置と数(‰): 5m ごとの勾配を 100m の箱で ならして整数に。いまの区間の数と 3 以上ちがう状態が
 * 120m つづいたら そこを かわりめにし、この先 300m の平均を 新しい区間の数にする。
 * 板が つづきすぎないよう、前の かわりめから 250m は つぎを立てない(数は その先で まとめて かわる) */
function gradePosts(rs) {
  const F = rs.frames, step = rs.step, N = F ? F.length : 0;
  if (N < 20) return [];
  const g = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const a = Math.max(0, i - 1), b = Math.min(N - 1, i + 1);
    g[i] = ((F[b].p.y - F[a].p.y) / ((b - a) * step)) * 1000;
  }
  const cs = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) cs[i + 1] = cs[i] + g[i];
  const W = Math.max(1, Math.round(50 / step));
  const sm = new Int16Array(N);
  for (let i = 0; i < N; i++) {
    const lo = Math.max(0, i - W), hi = Math.min(N - 1, i + W);
    sm[i] = Math.round((cs[hi + 1] - cs[lo]) / (hi - lo + 1));
  }
  const need = Math.round(120 / step), look = Math.round(300 / step), gap = 250;
  const out = [];
  let cur = sm[0], last = -1e9;
  for (let i = 1; i < N - need; i++) {
    if (Math.abs(sm[i] - cur) < 3 || i * step - last < gap) continue;
    let ok = true;
    for (let k = 0; k < need; k++) if (Math.abs(sm[i + k] - cur) < 3) { ok = false; break; }
    if (!ok) continue;
    let sum = 0, cnt = 0;
    for (let k = 0; k < look && i + k < N; k++) { sum += sm[i + k]; cnt++; }
    cur = Math.round(sum / cnt);
    out.push({ s: i * step, g: cur });
    last = i * step;
  }
  return out;
}

/* ---------- 信号機(4灯式)・番号札・ATS地上子 ---------- */
const LAMP_DY = [0.54, 0.18, -0.18, -0.54];      // 上から 黄・緑・赤・黄
const LAMP_COL = [0xffb21f, 0x1fe070, 0xff2618, 0xffb21f];
const HEAD_Y = 4.95;
const ASPECT_LAMPS = [[2], [3], [0, 1], [1]];   // 現示(0=R,1=Y,2=YG,3=G) → 点く灯(0始まり)

/* 部品を1つの形にまとめる(頂点色・UV・番号札フラグつき) */
function mergeParts(parts) {
  const geos = parts.map((p) => {
    const g = p.geo.index ? p.geo.toNonIndexed() : p.geo;
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3), pk = new Float32Array(n);
    const cc = new THREE.Color(p.color);    // sRGBの見た目の色→リニア
    for (let i = 0; i < n; i++) { col[i * 3] = cc.r; col[i * 3 + 1] = cc.g; col[i * 3 + 2] = cc.b; pk[i] = p.pk ? 1 : 0; }
    let uv = g.attributes.uv ? g.attributes.uv.array.slice() : new Float32Array(n * 2);
    if (!p.pk) for (let i = 0; i < n; i++) { uv[i * 2] = p.white[0]; uv[i * 2 + 1] = p.white[1]; }
    else if (p.uvRect) {
      for (let i = 0; i < n; i++) {
        uv[i * 2] = p.uvRect[0] + uv[i * 2] * (p.uvRect[2] - p.uvRect[0]);
        uv[i * 2 + 1] = p.uvRect[1] + uv[i * 2 + 1] * (p.uvRect[3] - p.uvRect[1]);
      }
    }
    if (p.flip) {
      /* 裏向きのコピー(フード内側・背板の裏) */
      const pos = g.attributes.position.array.slice(), nor = g.attributes.normal.array.slice();
      for (let i = 0; i < n; i += 3) {
        for (let k = 0; k < 3; k++) {
          const a = (i + 1) * 3 + k, b = (i + 2) * 3 + k;
          [pos[a], pos[b]] = [pos[b], pos[a]];
          [nor[a], nor[b]] = [nor[b], nor[a]];
        }
        for (let k = 0; k < 2; k++) { const a = (i + 1) * 2 + k, b = (i + 2) * 2 + k; [uv[a], uv[b]] = [uv[b], uv[a]]; }
      }
      for (let i = 0; i < nor.length; i++) nor[i] = -nor[i];
      return { pos, nor, uv, col, pk };
    }
    return { pos: g.attributes.position.array, nor: g.attributes.normal.array, uv, col, pk };
  });
  const N = geos.reduce((a, g) => a + g.pk.length, 0);
  const pos = new Float32Array(N * 3), nor = new Float32Array(N * 3), uv = new Float32Array(N * 2), col = new Float32Array(N * 3), pk = new Float32Array(N);
  let o = 0;
  geos.forEach((g) => {
    pos.set(g.pos, o * 3); nor.set(g.nor, o * 3); uv.set(g.uv, o * 2); col.set(g.col, o * 3); pk.set(g.pk, o);
    o += g.pk.length;
  });
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setAttribute('stPK', new THREE.BufferAttribute(pk, 1));
  return out;
}

/* 番号札の画像(出発・下1・下2…)。右端の白い帯は本体の色(頂点色)用 */
const PLATE_W = 40, PLATE_H = 56, PLATE_COLS = 11;
function plateAtlas(labels) {
  const rows = Math.max(1, Math.ceil(labels.length / PLATE_COLS));
  const W = 512, H = Math.max(64, Math.ceil((rows * PLATE_H) / 32) * 32);
  const draw = (c) => {
    c.fillStyle = '#0d0f11'; c.fillRect(0, 0, W, H);
    c.fillStyle = '#ffffff'; c.fillRect(W - 40, 0, 40, H);
    labels.forEach((lb, i) => {
      const x = (i % PLATE_COLS) * PLATE_W, y = Math.floor(i / PLATE_COLS) * PLATE_H;
      c.strokeStyle = '#d9dde0'; c.lineWidth = 2; c.strokeRect(x + 3, y + 3, PLATE_W - 6, PLATE_H - 6);
      c.fillStyle = '#f4f6f7';
      fitText(c, lb[0], x + PLATE_W / 2, y + 17, PLATE_W - 10, 17, 700);
      fitText(c, lb[1], x + PLATE_W / 2, y + 39, PLATE_W - 8, lb[1].length > 1 ? 15 : 19, 900);
    });
  };
  const t = canvasTexture(W, H, draw);
  t.userData.W = W; t.userData.H = H;
  redrawWhenFonts(t, labels.map((l) => l.join('')).join(''));
  return t;
}

function signalRes(rs) {
  if (rs._sigRes && rs._sigRes.v4) return rs._sigRes;
  const white = [0.98, 0.5];
  const parts = [];
  const P = (geo, color, extra = {}) => parts.push({ geo, color, white, ...extra });
  /* 基礎・柱・はしご */
  P(new THREE.BoxGeometry(0.6, 0.3, 0.6).translate(0, 0.15, 0), 0x9a9893);
  P(new THREE.CylinderGeometry(0.075, 0.09, 4.0, 8, 1, true).translate(0, 0.3 + 2.0, 0), 0x6d757c);
  [-0.17, 0.17].forEach((x) => P(new THREE.BoxGeometry(0.03, 3.7, 0.03).translate(x, 0.45 + 1.85, -0.12), 0x5d656b));
  for (let k = 0; k < 5; k++) P(new THREE.BoxGeometry(0.34, 0.025, 0.025).translate(0, 0.8 + k * 0.72, -0.12), 0x5d656b);
  /* 灯器(本体・背板・フード・消えているレンズ) */
  P(new THREE.BoxGeometry(0.46, 1.55, 0.24).translate(0, HEAD_Y, 0), 0x1f2428);
  const sh = new THREE.Shape();
  const bw = 0.78, bh = 1.9, br = 0.3;
  sh.moveTo(-bw / 2 + br, -bh / 2);
  sh.lineTo(bw / 2 - br, -bh / 2); sh.quadraticCurveTo(bw / 2, -bh / 2, bw / 2, -bh / 2 + br);
  sh.lineTo(bw / 2, bh / 2 - br); sh.quadraticCurveTo(bw / 2, bh / 2, bw / 2 - br, bh / 2);
  sh.lineTo(-bw / 2 + br, bh / 2); sh.quadraticCurveTo(-bw / 2, bh / 2, -bw / 2, bh / 2 - br);
  sh.lineTo(-bw / 2, -bh / 2 + br); sh.quadraticCurveTo(-bw / 2, -bh / 2, -bw / 2 + br, -bh / 2);
  const plate = new THREE.ShapeGeometry(sh, 3).translate(0, HEAD_Y, 0.125);
  P(plate, 0x0f1113);
  P(plate.clone().translate(0, 0, -0.006), 0x0f1113, { flip: true });
  const LENS = [0x2c2410, 0x0d2216, 0x2e100e, 0x2c2410];   // 消えているレンズ(暗い色ガラス)
  LAMP_DY.forEach((dy, k) => {
    const hood = new THREE.CylinderGeometry(0.17, 0.17, 0.22, 5, 1, true, -Math.PI * 0.62, Math.PI * 1.24);
    hood.rotateX(Math.PI / 2);
    hood.translate(0, HEAD_Y + dy, 0.24);
    P(hood, 0x1a1e22);
    P(hood.clone(), 0x0c0e10, { flip: true });
    P(new THREE.CircleGeometry(0.135, 10).translate(0, HEAD_Y + dy, 0.128), LENS[k]);
  });
  /* 番号札(枠+板)。板のUVは番号ごとにインスタンス属性でずらす */
  P(new THREE.BoxGeometry(0.38, 0.48, 0.04).translate(0, 3.7, 0.1), 0x15181b);
  const face = new THREE.PlaneGeometry(0.32, 0.42).translate(0, 3.7, 0.1215);
  parts.push({ geo: face, color: 0xffffff, pk: true, uvRect: [0, 0, 1, 1] });
  const geo = mergeParts(parts);
  /* 反対の線路(上り)の信号機を裏から見た形: 基礎・柱・はしご・灯器の箱・背板(フード・レンズ・番号札なし。約90三角形) */
  const bparts = [];
  const BP = (g, color, extra = {}) => bparts.push({ geo: g, color, white, ...extra });
  BP(new THREE.BoxGeometry(0.6, 0.3, 0.6).translate(0, 0.15, 0), 0x9a9893);
  BP(new THREE.CylinderGeometry(0.075, 0.09, 4.0, 6, 1, true).translate(0, 0.3 + 2.0, 0), 0x6d757c);
  [-0.17, 0.17].forEach((x) => BP(new THREE.BoxGeometry(0.03, 3.7, 0.03).translate(x, 0.45 + 1.85, -0.12), 0x5d656b));
  BP(new THREE.BoxGeometry(0.46, 1.55, 0.24).translate(0, HEAD_Y, 0), 0x1f2428);
  BP(plate, 0x0f1113);
  BP(plate.clone().translate(0, 0, -0.006), 0x22272b, { flip: true });
  const backGeo = mergeParts(bparts);
  /* 灯器はつや消しの黒(空の映りこみで点いた灯が白っぽく見えないように) */
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.1, envMapIntensity: 0.35 });
  mat.onBeforeCompile = (s) => {
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 stPlate;\nattribute float stPK;\nuniform vec2 uStPlateSz;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\n  vMapUv = mix( vMapUv, stPlate + vMapUv * uStPlateSz, stPK );\n#endif');
    s.uniforms.uStPlateSz = mat.userData.uStPlateSz;
  };
  mat.userData.uStPlateSz = { value: new THREE.Vector2(1, 1) };
  mat.customProgramCacheKey = () => 'stsig';
  /* 点いている灯: まん中は灯の大きさ(半径0.13m)でくっきり光り、まわりに にじみ */
  const glowT = (() => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const c = cv.getContext('2d');
    const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.36, 'rgba(255,255,255,0.96)');
    g.addColorStop(0.44, 'rgba(255,255,255,0.32)');
    g.addColorStop(0.7, 'rgba(255,255,255,0.09)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g; c.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(cv);
  })();
  const beacon = new THREE.BoxGeometry(0.5, 0.07, 0.36);
  {
    const n = beacon.attributes.position.count, col = new Float32Array(n * 3);
    const side = new THREE.Color(0xd9b21f), top = new THREE.Color(0x9c7f17);
    for (let i = 0; i < n; i++) {
      const c = i >= 8 && i < 12 ? top : side;   // +Y面(上)は少し暗い
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    beacon.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }
  const R = rs._sigRes = {
    v4: true,
    geo,
    backGeo,
    mat,
    glowGeo: new THREE.PlaneGeometry(0.72, 0.72),
    glowMat: fixAdditiveFog(new THREE.MeshBasicMaterial({ map: glowT, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }), 'stglow'),
    beaconGeo: beacon,
    beaconMat: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.1 }),
    /* HDR(1より明るい)にして夜のにじみ(ブルーム)にかかるように。強すぎると色が白っぽくなるので控えめ */
    on: LAMP_COL.map((h) => new THREE.Color(h).multiplyScalar(1.7)),
  };
  R.glowMat.userData.noWeather = true;
  [R.mat, R.glowMat, R.beaconMat].forEach((m) => rs._keep.add(m));
  return R;
}

const _m4 = new THREE.Matrix4(), _m4b = new THREE.Matrix4(), _zero = new THREE.Matrix4().makeScale(0, 0, 0);

/* 信号機を(種別ごとに)作り直す。inPlat(s): ホームの上か(柱の根元をホーム面に)
 * coverAt(s): 上にある天井・屋根の高さ(なければ Infinity。灯器をその下に収める)
 * 描画は全線で 本体(+影) / 灯 / ATS地上子 の4回 */
export function buildSignals(rs, inPlat, coverAt = () => Infinity, backOk = null) {
  const R = signalRes(rs);
  if (rs._sigGroup) {
    rs.world.remove(rs._sigGroup);
    rs._sigGroup.traverse((o) => { if (o.isInstancedMesh) o.dispose(); });
  }
  /* 前回の「反対の線路の信号機の裏」(world 直下。700mマスに分けられていることもある) */
  const olds = rs.world.children.filter((o) => (o.userData && o.userData.sigBack) ||
    (o.isGroup && o.children.length && o.children[0].userData && o.children[0].userData.sigBack));
  olds.forEach((o) => {
    rs.world.remove(o);
    o.traverse((x) => { if (x.isInstancedMesh) x.dispose(); });
  });
  /* 前回ぶんの形・番号札の画像(材質は使い回すので、画像だけ捨てる) */
  if (rs._sigBuilt) {
    rs._sigBuilt.geo.dispose(); rs._sigBuilt.plateTex.dispose();
    if (rs._sigBuilt.backGeo) rs._sigBuilt.backGeo.dispose();
    rs._sigBuilt = null;
  }
  rs._sigGroup = new THREE.Group();
  rs._sigGroup.userData.st = true;
  rs.world.add(rs._sigGroup);
  rs.signalMeshes = [];                        // 古い描画ループ(render内)は空回りさせる
  const sigs = rs.sim.signals, n = sigs.length;
  const up = rs.line.meta.direction === 'up';
  /* 番号札: 出発信号は「出発」、閉そく信号は「下1」「下2」…(のぼりは「上」) */
  const labels = [['出', '発']];
  const sigLabel = [];
  let blk = 0;
  sigs.forEach((sig) => {
    if (sig.kind === 'dep') sigLabel.push(0);
    else { blk++; labels.push([up ? '上' : '下', String(blk)]); sigLabel.push(labels.length - 1); }
  });
  const plateTex = plateAtlas(labels);
  const W = plateTex.userData.W, H = plateTex.userData.H;
  const geo = R.geo.clone();
  const off = new Float32Array(n * 2);
  sigLabel.forEach((li, i) => {
    off[i * 2] = ((li % PLATE_COLS) * PLATE_W) / W;
    off[i * 2 + 1] = 1 - ((Math.floor(li / PLATE_COLS) + 1) * PLATE_H) / H;
  });
  geo.setAttribute('stPlate', new THREE.InstancedBufferAttribute(off, 2));
  R.mat.map = plateTex;
  R.mat.userData.uStPlateSz.value.set(PLATE_W / W, PLATE_H / H);
  rs._sigBuilt = { geo, plateTex };

  const stat = new THREE.InstancedMesh(geo, R.mat, n);
  const glows = new THREE.InstancedMesh(R.glowGeo, R.glowMat, n * 4);
  glows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const base = new Float32Array(n * 16);
  const f = newFrame(), q = new THREE.Quaternion(), p = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
  sigs.forEach((sig, i) => {
    /* (debug) 信号機は ホームの上に立てない(sim/engine.js _placeSignals が よけている) */
    if (rs._debug && inPlat(sig.s)) console.warn('signal on platform', sig.s);
    frameInto(rs, sig.s, f);
    q.setFromAxisAngle(UPV, Math.atan2(-f.t.x, -f.t.z));        // 表(+z)を近づく列車へ
    p.copy(f.p).addScaledVector(f.left, 2.6);
    const lift = inPlat(sig.s) ? 1.05 : 0;
    /* 灯器(背板の上端)が トンネルの天井・ホームの屋根の下に収まるように(見た目だけ。信号の位置 s は変えない) */
    p.y += Math.min(lift, coverAt(sig.s) - 0.1 - (HEAD_Y + 0.95));
    _m4.compose(p, q, one);
    _m4.toArray(base, i * 16);
    stat.setMatrixAt(i, _m4);
    for (let k = 0; k < 4; k++) {
      glows.setMatrixAt(i * 4 + k, _zero);
      glows.setColorAt(i * 4 + k, R.on[k]);
    }
  });
  stat.castShadow = true;
  glows.userData.noSplit = true; stat.userData.noSplit = true;
  [stat, glows].forEach((m) => { m.computeBoundingSphere(); m.userData.st = true; });
  glows.frustumCulled = false;
  glows.renderOrder = 3;
  rs._sigGroup.add(stat, glows);

  /* ATS地上子(レールのあいだの黄色い箱): 信号の25m手前と、停車駅の手前 520/260/110/35m */
  const spots = [];
  sigs.forEach((sig) => spots.push(sig.s - 25));
  rs.sim.stops.forEach((st) => [520, 260, 110, 35].forEach((d) => spots.push(st.stopAt - d)));
  const L = rs.line.meta.length;
  const pts = spots.filter((s) => s > 5 && s < L - 5);
  const bim = new THREE.InstancedMesh(R.beaconGeo, R.beaconMat, pts.length * 2);
  let bi = 0;
  pts.forEach((s) => {
    frameInto(rs, s, f);
    q.setFromAxisAngle(UPV, Math.atan2(f.t.x, f.t.z));
    [0, -3.8].forEach((o) => {
      p.copy(f.p).addScaledVector(f.left, o);
      p.y += 0.1;
      bim.setMatrixAt(bi++, _m4.compose(p, q, one));
    });
  });
  bim.receiveShadow = true;
  bim.userData.noSplit = true; bim.userData.st = true;
  bim.computeBoundingSphere();
  rs._sigGroup.add(bim);

  /* 反対の線路(上り)の信号機: 自分の信号の35m先、上り線の右(-6.4m)に、裏(背板)をこちらへ向けて。
   * ホームの上・屋根やトンネルの下・ターミナル・坑口の近く・橋・踏切には立てない */
  const L2 = rs.line.meta.length;
  const rivers = rs.line.sections.river, cross = rs.crossSpots || [];
  const backs = [];
  sigs.forEach((sig) => {
    const s2 = sig.s + 35;
    if (s2 < 10 || s2 > L2 - 10) return;
    if (backOk && !backOk(s2)) return;
    if (inPlat(s2) || inPlat(s2 - 6) || inPlat(s2 + 6) || coverAt(s2) < 99) return;
    if (rivers.some((r) => s2 > r.from - 12 && s2 < r.to + 12) || cross.some((c) => Math.abs(c - s2) < 16)) return;
    backs.push(s2);
  });
  if (backs.length) {
    /* 700mごとのまとまりに分けて world 直下へ(見えるまとまりだけ描く。数が少ないので P6 の分割にはかからない) */
    const cells = new Map();
    backs.forEach((s2) => { const k = Math.floor(s2 / 700); if (!cells.has(k)) cells.set(k, []); cells.get(k).push(s2); });
    let maxN = 1;
    cells.forEach((list) => { maxN = Math.max(maxN, list.length); });
    const bgeo = R.backGeo.clone();
    bgeo.setAttribute('stPlate', new THREE.InstancedBufferAttribute(new Float32Array(maxN * 2), 2));
    rs._sigBuilt.backGeo = bgeo;
    cells.forEach((list) => {
      const bk = new THREE.InstancedMesh(bgeo, R.mat, list.length);
      list.forEach((s2, i) => {
        frameInto(rs, s2, f);
        q.setFromAxisAngle(UPV, Math.atan2(f.t.x, f.t.z));          // 表は上り列車のほう(こちらには裏)
        p.copy(f.p).addScaledVector(f.left, -6.4);
        bk.setMatrixAt(i, _m4.compose(p, q, one));
      });
      bk.castShadow = true;
      bk.userData.sigBack = true; bk.userData.st = true; bk.userData.noSplit = true;
      bk.computeBoundingSphere();
      rs.world.add(bk);
    });
  }

  rs._sigState = { sigs, n, asp: new Int8Array(n).fill(-1), base, glows, R };
}

/* 現示の更新(近い信号だけ・変わったときだけ書きかえ)。割り当てなし
 * 4灯式(上から 黄・緑・赤・黄): 進行=緑 / 減速=上の黄+緑 / 注意=下の黄 / 停止=赤 */
export function updateSignals(rs) {
  const S = rs._sigState;
  if (!S || !rs.sim || S.sigs !== rs.sim.signals) return;
  const sim = rs.sim;
  let dirty = false;
  for (let i = 0; i < S.n; i++) {
    const sig = S.sigs[i];
    const d = sig.s - sim.pos;
    if (d < -50 || d > 1100) continue;
    const asp = sim.signalAspect(sig);
    if (asp === S.asp[i]) continue;
    S.asp[i] = asp;
    dirty = true;
    const on = ASPECT_LAMPS[asp] || ASPECT_LAMPS[0];
    _m4.fromArray(S.base, i * 16);
    for (let k = 0; k < 4; k++) {
      if (on.indexOf(k) >= 0) S.glows.setMatrixAt(i * 4 + k, _m4b.makeTranslation(0, HEAD_Y + LAMP_DY[k], 0.14).premultiply(_m4));
      else S.glows.setMatrixAt(i * 4 + k, _zero);
    }
  }
  if (dirty) S.glows.instanceMatrix.needsUpdate = true;
}

/* ---------- 発車標(LED) ----------
 * 1台ぶん = 512x128。上の段に「つぎ」の電車、下の段に「そのつぎ」の電車。
 * 1段: [つぎ] 種別(種別ごとの色) 行き先(かな) [8りょう] 発車時刻(右はし)。
 * 種別の色は会社の色ではない一般的な色: かくえきていしゃ=緑 / きゅうこう=赤みのオレンジ / かいそくきゅうこう=水色。
 * 長い かなは 字の高さ(34px以上)を保ったまま横だけ細くする(本物のLEDの細字と同じ)。
 * 文字を書いてから、丸い点の格子でくり抜いて「点の集まり」に見せる。
 * boards: 1枚の画像に何台ぶん縦に並べるか(新宿は左右の島の2台を1枚に) */
export const LED_KIND = {
  local: { kana: 'かくえきていしゃ', col: '#6fe08a' },
  exp: { kana: 'きゅうこう', col: '#ff6a3d' },
  rapid: { kana: 'かいそくきゅうこう', col: '#54d4ff' },
};
const LED_ROW = 128;
/* 横だけ縮めて幅に収める(字の高さは size のまま。縮めすぎるときだけ字を小さく) */
function fitCondensed(c, text, x, y, maxW, size, align = 'left', minSx = 0.5) {
  let s = size;
  c.font = `900 ${s}px ${FONT}`;
  let w = c.measureText(text).width;
  let sx = w > maxW ? maxW / w : 1;
  if (sx < minSx) { s = Math.max(12, Math.floor((s * maxW) / (w * minSx))); c.font = `900 ${s}px ${FONT}`; w = c.measureText(text).width; sx = Math.min(1, maxW / w); }
  c.save();
  c.translate(align === 'right' ? x - w * sx : align === 'center' ? x - (w * sx) / 2 : x, y);
  c.scale(sx, 1);
  c.textAlign = 'left'; c.textBaseline = 'middle';
  c.fillText(text, 0, 0);
  c.restore();
}
export function texLed(boards = 1, extra = null) {
  /* extra: { h, draw(c, y0, W) } LEDの下に、同じ材質で描くほかの絵(新宿の のりば案内・車止めの赤い灯)の場所 */
  const W = 512, HL = LED_ROW * boards, H = HL + (extra ? extra.h : 0);
  const t = canvasTexture(W, H, () => {});
  t.userData.rows = [];
  t.userData.keys = [];
  t.userData.redraws = 0;              // 描き直した回数(毎フレーム描いていないかの確認用)
  const cv = t.image, c = cv.getContext('2d');
  const tmp = document.createElement('canvas');
  tmp.width = W; tmp.height = H;
  const tc = tmp.getContext('2d');
  const dot = document.createElement('canvas');
  dot.width = dot.height = 3;
  const dc = dot.getContext('2d');
  dc.fillStyle = '#fff'; dc.beginPath(); dc.arc(1.5, 1.5, 1.2, 0, Math.PI * 2); dc.fill();
  /* 1段(高さ64px)。e: { kind, dest, time, cars } / tag: 'つぎ' | 'そのつぎ' */
  const line = (y, tag, e) => {
    if (!e) return;
    const k = LED_KIND[e.kind] || LED_KIND.local;
    /* [つぎ] の札(わく) */
    tc.strokeStyle = '#ffb347'; tc.lineWidth = 3;
    tc.strokeRect(5, y - 25, 58, 50);
    tc.fillStyle = '#ffb347';
    fitCondensed(tc, tag, 34, y + 1, 50, tag.length > 2 ? 26 : 30, 'center', 0.45);
    tc.fillStyle = k.col;
    fitCondensed(tc, k.kana, 70, y + 1, 164, 38);
    tc.fillStyle = '#ff9a1f';
    fitCondensed(tc, e.dest, 240, y + 1, 128, 38);
    /* 両数の小さな札(ぬりつぶしに暗い字: 大きな数字+小さな「りょう」) */
    tc.fillStyle = '#ffb347'; tc.fillRect(372, y - 17, 52, 34);
    tc.fillStyle = '#000';
    tc.globalCompositeOperation = 'destination-out';
    const cw = String(e.cars).length > 1 ? 24 : 15;
    fitCondensed(tc, String(e.cars), 375, y + 1, cw, 30, 'left', 0.6);
    fitCondensed(tc, 'りょう', 377 + cw, y + 3, 44 - cw, 16, 'left', 0.5);
    tc.globalCompositeOperation = 'source-over';
    tc.fillStyle = '#ff9a1f';
    fitCondensed(tc, e.time, W - 6, y + 1, 82, 38, 'right', 0.6);
  };
  const draw = () => {
    c.fillStyle = '#070605'; c.fillRect(0, 0, W, HL);
    /* 消えている点(うっすら) */
    c.globalAlpha = 0.12; c.fillStyle = c.createPattern(dot, 'repeat');
    for (let b = 0; b < boards; b++) c.fillRect(4, b * LED_ROW + 4, W - 8, LED_ROW - 8);
    c.globalAlpha = 1;
    c.fillStyle = '#2a2d30';
    for (let b = 0; b < boards; b++) c.fillRect(0, b * LED_ROW + LED_ROW / 2, W, 1);
    tc.clearRect(0, 0, W, H);
    for (let b = 0; b < boards; b++) {
      const r = t.userData.rows[b];
      if (!r) continue;
      line(b * LED_ROW + 32, 'つぎ', r[0]);
      line(b * LED_ROW + 96, 'そのつぎ', r[1]);
    }
    tc.globalCompositeOperation = 'destination-in';
    tc.fillStyle = tc.createPattern(dot, 'repeat');
    tc.fillRect(0, 0, W, HL);
    tc.globalCompositeOperation = 'source-over';
    c.drawImage(tmp, 0, 0, W, HL, 0, 0, W, HL);
    t.userData.redraws++;
    t.needsUpdate = true;
  };
  const full = () => {
    if (extra) { c.clearRect(0, HL, W, H - HL); extra.draw(c, HL, W); }
    draw();
  };
  t.userData.redraw = full;
  if (extra) full();
  /* b台目に「つぎ」a と「そのつぎ」n を出す。中身が同じなら描き直さない */
  t.userData.setBoard = (b, a, n) => {
    const key = [a, n].map((e) => (e ? `${e.kind}|${e.dest}|${e.time}|${e.cars}` : '-')).join('/');
    if (t.userData.keys[b] === key) return;
    t.userData.keys[b] = key;
    t.userData.rows[b] = [a, n];
    draw();
    redrawWhenFonts(t, [a, n].map((e) => (e ? (LED_KIND[e.kind] || LED_KIND.local).kana + e.dest + e.time + e.cars : '')).join('') + 'つぎそのりょう');
  };
  /* そのボードの画像の範囲(uv: [u0,v0,u1,v1])。上の台が b=0 */
  t.userData.uvOf = (b) => [0, 1 - ((b + 1) * LED_ROW) / H, 1, 1 - (b * LED_ROW) / H];
  /* 画素の四角(x0,y0)-(x1,y1) の uv */
  t.userData.uvPx = (x0, y0, x1, y1) => [x0 / W, 1 - y1 / H, x1 / W, 1 - y0 / H];
  t.userData.extraY = HL;
  return t;
}
