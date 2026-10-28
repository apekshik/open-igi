// Evaluator for the condition strings in level tasks ("CutScene_1200.nTick > 11.5*GAME_FREQUENCY && !X_5.isRun").
//
// Three-valued: a variable the resolver does not know makes the sub-expression `undefined`; `&&` with a known false and
// `||` with a known true still decide. Callers treat an undefined result as "not active".

export type Resolve = (name: string) => number | boolean | undefined;
type Node = (r: Resolve) => number | undefined;

const cache = new Map<string, Node>();

export function evalCondition(src: string, resolve: Resolve): number | undefined {
  let node = cache.get(src);
  if (!node) {
    try {
      node = parse(src);
    } catch {
      node = () => undefined;
    }
    cache.set(src, node);
  }
  return node(resolve);
}

/** Names of the variables an expression reads (for debugging and dependency checks). */
export function conditionVariables(src: string): string[] {
  return [...src.matchAll(/[A-Za-z_][\w]*(?:\.[\w]+)*/g)].map((m) => m[0]).filter((n) => !CONSTANTS.has(n));
}

export const GAME_FREQUENCY = 30;
const CONSTANTS = new Set(["TRUE", "FALSE", "GAME_FREQUENCY"]);

const TOKEN = /\s*(?:(\d+\.?\d*(?:e[+-]?\d+)?)|([A-Za-z_][\w]*(?:\.[\w]+)*)|(\|\||&&|==|!=|<=|>=|[<>!+\-*/()]))/gy;

function parse(src: string): Node {
  const toks: { n?: number; id?: string; op?: string }[] = [];
  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  let end = 0;
  while ((m = TOKEN.exec(src))) {
    end = TOKEN.lastIndex;
    toks.push(m[1] !== undefined ? { n: Number(m[1]) } : m[2] !== undefined ? { id: m[2] } : { op: m[3] });
  }
  if (src.slice(end).trim()) throw new Error("bad token");
  let i = 0;
  const peekOp = (...ops: string[]) => (toks[i]?.op !== undefined && ops.includes(toks[i].op!) ? toks[i].op! : null);

  const binary = (next: () => Node, ops: string[], apply: (op: string, a: number, b: number) => number): Node => {
    let left = next();
    for (let op = peekOp(...ops); op; op = peekOp(...ops)) {
      i++;
      const l = left;
      const r = next();
      left = (res) => {
        const a = l(res);
        const b = r(res);
        return a === undefined || b === undefined ? undefined : apply(op, a, b);
      };
    }
    return left;
  };

  const primary = (): Node => {
    const t = toks[i++];
    if (!t) throw new Error("unexpected end");
    if (t.n !== undefined) {
      const v = t.n;
      return () => v;
    }
    if (t.id !== undefined) {
      const id = t.id;
      if (id === "TRUE") return () => 1;
      if (id === "FALSE") return () => 0;
      if (id === "GAME_FREQUENCY") return (res) => {
        const v = res(id);
        return v === undefined ? GAME_FREQUENCY : Number(v);
      };
      return (res) => {
        const v = res(id);
        return v === undefined ? undefined : Number(v);
      };
    }
    if (t.op === "(") {
      const e = or();
      if (toks[i++]?.op !== ")") throw new Error("expected )");
      return e;
    }
    throw new Error("unexpected " + t.op);
  };
  const unary = (): Node => {
    const op = peekOp("!", "-", "+");
    if (!op) return primary();
    i++;
    const e = unary();
    return (res) => {
      const v = e(res);
      return v === undefined ? undefined : op === "!" ? (v ? 0 : 1) : op === "-" ? -v : v;
    };
  };
  const mul = () => binary(unary, ["*", "/"], (o, a, b) => (o === "*" ? a * b : a / b));
  const add = () => binary(mul, ["+", "-"], (o, a, b) => (o === "+" ? a + b : a - b));
  const rel = () => binary(add, ["<", ">", "<=", ">="], (o, a, b) => Number(o === "<" ? a < b : o === ">" ? a > b : o === "<=" ? a <= b : a >= b));
  const eq = () => binary(rel, ["==", "!="], (o, a, b) => Number(o === "==" ? a === b : a !== b));
  const and = (): Node => {
    let left = eq();
    while (peekOp("&&")) {
      i++;
      const l = left;
      const r = eq();
      left = (res) => {
        const a = l(res);
        if (a === 0) return 0;
        const b = r(res);
        if (b === 0) return 0;
        return a === undefined || b === undefined ? undefined : 1;
      };
    }
    return left;
  };
  const or = (): Node => {
    let left = and();
    while (peekOp("||")) {
      i++;
      const l = left;
      const r = and();
      left = (res) => {
        const a = l(res);
        if (a !== undefined && a !== 0) return 1;
        const b = r(res);
        if (b !== undefined && b !== 0) return 1;
        return a === undefined || b === undefined ? undefined : 0;
      };
    }
    return left;
  };
  const root = or();
  if (i < toks.length) throw new Error("trailing tokens");
  return root;
}
