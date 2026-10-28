// AI navigation graphs: missions/location0/<level>/graphs/graph<id>.dat, one per AIGraph task in objects.qvm (the
// task id is the file number; a HumanAI's "Graph ID" parameter picks its graph). Node positions are relative to the
// AIGraph task's "Graph position".
//
// Both layouts are a stream of one-byte-tagged tokens:
//   0x00 u8 type        field type marker (precedes a keyed field's value, and the route table)
//   0x04 u32            field key: a hash of the field name (see FIELD below)
//   0x05 i32   0x06 f32   0x08 f64 x3 (a position)   0x09 u8 length, char[length] (NUL-terminated string)
//
// Keyed layout (all levels but level8): u32 magic 0xFFEEDDCC, then keyed fields:
//   nMaxNodes, RouteTable (marker 0x0a, 0x05 u32 byteSize, dim*dim cells of {u32 nextHop, f32 distance}),
//   then per node nNodeID, tNodePosition, vNodeGamma, vNodeRadius, nNodeMaterial, nNodeCriteria,
//   then per link nLinkID1, nLinkID2, eLinkType.
// Positional layout (level8): i32 nodeCount, i32 dim, i32 linkCount; per node: id, position, gamma, radius, f32 ? (absent in older files),
//   material, criteria, then two lists of id pairs (meaning unknown), each an i32 count then count x (i32, i32); per link:
//   id1, id2, type; then the route table (marker 0x0a, size, cells), which the game does not read for this layout.
//
// Layout facts (magic, the route table, the field-name hash and the 11 field names) come from
// flawme/igi-reverse-engineering (reverse/docs/16-verified-formats; see THIRD_PARTY.md). The token grammar and the
// positional layout are our own reading. See docs/formats/ai.md.

export interface GraphNode {
  id: number;
  /** Relative to the AIGraph task position, IGI units. */
  position: [number, number, number];
  gamma: number;
  radius: number;
  material: number;
  /** "NODECRITERIA_DOOR", "NODECRITERIA_STAIR", "NODECRITERIA_VIEW" (a look-at target, usually unlinked) or "". */
  criteria: string;
}

export interface AiGraph {
  nodes: GraphNode[];
  /** Undirected links between node ids. */
  links: { a: number; b: number; type: number }[];
}

const MAGIC = 0xffeeddcc;

/** IGI.exe's field-name hash (fcn.004f9bb0): h += upper(c) * mul; mul = (mul + 0x13d) & 0xffff. */
export function graphFieldHash(name: string): number {
  let h = 0;
  let mul = 1;
  for (const ch of name.toUpperCase()) {
    h = (h + ch.charCodeAt(0) * mul) >>> 0;
    mul = (mul + 0x13d) & 0xffff;
  }
  return h;
}

const FIELD = Object.fromEntries(
  ["nMaxNodes", "nNodeID", "tNodePosition", "vNodeGamma", "vNodeRadius", "nNodeMaterial", "nNodeCriteria", "nLinkID1", "nLinkID2", "eLinkType", "RouteTable"].map(
    (n) => [graphFieldHash(n), n],
  ),
) as Record<number, string>;

type Token = { tag: 0; type: number } | { tag: 4; key: number } | { tag: 5 | 6; value: number } | { tag: 8; value: [number, number, number] } | { tag: 9; value: string };

function* tokens(bytes: Uint8Array, start: number): Generator<Token> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = start;
  let tableNext = false;
  while (at < bytes.length) {
    const tag = bytes[at++];
    switch (tag) {
      case 0x00:
        if (bytes[at] === 0x0a) tableNext = true;
        yield { tag: 0, type: bytes[at++] };
        break;
      case 0x04:
        yield { tag: 4, key: v.getUint32(at, true) };
        at += 4;
        break;
      case 0x05: {
        const value = v.getInt32(at, true);
        at += 4;
        // A route table's byte size is followed by the table itself, which nothing here needs.
        if (tableNext) {
          at += value;
          tableNext = false;
        } else yield { tag: 5, value };
        break;
      }
      case 0x06:
        yield { tag: 6, value: v.getFloat32(at, true) };
        at += 4;
        break;
      case 0x08:
        yield { tag: 8, value: [v.getFloat64(at, true), v.getFloat64(at + 8, true), v.getFloat64(at + 16, true)] };
        at += 24;
        break;
      case 0x09: {
        const n = bytes[at];
        let s = "";
        for (let i = 1; i < n; i++) if (bytes[at + i]) s += String.fromCharCode(bytes[at + i]);
        yield { tag: 9, value: s };
        at += 1 + n;
        break;
      }
      default:
        throw new Error(`graph: unknown token 0x${tag.toString(16)} at ${at - 1}`);
    }
  }
}

export function parseAiGraph(bytes: Uint8Array): AiGraph {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return bytes.length >= 4 && v.getUint32(0, true) === MAGIC ? parseKeyed(bytes) : parsePositional(bytes);
}

function parseKeyed(bytes: Uint8Array): AiGraph {
  const nodes: GraphNode[] = [];
  const links: AiGraph["links"] = [];
  let field = "";
  let node: GraphNode | null = null;
  let link: { a: number; b: number; type: number } | null = null;
  for (const t of tokens(bytes, 4)) {
    if (t.tag === 4) {
      field = FIELD[t.key] ?? "";
      continue;
    }
    if (t.tag === 0) continue;
    const value = t.value;
    switch (field) {
      case "nNodeID":
        node = { id: value as number, position: [0, 0, 0], gamma: 0, radius: 0, material: -1, criteria: "" };
        nodes.push(node);
        break;
      case "tNodePosition":
        if (node) node.position = value as [number, number, number];
        break;
      case "vNodeGamma":
        if (node) node.gamma = value as number;
        break;
      case "vNodeRadius":
        if (node) node.radius = value as number;
        break;
      case "nNodeMaterial":
        if (node) node.material = value as number;
        break;
      case "nNodeCriteria":
        if (node) node.criteria = value as string;
        break;
      case "nLinkID1":
        link = { a: value as number, b: -1, type: 0 };
        links.push(link);
        break;
      case "nLinkID2":
        if (link) link.b = value as number;
        break;
      case "eLinkType":
        if (link) link.type = value as number;
        break;
    }
  }
  return { nodes, links };
}

function parsePositional(bytes: Uint8Array): AiGraph {
  const list = [...tokens(bytes, 0)].filter((t) => t.tag !== 0 && t.tag !== 4) as Exclude<Token, { tag: 0 | 4 }>[];
  let i = 0;
  const next = () => {
    if (i >= list.length) throw new Error("graph: unexpected end of positional graph");
    return list[i++].value;
  };
  const nodeCount = next() as number;
  next(); // route table dimension
  const linkCount = next() as number;
  const nodes: GraphNode[] = [];
  for (let n = 0; n < nodeCount; n++) {
    const id = next() as number;
    const position = next() as [number, number, number];
    // Gamma, radius and (in most files) one more f32.
    const gamma = next() as number;
    const radius = next() as number;
    while (list[i]?.tag === 6) i++;
    const material = next() as number;
    const criteria = next() as string;
    // Two lists of id pairs (meaning unknown), each a count then count x (i32, i32).
    for (let list = 0; list < 2; list++) {
      const pairs = next() as number;
      i += pairs * 2;
    }
    nodes.push({ id, position, gamma, radius, material, criteria });
  }
  const links: AiGraph["links"] = [];
  for (let l = 0; l < linkCount; l++) links.push({ a: next() as number, b: next() as number, type: next() as number });
  return { nodes, links };
}
