// Mission logic: the event-driven half of objects.qvm.
//
// IGI levels have no mission script with control flow; mission.qvm only declares the mission (DefineMission). The
// logic lives in objects.qvm as a tree of logic tasks whose VarString parameters are QSC expressions over other
// tasks' fields: EditVariable_105.Add = "EditVariable_105.nValue == 0 && AreaActivate_200.nActive",
// DefineComputerObjective_104 completes when "EditVariable_105.nValue == 1", LevelFlow_10 ends the level when
// "CutScene_1204.isFinished". MissionLogic builds one runtime object per logic task and re-evaluates every
// expression at the engine's fixed tick rate (GAME_FREQUENCY = 30 ticks/s, read from IGI.exe's constant table), so
// tick counts in the scripts (`nTick > 120*GAME_FREQUENCY`, `nDoorOpenTicks == 5*GAME_FREQUENCY`) mean what they
// meant in the original.
//
// A ConditionalContainer gates its whole subtree: children only exist (tick, count, render, take input) while the
// container's Condition holds. That is how levels sequence intro cutscene → gameplay → outro: the HumanPlayer task
// itself sits in a container that runs once the intro is over or skipped.
//
// This module is plain TypeScript (no three.js) so it runs in Node for verification. The game binds it to the world
// through MissionWorld and renders the objects in objects.ts. Field and parameter semantics are documented in
// docs/formats/mission.md.

import { decodeQvmScript, type QvmValue } from "../../formats/qvm.ts";
import { vec3, type Vec3 } from "../coords.ts";
import type { Entity } from "../entity.ts";
import type { GameEvents } from "../events.ts";
import { evaluate, parseExpression, run, truthy, type ScriptEnv, type ScriptValue } from "./script.ts";
import { pbool, pnum, pstr, pvec, type TaskNode, type TaskTree } from "./tasks.ts";
import { applyKey, autopilot, decodeAnimData, guideCar, newVehicleState, stepVehicle, type VehicleKind, type VehicleSpec, type VehicleState } from "./vehicles.ts";

/** Ticks per second of the logic clock (IGI.exe registers GAME_FREQUENCY = 30). */
export const GAME_FREQUENCY = 30;
const METRE = 4096;
/** How far from the player's eye an object can be used (F). */
export const USE_RANGE = 2.2 * METRE;

/** What mission logic needs from the running game. Everything is optional-safe so Node tests can stub it. */
export interface MissionWorld {
  /** The player's entity (feet position, alive), or null before it exists. */
  player(): Entity | null;
  entities(): Entity[];
  byTask(taskId: number): Entity | undefined;
  /** Static-geometry line of sight; missing physics means "visible". */
  lineOfSight(from: Vec3, to: Vec3): boolean;
  /** AI awareness of a soldier task (HumanAI.isDetection): true when it has noticed the player. */
  aiDetects(soldierTaskId: number): boolean;
  /** How many guards a GuardGenerator task has spawned (the AI system spawns them). Optional for Node tests. */
  aiSpawns?(generatorTaskId: number): number;
  /** Text by key (StatusMessage Text, objective texts). */
  text(key: string): string | undefined;
  /**
   * Highest surface under (x, y) at or below z (terrain, static models and other moving objects, not the object of
   * task `ignoreTaskId` itself). Vehicles follow it; optional for Node tests.
   */
  ground?(x: number, y: number, z: number, ignoreTaskId?: number): { z: number; normal: Vec3 } | null;
  /** The world system's train for a Train task id, which the mission's AnimTasks drive. */
  train?(taskId: number): TrainControl | undefined;
  /** Model extents for vehicles: length along +Y and depth of the lowest point below the origin (world units). */
  modelExtent?(model: string): { length: number; bottom: number } | null;
  /** AIGraph route from near `from` to a node (AiService.graphRoute): undefined while loading, null if none. */
  route?(graphId: number, from: Vec3, toNode: number): Vec3[] | null | undefined;
}

/** What the mission controls of a train (WorldService.train). */
export interface TrainControl {
  /** Its task exists (its ConditionalContainer runs): shown, colliding and simulated. */
  active: boolean;
  running: boolean;
  /** Thrust lever (AnimData channel 0), m/s² as the world system reads "Original thrust". */
  throttle: number;
}

type Emit = <K extends keyof GameEvents>(type: K, payload: GameEvents[K]) => void;

/** A compiled expression parameter. Empty strings compile to null (no expression). */
type Expr = QvmValue | null;

// ------------------------------------------------------------------------------------------------------ base runtime

export abstract class LogicTask {
  readonly node: TaskNode;
  readonly key: string;
  /** False while an enclosing ConditionalContainer is not running. */
  active = false;
  protected L: MissionLogic;

  constructor(node: TaskNode, L: MissionLogic) {
    this.node = node;
    this.L = L;
    this.key = `${node.type}_${node.id}`;
  }

  /** A script-visible field (`Door_408.isOpen`). Undefined means the field is unknown for this type. */
  abstract field(name: string): ScriptValue | undefined;
  /** One logic tick while active. */
  tick(): void {}
  /** The task stopped being active (its container stopped). */
  deactivate(): void {}

  /** Plain-data fields as constructed (numbers, strings, booleans, arrays of them), for restart(). */
  private initial: [string, unknown][] = [];

  /** Remember the freshly constructed state. Called once by MissionLogic after every task exists. */
  snapshot() {
    this.initial = Object.entries(this).filter(([k, v]) => k !== "initial" && k !== "active" && isPlainData(v)).map(([k, v]) => [k, structuredClone(v)]);
  }

  /** Back to the constructed state: the engine restarts a ConditionalContainer's contents from scratch. */
  restart() {
    for (const [k, v] of this.initial) (this as Record<string, unknown>)[k] = structuredClone(v);
  }

  protected expr(param: string): Expr {
    return this.L.compile(pstr(this.node, param), this.key, param);
  }
  /** Evaluate an expression with `this` bound to this task; null (empty) gives `fallback`. */
  protected test(e: Expr, fallback = false): boolean {
    return e === null ? fallback : truthy(this.L.eval(e, this));
  }
}

/** Something the player can use with F (doors, switches, terminals, pickups, timed actions). */
export interface Usable {
  /** World position used for range checks. */
  usePosition(): Vec3;
  /** Can be used right now (enabled, not finished, not destroyed). */
  canUse(): boolean;
  /** Seconds the use key must be held (0 = instant). */
  holdTime(): number;
  /** Text for the HUD prompt. */
  useText(): string;
  /** Called when the use completes (immediately for instant uses). `user` is the entity id. */
  use(user: number | null): void;
}

function isPlainData(v: unknown): boolean {
  if (v === null || ["number", "string", "boolean", "undefined"].includes(typeof v)) return true;
  return Array.isArray(v) && v.every((x) => x === null || ["number", "string", "boolean"].includes(typeof x));
}

export function isUsable(t: LogicTask): t is LogicTask & Usable {
  return typeof (t as Partial<Usable>).use === "function";
}

/** Shared state for tasks that can be shot or blown up (the ExplodeObject parameter block). */
export interface Explodable {
  /** Applied damage in IGI damage units; destroyed once it exceeds the object's "Damage scale". */
  damage(amount: number, part?: string): void;
  readonly exploded: boolean;
}

export function isExplodable(t: LogicTask): t is LogicTask & Explodable {
  return typeof (t as Partial<Explodable>).damage === "function";
}

// ------------------------------------------------------------------------------------------------ the logic engine

export interface ObjectiveState {
  /** Stable index across the level's objective definitions. */
  index: number;
  key: string;
  text: string;
  state: "active" | "completed" | "failed";
  /** Shown in the objective list right now (its DefineComputerObjective is active and valid). */
  visible: boolean;
  /** Task id of the map position the objective links to, or -1. */
  link: number;
}

export interface MissionEnd {
  success: boolean;
  reason: string;
}

export class MissionLogic {
  readonly tree: TaskTree;
  readonly world: MissionWorld;
  readonly emit: Emit;
  readonly tasks: LogicTask[] = [];
  readonly byKey = new Map<string, LogicTask>();
  readonly byNode = new Map<TaskNode, LogicTask>();
  /** Logic ticks since the level started. */
  tickCount = 0;
  /** Seconds of logic time. */
  time = 0;
  /** MenuManager_SetEnabled state: scripts disable the menu for the length of every cutscene. */
  menuEnabled = true;
  musicEnabled = true;
  ended: MissionEnd | null = null;
  readonly objectives: ObjectiveState[] = [];
  /** Expressions that failed to compile, for diagnostics. */
  readonly errors: string[] = [];

  private accumulator = 0;
  private compiled = new Map<string, Expr>();
  private self: LogicTask | null = null;
  private pulses: (() => void)[] = [];
  private pendingPulses: (() => void)[] = [];
  private breakKey = false;
  private alarmOn = false;
  private env: ScriptEnv;

  constructor(tree: TaskTree, world: MissionWorld, emit: Emit) {
    this.tree = tree;
    this.world = world;
    this.emit = emit;
    this.env = {
      get: (ident) => this.ident(ident),
      call: (fn, args) => this.call(fn, args),
    };
    for (const node of tree.all) {
      const make = RUNTIMES[node.type];
      const t = make ? make(node, this) : node.id >= 0 ? new EntityTask(node, this) : null;
      if (!t) continue;
      this.tasks.push(t);
      this.byNode.set(node, t);
      if (node.id >= 0 && !this.byKey.has(t.key)) this.byKey.set(t.key, t);
    }
    for (const t of this.tasks) t.snapshot();
    this.updateActive();
  }

