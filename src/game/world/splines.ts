// Spline objects and trains.
//
// SplineObj tasks lay a segment model (railway, tunnel, power line) along a path of SplineObjWaypoint children: the
// model of waypoint i is bent onto the stretch from waypoint i to i+1, its local X running from the start to the end
// of that stretch, Y sideways and Z up. "Linear Segments" makes the stretches straight; otherwise the path is a smooth
// (Catmull-Rom) curve through the waypoints. Train tasks run a locomotive and its wagons (child Train tasks) along the
// SplineObj named by "RailroadQTaskID", at "Position" (distance along the track, world units), accelerating by "Original
// thrust" up to "MaxSpeed". These rules are our reading of the parameter names and the level data; see
// docs/formats/world.md. The mission system drives trains from their AnimTasks (shown while their container runs, the
// thrust lever from AnimData channel 0; docs/formats/dynamic.md), and every car collides as a dynamic collider.

import * as THREE from "three";
import type { QvmCall, QvmValue } from "../../formats/qvm.ts";
import type { ModelLibrary } from "../../render/library.ts";
import type { StaticRenderer } from "../../render/statics.ts";
import { METRE } from "../coords.ts";
import type { DynamicCollider, PhysicsService } from "../physics/api.ts";

interface Spline {
  id: number;
  curve: THREE.Curve<THREE.Vector3>;
  /** Waypoint count; stretch i covers curve parameter [i, i+1] / (count - 1). */
  count: number;
  linear: boolean;
  points: THREE.Vector3[];
}

export interface TrainState {
  taskId: number;
  /** The train exists (the mission shows it while its ConditionalContainer runs). Inactive trains are hidden. */
  active: boolean;
  /** Whether the train runs on its own (its AnimTask condition is "1") or waits for start(). */
  running: boolean;
  /** Thrust lever, m/s² ("Original thrust", then AnimData channel 0). The actual thrust follows it by ThrustStep. */
  throttle: number;
  /** Distance of the locomotive along the track, world units. */
  position: number;
  /** World units per second. */
  speed: number;
}

interface Train extends TrainState {
  spline: Spline;
  length: number;
  /** Current thrust (m/s²), following the lever by `step` per logic tick. */
  thrust: number;
  step: number;
  maxSpeed: number;
  flip: boolean;
  offset: [number, number];
  cars: { mesh: THREE.Object3D; spacing: number; model: string; collider: DynamicCollider | null }[];
}

/** Rolling resistance of a train without thrust, m/s². */
const TRAIN_FRICTION = 0.4;

const MODEL_NAME = /^\d{3}_\d{2}_\d$/;

export class Splines {
  readonly group = new THREE.Group();
  private splines = new Map<number, Spline>();
  private trains: Train[] = [];
  private pendingTrains: { task: QvmCall; params: QvmValue[] }[] = [];

  /** Read SplineObj and Train tasks; spline geometry goes to `statics`, trains are reserved there for later. */
  constructor(statements: QvmCall[], library: ModelLibrary, statics: StaticRenderer, origin: [number, number, number]) {
    const autoRun = new Set<number>();
    const visit = (t: QvmCall, inTrain = false) => {
      if (t.fn !== "Task_New") return;
      const [id, type, , ...rest] = t.args;
      const params = rest.filter((r) => !isCall(r));
      const kids = rest.filter(isCall);
      if (type === "SplineObj") this.addSpline(Number(id), params, kids, library, statics, origin);
      else if (type === "Train" && !inTrain && typeof params[3] === "string") this.pendingTrains.push({ task: t, params });
      else if (type === "AnimTask" && params[7] === "1") autoRun.add(Number(params[6]));
      // Wagons are Train tasks under their locomotive; only the outermost one is a train.
      kids.forEach((k) => visit(k, inTrain || type === "Train"));
    };
    statements.forEach((s) => visit(s));
    for (const { task } of this.pendingTrains) for (const model of trainModels(task)) statics.reserve(model);
    this.autoRun = autoRun;
  }
  private autoRun: Set<number>;

