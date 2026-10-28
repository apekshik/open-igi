// Weapons: IGI's arsenal from weapons/*/weapon.qvm and ammo/*/ammo.qvm. Jones's inventory, ammo and reloads,
// switching (slot keys, wheel), hitscan firing with spread, view kick and hit zones, thrown and launched weapons,
// pickups, binoculars and scopes, first-person arms and guns, and the same ballistics for AI shooters via `fire()`.
//
// Damage follows IGI.exe as documented by flawme/igi-reverse-engineering (reverse/docs/06-weapons, see
// THIRD_PARTY.md): damage = hit-zone multiplier x weapon Damage Factor, and a character dies when its accumulated
// damage reaches its threshold (1.0 for AI, DefineHumanPlayerGeneral argument 7 for the player). Entity health here
// is `maxHealth` scaled, so a hit removes damage / threshold x maxHealth. See docs/formats/weapons.md.
import * as THREE from "three";
import { parseAnimFile, type AnimFile } from "../../formats/anim.ts";
import { readRes } from "../../formats/ilff.ts";
import type { WeaponSpec } from "../../formats/weapon.ts";
import type { SoundHandle } from "../audio/api.ts";
import { direction, METRE, vec3, type Vec3 } from "../coords.ts";
import type { Entity } from "../entity.ts";
import type { Game, GameSystem } from "../game.ts";
import type { Action } from "../input.ts";
import type { FireOptions, ShotResult, WeaponsService, WeaponState, ZoomKind } from "./api.ts";
import { extras, loadWeaponData, type WeaponData } from "./data.ts";
import { Effects } from "./effects.ts";
import { ZoomOverlay } from "./overlay.ts";
import { loadoutOf, Pickups, tasks, type Loadout, type PickupEntity, type PickupItem } from "./pickups.ts";
import { GRENADE_FUSE, Projectiles, type Projectile } from "./projectiles.ts";
import { loadSprites } from "./sprite.ts";
import { ViewModel } from "./viewmodel.ts";

/** Spread values are read as tenths of a degree (our reading; see docs/formats/weapons.md). */
const SPREAD_UNIT = 0.1;
/** Hearing radius of gunshots for AI ("noise" events): normal and silenced. */
const GUNSHOT_NOISE = 100 * METRE;
const SILENCED_NOISE = 10 * METRE;
const EXPLOSION_NOISE = 150 * METRE;
/** Audible range of gunshots (common/sounds/sounds.qvm DefineSound range 65 m). */
const GUNSHOT_RANGE = 65 * METRE;
/** AI hit-zone multipliers (IGI.exe table at 0x53f9d0): head 100, torso 1, limbs 0.5-1 by segment. */
const AI_ZONES: Record<string, number> = { head: 100, torso: 1, arms: 0.75, legs: 0.75 };
/** Reload sounds (common/sounds/<prefix>_reload_<n>.wav) by weapon. */
const RELOAD_SOUNDS: Record<string, string> = {
  WEAPON_ID_GLOCK: "glock",
  WEAPON_ID_DESERTEAGLE: "glock",
  WEAPON_ID_COLT: "colt",
  WEAPON_ID_MP5SD: "mp5",
  WEAPON_ID_UZI: "uzi",
  WEAPON_ID_UZIX2: "uzix2",
  WEAPON_ID_M16A2: "m16",
  WEAPON_ID_AK47: "ak47",
  WEAPON_ID_SPAS12: "spas12",
  WEAPON_ID_JACKHAMMER: "jackh",
  WEAPON_ID_DRAGUNOV: "dragu",
  WEAPON_ID_MINIMI: "minimi",
};
/** Part counts in common/sounds, used when the audio system cannot list its sounds. */
const RELOAD_PARTS: Record<string, number> = {
  glock_reload: 3, colt_reload: 7, mp5_reload: 5, uzi_reload: 3, uzix2_reload: 1, m16_reload: 3, ak47_reload: 3,
  spas12_reload: 2, spas12_bulins: 4, jackh_reload: 4, dragu_reload: 2, minimi_reload: 2,
};
/** Spread multiplier by what Jones's legs are doing (not in the data; IGI rewards standing still and crouching). */
const GAIT_SPREAD: Record<string, number> = { idle: 1, crouch: 1.2, crawl: 1.2, walk: 1.6, run: 2.5, air: 3, ladder: 3 };
/** common/sounds/bul_<family>_<n>.wav by game material, and how many variants each family has. */
const IMPACT_SOUNDS: Record<string, string> = {
  concrete: "concrete", wood: "wood", glass: "glass", fence: "metal_fnc", strongmetal: "metal_hrd", normalmetal: "metal_nrm",
  softmetal: "metal_sft", gravel: "gravel", ground: "gravel", snow: "gravel", carton: "carton", textiles: "textile",
  rug: "rug", plastic: "plastic", porcelain: "porc", rubber: "rubber", runway: "asphalt", asphalt: "asphalt", flesh: "flesh",
};
const IMPACT_PARTS: Record<string, number> = {
  asphalt: 2, carton: 3, concrete: 2, flesh: 5, glass: 4, gravel: 3, metal_fnc: 2, metal_hrd: 3, metal_nrm: 3, metal_sft: 4,
  plastic: 1, porc: 4, rubber: 1, rug: 2, textile: 1, wood: 7,
};
const SLOT_KEYS: Action[] = ["weapon1", "weapon2", "weapon3", "weapon4", "weapon5", "weapon6", "weapon7", "weapon8", "weapon9"];
const FIREARMS = new Set(["GUN", "PISTOL", "SHOTGUN"]);
const THROWN = new Set(["GRENADE", "PROXIMITYMINE"]);

const displayName = (s: WeaponSpec) => s.name.replace(/[<>]/g, "");
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const isLoopSound = (name: string) => /_loop$/.test(name);
const deg = (d: number) => (d * Math.PI) / 180;

interface Carried {
  spec: WeaponSpec;
  clip: number;
}

type PlayerState = "ready" | "switching" | "reloading" | "throwing" | "stabbing";

export function weaponsSystem(): GameSystem {
  let svc: Arsenal | null = null;
  return {
    name: "weapons",
    async init(game) {
      svc = new Arsenal(game);
      await svc.load();
      game.services.weapons = svc;
    },
    update(dt, game) {
      svc?.update(dt, game);
    },
    lateUpdate(dt, game) {
      svc?.lateUpdate(game.paused ? 0 : dt, game);
    },
    dispose() {
      svc?.dispose();
    },
  };
}

