// Assemble the static world for rendering: placed models (Building, EditRigidObj, Fence) plus the sub-models their
// .mef files attach (ATTA: room interiors, lamps, windows), each with its level-of-detail chain and, under a
// LightmapInfo task, its baked lightmaps from lightmaps/lightmaps.res.
//
// Lightmap files are named after the LightmapInfo's "Filename" (obj00014) plus a running number over the models of the
// owning task's subtree, in the order the lightmapper visited them:
//   task:  its model (if it has one), then its child tasks in order;
//   model: every LOD (_1.._5) with an LTMP chunk (an empty one takes a number but has no file), then its attachments -
//          first those without portals (props), then those with portals (rooms), each recursively.
// Matching by image size, this rule places 24,937 of the 25,337 .olm files in the 14 levels (98.4%). Tasks it
// does not cover (cameras with extra parts) are resynchronised by matching image sizes, see `alignLightMaps`.

import * as THREE from "three";
import { readRes } from "../../formats/ilff.ts";
import { decodeOlm, type ObjectLightMap } from "../../formats/olm.ts";
import { decodeQvm, type QvmCall, type QvmValue } from "../../formats/qvm.ts";
import type { Placement } from "../../level/objects.ts";
import type { ModelLibrary } from "../../render/library.ts";
import type { ClusterPart, LodChain } from "../../render/statics.ts";
import type { Vfs } from "../../vfs/vfs.ts";
import { METRE } from "../coords.ts";
import type { Environment } from "./environment.ts";

const MODEL_NAME = /^\d{3}_\d{2}_\d$/;
const MAX_LODS = 5;

/** A rendered static model: a placement or one of its attachments. */
export interface StaticNode {
  model: string;
  /** IGI space relative to the game origin. */
  matrix: THREE.Matrix4;
  attachments: StaticNode[];
  /** Index of this node in its parent model's ATTA list. */
  slot: number;
  /** Lightmap per LOD, filled in for nodes under a LightmapInfo. */
  lightMaps: (ObjectLightMap | null)[];
  placement?: Placement;
}

export interface StaticScene {
  /** Lightmapped groups: the owning task's nodes, flattened (owner first). */
  clusters: StaticNode[][];
  /** Everything else, flattened. */
  loose: StaticNode[];
  /** Root node per placement, for attaching collision children to Game.staticObjects. */
  byPlacement: Map<Placement, StaticNode>;
  /** Lightmap files matched / expected, for diagnostics. */
  lightMapStats: { files: number; matched: number; expected: number };
}

export interface LodTable {
  /** lod.qvm ModelLODSettings: distances relative to object radius, keyed by the LOD 1 model name. */
  models: Map<string, number[]>;
}

/** Read pc/lod.qvm (per-model LOD distances). */
export async function loadLodTable(vfs: Vfs): Promise<LodTable> {
  const models = new Map<string, number[]>();
  if (!vfs.has("lod.qvm")) return { models };
  for (const s of decodeQvm(await vfs.read("lod.qvm"))) {
    // Task_New(-1, "ModelLODSettings", name, model, lod1, lod2, lod3, lod4, cutoff)
    const [, type, , model, ...d] = s.args;
    if (type === "ModelLODSettings" && typeof model === "string") models.set(model, d.map(Number));
  }
  return { models };
}

/** LOD chains per model, sized by bounding radius as LODSettings describes. */
export class LodChains {
  private cache = new Map<string, LodChain>();
  private library: ModelLibrary;
  private env: Environment;
  private table: LodTable;

  constructor(library: ModelLibrary, env: Environment, table: LodTable) {
    this.library = library;
    this.env = env;
    this.table = table;
  }

