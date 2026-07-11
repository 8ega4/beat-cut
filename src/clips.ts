import type { ClipItem } from './types';

export const MAX_CLIPS = 5;
export const MIN_CLIPS = 2;

const ACCEPTED = /\.(mp4|mov|webm)$/i;
const ACCEPTED_MIME = /^video\/(mp4|quicktime|webm)$/i;

export function isAcceptedVideo(file: File): boolean {
  return ACCEPTED_MIME.test(file.type) || ACCEPTED.test(file.name);
}

// File → objectURL → 常駐<video>要素 + サムネイル生成。サーバーへは送信しない。
export async function loadClip(file: File): Promise<ClipItem> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';

  await withTimeout(
    new Promise<void>((res, rej) => {
      video.onloadedmetadata = () => res();
      video.onerror = () => rej(new Error('動画を読み込めませんでした。対応形式は mp4 / mov / webm です。'));
    }),
    15000,
    '読み込みがタイムアウトしました。ファイルが大きすぎるか、非対応のコーデックです。',
  );

  if (!isFinite(video.duration) || video.duration < 1) {
    URL.revokeObjectURL(url);
    throw new Error('1秒未満の動画は使えません。');
  }

  // サムネイル: 冒頭付近のフレームを9:16でcover crop
  const thumbAt = Math.min(0.4, video.duration / 2);
  await seekOnce(video, thumbAt);
  const c = document.createElement('canvas');
  c.width = 108;
  c.height = 192;
  const ctx = c.getContext('2d')!;
  drawCover(ctx, video, 108, 192);
  const thumb = c.toDataURL('image/jpeg', 0.7);

  return {
    id: crypto.randomUUID(),
    file,
    url,
    duration: video.duration,
    width: video.videoWidth,
    height: video.videoHeight,
    thumb,
    video,
  };
}

export function disposeClip(clip: ClipItem): void {
  clip.video.pause();
  clip.video.removeAttribute('src');
  clip.video.load();
  URL.revokeObjectURL(clip.url);
}

function seekOnce(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((res) => {
    const timer = setTimeout(done, 3000);
    function done() {
      clearTimeout(timer);
      v.removeEventListener('seeked', done);
      res();
    }
    v.addEventListener('seeked', done);
    v.currentTime = t;
  });
}

function drawCover(
  ctx: CanvasRenderingContext2D,
  v: HTMLVideoElement,
  w: number,
  h: number,
): void {
  const sAspect = v.videoWidth / v.videoHeight;
  const dAspect = w / h;
  let sw = v.videoWidth;
  let sh = v.videoHeight;
  if (sAspect > dAspect) sw = sh * dAspect;
  else sh = sw / dAspect;
  ctx.drawImage(v, (v.videoWidth - sw) / 2, (v.videoHeight - sh) / 2, sw, sh, 0, 0, w, h);
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(msg)), ms)),
  ]);
}
