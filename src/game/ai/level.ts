// AI data from a level's objects.qvm task tree: the characters (HumanSoldier with its HumanAI, weapons and patrol
// paths), the AIGraph tasks that anchor the navigation graphs, and the alarm panels soldiers run to.
//
// Parameter layouts (each type's Task_DeclareParameters call in objects.qvm):
//   HumanSoldier  Position(xyz), Gamma, Model, Team, Bone Heirachy, Stand Animation; children: Gun*/Binocular (weapon
//                 id, slot), HumanAI, PatrolPath...
//   HumanAI       AI Type ("AITYPE_PATROL_AK"), Graph ID (an AIGraph task id; graphs/graph<id>.dat)
//   PatrolPath    no parameters; children PatrolPathCommand(Command, Command Parameter), see patrol.ts
//   AIGraph       Graph position (xyz), ...
//   AlarmControl  Position (xyz), Orientation (9), Model, ...
//   StationaryGun Position (xyz), Orientation (stored as 3 angles; the third is the heading), Holder model, Weapon ID,
//                 Max up angle, Max down angle, Max sideways angle (degrees), Ammo (-1 = unlimited)
import type { QvmCall, QvmValue } from "../../formats/qvm.ts";
import type { Vec3 } from "../coords.ts";

export interface PatrolCommand {
  command: number;
  param: number;
  /** The editor's note, e.g. "Walks to node id 63". */
  note: string;
}

export interface CharacterSpec {
  /** HumanSoldier task id (-1 for some cutscene extras). */
  taskId: number;
  name: string;
  position: Vec3;
  gamma: number;
  model: string;
  team: number;
  /** Selects common/anims/<NNN>.iff. */
  hierarchy: number;
  /** Clip played while idle, or -1 for the AI type's default. */
  standAnimation: number;
  /** HumanAI task id: its script is missions/.../ai/<id>.qvm. */
  aiId: number;
  aiType: string;
  graphId: number;
  weapons: string[];
  /** PatrolPath task id → commands. */
  patrols: Map<number, PatrolCommand[]>;
  /** Placed inside a cutscene or vehicle (not spawned with the level's soldiers). */
  scripted: boolean;
  /**
   * Part of an intro or outro cutscene (inside a ConditionalContainer named as one): an actor that plays its scripted
   * animations and patrols while its containers run, without senses or fighting.
   */
  cutscene: boolean;
  /** The vehicle task type it rides in ("Heli", "Car", "Train", "AnimTask"), if any. */
  vehicle?: string;
  /**
   * Ids of the ConditionalContainer tasks around it: in IGI a container's subtree only exists while it runs, so
   * the character enters play when all of them run (e.g. level 1's guards once the intro cutscene ends).
   */
  gates: number[];
  /** Set when the character is a GuardGenerator's template: copies spawn while the condition holds. */
  generator?: { taskId: number; condition: string; maxSpawns: number };
}

export interface AiLevelData {
  characters: CharacterSpec[];
  /** AIGraph task id → graph origin. */
  graphs: Map<number, Vec3>;
  /** AlarmControl task id → position. */
  alarms: Map<number, Vec3>;
  /** Every task's position by id (for scripts that refer to tasks: Activate, FireAtTask). */
  taskPositions: Map<number, Vec3>;
  /** StationaryGun tasks by id (mounted machine guns that gunners man: AIFunction_SetGunnerID). */
  guns: Map<number, StationaryGunSpec>;
}

export interface StationaryGunSpec {
  taskId: number;
  position: Vec3;
  /** Heading of the gun's rest direction (radians about Z). */
  yaw: number;
  holderModel: string;
  weapon: string;
  /** Traverse limits in degrees: up, down (negative) and sideways either side of the rest direction. */
  maxUp: number;
  maxDown: number;
  maxSide: number;
  /** Rounds, or -1 for unlimited. */
  ammo: number;
}

// Characters inside these are part of cutscenes or ride vehicles; the mission system drives those.
const SCRIPTED_PARENTS = new Set(["CutScene", "Heli", "Car", "Train", "AnimTask"]);

const isCall = (v: QvmValue): v is QvmCall => typeof v === "object" && v !== null && "fn" in v;
const num = (v: QvmValue | undefined) => (typeof v === "number" ? v : NaN);

