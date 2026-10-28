// A soldier's visible body, skinned on the GPU: a three.js SkinnedMesh whose bones are IGI's skeleton
// (common/anims/<hierarchy>.iff) and whose clips play through the player's ClipPlayer. Dozens of soldiers then cost a
// few dozen quaternion slerps each per frame instead of re-skinning every vertex on the CPU (player/body.ts does that
// for the single player body).
//
// IGI stores skinned (type 1) vertices bone-relative, one influence record per (vertex, bone), and every bind-pose
// rotation is identity. So a vertex's bind position is the same from all of its records (skinFitError measures
// exactly that), and with bone inverse-bind matrices of pure translations the standard skinning sum reproduces
// IGI's: sum_i w_i (R_b p_i + T_b).
import * as THREE from "three";
import type { Animation, AnimFile, RotationKey } from "../../formats/anim.ts";
import { poseBones } from "../../formats/anim.ts";
import { skinFitError, skinMef, type MefModel } from "../../formats/mef.ts";
import type { BuiltModel, ModelLibrary } from "../../render/library.ts";
import { ClipPlayer, looping, rootAt } from "../player/animator.ts";

interface Rig {
  geometry: THREE.BufferGeometry;
  materials: THREE.Material[];
  anims: AnimFile;
  /** Bind-pose position of every bone in model space. */
  bindWorld: Float32Array;
}

const rigs = new WeakMap<ModelLibrary, Map<string, Rig | null>>();

/** Geometry (with skin indices/weights) shared by every body of one model on one skeleton. */
function rig(library: ModelLibrary, model: string, hierarchy: number): Rig | null {
  let cache = rigs.get(library);
  if (!cache) rigs.set(library, (cache = new Map()));
  const key = `${model}/${hierarchy}`;
  if (cache.has(key)) return cache.get(key)!;
  const built = library.build(model);
  const result = built?.skin ? buildRig(built, built.skin.model, pickSkeleton(library, built, hierarchy)) : null;
  cache.set(key, result);
  return result;
}

/** The skeleton the placement asks for, unless the model does not fit it (then the library's best fit). */
function pickSkeleton(library: ModelLibrary, built: BuiltModel, hierarchy: number): AnimFile {
  const wanted = library.animFiles.find((f) => f.skeleton.hierarchy === hierarchy);
  if (wanted && Number.isFinite(skinFitError(built.skin!.model, wanted.skeleton))) return wanted;
  return built.skin!.anims;
}

