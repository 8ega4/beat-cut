import { beatTimes } from './beat';
import { mulberry32 } from './rng';
import type { Cut, CutPlan } from './types';

const MIN_CUT = 0.35; // これ未満のカットは作らない(秒)

export interface CutPlanOptions {
  clipDurations: number[];
  bpm: number;
  beatOffsetSec: number;
  duration: number; // 15 | 30
  seed: number;
  beatsPerCut: number; // テーマ由来の密度(通常2、高密度テーマは1、遅めは4)
}

// ビートグリッドに沿ってカット境界を決め、クリップを割り当てる。
// - 同じクリップは連続させない(2本なら交互になる)
// - クリップ内の切り出し位置は「使用回ごとに均等分散+ランダムオフセット」
export function makeCutPlan(o: CutPlanOptions): CutPlan {
  const rand = mulberry32(o.seed);
  const period = 60 / o.bpm;
  let step = period * o.beatsPerCut;
  while (step < MIN_CUT) step *= 2;

  // 境界: 0 → (ビートに乗ったstep刻み) → duration
  const beats = beatTimes(o.bpm, o.beatOffsetSec, o.duration);
  const boundaries: number[] = [0];
  const beatsPerCutEff = Math.round(step / period);
  for (let i = 0; i < beats.length; i += beatsPerCutEff) {
    const b = beats[i];
    if (b - boundaries[boundaries.length - 1] >= MIN_CUT) boundaries.push(b);
  }
  if (o.duration - boundaries[boundaries.length - 1] < MIN_CUT) boundaries.pop();
  boundaries.push(o.duration);

  const nCuts = boundaries.length - 1;
  const nClips = o.clipDurations.length;

  // 割り当て: シャッフルしたバッグから引く。直前と同じなら引き直す
  const order: number[] = [];
  let bag: number[] = [];
  let prev = -1;
  for (let i = 0; i < nCuts; i++) {
    if (bag.length === 0) {
      bag = Array.from({ length: nClips }, (_, k) => k);
      for (let j = bag.length - 1; j > 0; j--) {
        const k = Math.floor(rand() * (j + 1));
        [bag[j], bag[k]] = [bag[k], bag[j]];
      }
    }
    let pick = bag.findIndex((c) => c !== prev);
    if (pick < 0) {
      // バッグに直前と同じクリップしか残っていない → 捨てて引き直し
      bag = Array.from({ length: nClips }, (_, k) => k).filter((c) => c !== prev);
      pick = Math.floor(rand() * bag.length);
    }
    prev = bag.splice(pick, 1)[0];
    order.push(prev);
  }

  // クリップごとの使用回数を数え、均等分散の基準位置を決める
  const usageCount = new Array(nClips).fill(0);
  for (const c of order) usageCount[c]++;
  const usageIdx = new Array(nClips).fill(0);

  const cuts: Cut[] = [];
  for (let i = 0; i < nCuts; i++) {
    const clipIdx = order[i];
    const cutLen = boundaries[i + 1] - boundaries[i];
    const dur = o.clipDurations[clipIdx];
    const usable = Math.max(0, dur - cutLen - 0.1);
    const m = usageCount[clipIdx];
    const j = usageIdx[clipIdx]++;
    // 均等分散 + ランダムオフセット(区画の半分まで)
    const slot = usable / m;
    const srcStart = Math.min(usable, slot * j + rand() * slot * 0.8);
    cuts.push({ start: boundaries[i], end: boundaries[i + 1], clipIdx, srcStart });
  }
  return { cuts, seed: o.seed };
}
