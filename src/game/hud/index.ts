// IGI's in-game HUD, drawn on a 2D canvas over the 3D view with the game's own status.res sprites and fonts:
// health figure (bottom left), weapon and ammo (bottom right), compass (top right), crosshair, messages, damage
// direction, pickup notices, context action icons and progress bar, the binocular/scope overlay, and the map computer.
import { direction, METRE, vec3, type Vec3 } from "../coords.ts";
import type { Game, GameSystem } from "../game.ts";
import type { HudAction, HudService, ZoomMode } from "./api.ts";
import { UiAssets, type Sprite, type UiFont } from "./gfx.ts";
import { MapComputer } from "./map.ts";

const STATUS = "screens/game/status/status.res";
const FONTS = "menusystem/ingamemenu.res";

/** HUD palette: IGI's phosphor green on dark. */
export const HUD_GREEN = "#8cf07a";
export const HUD_DIM = "#4f9a45";
const HUD_RED = "#ff4a3a";

/** status.res icon for each weapon id (WEAPON_ID_*), as in weapons/*.qvm. */
const WEAPON_ICONS: Record<string, string> = {
  AK47: "ak47",
  BINOCULARS: "binoculars",
  COLT: "colt",
  COLTANACONDA: "colt",
  DESERTEAGLE: "deserteagle",
  DRAGUNOV: "druganov",
  FLASHBANG: "flashgrenade",
  GLOCK: "glock",
  GRENADE: "splintgrenade",
  JACKHAMMER: "jackhammer",
  KNIFE: "knife",
  RPG18: "law80",
  LAW80: "law80",
  M16A2: "m16",
  M16: "m16",
  MP5SD: "mp5",
  MP5: "mp5",
  PROXIMITYMINE: "proximity",
  MINIMI: "saw",
  SAW: "saw",
  SPAS12: "spaz",
  M2HB: "stationary",
  MIL: "stationary",
  UZI: "uzi",
  UZIX2: "uzi",
  MEDIPACK: "health",
};

/** How a weapon's rounds are drawn (AMMODISPLAYTYPE_* in the weapon tables). */
function ammoDisplay(id: string): { sprite: string; frames: "clip" | "shell" | "single" } {
  if (id === "COLT" || id === "COLTANACONDA") return { sprite: "barrel6", frames: "clip" };
  if (id === "SPAS12") return { sprite: "shell7", frames: "shell" };
  if (id === "RPG18" || id === "LAW80") return { sprite: "rocket", frames: "single" };
  if (id === "GRENADE" || id === "FLASHBANG" || id === "PROXIMITYMINE") return { sprite: "spl_grenade", frames: "single" };
  return { sprite: "clip20", frames: "clip" };
}

const ACTION_SPRITES: Record<HudAction, string> = {
  door: "a_door",
  ladder: "a_ladder",
  fence: "a_fence",
  wire: "a_wire",
  c4: "a_c4",
  gun: "a_gun",
  computer: "action_comput",
  picklock: "action_picklock",
  cabinet: "action_searchcab",
  button: "action_pressbutton",
};

const weaponKey = (id: string) => id.replace(/^WEAPON_ID_/, "").toUpperCase();

interface Notice {
  text: string;
  until: number;
  icon?: Sprite | null;
}

export function hudSystem(): GameSystem {
  let hud: Hud | null = null;
  return {
    name: "hud",
    async init(game) {
      hud = new Hud(game);
      await hud.load();
      game.services.hud = hud.service;
    },
    lateUpdate(dt) {
      hud?.frame(dt);
    },
    dispose() {
      hud?.dispose();
      hud = null;
    },
  };
}

class Hud {
  readonly service: HudService;
  private game: Game;
  private assets: UiAssets;
  private canvas = document.createElement("canvas");
  private mask = document.createElement("canvas");
  private ctx = this.canvas.getContext("2d")!;
  private sprites = new Map<string, Sprite | null>();
  private font1!: UiFont;
  private font3!: UiFont;
  private font4!: UiFont;
  private clock = 0;
  private messages: Notice[] = [];
  private pickups: Notice[] = [];
  private hits: { angle: number; at: number }[] = [];
  private hurt = 0;
  private lastHealth: number | null = null;
  private currentAction: HudAction | null = null;
  private progressValue: number | null = null;
  private progressLabel = "";
  private zoom: { mode: ZoomMode; zoom: number } = { mode: "none", zoom: 1 };
  private map: MapComputer;
  private off: (() => void)[] = [];

