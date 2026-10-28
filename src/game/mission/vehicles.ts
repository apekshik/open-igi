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
// tilt their rotor thrust (rate-command cyclic, fitted to the levels' cutscenes and scripts), planes fly along their
// nose. Pure TypeScript: the caller passes a ground query.

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
  /** A helicopter resting on the ground. */
  landed?: boolean;
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
// Fitted against Mission 7's level script with the AnimTask gating as the game runs it (Car_351, 233 s of input): the
// truck must stop in the hamlet strip (AreaActivate_169) when its AnimTask pauses at LevelTimer_2500 tick 2650, wait
// 10 s, then pass the front gate, "Game complete" and rear gate areas before tick 4330. Holds with every constant
// varied by 10-15 %.
export const CAR_TUNING = { maxSpeed: 12.57 * METRE, accel: 3.35 * METRE, brake: 8 * METRE, maxSteer: 0.88, steerRate: 0.82, wheelbase: 0.6 };

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

/**
 * Helicopter model constants, fitted to where the levels' scripts and cutscene cameras expect the recorded flights to
 * be (docs/formats/dynamic.md, "Helicopters"): the cyclic and pedal inputs are rate commands (the tilt or heading
 * changes while a key is held and stays when it is released: the recordings are short taps that a pilot corrects with
 * opposite taps), the collective lever scales rotor thrust along the body's up axis (hover a little above 1).
 *  - pitchRate, rollRate, yawRate: rad/s while channel 0 (-1 nose down), 1 (+1 bank right), 2 (+1 turn right) is held;
 *  - lift: thrust per unit collective, in g (hover at 1 / lift);
 *  - groundEffect, groundEffectHeight: extra thrust near the ground, fading out by that height (m). Mission 10's Huey
 *    lifts off a hillside and skims it at collective 1.04 before descending to the town at 0.96;
 *  - liftOff: thrust (g) a landed helicopter needs to leave the ground (Mission 3's insertion helicopter lands at
 *    collective 0.92, then sets 1.04 while Jones jumps out; Mission 10's roof helicopter takes off at 1.2);
 *  - drag, dragZ: horizontal and vertical velocity damping (1/s); maxClimb: vertical speed limit (m/s, our choice:
 *    the intro flights hold collective 1.5 for a minute); maxSpeed: horizontal speed limit (m/s, our choice: the long
 *    gunship patrols of Missions 7 and 10 lean further and further forward, about 250 km/h is a Mi-24's top speed);
 *  - hoverBrake: deceleration (m/s²) of a helicopter holding a hover once its recording has ended.
 */
export const HELI_TUNING = {
  pitchRate: 0.03,
  rollRate: 0.06,
  yawRate: 0.08,
  rateLag: 0.2,
  maxTilt: 0.6,
  lift: 0.98,
  groundEffect: 0.08,
  groundEffectHeight: 20,
  liftOff: 1.12,
  drag: 0.02,
  dragZ: 0.3,
  maxClimb: 4,
  maxSpeed: 70,
  hoverBrake: 6,
};

function stepHeli(s: VehicleState, spec: VehicleSpec, inputs: Inputs, dt: number, ground: GroundQuery) {
  const T = HELI_TUNING;
  const r = s.rates;
  const o = s.orientation;
  const lag = Math.min(1, dt / T.rateLag);
  r[0] += (axis(inputs, HELI.pitch) * T.pitchRate - r[0]) * lag;
  r[1] += (axis(inputs, HELI.roll) * T.rollRate - r[1]) * lag;
  r[2] += (-axis(inputs, HELI.yaw) * T.yawRate - r[2]) * lag;
  o[0] = clamp(o[0] + r[0] * dt, -T.maxTilt, T.maxTilt);
  o[1] = clamp(o[1] + r[1] * dt, -T.maxTilt, T.maxTilt);
  o[2] += r[2] * dt;
  const collective = s.levers.get(HELI.collective) ?? 1;
  const up = bodyUp(o);
  const p = s.position;
  const below = ground(p[0], p[1], p[2] - spec.bottom + METRE);
  const height = below ? (p[2] - spec.bottom - below.z) / METRE : Infinity;
  const thrust = collective * T.lift * G * (1 + T.groundEffect * Math.max(0, 1 - height / T.groundEffectHeight));
  const v = s.velocity;
  if (s.landed && up[2] * thrust < T.liftOff * G) {
    // Not enough to take off: sit on the skids and settle level.
    s.velocity = [0, 0, 0];
    s.rates = [0, 0, 0];
    o[0] *= 0.8;
    o[1] *= 0.8;
    s.speed = 0;
    return;
  }
  v[0] += (up[0] * thrust - v[0] * T.drag) * dt;
  v[1] += (up[1] * thrust - v[1] * T.drag) * dt;
  v[2] = clamp(v[2] + (up[2] * thrust - G - v[2] * T.dragZ) * dt, -T.maxClimb * METRE, T.maxClimb * METRE);
  const horizontal = Math.hypot(v[0], v[1]);
  if (horizontal > T.maxSpeed * METRE) {
    v[0] *= (T.maxSpeed * METRE) / horizontal;
    v[1] *= (T.maxSpeed * METRE) / horizontal;
  }
  moveHeli(s, spec, dt, ground);
}

