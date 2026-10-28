// One AI character: IGI's event-driven AI. Things that happen to a soldier (it sees the player, hears a shot, is
// hit, the alarm goes off, it has nothing to do) become AIEVENT_* events; its HumanAI script and its type's common
// script answer each event by queueing actions (patrol, idle, play an animation, fight, raise the alarm, run in
// panic, die). Events rank by the order the script's CREATE handler gave them with AIFunction_SetEventPriority; an
// event ranked below the one that queued the current actions is ignored (a soldier in combat does not stop to
// play its "what was that?" animation), and when the queue runs dry the soldier gets AIEVENT_IDLE again, which
// restarts its patrol.
//
// Combat follows the type's HumanAIConfigItem (common/ai/settings.qvm) for the game difficulty: reaction and movement
// delays, bursts of a fraction of the clip, hit probability falling off with range, evasive rolls and dives, grenade
// throws, tracking distance and the targeting timeout after which the soldier searches the last place it saw the
// target and gives up. Patrols move about; guards, snipers and RPG soldiers hold their post; gunners man a
// stationary gun (gun.ts). Soldiers open unlocked doors in their way.
import * as THREE from "three";
import type { QvmScript } from "../../formats/qvm.ts";
import { direction, METRE, vec3, type Vec3 } from "../coords.ts";
import type { Entity } from "../entity.ts";
import type { Game } from "../game.ts";
import { ANIM_TICKS_PER_SECOND, cycleVelocity } from "../player/animator.ts";
import type { AiCharacter, AiEvent, AiState } from "./api.ts";
import type { SoldierBody } from "./body.ts";
import type { MountedGun } from "./gun.ts";
import type { AiConfig, CharacterSpec, PatrolCommand } from "./level.ts";
import { dist, type NavGraph } from "./nav.ts";
import { runScript, type ScriptNatives, type ScriptValue } from "./script.ts";

/** Script ticks per second (GAME_FREQUENCY, 30 in IGI.exe; animation time runs at 160 ticks per game tick). */
export const GAME_FREQUENCY = 30;

/**
 * Clip ids in the soldier skeletons (common/anims/001.iff; 002/003 share the low ids), identified from their root
 * motion and poses: e.g. 3 travels 2.45 m per 0.7 s cycle with the pelvis at 0.98 m (run), 7 lowers the pelvis from
 * 0.97 m to 0.54 m (stand to crouch), 22 ends with the pelvis at 0.17 m (death). See docs/formats/ai.md.
 */
export const CLIP = {
  idle: 2,
  idleRelaxed: 14,
  walk: 4,
  run: 3,
  sprint: 34,
  aim: 5,
  fire: 6,
  standToCrouch: 7,
  crouchToStand: 19,
  crouch: 18,
  crouchAim: 8,
  crouchFire: 9,
  standToProne: 12,
  proneToStand: 13,
  prone: 16,
  proneFire: 17,
  rollLeft: 10,
  rollRight: 11,
  crouchRollLeft: 33,
  crouchRollRight: 32,
  lookAround: 36,
  turnAround: 37,
  stunned: 39,
  /** Right hand swings up and forward over 1.2 s: the grenade throw ("Stand - Throwing grenade"). */
  throwGrenade: 70,
  deathsFront: [28, 29],
  deathsBack: [22, 23],
  deathHead: [30, 22],
  deathCrouch: 24,
  deathProne: 25,
} as const;

/** Event ranks before the CREATE handler sets its own (patrol.qvm's order). */
const DEFAULT_PRIORITY: AiEvent[] = [
  "AIEVENT_DEAD", "AIEVENT_ALARMOFF", "AIEVENT_FLASHBANG", "AIEVENT_GRENADETHROWN", "AIEVENT_GRENADELAND",
  "AIEVENT_COMBAT", "AIEVENT_ALERT", "AIEVENT_ENEMYDETECTION", "AIEVENT_GUNSHOT", "AIEVENT_TAKINGDAMAGE",
  "AIEVENT_GUNSHOTMISS", "AIEVENT_WALK", "AIEVENT_GROUNDIMPACT", "AIEVENT_DOOR", "AIEVENT_FENCE", "AIEVENT_ALARMON",
  "AIEVENT_EXPLOSION", "AIEVENT_ANIMATION", "AIEVENT_IDLE", "AIEVENT_CREATE",
];

export type Stance = "stand" | "crouch" | "prone";

export interface WeaponInfo {
  id: string;
  /** Damage factor per hit (fraction of a soldier's health), before hit zones. */
  damage: number;
  roundsPerMinute: number;
  clipSize: number;
  reloadTime: number;
  pellets: number;
  /** Gun model shown in the soldier's hands. */
  model: string;
  fireSound: string;
  silenced: boolean;
}

/** What a soldier needs from the AI system. */
export interface AiWorld {
  game: Game;
  graph(id: number): NavGraph | null;
  script(aiId: number): QvmScript | null;
  commonScript(aiType: string): QvmScript | null;
  alarmOn: boolean;
  raiseAlarm(source: Soldier): void;
  taskPosition(id: number): Vec3 | undefined;
  characters(): Soldier[];
  /** Fire one round of the soldier's weapon, or of `weapon` (a stationary gun), through the weapons service. */
  shoot(s: Soldier, origin: Vec3, dir: Vec3, weapon?: WeaponInfo): void;
  /** Throw a grenade or flashbang: launch velocity (units/s) and seconds to the explosion. */
  throwGrenade(s: Soldier, weapon: string, origin: Vec3, velocity: Vec3, fuse: number): void;
  weaponInfo(id: string): WeaponInfo | null;
  /** A StationaryGun by task id. */
  gun(id: number): MountedGun | undefined;
  /** Door entities (mission objects of kind "door"). */
  doors(): Entity[];
  sound(name: string, at: Vec3, volume?: number): void;
  /** Whether a character standing at this position can be on screen this frame. */
  inView(position: Vec3): boolean;
}

interface Action {
  state: AiState;
  /** Returns true when finished. */
  update(s: Soldier, dt: number): boolean;
  /** Event rank of the event that queued it (set when queued). */
  rank?: number;
  /**
   * Queued with AIACTIONFLAG_PUSHABLE: a later event's actions push it down instead of replacing it, and it resumes
   * when they end (Priboi's escort patrol carries on after he has run from gunfire; a guard's fight after a flashbang).
   */
  pushable?: boolean;
  /** Called when the action continues after a pushed action (re-plan the walk it was on). */
  resume?(): void;
}

/** AIACTIONFLAG_PUSHABLE (1) in an action's flag argument. */
function flagged<T extends Action>(a: T, flag: ScriptValue | undefined): T {
  a.pushable = typeof flag === "number" && (flag & 1) !== 0;
  return a;
}

/** Events that mean the character knows there is an enemy about. */
const THREAT = /GUNSHOT|DAMAGE|EXPLOSION|GRENADE|FLASHBANG|ENEMY|ALERT|COMBAT/;

/** Shortest pause between combat moves, seconds, whatever the config says. */
const MIN_MOVE_DELAY = 1;

const rand = Math.random;
const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)];
const yawTo = (from: Vec3, to: Vec3) => Math.atan2(-(to[0] - from[0]), to[1] - from[1]);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
/** Characters already alerted by the shout being relayed right now (see Soldier.shout). */
let shoutWave: Set<Soldier> | null = null;

export class Soldier implements AiCharacter {
  readonly id!: number;
  kind: string;
  position: Vec3;
  yaw: number;
  health = 1;
  maxHealth = 1;
  team: number;
  alive = true;
  radius = 0.35 * METRE;
  height = 1.8 * METRE;
  object?: THREE.Object3D;
  taskId?: number;
  state: AiState = "idle";
  aiType: string;
  aiId: number;
  awareness = 0;

  readonly spec: CharacterSpec;
  readonly body: SoldierBody | null;
  /** The type's settings for the current difficulty (replaced when the difficulty changes). */
  config: AiConfig;
  readonly weapon: WeaponInfo | null;
  /** Grenades and flashbangs carried (one per Gun task), thrown in combat. */
  grenades: string[];
  /** The stationary gun this soldier is manning. */
  manning: MountedGun | null = null;
  /** Seconds of flinch after a hit above the type's recoil threshold (no firing meanwhile). */
  recoil = 0;
  /** An extra or a passenger: no senses, no fighting; follows `anchor` when it has one. */
  passive = false;
  anchor: (() => { position: Vec3; yaw: number } | null) | null = null;
  readonly graph: NavGraph | null;
  stance: Stance = "stand";
  clip = 0;
  /** Where the target was last seen or heard. */
  lastKnown: Vec3 | null = null;
  /** Seconds the target has been continuously visible (aim settles in over time). */
  seenTime = 0;
  /** Seconds since the target was last seen. */
  lostTime = Infinity;
  canSee = false;

  // Script state (AIFunction_*).
  viewLength = 40;
  alarmViewLength = 50;
  viewAlpha = 50;
  viewGamma = 45;
  alarmControlId = -1;
  /** A specific task (usually an alarm switch) to activate instead of the alarm control's nearest pad. */
  alarmTriggerId = -1;
  alarmAccess = "AIALARMACCESS_BEFORECOMBAT";
  /** AIFunction_SetDeathAnimation: a fixed death clip, or -1. */
  deathAnimation = -1;
  /** AIFunction_SetGunnerID: the stationary gun this character mans. */
  gunnerId = -1;
  invulnerable = false;
  instantDeath = false;
  ints: number[] = [];
  reals: number[] = [];
  priority: AiEvent[] = [...DEFAULT_PRIORITY];
  private priorityReset = false;

