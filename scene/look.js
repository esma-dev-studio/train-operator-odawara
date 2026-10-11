/* =========================================================
 * scene/look.js — 光と空気(時間帯・天気ごとの「見え方」)
 * ・LOOK: 太陽・空の光・露出・霧・ブルーム・前照灯の数値表(調整はここだけで済む)
 * ・HDRの空の下ごしらえ(太陽の円盤を抑える・地平線の色を測る)
 * ・ぬれ/雪を全部の材質にまとめて足すシェーダ部品(weather chunk)
 * ・夜空(星と月)・夕焼けの空(どちらもテクスチャなしの手続きシェーダ)
 * ・トーンマップの仕上げ(彩度・明暗の色み)
 * 色は見た目(sRGB)で書く。THREE.Color の setHex は sRGB → リニアに直して持つ。
 * ========================================================= */
import * as THREE from '../vendor/three.module.min.js';
import { LuminosityHighPassShader } from '../vendor/addons/LuminosityHighPassShader.js';

/* sun: [強さ, 色] / hemi: [強さ, 空の色, 地面の色] / fog: [色(nullは空から自動), 近, 遠]
 * fogLin: 霧の色をリニアの光の強さで直接(夕焼けの地平線に合わせる) / env: 空の映りこみの強さ(倍率)
 * wire: 架線・電線の明るさ(倍率。夜は空より明るく光らないよう暗く)
 * bloom: [しきい値, 強さ, 半径](nullはブルームなしで直接描く) / head: 前照灯 / wet・snow: ぬれ・雪の量
 * 影は どの表でも太陽(夜は月)から落とす(影の有無を切りかえると全シェーダの作り直しになるため) */
export const LOOK = {
  /* 晴れの昼: 太陽を強く・空の光(環境光)を控えめにして、日なたと日かげの差をはっきり(色もあざやかに) */
  day: {
    sun: [5.5, 0xffe6c4], hemi: [0.5, 0x9cbcf0, 0x5c5444],
    exposure: 1.2, bg: 0.9, env: 0.85, wire: 1, fog: [null, 30, 1300], fogFallback: 0xb6b9c4,
    bloom: null, head: 0, wet: 0, snow: 0,
  },
  /* 夕方: 金色の低い日ざし。霧は夕焼けの地平線と同じ色(太陽の側はさらに明るく: 霧の照り返し)。
   * 日かげは青みの空の光(空は青紫・地面の照り返しは暖色)。日なただけが だいだい色になる(全部ピンクにしない)。
   * ブルームは太陽のまわりの強い所だけ(しきい値を上げて、左の建物まで白くにじませない) */
  eve: {
    sun: [2.6, 0xffa25a], hemi: [0.6, 0x8c96bc, 0x4a3a30],
    exposure: 0.95, bg: 1, env: 0.7, wire: 0.75, fog: [null, 40, 1350], fogLin: [0.97, 0.29, 0.16], fogFallback: 0x9a7a6a,
    bloom: [2.6, 0.42, 0.2], head: 70, wet: 0, snow: 0,
  },
  /* 夜: まっ黒にしない。紺の空・月明かり・街の明かりで遠くは灰色にかすむ。
   * 壁は暗く(昼を暗くしただけの絵にしない)、窓・街灯・ホームの明かりが目立つように。
   * desat: 暗い所ほど色がうすく見える(芝や木の緑が青い光の下で黒くつぶれない。明かりの当たる所は色が残る) */
  night: {
    sun: [0.38, 0x9fb4e0], hemi: [0.95, 0x5c6a88, 0x1e1c1a], desat: 0.65,
    exposure: 1.3, bg: 1, env: 1.0, wire: 0.2, fog: [0x262b3a, 60, 1050],
    bloom: [1.0, 0.5, 0.3], head: 420, wet: 0, snow: 0,
  },
  nightWet: {
    sun: [0.3, 0x9fb4e0], hemi: [0.85, 0x56606f, 0x201e1c], desat: 0.3,
    exposure: 1.25, bg: 1, env: 1.0, wire: 0.25, fog: [0x2a2d34, 40, 560],
    bloom: [1.1, 0.55, 0.25], head: 480, wet: 1, snow: 0,
  },
  /* 雨: 晴れより暗い くもり空。ぬれた地面(明るい空と暗い地面の差がつく)・水たまり・遠くは雨のかすみ */
  rain: {
    sun: [0.3, 0xd0d8e2], hemi: [0.5, 0xa4b2c0, 0x4a4e4a],
    exposure: 0.82, bg: 0.5, env: 0.65, wire: 0.9, fog: [null, 18, 480], fogFallback: 0x9da4a8,
    bloom: [2.0, 0.25, 0.3], head: 0, wet: 1, snow: 0,
  },
  snow: {
    sun: [0.6, 0xf2f4f8], hemi: [0.7, 0xcfdcf5, 0xe8ecf0],
    exposure: 0.88, bg: 1.0, env: 0.9, wire: 1, fog: [null, 20, 520], fogFallback: 0xd5d8dc,
    bloom: [4.0, 0.15, 0.3], head: 0, wet: 0.3, snow: 1,
  },
  /* トンネル・ターミナル(目の慣れ k で外の値とまぜる)。ブルームは灯りのまわりだけ(天井全体を白くかすませない) */
  indoor: { fog: [0x050607, 5, 220], bloom: [1.8, 0.32, 0.18], head: 420 },
};

