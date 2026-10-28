// Thrown and launched weapons: hand grenades and flashbangs (bouncing, timed fuse), proximity mines (arm, sense,
// count down) and LAW 80 / vehicle missiles (straight flight, explode on contact).
import * as THREE from "three";
import { METRE, vec3, type Vec3 } from "../coords.ts";
import type { Game } from "../game.ts";

const GRAVITY = 9.81 * METRE;
/** Seconds from throw to explosion for hand grenades and flashbangs (not in the data; IGI's feel). */
export const GRENADE_FUSE = 3;

export interface ProjectileHooks {
  explode(p: Projectile): void;
  bounce(p: Projectile): void;
  /** Proximity mines: is anyone in range? */
  sense(p: Projectile): boolean;
  arm(p: Projectile): void;
}

export interface Projectile {
  kind: "grenade" | "flashbang" | "mine" | "missile";
  weapon: string;
  ownerId: number | null;
  position: Vec3;
  velocity: Vec3;
  /** Seconds until it goes off (grenades), or until armed / detonation (mines). */
  timer: number;
  state: "flying" | "resting" | "arming" | "armed" | "triggered";
  object: THREE.Object3D;
  /** Mines: activation radius in world units. */
  activateRadius?: number;
  bounces: number;
}

export class Projectiles {
  private game: Game;
  private hooks: ProjectileHooks;
  readonly list: Projectile[] = [];

  constructor(game: Game, hooks: ProjectileHooks) {
    this.game = game;
    this.hooks = hooks;
  }

  add(p: Projectile) {
    this.list.push(p);
    p.object.position.copy(this.game.local(p.position));
    this.game.world.add(p.object);
  }

  private remove(p: Projectile) {
    this.game.world.remove(p.object);
    this.list.splice(this.list.indexOf(p), 1);
  }

  update(dt: number) {
    const physics = this.game.services.physics;
    for (const p of [...this.list]) {
      if (p.kind === "mine") {
        this.updateMine(p, dt);
        continue;
      }
      if (p.kind === "grenade" || p.kind === "flashbang") {
        p.timer -= dt;
        if (p.timer <= 0) {
          this.remove(p);
          this.hooks.explode(p);
          continue;
        }
      }
      if (p.state === "resting") continue;
      if (p.kind !== "missile") p.velocity[2] -= GRAVITY * dt;
      const next = vec3.add(p.position, vec3.scale(p.velocity, dt));
      const hit = physics?.raycast(p.position, next, { ignoreEntity: p.ownerId ?? undefined, entities: p.kind === "missile" });
      if (hit) {
        if (p.kind === "missile") {
          p.position = hit.point;
          this.remove(p);
          this.hooks.explode(p);
          continue;
        }
        // Bounce: reflect about the surface normal, lose most of the speed.
        const n = hit.normal;
        const vn = vec3.dot(p.velocity, n);
        p.velocity = vec3.scale(vec3.sub(p.velocity, vec3.scale(n, 2 * vn)), 0.35);
        p.position = vec3.add(hit.point, vec3.scale(n, 0.03 * METRE));
        if (Math.abs(vn) > 1.5 * METRE) this.hooks.bounce(p);
        p.bounces++;
        if (vec3.length(p.velocity) < 0.6 * METRE && n[2] > 0.5) {
          p.state = "resting";
          p.velocity = [0, 0, 0];
        }
      } else {
        p.position = next;
        if (p.kind === "missile" && (p.timer -= dt) <= 0) {
          this.remove(p);
          this.hooks.explode(p);
          continue;
        }
      }
      p.object.position.copy(this.game.local(p.position));
      if (p.kind === "missile") {
        // Nose (+Y in the model) along the flight direction.
        const d = vec3.normalize(p.velocity);
        p.object.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...d));
      } else {
        p.object.rotation.x += dt * 8;
        p.object.rotation.z += dt * 5;
      }
    }
  }

  private updateMine(p: Projectile, dt: number) {
    p.timer -= dt;
    if (p.state === "arming" && p.timer <= 0) {
      p.state = "armed";
      this.hooks.arm(p);
    } else if (p.state === "armed" && this.hooks.sense(p)) {
      p.state = "triggered";
      p.timer = (p.object.userData.countdown as number) ?? 0.5;
    } else if (p.state === "triggered" && p.timer <= 0) {
      this.remove(p);
      this.hooks.explode(p);
    }
  }
}