  constructor(game: Game) {
    this.game = game;
    this.assets = new UiAssets(game.vfs);
    this.canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none";
    game.overlay.append(this.canvas);
    this.map = new MapComputer(game, this.assets);
    const hud = this;
    this.service = {
      visible: true,
      message: (text, seconds) => this.message(text, seconds),
      action: (kind) => (this.currentAction = kind),
      progress: (value, label) => {
        this.progressValue = value;
        this.progressLabel = label ?? "";
      },
      get mapOpen() {
        return hud.map.open;
      },
      setMapOpen: (open) => this.setMap(open),
    };
  }

  async load() {
    await this.assets.preload(STATUS, FONTS);
    [this.font1, this.font3, this.font4] = await Promise.all([
      this.assets.font(FONTS, "font1.fnt", 9),
      this.assets.font(FONTS, "font3.fnt", 16),
      this.assets.font(FONTS, "font4.fnt", 12),
    ]);
    const names = new Set([
      "cross", "clip20", "barrel6", "shell7", "spl_grenade", "m16_alternative", "rocket", "powerbar", "powerbarbackground",
      "progressbar", "mapsphere", "mapcircle", "mapdot", "ammo", "weapon", "note", "anya",
      ...Object.values(WEAPON_ICONS), ...Object.values(ACTION_SPRITES),
    ]);
    await Promise.all([...names].map(async (n) => this.sprites.set(n, await this.assets.sprite(STATUS, `${n}.spr`))));
    await this.map.load();

    const ev = this.game.events;
    const playerId = () => this.game.services.player?.entity.id ?? -1;
    this.off.push(
      ev.on("message", (m) => this.message(m.text, m.seconds)),
      // StatusMessageScreen_ClearMessages(): gameplay containers clear the intro subtitles when they start.
      ev.on("status:clear", () => (this.messages.length = 0)),
      ev.on("objective", (o) => {
        // The mission system already shows IGI's own "Objective 1 Complete." for completed and failed objectives.
        if (this.game.services.mission && o.state !== "active") return;
        const text = o.text ?? this.game.services.mission?.objectives()[o.index]?.text ?? `Objective ${o.index + 1}`;
        const verb = o.state === "completed" ? "Objective completed" : o.state === "failed" ? "Objective failed" : "New objective";
        this.message(`${verb}: ${text}`, 5);
      }),
      ev.on("pickup", (p) => {
        // Mission items (keycards, C4) are announced by the level's own status messages.
        if (p.ownerId !== playerId() || p.item.startsWith("GenericPickup_")) return;
        const key = weaponKey(p.item);
        const icon = this.sprites.get(WEAPON_ICONS[key] ?? "") ?? this.sprites.get(/ammo|clip/i.test(p.item) ? "ammo" : "weapon");
        const name = this.game.services.weapons?.inventory().find((w) => w.id === p.item)?.name ?? prettyItem(p.item);
        this.pickups.push({ text: p.amount > 1 ? `${p.amount} x ${name}` : name, until: this.clock + 3, icon });
        if (this.pickups.length > 4) this.pickups.shift();
      }),
      ev.on("damage", (d) => {
        if (d.targetId !== playerId() || d.amount <= 0) return;
        this.hurt = Math.min(1, this.hurt + 0.25 + d.amount / 60);
        const player = this.game.services.player;
        if (!player) return;
        const src = d.sourceId !== null ? this.game.entities.get(d.sourceId)?.position : undefined;
        const toSource: Vec3 = src ? vec3.sub(src, player.entity.position) : vec3.scale(d.direction, -1);
        if (Math.hypot(toSource[0], toSource[1]) < 1e-6) return;
        // Bearing about Z like coords.direction (0 = +Y, counter-clockwise), relative to where the player looks.
        const bearing = Math.atan2(-toSource[0], toSource[1]) - player.yaw;
        this.hits.push({ angle: bearing, at: this.clock });
        if (this.hits.length > 6) this.hits.shift();
      }),
      ev.on("weapon:zoom", (z) => (this.zoom = { mode: z.mode, zoom: z.zoom })),
    );
  }

