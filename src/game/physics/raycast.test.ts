// Bullets and characters (run with `npm test`): a bullet flies on through glass, but hits whoever stands before the
// next pane. Mission 1's guard between two windows used to take no bullets from in line with both.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelCollision } from "../../formats/collision.ts";
import type { Vec3 } from "../coords.ts";
import type { Game } from "../game.ts";
import { IgiPhysics } from "./index.ts";
import type { GameMaterial } from "./materials.ts";
import { CollisionWorld } from "./world.ts";

const M = 4096;
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const CONCRETE = 1;
const GLASS = 2;
const MATERIALS: GameMaterial[] = [
  { id: 0, name: "Air", transparency: 1, passThrough: true, stopping: 0 },
  { id: 1, name: "Concrete", transparency: 0, passThrough: false, stopping: 5 },
  { id: 2, name: "Glass", transparency: 1, passThrough: false, stopping: 0 },
];

/** A closed box (metres) of one material as a model's detailed collision set. */
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, material: number): ModelCollision {
  const v = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ].flat().map((c) => c * M);
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  const faces = quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d]);
  return {
    modelType: 3,
    hit: { vertices: new Float32Array(v), faces: new Uint16Array(faces), faceGroup: new Uint16Array(faces.length / 3), groups: [{ flag: 1, link: -1, part: -1, material }], spheres: [] },
    human: null,
  };
}

interface Guard {
  id: number;
  alive: boolean;
  position: Vec3;
  radius: number;
  height: number;
}

function physics(shapes: ModelCollision[], guards: Guard[]): IgiPhysics {
  const world = new CollisionWorld({
    origin: [0, 0, 0],
    terrain: null,
    materials: MATERIALS,
    objects: shapes.map((collision, i) => ({ model: `m${i}`, collision, matrix: IDENTITY })),
  });
  const game = { entities: { all: () => guards } } as unknown as Game;
  return new IgiPhysics(game, world);
}

const guard = (id: number, x: number): Guard => ({ id, alive: true, position: [x * M, 0, 0], radius: 0.35 * M, height: 1.8 * M });
// Windows across the line of fire at x = 3 and x = 5 (2 cm panes).
const pane = (x: number) => box(x - 0.01, -2, 0, x + 0.01, 2, 3, GLASS);
const from: Vec3 = [0, 0, 1.3 * M];
const to: Vec3 = [8 * M, 0, 1.3 * M];

test("a bullet through a window hits the guard standing before the next one", () => {
  const p = physics([pane(3), pane(5)], [guard(7, 4)]);
  assert.equal(p.raycast(from, to, { bullet: true })?.entityId, 7);
});

test("a bullet flies on through both windows to a guard beyond them", () => {
  const p = physics([pane(3), pane(5)], [guard(7, 6.5)]);
  assert.equal(p.raycast(from, to, { bullet: true })?.entityId, 7);
});

test("glass still stops rays that are not bullets, and concrete stops bullets", () => {
  const glass = physics([pane(3), pane(5)], [guard(7, 4)]);
  assert.equal(glass.raycast(from, to)?.material, "Glass");
  const wall = physics([box(2.9, -2, 0, 3.1, 2, 3, CONCRETE)], [guard(7, 4)]);
  assert.equal(wall.raycast(from, to, { bullet: true })?.entityId, null);
});

test("the nearer of two guards between the windows takes the bullet", () => {
  const p = physics([pane(3), pane(5)], [guard(8, 4.6), guard(7, 3.6)]);
  assert.equal(p.raycast(from, to, { bullet: true })?.entityId, 7);
});