/* 時間帯×天気から使う表を決める(夕方の雨雪・夜の雪は近い表を少し変えて作る) */
export function pickLook(tod, weather) {
  const wet = weather === 'rain' || weather === 'snow';
  const snow = weather === 'snow';
  if (tod === 'night') {
    if (!wet) return { key: 'night', ...LOOK.night };
    return { key: 'nightWet', ...LOOK.nightWet, snow: snow ? 1 : 0, wet: snow ? 0.3 : 1 };
  }
  const base = wet ? { key: weather, ...LOOK[weather] } : tod === 'evening' ? { key: 'eve', ...LOOK.eve } : { key: 'day', ...LOOK.day };
  if (tod === 'evening' && wet) {
    /* 夕方の雨・雪: くもり空のまま、暗めで少しあたたかい色に */
    base.key = 'eve-' + weather;
    base.sun = [base.sun[0] * 0.5, 0xe2b48c];
    base.hemi = [base.hemi[0] * 0.75, base.hemi[1], base.hemi[2]];
    base.exposure *= 0.82;
    base.bg *= 0.6;
    base.head = LOOK.eve.head;
    base.bloom = LOOK.eve.bloom;
  }
  return base;
}

/* ---------- 色の仕上げ(グレード) ----------
 * ACES のトーンマップは明るい所で色がうすくなるので、出力の直後に少しだけ彩度を足し、
 * 暗い所はわずかに青く・明るい所はわずかに暖かくする(本物の運転映像のような締まった色)。
 * シェーダの部品そのものを書きかえるので、ブルーム経由の最後の出力(OutputPass)にも同じように効く。
 * どのシェーダもコンパイルされる前(このモジュールを読みこんだ時)に1回だけ行う */
const TM_ANCHOR = 'color = ACESOutputMat * color;';
const TM_GRADE = `
	float tmL = dot( color, vec3( 0.2126, 0.7152, 0.0722 ) );
	color = max( mix( vec3( tmL ), color, 1.12 ), 0.0 );
	color *= mix( vec3( 0.97, 0.99, 1.04 ), vec3( 1.02, 1.0, 0.97 ), smoothstep( 0.03, 0.45, tmL ) );`;
{
  const src = THREE.ShaderChunk.tonemapping_pars_fragment;
  if (src.indexOf('tmL') < 0) {
    if (src.indexOf(TM_ANCHOR) >= 0) THREE.ShaderChunk.tonemapping_pars_fragment = src.replace(TM_ANCHOR, TM_ANCHOR + TM_GRADE);
    else console.warn('[look] ACES の仕上げを入れる場所が見つからない(three.js の版が変わった?)');
  }
}

/* ---------- ブルーム(光のにじみ)の入口: とても明るい点は明るさ8まで ----------
 * 夕日がガラス窓に当たった反射(鏡のような反射)は、明るさが数十にもなる。にじみの元はしきい値を超えた明るさを
 * そのまま使うので、小さな反射が画面の4分の1を白くおおう大きなにじみになる。灯り・太陽の円盤(8まで)は変わらない。
 * ブルームのパスを作る前(このモジュールを読みこんだ時)に1回だけ書きかえる */
{
  const HP_ANCHOR = 'vec4 texel = texture2D( tDiffuse, vUv );';
  const src = LuminosityHighPassShader && LuminosityHighPassShader.fragmentShader;
  if (typeof src === 'string' && src.indexOf('hpCap') < 0 && src.indexOf(HP_ANCHOR) >= 0) {
    LuminosityHighPassShader.fragmentShader = src.replace(HP_ANCHOR, HP_ANCHOR +
      '\n\t\t\tfloat hpCap = dot( texel.xyz, vec3( 0.299, 0.587, 0.114 ) );' +
      '\n\t\t\ttexel.xyz *= min( 1.0, 8.0 / max( hpCap, 1e-4 ) );');
  }
}

