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
- `sim/engine.js` は **DOM非依存**（Node直接実行でテスト可能）。描画は `scene/`、計器は `cab/`、音は `audio/`。
- `data/line.json` は `tools/preprocess.mjs` で生成（標高は `tools/elev_cache.json` にキャッシュ）。
  ダイヤは `tools/autodrive.mjs --calibrate` で実走から自動校正（3パス）。
- three.js は `vendor/` にローカル同梱・importmap 参照（ビルド無し）。

## 検証
- エンジン回帰: `node tools/autodrive.mjs local|exp|rapid [clear|rain]`
  → 完走・ATS照査0回・停止誤差±2m以内が合格ライン。
- ブラウザ検証: ローカルHTTPサーバ必須（ESモジュール+fetch）。`?debug=1` で
  `__test.fast(倍率)`・`__test.auto(true)` を使い、ヘッドレスEdgeで
  成績票までのE2Eとスクリーンショットを確認してからデプロイする。
  ヘッドレスEdgeは `--enable-gpu --use-angle=d3d11` で**実GPU描画**になる
  （スクショの見た目確認・fps計測はこちら。`--enable-unsafe-swiftshader` は保険）。
- 色の注意: three.js r152+ は色管理が有効。`setRGB`/頂点色は**リニア解釈**なので、
  見た目(sRGB)で指定したい時は `THREE.SRGBColorSpace` を渡すか `pow(x, 2.2)` する。

## デプロイ
- `git push origin main` → GitHub Pages（mainブランチ直接公開）。
  公開URL: https://esma-dev-studio.github.io/train-operator-odawara/
  コミットは noreply メール（`280012992+esma-dev-studio@users.noreply.github.com`）。
