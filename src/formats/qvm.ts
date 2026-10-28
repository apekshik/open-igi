// .qvm: compiled QSC script ("LOOP" version 8). See docs/FORMATS.md.
//
//   header  "LOOP" u32 version(8) u32 sectionCount(5)
//           u32 identTable, u32 identPool, u32 identTableSize, u32 identPoolSize
//           u32 stringTable, u32 stringPool, u32 stringTableSize, u32 stringPoolSize
//           u32 code, u32 codeSize, u32 valueStackSize(0), u32 typeStackSize(0)
//   tables  u32 offsets into their NUL-terminated string pools
//
// The code is a stack machine with one-byte opcodes and fixed-width operands. The opcode names and numbering follow
// flawme/igi-reverse-engineering (reverse/docs/03-scripting, MIT; see THIRD_PARTY.md), which reads them from IGI.exe.
// decodeQvmScript() lifts the bytecode back into a small QSC-like AST (expression statements and if/else); the retail
// compiler emits no loops or backward branches. formatQvm() prints that AST as readable source.

// ---------------------------------------------------------------------------------------------------------------- AST

export type QvmValue = number | string | QvmIdent | QvmCall | QvmUnary | QvmBinary;

/** A symbol: a native function, an engine constant (`TRUE`, `AIEVENT_IDLE`) or a variable (`EditVariable_173.nValue`). */
export interface QvmIdent {
  ident: string;
}

export interface QvmCall {
  fn: string;
  args: QvmValue[];
}

/** Prefix operator applied to a non-literal (negated number literals are folded into plain numbers). */
export interface QvmUnary {
  unary: "-" | "+" | "!" | "~";
  arg: QvmValue;
}

/** Infix operator. `=` is assignment; its left side is the variable being written. */
export interface QvmBinary {
  binary: QvmBinaryOp;
  left: QvmValue;
  right: QvmValue;
}

export type QvmBinaryOp =
  | "+" | "-" | "*" | "/" | "<<" | ">>" | "&" | "|" | "^" | "&&" | "||"
  | "==" | "!=" | "<" | "<=" | ">" | ">=" | "=";

export type QvmStmt =
  | { kind: "expr"; expr: QvmValue }
  | { kind: "if"; cond: QvmValue; then: QvmStmt[]; else: QvmStmt[] | null };

export interface QvmScript {
  idents: string[];
  strings: string[];
  body: QvmStmt[];
}

// ------------------------------------------------------------------------------------------------------------ opcodes

/** Opcode mnemonics by number. Names from IGI.exe's own table (stored there in reverse order). */
export const QVM_OPCODES = [
  "BRK", "NOP", "PUSH", "PUSHB", "PUSHW", "PUSHF", "PUSHA", "PUSHS", "PUSHSI", "PUSHSIB", "PUSHSIW", "PUSHI", "PUSHII",
  "PUSHIIB", "PUSHIIW", "PUSH0", "PUSH1", "PUSHM", "POP", "RET", "BRA", "BF", "BT", "JSR", "CALL", "ADD", "SUB", "MUL",
  "DIV", "SHL", "SHR", "AND", "OR", "XOR", "LAND", "LOR", "EQ", "NE", "LT", "LE", "GT", "GE", "ASSIGN", "PLUS", "MINUS",
  "INV", "NOT", "BLK", "ILLEGAL",
] as const;

const OP = {
  BRK: 0x00, NOP: 0x01, PUSH: 0x02, PUSHB: 0x03, PUSHW: 0x04, PUSHF: 0x05, PUSHA: 0x06, PUSHS: 0x07, PUSHSI: 0x08,
  PUSHSIB: 0x09, PUSHSIW: 0x0a, PUSHI: 0x0b, PUSHII: 0x0c, PUSHIIB: 0x0d, PUSHIIW: 0x0e, PUSH0: 0x0f, PUSH1: 0x10,
  PUSHM: 0x11, POP: 0x12, RET: 0x13, BRA: 0x14, BF: 0x15, BT: 0x16, JSR: 0x17, CALL: 0x18,
  ASSIGN: 0x2a, PLUS: 0x2b, MINUS: 0x2c, INV: 0x2d, NOT: 0x2e,
} as const;

