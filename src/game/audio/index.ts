// Audio: the game's sound library played through Web Audio (2D and positional), volume buses, level ambience and
// conditional sounds from objects.qvm, mission dialogue and music. See docs/formats/audio.md.
import * as THREE from "three";
import type { GameSystem } from "../game.ts";
import type { AudioService, PlayOptions, SoundHandle } from "./api.ts";
import { LevelAudio } from "./ambience.ts";
import { AudioEngine } from "./engine.ts";
import { SoundLibrary } from "./library.ts";

export type { AudioBus, AudioService, PlayOptions, SoundHandle } from "./api.ts";

const fwd = new THREE.Vector3();
const up = new THREE.Vector3();

export function audioSystem(): GameSystem {
  let engine: AudioEngine | null = null;
  let level: LevelAudio | null = null;
  let lib: SoundLibrary | null = null;

  return {
    name: "audio",
    async init(game) {
      lib = new SoundLibrary(game.vfs);
      await lib.init(game.level.dir);
      const library = lib;
      const eng = (engine = new AudioEngine(library, (p) => game.toScene(p)));

      let music: SoundHandle | null = null;
      const speech: { queue: { line: string; volume?: number; done: () => void }[]; current: SoundHandle | null } = { queue: [], current: null };
      const resolveVars: { fn: ((n: string) => number | boolean | undefined) | null } = { fn: null };

      const play = (sound: string, o?: PlayOptions): SoundHandle | null => {
        const r = library.resolve(sound);
        return r ? eng.play(r, o) : null;
      };

      const next = (): void => {
        if (speech.current?.playing) return;
        const item = speech.queue.shift();
        if (!item) return;
        const r = library.resolve(item.line);
        if (!r) return item.done(), next();
        speech.current = eng.play(r, {
          bus: "voice",
          volume: item.volume,
          onEnd: () => {
            speech.current = null;
            item.done();
            next();
          },
        });
        if (!speech.current.playing) {
          speech.current = null;
          item.done();
          next();
        }
      };

      const service: AudioService = {
        play,
        list: () => library.paths(),
        find: (p) => library.find(p),
        resolve: (s) => library.resolve(s)?.path ?? null,
        defs: () => library.defNames(),
        async preload(sounds) {
          await Promise.all(sounds.map((s) => library.resolve(s)).map((r) => (r ? library.load(r.path, eng.decoder) : null)));
        },
        async duration(sound) {
          const r = library.resolve(sound);
          if (!r) return null;
          return (await library.load(r.path, eng.decoder))?.duration ?? null;
        },
        speak(line, options) {
          return new Promise<void>((resolve) => {
            if (options?.interrupt) {
              const q = speech.queue.splice(0);
              speech.current?.stop(0.05);
              for (const i of q) i.done();
            }
            speech.queue.push({ line, volume: options?.volume, done: resolve });
            next();
          });
        },
        stopSpeech() {
          const q = speech.queue.splice(0);
          speech.current?.stop(0.05);
          for (const i of q) i.done();
        },
        playMusic(sound, options) {
          music?.stop(options?.fade ?? 0.5);
          music = play(sound, { bus: "music", loop: options?.loop ?? true, fadeIn: options?.fade ?? 0.5, volume: options?.volume, ui: options?.ui });
          return music;
        },
        stopMusic(fade = 0.5) {
          music?.stop(fade);
          music = null;
        },
        getVolume: (b) => eng.getVolume(b),
        setVolume: (b, v) => eng.setVolume(b, v),
        get muted() {
          return eng.muted;
        },
        setMuted: (m) => eng.setMuted(m),
        setVariableResolver(fn) {
          resolveVars.fn = fn;
          if (level) level.external = fn;
        },
        get state() {
          return eng.state;
        },
        resume: () => eng.resume(),
        voices: () => eng.describe(),
        level: () => level?.describe() ?? { areas: [], conditional: [], containers: [] },
        stats: () => ({
          level: eng.outputLevel,
          voices: eng.voiceCount,
          pending: eng.pendingCount,
          cached: library.cachedBuffers.count,
          cachedMB: Math.round(library.cachedBuffers.bytes / 1048576),
          areas: level?.areas.length ?? 0,
          conditional: level?.conditional.length ?? 0,
        }),
      };
      game.services.audio = service;

      level = new LevelAudio(game, library, play);
      level.external = resolveVars.fn;

      // Read the level's loose sounds into memory in the background so the first play does not wait on the network.
      void library.prefetch(library.levelPaths());
    },

    update(dt) {
      level?.update(dt);
    },

    lateUpdate(_dt, game) {
      if (!engine) return;
      engine.setPaused(game.paused);
      game.camera.updateMatrixWorld();
      fwd.set(0, 0, -1).transformDirection(game.camera.matrixWorld);
      up.set(0, 1, 0).transformDirection(game.camera.matrixWorld);
      engine.setListener(game.camera.position, fwd, up);
    },

    dispose() {
      level?.dispose();
      engine?.dispose();
      level = engine = null;
    },
  };
}