class Arsenal implements WeaponsService {
  drawOverlay = false;
  private game: Game;
  private data!: WeaponData;
  private effects!: Effects;
  private overlay!: ZoomOverlay;
  private viewModel: ViewModel | null = null;
  private projectiles!: Projectiles;
  private pickups!: Pickups;

  // The player's kit.
  private carried = new Map<string, Carried>();
  private reserve = new Map<string, number>();
  private held: string | null = null;
  private state: PlayerState = "ready";
  private nextShot = 0;
  private burst = 0;
  private triggerUp = true;
  private binoculars = false;
  private zoomKind: ZoomKind = null;
  private zoomFov = 70;
  private baseFov = 70;
  private baseSensitivity = 0;
  private lastZoomSound = 0;
  private moving = false;

  // Everyone else.
  private loadouts = new Map<number, string[]>();
  private taskLoadouts = new Map<number, Loadout>();
  private shooters = new Map<number, { handle: SoundHandle | null; spec: WeaponSpec; until: number; at?: Vec3 }>();
  private timers: { at: number; fn: () => void; tag?: string }[] = [];
  private unsubscribe: (() => void)[] = [];

  constructor(game: Game) {
    this.game = game;
  }

  // ------------------------------------------------------------------------------------------------------- loading

  async load() {
    const game = this.game;
    const [data, sprites, anims, modelBytes] = await Promise.all([
      loadWeaponData(game.vfs),
      loadSprites(game.vfs),
      this.loadArmsAnims(),
      this.loadModelBytes(),
    ]);
    this.data = data;
    this.effects = new Effects(game, sprites);
    this.overlay = new ZoomOverlay(game.overlay, sprites);
    this.viewModel = new ViewModel(game.level.library, anims, (n) => modelBytes.get(n));
    game.scene.add(this.viewModel.root);
    this.projectiles = new Projectiles(game, {
      explode: (p) => this.detonate(p),
      bounce: (p) => this.sound("grenade_bnc_1", p.position, 20 * METRE),
      sense: (p) => this.senseMine(p),
      arm: (p) => this.sound("proxy_arm", p.position, 10 * METRE),
    });
    this.pickups = new Pickups(game, (item) => this.pickupModel(item));
    this.pickups.fromLevel();

    // Loadouts carried as child tasks (HumanPlayer, HumanSoldier, ...).
    let playerKit: Loadout | null = null;
    for (const t of tasks(game.level.statements)) {
      if (!t.children.length) continue;
      const kit = loadoutOf(t.children);
      if (!kit.weapons.length && !kit.ammo.length) continue;
      if (t.type === "HumanPlayer") playerKit ??= kit;
      else if (t.id >= 0) this.taskLoadouts.set(t.id, kit);
    }
    if (playerKit) {
      for (const w of playerKit.weapons) this.give(this.playerId, w.id, -1);
      for (const a of playerKit.ammo) this.addAmmo(a.id, a.rounds);
    }
    const first = this.bestWeapon();
    if (first) this.raise(first, false);

    this.unsubscribe.push(game.events.on("death", (e) => this.onDeath(e.entityId)));
  }

  private async loadArmsAnims(): Promise<AnimFile | null> {
    const fromLibrary = this.game.level.library.animFiles.find((a) => a.skeleton.hierarchy === 5);
    if (fromLibrary) return fromLibrary;
    try {
      return parseAnimFile(await this.game.vfs.read("common/anims/005.iff"));
    } catch {
      return null;
    }
  }

  /** Raw .mef bytes of the shared weapon models (for their ATTA attachment points). */
  private async loadModelBytes(): Promise<Map<string, Uint8Array>> {
    const out = new Map<string, Uint8Array>();
    const path = "missions/location0/common/models/location0.res";
    if (!this.game.vfs.has(path)) return out;
    for (const e of readRes(await this.game.vfs.read(path))) {
      const name = e.name.split("/").pop()!.replace(/\.mef$/i, "");
      if (/^1\d\d_|^10\d\d_/.test(name)) out.set(name, e.data);
    }
    return out;
  }

  dispose() {
    for (const u of this.unsubscribe) u();
    if (this.viewModel) this.game.scene.remove(this.viewModel.root);
    for (const s of this.shooters.values()) s.handle?.stop();
  }

  // ---------------------------------------------------------------------------------------------- service: queries

  private get playerId(): number {
    return this.game.services.player?.entity.id ?? -1;
  }

  spec(weaponId: string) {
    return this.data.weapons.get(weaponId);
  }

  ammo(ammoId: string) {
    return this.data.ammo.get(ammoId);
  }

  private ammoIdOf(spec: WeaponSpec): string | undefined {
    // Binoculars and the knife name a calibre but use no ammo.
    if (spec.ammoDisplay === "NONE") return undefined;
    return this.data.ammoByCalibre.get(spec.calibre);
  }

  private stateOf(c: Carried): WeaponState {
    const ammoId = this.ammoIdOf(c.spec);
    return { id: c.spec.id, name: displayName(c.spec), clip: c.clip, clipSize: ammoId ? Math.max(0, c.spec.clipSize) : 0, reserve: ammoId ? (this.reserve.get(ammoId) ?? 0) : 0 };
  }

  current(): WeaponState | null {
    if (this.binoculars || !this.held) return null;
    const c = this.carried.get(this.held);
    return c ? this.stateOf(c) : null;
  }

  inventory(): WeaponState[] {
    const order = this.data.player.cycle;
    return [...this.carried.values()]
      .sort((a, b) => (order.indexOf(a.spec.id) + 1 || 99) - (order.indexOf(b.spec.id) + 1 || 99))
      .map((c) => this.stateOf(c));
  }

  zoom() {
    return { kind: this.zoomKind, fov: this.zoomKind ? this.zoomFov : (this.game.services.player?.fov ?? 70) };
  }

  // ------------------------------------------------------------------------------------------- service: inventory

