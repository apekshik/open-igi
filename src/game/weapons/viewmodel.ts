// First-person view model: Jones's arms (005_01_1, skinned to the 56-bone rig in common/anims/005.iff) holding the
// weapon's gun model, played with the weapon's own arm animations (StandAnim, MoveAnim, FireAnim1-3, ReloadAnim).
//
// Rig (our reading, checked against every weapon's model attachments): bone 3 carries the gun, bone 52 the part the
// left hand handles on reload (usually the magazine) and bone 55 the other moving part (bolt, slide, cylinder). In
// the stand poses their offsets from bone 3 equal the gun model's ATTA positions for those parts. The arms are drawn
// after the world with the depth buffer cleared, so the gun never pokes into walls. See docs/formats/weapons.md.
import * as THREE from "three";
import { poseBones, type AnimFile, type Animation } from "../../formats/anim.ts";
import { parseIlff } from "../../formats/ilff.ts";
import { skinMef, tagName, type MefModel } from "../../formats/mef.ts";
import type { WeaponSpec } from "../../formats/weapon.ts";
import type { ModelLibrary } from "../../render/library.ts";

/** common/anims key times run at 4800 ticks per second (keys every 160 ticks = 30 frames per second). */
export const ANIM_TICKS_PER_SECOND = 4800;
const GUN_BONE = 3;
const PART_BONES = [52, 55];
/** Draw order for the view model: after everything else, including transparent world objects. */
const VIEW_ORDER = 1_000_000;
/** Self-light of the view model as a fraction of its texture colour (see viewMaterial). */
const VIEW_SELF_LIGHT = 0.4;
const BLEND_TIME = 0.12;

/** An attachment point in a .mef (ATTA chunk): 68-byte records of name[16], vec3 position, 3x3 rotation, pad. */
export interface Attachment {
  name: string;
  position: [number, number, number];
  /** Row-major 3x3. */
  rotation: number[];
}

export function readAttachments(bytes: Uint8Array): Attachment[] {
  const chunk = parseIlff(bytes).chunks.find((c) => tagName(c.tag) === "ATTA");
  if (!chunk) return [];
  const v = new DataView(chunk.data.buffer, chunk.data.byteOffset, chunk.length);
  const out: Attachment[] = [];
  for (let o = 0; o + 68 <= chunk.length; o += 68) {
    let name = "";
    for (let i = 0; i < 16 && chunk.data[o + i]; i++) name += String.fromCharCode(chunk.data[o + i]);
    const f = (k: number) => v.getFloat32(o + 16 + k * 4, true);
    out.push({ name, position: [f(0), f(1), f(2)], rotation: [3, 4, 5, 6, 7, 8, 9, 10, 11].map(f) });
  }
  return out;
}

/** Muzzle flash models are named 1000_* to 1013_*. */
export const isFlashModel = (name: string) => /^10\d\d_/.test(name);

function boneMatrix(bones: Float32Array, bone: number, out = new THREE.Matrix4()): THREE.Matrix4 {
  const b = bone * 12;
  return out.set(bones[b], bones[b + 1], bones[b + 2], bones[b + 9], bones[b + 3], bones[b + 4], bones[b + 5], bones[b + 10], bones[b + 6], bones[b + 7], bones[b + 8], bones[b + 11], 0, 0, 0, 1);
}

function attachmentMatrix(a: Attachment): THREE.Matrix4 {
  const r = a.rotation;
  return new THREE.Matrix4().set(r[0], r[1], r[2], a.position[0], r[3], r[4], r[5], a.position[1], r[6], r[7], r[8], a.position[2], 0, 0, 0, 1);
}

/** Blend two bone arrays (12 floats per bone): slerp rotations, lerp translations. */
function blendBones(a: Float32Array, b: Float32Array, f: number, out: Float32Array) {
  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), m = new THREE.Matrix4();
  for (let i = 0; i < a.length; i += 12) {
    qa.setFromRotationMatrix(boneMatrix(a, i / 12, m));
    qb.setFromRotationMatrix(boneMatrix(b, i / 12, m));
    qa.slerp(qb, f);
    m.makeRotationFromQuaternion(qa);
    const e = m.elements; // column-major
    out[i] = e[0]; out[i + 1] = e[4]; out[i + 2] = e[8];
    out[i + 3] = e[1]; out[i + 4] = e[5]; out[i + 5] = e[9];
    out[i + 6] = e[2]; out[i + 7] = e[6]; out[i + 8] = e[10];
    for (let k = 9; k < 12; k++) out[i + k] = a[i + k] + (b[i + k] - a[i + k]) * f;
  }
}

