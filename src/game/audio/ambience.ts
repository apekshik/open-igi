// Level sound tasks from objects.qvm:
//
//   AmbientArea(Position, Orientation, Size (m), Min Delay, Random wait, SoundDef)
//     A box. Looping sounds play while the listener is inside it (fading out over a margin around it); one-shot sounds
//     repeat every MinDelay + random(0..Wait) seconds at a random spot in the box.
//   ConditionalSound(Condition, SoundDef, Position, Simple, OneShot, Relative to microphone)
//     Plays while its condition holds (loops) or once each time it becomes true (non-looping sounds).
//
// Both live under ConditionalContainer tasks whose conditions gate them, so containers are evaluated here too.
// Conditions are read with a three-valued evaluator (expr.ts): anything the variable resolver does not know is
// "unknown", and unknown means not running.

import type { QvmCall, QvmValue } from "../../formats/qvm.ts";
import { METRE, type Vec3 } from "../coords.ts";
import type { Game } from "../game.ts";
import type { PlayOptions, SoundHandle } from "./api.ts";
import { evalCondition, GAME_FREQUENCY, type Resolve } from "./expr.ts";
import type { SoundDef, SoundLibrary } from "./library.ts";

interface Container {
  id: number;
  cond: string;
  parent: number | null;
}

interface Area {
  name: string;
  c: Vec3;
  yaw: number;
  /** Size in metres. */
  size: Vec3;
  minDelay: number;
  wait: number;
  defs: string[];
  gate: number | null;
  /** Seconds until the next one-shot. */
  timer: number;
  fade: number;
}

interface CondSound {
  name: string;
  cond: string;
  def: string;
  pos: Vec3 | null;
  relative: boolean;
  gate: number | null;
  active: boolean;
  voice: SoundHandle | null;
}

const num = (v: QvmValue | undefined) => (typeof v === "number" ? v : 0);
const bool = (v: QvmValue | undefined) => v === 1 || (typeof v === "object" && "ident" in v && v.ident === "TRUE");

/** How often conditions are re-evaluated (seconds). */
const TICK = 0.2;

export class LevelAudio {
  readonly areas: Area[] = [];
  readonly conditional: CondSound[] = [];
  private containers = new Map<number, Container>();
  private running = new Map<number, boolean>();
  private loops = new Map<string, { voice: SoundHandle; gain: number }>();
  private tick = 0;
  private alarms = new Map<number, boolean>();
  private alarmAny = false;
  external: Resolve | null = null;
  private off: (() => void)[] = [];

  private game: Game;
  private lib: SoundLibrary;
  private play: (def: string, o?: PlayOptions) => SoundHandle | null;

  constructor(game: Game, lib: SoundLibrary, play: (def: string, o?: PlayOptions) => SoundHandle | null) {
    this.game = game;
    this.lib = lib;
    this.play = play;
    this.collect(game.level.statements, null);
    this.off.push(
      game.events.on("alarm", (e) => {
        if (e.sourceId == null) this.alarmAny = e.active;
        else this.alarms.set(e.sourceId, e.active);
      }),
    );
  }

