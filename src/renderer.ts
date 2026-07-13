import { themeById } from './effects';
import type { ClipItem, CutPlan, ThemeId, TrackInfo } from './types';

// プレビューと書き出しで同一の描画ループを使う。
// タイムベースは AudioContext.currentTime(楽曲再生と同一クロック)。
// カット切替はダブルバッファ方式: 現カット再生中に次カットのvideoを先行シークしておく
// (スパイクSP2実測: 境界待ち平均0.9ms、黒フレーム0)

export interface RendererState {
  clips: ClipItem[];
  plan: CutPlan | null;
  track: TrackInfo | null;
  theme: ThemeId;
  intensity: number; // 0..1
  duration: number;  // 15 | 30
}

export interface StartOptions {
  // 書き出し用: 楽曲をこのノードにも接続する
  extraAudioOut?: MediaStreamAudioDestinationNode;
  // 書き出し用: 1フレーム描画するたびに呼ぶ(captureStream(0).requestFrame)
  onFrameDrawn?: () => void;
  muted?: boolean;
}

export class Renderer {
  private ac: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private raf = 0;
  private t0 = 0;
  private cutPtr = -1;
  private playingVideo: HTMLVideoElement | null = null;
  private loopCb: (() => void) | null = null;
  private ticker: ScriptProcessorNode | null = null;
  playing = false;

  onTime: ((t: number) => void) | null = null;
  onEnded: (() => void) | null = null;

  constructor(
    public canvas: HTMLCanvasElement,
    private getState: () => RendererState,
  ) {}

  audioContext(): AudioContext {
    if (!this.ac) this.ac = new AudioContext();
    return this.ac;
  }

  async start(opts: StartOptions = {}): Promise<void> {
    const s = this.getState();
    if (!s.plan || !s.track || s.clips.length < 2) return;
    this.stop(false);

    const ac = this.audioContext();
    await ac.resume();

    // 最初のカットと次のカットを先行シーク
    const cuts = s.plan.cuts;
    await this.seekClip(s.clips[cuts[0].clipIdx].video, cuts[0].srcStart);
    if (cuts.length > 1) {
      const n = cuts[1];
      if (n.clipIdx !== cuts[0].clipIdx) this.preseek(s.clips[n.clipIdx].video, n.srcStart);
    }

    const source = ac.createBufferSource();
    source.buffer = s.track.buffer;
    const gain = ac.createGain();
    gain.gain.value = opts.muted ? 0 : 1;
    source.connect(gain).connect(ac.destination);
    if (opts.extraAudioOut) source.connect(opts.extraAudioOut);
    this.source = source;

    this.t0 = ac.currentTime + 0.08; // 先頭カットの再生開始猶予
    source.start(this.t0, 0, s.duration);
    this.cutPtr = -1;
    this.playing = true;

    const step = () => {
      if (!this.playing) return;
      const t = ac.currentTime - this.t0;
      if (t >= s.duration) {
        this.drawFrame(s, s.duration - 0.001);
        opts.onFrameDrawn?.();
        this.stop();
        this.onEnded?.();
        return;
      }
      if (t >= 0) {
        this.advanceCut(s, t);
        this.drawFrame(s, t);
        opts.onFrameDrawn?.();
        this.onTime?.(t);
      }
    };
    // 可視時: rAF駆動(60fps)。タブ非表示時はrAFが止まるため、
    // Web Audioクロック(ScriptProcessor ~46Hz)で駆動を継続する。
    // これにより書き出し中に一瞬タブを離れても録画が止まりにくい。
    this.loopCb = step;
    const rafLoop = () => {
      if (!this.playing) return;
      step();
      this.raf = requestAnimationFrame(rafLoop);
    };
    this.raf = requestAnimationFrame(rafLoop);
    this.ensureTicker();
  }

  private ensureTicker(): void {
    if (this.ticker) return;
    const ac = this.audioContext();
    const src = ac.createConstantSource();
    const proc = ac.createScriptProcessor(1024, 1, 1);
    const mute = ac.createGain();
    mute.gain.value = 0;
    src.connect(proc);
    proc.connect(mute).connect(ac.destination);
    src.start();
    proc.onaudioprocess = () => {
      if (document.hidden) this.loopCb?.();
    };
    this.ticker = proc;
  }

  stop(fireCallback = true): void {
    void fireCallback;
    this.playing = false;
    this.loopCb = null;
    cancelAnimationFrame(this.raf);
    if (this.source) {
      try { this.source.stop(); } catch { /* already stopped */ }
      this.source.disconnect();
      this.source = null;
    }
    this.playingVideo?.pause();
    this.playingVideo = null;
    this.cutPtr = -1;
  }

  private preseek(v: HTMLVideoElement, t: number): void {
    try { v.currentTime = t; } catch { /* not ready yet */ }
  }

