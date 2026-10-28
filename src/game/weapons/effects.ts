// Shot effects in the world: bullet holes, dust and blood puffs, tracers, muzzle flashes of other shooters and
// explosions. Everything lives in Game.world (IGI space, origin-relative) and is pooled.
import * as THREE from "three";
import { METRE, type Vec3 } from "../coords.ts";
import type { Game } from "../game.ts";
import { spriteTexture, type Sprite } from "./sprite.ts";

const MAX_DECALS = 96;
const DECAL_SIZE = 0.11 * METRE;

interface Particle {
  sprite: THREE.Sprite;
  life: number;
  age: number;
  velocity: Vec3;
  grow: number;
  fade: number;
}

export class Effects {
  private game: Game;
  private group = new THREE.Group();
  private decals: THREE.Mesh[] = [];
  private nextDecal = 0;
  private particles: Particle[] = [];
  private tracers: { line: THREE.Line; life: number }[] = [];
  private lights: { light: THREE.PointLight; life: number }[] = [];
  private smoke: THREE.Texture | null;
  private fire: THREE.Texture | null;
  private decalMaterial: THREE.MeshBasicMaterial;
  private bloodDecal: THREE.MeshBasicMaterial;

  constructor(game: Game, sprites: Map<string, Sprite>) {
    this.game = game;
    game.world.add(this.group);
    const s = sprites.get("smoke1") ?? sprites.get("smoke2");
    const f = sprites.get("fireball");
    this.smoke = s ? spriteTexture(s) : null;
    this.fire = f ? spriteTexture(f) : null;
    this.decalMaterial = new THREE.MeshBasicMaterial({ map: holeTexture(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
    this.bloodDecal = new THREE.MeshBasicMaterial({ map: holeTexture("#5a0000"), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
  }

  /** A bullet hit: a hole and a dust puff on geometry, a blood puff on characters. */
  impact(point: Vec3, normal: Vec3, flesh: boolean) {
    const n = new THREE.Vector3(...normal);
    if (n.lengthSq() < 1e-6) n.set(0, 0, 1);
    n.normalize();
    if (!flesh) this.decal(point, n, this.decalMaterial, DECAL_SIZE * (0.7 + Math.random() * 0.6));
    const color = flesh ? 0x8a1010 : 0xb0a590;
    const out: Vec3 = [n.x, n.y, n.z];
    for (let i = 0; i < (flesh ? 3 : 2); i++) {
      const v: Vec3 = [
        out[0] * 0.6 + (Math.random() - 0.5) * 0.5,
        out[1] * 0.6 + (Math.random() - 0.5) * 0.5,
        out[2] * 0.6 + (Math.random() - 0.5) * 0.5 + 0.2,
      ];
      this.puff(point, v, this.smoke, color, 0.12 * METRE, 0.6 * METRE, 0.4 + Math.random() * 0.3, flesh ? 1 : 0.8);
    }
    if (!flesh && Math.random() < 0.5) this.spark(point, out);
  }

  private decal(point: Vec3, n: THREE.Vector3, material: THREE.Material, size: number) {
    let m = this.decals[this.nextDecal];
    if (!m) {
      m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
      m.renderOrder = 1;
      this.decals[this.nextDecal] = m;
      this.group.add(m);
    }
    m.material = material;
    m.scale.setScalar(size);
    m.position.copy(this.game.local(point)).addScaledVector(n, 0.004 * METRE);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    m.rotateZ(Math.random() * Math.PI * 2);
    this.nextDecal = (this.nextDecal + 1) % MAX_DECALS;
  }

  private spark(point: Vec3, n: Vec3) {
    const s = this.puff(point, n, this.fire, 0xffd080, 0.05 * METRE, 0, 0.06, 1);
    (s.material as THREE.SpriteMaterial).blending = THREE.AdditiveBlending;
  }

  private puff(point: Vec3, velocity: Vec3, map: THREE.Texture | null, color: number, size: number, grow: number, life: number, opacity: number) {
    const material = new THREE.SpriteMaterial({ map, color, transparent: true, opacity, depthWrite: false });
    const sprite = new THREE.Sprite(material);
    sprite.position.copy(this.game.local(point));
    sprite.scale.setScalar(size);
    material.rotation = Math.random() * Math.PI * 2;
    this.group.add(sprite);
    this.particles.push({ sprite, life, age: 0, velocity: [velocity[0] * METRE, velocity[1] * METRE, velocity[2] * METRE], grow, fade: opacity });
    return sprite;
  }

  /** A short bright streak from the muzzle to the hit point (scene-space muzzle allowed via `fromScene`). */
  tracer(from: Vec3, to: Vec3) {
    const g = new THREE.BufferGeometry().setFromPoints([this.game.local(from), this.game.local(to)]);
    const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffe0a0, transparent: true, opacity: 0.55, depthWrite: false }));
    this.group.add(line);
    this.tracers.push({ line, life: 0.04 });
  }

  /** A flash of light at a muzzle or explosion. */
  light(at: Vec3, color: number, intensity: number, distance: number, life: number) {
    // Reuse lights: adding and removing lights recompiles materials in three.js.
    let slot = this.lights.find((l) => l.life <= 0);
    if (!slot) {
      if (this.lights.length >= 4) slot = this.lights.reduce((a, b) => (a.life < b.life ? a : b));
      else {
        const light = new THREE.PointLight(color, 0, distance, 0);
        this.group.add(light);
        slot = { light, life: 0 };
        this.lights.push(slot);
      }
    }
    slot.light.color.setHex(color);
    slot.light.intensity = intensity;
    slot.light.distance = distance;
    slot.light.position.copy(this.game.local(at));
    slot.light.userData.peak = intensity;
    slot.light.userData.span = life;
    slot.life = life;
  }

  /** Another shooter's muzzle flash: a brief light and a flare sprite. */
  muzzle(at: Vec3) {
    this.light(at, 0xffc070, 3, 6 * METRE, 0.06);
    const s = this.puff(at, [0, 0, 0], this.fire, 0xffd090, 0.35 * METRE, 0, 0.05, 1);
    (s.material as THREE.SpriteMaterial).blending = THREE.AdditiveBlending;
  }

  explosion(at: Vec3, radius: number, flash: boolean) {
    this.light(at, flash ? 0xffffff : 0xffa040, flash ? 40 : 25, radius * 3, 0.35);
    if (flash) {
      const s = this.puff(at, [0, 0, 0], this.fire, 0xffffff, radius * 0.4, radius * 2, 0.25, 1);
      (s.material as THREE.SpriteMaterial).blending = THREE.AdditiveBlending;
      return;
    }
    for (let i = 0; i < 6; i++) {
      const v: Vec3 = [(Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4, Math.random() * 3];
      const s = this.puff(at, v, this.fire, 0xffffff, radius * 0.25, radius * 0.6, 0.35 + Math.random() * 0.2, 1);
      (s.material as THREE.SpriteMaterial).blending = THREE.AdditiveBlending;
    }
    for (let i = 0; i < 8; i++) {
      const v: Vec3 = [(Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3, 0.5 + Math.random() * 2];
      this.puff(at, v, this.smoke, 0x403830, radius * 0.3, radius * 0.5, 1.6 + Math.random() * 1.2, 0.8);
    }
    const down = new THREE.Vector3(0, 0, 1);
    this.decal([at[0], at[1], at[2] + 0.05 * METRE], down, this.decalMaterial, radius * 0.35);
  }

  /** Blood on the ground under a hit character. */
  blood(point: Vec3, ground: number | null) {
    if (ground === null || point[2] - ground > 2 * METRE) return;
    this.decal([point[0], point[1], ground], new THREE.Vector3(0, 0, 1), this.bloodDecal, (0.2 + Math.random() * 0.2) * METRE);
  }

  update(dt: number) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.age += dt;
      const f = p.age / p.life;
      if (f >= 1) {
        this.group.remove(p.sprite);
        p.sprite.material.dispose();
        this.particles.splice(i, 1);
        continue;
      }
      p.sprite.position.x += p.velocity[0] * dt;
      p.sprite.position.y += p.velocity[1] * dt;
      p.sprite.position.z += p.velocity[2] * dt;
      p.velocity = [p.velocity[0] * (1 - dt * 2), p.velocity[1] * (1 - dt * 2), p.velocity[2] * (1 - dt * 2)];
      p.sprite.scale.setScalar(p.sprite.scale.x + p.grow * dt);
      p.sprite.material.opacity = p.fade * (1 - f);
    }
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.life -= dt;
      if (t.life <= 0) {
        this.group.remove(t.line);
        t.line.geometry.dispose();
        (t.line.material as THREE.Material).dispose();
        this.tracers.splice(i, 1);
      }
    }
    for (const l of this.lights) {
      if (l.life <= 0) continue;
      l.life -= dt;
      l.light.intensity = l.life > 0 ? (l.light.userData.peak as number) * (l.life / (l.light.userData.span as number)) : 0;
    }
  }
}

/** A soft dark bullet hole drawn on a canvas. */
function holeTexture(core = "#0a0806"): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  g.addColorStop(0, core);
  g.addColorStop(0.3, core);
  g.addColorStop(0.45, "rgba(40,34,28,0.7)");
  g.addColorStop(1, "rgba(60,50,40,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 32, 32);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