export function aiLevelData(statements: QvmCall[]): AiLevelData {
  const characters: CharacterSpec[] = [];
  const graphs = new Map<number, Vec3>();
  const alarms = new Map<number, Vec3>();
  const taskPositions = new Map<number, Vec3>();
  const guns = new Map<number, StationaryGunSpec>();
  // Patrol paths outside any soldier (level4 keeps its friendly team's routes in a shared "Patrol Paths" container).
  const sharedPatrols = new Map<number, PatrolCommand[]>();

  function visit(task: QvmCall, scripted: boolean, gates: number[], generator?: CharacterSpec["generator"], vehicle?: string, inCutscene = false) {
    if (task.fn !== "Task_New") return;
    const [id, type, name, ...rest] = task.args;
    const t = String(type);
    const tid = num(id);
    const params = rest.filter((v) => !isCall(v));
    const children = rest.filter(isCall);
    if (tid >= 0 && typeof params[0] === "number" && typeof params[1] === "number" && typeof params[2] === "number") {
      taskPositions.set(tid, [params[0], params[1], params[2]]);
    }
    if (t === "AIGraph") graphs.set(tid, [num(params[0]), num(params[1]), num(params[2])]);
    else if (t === "AlarmControl") alarms.set(tid, [num(params[0]), num(params[1]), num(params[2])]);
    else if (t === "PatrolPath") sharedPatrols.set(tid, patrolCommands(children));
    else if (t === "StationaryGun" && tid >= 0) {
      guns.set(tid, {
        taskId: tid,
        position: [num(params[0]), num(params[1]), num(params[2])],
        yaw: num(params[5]) || 0,
        holderModel: String(params[6] ?? ""),
        weapon: String(params[7] ?? "WEAPON_ID_M2HB"),
        maxUp: num(params[8]) || 0,
        maxDown: num(params[9]) || 0,
        maxSide: Number.isFinite(num(params[10])) ? num(params[10]) : 180,
        ammo: Number.isFinite(num(params[11])) ? num(params[11]) : -1,
      });
    }
    // Ekk and Anya (level14) are HumanSoldierFemale tasks, with the same parameters as HumanSoldier.
    else if (t === "HumanSoldier" || t === "HumanSoldierFemale") {
      characters.push({ ...character(tid, String(name), params, children, scripted), gates, generator, vehicle, cutscene: inCutscene });
      return;
    }
    // Level 1 keeps its whole dynamic world in a container named "Cutscenes"; only the conditional cutscenes inside
    // count (level 3 spells one "Intro cutscnee").
    const cutscene = t === "ConditionalContainer" && /cuts*sc/i.test(String(name));
    const inside = scripted || SCRIPTED_PARENTS.has(t) || cutscene;
    const gated = t === "ConditionalContainer" && tid >= 0 ? [...gates, tid] : gates;
    const gen = t === "GuardGenerator" ? { taskId: tid, condition: String(params[0] ?? ""), maxSpawns: num(params[1]) || 1 } : generator;
    const ride = SCRIPTED_PARENTS.has(t) ? t : vehicle;
    for (const c of children) visit(c, inside, gated, gen, ride, inCutscene || cutscene);
  }

  for (const s of statements) visit(s, false, []);
  for (const c of characters) for (const [id, commands] of sharedPatrols) if (!c.patrols.has(id)) c.patrols.set(id, commands);
  return { characters, graphs, alarms, taskPositions, guns };
}

function patrolCommands(children: QvmCall[]): PatrolCommand[] {
  return children.map((cmd) => ({ command: num(cmd.args[3]), param: num(cmd.args[4]), note: String(cmd.args[2]) }));
}

function character(taskId: number, name: string, p: QvmValue[], children: QvmCall[], scripted: boolean): CharacterSpec {
  const spec: CharacterSpec = {
    gates: [],
    cutscene: false,
    taskId,
    name,
    position: [num(p[0]), num(p[1]), num(p[2])],
    gamma: num(p[3]) || 0,
    model: String(p[4]),
    team: num(p[5]) || 0,
    hierarchy: num(p[6]) || 0,
    standAnimation: Number.isFinite(num(p[7])) ? num(p[7]) : -1,
    aiId: -1,
    aiType: "AITYPE_PATROL_AK",
    graphId: -1,
    weapons: [],
    patrols: new Map(),
    scripted,
  };
  for (const c of children) {
    const [id, type, , ...rest] = c.args;
    const t = String(type);
    if (t === "HumanAI") {
      spec.aiId = num(id);
      spec.aiType = String(rest[0]);
      spec.graphId = num(rest[1]);
    } else if (t === "PatrolPath") {
      spec.patrols.set(num(id), patrolCommands(rest.filter(isCall)));
    } else if (/^(Gun|Binocular)/.test(t) && typeof rest[0] === "string") {
      spec.weapons.push(rest[0].trim());
    }
  }
  return spec;
}