  private world: AiWorld;
  private actions: Action[] = [];
  private rank = Infinity;
  private event: AiEvent = "AIEVENT_CREATE";
  private eventPos: Vec3 | null = null;
  private eventAnim = -1;
  private pendingCombat = false;
  private perceiveTimer = rand() * 0.2;
  private travelSpeed = 0;
  private route: { points: Vec3[]; i: number } | null = null;
  /** Falling speed (units/s) and seconds without headway, for physics.move. */
  private fall = 0;
  private stuck = 0;
  private baseClip: number = CLIP.idle;
  private lastHeard = -Infinity;
  /** A clip that plays to its end before the base clip resumes (stance changes, rolls, hit reactions). */
  private oneShot: { id: number; then?: () => void; left: number } | null = null;
  private suspicious = 0;
  /** Door handling while walking: next check, and the door being waited on. */
  private doorCheck = 0;
  private doorWait: { id: number; time: number } | null = null;
  private doorsTried = new Map<number, number>();

  constructor(world: AiWorld, spec: CharacterSpec, body: SoldierBody | null, config: AiConfig, weapon: WeaponInfo | null) {
    this.world = world;
    this.spec = spec;
    this.body = body;
    this.config = config;
    this.weapon = weapon;
    this.kind = spec.aiType === "AITYPE_CIVILIAN" ? "civilian" : "soldier";
    this.position = [...spec.position];
    this.yaw = spec.gamma;
    this.team = spec.team;
    this.taskId = spec.taskId >= 0 ? spec.taskId : undefined;
    this.aiType = spec.aiType;
    this.aiId = spec.aiId;
    this.graph = world.graph(spec.graphId);
    this.object = body?.object;
    this.clip = weapon?.clipSize ?? 0;
    this.grenades = [...spec.weapons.filter((w) => w === "WEAPON_ID_GRENADE"), ...spec.weapons.filter((w) => w === "WEAPON_ID_FLASHBANG")];
    if (body) body.clips.play(this.idleClip(), { blend: 0 });
  }

  get game() {
    return this.world.game;
  }

  eye(): Vec3 {
    const h = this.stance === "stand" ? 1.7 : this.stance === "crouch" ? 1.2 : 0.4;
    return [this.position[0], this.position[1], this.position[2] + h * METRE];
  }

  idleClip(): number {
    const s = this.spec.standAnimation;
    return s >= 0 && this.body?.clips.clip(s) ? s : CLIP.idle;
  }

  // ------------------------------------------------------------------------------------------------- events

  /** Deliver an AI event: run the scripts for it unless the current actions outrank it. */
  post(event: AiEvent, options: { position?: Vec3; animation?: number } = {}) {
    if (!this.alive && event !== "AIEVENT_DEAD") return;
    // Events raised while handling events (alerts passed between comrades) stop after a few levels.
    if (this.posting > 3) return;
    this.posting++;
    try {
      this.handle(event, options);
    } finally {
      this.posting--;
    }
  }

  /** What a pushable action interrupted. */
  private suspended: { actions: Action[]; rank: number }[] = [];

  /** The comrade whose AIEVENT_ALERT is being handled. */
  alertFrom: Soldier | null = null;
  private posting = 0;

  private handle(event: AiEvent, options: { position?: Vec3; animation?: number }) {
    const rank = this.rankOf(event);
    if (event !== "AIEVENT_CREATE" && this.actions.length && rank > this.rank) return;
    this.event = event;
    if (options.position) this.eventPos = [...options.position];
    if (options.animation !== undefined) this.eventAnim = options.animation;
    const queued: Action[] = [];
    this.pendingCombat = false;
    this.runScripts(queued);
    if (queued.length) {
      for (const a of queued) a.rank = rank;
      // Pushable actions under way are pushed down and resume afterwards; anything else is replaced.
      if (this.actions.length && this.actions[0].pushable && event !== "AIEVENT_DEAD") {
        this.suspended.push({ actions: this.actions, rank: this.rank });
        if (this.suspended.length > 3) this.suspended.shift();
      }
      this.actions = queued;
      this.rank = rank;
      this.route = null;
    }
    if (this.pendingCombat && event !== "AIEVENT_COMBAT") this.post("AIEVENT_COMBAT", options);
  }

  private rankOf(event: AiEvent): number {
    const i = this.priority.indexOf(event);
    return i < 0 ? this.priority.length : i;
  }

  private runScripts(queued: Action[]) {
    // Level scripts branch on mission state ("if (EditVariable_752.nValue == 1) AIAction_Patrol(711, ...)": level4's
    // friendly team advances that way); without this every task field read 0.
    const mission = this.game.services.mission;
    const scriptVariable = (name: string): ScriptValue => mission?.evaluate(name) ?? 0;
    const scriptAssign = (name: string, value: ScriptValue) => mission?.assign?.(name, Number(value) || 0);
    const level = this.world.script(this.aiId);
    const common = this.world.commonScript(this.aiType);
    const natives = this.natives(queued, common, scriptVariable, scriptAssign);
    // Without a level script the common script runs through DefaultHandler, which guards against recursion.
    if (level) runScript(level, natives, scriptVariable, scriptAssign);
    else natives.AIFunction_DefaultHandler();
  }

  /** The engine side of the scripts: AIFunction_* queries/settings and AIAction_* actions. */
  private natives(
    queued: Action[],
    common: QvmScript | null,
    variable: (name: string) => ScriptValue,
    assign: (name: string, value: ScriptValue) => void,
  ): ScriptNatives {
    const n = (v: ScriptValue | undefined) => (typeof v === "number" ? v : 0);
    // A DefaultHandler call from inside the common script means the engine's built-in handling, not the common
    // script again (that would recurse until the stack overflowed).
    let inCommon = false;
    const natives: ScriptNatives = {
      AIFunction_GetCurrentEventType: () => this.event,
      AIFunction_DefaultHandler: () => {
        if (common && !inCommon) {
          inCommon = true;
          try {
            runScript(common, natives, variable, assign);
          } finally {
            inCommon = false;
          }
        } else if (this.event === "AIEVENT_IDLE") queued.push(idle(2));
        else if (this.event === "AIEVENT_DEAD") queued.push(dead());
        else if (/ENEMYDETECTION|GUNSHOT|TAKINGDAMAGE|ALERT/.test(this.event)) this.pendingCombat = true;
        else if (this.event === "AIEVENT_COMBAT") queued.push(combat());
      },
      AIFunction_SetEventPriority: (e) => {
        if (!this.priorityReset) {
          this.priority = [];
          this.priorityReset = true;
        }
        if (!this.priority.includes(e as AiEvent)) this.priority.push(e as AiEvent);
      },
      AIFunction_SetViewLength: (v) => void (this.viewLength = n(v)),
      AIFunction_SetAlarmViewLength: (v) => void (this.alarmViewLength = n(v)),
      AIFunction_SetViewAlpha: (v) => void (this.viewAlpha = n(v)),
      AIFunction_SetViewGamma: (v) => void (this.viewGamma = n(v)),
      AIFunction_SetAlarmControlID: (v) => void (this.alarmControlId = n(v)),
      AIFunction_SetInvulnerability: (v) => void (this.invulnerable = !!n(v)),
      AIFunction_SetInstantDeath: (v) => void (this.instantDeath = !!n(v)),
      AIFunction_SetAlarmTriggerID: (v) => void (this.alarmTriggerId = n(v)),
      AIFunction_GetAlarmTriggerID: () => (this.alarmTriggerId >= 0 ? this.alarmTriggerId : this.alarmControlId),
      AIFunction_GetAlarmControlID: () => this.alarmControlId,
      // Scripts that never set it run for the alarm before they fight.
      AIFunction_SetAlarmAccess: (v) => void (this.alarmAccess = String(v)),
      AIFunction_GetAlarmAccess: () => this.alarmAccess,
      AIFunction_SetDeathAnimation: (v) => void (this.deathAnimation = n(v)),
      AIFunction_SetGunnerID: (v) => void (this.gunnerId = n(v)),
      AIFunction_GetAlarmControlStatus: () => Number(this.world.alarmOn),
      AIFunction_GetAlarmTriggerDistance: () => {
        const p = this.world.taskPosition(this.alarmControlId);
        return p ? dist(p, this.position) : 1e9;
      },
      AIFunction_GetEventDistance: () => (this.eventPos ? dist(this.eventPos, this.position) : 1e9),
      AIFunction_IsEventBehind: () => {
        if (!this.eventPos) return 0;
        return Number(Math.abs(wrap(yawTo(this.position, this.eventPos) - this.yaw)) > Math.PI / 2);
      },
      AIFunction_GetRandomValue: (v) => rand() * n(v),
      AIFunction_SetScriptIntegerValue: (i, v) => void (this.ints[n(i)] = Math.trunc(n(v))),
      AIFunction_GetScriptIntegerValue: (i) => this.ints[n(i)] ?? 0,
      AIFunction_SetScriptRealValue: (i, v) => void (this.reals[n(i)] = n(v)),
      AIFunction_GetScriptRealValue: (i) => this.reals[n(i)] ?? 0,
      AIFunction_GetAnimationToPlay: () => this.eventAnim,
      AIFunction_RemoveAlarmActions: () => {
        this.actions = this.actions.filter((a) => !(a instanceof ActivateAction));
      },
      // Answer the comrade whose alert this is (AIEVENT_ALERT_RESPONSE); the alert itself spread when it started.
      AIFunction_SendResponse: () => {
        const from = this.alertFrom;
        if (this.event === "AIEVENT_ALERT" && from?.alive) from.post("AIEVENT_ALERT_RESPONSE", { position: this.position });
      },
      AIFunction_GetGunnerID: () => this.gunnerId,
      AIFunction_GetGunnerStatus: () => Number(this.manning !== null),
      AIAction_Patrol: (path, start, flag) => {
        const commands = this.spec.patrols.get(n(path));
        if (commands) queued.push(flagged(new PatrolAction(commands, n(start)), flag));
      },
      AIAction_Idle: () => void queued.push(idle(2 + rand() * 2)),
      // Scripted idle animations are not alarm; reactions to shots, explosions and grenades are (HumanAI.isDetection).
      AIAction_PlayAnimation: (id, flag) => void queued.push(flagged(animation(n(id), THREAT.test(this.event) ? "alert" : "idle"), flag)),
      AIAction_SetCombat: () => void (this.pendingCombat = true),
      // Unarmed characters that are not civilians (Priboi, escorts) take cover for a moment instead of fighting.
      AIAction_Combat: (flag) =>
        void queued.push(flagged(this.kind === "civilian" ? panic(15) : this.weapon || this.manning || this.gunnerId >= 0 ? combat() : takeCover(4 + rand() * 2), flag)),
      AIAction_Activate: (task, _run, flag) => void queued.push(flagged(new ActivateAction(n(task)), flag)),
      AIAction_RunPanicking: (seconds) => void queued.push(panic(n(seconds) || 10)),
      AIAction_FallFlat: (seconds) => void queued.push(fallFlat(n(seconds) || 2)),
      AIAction_LookAtEvent: () => void queued.push(lookAtEvent()),
      AIAction_Dead: () => void queued.push(dead()),
      AIAction_RunToNode: (node) => void queued.push(toNode(n(node), "run")),
      AIAction_FireAtTask: (task, rounds, seconds) => void queued.push(fireAtTask(n(task), n(rounds), n(seconds))),
      AIAction_FireAtNode: (node, rounds, seconds) => void queued.push(fireAtTask(n(node), n(rounds), n(seconds), true)),
      AIAction_WalkToNode: (node) => void queued.push(toNode(n(node), "walk")),
      AIAction_MoveToEvent: () => void queued.push(moveToEvent()),
      AIAction_Stunned: () => void queued.push(animation(CLIP.stunned, "alert")),
    };
    return natives;
  }

