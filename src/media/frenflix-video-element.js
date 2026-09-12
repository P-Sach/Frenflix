/**
 * <frenflix-video>
 * ----------------
 * A custom element that presents a video + separately-sourced audio pair
 * (plus optional subtitles) behind the standard HTMLMediaElement interface —
 * the same facade trick `hls-video-element` and `dash-video-element` use.
 *
 * The controls layer only ever touches `play()`, `currentTime`, `volume` and
 * the standard media events, which is what keeps the later phases cheap: Drive
 * sources, extra audio tracks and a different UI skin are all changes *under*
 * this interface.
 */
import { SyncedMediaController } from './SyncedMediaController.js';
import { cueAt } from '../lib/subtitles.js';

const TEMPLATE = document.createElement('template');
TEMPLATE.innerHTML = `
  <style>
    :host {
      display: inline-block;
      position: relative;
      width: 100%;
      container-type: size;
    }
    video { width: 100%; height: 100%; display: block; background: #000; }
    audio { display: none; }

    /* The overlay lives inside this element so it survives fullscreen — the
       element that goes fullscreen is an ancestor, and anything rendered
       outside it would simply vanish. */
    #subs {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 7%;
      display: flex;
      justify-content: center;
      pointer-events: none;
      padding: 0 6%;
      transition: bottom 0.15s;
    }
    /* Lift clear of the control bar while it is on screen, the way every
       player does — set from the player, which can see media-chrome's
       activity state. */
    :host([controls-visible]) #subs { bottom: 17%; }
    #subs.hidden { display: none; }
    #subs > span {
      font-family: ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif;
      font-size: clamp(15px, 5.2cqh, 40px);
      font-weight: 600;
      line-height: 1.3;
      color: #fff;
      text-align: center;
      text-wrap: balance;
      /* A shadow rather than a box: subtitles sit over unknown video, and an
         outline stays readable on white without blocking the picture. */
      text-shadow:
        0 0 4px rgba(0, 0, 0, 0.95),
        0 2px 6px rgba(0, 0, 0, 0.9),
        0 0 14px rgba(0, 0, 0, 0.7);
      white-space: pre-wrap;
    }
  </style>
  <video part="video" playsinline></video>
  <audio part="audio"></audio>
  <div id="subs" class="hidden"><span></span></div>
`;

/** Events passed straight through from the underlying <video>. */
const FORWARDED = [
  // 'playing' is what tells a controls layer to clear its loading spinner.
  'playing',
  'loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough',
  'durationchange', 'timeupdate', 'progress', 'seeking', 'seeked',
  'error', 'emptied', 'resize',
];

export class FrenflixVideoElement extends HTMLElement {
  static get observedAttributes() {
    return ['src', 'audio-src', 'poster', 'autoplay', 'loop', 'muted', 'preload'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).appendChild(TEMPLATE.content.cloneNode(true));
    this._video = this.shadowRoot.querySelector('video');
    this._audio = this.shadowRoot.querySelector('audio');
    this._subsBox = this.shadowRoot.querySelector('#subs');
    this._subsText = this.shadowRoot.querySelector('#subs > span');
    this._controller = new SyncedMediaController(this._video, this._audio);

    this._cues = [];
    this._subtitleOffset = 0;
    this._subtitlesVisible = true;
    this._activeCue = null;
    this._subLoop = null;

    for (const type of FORWARDED) {
      this._video.addEventListener(type, () => this._relay(type));
    }
    this._video.addEventListener('volumechange', () => this._relay('volumechange'));
    this._audio.addEventListener('volumechange', () => this._relay('volumechange'));
    this._video.addEventListener('ratechange', () => this._relay('ratechange'));

    // Buffering is a property of the pair, not of either element.
    this._controller.addEventListener('stalled', () => this._relay('waiting'));
    this._controller.addEventListener('resumed', () => { if (!this.paused) this._relay('playing'); });
    this._controller.addEventListener('ended', () => { this._relay('pause'); this._relay('ended'); });
    this._controller.addEventListener('latencychange', (e) => {
      this.dispatchEvent(new CustomEvent('frenflix:latency', { detail: e.detail }));
    });
  }

  _relay(type) {
    this.dispatchEvent(new Event(type));
  }

