// Vehicle motion for Car, Heli and Plane tasks.
//
// IGI drives its scripted vehicles with the rigid-body physics in physicsobj/ (cars/*/car.qvm, helis/*/heli.qvm,
// planes/*/plane.qvm) fed by control inputs recorded in the editor: an AnimTask whose TargetID is the vehicle plays
// back its AnimData, a list of (channel, value) pairs where channel 32 waits `value` ticks (30 Hz) and the others set
// an input. Two kinds of channel appear (docs/formats/dynamic.md):
//   - axes (steering, cyclic, pedals: values -1, 0, 1) hold their value until the next key;
//   - levers (throttle, collective, brake, gear: a value, then -1 one or two ticks later) keep the last value set,
//     -1 meaning "key released".
// We do not run IGI's physics (its DefinePhysicsObjType parameters are mostly undecoded); these are simple models
// tuned so the recorded inputs give plausible paths: cars follow the ground with a bicycle steering model, helicopters
// tilt their rotor thrust, planes fly along their nose. Pure TypeScript: the caller passes a ground query.

import type { Vec3 } from "../coords.ts";

const METRE = 4096;
const G = 9.8 * METRE;
export const WAIT_CHANNEL = 32;

export type VehicleKind = "car" | "heli" | "plane";

/** Control inputs by channel (see the header): the latest value set on each channel by the AnimData. */
export type Inputs = ReadonlyMap<number, number>;

export interface VehicleState {
  /** Model origin, absolute IGI units. */
  position: Vec3;
  /** Euler angles as objects.qvm stores them: [pitch about X, roll about Y, heading about Z]. */
  orientation: Vec3;
  /** World velocity, units per second. */
  velocity: Vec3;
  /** Pitch, roll and yaw rates (rad/s) for aircraft; the front-wheel angle for cars in [0]. */
  rates: Vec3;
  /** Lever channels' current values (throttle, collective, brake). */
  levers: Map<number, number>;
  /** Forward speed (cars and planes), units per second. */
  speed: number;
}

export interface VehicleSpec {
  kind: VehicleKind;
  /** Length of the model along +Y (its forward axis), units: the wheelbase is taken from it. */
  length: number;
  /** Height of the model's lowest point below its origin (units, positive down): cars sit on the ground by it. */
  bottom: number;
  /** "Original Thrust": the throttle (cars, planes) or collective (helicopters) lever's starting value. */
  thrust: number;
}

/** Highest surface under (x, y) below z: its height and upward normal. */
export type GroundQuery = (x: number, y: number, z: number) => { z: number; normal: Vec3 } | null;

export function newVehicleState(position: Vec3, orientation: Vec3, velocity: Vec3, spec: VehicleSpec): VehicleState {
  const levers = new Map<number, number>();
  levers.set(spec.kind === "heli" ? HELI.collective : spec.kind === "plane" ? PLANE.throttle : CAR.throttle, spec.thrust);
  const speed = Math.hypot(velocity[0], velocity[1], velocity[2]);
  // Stored angles run 0..2π: bring pitch and roll to -π..π so the tilt limits apply.
  const o: Vec3 = [wrap(orientation[0]), wrap(orientation[1]), orientation[2]];
  return { position: [...position], orientation: o, velocity: [...velocity], rates: [0, 0, 0], levers, speed };
}

/** Lever channels of each kind (value -1 = released, keep the last value). Others are axes. */
const CAR = { steer: 0, throttle: 1, brake: 3, levers: new Set([1, 3, 4]) };
const HELI = { roll: 1, pitch: 0, yaw: 2, collective: 3, levers: new Set([3]) };
/** Channel mapping (our reading, not confirmed): channel 0 is the fore/aft cyclic (+1 nose down), 1 the lateral cyclic. */
const HELI_SIGNS = { pitch: -1, roll: 1, yaw: -1, pitchChannel: 0, rollChannel: 1 };
const PLANE = { roll: 0, pitch: 1, yaw: 2, throttle: 3, levers: new Set([3, 5, 6, 7, 8, 9]) };

/** Apply one AnimData key to the state's levers; returns true if it was a lever. */
export function applyKey(state: VehicleState, kind: VehicleKind, channel: number, value: number): boolean {
  const levers = kind === "car" ? CAR.levers : kind === "heli" ? HELI.levers : PLANE.levers;
  if (!levers.has(channel)) return false;
  if (value !== -1) state.levers.set(channel, value);
  else if (kind === "car" && channel === CAR.brake) state.levers.set(channel, 0);
  return true;
}

