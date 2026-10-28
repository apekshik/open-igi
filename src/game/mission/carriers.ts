// Things that carry other things in cutscenes: helicopters, cars, planes, train cars and characters.
//
// IGI places a cutscene's passengers and linked cameras where they sit relative to their carrier as the level editor
// left it: Jones in the insertion helicopter's cabin, Jones hiding on the roof of a train's fourth car, Jones at the
// wheel of the truck in Mission 1's outro. A vehicle's editor pose is its Position/Orientation; a train's is its
// locomotive at its Position along the track (its Smoke child sits on the chimney there). A carried point keeps its
// offset from the carrier: world = current × inverse(reference) × point, and headings turn with the carrier.
//
// Which carrier: the nearest Heli/Car/Plane/Train task above a character, else the vehicle its AI graph is placed in
// (Mission 1's Jones jumping onto the train walks graph 2, which lives in one of the train's cars; the outro's driver
// walks graph 15 in the truck). Cameras name theirs by EditCamera "Link task ID".

import * as THREE from "three";
import type { Vec3 } from "../coords.ts";
import type { Game } from "../game.ts";
import { VehicleTask, type MissionLogic } from "./logic.ts";
import type { TaskNode } from "./tasks.ts";
import { pnum, pvec } from "./tasks.ts";
import { rotate } from "./vehicles.ts";

/** A rigid pose: origin and model axes (absolute IGI units). */
export interface Pose {
  origin: Vec3;
  axes: [Vec3, Vec3, Vec3];
}

export interface Carrier {
  /** Where the level places it (what carried points are placed relative to). */
  reference: Pose;
  /** Where it is now, or null while it is not in play. */
  current(): Pose | null;
}

const VEHICLES = new Set(["Heli", "Car", "Plane", "Train"]);

function eulerPose(origin: Vec3, o: Vec3): Pose {
  return { origin, axes: [rotate(o, [1, 0, 0]), rotate(o, [0, 1, 0]), rotate(o, [0, 0, 1])] };
}

/** Pose from position and heading (characters). */
function yawPose(origin: Vec3, yaw: number): Pose {
  return eulerPose(origin, [0, 0, yaw]);
}

/** Turn a direction given relative to `from` the way the carrier has turned to `to`. */
export function carryDirection(v: Vec3, from: Pose, to: Pose): Vec3 {
  return carry(v, { origin: [0, 0, 0], axes: from.axes }, { origin: [0, 0, 0], axes: to.axes });
}

/** Carry a point placed relative to `from` to the same place relative to `to`. */
export function carry(point: Vec3, from: Pose, to: Pose): Vec3 {
  const d: Vec3 = [point[0] - from.origin[0], point[1] - from.origin[1], point[2] - from.origin[2]];
  const out: Vec3 = [...to.origin];
  for (let i = 0; i < 3; i++) {
    const a = from.axes[i];
    const k = d[0] * a[0] + d[1] * a[1] + d[2] * a[2];
    const b = to.axes[i];
    out[0] += b[0] * k;
    out[1] += b[1] * k;
    out[2] += b[2] * k;
  }
  return out;
}

/** How far a carrier has turned about Z from `from` to `to`. */
export function turned(from: Pose, to: Pose): number {
  const a = from.axes[0];
  const b = to.axes[0];
  return Math.atan2(b[1], b[0]) - Math.atan2(a[1], a[0]);
}

export class Carriers {
  private cache = new Map<TaskNode, Carrier | null>();
  private game: Game;
  private logic: MissionLogic;

  constructor(game: Game, logic: MissionLogic) {
    this.game = game;
    this.logic = logic;
  }

  /** The carrier task `id` names (Link task ID), or null if it is not something that moves. */
  byId(id: number): Carrier | null {
    const node = this.logic.tree.byId.get(id);
    return node ? this.of(node) : null;
  }

