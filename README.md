# BeatCut

クリップを入れる。ビートに刻む。 — 動画クリップ(2〜5本)を選んだ楽曲のビートに合わせて自動カット編集し、15秒/30秒の縦型MV(webm)をブラウザ内だけで生成するツール。

- 完全クライアントサイド(動画・音声はサーバーに送信されない)
- Vite + Vanilla TypeScript / 静的ホスティング(GitHub Pages / Cloudflare Pages)
- デモ: https://8ega4.github.io/beat-cut/

## 開発

```bash
npm install
npm run dev    # 開発サーバー(base=/beat-cut/ のため http://localhost:5199/beat-cut/)
npm run build  # tsc --noEmit + vite build → dist/
```

mainブランチへのpushでGitHub Actionsがdistをビルドし、GitHub Pagesへ自動デプロイする。

## プリセット楽曲の差し替え(public/music/)

`public/music/manifest.json` のエントリ構造:

```json
{
  "id": "strobe-rush",
  "title": "Strobe Rush",
  "mood": "エレクトロ / ストロボ",
  "theme": "flash",
  "bpm": 128,
  "beatOffsetSec": 0,
  "file": "hyper-bloom.webm"
}
```

- `theme`: flash / glitch / vhs / mono / clean。エフェクトテーマ選択時にこの値が一致する曲がリスト先頭にレコメンド表示される(選択の強制はしない)
- `bpm` / `beatOffsetSec`: BPM既知としてビート解析をスキップし、この2値からビートグリッドを直接計算する。**音源を差し替えたら必ず実測値に更新すること**
- **仮置き中の曲**: strobe-rush / signal-break / cassette-memory / concrete / daylight は音源未制作のため、既存3曲のファイルを参照している(`file` が他エントリと重複)。`bpm` は仮の公称値、`beatOffsetSec: 0`。本番音源を置いたら `file` を差し替え、bpm/offsetを実測値へ更新する
- 実測手順: アプリの「自分の曲を使う」から音源をアップロードすると解析結果のBPM/オフセットが表示される。波形上のビートマーカーが拍頭に一致することを目視確認してからmanifestへ転記する
- 音源フォーマット: `fetch` + `decodeAudioData` で読むため、ブラウザがデコードできる形式なら何でもよい(現行はopus/webm。WAVから `AudioContext` + `MediaRecorder` で再エンコードして約1/9に圧縮している)