  // ---- scripting

  compile(src: string, owner: string, param: string): Expr {
    const s = src.trim();
    if (!s) return null;
    const cached = this.compiled.get(s);
    if (cached !== undefined) return cached;
    let e: Expr = null;
    try {
      e = parseExpression(s);
    } catch (err) {
      this.errors.push(`${owner}.${param}: ${JSON.stringify(s)}: ${(err as Error).message}`);
    }
    this.compiled.set(s, e);
    return e;
  }

  eval(e: QvmValue, self: LogicTask | null = null): ScriptValue {
    const prev = this.self;
    this.self = self;
    try {
      return evaluate(e, this.env);
    } finally {
      this.self = prev;
    }
  }

  /**
   * A task variable by its script name ("CutScene_1200.nTick", "EditVariable_4004.nValue"), or undefined when no task
   * of that name has the field. The audio system resolves ConditionalSound conditions through this.
   */
  /** Write a task variable from an AI script ("EditVariable_173.nValue"); only EditVariable values are writable. */
  setVariable(name: string, value: number) {
    const dot = name.lastIndexOf(".");
    const task = dot < 0 ? undefined : this.byKey.get(name.slice(0, dot));
    if (task instanceof EditVariableTask) task.setField(name.slice(dot + 1), value);
  }

  variable(name: string): number | undefined {
    const dot = name.lastIndexOf(".");
    if (dot < 0) {
      const c = CONSTANTS[name];
      return typeof c === "number" ? c : undefined;
    }
    const v = this.byKey.get(name.slice(0, dot))?.field(name.slice(dot + 1));
    return v === undefined ? undefined : typeof v === "number" ? v : Number(v) || 0;
  }

  /** Evaluate a source expression (other systems use this for e.g. AlarmLight or Fence expressions). */
  evaluateSource(src: string, selfTaskId?: number): ScriptValue {
    const e = this.compile(src, "external", "expression");
    if (e === null) return 0;
    const self = selfTaskId === undefined ? null : (this.tasks.find((t) => t.node.id === selfTaskId) ?? null);
    return this.eval(e, self);
  }

  private ident(ident: string): ScriptValue {
    const dot = ident.lastIndexOf(".");
    if (dot < 0) return CONSTANTS[ident] ?? ident; // text keys (M1_MSG_4) and criteria evaluate to their own name
    const owner = ident.slice(0, dot);
    const field = ident.slice(dot + 1);
    const task = owner === "this" ? this.self : this.byKey.get(owner);
    const v = task?.field(field);
    return v ?? 0;
  }

  private call(fn: string, args: ScriptValue[]): ScriptValue {
    switch (fn) {
      case "LevelFlow_GetBreakCutSceneKey":
        return this.breakKey ? 1 : 0;
      case "MenuManager_SetEnabled":
        this.menuEnabled = truthy(args[0] ?? 1);
        return 1;
      case "Game_DisableMusic":
        this.musicEnabled = false;
        return 1;
      case "Game_EnableMusic":
        this.musicEnabled = true;
        return 1;
      case "Game_CutsceneDelete":
        return 1;
      case "StatusMessageScreen_ClearMessages":
        // After the level ended (the outro stopping restarts the gameplay container) keep "Mission Complete!".
        if (!this.ended) this.emit("status:clear", {});
        return 1;
      case "DefineMission":
        return 1;
      default:
        if (!this.errors.includes(`unknown function ${fn}`)) this.errors.push(`unknown function ${fn}`);
        return 0;
    }
  }

  /** Make a one-tick flag visible for exactly the next full tick (isLastPressed, isHackedThisTick, ...). */
  pulse(set: () => void, clear: () => void) {
    this.pendingPulses.push(() => {
      set();
      this.pulses.push(clear);
    });
  }

  // ---- ticking

  /** Advance logic time by dt seconds (fixed GAME_FREQUENCY ticks). */
  private vehicleAreaTasks: AreaActivateTask[] | null = null;
  /** The CRITERIA_VEHICLE areas (scripted cars are guided into them). */
  vehicleAreas(): AreaActivateTask[] {
    this.vehicleAreaTasks ??= this.tasks.filter((t): t is AreaActivateTask => t instanceof AreaActivateTask && t.forVehicles);
    return this.vehicleAreaTasks;
  }

  /** How far the logic clock is into the next tick (0..1), for drawing moving objects between ticks. */
  get alpha(): number {
    return Math.min(1, this.accumulator * GAME_FREQUENCY);
  }

  update(dt: number, breakKey = false) {
    if (breakKey) this.breakKey = true;
    this.accumulator = Math.min(this.accumulator + dt, 0.5);
    while (this.accumulator >= 1 / GAME_FREQUENCY) {
      this.accumulator -= 1 / GAME_FREQUENCY;
      this.step();
      this.breakKey = false;
    }
  }

  step() {
    this.tickCount++;
    this.time = this.tickCount / GAME_FREQUENCY;
    const pending = this.pendingPulses;
    this.pendingPulses = [];
    for (const p of pending) p();

    // Pre-order walk: a container decides whether its subtree is active before its children tick.
    const visit = (node: TaskNode, parentActive: boolean) => {
      const t = this.byNode.get(node);
      let active = parentActive;
      if (t) {
        if (t.active !== parentActive) {
          t.active = parentActive;
          if (!parentActive) t.deactivate();
        }
        if (parentActive) t.tick();
        if (t instanceof ConditionalContainerTask) active = parentActive && t.running;
      }
      for (const c of node.children) visit(c, active);
    };
    for (const r of this.tree.roots) visit(r, true);

    this.updateObjectives();
    this.updateAlarm();

    for (const clear of this.pulses) clear();
    this.pulses = [];
  }

  /** Recompute `active` without ticking (initial state). */
  private updateActive() {
    const visit = (node: TaskNode, active: boolean) => {
      const t = this.byNode.get(node);
      if (t) t.active = active;
      const childActive = t instanceof ConditionalContainerTask ? active && t.running : active;
      for (const c of node.children) visit(c, childActive);
    };
    for (const r of this.tree.roots) visit(r, true);
  }

  /** Reset every task below `node` to its constructed state (a ConditionalContainer starting again). */
  restartSubtree(node: TaskNode) {
    const visit = (n: TaskNode) => {
      for (const c of n.children) {
        this.byNode.get(c)?.restart();
        visit(c);
      }
    };
    visit(node);
  }

  /** Is the HumanPlayer task active (the player exists in the level)? False during intro/outro cutscenes. */
  playerActive(): boolean {
    const p = this.tasks.find((t) => t.node.type === "HumanPlayer");
    return p ? p.active : true;
  }

  /** A cutscene is playing (a CutScene task runs, or the scripts disabled the menu for one). */
  cutscene(): CutSceneTask | null {
    for (const t of this.tasks) if (t instanceof CutSceneTask && t.active && t.running) return t;
    return null;
  }

  alarm(): boolean {
    return this.alarmOn;
  }

  end(success: boolean, reason: string) {
    if (this.ended) return;
    this.ended = { success, reason };
    if (success) {
      for (const o of this.objectives) {
        if (o.visible && o.state === "active") this.setObjective(o, "completed");
      }
    }
    this.message(success ? "MISSION_COMPLETE" : "MISSION_FAILED", 5);
    this.emit("mission:end", { success, reason });
  }

  /** Show a text key (or literal text) as a status message, unless the same text was just shown. */
  message(keyOrText: string, seconds = 4) {
    const text = this.world.text(keyOrText) ?? keyOrText;
    if (!text || (text === this.lastMessage.text && this.tickCount - this.lastMessage.tick < GAME_FREQUENCY)) return;
    this.lastMessage = { text, tick: this.tickCount };
    this.emit("message", { text, seconds });
  }
  private lastMessage = { text: "", tick: -1 };

  // ---- objectives

  /** Called by DefineComputerObjective tasks at construction, in tree order. */
  registerObjective(key: string, link: number): ObjectiveState {
    const o: ObjectiveState = {
      index: this.objectives.length,
      key,
      text: this.world.text(key) ?? key,
      state: "active",
      visible: false,
      link,
    };
    this.objectives.push(o);
    return o;
  }

  setObjective(o: ObjectiveState, state: ObjectiveState["state"]) {
    if (o.state === state) return;
    o.state = state;
    this.emit("objective", { index: o.index, state, text: o.text });
    if (state !== "active" && !this.ended) {
      const n = this.visibleObjectives().indexOf(o) + 1;
      const key = `OBJ_${n}_${state === "completed" ? "COMPLETE" : "FAILED"}`;
      this.message(this.world.text(key) ? key : state === "completed" ? "OBJECTIVE_COMPLETE" : "OBJECTIVE_FAILED");
    }
  }

  visibleObjectives(): ObjectiveState[] {
    return this.objectives.filter((o) => o.visible);
  }

  /**
   * Only the last valid DefineComputerObjective is listed: level3 replaces its objective set twice, and its second and
   * third sets are both valid once the flight logs are hacked (both list M3_OBJ3, which showed and completed twice).
   */
  private updateObjectives() {
    const sets = this.tasks.filter((t): t is ObjectiveTask => t instanceof ObjectiveTask);
    let shown = -1;
    sets.forEach((t, i) => t.valid() && (shown = i));
    sets.forEach((t, i) => t.update(i === shown));
  }

  // ---- alarm

  private updateAlarm() {
    let on = false;
    for (const t of this.tasks) if (t instanceof AlarmControlTask && t.active && t.isAlarm) on = true;
    if (on !== this.alarmOn) {
      this.alarmOn = on;
      this.reportAlarm();
    }
  }