function buildRig(built: BuiltModel, model: MefModel, anims: AnimFile): Rig {
  const skin = model.skin!;
  const skeleton = anims.skeleton;
  const n = skin.renderCount;
  const bind = skinMef(model, poseBones(skeleton));
  // Up to four strongest influences per render vertex.
  const influences: { bone: number; weight: number }[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < model.vertexCount; i++) influences[skin.target[i]].push({ bone: skin.bone[i], weight: skin.weight[i] });
  const index = new Uint16Array(n * 4);
  const weight = new Float32Array(n * 4);
  for (let v = 0; v < n; v++) {
    const list = influences[v].sort((a, b) => b.weight - a.weight).slice(0, 4);
    const total = list.reduce((s, x) => s + x.weight, 0) || 1;
    list.forEach((x, k) => {
      index[v * 4 + k] = x.bone;
      weight[v * 4 + k] = x.weight / total;
    });
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(bind.positions.slice(0, n * 3), 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(bind.normals.slice(0, n * 3), 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(model.uvs.slice(0, n * 2), 2));
  geometry.setAttribute("skinIndex", new THREE.BufferAttribute(index, 4));
  geometry.setAttribute("skinWeight", new THREE.BufferAttribute(weight, 4));
  geometry.setIndex(built.geometry.index!.clone());
  for (const g of built.geometry.groups) geometry.addGroup(g.start, g.count, g.materialIndex);
  // Animated bodies reach well outside the bind pose (dives, deaths): a generous fixed bound keeps culling safe.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 4096), 3 * 4096);
  const bindWorld = new Float32Array(skeleton.boneCount * 3);
  for (let i = 0; i < skeleton.boneCount; i++) {
    const p = skeleton.parents[i];
    for (let k = 0; k < 3; k++) bindWorld[i * 3 + k] = skeleton.translations[i * 3 + k] + (p < 0 ? 0 : bindWorld[p * 3 + k]);
  }
  return { geometry, materials: built.materials, anims, bindWorld };
}

export class SoldierBody {
  readonly object: THREE.SkinnedMesh;
  readonly bones: THREE.Bone[];
  readonly clips: ClipPlayer;
  readonly anims: AnimFile;
  /** Extra rotation of the spine (radians about the body's X axis) for hit flinches; decays by itself. */
  flinch = 0;
  gun: THREE.Mesh | null = null;
  /**
   * Cutscene actors place their clips' roots the way the level places the actors: a posture clip (a root that does not
   * move: Anya typing, Jones on the helicopter bench or lying on the flatcar) has its pelvis at the placement; other
   * clips have their feet there, with the root's x/y measured from its first key. See docs/formats/ai.md.
   */
  actorRoots = false;
  private flinchSide = 0;
  private skeleton: AnimFile["skeleton"];
  private cursors: { anim: Animation | null; keys: Int32Array }[] = [
    { anim: null, keys: new Int32Array(0) },
    { anim: null, keys: new Int32Array(0) },
  ];
  private qa = new THREE.Quaternion();
  private qb = new THREE.Quaternion();
  private euler = new THREE.Euler();

  private constructor(r: Rig) {
    this.anims = r.anims;
    this.skeleton = r.anims.skeleton;
    this.clips = new ClipPlayer(r.anims);
    const s = this.skeleton;
    this.bones = [];
    for (let i = 0; i < s.boneCount; i++) {
      const b = new THREE.Bone();
      b.position.set(s.translations[i * 3], s.translations[i * 3 + 1], s.translations[i * 3 + 2]);
      this.bones.push(b);
      if (s.parents[i] >= 0) this.bones[s.parents[i]].add(b);
    }
    const inverses = this.bones.map((_, i) => new THREE.Matrix4().makeTranslation(-r.bindWorld[i * 3], -r.bindWorld[i * 3 + 1], -r.bindWorld[i * 3 + 2]));
    this.object = new THREE.SkinnedMesh(r.geometry, r.materials);
    this.object.add(this.bones[0]);
    this.object.bind(new THREE.Skeleton(this.bones, inverses), new THREE.Matrix4());
  }

  /** A body for a skinned model on the skeleton `hierarchy` (HumanSoldier "Bone Heirachy"), or null. */
  static create(library: ModelLibrary, model: string, hierarchy: number): SoldierBody | null {
    const r = rig(library, model, hierarchy);
    return r ? new SoldierBody(r) : null;
  }

  /** Feet position (child of Game.world: origin-relative IGI space) and heading. */
  place(local: THREE.Vector3, yaw: number) {
    this.object.position.copy(local);
    this.object.rotation.set(0, 0, yaw);
  }

  hit(side: number) {
    this.flinch = 0.35;
    this.flinchSide = side;
  }

  /** Pose the bones from the clip player (cross-fading its two tracks). Looping clips play in place. */
  pose(dt: number) {
    const tracks = this.clips.tracks();
    if (!tracks.length) return;
    const n = this.skeleton.boneCount;
    const [a, b] = tracks;
    const ca = this.cursor(0, a.anim), cb = b ? this.cursor(1, b.anim) : null;
    for (let i = 0; i < n; i++) {
      sample(a.anim.rotations[i], a.time, this.qa, ca, i);
      if (b) {
        sample(b.anim.rotations[i], b.time, this.qb, cb!, i);
        this.qa.slerp(this.qb, b.weight);
      }
      this.bones[i].quaternion.copy(this.qa);
    }
    const actor = this.actorRoots ? this.skeleton : null;
    const root = rootOf(a.anim, a.time, actor);
    if (b) {
      const rb = rootOf(b.anim, b.time, actor);
      for (let k = 0; k < 3; k++) root[k] += (rb[k] - root[k]) * b.weight;
    }
    const t = this.skeleton.translations;
    this.bones[0].position.set(t[0] + root[0], t[1] + root[1], t[2] + root[2]);
    if (this.flinch > 0) {
      // Spine (bone 1) snaps back and to the side, then recovers.
      const k = Math.sin((this.flinch / 0.35) * Math.PI) * 0.35;
      this.qb.setFromEuler(this.euler.set(-k, this.flinchSide * k * 0.6, 0));
      this.bones[1]?.quaternion.multiply(this.qb);
      this.flinch = Math.max(0, this.flinch - dt);
    }
  }

  /** Whether the current clip is a posture (its root does not move), placed by its pelvis for actors. */
  posture(): boolean {
    const id = this.clips.clipId;
    const anim = id === null ? null : this.clips.clip(id);
    return !!anim && isPosture(anim, this.skeleton);
  }

  /**
   * The lowest bone of the pose last set by pose() (where the body meets the ground: toes, or the back of someone lying
   * down), in the body's own frame (x right, y forward, z up).
   */
  lowest(out: THREE.Vector3): THREE.Vector3 {
    this.object.updateMatrixWorld(true);
    INVERSE.copy(this.object.matrixWorld).invert();
    let best = Infinity;
    for (const bone of this.bones) {
      BONE.setFromMatrixPosition(bone.matrixWorld).applyMatrix4(INVERSE);
      if (BONE.z < best) {
        best = BONE.z;
        out.copy(BONE);
      }
    }
    return out;
  }

  /** Per-bone key cursors for a track, so sampling walks forward from the last key instead of from the start. */
  private cursor(slot: number, anim: Animation): Int32Array {
    let c = this.cursors[slot];
    if (c.anim !== anim) {
      c = this.cursors[slot] = { anim, keys: new Int32Array(this.skeleton.boneCount) };
      // The track that was playing may move to the other slot when a new clip starts: keep its cursors.
      const other = this.cursors[1 - slot];
      if (other.anim === anim) c.keys.set(other.keys);
    }
    return c.keys;
  }

  /** Put a gun model in the hands (on `bone`, the gun bone of the soldier skeletons). */
  attachGun(mesh: THREE.Mesh, bone: number) {
    if (!this.bones[bone]) return;
    mesh.geometry.computeBoundingBox();
    this.bones[bone].add(mesh);
    this.gun = mesh;
  }

  /**
   * The gun's muzzle in three.js scene space: the end of the gun's bounding box that lies furthest along `forward`
   * (scene space). Null without a gun.
   */
  muzzle(forward: THREE.Vector3): THREE.Vector3 | null {
    const gun = this.gun;
    const box = gun?.geometry.boundingBox;
    if (!gun || !box) return null;
    this.object.updateMatrixWorld(true);
    const centre = box.getCenter(new THREE.Vector3());
    let best: THREE.Vector3 | null = null;
    let bestAlong = -Infinity;
    for (let axis = 0; axis < 3; axis++) {
      for (const end of [box.min, box.max]) {
        const p = centre.clone().setComponent(axis, end.getComponent(axis)).applyMatrix4(gun.matrixWorld);
        const along = p.dot(forward);
        if (along > bestAlong) {
          bestAlong = along;
          best = p;
        }
      }
    }
    return best;
  }
}

const INVERSE = new THREE.Matrix4();
/** How far (IGI units, 0.75 m) the lowest bone of a still clip may hang below its pelvis for it to be a posture. */
const POSTURE_REACH = 0.75 * 4096;
const BONE = new THREE.Vector3();
const postures = new WeakMap<Animation, boolean>();

/**
 * A still clip whose legs do not reach down to the floor under the pelvis: sitting (on a chair, a helicopter bench,
 * at the wheel), lying or crouching, rather than standing (toes about 0.95 m below the pelvis) or moving. Measured on
 * the clip's first frame; the root height alone does not tell (Mission 8's truck driver sits with the pelvis at a
 * standing 0.97 m).
 */
export function isPosture(anim: Animation, skeleton: AnimFile["skeleton"]): boolean {
  let p = postures.get(anim);
  if (p === undefined) {
    p = false;
    if (isStill(anim)) {
      const bones = poseBones(skeleton, anim, 0);
      let lowest = Infinity;
      for (let i = 0; i < skeleton.boneCount; i++) lowest = Math.min(lowest, bones[i * 12 + 11]);
      p = anim.root[0].p[2] - lowest < POSTURE_REACH;
    }
    postures.set(anim, p);
  }
  return p;
}

/** A clip whose root does not move. */
export function isStill(anim: Animation): boolean {
  const k = anim.root;
  return k.length > 0 && k.every((r) => Math.abs(r.p[0] - k[0].p[0]) + Math.abs(r.p[1] - k[0].p[1]) + Math.abs(r.p[2] - k[0].p[2]) < 1);
}

/**
 * Root position: looping clips keep x/y at their first key so locomotion plays on the spot. With `actor` roots a
 * posture's pelvis sits at the origin and other clips measure x/y from their first key.
 */
function rootOf(anim: Animation, time: number, actor: AnimFile["skeleton"] | null): [number, number, number] {
  const r = rootAt(anim, time);
  if (!anim.root.length) return r;
  const first = anim.root[0].p;
  if (actor) {
    if (isPosture(anim, actor)) return [0, 0, 0];
    r[0] = looping(anim) ? 0 : r[0] - first[0];
    r[1] = looping(anim) ? 0 : r[1] - first[1];
  } else if (looping(anim)) {
    r[0] = first[0];
    r[1] = first[1];
  }
  return r;
}

function sample(keys: RotationKey[], t: number, out: THREE.Quaternion, cursor: Int32Array, bone: number) {
  if (!keys.length) return out.set(0, 0, 0, 1);
  let i = cursor[bone];
  if (i >= keys.length || keys[i].time > t) i = 0;
  while (i + 1 < keys.length && keys[i + 1].time <= t) i++;
  cursor[bone] = i;
  const a = keys[i], b = keys[i + 1];
  out.set(a.q[0], a.q[1], a.q[2], a.q[3]);
  if (!b || b.time <= a.time) return out;
  const f = Math.min(1, (t - a.time) / (b.time - a.time));
  return out.slerp(tmp.set(b.q[0], b.q[1], b.q[2], b.q[3]), f);
}
const tmp = new THREE.Quaternion();
