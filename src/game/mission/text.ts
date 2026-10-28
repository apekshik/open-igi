// Mission text from the player's language files: titles, descriptions, briefing dialogue, objectives and messages.
import { decodeQvm } from "../../formats/qvm.ts";
import { readStrings } from "../../formats/strings.ts";
import type { Vfs } from "../../vfs/vfs.ts";
import { readMissionScript } from "./logic.ts";
import { pstr, taskTree, type TaskTree } from "./tasks.ts";

/** The archives under language/<lang>/, all merged into one key space (keys do not collide across files). */
const FILES = ["missions", "objectives", "messages", "computer", "menusystem", "movies"];

export type Strings = Map<string, string>;

const cache = new WeakMap<Vfs, Map<string, Promise<Strings>>>();

/** Languages the install has text for ("english", "USA", "french", ...). */
export function languages(vfs: Vfs): string[] {
  const out = new Set<string>();
  for (const p of vfs.list()) {
    const m = /^language\/([^/]+)\/missions\.res$/i.exec(p);
    if (m) out.add(m[1]);
  }
  return [...out];
}

/** All text for a language (default: english, else USA, else the first one present). Cached per vfs. */
export function loadStrings(vfs: Vfs, language?: string): Promise<Strings> {
  const langs = languages(vfs);
  const lang =
    langs.find((l) => l.toLowerCase() === (language ?? "english").toLowerCase()) ??
    langs.find((l) => l.toLowerCase() === "english") ??
    langs.find((l) => l.toLowerCase() === "usa") ??
    langs[0] ??
    "english";
  let perVfs = cache.get(vfs);
  if (!perVfs) cache.set(vfs, (perVfs = new Map()));
  let p = perVfs.get(lang);
  if (!p) {
    p = (async () => {
      const out: Strings = new Map();
      for (const f of FILES) {
        const path = `language/${lang}/${f}.res`;
        if (!vfs.has(path)) continue;
        for (const [k, v] of readStrings(await vfs.read(path))) out.set(k, v);
      }
      return out;
    })();
    perVfs.set(lang, p);
  }
  return p;
}

export interface MissionInfo {
  /** "level1".."level14". */
  level: string;
  /** Mission number from mission.qvm's DefineMission. */
  number: number;
  title: string;
  description: string;
  /** Intro dialogue lines (M<n>_CUT_*), in order. */
  briefing: string[];
  /** Objective texts in the order the level defines them (every DefineComputerObjective group). */
  objectives: string[];
}

/** Mission number for "levelN" when mission.qvm is missing. */
const levelNumber = (level: string) => Number(/(\d+)$/.exec(level)?.[1] ?? 0);

/**
 * Title, description, briefing and objective texts for one level. Reads mission.qvm and (for objectives)
 * objects.qvm, so pass `tree` when the level's task tree is already decoded.
 */
export async function missionInfo(vfs: Vfs, level: string, options: { language?: string; tree?: TaskTree } = {}): Promise<MissionInfo> {
  const strings = await loadStrings(vfs, options.language);
  const dir = `missions/location0/${level}`;
  const def = vfs.has(`${dir}/mission.qvm`) ? readMissionScript(await vfs.read(`${dir}/mission.qvm`)) : null;
  const number = def?.number ?? levelNumber(level);
  const tree = options.tree ?? (vfs.has(`${dir}/objects.qvm`) ? taskTree(decodeQvm(await vfs.read(`${dir}/objects.qvm`))) : null);
  const objectives: string[] = [];
  const seen = new Set<string>();
  for (const t of tree?.all ?? []) {
    if (t.type !== "DefineComputerObjective") continue;
    for (let i = 1; i <= 6; i++) {
      const key = pstr(t, `Objective ${i} Text Resource`).trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      objectives.push(strings.get(key) ?? key);
    }
  }
  return {
    level,
    number,
    title: strings.get(def?.name ?? `Mission ${number} Name`) ?? `Mission ${number}`,
    description: strings.get(def?.desc ?? `Mission ${number} Desc`) ?? "",
    briefing: briefingLines(strings, number),
    objectives,
  };
}

/** The intro cutscene dialogue for mission `n`: M<n>_CUT_01, _02, ... */
export function briefingLines(strings: Strings, n: number): string[] {
  const keys = [...strings.keys()].filter((k) => new RegExp(`^M${n}_CUT_\\d+$`).test(k));
  keys.sort((a, b) => Number(a.split("_").pop()) - Number(b.split("_").pop()));
  return keys.map((k) => strings.get(k)!);
}

/** Every mission in the install (level1..level14), in mission order. */
export async function missionList(vfs: Vfs, language?: string): Promise<MissionInfo[]> {
  const levels = new Set<string>();
  for (const p of vfs.list()) {
    const m = /^missions\/location0\/(level\d+)\/mission\.qvm$/i.exec(p);
    if (m) levels.add(m[1].toLowerCase());
  }
  const infos = await Promise.all([...levels].map((l) => missionInfo(vfs, l, { language })));
  return infos.sort((a, b) => a.number - b.number);
}
