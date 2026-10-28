// The front end: IGI's main menu, mission select, configuration, loading/briefing screen, and the in-game pause,
// game-over and mission-end screens around a running Game. Layouts follow menusystem/mainmenu.qvm and
// menusystem/ingamemenu.qvm (640x480 menu coordinates); pictures, fonts and frame sprites come from menusystem/*.res.
import { Game, type GameSystem } from "../game/game.ts";
import { UiAssets, type Sprite } from "../game/hud/gfx.ts";
import { DEFAULT_BINDINGS } from "../game/input.ts";
import { createSystems } from "../game/systems.ts";
import type { Vfs } from "../vfs/vfs.ts";
import { KeyBindings } from "./controls.ts";
import { Button, COLORS, Label, ListBox, MenuCanvas, Picture, ProgressBar, Slider, TextBlock, Toggle, Widget, type MenuTheme, type Page, type Rect } from "./menu.ts";
import { missionBriefing, missionCatalog, type MissionEntry } from "./missions.ts";
import { applySettings, defaultSettings, DETAIL_LEVELS, loadSettings, missionsUnlocked, saveSettings, unlockMission, type Settings } from "./settings.ts";
import { MenuAudio } from "./sound.ts";

const MENU_RES = "menusystem/menusystem.res";
const LOADING_RES = "menusystem/loadingscreen.res";
const MISSION_RES = "menusystem/missionsprites.res";
const STATUS_RES = "screens/game/status/status.res";

/** Main-menu screen frame (MenuScreen "Frame x0..y1" in mainmenu.qvm). */
const MAIN_PANEL: Rect = { x: 100, y: 163, w: 440, h: 307 };
/** In-game menu frame (ingamemenu.qvm). */
const INGAME_PANEL: Rect = { x: 85, y: 80, w: 470, h: 330 };

type State = "menu" | "loading" | "ready" | "playing" | "paused" | "over";

interface Stats {
  shots: number;
  hits: number;
  kills: number;
  alarms: number;
}

export class FrontEnd {
  private vfs: Vfs;
  private root = document.createElement("div");
  private gameHost = document.createElement("div");
  private status: (s: string) => void;
  private assets: UiAssets;
  private audio: MenuAudio;
  private menu!: MenuCanvas;
  private theme!: MenuTheme;
  private strings = new Map<string, string>();
  private missions: MissionEntry[] = [];
  private settings: Settings = loadSettings();
  private game: Game | null = null;
  private mission: MissionEntry | null = null;
  private state: State = "menu";
  private stats: Stats = { shots: 0, hits: 0, kills: 0, alarms: 0 };
  private mapWasOpen = false;
  /** A mission:end waiting to be shown: after a short delay, and only once the outro cutscene has played out. */
  private pendingEnd: { success: boolean; reason: string; wait: number } | null = null;
  private menuOpenedAt = 0;
  private loadToken = 0;
  private cleanup: (() => void)[] = [];

  constructor(vfs: Vfs, host: HTMLElement, status: (s: string) => void) {
    this.vfs = vfs;
    this.status = status;
    this.assets = new UiAssets(vfs);
    this.audio = new MenuAudio(vfs);
    this.audio.setVolumes(this.settings.musicVolume, this.settings.fxVolume);
    this.root.style.cssText = "position:absolute;inset:0;overflow:hidden;background:#000";
    this.gameHost.style.cssText = "position:absolute;inset:0";
    this.root.append(this.gameHost);
    host.append(this.root);
    const onLock = () => this.pointerLockChanged();
    document.addEventListener("pointerlockchange", onLock);
    this.cleanup.push(() => document.removeEventListener("pointerlockchange", onLock));
  }

