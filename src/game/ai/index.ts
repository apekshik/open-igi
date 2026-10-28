// The AI system: IGI's soldiers and civilians. At level start every HumanSoldier task outside cutscenes and vehicles
// becomes a Soldier (soldier.ts) with a GPU-skinned body (body.ts), its HumanAI script and type script (script.ts),
// its navigation graph (nav.ts, src/formats/graph.ts) and its type's combat settings (common/ai/settings.qvm).
// The system turns game events into what soldiers perceive: "noise" and "weapon:fire" (hearing, near misses),
// "damage"/"death" (hits) and "alarm" (AIEVENT_ALARMON/OFF).
//
// Shooting goes through the weapons service's fire() (same ballistics, effects, sounds and noise as the player's);
// without a weapons service soldiers fire their own hitscan and emit "damage" in IGI units (the weapon's damage
// factor times the AI type's damage scale; the player applies its own hit-zone multipliers). Soldiers own their
// health: they subtract "damage" amounts (hit zone already applied by the weapons system) and emit "death" once;
// the weapons system drops a dead soldier's gun.
import * as THREE from "three";
import { parseAiGraph } from "../../formats/graph.ts";
import { decodeQvm, decodeQvmScript, type QvmCall, type QvmScript } from "../../formats/qvm.ts";
import { METRE, vec3, type Vec3 } from "../coords.ts";
import type { Game, GameSystem } from "../game.ts";
import type { Entity } from "../entity.ts";
import type { AiDifficulty, AiEvent, AiService } from "./api.ts";
import { SoldierBody } from "./body.ts";
import { MountedGun } from "./gun.ts";
import { aiConfigs, aiLevelData, commonScriptName, DEFAULT_CONFIG, type AiConfig, type AiLevelData, type CharacterSpec } from "./level.ts";
import { dist, NavGraph } from "./nav.ts";
import { Soldier, type AiWorld, type WeaponInfo } from "./soldier.ts";

/**
 * How far soldiers hear a shot: each weapon's "AI Detection Event Range" (DefineWeaponType) names one of two
 * constants that IGI.exe registers for the scripts, HUMANAI_DETECTIONEVENT_GUNSHOT_RANGE = 0x1E000 units (30 m) and
 * HUMANAI_DETECTIONEVENT_GUNSHOT_SILENCED_RANGE = 0x1000 (1 m): the MP5SD, the knife and thrown grenades.
 */
const GUNSHOT_RANGE = 30 * METRE;
const SILENCED_RANGE = 1 * METRE;
/** A bullet passing this close counts as AIEVENT_GUNSHOTMISS (not in the data; chosen). */
const NEAR_MISS = 2 * METRE;
/** Soldiers this close to a door the player opens or closes get AIEVENT_DOOR (not in the data; chosen). */
const DOOR_HEARING = 10 * METRE;

const DIFFICULTIES: AiDifficulty[] = ["easy", "normal", "hard"];

function difficultyFromUrl(): AiDifficulty {
  const v = new URLSearchParams(location.search).get("difficulty")?.toLowerCase();
  if (!v) return "normal";
  const n = Number(v.replace(/^gd_/, ""));
  if (n >= 1 && n <= 3) return DIFFICULTIES[n - 1];
  return DIFFICULTIES.includes(v as AiDifficulty) ? (v as AiDifficulty) : "normal";
}
/** Bone that carries the gun in the soldier skeletons (the 20-21-22 chain off the spine; 22 sits in the right hand). */
const GUN_BONE = 22;

export function aiSystem(): GameSystem {
  let ai: AiSystem | null = null;
  return {
    name: "ai",
    async init(game) {
      ai = new AiSystem(game);
      await ai.load();
      game.services.ai = ai;
    },
    update(dt) {
      ai?.update(dt);
    },
    dispose() {
      ai?.dispose();
    },
  };
}