/* ---------- 色の計算(霧の色を空の地平線にぴったり合わせるため) ---------- */
/* three.js r160 の ACESFilmicToneMapping と同じ式(露出/0.6 → 入力行列 → RRT+ODT → 出力行列)+上の仕上げ */
export function acesFilmic(rgb, exposure) {
  const s = exposure / 0.6;
  const r = rgb[0] * s, g = rgb[1] * s, b = rgb[2] * s;
  const i0 = 0.59719 * r + 0.35458 * g + 0.04823 * b;
  const i1 = 0.07600 * r + 0.90834 * g + 0.01566 * b;
  const i2 = 0.02840 * r + 0.13383 * g + 0.83777 * b;
  const fit = (v) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.4329510) + 0.238081);
  const a0 = fit(i0), a1 = fit(i1), a2 = fit(i2);
  let o0 = 1.60475 * a0 - 0.53108 * a1 - 0.07367 * a2;
  let o1 = -0.10208 * a0 + 1.10813 * a1 - 0.00605 * a2;
  let o2 = -0.00327 * a0 - 0.07276 * a1 + 1.07602 * a2;
  /* 仕上げ(シェーダの TM_GRADE と同じ) */
  const tl = 0.2126 * o0 + 0.7152 * o1 + 0.0722 * o2;
  o0 = Math.max(tl + (o0 - tl) * 1.12, 0); o1 = Math.max(tl + (o1 - tl) * 1.12, 0); o2 = Math.max(tl + (o2 - tl) * 1.12, 0);
  const x = Math.min(1, Math.max(0, (tl - 0.03) / 0.42)), w = x * x * (3 - 2 * x);
  o0 *= 0.97 + 0.05 * w; o1 *= 0.99 + 0.01 * w; o2 *= 1.04 - 0.07 * w;
  const sat = (v) => Math.min(1, Math.max(0, v));
  return [sat(o0), sat(o1), sat(o2)];
}

/* HDR(半精度float, RGBA, 1行目=真上)の地平線0〜5°の明るさの中央値(リニア) */
export function horizonRadiance(tex) {
  const img = tex && tex.image;
  if (!img || !img.data || !(img.data instanceof Uint16Array)) return null;
  const W = img.width, H = img.height, d = img.data;
  const r0 = Math.floor(H * (0.5 - 5 / 180)), r1 = Math.floor(H * 0.5);
  const ch = [[], [], []];
  const f16 = THREE.DataUtils.fromHalfFloat;
  for (let y = r0; y < r1; y++) {
    for (let x = 0; x < W; x += 2) {
      const o = (y * W + x) * 4;
      ch[0].push(f16(d[o])); ch[1].push(f16(d[o + 1])); ch[2].push(f16(d[o + 2]));
    }
  }
  return ch.map((a) => { a.sort((p, q) => p - q); return a[a.length >> 1]; });
}

/* 晴れのHDRの太陽の円盤を明るさ8までに抑える(そのままだと影のつかない光が強すぎて、
 * 影がうすく平たい絵になる)。いちばん明るい点の向き=太陽の向きを返す。
 * 地平線より下は、映りこんだ空の代わりにあたたかい地面の明るさにする(2°でなめらかに) */