  async start(level?: string) {
    this.status("loading menus...");
    await this.assets.preload(MENU_RES, STATUS_RES);
    const sprites = new Map<string, Sprite | null>();
    const names = ["mainmenu.pic", "logo.pic", "pointer.spr", "glow.spr", "slide_1.spr", "slide_2.spr", "slide_3.spr", "slidevert_1.spr", "slidevert_2.spr", "slidevert_3.spr",
      ...Array.from({ length: 8 }, (_, i) => `win1_${i + 1}.spr`), ...Array.from({ length: 8 }, (_, i) => `win2_${i + 1}.spr`)];
    await Promise.all(names.map(async (n) => sprites.set(n.replace(/\.(spr|pic)$/, ""), await this.assets.sprite(MENU_RES, n))));
    sprites.set("progressbar", await this.assets.sprite(STATUS_RES, "progressbar.spr"));
    const [font1, font3, font4] = await Promise.all([this.assets.font(MENU_RES, "font1.fnt", 9), this.assets.font(MENU_RES, "font3.fnt", 16), this.assets.font(MENU_RES, "font4.fnt", 12)]);
    this.theme = { font1, font3, font4, sprites, audio: this.audio };
    this.menu = new MenuCanvas(this.root, this.theme);
    // Menu labels: the base table, overridden by the language's (e.g. "Single Player" reads "Play Project IGI").
    for (const path of ["menusystem/english.res", "language/english/menusystem.res"]) for (const [k, v] of await this.assets.strings(path)) this.strings.set(k, v);
    this.missions = await missionCatalog(this.vfs);
    this.status("");
    const n = level ? this.missions.find((m) => m.level === level) : undefined;
    if (level) this.load(n ?? { number: 0, level, name: level, description: "" });
    else this.mainMenu();
  }

  private t(key: string, fallback = key) {
    return this.strings.get(key) ?? fallback;
  }

  private sprite(name: string) {
    return this.theme.sprites.get(name) ?? null;
  }

  // ---- main menus ----------------------------------------------------------------------------------------------

  private mainMenu() {
    this.state = "menu";
    this.audio.musicOn();
    const p = MAIN_PANEL;
    const items: [string, () => void][] = [
      [this.t("Single Player"), () => this.missionSelect()],
      [this.t("Configuration"), () => this.configuration(false, () => this.mainMenu())],
      [this.t("Quit"), () => this.confirm(false, () => (location.search = "?view=landing"))],
    ];
    const widgets: Widget[] = [new Label({ x: p.x + 14, y: p.y + 6, w: 300, h: 24 }, this.t("Main Menu"), "font3")];
    items.forEach(([text, run], i) => widgets.push(new Button({ x: p.x + 14, y: p.y + 40 + i * 28, w: 300, h: 24 }, text, run)));
    widgets.push(
      new Button({ x: p.x + 14, y: p.y + p.h - 28, w: 80, h: 18 }, this.t("Read Me"), () => this.readMe(), "font4"),
      new Button({ x: p.x + 104, y: p.y + p.h - 28, w: 80, h: 18 }, this.t("Credits"), () => this.credits(), "font4"),
    );
    this.menu.show({
      background: this.sprite("mainmenu"),
      panel: p,
      widgets,
      onEscape: () => this.confirm(false, () => (location.search = "?view=landing")),
      decorate: (ctx) => {
        const logo = this.sprite("logo");
        if (logo) ctx.drawImage(logo.frames[0], (640 - logo.width) / 2, 32);
        this.theme.font1.draw(ctx, "open-igi", 636, 470, { color: COLORS.disabled, align: "right" });
      },
    });
  }

  private async missionSelect() {
    const p = MAIN_PANEL;
    await this.assets.preload(MISSION_RES);
    const pictures = await Promise.all(this.missions.map((m) => this.assets.sprite(MISSION_RES, `mission${m.number}.spr`)));
    const unlocked = this.unlocked();
    let selected = Math.min(unlocked, this.missions.length) - 1;
    const picture = new Picture({ x: 140, y: 210, w: 172, h: 128 }, pictures[selected]);
    const text = new TextBlock({ x: 142, y: 344, w: 168, h: 90 }, this.missions[selected].description, "font4");
    const go = (i: number) => this.load(this.missions[i]);
    const list = new ListBox(
      { x: 357, y: 210, w: 175, h: 230 },
      this.missions.map((m) => ({ text: `${m.number}. ${m.name}`, enabled: m.number <= unlocked })),
      selected,
      (i) => {
        selected = i;
        picture.sprite = pictures[i];
        text.text = this.missions[i].description;
      },
      go,
    );
    this.menu.show({
      background: this.sprite("mainmenu"),
      panel: p,
      widgets: [
        new Label({ x: p.x + 14, y: p.y + 6, w: 300, h: 24 }, this.t("Select Mission"), "font3"),
        picture,
        text,
        list,
        ...this.okCancel(() => go(selected), () => this.mainMenu(), false),
      ],
      onEscape: () => this.mainMenu(),
      decorate: (ctx) => {
        const logo = this.sprite("logo");
        if (logo) ctx.drawImage(logo.frames[0], (640 - logo.width) / 2, 32);
      },
    });
  }

