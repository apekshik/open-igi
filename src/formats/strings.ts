// Text archives: language/<lang>/{missions,objectives,messages,computer,menusystem,movies}.res. See
// docs/formats/mission.md.
//
// They are IRES archives, but instead of NAME/BODY file pairs every entry is a NAME chunk (the key) followed by a
// CSTR chunk (the text, Latin-1, NUL-terminated):
//
//   NAME "M1_OBJ1\0"        CSTR "Steal the truck near the main entrance.\0"
//   NAME "LOCAL:english/Mission 1 Name\0"        CSTR "Trainyard\0"
//
// missions.res and menusystem.res prefix their keys with "LOCAL:<language>/", and end with a PATH chunk (named after
// the prefix) that lists every key joined by ';'. Scripts refer to the keys without the prefix ("Mission 1 Name" in
// mission.qvm, M1_MSG_4 in objects.qvm StatusMessage tasks), so readStrings() strips it.

import { parseIlff } from "./ilff.ts";

/** Decode one text archive into key → text. Keys keep their case; the "LOCAL:<lang>/" prefix is removed. */
export function readStrings(bytes: Uint8Array): Map<string, string> {
  const file = parseIlff(bytes);
  if (file.formType !== "IRES") throw new Error(`expected IRES form, got ${file.formType}`);
  const out = new Map<string, string>();
  let name: string | null = null;
  for (const c of file.chunks) {
    if (c.tag === "NAME") name = latin1(c.data);
    else if (c.tag === "CSTR" && name !== null) {
      out.set(stripLocal(name), latin1(c.data));
      name = null;
    } else name = null; // PATH: the key index, not text
  }
  return out;
}

/** "LOCAL:english/Mission 1 Name" → "Mission 1 Name". */
export function stripLocal(key: string): string {
  return key.replace(/^LOCAL:[^/]*\//i, "");
}

function latin1(data: Uint8Array): string {
  let end = data.indexOf(0);
  if (end < 0) end = data.length;
  let s = "";
  for (let i = 0; i < end; i++) s += String.fromCharCode(data[i]);
  return s;
}
