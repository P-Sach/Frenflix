/**
 * In-page probe. Measures real A/V sync without asking the code under test
 * for its own opinion of where it is:
 *
 *   video position  <- 16-bit barcode read off the canvas, per presented frame
 *   audio position  <- 2 kHz burst peaks detected in an AudioWorklet tap
 *
 * Everything is timestamped on performance.now(), so the two series can be
 * compared directly: interpolate the video's content time at the wall instant
 * an audio burst is heard, subtract the burst's content time, and that
 * difference is what a viewer would experience.
 */
import '../src/media/frenflix-video-element.js';

const FPS = 30;
const BIT_W = 40;
const BITS = 16;
const BURST_PERIOD = 0.25;
const BURST_CENTRE = 0.01;

const WORKLET = [
  'class BurstDetect extends AudioWorkletProcessor {',
  '  constructor() { super(); this.in = false; this.peak = 0; this.peakAt = 0; }',
  '  process(inputs) {',
  '    const ch = inputs[0] && inputs[0][0];',
  '    if (!ch) return true;',
  '    let mx = 0, mi = 0;',
  '    for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i]); if (a > mx) { mx = a; mi = i; } }',
  '    if (mx > 0.3) {',
  '      if (!this.in) { this.in = true; this.peak = 0; }',
  '      if (mx > this.peak) { this.peak = mx; this.peakAt = currentFrame + mi; }',
  '    } else if (this.in) {',
  '      this.in = false;',
  '      this.port.postMessage({ t: this.peakAt / sampleRate, amp: this.peak });',
  '    }',
  '    return true;',
  '  }',
  '}',
  'registerProcessor("burst-detect", BurstDetect);',
].join('\n');

const el = document.createElement('frenflix-video');
document.getElementById('host').appendChild(el);
const video = el.controller.video;
const audio = el.controller.audio;

const state = {
  frames: [],      // {wall, content, mediaTime, ct}
  bursts: [],      // {wall, content, ctxTime}
  events: [],      // {wall, who, type, ...}
  marks: {},
};

// ------------------------------------------------------------ event tracing
const MEDIA_EVENTS = ['play', 'pause', 'playing', 'waiting', 'stalled', 'seeking',
  'seeked', 'canplay', 'canplaythrough', 'loadeddata', 'ratechange', 'error', 'ended'];

const trace = (who, node) => {
  for (const type of MEDIA_EVENTS) {
    node.addEventListener(type, () => {
      state.events.push({
        wall: performance.now(), who, type,
        ct: Number(node.currentTime.toFixed(4)),
        rs: node.readyState,
        paused: node.paused,
        rate: Number((node.playbackRate ?? 1).toFixed(4)),
      });
    });
  }
};
trace('video', video);
trace('audio', audio);

// ------------------------------------------------------------- video decode
const canvas = document.createElement('canvas');
canvas.width = 1;
canvas.height = 1;
const cctx = canvas.getContext('2d', { willReadFrequently: true });

let rvfc = null;
const onFrame = (now, meta) => {
  rvfc = video.requestVideoFrameCallback(onFrame);
  const w = video.videoWidth;
  if (!w) return;
  // 1:1 horizontal copy of one scan line, so the bands survive with no
  // resampling. The line is a quarter of the way down: every test clip keeps
  // the barcode there whatever its height.
  if (canvas.width !== w) canvas.width = w;
  cctx.drawImage(video, 0, Math.floor(video.videoHeight * 0.25), w, 1, 0, 0, w, 1);
  const px = cctx.getImageData(0, 0, w, 1).data;
  const band = w / BITS;
  let n = 0;
  for (let k = 0; k < BITS; k += 1) {
    if (px[Math.floor((k + 0.5) * band) * 4] > 128) n |= (1 << k);
  }
  state.frames.push({
    wall: Number.isFinite(meta?.expectedDisplayTime) ? meta.expectedDisplayTime : now,
    content: n / FPS,
    mediaTime: meta?.mediaTime ?? null,
    ct: video.currentTime,
    rate: video.playbackRate,
  });
  if (state.frames.length > 40000) state.frames.shift();
};

// ------------------------------------------------------------- audio decode
//
// `createMediaElementSource` may only be called once per element, so the probe
// does NOT create its own tap on the audio. It hands its AudioContext to the
// controller before playback and then hangs its detector off whatever source
// node the controller creates. One tap, shared: the probe still hears the real
// output, and the code under test still gets the clock it is designed around.
let actx = null;
let wnode = null;
let detector = null;
let attached = false;