  /** Highest mission number selectable: progress, or everything with ?missions=all. */
  private unlocked() {
    return new URLSearchParams(location.search).get("missions") === "all" ? 14 : missionsUnlocked();
  }

  /** OK / Cancel stacked at the right of the panel (MenuFrame "OK/Cancel" at 555,400 / 470,360). */
  private okCancel(ok: () => void, cancel: (() => void) | null, inGame: boolean): Widget[] {
    const x = inGame ? 470 : 555;
    const y = inGame ? 360 : 400;
    const out: Widget[] = [new Button({ x, y, w: 70, h: 24 }, this.t("OK"), ok, "font3", "menu_ok")];
    if (cancel) out.push(new Button({ x, y: y + 26, w: 70, h: 24 }, this.t("Cancel"), cancel, "font3", "menu_cancel"));
    return out;
  }

  private screen(inGame: boolean, title: string, widgets: Widget[], onEscape: () => void): Page {
    const p = inGame ? INGAME_PANEL : MAIN_PANEL;
    return {
      background: inGame ? null : this.sprite("mainmenu"),
      dim: inGame,
      panel: p,
      widgets: [new Label({ x: p.x + 14, y: p.y + 6, w: p.w - 28, h: 24 }, title, "font3"), ...widgets],
      onEscape,
      decorate: inGame
        ? undefined
        : (ctx) => {
            const logo = this.sprite("logo");
            if (logo) ctx.drawImage(logo.frames[0], (640 - logo.width) / 2, 32);
          },
    };
  }

  private configuration(inGame: boolean, back: () => void) {
    const p = inGame ? INGAME_PANEL : MAIN_PANEL;
    const row = (i: number, text: string, run: () => void) => new Button({ x: p.x + 14, y: p.y + 40 + i * 28, w: 300, h: 24 }, text, run);
    const self = () => this.configuration(inGame, back);
    const widgets: Widget[] = [];
    if (!inGame) widgets.push(row(widgets.length, this.t("Graphics"), () => this.graphics(self)));
    widgets.push(row(widgets.length, this.t("Sound"), () => this.sound(inGame, self)));
    widgets.push(row(widgets.length, this.t("Controls"), () => this.controls(inGame, self)));
    widgets.push(...this.okCancel(back, null, inGame));
    this.menu.show(this.screen(inGame, this.t("Configuration"), widgets, back));
  }

  /** Run a settings screen on a draft copy: OK keeps it, Cancel restores the saved settings. */
  private editSettings(build: (draft: Settings, apply: () => void) => Widget[], inGame: boolean, title: string, back: () => void) {
    const saved = structuredClone(this.settings);
    const draft = structuredClone(this.settings);
    const apply = () => {
      this.audio.setVolumes(draft.musicVolume, draft.fxVolume);
      if (this.game) applySettings(this.game, draft);
    };
    const finish = (keep: boolean) => {
      this.settings = keep ? draft : saved;
      if (keep) saveSettings(this.settings);
      this.audio.setVolumes(this.settings.musicVolume, this.settings.fxVolume);
      if (this.game) applySettings(this.game, this.settings);
      for (const w of widgets) (w as { dispose?: () => void }).dispose?.();
      back();
    };
    const widgets = build(draft, apply);
    widgets.push(...this.okCancel(() => finish(true), () => finish(false), inGame));
    this.menu.show(this.screen(inGame, title, widgets, () => finish(false)));
  }