  give(entityId: number, weaponId: string, rounds: number) {
    const spec = this.spec(weaponId);
    if (!spec) return;
    if (entityId !== this.playerId) {
      const list = this.loadouts.get(entityId) ?? [];
      if (!list.includes(weaponId)) list.push(weaponId);
      this.loadouts.set(entityId, list);
      return;
    }
    const n = rounds < 0 ? Math.max(1, spec.clipSize) : rounds;
    const have = this.carried.get(weaponId);
    if (have) {
      const ammoId = this.ammoIdOf(spec);
      if (ammoId) this.addAmmo(ammoId, n);
      return;
    }
    const clip = spec.clipSize > 0 && this.ammoIdOf(spec) ? Math.min(n, spec.clipSize) : 0;
    this.carried.set(weaponId, { spec, clip });
    const ammoId = this.ammoIdOf(spec);
    if (ammoId && n > clip) this.addAmmo(ammoId, n - clip);
  }

  addAmmo(ammoId: string, rounds: number): number {
    const limit = this.data.player.ammoLimits.get(ammoId) ?? 999;
    const have = this.reserve.get(ammoId) ?? 0;
    // Rounds in clips count against the carry limit too.
    let inClips = 0;
    for (const c of this.carried.values()) if (this.ammoIdOf(c.spec) === ammoId) inClips += c.clip;
    const take = Math.max(0, Math.min(rounds, limit - have - inClips));
    if (take > 0) this.reserve.set(ammoId, have + take);
    // Grenades and mines picked up as ammo while not carried: give the weapon.
    if (take > 0) {
      for (const w of this.data.weapons.values()) {
        if (THROWN.has(w.type) && this.ammoIdOf(w) === ammoId && !this.carried.has(w.id)) {
          this.reserve.set(ammoId, have + take - 1);
          this.carried.set(w.id, { spec: w, clip: 1 });
        }
      }
    }
    return take;
  }

  select(weaponId: string): boolean {
    const c = this.carried.get(weaponId);
    if (!c) return false;
    if (this.binoculars) this.setBinoculars(false);
    if (this.held === weaponId && this.state !== "switching") return true;
    this.raise(weaponId, true);
    return true;
  }

  // -------------------------------------------------------------------------------------------- service: shooting

  fire(ownerId: number, weaponId: string, origin: Vec3, dir: Vec3, options: FireOptions = {}): ShotResult {
    const spec = this.spec(weaponId);
    if (!spec) return { hits: [] };
    const d = vec3.normalize(dir);
    if (spec.type === "GRENADE" || spec.projectile === "MISSILE" || spec.type === "PROXIMITYMINE") {
      this.launch(ownerId, spec, origin, d);
      return { hits: [] };
    }
    if (spec.type === "KNIFE") return this.stab(ownerId, spec, origin, d, options.damageScale ?? 1);
    if (!options.quiet) {
      this.effects.muzzle(vec3.add(origin, vec3.scale(d, 0.6 * METRE)));
      this.shotSound(ownerId, spec, origin);
    }
    return this.shoot(ownerId, spec, origin, d, options, false);
  }

  /** Hitscan bullets (all pellets of one round), damage per entity, impacts, events. */
  private shoot(ownerId: number, spec: WeaponSpec, origin: Vec3, dir: Vec3, options: FireOptions, player: boolean): ShotResult {
    const physics = this.game.services.physics;
    const pellets = Math.max(1, spec.bulletsPerRound);
    const amplitude = deg(Math.max(Math.abs(spec.spread[0]), Math.abs(spec.spread[1])) * SPREAD_UNIT * (options.spreadScale ?? 1) + (options.spread ?? 0));
    const range = Math.max(spec.range, 1) * METRE;
    const result: ShotResult = { hits: [] };
    const damage = new Map<number, { amount: number; zone: number; point: Vec3; part?: string }>();
    let surfaceSounds = 0;
    for (let i = 0; i < pellets; i++) {
      const d = jitter(dir, amplitude);
      const to = vec3.add(origin, vec3.scale(d, range));
      const hit = physics?.raycast(origin, to, { ignoreEntity: ownerId });
      if (!player && i === 0 && Math.random() < 0.35) this.effects.tracer(vec3.add(origin, vec3.scale(d, 1 * METRE)), hit?.point ?? to);
      if (!hit) continue;
      result.hits.push({ point: hit.point, entityId: hit.entityId, part: hit.part });
      const target = hit.entityId !== null ? this.game.entities.get(hit.entityId) : undefined;
      if (target && target.kind !== "pickup") {
        const zone = this.zone(target, hit.part);
        const prev = damage.get(target.id) ?? { amount: 0, zone: 0, point: hit.point, part: hit.part };
        prev.amount += spec.damage * zone * (options.damageScale ?? 1);
        if (zone > prev.zone) Object.assign(prev, { zone, point: hit.point, part: hit.part });
        damage.set(target.id, prev);
        this.effects.impact(hit.point, vec3.scale(d, -1), true);
        if (i === 0 || Math.random() < 0.15) this.effects.blood(hit.point, physics?.groundHeight(hit.point[0], hit.point[1], hit.point[2]) ?? null);
      } else {
        this.effects.impact(hit.point, hit.normal, false);
        if (surfaceSounds++ < 2) this.impactSound(hit.point, hit.material ?? hit.part);
      }
      this.game.events.emit("weapon:impact", { ownerId, weapon: spec.id, point: hit.point, normal: hit.normal, entityId: hit.entityId, part: hit.part });
    }
    for (const [id, d] of damage) {
      this.sound(`bul_flesh_${1 + Math.floor(Math.random() * 5)}`, d.point, 30 * METRE);
      this.applyFactor(id, d.amount, ownerId, d.point, dir, d.part);
    }
    this.game.events.emit("weapon:fire", { ownerId, weapon: spec.id, origin, direction: dir, silenced: spec.detection.includes("SILENCED") });
    this.game.events.emit("noise", { position: origin, radius: spec.detection.includes("SILENCED") ? SILENCED_NOISE : GUNSHOT_NOISE, sourceId: ownerId, kind: "gunshot" });
    return result;
  }

  private stab(ownerId: number, spec: WeaponSpec, origin: Vec3, dir: Vec3, scale: number): ShotResult {
    const reach = Math.max(spec.range, 1.4) * METRE;
    const hit = this.game.services.physics?.raycast(origin, vec3.add(origin, vec3.scale(dir, reach)), { ignoreEntity: ownerId });
    this.sound(Math.random() < 0.5 ? spec.fireSound : spec.fireSoundEnd, ownerId === this.playerId ? undefined : origin, 10 * METRE);
    this.game.events.emit("noise", { position: origin, radius: 4 * METRE, sourceId: ownerId, kind: "knife" });
    if (!hit) return { hits: [] };
    const target = hit.entityId !== null ? this.game.entities.get(hit.entityId) : undefined;
    if (target && target.kind !== "pickup") {
      this.sound("stab_01", hit.point, 10 * METRE);
      this.effects.impact(hit.point, vec3.scale(dir, -1), true);
      this.applyFactor(target.id, spec.damage * this.zone(target, hit.part) * scale, ownerId, hit.point, dir, hit.part);
    } else {
      this.impactSound(hit.point, hit.material ?? hit.part);
    }
    return { hits: [{ point: hit.point, entityId: hit.entityId, part: hit.part }] };
  }

