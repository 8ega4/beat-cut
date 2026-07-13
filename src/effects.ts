import type { ThemeId } from './types';

// テーマ = カラーグレード + ビート同期モーションのセット。
// すべて canvas 2D の合成モードで実装(Safariが ctx.filter 非対応のため filter は使わない)

export interface FrameInfo {
  w: number;
  h: number;
  t: number;           // 出力タイムライン秒
  beatPhase: number;   // 現在ビート内の位相 0..1
  beatIndex: number;   // 曲頭からのビート番号(バースト頻度の決定論的判定用)
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
  // 強度スライダーが効くテーマか(false のテーマ選択中はスライダーを非表示にする)
  usesIntensity: boolean;
  beatsPerCut: (bpm: number) => number;
  render(ctx: CanvasRenderingContext2D, drawVideo: DrawVideo, f: FrameInfo): void;
}

// 強度 = エフェクトの視覚パラメータの倍率。各テーマは対象パラメータを
// min/max 定数で宣言し、min + (max - min) × 強度 の線形補間で使う。
// 0% = カラーグレードのみ(ビート同期モーション消滅)、100% = 最大演出。
// カット割りの密度・編集構造には影響させない。
export interface ParamRange {
  min: number;
  max: number;
}

function lerpParam(r: ParamRange, intensity: number): number {
  return r.min + (r.max - r.min) * intensity;
}

