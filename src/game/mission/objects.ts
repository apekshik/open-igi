// Renders the mission's interactive objects (doors, gates, switches, terminals, security cameras, explodables,
// mission pickups, elevators, vehicles) and registers them as entities, so bullets can hit them and the map can find them. Each
// model's collision sets go to the physics system as a dynamic collider at the object's current pose, so closed doors
// block movement, bullets and sight, and elevator cars carry whoever stands in them.
// Static scenery (Building, EditRigidObj) is placed by Game itself; these are the objects.qvm tasks whose state the
// mission logic changes.

import * as THREE from "three";
import { readMefLighting } from "../../formats/olm.ts";
import type { Vec3 } from "../coords.ts";
import type { Entity } from "../entity.ts";
import type { Game } from "../game.ts";
import type { DynamicCollider } from "../physics/api.ts";
import { DoorTask, ElevatorTask, GenericPickupTask, ObjectTask, SCameraTask, SwitchTask, TerminalTask, VehicleTask, type MissionLogic } from "./logic.ts";

const KIND: [new (...a: never[]) => ObjectTask, string][] = [
  [DoorTask, "door"],
  [SwitchTask, "switch"],
  [TerminalTask, "terminal"],
  [SCameraTask, "camera"],
  [GenericPickupTask, "pickup"],
  [ElevatorTask, "elevator"],
];

/** Attached parts that spin: helicopter rotor hubs and tail rotors (rad/s about their own axis). */
const SPINNING: Record<string, { axis: "x" | "y" | "z"; speed: number }> = {
  "711_01_1": { axis: "z", speed: 30 },
  "712_01_1": { axis: "x", speed: 45 },
  "700_03_1": { axis: "z", speed: 30 },
  "700_08_1": { axis: "z", speed: 30 },
  "700_02_1": { axis: "x", speed: 45 },
};

interface Visual {
  task: ObjectTask;
  group: THREE.Group;
  mesh: THREE.Mesh | null;
  model: string;
  /** Security camera lens (rotates under the holder). */
  lens?: { mesh: THREE.Mesh | null; model: string };
  entity: Entity;
  collider: DynamicCollider | null;
  /** Spinning attached parts (rotors). */
  spinners?: { object: THREE.Object3D; axis: "x" | "y" | "z"; speed: number }[];
}

export class MissionObjects {
  private game: Game;
  private logic: MissionLogic;
  private visuals: Visual[] = [];
  /** Entity id → task id, for routing damage events. */
  readonly entityTasks = new Map<number, ObjectTask>();

  constructor(game: Game, logic: MissionLogic) {
    this.game = game;
    this.logic = logic;
    for (const t of logic.tasks) {
      if (!(t instanceof ObjectTask) || !t.physical) continue;
      const group = new THREE.Group();
      game.world.add(group);
      const kind = t instanceof VehicleTask ? t.kind : (KIND.find(([cls]) => t instanceof cls)?.[1] ?? "object");
      const entity = game.entities.create({
        kind,
        position: t.worldPosition(),
        yaw: t.orientation[2],
        health: 100,
        maxHealth: 100,
        // Objects belong to no side; AI and targeting should ignore team -1.
        team: -1,
        alive: true,
        radius: 0.4 * 4096,
        height: 1 * 4096,
        object: group,
        ...(t.node.id >= 0 ? { taskId: t.node.id } : {}),
      });
      const v: Visual = { task: t, group, mesh: null, model: "", entity, collider: null };
      if (t instanceof SCameraTask) v.lens = { mesh: null, model: "" };
      this.visuals.push(v);
      this.entityTasks.set(entity.id, t);
      this.sync(v);
      // Fit the hit volume to the model.
      if (v.mesh) {
        v.mesh.geometry.computeBoundingBox();
        const box = v.mesh.geometry.boundingBox!;
        entity.radius = Math.max(0.2 * 4096, Math.hypot(box.max.x - box.min.x, box.max.y - box.min.y) / 2);
        entity.height = Math.max(0.2 * 4096, box.max.z - Math.min(0, box.min.z));
        const c = box.getCenter(new THREE.Vector3());
        t.center = [c.x, c.y, c.z];
      }
      // Doors and elevator cars are hit through their collision shape (the collider reports the entity), not a capsule.
      if (v.collider && (t instanceof DoorTask || t instanceof ElevatorTask || t instanceof VehicleTask)) entity.radius = 0;
    }
  }

  /** Per-frame: model swaps, door/elevator/camera/vehicle transforms, visibility. */
  update(dt = 0) {
    for (const v of this.visuals) this.sync(v, dt);
  }

  /**
   * Highest surface under (x, y) at or below z, leaving out the object of task `ignoreTaskId` (a vehicle finding the
   * ground under itself).
   */
  ground(x: number, y: number, z: number, ignoreTaskId?: number): { z: number; normal: Vec3 } | null {
    const physics = this.game.services.physics;
    if (!physics) return null;
    const own = ignoreTaskId === undefined ? undefined : this.visuals.find((v) => v.task.node.id === ignoreTaskId)?.collider;
    const was = own?.enabled;
    if (own) own.enabled = false;
    const g = physics.ground ? physics.ground(x, y, z) : null;
    const h = g ? null : physics.groundHeight(x, y, z);
    if (own) own.enabled = was!;
    if (g) return { z: g.z, normal: g.normal };
    return h === null ? null : { z: h, normal: [0, 0, 1] };
  }

  private extents = new Map<string, { length: number; bottom: number } | null>();

