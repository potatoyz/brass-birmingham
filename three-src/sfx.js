// WebAudio 合成音效（无音频文件）。初稿由 Antigravity CLI（Gemini 3.8 Flash）生成，已审查并修改：静音时不建 AudioContext。
const STORAGE_KEY = 'bb3d_mute';

function tone(ctx, out, { type = 'sine', freq = 440, endFreq, t0, dur = 0.1, vol = 1 }) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (endFreq) osc.frequency.exponentialRampToValueAtTime(Math.max(endFreq, 20), t0 + dur);
  const a = Math.min(0.008, dur * 0.1);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(vol, t0 + a);
  g.gain.linearRampToValueAtTime(0, t0 + dur);
  osc.connect(g);
  g.connect(out);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function noise(ctx, out, buf, { filterType = 'lowpass', filterFreq = 1000, q = 1, t0, dur = 0.1, vol = 1 }) {
  if (!buf) return;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = filterType;
  f.frequency.setValueAtTime(Math.min(filterFreq, ctx.sampleRate / 2 - 100), t0);
  f.Q.setValueAtTime(q, t0);
  const g = ctx.createGain();
  const a = Math.min(0.008, dur * 0.1);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(vol, t0 + a);
  g.gain.linearRampToValueAtTime(0, t0 + dur);
  src.connect(f);
  f.connect(g);
  g.connect(out);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

const RECIPES = {
  build(ctx, out, buf, r, v, t) {
    const dur = Math.min(0.16 / r, 0.6);
    tone(ctx, out, { type: 'triangle', freq: 120 * r, endFreq: 60 * r, t0: t, dur, vol: 0.8 * v });
    noise(ctx, out, buf, { filterType: 'lowpass', filterFreq: 400 * r, t0: t, dur: Math.min(0.06 / r, 0.6), vol: 0.6 * v });
  },
  link(ctx, out, buf, r, v, t) {
    const dur = Math.min(0.35 / r, 0.6);
    tone(ctx, out, { type: 'triangle', freq: 300 * r, endFreq: 700 * r, t0: t, dur, vol: 0.6 * v });
  },
  coin(ctx, out, buf, r, v, t) {
    tone(ctx, out, { type: 'sine', freq: 1300 * r, t0: t, dur: Math.min(0.18 / r, 0.5), vol: 0.45 * v });
    tone(ctx, out, { type: 'sine', freq: 1750 * r, t0: t + 0.04 / r, dur: Math.min(0.22 / r, 0.5), vol: 0.5 * v });
  },
  coinDown(ctx, out, buf, r, v, t) {
    tone(ctx, out, { type: 'sine', freq: 900 * r, t0: t, dur: Math.min(0.11 / r, 0.5), vol: 0.5 * v });
    tone(ctx, out, { type: 'sine', freq: 700 * r, t0: t + 0.07 / r, dur: Math.min(0.13 / r, 0.5), vol: 0.5 * v });
  },
  flip(ctx, out, buf, r, v, t) {
    noise(ctx, out, buf, { filterType: 'bandpass', filterFreq: 1400 * r, q: 2, t0: t, dur: Math.min(0.12 / r, 0.6), vol: 0.75 * v });
  },
  beer(ctx, out, buf, r, v, t) {
    tone(ctx, out, { type: 'square', freq: 200 * r, endFreq: 80 * r, t0: t, dur: Math.min(0.07 / r, 0.6), vol: 0.35 * v });
    noise(ctx, out, buf, { filterType: 'lowpass', filterFreq: 320 * r, t0: t, dur: Math.min(0.08 / r, 0.6), vol: 0.7 * v });
  },
  cube(ctx, out, buf, r, v, t) {
    tone(ctx, out, { type: 'sine', freq: 800 * r, endFreq: 400 * r, t0: t, dur: Math.min(0.05 / r, 0.6), vol: 0.5 * v });
    noise(ctx, out, buf, { filterType: 'bandpass', filterFreq: 2000 * r, q: 1.5, t0: t, dur: Math.min(0.04 / r, 0.6), vol: 0.6 * v });
  },
  turn(ctx, out, buf, r, v, t) {
    [523.25, 659.25, 783.99].forEach((f, i) => {
      const t0 = t + (i * 0.08) / r;
      const dur = Math.min(0.18 / r, 0.4);
      tone(ctx, out, { type: 'sine', freq: f * r, t0, dur, vol: 0.45 * v });
      tone(ctx, out, { type: 'triangle', freq: f * r, t0, dur, vol: 0.2 * v });
    });
  },
  bonus(ctx, out, buf, r, v, t) {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      const t0 = t + (i * 0.06) / r;
      tone(ctx, out, { type: 'triangle', freq: f * r, t0, dur: Math.min(0.15 / r, 0.35), vol: 0.4 * v });
    });
    tone(ctx, out, { type: 'sine', freq: 2093 * r, t0: t + 0.2 / r, dur: Math.min(0.25 / r, 0.4), vol: 0.35 * v });
  },
  score(ctx, out, buf, r, v, t) {
    const dur = Math.min(0.4 / r, 0.6);
    tone(ctx, out, { type: 'sine', freq: 1046.5 * r, t0: t, dur, vol: 0.6 * v });
    tone(ctx, out, { type: 'sine', freq: 2093 * r, t0: t, dur: Math.min(0.25 / r, 0.6), vol: 0.2 * v });
  },
  discard(ctx, out, buf, r, v, t) {
    noise(ctx, out, buf, { filterType: 'highpass', filterFreq: 2200 * r, q: 0.8, t0: t, dur: Math.min(0.1 / r, 0.6), vol: 0.7 * v });
  },
  loan(ctx, out, buf, r, v, t) {
    const freqs = [1500, 1900, 1650, 2200, 1800];
    let delay = 0;
    freqs.forEach((f) => {
      const pitch = (f + (Math.random() * 80 - 40)) * r;
      tone(ctx, out, { type: 'sine', freq: pitch, t0: t + delay, dur: Math.min(0.08 / r, 0.3), vol: 0.35 * v });
      delay += (0.03 + Math.random() * 0.02) / r;
    });
  }
};

