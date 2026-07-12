import './style.css';
import { detectBeats, tempoFromTaps } from './beat';
import { MAX_CLIPS, MIN_CLIPS, disposeClip, isAcceptedVideo, loadClip } from './clips';
import { makeCutPlan } from './cutplan';
import { THEMES, themeById } from './effects';
import { canExport, exportVideo } from './exporter';
import { Renderer } from './renderer';
import { drawWaveform } from './waveform';
import type { ClipItem, PresetTrack, ThemeId, TrackInfo } from './types';

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T =>
  document.querySelector(sel) as T;

// ---- 状態 ----
const state = {
  clips: [] as ClipItem[],
  track: null as TrackInfo | null,
  theme: 'flash' as ThemeId,
  intensity: 0.7,
  duration: 15,
  seed: 1,
  plan: null as ReturnType<typeof makeCutPlan> | null,
};
let baseOffset = 0; // ズレ補正スライダーの基準
let planDirty = false;

const renderer = new Renderer($('#preview-canvas') as unknown as HTMLCanvasElement, () => state);

// ---- ① 動画入力 ----
const dropzone = $('#dropzone');
const clipInput = $('#clip-input') as HTMLInputElement;
const clipList = $('#clip-list');
const clipError = $('#clip-error');

dropzone.addEventListener('click', () => clipInput.click());
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') clipInput.click();
});
dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('drag');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('drag');
  if (e.dataTransfer?.files) void addFiles(e.dataTransfer.files);
});
clipInput.addEventListener('change', () => {
  if (clipInput.files) void addFiles(clipInput.files);
  clipInput.value = '';
});

async function addFiles(files: FileList): Promise<void> {
  showClipError('');
  const list = [...files];
  const rejected = list.filter((f) => !isAcceptedVideo(f));
  const accepted = list.filter((f) => isAcceptedVideo(f));
  const room = MAX_CLIPS - state.clips.length;
  if (accepted.length > room) {
    showClipError(`最大${MAX_CLIPS}本までです。先頭の${room}本だけ追加します。`);
  }
  // デコード負荷を抑えるため1本ずつ順番に読み込む(スマホの同時5本ロード対策)
  for (const f of accepted.slice(0, room)) {
    try {
      dropzone.classList.add('loading');
      const clip = await loadClip(f);
      state.clips.push(clip);
      renderClipList();
      onProjectChanged();
    } catch (err) {
      showClipError(`「${f.name}」: ${err instanceof Error ? err.message : err}`);
    } finally {
      dropzone.classList.remove('loading');
    }
  }
  if (rejected.length) {
    showClipError(
      `${rejected.map((f) => `「${f.name}」`).join('')} は非対応です。mp4 / mov / webm を使ってください。`,
    );
  }
}

function showClipError(msg: string): void {
  clipError.textContent = msg;
  clipError.hidden = !msg;
}

function renderClipList(): void {
  clipList.innerHTML = '';
  state.clips.forEach((clip, i) => {
    const li = document.createElement('li');
    li.className = 'clip-item';
    li.draggable = true;
    li.innerHTML = `
      <img src="${clip.thumb}" alt="" class="clip-thumb" />
      <div class="clip-meta">
        <span class="clip-name">${escapeHtml(clip.file.name)}</span>
        <span class="clip-dur">${clip.duration.toFixed(1)}s</span>
      </div>
      <div class="clip-actions">
        <button class="icon-btn" data-act="left" title="前へ" ${i === 0 ? 'disabled' : ''}>◀</button>
        <button class="icon-btn" data-act="right" title="後へ" ${i === state.clips.length - 1 ? 'disabled' : ''}>▶</button>
        <button class="icon-btn danger" data-act="del" title="削除">✕</button>
      </div>`;
    li.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'del') {
        disposeClip(clip);
        state.clips.splice(i, 1);
      } else if (act === 'left' && i > 0) {
        [state.clips[i - 1], state.clips[i]] = [state.clips[i], state.clips[i - 1]];
      } else if (act === 'right' && i < state.clips.length - 1) {
        [state.clips[i + 1], state.clips[i]] = [state.clips[i], state.clips[i + 1]];
      }
      renderClipList();
      onProjectChanged();
    });
    // デスクトップ: ドラッグ並び替え
    li.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('text/plain', String(i));
      li.classList.add('dragging');
    });
    li.addEventListener('dragend', () => li.classList.remove('dragging'));
    li.addEventListener('dragover', (e) => e.preventDefault());
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      const from = Number(e.dataTransfer?.getData('text/plain'));
      if (Number.isNaN(from) || from === i) return;
      const [moved] = state.clips.splice(from, 1);
      state.clips.splice(i, 0, moved);
      renderClipList();
      onProjectChanged();
    });
    clipList.appendChild(li);
  });
  $('#clip-remain').textContent = String(MAX_CLIPS - state.clips.length);
  dropzone.style.display = state.clips.length >= MAX_CLIPS ? 'none' : '';
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// ---- ② 楽曲選択 ----
const presetList = $('#preset-list');
const audioInput = $('#audio-input') as HTMLInputElement;
const audioStatus = $('#audio-status');