  connectedCallback() {
    if (!this.hasAttribute('slot')) this.setAttribute('slot', 'media');
    this._startSubtitleLoop();
  }

  disconnectedCallback() {
    this._stopSubtitleLoop();
    this._controller.destroy();
  }

  attributeChangedCallback(name, _old, value) {
    switch (name) {
      case 'src':
      case 'audio-src':
        this.sources = {
          videoUrl: this.getAttribute('src'),
          audioUrl: this.getAttribute('audio-src'),
        };
        break;
      case 'poster': this._video.poster = value ?? ''; break;
      case 'preload': this._video.preload = value ?? 'auto'; break;
      case 'loop': this._video.loop = value !== null; break;
      case 'autoplay': this._video.autoplay = value !== null; break;
      case 'muted': this.muted = value !== null; break;
      default: break;
    }
  }

  // ------------------------------------------------------------ frenflix API

  set sources(value) {
    /*
     * A play press made while the bytes were still arriving must not be lost.
     *
     * A Drive title has to be copied to this device in full before it can be
     * played — Drive will not serve ranged reads to a browser — so the source
     * can arrive minutes after the page does, and a viewer who pressed play in
     * the meantime meant it. The controller clears its intent when the source
     * changes (it has to: the new source may be a different film), so the
     * intent is carried across here.
     *
     * Without this the press was swallowed, and worse: the controls layer had
     * already been told playback was starting, nothing ever told it otherwise,
     * and it sat on its loading spinner for ever. Hence the `pause` relay on
     * the other branch — whatever happens, the controls' idea of paused is
     * left matching this element's.
     */
    const resume = this._controller.wantPlay;
    this._controller.setSources(value || { videoUrl: '' });
    this.dispatchEvent(new Event('loadstart'));
    if (resume) this.play().catch(() => this._relay('pause'));
    else this._relay('pause');
  }

  get sources() {
    return {
      videoUrl: this._video.src,
      audioUrl: this._controller.hasExternalAudio ? this._audio.src : null,
    };
  }

  /**
   * Manual audio delay in seconds, same sense as VLC's j/k keys: positive
   * means the audio is pushed later. This exists because no amount of clock
   * work can see the hardware output path — see the controller's notes on
   * output latency.
   */
  get audioDelay() { return this._controller.userOffset; }
  set audioDelay(v) {
    this._controller.userOffset = Number(v) || 0;
    // Deliberately not a seek for small nudges: you adjust this by ear, in
    // 50ms steps, and a decoder flush on every keypress would make that
    // impossible to judge. The rate controller walks it over in well under a
    // second instead.
    this._controller._alignVideoNow(0.15);
  }

  /**
   * Swap the audio track while playing. The facade's whole point: the controls
   * layer asks for a different track and nothing else in the stack notices.
   *
   * @param {string|null} url null goes back to the video's embedded audio
   */
  setAudioTrack(url) { return this._controller.swapAudio(url); }

  get hasExternalAudio() { return this._controller.hasExternalAudio; }

  /** Measured length of the audio output path, seconds. */
  get measuredLatency() { return this._controller.timeline.lagSeconds; }

  /** Everything the sync panel reads: state, clock, offsets, error. */
  get syncStatus() { return this._controller.syncStatus; }

  /** 'auto' | 'manual' | 'off' */
  get syncMode() { return this._controller.syncMode; }
  set syncMode(mode) { this._controller.setSyncMode(mode); }

  /** Signed A/V error, seconds. Positive: video ahead of audio. */
  get drift() { return this._controller.drift; }
  get meanAbsDrift() { return this._controller.meanAbsDrift; }
  get peakDrift() { return this._controller.peakDrift; }
  get syncMethod() { return this._controller.supportsFrameCallback ? 'frame-accurate' : 'estimated'; }

  // Subtitles -----------------------------------------------------------

  set subtitleCues(cues) {
    this._cues = Array.isArray(cues) ? cues : [];
    this._activeCue = null;
    this._renderCue(true);
  }

  get subtitleCues() { return this._cues; }

  get subtitleOffset() { return this._subtitleOffset; }
  set subtitleOffset(v) {
    this._subtitleOffset = Number(v) || 0;
    this._renderCue(true);
  }

