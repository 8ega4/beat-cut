import type { Renderer } from './renderer';

// 書き出し: canvas.captureStream(0) + AudioContext.createMediaStreamDestination を
// 1つの MediaStream に合成して MediaRecorder で録画する。
// 音声を<audio>タグ経由にしないこと(音ズレの主因)。
// スパイクSP1実測: A/Vオフセット平均-6ms、30秒でのドリフト-4ms。

// iOS(Chrome/Firefox含む全ブラウザがWebKit製)は isTypeSupported が
// webmを「対応あり」と誤答する一方、実際に録画するとデータが出ない・
// AudioContext.resume()が返らない等で進捗が0%のまま固まることがある。
// 機能検出だけに頼らずUA判定で確実に弾く。
function isIOS(): boolean {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  // iPadOS 13+はデスクトップUAを名乗るため、タッチ対応のMacintoshで判定
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
}

export function exportMime(): string | null {
  if (isIOS()) return null;
  if (typeof MediaRecorder === 'undefined') return null;
  if (!('captureStream' in HTMLCanvasElement.prototype)) return null;
  for (const m of ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus']) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return null;
}

export function canExport(): boolean {
  return exportMime() !== null;
}

// 低スペック端末は720pへフォールバック
export function pickExportSize(): { w: number; h: number } {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const lowEnd =
    (nav.deviceMemory !== undefined && nav.deviceMemory <= 4) ||
    /iPhone|iPad|Android/i.test(navigator.userAgent);
  return lowEnd ? { w: 720, h: 1280 } : { w: 1080, h: 1920 };
}

export interface ExportOptions {
  duration: number; // 秒(進捗計算用)
  onProgress: (ratio: number) => void;
}

export async function exportVideo(renderer: Renderer, opts: ExportOptions): Promise<Blob> {
  const mime = exportMime();
  if (!mime) throw new Error('この環境は書き出しに対応していません');

  const canvas = renderer.canvas;
  const prevW = canvas.width;
  const prevH = canvas.height;
  const size = pickExportSize();
  canvas.width = size.w;
  canvas.height = size.h;

  const ac = renderer.audioContext();
  const dest = ac.createMediaStreamDestination();
  const vstream = canvas.captureStream(0);
  const vtrack = vstream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
  const combined = new MediaStream([vtrack, ...dest.stream.getAudioTracks()]);

  const rec = new MediaRecorder(combined, {
    mimeType: mime,
    videoBitsPerSecond: size.w >= 1080 ? 12_000_000 : 8_000_000,
    audioBitsPerSecond: 128_000,
  });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  const stopped = new Promise<void>((r) => (rec.onstop = () => r()));

  const prevEnded = renderer.onEnded;
  const prevTime = renderer.onTime;
  try {
    // 全クリップを事前デコード + エンコーダのウォームアップ(捨て録り)。
    // 初回書き出しでエンコーダ初期化中のフレーム落ちが起きるのを防ぐ
    await withTimeout(renderer.prime(), 10_000, '動画の準備がタイムアウトしました');
    const warm = new MediaRecorder(new MediaStream([vtrack]), {
      mimeType: mime,
      videoBitsPerSecond: 4_000_000,
    });
    const warmStopped = new Promise<void>((r) => (warm.onstop = () => r()));
    warm.start();
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 33));
      vtrack.requestFrame();
    }
    warm.stop();
    await warmStopped;

    // 本録画: キャプチャは30fpsにペーシングしてエンコーダ負荷を安定させる
    let lastCap = 0;
    rec.start(1000);
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        renderer.onEnded = () => resolve();
        renderer.onTime = (t) => opts.onProgress(Math.min(1, t / opts.duration));
        renderer
          .start({
            extraAudioOut: dest,
            onFrameDrawn: () => {
              const now = performance.now();
              if (now - lastCap >= 31) {
                lastCap = now;
                vtrack.requestFrame();
              }
            },
          })
          .catch(reject);
      }),
      // 想定尺+10秒を超えたら録画エンジンが応答不能になったと判断する
      opts.duration * 1000 + 10_000,
      '録画がタイムアウトしました。ブラウザやOSの制限で書き出しに対応していない可能性があります。',
    );
    rec.stop();
    await stopped;
  } finally {
    renderer.onEnded = prevEnded;
    renderer.onTime = prevTime;
    canvas.width = prevW;
    canvas.height = prevH;
  }
  return new Blob(chunks, { type: 'video/webm' });
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}