  /** Emit the level's alarm state (also to correct listeners that heard an alarm the level did not raise). */
  reportAlarm() {
    this.emittingAlarm = true;
    try {
      this.emit("alarm", { active: this.alarmOn, sourceId: null });
    } finally {
      this.emittingAlarm = false;
    }
  }

  /** True while MissionLogic itself is emitting an `alarm` event (so the system can tell its own events apart). */
  emittingAlarm = false;

  /**
   * Something outside the scripts (an AI soldier) raised the alarm: press the alarm pad nearest to `from` that an
   * active AlarmControl's Trigger expression listens to, the way IGI's soldiers run to a pad and hit it.
   */
  raiseAlarm(from: Vec3 | null): boolean {
    const pads = this.alarmSwitches();
    if (pads.length === 0) return false;
    const pick = from ? pads.reduce((a, b) => (vec3.distance(a.usePosition(), from) <= vec3.distance(b.usePosition(), from) ? a : b)) : pads[0];
    pick.press();
    return true;
  }

  /** Switches referenced by active AlarmControl trigger expressions (alarm pads). */
  alarmSwitches(): SwitchTask[] {
    const out = new Set<SwitchTask>();
    for (const t of this.tasks) {
      if (!(t instanceof AlarmControlTask) || !t.active) continue;
      for (const m of pstr(t.node, "Trigger Expression").matchAll(/Switch_(\d+)\.isLastPressed/g)) {
        const s = this.byKey.get(`Switch_${m[1]}`);
        if (s instanceof SwitchTask && s.active) out.add(s);
      }
    }
    return [...out];
  }

  // ---- interaction

  /**
   * The usable task the player would use from `eye` looking along `dir`, if any. Object origins sit at floor level
   * (doors, terminals on desks), so reach is measured horizontally, with a vertical window from the feet to just above
   * the eye.
   */
  useTarget(eye: Vec3, dir: Vec3): (LogicTask & Usable) | null {
    let best: (LogicTask & Usable) | null = null;
    let bestScore = Infinity;
    const look = Math.hypot(dir[0], dir[1]) || 1;
    for (const t of this.tasks) {
      if (!t.active || !isUsable(t) || !t.canUse()) continue;
      const p = t.usePosition();
      const dx = p[0] - eye[0];
      const dy = p[1] - eye[1];
      const dz = p[2] - eye[2];
      const d = Math.hypot(dx, dy);
      const range = t instanceof PlaceExplosiveTask ? Math.max(USE_RANGE, t.radius) : USE_RANGE;
      if (d > range || dz < -2.4 * METRE || dz > 1 * METRE) continue;
      const facing = d < 0.6 * METRE ? 1 : (dx * dir[0] + dy * dir[1]) / (d * look);
      if (facing < 0.5) continue;
      const score = d * (2 - facing);
      if (score < bestScore) {
        bestScore = score;
        best = t;
      }
    }
    return best;
  }

  /** Damage routed from a `damage` event to a task (by task id). */
  damageTask(taskId: number, amount: number) {
    for (const t of this.tasks) if (t.node.id === taskId && isExplodable(t)) t.damage(amount);
  }
}

const CONSTANTS: Record<string, ScriptValue> = {
  TRUE: 1,
  FALSE: 0,
  GAME_FREQUENCY,
  WORLD_METER: METRE,
  MATH_PI: Math.PI,
};

// --------------------------------------------------------------------------------------------------- task runtimes

/** Tasks with an id but no logic of their own: soldiers, the player, vehicles, weapon pickups (via game entities). */
class EntityTask extends LogicTask {
  private wasPresent = false;
  field(name: string): ScriptValue | undefined {
    const type = this.node.type;
    if (name === "isDead") {
      if (type === "HumanPlayer") {
        const p = this.L.world.player();
        return p && !p.alive ? 1 : 0;
      }
      const e = this.L.world.byTask(this.node.id);
      return e && !e.alive ? 1 : 0;
    }
    if (name === "isExploded" || name === "isDestroyed") {
      const e = this.L.world.byTask(this.node.id);
      return e && !e.alive ? 1 : 0;
    }
    if (name === "isPickedUp") {
      // Weapon pickups are the weapons system's entities: picked up once the entity is gone or dead.
      const e = this.L.world.byTask(this.node.id);
      if (e) this.wasPresent = true;
      return (e && !e.alive) || (!e && this.wasPresent) ? 1 : 0;
    }
    if (name === "isDetection" && type === "HumanAI") {
      const soldier = this.node.parent;
      return soldier && this.L.world.aiDetects(soldier.id) ? 1 : 0;
    }
    return undefined;
  }
}

export class ConditionalContainerTask extends LogicTask {
  running = false;
  /** Has run before: starting again restarts everything inside from its initial state. */
  private ran = false;
  private condition = this.expr("Condition");
  private start = this.expr("Run at start");
  private stop = this.expr("Run at stop");

  field(name: string) {
    if (name === "isRun") return this.running ? 1 : 0;
    return undefined;
  }
  tick() {
    const run = this.test(this.condition);
    if (run === this.running) return;
    this.running = run;
    if (run && this.ran) this.L.restartSubtree(this.node);
    if (run) this.ran = true;
    const e = run ? this.start : this.stop;
    if (e) this.L.eval(e, this);
  }
  deactivate() {
    if (!this.running) return;
    this.running = false;
    if (this.stop) this.L.eval(this.stop, this);
  }
}

class EditVariableTask extends LogicTask {
  value = pnum(this.node, "Initial value");
  private add = this.expr("Add");
  private sub = this.expr("Sub");
  field(name: string) {
    if (name === "nValue") return this.value;
    return undefined;
  }
  setField(name: string, value: number) {
    if (name === "nValue") this.value = value;
  }
  tick() {
    // Both are evaluated against the value at the start of the tick.
    const add = this.test(this.add);
    const sub = this.test(this.sub);
    if (add) this.value++;
    if (sub) this.value--;
  }
}

/** A box (Dimensions are its full size in world units, rotated by the orientation's Z angle). */
export class AreaActivateTask extends LogicTask {
  count = 0;
  readonly center = pvec(this.node, "Position");
  readonly size = pvec(this.node, "Dimensions");
  readonly angle = pvec(this.node, "Orientation")[2];
  private criteria = pstr(this.node, "Criteria").trim();
  get forVehicles() {
    return this.criteria === "CRITERIA_VEHICLE";
  }

  field(name: string) {
    if (name === "nActive") return this.count;
    return undefined;
  }
  contains(p: Vec3): boolean {
    const dx = p[0] - this.center[0];
    const dy = p[1] - this.center[1];
    const c = Math.cos(-this.angle);
    const s = Math.sin(-this.angle);
    const lx = dx * c - dy * s;
    const ly = dx * s + dy * c;
    return Math.abs(lx) <= this.size[0] / 2 && Math.abs(ly) <= this.size[1] / 2 && Math.abs(p[2] - this.center[2]) <= this.size[2] / 2;
  }
  /** Whether each scripted vehicle was inside at the last tick its task existed. */
  private vehicleInside = new Map<LogicTask, boolean>();
  /** Whether the player was inside at the last tick its HumanPlayer task existed. */
  private playerInside = false;
  /** Whether each friendly soldier (by task id) was inside at the last tick it was in play. */
  private allyInside = new Map<number, boolean>();

  tick() {
    // Test a point just above the feet so slopes and stairs at the box floor still count.
    const inside = (e: Entity) => e.alive && this.contains([e.position[0], e.position[1], e.position[2] + 0.5 * METRE]);
    const c = this.criteria;
    const all = this.L.world.entities();
    if (c === "CRITERIA_HUMAN1") this.count = all.filter((e) => e.team === 1 && isHuman(e) && inside(e)).length;
    else if (c === "CRITERIA_VEHICLE") {
      // Scripted vehicles (Car/Heli/Plane tasks) keep their last answer while their task does not exist, like the
      // player: Mission 7's outro runs on "AreaActivate_177.nActive" (the truck at the border) and its own start
      // takes the truck's container down; dropping the count would stop the outro again at once.
      let n = 0;
      const counted = new Set<Entity>();
      for (const t of this.L.tasks) {
        if (!(t instanceof VehicleTask)) continue;
        const e = this.L.world.byTask(t.node.id);
        if (e) counted.add(e);
        if (t.exploded) this.vehicleInside.delete(t);
        else if (t.active && e) this.vehicleInside.set(t, inside(e));
        if (this.vehicleInside.get(t)) n++;
      }
      // Vehicles that are not mission tasks (other systems' entities).
      n += all.filter((e) => VEHICLE_KINDS.has(e.kind) && !counted.has(e) && inside(e)).length;
      this.count = n;
    }
    else {
      // CRITERIA_HUMAN0: the player's side. While the HumanPlayer task does not exist (intro and outro cutscenes)
      // the player keeps its last answer: outro containers test the very area that started them.
      const player = this.L.world.player();
      if (player && this.L.playerActive()) this.playerInside = inside(player);
      // Friendly soldiers too: Mission 4's outro runs on "AreaActivate_156.nActive" (Harrison and Josip at the
      // helipad) and its start takes their container down with the player's; dropping them restarted the level.
      // A dead one stops counting; one taken out of play keeps its last answer.
      let n = this.playerInside ? 1 : 0;
      const present = new Set<number>();
      for (const e of all) {
        if (e.team !== 0 || !isHuman(e) || e === player) continue;
        const now = inside(e);
        if (now) n++;
        if (e.taskId === undefined) continue;
        present.add(e.taskId);
        if (e.alive) this.allyInside.set(e.taskId, now);
        else this.allyInside.delete(e.taskId);
      }
      for (const [id, was] of this.allyInside) if (was && !present.has(id)) n++;
      this.count = n;
    }
  }
}