/** ADD (0x19) .. GE (0x29), in opcode order. */
const BINARY_OPS: QvmBinaryOp[] = ["+", "-", "*", "/", "<<", ">>", "&", "|", "^", "&&", "||", "==", "!=", "<", "<=", ">", ">="];

/** Operand width in bytes for every opcode except the variable-width ones (PUSHS, PUSHI: inline C string; CALL). */
function operandWidth(op: number): number {
  switch (op) {
    case OP.PUSHB: case OP.PUSHSIB: case OP.PUSHIIB:
      return 1;
    case OP.PUSHW: case OP.PUSHSIW: case OP.PUSHIIW:
      return 2;
    case OP.PUSH: case OP.PUSHF: case OP.PUSHA: case OP.PUSHSI: case OP.PUSHII: case OP.BRA: case OP.BF: case OP.BT:
      return 4;
    default:
      return 0;
  }
}

// ------------------------------------------------------------------------------------------------------------ reading

interface QvmFile {
  bytes: Uint8Array;
  view: DataView;
  idents: string[];
  strings: string[];
  code: number;
  codeSize: number;
}

function readQvm(bytes: Uint8Array): QvmFile {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== "LOOP" || view.getUint32(4, true) !== 8) throw new Error("not a version 8 QVM script");
  const u32 = (at: number) => view.getUint32(at, true);
  const cstr = (at: number) => {
    let s = "";
    for (let i = at; bytes[i] !== 0; i++) s += String.fromCharCode(bytes[i]);
    return s;
  };
  const table = (tableAt: number, poolAt: number, size: number) => {
    const out: string[] = [];
    for (let i = 0; i < size / 4; i++) out.push(cstr(poolAt + u32(tableAt + i * 4)));
    return out;
  };
  return {
    bytes,
    view,
    idents: table(u32(0x0c), u32(0x10), u32(0x14)),
    strings: table(u32(0x1c), u32(0x20), u32(0x24)),
    code: u32(0x2c),
    codeSize: u32(0x30),
  };
}

export interface QvmInstruction {
  /** Offset from the start of the code section. */
  at: number;
  op: number;
  name: string;
  /** Immediate operand: number, string/symbol index, or (for branches) the absolute code offset of the target. */
  operand?: number;
  /** CALL only: code offsets of the argument fragments. */
  args?: number[];
  /** PUSHS / PUSHI only: the inline string. */
  text?: string;
  size: number;
}

/** Decode the instruction at code offset `at`. */
function instruction(f: QvmFile, at: number): QvmInstruction {
  const { bytes, view } = f;
  const p = f.code + at;
  if (at < 0 || at >= f.codeSize) throw new Error(`code offset ${at} out of range`);
  const op = bytes[p];
  const name = QVM_OPCODES[op];
  if (name === undefined) throw new Error(`unknown opcode 0x${op.toString(16)} at ${at}`);
  const ins: QvmInstruction = { at, op, name, size: 1 + operandWidth(op) };
  switch (op) {
    case OP.PUSHB: ins.operand = view.getInt8(p + 1); break;
    case OP.PUSHW: ins.operand = view.getInt16(p + 1, true); break;
    case OP.PUSH: case OP.PUSHA: ins.operand = view.getInt32(p + 1, true); break;
    case OP.PUSHF: ins.operand = view.getFloat32(p + 1, true); break;
    case OP.PUSHSIB: case OP.PUSHIIB: ins.operand = bytes[p + 1]; break;
    case OP.PUSHSIW: case OP.PUSHIIW: ins.operand = view.getUint16(p + 1, true); break;
    case OP.PUSHSI: case OP.PUSHII: ins.operand = view.getUint32(p + 1, true); break;
    case OP.BRA: case OP.BF: case OP.BT: ins.operand = at + 5 + view.getInt32(p + 1, true); break;
    case OP.PUSHS: case OP.PUSHI: {
      let s = "";
      let i = p + 1;
      for (; bytes[i] !== 0; i++) s += String.fromCharCode(bytes[i]);
      ins.text = s;
      ins.size = i + 1 - p;
      break;
    }
    case OP.CALL: {
      const n = view.getUint32(p + 1, true);
      ins.operand = n;
      ins.args = [];
      for (let k = 0; k < n; k++) ins.args.push(view.getUint32(p + 5 + k * 4, true));
      ins.size = 5 + n * 4;
      break;
    }
  }
  if (at + ins.size > f.codeSize) throw new Error(`${name} at ${at} runs past the end of the code`);
  return ins;
}