  /**
   * Tell nearby comrades (AIEVENT_ALERT) where the enemy is. An alerted guard's script answers with
   * AIFunction_SendResponse, which shouts again; each guard hears one wave of shouts once, so two guards in earshot
   * do not alert each other forever (that recursed until the stack overflowed).
   */
  shout() {
    if (!this.lastKnown) return;
    const outermost = shoutWave === null;
    const wave = (shoutWave ??= new Set());
    wave.add(this);
    try {
      for (const other of this.world.characters()) {
        if (other === this || !other.alive || other.team !== this.team || wave.has(other)) continue;
        const d = dist(other.position, this.position);
        if (d < 15 * METRE || (d < 35 * METRE && this.game.services.physics?.lineOfSight(this.eye(), other.eye()))) {
          wave.add(other);
          other.lastKnown ??= [...this.lastKnown];
          other.alertFrom = this;
          other.post("AIEVENT_ALERT", { position: this.lastKnown });
        }
      }
    } finally {
      if (outermost) shoutWave = null;
    }
  }

  // ------------------------------------------------------------------------------------------------- frame

  update(dt: number) {
    if (this.passive) {
      const a = this.anchor?.();
      if (a) {
        this.position = [...a.position];
        this.yaw = a.yaw;
      }
      if (this.alive && !this.oneShot) this.setBase(this.idleClip());
      if (!this.alive) this.actions[0]?.update(this, dt);
      this.animate(dt);
      return;
    }
    if (this.recoil > 0) this.recoil -= dt;
    if (this.alive) {
      this.perceive(dt);
      if (this.suspicious > 0 && this.state !== "combat") {
        // Something caught its eye: stop and look before deciding it was nothing.
        this.suspicious -= dt;
        if (this.lastKnown) this.turnTowards(yawTo(this.position, this.lastKnown), dt);
        this.state = "search";
        this.setBase(CLIP.aim);
      } else this.runActions(dt);
    } else this.actions[0]?.update(this, dt);
    this.animate(dt);
  }

  private runActions(dt: number) {
    let guard = 4;
    while (guard-- > 0) {
      const a = this.actions[0];
      if (!a && this.suspended.length) {
        // The actions that pushed a pushable one aside are over: carry on with it.
        ({ actions: this.actions, rank: this.rank } = this.suspended.pop()!);
        this.route = null;
        this.actions[0]?.resume?.();
        continue;
      }
      if (!a) {
        this.rank = Infinity;
        this.post("AIEVENT_IDLE");
        if (!this.actions.length) {
          this.state = "idle";
          this.setBase(this.idleClip());
          return;
        }
        continue;
      }
      const done = a.update(this, dt);
      this.state = a.state;
      if (!done) return;
      this.actions.shift();
      this.route = null;
      if (!this.actions.length) this.rank = Infinity;
    }
  }

  private animate(dt: number) {
    const b = this.body;
    if (!b) return;
    // Some skeletons flag their stance transitions as looping (level13's 018_01_1: 7 stand-to-crouch, 19
    // crouch-to-stand), so a one-shot also ends after one run of its clip; otherwise the soldier stayed busy forever and
    // never fired again.
    if (this.oneShot && b.clips.clipId === this.oneShot.id && (b.clips.finished || (this.oneShot.left -= dt) <= 0)) {
      const then = this.oneShot.then;
      this.oneShot = null;
      then?.();
    }
    if (!this.oneShot && b.clips.clipId !== this.baseClip) b.clips.play(this.baseClip);
    b.clips.advance(dt);
    b.place(this.game.local(this.position), this.yaw);
    // Off-screen bodies are not posed; far-away ones are posed at a quarter of the rate.
    this.posed = false;
    if (!this.world.inView(this.position)) return;
    const far = dist(this.position, this.game.fromScene(this.game.camera.position)) > 120 * METRE;
    if (!far || ((this.id + Math.floor(this.game.time * 30)) & 3) === 0) {
      b.pose(dt);
      this.posed = true;
    }
  }

  /** Whether the body's bones show this frame's pose (off-screen bodies are not posed, so their gun bone is stale). */
  posed = false;

  setBase(clip: number, speed = 1) {
    this.baseClip = this.body?.clips.clip(clip) ? clip : this.idleClip();
    if (!this.oneShot && this.body?.clips.clipId === this.baseClip) this.body.clips.play(this.baseClip, { speed });
    else if (!this.oneShot) this.body?.clips.play(this.baseClip, { speed, keepPhase: true });
  }

  /** Play a clip to its end, then return to the base clip. */
  playOnce(clip: number, then?: () => void) {
    if (!this.body?.clips.clip(clip)) {
      then?.();
      return;
    }
    this.oneShot = { id: clip, then, left: this.body.clips.clip(clip)!.duration / ANIM_TICKS_PER_SECOND };
    this.body.clips.play(clip);
  }

  /** Fire one round from the muzzle along `dir`. */
  shoot(origin: Vec3, dir: Vec3) {
    this.world.shoot(this, origin, dir);
  }

  /** Fire one round of another weapon (a stationary gun's). */
  shootWith(weaponId: string, origin: Vec3, dir: Vec3) {
    const w = this.world.weaponInfo(weaponId);
    if (w) this.world.shoot(this, origin, dir, w);
  }

  weaponInfo(id: string) {
    return this.world.weaponInfo(id);
  }

  throwGrenade(weapon: string, origin: Vec3, velocity: Vec3, fuse: number) {
    this.world.throwGrenade(this, weapon, origin, velocity, fuse);
  }

  /**
   * Is a living comrade within a metre of the line from `from` to `to` (or just beyond it, where a miss carries on)?
   * Soldiers hold their fire then (see docs/formats/ai.md: friendly fire).
   */
  comradeInLine(from: Vec3, to: Vec3): boolean {
    const dir = vec3.sub(to, from);
    const len = vec3.length(dir);
    if (len <= 0) return false;
    const u = vec3.scale(dir, 1 / len);
    const reach = len + 3 * METRE;
    for (const o of this.world.characters()) {
      if (o === this || !o.alive || o.team !== this.team) continue;
      const c: Vec3 = [o.position[0], o.position[1], o.position[2] + (o.stance === "prone" ? 0.3 : o.stance === "crouch" ? 0.7 : 1.1) * METRE];
      const rel = vec3.sub(c, from);
      const along = vec3.dot(rel, u);
      if (along <= 0 || along > reach) continue;
      const off = vec3.length(vec3.sub(rel, vec3.scale(u, along)));
      if (off < 1 * METRE) return true;
    }
    return false;
  }

  /** The stationary gun with this task id, if the level has it. */
  gunAt(id: number): MountedGun | undefined {
    return this.world.gun(id);
  }

  /** Take position at a stationary gun (AIAction_Activate on the gunner id). False if someone else has it. */
  mount(gun: MountedGun): boolean {
    if (gun.gunner >= 0 && gun.gunner !== this.id) {
      const other = this.game.entities.get(gun.gunner);
      if (other?.alive) return false;
    }
    gun.gunner = this.id;
    this.manning = gun;
    this.route = null;
    this.stance = "stand";
    this.position = gun.standPosition(this.game);
    this.yaw = gun.yaw;
    return true;
  }

  dismount() {
    if (this.manning?.gunner === this.id) this.manning.gunner = -1;
    this.manning = null;
  }