  /**
   * Hit-zone multiplier applied here: AI zones from IGI.exe's table. The player applies its own humanplayer.qvm zones
   * to the incoming amount (src/game/player), so hits on the player go out as the bare Damage Factor.
   */
  private zone(target: Entity, part?: string): number {
    if (target.id === this.playerId) return 1;
    return AI_ZONES[part ?? "torso"] ?? 1;
  }

  private applyFactor(targetId: number, amount: number, sourceId: number | null, point: Vec3, dir: Vec3, part?: string) {
    this.applyDamage(targetId, amount, sourceId, point, dir, part);
  }

  applyDamage(targetId: number, amount: number, sourceId: number | null, point: Vec3, direction: Vec3, part?: string) {
    const target = this.game.entities.get(targetId);
    if (!target || !target.alive || amount <= 0) return;
    this.game.events.emit("damage", { targetId, amount, sourceId, point, direction, part });
  }

  explode(position: Vec3, sourceId: number | null, radius: number, falloff: number, damage: number, kind = "explosion") {
    const flash = kind === "flashbang";
    this.effects.explosion(position, radius, flash);
    const sound = flash ? "explo_flash" : kind === "mine" ? "explo_proxy" : kind === "missile" ? "explo_03_l" : "explo_02_m";
    this.sound(sound, position, 300 * METRE, 1);
    this.game.events.emit("explosion", { position, radius, sourceId, kind });
    this.game.events.emit("noise", { position, radius: EXPLOSION_NOISE, sourceId, kind });
    const physics = this.game.services.physics;
    const lifted: Vec3 = [position[0], position[1], position[2] + 0.3 * METRE];
    if (flash) {
      const player = this.game.services.player;
      if (!player) return;
      const eye = player.eye();
      const dist = vec3.distance(eye, position);
      const reach = radius + falloff;
      if (dist < reach && (physics?.lineOfSight(lifted, eye) ?? true)) {
        const look = direction(player.yaw, player.pitch);
        const facing = 0.4 + 0.6 * Math.max(0, vec3.dot(look, vec3.normalize(vec3.sub(position, eye))));
        const strength = (1 - dist / reach) * facing;
        this.overlay.flash(strength);
        this.game.events.emit("flash", { position, strength });
      }
      return;
    }
    for (const e of this.game.entities.all()) {
      if (!e.alive || e.kind === "pickup" || e.radius <= 0) continue;
      const centre: Vec3 = [e.position[0], e.position[1], e.position[2] + e.height * 0.5];
      const d = vec3.distance(centre, position);
      if (d > radius) continue;
      if (physics && !physics.lineOfSight(lifted, centre)) continue;
      const f = Math.min(1, (radius - d) / Math.max(falloff, 0.01 * METRE));
      this.applyFactor(e.id, damage * f, sourceId, centre, vec3.normalize(vec3.sub(centre, position)), "torso");
    }
  }

  // ------------------------------------------------------------------------------------------------- projectiles

  private launch(ownerId: number, spec: WeaponSpec, origin: Vec3, dir: Vec3) {
    const x = extras(this.data, spec);
    const lib = this.game.level.library;
    const make = (name: string | undefined) => {
      const b = name ? lib.build(name) : null;
      return b ? new THREE.Mesh(b.geometry, b.materials) : new THREE.Mesh(new THREE.SphereGeometry(0.05 * METRE), new THREE.MeshLambertMaterial({ color: 0x334422 }));
    };
    const owner = ownerId >= 0 ? ownerId : null;
    if (spec.type === "PROXIMITYMINE") {
      const ground = this.game.services.physics?.groundHeight(origin[0], origin[1], origin[2]) ?? origin[2];
      const object = make(spec.model);
      object.userData.countdown = x.countdown ?? 0.5;
      this.projectiles.add({
        kind: "mine", weapon: spec.id, ownerId: owner, position: [origin[0], origin[1], ground], velocity: [0, 0, 0],
        timer: x.armTime ?? 3, state: "arming", object, activateRadius: (x.activateRadius ?? 2.5) * METRE, bounces: 0,
      });
      return;
    }
    if (spec.projectile === "MISSILE") {
      this.sound(spec.fireSound, ownerId === this.playerId ? undefined : origin, 150 * METRE);
      this.effects.muzzle(origin);
      this.projectiles.add({
        kind: "missile", weapon: spec.id, ownerId: owner, position: origin, velocity: vec3.scale(dir, 70 * METRE),
        timer: Math.max(spec.range, 300) / 70, state: "flying", object: make(spec.missileModel), bounces: 0,
      });
      this.game.events.emit("weapon:fire", { ownerId, weapon: spec.id, origin, direction: dir, silenced: false });
      this.game.events.emit("noise", { position: origin, radius: GUNSHOT_NOISE, sourceId: ownerId, kind: "gunshot" });
      return;
    }
    // Hand grenade / flashbang: muzzle velocity is the throw speed in m/s, thrown slightly upwards.
    const speed = Math.max(spec.muzzleVelocity, 5) * METRE;
    const up = vec3.normalize(vec3.add(dir, [0, 0, 0.25]));
    this.sound(spec.fireSound, ownerId === this.playerId ? undefined : origin, 15 * METRE);
    this.projectiles.add({
      kind: spec.id === "WEAPON_ID_FLASHBANG" ? "flashbang" : "grenade", weapon: spec.id, ownerId: owner, position: origin,
      velocity: vec3.scale(up, speed), timer: GRENADE_FUSE, state: "flying", object: make(spec.model), bounces: 0,
    });
    this.game.events.emit("noise", { position: origin, radius: SILENCED_NOISE, sourceId: ownerId, kind: "throw" });
  }