/** Linear disassembly of the whole code section. */
export function disassembleQvm(bytes: Uint8Array): { idents: string[]; strings: string[]; code: QvmInstruction[] } {
  const f = readQvm(bytes);
  const code: QvmInstruction[] = [];
  for (let at = 0; at < f.codeSize; ) {
    const ins = instruction(f, at);
    code.push(ins);
    at += ins.size;
  }
  return { idents: f.idents, strings: f.strings, code };
}

// ---------------------------------------------------------------------------------------------------------- decoding

/**
 * Lift a script into statements. The retail compiler's output is very regular, and the decoder checks it strictly:
 *
 *   call       PUSHIIB fn  CALL n argStart[n]  BRA end  arg[0] … arg[n-1]  end:     arg := expr BRK
 *   stmt       expr POP
 *   if         cond BF else  then…  BRA end  else: else…  end:               (BRA end == else: no else branch)
 *   script     stmt* BRK
 *
 * Every byte of the code is accounted for exactly once; anything else throws.
 */
export function decodeQvmScript(bytes: Uint8Array): QvmScript {
  const f = readQvm(bytes);
  const { idents, strings } = f;

  const ident = (i: number) => {
    const s = idents[i];
    if (s === undefined) throw new Error(`symbol index ${i} out of range`);
    return s;
  };
  const string = (i: number) => {
    const s = strings[i];
    if (s === undefined) throw new Error(`string index ${i} out of range`);
    return s;
  };

  // Parse statements in [at, end). Returns the statements; `end` must be reached exactly.
  function block(at: number, end: number): QvmStmt[] {
    const out: QvmStmt[] = [];
    const stack: QvmValue[] = [];
    const take = (ins: QvmInstruction) => {
      const v = stack.pop();
      if (v === undefined) throw new Error(`${ins.name} at ${ins.at} on an empty stack`);
      return v;
    };
    while (at < end) {
      const ins = instruction(f, at);
      if (ins.op === OP.POP) {
        out.push({ kind: "expr", expr: take(ins) });
        if (stack.length) throw new Error(`statement at ${at} leaves ${stack.length} values on the stack`);
        at += ins.size;
      } else if (ins.op === OP.BF || ins.op === OP.BT) {
        const cond = take(ins);
        if (stack.length) throw new Error(`branch at ${at} with ${stack.length} extra values on the stack`);
        const elseAt = ins.operand!;
        const thenAt = at + ins.size;
        if (elseAt <= thenAt + 4 || elseAt > end) throw new Error(`branch at ${at} to ${elseAt} breaks the block structure`);
        const jump = instruction(f, elseAt - 5);
        if (jump.op !== OP.BRA) throw new Error(`if at ${at}: then-branch does not end in BRA`);
        const endAt = jump.operand!;
        if (endAt < elseAt || endAt > end) throw new Error(`if at ${at}: BRA at ${jump.at} to ${endAt} leaves the block`);
        const then = block(thenAt, elseAt - 5);
        const els = endAt > elseAt ? block(elseAt, endAt) : null;
        // BT (never emitted by the retail compiler) would branch on true; express it with a negated condition.
        out.push({ kind: "if", cond: ins.op === OP.BT ? { unary: "!", arg: cond } : cond, then, else: els });
        at = endAt;
      } else if (ins.op === OP.BRK || ins.op === OP.BRA) {
        throw new Error(`unexpected ${ins.name} at ${at}`);
      } else {
        at = expression(ins, stack);
      }
    }
    if (at !== end) throw new Error(`block overran its end at ${end}`);
    if (stack.length) throw new Error(`block ending at ${end} leaves ${stack.length} values on the stack`);
    return out;
  }

  // An argument fragment: an expression terminated by BRK. Returns the value and the offset after the BRK.
  function fragment(at: number): { value: QvmValue; end: number } {
    const stack: QvmValue[] = [];
    for (;;) {
      const ins = instruction(f, at);
      if (ins.op === OP.BRK) {
        if (stack.length !== 1) throw new Error(`argument ending at ${at} left ${stack.length} values on the stack`);
        return { value: stack[0], end: at + 1 };
      }
      if (ins.op === OP.POP || ins.op === OP.BRA || ins.op === OP.BF || ins.op === OP.BT) {
        throw new Error(`unexpected ${ins.name} inside an argument at ${at}`);
      }
      at = expression(ins, stack);
    }
  }

  // Execute one expression instruction against the symbolic stack. Returns the offset of the next instruction.
  function expression(ins: QvmInstruction, stack: QvmValue[]): number {
    const take = () => {
      const v = stack.pop();
      if (v === undefined) throw new Error(`${ins.name} at ${ins.at} on an empty stack`);
      return v;
    };
    const op = ins.op;
    switch (op) {
      case OP.PUSH: case OP.PUSHB: case OP.PUSHW: case OP.PUSHF:
        stack.push(ins.operand!);
        break;
      case OP.PUSH0: stack.push(0); break;
      case OP.PUSH1: stack.push(1); break;
      case OP.PUSHM: stack.push(-1); break;
      case OP.PUSHSI: case OP.PUSHSIB: case OP.PUSHSIW:
        stack.push(string(ins.operand!));
        break;
      case OP.PUSHS:
        stack.push(ins.text!);
        break;
      case OP.PUSHII: case OP.PUSHIIB: case OP.PUSHIIW:
        stack.push({ ident: ident(ins.operand!) });
        break;
      case OP.PUSHI:
        stack.push({ ident: ins.text! });
        break;
      case OP.CALL: {
        const callee = take();
        if (typeof callee !== "object" || !("ident" in callee)) throw new Error(`CALL at ${ins.at} on a non-symbol`);
        const skip = instruction(f, ins.at + ins.size);
        if (skip.op !== OP.BRA) throw new Error(`CALL at ${ins.at} is not followed by BRA`);
        let argAt = skip.at + skip.size;
        const args: QvmValue[] = [];
        for (const start of ins.args!) {
          if (start !== argAt) throw new Error(`CALL at ${ins.at}: argument at ${start}, expected ${argAt}`);
          const r = fragment(start);
          args.push(r.value);
          argAt = r.end;
        }
        if (argAt !== skip.operand) throw new Error(`CALL at ${ins.at}: arguments end at ${argAt}, BRA skips to ${skip.operand}`);
        stack.push({ fn: callee.ident, args });
        return argAt;
      }
      case OP.ASSIGN: {
        const right = take();
        const left = take();
        stack.push({ binary: "=", left, right });
        break;
      }
      case OP.MINUS: {
        const v = take();
        stack.push(typeof v === "number" ? -v : { unary: "-", arg: v });
        break;
      }
      case OP.PLUS: stack.push({ unary: "+", arg: take() }); break;
      case OP.NOT: stack.push({ unary: "!", arg: take() }); break;
      case OP.INV: stack.push({ unary: "~", arg: take() }); break;
      case OP.NOP: break;
      default: {
        const binary = BINARY_OPS[op - 0x19];
        if (op < 0x19 || binary === undefined) throw new Error(`unsupported opcode ${ins.name} at ${ins.at}`);
        const right = take();
        const left = take();
        stack.push({ binary, left, right });
      }
    }
    return ins.at + ins.size;
  }

  // The script is a block closed by a final BRK at the very end of the code.
  const last = f.codeSize - 1;
  if (f.codeSize < 1 || f.bytes[f.code + last] !== OP.BRK) throw new Error("code does not end in BRK");
  return { idents, strings, body: block(0, last) };
}

