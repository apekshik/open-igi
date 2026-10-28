// The player: David Jones. Spawns at the level's HumanPlayer task and moves the way IGI moves him: speeds come from
// the animations' root motion (x1.75, humanplayer.qvm), run is the default and walking is held, crouch is held,
// jumps and falls use the exe's gravity and fall-damage rule, and the eye rides on the pelvis of the playing clip,
// which gives IGI's stance blends and head bob. Values and their sources: docs/formats/player.md.
//
// Collision goes only through game.services.physics (move / groundHeight / raycast).
import type { AnimFile } from "../../formats/anim.ts";
import { direction, METRE, vec3, type Vec3 } from "../coords.ts";
import type { Entity } from "../entity.ts";
import type { Game, GameSystem } from "../game.ts";
import type { QvmCall, QvmValue } from "../../formats/qvm.ts";
import { ANIM_TICKS_PER_SECOND, ClipPlayer, rootAt } from "./animator.ts";
import { findLadders, type Ladder } from "./ladders.ts";
import type { Gait, PlayerService, Stance } from "./api.ts";
import { SkinnedBody } from "./body.ts";
import { DEFAULT_PARAMS, groundMaterial, loadPlayerData, PHYSICS, type PlayerData } from "./params.ts";

/**
 * IGI's view: tan(half horizontal FOV) = tan(30°) at 4:3 (the zoom reset value), i.e. 46.8° vertical. Wider screens
 * see more to the sides (Hor+), as the original did at 4:3.
 */
export const DEFAULT_FOV = (2 * Math.atan(Math.tan(Math.PI / 6) * 0.75) * 180) / Math.PI;

/** Movement clips of skeleton 000 (the HumanPlayer state table at 0x5368c8): forward, diagonals, back, strafes. */
const MOVE_CLIPS = {
  run: { f: 4, fr: 37, fl: 35, b: 64, br: 70, bl: 68, r: 11, l: 10 },
  walk: { f: 57, fr: 74, fl: 72, b: 75, br: 77, bl: 76, r: 81, l: 80 },
  crouch: { f: 17, fr: 41, fl: 39, b: 27, br: 49, bl: 47, r: 29, l: 28 },
};
const CLIP = { stand: 2, crouched: 19, jump: 25, fall: 2, ladder: 168, ladderTop: 170, death: [201, 202], deathHead: 204 };
type Dir = keyof typeof MOVE_CLIPS.run;

// Ladders (see ladders.ts and docs/formats/player.md). Clip 168 is laid out with its origin on the rung plane and on
// a rung multiple: the planted foot's sole sits 1200 units above it, the pelvis 0.375 m out from the rungs and
// 0.61 m higher at the end of each 0.7 s cycle (two rungs, one per hand). Clip 170 starts from 168's end pose and
// climbs over the top: 1.84 m up and 0.77 m forward over 2.33 s, ending stood 2.45 m above its origin.
/** Grab a ladder from this far out (feet to rungs; a ladder's movement hull stands 0.76 m proud of its rungs). */
const LADDER_REACH = 1.3 * METRE;
/** Sideways slack beyond the rails when grabbing. */
const LADDER_SLACK = 0.3 * METRE;
/** Height of the planted foot's rung above clip 168's origin, and the top of the hands at the end of a cycle. */
const LADDER_FOOT_RUNG = 1200;
const LADDER_HANDS = 9800;
/** Out from the rungs beyond which a body that left a ladder is clear of the ladder's (and its tower's) hull. */
const LADDER_CLEAR = 1.2 * METRE;
/** Seconds over which the body slides from where it stood onto the ladder. */
const LADDER_GRAB_TIME = 0.25;
/** Push off when jumping from a ladder (m/s back, up). open-igi's choice. */
const LADDER_JUMP = { back: 2 * METRE, up: 1 * METRE };
/** AI hears ladder steps (AIEVENT_LADDER) within this radius. open-igi's choice: IGI's value is not known. */
const LADDER_NOISE = 10 * METRE;
const LADDER_SOUNDS = ["walk_ladder_1", "walk_ladder_2", "walk_ladder_3", "walk_ladder_4"];

interface Climb {
  ladder: Ladder;
  /** 168 (on the rungs) or 170 (over the top). */
  clip: number;
  /** Clip time, ticks. */
  t: number;
  /** Height of the clip origin above the ladder origin: on a rung, in whole climb cycles (two rungs). */
  base: number;
  /** Landing height mismatch spread over clip 170 (units; 0 on the rungs). */
  fix: number;
  /** Clip 170 is played backwards: getting on at the top. */
  down: boolean;
  /** Where the body stood when it grabbed, relative to the climb pose; fades out over LADDER_GRAB_TIME. */
  grab: Vec3;
  grabLeft: number;
}

/** Without animation data: per-gait speeds (m/s, already x1.75) and pelvis heights (m) measured from 000.iff. */
const FALLBACK_SPEED = { run: 5.88, runSide: 4.8, walk: 2.18, walkSide: 1.76, crouch: 2.79 };
const FALLBACK_PELVIS = { stand: 0.95, run: 0.93, crouched: 0.43, crouchMove: 0.65 };

/** open-igi additions (IGI 1 has no prone): crawl speed and eye height. */
const PRONE_SPEED = 0.6 * METRE;
const PRONE_EYE = 0.3 * METRE;
const PRONE_HEIGHT = 0.6 * METRE;
/** Camera roll at full lean (IGI only shifts the eye; a small roll reads better on modern screens). */
const LEAN_ROLL = (10 * Math.PI) / 180;
/** Keep the leaning eye this far from walls. */
const LEAN_MARGIN = 0.25 * METRE;
const THIRD_PERSON_DISTANCE = 3 * METRE;

const SOUND = (name: string) => `common/sounds/${name}.wav`;
const pick = <T>(list: readonly T[]) => list[Math.floor(Math.random() * list.length)];

