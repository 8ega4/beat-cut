// ビートグリッド計算 + オンセット検出(スパイクSP3で精度検証済みのアルゴリズム)

export interface BeatDetectResult {
  bpm: number;
  offsetSec: number;
}

// BPM+オフセットから出力尺内のビート時刻列を返す
export function beatTimes(bpm: number, offsetSec: number, duration: number): number[] {
  const period = 60 / bpm;
  let t = offsetSec % period;
  if (t < 0) t += period;
  const out: number[] = [];
  for (; t < duration; t += period) out.push(t);
  return out;
}

// エネルギーベースのオンセット検出 → 自己相関でBPM →
// 90〜180BPMへ折り畳み → BPM±1を0.05刻みで微調整しつつ位相推定。
// (SP3実測: BPM誤差≤0.04%、ビート位置中央値誤差≤5ms)
export function detectBeats(buffer: AudioBuffer): BeatDetectResult {
  const data = buffer.getChannelData(0);
  const sr = buffer.sampleRate;
  const HOP = 512;
  const WIN = 1024;

  const nFrames = Math.floor((data.length - WIN) / HOP);
  const energy = new Float32Array(nFrames);
  for (let i = 0; i < nFrames; i++) {
    let s = 0;
    const o = i * HOP;
    for (let j = 0; j < WIN; j++) s += data[o + j] * data[o + j];
    energy[i] = s / WIN;
  }

  const onset = new Float32Array(nFrames);
  for (let i = 1; i < nFrames; i++) {
    const d = Math.log(1e-8 + energy[i]) - Math.log(1e-8 + energy[i - 1]);
    onset[i] = Math.max(0, d);
  }
  let mean = 0;
  for (let i = 0; i < nFrames; i++) mean += onset[i];
  mean /= nFrames;
  for (let i = 0; i < nFrames; i++) onset[i] = Math.max(0, onset[i] - mean);

  const framesPerSec = sr / HOP;

  // 自己相関 (60〜200 BPM) + 2倍周期整合ボーナス
  let bestBpm = 120;
  let bestScore = -1;
  for (let bpm = 60; bpm <= 200; bpm += 0.25) {
    const lag = (60 / bpm) * framesPerSec;
    let score = 0;
    let n = 0;
    for (let i = 0; i + lag < nFrames; i++) {
      score += onset[i] * interp(onset, i + lag);
      n++;
    }
    score /= n;
    let harm = 0;
    if (2 * lag < nFrames) {
      let s2 = 0;
      let n2 = 0;
      for (let i = 0; i + 2 * lag < nFrames; i += 2) {
        s2 += onset[i] * interp(onset, i + 2 * lag);
        n2++;
      }
      harm = (s2 / n2) * 0.5;
    }
    if (score + harm > bestScore) {
      bestScore = score + harm;
      bestBpm = bpm;
    }
  }

  // テンポ折り畳み(オクターブ誤り対策): MV用途は90〜180に正規化
  while (bestBpm < 90) bestBpm *= 2;
  while (bestBpm >= 180) bestBpm /= 2;

  // BPM微調整+位相の同時サーチ
  let bestPhase = 0;
  let bestJoint = -1;
  const STEPS = 64;
  const baseBpm = bestBpm;
  for (let bpm = baseBpm - 1; bpm <= baseBpm + 1; bpm += 0.05) {
    const pf = (60 / bpm) * framesPerSec;
    for (let s = 0; s < STEPS; s++) {
      const phase = (s / STEPS) * pf;
      let score = 0;
      for (let t = phase; t < nFrames; t += pf) {
        for (let k = -2; k <= 2; k++) score += interp(onset, t + k) / (1 + Math.abs(k));
      }
      if (score > bestJoint) {
        bestJoint = score;
        bestPhase = phase;
        bestBpm = bpm;
      }
    }
  }

  const period = 60 / bestBpm;
  let offsetSec = ((bestPhase * HOP + WIN / 2) / sr) % period;
  return { bpm: +bestBpm.toFixed(2), offsetSec: +offsetSec.toFixed(4) };
}

function interp(arr: Float32Array, x: number): number {
  const i = Math.floor(x);
  if (i < 0 || i + 1 >= arr.length) return 0;
  const f = x - i;
  return arr[i] * (1 - f) + arr[i + 1] * f;
}

// タップテンポ: タップ時刻列(曲頭からの秒)からBPMと位相を推定
export function tempoFromTaps(taps: number[]): BeatDetectResult | null {
  if (taps.length < 4) return null;
  const diffs: number[] = [];
  for (let i = 1; i < taps.length; i++) diffs.push(taps[i] - taps[i - 1]);
  diffs.sort((a, b) => a - b);
  const median = diffs[Math.floor(diffs.length / 2)];
  if (median < 0.2 || median > 2) return null; // 30〜300BPM外は無効
  const bpm = 60 / median;
  // 位相: 各タップの (t mod period) の円平均
  const period = median;
  let sx = 0;
  let sy = 0;
  for (const t of taps) {
    const a = ((t % period) / period) * Math.PI * 2;
    sx += Math.cos(a);
    sy += Math.sin(a);
  }
  let phase = Math.atan2(sy, sx) / (Math.PI * 2);
  if (phase < 0) phase += 1;
  return { bpm: +bpm.toFixed(2), offsetSec: +(phase * period).toFixed(4) };
}
