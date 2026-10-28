// The 14 missions as the front end lists them: names and one-line descriptions from the language files
// (language/<lang>/missions.res, the strings the original mission-select screen shows), the mission picture from
// menusystem/missionsprites.res, and the briefing text once the mission system can provide it.
import { readStrings } from "../game/hud/gfx.ts";
import { missionInfo } from "../game/mission/text.ts";
import type { Vfs } from "../vfs/vfs.ts";

export const MISSION_COUNT = 14;

export interface MissionEntry {
  /** 1..14 */
  number: number;
  /** "level1".."level14" */
  level: string;
  name: string;
  description: string;
}

export async function missionCatalog(vfs: Vfs, language = "english"): Promise<MissionEntry[]> {
  const path = `language/${language}/missions.res`;
  const strings = vfs.has(path) ? readStrings(await vfs.read(path)) : new Map<string, string>();
  return Array.from({ length: MISSION_COUNT }, (_, i) => ({
    number: i + 1,
    level: `level${i + 1}`,
    name: strings.get(`Mission ${i + 1} Name`) ?? `Mission ${i + 1}`,
    description: strings.get(`Mission ${i + 1} Desc`) ?? "",
  }));
}

/**
 * Briefing text for the loading screen (a two-line panel): the mission's description from mission.qvm's
 * DefineMission strings. Objectives are on the map computer's Objectives page.
 */
export async function missionBriefing(vfs: Vfs, mission: MissionEntry): Promise<string> {
  const info = await missionInfo(vfs, mission.level).catch(() => null);
  return info?.description || mission.description;
}