export function playerSystem(): GameSystem {
  let player: Player;
  let onKey: (e: KeyboardEvent) => void;
  return {
    name: "player",
    async init(game) {
      const data = await loadPlayerData(game.vfs).catch((err) => {
        console.warn("player: using default parameters", err);
        return { params: DEFAULT_PARAMS, materials: new Map(), footsteps: new Map(), ladderSteps: new Map() } as PlayerData;
      });
      player = new Player(game, data);
      game.services.player = player;
      // Debug third-person view. Input has no action for it, so listen for the key directly.
      onKey = (e) => {
        if (e.code === "KeyV" && !e.repeat && game.input.locked) player.thirdPerson = !player.debugView;
      };
      window.addEventListener("keydown", onKey);
    },
    update(dt) {
      player.update(dt);
    },
    lateUpdate(dt) {
      player.render(dt);
    },
    dispose() {
      window.removeEventListener("keydown", onKey);
      player.dispose();
    },
  };
}

interface Spawn {
  position: Vec3;
  yaw: number;
}

/** The HumanPlayer task's position and gamma, located through the type's Task_DeclareParameters schema. */
export function findHumanPlayer(statements: QvmCall[]): Spawn | null {
  let schema: string[] | null = null;
  for (const s of statements) {
    if (s.fn === "Task_DeclareParameters" && s.args[0] === "HumanPlayer") schema = s.args.slice(1).map(String);
  }
  const width = (type: string) => (type === "ObjectPos" ? 3 : 1);
  let found: Spawn | null = null;
  const visit = (task: QvmValue) => {
    if (found || typeof task !== "object" || !("fn" in task) || task.fn !== "Task_New") return;
    const [, type, , ...rest] = task.args;
    if (type === "HumanPlayer") {
      let at = 0;
      const out: Spawn = { position: [0, 0, 0], yaw: 0 };
      const pairs = schema ?? ["Position", "ObjectPos", "Gamma", "Angle"];
      for (let i = 0; i + 1 < pairs.length; i += 2) {
        const [name, kind] = [pairs[i], pairs[i + 1]];
        const vals = rest.slice(at, at + width(kind)).map(Number);
        if (name === "Position") out.position = [vals[0], vals[1], vals[2]];
        if (name === "Gamma") out.yaw = vals[0] || 0;
        at += width(kind);
      }
      found = out;
      return;
    }
    for (const child of rest) visit(child);
  };
  for (const s of statements) visit(s);
  return found;
}

class Player implements PlayerService {
  readonly entity: Entity;
  yaw = 0;
  pitch = 0;
  stance: Stance = "stand";
  fov = DEFAULT_FOV;
  readonly defaultFov = DEFAULT_FOV;
  frozen = false;
  velocity: Vec3 = [0, 0, 0];
  grounded = false;
  gait: Gait = "idle";
  lean = 0;
  dead = false;
  /** The debug third-person toggle (V). */
  private debugThirdPerson = false;
  /** Third person while climbing a ladder, as IGI shows it, or when toggled with V. */
  get thirdPerson() {
    return this.debugThirdPerson || this.climbing;
  }
  private get climbing() {
    return this.climb !== null;
  }
  set thirdPerson(on: boolean) {
    this.debugThirdPerson = on;
  }
  /** Is the V toggle on (regardless of ladders)? */
  get debugView() {
    return this.debugThirdPerson;
  }

  private game: Game;
  private data: PlayerData;
  private clips: ClipPlayer | null;
  private body: SkinnedBody | null;
  private spawned = false;
  private start: Spawn;
  /** Airborne velocity (units/s); also the speed carried into a fall. */
  private air: Vec3 = [0, 0, 0];
  private knock: [number, number] = [0, 0];
  /** Ground velocity of the last frame (for jumps and falls). */
  private walkVelocity: Vec3 = [0, 0, 0];
  /** On a ladder (null otherwise). */
  private climb: Climb | null = null;
  /** The level's ladders (found on first use: they are placed by the world system). */
  private ladderList: Ladder[] | null = null;
  private landings = new Map<Ladder, number | null>();
  /** The ladder just left: until the body is clear of it, it moves against real shapes only, not hulls. */
  private clearOf: Ladder | null = null;
  private prone = false;
  /** 0 = standing eye offset above the pelvis, 1 = crouched offset; blends like the clips. */
  private low = 0;
  private eyeHeight: number;
  private peek = 0;
  private leanOffset: Vec3 = [0, 0, 0];
  private dip = 0;
  private dipVelocity = 0;
  private flinch = { pitch: 0, yaw: 0, roll: 0 };
  private lastHitPart: string | undefined;
  private deathTime = 0;
  private eyePos: Vec3;
  private unsubscribe: () => void;

  constructor(game: Game, data: PlayerData) {
    this.game = game;
    this.data = data;
    const p = data.params;
    this.start = findHumanPlayer(game.level.statements) ?? { position: game.level.objects.playerStart ?? game.origin, yaw: 0 };
    this.yaw = this.start.yaw;
    this.entity = game.entities.create({
      kind: "player",
      position: [...this.start.position] as Vec3,
      yaw: this.yaw,
      health: p.maxHealth,
      maxHealth: p.maxHealth,
      team: 0,
      alive: true,
      radius: PHYSICS.radius,
      height: PHYSICS.heightStand,
      taskId: 0,
    });
    this.body = safe(() => SkinnedBody.create(game.level.library, "000_01_1"));
    const anims: AnimFile | undefined = this.body?.clips.file ?? game.level.library.animFiles.find((f) => f.skeleton.hierarchy === 0);
    this.clips = this.body?.clips ?? (anims ? new ClipPlayer(anims) : null);
    this.clips?.play(CLIP.stand, { blend: 0 });
    if (this.body) {
      this.body.object.visible = false;
      game.world.add(this.body.object);
    }
    this.eyeHeight = this.pelvisHeight() + PHYSICS.eyeAbovePelvis;
    this.eyePos = vec3.add(this.entity.position, [0, 0, this.eyeHeight]);
    this.unsubscribe = game.events.on("damage", (d) => {
      if (d.targetId === this.entity.id) this.takeDamage(d.amount, d.part, d.sourceId, d.direction, d.point);
    });
  }