// ビート番号 → [0,1) の決定論ハッシュ(プレビューと書き出しで同一結果にする)
function hash01(n: number): number {
  let x = ((n | 0) + 0x6d2b79f5) | 0;
  x = Math.imul(x ^ (x >>> 15), 1 | x);
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
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

// flash: 強度対象 = フラッシュの不透明度、ズームパルスの振幅
const FLASH_PARAMS = {
  flashOpacity: { min: 0, max: 0.8 } as ParamRange,
  zoomAmp: { min: 0, max: 0.07 } as ParamRange,
};
// グレード(強度非連動)
const FLASH_GRADE = { contrast: 0.15 };

const flash: Theme = {
  id: 'flash',
  label: 'Flash',
  desc: 'ビート頭で白フラッシュ+ズームパルス',
  usesIntensity: true,
  beatsPerCut: () => 2,
  render(ctx, drawVideo, f) {
    const pulse = Math.max(0, 1 - f.beatPhase / 0.35);
    drawVideo({ scale: 1 + lerpParam(FLASH_PARAMS.zoomAmp, f.intensity) * pulse * pulse });
    contrastBoost(ctx, f, FLASH_GRADE.contrast);
    const flashA =
      lerpParam(FLASH_PARAMS.flashOpacity, f.intensity) *
      Math.pow(Math.max(0, 1 - f.beatPhase / 0.2), 2);
    fillComposite(ctx, f, 'source-over', '#ffffff', flashA);
  },
};

// glitch: 強度対象 = RGBずらしの距離、グリッチバーストの発生頻度
const GLITCH_PARAMS = {
  shiftDist: { min: 4, max: 16 } as ParamRange,   // px
  burstFreq: { min: 0.35, max: 1 } as ParamRange, // バーストが乗るビートの割合
};
// グレード・意匠(強度非連動)
const GLITCH_GRADE = {
  scanlineAlpha: 0.12,
  tintAlpha: 0.1,
  burstAlpha: 0.55,
  cutBurstSec: 0.13,   // カット切替直後のバースト持続
  beatBurstPhase: 0.1, // ビート頭バーストの位相窓
};

const glitch: Theme = {
  id: 'glitch',
  label: 'Glitch',
  desc: 'RGBずらし+スキャンライン、切替時にバースト',
  usesIntensity: true,
  beatsPerCut: (bpm) => (bpm >= 140 ? 2 : 1),
  render(ctx, drawVideo, f) {
    drawVideo();
    if (f.intensity > 0) {
      // ビート頭バーストは「頻度」: 強度に応じた割合のビートにだけ乗せる(決定論的)
      const beatOn =
        f.beatPhase < GLITCH_GRADE.beatBurstPhase &&
        hash01(f.beatIndex) < lerpParam(GLITCH_PARAMS.burstFreq, f.intensity);
      const burst = f.cutAge < GLITCH_GRADE.cutBurstSec || beatOn;
      if (burst) {
        const amp = lerpParam(GLITCH_PARAMS.shiftDist, f.intensity);
        chromaShift(ctx, f, [
          { color: '#ff0044', dx: (Math.random() - 0.5) * 2 * amp, dy: 0, alpha: GLITCH_GRADE.burstAlpha },
          { color: '#00ffee', dx: (Math.random() - 0.5) * 2 * amp, dy: 0, alpha: GLITCH_GRADE.burstAlpha },
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
    }
    drawScanlines(ctx, f, GLITCH_GRADE.scanlineAlpha);
    fillComposite(ctx, f, 'soft-light', '#3355ff', GLITCH_GRADE.tintAlpha);
  },
};

// vhs: 強度対象 = ノイズ量(粒子・スキャンライン・トラッキング帯)、色収差の強さ
const VHS_PARAMS = {
  noiseAlpha: { min: 0, max: 0.2 } as ParamRange,
  scanlineAlpha: { min: 0, max: 0.12 } as ParamRange,
  trackingFreq: { min: 0, max: 0.06 } as ParamRange, // 帯の発生確率/フレーム
  chromaDist: { min: 0, max: 4.5 } as ParamRange,    // px
  chromaAlpha: { min: 0, max: 0.25 } as ParamRange,
};
// グレード・意匠(強度非連動): 彩度低下・暖色・日付オーバーレイ
const VHS_GRADE = { desaturate: 0.3, warmAlpha: 0.16 };

const vhs: Theme = {
  id: 'vhs',
  label: 'VHS',
  desc: 'ノイズ+色収差+日付風オーバーレイ',
  usesIntensity: true,
  beatsPerCut: () => 2,
  render(ctx, drawVideo, f) {
    drawVideo();
    fillComposite(ctx, f, 'saturation', 'hsl(0 0% 50%)', VHS_GRADE.desaturate);
    const cDist = lerpParam(VHS_PARAMS.chromaDist, f.intensity);
    const cAlpha = lerpParam(VHS_PARAMS.chromaAlpha, f.intensity);
    chromaShift(ctx, f, [
      { color: '#ff2266', dx: cDist, dy: 0, alpha: cAlpha },
      { color: '#22ffcc', dx: -cDist, dy: 0, alpha: cAlpha },
    ]);
    drawNoise(ctx, f, lerpParam(VHS_PARAMS.noiseAlpha, f.intensity));
    drawScanlines(ctx, f, lerpParam(VHS_PARAMS.scanlineAlpha, f.intensity));
    // ときどきトラッキングノイズの帯
    if (Math.random() < lerpParam(VHS_PARAMS.trackingFreq, f.intensity)) {
      const y = Math.random() * f.h;
      const bh = f.h * 0.02;
      const s = getSnap(f.w, f.h);
      const sx = s.getContext('2d')!;
      sx.globalCompositeOperation = 'source-over';
      sx.drawImage(ctx.canvas, 0, 0);
      ctx.drawImage(s, 0, y, f.w, bh, 24 * f.intensity, y, f.w, bh);
    }
    fillComposite(ctx, f, 'soft-light', '#c98f2e', VHS_GRADE.warmAlpha);
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

// mono: 強度対象 = 粒子ノイズ量、コントラストの強さ(+ビート明滅は0%で消える演出)
const MONO_PARAMS = {
  grainAlpha: { min: 0, max: 0.16 } as ParamRange,
  contrast: { min: 0.3, max: 0.65 } as ParamRange, // minはグレードとして残す
  beatFlash: { min: 0, max: 0.1 } as ParamRange,
};
// グレード・意匠(強度非連動): 完全モノクロ化、カット内ケンバーンズ
const MONO_GRADE = { kenBurnsZoom: 0.05 };

const mono: Theme = {
  id: 'mono',
  label: 'Mono',
  desc: 'モノクロ+粒子ノイズ+ハイコントラスト',
  usesIntensity: true,
  beatsPerCut: (bpm) => (bpm >= 110 ? 4 : 2),
  render(ctx, drawVideo, f) {
    // カット内でゆっくり寄るケンバーンズ
    drawVideo({ scale: 1 + MONO_GRADE.kenBurnsZoom * f.cutProgress });
    fillComposite(ctx, f, 'saturation', 'hsl(0 0% 50%)', 1);
    contrastBoost(ctx, f, lerpParam(MONO_PARAMS.contrast, f.intensity));
    drawNoise(ctx, f, lerpParam(MONO_PARAMS.grainAlpha, f.intensity), 'overlay');
    // ビート頭でわずかに明滅
    const th = lerpParam(MONO_PARAMS.beatFlash, f.intensity) * Math.max(0, 1 - f.beatPhase / 0.2);
    fillComposite(ctx, f, 'source-over', '#ffffff', th);
  },
};

// clean: 強度対象なし(固定のグレードのみ。スライダー自体を非表示にする)
const CLEAN_GRADE = { contrast: 0.12, warmAlpha: 0.05 };

const clean: Theme = {
  id: 'clean',
  label: 'Clean',
  desc: 'エフェクトなし(グレードのみ)',
  usesIntensity: false,
  beatsPerCut: () => 2,
  render(ctx, drawVideo, f) {
    drawVideo();
    contrastBoost(ctx, f, CLEAN_GRADE.contrast);
    fillComposite(ctx, f, 'soft-light', '#ff9a3d', CLEAN_GRADE.warmAlpha);
  },
};

export const THEMES: Theme[] = [flash, glitch, vhs, mono, clean];
export const themeById = (id: ThemeId): Theme => THEMES.find((t) => t.id === id)!;