  private optionRow(inGame: boolean, i: number) {
    const p = inGame ? INGAME_PANEL : MAIN_PANEL;
    return { rect: { x: p.x + 14, y: p.y + 40 + i * 29, w: p.w - 28 - (inGame ? 80 : 0), h: 25 }, controlX: p.x + (inGame ? 210 : 240) };
  }

  private graphics(back: () => void) {
    this.editSettings(
      (draft) => {
        const r = this.optionRow(false, 0);
        const detail = new Slider(r.rect, this.t("Performance Level", "Graphics detail"), r.controlX, 150, draft.detail / (DETAIL_LEVELS.length - 1), (v) => {
          draft.detail = Math.round(v * (DETAIL_LEVELS.length - 1));
        }, DETAIL_LEVELS.length);
        const r2 = this.optionRow(false, 1);
        const note = new Label({ ...r2.rect, h: 18 }, "Takes effect when a mission starts.", "font4", COLORS.small);
        const r3 = this.optionRow(false, 3);
        const reset = new Button({ ...r3.rect, w: 250 }, this.t("Reset to Default"), () => {
          draft.detail = defaultSettings().detail;
          detail.value = draft.detail / (DETAIL_LEVELS.length - 1);
        });
        return [detail, note, reset];
      },
      false,
      this.t("Graphics Configuration"),
      back,
    );
  }

  private sound(inGame: boolean, back: () => void) {
    this.editSettings(
      (draft, apply) => {
        const a = this.optionRow(inGame, 0);
        const b = this.optionRow(inGame, 1);
        return [
          new Slider(a.rect, this.t("Music Volume"), a.controlX, 140, draft.musicVolume, (v) => ((draft.musicVolume = v), apply())),
          new Slider(b.rect, this.t("FX Volume"), b.controlX, 140, draft.fxVolume, (v) => {
            draft.fxVolume = v;
            apply();
            this.audio.play("menu_k03");
          }),
        ];
      },
      inGame,
      this.t("Sound Configuration"),
      back,
    );
  }

  private controls(inGame: boolean, back: () => void) {
    this.editSettings(
      (draft, apply) => {
        const p = inGame ? INGAME_PANEL : MAIN_PANEL;
        const a = this.optionRow(inGame, 0);
        const b = this.optionRow(inGame, 1);
        const invert = new Toggle(a.rect, this.t("Invert Mouse"), a.controlX, draft.invertMouse, (v) => ((draft.invertMouse = v), apply()));
        const mouse = new Slider(b.rect, this.t("Mouse Sensitivity"), b.controlX, 140, draft.mouse, (v) => ((draft.mouse = v), apply()));
        const keys = new KeyBindings({ x: p.x + 14, y: p.y + 100, w: inGame ? 360 : 400, h: inGame ? 186 : 166 }, draft.bindings, this.strings, apply);
        const reset = new Button({ x: p.x + 14, y: p.y + (inGame ? 292 : 272), w: 250, h: 22 }, this.t("Reset to Default"), () => {
          draft.bindings = structuredClone(DEFAULT_BINDINGS);
          keys.bindings = draft.bindings;
          draft.invertMouse = false;
          invert.value = false;
          apply();
        }, "font4");
        return [invert, mouse, keys, reset];
      },
      inGame,
      this.t("Controls Configuration"),
      back,
    );
  }

  private async readMe() {
    const path = "language/english/readme.txt";
    const text = this.vfs.has(path) ? new TextDecoder("latin1").decode(await this.vfs.read(path)) : "";
    this.textPage(this.t("Read Me"), text.replace(/\t/g, "    "));
  }

  private credits() {
    this.textPage(
      this.t("Credits"),
      "Project I.G.I. - I'm Going In\nInnerloop Studios, published by Eidos Interactive (2000).\n\n" +
        "open-igi\nA free, open-source reimplementation that runs on your own copy of the game.\n\n" +
        "Built on community reverse-engineering: hjcminus/Project-IGI-Terrain and flawme/igi-reverse-engineering. See THIRD_PARTY.md.",
    );
  }