export function prepareClearHdr(tex) {
  const img = tex && tex.image;
  if (!img || !img.data || !(img.data instanceof Uint16Array)) return null;
  const W = img.width, H = img.height, d = img.data;
  const { toHalfFloat: t16, fromHalfFloat: f16 } = THREE.DataUtils;
  const LIM = 8, raw = t16(LIM);
  let best = -1, bx = 0, by = 0;
  for (let i = 0, n = W * H * 4; i < n; i += 4) {
    if (d[i] <= raw && d[i + 1] <= raw && d[i + 2] <= raw) continue;   // 正の半精度は整数のまま大小比較できる
    const r = f16(d[i]), g = f16(d[i + 1]), b = f16(d[i + 2]);
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (L > best) { best = L; bx = (i >> 2) % W; by = Math.floor((i >> 2) / W); }
    if (L > LIM) { const k = LIM / L; d[i] = t16(r * k); d[i + 1] = t16(g * k); d[i + 2] = t16(b * k); }
  }
  /* 地平線より下(日なたの地面の照り返し。強い日ざしに合わせて少し明るく・あたたかく) */
  const G = [0.24, 0.22, 0.18], Gh = G.map((v) => t16(v));
  const band = 2 / 180 * H;
  for (let y = Math.floor(H / 2); y < H; y++) {
    const below = (y + 0.5) - H / 2;            // 地平線からの行数
    const w = Math.min(1, below / band);
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      if (w >= 1) { d[o] = Gh[0]; d[o + 1] = Gh[1]; d[o + 2] = Gh[2]; continue; }
      for (let c = 0; c < 3; c++) d[o + c] = t16(f16(d[o + c]) * (1 - w) + G[c] * w);
    }
  }
  tex.needsUpdate = true;
  if (best < 0) return null;
  const u = (bx + 0.5) / W, v = 1 - (by + 0.5) / H;
  const phi = (u - 0.5) * Math.PI * 2, el = (v - 0.5) * Math.PI;
  return new THREE.Vector3(Math.cos(el) * Math.cos(phi), Math.sin(el), Math.cos(el) * Math.sin(phi)).normalize();
}

/* 地平線の明るさ → 霧の色。
 * 直接描く(低画質)ときは、霧はトーンマップ・sRGB変換の後で混ざる。そこで「トーンマップ後の値」を
 * リニアのまま持たせる(画面へ送るときに three が sRGB に1回だけ変換する。sRGB として持たせると
 * 2回変換されて、遠くの物が空より暗くなってしまう)。
 * ブルーム経由(リニアのまま描いて最後にトーンマップ)のときはリニアの光の強さのまま使う */
export function fogFromHorizon(lin, bgIntensity, exposure, direct, out = new THREE.Color()) {
  const c = [lin[0] * bgIntensity, lin[1] * bgIntensity, lin[2] * bgIntensity];
  if (!direct) return out.setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace);
  const t = acesFilmic(c, exposure);
  return out.setRGB(t[0], t[1], t[2], THREE.LinearSRGBColorSpace);
}

/* ---------- 地面の大きなムラ(2オクターブの値ノイズ: R=220m周期, G=37m周期) ---------- */
export function makeMacroTex() {
  const N = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const c = cv.getContext('2d');
  const img = c.createImageData(N, N);
  let seed = 4242;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  /* 周期的な格子の値ノイズ(つなぎ目なし) */
  const layer = (cells) => {
    const g = new Float32Array(cells * cells).map(() => rnd());
    return (x, y) => {
      const fx = x / N * cells, fy = y / N * cells;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const at = (i, j) => g[((j + cells) % cells) * cells + ((i + cells) % cells)];
      const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
      const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
      return a + (b - a) * sy;
    };
  };
  const r1 = layer(4), r2 = layer(9), g1 = layer(8), g2 = layer(23);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const o = (y * N + x) * 4;
      img.data[o] = Math.round((r1(x, y) * 0.68 + r2(x, y) * 0.32) * 255);
      img.data[o + 1] = Math.round((g1(x, y) * 0.6 + g2(x, y) * 0.4) * 255);
      img.data[o + 2] = 128;
      img.data[o + 3] = 255;
    }
  }
  c.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

/* ---------- ぬれ・雪(全部の標準材質に足す共通シェーダ部品) ----------
 * U = { uSnow, uWet, uSnowCol, uWxMacro, uFogSun, uSunDirW } を全プログラムで共有するので、
 * 天気を変えても値を書きかえるだけ(作り直し=コンパイルが起きない)。
 * 他の部品の色の加工(color_fragment の後)より後、roughnessmap_fragment の直前に入れる。
 * 霧(fog_fragment)も ここで置きかえ、夕方は太陽の側の霧を明るくする(霧の照り返し)。
 * 水たまりは材質ごとの値 uPud(1=水たまりができる平らな舗装)で切りかえる。
 * 定義(#define)で分けないので、シェーダの種類は増えない */
const WX_VERT_HEAD = `
varying vec3 vWxN;
varying vec3 vWxP;`;
/* 法線は three が計算済みの transformedNormal(視点座標・拡大縮小を正しく補正済み)を世界座標へ戻す */
const WX_VERT = `
{
  vec4 wxP = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    wxP = instanceMatrix * wxP;
  #endif
  vWxP = ( modelMatrix * wxP ).xyz;
  vWxN = inverseTransformDirection( transformedNormal + vec3( 0.0, 1e-6, 0.0 ), viewMatrix );
}`;
/* wxVN: テクスチャを使わない値ノイズ(格子の乱数をなめらかにつなぐ)。sin を使わない乱数なので
 * 世界座標が大きくても模様がくずれない */
