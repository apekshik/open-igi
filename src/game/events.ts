// Typed game-wide event bus. Systems talk to each other through events and services, never by importing each
// other's internals.
//
// To add events from your own system without editing this file, augment the map from your module:
//   declare module "../events.ts" { interface GameEvents { "door:open": { id: number } } }

import type { Vec3 } from "./coords.ts";

export interface GameEvents {
  /** The level, terrain and static world are loaded and the first frame is about to run. */
  "level:loaded": { level: string };
  /** Something took damage. `part` is a body region when known ("head", "torso", "legs"). */
  damage: { targetId: number; amount: number; sourceId: number | null; point: Vec3; direction: Vec3; part?: string };
  death: { entityId: number; killerId: number | null };
  /** A shot was fired (for AI hearing, audio, effects). */
  "weapon:fire": { ownerId: number; weapon: string; origin: Vec3; direction: Vec3; silenced: boolean };
  /** A sound that AI can hear: gunshots, explosions, footsteps, doors. Radius in world units. */
  noise: { position: Vec3; radius: number; sourceId: number | null; kind: string };
  alarm: { active: boolean; sourceId: number | null };
  objective: { index: number; state: "active" | "completed" | "failed"; text?: string };
  "mission:end": { success: boolean; reason: string };
  /** Short on-screen text (HUD shows it). */
  message: { text: string; seconds?: number };
  pickup: { ownerId: number; item: string; amount: number };
}

type Handler<T> = (payload: T) => void;

export class EventBus {
  private handlers = new Map<keyof GameEvents, Set<Handler<never>>>();

  on<K extends keyof GameEvents>(type: K, handler: Handler<GameEvents[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(handler as Handler<never>);
    return () => set!.delete(handler as Handler<never>);
  }

  emit<K extends keyof GameEvents>(type: K, payload: GameEvents[K]) {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const h of [...set]) (h as Handler<GameEvents[K]>)(payload);
  }
}