const HUMAN_KINDS = new Set(["player", "soldier", "civilian", "human"]);
const VEHICLE_KINDS = new Set(["car", "heli", "plane", "train", "vehicle", "tank"]);
const isHuman = (e: Entity) => HUMAN_KINDS.has(e.kind);

class LevelTimerTask extends LogicTask {
  running = pbool(this.node, "Initial run");
  ticks = 0;
  private on = this.expr("On");
  private reset = this.expr("Reset");
  field(name: string) {
    if (name === "isRun") return this.running ? 1 : 0;
    if (name === "nTick") return this.ticks;
    return undefined;
  }
  tick() {
    if (this.on) this.running = this.test(this.on);
    if (this.test(this.reset)) this.ticks = 0;
    if (this.running) this.ticks++;
  }
}

/**
 * Plays back recorded control input for the task named by TargetID (a Car, Heli, Plane or Train): AnimData keys set
 * input channels at their tick while the AnimTask runs (see vehicles.ts and docs/formats/dynamic.md).
 */
export class AnimTaskTask extends LogicTask {
  running = pbool(this.node, "Initial run");
  ticks = 0;
  readonly target = pnum(this.node, "TargetID", -1);
  /** Latest value per input channel. */
  readonly inputs = new Map<number, number>();
  /** Keys applied since the target last read them (levers need every key, not just the latest). */
  private fresh: { channel: number; value: number }[] = [];
  private keys: { tick: number; channel: number; value: number }[];
  private next = 0;
  private run = this.expr("Run");
  constructor(node: TaskNode, L: MissionLogic) {
    super(node, L);
    const data = node.params["AnimData"];
    this.keys = Array.isArray(data) ? decodeAnimData(data) : [];
  }
  field(name: string) {
    if (name === "isRun") return this.running ? 1 : 0;
    if (name === "nTick") return this.ticks;
    return undefined;
  }
  tick() {
    if (this.run) this.running = this.test(this.run);
    if (!this.running) return;
    while (this.next < this.keys.length && this.keys[this.next].tick <= this.ticks) {
      const k = this.keys[this.next++];
      this.inputs.set(k.channel, k.value);
      this.fresh.push(k);
    }
    this.ticks++;
  }
  /** Played some of its keys but not all: a paused drive (its Run condition went false on the way). */
  get paused(): boolean {
    return !this.running && this.ticks > 0 && this.next < this.keys.length;
  }
  /** Keys since the last call. */
  take(): { channel: number; value: number }[] {
    return this.fresh.splice(0);
  }
  deactivate() {
    this.running = false;
  }
}

export class StatusMessageTask extends LogicTask {
  sent = false;
  sentTick = -1;
  private send = this.expr("Send");
  private textExpr = this.expr("Text");
  private once = pbool(this.node, "Is send once");
  private duration = pnum(this.node, "Duration", 4) || 4;
  private wasTrue = false;

  field(name: string) {
    const since = this.sentTick < 0 ? 0 : this.L.tickCount - this.sentTick;
    if (name === "isSendt") return this.sent ? 1 : 0;
    if (name === "nTickSendt") return since;
    if (name === "nTicksSinceFinishedDisplay") return this.sentTick < 0 ? 0 : Math.max(0, since - Math.round(this.duration * GAME_FREQUENCY));
    return undefined;
  }
  tick() {
    const now = this.test(this.send);
    const rising = now && !this.wasTrue;
    this.wasTrue = now;
    if (!rising || (this.once && this.sent)) return;
    // Once the level is over nothing more is said: an outro stopping restarts the gameplay container, whose messages
    // would otherwise be sent again under the end screen (Missions 2 and 5).
    if (this.L.ended) return;
    this.sent = true;
    this.sentTick = this.L.tickCount;
    const v = this.textExpr ? this.L.eval(this.textExpr, this) : "";
    this.L.message(String(v), this.duration);
    const sound = pstr(this.node, "Sound");
    if (sound) this.L.emit("mission:sound", { sound, position: null });
  }
  deactivate() {
    this.wasTrue = false;
  }
}

class LevelFlowTask extends LogicTask {
  private complete = this.expr("Complete");
  private failed = this.expr("Failed");
  private maxTime = pnum(this.node, "Max level play time");
  private ticks = 0;
  private result: boolean | null = null;
  field(name: string) {
    if (name === "nTick") return this.ticks;
    if (name === "isFailed") return this.result === false ? 1 : 0;
    if (name === "isComplete") return this.result === true ? 1 : 0;
    return undefined;
  }
  tick() {
    this.ticks++;
    if (this.result !== null) return;
    if (this.test(this.failed)) this.finish(false, "failed");
    else if (this.test(this.complete)) this.finish(true, "complete");
    else if (this.maxTime > 0 && this.ticks > this.maxTime * GAME_FREQUENCY) this.finish(false, "time");
  }
  private finish(success: boolean, reason: string) {
    this.result = success;
    this.L.end(success, reason);
  }
}

class ObjectiveTask extends LogicTask {
  private validExpr = this.expr("Objectives Valid");
  private slots: { o: ObjectiveState; complete: Expr; failed: Expr }[] = [];
  constructor(node: TaskNode, L: MissionLogic) {
    super(node, L);
    for (let i = 1; i <= 6; i++) {
      const key = pstr(node, `Objective ${i} Text Resource`).trim();
      if (!key) continue;
      this.slots.push({
        o: L.registerObjective(key, pnum(node, `Objective ${i} Link To Position`, -1)),
        complete: this.expr(`Objective ${i} Complete Expression`),
        failed: this.expr(`Objective ${i} Failed Expression`),
      });
    }
  }
  field() {
    return undefined;
  }
  /** Active, and its "Objectives Valid" expression holds (empty = always). */
  valid() {
    return this.active && this.test(this.validExpr, true);
  }
  /** Runs after every tick (also while inactive, to hide the objectives). */
  update(visible: boolean) {
    for (const s of this.slots) {
      s.o.visible = visible;
      if (!visible || s.o.state !== "active" || this.L.ended) continue;
      if (this.test(s.failed)) this.L.setObjective(s.o, "failed");
      else if (this.test(s.complete)) this.L.setObjective(s.o, "completed");
    }
  }
}

/** One camera key of a CutScene (its EditCamera children). */
export interface CameraKey {
  position: Vec3;
  /** Raw Alpha/Beta/Gamma angles (radians) as stored. */
  alpha: number;
  beta: number;
  gamma: number;
  fov: number;
  /** Seconds until the next key. */
  duration: number;
  /** Seconds from the cutscene start. */
  start: number;
  link: number;
  target: number;
  smooth: boolean;
}

export class CutSceneTask extends LogicTask {
  running = pbool(this.node, "Initial run");
  finished = false;
  ticks = 0;
  readonly keys: CameraKey[] = [];
  /** Length in seconds (sum of the camera key durations, divided by Time scale). */
  readonly length: number;
  private run = this.expr("Run");
  private reset = this.expr("Reset");

  constructor(node: TaskNode, L: MissionLogic) {
    super(node, L);
    let t = 0;
    for (const c of node.children) {
      if (c.type !== "EditCamera") continue;
      const duration = pnum(c, "Duration");
      this.keys.push({
        position: pvec(c, "Position"),
        alpha: pnum(c, "Alpha"),
        beta: pnum(c, "Beta"),
        gamma: pnum(c, "Gamma"),
        fov: pnum(c, "FOV", 1) || 1,
        duration,
        start: t,
        link: pnum(c, "Link task ID", -1),
        target: pnum(c, "Target task ID", -1),
        smooth: pbool(c, "Smooth to next"),
      });
      t += duration;
    }
    this.scale = pnum(node, "Time scale", 1) || 1;
    this.length = t / this.scale;
  }
  field(name: string) {
    if (name === "isRun") return this.running ? 1 : 0;
    if (name === "isFinished") return this.finished ? 1 : 0;
    if (name === "nTick") return this.ticks;
    return undefined;
  }
  private scale: number;
  /** Seconds into the cutscene. */
  get seconds() {
    return this.ticks / GAME_FREQUENCY;
  }
  /** Position on the camera key timeline (seconds × Time scale). */
  get keyTime() {
    return this.seconds * this.scale;
  }
  tick() {
    if (this.test(this.reset)) {
      this.ticks = 0;
      this.finished = false;
    }
    this.running = this.run ? this.test(this.run) : this.running;
    if (!this.running) return;
    this.ticks++;
    if (this.ticks >= Math.max(1, Math.round(this.length * GAME_FREQUENCY))) {
      this.finished = true;
      // The Run expressions in every level are "!CutScene_N.isFinished"; stop now rather than a tick later.
      this.running = false;
    }
  }
  deactivate() {
    this.running = false;
  }
}

// ---------------------------------------------------------------------------------------------- interactive objects

