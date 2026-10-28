// Renders the mission's interactive objects (doors, gates, switches, terminals, security cameras, explodables,
// mission pickups, elevators) and registers them as entities, so bullets can hit them and the map can find them.
// Static scenery (Building, EditRigidObj) is placed by Game itself; these are the objects.qvm tasks whose state the
// mission logic changes.

import * as THREE from "three";
import type { Vec3 } from "../coords.ts";
import type { Entity } from "../entity.ts";
import type { Game } from "../game.ts";
import { DoorTask, ElevatorTask, GenericPickupTask, ObjectTask, SCameraTask, SwitchTask, TerminalTask, type MissionLogic } from "./logic.ts";

const KIND: [new (...a: never[]) => ObjectTask, string][] = [
  [DoorTask, "door"],
  [SwitchTask, "switch"],
  [TerminalTask, "terminal"],
  [SCameraTask, "camera"],
  [GenericPickupTask, "pickup"],
  [ElevatorTask, "elevator"],
];

interface Visual {
  task: ObjectTask;
  group: THREE.Group;
  mesh: THREE.Mesh | null;
  model: string;
  /** Security camera lens (rotates under the holder). */
  lens?: { mesh: THREE.Mesh | null; model: string };
  entity: Entity;
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
      const kind = KIND.find(([cls]) => t instanceof cls)?.[1] ?? "object";
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
      const v: Visual = { task: t, group, mesh: null, model: "", entity };
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
    }
  }

  /** Per-frame: model swaps, door/elevator/camera transforms, visibility. */
  update() {
    for (const v of this.visuals) this.sync(v);
  }

  private sync(v: Visual) {
    const t = v.task;
    const model = t.currentModel();
    if (model !== v.model) {
      v.model = model;
      if (v.mesh) v.group.remove(v.mesh);
      v.mesh = this.build(model);
      if (v.mesh) v.group.add(v.mesh);
    }
    let pos: Vec3 = t.worldPosition();
    let rot: Vec3 = t.orientation;
    if (t instanceof DoorTask) ({ position: pos, orientation: rot } = t.pose());
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
    v.entity.position = pos;
    v.entity.alive = !t.exploded && t.active && !!model;
    v.entity.health = Math.max(0, t.health);
  }

  private build(model: string): THREE.Mesh | null {
    if (!model) return null;
    const built = this.game.level.library.build(model);
    return built ? new THREE.Mesh(built.geometry, built.materials) : null;
  }

  dispose() {
    for (const v of this.visuals) {
      v.group.removeFromParent();
      this.game.entities.remove(v.entity.id);
    }
    this.visuals = [];
  }
}