async function initPresets(): Promise<void> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}music/manifest.json`);
    const presets: PresetTrack[] = await res.json();
    presetList.innerHTML = '';
    for (const p of presets) {
      const btn = document.createElement('button');
      btn.className = 'track-card';
      btn.innerHTML = `<b>${escapeHtml(p.title)}</b><span>${escapeHtml(p.mood)}</span><span class="tc-bpm">${p.bpm} BPM</span>`;
      btn.addEventListener('click', () => void selectPreset(p, btn));
      presetList.appendChild(btn);
    }
  } catch {
    presetList.innerHTML = '<p class="error">プリセット楽曲を読み込めませんでした。ページを再読み込みしてください。</p>';
  }
}

async function selectPreset(p: PresetTrack, btn: HTMLElement): Promise<void> {
  markSelectedTrack(btn);
  audioStatus.textContent = '読み込み中…';
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}music/${p.file}`);
    const buf = await res.arrayBuffer();
    const audio = await renderer.audioContext().decodeAudioData(buf);
    // BPM既知: ビート解析はスキップし、bpm+offsetからグリッドを直接計算する
    setTrack({
      kind: 'preset',
      title: p.title,
      buffer: audio,
      bpm: p.bpm,
      beatOffsetSec: p.beatOffsetSec,
      detected: false,
    });
    audioStatus.textContent = '';
  } catch {
    audioStatus.textContent = '楽曲の読み込みに失敗しました。通信環境を確認して再度選択してください。';
  }
}

audioInput.addEventListener('change', () => {
  const f = audioInput.files?.[0];
  audioInput.value = '';
  if (f) void handleAudioFile(f);
});

async function handleAudioFile(f: File): Promise<void> {
  markSelectedTrack(null);
  audioStatus.textContent = 'デコード中…';
  try {
    const buf = await f.arrayBuffer();
    const audio = await renderer.audioContext().decodeAudioData(buf);
    if (audio.duration < 16) {
      audioStatus.textContent = '16秒以上の曲を使ってください(出力尺+余裕が必要です)。';
      return;
    }
    audioStatus.textContent = 'ビート解析中…';
    await new Promise((r) => setTimeout(r, 30)); // UI反映
    const det = detectBeats(audio);
    setTrack({
      kind: 'upload',
      title: f.name,
      buffer: audio,
      bpm: det.bpm,
      beatOffsetSec: det.offsetSec,
      detected: true,
    });
    audioStatus.textContent = `解析完了: ${det.bpm} BPM(合わないときは下の「ビートが合わない?」から調整)`;
  } catch {
    audioStatus.textContent = 'この音声ファイルをデコードできませんでした。mp3 / wav を使ってください。';
  }
}

function markSelectedTrack(btn: HTMLElement | null): void {
  presetList.querySelectorAll('.track-card').forEach((el) => el.classList.remove('active'));
  btn?.classList.add('active');
}

function setTrack(t: TrackInfo): void {
  state.track = t;
  baseOffset = t.beatOffsetSec;
  ($('#offset-input') as HTMLInputElement).value = '0';
  $('#offset-label').textContent = '0ms';
  ($('#bpm-input') as HTMLInputElement).value = String(t.bpm);
  updateBeatPanel();
  onProjectChanged();
}

function updateBeatPanel(): void {
  const panel = $('#beat-panel');
  if (!state.track) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  $('#track-title').textContent = state.track.title;
  $('#bpm-value').textContent = String(state.track.bpm);
  drawWaveform(
    $('#waveform') as unknown as HTMLCanvasElement,
    state.track.buffer,
    state.track.bpm,
    state.track.beatOffsetSec,
    state.duration,
  );
}