const axis = (inputs: Inputs, channel: number) => {
  const v = inputs.get(channel) ?? 0;
  return Math.max(-1, Math.min(1, v));
};

/** Advance a vehicle by dt seconds. */
export function stepVehicle(s: VehicleState, spec: VehicleSpec, inputs: Inputs, dt: number, ground: GroundQuery) {
  if (spec.kind === "car") stepCar(s, spec, inputs, dt, ground);
  else if (spec.kind === "heli") stepHeli(s, spec, inputs, dt, ground);
  else stepPlane(s, spec, inputs, dt, ground);
}

// ------------------------------------------------------------------------------------------------------------ cars

/** Throttle 1 = this speed; the recorded levers are mostly 0.125 .. 0.5. */
/** Car model constants (exported so tools can fit them against the levels' arrival areas). */
// Fitted so the Mission 7 truck (Car_351, 233 s of recorded input) passes its four CRITERIA_VEHICLE areas in order.
export const CAR_TUNING = { maxSpeed: 18.5 * METRE, accel: 6.5 * METRE, brake: 8 * METRE, maxSteer: 0.79, steerRate: 1.71, wheelbase: 0.6 };

function stepCar(s: VehicleState, spec: VehicleSpec, inputs: Inputs, dt: number, ground: GroundQuery) {
  // Front wheels turn towards the steering input.
  const T = CAR_TUNING;
  const want = axis(inputs, CAR.steer) * T.maxSteer;
  s.rates[0] += Math.max(-T.steerRate * dt, Math.min(T.steerRate * dt, want - s.rates[0]));
  const throttle = s.levers.get(CAR.throttle) ?? 0;
  const braking = (s.levers.get(CAR.brake) ?? 0) > 0;
  const target = braking ? 0 : throttle * T.maxSpeed;
  const rate = braking ? T.brake : T.accel;
  s.speed += Math.max(-rate * dt, Math.min(rate * dt, target - s.speed));
  const wheelbase = Math.max(2 * METRE, spec.length * T.wheelbase);
  // Positive steering turns right (heading decreases).
  const heading = s.orientation[2] - ((s.speed * Math.tan(s.rates[0])) / wheelbase) * dt;
  const fx = -Math.sin(heading);
  const fy = Math.cos(heading);
  const x = s.position[0] + fx * s.speed * dt;
  const y = s.position[1] + fy * s.speed * dt;
  // Follow the ground: height under the centre, pitch from front and back, roll from the sides.
  const z0 = s.position[2] - spec.bottom + 2 * METRE;
  const g = ground(x, y, z0);
  let z = g ? g.z : s.position[2] - spec.bottom;
  let pitch = 0;
  let roll = 0;
  const half = spec.length * 0.35;
  const front = ground(x + fx * half, y + fy * half, z0);
  const back = ground(x - fx * half, y - fy * half, z0);
  if (front && back) {
    pitch = Math.atan2(front.z - back.z, 2 * half);
    z = Math.max(z, (front.z + back.z) / 2);
  }
  const side = 1 * METRE;
  const right = ground(x + fy * side, y - fx * side, z0);
  const left = ground(x - fy * side, y + fx * side, z0);
  if (right && left) roll = Math.atan2(left.z - right.z, 2 * side);
  // Without ground (off the terrain) keep the height.
  z = !g && !front ? s.position[2] : z + spec.bottom;
  s.velocity = [(x - s.position[0]) / dt, (y - s.position[1]) / dt, (z - s.position[2]) / dt];
  s.position = [x, y, z];
  s.orientation = [pitch, roll, heading];
}

// ----------------------------------------------------------------------------------------------------- helicopters

/** Cyclic and pedal inputs are angular accelerations, damped (rad/s², 1/s). */
const HELI_TILT_ACCEL = 2.0;
const HELI_YAW_ACCEL = 1.5;
const HELI_RATE_DAMPING = 2.5;
/** Horizontal drag (1/s) and vertical drag. */
const HELI_DRAG = 0.15;
const HELI_DRAG_Z = 1.0;
const HELI_MAX_TILT = 0.9;

