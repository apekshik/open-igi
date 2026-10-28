// .mtp: per-level material table. A big-endian IFF "FORM" of type "MTP " whose chunk payloads are little-endian.
//
//   MODS  u32 count, then count NUL-terminated model names (same names as the models archive, minus ".mef")
//   VNAM  u32 count, then count u32 offsets, one per model (meaning unknown; not offsets into INST)
//   INST  one record per model, in MODS order: u32 modelIndex, u32 n, then n u32 indices into TEXF.
//         n equals the model's material count; material slot i uses texture INST[i].
//   TEXF  u32 count, then count NUL-terminated texture names (same order as the textures archive)
//   GTT   u32 count, then count pairs (u32 index, i32 -1), identity in every file seen
//   BANM, SNDS, SVOL, PALF  empty in Mission 1

export interface MaterialTable {
  models: string[];
  textures: string[];
  /** Per model (same order as `models`), the TEXF index used by each material slot. */
  modelTextures: number[][];
}

export function parseMtp(bytes: Uint8Array): MaterialTable {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  if (tag(0) !== "FORM" || tag(8) !== "MTP ") throw new Error("not an MTP file");

  const chunks = new Map<string, DataView>();
  let at = 12;
  while (at + 8 <= bytes.length) {
    const size = view.getUint32(at + 4, false);
    chunks.set(tag(at).trim(), new DataView(bytes.buffer, bytes.byteOffset + at + 8, size));
    at += 8 + size + (size & 1);
  }
  const need = (name: string) => {
    const c = chunks.get(name);
    if (!c) throw new Error(`MTP has no ${name} chunk`);
    return c;
  };

  const models = names(need("MODS"));
  const textures = names(need("TEXF"));
  const inst = need("INST");
  const modelTextures: number[][] = models.map(() => []);
  for (let o = 0; o + 8 <= inst.byteLength; ) {
    const model = inst.getUint32(o, true);
    const n = inst.getUint32(o + 4, true);
    if (model >= models.length) throw new Error(`INST record for model ${model} of ${models.length}`);
    const slots: number[] = [];
    for (let i = 0; i < n; i++) slots.push(inst.getUint32(o + 8 + i * 4, true));
    modelTextures[model] = slots;
    o += 8 + n * 4;
  }
  return { models, textures, modelTextures };
}

function names(chunk: DataView): string[] {
  const count = chunk.getUint32(0, true);
  const out: string[] = [];
  let s = "";
  for (let i = 4; i < chunk.byteLength && out.length < count; i++) {
    const c = chunk.getUint8(i);
    if (c === 0) {
      out.push(s);
      s = "";
    } else s += String.fromCharCode(c);
  }
  return out;
}