  /**
   * Where to go to activate task `id`: the task itself when it is the alarm trigger or a gun to man, otherwise (an
   * alarm control) the nearest alarm pad when the mission system knows them.
   */
  alarmTarget(id: number): Vec3 | undefined {
    if (id === this.gunnerId) {
      const gun = this.world.gun(id);
      if (gun) return gun.standPosition(this.game);
    }
    if (id === this.alarmTriggerId || id === this.gunnerId) return this.world.taskPosition(id);
    const pads = this.game.services.mission?.alarmPads() ?? [];
    let best: Vec3 | undefined;
    for (const pad of pads) if (!best || dist(pad.position, this.position) < dist(best, this.position)) best = pad.position;
    return best ?? this.world.taskPosition(id);
  }

  taskPosition(id: number): Vec3 | undefined {
    return this.world.taskPosition(id);
  }

  raiseAlarm() {
    this.world.raiseAlarm(this);
  }

  /** Where the event being handled happened. */
  get eventPosition(): Vec3 | null {
    return this.eventPos;
  }

  get busyAnimating() {
    return this.oneShot !== null;
  }

  // ------------------------------------------------------------------------------------------------- movement

  turnTowards(yaw: number, dt: number, rate = 5): boolean {
    const d = wrap(yaw - this.yaw);
    const step = rate * dt;
    this.yaw = Math.abs(d) <= step ? yaw : wrap(this.yaw + Math.sign(d) * step);
    return Math.abs(d) < 0.08;
  }

  /** Units per second for a gait: the clip's own root speed, or the patrol's "travel speed" (km/h). */
  private speed(gait: "walk" | "run" | "sprint"): number {
    if (gait === "walk" && this.travelSpeed > 0) return (this.travelSpeed / 3.6) * METRE;
    const id = gait === "walk" ? CLIP.walk : gait === "run" ? CLIP.run : CLIP.sprint;
    const clip = this.body?.clips.clip(id);
    const v = clip ? Math.hypot(...cycleVelocity(clip)) : 0;
    return v > 0 ? v : (gait === "walk" ? 1.3 : gait === "run" ? 3.5 : 4.5) * METRE;
  }

  setTravelSpeed(kmh: number) {
    this.travelSpeed = kmh;
  }

  /** Plan a route to a position over the soldier's graph (straight line without one), optionally only its first stretch. */
  goTo(target: Vec3, finish = true, limit = Infinity) {
    let points = this.graph ? this.graph.route(this.position, target, finish) : [target];
    if (limit < Infinity) {
      let total = 0, prev = this.position;
      const cut: Vec3[] = [];
      for (const p of points) {
        cut.push(p);
        total += dist(prev, p);
        prev = p;
        if (total >= limit) break;
      }
      points = cut;
    }
    // Comrades heading for (or standing on) the same spot: stop beside them, not on top of them.
    const last = points.length ? points[points.length - 1] : null;
    if (last) points[points.length - 1] = this.freeSpot(last);
    this.route = { points, i: 0 };
  }

  /** The route's end, for comrades choosing where to stand. */
  get destination(): Vec3 | null {
    return this.route ? this.route.points[this.route.points.length - 1] : null;
  }

  /** `p`, or a point 1.2-2 m around it when a comrade stands there or is heading there. */
  private freeSpot(p: Vec3): Vec3 {
    const taken = (q: Vec3) =>
      this.world.characters().some((o) => {
        if (o === this || !o.alive) return false;
        const at = o.destination ?? o.position;
        return Math.hypot(at[0] - q[0], at[1] - q[1]) < 1.1 * METRE && Math.abs(at[2] - q[2]) < 2 * METRE;
      });
    if (!taken(p)) return p;
    const physics = this.game.services.physics;
    for (let k = 0; k < 8; k++) {
      const a = (this.id * 2.4 + k * Math.PI / 4) % (Math.PI * 2);
      const r = (1.2 + (k & 1) * 0.8) * METRE;
      const q: Vec3 = [p[0] + Math.cos(a) * r, p[1] + Math.sin(a) * r, p[2]];
      const z = physics?.groundHeight(q[0], q[1], p[2] + 1 * METRE);
      if (z === null || z === undefined || Math.abs(z - p[2]) > 0.6 * METRE) continue;
      q[2] = z;
      if (!taken(q) && (!physics || physics.lineOfSight([p[0], p[1], p[2] + METRE], [q[0], q[1], q[2] + METRE]))) return q;
    }
    return p;
  }

  /** Sideways push away from comrades closer than 0.9 m, so soldiers walking the same way do not merge. */
  private separation(): [number, number] {
    let x = 0, y = 0;
    for (const o of this.world.characters()) {
      if (o === this || !o.alive) continue;
      const dx = this.position[0] - o.position[0], dy = this.position[1] - o.position[1];
      const d = Math.hypot(dx, dy);
      const min = 0.9 * METRE;
      if (d >= min || Math.abs(this.position[2] - o.position[2]) > 1.5 * METRE) continue;
      const f = (min - d) / min;
      if (d < 1) {
        x += Math.cos(this.id) * f;
        y += Math.sin(this.id) * f;
      } else {
        x += (dx / d) * f;
        y += (dy / d) * f;
      }
    }
    return [x, y];
  }

  get moving() {
    return this.route !== null;
  }

  /**
   * Advance along the planned route; true when it is done. Steps go through physics.move, so walls and floors hold
   * the soldier; a soldier that makes no headway for a second skips to its next point.
   */
  follow(dt: number, gait: "walk" | "run" | "sprint"): boolean {
    const r = this.route;
    if (!r) return true;
    if (this.manning) this.dismount();
    if (this.stance !== "stand") this.stance = "stand";
    const target = r.points[r.i];
    const dx = target[0] - this.position[0], dy = target[1] - this.position[1];
    const d = Math.hypot(dx, dy);
    if (this.waitForDoor(dt, dx, dy, d)) return false;
    const step = Math.min(d, this.speed(gait) * dt);
    this.turnTowards(yawTo(this.position, target), dt, 6);
    const physics = this.game.services.physics;
    const before = this.position;
    if (physics) {
      this.fall = Math.min(this.fall + 9.8 * METRE * dt, 30 * METRE);
      const [sx, sy] = this.separation();
      const push = 1.5 * METRE * dt;
      const delta: Vec3 = d > 0 ? [(dx / d) * step + sx * push, (dy / d) * step + sy * push, -this.fall * dt] : [sx * push, sy * push, -this.fall * dt];
      const moved = physics.move(this.position, delta, this.radius, this.height);
      this.position = moved.position;
      if (moved.grounded) this.fall = 0;
    } else {
      const f = d > 0 ? step / d : 0;
      this.position = [this.position[0] + dx * f, this.position[1] + dy * f, target[2]];
    }
    const progress = Math.hypot(this.position[0] - before[0], this.position[1] - before[1]);
    this.stuck = step > 0 && progress < step * 0.2 ? this.stuck + dt : 0;
    if (d - progress < 0.25 * METRE || this.stuck > 1) {
      this.stuck = 0;
      r.i++;
    }
    const clip = gait === "walk" ? CLIP.walk : gait === "run" ? CLIP.run : CLIP.sprint;
    const natural = this.speed(gait);
    const clipSpeed = gait === "walk" && this.travelSpeed > 0 ? natural / Math.max(1, this.speedOfClip(CLIP.walk)) : 1;
    this.setBase(clip, clipSpeed);
    if (r.i >= r.points.length) {
      this.route = null;
      return true;
    }
    return false;
  }

  /**
   * Doors on the way: when the next stretch of the route runs into a closed, unlocked door, the soldier opens it (as
   * the use key does) and waits for it to swing open, up to two seconds; locked doors stay shut (the route's stuck
   * rule moves on). A door is tried once in a while, not over and over.
   */
  private waitForDoor(dt: number, dx: number, dy: number, d: number): boolean {
    const mission = this.game.services.mission;
    if (!mission?.door) return false;
    if (this.doorWait) {
      const state = mission.door(this.doorWait.id);
      this.doorWait.time += dt;
      if (!state || state.open >= 0.6 || state.moving < 0 || this.doorWait.time > 2) {
        this.doorWait = null;
        return false;
      }
      this.setBase(this.idleClip());
      return true;
    }
    if ((this.doorCheck -= dt) > 0 || d <= 0) return false;
    this.doorCheck = 0.25;
    const physics = this.game.services.physics;
    if (!physics || !this.world.doors().length) return false;
    const reach = Math.min(d, 1.5 * METRE) + this.radius;
    const from: Vec3 = [this.position[0], this.position[1], this.position[2] + 1 * METRE];
    const to: Vec3 = [from[0] + (dx / d) * reach, from[1] + (dy / d) * reach, from[2]];
    const hit = physics.raycast(from, to, { ignoreEntity: this.id });
    const door = hit?.entityId != null ? this.game.entities.get(hit.entityId) : undefined;
    if (!door || door.kind !== "door") return false;
    const tried = this.doorsTried.get(door.id);
    if (tried !== undefined && this.game.time - tried < 8) return false;
    this.doorsTried.set(door.id, this.game.time);
    const state = mission.door(door.id);
    if (!state || state.locked || state.open >= 0.6 || state.moving > 0 || !mission.openDoor(this.id, door.id)) return false;
    this.doorWait = { id: door.id, time: 0 };
    this.setBase(this.idleClip());
    return true;
  }

  private speedOfClip(id: number) {
    const clip = this.body?.clips.clip(id);
    return clip ? Math.hypot(...cycleVelocity(clip)) : 0;
  }

  stopMoving() {
    this.route = null;
  }

  // ------------------------------------------------------------------------------------------------- senses