/** The "Model / Destroyed model / Damage scale / Explosion ..." parameter block shared by many object types. */
export abstract class ObjectTask extends LogicTask implements Explodable {
  readonly position: Vec3 = pvec(this.node, this.node.params["Position"] ? "Position" : "Position start");
  readonly orientation: Vec3 = orientationOf(this.node);
  readonly model = pstr(this.node, "Model");
  readonly destroyedModel = pstr(this.node, "Destroyed model") || pstr(this.node, "Destroyde model");
  /** Offset added to the position (elevator children ride along). */
  offset: Vec3 = [0, 0, 0];
  /** Centre of the model in its own frame (set by the renderer from the model bounds). Origins are often an edge. */
  center: Vec3 = [0, 0, 0];
  /**
   * Damage left before it blows, in IGI damage units (a weapon's Damage Factor; an AI soldier dies at 1.0). The
   * level's "Damage scale" is this toughness, not a multiplier: computers and barrels have 1 (a few rifle rounds),
   * level6's large fuel tanks 100 and level8's SAM launcher 99 (only their scripted C4 / airstrike destroys them).
   */
  health = pnum(this.node, "Damage scale", 1);
  exploded = false;
  /** Seconds left until a triggered explosion goes off. */
  private fuse = -1;
  private explosionExpr = this.expr("Explosion expression");

  /** Can bullets and blasts destroy it? */
  get destructible(): boolean {
    return !!this.destroyedModel || this.node.params["Explodable"] === true;
  }
  /** Model rendered right now ("" = nothing). */
  currentModel(): string {
    return this.exploded && this.destroyedModel ? this.destroyedModel : this.model;
  }
  worldPosition(): Vec3 {
    return vec3.add(this.position, this.offset);
  }
  /** Where the model is drawn and collides: position and Euler angles (doors and vehicles move). */
  pose(): { position: Vec3; orientation: Vec3 } {
    return { position: this.worldPosition(), orientation: this.orientation };
  }
  /** World position of the model's centre (where the player aims to use it). */
  centerPosition(): Vec3 {
    const g = this.orientation[2];
    const [x, y, z] = this.center;
    const p = this.worldPosition();
    return [p[0] + x * Math.cos(g) - y * Math.sin(g), p[1] + x * Math.sin(g) + y * Math.cos(g), p[2] + z];
  }
  /** A visible, physical model (tasks with Model "waypoint" are editor markers). */
  get physical(): boolean {
    return !!this.model && this.model.toLowerCase() !== "waypoint";
  }
  damage(amount: number, _part?: string) {
    if (this.exploded || this.fuse >= 0 || !this.destructible || !this.physical) return;
    this.health -= amount;
    if (this.health <= 0) this.trigger();
  }
  /** Start the explosion (after Explosion delay). */
  trigger() {
    if (this.exploded || this.fuse >= 0) return;
    this.fuse = pnum(this.node, "Explosion delay");
  }
  tick() {
    if (!this.exploded && this.fuse < 0 && this.test(this.explosionExpr)) this.trigger();
    if (this.fuse >= 0 && !this.exploded) {
      this.fuse -= 1 / GAME_FREQUENCY;
      if (this.fuse <= 0) this.explode();
    }
  }
  protected explode() {
    this.exploded = true;
    this.fuse = -1;
    const radius = pnum(this.node, "Explosion radius") * METRE;
    this.L.emit("object:explode", {
      taskId: this.node.id,
      position: this.worldPosition(),
      radius,
      falloff: pnum(this.node, "Explosion falloff radius") * METRE,
      damage: 100 * (pnum(this.node, "Explosion damage scale", 1) || 0),
      sound: pstr(this.node, "Explosion sound"),
      fragments: pnum(this.node, "Explosion fragments"),
      fireballs: pnum(this.node, "Explosion fireballs"),
    });
  }
  field(name: string): ScriptValue | undefined {
    if (name === "isExploded" || name === "isDestroyed") return this.exploded ? 1 : 0;
    return undefined;
  }
}

function orientationOf(node: TaskNode): Vec3 {
  const o = node.params["Orientation"];
  if (Array.isArray(o)) return [o[0], o[1], o[2]];
  if (typeof o === "number") return [0, 0, o]; // Cabinet: a single Angle
  return [0, 0, pnum(node, "Gamma")];
}

class ExplodeObjectTask extends ObjectTask {
  get destructible() {
    return true;
  }
}

export class DoorTask extends ObjectTask implements Usable {
  /** 0 = closed, 1 = open. */
  open = pnum(this.node, "Position slider");
  /** -1 closing, 0 still, 1 opening. */
  moving = 0;
  picked = false;
  openTicks = 0;
  readonly slide: [number, number] = [pnum(this.node, "Position stop X") * METRE, pnum(this.node, "Position stop Y") * METRE];
  readonly maxAngle = (pnum(this.node, "Max angle") * Math.PI) / 180;
  private openTime = pnum(this.node, "Open time", 1) || 1;
  private locked = this.expr("Locked expression");
  private openExpr = this.expr("Open door expression");
  private closeExpr = this.expr("Close door expression");
  private openWas = false;
  private closeWas = false;
  private lastOpen = false;

  get destructible() {
    return false;
  }
  get isOpen() {
    return this.open >= 1 && this.moving === 0;
  }
  get isClosed() {
    return this.open <= 0 && this.moving === 0;
  }
  isLocked() {
    return this.test(this.locked);
  }
  field(name: string) {
    switch (name) {
      case "isOpen": return this.isOpen ? 1 : 0;
      case "isClosed": return this.isClosed ? 1 : 0;
      case "isLocked": return this.isLocked() ? 1 : 0;
      case "isPicked": return this.picked ? 1 : 0;
      case "nDoorOpenTicks": return this.openTicks;
      case "isLastOpen": return this.lastOpen ? 1 : 0;
      case "isMoving": return this.moving !== 0 ? 1 : 0;
    }
    return super.field(name);
  }
  tick() {
    // The expressions trigger on their rising edge. Elevator doors open on "Elevator_698.vFloor == 0", which stays
    // true while the car waits; tested as a level it reopened the doors the moment a call button closed them, so the
    // car's "Can start" (doors closed) never held and the lift never left.
    const open = this.test(this.openExpr);
    const close = this.test(this.closeExpr);
    const openEdge = open && !this.openWas;
    const closeEdge = close && !this.closeWas;
    this.openWas = open;
    this.closeWas = close;
    if (openEdge && this.open < 1) this.startMove(1);
    else if (closeEdge && this.open > 0) this.startMove(-1);
    if (this.moving !== 0) {
      this.open = Math.min(1, Math.max(0, this.open + this.moving / (this.openTime * GAME_FREQUENCY)));
      if ((this.moving > 0 && this.open >= 1) || (this.moving < 0 && this.open <= 0)) {
        const opened = this.moving > 0;
        this.moving = 0;
        if (opened) {
          this.openTicks = 0;
          this.L.pulse(() => (this.lastOpen = true), () => (this.lastOpen = false));
        }
        this.L.emit(opened ? "door:open" : "door:close", { taskId: this.node.id });
      }
    }
    if (this.isOpen) this.openTicks++;
    else this.openTicks = 0;
  }
  startMove(dir: 1 | -1) {
    if (this.moving === dir) return;
    this.moving = dir;
    this.L.emit("door:move", { taskId: this.node.id, opening: dir > 0, sound: pstr(this.node, dir > 0 ? "Open sound" : "Close sound"), position: this.worldPosition() });
  }
  // Usable: the player opens and closes unlocked doors; pickable locked doors take "Pick lock time" to pick.
  usePosition() {
    return this.centerPosition();
  }
  canUse() {
    return this.physical && (!this.isLocked() || pbool(this.node, "Pickable"));
  }
  holdTime() {
    return this.isLocked() ? pnum(this.node, "Pick lock time (s)", 4) : 0;
  }
  useText() {
    return this.isLocked() ? "Pick lock" : this.open > 0.5 || this.moving > 0 ? "Close door" : "Open door";
  }
  use() {
    if (this.isLocked()) {
      this.picked = true;
      return;
    }
    this.startMove(this.open > 0.5 || this.moving > 0 ? -1 : 1);
  }
  /** Door model transform at an opening (default: the current one): slide along local X/Y or swing about Z by Max angle. */
  pose(f = this.open): { position: Vec3; orientation: Vec3 } {
    // The slide is along the model's local X/Y, so it turns with the full orientation (Euler ZYX, as the model is
    // drawn), not just the heading: level12's blast doors (506_01_1) are tipped 90 degrees about Y and slide up.
    const [a, b, g] = this.orientation;
    const [sx, sy] = this.slide;
    const y1 = sy * Math.cos(a), z1 = sy * Math.sin(a);
    const x2 = sx * Math.cos(b) + z1 * Math.sin(b), z2 = -sx * Math.sin(b) + z1 * Math.cos(b);
    const dx = x2 * Math.cos(g) - y1 * Math.sin(g), dy = x2 * Math.sin(g) + y1 * Math.cos(g);
    const base = this.worldPosition();
    const position: Vec3 = [base[0] + dx * f, base[1] + dy * f, base[2] + z2 * f];
    return { position, orientation: [a, b, g + this.maxAngle * f] };
  }
}

/**
 * Wall buttons and alarm pads. isLastPressed is true for the tick after a press; isPressed latches once pressed.
 * "Initial on" only picks the lit model: level8's generator switch starts "on" but must still be pressed.
 */
