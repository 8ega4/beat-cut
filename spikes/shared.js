// 非表示タブでは requestAnimationFrame / setTimeout が停止・スロットリングされるため、
// Web Audio の ScriptProcessor コールバック(非表示でも動く)をティッカーとして使う。
// 実プロダクトは可視タブ前提なので rAF でよいが、スパイクの自動実行にはこれが必要。

export async function createTicker() {
  const ac = new AudioContext();
  await ac.resume();
  if (ac.state !== 'running') {
    throw new Error(`AudioContext not running (${ac.state}) — user gesture required`);
  }
  const src = ac.createConstantSource();
  const proc = ac.createScriptProcessor(1024, 1, 1);
  const mute = ac.createGain();
  mute.gain.value = 0;
  src.connect(proc);
  proc.connect(mute).connect(ac.destination);
  src.start();
  const subs = new Set();
  proc.onaudioprocess = () => {
    for (const f of [...subs]) f();
  };
  return {
    ac,
    // ~21ms間隔 (1024 samples @48kHz)
    onTick(f) {
      subs.add(f);
      return () => subs.delete(f);
    },
    sleep(ms) {
      return new Promise((res) => {
        const t0 = performance.now();
        const un = this.onTick(() => {
          if (performance.now() - t0 >= ms) {
            un();
            res();
          }
        });
      });
    },
    async close() {
      proc.onaudioprocess = null;
      src.stop();
      await ac.close();
    },
  };
}

// seeked待ち(タイムアウト付き)
export function seekTo(v, t, timeoutMs = 3000) {
  return new Promise((res, rej) => {
    const timer = setTimeout(() => {
      v.removeEventListener('seeked', done);
      rej(new Error(`seek timeout (${timeoutMs}ms) at t=${t}`));
    }, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      v.removeEventListener('seeked', done);
      res();
    };
    v.addEventListener('seeked', done);
    v.currentTime = t;
  });
}

export async function loadVideoBlob(blob) {
  const v = document.createElement('video');
  v.src = URL.createObjectURL(blob);
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.style.cssText = 'position:fixed;width:2px;height:2px;opacity:0.01;pointer-events:none';
  document.body.appendChild(v);
  await new Promise((res, rej) => {
    v.onloadedmetadata = res;
    v.onerror = () => rej(new Error('video load error'));
  });
  // MediaRecorder製webmは duration=Infinity のため末尾シークで確定させる
  if (!isFinite(v.duration)) {
    await seekTo(v, 1e7, 5000);
    await seekTo(v, 0, 5000);
  }
  return v;
}

export const avg = (xs) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);
export const percentile = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
