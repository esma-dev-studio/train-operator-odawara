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

/* Webフォント(Zen Kaku Gothic New)が後から届いたら、文字の入ったキャンバスを1回だけ描き直す */
let _fontQ = null;
export function redrawWhenFonts(tex, text) {
  if (typeof document === 'undefined' || !document.fonts || !document.fonts.load) return;
  if (!_fontQ) {
    const q = _fontQ = { texs: new Set(), text: '' };
    Promise.resolve().then(() => {
      _fontQ = null;
      const specs = ['900', '700', '500'].map((w) => `${w} 40px "Zen Kaku Gothic New"`);
      const txt = q.text || 'あ';
      if (specs.every((s) => { try { return document.fonts.check(s, txt); } catch (e) { return false; } })) return;
      Promise.all(specs.map((s) => document.fonts.load(s, txt))).then(() => {
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
  /* 四角い板。c=中心, n=表の向き(水平), uv=[u0,v0,u1,v1](nullなら白いマス) */
  quad(c, n, w, h, uv, col) {
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
      this.E.push(0);
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
  });
  mat.name = 'st-lineside';
  const A = rs._atlas = { tex, mat, text: '', white: [1 - C / 2 / W, C / 2 / H] };
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
  return bakerFor(rs, 'line', A.mat, { white: A.white, build: { cast: true } });
}

/* 四角い標識の絵(背景・枠・文字) */
const boardDraw = (bg, fg, text, size, weight = 900, border = '#111') => (c, s) => {
  const k = s / 128;
  c.fillStyle = bg; c.fillRect(0, 0, s, s);
  c.strokeStyle = border; c.lineWidth = 7 * k; c.strokeRect(6 * k, 6 * k, s - 12 * k, s - 12 * k);
  c.fillStyle = fg;
  fitText(c, text, s / 2, s / 2 + 4 * k, s - 26 * k, size * k, weight);
};

export function lineBoard(rs, key) {
  if (!rs._texCache) rs._texCache = new Map();
  const hit = rs._texCache.get(key);
  if (hit) return hit;
  const A = boardAtlas(rs);
  let fn, small = false;
  const [kind, val] = key.split(':');
  if (kind === 'lim') fn = boardDraw('#e8bf1f', '#111111', val, val.length > 2 ? 64 : 80);
  else if (kind === 'kai') fn = boardDraw('#f4f4f0', '#111111', '解', 78);
  else if (kind === 'stop8') fn = boardDraw('#ffffff', '#111111', '8', 96, 900, '#111');
  else if (kind === 'appr') fn = boardDraw('#f4f4f0', '#111111', val, val.length > 2 ? 54 : 74, 900, '#1d2a36');
  else if (kind === 'km') { fn = boardDraw('#f2f2ee', '#16283a', val, val.length > 1 ? 70 : 84, 900, '#16283a'); small = true; }
  else if (kind === 'nori') { fn = boardDraw('#20272d', '#ffffff', val, 88, 900, '#f2c230'); small = true; }
  else fn = boardDraw('#ffffff', '#111111', val || key, 60);
  const uv = A.cell(key, fn, small);
  A.text += (val || '') + '解8';
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
  B.quad(o.c, o.n, w, h, b.uv);
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
 * plat: { L:{edge,back} } / inPlat(s): ホームの範囲か */
export function buildBoards(rs, plat, inPlat) {
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
  /* 停止位置の予告(300/200/100/50m手前): ブレーキをかけはじめる目安 */
  rs.line.stations.forEach((st) => {
    [300, 200, 100, 50].forEach((d) => {
      const s = st.s + 4.5 - d;
      if (s < 20 || rs._inTerminal(s, 4)) return;
      const on = inPlat(s);
      face(s, on ? plat.L.back - 0.4 : 2.4, on ? 1.05 : 0, `appr:${d}`, 0.5, 1.3);
    });
  });
  /* キロ程(100mごとの白い杭と50mごとの短い杭。1kmごとに数字の札) */
  const pad = rs.line.meta.pad || 0;
  const up = rs.line.meta.direction === 'up';
  const river = rs.line.sections.river;
  const skip = (s) => inPlat(s) || rs._inTunnel(s) || rs._inTerminal(s, 10) ||
    river.some((r) => s > r.from - 25 && s < r.to + 25);
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
}

/* ---------- 信号機(4灯式)・番号札・ATS地上子 ---------- */
const LAMP_DY = [0.54, 0.18, -0.18, -0.54];      // 上から 黄・緑・赤・黄
const LAMP_COL = [0xffc12b, 0x22e06a, 0xff4838, 0xffc12b];
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
  if (rs._sigRes && rs._sigRes.v3) return rs._sigRes;
  const white = [0.98, 0.5];
  const parts = [];
  const P = (geo, color, extra = {}) => parts.push({ geo, color, white, ...extra });
  /* 基礎・柱・はしご */
  P(new THREE.BoxGeometry(0.6, 0.3, 0.6).translate(0, 0.15, 0), 0x9a9893);
  P(new THREE.CylinderGeometry(0.075, 0.09, 4.0, 8, 1, true).translate(0, 0.3 + 2.0, 0), 0x6d757c);
  [-0.17, 0.17].forEach((x) => P(new THREE.BoxGeometry(0.03, 3.7, 0.03).translate(x, 0.45 + 1.85, -0.2), 0x5d656b));
  for (let k = 0; k < 6; k++) P(new THREE.BoxGeometry(0.34, 0.025, 0.025).translate(0, 0.8 + k * 0.6, -0.2), 0x5d656b);
  [-0.17, 0.17].forEach((x) => P(new THREE.BoxGeometry(0.03, 0.03, 0.14).translate(x, 3.9, -0.13), 0x5d656b));
  /* 灯器(本体・背板・フード・消えているレンズ) */
  P(new THREE.BoxGeometry(0.46, 1.55, 0.24).translate(0, HEAD_Y, 0), 0x1f2428);
  P(new THREE.BoxGeometry(0.12, 0.3, 0.12).translate(0, HEAD_Y - 0.9, 0), 0x2a2f33);
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
  const LENS = [0x3a2e12, 0x10291b, 0x3a1412, 0x3a2e12];   // 消えているレンズ(暗い色ガラス)
  LAMP_DY.forEach((dy, k) => {
    const hood = new THREE.CylinderGeometry(0.17, 0.17, 0.22, 7, 1, true, -Math.PI * 0.62, Math.PI * 1.24);
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
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.25 });
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
    v3: true,
    geo,
    mat,
    glowGeo: new THREE.PlaneGeometry(0.72, 0.72),
    glowMat: fixAdditiveFog(new THREE.MeshBasicMaterial({ map: glowT, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }), 'stglow'),
    beaconGeo: beacon,
    beaconMat: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.1 }),
    on: LAMP_COL.map((h) => new THREE.Color(h).multiplyScalar(2.2)),
  };
  R.glowMat.userData.noWeather = true;
  [R.mat, R.glowMat, R.beaconMat].forEach((m) => rs._keep.add(m));
  return R;
}

const _m4 = new THREE.Matrix4(), _m4b = new THREE.Matrix4(), _zero = new THREE.Matrix4().makeScale(0, 0, 0);

/* 信号機を(種別ごとに)作り直す。inPlat(s): ホームの上か(柱の根元をホーム面に)
 * 描画は全線で 本体(+影) / 灯 / ATS地上子 の4回 */
export function buildSignals(rs, inPlat) {
  const R = signalRes(rs);
  if (rs._sigGroup) {
    rs.world.remove(rs._sigGroup);
    rs._sigGroup.traverse((o) => { if (o.isInstancedMesh) o.dispose(); });
  }
  /* 前回ぶんの形・番号札の画像(材質は使い回すので、画像だけ捨てる) */
  if (rs._sigBuilt) { rs._sigBuilt.geo.dispose(); rs._sigBuilt.plateTex.dispose(); rs._sigBuilt = null; }
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
    frameInto(rs, sig.s, f);
    q.setFromAxisAngle(UPV, Math.atan2(-f.t.x, -f.t.z));        // 表(+z)を近づく列車へ
    p.copy(f.p).addScaledVector(f.left, 2.6);
    if (inPlat(sig.s)) p.y += 1.05;
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

/* ---------- 発車標(オレンジのLED) ----------
 * 1行目: 種別・行き先(左)と発車時刻(右) / 2行目: 両数。
 * 文字を書いてから、丸い点の格子でくり抜いて「点の集まり」に見せる */
export function texLed() {
  const W = 512, H = 112;
  const t = canvasTexture(W, H, () => {});
  t.userData.lines = ['', '', ''];
  const cv = t.image, c = cv.getContext('2d');
  const tmp = document.createElement('canvas');
  tmp.width = W; tmp.height = H;
  const tc = tmp.getContext('2d');
  const dot = document.createElement('canvas');
  dot.width = dot.height = 3;
  const dc = dot.getContext('2d');
  dc.fillStyle = '#fff'; dc.beginPath(); dc.arc(1.5, 1.5, 1.2, 0, Math.PI * 2); dc.fill();
  const draw = () => {
    const [l1, tm, l2] = t.userData.lines;
    c.fillStyle = '#070605'; c.fillRect(0, 0, W, H);
    /* 消えている点(うっすら) */
    c.globalAlpha = 0.12; c.fillStyle = c.createPattern(dot, 'repeat'); c.fillRect(6, 6, W - 12, H - 12); c.globalAlpha = 1;
    c.fillStyle = '#2a2d30'; c.fillRect(0, 56, W, 1);
    tc.clearRect(0, 0, W, H);
    tc.fillStyle = '#ff9a1f';
    fitText(tc, tm, W - 12, 30, 120, 40, 900, 'right');
    fitText(tc, l1, 12, 30, W - 150, 38, 900, 'left');
    tc.fillStyle = '#ffb347';
    fitText(tc, l2, 12, 84, 200, 34, 900, 'left');
    tc.globalCompositeOperation = 'destination-in';
    tc.fillStyle = tc.createPattern(dot, 'repeat');
    tc.fillRect(0, 0, W, H);
    tc.globalCompositeOperation = 'source-over';
    c.drawImage(tmp, 0, 0);
    t.needsUpdate = true;
  };
  t.userData.redraw = draw;
  t.userData.set = (l1, tm, l2) => {
    const L = t.userData.lines;
    if (L[0] === l1 && L[1] === tm && L[2] === l2) return;
    t.userData.lines = [l1, tm, l2];
    draw();
    redrawWhenFonts(t, l1 + tm + l2);
  };
  return t;
}