  /** What carries the character whose HumanAI task is `aiId`, if anything. */
  ofCharacter(aiId: number): Carrier | null {
    const ai = this.logic.tree.byKey.get(`HumanAI_${aiId}`);
    const soldier = ai?.parent;
    if (!ai || !soldier) return null;
    for (let p = soldier.parent; p; p = p.parent) if (VEHICLES.has(p.type)) return this.of(p);
    const host = this.logic.tree.byKey.get(`AIGraph_${pnum(ai, "Graph ID", -1)}`)?.parent;
    return host && VEHICLES.has(host.type) ? this.of(host) : null;
  }

  /** A carrier for a task node: a vehicle, a train car or a character. */
  of(node: TaskNode): Carrier | null {
    if (this.cache.has(node)) return this.cache.get(node)!;
    const c = this.make(node);
    this.cache.set(node, c);
    return c;
  }

  private make(node: TaskNode): Carrier | null {
    const logic = this.logic;
    const game = this.game;
    if (node.type === "Heli" || node.type === "Car" || node.type === "Plane") {
      const task = logic.byNode.get(node);
      if (!(task instanceof VehicleTask)) return null;
      return {
        reference: eulerPose(pvec(node, "Position"), pvec(node, "Orientation")),
        current: () => {
          if (!task.active) return null;
          // As drawn: between the previous and the latest logic tick.
          const a = logic.alpha;
          const p0 = task.previous.position, p1 = task.state.position;
          const o0 = task.previous.orientation, o1 = task.state.orientation;
          const lerp = (x: number, y: number) => x + (y - x) * a;
          const angle = (x: number, y: number) => x + Math.atan2(Math.sin(y - x), Math.cos(y - x)) * a;
          return eulerPose([lerp(p0[0], p1[0]), lerp(p0[1], p1[1]), lerp(p0[2], p1[2])], [angle(o0[0], o1[0]), angle(o0[1], o1[1]), angle(o0[2], o1[2])]);
        },
      };
    }
    if (node.type === "Train") {
      // The locomotive is the outermost Train; wagons are its Train children in order.
      let loco = node;
      while (loco.parent?.type === "Train") loco = loco.parent;
      const index = loco === node ? 0 : loco.children.filter((c) => c.type === "Train").indexOf(node) + 1;
      const car = () => game.services.world?.trainCar?.(loco.id, index);
      const reference = car()?.reference;
      if (!reference) return null;
      return { reference, current: () => car()?.current ?? null };
    }
    if (node.type === "HumanSoldier" || node.type === "HumanSoldierFemale") {
      return {
        reference: yawPose(pvec(node, "Position"), pnum(node, "Gamma")),
        current: () => {
          const e = game.entities.byTask(node.id);
          if (!e) return null;
          const yaw = (e as { yaw?: number }).yaw ?? pnum(node, "Gamma");
          return yawPose(e.position, yaw);
        },
      };
    }
    return null;
  }
}

/** IGI (x east, y north, z up) to three.js scene axes (x, z, -y). */
const toScene = (v: Vec3) => new THREE.Vector3(v[0], v[2], -v[1]);

/**
 * A camera view (yaw, pitch, roll as Game.setView takes them) placed relative to `from`, turned the way the carrier
 * has turned since: a linked camera pitches and banks with its helicopter.
 */
export function turnView(yaw: number, pitch: number, roll: number, from: Pose, to: Pose): { yaw: number; pitch: number; roll: number } {
  const basis = (p: Pose) => new THREE.Matrix4().makeBasis(toScene(p.axes[0]), toScene(p.axes[1]), toScene(p.axes[2]));
  const delta = basis(to).multiply(basis(from).transpose());
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, roll, "YXZ"));
  q.premultiply(new THREE.Quaternion().setFromRotationMatrix(delta));
  const e = new THREE.Euler().setFromQuaternion(q, "YXZ");
  return { yaw: e.y, pitch: e.x, roll: e.z };
}