  eye(): Vec3 {
    return [...this.eyePos] as Vec3;
  }

  heal(amount: number) {
    if (this.dead) return;
    this.entity.health = Math.min(this.entity.maxHealth, this.entity.health + amount);
  }

  teleport(feet: Vec3, yaw?: number) {
    this.entity.position = [...feet] as Vec3;
    if (yaw !== undefined) this.yaw = yaw;
    this.air = [0, 0, 0];
    this.knock = [0, 0];
    this.walkVelocity = [0, 0, 0];
    this.velocity = [0, 0, 0];
    this.spawned = true;
    this.grounded = false;
    this.climb = null;
    this.clearOf = null;
  }

  private get physics() {
    return this.game.services.physics;
  }

  private sound(name: string, volume = 1) {
    if (name) this.game.services.audio?.play(SOUND(name), { volume });
  }

  // --- per frame -------------------------------------------------------------------------------------------------

  update(dt: number) {
    if (!this.spawned) this.spawn();
    if (this.dead) return this.updateDead(dt);
    if (this.frozen) {
      this.velocity = [0, 0, 0];
      return;
    }
    const input = this.game.input;
    const look = input.look();
    this.yaw = wrapAngle(this.yaw + look.yaw);
    this.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.pitch + look.pitch));

    const fwd = (input.isDown("forward") ? 1 : 0) - (input.isDown("back") ? 1 : 0);
    const side = (input.isDown("right") ? 1 : 0) - (input.isDown("left") ? 1 : 0);
    const leanKey = (input.isDown("leanRight") ? 1 : 0) - (input.isDown("leanLeft") ? 1 : 0);

    this.updateStance(input.isDown("crouch"), input.wasPressed("prone"));
    this.updateLean(dt, this.grounded && !this.climbing ? leanKey : 0, fwd > 0);
    const leaning = this.lean !== 0 || leanKey !== 0;

    // Ladders (magicobj.qvm TASKTYPE_LADDER models): walking into one, or onto one's top from its landing, or pressing
    // use while the ladder icon shows, gets on.
    let grab: ReturnType<Player["ladderInReach"]> = null;
    if (!this.climbing && this.grounded && !leaning && this.stance === "stand") {
      grab = this.ladderInReach(fwd);
      if (grab && (grab.moving || input.wasPressed("use"))) this.mountLadder(grab.ladder, grab.top);
    }
    this.game.services.hud?.action(grab && !this.climbing ? "ladder" : null);

    if (this.climbing) this.updateLadder(dt, fwd, input.wasPressed("jump"));
    else if (this.grounded) this.updateGround(dt, leaning ? 0 : fwd, leaning ? 0 : side, input.isDown("walk"), input.wasPressed("jump"));
    else this.updateAir(dt, fwd, side);

    this.updateEffects(dt);
    this.entity.yaw = this.yaw;
  }

  /** Put the feet on the ground under the HumanPlayer task (terrain exists only after every system's init). */
  private spawn() {
    this.spawned = true;
    const [x, y, z] = this.start.position;
    const ground = this.physics?.groundHeight(x, y, z + 2 * METRE);
    this.entity.position = [x, y, ground ?? z];
    this.grounded = ground !== null && ground !== undefined;
  }

  private updateStance(crouchHeld: boolean, proneToggle: boolean) {
    if (!this.grounded || this.climbing) {
      // Airborne bodies keep their stance; IGI jumps and falls are standing states.
      return;
    }
    if (proneToggle) this.prone = !this.prone;
    if (crouchHeld) this.prone = false;
    let want: Stance = this.prone ? "prone" : crouchHeld ? "crouch" : "stand";
    // Standing (or rising from prone) is refused under a low ceiling, like the exe's "Roof!" flag.
    if (want === "stand" && this.stance !== "stand" && !this.headroom(PHYSICS.heightStand)) want = "crouch";
    if (want === "crouch" && this.stance === "prone" && !this.headroom(PHYSICS.heightCrouch)) want = "prone";
    if (want !== "prone") this.prone = false;
    this.stance = want;
    this.entity.height = want === "stand" ? PHYSICS.heightStand : want === "crouch" ? PHYSICS.heightCrouch : PRONE_HEIGHT;
  }

  private headroom(height: number): boolean {
    const f = this.entity.position;
    const hit = this.physics?.raycast([f[0], f[1], f[2] + 0.2 * METRE], [f[0], f[1], f[2] + height], { entities: false, ignoreEntity: this.entity.id });
    return !hit;
  }

  /** IGI's lean: the eye slides sideways by 0.85 m over 7 ticks; crouched, forward also raises it over cover. */
  private updateLean(dt: number, key: number, forward: boolean) {
    const p = this.data.params;
    const rate = dt / p.leanTime;
    this.lean = approach(this.lean, key, rate);
    const peekWanted = key !== 0 && forward && this.stance === "crouch" ? 1 : 0;
    this.peek = approach(this.peek, peekWanted, rate);
  }

  private updateGround(dt: number, fwd: number, side: number, walkHeld: boolean, jump: boolean) {
    const p = this.data.params;
    const moving = fwd !== 0 || side !== 0;
    const dir = moveDir(fwd, side);

    // Jump: standing states only (IGI has no crouched jump); take-off along the current movement.
    if (jump && this.stance === "stand") {
      const h = this.walkVelocity;
      const len = Math.hypot(h[0], h[1]);
      const k = len > 1 ? p.jumpSpeed / len : 0;
      this.air = [h[0] * k, h[1] * k, p.jumpUpSpeed];
      this.grounded = false;
      this.clips?.play(CLIP.jump, { blend: 0, speed: 0.4 });
      this.sound("jump_1");
      return this.updateAir(dt, 0, 0, true);
    }

    let local: [number, number];
    if (this.stance === "prone") {
      const n = Math.hypot(fwd, side) || 1;
      local = [(side / n) * PRONE_SPEED, (fwd / n) * PRONE_SPEED];
      this.clips?.play(CLIP.crouched);
      this.gait = moving ? "crawl" : "idle";
    } else {
      const gait = this.stance === "crouch" ? "crouch" : walkHeld ? "walk" : "run";
      const id = moving && dir ? MOVE_CLIPS[gait][dir] : this.stance === "crouch" ? CLIP.crouched : CLIP.stand;
      const wasMoving = isMoveClip(this.clips?.clipId ?? null);
      this.clips?.play(id, { keepPhase: wasMoving && moving });
      local = this.clips ? scale2(this.clips.velocity(), p.rootMotionScale) : fallbackVelocity(gait, fwd, side);
      this.gait = moving ? gait : this.stance === "crouch" ? "crouch" : "idle";
    }
    // Model axes (x right, y forward) → world, turned by the heading.
    const right = direction(this.yaw - Math.PI / 2);
    const ahead = direction(this.yaw);
    const v: Vec3 = [right[0] * local[0] + ahead[0] * local[1], right[1] * local[0] + ahead[1] * local[1], 0];
    this.walkVelocity = v;
    this.moveBody(dt, v);
  }

  private updateAir(dt: number, fwd: number, side: number, takeOff = false) {
    const p = this.data.params;
    if (!takeOff) {
      this.air[2] -= PHYSICS.gravity * dt;
      // Air control: the move keys push along the body axes.
      if (fwd || side) {
        const right = direction(this.yaw - Math.PI / 2);
        const ahead = direction(this.yaw);
        const a = p.airControl * dt;
        this.air[0] += (right[0] * side + ahead[0] * fwd) * a;
        this.air[1] += (right[1] * side + ahead[1] * fwd) * a;
      }
    }
    this.gait = "air";
    this.moveBody(dt, this.air);
  }

  // --- ladders ---------------------------------------------------------------------------------------------------

  private get ladders(): Ladder[] {
    if (!this.ladderList) {
      this.ladderList = findLadders(this.game);
      if (this.ladderList.length) console.info(`player: ${this.ladderList.length} ladders`);
    }
    return this.ladderList;
  }

  /** A point in a ladder's frame: out from the rungs (towards the climber), along the rails, up from the origin. */
  private ladderFrame(l: Ladder, p: Vec3) {
    const dx = p[0] - l.origin[0], dy = p[1] - l.origin[1];
    return { out: -(dx * l.face[0] + dy * l.face[1]), side: dx * l.face[1] - dy * l.face[0], up: p[2] - l.origin[2] };
  }

  /** Ladder space (x along the rails, y towards the wall, z up) → world, from the ladder origin. */
  private ladderPoint(l: Ladder, x: number, y: number, z: number): Vec3 {
    const [fx, fy] = l.face;
    return [l.origin[0] + fy * x + fx * y, l.origin[1] - fx * x + fy * y, l.origin[2] + z];
  }

  /**
   * Height of the floor at the top of a ladder where clip 170 puts the feet (0.4 m past the rungs, under the hooks:
   * on a roof's parapet, a tower's deck), or null if the ladder leads nowhere walkable. Looked for from just above
   * the rungs, under the hooks' tops.
   */
  private landing(l: Ladder): number | null {
    if (this.landings.has(l)) return this.landings.get(l)!;
    const p = this.ladderPoint(l, 0, this.clipRoot(CLIP.ladderTop, this.clipLength(CLIP.ladderTop))[1], 0);
    const top = l.origin[2] + l.rungTop;
    const z = this.physics?.groundHeight(p[0], p[1], top + 0.5 * METRE) ?? null;
    const found = z !== null && z > top - 2 * METRE && z < top + 0.5 * METRE ? z : null;
    this.landings.set(l, found);
    return found;
  }

  /**
   * The ladder Jones could get on from where he stands: at its foot, facing it (`moving` when walking into it), or on
   * its landing at the top, by its hooks (`moving` when walking out over the edge).
   */
  private ladderInReach(fwd: number): { ladder: Ladder; top: boolean; moving: boolean } | null {
    const feet = this.entity.position;
    const look = direction(this.yaw);
    for (const l of this.ladders) {
      const f = this.ladderFrame(l, feet);
      if (Math.abs(f.side) > l.halfWidth + LADDER_SLACK) continue;
      const facing = look[0] * l.face[0] + look[1] * l.face[1];
      if (f.out > 0 && f.out <= LADDER_REACH && f.up > l.bottom - 0.6 * METRE && f.up < l.rungTop - 1.8 * METRE && facing > 0.5) {
        return { ladder: l, top: false, moving: fwd > 0 };
      }
      const landing = this.landing(l);
      if (landing !== null && feet[2] > landing - METRE && feet[2] < landing + 0.5 * METRE && f.out < 0 && f.out > -LADDER_REACH) {
        // Walking towards the edge: forward facing away from the wall, or backing onto it facing the wall.
        if (Math.abs(facing) < 0.5) continue;
        return { ladder: l, top: true, moving: fwd !== 0 && Math.sign(fwd) === -Math.sign(facing) };
      }
    }
    return null;
  }

  /** Height of the climb clip's origin above the ladder origin for climb cycle `k`: on a rung, under the foot. */
  private ladderBase(l: Ladder, k: number): number {
    return l.rungPhase - LADDER_FOOT_RUNG + k * 2 * l.pitch;
  }

  private mountLadder(l: Ladder, top: boolean) {
    const before: Vec3 = [...this.entity.position] as Vec3;
    const up = before[2] - l.origin[2];
    const step = 2 * l.pitch;
    const b0 = this.ladderBase(l, 0);
    let climb: Climb;
    if (top) {
      // Getting on at the top: clip 170 backwards, from stood on the landing down onto the rungs.
      const end = this.topEnd();
      const k = Math.round((up - end - b0) / step);
      const base = this.ladderBase(l, k);
      const t = this.clipLength(CLIP.ladderTop);
      climb = { ladder: l, clip: CLIP.ladderTop, t, base, fix: up - (base + end), down: true, grab: [0, 0, 0], grabLeft: 0 };
    } else {
      // At the foot: the lowest cycle that does not put the feet below where they stand (by more than a little).
      const k = Math.max(Math.ceil((up - b0 - 0.15 * METRE) / step), Math.ceil((l.bottom - b0 - 0.15 * METRE) / step));
      climb = { ladder: l, clip: CLIP.ladder, t: 0, base: this.ladderBase(l, k), fix: 0, down: false, grab: [0, 0, 0], grabLeft: 0 };
    }
    this.climb = climb;
    this.clips?.play(climb.clip, { speed: 0 });
    this.clips?.seek(Math.min(climb.t, this.clipLength(climb.clip) - 1));
    climb.grab = vec3.sub(before, this.climbFeet(climb));
    climb.grabLeft = LADDER_GRAB_TIME;
    this.lean = this.peek = 0;
    this.air = [0, 0, 0];
    this.walkVelocity = [0, 0, 0];
    this.grounded = false;
    this.clearOf = null;
  }

  private clipLength(id: number): number {
    return this.clips?.clip(id)?.duration ?? (id === CLIP.ladderTop ? 11200 : 3360);
  }

  /** Root position of a clip at a time (model axes), with a fallback when animations are missing. */
  private clipRoot(id: number, t: number): [number, number, number] {
    const anim = this.clips?.clip(id);
    if (anim) return rootAt(anim, t);
    // Without 000.iff: straight up and over at the clips' rates.
    const f = t / this.clipLength(id);
    return id === CLIP.ladderTop ? [0, -1538 + 3173 * f, 6408 + 7550 * f] : [0, -1538, 3912 + 2507 * f];
  }

  /** Feet height above the clip origin at the end of clip 170 (stood on the landing). */
  private topEnd(): number {
    return this.clipRoot(CLIP.ladderTop, this.clipLength(CLIP.ladderTop))[2] - this.clipRoot(CLIP.ladder, 0)[2];
  }

  /** Where the clip's origin is now (on the rung plane; clip 170 also carries the landing fix). */
  private climbOrigin(c: Climb): Vec3 {
    const f = c.clip === CLIP.ladderTop ? c.t / this.clipLength(c.clip) : 0;
    return this.ladderPoint(c.ladder, 0, 0, c.base + c.fix * f);
  }

  /** Feet (the entity position) for the climb pose: under the pelvis, at the pelvis height less a standing pelvis. */
  private climbFeet(c: Climb): Vec3 {
    const o = this.climbOrigin(c);
    const r = this.clipRoot(c.clip, c.t);
    const [fx, fy] = c.ladder.face;
    const z0 = this.clipRoot(CLIP.ladder, 0)[2];
    return [o[0] + fy * r[0] + fx * r[1], o[1] - fx * r[0] + fy * r[1], o[2] + r[2] - z0];
  }

  /**
   * IGI's ladder: forward climbs, back climbs down, nothing else moves Jones (strafe and look leave him on the rungs);
   * he gets off at the top (clip 170 onto the landing), at the foot (on the ground), or by jumping.
   */
  private updateLadder(dt: number, fwd: number, jump: boolean) {
    const c = this.climb!;
    const l = c.ladder;
    this.gait = "ladder";
    const rate = dt * ANIM_TICKS_PER_SECOND * this.data.params.rootMotionScale;
    const length = this.clipLength(c.clip);
    const before = c.t;
    const steps = this.data.ladderSteps.get(c.clip) ?? (c.clip === CLIP.ladder ? [0, 1737] : [0, 1680, 3360, 5040]);
    let crossed = false;

    if (c.clip === CLIP.ladderTop) {
      // Over the top (or back down onto the rungs from it): plays through whatever is pressed.
      c.t = c.down ? Math.max(0, c.t - rate) : Math.min(length, c.t + rate);
      crossed = steps.some((s) => (c.down ? s < before && s >= c.t : s > before && s <= c.t));
      if (!c.down && c.t >= length) return this.leaveLadder("top", crossed);
      if (c.down && c.t <= 0) {
        c.clip = CLIP.ladder;
        c.t = this.clipLength(CLIP.ladder);
        c.fix = 0;
        c.down = false;
        this.clips?.play(CLIP.ladder, { speed: 0, blend: 0.1 });
      }
    } else if (jump) {
      return this.leaveLadder("jump", false);
    } else if (fwd > 0) {
      c.t += rate;
      if (c.t >= length) {
        const landing = this.landing(l);
        const end = this.topEnd();
        if (landing !== null && landing - (l.origin[2] + c.base + end) <= l.pitch) {
          // The landing is within a rung of where clip 170 ends: climb over the top, absorbing the difference.
          c.clip = CLIP.ladderTop;
          c.fix = landing - (l.origin[2] + c.base + end);
          c.t = Math.min(c.t - length, rate);
          this.clips?.play(CLIP.ladderTop, { speed: 0, blend: 0 });
        } else if (c.base + 2 * l.pitch + LADDER_HANDS <= l.rungTop) {
          c.t -= length;
          c.base += 2 * l.pitch;
        } else c.t = length;
      }
      if (c.clip === CLIP.ladder) crossed = steps.some((s) => (c.t >= before ? s > before && s <= c.t : s > before || s <= c.t));
    } else if (fwd < 0) {
      c.t -= rate;
      if (c.t < 0) {
        const below = this.ladderPoint(l, 0, -0.4 * METRE, c.base);
        const ground = this.physics?.groundHeight(below[0], below[1], below[2] + 1.5 * METRE) ?? null;
        const next = c.base - 2 * l.pitch;
        const roomBelow = ground === null || l.origin[2] + next >= ground - 0.3 * METRE;
        if (roomBelow && next >= l.bottom - l.pitch) {
          c.t += length;
          c.base = next;
        } else return this.leaveLadder("bottom", false);
      }
      crossed = steps.some((s) => (c.t <= before ? s < before && s >= c.t : s < before || s >= c.t));
    }
    if (crossed) this.ladderStep();
    this.clips?.seek(Math.min(c.t, this.clipLength(c.clip) - 1));
    this.placeOnLadder(dt);
  }

  /** Put the entity on the climb pose, easing in from where the body stood when it grabbed. */
  private placeOnLadder(dt: number) {
    const c = this.climb!;
    c.grabLeft = Math.max(0, c.grabLeft - dt);
    const k = c.grabLeft / LADDER_GRAB_TIME;
    const feet = vec3.add(this.climbFeet(c), vec3.scale(c.grab, k * k));
    this.velocity = dt > 0 ? vec3.scale(vec3.sub(feet, this.entity.position), 1 / dt) : [0, 0, 0];
    this.entity.position = feet;
  }

  /** A hand or foot on a rung: IGI's ladder step sounds, which soldiers hear as AIEVENT_LADDER. */
  private ladderStep() {
    const position: Vec3 = [...this.entity.position] as Vec3;
    // The SoundDefs (common sounds.qvm FOOTSTEPS group) carry their volume; the player's own sounds are 2D.
    this.game.services.audio?.play(pick(LADDER_SOUNDS));
    this.game.events.emit("noise", { position, radius: LADDER_NOISE, sourceId: this.entity.id, kind: "ladder" });
  }

  private leaveLadder(how: "top" | "bottom" | "jump", step: boolean) {
    const c = this.climb!;
    const l = c.ladder;
    if (step) this.ladderStep();
    const feet = this.climbFeet(c);
    this.climb = null;
    this.clearOf = l;
    this.velocity = [0, 0, 0];
    if (how === "jump") {
      this.entity.position = feet;
      this.air = [-l.face[0] * LADDER_JUMP.back, -l.face[1] * LADDER_JUMP.back, LADDER_JUMP.up];
      this.grounded = false;
      this.clips?.play(CLIP.fall);
      return;
    }
    // Stand where the clip left the feet: on the landing, or on the ground at the foot.
    const ground = this.physics?.groundHeight(feet[0], feet[1], feet[2] + 0.6 * METRE) ?? null;
    if (ground !== null && Math.abs(ground - feet[2]) < 0.6 * METRE) {
      this.entity.position = [feet[0], feet[1], ground];
      this.grounded = true;
    } else {
      this.entity.position = feet;
      this.air = [0, 0, 0];
      this.grounded = false;
    }
    this.clips?.play(CLIP.stand);
  }

  /** Still inside the hull of the ladder just left? Then moves ignore hulls, which close over ladders. */
  private nearLadderLeft(): boolean {
    const l = this.clearOf;
    if (!l) return false;
    const f = this.ladderFrame(l, this.entity.position);
    const inside =
      Math.abs(f.out) < LADDER_CLEAR && Math.abs(f.side) < l.halfWidth + LADDER_CLEAR && f.up > l.bottom - METRE && f.up < l.rungTop + 2 * METRE;
    if (!inside) this.clearOf = null;
    return inside;
  }

  /** Move the feet through physics, handle ground snapping, take-off into a fall, and landing. */
  private moveBody(dt: number, v: Vec3) {
    const physics = this.physics;
    const knock: Vec3 = [this.knock[0], this.knock[1], 0];
    const delta = vec3.scale(vec3.add(v, knock), dt);
    const feet = this.entity.position;
    const wasGrounded = this.grounded;
    let next: Vec3;
    let grounded: boolean;
    if (physics) {
      // Just off a ladder only the real shapes hold the body: ladders' and towers' movement hulls close over the rungs.
      const r = physics.move(feet, delta, this.entity.radius, this.entity.height, { ignoreHulls: this.nearLadderLeft(), entityId: this.entity.id });
      next = r.position;
      grounded = r.grounded;
    } else {
      next = vec3.add(feet, delta);
      grounded = wasGrounded;
    }
    if (wasGrounded) {
      if (!grounded) {
        // Ground snap: stay on slopes and down small steps (0.5 m) instead of falling.
        const ground = physics?.groundHeight(next[0], next[1], next[2] + 0.1 * METRE);
        if (ground !== null && ground !== undefined && next[2] - ground <= PHYSICS.stepDown) {
          next = [next[0], next[1], ground];
          grounded = true;
        }
      }
      if (!grounded) {
        // Walked off an edge: fall with the speed we had.
        this.air = [this.walkVelocity[0], this.walkVelocity[1], 0];
        this.clips?.play(CLIP.fall, { blend: 0 });
      }
      this.grounded = grounded;
    } else if (grounded && this.air[2] <= 0) {
      this.land(-this.air[2]);
    } else if (grounded) {
      // Still rising through a step the physics stood us on: stay airborne.
      grounded = false;
    }
    this.grounded = grounded;
    this.velocity = dt > 0 ? vec3.scale(vec3.sub(next, feet), 1 / dt) : [0, 0, 0];
    this.entity.position = next;
  }

  /** Landing (state 28/29 touchdown): fall damage, sounds, camera dip and the ground-impact noise. */
  private land(speed: number) {
    const p = this.data.params;
    const v = speed / METRE;
    this.air = [0, 0, 0];
    this.grounded = true;
    const damage = (Math.max(0, v - PHYSICS.fallDamageFrom) / PHYSICS.fallDamageRange) * p.maxHealth;
    const material = groundMaterial(this.data, this.groundPart());
    this.sound(material.land);
    if (damage > 0) {
      const fraction = damage / p.maxHealth;
      this.sound(fraction < 0.1 ? "player_fall_1" : fraction < 0.2 ? "player_fall_2" : "player_fall_3");
    }
    this.dipVelocity -= Math.min(1, v / 8) * 0.25 * METRE * 20;
    this.game.events.emit("noise", {
      position: [...this.entity.position] as Vec3,
      radius: damage > 0 ? PHYSICS.landNoiseHurt : PHYSICS.landNoise,
      sourceId: this.entity.id,
      kind: "land",
    });
    if (damage > 0) {
      this.game.events.emit("damage", {
        targetId: this.entity.id,
        amount: damage,
        sourceId: null,
        point: [...this.entity.position] as Vec3,
        direction: [0, 0, -1],
        part: "fall",
      });
    }
  }

  /** Material name of the surface under the feet, when the physics reports one. */
  private groundPart(): string | undefined {
    const f = this.entity.position;
    return this.physics?.raycast([f[0], f[1], f[2] + 0.3 * METRE], [f[0], f[1], f[2] - 0.5 * METRE], { entities: false })?.part;
  }

  private footstep() {
    if (!this.grounded || this.climbing) return;
    const material = groundMaterial(this.data, this.groundPart());
    const low = this.stance !== "stand";
    if (material.steps.length) this.sound(pick(material.steps), low ? 0.45 : 0.9);
    // AI hears footsteps within the material's range, but never from a crouched player.
    if (!low && material.footstepRange > 0) {
      this.game.events.emit("noise", {
        position: [...this.entity.position] as Vec3,
        radius: material.footstepRange,
        sourceId: this.entity.id,
        kind: "footstep",
      });
    }
  }

  // --- health --------------------------------------------------------------------------------------------------

  private takeDamage(amount: number, part: string | undefined, sourceId: number | null, dir: Vec3, point: Vec3) {
    if (this.dead || amount <= 0) return;
    const dealt = amount * this.zoneMultiplier(part, point);
    this.entity.health = Math.max(0, this.entity.health - dealt);
    this.lastHitPart = part;
    if (part !== "fall") {
      if (sourceId !== null) {
        // Bullet knock-back along the horizontal shot direction.
        const len = Math.hypot(dir[0], dir[1]);
        if (len > 0) {
          this.knock[0] += (dir[0] / len) * PHYSICS.bulletKnock;
          this.knock[1] += (dir[1] / len) * PHYSICS.bulletKnock;
        }
      }
      this.sound(`player_hit_${1 + Math.floor(Math.random() * 4)}`);
      const k = Math.min(1, 0.4 + dealt / this.entity.maxHealth);
      this.flinch.pitch += (0.03 + Math.random() * 0.03) * k;
      this.flinch.yaw += (Math.random() - 0.5) * 0.06 * k;
      this.flinch.roll += (Math.random() - 0.5) * 0.08 * k;
    }
    if (this.entity.health <= 0) this.die(sourceId);
  }

  /** Hit-zone multiplier for the physics' coarse body regions (humanplayer.qvm table; see docs/formats/player.md). */
  private zoneMultiplier(part: string | undefined, _point: Vec3): number {
    const z = this.data.params.hitZones;
    if (!part) return 1;
    const m = /^zone\s*(\d+)$/i.exec(part);
    if (m) return z[Number(m[1])] ?? 1;
    switch (part.toLowerCase()) {
      case "head":
        return z[16];
      case "torso":
      case "chest":
        return z[12];
      case "legs":
      case "leg":
      case "arms":
      case "arm":
        return z[1];
      case "foot":
      case "hand":
        return z[0];
      default:
        return 1;
    }
  }

  private die(killerId: number | null) {
    this.dead = true;
    this.entity.alive = false;
    this.entity.health = 0;
    this.gait = "dead";
    this.climb = null;
    this.game.services.hud?.action(null);
    this.lean = this.peek = 0;
    this.sound(`player_death_${1 + Math.floor(Math.random() * 3)}`);
    this.clips?.play(this.lastHitPart === "head" ? CLIP.deathHead : pick(CLIP.death));
    this.game.events.emit("death", { entityId: this.entity.id, killerId });
  }

  private updateDead(dt: number) {
    this.deathTime += dt;
    this.velocity = [0, 0, 0];
    if (!this.grounded) {
      this.air[2] -= PHYSICS.gravity * dt;
      this.moveBody(dt, this.air);
    }
    this.knock = [0, 0];
    this.clips?.advance(dt);
  }

  // --- view ----------------------------------------------------------------------------------------------------

  private pelvisHeight(): number {
    if (this.clips && this.clips.clipId !== null) return this.clips.rootHeight();
    const moving = this.gait !== "idle";
    if (this.stance === "crouch") return (moving ? FALLBACK_PELVIS.crouchMove : FALLBACK_PELVIS.crouched) * METRE;
    return (moving ? FALLBACK_PELVIS.run : FALLBACK_PELVIS.stand) * METRE;
  }

  private updateEffects(dt: number) {
    // Clips (stance blends, bob) and their footstep events.
    const clips = this.clips;
    if (clips) {
      const id = clips.clipId;
      const events = id !== null && this.grounded ? this.data.footsteps.get(id) : undefined;
      clips.advance(dt, events, () => this.footstep());
    }
    // Knock-back decays x0.9 per 30 Hz tick.
    const decay = Math.pow(PHYSICS.knockDecay, dt * 30);
    this.knock[0] *= decay;
    this.knock[1] *= decay;
    // Landing dip: a damped spring back to 0.
    this.dipVelocity += (-this.dip * 180 - this.dipVelocity * 22) * dt;
    this.dip += this.dipVelocity * dt;
    // Flinch recovers quickly.
    const f = Math.exp(-dt * 9);
    this.flinch.pitch *= f;
    this.flinch.yaw *= f;
    this.flinch.roll *= f;
  }

  /** Place the camera (and the body). Runs every frame, also while paused or frozen. */
  render(dt: number) {
    const game = this.game;
    const feet = this.entity.position;
    const lowTarget = this.stance === "stand" ? 0 : 1;
    this.low = approach(this.low, lowTarget, dt / 0.2);
    let target =
      this.stance === "prone"
        ? PRONE_EYE
        : this.pelvisHeight() + PHYSICS.eyeAbovePelvis + (PHYSICS.eyeAbovePelvisLow - PHYSICS.eyeAbovePelvis) * this.low;
    if (this.dead) target = 0.25 * METRE;
    // On a ladder the feet already ride the clip's pelvis (see climbFeet), so the eye sits a standing pelvis above.
    if (this.climb) target = this.clipRoot(CLIP.ladder, 0)[2] + PHYSICS.eyeAbovePelvis;
    this.eyeHeight += (target - this.eyeHeight) * (1 - Math.exp(-dt * (this.dead ? 2 : 25)));

    // Lean: sideways offset, shortened when a wall is in the way.
    const p = this.data.params;
    const right = direction(this.yaw - Math.PI / 2);
    const base: Vec3 = [feet[0], feet[1], feet[2] + this.eyeHeight + this.dip + this.peek * p.leanUp];
    let side = this.lean * p.leanSide;
    if (side !== 0 && this.physics) {
      const sign = Math.sign(side);
      const want = Math.abs(side) + LEAN_MARGIN;
      const hit = this.physics.raycast(base, vec3.add(base, vec3.scale(right, sign * want)), { entities: false });
      if (hit) side = sign * Math.max(0, Math.min(Math.abs(side), hit.distance - LEAN_MARGIN));
    }
    this.leanOffset = vec3.scale(right, side);
    this.eyePos = vec3.add(base, this.leanOffset);

    const roll = -this.lean * LEAN_ROLL + this.flinch.roll;
    const yaw = this.yaw + this.flinch.yaw;
    const pitch = this.pitch + this.flinch.pitch;

    const showBody = this.thirdPerson || this.dead;
    if (this.body) {
      this.body.object.visible = showBody;
      if (showBody) {
        const c = this.climb;
        if (c) {
          // The body is posed with its root held at the clip's first key, so it stands at the clip origin plus the
          // root's travel since then, facing the rungs.
          const r0 = this.clipRoot(c.clip, 0), r = this.clipRoot(c.clip, c.t);
          const [fx, fy] = c.ladder.face;
          const dx = r[0] - r0[0], dy = r[1] - r0[1];
          const o = this.climbOrigin(c);
          const grab = vec3.scale(c.grab, (c.grabLeft / LADDER_GRAB_TIME) ** 2);
          this.body.place(game.local(vec3.add([o[0] + fy * dx + fx * dy, o[1] - fx * dx + fy * dy, o[2]], grab)), c.ladder.yaw);
        } else this.body.place(game.local(feet), this.yaw);
        this.body.pose();
      }
    }
    if (this.dead) {
      // Death camera: orbit slowly around the body, as IGI's death view does.
      const around = this.yaw + Math.PI + this.deathTime * 0.25;
      const focus: Vec3 = [feet[0], feet[1], feet[2] + 0.4 * METRE];
      const from = this.orbit(focus, around, 0.6, THIRD_PERSON_DISTANCE);
      return this.lookAt(from, focus);
    }
    if (this.thirdPerson) {
      const from = this.orbit(this.eyePos, this.yaw + Math.PI, -this.pitch, THIRD_PERSON_DISTANCE);
      return game.setView(from, yaw, pitch, this.fov);
    }
    game.setView(this.eyePos, yaw, pitch, this.fov, roll);
  }

  /** A camera point `distance` behind `focus` (heading `around`, elevation `-pitch`), pulled in front of walls. */
  private orbit(focus: Vec3, around: number, pitch: number, distance: number): Vec3 {
    const d = direction(around, pitch);
    const want = vec3.add(focus, vec3.scale(d, distance));
    const hit = this.physics?.raycast(focus, want, { entities: false });
    if (!hit) return want;
    return vec3.add(focus, vec3.scale(d, Math.max(0.3 * METRE, hit.distance - 0.3 * METRE)));
  }

  private lookAt(from: Vec3, to: Vec3) {
    const d = vec3.sub(to, from);
    const yaw = Math.atan2(-d[0], d[1]);
    const pitch = Math.atan2(d[2], Math.hypot(d[0], d[1]));
    this.game.setView(from, yaw, pitch, this.fov);
  }

  dispose() {
    this.unsubscribe();
    this.body?.dispose();
  }
}

