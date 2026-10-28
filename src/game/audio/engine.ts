// Web Audio playback: one lazily created context, volume buses, voices (2D and positional), voice limiting with
// priority, pause handling and listener sync. No game knowledge beyond a position converter.

import type { Vec3 } from "../coords.ts";
import { METRE } from "../coords.ts";
import type { AudioBus, PlayOptions, SoundHandle } from "./api.ts";
import type { ResolvedSound, SoundLibrary } from "./library.ts";

type VoiceBus = Exclude<AudioBus, "master">;
const BUSES: VoiceBus[] = ["effects", "voice", "music", "ambience"];
const PRIORITY: Record<VoiceBus, number> = { music: 100, voice: 90, effects: 50, ambience: 20 };

const MAX_VOICES = 40;
/** Most simultaneous copies of the same sample (automatic weapons would otherwise eat every voice). */
const MAX_PER_SOUND = 6;
const STORAGE_KEY = "igi.audio";
const DEFAULT_VOLUME: Record<AudioBus, number> = { master: 1, effects: 1, voice: 1, music: 0.7, ambience: 0.8 };
/** Positional sounds without an authored range fall off over this many metres. */
const DEFAULT_RANGE_M = 60;

let seq = 0;

interface VoiceParams {
  path: string;
  bus: VoiceBus;
  priority: number;
  volume: number;
  loop: boolean;
  pitch: number;
  ui: boolean;
  /** Audio-space position in metres (null = 2D). */
  at: [number, number, number] | null;
  minM: number;
  maxM: number;
  fadeIn: number;
  onEnd?: () => void;
}

export class Voice implements SoundHandle {
  readonly id = ++seq;
  state: "loading" | "playing" | "paused" | "ended" = "loading";
  readonly bornAt = performance.now();
  private buffer: AudioBuffer | null = null;
  private src: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private panner: PannerNode | null = null;
  private offset = 0;
  private startedAt = 0;
  private level = 1;

  private engine: AudioEngine;
  readonly p: VoiceParams;

  constructor(engine: AudioEngine, p: VoiceParams) {
    this.engine = engine;
    this.p = p;
  }

  get playing() {
    return this.state !== "ended";
  }

  get ui() {
    return this.p.ui;
  }

  /** Metres from the listener (0 for 2D). */
  distance(): number {
    const a = this.p.at;
    return a ? this.engine.listenerDistance(a) : 0;
  }

  setBuffer(buffer: AudioBuffer | null) {
    if (this.state !== "loading") return;
    if (!buffer) return this.end();
    this.buffer = buffer;
    this.state = this.engine.paused && !this.p.ui ? "paused" : "playing";
    if (this.state === "playing") this.start();
  }

  /** Build the node chain and start from `offset`. */
  start() {
    const ctx = this.engine.ctx;
    if (!ctx || !this.buffer) return;
    const g = ctx.createGain();
    const fade = this.p.fadeIn > 0 && this.offset === 0;
    g.gain.value = fade ? 0 : this.p.volume * this.level;
    if (fade) g.gain.linearRampToValueAtTime(this.p.volume * this.level, ctx.currentTime + this.p.fadeIn);
    let tail: AudioNode = g;
    if (this.p.at) {
      const [x, y, z] = this.p.at;
      const range = Math.min(1e6, Math.max(this.p.maxM, this.p.minM + 0.01));
      const pn = new PannerNode(ctx, {
        panningModel: "equalpower",
        distanceModel: "linear",
        refDistance: this.p.minM,
        maxDistance: range,
        // A range of Infinity (ambience areas) turns attenuation off; the caller drives the level itself.
        rolloffFactor: Number.isFinite(this.p.maxM) ? 1 : 0,
        positionX: x,
        positionY: y,
        positionZ: z,
      });
      g.connect(pn);
      tail = pn;
      this.panner = pn;
    }
    tail.connect(this.engine.bus(this.p.bus));
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    src.loop = this.p.loop;
    src.playbackRate.value = this.p.pitch;
    src.connect(g);
    src.onended = () => {
      if (this.state === "playing") this.end();
    };
    this.gain = g;
    this.src = src;
    this.startedAt = ctx.currentTime;
    src.start(0, this.offset % this.buffer.duration);
    this.state = "playing";
  }

  /** Freeze at the current position (game pause); resume() continues. */
  pause() {
    if (this.state === "loading") return;
    if (this.state !== "playing" || !this.src || !this.buffer || !this.engine.ctx) return;
    const played = (this.engine.ctx.currentTime - this.startedAt) * this.p.pitch;
    this.offset += played;
    if (!this.p.loop && this.offset >= this.buffer.duration) return this.end();
    this.teardown();
    this.state = "paused";
  }

