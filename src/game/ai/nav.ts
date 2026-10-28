// Navigation on an AI graph (src/formats/graph.ts): world-space nodes, nearest-node lookup and A* over the links.
// IGI ships a precomputed next-hop table with each graph; A* over the same links finds the same shortest paths and
// lets us route between arbitrary positions without it.
import type { AiGraph, GraphNode } from "../../formats/graph.ts";
import type { Vec3 } from "../coords.ts";

export interface NavNode {
  id: number;
  /** World position, IGI units. */
  position: Vec3;
  criteria: string;
  links: NavNode[];
}

export class NavGraph {
  readonly nodes = new Map<number, NavNode>();
  /** Nodes that have links (walkable), as opposed to look-at targets. */
  readonly walkable: NavNode[] = [];

  constructor(graph: AiGraph, origin: Vec3) {
    for (const n of graph.nodes) this.nodes.set(n.id, toNav(n, origin));
    for (const l of graph.links) {
      const a = this.nodes.get(l.a), b = this.nodes.get(l.b);
      if (!a || !b || a === b) continue;
      if (!a.links.includes(b)) a.links.push(b);
      if (!b.links.includes(a)) b.links.push(a);
    }
    for (const n of this.nodes.values()) if (n.links.length) this.walkable.push(n);
  }

  node(id: number): NavNode | undefined {
    return this.nodes.get(id);
  }

  /** Nearest walkable node to a position (height differences count triple, so floors stay apart). */
  nearest(p: Vec3, filter?: (n: NavNode) => boolean): NavNode | null {
    let best: NavNode | null = null;
    let bestD = Infinity;
    for (const n of this.walkable) {
      if (filter && !filter(n)) continue;
      const dx = n.position[0] - p[0], dy = n.position[1] - p[1], dz = (n.position[2] - p[2]) * 3;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  }

  /** Shortest node path from `from` to `to` (both included), or null if they are not connected. */
  path(from: NavNode, to: NavNode): NavNode[] | null {
    if (from === to) return [from];
    const g = new Map<NavNode, number>([[from, 0]]);
    const came = new Map<NavNode, NavNode>();
    const open: { n: NavNode; f: number }[] = [{ n: from, f: dist(from.position, to.position) }];
    const closed = new Set<NavNode>();
    while (open.length) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
      const { n } = open[bi];
      open.splice(bi, 1);
      if (n === to) {
        const out = [n];
        for (let c = came.get(n); c; c = came.get(c)) out.push(c);
        return out.reverse();
      }
      if (closed.has(n)) continue;
      closed.add(n);
      const gn = g.get(n)!;
      for (const m of n.links) {
        if (closed.has(m)) continue;
        const gm = gn + dist(n.position, m.position);
        if (gm >= (g.get(m) ?? Infinity)) continue;
        g.set(m, gm);
        came.set(m, n);
        open.push({ n: m, f: gm + dist(m.position, to.position) });
      }
    }
    return null;
  }

  /** Route between two world positions: positions of the nodes to visit, ending at `to` itself unless `finish` is false. */
  route(from: Vec3, to: Vec3, finish = true): Vec3[] {
    const a = this.nearest(from), b = this.nearest(to);
    if (!a || !b) return [to];
    const nodes = this.path(a, b);
    if (!nodes) return [to];
    const points = nodes.map((n) => n.position);
    // Skip the first node when it lies behind us on the way to the second.
    if (points.length > 1 && dist(from, points[1]) < dist(points[0], points[1])) points.shift();
    if (finish && dist(points[points.length - 1], to) > 1) points.push(to);
    return points;
  }
}

function toNav(n: GraphNode, origin: Vec3): NavNode {
  return {
    id: n.id,
    position: [origin[0] + n.position[0], origin[1] + n.position[1], origin[2] + n.position[2]],
    criteria: n.criteria,
    links: [],
  };
}

export const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