export class SwitchTask extends ObjectTask implements Usable {
  pressed = false;
  private lit = pbool(this.node, "Initial on");
  lastPressed = false;
  private on = this.expr("On");
  get destructible() {
    return pbool(this.node, "Destructable");
  }
  currentModel() {
    if (this.exploded) return pstr(this.node, "Destroyed model") || this.model;
    const on = this.lit !== this.pressed;
    return pstr(this.node, on ? (this.pressed ? "On pressed model" : "On model") : this.pressed ? "Off pressed model" : "Off model") || this.model;
  }
  get physical() {
    return !!pstr(this.node, "Off model") || !!pstr(this.node, "On model");
  }
  field(name: string) {
    if (name === "isPressed") return this.pressed ? 1 : 0;
    if (name === "isLastPressed") return this.lastPressed ? 1 : 0;
    if (name === "isOn") return this.enabled() ? 1 : 0;
    return super.field(name);
  }
  enabled() {
    return !this.exploded && this.test(this.on, true);
  }
  /** Press the switch (player F, or an AI soldier hitting an alarm pad). */
  press() {
    this.pressed = true;
    this.L.pulse(() => (this.lastPressed = true), () => (this.lastPressed = false));
    this.L.emit("switch:press", { taskId: this.node.id, position: this.worldPosition() });
  }
  usePosition() {
    return this.centerPosition();
  }
  canUse() {
    return this.enabled();
  }
  holdTime() {
    return 0;
  }
  useText() {
    return "Use switch";
  }
  use() {
    this.press();
  }
}

/** Terminals, alarm controls and camera controls: computers the player hacks by holding F for "Hack Time". */
export class TerminalTask extends ObjectTask implements Usable {
  hacked = false;
  hackedThisTick = false;
  protected on = this.expr("On Expression");
  field(name: string) {
    if (name === "isHacked") return this.hacked ? 1 : 0;
    if (name === "isHackedThisTick") return this.hackedThisTick ? 1 : 0;
    if (name === "isOn") return this.isOn() ? 1 : 0;
    return super.field(name);
  }
  isOn() {
    return !this.exploded && this.test(this.on, true);
  }
  usePosition() {
    return this.centerPosition();
  }
  canUse() {
    return this.physical && this.isOn();
  }
  holdTime() {
    return pnum(this.node, "Hack Time (s)", 4);
  }
  useText() {
    return "Use computer";
  }
  use() {
    this.hacked = true;
    this.L.pulse(() => (this.hackedThisTick = true), () => (this.hackedThisTick = false));
  }
}

export class AlarmControlTask extends TerminalTask {
  isAlarm = false;
  isTrigger = false;
  private triggerExpr = this.expr("Trigger Expression");
  private alarmExpr = this.expr("Alarm Expression");
  field(name: string) {
    if (name === "isAlarm") return this.isAlarm ? 1 : 0;
    if (name === "isTrigger") return this.isTrigger ? 1 : 0;
    return super.field(name);
  }
  tick() {
    super.tick();
    this.isTrigger = this.isOn() && this.test(this.triggerExpr);
    this.isAlarm = this.test(this.alarmExpr);
  }
  deactivate() {
    this.isTrigger = false;
  }
}

class SCameraControlTask extends TerminalTask {
  detection = false;
  private detectionExpr = this.expr("Detection Expression");
  field(name: string) {
    if (name === "isDetection") return this.detection ? 1 : 0;
    return super.field(name);
  }
  tick() {
    super.tick();
    this.detection = this.isOn() && this.test(this.detectionExpr);
  }
}

/** A security camera: sweeps between its gamma limits and detects the player inside its view cone. */
export class SCameraTask extends ObjectTask {
  readonly holderGamma = pnum(this.node, "Holder Gamma");
  readonly alpha = pnum(this.node, "Camera Alpha");
  /** Current sweep offset from the camera's rest gamma, radians. */
  sweep = 0;
  detection = false;
  /** Seconds the player has been in view. */
  seen = 0;
  private dir = 1;
  private pause = 0;
  private on = this.expr("On Expression");
  private right = (pnum(this.node, "Rotate Gamma Right (d)") * Math.PI) / 180;
  private left = (pnum(this.node, "Rotate Gamma Left (d)") * Math.PI) / 180;
  private speed = (pnum(this.node, "Rotate Gamma Speed (d/s)") * Math.PI) / 180;
  private delay = pnum(this.node, "Gamma Delay (s)");
  private coneAlpha = (pnum(this.node, "Viewcone Alpha (d)") * Math.PI) / 180;
  private coneGamma = (pnum(this.node, "Viewcone Gamma (d)") * Math.PI) / 180;
  private length = pnum(this.node, "Viewcone length (m)") * METRE;

  worldPosition(): Vec3 {
    return vec3.add(pvec(this.node, "Holder Position"), this.offset);
  }
  get destructible() {
    return true;
  }
  get physical() {
    return true;
  }
  currentModel() {
    return pstr(this.node, "Holder Model");
  }
  cameraModel() {
    return this.exploded ? pstr(this.node, "Camera Destroyed Model") : pstr(this.node, "Camera Model");
  }
  /** Heading of the lens (radians about Z). */
  heading() {
    return this.holderGamma + pnum(this.node, "Camera Gamma") + this.sweep;
  }
  isOn() {
    return !this.exploded && this.test(this.on, true);
  }
  field(name: string) {
    if (name === "isDetection") return this.detection ? 1 : 0;
    if (name === "isOn") return this.isOn() ? 1 : 0;
    return super.field(name);
  }
  tick() {
    super.tick();
    const dt = 1 / GAME_FREQUENCY;
    if (!this.isOn()) {
      this.detection = false;
      this.seen = 0;
      return;
    }
    if (this.speed > 0 && this.left + this.right > 0) {
      if (this.pause > 0) this.pause -= dt;
      else {
        this.sweep += this.dir * this.speed * dt;
        // Positive offsets turn left (counter-clockwise), negative turn right.
        if (this.sweep >= this.left) [this.sweep, this.dir, this.pause] = [this.left, -1, this.delay];
        else if (this.sweep <= -this.right) [this.sweep, this.dir, this.pause] = [-this.right, 1, this.delay];
      }
    }
    this.seen = this.sees() ? this.seen + dt : 0;
    // A short dwell so a sweep that only grazes the player does not set off the alarm instantly.
    this.detection = this.seen >= 0.5;
  }
  private sees(): boolean {
    const p = this.L.playerActive() ? this.L.world.player() : null;
    if (!p || !p.alive) return false;
    const eye = this.worldPosition();
    const target: Vec3 = [p.position[0], p.position[1], p.position[2] + p.height * 0.6];
    const to = vec3.sub(target, eye);
    const dist = vec3.length(to);
    if (dist > this.length || dist < 1) return false;
    const yaw = Math.atan2(-to[0], to[1]);
    const dy = Math.abs(wrapAngle(yaw - this.heading()));
    const pitch = Math.atan2(to[2], Math.hypot(to[0], to[1]));
    const dp = Math.abs(pitch - this.alpha);
    if (dy > this.coneGamma / 2 || dp > Math.max(this.coneAlpha / 2, 0.2)) return false;
    return this.L.world.lineOfSight(eye, target);
  }
}

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** A mission item (keycard, C4, map computer): picked up by walking over it or using it. */
export class GenericPickupTask extends ObjectTask implements Usable {
  pickedUp = false;
  get destructible() {
    return false;
  }
  field(name: string) {
    if (name === "isPickedUp") return this.pickedUp ? 1 : 0;
    return super.field(name);
  }
  tick() {
    super.tick();
    if (this.pickedUp || !this.L.playerActive()) return;
    const p = this.L.world.player();
    if (p && p.alive && vec3.distance([p.position[0], p.position[1], p.position[2] + 0.5 * METRE], this.worldPosition()) < 1.2 * METRE) this.use(p.id);
  }
  usePosition() {
    return this.centerPosition();
  }
  canUse() {
    return !this.pickedUp;
  }
  holdTime() {
    return 0;
  }
  useText() {
    return "Pick up";
  }
  use(user: number | null) {
    if (this.pickedUp) return;
    this.pickedUp = true;
    // By script name: the HUD leaves mission items to the level's own messages ("Keycard found!").
    this.L.emit("pickup", { ownerId: user ?? 0, item: this.key, amount: 1 });
  }
  currentModel() {
    return this.pickedUp ? "" : this.model;
  }
}

/** Timed actions: plant C4, fix a beacon. Hold F for "Activate Time" while the On Expression holds. */
export class TimedActionTask extends ObjectTask implements Usable {
  finished = false;
  private on = this.expr("On Expression");
  get destructible() {
    return pbool(this.node, "Explodable");
  }
  field(name: string) {
    if (name === "isFinished") return this.finished ? 1 : 0;
    if (name === "isOn") return this.test(this.on, true) ? 1 : 0;
    return super.field(name);
  }
  usePosition() {
    return this.centerPosition();
  }
  canUse() {
    return !this.finished && !this.exploded && this.test(this.on, true);
  }
  holdTime() {
    return pnum(this.node, "Activate Time (s)", 4);
  }
  useText() {
    return /c4/i.test(pstr(this.node, "Click to select sprite")) ? "Place explosives" : "Use";
  }
  use() {
    this.finished = true;
  }
}

export class PlaceExplosiveTask extends TimedActionTask {
  readonly radius = pnum(this.node, "Activate radius (meters)") * METRE;
  readonly placeTask = pnum(this.node, "Task ID to place", -1);
}

class CabinetTask extends ObjectTask implements Usable {
  searched = false;
  get destructible() {
    return false;
  }
  field(name: string) {
    if (name === "isSearched") return this.searched ? 1 : 0;
    return super.field(name);
  }
  usePosition() {
    return this.centerPosition();
  }
  canUse() {
    return !this.searched;
  }
  holdTime() {
    return pnum(this.node, "Search Time (s)", 4);
  }
  useText() {
    return "Search cabinet";
  }
  use() {
    this.searched = true;
  }
}