class AiSystem implements AiService, AiWorld {
  readonly game: Game;
  debug = new URLSearchParams(location.search).has("aidebug");
  alarmOn = false;
  private soldiers: Soldier[] = [];
  private data!: AiLevelData;
  private graphs = new Map<number, NavGraph | null>();
  private levelScripts = new Map<number, QvmScript | null>();
  private commonScripts = new Map<string, QvmScript | null>();
  private configs = new Map<string, AiConfig>();
  private weaponDefs = new Map<string, WeaponInfo>();
  private level: AiDifficulty = difficultyFromUrl();
  private guns = new Map<number, MountedGun>();
  private doorList: Entity[] | null = null;
  private doorListTime = -Infinity;
  frameTime = 0;
  /** The latest explosion (its damage events follow it in the same frame). */
  private blast: { sourceId: number | null; time: number } | null = null;
  /** Characters spawned because their ConditionalContainers run (they are removed when one stops). */
  private gated = new Set<Soldier>();
  private unsubscribe: (() => void)[] = [];
  private markers = new Map<Soldier, THREE.Mesh>();
  private pending: CharacterSpec[] = [];
  private generators: { spec: CharacterSpec; spawned: number; last: number; copies: Soldier[] }[] = [];
  private pollTimer = 0;
  private frustum = new THREE.Frustum();
  private viewProjection = new THREE.Matrix4();
  private sphere = new THREE.Sphere(new THREE.Vector3(), 2.5 * METRE);

  constructor(game: Game) {
    this.game = game;
  }

  get alarm() {
    return this.alarmOn;
  }

  get difficulty(): AiDifficulty {
    return this.level;
  }

  set difficulty(value: AiDifficulty) {
    if (!DIFFICULTIES.includes(value) || value === this.level) return;
    this.level = value;
    for (const s of this.soldiers) s.config = this.configFor(s.aiType);
  }

  /** The type's HumanAIConfigItem for the current difficulty (GD_1..GD_3). */
  private configFor(aiType: string): AiConfig {
    const gd = `GD_${DIFFICULTIES.indexOf(this.level) + 1}`;
    return this.configs.get(`${aiType}/${gd}`) ?? this.configs.get(`${aiType}/GD_2`) ?? DEFAULT_CONFIG;
  }

  async load() {
    const { game } = this;
    const vfs = game.vfs;
    this.data = aiLevelData(game.level.statements);
    const read = async (path: string) => (vfs.has(path) ? vfs.read(path) : null);
    const settings = await read("common/ai/settings.qvm");
    if (settings) this.configs = aiConfigs(decodeQvm(settings));
    await this.loadWeapons();

    const wanted = this.data.characters.filter((c) => !c.scripted);
    await Promise.all(wanted.map((c) => this.prepare(c)));
    this.placeGuns();
    // Characters inside ConditionalContainers wait for them to run (checked through the mission system once it is
    // up); GuardGenerator templates spawn copies while their generator's condition holds.
    for (const spec of wanted) {
      if (spec.generator) this.generators.push({ spec, spawned: 0, last: -Infinity, copies: [] });
      else if (spec.gates.length) this.pending.push(spec);
      else this.add(spec);
    }

    const on = game.events.on.bind(game.events);
    this.unsubscribe.push(
      on("explosion", (x) => {
        this.blast = { sourceId: x.sourceId, time: this.game.time };
      }),
      on("damage", (d) => {
        // Damage arrives in IGI units with the hit zone already applied; the owner subtracts it.
        const target = this.byEntity(d.targetId);
        if (!target) return;
        // Soldiers' bullets do not hurt their own side (their grenades and rockets still do): see docs/formats/ai.md.
        const source = d.sourceId !== null ? this.byEntity(d.sourceId) : undefined;
        const blast = this.blast && this.blast.sourceId === d.sourceId && this.blast.time === this.game.time;
        if (source && source !== target && source.team === target.team && !blast) return;
        target.damaged(d.amount, d.part, d.sourceId, d.point, d.direction);
      }),
      on("death", (d) => {
        const s = this.byEntity(d.entityId);
        if (s?.alive) s.die(undefined, null, d.killerId, true);
      }),
      on("noise", (n) => {
        // Shots are heard through "weapon:fire" at IGI's detection ranges; a thrown grenade is "silenced".
        if (n.kind === "gunshot") return;
        const radius = n.kind === "throw" ? SILENCED_RANGE : n.radius;
        for (const s of this.soldiers) if (s.id !== n.sourceId) s.hear(n.position, radius, n.kind, n.sourceId);
      }),
      on("weapon:fire", (f) => this.shotFired(f.ownerId, f.origin, f.direction, f.silenced)),
      on("door:move", (d) => {
        // A door the player works (soldiers open doors right in front of themselves, the player is not near those).
        const player = game.services.player?.entity;
        if (!player || dist(player.position, d.position) > 3 * METRE) return;
        for (const s of this.soldiers) if (s.alive) s.hear(d.position, DOOR_HEARING, "door", player.id);
      }),
      on("alarm", (a) => {
        if (a.active === this.alarmOn) return;
        this.alarmOn = a.active;
        for (const s of this.soldiers) s.post(a.active ? "AIEVENT_ALARMON" : "AIEVENT_ALARMOFF");
      }),
    );
  }

