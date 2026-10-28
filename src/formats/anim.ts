// .iff: skeleton plus skeletal animations (common/anims/000.iff ... 006.iff). An EA IFF 85 file: big-endian chunk
// sizes, chunks padded to even length, little-endian payloads.
//
//   FORM BOBJ
//     FORM BOBH                  skeleton
//       BOSH  u32 hierarchy, u32 boneCount        hierarchy = the file number, which objects.qvm's HumanSoldier
//                                                 "Bone Heirachy" parameter selects
//       PLST  i32 parent[boneCount]               -1 for the root; parents precede children
//       TLST  vec3 translation[boneCount]         bone origin in its parent's frame, rest rotation is identity
//     FORM BOAL                  animations
//       BALH  u32 animationCount, u32 ?
//       FORM BOAN  (animationCount times)
//         BOAH  f32 duration, u32 flags (bit 31 seems to mean looping), u32 id
//         BOTH  u32 n;  BOTD  n x 40 bytes: vec3 rootPosition, f32 time, vec3 ?, vec3 ? (spline tangents?)
//         BORH  u32 n;  BORD  n x 52 bytes: quat (x, y, z, w), f32 time, quat ?, quat ?   } once per bone
//         BOEH  u32 n;  BOED  event data (not decoded)
//
// Sizes and tables follow flawme/igi-reverse-engineering (see THIRD_PARTY.md); the key layouts and the pose math
// below are our own reading and were checked visually. See docs/FORMATS.md.

export interface Skeleton {
  /** Hierarchy number (BOSH[0]); equals the file number, e.g. 0 for 000.iff. */
  hierarchy: number;
  boneCount: number;
  parents: Int32Array;
  /** xyz per bone, relative to the parent bone. */
  translations: Float32Array;
}

export interface RotationKey {
  time: number;
  /** Rotation relative to the parent, as x, y, z, w. */
  q: [number, number, number, number];
}

export interface TranslationKey {
  time: number;
  /** Root bone position. */
  p: [number, number, number];
}

export interface Animation {
  id: number;
  duration: number;
  flags: number;
  root: TranslationKey[];
  /** One key list per bone, in bone order. */
  rotations: RotationKey[][];
}

export interface AnimFile {
  skeleton: Skeleton;
  animations: Animation[];
}

interface Chunk {
  tag: string;
  view: DataView;
}

// The FORM sizes in these files do not nest consistently (BOBJ's size covers only the skeleton, and the last BOAN
// runs past the end of BOAL), so the file is read as a flat stream: a FORM header is stepped into, any other chunk
// is stepped over, and the FORM types only mark where each animation starts.
function flatChunks(bytes: Uint8Array): Chunk[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  const out: Chunk[] = [];
  let at = 0;
  while (at + 8 <= bytes.length) {
    const t = tag(at);
    if (t === "FORM") {
      out.push({ tag: tag(at + 8), view: new DataView(bytes.buffer, bytes.byteOffset + at, 0) });
      at += 12;
      continue;
    }
    const size = view.getUint32(at + 4, false);
    if (at + 8 + size > bytes.length) throw new Error(`IFF chunk ${t} at ${at} overruns the file`);
    out.push({ tag: t, view: new DataView(bytes.buffer, bytes.byteOffset + at + 8, size) });
    at += 8 + size + (size & 1);
  }
  return out;
}

export function parseAnimFile(bytes: Uint8Array): AnimFile {
  const cs = flatChunks(bytes);
  if (cs[0]?.tag !== "BOBJ") throw new Error("not a BOBJ animation file");
  const one = (name: string) => {
    const c = cs.find((c) => c.tag === name);
    if (!c) throw new Error(`animation file has no ${name}`);
    return c.view;
  };
  const bosh = one("BOSH"), plst = one("PLST"), tlst = one("TLST"), balh = one("BALH");
  const boneCount = bosh.getUint32(4, true);
  if (plst.byteLength !== boneCount * 4 || tlst.byteLength !== boneCount * 12) throw new Error("bone table size mismatch");
  const parents = new Int32Array(boneCount);
  const translations = new Float32Array(boneCount * 3);
  for (let i = 0; i < boneCount; i++) {
    parents[i] = plst.getInt32(i * 4, true);
    if (parents[i] >= i) throw new Error(`bone ${i} has parent ${parents[i]} after it`);
    for (let k = 0; k < 3; k++) translations[i * 3 + k] = tlst.getFloat32(i * 12 + k * 4, true);
  }
  const skeleton: Skeleton = { hierarchy: bosh.getUint32(0, true), boneCount, parents, translations };

  const animations: Animation[] = [];
  let anim: Animation | null = null;
  for (const { tag, view: v } of cs) {
    if (tag === "BOAH") {
      anim = { duration: v.getFloat32(0, true), flags: v.getUint32(4, true), id: v.getUint32(8, true), root: [], rotations: [] };
      animations.push(anim);
    } else if (tag === "BOTD" && anim) {
      for (let o = 0; o + 40 <= v.byteLength; o += 40) {
        const p: [number, number, number] = [v.getFloat32(o, true), v.getFloat32(o + 4, true), v.getFloat32(o + 8, true)];
        anim.root.push({ time: v.getFloat32(o + 12, true), p });
      }
    } else if (tag === "BORD" && anim) {
      const keys: RotationKey[] = [];
      for (let o = 0; o + 52 <= v.byteLength; o += 52) {
        const q: [number, number, number, number] = [v.getFloat32(o, true), v.getFloat32(o + 4, true), v.getFloat32(o + 8, true), v.getFloat32(o + 12, true)];
        keys.push({ time: v.getFloat32(o + 16, true), q });
      }
      anim.rotations.push(keys);
    }
  }
  if (animations.length !== balh.getUint32(0, true)) {
    throw new Error(`BALH says ${balh.getUint32(0, true)} animations, found ${animations.length}`);
  }
  for (const a of animations) {
    if (a.rotations.length !== boneCount) throw new Error(`animation ${a.id} has ${a.rotations.length} tracks for ${boneCount} bones`);
  }
  return { skeleton, animations };
}