function stepHeli(s: VehicleState, spec: VehicleSpec, inputs: Inputs, dt: number, ground: GroundQuery) {
  const r = s.rates;
  const k = HELI_SIGNS;
  r[0] += (axis(inputs, k.pitchChannel) * k.pitch * HELI_TILT_ACCEL - r[0] * HELI_RATE_DAMPING) * dt;
  r[1] += (axis(inputs, k.rollChannel) * k.roll * HELI_TILT_ACCEL - r[1] * HELI_RATE_DAMPING) * dt;
  r[2] += (axis(inputs, HELI.yaw) * k.yaw * HELI_YAW_ACCEL - r[2] * HELI_RATE_DAMPING) * dt;
  const o = s.orientation;
  o[0] = clamp(o[0] + r[0] * dt, -HELI_MAX_TILT, HELI_MAX_TILT);
  o[1] = clamp(o[1] + r[1] * dt, -HELI_MAX_TILT, HELI_MAX_TILT);
  o[2] += r[2] * dt;
  // Rotor thrust along the body's up axis; collective 1 holds a level hover, more is needed to hold height while
  // tilted into forward flight.
  const collective = s.levers.get(HELI.collective) ?? 1;
  const up = bodyUp(o);
  const thrust = collective * G;
  const v = s.velocity;
  v[0] += (up[0] * thrust - v[0] * HELI_DRAG) * dt;
  v[1] += (up[1] * thrust - v[1] * HELI_DRAG) * dt;
  v[2] += (up[2] * thrust - G - v[2] * HELI_DRAG_Z) * dt;
  const p = s.position;
  const next: Vec3 = [p[0] + v[0] * dt, p[1] + v[1] * dt, p[2] + v[2] * dt];
  const g = ground(next[0], next[1], next[2] + spec.bottom + METRE);
  if (g && next[2] - spec.bottom < g.z) {
    // Landed: rest on the skids and settle level.
    next[2] = g.z + spec.bottom;
    v[0] *= 0.8;
    v[1] *= 0.8;
    v[2] = Math.max(0, v[2]);
    o[0] *= 0.8;
    o[1] *= 0.8;
  }
  s.position = next;
  s.speed = Math.hypot(v[0], v[1], v[2]);
}

// ----------------------------------------------------------------------------------------------------------- planes

const PLANE_MAX_SPEED = 110 * METRE;
const PLANE_ACCEL = 8 * METRE;
const PLANE_ROTATE_SPEED = 50 * METRE;
const PLANE_PITCH_ACCEL = 1.0;
const PLANE_ROLL_ACCEL = 2.0;
const PLANE_YAW_ACCEL = 0.5;
const PLANE_RATE_DAMPING = 2.0;

function stepPlane(s: VehicleState, spec: VehicleSpec, inputs: Inputs, dt: number, ground: GroundQuery) {
  const throttle = s.levers.get(PLANE.throttle) ?? 0;
  s.speed += clamp(throttle * PLANE_MAX_SPEED - s.speed, -PLANE_ACCEL * dt, PLANE_ACCEL * dt);
  const r = s.rates;
  const o = s.orientation;
  r[0] += (axis(inputs, PLANE.pitch) * PLANE_PITCH_ACCEL - r[0] * PLANE_RATE_DAMPING) * dt;
  r[1] += (axis(inputs, PLANE.roll) * PLANE_ROLL_ACCEL - r[1] * PLANE_RATE_DAMPING) * dt;
  r[2] += (-axis(inputs, PLANE.yaw) * PLANE_YAW_ACCEL - r[2] * PLANE_RATE_DAMPING) * dt;
  o[0] = clamp(o[0] + r[0] * dt, -1.2, 1.2);
  o[1] = clamp(o[1] + r[1] * dt, -1.3, 1.3);
  // A banked plane turns towards the lower wing (roll right, heading decreases).
  const turn = s.speed > METRE ? (G * Math.tan(o[1])) / s.speed : 0;
  o[2] += (r[2] - turn * Math.cos(o[0])) * dt;
  const f = bodyForward(o);
  const p = s.position;
  // Below flying speed the nose cannot hold the plane up.
  const sink = s.speed < PLANE_ROTATE_SPEED ? G * 0.5 * (1 - s.speed / PLANE_ROTATE_SPEED) : 0;
  const next: Vec3 = [p[0] + f[0] * s.speed * dt, p[1] + f[1] * s.speed * dt, p[2] + (f[2] * s.speed - sink) * dt];
  const g = ground(next[0], next[1], next[2] + spec.bottom + METRE);
  if (g && next[2] - spec.bottom < g.z) {
    next[2] = g.z + spec.bottom;
    if (s.speed < PLANE_ROTATE_SPEED || o[0] < 0) o[0] = Math.max(0, o[0] * 0.5);
    o[1] *= 0.5;
  }
  s.velocity = [(next[0] - p[0]) / dt, (next[1] - p[1]) / dt, (next[2] - p[2]) / dt];
  s.position = next;
}

