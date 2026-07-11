import type { ThemeId } from './types';

// テーマ = カラーグレード + ビート同期モーションのセット。
// すべて canvas 2D の合成モードで実装(Safariが ctx.filter 非対応のため filter は使わない)

export interface FrameInfo {
  w: number;
  h: number;
  t: number;           // 出力タイムライン秒
  beatPhase: number;   // 現在ビート内の位相 0..1
  beatPeriod: number;  // 秒
  cutAge: number;      // カット開始からの秒
  cutProgress: number; // カット内の進行 0..1
  cutIndex: number;
  intensity: number;   // 0..1
}

export type DrawVideo = (opts?: { scale?: number; dx?: number; dy?: number }) => void;

export interface Theme {
  id: ThemeId;
  label: string;
  desc: string;
  beatsPerCut: (bpm: number) => number;
  render(ctx: CanvasRenderingContext2D, drawVideo: DrawVideo, f: FrameInfo): void;
}

// ---- 共有リソース(ノイズ・スキャンライン・スナップショット) ----

let noiseFrames: HTMLCanvasElement[] | null = null;
function getNoise(): HTMLCanvasElement[] {
  if (!noiseFrames) {
    noiseFrames = [];
    for (let f = 0; f < 4; f++) {
      const c = document.createElement('canvas');
      c.width = 256;
      c.height = 256;
      const x = c.getContext('2d')!;
      const img = x.createImageData(256, 256);
      for (let i = 0; i < img.data.length; i += 4) {
        const v = (Math.random() * 255) | 0;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
      x.putImageData(img, 0, 0);
      noiseFrames.push(c);
    }
  }
  return noiseFrames;
}

let scanlineTile: HTMLCanvasElement | null = null;
function getScanlines(): HTMLCanvasElement {
  if (!scanlineTile) {
    scanlineTile = document.createElement('canvas');
    scanlineTile.width = 4;
    scanlineTile.height = 4;
    const x = scanlineTile.getContext('2d')!;
    x.fillStyle = '#000';
    x.fillRect(0, 2, 4, 2);
  }
  return scanlineTile;
}

let snap: HTMLCanvasElement | null = null;
let tintC: HTMLCanvasElement | null = null;
function ensureSize(c: HTMLCanvasElement, w: number, h: number) {
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
}
function getSnap(w: number, h: number) {
  if (!snap) snap = document.createElement('canvas');
  ensureSize(snap, w, h);
  return snap;
}
function getTint(w: number, h: number) {
  if (!tintC) tintC = document.createElement('canvas');
  ensureSize(tintC, w, h);
  return tintC;
}

// 現フレームのスナップショットに色を掛けたコピーをオフセット合成(RGBずらし/色収差)
function chromaShift(
  ctx: CanvasRenderingContext2D,
  f: FrameInfo,
  shifts: Array<{ color: string; dx: number; dy: number; alpha: number }>,
) {
  const s = getSnap(f.w, f.h);
  const sx = s.getContext('2d')!;
  sx.globalCompositeOperation = 'source-over';
  sx.globalAlpha = 1;
  sx.drawImage(ctx.canvas, 0, 0);
  const tc = getTint(f.w, f.h);
  const tx = tc.getContext('2d')!;
  for (const sh of shifts) {
    tx.globalCompositeOperation = 'source-over';
    tx.globalAlpha = 1;
    tx.drawImage(s, 0, 0);
    tx.globalCompositeOperation = 'multiply';
    tx.fillStyle = sh.color;
    tx.fillRect(0, 0, f.w, f.h);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = sh.alpha;
    ctx.drawImage(tc, sh.dx, sh.dy);
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
}

function fillComposite(
  ctx: CanvasRenderingContext2D,
  f: FrameInfo,
  gco: GlobalCompositeOperation,
  color: string,
  alpha: number,
) {
  if (alpha <= 0.005) return;
  ctx.globalCompositeOperation = gco;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, f.w, f.h);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
}

// 自分自身を overlay 合成 → コントラスト増強の定番トリック
function contrastBoost(ctx: CanvasRenderingContext2D, _f: FrameInfo, alpha: number) {
  if (alpha <= 0.005) return;
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = alpha;
  ctx.drawImage(ctx.canvas, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
}

function drawNoise(ctx: CanvasRenderingContext2D, f: FrameInfo, alpha: number, gco: GlobalCompositeOperation = 'source-over') {
  if (alpha <= 0.005) return;
  const frames = getNoise();
  const tile = frames[(Math.random() * frames.length) | 0];
  ctx.globalCompositeOperation = gco;
  ctx.globalAlpha = alpha;
  const pat = ctx.createPattern(tile, 'repeat')!;
  ctx.fillStyle = pat;
  ctx.fillRect(0, 0, f.w, f.h);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
}

function drawScanlines(ctx: CanvasRenderingContext2D, f: FrameInfo, alpha: number) {
  if (alpha <= 0.005) return;
  ctx.globalAlpha = alpha;
  const pat = ctx.createPattern(getScanlines(), 'repeat')!;
  ctx.fillStyle = pat;
  ctx.fillRect(0, 0, f.w, f.h);
  ctx.globalAlpha = 1;
}

// ---- テーマ定義 ----

const flash: Theme = {
  id: 'flash',
  label: 'Flash',
  desc: 'ビート頭で白フラッシュ+ズームパルス',
  beatsPerCut: () => 2,
  render(ctx, drawVideo, f) {
    const pulse = Math.max(0, 1 - f.beatPhase / 0.35);
    drawVideo({ scale: 1 + 0.07 * f.intensity * pulse * pulse });
    contrastBoost(ctx, f, 0.15);
    const flashA = 0.8 * f.intensity * Math.pow(Math.max(0, 1 - f.beatPhase / 0.2), 2);
    fillComposite(ctx, f, 'source-over', '#ffffff', flashA);
  },
};

const glitch: Theme = {
  id: 'glitch',
  label: 'Glitch',
  desc: 'RGBずらし+スキャンライン、切替時にバースト',
  beatsPerCut: (bpm) => (bpm >= 140 ? 2 : 1),
  render(ctx, drawVideo, f) {
    drawVideo();
    const burst = f.cutAge < 0.13 || f.beatPhase < 0.1;
    if (burst && f.intensity > 0.03) {
      const amp = 14 * f.intensity;
      chromaShift(ctx, f, [
        { color: '#ff0044', dx: (Math.random() - 0.5) * 2 * amp, dy: 0, alpha: 0.55 * f.intensity },
        { color: '#00ffee', dx: (Math.random() - 0.5) * 2 * amp, dy: 0, alpha: 0.55 * f.intensity },
      ]);
      // 水平スライスをランダムにずらす
      const s = getSnap(f.w, f.h);
      const sx = s.getContext('2d')!;
      sx.globalCompositeOperation = 'source-over';
      sx.drawImage(ctx.canvas, 0, 0);
      const n = 2 + ((Math.random() * 4) | 0);
      for (let i = 0; i < n; i++) {
        const y = Math.random() * f.h;
        const sh = Math.max(8, Math.random() * f.h * 0.06);
        const dx = (Math.random() - 0.5) * 2 * amp * 3;
        ctx.drawImage(s, 0, y, f.w, sh, dx, y, f.w, sh);
      }
    }
    drawScanlines(ctx, f, 0.06 + 0.1 * f.intensity);
    fillComposite(ctx, f, 'soft-light', '#3355ff', 0.1 * f.intensity);
  },
};

const vhs: Theme = {
  id: 'vhs',
  label: 'VHS',
  desc: 'ノイズ+色収差+日付風オーバーレイ',
  beatsPerCut: () => 2,
  render(ctx, drawVideo, f) {
    drawVideo();
    fillComposite(ctx, f, 'saturation', 'hsl(0 0% 50%)', 0.35 * f.intensity);
    chromaShift(ctx, f, [
      { color: '#ff2266', dx: 2 + 2 * f.intensity, dy: 0, alpha: 0.22 * f.intensity },
      { color: '#22ffcc', dx: -(2 + 2 * f.intensity), dy: 0, alpha: 0.22 * f.intensity },
    ]);
    drawNoise(ctx, f, 0.05 + 0.13 * f.intensity);
    drawScanlines(ctx, f, 0.1 * f.intensity);
    // ときどきトラッキングノイズの帯
    if (Math.random() < 0.06 * f.intensity) {
      const y = Math.random() * f.h;
      const bh = f.h * 0.02;
      const s = getSnap(f.w, f.h);
      const sx = s.getContext('2d')!;
      sx.globalCompositeOperation = 'source-over';
      sx.drawImage(ctx.canvas, 0, 0);
      ctx.drawImage(s, 0, y, f.w, bh, 24 * f.intensity, y, f.w, bh);
    }
    fillComposite(ctx, f, 'soft-light', '#c98f2e', 0.16 * f.intensity);
    // 日付風オーバーレイ
    ctx.save();
    ctx.font = `500 ${Math.round(f.h * 0.026)}px ui-monospace, monospace`;
    ctx.fillStyle = 'rgba(240,240,220,0.85)';
    ctx.shadowColor = 'rgba(0,0,0,0.7)';
    ctx.shadowBlur = 4;
    const sec = Math.floor(f.t);
    const tc = `0:${String(sec).padStart(2, '0')}`;
    ctx.fillText(`▶ PLAY  ${tc}`, f.w * 0.06, f.h * 0.08);
    ctx.fillText('JUL.12 2026', f.w * 0.06, f.h * 0.94);
    ctx.restore();
  },
};

const mono: Theme = {
  id: 'mono',
  label: 'Mono',
  desc: 'モノクロ+粒子ノイズ+ハイコントラスト',
  beatsPerCut: (bpm) => (bpm >= 110 ? 4 : 2),
  render(ctx, drawVideo, f) {
    // カット内でゆっくり寄るケンバーンズ
    drawVideo({ scale: 1 + 0.05 * f.cutProgress });
    fillComposite(ctx, f, 'saturation', 'hsl(0 0% 50%)', 1);
    contrastBoost(ctx, f, 0.3 + 0.35 * f.intensity);
    drawNoise(ctx, f, 0.06 + 0.1 * f.intensity, 'overlay');
    // ビート頭でわずかに明滅
    const th = 0.1 * f.intensity * Math.max(0, 1 - f.beatPhase / 0.2);
    fillComposite(ctx, f, 'source-over', '#ffffff', th);
  },
};

const clean: Theme = {
  id: 'clean',
  label: 'Clean',
  desc: 'エフェクトなし(グレードのみ)',
  beatsPerCut: () => 2,
  render(ctx, drawVideo, f) {
    drawVideo();
    contrastBoost(ctx, f, 0.12 * f.intensity);
    fillComposite(ctx, f, 'soft-light', '#ff9a3d', 0.05 * f.intensity);
  },
};

export const THEMES: Theme[] = [flash, glitch, vhs, mono, clean];
export const themeById = (id: ThemeId): Theme => THEMES.find((t) => t.id === id)!;
