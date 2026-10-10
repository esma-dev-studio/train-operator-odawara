/* =========================================================
 * scene/look.js — 光と空気(時間帯・天気ごとの「見え方」)
 * ・LOOK: 太陽・空の光・露出・霧・ブルーム・前照灯の数値表(調整はここだけで済む)
 * ・HDRの空の下ごしらえ(太陽の円盤を抑える・地平線の色を測る)
 * ・ぬれ/雪を全部の材質にまとめて足すシェーダ部品(weather chunk)
 * ・夜空(星と月)・夕焼けの空の明るさ調整
 * 色は見た目(sRGB)で書く。THREE.Color の setHex は sRGB → リニアに直して持つ。
 * ========================================================= */
import * as THREE from '../vendor/three.module.min.js';

/* sun: [強さ, 色] / hemi: [強さ, 空の色, 地面の色] / fog: [色(nullは空から自動), 近, 遠]
 * bloom: [しきい値, 強さ, 半径](nullはブルームなしで直接描く) / head: 前照灯 / wet・snow: ぬれ・雪の量 */
export const LOOK = {
  day: {
    sun: [4.0, 0xfff1dc], shadow: true, hemi: [0.25, 0xa9c4ea, 0x6a6448],
    exposure: 1.4, bg: 0.78, fog: [null, 80, 1500], fogFallback: 0xb6b9c4,
    bloom: null, head: 0, wet: 0, snow: 0,
  },
  eve: {
    sun: [2.1, 0xffa766], shadow: true, hemi: [0.8, 0xd8a888, 0x4a4038],
    exposure: 0.95, bg: 1, fog: [0x8a6a5a, 60, 1700],
    bloom: [2.5, 0.45, 0.35], head: 70, wet: 0, snow: 0,
  },
  night: {
    sun: [0.35, 0x9fb4e0], shadow: false, hemi: [0.55, 0x5a6e96, 0x1c1a18],
    exposure: 1.05, bg: 1, fog: [0x0b1018, 60, 1050],
    bloom: [1.0, 0.7, 0.4], head: 420, wet: 0, snow: 0,
  },
  nightWet: {
    sun: [0.3, 0x9fb4e0], shadow: false, hemi: [0.5, 0x5a6478, 0x1c1a18],
    exposure: 1.0, bg: 1, fog: [0x10141a, 40, 560],
    bloom: [1.0, 0.7, 0.4], head: 480, wet: 1, snow: 0,
  },
  rain: {
    sun: [0.45, 0xdfe4ea], shadow: false, hemi: [0.42, 0xb4c2d0, 0x50554e],
    exposure: 0.82, bg: 0.62, fog: [null, 40, 780], fogFallback: 0xcfc8c2,
    bloom: [4.0, 0.15, 0.3], head: 0, wet: 1, snow: 0,
  },
  snow: {
    sun: [0.6, 0xf2f4f8], shadow: true, hemi: [0.7, 0xcfdcf5, 0xe8ecf0],
    exposure: 0.88, bg: 1.0, fog: [null, 20, 520], fogFallback: 0xd5d8dc,
    bloom: [4.0, 0.15, 0.3], head: 0, wet: 0.3, snow: 1,
  },
  /* トンネル・ターミナル(目の慣れ k で外の値とまぜる) */
  indoor: { fog: [0x050607, 5, 220], bloom: [1.2, 0.6, 0.4], head: 420 },
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

/* ---------- 色の計算(霧の色を空の地平線にぴったり合わせるため) ---------- */
/* three.js r160 の ACESFilmicToneMapping と同じ式(露出/0.6 → 入力行列 → RRT+ODT → 出力行列) */
export function acesFilmic(rgb, exposure) {
  const s = exposure / 0.6;
  const r = rgb[0] * s, g = rgb[1] * s, b = rgb[2] * s;
  const i0 = 0.59719 * r + 0.35458 * g + 0.04823 * b;
  const i1 = 0.07600 * r + 0.90834 * g + 0.01566 * b;
  const i2 = 0.02840 * r + 0.13383 * g + 0.83777 * b;
  const fit = (v) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.4329510) + 0.238081);
  const a0 = fit(i0), a1 = fit(i1), a2 = fit(i2);
  const sat = (v) => Math.min(1, Math.max(0, v));
  return [
    sat(1.60475 * a0 - 0.53108 * a1 - 0.07367 * a2),
    sat(-0.10208 * a0 + 1.10813 * a1 - 0.00605 * a2),
    sat(-0.00327 * a0 - 0.07276 * a1 + 1.07602 * a2),
  ];
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
  /* 地平線より下 */
  const G = [0.16, 0.15, 0.12], Gh = G.map((v) => t16(v));
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

/* 地平線の明るさ → 霧の色。直接描く(昼・晴れ)ときはトーンマップ後のsRGB、
 * ブルーム経由(リニアのまま描いて最後にトーンマップ)のときはリニアのまま使う */