  private textPage(title: string, text: string) {
    const p = MAIN_PANEL;
    this.menu.show(
      this.screen(false, title, [new TextBlock({ x: p.x + 14, y: p.y + 36, w: p.w - 28, h: p.h - 50 }, text, "font4"), ...this.okCancel(() => this.mainMenu(), null, false)], () => this.mainMenu()),
    );
  }

  /** IGI's "Are you sure?" dialog. */
  private confirm(inGame: boolean, yes: () => void) {
    const r: Rect = inGame ? { x: 220, y: 180, w: 200, h: 120 } : { x: 197, y: 234, w: 256, h: 133 };
    const no = () => this.menu.closePopup();
    this.menu.showPopup({
      background: null,
      panel: r,
      widgets: [
        new Label({ x: r.x, y: r.y + 8, w: r.w, h: 24 }, this.t("Are you sure?", "Are you sure?"), "font3", COLORS.title, "center"),
        new Button({ x: r.x, y: r.y + 46, w: r.w, h: 24 }, this.t("Yes"), yes, "font3", "menu_ok", "center"),
        new Button({ x: r.x, y: r.y + 74, w: r.w, h: 24 }, this.t("No"), no, "font3", "menu_cancel", "center"),
      ],
      onEscape: no,
    });
  }

  // ---- loading and the game ------------------------------------------------------------------------------------

  private async load(mission: MissionEntry) {
    this.disposeGame();
    const token = ++this.loadToken;
    this.mission = mission;
    this.state = "loading";
    this.audio.musicOff();
    await this.assets.preload(LOADING_RES, MISSION_RES);
    const background = (await this.assets.sprite(LOADING_RES, "loading.pic")) ?? this.sprite("mainmenu");
    const picture = mission.number ? await this.assets.sprite(MISSION_RES, `mission${mission.number}.spr`) : null;
    const briefing = await missionBriefing(this.vfs, mission);
    if (token !== this.loadToken) return;

    const panel: Rect = { x: 40, y: 346, w: 560, h: 124 };
    const bar = new ProgressBar({ x: 204, y: 436, w: 380, h: 22 }, this.sprite("progressbar"));
    const statusLabel = new Label({ x: 204, y: 418, w: 380, h: 16 }, this.t("LoadingText", "Loading Level... Please Wait..."), "font4", COLORS.small);
    const widgets: Widget[] = [
      new Picture({ x: 52, y: 356, w: 140, h: 104 }, picture),
      new Label({ x: 204, y: 352, w: 380, h: 22 }, mission.number ? `${this.t(`Mission ${mission.number}`)}: ${mission.name}` : mission.name, "font3"),
      new TextBlock({ x: 204, y: 376, w: 380, h: 40 }, briefing, "font4"),
      statusLabel,
      bar,
    ];
    this.menu.show({ background, panel, widgets });

    // Game.start reports its steps; turn them into a rough progress fraction.
    let target = 0.02;
    const creep = setInterval(() => (bar.value += (target - bar.value) * 0.15), 50);
    const onProgress = (text: string) => {
      this.status(text);
      if (/^loading/.test(text)) target = 0.1;
      else if (/placing/.test(text)) target = 0.45;
      else if (/^starting/.test(text)) target = Math.min(0.85, Math.max(target, 0.5) + 0.04);
      else if (/terrain/.test(text)) target = 0.9;
      else if (text === "") target = 1;
    };

    const params = new URLSearchParams(location.search);
    this.stats = { shots: 0, hits: 0, kills: 0, alarms: 0 };
    this.pendingEnd = null;
    let game: Game;
    try {
      game = await Game.start({
        vfs: this.vfs,
        host: this.gameHost,
        level: mission.level,
        systems: [...createSystems(), this.frontEndSystem()],
        detail: Number(params.get("detail") ?? DETAIL_LEVELS[this.settings.detail]),
        onProgress,
      });
    } catch (err) {
      clearInterval(creep);
      console.error(err);
      statusLabel.text = `Could not load ${mission.level}: ${(err as Error).message}`;
      statusLabel.color = "#ff7060";
      widgets.push(new Button({ x: 470, y: 450, w: 120, h: 20 }, this.t("Back"), () => this.mainMenu(), "font4"));
      return;
    }
    clearInterval(creep);
    if (token !== this.loadToken) {
      game.dispose();
      return;
    }
    this.game = game;
    applySettings(game, this.settings);
    if (import.meta.env.DEV) Object.assign(window, { game });
    bar.value = 1;
    this.state = "ready";
    this.status(`${game.level.name} | Esc pauses, M/Tab opens the map computer`);
    statusLabel.text = "";
    statusLabel.color = COLORS.hover;
    const start = new StartArea({ x: -400, y: -400, w: 1440, h: 1280 }, () => this.resume());
    widgets.unshift(start);
    this.menu.show({ background, panel, widgets, onEscape: () => this.resume() });
    this.menu.setFocus(start);
  }

