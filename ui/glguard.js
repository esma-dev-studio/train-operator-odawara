/* =========================================================
 * ui/glguard.js — WebGLの文脈が消えたとき(iPadが裏で回収した・メモリ不足)の立ちなおり
 * 消えた: 運転中なら一時停止し、暗転(じゅんび中)を出して 3Dの描画を止める(app._glLost)。
 * もどった(webglcontextrestored)、または 画面にもどって1.5秒たっても もどらない:
 *   ステージ(RailScene)を新しいキャンバスで作りなおし、運転中なら同じ路線・同じ位置・同じ時間帯と天気、
 *   同じカメラに もどして シェーダを準備してから 暗転を明ける(運転は一時停止のまま)。
 *   運転中でなければ タイトルのデモ走行に もどす。
 * 文脈のイベントは泡立たない(bubbles しない)が、上の要素の「捕まえる側(capture)」では見える。
 * app._rebuildScene が古いキャンバスの文脈を自分で消すときのイベントは むしする(作りなおし中の印)。
 * 使い方: installGlGuard(app)  (app は main.js の App。scene・_rebuildScene・_enterAttract などを使う)
 * ========================================================= */

const $ = (s) => document.querySelector(s);

export function installGlGuard(app) {
  if (!app || app._glGuard) return app ? app._glGuard : null;
  const G = { lost: false, rebuilding: false, recovering: false, waitT: null, n: 0 };
  app._glGuard = G;
  app._glLost = false;

  /* 作りなおし中(古い文脈を消す)のイベントで 立ちなおりを始めない */
  if (typeof app._rebuildScene === 'function') {
    const orig = app._rebuildScene;
    app._rebuildScene = function (...a) {
      G.rebuilding = true;
      try { return orig.apply(this, a); } finally { G.rebuilding = false; }
    };
  }

  const canvasNow = () => (app.scene && app.scene.renderer ? app.scene.renderer.domElement : null);
  const fadeOn = (on) => {
    const f = $('#fade');
    if (!f) return;
    if (on) f.classList.add('on', 'slow');
    else { f.classList.remove('on'); f.classList.remove('slow'); }
  };

  const onLost = (ev) => {
    if (G.rebuilding || !ev || ev.target !== canvasNow()) return;
    if (typeof ev.preventDefault === 'function') ev.preventDefault();   // もどせるように(webglcontextrestored が来る)
    if (G.lost) return;
    G.lost = true;
    G.n++;
    app._glLost = true;
    if (app.mode === 'drive' && app.running && !app.paused && typeof app.setPaused === 'function') {
      try { app.setPaused(true); } catch (e) { /* noop */ }
    }
    fadeOn(true);
    /* 画面に出ているのに もどらない(しばらく待つ)ときも作りなおす */
    clearTimeout(G.waitT);
    if (!document.hidden) G.waitT = setTimeout(() => { if (G.lost) recover(); }, 1500);
  };

  const onRestored = (ev) => {
    if (G.rebuilding || !ev || ev.target !== canvasNow()) return;
    if (G.lost) recover();
  };

  /* 立ちなおり: 新しいキャンバスでステージを作りなおし、運転中なら同じ場面へ */
  async function recover() {
    if (G.recovering || !G.lost) return;
    G.recovering = true;
    clearTimeout(G.waitT);
    fadeOn(true);
    try {
      const old = app.scene;
      const cam = old && old.camMode ? old.camMode : 'cab';
      const driving = app.mode === 'drive' && !!app.sim && !!app.line;
      if (typeof app._rebuildScene === 'function') app._rebuildScene();
      const S = app.scene;
      if (S && S !== old) {
        if (driving) {
          if (typeof S.setWorldAsync === 'function') await S.setWorldAsync(app.line, app.sim);
          else S.setWorld(app.line, app.sim);
          S.setTimeOfDay(app.daytime);
          S.setWeather(app.weather);
          S.guide = app.settings ? app.settings.guide : S.guide;
          if (typeof app._setCam === 'function') app._setCam(cam); else S.setCameraMode(cam);
          if (typeof app.resizeGL === 'function') app.resizeGL();
        } else if (typeof app._enterAttract === 'function') {
          app._enterAttract();
        }
        if (typeof S.prewarmAsync === 'function') {
          await Promise.race([S.prewarmAsync(), new Promise((r) => setTimeout(r, 12000))]);
        } else if (typeof S.prewarm === 'function') {
          S.prewarm();
        }
        app._pauseDirty = true;   // 一時停止中でも 1回 描きなおす
      }
    } catch (e) {
      console.warn('[glguard] recover failed', e);
    } finally {
      G.lost = false;
      G.recovering = false;
      app._glLost = false;
      if (!app._starting) fadeOn(false);
    }
  }

  const wrap = $('#gl-wrap') || document.body;
  wrap.addEventListener('webglcontextlost', onLost, true);
  wrap.addEventListener('webglcontextrestored', onRestored, true);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !G.lost) return;
    clearTimeout(G.waitT);
    G.waitT = setTimeout(() => { if (G.lost) recover(); }, 1500);
  });
  G.recover = recover;
  return G;
}
