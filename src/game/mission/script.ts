// The mission scripting runtime: a small interpreter over the QSC AST from src/formats/qvm.ts, plus a parser for the
// expression strings that objects.qvm tasks carry in their VarString parameters ("EditVariable_105.nValue == 1",
// "CutScene_1204.nTick > 11.35*GAME_FREQUENCY", "MenuManager_SetEnabled(FALSE) && Game_DisableMusic()").
//
// IGI compiles those strings with the same QSC compiler as the .qvm files when a level loads; here they are parsed
// into the same QvmValue AST and evaluated against the live task state every logic tick. Values are numbers (C-style
// truthiness) or strings; native functions and identifiers are resolved by the caller's ScriptEnv.

import type { QvmBinaryOp, QvmStmt, QvmValue } from "../../formats/qvm.ts";

export type ScriptValue = number | string;

export interface ScriptEnv {
  /** Value of an identifier: a constant (TRUE, GAME_FREQUENCY), a task field (Door_408.isOpen) or a text key. */
  get(ident: string): ScriptValue;
  /** Assignment target (`x = …` statements). */
  set?(ident: string, value: ScriptValue): void;
  /** A native function call. Unknown functions should return 0 rather than throw. */
  call(fn: string, args: ScriptValue[]): ScriptValue;
}

const num = (v: ScriptValue) => (typeof v === "number" ? v : v === "" ? 0 : Number(v) || 0);
export const truthy = (v: ScriptValue) => (typeof v === "number" ? v !== 0 : v !== "");

/** Evaluate one AST value. `&&` and `||` short-circuit, comparisons give 1 or 0, x/0 gives 0. */
export function evaluate(v: QvmValue, env: ScriptEnv): ScriptValue {
  if (typeof v === "number" || typeof v === "string") return v;
  if ("ident" in v) return env.get(v.ident);
  if ("fn" in v) return env.call(v.fn, v.args.map((a) => evaluate(a, env)));
  if ("unary" in v) {
    const a = num(evaluate(v.arg, env));
    switch (v.unary) {
      case "-": return -a;
      case "+": return a;
      case "!": return a === 0 ? 1 : 0;
      case "~": return ~a;
    }
  }
  if (v.binary === "&&") return truthy(evaluate(v.left, env)) && truthy(evaluate(v.right, env)) ? 1 : 0;
  if (v.binary === "||") return truthy(evaluate(v.left, env)) || truthy(evaluate(v.right, env)) ? 1 : 0;
  if (v.binary === "=") {
    const value = evaluate(v.right, env);
    if (typeof v.left === "object" && "ident" in v.left) env.set?.(v.left.ident, value);
    return value;
  }
  const l = evaluate(v.left, env);
  const r = evaluate(v.right, env);
  if (typeof l === "string" && typeof r === "string") {
    if (v.binary === "==") return l === r ? 1 : 0;
    if (v.binary === "!=") return l !== r ? 1 : 0;
    if (v.binary === "+") return l + r;
  }
  return binary(v.binary, num(l), num(r));
}

function binary(op: QvmBinaryOp, a: number, b: number): number {
  switch (op) {
    case "+": return a + b;
    case "-": return a - b;
    case "*": return a * b;
    case "/": return b === 0 ? 0 : a / b;
    case "<<": return a << b;
    case ">>": return a >> b;
    case "&": return a & b;
    case "|": return a | b;
    case "^": return a ^ b;
    case "==": return a === b ? 1 : 0;
    case "!=": return a !== b ? 1 : 0;
    case "<": return a < b ? 1 : 0;
    case "<=": return a <= b ? 1 : 0;
    case ">": return a > b ? 1 : 0;
    case ">=": return a >= b ? 1 : 0;
    default: return 0;
  }
}

/** Run a decoded script body (expression statements and if/else). */
export function run(body: QvmStmt[], env: ScriptEnv) {
  for (const s of body) {
    if (s.kind === "expr") evaluate(s.expr, env);
    else if (truthy(evaluate(s.cond, env))) run(s.then, env);
    else if (s.else) run(s.else, env);
  }
}

// ------------------------------------------------------------------------------------------------ expression parser

/** Binary operators by precedence level, loosest first (C precedence; assignment is handled separately). */
const LEVELS: QvmBinaryOp[][] = [
  ["||"], ["&&"], ["|"], ["^"], ["&"], ["==", "!="], ["<", "<=", ">", ">="], ["<<", ">>"], ["+", "-"], ["*", "/"],
];