  /** The front end's own system: watches pause/map keys and game events for the end screens and stats. */
  private frontEndSystem(): GameSystem {
    const fe = this;
    let offs: (() => void)[] = [];
    return {
      name: "frontend",
      init(game) {
        game.paused = true;
        const player = () => game.services.player?.entity.id ?? -1;
        offs = [
          game.events.on("weapon:fire", (e) => e.ownerId === player() && fe.stats.shots++),
          game.events.on("damage", (e) => e.sourceId === player() && e.targetId !== player() && fe.stats.hits++),
          game.events.on("death", (e) => {
            if (e.killerId === player() && e.entityId !== player()) fe.stats.kills++;
            if (e.entityId === player()) setTimeout(() => game === fe.game && fe.gameOver(), 2500);
          }),
          game.events.on("alarm", (e) => e.active && fe.stats.alarms++),
          // LevelFlow can complete before the outro ends (level12 completes on its first of three outro cutscenes).
          game.events.on("mission:end", (e) => (fe.pendingEnd = { success: e.success, reason: e.reason, wait: e.success ? 1.5 : 2.5 })),
        ];
      },
      lateUpdate(dt, game) {
        if (game !== fe.game) return;
        const end = fe.pendingEnd;
        if (end && (end.wait -= dt) <= 0 && !game.services.mission?.cutscene()) {
          fe.pendingEnd = null;
          fe.missionEnd(end.success, end.reason);
        }
        const mapOpen = game.services.hud?.mapOpen ?? false;
        if (fe.state === "playing" && !mapOpen && !fe.mapWasOpen && game.input.wasPressed("pause")) fe.pause();
        fe.mapWasOpen = mapOpen;
      },
      dispose() {
        for (const off of offs) off();
      },
    };
  }

  private pointerLockChanged() {
    const game = this.game;
    if (!game || this.state !== "playing" || game.input.locked) return;
    if (game.services.hud?.mapOpen || this.mapWasOpen) return;
    // Esc releases the mouse before the page sees the key: treat losing the pointer as the pause key.
    this.pause();
  }

  private resume() {
    const game = this.game;
    if (!game) return;
    this.menu.hide();
    this.state = "playing";
    this.status("");
    game.paused = false;
    if (game.services.player) game.services.player.frozen = false;
    game.input.lock();
  }

  private pause() {
    const game = this.game;
    if (!game || this.state !== "playing") return;
    this.state = "paused";
    game.paused = true;
    game.input.unlock();
    this.menuOpenedAt = performance.now();
    this.pauseMenu();
  }

  /** The in-game menu (ingamemenu.qvm screen 900). */
  private pauseMenu() {
    const p = INGAME_PANEL;
    const failed = this.state === "over";
    const items: [string, () => void, boolean][] = [
      [this.t("Resume Game"), () => this.resume(), !failed],
      [this.t("Restart Game"), () => this.confirm(true, () => this.restart()), true],
      [this.t("Sound"), () => this.sound(true, () => this.pauseMenu()), true],
      [this.t("Controls"), () => this.controls(true, () => this.pauseMenu()), true],
      [this.t("Quit to Main Menu"), () => this.confirm(true, () => this.quitToMenu()), true],
    ];
    const widgets: Widget[] = items.map(([text, run, enabled], i) => {
      const b = new Button({ x: p.x + 14, y: p.y + 40 + i * 28, w: 300, h: 24 }, text, run);
      b.enabled = enabled;
      return b;
    });
    this.menu.show(
      this.screen(true, this.t("Game Paused"), widgets, () => {
        // Ignore the Esc that opened the menu.
        if (performance.now() - this.menuOpenedAt > 300) this.resume();
      }),
    );
  }