// BPM手動入力
($('#bpm-input') as HTMLInputElement).addEventListener('change', (e) => {
  if (!state.track) return;
  const v = Number((e.target as HTMLInputElement).value);
  if (v >= 40 && v <= 220) {
    state.track.bpm = v;
    updateBeatPanel();
    onProjectChanged();
  }
});

// ズレ補正スライダー
($('#offset-input') as HTMLInputElement).addEventListener('input', (e) => {
  if (!state.track) return;
  const v = Number((e.target as HTMLInputElement).value);
  state.track.beatOffsetSec = baseOffset + v;
  $('#offset-label').textContent = `${Math.round(v * 1000)}ms`;
  updateBeatPanel();
  onProjectChanged();
});

// タップテンポ: 1回目のクリックで曲を再生開始、以降のクリックがタップ
const tapBtn = $('#tap-btn') as HTMLButtonElement;
let tapSource: AudioBufferSourceNode | null = null;
let tapStart = 0;
let taps: number[] = [];
let tapIdleTimer = 0;

tapBtn.addEventListener('click', () => {
  if (!state.track) return;
  const ac = renderer.audioContext();
  if (!tapSource) {
    void ac.resume();
    renderer.stop();
    tapSource = ac.createBufferSource();
    tapSource.buffer = state.track.buffer;
    tapSource.connect(ac.destination);
    tapSource.start();
    tapStart = ac.currentTime;
    taps = [];
    tapBtn.textContent = '♪ 曲に合わせてタップ…';
    tapSource.onended = finishTaps;
    return;
  }
  taps.push(ac.currentTime - tapStart);
  tapBtn.textContent = `タップ! (${taps.length})`;
  clearTimeout(tapIdleTimer);
  tapIdleTimer = window.setTimeout(finishTaps, 2500);
});

function finishTaps(): void {
  clearTimeout(tapIdleTimer);
  if (tapSource) {
    tapSource.onended = null;
    try { tapSource.stop(); } catch { /* noop */ }
    tapSource = null;
  }
  const result = tempoFromTaps(taps);
  if (result && state.track) {
    state.track.bpm = result.bpm;
    state.track.beatOffsetSec = result.offsetSec;
    baseOffset = result.offsetSec;
    ($('#bpm-input') as HTMLInputElement).value = String(result.bpm);
    ($('#offset-input') as HTMLInputElement).value = '0';
    $('#offset-label').textContent = '0ms';
    updateBeatPanel();
    onProjectChanged();
    tapBtn.textContent = `タップ完了: ${result.bpm} BPM`;
  } else {
    tapBtn.textContent = 'タップ (曲に合わせて4回以上)';
    if (taps.length > 0) audioStatus.textContent = 'タップが4回未満か間隔が不安定でした。もう一度どうぞ。';
  }
  taps = [];
}

// 出力尺
document.querySelectorAll<HTMLButtonElement>('.seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.duration = Number(btn.dataset.dur);
    updateBeatPanel();
    onProjectChanged();
  });
});

// テーマ
function initThemes(): void {
  const row = $('#theme-row');
  THEMES.forEach((t, i) => {
    const btn = document.createElement('button');
    btn.className = `theme-chip${i === 0 ? ' active' : ''}`;
    btn.innerHTML = `<b>${t.label}</b><span>${t.desc}</span>`;
    btn.addEventListener('click', () => {
      row.querySelectorAll('.theme-chip').forEach((el) => el.classList.remove('active'));
      btn.classList.add('active');
      state.theme = t.id;
      // 再生中: 次フレームから描画に即反映。カット密度の変更は次の再生開始時に適用
      if (renderer.playing) {
        planDirty = true;
      } else {
        replan();
        void renderer.drawStill();
      }
    });
    row.appendChild(btn);
  });
}

($('#intensity') as HTMLInputElement).addEventListener('input', (e) => {
  const v = Number((e.target as HTMLInputElement).value);
  state.intensity = v / 100;
  $('#intensity-label').textContent = `${v}%`;
  if (!renderer.playing) void renderer.drawStill();
});

// ---- プレビュー ----
const playBtn = $('#play-btn') as HTMLButtonElement;
const overlay = $('#preview-overlay');
const previewNote = $('#preview-note');
const timebarFill = $('#timebar-fill');

renderer.onTime = (t) => {
  timebarFill.style.width = `${(t / state.duration) * 100}%`;
};
renderer.onEnded = () => {
  overlay.classList.remove('hidden');
  timebarFill.style.width = '0%';
};