  /** Create the train meshes; call after StaticRenderer.finish(). */
  createTrains(library: ModelLibrary, statics: StaticRenderer) {
    for (const { task, params } of this.pendingTrains) {
      const [id] = task.args;
      const spline = this.splines.get(Number(params[2]));
      if (!spline) continue;
      // Train: position, thrust, railroad id, model, thrust step, max speed, flip, displacement x, y, sound.
      const cars: Train["cars"] = [];
      for (const model of trainModels(task)) {
        const mesh = statics.createMesh(model);
        if (!mesh) continue;
        const g = library.build(model)!.geometry;
        if (!g.boundingBox) g.computeBoundingBox();
        const bb = g.boundingBox!;
        mesh.matrixAutoUpdate = false;
        mesh.visible = false;
        this.group.add(mesh);
        cars.push({ mesh, spacing: bb.max.x - bb.min.x, model, collider: null });
      }
      if (!cars.length) continue;
      const num = (v: QvmValue | undefined, f: number) => (typeof v === "number" ? v : f);
      this.trains.push({
        taskId: Number(id),
        spline,
        length: spline.curve.getLength(),
        active: true,
        running: this.autoRun.has(Number(id)),
        position: num(params[0], 0),
        speed: 0,
        // Thrust as metres per second squared, MaxSpeed as km/h.
        throttle: num(params[1], 0.2),
        thrust: 0,
        step: num(params[4], 1),
        maxSpeed: (num(params[5], 60) / 3.6) * METRE,
        flip: isTrue(params[6]),
        offset: [num(params[7], 0), num(params[8], 0)],
        cars,
      });
    }
    this.pendingTrains = [];
  }

  /** Trains by task id, for mission scripts that start them. */
  train(taskId: number): TrainState | undefined {
    return this.trains.find((t) => t.taskId === taskId);
  }

  /** Give every train car a dynamic collider (once the physics system exists). */
  attachColliders(physics: PhysicsService) {
    if (!physics.addDynamic) return;
    for (const t of this.trains) for (const car of t.cars) car.collider ??= physics.addDynamic(car.model, car.mesh.matrix.elements);
  }

  update(dt: number) {
    const p = new THREE.Vector3();
    const tangent = new THREE.Vector3();
    const left = new THREE.Vector3();
    const up = new THREE.Vector3(0, 0, 1);
    const m = new THREE.Matrix4();
    for (const t of this.trains) {
      if (!t.active) {
        for (const car of t.cars) {
          car.mesh.visible = false;
          if (car.collider) car.collider.enabled = false;
        }
        continue;
      }
      // The thrust follows the lever by ThrustStep per 30 Hz tick; without thrust the train rolls to a stop.
      const lever = t.running ? t.throttle : 0;
      t.thrust += Math.max(-t.step * 30 * dt, Math.min(t.step * 30 * dt, lever - t.thrust));
      if (t.thrust > 0) t.speed = Math.min(t.maxSpeed, t.speed + t.thrust * METRE * dt);
      else t.speed = Math.max(0, t.speed - TRAIN_FRICTION * METRE * dt);
      t.position += t.speed * dt;
      let along = t.position;
      for (const car of t.cars) {
        const s = along - car.spacing / 2;
        along -= car.spacing;
        // Distance from the start of the track (or its end, for flipped trains).
        const d = t.flip ? t.length - s : s;
        if (d < 0 || d > t.length) {
          car.mesh.visible = false;
          if (car.collider) car.collider.enabled = false;
          continue;
        }
        const u = d / t.length;
        t.spline.curve.getPointAt(u, p);
        t.spline.curve.getTangentAt(u, tangent);
        if (t.flip) tangent.negate();
        left.crossVectors(up, tangent).normalize();
        const realUp = new THREE.Vector3().crossVectors(tangent, left);
        p.addScaledVector(left, t.offset[1]).addScaledVector(tangent, t.offset[0]);
        m.makeBasis(tangent, left, realUp).setPosition(p);
        car.mesh.matrix.copy(m);
        car.mesh.visible = true;
        if (car.collider) {
          car.collider.setMatrix(m.elements);
          car.collider.enabled = true;
        }
      }
    }
  }