/** Material copies for the view model: drawn last, in the transparent pass, after a depth clear. */
function viewMaterial(m: THREE.Material): THREE.Material {
  const c = m.clone();
  // The arms and gun sit at the eye, so the world's sun often lights them from behind and they turn into a black
  // silhouette. Give them a floor of their own texture as self-light, like IGI's evenly lit first-person weapons.
  if (c instanceof THREE.MeshLambertMaterial && c.map) {
    c.emissiveMap = c.map;
    c.emissive.setScalar(VIEW_SELF_LIGHT);
  }
  c.transparent = true;
  c.depthWrite = true;
  c.side = THREE.FrontSide;
  return c;
}

function flashMaterial(m: THREE.Material): THREE.Material {
  const map = (m as THREE.MeshLambertMaterial).map ?? null;
  return new THREE.MeshBasicMaterial({ map, color: map ? 0xffffff : 0xffcc66, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
}

interface Track {
  anim: Animation;
  time: number;
  loop: boolean;
  speed: number;
}

interface Part {
  object: THREE.Object3D;
  bone: number;
}

export interface ViewModelInput {
  moving: boolean;
  /** Mouse look this frame (radians), for sway. */
  lookYaw: number;
  lookPitch: number;
}

export class ViewModel {
  /** Added to the scene; follows the camera. */
  readonly root = new THREE.Group();
  /** IGI view space (X right, Y forward, Z up) → camera space. */
  private holder = new THREE.Group();
  private gunGroup = new THREE.Group();
  private library: ModelLibrary;
  private anims: AnimFile | null;
  private armsModel: MefModel | null = null;
  private armsGeometry: THREE.BufferGeometry | null = null;
  private armsMesh: THREE.Mesh | null = null;
  private parts: Part[] = [];
  private flashes: THREE.Object3D[] = [];
  private flashTimer = 0;
  private track: Track | null = null;
  private previous: { bones: Float32Array; weight: number } | null = null;
  private idle: { stand: Animation | null; move: Animation | null } = { stand: null, move: null };
  private onEnd: (() => void) | null = null;
  private bones: Float32Array | null = null;
  private sway = new THREE.Vector2();
  private kick = 0;
  private kickVelocity = 0;
  /** 0 = fully raised, 1 = lowered out of view (weapon switching). */
  lowered = 1;
  private lowerTarget = 1;
  private lowerSpeed = 4;
  /** Hide the whole view model (binoculars, sniper scope). */
  hidden = false;
  private weapon: WeaponSpec | null = null;
  private modelBytes: (name: string) => Uint8Array | undefined;

  constructor(library: ModelLibrary, anims: AnimFile | null, modelBytes: (name: string) => Uint8Array | undefined) {
    this.library = library;
    this.anims = anims;
    this.modelBytes = modelBytes;
    this.root.matrixAutoUpdate = false;
    this.holder.rotation.x = -Math.PI / 2;
    this.root.add(this.holder);
    this.holder.add(this.gunGroup);
    this.root.add(depthClearer());
    this.buildArms();
  }

  private buildArms() {
    const built = this.library.build("005_01_1");
    const model = built?.skin?.model ?? null;
    if (!built || !model || !this.anims) return;
    this.armsModel = model;
    const g = built.geometry.clone();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(model.vertexCount * 3), 3));
    g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(model.vertexCount * 3), 3));
    this.armsGeometry = g;
    this.armsMesh = new THREE.Mesh(g, built.materials.map(viewMaterial));
    this.armsMesh.frustumCulled = false;
    this.armsMesh.renderOrder = VIEW_ORDER;
    this.holder.add(this.armsMesh);
  }

  /** Show a weapon (or nothing). Parts are the gun model plus the sub-models its ATTA chunk places. */
  setWeapon(spec: WeaponSpec | null) {
    this.weapon = spec;
    for (const p of this.parts) this.gunGroup.remove(p.object);
    this.parts = [];
    this.flashes = [];
    this.track = null;
    this.previous = null;
    this.idle = { stand: this.anim(spec?.anims.stand), move: this.anim(spec?.anims.move) };
    if (!spec) return;
    const models = spec.id === "WEAPON_ID_UZIX2" ? [spec.model, spec.model.replace(/_04_/, "_05_")] : [spec.model];
    // Stand pose: decides which bone (52 or 55) each attached part follows.
    const stand = this.anims ? poseBones(this.anims.skeleton, this.idle.stand ?? undefined, 0) : null;
    models.forEach((name, gunIndex) => {
      const main = this.mesh(name);
      if (!main) return;
      // Dual Uzis: the left gun rides bone 52 (the other hand); one gun per hand.
      const bone = gunIndex === 0 ? GUN_BONE : 52;
      this.parts.push({ object: main, bone });
      const bytes = this.modelBytes(name);
      for (const a of bytes ? readAttachments(bytes) : []) {
        if (models.includes(a.name)) continue;
        const sub = this.mesh(a.name, isFlashModel(a.name));
        if (!sub) continue;
        const local = attachmentMatrix(a);
        if (isFlashModel(a.name)) {
          // Flashes stay on the gun, at the muzzle.
          sub.matrix.copy(local);
          sub.matrixAutoUpdate = false;
          sub.visible = false;
          main.add(sub);
          this.flashes.push(sub);
          continue;
        }
        // Moving parts follow bone 52 or 55, whichever sits at this attachment in the stand pose.
        let partBone = -1;
        if (stand && gunIndex === 0) {
          const gun = boneMatrix(stand, GUN_BONE).invert();
          let best = 120;
          for (const b of PART_BONES) {
            const at = new THREE.Vector3().setFromMatrixPosition(boneMatrix(stand, b)).applyMatrix4(gun);
            const d = at.distanceTo(new THREE.Vector3(...a.position));
            if (d < best) [best, partBone] = [d, b];
          }
        }
        if (partBone >= 0) this.parts.push({ object: sub, bone: partBone });
        else {
          sub.matrix.copy(local);
          sub.matrixAutoUpdate = false;
          main.add(sub);
        }
      }
    });
    for (const p of this.parts) {
      p.object.matrixAutoUpdate = false;
      this.gunGroup.add(p.object);
    }
    this.playIdle(false);
  }

  private mesh(name: string, flash = false): THREE.Mesh | null {
    const built = this.library.build(name);
    if (!built) return null;
    const m = new THREE.Mesh(built.geometry, built.materials.map(flash ? flashMaterial : viewMaterial));
    m.frustumCulled = false;
    m.renderOrder = VIEW_ORDER + (flash ? 1 : 0);
    return m;
  }

  private anim(id: number | undefined): Animation | null {
    if (id === undefined || id < 0 || !this.anims) return null;
    return this.anims.animations.find((a) => a.id === id) ?? null;
  }

  /** Length of an arm animation in seconds (0 if missing). */
  duration(id: number): number {
    const a = this.anim(id);
    return a ? a.duration / ANIM_TICKS_PER_SECOND : 0;
  }

  /** Play an arm animation once (or looped), cross-fading from the current pose. False if the weapon has no such animation. */
  play(id: number, options: { loop?: boolean; speed?: number; onEnd?: () => void } = {}): boolean {
    const anim = this.anim(id);
    // Missing animation: the caller carries on without it (onEnd is not called).
    if (!anim) return false;
    this.start(anim, options.loop ?? false, options.speed ?? 1);
    this.onEnd = options.onEnd ?? null;
    return true;
  }

  private start(anim: Animation, loop: boolean, speed: number) {
    if (this.bones && this.track?.anim !== anim) this.previous = { bones: this.bones.slice(), weight: 1 };
    this.track = { anim, time: 0, loop, speed };
  }

  private playIdle(moving: boolean) {
    const a = (moving ? this.idle.move : null) ?? this.idle.stand;
    if (a && this.track?.anim !== a) this.start(a, true, 1);
    this.onEnd = null;
  }

  /** Is a one-shot animation (fire, reload) still playing? */
  get busy(): boolean {
    return !!this.track && !this.track.loop;
  }

  muzzleFlash() {
    if (!this.flashes.length) return;
    this.flashTimer = 0.05;
    for (const f of this.flashes) {
      f.visible = true;
      // Random roll about the barrel (Y).
      const keep = f.matrix.clone();
      f.userData.base ??= keep;
      f.matrix.copy(f.userData.base as THREE.Matrix4).multiply(new THREE.Matrix4().makeRotationY(Math.random() * Math.PI * 2));
    }
  }

  /** Recoil impulse (scaled by the weapon's view kick). */
  fireKick(strength: number) {
    this.kickVelocity += strength;
  }

  /** Lower the weapon out of view, or raise it. */
  lower(down: boolean, seconds = 0.25) {
    this.lowerTarget = down ? 1 : 0;
    this.lowerSpeed = 1 / Math.max(0.01, seconds);
  }

  /** World position of the muzzle (three.js scene space), for tracers and flashes; falls back to the camera. */
  muzzleWorld(camera: THREE.Camera, out = new THREE.Vector3()): THREE.Vector3 {
    const f = this.flashes[0];
    if (f && !this.hidden && this.lowered < 0.5) {
      f.updateWorldMatrix(true, false);
      return out.setFromMatrixPosition(f.matrixWorld);
    }
    // About 30 cm ahead, 10 cm right and down of the eye.
    return out.set(0.1, -0.1, -0.3).multiplyScalar(4096).applyMatrix4(camera.matrixWorld);
  }

  update(dt: number, camera: THREE.Camera, input: ViewModelInput) {
    this.root.matrix.copy(camera.matrixWorld);
    this.root.matrixWorldNeedsUpdate = true;
    this.root.visible = !this.hidden && !!this.weapon && this.lowered < 0.999;

    // Animation.
    const t = this.track;
    if (t) {
      t.time += dt * t.speed * ANIM_TICKS_PER_SECOND;
      if (!t.loop && t.time >= t.anim.duration) {
        const done = this.onEnd;
        this.onEnd = null;
        this.playIdle(input.moving);
        done?.();
      } else if (t.loop) {
        const want = (input.moving ? this.idle.move : null) ?? this.idle.stand;
        if (want && t.anim !== want) this.playIdle(input.moving);
      }
    }
    if (this.anims && this.track) {
      const tr = this.track;
      let bones = poseBones(this.anims.skeleton, tr.anim, tr.loop ? tr.time : Math.min(tr.time, tr.anim.duration - 1));
      if (this.previous) {
        this.previous.weight -= dt / BLEND_TIME;
        if (this.previous.weight <= 0) this.previous = null;
        else {
          const out = new Float32Array(bones.length);
          blendBones(bones, this.previous.bones, this.previous.weight, out);
          bones = out;
        }
      }
      this.bones = bones;
      if (this.armsModel && this.armsGeometry && this.root.visible) {
        const skinned = skinMef(this.armsModel, bones);
        (this.armsGeometry.attributes.position.array as Float32Array).set(skinned.positions);
        (this.armsGeometry.attributes.normal.array as Float32Array).set(skinned.normals);
        this.armsGeometry.attributes.position.needsUpdate = true;
        this.armsGeometry.attributes.normal.needsUpdate = true;
      }
      for (const p of this.parts) boneMatrix(bones, p.bone, p.object.matrix);
    }

    // Muzzle flash.
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) for (const f of this.flashes) f.visible = false;
    }

    // Procedural motion on top of the animation: sway behind the mouse, recoil spring, raise/lower.
    this.sway.x += (-input.lookYaw * 0.6 - this.sway.x) * Math.min(1, dt * 10);
    this.sway.y += (-input.lookPitch * 0.6 - this.sway.y) * Math.min(1, dt * 10);
    this.sway.clampScalar(-0.06, 0.06);
    this.kickVelocity += (-this.kick * 300 - this.kickVelocity * 24) * dt;
    this.kick += this.kickVelocity * dt;
    this.lowered += Math.sign(this.lowerTarget - this.lowered) * Math.min(Math.abs(this.lowerTarget - this.lowered), dt * this.lowerSpeed);
    const drop = this.lowered * this.lowered;
    this.holder.position.set(this.sway.x * 1500, -this.kick * 150 - drop * 2500, this.kick * 60);
    this.holder.rotation.set(-Math.PI / 2 + this.sway.y + this.kick * 0.08 - drop * 0.6, this.sway.x * 0.5, 0);
  }
}

/** Clears the depth buffer just before the view model draws (lowest render order of the view model's batch). */
function depthClearer(): THREE.Object3D {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthTest: false, depthWrite: false, colorWrite: false }));
  m.frustumCulled = false;
  m.renderOrder = VIEW_ORDER - 1;
  m.onBeforeRender = (renderer) => renderer.clearDepth();
  return m;
}