/**
 * The declarative subset used by objects.qvm, ammo and weapon definitions: a flat list of call statements.
 * Throws if the script contains anything else (control flow, assignments, bare expressions).
 */
export function decodeQvm(bytes: Uint8Array): QvmCall[] {
  return decodeQvmScript(bytes).body.map((s) => {
    if (s.kind !== "expr" || typeof s.expr !== "object" || !("fn" in s.expr)) {
      throw new Error("not a declarative script (statements other than calls)");
    }
    return s.expr;
  });
}

// ---------------------------------------------------------------------------------------------------------- printing

const PRECEDENCE: Record<QvmBinaryOp, number> = {
  "=": 1, "||": 2, "&&": 3, "|": 4, "^": 5, "&": 6, "==": 7, "!=": 7, "<": 8, "<=": 8, ">": 8, ">=": 8,
  "<<": 9, ">>": 9, "+": 10, "-": 10, "*": 11, "/": 11,
};
const UNARY_PRECEDENCE = 12;

function precedence(v: QvmValue): number {
  if (typeof v === "object" && "binary" in v) return PRECEDENCE[v.binary];
  if (typeof v === "object" && "unary" in v) return UNARY_PRECEDENCE;
  if (typeof v === "number" && v < 0) return UNARY_PRECEDENCE;
  return 99;
}