/** Generators power cameras, alarms and elevators: on while the On expression holds and it is intact. */
class GeneratorTask extends ObjectTask {
  private on = this.expr("On expression");
  /** Off until the first tick evaluates the On expression (level8 starts with its generator off). */
  isOn = false;
  field(name: string) {
    if (name === "isOn") return this.isOn ? 1 : 0;
    return super.field(name);
  }
  tick() {
    super.tick();
    const on = !this.exploded && this.test(this.on, true);
    if (on !== this.isOn && this.L.tickCount > 1) this.L.emit("generator", { taskId: this.node.id, on, sound: pstr(this.node, on ? "Run sound" : "Shutdown sound") });
    this.isOn = on;
  }
}

/** Objects with an On expression and an explodable model: Siren, Radio, AlarmLight. */
class PoweredObjectTask extends ObjectTask {
  isOn = false;
  private on = this.expr(this.node.params["On Expression"] !== undefined ? "On Expression" : "On expression");
  get destructible() {
    return this.node.type !== "AlarmLight" || !!this.destroyedModel;
  }
  currentModel() {
    if (this.node.type !== "AlarmLight") return super.currentModel();
    if (this.exploded) return this.destroyedModel || pstr(this.node, "Off model");
    return pstr(this.node, this.isOn ? "On model" : "Off model");
  }
  get physical() {
    return !!this.currentModel();
  }
  field(name: string) {
    if (name === "isOn") return this.isOn ? 1 : 0;
    return super.field(name);
  }
  tick() {
    super.tick();
    this.isOn = !this.exploded && this.test(this.on, true);
  }
}

/** Elevators and cable cars: move along their SplineObj's waypoints; each waypoint is a floor. */
export class ElevatorTask extends ObjectTask {
  readonly floors: Vec3[];
  /** Position along the path in floors (0 = first waypoint). */
  pos = pnum(this.node, "Pos");
  target = Math.round(this.pos);
  moving = false;
  /** Floor asked for by a call button, waiting for "Can start"; -1 none. */
  private request = -1;
  private speed =(pnum(this.node, "Max speed", 2) || 2) * METRE;
  private canStart = this.expr("Can start");
  private wanted: Expr[] = [];
  private up = this.expr("Floor up");
  private down = this.expr("Floor down");

  constructor(node: TaskNode, L: MissionLogic) {
    super(node, L);
    const spline = L.tree.byKey.get(`SplineObj_${pnum(node, "SplineObj taskid", -1)}`);
    this.floors = (spline?.children ?? []).filter((c) => c.type === "SplineObjWaypoint").map((w) => pvec(w, "Position"));
    if (this.floors.length === 0) this.floors.push(this.position);
    for (let i = 0; i < 10; i++) this.wanted.push(this.expr(`Wanted floor ${i}`));
  }
  get destructible() {
    return false;
  }
  field(name: string) {
    if (name === "vFloor") return this.moving ? -1 : Math.round(this.pos);
    if (name === "isMoving") return this.moving ? 1 : 0;
    return super.field(name);
  }
  /** Path point at `pos` (linear between waypoints). */
  pointAt(pos: number): Vec3 {
    const i = Math.max(0, Math.min(this.floors.length - 1, Math.floor(pos)));
    const j = Math.min(this.floors.length - 1, i + 1);
    const f = Math.max(0, Math.min(1, pos - i));
    const a = this.floors[i];
    const b = this.floors[j];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  }
  /** Displacement of the car from where the level placed it (children ride along). */
  displacement(): Vec3 {
    return vec3.sub(this.pointAt(this.pos), this.pointAt(pnum(this.node, "Pos")));
  }
  tick() {
    super.tick();
    if (!this.moving) {
      let want = -1;
      this.wanted.forEach((e, i) => {
        if (want < 0 && i < this.floors.length && this.test(e)) want = i;
      });
      if (want < 0 && this.test(this.up)) want = Math.min(this.floors.length - 1, Math.round(this.pos) + 1);
      if (want < 0 && this.test(this.down)) want = Math.max(0, Math.round(this.pos) - 1);
      // Call buttons pulse for one tick (Switch.isLastPressed) and close the doors at the same time, so the request
      // is remembered until "Can start" (doors closed) holds.
      if (want >= 0 && want !== Math.round(this.pos)) this.request = want;
      if (this.request >= 0 && this.request === Math.round(this.pos)) this.request = -1;
      if (this.request >= 0 && this.test(this.canStart, true)) {
        want = this.request;
        this.request = -1;
        this.target = want;
        this.moving = true;
        this.L.emit("elevator", { taskId: this.node.id, moving: true, sound: pstr(this.node, "Start sound") });
      }
    }
    if (this.moving) {
      const i = Math.floor(Math.min(this.pos, this.target));
      const seg = vec3.distance(this.floors[i], this.floors[Math.min(this.floors.length - 1, i + 1)]) || 1;
      const step = this.speed / GAME_FREQUENCY / seg;
      this.pos = this.target > this.pos ? Math.min(this.target, this.pos + step) : Math.max(this.target, this.pos - step);
      if (this.pos === this.target) {
        this.moving = false;
        this.L.emit("elevator", { taskId: this.node.id, moving: false, sound: pstr(this.node, "Stop sound") });
      }
    }
    // Children (switches, doors inside the car) ride along.
    const d = this.displacement();
    const ride = (n: TaskNode) => {
      for (const c of n.children) {
        const t = this.L.byNode.get(c);
        if (t instanceof ObjectTask) t.offset = d;
        ride(c);
      }
    };
    ride(this.node);
  }
  worldPosition(): Vec3 {
    return vec3.add(this.position, this.displacement());
  }
}

/** How far ahead a paused scripted car still rolls into a vehicle area, and how fast. */
const SETTLE_RANGE = 60 * METRE;
const SETTLE_SPEED = 2.5 * METRE;

/** CarAI drivers' default speed and how close a route point counts as reached. */
const CARAI_SPEED = (30 / 3.6) * METRE;
const CARAI_REACH = 4 * METRE;

/** Share of a bullet's damage a vehicle takes (armour, engine block, tyres: it takes explosives to destroy one). */
const BULLET_FACTOR = 0.02;

/** Health of vehicles, in the player's health-bar units that damage events carry (3 = one full bar). */
const VEHICLE_HEALTH: Record<VehicleKind, number> = { car: 12, heli: 9, plane: 9 };

/**
 * Car, Heli and Plane: moved by the AnimTask that targets them (recorded inputs; vehicles.ts), drawn and colliding as
 * mission objects, destroyed (`isExploded`) by enough damage. Without a running AnimTask their controls are
 * released: cars roll to a stop, helicopters hold their last collective.
 */
export class VehicleTask extends ObjectTask {
  readonly kind: VehicleKind;
  state: VehicleState;
  /** The pose one logic tick ago, for drawing between ticks. */
  previous: { position: Vec3; orientation: Vec3 };
  private anim: AnimTaskTask | null | undefined;
  private spec: VehicleSpec | null = null;
  private released = new Map<number, number>();
  private visitedAreas = new Set<AreaActivateTask>();
  /** CarAI driver: PatrolPath commands over an AIGraph (see docs/formats/ai.md for the command ids). */
  private driver: { graph: number; commands: [number, number][]; ip: number; loop: number; route: Vec3[] | null; speed: number; delay: number; done: boolean } | null = null;
  private driverInputs = new Map<number, number>();

  constructor(node: TaskNode, L: MissionLogic) {
    super(node, L);
    this.kind = node.type === "Heli" ? "heli" : node.type === "Plane" ? "plane" : "car";
    const ai = node.children.find((c) => c.type === "CarAI");
    const path = ai && L.tree.byKey.get(`PatrolPath_${pnum(ai, "Route ID", -1)}`);
    if (ai && path) {
      const commands = path.children.filter((c) => c.type === "PatrolPathCommand").map((c) => [pnum(c, "Command"), pnum(c, "Command Parameter")] as [number, number]);
      this.driver = { graph: pnum(ai, "Graph ID", -1), commands, ip: 0, loop: -1, route: null, speed: CARAI_SPEED, delay: 0, done: false };
    }
    const v = pvec(node, "Speed").map((x) => x * METRE) as Vec3;
    this.state = newVehicleState(this.position, this.orientation, v, { kind: this.kind, length: 0, bottom: 0, thrust: pnum(node, "Original Thrust") });
    this.previous = { position: [...this.position], orientation: [...this.orientation] };
  }
  get destructible() {
    return true;
  }
  /**
   * `part` is what the damage event names: a surface material for a bullet striking the body (physics reports the hit
   * face's material), "torso"/undefined for blasts. Small-arms fire barely scratches a vehicle: Mission 7's hamlet
   * guards shoot at the truck Jones rides through, and the level fails if it explodes.
   */
  damage(amount: number, part?: string) {
    if (this.exploded) return;
    const bullet = part !== undefined && part !== "torso";
    this.health -= ((bullet ? amount * BULLET_FACTOR : amount) / VEHICLE_HEALTH[this.kind]) * 100;
    if (this.health <= 0) this.explode();
  }
  protected explode() {
    this.exploded = true;
    this.L.emit("object:explode", { taskId: this.node.id, position: this.pose().position, radius: 6 * METRE, falloff: 3 * METRE, damage: 100, sound: "", fragments: 6, fireballs: 3 });
  }
  pose(): { position: Vec3; orientation: Vec3 } {
    return { position: this.state.position, orientation: this.state.orientation };
  }
  private resolveAnim(): AnimTaskTask | null {
    if (this.anim !== undefined) return this.anim;
    const id = this.node.id;
    this.anim = id < 0 ? null : ((this.L.tasks.find((t) => t instanceof AnimTaskTask && t.target === id) as AnimTaskTask | undefined) ?? null);
    return this.anim;
  }
  tick() {
    super.tick();
    this.previous = { position: [...this.state.position], orientation: [...this.state.orientation] };
    if (this.exploded) return;
    if (!this.spec) {
      const ext = this.L.world.modelExtent?.(this.model) ?? { length: 4 * METRE, bottom: 0 };
      this.spec = { kind: this.kind, length: ext.length, bottom: ext.bottom, thrust: pnum(this.node, "Original Thrust") };
      if (this.kind === "car") {
        // Wheels on the ground where the level placed the car.
        const g = this.L.world.ground?.(this.position[0], this.position[1], this.position[2] + 2 * METRE, this.node.id);
        if (g) this.state.position[2] = g.z + ext.bottom;
        this.previous.position = [...this.state.position];
      }
    }
    const anim = this.resolveAnim();
    let inputs: ReadonlyMap<number, number> = this.released;
    if (anim?.running) {
      for (const k of anim.take()) applyKey(this.state, this.kind, k.channel, k.value);
      inputs = anim.inputs;
    } else if (this.driver && this.kind === "car") inputs = this.drive();
    else if (anim?.paused && this.kind === "car") inputs = this.settle();
    const ground = this.L.world.ground;
    stepVehicle(this.state, this.spec, inputs, 1 / GAME_FREQUENCY, (x, y, z) => ground?.(x, y, z, this.node.id) ?? null);
    if (this.kind === "car" && anim?.running) {
      // Each vehicle area guides a car until the car has been inside it, then the next one ahead takes over.
      const areas = this.L.vehicleAreas();
      for (const a of areas) if (a.contains(this.state.position)) this.visitedAreas.add(a);
      guideCar(this.state, areas.filter((a) => !this.visitedAreas.has(a)).map((a) => a.center), 1 / GAME_FREQUENCY);
    }
  }

