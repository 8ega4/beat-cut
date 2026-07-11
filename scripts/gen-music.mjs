// プリセット楽曲のダミー音源を生成する(後からSuno生成曲に差し替える前提)。
// 依存なしで 44.1kHz mono 16bit WAV を書き出す。
// 使い方: node scripts/gen-music.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SR = 44100;
const LEN = 36; // 秒(30秒出力+余裕)
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'music');
mkdirSync(outDir, { recursive: true });

const TRACKS = [
  { file: 'neon-drive.wav', bpm: 120, style: 'drive' },
  { file: 'midnight-steps.wav', bpm: 95, style: 'chill' },
  { file: 'hyper-bloom.wav', bpm: 140, style: 'hyper' },
];

for (const t of TRACKS) {
  const buf = synth(t.bpm, t.style);
  writeFileSync(join(outDir, t.file), toWav(buf));
  console.log(`${t.file} (${t.bpm}bpm) written`);
}

function synth(bpm, style) {
  const n = SR * LEN;
  const out = new Float64Array(n);
  const period = 60 / bpm;
  const beats = Math.floor((LEN - 0.5) / period);

  // ベース進行(4ビートごとにルートを変える)
  const roots = [55, 65.4, 49, 41.2]; // A1, C2, G1, E1

  for (let b = 0; b < beats; b++) {
    const t = b * period;
    kick(out, t, 1.0);
    if (b % 2 === 1) snare(out, t, style === 'chill' ? 0.35 : 0.5);
    hat(out, t + period / 2, style === 'hyper' ? 0.35 : 0.25);
    if (style === 'hyper') {
      hat(out, t + period / 4, 0.18);
      hat(out, t + (3 * period) / 4, 0.18);
    }
    const root = roots[Math.floor(b / 4) % roots.length];
    bass(out, t, period * (style === 'chill' ? 0.9 : 0.5), root, style === 'chill' ? 0.16 : 0.14);
    if (style === 'drive') bass(out, t + period / 2, period * 0.4, root * 2, 0.08);
  }

  // 軽いパッド(検出を邪魔しない程度)
  for (let i = 0; i < n; i++) {
    const tt = i / SR;
    out[i] += 0.03 * Math.sin(2 * Math.PI * 220 * tt) * (0.6 + 0.4 * Math.sin(2 * Math.PI * tt * 0.25));
  }

  // 正規化(ヘッドルーム -1dB)
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  const g = 0.89 / peak;
  for (let i = 0; i < n; i++) out[i] *= g;
  return out;
}

function kick(out, t, amp) {
  const start = Math.floor(t * SR);
  const len = Math.floor(0.28 * SR);
  for (let i = 0; i < len && start + i < out.length; i++) {
    const tt = i / SR;
    const f = 150 * Math.exp(-tt * 18) + 45;
    const env = Math.exp(-tt * 14);
    out[start + i] += amp * env * Math.sin(2 * Math.PI * f * tt);
  }
}

function snare(out, t, amp) {
  const start = Math.floor(t * SR);
  const len = Math.floor(0.16 * SR);
  for (let i = 0; i < len && start + i < out.length; i++) {
    const tt = i / SR;
    const env = Math.exp(-tt * 26);
    out[start + i] += amp * env * ((Math.random() * 2 - 1) * 0.7 + 0.3 * Math.sin(2 * Math.PI * 185 * tt));
  }
}

function hat(out, t, amp) {
  const start = Math.floor(t * SR);
  const len = Math.floor(0.05 * SR);
  let hp = 0;
  for (let i = 0; i < len && start + i < out.length; i++) {
    const white = Math.random() * 2 - 1;
    const hi = white - hp; // 簡易ハイパス
    hp = hp * 0.6 + white * 0.4;
    out[start + i] += amp * Math.exp(-(i / SR) * 60) * hi;
  }
}

function bass(out, t, dur, freq, amp) {
  const start = Math.floor(t * SR);
  const len = Math.floor(dur * SR);
  for (let i = 0; i < len && start + i < out.length; i++) {
    const tt = i / SR;
    const env = Math.min(1, tt * 200) * Math.exp(-tt * 3);
    const sq = Math.sign(Math.sin(2 * Math.PI * freq * tt)) * 0.5 + Math.sin(2 * Math.PI * freq * tt) * 0.5;
    out[start + i] += amp * env * sq;
  }
}

function toWav(float64) {
  const n = float64.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(float64[i] * 32767))), 44 + i * 2);
  }
  return buf;
}
