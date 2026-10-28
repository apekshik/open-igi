// Weapons and ammo lying in the level: objects.qvm GunPickup / AmmoPickup tasks, and guns dropped by dead soldiers.
// Each is an entity of kind "pickup" (radius 0, so bullets pass through) with the item's own model. Jones takes them
// by walking over them. Also reads the weapon loadouts that tasks carry as children (Gun, GunMP5SD, GunDRAGUNOV,
// Binocular, AddAmmo), which is how HumanPlayer gets its starting kit and soldiers their guns.
import * as THREE from "three";
import type { QvmCall, QvmValue } from "../../formats/qvm.ts";
import { METRE, type Vec3 } from "../coords.ts";
import type { Entity } from "../entity.ts";
import type { Game } from "../game.ts";

export interface PickupItem {
  /** "weapon" gives the gun (and a clip); "ammo" adds rounds. */
  kind: "weapon" | "ammo";
  /** WEAPON_ID_* or AMMO_ID_*. */
  id: string;
  /** Rounds (ammo pickups, dropped guns); -1 = the weapon's default. */
  amount: number;
}

export type PickupEntity = Entity & { item: PickupItem; spin: boolean };

export interface Loadout {
  weapons: { id: string; slot: number }[];
  ammo: { id: string; rounds: number }[];
}

const isCall = (v: QvmValue): v is QvmCall => typeof v === "object" && "fn" in v;
const str = (v: QvmValue | undefined) => (typeof v === "string" ? v : typeof v === "object" && v && "ident" in v ? v.ident : "");
const num = (v: QvmValue | undefined) => (typeof v === "number" ? v : 0);

/** Every Task_New in the tree with its parameters (after id, type, name) and its child tasks. */
export function* tasks(statements: QvmCall[]): Generator<{ id: number; type: string; params: QvmValue[]; children: QvmCall[] }> {
  const stack = [...statements].reverse();
  while (stack.length) {
    const t = stack.pop()!;
    if (t.fn !== "Task_New") continue;
    const [id, type, , ...rest] = t.args;
    const children = rest.filter(isCall).filter((c) => c.fn === "Task_New");
    yield { id: num(id), type: String(type), params: rest.filter((v) => !isCall(v)), children };
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
}

/** Weapons and ammo a task carries as child tasks. */
export function loadoutOf(children: QvmCall[]): Loadout {
  const out: Loadout = { weapons: [], ammo: [] };
  for (const c of children) {
    const [, type, , a, b] = c.args;
    const t = String(type);
    if ((t.startsWith("Gun") && t !== "GunPickup") || t === "Binocular") out.weapons.push({ id: str(a), slot: num(b) });
    else if (t === "AddAmmo") out.ammo.push({ id: str(a), rounds: num(b) });
  }
  return out;
}

export class Pickups {
  private game: Game;
  readonly list: PickupEntity[] = [];
  private modelFor: (item: PickupItem) => string;

  constructor(game: Game, modelFor: (item: PickupItem) => string) {
    this.game = game;
    this.modelFor = modelFor;
  }

  /** Create the level's GunPickup and AmmoPickup entities. */
  fromLevel() {
    for (const t of tasks(this.game.level.statements)) {
      if (t.type !== "GunPickup" && t.type !== "AmmoPickup") continue;
      const p = t.params.map(num);
      const id = str(t.params[6]);
      if (!id) continue;
      const item: PickupItem = t.type === "GunPickup" ? { kind: "weapon", id, amount: -1 } : { kind: "ammo", id, amount: num(t.params[7]) };
      this.add(item, [p[0], p[1], p[2]], [p[3], p[4], p[5]], t.id >= 0 ? t.id : undefined, false);
    }
  }

  add(item: PickupItem, position: Vec3, rotation: Vec3, taskId?: number, spin = false): PickupEntity | null {
    const built = this.game.level.library.build(this.modelFor(item));
    let object: THREE.Object3D;
    if (built) {
      object = new THREE.Mesh(built.geometry, built.materials);
    } else {
      // Unknown model: a small crate so the pickup is still visible.
      object = new THREE.Mesh(new THREE.BoxGeometry(0.3 * METRE, 0.3 * METRE, 0.15 * METRE), new THREE.MeshLambertMaterial({ color: 0x556644 }));
    }
    object.position.copy(this.game.local(position));
    object.rotation.set(rotation[0], rotation[1], rotation[2], "ZYX");
    this.game.world.add(object);
    const e = this.game.entities.create({
      kind: "pickup",
      position: [...position] as Vec3,
      yaw: rotation[2],
      health: 1,
      maxHealth: 1,
      team: -1,
      alive: true,
      radius: 0,
      height: 0,
      object,
      taskId,
      item,
      spin,
    });
    this.list.push(e);
    return e;
  }

  remove(e: PickupEntity) {
    this.game.world.remove(e.object!);
    this.game.entities.remove(e.id);
    this.list.splice(this.list.indexOf(e), 1);
  }

  /** Pickups within reach of feet position `at`. */
  near(at: Vec3, reach = 1.1 * METRE): PickupEntity[] {
    return this.list.filter((e) => {
      const dx = e.position[0] - at[0], dy = e.position[1] - at[1], dz = e.position[2] - at[2];
      return dx * dx + dy * dy < reach * reach && dz > -0.6 * METRE && dz < 2 * METRE;
    });
  }

  update(dt: number) {
    for (const e of this.list) if (e.spin && e.object) e.object.rotation.z += dt * 0.8;
  }
}
