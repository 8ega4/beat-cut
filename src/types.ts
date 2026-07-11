export interface ClipItem {
  id: string;
  file: File;
  url: string;
  duration: number;
  width: number;
  height: number;
  thumb: string; // dataURL
  video: HTMLVideoElement; // 常駐要素(ダブルバッファの先行シーク先)
}

export interface PresetTrack {
  id: string;
  title: string;
  mood: string;
  bpm: number;
  beatOffsetSec: number;
  file: string;
}

export interface TrackInfo {
  kind: 'preset' | 'upload';
  title: string;
  buffer: AudioBuffer;
  bpm: number;
  beatOffsetSec: number;
  detected: boolean; // ビート解析による推定値か
}

export type ThemeId = 'flash' | 'glitch' | 'vhs' | 'mono' | 'clean';

export interface Cut {
  start: number;    // 出力タイムライン上の開始秒
  end: number;
  clipIdx: number;  // clips配列のインデックス
  srcStart: number; // クリップ内の切り出し開始秒
}

export interface CutPlan {
  cuts: Cut[];
  seed: number;
}
