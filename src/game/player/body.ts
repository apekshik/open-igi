// A visible, animated human: a skinned (type 1) model from the level library posed every frame from a ClipPlayer.
// The player uses it for the debug third-person view (key V) and the death camera; AI soldiers can use the same
// class for their bodies. Usage:
//   const body = SkinnedBody.create(game.level.library, "000_01_1");
//   game.world.add(body.object);
//   body.clips.play(4);                          // run forward
//   body.clips.advance(dt); body.place(game.local(feet), yaw); body.pose();
import * as THREE from "three";
import { poseBones } from "../../formats/anim.ts";
import { skinMef } from "../../formats/mef.ts";
import type { BuiltModel, BuiltSkin, ModelLibrary } from "../../render/library.ts";
import { ClipPlayer } from "./animator.ts";

export class SkinnedBody {
  readonly object: THREE.Mesh;
  readonly clips: ClipPlayer;
  private skin: BuiltSkin;
  private blended: Float32Array;

  private constructor(built: BuiltModel, skin: BuiltSkin) {
    this.skin = skin;
    this.clips = new ClipPlayer(skin.anims);
    // The library caches one geometry per model name; posing writes vertices, so each body gets its own copy.
    const geometry = built.geometry.clone();
    this.object = new THREE.Mesh(geometry, built.materials);
    this.object.frustumCulled = false;
    this.blended = new Float32Array(skin.anims.skeleton.boneCount * 12);
  }

  /** Build a body for a skinned model, or null if the model is missing or not skinned. */
  static create(library: ModelLibrary, model: string): SkinnedBody | null {
    const built = library.build(model);
    if (!built?.skin) return null;
    return new SkinnedBody(built, built.skin);
  }

  /** Feet position (a child of Game.world, so origin-relative IGI space) and heading. */
  place(local: THREE.Vector3, yaw: number) {
    this.object.position.copy(local);
    this.object.rotation.set(0, 0, yaw);
  }

  /** Skin the model with the current (blended) clip pose. Skips the work while hidden. */
  pose() {
    if (!this.object.visible) return;
    const tracks = this.clips.tracks();
    const skeleton = this.skin.anims.skeleton;
    let bones: Float32Array;
    if (tracks.length === 0) bones = poseBones(skeleton);
    else if (tracks.length === 1) bones = poseBones(skeleton, tracks[0].anim, tracks[0].time, true);
    else {
      // Cross-fade: blend bone transforms element-wise (fine for IGI's short 0.2 s blends).
      bones = this.blended;
      bones.fill(0);
      for (const t of tracks) {
        const b = poseBones(skeleton, t.anim, t.time, true);
        for (let i = 0; i < bones.length; i++) bones[i] += b[i] * t.weight;
      }
    }
    const posed = skinMef(this.skin.model, bones);
    const geometry = this.object.geometry;
    const pos = geometry.getAttribute("position") as THREE.BufferAttribute;
    const nrm = geometry.getAttribute("normal") as THREE.BufferAttribute;
    (pos.array as Float32Array).set(posed.positions);
    (nrm.array as Float32Array).set(posed.normals);
    pos.needsUpdate = nrm.needsUpdate = true;
  }

  dispose() {
    this.object.removeFromParent();
    this.object.geometry.dispose();
  }
}