playBtn.addEventListener('click', () => void togglePlay());
$('#restart-btn').addEventListener('click', () => {
  renderer.stop();
  void togglePlay();
});
$('#shuffle-btn').addEventListener('click', () => {
  // 割り当てだけ引き直す。ビート解析は再実行しない
  state.seed++;
  const wasPlaying = renderer.playing;
  renderer.stop();
  replan();
  if (wasPlaying) void togglePlay();
  else void renderer.drawStill();
});

async function togglePlay(): Promise<void> {
  if (renderer.playing) {
    renderer.stop();
    overlay.classList.remove('hidden');
    return;
  }
  if (!ready()) return;
  if (planDirty || !state.plan) {
    replan();
    planDirty = false;
  }
  overlay.classList.add('hidden');
  await renderer.start();
}

function ready(): boolean {
  return state.clips.length >= MIN_CLIPS && !!state.track;
}

function replan(): void {
  if (!ready()) {
    state.plan = null;
    return;
  }
  const t = state.track!;
  state.plan = makeCutPlan({
    clipDurations: state.clips.map((c) => c.duration),
    bpm: t.bpm,
    beatOffsetSec: t.beatOffsetSec,
    duration: state.duration,
    seed: state.seed,
    beatsPerCut: themeById(state.theme).beatsPerCut(t.bpm),
  });
}

// クリップ/曲/尺の変更時に呼ぶ
function onProjectChanged(): void {
  renderer.stop();
  overlay.classList.remove('hidden');
  replan();
  updatePreviewState();
  if (state.plan) void renderer.drawStill();
}

function updatePreviewState(): void {
  const ok = ready();
  previewNote.hidden = ok;
  if (!ok) {
    const needs: string[] = [];
    if (state.clips.length < MIN_CLIPS) needs.push(`動画をあと${MIN_CLIPS - state.clips.length}本`);
    if (!state.track) needs.push('曲を選択');
    previewNote.textContent = `プレビューには: ${needs.join(' / ')}`;
  }
  ($('#export-btn') as HTMLButtonElement).disabled = !ok || !canExport();
}

// ---- ③ 書き出し ----
const exportBtn = $('#export-btn') as HTMLButtonElement;
const progress = $('#progress');
const progressBar = $('#progress-bar');
const progressLabel = $('#progress-label');
const exportDone = $('#export-done');

if (!canExport()) {
  $('#no-export-warn').hidden = false;
  $('#tab-warn').hidden = true;
}

exportBtn.addEventListener('click', async () => {
  if (!ready()) return;
  renderer.stop();
  if (planDirty || !state.plan) {
    replan();
    planDirty = false;
  }
  exportBtn.disabled = true;
  exportDone.hidden = true;
  progress.hidden = false;
  progressBar.style.width = '0%';
  try {
    const blob = await exportVideo(renderer, {
      duration: state.duration,
      onProgress: (r) => {
        progressBar.style.width = `${Math.round(r * 100)}%`;
        progressLabel.textContent = `${Math.round(r * 100)}%`;
      },
    });
    const url = URL.createObjectURL(blob);
    const link = $('#download-link') as HTMLAnchorElement;
    link.href = url;
    link.download = `beatcut-${state.duration}s.webm`;
    exportDone.hidden = false;
    progressLabel.textContent = `完了 (${(blob.size / 1024 / 1024).toFixed(1)}MB)`;
    void renderer.drawStill(); // プレビューを復元
  } catch (err) {
    progressLabel.textContent = `書き出しに失敗しました: ${err instanceof Error ? err.message : err}`;
  } finally {
    exportBtn.disabled = false;
  }
});

// Xシェア
const shareText = encodeURIComponent('ビートに合わせて自動カット編集したMVを作った🎬 #BeatCut');
const shareUrl = encodeURIComponent(location.origin + location.pathname);
($('#share-x') as HTMLAnchorElement).href =
  `https://twitter.com/intent/tweet?text=${shareText}&url=${shareUrl}`;

// ---- 起動 ----
initThemes();
void initPresets();
updatePreviewState();

// 開発時のみ: E2Eテスト用フック(本番ビルドには含まれない)
if (import.meta.env.DEV) {
  Object.assign(window, {
    __beatcut: {
      state,
      renderer,
      addFiles: (files: File[]) => addFiles(files as unknown as FileList),
      setAudio: (f: File) => handleAudioFile(f),
      replan,
      togglePlay,
    },
  });
}