  private detonate(p: Projectile) {
    const spec = this.spec(p.weapon);
    const x = spec ? extras(this.data, spec) : {};
    if (p.kind === "grenade") this.explode(p.position, p.ownerId, (x.radius ?? 7) * METRE, (x.falloff ?? 4) * METRE, x.damage ?? 1.3, "grenade");
    else if (p.kind === "flashbang") this.explode(p.position, p.ownerId, (x.radius ?? 10) * METRE, (x.falloff ?? 15) * METRE, 0, "flashbang");
    else if (p.kind === "mine") this.explode(p.position, p.ownerId, (x.radius ?? 3.5) * METRE, (x.radius ?? 3.5) * 0.5 * METRE, 2, "mine");
    else this.explode(p.position, p.ownerId, 6 * METRE, 3 * METRE, 2, "missile");
  }

  private senseMine(p: Projectile): boolean {
    const r = p.activateRadius ?? 2.5 * METRE;
    return this.game.entities.all().some((e) => e.alive && e.radius > 0 && vec3.distance(e.position, p.position) < r);
  }

  // ----------------------------------------------------------------------------------------------------- pickups

  private pickupModel(item: PickupItem): string {
    if (item.kind === "weapon") return this.spec(item.id)?.model ?? "";
    return this.ammo(item.id)?.model ?? "";
  }

  private collect(e: PickupEntity) {
    const item = e.item;
    if (item.kind === "weapon") {
      const spec = this.spec(item.id);
      if (!spec) return;
      const rounds = item.amount < 0 ? Math.max(1, spec.clipSize) : item.amount;
      if (!this.carried.has(item.id)) {
        this.give(this.playerId, item.id, rounds);
        this.picked(e, displayName(spec), rounds, "weaponpickup_1");
        if (!this.held) this.raise(item.id, true);
        return;
      }
      const ammoId = this.ammoIdOf(spec);
      if (!ammoId) return;
      const took = this.addAmmo(ammoId, rounds);
      if (took > 0) this.picked(e, `${displayName(spec)} ammo`, took, "pickup");
      return;
    }
    const took = this.addAmmo(item.id, item.amount);
    if (took <= 0) return;
    if (took < item.amount) {
      item.amount -= took;
      this.game.events.emit("message", { text: `${took} rounds`, seconds: 2 });
      this.sound("pickup");
      return;
    }
    const weapon = [...this.data.weapons.values()].find((w) => this.ammoIdOf(w) === item.id && this.carried.has(w.id));
    this.picked(e, weapon ? `${displayName(weapon)} ammo` : "Ammo", took, "pickup");
  }

  private picked(e: PickupEntity, what: string, amount: number, sound: string) {
    this.pickups.remove(e);
    this.sound(sound);
    this.game.events.emit("pickup", { ownerId: this.playerId, item: e.item.id, amount });
    this.game.events.emit("message", { text: amount > 1 ? `${what} (${amount})` : what, seconds: 2 });
  }

  /** Dead soldiers drop their gun where they fall. */
  private onDeath(entityId: number) {
    const e = this.game.entities.get(entityId);
    if (!e || entityId === this.playerId) return;
    const ids = this.loadouts.get(entityId) ?? (e.taskId !== undefined ? this.taskLoadouts.get(e.taskId)?.weapons.map((w) => w.id) : undefined) ?? [];
    this.loadouts.delete(entityId);
    const gun = ids.map((id) => this.spec(id)).find((s) => s && FIREARMS.has(s.type));
    if (!gun) return;
    const ground = this.game.services.physics?.groundHeight(e.position[0], e.position[1], e.position[2] + METRE) ?? e.position[2];
    const at: Vec3 = [e.position[0] + rand(-0.4, 0.4) * METRE, e.position[1] + rand(-0.4, 0.4) * METRE, ground + 0.05 * METRE];
    this.pickups.add({ kind: "weapon", id: gun.id, amount: gun.clipSize }, at, [0, Math.PI / 2, rand(0, Math.PI * 2)]);
  }

  // ------------------------------------------------------------------------------------------------------ sounds

  private sound(name: string, at?: Vec3, range = GUNSHOT_RANGE, volume = 1): SoundHandle | null {
    const audio = this.game.services.audio;
    if (!audio || !name) return null;
    const opts = { at, range, volume };
    return audio.play(`common/sounds/${name}.wav`, opts) ?? audio.play(`common/sounds/${name}.wav.wav`, opts);
  }

  /** Fire sound: a single shot, or the weapon's loop held while it keeps firing and its tail when it stops. */
  private shotSound(ownerId: number, spec: WeaponSpec, origin: Vec3) {
    const at = ownerId === this.playerId ? undefined : origin;
    const range = spec.id === "WEAPON_ID_DRAGUNOV" ? 100 * METRE : GUNSHOT_RANGE;
    if (!isLoopSound(spec.fireSound)) {
      const alt = spec.fireSoundEnd && spec.fireSoundEnd !== spec.fireSound && Math.random() < 0.5;
      this.sound(alt ? spec.fireSoundEnd : spec.fireSound, at, range);
      return;
    }
    const interval = 60 / Math.max(1, spec.roundsPerMinute);
    let s = this.shooters.get(ownerId);
    if (s && s.spec !== spec) {
      this.stopLoop(ownerId);
      s = undefined;
    }
    if (!s) {
      s = { handle: this.sound(spec.fireSound, at, range), spec, until: 0, at };
      // Loop only if the audio system played it; a missing loop still gets its tail.
      if (s.handle) {
        s.handle.stop();
        s.handle = this.game.services.audio?.play(`common/sounds/${spec.fireSound}.wav`, { at, range, loop: true }) ?? null;
      }
      this.shooters.set(ownerId, s);
    }
    s.at = at;
    if (at) s.handle?.setPosition(at);
    s.until = this.game.time + interval * 1.6;
  }

  private stopLoop(ownerId: number) {
    const s = this.shooters.get(ownerId);
    if (!s) return;
    s.handle?.stop();
    this.sound(s.spec.fireSoundEnd, s.at, s.spec.id === "WEAPON_ID_DRAGUNOV" ? 100 * METRE : GUNSHOT_RANGE);
    this.shooters.delete(ownerId);
  }

  /** Numbered sound parts that exist, e.g. "ak47_reload" → ak47_reload_1..3. */
  private reloadSounds(base: string): string[] {
    const list = new Set(this.game.services.audio?.list().map((p) => p.toLowerCase()) ?? []);
    const out: string[] = [];
    for (let i = 1; i <= 9; i++) {
      const name = `${base}_${i}`;
      if (list.size ? list.has(`common/sounds/${name}.wav`) : i <= (RELOAD_PARTS[base] ?? 0)) out.push(name);
    }
    return out;
  }