  /** Load what a character needs: its scripts and its graph. */
  private async prepare(spec: CharacterSpec) {
    const vfs = this.game.vfs;
    const dir = this.game.level.dir;
    const script = async (path: string) => {
      if (!vfs.has(path)) return null;
      try {
        return decodeQvmScript(await vfs.read(path));
      } catch (err) {
        console.warn(`ai: ${path}: ${(err as Error).message}`);
        return null;
      }
    };
    if (!this.levelScripts.has(spec.aiId)) {
      this.levelScripts.set(spec.aiId, null);
      this.levelScripts.set(spec.aiId, await script(`${dir}/ai/${spec.aiId}.qvm`));
    }
    const common = commonScriptName(spec.aiType);
    if (!this.commonScripts.has(common)) {
      this.commonScripts.set(common, null);
      this.commonScripts.set(common, await script(`common/ai/${common}.qvm`));
    }
    if (!this.graphs.has(spec.graphId)) {
      this.graphs.set(spec.graphId, null);
      const path = `${dir}/graphs/graph${spec.graphId}.dat`;
      const origin = this.data.graphs.get(spec.graphId);
      if (origin && vfs.has(path)) {
        try {
          this.graphs.set(spec.graphId, new NavGraph(parseAiGraph(await vfs.read(path)), origin));
        } catch (err) {
          console.warn(`ai: ${path}: ${(err as Error).message}`);
        }
      }
    }
  }

  /** Weapon facts for soldiers: the weapons service's specs when it has them, else weapons/<NAME>/weapon.qvm. */
  private async loadWeapons() {
    const vfs = this.game.vfs;
    const paths = vfs.list().filter((p) => /^weapons\/[^/]+\/weapon\.qvm$/i.test(p));
    for (const path of paths) {
      try {
        const def = decodeQvm(await vfs.read(path)).find((c) => c.fn === "DefineWeaponType");
        const w = def && weaponFromDefinition(def);
        if (w) this.weaponDefs.set(w.id, w);
      } catch {
        // Not every weapon script needs to decode for soldiers to work.
      }
    }
  }

  /** Stationary guns stand in the level from the start; gunners walk to them. */
  private placeGuns() {
    for (const spec of this.data.guns.values()) {
      const model = this.weaponInfo(spec.weapon)?.model ?? "";
      const gun = new MountedGun(this.game, spec, model);
      this.game.world.add(gun.object);
      this.guns.set(spec.taskId, gun);
    }
  }

  weaponInfo(id: string): WeaponInfo | null {
    const spec = this.game.services.weapons?.spec(id);
    if (spec) {
      return {
        id,
        damage: spec.damage,
        roundsPerMinute: spec.roundsPerMinute,
        clipSize: Math.max(1, spec.clipSize),
        reloadTime: spec.reloadTime,
        pellets: spec.bulletsPerRound,
        model: spec.model,
        fireSound: spec.fireSound,
        silenced: /SILENCED/.test(spec.detection),
      };
    }
    return this.weaponDefs.get(id) ?? null;
  }

  private add(spec: CharacterSpec, passive = false): Soldier {
    const game = this.game;
    const physics = game.services.physics;
    // Some placements float above the ground (or sink into it): stand them on the floor below them.
    const ground = physics?.groundHeight(spec.position[0], spec.position[1], spec.position[2] + 0.5 * METRE);
    const position: Vec3 = [...spec.position];
    if (ground !== null && ground !== undefined && spec.position[2] - ground < 8 * METRE) position[2] = ground;
    const config = this.configFor(spec.aiType);
    const weaponId = spec.weapons.find((w) => !/GRENADE|FLASHBANG|BINOCULAR|MEDIPACK|MINE|KNIFE/.test(w)) ?? defaultWeapon(spec.aiType);
    const weapon = weaponId ? this.weaponInfo(weaponId) : null;
    let body: SoldierBody | null = null;
    try {
      body = SoldierBody.create(game.level.library, spec.model, spec.hierarchy);
    } catch (err) {
      console.warn(`ai: model ${spec.model}: ${(err as Error).message}`);
    }
    const soldier = game.entities.adopt(new Soldier(this, { ...spec, position }, body, config, weapon));
    if (body) {
      body.object.userData.entityId = soldier.id;
      game.world.add(body.object);
      const gun = weapon?.model ? game.level.library.build(weapon.model) : null;
      if (gun) body.attachGun(new THREE.Mesh(gun.geometry, gun.materials), GUN_BONE);
    }
    for (const w of spec.weapons) game.services.weapons?.give(soldier.id, w, this.weaponInfo(w)?.clipSize ?? 1);
    soldier.passive = passive || spec.scripted;
    this.soldiers.push(soldier);
    soldier.post("AIEVENT_CREATE");
    return soldier;
  }