  /**
   * The enemy this character fights: the player, if alive and on another team. Not during scripted cutscenes: IGI
   * removes the HumanPlayer task then, so guards cannot shoot Jones while the outro plays.
   */
  target(): Entity | null {
    if (this.game.services.mission?.cutscene()) return null;
    const p = this.game.services.player?.entity;
    return p && p.alive && p.team !== this.team ? p : null;
  }

  private targetEye(t: Entity): Vec3 {
    const player = this.game.services.player;
    return player && t === player.entity ? player.eye() : [t.position[0], t.position[1], t.position[2] + t.height * 0.9];
  }

  /** Vision cone, range and line of sight to the target's head or chest. */
  private sees(t: Entity, cone: number, range: number): boolean {
    const eye = this.eye();
    const head = this.targetEye(t);
    const d = dist(eye, head);
    if (d > range) return false;
    const toYaw = yawTo(eye, head);
    if (Math.abs(wrap(toYaw - this.yaw)) > cone) return false;
    const horiz = Math.hypot(head[0] - eye[0], head[1] - eye[1]);
    if (Math.abs(Math.atan2(head[2] - eye[2], horiz)) > (this.viewAlpha * Math.PI) / 180) return false;
    const physics = this.game.services.physics;
    if (!physics) return true;
    if (physics.lineOfSight(eye, head)) return true;
    const chest: Vec3 = [head[0], head[1], (head[2] + t.position[2]) / 2];
    return physics.lineOfSight(eye, chest);
  }

  private perceive(dt: number) {
    if (this.passive) return;
    this.perceiveTimer -= dt;
    const fighting = this.state === "combat";
    const interval = fighting ? 0.1 : 0.2;
    if (this.canSee) this.seenTime += dt;
    else this.seenTime = Math.max(0, this.seenTime - dt * 2);
    this.lostTime = this.canSee ? 0 : this.lostTime + dt;
    if (this.perceiveTimer > 0) return;
    const step = interval - this.perceiveTimer;
    this.perceiveTimer = interval;
    const t = this.target();
    if (!t || this.kind === "civilian" && this.state === "combat") {
      this.canSee = false;
      return;
    }
    const range = (this.world.alarmOn || fighting ? this.alarmViewLength : this.viewLength) * METRE;
    const d = dist(this.position, t.position);
    if (d > range * 1.5) {
      this.canSee = false;
      this.awareness = Math.max(0, this.awareness - step * 0.2);
      return;
    }
    const halfCone = (this.viewGamma * Math.PI) / 180;
    if (fighting) {
      // Once fighting, the soldier keeps track of its enemy all around.
      this.canSee = this.sees(t, Math.max(halfCone, 2.2), range * 1.5);
      if (this.canSee) {
        this.lastKnown = [...t.position];
        this.awareness = 1;
      }
      return;
    }
    let rate = 0;
    if (this.sees(t, halfCone, range)) rate = 1;
    else if (d < 8 * METRE && this.sees(t, 1.9, 8 * METRE)) rate = 0.3; // peripheral vision
    else if (d < 1.5 * METRE) rate = 0.6; // right behind it
    this.canSee = rate > 0;
    if (rate > 0) {
      // Seconds to notice: quick up close, slow at the edge of view; harder for a crouched or still target.
      const player = this.game.services.player;
      const stance = player?.stance === "prone" ? 3 : player?.stance === "crouch" ? 1.8 : 1;
      const gait = player?.gait;
      const motion = gait === "run" ? 0.6 : gait === "idle" || gait === "crouch" && vec3.length(player!.velocity) < 1 ? 1.3 : 0.9;
      const near = d < 4 * METRE ? 0.3 : 1;
      const seconds = (0.4 + 2.6 * Math.pow(d / range, 1.5)) * stance * motion * near / (this.world.alarmOn ? 1.5 : 1);
      this.awareness = Math.min(1, this.awareness + (step * rate) / seconds);
      this.lastKnown = [...t.position];
      if (this.awareness >= 1) {
        this.suspicious = 0;
        this.post("AIEVENT_ENEMYDETECTION", { position: t.position });
      } else if (this.awareness > 0.35 && this.suspicious <= 0) this.suspicious = 1.5;
    } else this.awareness = Math.max(0, this.awareness - step * 0.15);
  }

  /** A sound reached this character. */
  hear(position: Vec3, radius: number, kind: string, sourceId: number | null) {
    if (!this.alive) return;
    const d = dist(position, this.position);
    if (d > radius) return;
    const source = sourceId !== null ? this.game.entities.get(sourceId) : undefined;
    const friendly = source && source.team === this.team;
    if (friendly && !(source instanceof Soldier && source.state === "combat")) return;
    const where = friendly ? (source as Soldier).lastKnown ?? position : position;
    if (/shot|fire|gun/.test(kind)) {
      if (this.game.time - this.lastHeard < 0.3) return;
      this.lastHeard = this.game.time;
      this.lastKnown = [...where];
      this.awareness = Math.max(this.awareness, 0.8);
      this.post("AIEVENT_GUNSHOT", { position: where });
    } else if (kind === "explosion") this.post("AIEVENT_EXPLOSION", { position });
    else if (kind === "door") this.post("AIEVENT_DOOR", { position });
    else if (kind === "fence") this.post("AIEVENT_FENCE", { position });
    else if (kind === "ladder") this.post("AIEVENT_LADDER", { position });
    else if (/step|walk|run/.test(kind)) {
      if (friendly) return;
      this.lastKnown = [...position];
      this.post("AIEVENT_WALK", { position });
    } else if (/land|impact|fall/.test(kind)) {
      if (friendly) return;
      this.lastKnown = [...position];
      this.post("AIEVENT_GROUNDIMPACT", { position });
    }
  }

  /** A bullet passed close by. */
  nearMiss(point: Vec3, sourceId: number | null) {
    const source = sourceId !== null ? this.game.entities.get(sourceId) : undefined;
    if (!this.alive || !source || source.team === this.team) return;
    this.lastKnown = [...source.position];
    this.post("AIEVENT_GUNSHOTMISS", { position: source.position });
  }

  // ------------------------------------------------------------------------------------------------- damage

  /** A hit: `amount` is in IGI damage units with the hit zone already applied (a soldier dies at 1.0). */
  damaged(amount: number, part: string | undefined, sourceId: number | null, point: Vec3, dir: Vec3) {
    if (!this.alive || amount <= 0) return;
    if (!this.invulnerable) this.health = this.instantDeath ? 0 : Math.max(0, this.health - amount);
    const source = sourceId !== null ? this.game.entities.get(sourceId) : undefined;
    const from = source?.position ?? vec3.sub(point, vec3.scale(dir, 10 * METRE));
    const side = Math.sign(wrap(yawTo(this.position, from) - this.yaw)) || 1;
    this.body?.hit(-side);
    if (this.health <= 0) {
      this.die(part, from, sourceId);
      return;
    }
    if (amount >= this.config.recoilThreshold) this.recoil = Math.max(this.recoil, 0.5 + rand() * 0.3);
    this.world.sound(`ai_hit_0${1 + Math.floor(rand() * 3)}`, this.position);
    this.lastKnown = [...from];
    this.awareness = 1;
    this.post("AIEVENT_TAKINGDAMAGE", { position: from });
  }

  die(part: string | undefined, from: Vec3 | null, killerId: number | null, deathEmitted = false) {
    if (!this.alive) return;
    this.alive = false;
    this.health = 0;
    this.state = "dead";
    this.canSee = false;
    this.route = null;
    this.oneShot = null;
    this.actions = [];
    this.suspended = [];
    this.rank = Infinity;
    this.dismount();
    // Script DEAD handlers only queue AIAction_Dead; we always play the death ourselves.
    this.actions = [dead(part, from)];
    // The weapons system drops the gun as a pickup.
    if (this.body?.gun && this.game.services.weapons) this.body.gun.visible = false;
    this.world.sound(`ai_death_0${1 + Math.floor(rand() * 4)}`, this.position);
    if (!deathEmitted) this.game.events.emit("death", { entityId: this.id, killerId });
  }
}

// ----------------------------------------------------------------------------------------------------- actions

function idle(seconds: number): Action {
  let t = seconds;
  return {
    state: "idle",
    update(s, dt) {
      s.setBase(s.idleClip());
      return (t -= dt) <= 0;
    },
  };
}

function animation(id: number, state: AiState): Action {
  let started = false;
  let done = false;
  return {
    state,
    update(s) {
      if (!started) {
        started = true;
        s.stopMoving();
        s.playOnce(id, () => (done = true));
      }
      return done || !s.busyAnimating;
    },
  };
}

function lookAtEvent(): Action {
  let hold = 1.5;
  return {
    state: "search",
    update(s, dt) {
      const p = s.eventPosition ?? s.lastKnown;
      if (p && !s.turnTowards(yawTo(s.position, p), dt)) return false;
      s.setBase(CLIP.aim);
      return (hold -= dt) <= 0;
    },
  };
}

function dead(part?: string, from?: Vec3 | null): Action {
  let started = false;
  let fall = 1;
  return {
    state: "dead",
    update(s, dt) {
      if (!started) {
        started = true;
        const front = from ? Math.abs(wrap(yawTo(s.position, from) - s.yaw)) < Math.PI / 2 : true;
        const clip =
          s.deathAnimation >= 0 && s.body?.clips.clip(s.deathAnimation) ? s.deathAnimation
          : s.stance === "prone" ? CLIP.deathProne
          : s.stance === "crouch" ? CLIP.deathCrouch
          : part === "head" ? pick(CLIP.deathHead)
          : pick(front ? CLIP.deathsFront : CLIP.deathsBack);
        s.setBase(clip);
        s.body?.clips.play(clip, { blend: 0.1 });
      }
      if (fall > 0 && (fall -= dt) <= 0) s.game.services.audio?.play(`common/sounds/bodyfall_${1 + Math.floor(rand() * 8)}.wav`, { at: s.position });
      return false;
    },
  };
}