/**
 * Bone-to-model transforms, 12 floats per bone: a row-major 3x3 rotation then a translation. With no animation this
 * is the bind pose (identity rotations, translations summed down the hierarchy), which is the frame that type 1
 * .mef vertices are stored in. With an animation, `time` is wrapped into [0, duration). `inPlace` keeps the root's
 * horizontal (x, y) position at its first key, so locomotion plays on the spot.
 */
export function poseBones(skeleton: Skeleton, anim?: Animation, time = 0, inPlace = false): Float32Array {
  const n = skeleton.boneCount;
  const out = new Float32Array(n * 12);
  const t = anim && anim.duration > 0 ? ((time % anim.duration) + anim.duration) % anim.duration : 0;
  const root = anim?.root.length ? [...lerpRoot(anim.root, t)] : [0, 0, 0];
  if (anim?.root.length && inPlace) [root[0], root[1]] = anim.root[0].p;
  const local = new Float32Array(12);
  for (let i = 0; i < n; i++) {
    const q = anim ? sampleRotation(anim.rotations[i], t) : [0, 0, 0, 1];
    quatToMatrix(q, local);
    for (let k = 0; k < 3; k++) local[9 + k] = skeleton.translations[i * 3 + k] + (i === 0 ? root[k] : 0);
    const p = skeleton.parents[i];
    if (p < 0) out.set(local, i * 12);
    else compose(out, p * 12, local, out, i * 12);
  }
  return out;
}

function lerpRoot(keys: TranslationKey[], t: number): number[] {
  let i = 0;
  while (i + 1 < keys.length && keys[i + 1].time <= t) i++;
  const a = keys[i], b = keys[i + 1];
  if (!b || b.time <= a.time) return a.p;
  const f = (t - a.time) / (b.time - a.time);
  return a.p.map((x, k) => x + (b.p[k] - x) * f);
}

function sampleRotation(keys: RotationKey[], t: number): number[] {
  if (!keys.length) return [0, 0, 0, 1];
  let i = 0;
  while (i + 1 < keys.length && keys[i + 1].time <= t) i++;
  const a = keys[i], b = keys[i + 1];
  if (!b || b.time <= a.time) return a.q;
  return slerp(a.q, b.q, (t - a.time) / (b.time - a.time));
}

function slerp(a: number[], b: number[], f: number): number[] {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const s = dot < 0 ? -1 : 1;
  dot *= s;
  let wa = 1 - f, wb = f;
  if (dot < 0.9995) {
    const angle = Math.acos(dot), sin = Math.sin(angle);
    wa = Math.sin((1 - f) * angle) / sin;
    wb = Math.sin(f * angle) / sin;
  }
  const q = [0, 1, 2, 3].map((k) => a[k] * wa + b[k] * wb * s);
  const len = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return q.map((x) => x / len);
}

function quatToMatrix([x, y, z, w]: number[], m: Float32Array) {
  m[0] = 1 - 2 * (y * y + z * z); m[1] = 2 * (x * y - z * w); m[2] = 2 * (x * z + y * w);
  m[3] = 2 * (x * y + z * w); m[4] = 1 - 2 * (x * x + z * z); m[5] = 2 * (y * z - x * w);
  m[6] = 2 * (x * z - y * w); m[7] = 2 * (y * z + x * w); m[8] = 1 - 2 * (x * x + y * y);
}

/** out[o..] = a[ao..] * b (rotation then translation, 12 floats each). */
function compose(a: Float32Array, ao: number, b: Float32Array, out: Float32Array, o: number) {
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[o + r * 3 + c] = a[ao + r * 3] * b[c] + a[ao + r * 3 + 1] * b[3 + c] + a[ao + r * 3 + 2] * b[6 + c];
    }
    out[o + 9 + r] = a[ao + r * 3] * b[9] + a[ao + r * 3 + 1] * b[10] + a[ao + r * 3 + 2] * b[11] + a[ao + 9 + r];
  }
}