const WX_FRAG_HEAD = `
uniform float uWet;
uniform float uSnow;
uniform vec3 uSnowCol;
uniform vec3 uFogSun;
uniform vec3 uSunDirW;
uniform vec3 uFogAnti;
uniform float uFogDir;
uniform float uPud;
uniform float uNightDs;
uniform float uDsLo;
uniform float uDsHi;
varying vec3 vWxN;
varying vec3 vWxP;
float wxH2( vec2 p ) {
  vec3 q = fract( vec3( p.xyx ) * 0.1031 );
  q += dot( q, q.yzx + 33.33 );
  return fract( ( q.x + q.y ) * q.z );
}
float wxVN( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( wxH2( i ), wxH2( i + vec2( 1.0, 0.0 ) ), f.x ), mix( wxH2( i + vec2( 0.0, 1.0 ) ), wxH2( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}`;
/* 水たまり(雨の日の平らな舗装: ホーム・犬走り・道路・街の地面)。暗くなって、空を鏡のように映す */
const WX_PUD = `
    if ( uPud > 0.0 ) {
      /* 2m ほどの大きさのまだらな水たまり(全体の2割ほど) */
      wxPud = uWet * smoothstep( 0.62, 0.7, 0.7 * wxVN( vWxP.xz * 0.5 ) + 0.3 * wxVN( vWxP.xz * 1.7 ) ) * smoothstep( 0.96, 0.99, wxNrm.y );
      diffuseColor.rgb *= 1.0 - 0.7 * wxPud;
    }`;
/* 地面(芝)用: 大きなムラ+遠くの色寄せ、雪は芝の模様を雪の凹凸として残す */
const WX_MACRO = `
  {
    float wxM1 = texture2D( uWxMacro, vWxP.xz * ( 1.0 / 220.0 ) ).r;
    float wxM2 = texture2D( uWxMacro, vWxP.xz * ( 1.0 / 37.0 ) ).g;
    diffuseColor.rgb *= mix( vec3( 0.80, 0.86, 0.74 ), vec3( 1.10, 1.06, 0.92 ), wxM1 ) * ( 0.9 + 0.2 * wxM2 );
    diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.42, 0.50, 0.36 ) * uWxFar, smoothstep( 150.0, 600.0, distance( vWxP, cameraPosition ) ) * 0.35 );
    if ( uSnow > 0.0 ) {
      /* 雪の凹凸: 芝の細かい模様は少し離れると平均されて消えるので、1〜2m(9m周期の値ノイズ)の
       * ムラと吹きだまり(37m)で明るさを変える。足もとだけ芝の模様も凹凸として残す。
       * 雪は明るくトーンマップで差がつぶれやすいので、反射率の差は大きめにとる */
      float wxL = dot( sampledDiffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
      float wxN1 = texture2D( uWxMacro, vWxP.xz * ( 1.0 / 9.0 ) ).r;
      vec3 wxRel = uSnowCol * ( 0.58 + 0.42 * wxN1 * wxN1 ) * ( 0.82 + 0.18 * wxM2 ) * ( 0.88 + 0.12 * smoothstep( 0.05, 0.2, wxL ) );
      /* 風で雪がうすい所は芝が少し透ける(真っ白で何もない面にしない) */
      wxCov = uSnow * ( 1.0 - 0.45 * smoothstep( 0.56, 0.78, wxM2 ) * ( 0.6 + 0.4 * wxN1 ) );
      diffuseColor.rgb = mix( diffuseColor.rgb, wxRel, wxCov );
    }
  }
  if ( uWet > 0.0 ) {
    wxWet = uWet * ( 0.55 + 0.45 * wxUp );
    diffuseColor.rgb *= 1.0 - 0.38 * wxWet;
    wxWet *= 0.45;   // 芝はてかてかにしない` + WX_PUD + `
  }`;
