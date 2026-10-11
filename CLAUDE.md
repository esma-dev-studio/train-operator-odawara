# このフォルダのルール（TRAIN OPERATOR 小田原線）

## トーン（最重要）
- 見た目は**本格運転シミュレーター**（業務機器調・かわいい装飾はしない）を維持しつつ、
  **文言は小学2年生でも読める**ようにする（2026-07-28 ユーザー指示で方針変更）:
  難読漢字には`<ruby>`でふりがな、説明はやさしい言い回し、駅名はかな併記
  （かな辞書は `sim/kana.js`）。
- iPad(タッチ)がファーストクラス: importmapは使わない（古いSafari非対応。
  three.jsは相対パスでimport）。ボタンは `touch-action: manipulation`。
- 実プレイ(小2)の学び: 専門用語のランプは平易に（「パターン接近」→「スピードちゅうい」）。
  ノッチ表示列(P4〜EB)は子どもが触りがちなので**表示列自体を操作UI**にしてある。
  ATSの先行パターンでのブレーキは理由をコーチ表示で説明する（「このさきは◯◯まで」）。
  画面下の「いまやること」コーチ(#coach)が常に次の一手を出す。壊さないこと。
- 権利面: 社名・ロゴ・実車デザイン・実ダイヤは使わない。駅名と線形は公共データ由来の
  事実情報として使用し、出典（国土数値情報 N02 / 国土地理院）をタイトルとREADMEに明記する。

## 構成
- `sim/engine.js` は **DOM非依存**（Node直接実行でテスト可能）。描画は `scene/`、計器は `cab/`、音は `audio/`、画面部品は `ui/`。
- `data/line.json` は `tools/preprocess.mjs` で生成（標高は `tools/elev_cache.json` にキャッシュ）。
  エンジン・描画には必ず `prepareLine(raw, 'down'|'up')`（`sim/line.js`）を通した線形を渡す
  （新宿側に260mの余白を足し、のぼりは全体を反転。駅の s・制限・区間がずれるので生データを直接使わない）。
- ダイヤは `tools/autodrive.mjs --calibrate` で実走から自動校正（くだり3種別＋のぼり3種別 `*_up`、3パス）。
  エンジンの物理・信号・停車時分を変えたら必ず再校正する。自動運転は `sim/autopilot.js` に一本化。
- three.js r160 は `vendor/` にローカル同梱し**相対パスで import**（ビルド無し）。追加の examples/jsm は
  `vendor/addons/` に置き、`from 'three'` を `'../three.module.min.js'` に書き換える。
- 3Dステージは1つだけ（タイトル・選択画面の背景でも自動運転のデモ列車が走る）。路線(方向)が変わると
  `RailScene.setWorld()` でワールドを作り直す。全線ぶんの InstancedMesh・帯は `_splitInstances`/`_splitRibbons`
  で約700m単位に分割している（視錐台カリングのため。新しい沿線物も world 直下に足せば自動で分割される）。
  分割したセルは遠いと描かない(`userData.cullCell`)ので、自分で見え隠れを切り替える物は `cullCell=false` か
  `material.visible` で切り替える。作ったあと動かす物には `userData.dyn = true`（静的な物は行列を凍結している）。
  ワールドは `setWorldAsync` で小分けに作り、シェーダは `prewarmAsync` で暗転のあいだに先に作る。
- シェーダ数は少なく保つ（q=mid で 80 以下）: `onBeforeCompile` には必ず固定の `customProgramCacheKey`。
  ぬれ・雪は `scene/look.js` の共通部品だけで扱い、時間帯×天気の光・霧・ブルームの数値も look.js の表に集める。
  材質を物ごとに clone しない。
- 古いiPad Safari のため `?.` / `??` / `||=` は使わない。新しいCSS(color-mix など)には代わりの値を用意する。
- 画面の作りは5つの係に分かれている: 街 `town.js`/`facade.js`/`cars.js`/`shopsign.js`/`roadtraffic.js`、
  駅と線路 `stations.js`/`signage.js`/`trackbed.js`/`lightpool.js`、光 `look.js`/`weatherfx.js`、
  運転台 `cockpit.js`+`cab/cab.js`、画面とHUD `main.js`/`ui/`。scene.js は組み立て・描画の流れ・カメラ。
- `sw.js` の `VERSION` は公開のたびに上げる（上げないとホーム画面版のiPadが古いまま）。ファイルを増やしたら `CORE` にも足し、
  `node tools/check-sw.mjs` で漏れがないか確認する（漏れるとオフライン起動が読み込み中で止まる）。

## 検証
- エンジン回帰: `node tools/autodrive.mjs local|exp|rapid [clear|rain|snow] [up]`
  → 完走・ATS照査0回・停止誤差±2m以内が合格ライン（18通り）。
- ブラウザ検証: ローカルHTTPサーバ必須（ESモジュール+fetch）。`npx http-server -p 8123 -c-1 .` →
  `node tools/e2e.mjs` でタイトル→区間運転(自動)→成績票→スタンプ帳の通しとスクリーンショット。
  `?debug=1` で `__test.fast(倍率)`・`__test.auto(true)`・`__test.setup({...})`・`__test.cam(...)`、`&q=low` で画質指定。
  ソフトウェア描画(swiftshader)はブルームが極端に遅いので `q=low` で確認し、見た目確認は実GPUで。
  ヘッドレスEdgeは `--enable-gpu --use-angle=d3d11` で**実GPU描画**になる
  （スクショの見た目確認・fps計測はこちら。`--enable-unsafe-swiftshader` は保険）。
- 見た目の確認: `node tools/shots.mjs <出力先> [場面名の一部...]` で決まった40場面を撮り、
  `calls.json` の draw call(≤230)・三角形(≤40万)・シェーダ数(≤80) も見る。
- 音は `tools/audio-test.html`（試聴台）。
- 色の注意: three.js r152+ は色管理が有効。`setRGB`/頂点色は**リニア解釈**なので、
  見た目(sRGB)で指定したい時は `THREE.SRGBColorSpace` を渡すか `pow(x, 2.2)` する。

## デプロイ
- `git push origin main` → GitHub Pages（mainブランチ直接公開）。
  公開URL: https://esma-dev-studio.github.io/train-operator-odawara/
  コミットは noreply メール（`280012992+esma-dev-studio@users.noreply.github.com`）。