function onBurst(e) {
  const ctxTime = e.data.t;
  const ts = actx.getOutputTimestamp();
  // ctxTime is when the burst is rendered; getOutputTimestamp pairs the
  // context clock with performance.now(), so this is when it is heard.
  const wall = ts.performanceTime + (ctxTime - ts.contextTime) * 1000;
  // Which burst is it? Only an integer is needed and they are 250 ms apart,
  // so a coarse currentTime read cannot pick the wrong one.
  const approx = detector.currentTime;
  const k = Math.round((approx - BURST_CENTRE) / BURST_PERIOD);
  state.bursts.push({ wall, content: k * BURST_PERIOD + BURST_CENTRE, k, ctxTime, approx });
  if (state.bursts.length > 8000) state.bursts.shift();
}

async function makeContext() {
  if (actx) return actx;
  actx = new AudioContext({ latencyHint: 'interactive' });
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
  await actx.audioWorklet.addModule(url);
  await actx.resume().catch(() => {});
  wnode = new AudioWorkletNode(actx, 'burst-detect');
  wnode.connect(actx.destination);   // emits nothing, but must be pulled
  wnode.port.onmessage = onBurst;
  return actx;
}

function attachTo(sourceNode, element) {
  if (attached || !sourceNode) return false;
  sourceNode.connect(wnode);
  detector = element;
  attached = true;
  return true;
}

/** Tap an element directly, for cases where the controller will not. */
function selfTap(element) {
  if (attached) return true;
  const src = actx.createMediaElementSource(element);
  src.connect(actx.destination);
  return attachTo(src, element);
}

/** Wait for the controller to create its tap, then listen in on it. */
async function attachToController(timeoutMs = 4000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const src = el.controller.timeline.source;
    if (src) return attachTo(src, audio);
    await new Promise((r) => setTimeout(r, 40));
  }
  // The controller declined to tap (sync off, or Web Audio refused it), so the
  // probe has to open its own so there is still something to measure.
  return selfTap(audio);
}

// ------------------------------------------------------------------- helpers
function videoContentAt(wall) {
  const f = state.frames;
  if (f.length < 2) return null;
  let lo = 0;
  let hi = f.length - 1;
  if (wall < f[0].wall || wall > f[hi].wall) return null;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (f[m].wall <= wall) lo = m; else hi = m;
  }
  const a = f[lo];
  const b = f[hi];
  const span = b.wall - a.wall;
  if (span <= 0) return a.content;
  // A seek puts a step in the content series. Interpolating across it invents
  // a position the video never showed, which is how a clean seek test came
  // back reporting a 34-second worst case.
  const step = Math.abs(b.content - a.content);
  if (step > (span / 1000) * 3 + 0.2) return null;
  return a.content + (b.content - a.content) * ((wall - a.wall) / span);
}

function pairs() {
  const out = [];
  for (const b of state.bursts) {
    const v = videoContentAt(b.wall);
    if (v == null) continue;
    out.push({ wall: b.wall, err: v - b.content, audio: b.content, video: v });
  }
  return out;
}

const stats = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((p, q) => p - q);
  const abs = xs.map(Math.abs).sort((p, q) => p - q);
  const q = (arr, f) => arr[Math.min(arr.length - 1, Math.floor(arr.length * f))];
  return {
    n: xs.length,
    mean: xs.reduce((a, c) => a + c, 0) / xs.length,
    medianSigned: q(s, 0.5),
    medianAbs: q(abs, 0.5),
    p95Abs: q(abs, 0.95),
    maxAbs: abs[abs.length - 1],
    min: s[0],
    max: s[s.length - 1],
  };
};

