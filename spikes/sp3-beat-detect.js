// SP3: エネルギーベースのオンセット検出 + 自己相関によるBPM/位相推定の精度検証。
//
// OfflineAudioContext で既知BPMのテスト音源(キック+ハイハット+ノイズ)を合成し、
// 検出結果と真値を突合する。判定基準:
//   - BPM誤差 ±2% 以内(半分/2倍テンポの検出は "octave" として別カウント)
//   - ビート位置の中央値誤差 30ms 以内

const SR = 44100;
const LEN = 20; // 秒

export async function run(log) {
  const cases = [
    { name: 'kick only 128bpm', bpm: 128, offset: 0.25, hat: false, noise: 0 },
    { name: 'kick+hat 95bpm', bpm: 95, offset: 0.1, hat: true, noise: 0.02 },
    { name: 'kick+hat+noise 140bpm', bpm: 140, offset: 0.0, hat: true, noise: 0.05 },
  ];
  const results = [];
  for (const c of cases) {
    log(`SP3: ${c.name} を合成・解析中...`);
    const buf = await synth(c);
    const det = detectBeats(buf);
    const ratio = det.bpm / c.bpm;
    const octave = Math.abs(ratio - 0.5) < 0.02 || Math.abs(ratio - 2) < 0.04;
    const bpmErrPct = +((Math.abs(det.bpm - c.bpm) / c.bpm) * 100).toFixed(2);

    // ビート位置誤差: 各真値ビートに最も近い推定ビートとの差の中央値
    const period = 60 / c.bpm;
    const trueBeats = [];
    for (let t = c.offset; t < LEN - 0.5; t += period) trueBeats.push(t);
    const errs = trueBeats.map((t) => {
      let best = Infinity;
      for (const e of det.beats) best = Math.min(best, Math.abs(e - t));
      return best * 1000;
    });
    errs.sort((a, b) => a - b);
    const medianErrMs = +errs[Math.floor(errs.length / 2)].toFixed(1);

    results.push({
      case: c.name,
      trueBpm: c.bpm,
      detectedBpm: +det.bpm.toFixed(2),
      bpmErrPct,
      octaveError: octave,
      medianBeatErrMs: medianErrMs,
      pass: (bpmErrPct <= 2 || octave) && medianErrMs <= 30,
    });
  }
  const passed = results.filter((r) => r.pass).length;
  return {
    cases: results,
    verdict: passed === results.length ? 'PASS' : passed >= 2 ? 'PARTIAL' : 'FAIL',
  };
}

async function synth({ bpm, offset, hat, noise }) {
  const oc = new OfflineAudioContext(1, SR * LEN, SR);
  const period = 60 / bpm;
  for (let t = offset; t < LEN - 0.3; t += period) {
    // キック: 150→50Hz スイープ + 減衰
    const osc = oc.createOscillator();
    osc.frequency.setValueAtTime(150, t);
    osc.frequency.exponentialRampToValueAtTime(50, t + 0.12);
    const g = oc.createGain();
    g.gain.setValueAtTime(1.0, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    osc.connect(g).connect(oc.destination);
    osc.start(t);
    osc.stop(t + 0.3);
  }
  if (hat) {
    // 裏拍のハイハット(短いノイズバースト)
    for (let t = offset + period / 2; t < LEN - 0.3; t += period) {
      addNoiseBurst(oc, t, 0.03, 0.25);
    }
  }
  if (noise > 0) {
    // 常時ノイズ(パッド代わり)
    const nb = oc.createBuffer(1, SR * LEN, SR);
    const d = nb.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * noise;
    const src = oc.createBufferSource();
    src.buffer = nb;
    src.connect(oc.destination);
    src.start(0);
  }
  return oc.startRendering();
}

function addNoiseBurst(oc, t, len, gain) {
  const n = Math.floor(SR * len);
  const nb = oc.createBuffer(1, n, SR);
  const d = nb.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const src = oc.createBufferSource();
  src.buffer = nb;
  const g = oc.createGain();
  g.gain.value = gain;
  src.connect(g).connect(oc.destination);
  src.start(t);
}

// ===== 検出アルゴリズム(本体実装に流用予定) =====

export function detectBeats(buffer) {
  const data = buffer.getChannelData(0);
  const sr = buffer.sampleRate;
  const HOP = 512;
  const WIN = 1024;

  // 1. フレームごとのエネルギー
  const nFrames = Math.floor((data.length - WIN) / HOP);
  const energy = new Float32Array(nFrames);
  for (let i = 0; i < nFrames; i++) {
    let s = 0;
    const o = i * HOP;
    for (let j = 0; j < WIN; j++) s += data[o + j] * data[o + j];
    energy[i] = s / WIN;
  }

  // 2. オンセット強度 = エネルギーの正の増分(対数圧縮)
  const onset = new Float32Array(nFrames);
  for (let i = 1; i < nFrames; i++) {
    const d = Math.log(1e-8 + energy[i]) - Math.log(1e-8 + energy[i - 1]);
    onset[i] = Math.max(0, d);
  }
  // 平滑化した移動平均を引いてローカルコントラストに
  const mean = onset.reduce((s, x) => s + x, 0) / nFrames;
  for (let i = 0; i < nFrames; i++) onset[i] = Math.max(0, onset[i] - mean);

  const framesPerSec = sr / HOP;

  // 3. 自己相関でBPM推定 (60〜200 BPM)
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
    // 2倍・4倍周期との整合ボーナス(オクターブ誤りの抑制)
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
    const total = score + harm;
    if (total > bestScore) {
      bestScore = total;
      bestBpm = bpm;
    }
  }

  // 3.5 テンポ折り畳み: MV用途では 90〜180 BPM 帯域に正規化する
  //     (オクターブ誤り対策。半分/2倍テンポはカット密度の解釈違いでしかなく、
  //      位相さえ正しければビート同期は成立する)
  while (bestBpm < 90) bestBpm *= 2;
  while (bestBpm >= 180) bestBpm /= 2;

  // 4. BPM微調整 + 位相推定の同時サーチ:
  //    折り畳みで量子化誤差が倍化するため、±1BPMを0.05刻みで再探索し、
  //    「グリッド点上のオンセット強度合計」が最大の (bpm, phase) を採用する
  let bestPhase = 0;
  let bestJointScore = -1;
  const STEPS = 64;
  const baseBpm = bestBpm;
  for (let bpm = baseBpm - 1; bpm <= baseBpm + 1; bpm += 0.05) {
    const pf = (60 / bpm) * framesPerSec;
    for (let s = 0; s < STEPS; s++) {
      const phase = (s / STEPS) * pf;
      let score = 0;
      for (let t = phase; t < nFrames; t += pf) {
        // グリッド点近傍±2フレームを重み付きで集計(検出遅れ耐性)
        for (let k = -2; k <= 2; k++) score += interp(onset, t + k) / (1 + Math.abs(k));
      }
      if (score > bestJointScore) {
        bestJointScore = score;
        bestPhase = phase;
        bestBpm = bpm;
      }
    }
  }
  const periodFrames = (60 / bestBpm) * framesPerSec;

  const beats = [];
  for (let t = bestPhase; t < nFrames; t += periodFrames) {
    beats.push((t * HOP + WIN / 2) / sr);
  }
  return { bpm: bestBpm, offsetSec: (bestPhase * HOP + WIN / 2) / sr, beats };
}

function interp(arr, x) {
  const i = Math.floor(x);
  if (i < 0 || i + 1 >= arr.length) return 0;
  const f = x - i;
  return arr[i] * (1 - f) + arr[i + 1] * f;
}
