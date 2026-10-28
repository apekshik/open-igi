// Decode compiled QSC scripts (.qvm).
// Usage: npm run qvm -- <file.qvm>            print the script as QSC-like source
//        npm run qvm -- <file.qvm> --asm      print the raw disassembly
//        npm run qvm -- <dir>                 decode every .qvm under <dir>, report decoded/total and failures
// Output goes to stdout only; decoded scripts are game data, so keep them out of the repo (out/ is gitignored).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { decodeQvmScript, disassembleQvm, formatQvm, formatQvmValue, QVM_OPCODES } from "../src/formats/qvm.ts";

const path = process.argv[2];
const asm = process.argv.includes("--asm");
if (!path) {
  console.error("usage: qvm <file.qvm | dir> [--asm]");
  process.exit(1);
}

if (statSync(path).isDirectory()) {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.toLowerCase().endsWith(".qvm")) files.push(p);
    }
  };
  walk(path);
  const opcodes = new Map<string, number>();
  const failures: string[] = [];
  let decoded = 0;
  for (const file of files) {
    const bytes = new Uint8Array(readFileSync(file));
    try {
      for (const ins of disassembleQvm(bytes).code) opcodes.set(ins.name, (opcodes.get(ins.name) ?? 0) + 1);
      decodeQvmScript(bytes);
      decoded++;
    } catch (e) {
      failures.push(`  ${relative(path, file)}: ${(e as Error).message}`);
    }
  }
  if (failures.length) console.log(`failures:\n${failures.join("\n")}`);
  const used = QVM_OPCODES.filter((n) => opcodes.has(n));
  console.log(`opcodes used (${used.length}): ${used.map((n) => `${n} ${opcodes.get(n)}`).join(", ")}`);
  console.log(`decoded ${decoded}/${files.length}`);
  process.exit(failures.length ? 1 : 0);
}

const bytes = new Uint8Array(readFileSync(path));
if (asm) {
  const { idents, strings, code } = disassembleQvm(bytes);
  for (const ins of code) {
    let operand = "";
    if (ins.name.startsWith("PUSHSI")) operand = `${ins.operand}  ; ${JSON.stringify(strings[ins.operand!])}`;
    else if (ins.name.startsWith("PUSHII")) operand = `${ins.operand}  ; ${idents[ins.operand!]}`;
    else if (ins.text !== undefined) operand = JSON.stringify(ins.text);
    else if (ins.name === "CALL") operand = `${ins.operand}  [${ins.args!.join(", ")}]`;
    else if (ins.name === "BRA" || ins.name === "BF" || ins.name === "BT") operand = `-> ${ins.operand}`;
    else if (ins.operand !== undefined) operand = formatQvmValue(ins.operand);
    console.log(`${String(ins.at).padStart(6)}  ${ins.name.padEnd(8)} ${operand}`);
  }
} else {
  console.log(formatQvm(decodeQvmScript(bytes).body));
}