  /** Length along +Y and depth of the lowest point below the origin of a model with its attached parts (wheels). */
  modelExtent(model: string): { length: number; bottom: number } | null {
    if (this.extents.has(model)) return this.extents.get(model)!;
    const library = this.game.level.library;
    const box = new THREE.Box3();
    const add = (name: string, m: THREE.Matrix4, depth: number) => {
      const built = library.build(name);
      if (!built) return;
      if (!built.geometry.boundingBox) built.geometry.computeBoundingBox();
      box.union(built.geometry.boundingBox!.clone().applyMatrix4(m));
      if (depth < 2) for (const a of this.attachments(name)) add(a.model, m.clone().multiply(a.matrix), depth + 1);
    };
    add(model, new THREE.Matrix4(), 0);
    const out = box.isEmpty() ? null : { length: box.max.y - box.min.y, bottom: -box.min.z };
    this.extents.set(model, out);
    return out;
  }

  /** A model's ATTA sub-models (wheels, rotors, doors) with their matrices in its model space. */
  private attachments(model: string): { model: string; matrix: THREE.Matrix4 }[] {
    const bytes = this.game.level.library.bytes(model);
    if (!bytes) return [];
    let list;
    try {
      list = readMefLighting(bytes).attachments;
    } catch {
      return [];
    }
    return list.map((a) => {
      const r = a.rotation;
      const matrix = new THREE.Matrix4().set(r[0], r[1], r[2], a.position[0], r[3], r[4], r[5], a.position[1], r[6], r[7], r[8], a.position[2], 0, 0, 0, 1);
      return { model: a.model, matrix };
    });
  }

  private sync(v: Visual, dt = 0) {
    const t = v.task;
    const model = t.currentModel();
    let rebuilt = false;
    if (model !== v.model) {
      v.model = model;
      if (v.mesh) v.group.remove(v.mesh);
      v.mesh = this.build(model);
      if (v.mesh) v.group.add(v.mesh);
      // Vehicles bring their wheels, rotors and doors as attached sub-models.
      if (v.mesh && t instanceof VehicleTask) this.addAttachments(v, v.mesh, model, 0);
      v.collider?.remove();
      v.collider = null;
      rebuilt = true;
    }
    let { position: pos, orientation: rot } = t.pose();
    if (t instanceof VehicleTask) {
      // Between logic ticks (30 Hz): interpolate from the previous tick's pose.
      const a = this.logic.alpha;
      const p0 = t.previous.position;
      const o0 = t.previous.orientation;
      pos = [p0[0] + (pos[0] - p0[0]) * a, p0[1] + (pos[1] - p0[1]) * a, p0[2] + (pos[2] - p0[2]) * a];
      rot = [lerpAngle(o0[0], rot[0], a), lerpAngle(o0[1], rot[1], a), lerpAngle(o0[2], rot[2], a)];
      for (const s of v.spinners ?? []) if (!t.exploded) s.object.rotation[s.axis] += s.speed * dt;
    }
    if (t instanceof SCameraTask) {
      rot = [0, 0, t.holderGamma];
      const lensModel = t.cameraModel();
      const lens = v.lens!;
      if (lensModel !== lens.model) {
        lens.model = lensModel;
        if (lens.mesh) v.group.remove(lens.mesh);
        lens.mesh = this.build(lensModel);
        if (lens.mesh) v.group.add(lens.mesh);
      }
      // The lens turns about the holder's Z, then tilts by Camera Alpha.
      lens.mesh?.rotation.set(t.alpha, 0, t.heading() - t.holderGamma, "ZYX");
    }
    v.group.position.copy(this.game.local(pos));
    v.group.rotation.set(rot[0], rot[1], rot[2], "ZYX");
    v.group.visible = t.active && !!model;
    if (rebuilt && model) {
      v.group.updateMatrix();
      v.collider = this.game.services.physics?.addDynamic?.(model, v.group.matrix.elements, { entityId: v.entity.id }) ?? null;
      // Some buildings carry the closed door leaf in their own collision; the Door object takes its place.
      if (v.collider && t instanceof DoorTask) {
        const closed = t.pose(0);
        const m = new THREE.Matrix4().compose(
          this.game.local(closed.position),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(closed.orientation[0], closed.orientation[1], closed.orientation[2], "ZYX")),
          new THREE.Vector3(1, 1, 1),
        );
        v.collider.carve(m.elements);
      }
    }
    if (v.collider) {
      v.group.updateMatrix();
      v.collider.setMatrix(v.group.matrix.elements);
      v.collider.enabled = v.group.visible;
    }
    v.entity.position = pos;
    v.entity.alive = !t.exploded && t.active && !!model;
    v.entity.health = Math.max(0, t.health);
  }

  private addAttachments(v: Visual, parent: THREE.Object3D, model: string, depth: number) {
    for (const a of this.attachments(model)) {
      const mesh = this.build(a.model);
      if (!mesh) continue;
      const holder = new THREE.Group();
      holder.matrixAutoUpdate = false;
      holder.matrix.copy(a.matrix);
      holder.add(mesh);
      parent.add(holder);
      const spin = SPINNING[a.model];
      if (spin) (v.spinners ??= []).push({ object: mesh, ...spin });
      if (depth < 1) this.addAttachments(v, mesh, a.model, depth + 1);
    }
  }

  private build(model: string): THREE.Mesh | null {
    if (!model) return null;
    const built = this.game.level.library.build(model);
    return built ? new THREE.Mesh(built.geometry, built.materials) : null;
  }

  dispose() {
    for (const v of this.visuals) {
      v.collider?.remove();
      v.group.removeFromParent();
      this.game.entities.remove(v.entity.id);
    }
    this.visuals = [];
  }
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
}