  private restart() {
    if (this.mission) this.load(this.mission);
  }

  private quitToMenu() {
    this.disposeGame();
    this.mainMenu();
  }

  private disposeGame() {
    this.loadToken++;
    if (!this.game) return;
    this.game.input.unlock();
    this.game.dispose();
    this.game = null;
    if (import.meta.env.DEV) Object.assign(window, { game: undefined });
  }

  private endScreen(title: string, lines: string[], buttons: [string, () => void][]) {
    const game = this.game;
    if (!game) return;
    this.state = "over";
    game.paused = true;
    game.input.unlock();
    const p = INGAME_PANEL;
    const widgets: Widget[] = [new Label({ x: p.x, y: p.y + 10, w: p.w, h: 26 }, title, "font3", COLORS.title, "center")];
    lines.forEach((l, i) => widgets.push(new Label({ x: p.x + 60, y: p.y + 50 + i * 20, w: p.w - 120, h: 18 }, l, "font4", COLORS.value)));
    buttons.forEach(([text, run], i) => widgets.push(new Button({ x: p.x, y: p.y + 214 + i * 28, w: p.w, h: 24 }, text, run, "font3", "menu_ok", "center")));
    this.menu.show({ background: null, dim: true, panel: p, widgets });
  }

  private gameOver() {
    if (this.state === "over") return;
    this.endScreen(this.t("Game Over"), ["Jones is down. The mission has failed."], [
      [this.t("Restart Game"), () => this.restart()],
      [this.t("Quit to Main Menu"), () => this.quitToMenu()],
    ]);
  }

  private missionEnd(success: boolean, reason: string) {
    if (this.state === "over" || !this.game) return;
    const m = this.mission;
    const elapsed = this.game.services.mission?.elapsed() ?? this.game.time;
    const time = `${Math.floor(elapsed / 60)}:${String(Math.floor(elapsed % 60)).padStart(2, "0")}`;
    const accuracy = this.stats.shots ? `${Math.round((Math.min(this.stats.hits, this.stats.shots) / this.stats.shots) * 100)}%` : "-";
    // The mission system reports a reason code; "complete"/"failed" just repeat the title.
    const why = ({ killed: "Jones was killed.", time: "Out of time." } as Record<string, string>)[reason];
    const lines = [
      ...(why ? [why] : []),
      `Mission time:  ${time}`,
      `Enemies killed:  ${this.stats.kills}`,
      `Shots fired:  ${this.stats.shots}`,
      `Accuracy:  ${accuracy}`,
      `Alarms raised:  ${this.stats.alarms}`,
    ];
    if (success && m && m.number) unlockMission(m.number + 1);
    const next = success && m && m.number > 0 && m.number < this.missions.length ? this.missions[m.number] : null;
    const buttons: [string, () => void][] = [];
    if (next) buttons.push([`Next Mission: ${next.name}`, () => this.load(next)]);
    else if (!success) buttons.push([this.t("Restart Game"), () => this.restart()]);
    buttons.push([this.t("Quit to Main Menu"), () => this.quitToMenu()]);
    this.endScreen(success ? "Mission Complete" : "Mission Failed", lines, buttons);
  }

  dispose() {
    this.disposeGame();
    this.menu?.dispose();
    this.audio.dispose();
    for (const c of this.cleanup) c();
    this.root.remove();
  }
}

/** Invisible full-screen widget: any click (or Enter) continues from the loading screen. */
class StartArea extends Widget {
  private run: () => void;
  constructor(
    rect: Rect,
    run: () => void,
  ) {
    super(rect);
    this.run = run;
    this.selectable = true;
  }
  draw(ctx: CanvasRenderingContext2D, theme: MenuTheme) {
    // Blink a prompt under the progress bar.
    if (Math.floor(performance.now() / 500) % 2) theme.font4.draw(ctx, "Click to start", 394, 418, { color: COLORS.hover, align: "center" });
  }
  click() {
    this.run();
  }
}