// --------------------------------------------------------------------- API
window.__bench = {
  el,
  video,
  audio,

  /**
   * `tap` picks which element the burst detector listens to. Tapping the video
   * on a muxed file measures the BROWSER's own A/V sync through the exact same
   * instrument — that reading is the instrument's bias and gets subtracted.
   */
  async setup({ videoUrl, audioUrl, tap = 'audio', syncMode = null }) {
    await makeContext();
    if (tap === 'video') {
      selfTap(video);                     // calibration: no controller involved
    } else if (tap === 'self') {
      selfTap(audio);                     // force the controller onto its fallback
    } else {
      el.controller.timeline.ctx = actx;  // let the controller tap on our context
    }
    if (syncMode) el.syncMode = syncMode;
    el.sources = { videoUrl, audioUrl };
    if (rvfc == null) rvfc = video.requestVideoFrameCallback(onFrame);
    const waitMeta = (node) => (node.readyState >= 1 ? Promise.resolve() : new Promise((res) => {
      const done = () => { node.removeEventListener('loadedmetadata', done); res(); };
      node.addEventListener('loadedmetadata', done);
      setTimeout(res, 10000);
    }));
    await Promise.all([waitMeta(video), audioUrl ? waitMeta(audio) : Promise.resolve()]);
    return { videoDur: video.duration, audioDur: audio.duration, latency: el.measuredLatency };
  },

  mark(name) { state.marks[name] = performance.now(); return state.marks[name]; },

  reset() {
    state.frames.length = 0;
    state.bursts.length = 0;
    state.events.length = 0;
    state.marks = {};
  },

  async play() {
    state.marks.playCalled = performance.now();
    const started = el.play();
    if (!attached) attachToController();
    try { await started; return 'ok'; } catch (e) { return String(e); }
  },
  pause() { el.pause(); },
  seek(t) { state.marks.seekCalled = performance.now(); el.currentTime = t; },
  setRate(r) { el.playbackRate = r; },
  setAudioDelay(ms) { el.audioDelay = ms / 1000; },
  setSyncMode(m) { el.syncMode = m; },

  /** Sample the controller's own view of the world, for debugging. */
  startTrace(everyMs = 100) {
    if (this._trace) clearInterval(this._trace);
    state.trace = [];
    this._trace = setInterval(() => {
      const c = el.controller;
      state.trace.push({
        t: Math.round(performance.now()),
        phase: c._phase,
        seeks: c.seekCount,
        err: Math.round(c.lastError * 1000),
        filt: Math.round(c._errorFilt * 1000),
        vRate: Number(video.playbackRate.toFixed(4)),
        vCt: Number(video.currentTime.toFixed(3)),
        aCt: Number(audio.currentTime.toFixed(3)),
        lag: Math.round(c.timeline.lagSeconds * 1000),
        off: Math.round(c.userOffset * 1000),
        vRs: video.readyState,
        aRs: audio.readyState,
        clock: c.timeline.mode,
        ext: c.hasExternalAudio,
      });
    }, everyMs);
  },
  stopTrace() { if (this._trace) clearInterval(this._trace); this._trace = null; return state.trace || []; },
  getTrace() { return state.trace || []; },
  getAudioDelay() { return el.audioDelay; },

  readout() {
    return {
      drift: el.drift,
      mean: el.meanAbsDrift,
      peak: el.peakDrift,
      latency: el.measuredLatency,
      method: el.syncMethod,
      videoRate: video.playbackRate,
      audioRate: audio.playbackRate,
      videoCt: video.currentTime,
      audioCt: audio.currentTime,
      elCt: el.currentTime,
      paused: el.paused,
      sync: el.syncStatus,
      tapped: attached,
      clockMode: el.controller.timeline.mode,
    };
  },

  /** Everything the driver needs, already reduced. */
  report(sinceMark) {
    const t0 = sinceMark ? (state.marks[sinceMark] ?? 0) : 0;
    const fr = state.frames.filter((f) => f.wall >= t0);
    const bu = state.bursts.filter((b) => b.wall >= t0);
    const pr = pairs().filter((p) => p.wall >= t0);

    // Instantaneous playback rate of each stream, measured against the wall.
    const rateSeries = (arr) => {
      const r = [];
      for (let i = 1; i < arr.length; i += 1) {
        const dw = (arr[i].wall - arr[i - 1].wall) / 1000;
        const dc = arr[i].content - arr[i - 1].content;
        if (dw > 0.001) r.push({ wall: arr[i].wall, rate: dc / dw });
      }
      return r;
    };
    const audioRates = rateSeries(bu);
    const videoRates = rateSeries(fr);

    return {
      marks: state.marks,
      events: state.events.filter((e) => e.wall >= t0)
        .map((e) => ({ ...e, wall: Number((e.wall - t0).toFixed(1)) })),
      frameCount: fr.length,
      burstCount: bu.length,
      firstFrameAfter: fr.length ? Number((fr[0].wall - t0).toFixed(1)) : null,
      firstBurstAfter: bu.length ? Number((bu[0].wall - t0).toFixed(1)) : null,
      firstFrameContent: fr[0]?.content ?? null,
      avError: stats(pr.map((p) => p.err)),
      avSeries: pr.map((p) => ({ w: Number((p.wall - t0).toFixed(0)), e: Number((p.err * 1000).toFixed(1)) })),
      audioRate: stats(audioRates.map((r) => r.rate)),
      videoRate: stats(videoRates.map((r) => r.rate)),
      audioRateSeries: audioRates.map((r) => ({ w: Number((r.wall - t0).toFixed(0)), r: Number(r.rate.toFixed(3)) })),
      // How long the audio spends running slower than half speed: the stutter.
      audioStallCount: audioRates.filter((r) => r.rate < 0.5).length,
      readout: window.__bench.readout(),
    };
  },
};

window.__benchReady = true;
document.getElementById('log').textContent = 'bench ready';
