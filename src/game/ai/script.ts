// Runs IGI's AI scripts. Every HumanAI has missions/location0/<level>/ai/<HumanAI id>.qvm and every AI type a shared
// common/ai/<type>.qvm. Both are if/else chains on `AIFunction_GetCurrentEventType() == AIEVENT_*` that call
// AIFunction_* (queries and settings) and AIAction_* (queue an action). A level script usually handles CREATE, IDLE
// (start its patrol) and ALARMON (run to an alarm position) and passes everything else to
// AIFunction_DefaultHandler(), which runs the type's common script for the same event.
//
// This is a tree-walking evaluator over the AST from decodeQvmScript (src/formats/qvm.ts). The engine side (the
// AIFunction_/AIAction_ implementations) is supplied by the soldier as a table of handlers.
import type { QvmScript, QvmStmt, QvmValue } from "../../formats/qvm.ts";

export type ScriptValue = number | string;

/** Native functions by name; unknown calls evaluate to 0. */
export type ScriptNatives = Record<string, (...args: ScriptValue[]) => ScriptValue | void>;

const CONSTANTS: Record<string, ScriptValue> = {
  TRUE: 1,
  FALSE: 0,
  WORLD_METER: 4096,
  AIACTIONFLAG_NONE: 0,
  AIACTIONFLAG_PUSHABLE: 1,
};

/** Run a script's body. Identifiers that are not natives or constants evaluate to their own name (AIEVENT_*, ...). */
export function runScript(
  script: QvmScript,
  natives: ScriptNatives,
  variable?: (name: string) => ScriptValue,
  assign?: (name: string, value: ScriptValue) => void,
) {
  const value = (v: QvmValue): ScriptValue => {
    if (typeof v === "number" || typeof v === "string") return v;
    if ("ident" in v) {
      if (v.ident in CONSTANTS) return CONSTANTS[v.ident];
      if (/^[A-Z][A-Z0-9_]*$/.test(v.ident)) return v.ident;
      return variable?.(v.ident) ?? 0;
    }
    if ("fn" in v) {
      const f = natives[v.fn];
      const result = f ? f(...v.args.map(value)) : undefined;
      return result ?? 0;
    }
    if ("unary" in v) {
      const a = value(v.arg);
      const n = typeof a === "number" ? a : 0;
      return v.unary === "-" ? -n : v.unary === "!" ? Number(!a) : v.unary === "~" ? ~n : n;
    }
    // Short-circuit the logical operators, as the bytecode does.
    if (v.binary === "&&") return Number(truthy(value(v.left)) && truthy(value(v.right)));
    if (v.binary === "||") return Number(truthy(value(v.left)) || truthy(value(v.right)));
    if (v.binary === "=") {
      // Level scripts also write mission variables: level10's Priboi sets `EditVariable_173.nValue = 2` after taking
      // patrol path 619, so that his next IDLE moves on to the next path.
      const r = value(v.right);
      if (typeof v.left === "object" && "ident" in v.left) assign?.(v.left.ident, r);
      return r;
    }
    const a = value(v.left), b = value(v.right);
    if (v.binary === "==") return Number(a === b);
    if (v.binary === "!=") return Number(a !== b);
    const x = Number(a), y = Number(b);
    switch (v.binary) {
      case "+": return x + y;
      case "-": return x - y;
      case "*": return x * y;
      case "/": return y ? x / y : 0;
      case "<<": return x << y;
      case ">>": return x >> y;
      case "&": return x & y;
      case "|": return x | y;
      case "^": return x ^ y;
      case "<": return Number(x < y);
      case "<=": return Number(x <= y);
      case ">": return Number(x > y);
      case ">=": return Number(x >= y);
    }
    return 0;
  };
  const run = (body: QvmStmt[]) => {
    for (const s of body) {
      if (s.kind === "expr") value(s.expr);
      else if (truthy(value(s.cond))) run(s.then);
      else if (s.else) run(s.else);
    }
  };
  run(script.body);
}

const truthy = (v: ScriptValue) => (typeof v === "number" ? v !== 0 : v !== "");