  get(model: string): LodChain {
    const first = model.replace(/_\d$/, "_1");
    let chain = this.cache.get(first);
    if (chain) return chain;
    const base = first.slice(0, -2);
    const names: string[] = [];
    for (let l = 1; l <= MAX_LODS && this.library.has(`${base}_${l}`); l++) names.push(`${base}_${l}`);
    if (!names.length) names.push(model);
    const radius = (this.library.build(names[0])?.geometry.boundingSphere?.radius ?? METRE) / METRE;
    // "Degree to which radius affects LOD": 0 sizes every object as the ideal radius, 1 uses its own radius.
    const { idealRadius, radiusExponent, firstSwitch, cutoff } = this.env.lod;
    const scale = idealRadius * Math.pow(Math.max(radius, 0.01) / idealRadius, radiusExponent) * METRE;
    const own = this.table.models.get(first);
    if (own) {
      chain = { names, switches: own.slice(0, 4).map((d) => d * scale), cutoff: own[4] * scale };
    } else {
      // Only the first switch is given; later levels follow at doubling distances.
      chain = { names, switches: [1, 2, 4, 8].map((k) => firstSwitch.rigid * k * scale), cutoff: cutoff.rigid * scale };
    }
    this.cache.set(first, chain);
    return chain;
  }
}