const WX_GENERIC = `
  if ( uWet > 0.0 ) {
    /* ぬれると暗く、色も少しくすむ(くもり空の下の しっとりした色) */
    wxWet = uWet * ( 0.55 + 0.45 * wxUp );
    diffuseColor.rgb *= 1.0 - 0.38 * wxWet;
    diffuseColor.rgb = mix( diffuseColor.rgb, vec3( dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ) ), 0.25 * wxWet );
    #ifdef USE_MAP
      /* 模様のある面(砂利など): ぬれた石は明るい石ほど暗くなり、全体が濃い一様な色になる(白黒のごま塩にしない)。
       * 光るのは明るい石の上だけ。全体を鏡のようにすると、空が映って乾いた時より白っぽい板に見えてしまう */
      float wxG = smoothstep( 0.08, 0.32, dot( sampledDiffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ) );
      diffuseColor.rgb *= 1.0 - wxWet * ( 0.2 + 0.28 * wxG );
      /* つやは明るい石の上だけ・弱く(くもり空の映りこみで、ぬれた砂利が乾いた時より白っぽくならないように) */
      wxWet *= 0.14 + 0.40 * wxG;
    #endif` + WX_PUD + `
  }
  if ( uSnow > 0.0 ) {
    float wxH = fract( sin( dot( floor( vWxP.xz * 1.7 ), vec2( 12.99, 78.23 ) ) ) * 43758.5 );
    wxCov = uSnow * smoothstep( 0.25, 0.75, wxNrm.y + ( wxH - 0.5 ) * 0.35 );
    vec3 wxS = uSnowCol;
    #ifdef USE_MAP
      /* 模様のある面(砂利・コンクリート)は、暗いすき間に雪が残りにくい=凹凸が見える */
      float wxL = smoothstep( 0.06, 0.35, dot( sampledDiffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ) );
      wxS *= 0.86 + 0.14 * wxL;
      wxCov *= 0.72 + 0.28 * wxL;
    #endif
    diffuseColor.rgb = mix( diffuseColor.rgb, wxS, wxCov );
  }`;
/* 両面の材質(帯状の地面など)は裏から見えている面の法線を反転して「上向き」を正しく判定 */
const WX_PRE = `
  vec3 wxNrm = vWxN;
  #ifdef DOUBLE_SIDED
    wxNrm *= gl_FrontFacing ? 1.0 : -1.0;
  #endif
  float wxUp = clamp( wxNrm.y, 0.0, 1.0 );
  float wxWet = 0.0, wxCov = 0.0, wxPud = 0.0;`;
const WX_ROUGH = `
  roughnessFactor = mix( roughnessFactor, 0.28, wxWet * wxUp * 0.85 );
  roughnessFactor = mix( roughnessFactor, 0.85, wxCov );
  roughnessFactor = mix( roughnessFactor, 0.03, wxPud * ( 1.0 - wxCov ) );`;
/* 夜の色のうすさ: 暗い所だけ色をぬく(目は暗い所で色を感じにくいが、明かりの当たる所の色は見える)。
 * 照らされたあとの明るさで決めるので、ホームの床・車体の帯・店先など明かりの当たる所は色が残る。
 * uDsLo/uDsHi は描き方で変える(ブルーム経由=トーンマップ前のリニア / 直接=トーンマップ後) */
const WX_DS = `
  if ( uNightDs > 0.0 ) {
    float wxLo = dot( gl_FragColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
    gl_FragColor.rgb = mix( gl_FragColor.rgb, vec3( wxLo ), uNightDs * ( 1.0 - smoothstep( uDsLo, uDsHi, wxLo ) ) );
  }`;
/* 霧: three の標準の式に、太陽の方向ほど明るい霧(夕方の照り返し)を足す。
 * 夕方は太陽と反対の側(地球の影の側)の霧を、地平線と同じ青紫がかった灰色へ寄せる(uFogDir)。
 * uFogSun・uFogDir が0なら標準と同じ */
const WX_FOG = WX_DS + `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  float wxMu = dot( normalize( vWxP - cameraPosition ), uSunDirW );
  vec3 wxFc = mix( fogColor, uFogAnti, uFogDir * ( 1.0 - smoothstep( -0.6, 0.5, wxMu ) ) ) + uFogSun * pow( max( wxMu, 0.0 ), 8.0 );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, wxFc, fogFactor );
#endif`;

export function makeWeatherUniforms() {
  return {
    uSnow: { value: 0 },
    uWet: { value: 0 },
    uSnowCol: { value: new THREE.Color(0xf2f5f8) },
    uWxMacro: { value: null },
    uWxFar: { value: 1 },
    /* 霧の照り返し(リニアの光の強さ。夕方・ブルーム経由のときだけ0以外)と太陽の向き(世界座標) */
    uFogSun: { value: new THREE.Vector3() },
    uSunDirW: { value: new THREE.Vector3(0, 1, 0) },
    /* 夕方の太陽と反対側の霧の色(リニア)と、その効き(0=使わない。夕方・ブルーム経由だけ) */
    uFogAnti: { value: new THREE.Color() },
    uFogDir: { value: 0 },
    /* 夜の色のうすさ(0〜1。LOOK.desat × 目の慣れ)と、色をぬく明るさの範囲(これより明るい所は色が残る) */
    uNightDs: { value: 0 },
    uDsLo: { value: 0.01 },
    uDsHi: { value: 0.12 },
  };
}

