/* =========================================================
 * ui/glguard.js — WebGLの文脈が消えたとき(iPadが裏で回収した・メモリ不足)の立ちなおり
 * 消えた: 運転中なら一時停止し、暗転(じゅんび中)を出して 3Dの描画を止める(app._glLost)。
 * もどった(webglcontextrestored)、または 画面にもどって1.5秒たっても もどらない:
 *   ステージ(RailScene)を新しいキャンバスで作りなおし、運転中なら同じ路線・同じ位置・同じ時間帯と天気、
 *   同じカメラに もどして シェーダを準備してから 暗転を明ける(運転は一時停止のまま)。
 *   運転中でなければ タイトルのデモ走行に もどす。
 *   作りなおせなかった(新しい文脈も とれない など)ときは 暗転・一時停止のまま、間を あけて もういちど。
 * 起動中(これを 入れる まえ)に 消えていたときも、入れたときに 立ちなおる(app._bootLost・scene.glLost)。
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

  /* 「じゅんび中」の ことば(作りなおしが なんども だめなときだけ かえる) */
  const msgEl = $('#fade .fade-msg');
  const msg0 = msgEl ? msgEl.innerHTML : '';
  const setHelp = (on) => {
    if (!msgEl) return;
    const f = $('#fade');
    if (on) {
      if (f) f.classList.remove('card');   // カードの かわりに ことばを 出す
      msgEl.classList.add('help');
      msgEl.innerHTML = '<i class="fm-bar"></i>うまく うつらないときは、いちど とじて もういちど ひらいてね';
    } else if (msgEl.innerHTML !== msg0) {
      msgEl.classList.remove('help');
      msgEl.innerHTML = msg0;
    }
  };

  /* 消えた ことにする(イベントから・入れる まえに 消えていた・作りなおしに しっぱいした)。
   * 運転中なら一時停止、暗転、delay ミリ秒後に 作りなおす(裏に いるときは もどってから) */
  function markLost(delay) {
    if (!G.lost) { G.lost = true; G.n++; }
    app._glLost = true;
    if (app.mode === 'drive' && app.running && !app.paused && typeof app.setPaused === 'function') {
      try { app.setPaused(true); } catch (e) { /* noop */ }
    }
    fadeOn(true);
    clearTimeout(G.waitT);
    if (!document.hidden && !G.recovering) G.waitT = setTimeout(() => { if (G.lost && !document.hidden) recover(); }, Math.max(0, delay || 0));
  }

  const onLost = (ev) => {
    if (G.rebuilding || !ev || ev.target !== canvasNow()) return;
    if (typeof ev.preventDefault === 'function') ev.preventDefault();   // もどせるように(webglcontextrestored が来る)
    if (G.lost) return;
    /* 画面に出ているのに もどらない(しばらく待つ)ときも作りなおす */
    markLost(1500);
  };

  const onRestored = (ev) => {
    if (G.rebuilding || !ev || ev.target !== canvasNow()) return;
    if (G.lost) recover();
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const menuMode = () => app.mode !== 'drive';

  /* 立ちなおり: 新しいキャンバスでステージを作りなおし、運転中なら同じ場面へ。
   * ワールドと空は 新しいステージで 少しずつ 作る(app._rebuildScene は ワールドを あとまわしに する) */
  async function recover() {
    if (G.recovering || !G.lost) return;
    G.recovering = true;
    clearTimeout(G.waitT);
    fadeOn(true);
    let ok = false;
    try {
      const old = app.scene;
      const cam = old && old.camMode ? old.camMode : 'cab';
      const sim0 = app.sim;
      const driving = app.mode === 'drive' && !!app.sim && !!app.line;
      if (typeof app._rebuildScene === 'function') app._rebuildScene();
      const S = app.scene;
      if (S && S !== old) {
        if (driving) {
          if (typeof S.setWorldAsync === 'function') await S.setWorldAsync(app.line, app.sim);
          else S.setWorld(app.line, app.sim);
          if (app.scene === S && app.mode === 'drive' && app.sim === sim0) {
            S.setTimeOfDay(app.daytime);
            S.setWeather(app.weather);
            S.guide = app.settings ? app.settings.guide : S.guide;
            if (typeof app._setCam === 'function') app._setCam(cam); else S.setCameraMode(cam);
            if (typeof app.resizeGL === 'function') app.resizeGL();
          } else if (app.scene === S && menuMode() && typeof app._enterAttract === 'function') {
            app._enterAttract();   // 作っている あいだに 運転を やめた
          }
          /* 作っている あいだに 新しい運転が はじまった: beginRun が この ステージを もう ととのえた */
        } else {
          /* タイトルの デモ走行の ワールドを 少しずつ 作ってから のせる */
          const A = app.attract;
          if (A && A.line && typeof S.setWorldAsync === 'function') await S.setWorldAsync(A.line, A.sim);
          /* 出発の じゅんび中(運転画面で まだ beginRun の まえ)なら、beginRun が この ステージを ととのえる */
          if (app.scene === S && menuMode() && typeof app._enterAttract === 'function') app._enterAttract();
        }
        if (app.scene === S) {
          if (typeof S.prewarmAsync === 'function') {
            /* 遅い端末でも 準備が終わってから明ける(止まったときだけ 30秒で先へ) */
            await Promise.race([S.prewarmAsync(), sleep(30000)]);
            /* それでも 準備中(描かない)なら、おわるまで 暗転のまま(12秒まで) */
            const t0 = performance.now();
            while (app.scene === S && S._warming && !S.glLost && performance.now() - t0 < 12000) await sleep(50);
          } else if (typeof S.prewarm === 'function') {
            S.prewarm();
          }
        }
        app._pauseDirty = true;   // 一時停止中でも 1回 描きなおす
        /* 作りなおした ステージが また 消えていたら・とちゅうで 捨てられたら(cancelAsync)、もういちど */
        ok = app.scene === S && !S.glLost && !S._dead;
      }
    } catch (e) {
      console.warn('[glguard] recover failed', e);
    } finally {
      G.recovering = false;
      if (ok) {
        G.fail = 0;
        G.lost = false;
        app._glLost = false;
        setHelp(false);
        if (!app._starting) fadeOn(false);
      } else {
        /* 作れなかった: 暗転・一時停止のまま、少しあとで もういちど(だんだん 間を あける。3回 だめなら ことばを 出す) */
        G.fail = (G.fail || 0) + 1;
        if (G.fail >= 3) setHelp(true);
        markLost(Math.min(30000, 1500 * Math.pow(2, Math.min(G.fail, 4))));
      }
    }
  }

  const wrap = $('#gl-wrap') || document.body;
  wrap.addEventListener('webglcontextlost', onLost, true);
  wrap.addEventListener('webglcontextrestored', onRestored, true);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !G.lost) return;
    clearTimeout(G.waitT);
    G.waitT = setTimeout(() => { if (G.lost && !document.hidden) recover(); }, 1500);
  });
  G.recover = recover;
  G.markLost = markLost;

  /* 入れる まえ(起動中)に 文脈が 消えていた: いま 立ちなおる(消えたイベントは 2回 こない。
   * もどっていても 環境光などは からっぽなので 作りなおす) */
  let dead = !!app._bootLost;
  try {
    const S0 = app.scene;
    if (S0 && (S0.glLost || S0.glLostOnce)) dead = true;
    if (S0 && S0.renderer && S0.renderer.getContext().isContextLost()) dead = true;
  } catch (e) { /* noop */ }
  if (dead) markLost(0);
  return G;
}
