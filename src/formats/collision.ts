// .mef collision: the CMSH/CVTX/CFCE/CMAT/CSPH chunks that follow a model's render geometry. See
// docs/formats/collision.md.
//
// Every model with collision stores two sets, each CVTX (vertices), CFCE (triangles), CMAT (face groups with a game
// material) and CSPH (a bounding-sphere tree over the triangles):
//   set 0 "hit"   - the real shape, grouped by surface material (Concrete, Wood, Glass, Flesh, ...). Bullets, line of
//                   sight and anything that needs the surface material use it.
//   set 1 "human" - an optional coarse hull already grown outwards by roughly a person's radius, every face tagged
//                   material 21 "HumanCollision" (material/material.qvm). Characters move against it.
// CMSH is two 32-byte descriptors with the counts of each set: u32 faces, vertices, groups, spheres, then 16 bytes
// the loader fills with pointers.

import { parseIlff, type IlffFile } from "./ilff.ts";
import { tagName } from "./mef.ts";

/** Game material ids from material/material.qvm (SetActiveMaterial n; DefineGameMaterial(name, ...)). */
export const HUMAN_COLLISION_MATERIAL = 21;
/** CMAT material value for a face group without a game material. */
export const NO_MATERIAL = 0xffff;

export interface CollisionGroup {
  /** f32 at +0: 1 for the catch-all group (part -1), 0 for numbered parts. */
  flag: number;
  /** i16 at +4: -1, or an index on catch-all groups of rigid objects (purpose unknown). */
  link: number;
  /** i16 at +6: part number (0, 1, 2, ... in order), -1 for the catch-all group. Characters: one part per bone group. */
  part: number;
  /** Game material id (material.qvm), or NO_MATERIAL. */
  material: number;
}

export interface CollisionSphere {
  centre: [number, number, number];
  radius: number;
  /** Triangle index for leaves, -1 for inner nodes. */
  face: number;
  /** First child (inner nodes), or -1. Node 0 is the root, so 0 never appears as a link. */
  child: number;
  /** Next sibling, or -1. */
  next: number;
}

export interface CollisionMesh {
  /** xyz per vertex, model space (IGI units, Z up). */
  vertices: Float32Array;
  /** i0, i1, i2 per triangle. */
  faces: Uint16Array;
  /** Per triangle: index into `groups`. */
  faceGroup: Uint16Array;
  groups: CollisionGroup[];
  /** Binary sphere tree: 2 * faces - 1 nodes, root first. */
  spheres: CollisionSphere[];
}

export interface ModelCollision {
  /** MESH model type (0 rigid, 1 skinned, 3 static). Type 1 collision vertices are bone-relative like its render ones. */
  modelType: number;
  /** Set 0: detailed, material-tagged shape (bullets, sight, surface sounds). */
  hit: CollisionMesh | null;
  /** Set 1: hull pre-grown by a person's radius, for character movement (absent on many models). */
  human: CollisionMesh | null;
}

const DESCRIPTOR = 32;

/** Read both collision sets of a .mef (bytes or an already-parsed ILFF). Models without CMSH return nulls. */
export function decodeCollision(source: Uint8Array | IlffFile): ModelCollision {
  const file = source instanceof Uint8Array ? parseIlff(source) : source;
  const mesh = file.chunks.find((c) => tagName(c.tag) === "MESH");
  const modelType = mesh && mesh.length >= 36 ? new DataView(mesh.data.buffer, mesh.data.byteOffset, mesh.length).getUint32(32, true) : -1;
  const at = file.chunks.findIndex((c) => tagName(c.tag) === "CMSH");
  if (at < 0) return { modelType, hit: null, human: null };
  const cmsh = file.chunks[at];
  if (cmsh.length < 2 * DESCRIPTOR) throw new Error(`CMSH is ${cmsh.length} bytes`);
  const view = new DataView(cmsh.data.buffer, cmsh.data.byteOffset, cmsh.length);
  const sets = [0, 1].map((s) => {
    const chunks = file.chunks.slice(at + 1 + s * 4, at + 5 + s * 4);
    const names = chunks.map((c) => tagName(c.tag)).join(",");
    if (names !== "CVTX,CFCE,CMAT,CSPH") throw new Error(`collision set ${s} has chunks ${names}`);
    const counts = [0, 4, 8, 12].map((k) => view.getUint32(s * DESCRIPTOR + k, true));
    return readSet(chunks.map((c) => c.data), counts as [number, number, number, number], s);
  });
  return { modelType, hit: sets[0], human: sets[1] };
}

