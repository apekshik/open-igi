export interface HudService {
  /** Show a short message (also triggered by "message" events). */
  message(text: string, seconds?: number): void;
  /** Hide all HUD (cutscenes, map computer). */
  visible: boolean;
}