  /** Bullet impact sound by the physics surface material (material/material.qvm names). */
  private impactSound(point: Vec3, material?: string) {
    const family = IMPACT_SOUNDS[(material ?? "").toLowerCase()] ?? "concrete";
    this.sound(`bul_${family}_${1 + Math.floor(Math.random() * (IMPACT_PARTS[family] ?? 1))}`, point, 25 * METRE, 0.8);
    const hard = family === "concrete" || family.startsWith("metal") || family === "asphalt";
    if (hard && Math.random() < 0.15) this.sound(`riccochet_${1 + Math.floor(Math.random() * 5)}`, point, 40 * METRE, 0.6);
  }

  // ----------------------------------------------------------------------------------------- the player's weapon

  /** Highest-slot firearm carried, else anything. */
  private bestWeapon(): string | null {
    const order = this.data.player.cycle;
    const list = [...this.carried.values()].filter((c) => c.spec.type !== "BINOCULAR");
    list.sort((a, b) => order.indexOf(b.spec.id) - order.indexOf(a.spec.id));
    return (list.find((c) => FIREARMS.has(c.spec.type)) ?? list[0])?.spec.id ?? null;
  }

  /** Lower the weapon in hand (if any) and raise another. */
  private raise(weaponId: string | null, animate: boolean) {
    const vm = this.viewModel;
    this.cancel("reload");
    this.setZoom(null);
    this.stopLoop(this.playerId);
    const swap = () => {
      this.held = weaponId;
      const spec = weaponId ? this.spec(weaponId) : undefined;
      vm?.setWeapon(spec ?? null);
      vm?.lower(false, 0.3);
      this.state = "switching";
      this.after(0.3, () => (this.state = "ready"), "switch");
      this.game.events.emit("weapon:switch", { ownerId: this.playerId, weapon: weaponId });
      if (animate && weaponId) this.sound("new_gun");
    };
    this.cancel("switch");
    if (animate && vm && this.held && vm.lowered < 0.99) {
      this.state = "switching";
      vm.lower(true, 0.2);
      this.after(0.2, swap, "switch");
    } else swap();
  }

  private cycle(step: number) {
    const order = this.data.player.cycle.filter((id) => this.carried.has(id) && this.usable(id));
    if (!order.length) return;
    const at = this.held ? order.indexOf(this.held) : -1;
    const next = order[(at + step + order.length * 2) % order.length];
    if (next !== this.held) this.select(next);
  }

  /** IGI lets you select any weapon, but thrown ones need something to throw. */
  private usable(id: string): boolean {
    const c = this.carried.get(id)!;
    if (!THROWN.has(c.spec.type)) return true;
    const ammoId = this.ammoIdOf(c.spec);
    return c.clip > 0 || (ammoId ? (this.reserve.get(ammoId) ?? 0) > 0 : false);
  }

  /** Slot key: cycle through the carried weapons of that category. */
  private slot(index: number) {
    const ids = (this.data.player.slots[index] ?? []).filter((id) => this.carried.has(id) && this.usable(id));
    if (!ids.length) return;
    const at = this.held ? ids.indexOf(this.held) : -1;
    this.select(ids[(at + 1) % ids.length]);
  }

  private reload() {
    if (!this.held || this.state !== "ready") return;
    const c = this.carried.get(this.held)!;
    const spec = c.spec;
    const ammoId = this.ammoIdOf(spec);
    const reserve = ammoId ? (this.reserve.get(ammoId) ?? 0) : 0;
    if (spec.clipSize <= 0 || c.clip >= spec.clipSize || reserve <= 0 || THROWN.has(spec.type) || spec.type === "MEDIPACK") return;
    this.setZoom(null);
    this.stopLoop(this.playerId);
    this.state = "reloading";
    this.game.events.emit("weapon:reload", { ownerId: this.playerId, weapon: spec.id });
    const vm = this.viewModel;
    // The Spas 12 loads shell by shell: one short reload animation per shell, interruptible by firing.
    const perShell = spec.ammoDisplay === "SHELL";
    const seconds = (vm?.duration(spec.anims.reload) || spec.reloadTime) as number;
    const finish = () => {
      if (this.state !== "reloading" || this.held !== spec.id) return;
      const have = this.reserve.get(ammoId!) ?? 0;
      const take = Math.min(perShell ? 1 : spec.clipSize - c.clip, have);
      c.clip += take;
      this.reserve.set(ammoId!, have - take);
      this.state = "ready";
      if (perShell && c.clip < spec.clipSize && have - take > 0 && !this.game.input.isDown("fire")) this.reload();
    };
    const prefix = RELOAD_SOUNDS[spec.id];
    const parts = prefix ? this.reloadSounds(perShell ? "spas12_bulins" : `${prefix}_reload`) : [];
    if (perShell && parts.length) this.after(seconds * 0.4, () => this.sound(parts[Math.floor(Math.random() * parts.length)]), "reload");
    else parts.forEach((p, i) => this.after(seconds * (0.1 + (0.75 * i) / Math.max(1, parts.length - 1)), () => this.sound(p), "reload"));
    if (!vm || !vm.play(spec.anims.reload, { onEnd: finish })) {
      // No reload animation (LAW 80): lower, reload, raise.
      vm?.lower(true, 0.3);
      this.after(spec.reloadTime, () => {
        vm?.lower(false, 0.3);
        finish();
      }, "reload");
    }
  }

  private setBinoculars(on: boolean) {
    if (on === this.binoculars) return;
    const bin = [...this.carried.values()].find((c) => c.spec.type === "BINOCULAR");
    if (on && !bin) return;
    this.cancel("reload");
    this.stopLoop(this.playerId);
    this.binoculars = on;
    if (on && bin) {
      const x = extras(this.data, bin.spec);
      // The data's default (70) and max (90) are wider than IGI's 46.8° view, so start at 3x and keep zooming in.
      this.setZoom("binoculars", Math.min(x.defaultFov ?? 70, this.zoomBase() / 3));
      this.sound("bin_zoom_1");
    } else {
      this.setZoom(null);
      if (this.state === "reloading") this.state = "ready";
    }
    this.game.events.emit("weapon:switch", { ownerId: this.playerId, weapon: on ? (bin?.spec.id ?? null) : this.held });
  }

