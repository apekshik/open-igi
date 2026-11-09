// Character movement against static geometry (run with `npm test`): sliding round an outside corner without being
// thrown back, and no passing through walls at any frame rate the game allows (frames are capped at 0.1 s).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelCollision } from "../../formats/collision.ts";
import type { GameMaterial } from "./materials.ts";
import { CollisionWorld } from "./world.ts";

const M = 4096;
const RADIUS = 0.3 * M;
const HEIGHT = 1.8 * M;
const RUN = 5.88 * M;
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const MATERIALS: GameMaterial[] = [
  { id: 0, name: "Air", transparency: 1, passThrough: true, stopping: 0 },
  { id: 1, name: "Concrete", transparency: 0, passThrough: false, stopping: 5 },
];

/** A closed box (metres) as a model's detailed collision set, material Concrete, no human hull. */
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): ModelCollision {
  const v = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ].flat().map((c) => c * M);
  // Two triangles per side, wound outwards.
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  const faces = quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d]);
  const hit = {
    vertices: new Float32Array(v),
    faces: new Uint16Array(faces),
    faceGroup: new Uint16Array(faces.length / 3),
    groups: [{ flag: 1, link: -1, part: -1, material: 1 }],
    spheres: [],
  };
  return { modelType: 3, hit, human: null };
}

function world(...shapes: ModelCollision[]): CollisionWorld {
  const floor = box(-50, -50, -1, 50, 50, 0);
  return new CollisionWorld({
    origin: [0, 0, 0],
    terrain: null,
    materials: MATERIALS,
    objects: [floor, ...shapes].map((collision, i) => ({ model: `m${i}`, collision, matrix: IDENTITY })),
  });
}

/** Run along `dir` (unit, xy) for `seconds` at frames of `dt`; the feet after every frame. */
function run(w: CollisionWorld, from: [number, number], dir: [number, number], seconds: number, dt: number): number[][] {
  let feet = [from[0] * M, from[1] * M, 0];
  const path: number[][] = [];
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    feet = w.move(feet, [dir[0] * RUN * dt, dir[1] * RUN * dt, -0.1 * M * dt], RADIUS, HEIGHT).position;
    path.push(feet);
  }
  return path;
}

/** Frames whose step turns back on the previous one (jitter), ignoring sub-millimetre steps. */
function reversals(path: number[][]): number {
  let n = 0;
  for (let i = 2; i < path.length; i++) {
    const ax = path[i - 1][0] - path[i - 2][0], ay = path[i - 1][1] - path[i - 2][1];
    const bx = path[i][0] - path[i - 1][0], by = path[i][1] - path[i - 1][1];
    if (ax * bx + ay * by < 0 && Math.hypot(bx, by) > 0.002 * M) n++;
  }
  return n;
}

const norm = (x: number, y: number): [number, number] => [x / Math.hypot(x, y), y / Math.hypot(x, y)];

test("sliding along a wall rounds its outside corner without being thrown back", () => {
  // A 4 m building; run up its +x wall at 60 degrees into it, past the corner at y = 4.
  const w = world(box(0, 0, 0, 4, 4, 3));
  for (const dt of [1 / 60, 1 / 30, 0.1]) {
    const path = run(w, [4.6, 1], norm(-0.5, 0.866), 1.5, dt);
    assert.equal(reversals(path), 0, `jitter at dt ${dt}`);
    const end = path[path.length - 1];
    assert.ok(end[1] > 5 * M, `stuck at the corner at dt ${dt}: y = ${end[1] / M}`);
  }
});

test("running into a wall never passes through it, at any frame time", () => {
  const w = world(box(0, 0, 0, 4, 4, 3));
  for (const dt of [1 / 60, 1 / 30, 0.1]) {
    for (const angle of [0, 20, 45, 70]) {
      const a = (angle * Math.PI) / 180;
      const path = run(w, [5, 2], [-Math.cos(a), Math.sin(a) * 0.5], 2, dt);
      for (const p of path) {
        const inside = p[0] < 4 * M + RADIUS - 0.01 * M && p[1] > 0 && p[1] < 4 * M;
        assert.ok(!inside, `entered the wall at dt ${dt}, ${angle} degrees: x = ${p[0] / M}`);
      }
    }
  }
});

test("a thin wall stops a running body from either side", () => {
  // A 10 cm slab, 6 m long; run at it from both sides and at angles.
  const w = world(box(-0.05, -3, 0, 0.05, 3, 3));
  for (const dt of [1 / 60, 0.1]) {
    for (const side of [1, -1]) {
      for (const angle of [0, 30, 60]) {
        const a = (angle * Math.PI) / 180;
        const path = run(w, [side * 1.5, -1], [-side * Math.cos(a), Math.sin(a)], 1.5, dt);
        for (const p of path) {
          if (Math.abs(p[1]) < 3 * M) assert.ok(p[0] * side > 0, `through the slab at dt ${dt}, side ${side}, ${angle} degrees`);
        }
      }
    }
  }
});