/** HumanAIConfigItem parameters (common/ai/settings.qvm), one per AI type and difficulty ("GD_1".."GD_3"). */
export interface AiConfig {
  /** Scales the damage this soldier's weapon deals. */
  damageScale: number;
  recoilThreshold: number;
  /** Seconds before the first combat move, and between moves. */
  initialMoveDelay: number;
  moveDelay: number;
  /** Seconds without seeing the target before combat ends. */
  targetingTimeout: number;
  /** Metres; beyond this the soldier closes in. */
  trackingDistance: number;
  /** Metres; beyond this the soldier may lie down to fire. */
  lieDownDistance: number;
  evasiveProbability: number;
  evasiveStandRollOrLie: number;
  evasiveKneelRollOrLie: number;
  evasiveStandRollSide: number;
  evasiveKneelRollSide: number;
  hitProbabilityNear: number;
  hitProbabilityFar: number;
  maxRoundsPerBurst: number;
  aimPrecision: number;
  minClipFraction: number;
  randomClipFraction: number;
  minBurstDelay: number;
  randomBurstDelay: number;
  minShotDelay: number;
  randomShotDelay: number;
  grenadeProbability: number;
  grenadeOnReloadProbability: number;
  grenadeMinDistance: number;
  grenadeMaxDistance: number;
  grenadeMinFlyTime: number;
  grenadeRandomFlyTime: number;
  grenadeMinExplodeTime: number;
  grenadeRandomExplodeTime: number;
  closeCombatHitProbability: number;
  closeCombatDamage: number;
}

const CONFIG_FIELDS: (keyof AiConfig)[] = [
  "damageScale", "recoilThreshold", "initialMoveDelay", "moveDelay", "targetingTimeout", "trackingDistance",
  "lieDownDistance", "evasiveProbability", "evasiveStandRollOrLie", "evasiveKneelRollOrLie", "evasiveStandRollSide",
  "evasiveKneelRollSide", "hitProbabilityNear", "hitProbabilityFar", "maxRoundsPerBurst", "aimPrecision",
  "minClipFraction", "randomClipFraction", "minBurstDelay", "randomBurstDelay", "minShotDelay", "randomShotDelay",
  "grenadeProbability", "grenadeOnReloadProbability", "grenadeMinDistance", "grenadeMaxDistance", "grenadeMinFlyTime",
  "grenadeRandomFlyTime", "grenadeMinExplodeTime", "grenadeRandomExplodeTime", "closeCombatHitProbability",
  "closeCombatDamage",
];

/** Settings for when settings.qvm is missing a type: AITYPE_PATROL_AK, GD_2. */
export const DEFAULT_CONFIG: AiConfig = configFrom([
  0.5, 0.3, 0.33, 1, 15, 20, 15, 0.3, 0.5, 0.5, 0.5, 0.5, 1, 0.3, 30, 0.8, 0.2, 0.3, 0.5, 0.5, 0.1, 0, 0.33, 0.1, 10,
  60, 0.5, 0.5, 0.3, 0.7, 0.7, 0.3,
]);

function configFrom(values: number[]): AiConfig {
  const c = {} as AiConfig;
  CONFIG_FIELDS.forEach((f, i) => (c[f] = values[i] ?? 0));
  return c;
}

/** Parse settings.qvm into "AITYPE_X/GD_n" → config. */
export function aiConfigs(statements: QvmCall[]): Map<string, AiConfig> {
  const out = new Map<string, AiConfig>();
  for (const s of statements) {
    if (s.fn !== "Task_New" || s.args[1] !== "HumanAIConfigItem") continue;
    const [, , , type, difficulty, ...values] = s.args;
    out.set(`${type}/${difficulty}`, configFrom(values.map((v) => num(v))));
  }
  return out;
}

/** The common script an AI type falls back on (AIFunction_DefaultHandler): common/ai/<name>.qvm. */
export function commonScriptName(aiType: string): string {
  const t = aiType.replace(/^AITYPE_/, "");
  if (t.includes("GUARD")) return "guard";
  if (t.includes("PATROL")) return "patrol";
  return t.toLowerCase();
}