// -------------------------------------------------------------------------------------------------------- helpers

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const wrap = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));

/** R = Rz(c) Ry(b) Rx(a) applied to a model-space vector. */
export function rotate(o: Vec3, v: Vec3): Vec3 {
  const [a, b, c] = o;
  // Rx
  let x = v[0];
  let y = v[1] * Math.cos(a) - v[2] * Math.sin(a);
  let z = v[1] * Math.sin(a) + v[2] * Math.cos(a);
  // Ry
  const x2 = x * Math.cos(b) + z * Math.sin(b);
  z = -x * Math.sin(b) + z * Math.cos(b);
  x = x2;
  // Rz
  const x3 = x * Math.cos(c) - y * Math.sin(c);
  y = x * Math.sin(c) + y * Math.cos(c);
  return [x3, y, z];
}

const bodyUp = (o: Vec3) => rotate(o, [0, 0, 1]);
const bodyForward = (o: Vec3) => rotate(o, [0, 1, 0]);

/** Decode AnimData (count, then channel/value pairs; channel 32 waits value ticks) into timed keys. */
export function decodeAnimData(data: readonly number[]): { tick: number; channel: number; value: number }[] {
  const keys: { tick: number; channel: number; value: number }[] = [];
  const count = data[0] ?? 0;
  let tick = 0;
  for (let k = 0; k < count && 2 + k * 2 < data.length + 1; k++) {
    const channel = data[1 + k * 2];
    const value = data[2 + k * 2];
    if (channel === undefined || value === undefined) break;
    if (channel === WAIT_CHANNEL) tick += value;
    else keys.push({ tick, channel, value });
  }
  return keys;
}

/** How far ahead (world units) and how sharply off the nose a vehicle area still guides a car, and how hard. */
const GUIDE_RANGE = 80 * METRE;
const GUIDE_CONE = 1.0;
const GUIDE_RATE = 0.6;

/**
 * Recorded inputs replayed through our approximate car model drift by metres over a long drive, while level scripts
 * need the car inside their CRITERIA_VEHICLE areas (Mission 7's border-crossing truck opens the gates and ends the
 * mission by entering them). A car moving towards such an area turns gently onto it. `targets` are area centres.
 */
export function guideCar(s: VehicleState, targets: readonly Vec3[], dt: number) {
  if (s.speed <= METRE) return;
  const heading = s.orientation[2];
  let best: { d: number; turn: number } | null = null;
  for (const t of targets) {
    const dx = t[0] - s.position[0];
    const dy = t[1] - s.position[1];
    const d = Math.hypot(dx, dy);
    if (d > GUIDE_RANGE || d < METRE) continue;
    const turn = wrap(Math.atan2(-dx, dy) - heading);
    if (Math.abs(turn) > GUIDE_CONE) continue;
    if (!best || d < best.d) best = { d, turn };
  }
  if (best) s.orientation[2] = heading + clamp(best.turn, -GUIDE_RATE * dt, GUIDE_RATE * dt);
}

/**
 * Drive a car towards `target` at `speed` (units/s) by setting its steering input and throttle lever, as a CarAI
 * driver does along its PatrolPath (null target: brake to a stop).
 */
export function autopilot(s: VehicleState, target: Vec3 | null, speed: number, inputs: Map<number, number>) {
  if (!target) {
    inputs.set(CAR.steer, 0);
    s.levers.set(CAR.throttle, 0);
    s.levers.set(CAR.brake, 1);
    return;
  }
  const want = Math.atan2(-(target[0] - s.position[0]), target[1] - s.position[1]);
  const turn = wrap(want - s.orientation[2]);
  // Positive steering turns right (heading decreases).
  inputs.set(CAR.steer, clamp(-turn * 2, -1, 1));
  // Slow down for sharp turns.
  const slow = Math.abs(turn) > 0.6 ? 0.4 : 1;
  s.levers.set(CAR.throttle, (speed * slow) / CAR_TUNING.maxSpeed);
  s.levers.set(CAR.brake, 0);
}