type Token = { t: "num"; v: number } | { t: "str"; v: string } | { t: "id"; v: string } | { t: "op"; v: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    // Two retail strings carry stray backticks (level5 LevelTimer_95, level10 ConditionalContainer_354); skip them
    // like whitespace so those tasks still work.
    if (/\s/.test(c) || c === "`") {
      i++;
    } else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^(0x[0-9a-f]+|\d*\.?\d+(e[+-]?\d+)?)f?/i.exec(src.slice(i))!;
      out.push({ t: "num", v: Number(m[1]) });
      i += m[0].length;
    } else if (/[A-Za-z_]/.test(c)) {
      // Identifiers include member access: "Door_408.isOpen", "this.nDoorOpenTicks".
      const m = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(src.slice(i))!;
      out.push({ t: "id", v: m[0] });
      i += m[0].length;
    } else if (c === '"') {
      const end = src.indexOf('"', i + 1);
      if (end < 0) throw new Error("unterminated string");
      out.push({ t: "str", v: src.slice(i + 1, end) });
      i = end + 1;
    } else {
      const two = src.slice(i, i + 2);
      const op = ["||", "&&", "==", "!=", "<=", ">=", "<<", ">>"].includes(two) ? two : c;
      if (!"+-*/<>=!~&|^(),".includes(op[0])) throw new Error(`unexpected character ${JSON.stringify(c)}`);
      out.push({ t: "op", v: op });
      i += op.length;
    }
  }
  return out;
}

/**
 * Parse one QSC expression string. A trailing ';' is allowed. Throws on syntax errors (some retail strings have them,
 * e.g. "Door_200.nDoorOpenTicks > * GAME_FREQUENCY"; the engine's compiler rejected those too).
 */
export function parseExpression(src: string): QvmValue {
  const tokens = tokenize(src.trim().replace(/;\s*$/, ""));
  let at = 0;
  const peek = () => tokens[at];
  const isOp = (v: string) => peek()?.t === "op" && peek()!.v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new Error(`expected '${v}'`);
    at++;
  };

  const assignment = (): QvmValue => {
    const left = level(0);
    if (isOp("=")) {
      at++;
      return { binary: "=", left, right: assignment() };
    }
    return left;
  };
  const level = (n: number): QvmValue => {
    if (n === LEVELS.length) return unary();
    let left = level(n + 1);
    for (;;) {
      const t = peek();
      if (t?.t !== "op" || !LEVELS[n].includes(t.v as QvmBinaryOp)) return left;
      at++;
      left = { binary: t.v as QvmBinaryOp, left, right: level(n + 1) };
    }
  };
  const unary = (): QvmValue => {
    const t = peek();
    if (t?.t === "op" && (t.v === "!" || t.v === "-" || t.v === "+" || t.v === "~")) {
      at++;
      const arg = unary();
      if (t.v === "-" && typeof arg === "number") return -arg;
      return { unary: t.v, arg };
    }
    return primary();
  };
  const primary = (): QvmValue => {
    const t = tokens[at++];
    if (!t) throw new Error("unexpected end of expression");
    if (t.t === "num" || t.t === "str") return t.v;
    if (t.t === "id") {
      if (!isOp("(")) return { ident: t.v };
      at++;
      const args: QvmValue[] = [];
      if (!isOp(")")) {
        for (;;) {
          args.push(assignment());
          if (!isOp(",")) break;
          at++;
        }
      }
      expect(")");
      return { fn: t.v, args };
    }
    if (t.v === "(") {
      const inner = assignment();
      expect(")");
      return inner;
    }
    throw new Error(`unexpected '${t.v}'`);
  };

  if (tokens.length === 0) return 0;
  const result = assignment();
  if (at < tokens.length) throw new Error(`unexpected '${(tokens[at] as { v: unknown }).v}'`);
  return result;
}

/** Every identifier an expression reads (for dependency research and tools). */
export function identifiers(v: QvmValue, out = new Set<string>()): Set<string> {
  if (typeof v !== "object") return out;
  if ("ident" in v) out.add(v.ident);
  else if ("fn" in v) v.args.forEach((a) => identifiers(a, out));
  else if ("unary" in v) identifiers(v.arg, out);
  else {
    identifiers(v.left, out);
    identifiers(v.right, out);
  }
  return out;
}
