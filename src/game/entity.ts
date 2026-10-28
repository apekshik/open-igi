// Entities: anything with a position that can be hit, seen or interacted with (the player, soldiers, doors, pickups).
// Systems own their entities' behaviour; the registry just makes them findable (hit tests, AI targeting, the map).

import type * as THREE from "three";
import type { Vec3 } from "./coords.ts";

export interface Entity {
  readonly id: number;
  /** "player", "soldier", "civilian", "pickup", "door", ... */
  kind: string;
  /** Feet position in IGI world units. */
  position: Vec3;
  /** Heading about Z in radians (see coords.direction). */
  yaw: number;
  health: number;
  maxHealth: number;
  /** 0 = player's side; other values are enemy/neutral teams as in the level script. */
  team: number;
  alive: boolean;
  /** Collision/hit volume: a vertical capsule from the feet, in world units. */
  radius: number;
  height: number;
  /** The rendered object, a child of Game.world. */
  object?: THREE.Object3D;
  /** The objects.qvm task id this entity came from, if any (missions refer to tasks by id). */
  taskId?: number;
}

export class EntityRegistry {
  private nextId = 1;
  private byId = new Map<number, Entity>();

  create<T extends Omit<Entity, "id">>(fields: T): T & Entity {
    const e = { ...fields, id: this.nextId++ } as T & Entity;
    this.byId.set(e.id, e);
    return e;
  }

  /** Register an object that already carries its own id-less fields (keeps class instances intact). */
  adopt<T extends object>(entity: T & Omit<Entity, "id">): T & Entity {
    (entity as unknown as { id: number }).id = this.nextId++;
    this.byId.set((entity as unknown as Entity).id, entity as unknown as Entity);
    return entity as T & Entity;
  }

  remove(id: number) {
    this.byId.delete(id);
  }

  get(id: number): Entity | undefined {
    return this.byId.get(id);
  }

  all(): Entity[] {
    return [...this.byId.values()];
  }

  byTask(taskId: number): Entity | undefined {
    for (const e of this.byId.values()) if (e.taskId === taskId) return e;
    return undefined;
  }
}