  private collect(args: (QvmCall | QvmValue)[], gate: number | null) {
    for (const c of args) {
      if (typeof c !== "object" || !("fn" in c) || c.fn !== "Task_New") continue;
      const [id, type, name, ...p] = c.args;
      let childGate = gate;
      if (type === "ConditionalContainer") {
        const cont: Container = { id: num(id), cond: typeof p[0] === "string" ? p[0] : "", parent: gate };
        this.containers.set(cont.id, cont);
        childGate = cont.id;
      } else if (type === "AmbientArea") {
        const defs = String(p[11] ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        const size: Vec3 = [num(p[6]), num(p[7]), num(p[8])];
        this.areas.push({
          name: String(name),
          c: [num(p[0]), num(p[1]), num(p[2])],
          yaw: num(p[5]),
          size,
          minDelay: num(p[9]),
          wait: num(p[10]),
          defs,
          gate,
          timer: -1,
          fade: Math.min(30, Math.max(4, 0.3 * Math.min(size[0], size[1]))),
        });
      } else if (type === "ConditionalSound") {
        const pos: Vec3 = [num(p[2]), num(p[3]), num(p[4])];
        this.conditional.push({
          name: String(name),
          cond: typeof p[0] === "string" ? p[0] : "",
          def: String(p[1] ?? "").toLowerCase(),
          pos: pos[0] || pos[1] || pos[2] ? pos : null,
          relative: bool(p[7]),
          gate,
          active: false,
          voice: null,
        });
      }
      this.collect(c.args, childGate);
    }
  }

  // ------------------------------------------------------------------------------------------------- conditions

  private resolve: Resolve = (name) => {
    const ext = this.external?.(name);
    if (ext !== undefined) return ext;
    if (name === "GAME_FREQUENCY") return GAME_FREQUENCY;
    const m = /^(\w+?)_(\d+)\.(\w+)$/.exec(name);
    if (!m) return undefined;
    const id = Number(m[2]);
    if (m[3] === "isRun" && this.containers.has(id)) return this.runs(id);
    if (m[3] === "isAlarm" && m[1] === "AlarmControl") return this.alarms.get(id) ?? this.alarmAny;
    return undefined;
  };

  private evaluating = new Set<number>();

  /** Is this ConditionalContainer (and every container above it) running? Unknown conditions do not run. */
  private runs(id: number | null): boolean {
    if (id === null) return true;
    const cached = this.running.get(id);
    if (this.evaluating.has(id)) return cached ?? false; // self reference ("this.isRun"): previous state
    if (cached !== undefined && this.memo.has(id)) return cached;
    const c = this.containers.get(id);
    if (!c) return false;
    this.evaluating.add(id);
    const v = this.runs(c.parent) && !!evalCondition(c.cond, (n) => (n === "this.isRun" ? (this.running.get(id) ?? false) : this.resolve(n)));
    this.evaluating.delete(id);
    this.running.set(id, v);
    this.memo.add(id);
    return v;
  }

  private memo = new Set<number>();

  private evaluate() {
    this.memo.clear();
    for (const s of this.conditional) {
      const on = this.runs(s.gate) && !!evalCondition(s.cond, this.resolve);
      this.step(s, on);
    }
  }

  private step(s: CondSound, on: boolean) {
    const def = this.lib.def(s.def);
    if (!def) return;
    if (on && !s.active) {
      s.active = true;
      if (!def.loop) this.fire(s);
    } else if (!on && s.active) {
      s.active = false;
      s.voice?.stop(0.2);
      s.voice = null;
    }
    // Loops run only while the listener could hear them.
    if (def.loop && s.active) {
      const d = s.pos && !s.relative ? this.distanceM(s.pos) : 0;
      if (!s.voice && d <= def.max) this.fire(s);
      else if (s.voice && d > def.max * 1.25) {
        s.voice.stop(0.2);
        s.voice = null;
      }
    }
  }

  private fire(s: CondSound) {
    s.voice = this.play(s.def, { at: s.pos && !s.relative ? s.pos : undefined });
  }

  private listener(): Vec3 {
    return this.game.fromScene(this.game.camera.position);
  }

  private distanceM(p: Vec3) {
    const l = this.listener();
    return Math.hypot(p[0] - l[0], p[1] - l[1], p[2] - l[2]) / METRE;
  }

  // ------------------------------------------------------------------------------------------------- areas

  /** How audible an area is at the listener (0..1) and the nearest point of the box to it. */
  private probe(a: Area, l: Vec3): { gain: number; at: Vec3 } {
    const dx = (l[0] - a.c[0]) / METRE;
    const dy = (l[1] - a.c[1]) / METRE;
    const dz = (l[2] - a.c[2]) / METRE;
    const cos = Math.cos(a.yaw);
    const sin = Math.sin(a.yaw);
    // Into the box's frame (rotation about Z).
    const lx = dx * cos + dy * sin;
    const ly = -dx * sin + dy * cos;
    const hx = a.size[0] / 2;
    const hy = a.size[1] / 2;
    // The authored Z is the area's reference height; accept a generous vertical band around it.
    const hz = a.size[2] / 2 + 1.5;
    const cx = Math.max(-hx, Math.min(hx, lx));
    const cy = Math.max(-hy, Math.min(hy, ly));
    const cz = Math.max(-hz, Math.min(hz, dz));
    const out = Math.hypot(lx - cx, ly - cy, dz - cz);
    const gain = out <= 0 ? 1 : Math.max(0, 1 - out / a.fade);
    const wx = cx * cos - cy * sin;
    const wy = cx * sin + cy * cos;
    return { gain, at: [a.c[0] + wx * METRE, a.c[1] + wy * METRE, a.c[2] + cz * METRE] };
  }

  update(dt: number) {
    this.tick -= dt;
    if (this.tick <= 0) {
      this.tick = TICK;
      this.evaluate();
    }
    const l = this.listener();
    const best = new Map<string, { gain: number; at: Vec3 }>();
    for (const a of this.areas) {
      if (!a.defs.length || !this.runs(a.gate)) continue;
      const first = this.lib.def(a.defs[0]);
      if (!first) continue;
      const { gain, at } = this.probe(a, l);
      if (gain <= 0.001) {
        a.timer = -1;
        continue;
      }
      if (first.loop) {
        const b = best.get(first.name);
        if (!b || gain > b.gain) best.set(first.name, { gain, at });
        continue;
      }
      // One-shot ambience: random pick every MinDelay + random(Wait).
      if (a.timer < 0) a.timer = Math.random() * (a.minDelay + a.wait || 5);
      a.timer -= dt;
      if (a.timer <= 0) {
        a.timer = a.minDelay + Math.random() * a.wait || 5 + Math.random() * 5;
        const def = this.lib.def(a.defs[Math.floor(Math.random() * a.defs.length)]);
        if (def) this.playOneShot(a, def, gain, l);
      }
    }
    // Looping ambience: one voice per sound (the loudest area), so overlapping areas do not stack.
    for (const [name, b] of best) {
      const have = this.loops.get(name);
      if (have?.voice.playing) {
        have.voice.setPosition(b.at);
        have.voice.setVolume(b.gain);
      } else {
        const voice = this.play(name, { at: b.at, range: Infinity, volume: b.gain, bus: "ambience", fadeIn: 0.8 });
        if (voice) this.loops.set(name, { voice, gain: b.gain });
      }
    }
    for (const [name, v] of this.loops) {
      if (!best.has(name)) {
        v.voice.stop(0.8);
        this.loops.delete(name);
      }
    }
  }

  private playOneShot(a: Area, def: SoundDef, gain: number, l: Vec3) {
    // Somewhere the player can hear it: a quarter to nine tenths of the sound's range out (at most 150 m) in a random
    // direction, kept inside the box.
    const ang = Math.random() * Math.PI * 2;
    const dist = Math.min(150, (0.25 + Math.random() * 0.65) * def.max) * METRE;
    const sky = /plane|heli|thunder/.test(def.name) ? 40 * METRE : 0;
    const target: Vec3 = [l[0] + Math.cos(ang) * dist, l[1] + Math.sin(ang) * dist, l[2] + sky];
    const { at } = this.probe({ ...a, fade: 1 }, target);
    this.play(def.name, { at, volume: gain, bus: "ambience" });
  }

  /** State of every sound task, for debugging. */
  describe() {
    const l = this.listener();
    return {
      areas: this.areas.map((a) => ({ name: a.name, defs: a.defs.join(" "), running: this.runs(a.gate), gain: +this.probe(a, l).gain.toFixed(2) })),
      conditional: this.conditional.map((s) => ({ name: s.name, def: s.def, cond: s.cond, gateRunning: this.runs(s.gate), active: s.active, playing: !!s.voice?.playing })),
      containers: [...this.containers.values()].map((c) => ({ id: c.id, cond: c.cond, running: this.runs(c.id) })),
    };
  }

  dispose() {
    for (const o of this.off) o();
    for (const l of this.loops.values()) l.voice.stop(0);
    for (const s of this.conditional) s.voice?.stop(0);
    this.loops.clear();
  }
}