  /** Take a character out of play: its body, entity and markers go; scripts get AIEVENT_DELETE first. */
  private remove(s: Soldier) {
    if (s.alive) s.post("AIEVENT_DELETE");
    s.dismount();
    s.object?.removeFromParent();
    this.game.entities.remove(s.id);
    this.soldiers.splice(this.soldiers.indexOf(s), 1);
    this.gated.delete(s);
    const m = this.markers.get(s);
    m?.removeFromParent();
    this.markers.delete(s);
  }

  update(dt: number) {
    const start = performance.now();
    const cam = this.game.camera;
    cam.updateMatrixWorld();
    this.frustum.setFromProjectionMatrix(this.viewProjection.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    if ((this.pollTimer -= dt) <= 0) {
      this.pollTimer = 0.5;
      this.spawnPending();
    }
    for (const s of this.soldiers) s.update(dt);
    if (this.debug || this.markers.size) this.drawDebug();
    this.frameTime = performance.now() - start;
  }

  // ----------------------------------------------------------------------------------------------- AiWorld

  graph(id: number) {
    return this.graphs.get(id) ?? null;
  }

  script(aiId: number) {
    return this.levelScripts.get(aiId) ?? null;
  }

  commonScript(aiType: string) {
    return this.commonScripts.get(commonScriptName(aiType)) ?? null;
  }

  taskPosition(id: number) {
    return this.data.taskPositions.get(id);
  }

  characters() {
    return this.soldiers;
  }

  raiseAlarm(source: Soldier) {
    if (this.alarmOn) return;
    this.game.events.emit("alarm", { active: true, sourceId: source.id });
  }

  inView(position: Vec3) {
    this.sphere.center.copy(this.game.toScene(position));
    this.sphere.center.y += METRE;
    return this.frustum.intersectsSphere(this.sphere);
  }

  sound(name: string, at: Vec3, volume = 1) {
    this.game.services.audio?.play(`common/sounds/${name}.wav`, { at, volume });
  }

  doors(): Entity[] {
    // Mission objects are registered after the AI system starts; look them up lazily and refresh now and then.
    if (!this.doorList || (!this.doorList.length && this.game.time - this.doorListTime > 5)) {
      this.doorList = this.game.entities.all().filter((e) => e.kind === "door");
      this.doorListTime = this.game.time;
    }
    return this.doorList;
  }

  gun(id: number) {
    return this.guns.get(id);
  }

  throwGrenade(s: Soldier, weapon: string, origin: Vec3, velocity: Vec3, fuse: number) {
    const weapons = this.game.services.weapons;
    if (!weapons) return;
    weapons.fire(s.id, weapon, origin, vec3.normalize(velocity), { velocity, fuse });
    this.game.events.emit("ai:grenade", { entityId: s.id, weapon, origin, velocity, fuse });
  }

  shoot(s: Soldier, origin: Vec3, dir: Vec3, weapon?: WeaponInfo) {
    const w = weapon ?? s.weapon;
    if (!w) return;
    const game = this.game;
    const weapons = game.services.weapons;
    if (weapons) {
      // Aim error is already in the direction; distant off-screen shooters skip their muzzle effects.
      const quiet = !this.inView(s.position) && dist(s.position, game.fromScene(game.camera.position)) > 60 * METRE;
      // Shotguns (Spas 12: Damage Factor 0.25, 30 pellets): we read the factor as the whole shell's, shared by its
      // pellets. Read per pellet, one shell from a guard did up to 7.5 damage (Jones dies at 3); see docs/formats/ai.md.
      const pellets = Math.max(1, w.pellets);
      weapons.fire(s.id, w.id, origin, dir, { damageScale: s.config.damageScale / pellets, spreadScale: pellets > 1 ? 1 : 0.5, quiet });
      return;
    }
    // Our own hitscan: first thing along the line within 300 m.
    const physics = game.services.physics;
    const end = vec3.add(origin, vec3.scale(dir, 300 * METRE));
    const hit = physics?.raycast(origin, end, { ignoreEntity: s.id });
    game.events.emit("weapon:fire", { ownerId: s.id, weapon: w.id, origin, direction: dir, silenced: w.silenced });
    game.events.emit("noise", { position: origin, radius: w.silenced ? SILENCED_RANGE : GUNSHOT_RANGE, sourceId: s.id, kind: "gunshot" });
    if (w.fireSound && Math.random() < 0.5) this.sound(w.fireSound, origin, 0.8);
    if (hit?.entityId !== null && hit?.entityId !== undefined) {
      const amount = w.damage * s.config.damageScale;
      game.events.emit("damage", { targetId: hit.entityId, amount, sourceId: s.id, point: hit.point, direction: dir, part: hit.part });
    }
  }

  // ----------------------------------------------------------------------------------------------- service

  byTask(taskId: number) {
    return this.soldiers.find((s) => s.taskId === taskId);
  }

  private byEntity(id: number) {
    const e = this.game.entities.get(id);
    return e instanceof Soldier ? e : undefined;
  }

  /**
   * Spawn the gated characters whose containers now run, and generator copies whose conditions hold; remove the ones
   * whose containers stopped (IGI deletes a ConditionalContainer's subtree when it stops; it can come back fresh).
   */
  private spawnPending() {
    const mission = this.game.services.mission;
    const test = (expression: string, self?: number) => {
      if (!mission) return true;
      try {
        const v = mission.evaluate(expression, self);
        return typeof v === "number" ? v !== 0 : v !== "";
      } catch {
        return true;
      }
    };
    for (const s of [...this.soldiers]) {
      // Only characters that entered play with their containers running leave with them (not ones spawned by request).
      if (!this.gated.has(s) || gatesOpen(s.spec, test)) continue;
      this.remove(s);
      if (!s.spec.generator && !this.pending.includes(s.spec)) this.pending.push(s.spec);
    }
    this.pending = this.pending.filter((spec) => {
      if (!gatesOpen(spec, test)) return true;
      this.gated.add(this.add(spec));
      return false;
    });
    for (const g of this.generators) {
      const gen = g.spec.generator!;
      if (g.spawned >= gen.maxSpawns || !gatesOpen(g.spec, test) || !test(gen.condition, gen.taskId)) continue;
      // One guard at a time: the next comes when the last is down or a few seconds have passed.
      if (g.copies.some((c) => c.alive) && this.game.time - g.last < 8) continue;
      const copy = this.add({ ...g.spec, taskId: g.spawned === 0 ? g.spec.taskId : -1 });
      if (g.spec.gates.length) this.gated.add(copy);
      copy.lastKnown = this.game.services.player ? [...this.game.services.player.entity.position] : null;
      if (this.alarmOn) copy.post("AIEVENT_ALARMON");
      g.copies.push(copy);
      g.spawned++;
      g.last = this.game.time;
    }
  }

  generatorSpawns(taskId: number) {
    return this.generators.find((g) => g.spec.generator!.taskId === taskId)?.spawned ?? 0;
  }

  spawn(taskId: number, options: { passive?: boolean; passenger?: { anchor: () => { position: Vec3; yaw: number } | null } } = {}) {
    const existing = this.byTask(taskId);
    if (existing) return existing;
    const spec = this.data.characters.find((c) => c.taskId === taskId);
    if (!spec) return undefined;
    this.pending = this.pending.filter((p) => p !== spec);
    // Scripts and graphs load asynchronously; the character starts with its type's defaults until they arrive.
    void this.prepare(spec);
    const s = this.add(spec, options.passive ?? !!options.passenger);
    s.passive = options.passive ?? (!!options.passenger || spec.scripted);
    if (options.passenger) s.anchor = options.passenger.anchor;
    return s;
  }

  despawn(taskId: number) {
    const s = this.byTask(taskId);
    if (s) this.remove(s);
  }

  send(entityId: number, event: AiEvent, options?: { position?: Vec3; animation?: number }) {
    this.byEntity(entityId)?.post(event, options);
  }

  /**
   * Every soldier within the weapon's detection range hears a shot (comrades' shots too, which is how a fight draws
   * the guards around it); the ones the bullet passed close to react to the near miss.
   */
  private shotFired(ownerId: number, origin: Vec3, dir: Vec3, silenced: boolean) {
    const range = silenced ? SILENCED_RANGE : GUNSHOT_RANGE;
    for (const s of this.soldiers) {
      if (!s.alive || s.id === ownerId) continue;
      s.hear(origin, range, "gunshot", ownerId);
      const chest: Vec3 = [s.position[0], s.position[1], s.position[2] + 1.2 * METRE];
      const rel = vec3.sub(chest, origin);
      const along = vec3.dot(rel, dir);
      if (along <= 0) continue;
      const off = vec3.length(vec3.sub(rel, vec3.scale(dir, along)));
      if (off < NEAR_MISS && off > s.radius) s.nearMiss(chest, ownerId);
    }
  }

  private drawDebug() {
    const colors: Record<string, number> = { idle: 0x44aa44, patrol: 0x44ff44, alert: 0xffcc00, search: 0xff8800, combat: 0xff0000, dead: 0x444444 };
    for (const s of this.soldiers) {
      let m = this.markers.get(s);
      if (!m) {
        m = new THREE.Mesh(new THREE.OctahedronGeometry(0.15 * METRE), new THREE.MeshBasicMaterial());
        this.game.world.add(m);
        this.markers.set(s, m);
      }
      m.visible = this.debug;
      m.position.copy(this.game.local(s.position)).add(new THREE.Vector3(0, 0, 2.2 * METRE));
      (m.material as THREE.MeshBasicMaterial).color.setHex(colors[s.state] ?? 0xffffff);
      m.scale.setScalar(0.5 + s.awareness);
    }
  }

  dispose() {
    for (const u of this.unsubscribe) u();
    for (const s of this.soldiers) s.object?.removeFromParent();
    for (const g of this.guns.values()) g.object.removeFromParent();
    for (const m of this.markers.values()) m.removeFromParent();
  }
}

function gatesOpen(spec: CharacterSpec, test: (expression: string) => boolean) {
  return spec.gates.every((id) => test(`ConditionalContainer_${id}.isRun`));
}

/** Soldiers without a Gun task carry their type's weapon. */
function defaultWeapon(aiType: string): string | null {
  if (aiType === "AITYPE_CIVILIAN") return null;
  if (aiType.endsWith("_SPAS")) return "WEAPON_ID_SPAS12";
  if (aiType.endsWith("_UZI")) return "WEAPON_ID_UZI";
  if (aiType.endsWith("_PISTOL")) return "WEAPON_ID_GLOCK";
  if (aiType === "AITYPE_SNIPER") return "WEAPON_ID_DRAGUNOV";
  if (aiType === "AITYPE_RPG") return "WEAPON_ID_RPG18";
  return "WEAPON_ID_AK47";
}

/**
 * The few DefineWeaponType values soldiers need, by position: 1 id, 10 damage factor, 12 reload time, 14 bullets per
 * round, 15 rounds per minute, 16 clip size; then the gun model (the first "NNN_NN_N" name) and the fire sound (the
 * first plain lower-case name after the models). The weapons system documents the full layout.
 */
function weaponFromDefinition(def: QvmCall): WeaponInfo | null {
  const a = def.args;
  const num = (i: number) => (typeof a[i] === "number" ? (a[i] as number) : 0);
  if (typeof a[1] !== "string") return null;
  const strings = a.map((v, i) => [v, i] as const).filter(([v]) => typeof v === "string") as [string, number][];
  const model = strings.find(([v, i]) => i > 20 && /^\d{3}_\d{2}_\d$/.test(v));
  const sound = strings.find(([v, i]) => i > (model?.[1] ?? 20) && /^[a-z0-9_]+$/.test(v));
  const silenced = a.some((v) => typeof v === "object" && "ident" in v && /SILENCED/.test(v.ident));
  return {
    id: a[1],
    damage: num(10),
    reloadTime: num(12),
    pellets: Math.max(1, num(14)),
    roundsPerMinute: num(15),
    clipSize: Math.max(1, num(16)),
    model: model?.[0] ?? "",
    fireSound: sound?.[0] ?? "",
    silenced,
  };
}
