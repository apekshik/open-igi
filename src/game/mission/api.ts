export interface Objective {
  text: string;
  state: "active" | "completed" | "failed";
}

export interface MissionService {
  /** Mission title and briefing text from the language files. */
  title: string;
  briefing: string;
  objectives(): Objective[];
  /** Seconds since mission start (LevelTimer etc.). */
  elapsed(): number;
}