function readSet(
  [cvtx, cfce, cmat, csph]: Uint8Array[],
  [faceCount, vertexCount, groupCount, sphereCount]: [number, number, number, number],
  set: number,
): CollisionMesh | null {
  const where = `collision set ${set}`;
  if (cvtx.length !== vertexCount * 16) throw new Error(`${where}: CVTX ${cvtx.length} bytes for ${vertexCount} vertices`);
  if (cfce.length !== faceCount * 8) throw new Error(`${where}: CFCE ${cfce.length} bytes for ${faceCount} faces`);
  if (cmat.length !== groupCount * 12) throw new Error(`${where}: CMAT ${cmat.length} bytes for ${groupCount} groups`);
  if (csph.length !== sphereCount * 24) throw new Error(`${where}: CSPH ${csph.length} bytes for ${sphereCount} spheres`);
  if (!faceCount) return null;

  const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.length);
  // CVTX: f32 x, y, z, 0.
  const vv = dv(cvtx);
  const vertices = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) for (let k = 0; k < 3; k++) vertices[i * 3 + k] = vv.getFloat32(i * 16 + k * 4, true);

  // CMAT: f32 flag, i16 link, i16 part, u16 material, u16 (uninitialised).
  const gv = dv(cmat);
  const groups: CollisionGroup[] = [];
  for (let i = 0; i < groupCount; i++) {
    const o = i * 12;
    groups.push({ flag: gv.getFloat32(o, true), link: gv.getInt16(o + 4, true), part: gv.getInt16(o + 6, true), material: gv.getUint16(o + 8, true) });
  }

  // CFCE: u16 i0, i1, i2, group.
  const fv = dv(cfce);
  const faces = new Uint16Array(faceCount * 3);
  const faceGroup = new Uint16Array(faceCount);
  for (let i = 0; i < faceCount; i++) {
    for (let k = 0; k < 3; k++) {
      const index = fv.getUint16(i * 8 + k * 2, true);
      if (index >= vertexCount) throw new Error(`${where}: face ${i} uses vertex ${index} of ${vertexCount}`);
      faces[i * 3 + k] = index;
    }
    faceGroup[i] = fv.getUint16(i * 8 + 6, true);
    if (faceGroup[i] >= groupCount) throw new Error(`${where}: face ${i} uses group ${faceGroup[i]} of ${groupCount}`);
  }

  // CSPH: f32 x, y, z, radius, u16 face (0xFFFF on inner nodes), u16 leaf, u16 firstChild, u16 nextSibling (0 = none).
  const sv = dv(csph);
  const spheres: CollisionSphere[] = [];
  for (let i = 0; i < sphereCount; i++) {
    const o = i * 24;
    const face = sv.getUint16(o + 16, true);
    const child = sv.getUint16(o + 20, true);
    const next = sv.getUint16(o + 22, true);
    spheres.push({
      centre: [sv.getFloat32(o, true), sv.getFloat32(o + 4, true), sv.getFloat32(o + 8, true)],
      radius: sv.getFloat32(o + 12, true),
      face: face === 0xffff ? -1 : face,
      child: child ? child : -1,
      next: next ? next : -1,
    });
  }
  return { vertices, faces, faceGroup, groups, spheres };
}

/**
 * Structural checks beyond what decoding enforces: the sphere tree is a binary tree whose leaves are each triangle
 * exactly once, and every leaf sphere contains its triangle. Returns a list of problems (empty when consistent).
 */
export function checkCollisionMesh(mesh: CollisionMesh): string[] {
  const problems: string[] = [];
  const faceCount = mesh.faceGroup.length;
  const { spheres } = mesh;
  if (spheres.length !== 2 * faceCount - 1) problems.push(`${spheres.length} spheres for ${faceCount} faces`);
  const seen = new Uint8Array(faceCount);
  const visited = new Uint8Array(spheres.length);
  const stack = [0];
  while (stack.length) {
    const i = stack.pop()!;
    if (i < 0 || i >= spheres.length) {
      problems.push(`sphere link ${i} out of range`);
      continue;
    }
    if (visited[i]++) {
      problems.push(`sphere ${i} reached twice`);
      continue;
    }
    const s = spheres[i];
    if (s.face >= 0) {
      if (s.child >= 0) problems.push(`leaf sphere ${i} has children`);
      if (s.face >= faceCount) problems.push(`sphere ${i} face ${s.face} of ${faceCount}`);
      else {
        seen[s.face]++;
        for (let k = 0; k < 3; k++) {
          const v = mesh.faces[s.face * 3 + k] * 3;
          const d = Math.hypot(mesh.vertices[v] - s.centre[0], mesh.vertices[v + 1] - s.centre[1], mesh.vertices[v + 2] - s.centre[2]);
          if (d > s.radius * 1.001 + 1) problems.push(`sphere ${i} misses a vertex of face ${s.face} by ${(d - s.radius).toFixed(1)}`);
        }
      }
    } else {
      let n = 0;
      for (let c = s.child; c >= 0; c = spheres[c]?.next ?? -1) {
        stack.push(c);
        if (++n > 2) break;
      }
      if (n !== 2) problems.push(`inner sphere ${i} has ${n} children`);
    }
  }
  if (spheres.length && spheres[0].next >= 0) problems.push("root sphere has a sibling");
  const missing = seen.reduce((n, v) => n + (v === 1 ? 0 : 1), 0);
  if (missing) problems.push(`${missing} faces not exactly once in the sphere tree`);
  return problems.slice(0, 5);
}