  message(text: string, seconds = 3) {
    this.messages.push({ text, until: this.clock + seconds });
    if (this.messages.length > 4) this.messages.shift();
    this.map.log(text);
  }

  private setMap(open: boolean) {
    if (open === this.map.open) return;
    const player = this.game.services.player;
    if (open) {
      this.map.show();
      if (player) player.frozen = true;
      this.game.input.unlock();
    } else {
      this.map.hide();
      if (player) player.frozen = false;
      this.game.input.lock();
    }
  }

  frame(dt: number) {
    const game = this.game;
    if (!game.paused) this.clock += dt;
    if (!game.paused && game.input.wasPressed("map")) this.setMap(!this.map.open);
    else if (this.map.open && game.input.wasPressed("pause")) this.setMap(false);
    this.map.frame(dt);

    const w = game.overlay.clientWidth;
    const h = game.overlay.clientHeight;
    const dpr = Math.min(devicePixelRatio, 2);
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.service.visible || this.map.open || w === 0) return;
    // HUD units: the original laid the HUD out for 640x480; scale with the screen height.
    const s = Math.max(1, h / 560) * dpr;
    ctx.imageSmoothingEnabled = false;
    const W = this.canvas.width / s;
    const H = this.canvas.height / s;
    ctx.setTransform(s, 0, 0, s, 0, 0);

    // Scripted cutscenes (intro/outro): Jones is not in control, so only the subtitles show.
    if (game.services.mission?.cutscene()) {
      this.drawMessages(W, H);
      return;
    }

    this.hurt = Math.max(0, this.hurt - dt * 0.8);
    const player = game.services.player;
    if (player) {
      if (this.lastHealth !== null && player.entity.health < this.lastHealth - 0.01) this.hurt = Math.min(1, this.hurt + 0.2);
      this.lastHealth = player.entity.health;
    }
    if (this.hurt > 0) this.drawHurt(W, H);