  resume() {
    if (this.state === "paused") this.start();
  }

  private teardown() {
    if (this.src) {
      this.src.onended = null;
      try {
        this.src.stop();
      } catch {
        /* already stopped */
      }
      this.src.disconnect();
    }
    this.gain?.disconnect();
    this.panner?.disconnect();
    this.src = this.gain = this.panner = null;
  }

  stop(fade = 0.03) {
    if (this.state === "ended") return;
    const ctx = this.engine.ctx;
    if (this.state === "playing" && ctx && this.gain && this.src && fade > 0) {
      const now = ctx.currentTime;
      this.gain.gain.cancelScheduledValues(now);
      this.gain.gain.setValueAtTime(this.gain.gain.value, now);
      this.gain.gain.linearRampToValueAtTime(0, now + fade);
      this.src.onended = null;
      this.src.stop(now + fade);
      const { src, gain, panner } = this;
      src.onended = () => {
        src.disconnect();
        gain.disconnect();
        panner?.disconnect();
      };
      this.src = this.gain = this.panner = null;
    } else this.teardown();
    this.end();
  }

  /** Voice-limit steal: no fade needed beyond the click guard. */
  steal() {
    this.stop(0.02);
  }

  private end() {
    if (this.state === "ended") return;
    this.state = "ended";
    this.teardown();
    this.engine.release(this);
    this.p.onEnd?.();
  }

  setPosition(p: Vec3) {
    if (!this.p.at) return;
    const a = this.engine.toAudio(p);
    this.p.at = a;
    if (this.panner && this.engine.ctx) {
      const t = this.engine.ctx.currentTime;
      this.panner.positionX.setValueAtTime(a[0], t);
      this.panner.positionY.setValueAtTime(a[1], t);
      this.panner.positionZ.setValueAtTime(a[2], t);
    }
  }

  setVolume(v: number) {
    this.level = Math.max(0, v);
    if (this.gain && this.engine.ctx) this.gain.gain.setTargetAtTime(this.p.volume * this.level, this.engine.ctx.currentTime, 0.05);
  }
}

class DeadHandle implements SoundHandle {
  playing = false;
  stop() {}
  setPosition() {}
  setVolume() {}
}
const DEAD = new DeadHandle();

export class AudioEngine {
  ctx: AudioContext | null = null;
  paused = false;
  muted = false;
  private volumes: Record<AudioBus, number> = { ...DEFAULT_VOLUME };
  private master!: GainNode;
  private analyser: AnalyserNode | null = null;
  private samples = new Float32Array(1024);
  private busGains = new Map<VoiceBus, GainNode>();
  private voices = new Set<Voice>();
  private waiting: Voice[] = [];
  private lastListener: Vec3Audio = [0, 0, 0];
  private lastRight: Vec3Audio = [1, 0, 0];
  private unlock: (() => void) | null = null;
  private onChange: () => void;

  /** Converts an IGI world position (units) into the audio space (metres, three.js axes). */
  toAudio: (p: Vec3) => [number, number, number];

  readonly library: SoundLibrary;

  constructor(library: SoundLibrary, toScene: (p: Vec3) => { x: number; y: number; z: number }, onChange: () => void = () => {}) {
    this.library = library;
    this.toAudio = (p) => {
      const v = toScene(p);
      return [v.x / METRE, v.y / METRE, v.z / METRE];
    };
    this.onChange = onChange;
    this.loadSettings();
    // Chrome only starts a context after the page has been interacted with; create ours then, so nothing warns before.
    if (navigator.userActivation?.hasBeenActive) this.createContext();
    else this.armUnlock();
  }

  get state(): "locked" | "running" {
    return this.ctx?.state === "running" ? "running" : "locked";
  }

  // ------------------------------------------------------------------------------------------------- context

  private armUnlock() {
    const events = ["pointerdown", "keydown", "touchend", "mousedown"];
    const go = () => {
      this.resume();
      if (this.ctx) {
        for (const e of events) removeEventListener(e, go, true);
        this.unlock = null;
      }
    };
    for (const e of events) addEventListener(e, go, true);
    this.unlock = () => {
      for (const e of events) removeEventListener(e, go, true);
    };
  }

  /** Create or resume the context. Needs a user gesture (or sticky activation) to succeed. */
  resume() {
    if (!this.ctx) this.createContext();
    if (this.ctx && this.ctx.state !== "running") void this.ctx.resume().catch(() => {});
  }

