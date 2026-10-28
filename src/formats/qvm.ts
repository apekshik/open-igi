// .qvm: compiled QSC script ("LOOP" version 8). See docs/FORMATS.md.
//
//   header  "LOOP" u32 version(8) u32 ?(5)
//           u32 identTable, u32 identPool, u32 identTableSize, u32 identPoolSize
//           u32 stringTable, u32 stringPool, u32 stringTableSize, u32 stringPoolSize
//           u32 code, u32 codeSize
//   tables  u32 offsets into their NUL-terminated string pools
//
// Code is a sequence of statements `call 12`, ending with 00. Covered so far: the declarative subset used by
// objects.qvm, ammo and weapon definitions (calls, literals, negation). Control flow in AI scripts is still unknown.

export type QvmValue = number | string | QvmIdent | QvmCall;

export interface QvmIdent {
  ident: string;
}

export interface QvmCall {
  fn: string;
  args: QvmValue[];
}

const OP_END = 0x00;
const OP_INT8 = 0x03;
const OP_INT16 = 0x04;
const OP_FLOAT = 0x05;
const OP_STR8 = 0x09;
const OP_STR16 = 0x0a;
const OP_IDENT = 0x0d;
const OP_ZERO = 0x0f;
const OP_ONE = 0x10;
const OP_STMT_END = 0x12;
const OP_ARGBYTES = 0x14;
const OP_ARGLIST = 0x18;
const OP_NEG = 0x2c;

export function decodeQvm(bytes: Uint8Array): QvmCall[] {
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
  const idents = table(u32(0x0c), u32(0x10), u32(0x14));
  const strings = table(u32(0x1c), u32(0x20), u32(0x24));
  const code = u32(0x2c);
  const codeEnd = code + u32(0x30);

  // An argument list: OP_ARGLIST u32 n, u32 argStart[n] (relative to code), OP_ARGBYTES u32 total, args.
  function call(at: number): { call: QvmCall; end: number } {
    const fn = idents[bytes[at + 1]];
    const n = u32(at + 3);
    const starts: number[] = [];
    for (let k = 0; k < n; k++) starts.push(code + u32(at + 7 + k * 4));
    const after = at + 7 + n * 4;
    if (bytes[after] !== OP_ARGBYTES) throw new Error(`malformed argument list at ${at - code}`);
    const end = after + 5 + u32(after + 1);
    const args = starts.map((s, k) => expr(s, k + 1 < n ? starts[k + 1] : end));
    return { call: { fn, args }, end };
  }

  // One argument: a little stack program terminated by OP_END.
  function expr(at: number, end: number): QvmValue {
    const stack: QvmValue[] = [];
    while (at < end) {
      const op = bytes[at];
      if (op === OP_END) break;
      switch (op) {
        case OP_INT8:
          stack.push(view.getInt8(at + 1));
          at += 2;
          break;
        case OP_INT16:
          stack.push(view.getInt16(at + 1, true));
          at += 3;
          break;
        case OP_FLOAT:
          stack.push(view.getFloat32(at + 1, true));
          at += 5;
          break;
        case OP_STR8:
          stack.push(strings[bytes[at + 1]]);
          at += 2;
          break;
        case OP_STR16:
          stack.push(strings[view.getUint16(at + 1, true)]);
          at += 3;
          break;
        case OP_ZERO:
          stack.push(0);
          at += 1;
          break;
        case OP_ONE:
          stack.push(1);
          at += 1;
          break;
        case OP_NEG: {
          const v = stack.pop();
          if (typeof v !== "number") throw new Error(`negating a non-number at ${at - code}`);
          stack.push(-v);
          at += 1;
          break;
        }
        case OP_IDENT:
          if (bytes[at + 2] === OP_ARGLIST) {
            const r = call(at);
            stack.push(r.call);
            at = r.end;
          } else {
            stack.push({ ident: idents[bytes[at + 1]] });
            at += 2;
          }
          break;
        default:
          throw new Error(`unknown opcode 0x${op.toString(16)} at ${at - code}`);
      }
    }
    if (stack.length !== 1) throw new Error(`argument left ${stack.length} values on the stack`);
    return stack[0];
  }

  const statements: QvmCall[] = [];
  let at = code;
  while (at < codeEnd && bytes[at] !== OP_END) {
    if (bytes[at] !== OP_IDENT || bytes[at + 2] !== OP_ARGLIST) throw new Error(`unexpected byte at ${at - code}`);
    const r = call(at);
    statements.push(r.call);
    at = r.end;
    if (bytes[at] !== OP_STMT_END) throw new Error(`statement not terminated at ${at - code}`);
    at++;
  }
  return statements;
}
