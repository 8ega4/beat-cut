import { beatTimes } from './beat';

// 波形 + ビートマーカー + 出力尺ウィンドウの描画(シグネチャー要素)
export function drawWaveform(
  canvas: HTMLCanvasElement,
  buffer: AudioBuffer,
  bpm: number,
  offsetSec: number,
  outDuration: number,
): void {
  const ctx = canvas.getContext('2d')!;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const data = buffer.getChannelData(0);
  const shownSec = Math.min(buffer.duration, Math.max(outDuration * 1.5, 20));
  const samplesShown = Math.floor(shownSec * buffer.sampleRate);
  const perCol = Math.floor(samplesShown / w);

  // 出力尺ウィンドウ
  const winW = (outDuration / shownSec) * w;
  ctx.fillStyle = 'rgba(200,255,62,0.08)';
  ctx.fillRect(0, 0, winW, h);

  // 波形エンベロープ
  ctx.fillStyle = 'rgba(232,234,240,0.75)';
  for (let x = 0; x < w; x++) {
    let min = 1;
    let max = -1;
    const o = x * perCol;
    for (let i = 0; i < perCol; i += 8) {
      const v = data[o + i] ?? 0;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const y1 = ((1 - max) / 2) * h;
    const y2 = ((1 - min) / 2) * h;
    ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }

  // ビートマーカー
  ctx.fillStyle = 'rgba(200,255,62,0.9)';
  for (const b of beatTimes(bpm, offsetSec, shownSec)) {
    const x = (b / shownSec) * w;
    ctx.fillRect(x, 0, 1.5, h);
  }

  // ウィンドウ右端
  ctx.fillStyle = 'rgba(200,255,62,0.6)';
  ctx.fillRect(winW - 1, 0, 2, h);
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillStyle = 'rgba(139,144,160,0.9)';
  ctx.fillText(`${outDuration}s`, winW + 4, 10);
}