  private createContext() {
    if (this.ctx) return;
    const ctx = new AudioContext({ latencyHint: "interactive" });
    this.ctx = ctx;
    const comp = new DynamicsCompressorNode(ctx, { threshold: -12, knee: 12, ratio: 6, attack: 0.003, release: 0.25 });
    this.master = ctx.createGain();
    this.analyser = new AnalyserNode(ctx, { fftSize: 1024 });
    this.master.connect(comp).connect(ctx.destination);
    comp.connect(this.analyser);
    for (const b of BUSES) {
      const g = ctx.createGain();
      g.connect(this.master);
      this.busGains.set(b, g);
    }
    this.applyVolumes();
    for (const v of this.waiting.splice(0)) this.begin(v);
    void ctx.resume().catch(() => {});
    this.unlock?.();
    this.unlock = null;
  }

  private offline: OfflineAudioContext | null = null;

  /** A context to decode samples with: AudioBuffers work in any context, so no user gesture is needed. */
  get decoder(): BaseAudioContext {
    return this.ctx ?? (this.offline ??= new OfflineAudioContext(1, 1, 44100));
  }

  bus(b: VoiceBus): GainNode {
    return this.busGains.get(b)!;
  }

  // ------------------------------------------------------------------------------------------------- volume

  getVolume(b: AudioBus) {
    return this.volumes[b];
  }

  setVolume(b: AudioBus, v: number) {
    this.volumes[b] = Math.min(1, Math.max(0, v));
    this.applyVolumes();
    this.saveSettings();
    this.onChange();
  }

  setMuted(m: boolean) {
    this.muted = m;
    this.applyVolumes();
    this.saveSettings();
    this.onChange();
  }