    if (this.zoom.mode !== "none") this.drawOptics(W, H);
    else this.drawCrosshair(W, H);
    this.drawDamage(W, H);
    if (player) this.drawHealth(player.entity.health / (player.entity.maxHealth || 100), H);
    this.drawWeapon(W, H);
    if (player) this.drawCompass(player.yaw, W);
    this.drawMessages(W, H);
    this.drawPickups(W, H);
    this.drawAction(W, H);
    this.drawProgress(W, H);
  }

  private sprite(name: string) {
    return this.sprites.get(name) ?? null;
  }

  private drawCrosshair(W: number, H: number) {
    const c = this.sprite("cross");
    if (c) this.ctx.drawImage(c.frames[0], Math.round(W / 2 - c.width / 2), Math.round(H / 2 - c.height / 2));
  }

  private drawHealth(fraction: number, H: number) {
    const ctx = this.ctx;
    const bg = this.sprite("powerbarbackground");
    const bar = this.sprite("powerbar");
    const x = 10;
    const y = H - 10 - (bg?.height ?? 78);
    if (bg) ctx.drawImage(bg.frames[0], x, y);
    if (bar) {
      // The red figure fills the outline from the feet up as far as health reaches.
      const f = Math.max(0, Math.min(1, fraction));
      const fill = Math.round(bar.height * f);
      const low = f < 0.25 && Math.floor(this.clock * 4) % 2 === 0;
      ctx.globalAlpha = low ? 0.45 : 0.9;
      if (fill > 0) ctx.drawImage(bar.frames[0], 0, bar.height - fill, bar.width, fill, x + 19, y + 2 + bar.height - fill, bar.width, fill);
      ctx.globalAlpha = 1;
    }
    this.font1.draw(ctx, `${Math.max(0, Math.ceil(fraction * 100))}%`, x + 2, y - 10, { color: fraction < 0.25 ? HUD_RED : HUD_GREEN });
  }

  private drawWeapon(W: number, H: number) {
    const weapon = this.game.services.weapons?.current();
    if (!weapon) return;
    const ctx = this.ctx;
    const key = weaponKey(weapon.id);
    const icon = this.sprite(WEAPON_ICONS[key] ?? "");
    const right = W - 12;
    const bottom = H - 12;
    if (icon) ctx.drawImage(icon.frames[0], right - icon.width, bottom - icon.height);
    else this.font4.draw(ctx, weapon.name, right, bottom - this.font4.lineHeight, { color: HUD_GREEN, align: "right" });
    if (weapon.clipSize <= 0) return;
    const rowY = bottom - (icon?.height ?? 14) - 40;
    const display = ammoDisplay(key);
    const ammo = this.sprite(display.sprite);
    let x = right;
    // Rounds in reserve, then the rounds left in the clip as a big number, then the clip picture.
    const mags = display.frames === "single" ? weapon.reserve : Math.ceil(weapon.reserve / weapon.clipSize);
    this.font1.draw(ctx, display.frames === "single" ? `+${weapon.reserve}` : `x${mags}`, x, rowY + 24, { color: HUD_DIM, align: "right" });
    x -= Math.max(18, this.font1.measure(`x${mags}`) + 4);
    this.font3.draw(ctx, String(weapon.clip), x, rowY + 8, { color: HUD_GREEN, align: "right" });
    x -= this.font3.measure(String(weapon.clip)) + 6;
    if (ammo) {
      const frames = ammo.frames.length;
      let frame = 0;
      if (display.frames === "clip") frame = Math.round((1 - weapon.clip / weapon.clipSize) * (frames - 1));
      else if (display.frames === "shell") frame = frames - 1 - Math.min(frames - 1, weapon.clip);
      frame = Math.max(0, Math.min(frames - 1, frame));
      ctx.drawImage(ammo.frames[frame], x - ammo.width, rowY + 33 - ammo.height + 4);
    }
  }

  private drawCompass(yaw: number, W: number) {
    const ctx = this.ctx;
    const disc = this.sprite("mapsphere");
    const ring = this.sprite("mapcircle");
    const dot = this.sprite("mapdot");
    const r = disc?.width ?? 58;
    const cx = W - 12 - r;
    const cy = 12 + r;
    ctx.save();
    ctx.translate(cx, cy);
    // mapsphere and mapcircle are quarter pieces with the circle centre at their bottom-right corner; four rotated
    // copies make the dial.
    if (disc) {
      ctx.globalAlpha = 0.45;
      for (let q = 0; q < 4; q++) {
        ctx.save();
        ctx.rotate((q * Math.PI) / 2);
        ctx.drawImage(tinted(disc.frames[0], "#0f2a0c"), -r, -r);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }
    // The dial turns with the view: north sits where it is relative to the facing direction (yaw is CCW, so the
    // north marker moves clockwise as the player turns left).
    ctx.rotate(yaw);
    if (ring) {
      for (let q = 0; q < 4; q++) {
        ctx.save();
        ctx.rotate((q * Math.PI) / 2);
        ctx.drawImage(ring.frames[0], -ring.width, -ring.height);
        ctx.restore();
      }
    }
    const letters = ["N", "W", "S", "E"];
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;
      const lx = -Math.sin(a) * (r - 13);
      const ly = -Math.cos(a) * (r - 13);
      ctx.save();
      ctx.translate(lx, ly);
      ctx.rotate(-yaw);
      this.font1.draw(ctx, letters[i], 0, -5, { color: i === 0 ? "#ffffff" : HUD_GREEN, align: "center" });
      ctx.restore();
    }
    ctx.restore();
    // Fixed marker: the direction the player faces.
    if (dot) ctx.drawImage(dot.frames[0], cx - dot.width / 2, cy - r - dot.height / 2 + 2);
    const deg = Math.round(((-yaw * 180) / Math.PI) % 360 + 360) % 360;
    this.font1.draw(ctx, String(deg).padStart(3, "0"), cx, cy + r + 3, { color: HUD_GREEN, align: "center" });
  }

  private drawMessages(W: number, H: number) {
    this.messages = this.messages.filter((m) => m.until > this.clock);
    let y = H * 0.2;
    for (const m of this.messages) {
      const alpha = Math.min(1, (m.until - this.clock) * 2);
      for (const line of this.font4.wrap(m.text, W * 0.7)) {
        this.font4.draw(this.ctx, line, W / 2, y, { color: HUD_GREEN, align: "center", alpha });
        y += this.font4.lineHeight;
      }
      y += 2;
    }
  }

  private drawPickups(W: number, H: number) {
    this.pickups = this.pickups.filter((p) => p.until > this.clock);
    let y = H - 70;
    for (const p of [...this.pickups].reverse()) {
      const alpha = Math.min(1, (p.until - this.clock) * 2);
      const ctx = this.ctx;
      ctx.globalAlpha = alpha;
      const tw = this.font4.measure(p.text);
      const iw = p.icon ? p.icon.width + 6 : 0;
      const x = W / 2 - (tw + iw) / 2;
      if (p.icon) ctx.drawImage(p.icon.frames[0], x, y - p.icon.height / 2);
      ctx.globalAlpha = 1;
      this.font4.draw(ctx, p.text, x + iw, y - this.font4.lineHeight / 2, { color: HUD_GREEN, alpha });
      y -= Math.max(this.font4.lineHeight, p.icon?.height ?? 0) + 4;
    }
  }

  private drawAction(W: number, H: number) {
    if (!this.currentAction) return;
    const icon = this.sprite(ACTION_SPRITES[this.currentAction]);
    if (icon) this.ctx.drawImage(icon.frames[0], Math.round(W / 2 - icon.width / 2), Math.round(H / 2 + 24));
  }

  private drawProgress(W: number, H: number) {
    if (this.progressValue === null) return;
    const bar = this.sprite("progressbar");
    const ctx = this.ctx;
    const w = bar?.width ?? 240;
    const h = bar?.height ?? 32;
    const x = Math.round(W / 2 - w / 2);
    const y = Math.round(H * 0.68);
    const v = Math.max(0, Math.min(1, this.progressValue));
    // progressbar.spr is the frame; fill its inner track (3px inset) with the phosphor green.
    if (bar) ctx.drawImage(bar.frames[0], x, y);
    ctx.fillStyle = HUD_GREEN;
    ctx.globalAlpha = 0.75;
    ctx.fillRect(x + 4, y + 4, Math.round((w - 8) * v), h - 8);
    ctx.globalAlpha = 1;
    if (this.progressLabel) this.font4.draw(ctx, this.progressLabel, W / 2, y - this.font4.lineHeight - 2, { color: HUD_GREEN, align: "center" });
  }

  private drawHurt(W: number, H: number) {
    const ctx = this.ctx;
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.7);
    g.addColorStop(0, "rgba(160,0,0,0)");
    g.addColorStop(1, `rgba(160,0,0,${0.5 * this.hurt})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  /** Red arcs around the crosshair pointing at whoever hit the player. */
  private drawDamage(W: number, H: number) {
    this.hits = this.hits.filter((h) => this.clock - h.at < 1.5);
    const ctx = this.ctx;
    const r = Math.min(W, H) * 0.16;
    for (const hit of this.hits) {
      const alpha = 1 - (this.clock - hit.at) / 1.5;
      // Screen angle clockwise from up: a hit from the left (positive bearing) points left.
      const a = -hit.angle - Math.PI / 2;
      ctx.strokeStyle = `rgba(255,60,40,${alpha})`;
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(W / 2, H / 2, r, a - 0.3, a + 0.3);
      ctx.stroke();
      ctx.fillStyle = `rgba(255,60,40,${alpha})`;
      ctx.beginPath();
      ctx.moveTo(W / 2 + Math.cos(a) * (r + 12), H / 2 + Math.sin(a) * (r + 12));
      ctx.lineTo(W / 2 + Math.cos(a - 0.12) * (r + 3), H / 2 + Math.sin(a - 0.12) * (r + 3));
      ctx.lineTo(W / 2 + Math.cos(a + 0.12) * (r + 3), H / 2 + Math.sin(a + 0.12) * (r + 3));
      ctx.fill();
    }
  }

  /** Binoculars: two overlapping lenses with range and zoom readouts. Scope: one lens with a cross reticle. */
  private drawOptics(W: number, H: number) {
    const ctx = this.ctx;
    const binoculars = this.zoom.mode === "binoculars";
    const r = H * (binoculars ? 0.42 : 0.47);
    const lenses = binoculars ? [W / 2 - r * 0.62, W / 2 + r * 0.62] : [W / 2];
    ctx.save();
    // Black everywhere except the lenses (built on a scratch canvas so overlapping lenses stay open).
    const mask = this.mask;
    mask.width = this.canvas.width;
    mask.height = this.canvas.height;
    const m = mask.getContext("2d")!;
    m.setTransform(ctx.getTransform());
    m.fillStyle = "#000";
    m.fillRect(0, 0, W, H);
    m.globalCompositeOperation = "destination-out";
    for (const cx of lenses) {
      m.beginPath();
      m.arc(cx, H / 2, r, 0, Math.PI * 2);
      m.fill();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(mask, 0, 0);
    ctx.setTransform(m.getTransform());
    // Soft dark lens edge.
    for (const cx of lenses) {
      const g = ctx.createRadialGradient(cx, H / 2, r * 0.8, cx, H / 2, r);
      g.addColorStop(0, "rgba(0,0,0,0)");
      g.addColorStop(1, "rgba(0,0,0,0.85)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, H / 2, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = binoculars ? "rgba(140,240,122,0.8)" : "rgba(0,0,0,0.9)";
    ctx.lineWidth = binoculars ? 0.75 : 1.25;
    ctx.beginPath();
    if (binoculars) {
      // Centre graticule with mil ticks.
      ctx.moveTo(W / 2 - r * 0.5, H / 2);
      ctx.lineTo(W / 2 + r * 0.5, H / 2);
      ctx.moveTo(W / 2, H / 2 - r * 0.3);
      ctx.lineTo(W / 2, H / 2 + r * 0.3);
      for (let i = -5; i <= 5; i++) {
        if (!i) continue;
        const t = i % 5 === 0 ? 6 : 3;
        ctx.moveTo(W / 2 + i * r * 0.1, H / 2 - t);
        ctx.lineTo(W / 2 + i * r * 0.1, H / 2 + t);
      }
    } else {
      ctx.moveTo(W / 2 - r, H / 2);
      ctx.lineTo(W / 2 - 6, H / 2);
      ctx.moveTo(W / 2 + 6, H / 2);
      ctx.lineTo(W / 2 + r, H / 2);
      ctx.moveTo(W / 2, H / 2 - r);
      ctx.lineTo(W / 2, H / 2 - 6);
      ctx.moveTo(W / 2, H / 2 + 6);
      ctx.lineTo(W / 2, H / 2 + r);
    }
    ctx.stroke();
    if (!binoculars) {
      ctx.fillStyle = "rgba(0,0,0,0.9)";
      ctx.fillRect(W / 2 - 0.75, H / 2 - 0.75, 1.5, 1.5);
    }
    ctx.restore();
    const zoomText = `ZOOM x${this.zoom.zoom.toFixed(1)}`;
    if (binoculars) {
      const range = this.range();
      this.font4.draw(ctx, zoomText, W / 2 - r * 0.62, H / 2 + r * 0.55, { color: HUD_GREEN, align: "center" });
      this.font4.draw(ctx, range === null ? "RANGE ----" : `RANGE ${Math.round(range)}m`, W / 2 + r * 0.62, H / 2 + r * 0.55, { color: HUD_GREEN, align: "center" });
    } else {
      this.font1.draw(ctx, zoomText, W / 2 + r * 0.55, H / 2 + r * 0.6, { color: "#c8c8c8" });
    }
  }

  /** Distance (metres) to whatever the player looks at, via the physics service. */
  private range(): number | null {
    const player = this.game.services.player;
    const physics = this.game.services.physics;
    if (!player || !physics) return null;
    const eye = player.eye();
    const dir = direction(player.yaw, player.pitch);
    const hit = physics.raycast(eye, vec3.add(eye, vec3.scale(dir, 2000 * METRE)), { ignoreEntity: player.entity.id });
    return hit ? hit.distance / METRE : null;
  }

  dispose() {
    for (const off of this.off) off();
    this.map.dispose();
    this.canvas.remove();
  }
}

const tintCache = new WeakMap<HTMLCanvasElement, Map<string, HTMLCanvasElement>>();

/** A copy of `src` with its colour replaced by `color` (alpha kept). */
export function tinted(src: HTMLCanvasElement, color: string): HTMLCanvasElement {
  let byColor = tintCache.get(src);
  if (!byColor) tintCache.set(src, (byColor = new Map()));
  let c = byColor.get(color);
  if (!c) {
    c = Object.assign(document.createElement("canvas"), { width: src.width, height: src.height });
    const ctx = c.getContext("2d")!;
    ctx.drawImage(src, 0, 0);
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, c.width, c.height);
    byColor.set(color, c);
  }
  return c;
}

function prettyItem(item: string): string {
  const s = item.replace(/^(WEAPON_ID_|AMMO_ID_)/, "").replace(/_/g, " ").toLowerCase();
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}