  /** Change the zoom view: FOV via PlayerService.fov, mouse sensitivity scaled to match, overlay, event. */
  private setZoom(kind: ZoomKind, fov = this.baseFov) {
    const player = this.game.services.player;
    const input = this.game.input;
    if (!player) return;
    if (!this.zoomKind && kind) {
      this.baseFov = player.defaultFov ?? player.fov;
      this.baseSensitivity = input.sensitivity;
    }
    if (!kind && !this.zoomKind) return;
    this.zoomKind = kind;
    this.zoomFov = kind ? fov : this.baseFov;
    player.fov = this.zoomFov;
    input.sensitivity = this.baseSensitivity * (kind ? Math.tan(deg(this.zoomFov) / 2) / Math.tan(deg(this.baseFov) / 2) : 1);
    if (this.viewModel) this.viewModel.hidden = kind === "binoculars" || kind === "scope";
    if (this.drawOverlay && kind) this.overlay.show(kind, this.zoomFov, this.baseFov);
    else this.overlay.hide();
    // The HUD (src/game/hud/api.ts) draws the optics from this; a plain zoom (MP5SD) has no overlay.
    const zoom = Math.tan(deg(this.baseFov) / 2) / Math.tan(deg(this.zoomFov) / 2);
    this.game.events.emit("weapon:zoom", { mode: kind === "binoculars" || kind === "scope" ? kind : "none", zoom: kind ? zoom : 1 });
  }

  private zoomBase(): number {
    return this.zoomKind ? this.baseFov : (this.game.services.player?.defaultFov ?? 46.8);
  }

  /** Zoom in (factor < 1) or out within the current zoom's limits. */
  private zoomBy(factor: number) {
    if (!this.zoomKind) return;
    const [min, max] = this.zoomLimits();
    const fov = Math.min(max, Math.max(min, this.zoomFov * factor));
    if (Math.abs(fov - this.zoomFov) < 1e-3) return;
    this.setZoom(this.zoomKind, fov);
    if (this.game.time - this.lastZoomSound > 0.25) {
      this.sound(this.zoomKind === "binoculars" ? "bin_zoom_1" : "zoom_01", undefined, GUNSHOT_RANGE, 0.6);
      this.lastZoomSound = this.game.time;
    }
  }

  private zoomLimits(): [number, number] {
    if (this.zoomKind === "binoculars") {
      const bin = [...this.carried.values()].find((c) => c.spec.type === "BINOCULAR");
      const x = bin ? extras(this.data, bin.spec) : {};
      return [x.minFov ?? 5, Math.min(x.maxFov ?? 90, this.zoomBase())];
    }
    const spec = this.held ? this.spec(this.held) : undefined;
    const min = spec ? (extras(this.data, spec).zoomMinFov ?? 30) : 30;
    return this.zoomKind === "scope" ? [min, 30] : [min, this.baseFov];
  }

  /** Right mouse: the Dragunov's scope or the MP5SD's zoom. */
  private toggleAim() {
    const spec = this.held ? this.spec(this.held) : undefined;
    if (!spec || this.state !== "ready") return;
    const min = extras(this.data, spec).zoomMinFov;
    if (min === undefined) return;
    if (this.zoomKind) {
      this.setZoom(null);
      return;
    }
    if (spec.task === "GUNDRAGUNOV") this.setZoom("scope", Math.max(min, 15));
    else this.setZoom("zoom", min);
    this.sound("zoom_01", undefined, GUNSHOT_RANGE, 0.6);
  }

  private playerFire(spec: WeaponSpec, c: Carried) {
    const player = this.game.services.player!;
    const eye = player.eye();
    const look = direction(player.yaw, player.pitch);
    const vm = this.viewModel;
    const fireAnim = spec.anims.fire[Math.floor(Math.random() * spec.anims.fire.length)] ?? -1;
    const interval = 60 / Math.max(1, spec.roundsPerMinute);
    this.nextShot = this.game.time + interval;
    this.burst++;

    if (spec.type === "MEDIPACK") {
      const e = player.entity;
      if (c.clip <= 0 || e.health >= e.maxHealth || player.dead) return;
      c.clip--;
      const heal = (extras(this.data, spec).healPerRound ?? 0.01) * e.maxHealth;
      player.heal(heal);
      if (this.burst === 1) {
        this.sound("syringe");
        vm?.play(fireAnim, { loop: false });
      }
      this.refillThrown(c);
      return;
    }
    if (spec.type === "KNIFE") {
      this.state = "stabbing";
      vm?.play(fireAnim);
      const reachAt = Math.max(0.15, (vm?.duration(fireAnim) ?? 0.4) * 0.35);
      this.after(reachAt, () => this.stab(this.playerId, spec, player.eye(), direction(player.yaw, player.pitch), 1));
      this.after(Math.max(interval, (vm?.duration(fireAnim) ?? 0.4) * 0.8), () => (this.state = "ready"));
      return;
    }
    if (THROWN.has(spec.type)) {
      if (c.clip <= 0) return;
      this.state = "throwing";
      const anim = spec.anims.fire[0] ?? -1;
      const release = () => {
        if (this.held !== spec.id) return;
        c.clip--;
        const p = this.game.services.player!;
        const from = vec3.add(p.eye(), vec3.scale(direction(p.yaw - Math.PI / 2), 0.2 * METRE));
        const forward = spec.type === "PROXIMITYMINE" ? vec3.add(p.entity.position, vec3.scale(direction(p.yaw), 0.6 * METRE)) : from;
        this.launch(this.playerId, spec, spec.type === "PROXIMITYMINE" ? [forward[0], forward[1], forward[2] + 0.5 * METRE] : from, direction(p.yaw, p.pitch));
        const refilled = this.refillThrown(c);
        const next = spec.anims.fire[1];
        const done = () => {
          this.state = "ready";
          if (!refilled) this.raise(this.bestWeapon(), true);
        };
        if (next !== undefined && next >= 0 && vm?.play(next, { onEnd: done })) return;
        this.after(0.4, done);
      };
      if (!vm || !vm.play(anim, { onEnd: release })) release();
      return;
    }

    if (c.clip <= 0) return;
    c.clip--;
    vm?.play(fireAnim);
    vm?.muzzleFlash();
    vm?.fireKick(0.4 + spec.kick.fixedX * 0.3);
    const muzzle = vm ? this.game.fromScene(vm.muzzleWorld(this.game.camera)) : eye;
    if (!spec.detection.includes("SILENCED")) this.effects.light(muzzle, 0xffc070, 2.5, 5 * METRE, 0.05);
    if (spec.projectile === "MISSILE") {
      this.launch(this.playerId, spec, vec3.add(eye, vec3.scale(look, 0.8 * METRE)), look);
    } else {
      this.shotSound(this.playerId, spec, eye);
      this.shoot(this.playerId, spec, eye, look, { spreadScale: GAIT_SPREAD[player.gait] ?? 1 }, true);
    }
    // View kick (degrees about X = pitch up, about Z = yaw), fixed plus random.
    player.pitch = Math.min(1.5, player.pitch + deg(spec.kick.fixedX + rand(-1, 1) * spec.kick.randomX));
    player.yaw += deg(spec.kick.fixedZ + rand(-1, 1) * spec.kick.randomZ);
    if (c.clip === 0) this.stopLoop(this.playerId);
  }