function panic(seconds: number): Action {
  let t = seconds;
  return {
    state: "alert",
    update(s, dt) {
      if (!s.moving) {
        const away = s.lastKnown ?? s.position;
        const options = s.graph?.walkable.filter((n) => {
          const d = dist(n.position, s.position);
          return d > 10 * METRE && d < 40 * METRE && dist(n.position, away) > dist(s.position, away);
        });
        const goal = options?.length ? pick(options).position : vec3.add(s.position, vec3.scale(direction(rand() * 6.3), 15 * METRE));
        s.goTo(goal);
      }
      s.follow(dt, "sprint");
      return (t -= dt) <= 0;
    },
  };
}

function fallFlat(seconds: number): Action {
  let phase = 0;
  let t = seconds;
  return {
    state: "alert",
    update(s, dt) {
      if (phase === 0) {
        phase = 1;
        s.stopMoving();
        s.stance = "prone";
        s.setBase(CLIP.prone);
        s.playOnce(CLIP.standToProne);
      } else if (phase === 1 && !s.busyAnimating && (t -= dt) <= 0) {
        phase = 2;
        s.playOnce(CLIP.proneToStand, () => {
          s.stance = "stand";
          phase = 3;
        });
        s.setBase(s.idleClip());
      }
      return phase === 3;
    },
  };
}

/**
 * Combat for a character without a gun (Priboi, escorts): crouch where it is, facing away from the threat, for a few
 * seconds, then carry on (a pushable patrol it interrupted resumes).
 */
function takeCover(seconds: number): Action {
  let t = seconds;
  let started = false;
  return {
    state: "alert",
    update(s, dt) {
      if (!started) {
        started = true;
        s.stopMoving();
        if (s.stance === "stand") s.playOnce(CLIP.standToCrouch);
        s.stance = "crouch";
      }
      s.setBase(CLIP.crouch);
      if ((t -= dt) > 0) return false;
      s.stance = "stand";
      s.playOnce(CLIP.crouchToStand);
      return true;
    },
  };
}

/** AIAction_MoveToEvent: run to where the event happened. */
function moveToEvent(): Action {
  let started = false;
  return {
    state: "search",
    update(s, dt) {
      if (!started) {
        started = true;
        const p = s.eventPosition ?? s.lastKnown;
        if (!p) return true;
        s.goTo(p);
      }
      return s.follow(dt, "run");
    },
  };
}

function toNode(node: number, gait: "walk" | "run"): Action {
  let started = false;
  return {
    state: "patrol",
    update(s, dt) {
      if (!started) {
        started = true;
        const n = s.graph?.node(node);
        if (!n) return true;
        s.goTo(n.position);
      }
      return s.follow(dt, gait);
    },
    resume() {
      started = false;
    },
  };
}

/** Run to a task and activate it: raise the alarm at an alarm pad, or use it (a switch, a stationary gun). */
class ActivateAction implements Action {
  state: AiState = "combat";
  private started = false;
  private pressing = -1;
  private task: number;
  constructor(task: number) {
    this.task = task;
  }
  update(s: Soldier, dt: number) {
    const alarm = this.task !== s.gunnerId;
    if (alarm && s.game.services.ai?.alarm) return true;
    const gun = alarm ? undefined : s.gunAt(this.task);
    if (gun && s.manning === gun) return true;
    const p = s.alarmTarget(this.task);
    if (!p) return true;
    if (!this.started) {
      this.started = true;
      s.goTo(p);
    }
    if (this.pressing < 0) {
      if (!s.follow(dt, "sprint")) return false;
      this.pressing = 1;
      s.setBase(s.idleClip());
      s.turnTowards(yawTo(s.position, p), 1);
    }
    if (gun) {
      s.mount(gun);
      return true;
    }
    if ((this.pressing -= dt) > 0) return false;
    if (alarm) s.raiseAlarm();
    else s.game.services.mission?.use(s.id, this.task);
    return true;
  }
}

/**
 * AIAction_FireAtTask(task, rounds, seconds, ...) / AIAction_FireAtNode(node, ...): shoot at a task's position or a
 * graph node (scripted suppression fire).
 */
function fireAtTask(task: number, rounds: number, seconds: number, node = false): Action {
  let left = Math.max(1, rounds);
  let wait = 0;
  let hold = Math.max(0.5, seconds);
  return {
    state: "combat",
    update(s, dt) {
      const p = (node ? s.graph?.node(task)?.position : s.taskPosition(task)) ?? s.eventPosition;
      if (!p || !s.weapon) return true;
      s.stopMoving();
      s.setBase(left > 0 ? CLIP.fire : CLIP.aim);
      if (!s.turnTowards(yawTo(s.position, p), dt, 4)) return false;
      if (left > 0 && (wait -= dt) <= 0) {
        const eye = s.eye();
        const target: Vec3 = [p[0] + (rand() - 0.5) * METRE, p[1] + (rand() - 0.5) * METRE, p[2] + rand() * METRE];
        s.shoot(eye, vec3.normalize(vec3.sub(target, eye)));
        left--;
        wait = 60 / Math.max(1, s.weapon.roundsPerMinute);
      }
      return left <= 0 && (hold -= dt) <= 0;
    },
  };
}

/** PatrolPath commands (PatrolPathCommand "Command" ids, named by the editor notes in objects.qvm). */
export const PATROL_COMMAND = {
  playAnimation: 0,
  delay: 1,
  walkToNode: 2,
  runToNode: 3,
  crouch: 4,
  lookAtNode: 5,
  /** "End script, only runs commands after this one": what follows repeats forever. */
  loopRest: 6,
  quit: 7,
  travelSpeed: 8,
} as const;

class PatrolAction implements Action {
  state: AiState = "patrol";
  private i: number;
  private loopFrom = -1;
  private wait = -1;
  private started = false;
  private turns = 0;
  private commands: PatrolCommand[];
  constructor(commands: PatrolCommand[], start: number) {
    this.commands = commands;
    this.i = Math.max(0, start);
  }

  resume() {
    this.started = false;
    this.wait = -1;
  }

  update(s: Soldier, dt: number): boolean {
    for (let guard = 0; guard < 8; guard++) {
      const c = this.commands[this.i];
      if (!c) {
        if (this.loopFrom < 0 || this.loopFrom >= this.commands.length) return true;
        this.i = this.loopFrom;
        // A loop with nothing that takes time would spin: let a frame pass.
        if (++this.turns > 1) return false;
        continue;
      }
      if (!this.run(s, c, dt)) return false;
      this.i++;
      this.started = false;
      this.wait = -1;
    }
    return false;
  }

  /** Execute one command; true when it is complete. */
  private run(s: Soldier, c: PatrolCommand, dt: number): boolean {
    this.turns = 0;
    switch (c.command) {
      case PATROL_COMMAND.playAnimation:
        this.state = "idle";
        if (!this.started) {
          this.started = true;
          s.playOnce(c.param);
        }
        return !s.busyAnimating;
      case PATROL_COMMAND.delay:
        this.state = "idle";
        if (this.wait < 0) this.wait = c.param / GAME_FREQUENCY;
        s.setBase(s.stance === "crouch" ? CLIP.crouch : s.idleClip());
        return (this.wait -= dt) <= 0;
      case PATROL_COMMAND.walkToNode:
      case PATROL_COMMAND.runToNode: {
        const node = s.graph?.node(c.param);
        if (!node) return true;
        this.state = "patrol";
        if (!this.started) {
          this.started = true;
          s.goTo(node.position);
        }
        return s.follow(dt, c.command === PATROL_COMMAND.walkToNode ? "walk" : "run");
      }
      case PATROL_COMMAND.crouch:
        if (s.stance !== "crouch") {
          s.stance = "crouch";
          s.playOnce(CLIP.standToCrouch);
        }
        s.setBase(CLIP.crouch);
        return true;
      case PATROL_COMMAND.lookAtNode: {
        const node = s.graph?.node(c.param);
        if (!node) return true;
        this.state = "idle";
        s.setBase(s.stance === "crouch" ? CLIP.crouch : s.idleClip());
        return s.turnTowards(yawTo(s.position, node.position), dt, 2.5);
      }
      case PATROL_COMMAND.loopRest:
        this.loopFrom = this.i + 1;
        return true;
      case PATROL_COMMAND.quit:
        this.i = this.commands.length;
        this.loopFrom = -1;
        return true;
      case PATROL_COMMAND.travelSpeed:
        s.setTravelSpeed(c.param);
        return true;
    }
    return true;
  }
}

// ----------------------------------------------------------------------------------------------------- combat

function combat(): Action {
  return new CombatAction();
}

/**
 * How a soldier fights, after the combat modes IGI.exe names: "Combat - Kneel/Liedown/RePosition/Follow/LookForTarget"
 * (patrols move, dodge and close in), "Guard Combat - Stand" (guards and snipers hold their post), "RPG Combat -
 * Stand/Kneel" and "Gunner Combat - Stand" (at a stationary gun).
 */
type CombatStyle = "mobile" | "post" | "rpg" | "gunner";

function combatStyle(s: Soldier): CombatStyle {
  if (s.manning) return "gunner";
  if (s.aiType === "AITYPE_RPG" || s.weapon?.id === "WEAPON_ID_RPG18") return "rpg";
  if (/GUARD|SNIPER|GUNNER/.test(s.aiType)) return "post";
  return "mobile";
}