  private applyVolumes() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.muted ? 0 : this.volumes.master, t, 0.02);
    for (const b of BUSES) this.busGains.get(b)!.gain.setTargetAtTime(this.volumes[b], t, 0.02);
  }

  private loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
      if (!s) return;
      for (const b of Object.keys(this.volumes) as AudioBus[]) if (typeof s[b] === "number") this.volumes[b] = Math.min(1, Math.max(0, s[b]));
      this.muted = !!s.muted;
    } catch {
      /* storage unavailable */
    }
  }

  private saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...this.volumes, muted: this.muted }));
    } catch {
      /* storage unavailable */
    }
  }

  // ------------------------------------------------------------------------------------------------- listener

  /** Sync the listener to the camera: position in metres plus forward and up vectors (all in three.js axes). */
  setListener(pos: { x: number; y: number; z: number }, forward: { x: number; y: number; z: number }, up: { x: number; y: number; z: number }) {
    const x = pos.x / METRE;
    const y = pos.y / METRE;
    const z = pos.z / METRE;
    this.lastListener = [x, y, z];
    this.lastRight = [forward.y * up.z - forward.z * up.y, forward.z * up.x - forward.x * up.z, forward.x * up.y - forward.y * up.x];
    const l = this.ctx?.listener;
    if (!l || !this.ctx) return;
    if (l.positionX) {
      const t = this.ctx.currentTime;
      l.positionX.setValueAtTime(x, t);
      l.positionY.setValueAtTime(y, t);
      l.positionZ.setValueAtTime(z, t);
      l.forwardX.setValueAtTime(forward.x, t);
      l.forwardY.setValueAtTime(forward.y, t);
      l.forwardZ.setValueAtTime(forward.z, t);
      l.upX.setValueAtTime(up.x, t);
      l.upY.setValueAtTime(up.y, t);
      l.upZ.setValueAtTime(up.z, t);
    }
  }

  listenerDistance(a: [number, number, number]) {
    const l = this.lastListener;
    return Math.hypot(a[0] - l[0], a[1] - l[1], a[2] - l[2]);
  }

  // ------------------------------------------------------------------------------------------------- pause

  setPaused(p: boolean) {
    if (p === this.paused) return;
    this.paused = p;
    for (const v of this.voices) {
      if (v.ui) continue;
      if (p) v.pause();
      else v.resume();
    }
  }

  // ------------------------------------------------------------------------------------------------- playing

  /** Start a resolved sound. Cheap when the buffer is already decoded. */
  play(r: ResolvedSound, o: PlayOptions = {}, busHint: VoiceBus | null = null): SoundHandle {
    const def = r.def;
    const bus = o.bus ?? busHint ?? inferBus(r);
    const loop = o.loop ?? def?.loop ?? false;
    const volume = (o.volume ?? 1) * (def?.volume ?? 1);
    let maxM = o.range !== undefined ? o.range / METRE : (def?.max ?? DEFAULT_RANGE_M);
    const minM = Math.min(def?.min ?? 1, Number.isFinite(maxM) ? maxM * 0.5 : Infinity);
    const at = o.at ? this.toAudio(o.at) : null;
    // Inaudible one-shots never start (a gunshot 300 m away).
    if (at && !loop && Number.isFinite(maxM) && this.listenerDistance(at) > maxM) {
      o.onEnd?.();
      return DEAD;
    }
    if (!Number.isFinite(maxM) && !at) maxM = 0;
    const voice = new Voice(this, {
      path: r.path,
      bus,
      priority: o.priority ?? PRIORITY[bus],
      volume,
      loop,
      pitch: o.pitch ?? 1,
      ui: o.ui ?? false,
      at,
      minM,
      maxM,
      fadeIn: o.fadeIn ?? 0,
      onEnd: o.onEnd,
    });
    if (!this.admit(voice)) {
      o.onEnd?.();
      return DEAD;
    }
    this.voices.add(voice);
    if (!this.ctx) {
      this.waiting.push(voice);
      return voice;
    }
    this.begin(voice);
    return voice;
  }

  private begin(v: Voice) {
    if (!v.playing) return;
    // One-shots queued before the page was interactive are stale after a moment; loops (ambience) still start.
    if (!v.p.loop && performance.now() - v.bornAt > 1500) return v.stop(0);
    const hit = this.library.peek(v.p.path);
    if (hit) v.setBuffer(hit);
    else void this.library.load(v.p.path, this.decoder).then((b) => v.setBuffer(b));
  }

  /** Make room for a new voice; false if it loses to everything already playing. */
  private admit(v: Voice): boolean {
    const same = [...this.voices].filter((x) => x.p.path === v.p.path);
    if (same.length >= MAX_PER_SOUND) {
      const oldest = same.reduce((a, b) => (a.bornAt <= b.bornAt ? a : b));
      if (oldest.p.priority > v.p.priority) return false;
      oldest.steal();
    }
    if (this.voices.size >= MAX_VOICES) {
      let victim: Voice | null = null;
      for (const x of this.voices) {
        if (x.p.priority > v.p.priority) continue;
        if (!victim || x.p.priority < victim.p.priority || (x.p.priority === victim.p.priority && x.distance() > victim.distance())) victim = x;
      }
      if (!victim) return false;
      victim.steal();
    }
    return true;
  }

  release(v: Voice) {
    this.voices.delete(v);
    const i = this.waiting.indexOf(v);
    if (i >= 0) this.waiting.splice(i, 1);
  }

  stopAll(fade = 0) {
    for (const v of [...this.voices]) v.stop(fade);
  }

  get voiceCount() {
    return this.voices.size;
  }

  get pendingCount() {
    return [...this.voices].filter((v) => v.state === "loading").length;
  }

  /** RMS of the final mix (0..1), for meters and tests. */
  get outputLevel(): number {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (const s of this.samples) sum += s * s;
    return Math.sqrt(sum / this.samples.length);
  }

  /** What is playing, for debugging. */
  describe() {
    return [...this.voices].map((v) => ({ path: v.p.path, bus: v.p.bus, state: v.state, loop: v.p.loop, priority: v.p.priority, volume: +v.p.volume.toFixed(2), distanceM: v.p.at ? +v.distance().toFixed(1) : null, pan: v.p.at ? this.pan(v.p.at) : null }));
  }

  /** -1 (hard left) .. 1 (hard right) for a source position, as the listener hears it. */
  private pan(a: Vec3Audio) {
    const l = this.lastListener;
    const d = Math.hypot(a[0] - l[0], a[1] - l[1], a[2] - l[2]) || 1;
    const r = this.lastRight;
    return +(((a[0] - l[0]) * r[0] + (a[1] - l[1]) * r[1] + (a[2] - l[2]) * r[2]) / d).toFixed(2);
  }

  dispose() {
    this.stopAll();
    this.unlock?.();
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}

type Vec3Audio = [number, number, number];

/** Pick a bus from what the sound is: mission dialogue and cutscene speech, music, or plain effects. */
function inferBus(r: ResolvedSound): VoiceBus {
  if (r.def?.group === "VOICE" || /\/(m\d+_ing_\d+|_cut\d+_\d+)\.wav$/.test(r.path)) return "voice";
  if (/menu_music\.wav$/.test(r.path)) return "music";
  if (/\/m\d+_ambience\.wav$/.test(r.path)) return "ambience";
  return "effects";
}