  /**
   * A scripted drive paused by its level script waits for the car to sit in a vehicle area (Mission 7's truck must stand
   * 10 s in the hamlet strip before its AnimTask resumes). The original stops there by its recorded brake; ours may
   * stop a few metres short, so a paused car rolls on at walking pace into a vehicle area just ahead and stops inside.
   */
  private settle(): ReadonlyMap<number, number> {
    const inputs = this.driverInputs;
    const pos = this.state.position;
    const heading = this.state.orientation[2];
    let target: Vec3 | null = null;
    let reverse = false;
    let best = SETTLE_RANGE;
    for (const a of this.L.vehicleAreas()) {
      if (a.contains(pos)) {
        target = null;
        break;
      }
      const dx = a.center[0] - pos[0];
      const dy = a.center[1] - pos[1];
      const d = Math.hypot(dx, dy);
      const off = Math.abs(wrapAngle(Math.atan2(-dx, dy) - heading));
      // Ahead: roll on into it; straight behind (it stopped just past it): back up into it.
      if (d < best && (off < 1.2 || off > Math.PI - 0.6)) {
        best = d;
        target = a.center;
        reverse = off > Math.PI / 2;
      }
    }
    autopilot(this.state, target, SETTLE_SPEED, inputs, reverse);
    return inputs;
  }

  /** One tick of the CarAI driver: run PatrolPath commands, steer along the current route. */
  private drive(): ReadonlyMap<number, number> {
    const d = this.driver!;
    const inputs = this.driverInputs;
    const pos = this.state.position;
    for (let guard = 0; guard < 8 && !d.done && !d.route && d.delay <= 0; guard++) {
      if (d.ip >= d.commands.length) {
        // "End script" (6) repeats the commands after it; with none after it, or after "Quit" (7), the car stops.
        if (d.loop >= 0 && d.loop < d.commands.length) d.ip = d.loop;
        else {
          d.done = true;
          break;
        }
      }
      const [cmd, param] = d.commands[d.ip];
      if (cmd === 2 || cmd === 3) {
        const route = this.L.world.route?.(d.graph, pos, param);
        if (route === undefined) break; // graph still loading: try next tick
        d.route = route && route.length ? [...route] : null;
      } else if (cmd === 1) d.delay = param;
      else if (cmd === 8) d.speed = param > 0 ? (param / 3.6) * METRE : CARAI_SPEED;
      else if (cmd === 6) d.loop = d.ip + 1;
      else if (cmd === 7) d.done = true;
      d.ip++;
    }
    if (d.delay > 0) d.delay--;
    // Next route point: passed once within reach.
    while (d.route && d.route.length && Math.hypot(d.route[0][0] - pos[0], d.route[0][1] - pos[1]) < CARAI_REACH) d.route.shift();
    if (d.route && !d.route.length) d.route = null;
    autopilot(this.state, d.route ? d.route[0] : null, d.speed, inputs);
    return inputs;
  }
}

/** A Train task: the world system runs it on its railroad; the mission shows it while its container runs and drives it. */
class TrainTask extends LogicTask {
  private anim: AnimTaskTask | null | undefined;
  private throttle = pnum(this.node, "Original thrust");
  constructor(node: TaskNode, L: MissionLogic) {
    super(node, L);
    // Hidden until its container runs.
    const train = L.world.train?.(node.id);
    if (train) train.active = false;
  }
  field(): ScriptValue | undefined {
    return undefined;
  }
  tick() {
    const train = this.L.world.train?.(this.node.id);
    if (!train) return;
    if (this.anim === undefined) {
      const id = this.node.id;
      this.anim = (this.L.tasks.find((t) => t instanceof AnimTaskTask && t.target === id) as AnimTaskTask | undefined) ?? null;
    }
    train.active = true;
    if (this.anim) {
      train.running = this.anim.running;
      for (const k of this.anim.take()) if (k.channel === 0 && k.value !== -1) this.throttle = k.value;
    } else train.running = this.throttle > 0;
    train.throttle = this.throttle;
  }
  deactivate() {
    const train = this.L.world.train?.(this.node.id);
    if (train) train.active = false;
  }
}

class GuardGeneratorTask extends LogicTask {
  private generate = this.expr("Generate guards");
  isOn = false;
  field(name: string) {
    if (name === "isOn") return this.isOn ? 1 : 0;
    if (name === "nSpawns" || name === "isSpawned") {
      // The AI system spawns the guards; scripts read how many came.
      const n = this.L.world.aiSpawns?.(this.node.id) ?? 0;
      return name === "nSpawns" ? n : n > 0 ? 1 : 0;
    }
    return undefined;
  }
  tick() {
    this.isOn = this.test(this.generate);
  }
}

type Factory = (node: TaskNode, L: MissionLogic) => LogicTask;
const RUNTIMES: Record<string, Factory> = {
  ConditionalContainer: (n, L) => new ConditionalContainerTask(n, L),
  EditVariable: (n, L) => new EditVariableTask(n, L),
  AreaActivate: (n, L) => new AreaActivateTask(n, L),
  LevelTimer: (n, L) => new LevelTimerTask(n, L),
  AnimTask: (n, L) => new AnimTaskTask(n, L),
  StatusMessage: (n, L) => new StatusMessageTask(n, L),
  LevelFlow: (n, L) => new LevelFlowTask(n, L),
  DefineComputerObjective: (n, L) => new ObjectiveTask(n, L),
  CutScene: (n, L) => new CutSceneTask(n, L),
  ExplodeObject: (n, L) => new ExplodeObjectTask(n, L),
  Door: (n, L) => new DoorTask(n, L),
  Switch: (n, L) => new SwitchTask(n, L),
  Terminal: (n, L) => new TerminalTask(n, L),
  AlarmControl: (n, L) => new AlarmControlTask(n, L),
  SCameraControl: (n, L) => new SCameraControlTask(n, L),
  SCamera: (n, L) => new SCameraTask(n, L),
  GenericPickup: (n, L) => new GenericPickupTask(n, L),
  GenericTBA: (n, L) => new TimedActionTask(n, L),
  PlaceExplosiveTBA: (n, L) => new PlaceExplosiveTask(n, L),
  Cabinet: (n, L) => new CabinetTask(n, L),
  Generator: (n, L) => new GeneratorTask(n, L),
  Siren: (n, L) => new PoweredObjectTask(n, L),
  Radio: (n, L) => new PoweredObjectTask(n, L),
  AlarmLight: (n, L) => new PoweredObjectTask(n, L),
  Elevator: (n, L) => new ElevatorTask(n, L),
  GuardGenerator: (n, L) => new GuardGeneratorTask(n, L),
  Car: (n, L) => new VehicleTask(n, L),
  Heli: (n, L) => new VehicleTask(n, L),
  Plane: (n, L) => new VehicleTask(n, L),
  // Wagons are Train tasks under their locomotive; only top-level trains run.
  Train: (n, L) => (n.parent?.type === "Train" ? new EntityTask(n, L) : new TrainTask(n, L)),
};

/** Run a level's mission.qvm (DefineMission) and return the declared mission number and text keys. */
export function readMissionScript(bytes: Uint8Array): { number: number; name: string; desc: string; level: string } | null {
  let out: { number: number; name: string; desc: string; level: string } | null = null;
  const body = decodeQvmScript(bytes).body;
  const env: ScriptEnv = {
    get: (i) => CONSTANTS[i] ?? i,
    call: (fn, args) => {
      if (fn === "DefineMission") out = { number: Number(args[0]), name: String(args[1]), desc: String(args[2]), level: String(args[9] ?? "") };
      return 1;
    },
  };
  run(body, env);
  return out;
}