/* 1つの材質に部品を足す(すでに onBeforeCompile があればそれを先に実行する)。
 * m.userData.puddle なら水たまりができる(材質ごとの値 m.userData.wxPudU.value。あとから0/1を変えてもよい) */
export function installWeather(m, U) {
  if (!m || !m.isMeshStandardMaterial || m.userData.wx || m.userData.noWeather) return false;
  /* 古い作り方の U(この部品より前の makeWeatherUniforms)でも動くよう、足りない値は足しておく */
  if (!U.uFogSun || !U.uSunDirW || !U.uNightDs || !U.uFogAnti || !U.uFogDir || !U.uDsLo || !U.uDsHi) {
    const D = makeWeatherUniforms();
    Object.keys(D).forEach((k) => { if (!U[k]) U[k] = D[k]; });
  }
  const macro = !!(m.userData.wxMacro && m.map && U.uWxMacro.value);
  const prev = m.onBeforeCompile, base = m.customProgramCacheKey();
  if (!m.userData.wxPudU) m.userData.wxPudU = { value: m.userData.puddle ? 1 : 0 };
  const pud = m.userData.wxPudU;
  m.onBeforeCompile = (sh, r) => {
    prev.call(m, sh, r);
    sh.uniforms.uWet = U.uWet;
    sh.uniforms.uSnow = U.uSnow;
    sh.uniforms.uSnowCol = U.uSnowCol;
    sh.uniforms.uFogSun = U.uFogSun;
    sh.uniforms.uSunDirW = U.uSunDirW;
    sh.uniforms.uFogAnti = U.uFogAnti;
    sh.uniforms.uFogDir = U.uFogDir;
    sh.uniforms.uPud = pud;
    sh.uniforms.uNightDs = U.uNightDs;
    sh.uniforms.uDsLo = U.uDsLo;
    sh.uniforms.uDsHi = U.uDsHi;
    if (macro) { sh.uniforms.uWxMacro = U.uWxMacro; sh.uniforms.uWxFar = U.uWxFar; }
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>' + WX_VERT_HEAD)
      .replace('#include <fog_vertex>', '#include <fog_vertex>' + WX_VERT);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>' + WX_FRAG_HEAD + (macro ? '\nuniform sampler2D uWxMacro;\nuniform float uWxFar;' : ''))
      .replace('#include <roughnessmap_fragment>',
        WX_PRE + (macro ? WX_MACRO : WX_GENERIC) +
        '\n#include <roughnessmap_fragment>' + WX_ROUGH)
      .replace('#include <fog_fragment>', WX_FOG);
  };
  m.customProgramCacheKey = () => base + (macro ? '|wx1m' : '|wx1');
  m.userData.wx = true;
  m.needsUpdate = true;
  return true;
}

/* ---------- 夕焼けの空: 金色の地平線・太陽のまわりの輝き・反対側の「ビーナスの帯」(テクスチャなし) ----------
 * 色はリニアの光の強さ(露出0.95のトーンマップ後に、上は青紫・地平線はだいだいになる値) */
