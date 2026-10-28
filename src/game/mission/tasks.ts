// The objects.qvm task tree with named parameters.
//
// Every task is Task_New(id, type, name, ...params, ...children). The script declares each type's parameter list
// with Task_DeclareParameters(type, name1, kind1, name2, kind2, ...); this module walks the tree and names every
// parameter from that schema, so mission logic can read `task.params["Open door expression"]`.
//
// Values per parameter kind, as stored: ObjectPos, Real32x3, Real64x3 and RGB take three values; Real32x9 (an
// orientation matrix in the editor) is stored as three Euler angles; PushButton takes none; AnimData/Graph take
// whatever is left. Everything else is one value.

import type { QvmCall, QvmValue } from "../../formats/qvm.ts";

export type ParamValue = number | string | boolean | number[];

export interface TaskNode {
  /** Task id, or -1 for anonymous tasks. Expressions refer to tasks as `<Type>_<id>`. */
  id: number;
  type: string;
  name: string;
  params: Record<string, ParamValue>;
  children: TaskNode[];
  parent: TaskNode | null;
}

const WIDTH: Record<string, number> = { ObjectPos: 3, Real32x9: 3, Real32x3: 3, Real64x3: 3, RGB: 3, PushButton: 0 };
const REST = new Set(["AnimData", "Graph"]);

export interface TaskTree {
  roots: TaskNode[];
  all: TaskNode[];
  /** Tasks with an id, by `<Type>_<id>` (the name expressions use). */
  byKey: Map<string, TaskNode>;
  byId: Map<number, TaskNode>;
  schema: Map<string, [name: string, kind: string][]>;
}

export function taskTree(statements: QvmCall[]): TaskTree {
  const schema = new Map<string, [string, string][]>();
  for (const s of statements) {
    if (s.fn !== "Task_DeclareParameters") continue;
    const [type, ...rest] = s.args;
    const pairs: [string, string][] = [];
    for (let i = 0; i + 1 < rest.length; i += 2) pairs.push([String(rest[i]), String(rest[i + 1])]);
    schema.set(String(type), pairs);
  }

  const all: TaskNode[] = [];
  const byKey = new Map<string, TaskNode>();
  const byId = new Map<number, TaskNode>();

  const build = (call: QvmCall, parent: TaskNode | null): TaskNode | null => {
    if (call.fn !== "Task_New") return null;
    const [id, type, name, ...rest] = call.args;
    const values = rest.filter((a) => !isCall(a)).map(plain);
    const node: TaskNode = { id: Number(id), type: String(type), name: String(name ?? ""), params: {}, children: [], parent };
    let k = 0;
    for (const [pname, kind] of schema.get(node.type) ?? []) {
      if (REST.has(kind)) {
        node.params[pname] = values.slice(k).filter((v): v is number => typeof v === "number");
        k = values.length;
        continue;
      }
      const width = WIDTH[kind] ?? 1;
      if (k + width > values.length) break;
      node.params[pname] = width === 1 ? values[k] : (values.slice(k, k + width) as number[]);
      k += width;
    }
    all.push(node);
    if (node.id >= 0) {
      byKey.set(`${node.type}_${node.id}`, node);
      if (!byId.has(node.id)) byId.set(node.id, node);
    }
    for (const c of rest) {
      if (!isCall(c)) continue;
      const child = build(c, node);
      if (child) node.children.push(child);
    }
    return node;
  };

  const roots: TaskNode[] = [];
  for (const s of statements) {
    const n = build(s, null);
    if (n) roots.push(n);
  }
  return { roots, all, byKey, byId, schema };
}

function isCall(v: QvmValue): v is QvmCall {
  return typeof v === "object" && "fn" in v;
}

/** TRUE/FALSE identifiers become booleans; numbers and strings stay as they are. */
function plain(v: QvmValue): ParamValue {
  if (typeof v === "number" || typeof v === "string") return v;
  if ("ident" in v) {
    if (v.ident === "TRUE") return true;
    if (v.ident === "FALSE") return false;
    return v.ident;
  }
  return 0;
}

// Typed parameter access.
export const pnum = (t: TaskNode, name: string, fallback = 0): number => {
  const v = t.params[name];
  return typeof v === "number" ? v : typeof v === "boolean" ? Number(v) : fallback;
};
export const pstr = (t: TaskNode, name: string): string => {
  const v = t.params[name];
  return typeof v === "string" ? v : "";
};
export const pbool = (t: TaskNode, name: string): boolean => {
  const v = t.params[name];
  return v === true || (typeof v === "number" && v !== 0);
};
export const pvec = (t: TaskNode, name: string): [number, number, number] => {
  const v = t.params[name];
  return Array.isArray(v) && v.length >= 3 ? [v[0], v[1], v[2]] : [0, 0, 0];
};
