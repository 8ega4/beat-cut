import { defineConfig } from 'vite';

// GitHub Pages配信用: https://8ega4.github.io/beat-cut/ 配下に置くため
// アセットの参照パスをリポジトリ名でプレフィックスする。
// Cloudflare Pagesなど独自ドメイン配信に切り替える場合は '/' に戻す。
export default defineConfig({
  base: '/beat-cut/',
});