/** Grenade throw (soldier clip 70: right hand swings up to 1.6 m and forward) and the moment the grenade leaves the hand. */
const THROW_RELEASE = 0.55;
/** Horizontal throw speed cap (m/s): fly times from settings.qvm stretch so long throws stay a lob. */
const THROW_SPEED = 16;
const GRAVITY = 9.81 * METRE;

/**
 * Chance that one aimed round hits, from the type's HumanAIConfigItem: "hit probability at minimum range" falling to
 * "at maximum range" over the soldier's view range, capped beyond 10 m by "aim precision", times how long the target
 * has been in sight (aim settles in over 3 s) and how hard the target is to hit (crouched, prone, moving). The data
 * gives the two probabilities and the precision; how IGI.exe combines them is not known (see docs/formats/ai.md).
 */
export function hitChance(s: Soldier, d: number): number {
  const c = s.config;
  const range = Math.max(s.viewLength, s.alarmViewLength) * METRE;
  const f = Math.min(1, d / range);
  let p = c.hitProbabilityNear + (c.hitProbabilityFar - c.hitProbabilityNear) * f;
  const close = Math.max(0, 1 - d / (10 * METRE));
  p *= c.aimPrecision + (1 - c.aimPrecision) * close;
  p *= Math.min(1, 0.4 + (0.6 * s.seenTime) / 3);
  const player = s.game.services.player;
  if (player && s.target() === player.entity) {
    p *= player.stance === "prone" ? 0.5 : player.stance === "crouch" ? 0.75 : 1;
    const v = player.velocity;
    const speed = Math.hypot(v[0], v[1]) / METRE;
    p *= speed > 3 ? 0.55 : speed > 0.5 ? 0.75 : 1;
  }
  return Math.max(0, Math.min(1, p));
}

class CombatAction implements Action {
  state: AiState = "combat";
  private started = false;
  private moveTimer = 0;
  private burstDelay = 0;
  private burstLeft = 0;
  private shotTimer = 0;
  private reloadTimer = 0;
  private meleeTimer = 0;
  private searching = false;
  private searchHold = 0;
  private gait: "run" | "walk" = "run";
  private grenadeCooldown = 0;
  private firedSinceMove = true;
  /** The last burst was held because the line of fire was blocked. */
  private blocked = false;
  private burstShots = 0;
  private throwing: { weapon: string; t: number; release: number; thrown: boolean } | null = null;