  /** After throwing or using up a medipack round: take the next one from the reserve. */
  private refillThrown(c: Carried): boolean {
    if (c.clip > 0) return true;
    const ammoId = this.ammoIdOf(c.spec);
    const have = ammoId ? (this.reserve.get(ammoId) ?? 0) : 0;
    const take = Math.min(have, Math.max(1, c.spec.clipSize));
    if (take <= 0) return false;
    c.clip = take;
    this.reserve.set(ammoId!, have - take);
    return true;
  }

  // ----------------------------------------------------------------------------------------------------- frames

  private after(seconds: number, fn: () => void, tag?: string) {
    this.timers.push({ at: this.game.time + seconds, fn, tag });
  }

  private cancel(tag: string) {
    this.timers = this.timers.filter((t) => t.tag !== tag);
    if (tag === "reload" && this.state === "reloading") {
      this.state = "ready";
      this.viewModel?.lower(false, 0.2);
    }
  }

  update(dt: number, game: Game) {
    for (const t of this.timers.filter((t) => t.at <= game.time)) {
      this.timers.splice(this.timers.indexOf(t), 1);
      t.fn();
    }
    const player = game.services.player;
    if (player && !player.frozen && !player.dead) this.handleInput(game);
    else this.triggerUp = true;

    // Sound loops of shooters that stopped firing.
    for (const [id, s] of this.shooters) if (game.time > s.until) this.stopLoop(id);
    if (player && !game.input.isDown("fire") && this.shooters.has(this.playerId)) this.stopLoop(this.playerId);

    // Walking over pickups.
    if (player && !player.dead) for (const e of this.pickups.near(player.entity.position)) this.collect(e);

    this.projectiles.update(dt);
    this.pickups.update(dt);
    this.effects.update(dt);
    this.overlay.update(dt);

    this.moving = !!player && ["walk", "run", "crouch", "crawl"].includes(player.gait) && Math.hypot(player.velocity[0], player.velocity[1]) > 0.5 * METRE;
  }

  private handleInput(game: Game) {
    const input = game.input;
    if (input.wasPressed("binoculars")) this.setBinoculars(!this.binoculars);

    if (this.binoculars) {
      // Wheel or fire/aim held zoom the binoculars; weapon keys put them away.
      if (input.wasPressed("prevWeapon")) this.zoomBy(1 / 1.3);
      if (input.wasPressed("nextWeapon")) this.zoomBy(1.3);
      if (input.isDown("fire")) this.zoomBy(Math.pow(0.4, 1 / 60));
      if (input.isDown("aim")) this.zoomBy(Math.pow(2.5, 1 / 60));
      SLOT_KEYS.forEach((k, i) => input.wasPressed(k) && (this.setBinoculars(false), this.slot(i)));
      return;
    }

    SLOT_KEYS.forEach((k, i) => input.wasPressed(k) && this.slot(i));
    if (this.zoomKind === "scope") {
      if (input.wasPressed("prevWeapon")) this.zoomBy(1 / 1.4);
      if (input.wasPressed("nextWeapon")) this.zoomBy(1.4);
    } else {
      if (input.wasPressed("nextWeapon")) this.cycle(1);
      if (input.wasPressed("prevWeapon")) this.cycle(-1);
    }
    if (input.wasPressed("aim")) this.toggleAim();
    if (input.wasPressed("reload")) this.reload();

    const held = this.held ? this.carried.get(this.held) : undefined;
    const fireDown = input.isDown("fire");
    if (!fireDown) {
      this.triggerUp = true;
      this.burst = 0;
    }
    if (!held || !fireDown) return;
    const spec = held.spec;
    // Firing interrupts a shell-by-shell reload.
    if (this.state === "reloading" && spec.ammoDisplay === "SHELL" && held.clip > 0) this.cancel("reload");
    if (this.state !== "ready" || game.time < this.nextShot) return;
    const auto = spec.maxBurst > 1 || spec.type === "MEDIPACK";
    if (!auto && !this.triggerUp) return;
    if (auto && spec.maxBurst > 1 && this.burst >= spec.maxBurst) return;
    const usesClip = FIREARMS.has(spec.type);
    if (usesClip && held.clip <= 0) {
      if (this.triggerUp) {
        this.sound("guns_dry_1");
        this.reload();
      }
      this.triggerUp = false;
      return;
    }
    this.triggerUp = false;
    this.playerFire(spec, held);
  }

  lateUpdate(dt: number, game: Game) {
    const vm = this.viewModel;
    if (!vm) return;
    game.camera.updateMatrixWorld();
    const look = game.input.look();
    vm.update(dt, game.camera, { moving: this.moving, lookYaw: look.yaw, lookPitch: look.pitch });
    const player = game.services.player;
    if (player && (player.thirdPerson || player.dead)) vm.root.visible = false;
  }
}

/** A direction randomly deviated by up to `amplitude` radians (uniform over the disc). */
function jitter(dir: Vec3, amplitude: number): Vec3 {
  if (amplitude <= 0) return dir;
  const r = amplitude * Math.sqrt(Math.random());
  const a = Math.random() * Math.PI * 2;
  const up: Vec3 = Math.abs(dir[2]) > 0.95 ? [1, 0, 0] : [0, 0, 1];
  const right = vec3.normalize(cross(dir, up));
  const up2 = cross(right, dir);
  return vec3.normalize(vec3.add(dir, vec3.add(vec3.scale(right, Math.tan(r) * Math.cos(a)), vec3.scale(up2, Math.tan(r) * Math.sin(a)))));
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