/** Print one value as QSC-like source. Numbers print as JS numbers: the AST does not keep int/float apart. */
export function formatQvmValue(v: QvmValue): string {
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : shortestFloat(v);
  if (typeof v === "string") return JSON.stringify(v);
  if ("ident" in v) return v.ident;
  if ("fn" in v) return `${v.fn}(${v.args.map(formatQvmValue).join(", ")})`;
  if ("unary" in v) {
    const a = formatQvmValue(v.arg);
    return v.unary + (precedence(v.arg) < UNARY_PRECEDENCE ? `(${a})` : a);
  }
  const p = PRECEDENCE[v.binary];
  // Left-associative, except assignment.
  const leftNeeds = v.binary === "=" ? precedence(v.left) <= p : precedence(v.left) < p;
  const rightNeeds = v.binary === "=" ? precedence(v.right) < p : precedence(v.right) <= p;
  const l = formatQvmValue(v.left);
  const r = formatQvmValue(v.right);
  return `${leftNeeds ? `(${l})` : l} ${v.binary} ${rightNeeds ? `(${r})` : r}`;
}

/** Shortest decimal that rounds to the same float32. */
function shortestFloat(v: number): string {
  for (let digits = 1; digits <= 9; digits++) {
    const s = v.toPrecision(digits);
    if (Math.fround(Number(s)) === v) return String(Number(s));
  }
  return String(v);
}

/** Print statements as indented QSC-like source. */
export function formatQvm(body: QvmStmt[], indent = ""): string {
  const lines: string[] = [];
  const emit = (stmts: QvmStmt[], pad: string) => {
    for (const s of stmts) {
      if (s.kind === "expr") {
        lines.push(`${pad}${formatQvmValue(s.expr)};`);
        continue;
      }
      // Fold `else { if … }` into `else if …`.
      let cur: QvmStmt & { kind: "if" } = s;
      lines.push(`${pad}if (${formatQvmValue(cur.cond)}) {`);
      for (;;) {
        emit(cur.then, pad + "  ");
        const e: QvmStmt[] | null = cur.else;
        if (e && e.length === 1 && e[0].kind === "if") {
          cur = e[0];
          lines.push(`${pad}} else if (${formatQvmValue(cur.cond)}) {`);
          continue;
        }
        if (e) {
          lines.push(`${pad}} else {`);
          emit(e, pad + "  ");
        }
        lines.push(`${pad}}`);
        break;
      }
    }
  };
  emit(body, indent);
  return lines.join("\n");
}
