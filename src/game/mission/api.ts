import type { Vec3 } from "../coords.ts";

export interface Objective {
  text: string;
  state: "active" | "completed" | "failed";
  /** Text key in objectives.res (e.g. "M1_OBJ1"). */
  key: string;
  /** Stable index (matches `objective` events). */
  index: number;
  /** World position of the map location the objective links to, if any (map computer marker). */
  position: Vec3 | null;
}

/** What the use key (F) would do right now, for the HUD prompt and progress bar. */
export interface UsePrompt {
  text: string;
  /** 0..1 while the key is held on a timed action (hacking, picking a lock, placing C4), otherwise 0. */
  progress: number;
  taskId: number;
}

/** Where a riding character sits now (MissionService.rider). */
export interface RiderSeat {
  /** Feet position, IGI units. */
  position: Vec3;
  yaw: number;
  /** The vehicle is not in play: the rider is not shown. */
  hidden?: boolean;
  /** Body axes (right, forward, up) in IGI space, when the vehicle pitches or banks the rider with it. */
  basis?: [Vec3, Vec3, Vec3];
}

/** A rigid pose in absolute IGI units: origin and model axes. */
export interface CarrierPose {
  origin: Vec3;
  axes: [Vec3, Vec3, Vec3];
}

export interface MissionService {
  /** Mission number (1..14), title and description from the language files. */
  number: number;
  title: string;
  description: string;
  /** The intro dialogue (M<n>_CUT_* lines), joined by newlines. */
  briefing: string;
  briefingLines: string[];
  /** Objectives currently listed on the map computer (the valid DefineComputerObjective groups). */
  objectives(): Objective[];
  /** Seconds since mission start (logic time). */
  elapsed(): number;
  /** An AlarmControl in the level is in alarm. */
  alarm(): boolean;
  /** A scripted cutscene is playing (the player is frozen and the camera is scripted). */
  cutscene(): boolean;
  /** Set once the level is won or lost. */
  ended(): { success: boolean; reason: string } | null;
  /** Current use prompt, or null when nothing usable is in reach. */
  prompt(): UsePrompt | null;
  /** Text by key from the language files (messages, objectives, menus), or undefined. */
  text(key: string): string | undefined;
  /**
   * Evaluate a QSC expression against the level's live task state, e.g. a Fence's "Electric Expression" or an
   * AIStationaryGunHolder's "On expression". `selfTaskId` binds `this`.
   */
  evaluate(expression: string, selfTaskId?: number): number | string;
  /** Write a task variable from an AI script (`EditVariable_173.nValue = 2`). Unknown or read-only names are ignored. */
  assign?(name: string, value: number): void;
  /**
   * A cutscene character riding a vehicle (its HumanSoldier inside a Heli/Car/Plane/Train task, or its AI graph in
   * one): a function giving its seat now (feet position and heading; `hidden` while the vehicle is not in play), or
   * null if it rides nothing. `aiId` is its HumanAI task id.
   */
  rider?(aiId: number): (() => RiderSeat) | null;
  /**
   * A vehicle that carries things placed inside its task (Placement.carrier: a Heli/Car/Plane task id, or a train's
   * locomotive id and car index): where the level places it and where it is now (null while it is not in play).
   */
  carrier?(task: number, car: number): { reference: CarrierPose; current: CarrierPose | null } | null;
  /** Let an entity (an AI soldier) use a door or switch by task id. Returns false if not usable now. */
  use(entityId: number, taskId: number): boolean;
  /** Alarm pads (switches that set off an AlarmControl), for AI soldiers running to raise the alarm. */
  alarmPads(): { taskId: number; position: Vec3 }[];
  /**
   * A door's state by its entity id (entities of kind "door"; most Door tasks have no task id), or null for other
   * entities and doors whose task is not in play: `open` 0 (closed) .. 1 (open), `moving` -1 closing / 0 / 1 opening.
   */
  door(entityId: number): { open: number; moving: number; locked: boolean } | null;
  /** An AI soldier opens a door by entity id (as the use key does, without picking locks). False if it cannot. */
  openDoor(userEntityId: number, doorEntityId: number): boolean;
}

// Events the mission system emits, in addition to objective/alarm/message/mission:end/pickup (events.ts).
declare module "../events.ts" {
  interface GameEvents {
    /** StatusMessageScreen_ClearMessages(): scripts clear the message list when gameplay starts. */
    "status:clear": Record<string, never>;
    /**
     * An objects.qvm object exploded (ExplodeObject, Terminal, Generator, ...). Radii in world units. The mission
     * system turns it into a weapons-system blast (damage, effects, "explosion" and "noise" events).
     */
    "object:explode": {
      taskId: number;
      position: Vec3;
      radius: number;
      falloff: number;
      /** Damage at the centre as the level's "Explosion damage scale" x 100 (100 = a full health bar). */
      damage: number;
      sound: string;
      fragments: number;
      fireballs: number;
    };
    /** A door started moving; `sound` is its Open/Close sound name from objects.qvm. */
    "door:move": { taskId: number; opening: boolean; sound: string; position: Vec3 };
    "door:open": { taskId: number };
    "door:close": { taskId: number };
    "switch:press": { taskId: number; position: Vec3 };
    generator: { taskId: number; on: boolean; sound: string };
    elevator: { taskId: number; moving: boolean; sound: string };
    /** A sound the mission scripts ask for (StatusMessage "Sound", by SoundDef name); played by the mission system. */
    "mission:sound": { sound: string; position: Vec3 | null };
    /** Cutscene playback started or stopped (the HUD hides, letterbox shows). */
    cutscene: { active: boolean; taskId: number };
  }
}