export function fogFromHorizon(lin, bgIntensity, exposure, direct, out = new THREE.Color()) {
  const c = [lin[0] * bgIntensity, lin[1] * bgIntensity, lin[2] * bgIntensity];
  if (!direct) return out.setRGB(c[0], c[1], c[2]);
  const t = acesFilmic(c, exposure);
  return out.setRGB(t[0], t[1], t[2], THREE.SRGBColorSpace);
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
 * U = { uSnow, uWet, uSnowCol, uWxMacro } を全プログラムで共有するので、
 * 天気を変えても値を書きかえるだけ(作り直し=コンパイルが起きない)。
 * 他の部品の色の加工(color_fragment の後)より後、roughnessmap_fragment の直前に入れる。 */
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
const WX_FRAG_HEAD = `
uniform float uWet;
uniform float uSnow;
uniform vec3 uSnowCol;
varying vec3 vWxN;
varying vec3 vWxP;`;
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
    wxWet *= 0.45;   // 芝はてかてかにしない
  }`;
const WX_GENERIC = `
  if ( uWet > 0.0 ) {
    wxWet = uWet * ( 0.55 + 0.45 * wxUp );
    diffuseColor.rgb *= 1.0 - 0.38 * wxWet;
    #ifdef USE_MAP
      /* 模様のある面(砂利など): すき間(暗い所)は水がしみてさらに暗く、明るい石の上だけ光る。
       * 全体を鏡のようにすると、空が映って乾いた時より白っぽい板に見えてしまう */
      float wxG = smoothstep( 0.08, 0.32, dot( sampledDiffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ) );
      diffuseColor.rgb *= 1.0 - 0.3 * wxWet * ( 1.0 - wxG );
      wxWet *= 0.3 + 0.7 * wxG;
    #endif
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
  float wxWet = 0.0, wxCov = 0.0;`;
const WX_ROUGH = `
  roughnessFactor = mix( roughnessFactor, 0.18, wxWet * wxUp * 0.85 );
  roughnessFactor = mix( roughnessFactor, 0.85, wxCov );`;

export function makeWeatherUniforms() {
  return {
    uSnow: { value: 0 },
    uWet: { value: 0 },
    uSnowCol: { value: new THREE.Color(0xf2f5f8) },
    uWxMacro: { value: null },
    uWxFar: { value: 1 },
  };
}

/* 1つの材質に部品を足す(すでに onBeforeCompile があればそれを先に実行する) */
export function installWeather(m, U) {
  if (!m || !m.isMeshStandardMaterial || m.userData.wx || m.userData.noWeather) return false;
  const macro = !!(m.userData.wxMacro && m.map && U.uWxMacro.value);
  const prev = m.onBeforeCompile, base = m.customProgramCacheKey();
  m.onBeforeCompile = (sh, r) => {
    prev.call(m, sh, r);
    sh.uniforms.uWet = U.uWet;
    sh.uniforms.uSnow = U.uSnow;
    sh.uniforms.uSnowCol = U.uSnowCol;
    if (macro) { sh.uniforms.uWxMacro = U.uWxMacro; sh.uniforms.uWxFar = U.uWxFar; }
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>' + WX_VERT_HEAD)
      .replace('#include <fog_vertex>', '#include <fog_vertex>' + WX_VERT);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>' + WX_FRAG_HEAD + (macro ? '\nuniform sampler2D uWxMacro;\nuniform float uWxFar;' : ''))
      .replace('#include <roughnessmap_fragment>',
        WX_PRE + (macro ? WX_MACRO : WX_GENERIC) +
        '\n#include <roughnessmap_fragment>' + WX_ROUGH);
  };
  m.customProgramCacheKey = () => base + (macro ? '|wx1m' : '|wx1');
  m.userData.wx = true;
  m.needsUpdate = true;
  return true;
}

/* ---------- 夕焼けの空(Sky)の明るさを下げる(元のままだと露出0.95では白く飛ぶ) ---------- */
export function patchSkyGain(skyMat, gain) {
  if (skyMat.uniforms.skyGain) return;
  skyMat.uniforms.skyGain = { value: gain };
  skyMat.fragmentShader = 'uniform float skyGain;\n' +
    skyMat.fragmentShader.replace('gl_FragColor = vec4( retColor, 1.0 );', 'gl_FragColor = vec4( retColor * skyGain, 1.0 );');
  skyMat.needsUpdate = true;
}

/* ---------- 夜空: 紺のグラデーション+地平線の街明かり+星+月(テクスチャなし) ---------- */
export function makeNightSky(geometry) {
  const U = {
    uZen: { value: new THREE.Color(0x03060d) },
    uHor: { value: new THREE.Color(0x18202f) },
    uGlow: { value: new THREE.Color(0x4a3426) },
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
        float m = dot( d, uMoon );
        c += vec3( 1.0, 0.96, 0.86 ) * ( smoothstep( 0.9999, 0.99994, m ) * 1.7 + pow( max( m, 0.0 ), 600.0 ) * 0.14 );
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
