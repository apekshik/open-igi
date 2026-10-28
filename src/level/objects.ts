// Turn a level's objects.qvm task tree into placed models.
//
// Every object is Task_New(id, type, name, ...params, ...children). Parameter layouts come from the script's own
// Task_DeclareParameters calls, or (for engine-defined types like EditRigidObj) from observation. See docs/FORMATS.md.

import type { QvmCall, QvmValue } from "../formats/qvm.ts";

export interface Placement {
  type: string;
  name: string;
  id: number;
  /** World position, IGI units (Z up, 4096 units per metre). */
  position: [number, number, number];
  /** Euler angles in radians, as stored (third is rotation about Z). */
  rotation: [number, number, number];
  model: string;
}

export interface HeightMapTask {
  position: [number, number, number];
  /** Octree level of the cube the patch covers. */
  level: number;
  size: number;
  /** Slot in terrain.hmp. */
  id: number;
}

export interface LevelObjects {
  placements: Placement[];
  heightMaps: HeightMapTask[];
  /** Position of the HumanPlayer task, if found. */
  playerStart: [number, number, number] | null;
  /** Count of every task type in the tree, for research. */
  typeCounts: Map<string, number>;
}

// Types whose params start (x, y, z, a, b, c, model).
const POSE_THEN_MODEL = new Set(["Building", "EditRigidObj"]);

export function levelObjects(statements: QvmCall[]): LevelObjects {
  const placements: Placement[] = [];
  const heightMaps: HeightMapTask[] = [];
  const typeCounts = new Map<string, number>();
  let playerStart: [number, number, number] | null = null;

  const num = (v: QvmValue | undefined) => (typeof v === "number" ? v : NaN);

  function visit(task: QvmCall) {
    if (task.fn !== "Task_New") return;
    const [id, type, name, ...rest] = task.args;
    const t = String(type);
    typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
    const p = rest.map(num);

    if (POSE_THEN_MODEL.has(t) && typeof rest[6] === "string") {
      placements.push({
        type: t,
        name: String(name),
        id: num(id),
        position: [p[0], p[1], p[2]],
        rotation: [p[3], p[4], p[5]],
        model: rest[6],
      });
    } else if (t === "Fence" && typeof rest[4] === "string") {
      // Fence: position, gamma angle, model.
      placements.push({ type: t, name: String(name), id: num(id), position: [p[0], p[1], p[2]], rotation: [0, 0, p[3]], model: rest[4] });
    } else if (t === "HeightMap") {
      // HeightMap: position, level, size, isEdit, bitmap id, normal smooth, blur smooth.
      heightMaps.push({ position: [p[0], p[1], p[2]], level: p[3], size: p[4], id: p[6] });
    } else if (t === "HumanPlayer" && playerStart === null) {
      // HumanPlayer: position, gamma, model, team. Mission 1 names it "TheGoodGuy".
      playerStart = [p[0], p[1], p[2]];
    }

    for (const child of rest) if (isCall(child)) visit(child);
  }

  for (const s of statements) visit(s);
  return { placements, heightMaps, playerStart, typeCounts };
}

function isCall(v: QvmValue): v is QvmCall {
  return typeof v === "object" && "fn" in v;
}