export function makeDuskSky(geometry) {
  const lin = (r, g, b) => new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace);
  const U = {
    uZen: { value: lin(0.061, 0.108, 0.275) },
    uMid: { value: lin(0.466, 0.251, 0.295) },
    uHor: { value: lin(1.08, 0.32, 0.18) },
    uSunCol: { value: lin(2.08, 0.43, 0.09) },
    uAnti: { value: lin(0.38, 0.25, 0.34) },
    /* 太陽と反対側の地平線(地球の影: 青みがかった灰色。のぼりで東へ走ると正面に見える) */
    uHorAnti: { value: lin(0.34, 0.27, 0.36) },
    uSun: { value: new THREE.Vector3(0, 0.05, -1).normalize() },
  };
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: U,
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = ( projectionMatrix * modelViewMatrix * vec4( position, 1.0 ) ).xyww;
      }`,
    fragmentShader: `
      uniform vec3 uZen, uMid, uHor, uSunCol, uAnti, uHorAnti, uSun;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize( vDir );
        float h = d.y, mu = dot( d, uSun ), hh = clamp( h, 0.0, 1.0 );
        /* 地平線の色は方位で変える: 太陽の側はだいだい、反対側は地球の影の青みがかった灰色 */
        vec3 hor = mix( uHorAnti, uHor, smoothstep( -0.6, 0.5, mu ) );
        /* 地平線のだいだい → 低い空のばら色(高さ2〜6°の帯) → 上の青(運転台から見える高さ15°あたりで青になる。
         * ばら色が上まで広がると、空も、空の光で照らされる壁も全部ピンクになる) */
        vec3 c = mix( hor, uMid, smoothstep( 0.0, 0.08, hh ) );
        c = mix( c, uZen, smoothstep( 0.04, 0.3, hh ) );
        /* 太陽の側の輝き(低い所ほど強い。高さ15°より上は青い空のまま: 太陽の方を向く運転台でも上は青) */
        c = mix( c, uSunCol, pow( max( mu, 0.0 ), 3.0 ) * ( 1.0 - smoothstep( 0.0, 0.28, hh ) ) * 0.85 );
        /* 反対側の地平線の少し上のピンクの帯(ビーナスの帯) */
        c = mix( c, uAnti, pow( max( -mu, 0.0 ), 2.0 ) * smoothstep( 0.02, 0.08, hh ) * ( 1.0 - smoothstep( 0.12, 0.3, hh ) ) * 0.6 );
        /* 太陽の円盤(小さく明るい芯)とまわりのにじみ(せまい輝き+うすく広い輝き)。
         * 円盤を強くしすぎると、ブルームで画面の左の4分の1が白くとぶ */
        c += uSunCol * ( smoothstep( 0.99985, 0.99993, mu ) * 8.0 + pow( max( mu, 0.0 ), 900.0 ) * 2.0 + pow( max( mu, 0.0 ), 60.0 ) * 0.25 );
        /* 地平線より下 */
        c = mix( c, hor * 0.45, smoothstep( 0.0, 0.05, -h ) );
        gl_FragColor = vec4( c, 1.0 );
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 999;   // 不透明物の最後に描く(隠れている画素は深度で捨てられる)
  return { mesh, U };
}

/* ---------- 夜空: 紺のグラデーション+地平線の街明かり+星+月(テクスチャなし) ---------- */
export function makeNightSky(geometry) {
  const U = {
    uZen: { value: new THREE.Color(0x1a2132) },
    uHor: { value: new THREE.Color(0x2f3341) },
    uGlow: { value: new THREE.Color(0x3a2416) },
    /* 月は西の空・高さ15°(くだりの運転台の正面〜右前に見える。高いと屋根や表示に隠れる) */
    uMoon: { value: new THREE.Vector3(-0.965, 0.259, -0.034).normalize() },
    uStars: { value: 1 },
  };
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: U,
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = ( projectionMatrix * modelViewMatrix * vec4( position, 1.0 ) ).xyww;
      }`,
    fragmentShader: `
      uniform vec3 uZen, uHor, uGlow, uMoon;
      uniform float uStars;
      varying vec3 vDir;
      float nsHash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
      void main() {
        vec3 d = normalize( vDir );
        float h = d.y;
        vec3 c = mix( uHor, uZen, pow( clamp( h, 0.0, 1.0 ), 0.5 ) ) + uGlow * exp( -max( h, 0.0 ) * 10.0 );
        c = mix( c, uHor * 0.6, smoothstep( 0.0, 0.06, -h ) );
        /* 星: 天頂からの立体射影の格子(三角関数を使わず軽い)。地平線近くは街明かりで見えない */
        vec2 g = d.xz / ( 1.0 + max( h, 0.0 ) ) * 440.0;
        float r = nsHash( floor( g ) );
        float star = step( 0.9965, r ) * smoothstep( 0.38, 0.0, length( fract( g ) - 0.5 ) ) * smoothstep( 0.05, 0.22, h ) * uStars;
        c += vec3( 0.9, 0.95, 1.0 ) * star * ( 0.5 + 1.6 * fract( r * 37.0 ) );
        /* 月: 本当の大きさに近い小さな円盤と、うすいかさ(大きいと空の主役になってしまう) */
        float m = dot( d, uMoon );
        c += vec3( 1.0, 0.96, 0.86 ) * ( smoothstep( 0.99996, 0.99998, m ) * 1.7 + pow( max( m, 0.0 ), 300.0 ) * 0.08 );
        gl_FragColor = vec4( c, 1.0 );
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 999;   // 不透明物の最後に描く(隠れている画素は深度で捨てられる)
  return { mesh, U };
}