/**
 * A helicopter whose recording has ended (or has none) holds a hover where it is: it levels out and brakes to a stop
 * (Mission 10's Huey waits over the roof for Priboi). A landed one stays on the ground.
 */
export function hoverHeli(s: VehicleState, spec: VehicleSpec, dt: number, ground: GroundQuery) {
  const T = HELI_TUNING;
  const o = s.orientation;
  s.rates = [0, 0, 0];
  const level = 0.3 * dt;
  o[0] -= clamp(o[0], -level, level);
  o[1] -= clamp(o[1], -level, level);
  const v = s.velocity;
  const speed = Math.hypot(v[0], v[1], v[2]);
  const k = speed > 0 ? Math.max(0, speed - T.hoverBrake * METRE * dt) / speed : 0;
  s.velocity = [v[0] * k, v[1] * k, v[2] * k];
  moveHeli(s, spec, dt, ground);
}

function moveHeli(s: VehicleState, spec: VehicleSpec, dt: number, ground: GroundQuery) {
  const v = s.velocity;
  const o = s.orientation;
  const p = s.position;
  const next: Vec3 = [p[0] + v[0] * dt, p[1] + v[1] * dt, p[2] + v[2] * dt];
  const g = ground(next[0], next[1], next[2] + spec.bottom + METRE);
  s.landed = !!g && next[2] - spec.bottom <= g.z + 1;
  if (g && s.landed) {
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

/** How long AnimData runs, in ticks: its waits added up. */
export function animLength(data: readonly number[]): number {
  let ticks = 0;
  for (const k of decodeAnimDataRaw(data)) if (k.channel === WAIT_CHANNEL) ticks += k.value;
  return ticks;
}

function* decodeAnimDataRaw(data: readonly number[]) {
  const count = data[0] ?? 0;
  for (let k = 0; k < count; k++) {
    const channel = data[1 + k * 2];
    const value = data[2 + k * 2];
    if (channel === undefined || value === undefined) return;
    yield { channel, value };
  }
}

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

/**
 * How far ahead (world units) and how far off the nose (radians) a vehicle area still guides a car, and how fast the car
 * is shifted sideways onto it (world units per second).
 */
export const GUIDE = { range: 68 * METRE, cone: 1.2, rate: 2.33 * METRE, far: 990 * METRE, pull: 0.03 };

/**
 * Recorded inputs replayed through our approximate car model drift by metres over a long drive, while level scripts
 * need the car inside their CRITERIA_VEHICLE areas (Mission 7's border-crossing truck must wait 10 s in the hamlet strip,
 * then open the gates and end the mission by entering them). A car heading for such an area is shifted sideways onto the
 * line through it, a little each tick, without turning: the heading, and so the rest of the recorded drive, is kept.
 * `targets` are the centres of the areas the car has not been in yet; the nearest is taken as the next.
 */
export function guideCar(s: VehicleState, targets: readonly Vec3[], dt: number) {
  if (s.speed <= METRE) return;
  const heading = s.orientation[2];
  const fx = -Math.sin(heading);
  const fy = Math.cos(heading);
  let best: { d: number; side: number; turn: number } | null = null;
  for (const t of targets) {
    const dx = t[0] - s.position[0];
    const dy = t[1] - s.position[1];
    const d = Math.hypot(dx, dy);
    if (d > GUIDE.far || d < METRE) continue;
    const turn = wrap(Math.atan2(-dx, dy) - heading);
    if (!best || d < best.d) best = { d, side: dx * fy - dy * fx, turn };
  }
  // The nearest area not yet visited is the next one on the way; it guides only while roughly ahead.
  if (!best || Math.abs(best.turn) > GUIDE.cone) return;
  // Far out, a slow turn takes out the heading the replay has drifted by; close in, a sideways shift lines it up.
  s.orientation[2] = heading + clamp(best.turn, -GUIDE.pull * dt, GUIDE.pull * dt);
  if (best.d > GUIDE.range) return;
  // Right of the heading is (fy, -fx); `side` is how far the area's centre lies to that side.
  const shift = clamp(best.side, -GUIDE.rate * dt, GUIDE.rate * dt);
  s.position = [s.position[0] + fy * shift, s.position[1] - fx * shift, s.position[2]];
}

/**
 * Drive a car towards `target` at `speed` (units/s) by setting its steering input and throttle lever, as a CarAI
 * driver does along its PatrolPath (null target: brake to a stop; `reverse`: back straight up towards it).
 */
export function autopilot(s: VehicleState, target: Vec3 | null, speed: number, inputs: Map<number, number>, reverse = false) {
  if (!target) {
    inputs.set(CAR.steer, 0);
    s.levers.set(CAR.throttle, 0);
    s.levers.set(CAR.brake, 1);
    return;
  }
  if (reverse) {
    // Straight back (the target lies behind).
    inputs.set(CAR.steer, 0);
    s.levers.set(CAR.throttle, -speed / CAR_TUNING.maxSpeed);
    s.levers.set(CAR.brake, 0);
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
