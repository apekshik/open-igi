// Decode and check the collision sets of every model in every level (and the shared location0 archive).
// Usage: npm run collision -- <PC folder>   (e.g. the folder IGI_DATA points at)
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { checkCollisionMesh, decodeCollision, HUMAN_COLLISION_MATERIAL, type CollisionMesh } from "../src/formats/collision.ts";
import { parseIlff, readRes } from "../src/formats/ilff.ts";

const root = process.argv[2] ?? process.env.IGI_DATA;
if (!root) {
  console.error("usage: collision <PC folder>");
  process.exit(1);
}
const missions = join(root, "missions/location0");
const archives = readdirSync(missions)
  .flatMap((d) => [join(missions, d, "models", `${d}.res`), join(missions, d, "models", "location0.res")])
  .filter((p) => existsSync(p));

const seen = new Set<string>();
const byType = new Map<number, { models: number; hit: number; human: number; hitFaces: number; humanFaces: number }>();
const materials = new Map<string, number>();
const growth: number[] = [];
let problems = 0;
let headerMismatch = 0;

/** How far the human hull sticks out past the hit shape, per side (median of the four x/y bound differences). */
function hullGrowth(hit: CollisionMesh, human: CollisionMesh): number {
  const bounds = (m: CollisionMesh) => {
    const lo = [Infinity, Infinity];
    const hi = [-Infinity, -Infinity];
    for (let i = 0; i < m.vertices.length; i += 3)
      for (let k = 0; k < 2; k++) {
        lo[k] = Math.min(lo[k], m.vertices[i + k]);
        hi[k] = Math.max(hi[k], m.vertices[i + k]);
      }
    return { lo, hi };
  };
  const a = bounds(hit);
  const b = bounds(human);
  const d = [a.lo[0] - b.lo[0], a.lo[1] - b.lo[1], b.hi[0] - a.hi[0], b.hi[1] - a.hi[1]].sort((x, y) => x - y);
  return (d[1] + d[2]) / 2;
}

for (const path of archives) {
  for (const entry of readRes(new Uint8Array(readFileSync(path)))) {
    if (!entry.name.endsWith(".mef") || seen.has(entry.name)) continue;
    seen.add(entry.name);
    const file = parseIlff(entry.data);
    const mesh = file.chunks[0];
    const mv = new DataView(mesh.data.buffer, mesh.data.byteOffset, mesh.length);
    const type = mv.getUint32(32, true);
    const t = byType.get(type) ?? { models: 0, hit: 0, human: 0, hitFaces: 0, humanFaces: 0 };
    byType.set(type, t);
    t.models++;
    let c;
    try {
      c = decodeCollision(file);
    } catch (e) {
      problems++;
      console.log(`${entry.name}: ${(e as Error).message}`);
      continue;
    }
    const faces = (c.hit?.faceGroup.length ?? 0) + (c.human?.faceGroup.length ?? 0);
    const verts = ((c.hit?.vertices.length ?? 0) + (c.human?.vertices.length ?? 0)) / 3;
    if (mv.getUint32(0x6c, true) !== faces || mv.getUint32(0x70, true) !== verts) headerMismatch++;
    for (const [name, m] of [["hit", c.hit], ["human", c.human]] as const) {
      if (!m) continue;
      t[name]++;
      t[name === "hit" ? "hitFaces" : "humanFaces"] += m.faceGroup.length;
      for (const p of checkCollisionMesh(m)) {
        problems++;
        console.log(`${entry.name} ${name}: ${p}`);
      }
      for (let f = 0; f < m.faceGroup.length; f++) {
        const key = `${name}:${m.groups[m.faceGroup[f]].material}`;
        materials.set(key, (materials.get(key) ?? 0) + 1);
      }
    }
    if (c.human && c.human.groups.some((g) => g.material !== HUMAN_COLLISION_MATERIAL)) {
      console.log(`note: ${entry.name} human set has a group without material 21`);
    }
    if (c.human && !c.hit) console.log(`note: ${entry.name} has a human set but no hit set`);
    if (c.hit && c.human) growth.push(hullGrowth(c.hit, c.human));
  }
}

console.log(`${seen.size} models in ${archives.length} archives`);
for (const [type, t] of [...byType].sort((a, b) => a[0] - b[0])) console.log(`type ${type}:`, t);
console.log(`MESH header totals (0x6c faces, 0x70 vertices) disagree with the sets in ${headerMismatch} models`);
growth.sort((a, b) => a - b);
const q = (f: number) => growth[Math.floor(f * (growth.length - 1))]?.toFixed(0);
console.log(`human hull growth over the hit shape (units): p10 ${q(0.1)}  median ${q(0.5)}  p90 ${q(0.9)}`);
console.log("faces per set:material", Object.fromEntries([...materials].sort()));
console.log(problems ? `${problems} problems` : "all collision sets consistent");
process.exitCode = problems ? 1 : 0;