function moveDir(fwd: number, side: number): Dir | null {
  if (fwd > 0) return side > 0 ? "fr" : side < 0 ? "fl" : "f";
  if (fwd < 0) return side > 0 ? "br" : side < 0 ? "bl" : "b";
  return side > 0 ? "r" : side < 0 ? "l" : null;
}

const MOVE_IDS = new Set(Object.values(MOVE_CLIPS).flatMap((g) => Object.values(g)));
const isMoveClip = (id: number | null) => id !== null && MOVE_IDS.has(id);

function fallbackVelocity(gait: "run" | "walk" | "crouch", fwd: number, side: number): [number, number] {
  const s = FALLBACK_SPEED;
  const speed = gait === "crouch" ? s.crouch : gait === "walk" ? (fwd > 0 && !side ? s.walk : s.walkSide) : fwd > 0 && !side ? s.run : s.runSide;
  const n = Math.hypot(fwd, side) || 1;
  return [(side / n) * speed * METRE, (fwd / n) * speed * METRE];
}

const scale2 = (v: [number, number, number], s: number): [number, number] => [v[0] * s, v[1] * s];

function approach(value: number, target: number, step: number): number {
  if (value < target) return Math.min(target, value + step);
  if (value > target) return Math.max(target, value - step);
  return value;
}

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch (err) {
    console.warn("player:", err);
    return null;
  }
}