/** Walk objects.qvm and build the static scene. `local` maps an IGI position to origin-relative coordinates. */
export async function collectStatics(
  vfs: Vfs,
  levelDir: string,
  statements: QvmCall[],
  placements: Placement[],
  library: ModelLibrary,
  origin: [number, number, number],
): Promise<StaticScene> {
  const lmPath = `${levelDir}/lightmaps/lightmaps.res`;
  const files = new Map<string, Uint8Array>();
  if (vfs.has(lmPath)) {
    for (const e of readRes(await vfs.read(lmPath))) files.set(e.name.split("/").pop()!.replace(/\.olm$/i, "").toLowerCase(), e.data);
  }

  const byPlacement = new Map<Placement, StaticNode>();
  const clusters: StaticNode[][] = [];
  const loose: StaticNode[] = [];
  const stats = { files: files.size, matched: 0, expected: 0 };
  let placementIndex = 0;

  const attach = (model: string, matrix: THREE.Matrix4, slot = -1, depth = 0): StaticNode => {
    const node: StaticNode = { model, matrix, attachments: [], lightMaps: [], slot };
    if (depth < 4) {
      (library.lighting(model)?.attachments ?? []).forEach((a, i) => {
        if (!library.has(a.model)) return;
        const r = a.rotation;
        const m = new THREE.Matrix4().set(r[0], r[1], r[2], a.position[0], r[3], r[4], r[5], a.position[1], r[6], r[7], r[8], a.position[2], 0, 0, 0, 1);
        node.attachments.push(attach(a.model, matrix.clone().multiply(m), i, depth + 1));
      });
    }
    return node;
  };
  const flatten = (n: StaticNode, out: StaticNode[]) => {
    out.push(n);
    n.attachments.forEach((a) => flatten(a, out));
    return out;
  };

  // Placement tasks in the same order levelObjects() found them.
  const isPlacement = (type: string, rest: QvmValue[]) =>
    ((type === "Building" || type === "EditRigidObj") && typeof rest[6] === "string") || (type === "Fence" && typeof rest[4] === "string");

  function visit(task: QvmCall, owner: { nodes: StaticNode[]; task: QvmCall } | null) {
    if (task.fn !== "Task_New") return;
    const [, type, , ...rest] = task.args;
    const lightInfo = rest.find((c): c is QvmCall => isCall(c) && c.args[1] === "LightmapInfo");
    let own = owner;
    if (lightInfo && !owner) own = { nodes: [], task };

    if (isPlacement(String(type), rest)) {
      const p = placements[placementIndex++];
      if (p && library.has(p.model)) {
        const matrix = new THREE.Matrix4().compose(
          new THREE.Vector3(p.position[0] - origin[0], p.position[1] - origin[1], p.position[2] - origin[2]),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(p.rotation[0], p.rotation[1], p.rotation[2], "ZYX")),
          new THREE.Vector3(1, 1, 1),
        );
        const node = attach(p.model, matrix);
        node.placement = p;
        byPlacement.set(p, node);
        flatten(node, own ? own.nodes : loose);
      }
    }
    for (const c of rest) if (isCall(c)) visit(c, own);

    if (own && own !== owner) {
      const name = String(lightInfo!.args.at(-1)).toLowerCase();
      alignLightMaps(own.task, own.nodes, name);
      clusters.push(own.nodes);
    }
  }

  /** Assign obj<name>_<n>.olm files to nodes by the lightmapper's visiting order. */
  function alignLightMaps(task: QvmCall, nodes: StaticNode[], name: string) {
    const expected: { node: StaticNode | null; lod: number; size: [number, number] }[] = [];
    const rendered = new Set(nodes);
    const visitModel = (model: string, node: StaticNode | null) => {
      const base = model.replace(/_\d$/, "");
      for (let l = 1; l <= MAX_LODS; l++) {
        const lighting = library.lighting(`${base}_${l}`);
        if (!lighting) break;
        // A model with an empty LTMP still uses up a number (its file is simply missing).
        if (lighting.lightMapSlot) expected.push({ node, lod: l - 1, size: lighting.lightMapSize ?? [0, 0] });
      }
      const atts = library.lighting(model)?.attachments ?? [];
      const kids = node?.attachments ?? [];
      // Rooms (models with portals) come after the props.
      const order = atts.map((a, i) => ({ a, kid: kids.find((k) => k.slot === i) ?? null, room: hasPortals(library, a.model) }));
      for (const room of [false, true]) for (const o of order) if (o.room === room) visitModel(o.a.model, o.kid);
    };
    const visitTask = (t: QvmCall) => {
      const [, , , ...rest] = t.args;
      const model = rest.find((r): r is string => typeof r === "string" && MODEL_NAME.test(r));
      if (model) {
        const node = nodes.find((n) => n.placement && rendered.has(n) && n.placement.model === model && !claimed.has(n)) ?? null;
        if (node) claimed.add(node);
        visitModel(model, node);
      }
      for (const c of rest) if (isCall(c)) visitTask(c);
    };
    const claimed = new Set<StaticNode>();
    visitTask(task);

    // Files by number; numbers whose model had an empty LTMP have no file and count as size 0x0.
    const prefix = `${name}_`;
    let count = 0;
    for (const key of files.keys()) if (key.startsWith(prefix)) count = Math.max(count, Number(key.slice(prefix.length)) + 1);
    const sizes: [number, number][] = [];
    const data: (Uint8Array | null)[] = [];
    for (let i = 0; i < count; i++) {
      const bytes = files.get(`${prefix}${String(i).padStart(5, "0")}`) ?? null;
      const v = bytes && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      sizes.push(v ? [v.getUint16(100, true), v.getUint16(102, true)] : [0, 0]);
      data.push(bytes);
    }
    stats.expected += expected.filter((e) => e.size[0]).length;
    // Greedy alignment by image size: skip whichever side gets back in step soonest.
    const same = (a: [number, number], b: [number, number]) => a[0] === b[0] && a[1] === b[1];
    let i = 0;
    let j = 0;
    while (i < expected.length && j < sizes.length) {
      if (same(expected[i].size, sizes[j])) {
        const e = expected[i];
        const bytes = data[j];
        if (e.node && bytes) e.node.lightMaps[e.lod] = decodeOlm(bytes);
        if (bytes) stats.matched++;
        i++;
        j++;
        continue;
      }
      let skip = 0;
      for (let k = 1; k <= 8 && !skip; k++) {
        if (j + k < sizes.length && same(expected[i].size, sizes[j + k])) skip = k;
        else if (i + k < expected.length && same(expected[i + k].size, sizes[j])) skip = -k;
      }
      if (skip > 0) j += skip;
      else if (skip < 0) i -= skip;
      else {
        i++;
        j++;
      }
    }
  }

  for (const s of statements) visit(s, null);
  return { clusters, loose, byPlacement, lightMapStats: stats };
}

/** Parts for StaticRenderer.addCluster. */
export function clusterParts(nodes: StaticNode[], chains: LodChains): { part: ClusterPart; chain: LodChain }[] {
  return nodes.map((n) => {
    const chain = chains.get(n.model);
    return { part: { model: chain.names[0], matrix: n.matrix, lightMaps: chain.names.map((_, l) => n.lightMaps[l] ?? null) }, chain };
  });
}

const portalCache = new WeakMap<ModelLibrary, Map<string, boolean>>();
function hasPortals(library: ModelLibrary, model: string): boolean {
  let m = portalCache.get(library);
  if (!m) portalCache.set(library, (m = new Map()));
  if (!m.has(model)) m.set(model, library.lighting(model)?.portals ?? false);
  return m.get(model)!;
}

function isCall(v: QvmValue): v is QvmCall {
  return typeof v === "object" && "fn" in v;
}
