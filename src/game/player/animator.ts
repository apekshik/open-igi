// Clip playback for IGI's skeletal animations (common/anims/NNN.iff), shared by the player's movement logic and the
// visible skinned body. IGI drives humans from their animations: the root bone's motion moves the body, the pelvis
// height sets the eye, and footstep events in the clips make the sounds. A ClipPlayer holds the playing clip and the
// one it is blending out of (IGI blends over 0.2 s), and answers those questions without needing a mesh.
//
// Time is in animation ticks: 4800 per second (160 per 30 Hz game tick).
import type { Animation, AnimFile } from "../../formats/anim.ts";

export const ANIM_TICKS_PER_SECOND = 4800;
/** IGI's state-change blend (0x3e4ccccd). */
export const DEFAULT_BLEND = 0.2;

export interface PlayOptions {
  /** Cross-fade time in seconds (default 0.2; 0 switches at once). */
  blend?: number;
  /** Playback rate (the jump plays at 0.4). */
  speed?: number;
  /** Start at the old clip's stride phase (fraction of its cycle) instead of 0, as IGI does between move clips. */
  keepPhase?: boolean;
}

interface Track {
  anim: Animation;
  time: number;
  speed: number;
}

/** Root position of a clip at a time (linear between keys; time clamped to the keys, not wrapped). */
export function rootAt(anim: Animation, time: number): [number, number, number] {
  const keys = anim.root;
  if (!keys.length) return [0, 0, 0];
  let i = 0;
  while (i + 1 < keys.length && keys[i + 1].time <= time) i++;
  const a = keys[i], b = keys[i + 1];
  if (!b || b.time <= a.time) return [...a.p];
  const f = Math.min(1, Math.max(0, (time - a.time) / (b.time - a.time)));
  return [a.p[0] + (b.p[0] - a.p[0]) * f, a.p[1] + (b.p[1] - a.p[1]) * f, a.p[2] + (b.p[2] - a.p[2]) * f];
}

/**
 * Average root velocity of a looping clip over one cycle, in model units per second, model axes (x right, y forward,
 * z up). Zero for clips that do not travel.
 */
export function cycleVelocity(anim: Animation): [number, number, number] {
  if (anim.duration <= 0 || anim.root.length < 2) return [0, 0, 0];
  const a = rootAt(anim, 0), b = rootAt(anim, anim.duration);
  const s = ANIM_TICKS_PER_SECOND / anim.duration;
  return [(b[0] - a[0]) * s, (b[1] - a[1]) * s, (b[2] - a[2]) * s];
}

export class ClipPlayer {
  readonly file: AnimFile;
  private byId = new Map<number, Animation>();
  private current: Track | null = null;
  private previous: Track | null = null;
  private blendTime = 0;
  private blendLength = 0;

  constructor(file: AnimFile) {
    this.file = file;
    for (const a of file.animations) this.byId.set(a.id, a);
  }

  clip(id: number): Animation | undefined {
    return this.byId.get(id);
  }

  get clipId(): number | null {
    return this.current?.anim.id ?? null;
  }

  /** Current clip time in animation ticks. */
  get time(): number {
    return this.current?.time ?? 0;
  }

  /** Whether a non-looping clip has reached its end. */
  get finished(): boolean {
    const c = this.current;
    return !!c && !looping(c.anim) && c.time >= c.anim.duration;
  }

  /** Weight of the playing clip (0..1); the rest is the clip blending out. */
  get weight(): number {
    return this.previous && this.blendLength > 0 ? Math.min(1, this.blendTime / this.blendLength) : 1;
  }

  /** Switch to a clip. Playing the clip that is already playing only updates its speed. */
  play(id: number, options: PlayOptions = {}): boolean {
    const anim = this.byId.get(id);
    if (!anim) return false;
    const speed = options.speed ?? 1;
    if (this.current?.anim === anim) {
      this.current.speed = speed;
      return true;
    }
    let time = 0;
    const old = this.current;
    if (options.keepPhase && old && old.anim.duration > 0 && looping(anim)) time = (anim.duration * old.time) / old.anim.duration;
    const blend = options.blend ?? DEFAULT_BLEND;
    this.previous = old && blend > 0 ? old : null;
    this.blendTime = 0;
    this.blendLength = blend;
    this.current = { anim, time, speed };
    return true;
  }

  /** Put the playing clip at a time (ticks): for clips driven from outside, such as the ladder climb. */
  seek(time: number) {
    if (this.current) this.current.time = Math.max(0, Math.min(this.current.anim.duration, time));
  }

  /** Advance by dt seconds, calling `onEvent(time)` for each of `events` (ticks in the playing clip) crossed. */
  advance(dt: number, events?: readonly number[], onEvent?: (time: number) => void) {
    if (this.previous) {
      this.blendTime += dt;
      step(this.previous, dt);
      if (this.blendTime >= this.blendLength) this.previous = null;
    }
    const c = this.current;
    if (!c) return;
    const before = c.time;
    const wrapped = step(c, dt);
    if (!events?.length || !onEvent) return;
    const after = c.time;
    for (const t of events) {
      const crossed = wrapped ? t > before || t <= after : t > before && t <= after;
      if (crossed) onEvent(t);
    }
  }

  /** Blended pelvis (root) height above the feet, model units. */
  rootHeight(): number {
    const c = this.current;
    if (!c) return 0;
    const z = rootAt(c.anim, c.time)[2];
    if (!this.previous) return z;
    const w = this.weight;
    return z * w + rootAt(this.previous.anim, this.previous.time)[2] * (1 - w);
  }

  /** Blended cycle velocity (model axes, units/s) of the playing clips. */
  velocity(): [number, number, number] {
    const c = this.current;
    if (!c) return [0, 0, 0];
    const v = cycleVelocity(c.anim).map((x) => x * c.speed) as [number, number, number];
    if (!this.previous) return v;
    const w = this.weight;
    const p = cycleVelocity(this.previous.anim).map((x) => x * this.previous!.speed);
    return [v[0] * w + p[0] * (1 - w), v[1] * w + p[1] * (1 - w), v[2] * w + p[2] * (1 - w)];
  }

  /** The tracks to pose: playing clip with its weight, and the clip blending out (if any). */
  tracks(): { anim: Animation; time: number; weight: number }[] {
    const out: { anim: Animation; time: number; weight: number }[] = [];
    if (!this.current) return out;
    const w = this.weight;
    out.push({ anim: this.current.anim, time: this.current.time, weight: w });
    if (this.previous && w < 1) out.push({ anim: this.previous.anim, time: this.previous.time, weight: 1 - w });
    return out;
  }
}

/** Bit 31 of the clip flags marks looping clips. */
export const looping = (anim: Animation) => (anim.flags & 0x80000000) !== 0;

/** Advance a track; returns whether a looping clip wrapped. Non-looping clips hold their last frame. */
function step(t: Track, dt: number): boolean {
  const d = t.anim.duration;
  t.time += dt * ANIM_TICKS_PER_SECOND * t.speed;
  if (d <= 0) {
    t.time = 0;
    return false;
  }
  if (!looping(t.anim)) {
    t.time = Math.min(t.time, d);
    return false;
  }
  if (t.time >= 0 && t.time < d) return false;
  t.time = ((t.time % d) + d) % d;
  return true;
}