export class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noiseBuf = null;
    this.lastPlay = new Map();
    this._muted = false;
    try {
      if (typeof localStorage !== 'undefined') {
        this._muted = localStorage.getItem(STORAGE_KEY) === '1';
      }
    } catch (_) {}
  }

  get muted() {
    return this._muted;
  }

  set muted(val) {
    this._muted = Boolean(val);
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, this._muted ? '1' : '0');
      }
    } catch (_) {}
    if (this.master && this.ctx) {
      const t = this.ctx.currentTime;
      this.master.gain.setValueAtTime(this.master.gain.value, t);
      this.master.gain.linearRampToValueAtTime(this._muted ? 0 : 0.35, t + 0.03);
    }
  }

  _ensureAudio() {
    if (this.ctx) return true;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return false;
      this.ctx = new AudioCtx();
      this.master = this.ctx.createGain();
      this.master.gain.setValueAtTime(0, this.ctx.currentTime);
      this.master.gain.linearRampToValueAtTime(this._muted ? 0 : 0.35, this.ctx.currentTime + 0.02);
      this.master.connect(this.ctx.destination);
      return true;
    } catch (_) {
      return false;
    }
  }

  _getNoise() {
    if (this.noiseBuf) return this.noiseBuf;
    if (!this.ctx) return null;
    const size = Math.floor(this.ctx.sampleRate * 0.6);
    const buf = this.ctx.createBuffer(1, size, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < size; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
    return buf;
  }

  play(name, opts = {}) {
    if (this._muted || !this._ensureAudio()) return;
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }

    const now = performance.now();
    const last = this.lastPlay.get(name) || 0;
    if (now - last < 60) return;
    this.lastPlay.set(name, now);

    const r = Math.min(Math.max(Number(opts.rate) || 1, 0.5), 2);
    const v = Math.min(Math.max(Number(opts.volume ?? 1) || 0, 0), 1);
    if (v <= 0) return;

    const recipe = RECIPES[name];
    if (recipe) {
      recipe(this.ctx, this.master, this._getNoise(), r, v, this.ctx.currentTime);
    }
  }
}