  private addSpline(id: number, params: QvmValue[], waypoints: QvmCall[], library: ModelLibrary, statics: StaticRenderer, origin: [number, number, number]) {
    // SplineObj: linear segments, display waypoints, snap length, automatic orientation, matrices per segment, ...
    const linear = isTrue(params[0]);
    const points: THREE.Vector3[] = [];
    const segmentModels: string[] = [];
    for (const w of waypoints) {
      if (w.args[1] !== "SplineObjWaypoint") continue;
      // SplineObjWaypoint: orientation (3 angles), position, waypoint model, segment model, areas, align, flip, auto.
      const p = w.args.slice(3).filter((r) => !isCall(r));
      points.push(new THREE.Vector3(Number(p[3]) - origin[0], Number(p[4]) - origin[1], Number(p[5]) - origin[2]));
      segmentModels.push(typeof p[7] === "string" ? p[7] : "");
    }
    if (points.length < 2) return;
    const curve: THREE.Curve<THREE.Vector3> = linear ? new Polyline(points) : new THREE.CatmullRomCurve3(points, false, "catmullrom", 0.5);
    const spline: Spline = { id, curve, count: points.length, linear, points };
    if (id >= 0) this.splines.set(id, spline);

    for (let i = 0; i < points.length - 1; i++) {
      const model = segmentModels[i];
      if (!MODEL_NAME.test(model)) continue;
      const g = library.build(model)?.geometry;
      if (!g) continue;
      if (!g.boundingBox) g.computeBoundingBox();
      const x0 = g.boundingBox!.min.x;
      const span = Math.max(1, g.boundingBox!.max.x - x0);
      const n = points.length - 1;
      const at = new THREE.Vector3();
      const tangent = new THREE.Vector3();
      const left = new THREE.Vector3();
      const up = new THREE.Vector3();
      const z = new THREE.Vector3(0, 0, 1);
      const basis = new THREE.Matrix3();
      statics.addDeformed(model, (p, nrm) => {
        const t = (i + Math.min(1, Math.max(0, (p.x - x0) / span))) / n;
        curve.getPoint(t, at);
        curve.getTangent(t, tangent);
        left.crossVectors(z, tangent).normalize();
        up.crossVectors(tangent, left);
        basis.set(tangent.x, left.x, up.x, tangent.y, left.y, up.y, tangent.z, left.z, up.z);
        const y = p.y;
        const h = p.z;
        p.copy(at).addScaledVector(left, y).addScaledVector(up, h);
        nrm.applyMatrix3(basis).normalize();
      });
    }
  }
}

/** Straight stretches between points, parameterised like CatmullRomCurve3 (point i at t = i / (n - 1)). */
class Polyline extends THREE.Curve<THREE.Vector3> {
  private points: THREE.Vector3[];
  constructor(points: THREE.Vector3[]) {
    super();
    this.points = points;
  }
  override getPoint(t: number, target = new THREE.Vector3()) {
    const n = this.points.length - 1;
    const f = Math.min(n, Math.max(0, t * n));
    const i = Math.min(n - 1, Math.floor(f));
    return target.lerpVectors(this.points[i], this.points[i + 1], f - i);
  }
}

/** Locomotive then wagons (child Train tasks), by model name. */
function trainModels(task: QvmCall): string[] {
  const model = (t: QvmCall) => t.args.slice(3).filter((r) => !isCall(r))[3];
  const kids = task.args.slice(3).filter(isCall).filter((c) => c.args[1] === "Train");
  return [task, ...kids].map(model).filter((m): m is string => typeof m === "string" && MODEL_NAME.test(m));
}

const isTrue = (v: QvmValue | undefined) => v === 1 || (typeof v === "object" && "ident" in v && v.ident === "TRUE");

function isCall(v: QvmValue): v is QvmCall {
  return typeof v === "object" && "fn" in v;
}