  get subtitlesVisible() { return this._subtitlesVisible; }
  set subtitlesVisible(v) {
    this._subtitlesVisible = Boolean(v);
    this._renderCue(true);
  }

  _startSubtitleLoop() {
    if (this._subLoop) return;
    const step = () => {
      this._subLoop = requestAnimationFrame(step);
      this._renderCue(false);
    };
    this._subLoop = requestAnimationFrame(step);
  }

  _stopSubtitleLoop() {
    if (this._subLoop) cancelAnimationFrame(this._subLoop);
    this._subLoop = null;
  }

  _renderCue(force) {
    if (!this._subsBox) return;
    if (!this._subtitlesVisible || this._cues.length === 0) {
      if (force || !this._subsBox.classList.contains('hidden')) {
        this._subsBox.classList.add('hidden');
        this._activeCue = null;
      }
      return;
    }
    // Cues are timed against the master clock (the audio, when there is one),
    // because dialogue is what they belong to.
    const t = this._controller.currentTime - this._subtitleOffset;
    const cue = cueAt(this._cues, t);
    if (cue === this._activeCue && !force) return;
    this._activeCue = cue;
    if (cue) {
      this._subsText.innerHTML = cue.html;
      this._subsBox.classList.remove('hidden');
    } else {
      this._subsBox.classList.add('hidden');
    }
  }

  get nativeVideo() { return this._video; }
  get controller() { return this._controller; }

  // -------------------------------------------------- HTMLMediaElement surface

  play() { return this._controller.play().then(() => this._relay('play')); }

  pause() { this._controller.pause(); this._relay('pause'); }

  load() { this._video.load(); if (this._controller.hasExternalAudio) this._audio.load(); }

  canPlayType(type) { return this._video.canPlayType(type); }

  /** From user intent, not physical state: a buffer hold still reads as playing. */
  get paused() { return !this._controller.wantPlay; }

  get currentTime() { return this._controller.currentTime; }
  set currentTime(t) { this._controller.seek(t); }

  get duration() { return this._video.duration; }
  get seekable() { return this._video.seekable; }
  get buffered() { return this._video.buffered; }
  get played() { return this._video.played; }
  get readyState() { return this._video.readyState; }
  get networkState() { return this._video.networkState; }
  get seeking() { return this._video.seeking || this._audio.seeking; }
  get ended() { return this._video.ended; }
  get error() { return this._video.error || this._audio.error; }

  get videoWidth() { return this._video.videoWidth; }
  get videoHeight() { return this._video.videoHeight; }

  get volume() { return this._controller.soundElement.volume; }
  set volume(v) { this._controller.soundElement.volume = v; }

  get muted() { return this._controller.soundElement.muted; }
  set muted(v) { this._controller.soundElement.muted = Boolean(v); }

  get playbackRate() { return this._controller.rate; }
  set playbackRate(r) { this._controller.rate = r; }

  get defaultPlaybackRate() { return this._video.defaultPlaybackRate; }
  set defaultPlaybackRate(r) { this._video.defaultPlaybackRate = r; }

  get preservesPitch() { return this._audio.preservesPitch; }
  set preservesPitch(v) { this._video.preservesPitch = v; this._audio.preservesPitch = v; }

  get loop() { return this._video.loop; }
  set loop(v) { this._video.loop = Boolean(v); }

  get autoplay() { return this._video.autoplay; }
  set autoplay(v) { this._video.autoplay = Boolean(v); }

  get poster() { return this._video.poster; }
  set poster(v) { this._video.poster = v; }

  get preload() { return this._video.preload; }
  set preload(v) { this._video.preload = v; }

  get crossOrigin() { return this._video.crossOrigin; }
  set crossOrigin(v) { this._video.crossOrigin = v; this._audio.crossOrigin = v; }

  get textTracks() { return this._video.textTracks; }
  addTextTrack(...args) { return this._video.addTextTrack(...args); }

  get disablePictureInPicture() { return this._video.disablePictureInPicture; }
  set disablePictureInPicture(v) { this._video.disablePictureInPicture = v; }
  requestPictureInPicture() { return this._video.requestPictureInPicture(); }
  get remote() { return this._video.remote; }
}

if (!customElements.get('frenflix-video')) {
  customElements.define('frenflix-video', FrenflixVideoElement);
}

export default FrenflixVideoElement;
