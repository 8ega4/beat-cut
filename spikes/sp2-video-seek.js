// SP2: 5本の <video> を頻繁にシーク(currentTime変更 → seeked待ち → drawImage)して、
// カット切替でフレーム落ち・黒フレームが出ないかを実測する。
//
// ffmpeg が無いためテストクリップはブラウザ内で生成(canvas録画のwebm)。
// MediaRecorder製webmはシークインデックスが無い最悪ケースなので、
// これで成立すれば実ユーザーのmp4ではより有利になる。
//
// Test A: 素朴方式 — カット境界で同期的にシークして待つ(待ち時間=切替遅延)
// Test B: ダブルバッファ — 現カット再生中に次カットのvideoを先行シークしておく

import { createTicker, seekTo, loadVideoBlob, avg, percentile } from './shared.js';

const CLIP_COUNT = 5;
const CLIP_LEN = 4;      // 秒
const CUTS = 24;         // カット数(15秒 @120BPM 2ビート刻み相当)
const CUT_LEN_MS = 400;  // 1カットの再生時間

export async function run(log) {
  const ticker = await createTicker();
  log(`SP2: テストクリップ${CLIP_COUNT}本を並行生成中(各${CLIP_LEN}秒)...`);
  const blobs = await Promise.all(
    Array.from({ length: CLIP_COUNT }, (_, i) => makeClip(i, ticker))
  );
  const videos = [];
  for (const b of blobs) videos.push(await loadVideoBlob(b));
  log(`SP2: クリップ準備完了 (${blobs.map((b) => (b.size / 1024).toFixed(0) + 'KB').join(', ')})`);

  const out = document.createElement('canvas');
  out.width = 270;
  out.height = 480;
  const ctx = out.getContext('2d', { willReadFrequently: true });

  // 疑似乱数(固定シード)で再現性を確保
  let seed = 42;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const plan = [];
  let prev = -1;
  for (let i = 0; i < CUTS; i++) {
    let ci;
    do { ci = Math.floor(rand() * CLIP_COUNT); } while (ci === prev);
    prev = ci;
    plan.push({ clip: ci, t: 0.2 + rand() * (CLIP_LEN - 1.2) });
  }

  const isBlack = () => {
    const data = ctx.getImageData(0, 0, 270, 480).data;
    let sum = 0;
    let n = 0;
    for (let y = 40; y < 480; y += 110) {
      for (let x = 30; x < 270; x += 60) {
        const o = (y * 270 + x) * 4;
        sum += (data[o] + data[o + 1] + data[o + 2]) / 3;
        n++;
      }
    }
    return sum / n < 10;
  };

  // --- Test A: 素朴方式 ---
  log('SP2: Test A (素朴方式) 実行中...');
  const aSeek = [];
  let aBlack = 0;
  let aErrors = 0;
  for (const cut of plan) {
    const v = videos[cut.clip];
    const st = performance.now();
    try {
      await seekTo(v, cut.t);
    } catch {
      aErrors++;
      continue;
    }
    aSeek.push(performance.now() - st);
    ctx.drawImage(v, 0, 0, 270, 480);
    if (isBlack()) aBlack++;
    // 実運用相当の再生負荷(非表示タブでは進まない可能性があるため参考値)
    v.play().catch(() => {});
    await ticker.sleep(CUT_LEN_MS / 2);
    ctx.drawImage(v, 0, 0, 270, 480);
    v.pause();
  }

  // --- Test B: ダブルバッファ(次カットを先行シーク) ---
  log('SP2: Test B (先行シーク方式) 実行中...');
  const bWait = [];
  let bBlack = 0;
  let bErrors = 0;
  // 再生がタブ非表示で進むかの検証も兼ねる
  const v0 = videos[plan[0].clip];
  const t0before = v0.currentTime;
  let pending = seekTo(v0, plan[0].t);
  for (let i = 0; i < plan.length; i++) {
    const cur = plan[i];
    const v = videos[cur.clip];
    const st = performance.now();
    try {
      await pending;
    } catch {
      bErrors++;
      if (i + 1 < plan.length) pending = seekTo(videos[plan[i + 1].clip], plan[i + 1].t);
      continue;
    }
    bWait.push(performance.now() - st);
    ctx.drawImage(v, 0, 0, 270, 480);
    if (isBlack()) bBlack++;
    v.play().catch(() => {});
    // 現カット再生中に次カットを先行シーク
    let nextDone = null;
    if (i + 1 < plan.length) {
      const nx = plan[i + 1];
      const nv = videos[nx.clip];
      if (nv === v) {
        // 同一要素なら再生終了後にシーク(実装では2要素/クリップで回避予定)
        nextDone = null;
      } else {
        nextDone = seekTo(nv, nx.t);
      }
    }
    await ticker.sleep(CUT_LEN_MS);
    ctx.drawImage(v, 0, 0, 270, 480);
    if (isBlack()) bBlack++;
    v.pause();
    if (i + 1 < plan.length) {
      const nx = plan[i + 1];
      pending = nextDone ?? seekTo(videos[nx.clip], nx.t);
    }
  }

  // 再生進行チェック(非表示タブでの video.play() の挙動確認)
  const pv = videos[0];
  await seekTo(pv, 0.5);
  const before = pv.currentTime;
  pv.play().catch(() => {});
  await ticker.sleep(600);
  const advanced = pv.currentTime - before;
  pv.pause();

  for (const v of videos) { URL.revokeObjectURL(v.src); v.remove(); }
  await ticker.close();

  const stats = (xs) => ({
    meanMs: +avg(xs).toFixed(1),
    p95Ms: +percentile(xs, 95).toFixed(1),
    maxMs: +Math.max(...xs).toFixed(1),
  });
  const a = stats(aSeek);
  const b = stats(bWait);
  return {
    cuts: CUTS,
    clipSizesKB: blobs.map((x) => +(x.size / 1024).toFixed(0)),
    naive: { seekLatency: a, blackFrames: aBlack, seekTimeouts: aErrors },
    doubleBuffer: { boundaryWait: b, blackFrames: bBlack, seekTimeouts: bErrors },
    playbackAdvancedSecWhileHidden: +advanced.toFixed(2),
    verdict:
      bErrors === 0 && bBlack === 0 && b.p95Ms < 50
        ? 'PASS (ダブルバッファ方式)'
        : aErrors === 0 && aBlack === 0 && a.p95Ms < 50
          ? 'PASS (素朴方式で十分)'
          : 'FAIL',
  };
}

async function makeClip(i, ticker) {
  const c = document.createElement('canvas');
  c.width = 640;
  c.height = 360;
  const ctx = c.getContext('2d');
  const stream = c.captureStream(0);
  const track = stream.getVideoTracks()[0];
  const hue = i * 70;
  let frame = 0;
  const unTick = ticker.onTick(() => {
    ctx.fillStyle = `hsl(${hue} 80% 45%)`;
    ctx.fillRect(0, 0, 640, 360);
    ctx.fillStyle = '#fff';
    ctx.fillRect((frame * 5) % 600, 180, 40, 60);
    ctx.font = 'bold 72px monospace';
    ctx.fillText(`${i}:${frame}`, 40, 100);
    frame++;
    if (track.requestFrame) track.requestFrame();
    else stream.requestFrame();
  });
  const rec = new MediaRecorder(stream, {
    mimeType: 'video/webm;codecs=vp8',
    videoBitsPerSecond: 1_500_000,
  });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise((r) => (rec.onstop = r));
  rec.start();
  await ticker.sleep(CLIP_LEN * 1000);
  rec.stop();
  await stopped;
  unTick();
  return new Blob(chunks, { type: 'video/webm' });
}
