// SP1: canvas.captureStream + AudioContext.createMediaStreamDestination を
// 1つの MediaStream に合成して MediaRecorder で30秒録画し、音ズレを実測する。
//
// 計測方式(タブ非表示でも動くオフライン解析):
//   録音源: 1kHzビープ(毎秒) / 録画源: 同じAudioContextクロックで白フラッシュ
//   → 録画したwebmを decodeAudioData で解析しビープ時刻をサンプル精度で取得
//   → 同じwebmを <video> でシークしながらピクセル検査しフラッシュ時刻を取得
//   → 両者は同一メディアタイムラインなので、差がそのままA/Vオフセット。
//   フラッシュ時刻の分解能はシーク刻み(20ms)に量子化される点に注意。

import { createTicker, seekTo, loadVideoBlob, avg } from './shared.js';

const DURATION = 30;
const BEEP_INTERVAL = 1.0;
const FLASH_LEN = 0.08;
const SEEK_STEP = 0.02;

export async function run(log) {
  const ticker = await createTicker();
  const ac = ticker.ac;
  const dest = ac.createMediaStreamDestination();

  // --- 音源: 毎秒ビープをスケジュール ---
  const t0 = ac.currentTime + 0.5;
  let beepCount = 0;
  for (let k = 0; k * BEEP_INTERVAL < DURATION - 0.6; k++) {
    const t = t0 + k * BEEP_INTERVAL;
    const osc = ac.createOscillator();
    osc.frequency.value = 1000;
    const g = ac.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.9, t + 0.002);
    g.gain.setValueAtTime(0.9, t + FLASH_LEN - 0.01);
    g.gain.linearRampToValueAtTime(0, t + FLASH_LEN);
    osc.connect(g).connect(dest);
    osc.start(t);
    osc.stop(t + FLASH_LEN + 0.02);
    beepCount++;
  }

  // --- 映像: 同じクロックで白フラッシュ(ティッカー駆動 + requestFrame) ---
  const canvas = document.createElement('canvas');
  canvas.width = 540;
  canvas.height = 960;
  const ctx = canvas.getContext('2d');
  const vstream = canvas.captureStream(0);
  const vtrack = vstream.getVideoTracks()[0];
  const unTick = ticker.onTick(() => {
    const t = ac.currentTime - t0;
    const phase = ((t % BEEP_INTERVAL) + BEEP_INTERVAL) % BEEP_INTERVAL;
    const on = t >= 0 && t < DURATION - 0.6 && phase < FLASH_LEN;
    ctx.fillStyle = on ? '#fff' : '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (vtrack.requestFrame) vtrack.requestFrame();
    else vstream.requestFrame();
  });

  // --- 合成ストリームを録画 ---
  const combined = new MediaStream([
    ...vstream.getVideoTracks(),
    ...dest.stream.getAudioTracks(),
  ]);
  const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
    ? 'video/webm;codecs=vp9,opus'
    : 'video/webm;codecs=vp8,opus';
  const rec = new MediaRecorder(combined, { mimeType: mime, videoBitsPerSecond: 2_500_000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise((r) => (rec.onstop = r));
  rec.start(1000);
  log(`SP1: ${DURATION}秒録画中 (${mime})...`);
  await ticker.sleep((DURATION + 0.7) * 1000);
  rec.stop();
  await stopped;
  unTick();
  const blob = new Blob(chunks, { type: 'video/webm' });
  log(`SP1: 録画完了 ${(blob.size / 1024 / 1024).toFixed(2)}MB — オフライン解析中...`);

  // --- 音声解析: ビープ時刻(メディアタイムライン, サンプル精度) ---
  const buf = await blob.arrayBuffer();
  const decoded = await ac.decodeAudioData(buf.slice(0));
  const d = decoded.getChannelData(0);
  const sr = decoded.sampleRate;
  const beepTimes = [];
  let i = 0;
  while (i < d.length) {
    if (Math.abs(d[i]) > 0.1) {
      beepTimes.push(i / sr);
      i += Math.floor(sr * 0.5); // 500ms 不応期
    } else {
      i++;
    }
  }

  // --- 映像解析: シークしながらフラッシュ開始時刻を探す ---
  const v = await loadVideoBlob(blob);
  const sc = document.createElement('canvas');
  sc.width = 8;
  sc.height = 8;
  const sctx = sc.getContext('2d', { willReadFrequently: true });
  const lumAt = async (t) => {
    await seekTo(v, t);
    sctx.drawImage(v, 0, 0, 8, 8);
    const p = sctx.getImageData(4, 4, 1, 1).data;
    return (p[0] + p[1] + p[2]) / 3;
  };

  const pairs = [];
  let misses = 0;
  for (const bt of beepTimes) {
    let flashAt = null;
    for (let t = Math.max(0, bt - 0.15); t <= bt + 0.3; t += SEEK_STEP) {
      if ((await lumAt(t)) > 128) {
        flashAt = t;
        break;
      }
    }
    if (flashAt === null) misses++;
    else pairs.push({ beep: bt, diffMs: (flashAt - bt) * 1000 });
  }
  v.remove();
  await ticker.close();

  const diffs = pairs.map((p) => p.diffMs);
  const mean = avg(diffs);
  const std = Math.sqrt(avg(diffs.map((x) => (x - mean) ** 2)));
  const head = avg(diffs.slice(0, 5));
  const tail = avg(diffs.slice(-5));
  const drift = tail - head;

  return {
    recordedMB: +(blob.size / 1024 / 1024).toFixed(2),
    audioSampleRate: sr,
    beepsScheduled: beepCount,
    beepsDetectedInRecording: beepTimes.length,
    flashesMatched: pairs.length,
    flashesMissed: misses,
    avOffsetMeanMs: +mean.toFixed(1), // 正 = 映像が音より遅い(量子化 ±20ms)
    avOffsetStdMs: +std.toFixed(1),
    driftHeadToTailMs: +drift.toFixed(1),
    verdict:
      beepTimes.length >= beepCount - 2 &&
      pairs.length >= beepTimes.length - 2 &&
      Math.abs(mean) < 60 &&
      Math.abs(drift) < 40
        ? 'PASS'
        : 'FAIL',
  };
}