  update(s: Soldier, dt: number): boolean {
    const c = s.config;
    const target = s.target();
    if (!target) {
      s.stopMoving();
      return true;
    }
    const style = combatStyle(s);
    if (!this.started) {
      this.started = true;
      this.moveTimer = c.initialMoveDelay;
      // The targeting timeout counts from the moment combat starts (the soldier knows where the enemy was).
      if (!s.canSee) s.lostTime = 0;
      // Reaction time before the first burst: the type's delay between bursts.
      this.burstDelay = c.minBurstDelay + rand() * c.randomBurstDelay;
      s.shout();
    }
    if (!s.weapon && !s.manning) return true;
    this.grenadeCooldown -= dt;

    // Lost the target for too long: search where it was last seen (guards look around at their post), then give up.
    if (s.lostTime > c.targetingTimeout || this.searching) {
      this.state = "search";
      if (!this.searching) {
        this.searching = true;
        if (s.lastKnown && style === "mobile") s.goTo(s.lastKnown);
      }
      if (s.canSee) {
        this.searching = false;
        this.state = "combat";
        s.stopMoving();
        return false;
      }
      if (s.moving) {
        s.follow(dt, "walk");
        return false;
      }
      if (this.searchHold <= 0) {
        this.searchHold = 1;
        if (!s.manning) s.playOnce(CLIP.lookAround);
      }
      if (s.busyAnimating) return false;
      s.awareness = 0.3;
      return true;
    }
    this.state = "combat";
    if (style === "gunner") return this.gunner(s, dt, target);

    const eye = s.eye();
    const aimAt = s.lastKnown ?? target.position;
    const d = dist(s.position, target.position);

    if (this.reloadTimer > 0) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) s.clip = s.weapon!.clipSize;
    }
    if (this.throwing) return this.throwUpdate(s, dt);
    // A hit above the type's recoil threshold spoils the aim: the burst stops and the soldier recovers first.
    if (s.recoil > 0) {
      this.burstLeft = 0;
      this.burstDelay = Math.max(this.burstDelay, s.recoil);
    }

    // Movement: close in on a hidden or distant target, or dodge (patrols only; guards hold their post). A soldier
    // that sees its target fires a burst between moves.
    if (!s.busyAnimating && !s.moving && (this.moveTimer -= dt) <= 0 && this.burstLeft === 0 && (this.firedSinceMove || !s.canSee)) {
      // settings.qvm gives AITYPE_SPETNAZ_PATROL_AK at GD_2 (level13's surface guards) a move delay of 0: with no floor
      // they picked a new move or evasive roll every free frame and never fired.
      this.moveTimer = Math.max(MIN_MOVE_DELAY, c.moveDelay * (0.5 + rand()));
      this.firedSinceMove = false;
      if (style === "mobile") this.decideMove(s, target, d);
      else if (style === "rpg" && s.stance === "stand" && rand() < c.evasiveProbability) {
        s.stance = "crouch";
        s.playOnce(CLIP.standToCrouch);
      }
    }
    if (s.moving) {
      if (s.follow(dt, this.gait) && s.stance !== "stand") s.stance = "stand";
      if (s.canSee && d < 6 * METRE) s.stopMoving();
      return false;
    }
    if (s.busyAnimating) return false;

    const facing = s.turnTowards(yawTo(s.position, aimAt), dt, 4);
    const fireClip = s.stance === "prone" ? CLIP.proneFire : s.stance === "crouch" ? CLIP.crouchFire : CLIP.fire;
    const aimClip = s.stance === "prone" ? CLIP.prone : s.stance === "crouch" ? CLIP.crouchAim : CLIP.aim;
    s.setBase(this.burstLeft > 0 ? fireClip : aimClip);

    // Rifle butt up close.
    if (d < 1.4 * METRE && s.canSee) {
      if ((this.meleeTimer -= dt) <= 0) {
        this.meleeTimer = 1.2;
        if (rand() < c.closeCombatHitProbability) {
          const dir = vec3.normalize(vec3.sub(target.position, s.position));
          s.game.events.emit("damage", { targetId: target.id, amount: c.closeCombatDamage, sourceId: s.id, point: target.position, direction: dir, part: "torso" });
          s.game.services.audio?.play("common/sounds/gunpunch_01.wav", { at: s.position });
        }
      }
      return false;
    }

    if (!s.canSee || !facing) return false;
    if (this.reloadTimer > 0) {
      // "Combat grenade throw when reload probability", rolled once per reload.
      if (this.reloadTimer > 0.5 && this.maybeGrenade(s, d, true)) this.reloadTimer = Math.max(this.reloadTimer, 1.2);
      return false;
    }
    const w = s.weapon!;
    if (this.burstLeft === 0) {
      if ((this.burstDelay -= dt) > 0) return false;
      if (this.maybeGrenade(s, d, false)) return false;
      const rounds = Math.round(w.clipSize * (c.minClipFraction + rand() * c.randomClipFraction));
      this.burstLeft = Math.max(1, Math.min(rounds, c.maxRoundsPerBurst || rounds, s.clip));
      this.shotTimer = 0;
      if (!this.chooseAim(s, target, this.muzzle(s, eye))) {
        this.holdFire(style, true);
        return false;
      }
      this.blocked = false;
    }
    if ((this.shotTimer -= dt) > 0) return false;
    // The target may have ducked behind cover mid-burst: look again every few rounds.
    if (++this.burstShots % 5 === 0 && !this.chooseAim(s, target, this.muzzle(s, eye))) {
      this.holdFire(style, true);
      return false;
    }
    if (!this.fire(s, target, eye, d, style === "rpg")) {
      this.holdFire(style);
      return false;
    }
    s.clip--;
    this.burstLeft--;
    this.shotTimer = Math.max(60 / Math.max(1, w.roundsPerMinute), c.minShotDelay + rand() * c.randomShotDelay);
    if (this.burstLeft === 0) {
      this.burstDelay = c.minBurstDelay + rand() * c.randomBurstDelay;
      this.firedSinceMove = true;
    }
    if (s.clip <= 0) {
      this.burstLeft = 0;
      this.reloadTimer = w.reloadTime || 2;
      this.grenadeRolled = false;
    }
    return false;
  }

  private grenadeRolled = false;
  /** Aim at the head this burst: the chest is behind cover (a target crouched behind a low wall). */
  private aimHead = false;

  /**
   * Pick head or chest for the coming burst, and check the line of fire: sight passes glass and chain-link fences and
   * bullets may not, so a soldier whose shots would stop in a wall, a fence or a door holds the burst (patrols move to
   * a clear angle) instead of emptying clips into it. False when the line is blocked.
   */
  private chooseAim(s: Soldier, target: Entity, from: Vec3 = s.eye()): boolean {
    const physics = s.game.services.physics;
    const player = s.game.services.player;
    const head: Vec3 = player && target === player.entity ? player.eye() : [target.position[0], target.position[1], target.position[2] + target.height * 0.9];
    const chest: Vec3 = [head[0], head[1], head[2] - 0.35 * METRE];
    if (!physics) return true;
    this.aimHead = !physics.lineOfSight(s.eye(), chest);
    const aim = this.aimHead ? head : chest;
    const hit = physics.raycast(from, aim, { ignoreEntity: s.id, bullet: true });
    if (!hit || hit.entityId === target.id) return true;
    const e = hit.entityId !== null ? s.game.entities.get(hit.entityId) : undefined;
    if (e instanceof Soldier) return true; // comrades are handled shot by shot
    return hit.distance > dist(from, aim) - 0.5 * METRE;
  }

  /** Maybe start a grenade throw (settings.qvm's grenade probabilities and distances); true when one starts. */
  private maybeGrenade(s: Soldier, d: number, reloading: boolean): boolean {
    const c = s.config;
    if (!s.grenades.length || this.grenadeCooldown > 0 || s.stance === "prone" || !s.lastKnown) return false;
    if (reloading) {
      if (this.grenadeRolled) return false;
      this.grenadeRolled = true;
    }
    if (d < c.grenadeMinDistance * METRE || d > c.grenadeMaxDistance * METRE) return false;
    this.grenadeCooldown = 4;
    if (rand() >= (reloading ? c.grenadeOnReloadProbability : c.grenadeProbability)) return false;
    const weapon = s.grenades.shift()!;
    const clip = s.body?.clips.clip(CLIP.throwGrenade);
    const length = clip ? clip.duration / 4800 : 1.2;
    this.throwing = { weapon, t: 0, release: length * THROW_RELEASE, thrown: false };
    if (s.stance === "crouch") s.stance = "stand";
    s.stopMoving();
    s.playOnce(CLIP.throwGrenade);
    return true;
  }

  private throwUpdate(s: Soldier, dt: number): boolean {
    const th = this.throwing!;
    th.t += dt;
    if (!th.thrown && th.t >= th.release) {
      th.thrown = true;
      const c = s.config;
      const to = s.lastKnown ?? s.target()?.position;
      if (to) {
        const hand: Vec3 = vec3.add(s.eye(), vec3.add(vec3.scale(direction(s.yaw), 0.3 * METRE), [0, 0, 0.1 * METRE]));
        const delta = vec3.sub(to, hand);
        const horizontal = Math.hypot(delta[0], delta[1]);
        const fly = Math.max(c.grenadeMinFlyTime + rand() * c.grenadeRandomFlyTime, horizontal / (THROW_SPEED * METRE));
        const velocity: Vec3 = [delta[0] / fly, delta[1] / fly, delta[2] / fly + 0.5 * GRAVITY * fly];
        const fuse = fly + c.grenadeMinExplodeTime + rand() * c.grenadeRandomExplodeTime;
        s.throwGrenade(th.weapon, hand, velocity, fuse);
      }
    }
    if (s.busyAnimating) return false;
    this.throwing = null;
    this.burstDelay = s.config.minBurstDelay;
    return false;
  }

  private decideMove(s: Soldier, target: Entity, d: number) {
    const c = s.config;
    if (!s.canSee) {
      if (s.lastKnown) {
        this.gait = "run";
        s.goTo(s.lastKnown);
      }
      return;
    }
    if (d > c.trackingDistance * METRE) {
      // "Combat - Follow": a stretch of the route towards the target, then fire again.
      this.gait = "run";
      s.goTo(target.position, false, 10 * METRE);
      return;
    }
    if (!this.blocked && rand() < c.evasiveProbability) {
      const left = rand() < c.evasiveStandRollSide;
      if (s.stance === "stand") {
        if (rand() < c.evasiveStandRollOrLie) s.playOnce(left ? CLIP.rollLeft : CLIP.rollRight, () => (s.stance = "crouch"));
        else if (d > c.lieDownDistance * METRE) {
          s.stance = "prone";
          s.playOnce(CLIP.standToProne);
        } else {
          s.stance = "crouch";
          s.playOnce(CLIP.standToCrouch);
        }
      } else if (s.stance === "crouch") {
        if (rand() < c.evasiveKneelRollOrLie) s.playOnce(rand() < c.evasiveKneelRollSide ? CLIP.crouchRollLeft : CLIP.crouchRollRight);
        else {
          s.stance = "stand";
          s.playOnce(CLIP.crouchToStand);
        }
      }
      return;
    }
    // Reposition: a nearby node with a different angle on the target that still sees it.
    const physics = s.game.services.physics;
    const options = s.graph?.walkable.filter((n) => {
      const dn = dist(n.position, s.position);
      return dn > 3 * METRE && dn < 12 * METRE;
    });
    if (!options?.length || !physics) return;
    for (let k = 0; k < 3; k++) {
      const n = pick(options);
      const from: Vec3 = [n.position[0], n.position[1], n.position[2] + 1.6 * METRE];
      const to: Vec3 = [target.position[0], target.position[1], target.position[2] + 1.4 * METRE];
      // A clear line of fire, not just of sight (fences and glass let sight through).
      if (!physics.raycast(from, to, { entities: false })) {
        this.gait = rand() < 0.5 ? "run" : "walk";
        s.goTo(n.position);
        return;
      }
    }
    // Nowhere better close by and the shot is blocked: close in.
    if (this.blocked) {
      this.gait = "run";
      s.goTo(target.position, false, 10 * METRE);
    }
  }

  /** Where one round goes: at the head or chest when the hit roll succeeds, else past the target close enough to hear. */
  private aimPoint(s: Soldier, target: Entity, from: Vec3, d: number, rpg: boolean): Vec3 {
    const c = s.config;
    const player = s.game.services.player;
    const head: Vec3 = player && target === player.entity ? player.eye() : [target.position[0], target.position[1], target.position[2] + target.height * 0.9];
    const chest: Vec3 = [head[0], head[1], head[2] - 0.35 * METRE];
    // A rocket goes for the feet (its blast does the work); bullets mostly for the chest.
    const aim: Vec3 = rpg ? [target.position[0], target.position[1], target.position[2] + 0.2 * METRE] : this.aimHead || rand() < 0.15 ? head : chest;
    if (rand() < hitChance(s, d)) {
      const jitter = (1 - c.aimPrecision) * 0.15 * METRE;
      return vec3.add(aim, [(rand() - 0.5) * jitter, (rand() - 0.5) * jitter, (rand() - 0.5) * jitter]);
    }
    const side = vec3.normalize([-(aim[1] - from[1]), aim[0] - from[0], 0]);
    const off = (rpg ? 2 + rand() * 2 : 0.5 + rand()) * METRE * (rand() < 0.5 ? -1 : 1);
    return vec3.add(aim, [side[0] * off, side[1] * off, (rand() - 0.3) * 0.6 * METRE]);
  }

  /** The gun's muzzle when the body is posed, else a point in front of the chest. */
  private muzzle(s: Soldier, eye: Vec3): Vec3 {
    const facing = direction(s.yaw);
    const tip = s.posed ? s.body?.muzzle(s.game.toSceneDir(facing)) : null;
    return tip ? s.game.fromScene(tip) : vec3.add(eye, vec3.add(vec3.scale(facing, 0.5 * METRE), [0, 0, -0.25 * METRE]));
  }

  private fire(s: Soldier, target: Entity, eye: Vec3, d: number, rpg: boolean): boolean {
    const muzzle = this.muzzle(s, eye);
    const point = this.aimPoint(s, target, muzzle, d, rpg);
    if (s.comradeInLine(muzzle, point)) return false;
    s.shoot(muzzle, vec3.normalize(vec3.sub(point, muzzle)));
    return true;
  }

  /** A comrade stands in the line of fire: hold the burst, and a patrol moves to a clear angle. */
  private holdFire(style: CombatStyle, blocked = false) {
    this.blocked = blocked;
    this.burstLeft = 0;
    this.burstDelay = 0.4 + rand() * 0.3;
    if (style === "mobile") {
      this.moveTimer = 0;
      this.firedSinceMove = true;
    }
  }

  /** "Gunner Combat - Stand": traverse the stationary gun onto the target and fire its weapon in bursts. */
  private gunner(s: Soldier, dt: number, target: Entity): boolean {
    const gun = s.manning!;
    const c = s.config;
    s.setBase(CLIP.aim);
    s.yaw = gun.yaw;
    const aimAt = s.lastKnown ?? target.position;
    const chest: Vec3 = [aimAt[0], aimAt[1], aimAt[2] + 1.2 * METRE];
    const aligned = gun.aim(chest, dt);
    if (!s.canSee || !aligned || !gun.covers(chest)) return false;
    if (this.burstLeft === 0) {
      if ((this.burstDelay -= dt) > 0) return false;
      if (!this.chooseAim(s, target, gun.muzzle())) {
        this.holdFire("gunner");
        return false;
      }
      const clip = gun.ammo >= 0 ? gun.ammo : 10000;
      const rounds = Math.round(Math.min(clip, 10000) * (c.minClipFraction + rand() * c.randomClipFraction));
      this.burstLeft = Math.max(1, Math.min(rounds, c.maxRoundsPerBurst || rounds));
      if (gun.ammo === 0) return false;
      this.shotTimer = 0;
    }
    if ((this.shotTimer -= dt) > 0) return false;
    const muzzle = gun.muzzle();
    const point = this.aimPoint(s, target, muzzle, dist(s.position, target.position), false);
    if (s.comradeInLine(muzzle, point)) {
      this.holdFire("gunner");
      return false;
    }
    s.shootWith(gun.spec.weapon, muzzle, vec3.normalize(vec3.sub(point, muzzle)));
    if (gun.ammo > 0) gun.ammo--;
    this.burstLeft--;
    const rpm = s.weaponInfo(gun.spec.weapon)?.roundsPerMinute ?? 600;
    this.shotTimer = Math.max(60 / Math.max(1, rpm), c.minShotDelay + rand() * c.randomShotDelay);
    if (this.burstLeft === 0) this.burstDelay = c.minBurstDelay + rand() * c.randomBurstDelay;
    return false;
  }
}