  private seekClip(v: HTMLVideoElement, t: number): Promise<void> {
    return new Promise((res) => {
      const timer = setTimeout(done, 1500);
      function done() {
        clearTimeout(timer);
        v.removeEventListener('seeked', done);
        res();
      }
      v.addEventListener('seeked', done);
      v.currentTime = t;
    });
  }

  private advanceCut(s: RendererState, t: number): void {
    const cuts = s.plan!.cuts;
    let ptr = this.cutPtr;
    while (ptr + 1 < cuts.length && cuts[ptr + 1].start <= t) ptr++;
    if (ptr === this.cutPtr) return;
    this.cutPtr = ptr;
    const cut = cuts[ptr];
    const clip = s.clips[cut.clipIdx];
    if (!clip) return;

    this.playingVideo?.pause();
    const v = clip.video;
    // 先行シーク済みのはず。大きくズレていた場合のみ再シーク(非同期のまま進める)
    if (Math.abs(v.currentTime - cut.srcStart) > 0.25) v.currentTime = cut.srcStart;
    v.play().catch(() => { /* 自動再生ブロック等は次フレームで回復 */ });
    this.playingVideo = v;

    // 次カットのvideoを先行シーク(連続同一クリップは無いので別要素が保証される)
    const next = cuts[ptr + 1];
    if (next && next.clipIdx !== cut.clipIdx) {
      this.preseek(s.clips[next.clipIdx].video, next.srcStart);
    }
  }

  private drawFrame(s: RendererState, t: number): void {
    const ctx = this.canvas.getContext('2d')!;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const cuts = s.plan!.cuts;
    const cut = cuts[Math.max(0, this.cutPtr)];
    const clip = s.clips[cut.clipIdx];
    const v = clip?.video;

    const period = 60 / s.track!.bpm;
    const rel = t - s.track!.beatOffsetSec;
    let phase = (rel % period) / period;
    if (phase < 0) phase += 1;

    const theme = themeById(s.theme);
    const f = {
      w,
      h,
      t,
      beatPhase: phase,
      beatIndex: Math.floor(rel / period),
      beatPeriod: period,
      cutAge: t - cut.start,
      cutProgress: Math.min(1, (t - cut.start) / Math.max(0.001, cut.end - cut.start)),
      cutIndex: this.cutPtr,
      intensity: s.intensity,
    };

    const drawVideo = (o: { scale?: number; dx?: number; dy?: number } = {}) => {
      if (!v || v.readyState < 2 || !v.videoWidth) return; // 前フレームを残す(黒を出さない)
      const scale = o.scale ?? 1;
      // cover crop: 9:16 に合わせて中央を切り出す
      const sAspect = v.videoWidth / v.videoHeight;
      const dAspect = w / h;
      let sw = v.videoWidth;
      let sh = v.videoHeight;
      if (sAspect > dAspect) sw = sh * dAspect;
      else sh = sw / dAspect;
      sw /= scale;
      sh /= scale;
      const sx = (v.videoWidth - sw) / 2;
      const sy = (v.videoHeight - sh) / 2;
      ctx.drawImage(v, sx, sy, sw, sh, o.dx ?? 0, o.dy ?? 0, w, h);
    };

    theme.render(ctx, drawVideo, f);
    this.drawWatermark(ctx, w, h);
  }

  // 透かし(設定でのOFFは不可)
  private drawWatermark(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    ctx.save();
    ctx.font = `700 ${Math.round(h * 0.02)}px system-ui, sans-serif`;
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 3;
    ctx.fillText('BEATCUT', w - h * 0.015, h - h * 0.015);
    ctx.restore();
  }

  // 全クリップのデコーダを起こしておく(書き出し前のプライム)
  async prime(): Promise<void> {
    const s = this.getState();
    if (!s.plan) return;
    const firstUse = new Map<number, number>();
    for (const c of s.plan.cuts) {
      if (!firstUse.has(c.clipIdx)) firstUse.set(c.clipIdx, c.srcStart);
    }
    for (const [idx, t] of firstUse) {
      const clip = s.clips[idx];
      if (clip) await this.seekClip(clip.video, t);
    }
  }

  // 停止中に1フレームだけ描く(テーマ切替の即時反映用)
  async drawStill(): Promise<void> {
    const s = this.getState();
    if (!s.plan || !s.track || s.clips.length < 2) return;
    const cut = s.plan.cuts[0];
    const v = s.clips[cut.clipIdx].video;
    if (Math.abs(v.currentTime - cut.srcStart) > 0.05) await this.seekClip(v, cut.srcStart);
    this.cutPtr = 0;
    this.drawFrame(s, cut.start + 0.05);
    this.cutPtr = -1;
  }
}
