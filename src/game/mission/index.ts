// Mission system: runs the level's mission logic (objects.qvm logic tasks; see logic.ts), renders its interactive
// objects, handles the use key (F) for doors, switches, terminals and timed actions, plays scripted cutscene
// cameras, and reports objectives, alarms and the end of the mission.
import { direction, METRE, vec3, type Vec3 } from "../coords.ts";
import type { GameSystem } from "../game.ts";
import type { MissionService, Objective, UsePrompt } from "./api.ts";
import { CutSceneTask, isUsable, MissionLogic, type LogicTask, type Usable } from "./logic.ts";
import { MissionObjects } from "./objects.ts";
import { pvec, taskTree } from "./tasks.ts";
import { briefingLines, loadStrings, missionInfo } from "./text.ts";

/** Seconds after the player dies before the mission fails, if the level's own scripts have not ended it. */
const DEATH_FAIL_DELAY = 4;

export function missionSystem(): GameSystem {
  let logic: MissionLogic;
  let objects: MissionObjects;
  let hold: { task: LogicTask & Usable; time: number } | null = null;
  let target: (LogicTask & Usable) | null = null;
  let frozeByUs = false;
  let useLatched = false;
  let wasCutscene: CutSceneTask | null = null;
  let deathTimer = -1;
  const cleanup: (() => void)[] = [];

  return {
    name: "mission",
    async init(game) {
      const strings = await loadStrings(game.vfs);
      const tree = taskTree(game.level.statements);
      const info = await missionInfo(game.vfs, game.level.name, { tree });
      const ai = () => game.services.ai;
      logic = new MissionLogic(
        tree,
        {
          player: () => game.services.player?.entity ?? game.entities.all().find((e) => e.kind === "player") ?? null,
          entities: () => game.entities.all(),
          byTask: (id) => game.entities.byTask(id),
          lineOfSight: (a, b) => game.services.physics?.lineOfSight(a, b) ?? true,
          aiDetects: (taskId) => {
            const c = ai()?.characters().find((ch) => ch.taskId === taskId);
            return !!c && c.alive && (c.state === "alert" || c.state === "combat");
          },
          aiSpawns: (taskId) => ai()?.generatorSpawns(taskId) ?? 0,
          text: (key) => strings.get(key),
        },
        (type, payload) => game.events.emit(type, payload),
      );
      for (const e of logic.errors) console.warn(`[mission] ${e}`);
      objects = new MissionObjects(game, logic);

      // Sounds: the audio system resolves level sound conditions (ConditionalSound, AmbientArea containers) against
      // our task state; object sounds come from the objects.qvm parameters (SoundDef names).
      const audio = () => game.services.audio;
      audio()?.setVariableResolver((name) => logic.variable(name));
      cleanup.push(() => audio()?.setVariableResolver(null));
      const sound = (name: string, at: Vec3 | null) => {
        if (name) audio()?.play(name, at ? { at } : {});
      };
      cleanup.push(game.events.on("mission:sound", (e) => sound(e.sound, e.position)));
      cleanup.push(game.events.on("door:move", (e) => sound(e.sound, e.position)));
      cleanup.push(game.events.on("object:explode", (e) => sound(e.sound, e.position)));
      cleanup.push(game.events.on("generator", (e) => sound(e.sound, null)));
      cleanup.push(game.events.on("elevator", (e) => sound(e.sound, null)));

      // Bullets and blasts that hit mission objects.
      cleanup.push(
        game.events.on("damage", (d) => {
          const t = objects.entityTasks.get(d.targetId);
          if (t) t.damage(d.amount);
        }),
      );
      // Exploding objects: a full health bar of damage per 100 (the player's bar is maxHealth IGI damage units).
      // The weapons system owns blasts (damage falloff, cover, effects, noise); without it, damage directly.
      // Damage reaching other explodables sets them off: chain reactions.
      cleanup.push(
        game.events.on("object:explode", (x) => {
          if (x.radius <= 0 || x.damage <= 0) return;
          const bar = game.services.player?.entity.maxHealth ?? 3;
          const damage = (x.damage / 100) * bar;
          const weapons = game.services.weapons;
          if (weapons?.explode) {
            // Level data: full damage within "falloff", fading to 0 at "radius". Weapons: fade band width.
            const reach = Math.max(x.radius, x.falloff);
            weapons.explode(x.position, null, reach, reach - x.falloff, damage, "object");
            return;
          }
          const reach = Math.max(x.radius, x.falloff);
          for (const e of game.entities.all()) {
            if (!e.alive || objects.entityTasks.get(e.id)?.node.id === x.taskId) continue;
            const center: Vec3 = [e.position[0], e.position[1], e.position[2] + e.height / 2];
            const d = vec3.distance(center, x.position);
            if (d > reach) continue;
            const f = d <= x.falloff ? 1 : 1 - (d - x.falloff) / Math.max(1, reach - x.falloff);
            game.events.emit("damage", { targetId: e.id, amount: damage * f, sourceId: null, point: center, direction: vec3.normalize(vec3.sub(center, x.position)) });
          }
          game.events.emit("noise", { position: x.position, radius: 150 * METRE, sourceId: null, kind: "explosion" });
        }),
      );
      // An AI soldier raised the alarm: hit the nearest alarm pad so the level's own alarm logic runs.
      cleanup.push(
        game.events.on("alarm", (a) => {
          if (logic.emittingAlarm || !a.active || logic.alarm()) return;
          const src = a.sourceId === null ? undefined : game.entities.get(a.sourceId);
          logic.raiseAlarm(src?.position ?? null);
        }),
      );
      cleanup.push(
        game.events.on("death", (d) => {
          // Only while the HumanPlayer task exists: a stray round landing during the outro must not fail a won level.
          if (d.entityId === game.services.player?.entity.id && deathTimer < 0 && logic.playerActive()) deathTimer = DEATH_FAIL_DELAY;
        }),
      );

      const service: MissionService = {
        number: info.number,
        title: info.title,
        description: info.description,
        briefingLines: info.briefing.length ? info.briefing : briefingLines(strings, info.number),
        get briefing() {
          return this.briefingLines.join("\n");
        },
        objectives: () =>
          logic.visibleObjectives().map(
            (o): Objective => ({ text: o.text, state: o.state, key: o.key, index: o.index, position: linkPosition(o.link) }),
          ),
        elapsed: () => logic.time,
        alarm: () => logic.alarm(),
        cutscene: () => !!logic.cutscene(),
        ended: () => logic.ended,
        prompt: (): UsePrompt | null =>
          target ? { text: target.useText(), progress: hold && hold.task === target ? hold.time / target.holdTime() : 0, taskId: target.node.id } : null,
        text: (key) => strings.get(key),
        evaluate: (src, self) => logic.evaluateSource(src, self),
        use: (_entityId, taskId) => {
          const t = logic.tasks.find((x) => x.node.id === taskId && x.active);
          if (!t || !isUsable(t) || !t.canUse()) return false;
          t.use(_entityId);
          return true;
        },
        alarmPads: () => logic.alarmSwitches().map((s) => ({ taskId: s.node.id, position: s.worldPosition() })),
      };
      game.services.mission = service;

      function linkPosition(id: number): Vec3 | null {
        if (id < 0) return null;
        const e = game.entities.byTask(id);
        if (e) return e.position;
        const n = tree.byId.get(id);
        const p = n && (n.params["Position"] ?? n.params["Position start"]);
        return Array.isArray(p) ? pvec(n!, n!.params["Position"] ? "Position" : "Position start") : null;
      }
    },

    update(dt, game) {
      const player = game.services.player;
      const input = game.input;

      // The player exists only while its HumanPlayer task does (not during intro/outro cutscenes).
      const present = logic.playerActive() && !logic.ended;
      if (player) {
        if (!present && !player.frozen) {
          player.frozen = true;
          frozeByUs = true;
        } else if (present && frozeByUs) {
          player.frozen = false;
          frozeByUs = false;
        }
      }

      // Use key: instant uses fire on press; timed ones (hack, pick lock, place C4, search) need F held.
      target = null;
      if (player && present && !player.frozen && player.entity.alive) {
        target = logic.useTarget(player.eye(), direction(player.yaw, player.pitch));
        if (target && input.wasPressed("use")) {
          if (target.holdTime() <= 0) target.use(player.entity.id);
          else hold = { task: target, time: 0 };
        }
        if (hold) {
          if (!input.isDown("use") || hold.task !== target || !target.canUse()) hold = null;
          else if ((hold.time += dt) >= target.holdTime()) {
            target.use(player.entity.id);
            hold = null;
          }
        }
      } else hold = null;

      const breakKey = !!logic.cutscene() && (input.wasPressed("jump") || input.wasPressed("fire") || input.wasPressed("use"));
      logic.update(dt, breakKey);

      if (deathTimer >= 0 && (deathTimer -= dt) <= 0 && !logic.ended) logic.end(false, "killed");

      objects.update();
    },

    // After the player system has placed its camera, so a running cutscene owns the view.
    lateUpdate(_dt, game) {
      playCutscene(game);
    },

    dispose(game) {
      for (const c of cleanup) c();
      objects?.dispose();
      if (frozeByUs && game.services.player) game.services.player.frozen = false;
    },
  };

  /** Scripted camera: EditCamera keys of the running CutScene (see docs/formats/mission.md for the angles). */
  function playCutscene(game: Parameters<NonNullable<GameSystem["update"]>>[1]) {
    const cut = logic.cutscene();
    if (cut !== wasCutscene) {
      if (wasCutscene) game.events.emit("cutscene", { active: false, taskId: wasCutscene.node.id });
      if (cut) game.events.emit("cutscene", { active: true, taskId: cut.node.id });
      wasCutscene = cut;
    }
    if (!cut || cut.keys.length === 0) return;
    const t = cut.keyTime;
    let i = cut.keys.length - 1;
    while (i > 0 && cut.keys[i].start > t) i--;
    const a = cut.keys[i];
    const b = cut.keys[i + 1];
    const f = b && a.smooth && a.duration > 0 ? Math.min(1, (t - a.start) / a.duration) : 0;
    const s = f * f * (3 - 2 * f);
    const lerp = (x: number, y: number) => x + (y - x) * s;
    const eye: Vec3 = b ? [lerp(a.position[0], b.position[0]), lerp(a.position[1], b.position[1]), lerp(a.position[2], b.position[2])] : a.position;
    let yaw = b ? lerpAngle(a.gamma, b.gamma, s) : a.gamma;
    // Alpha is measured from straight down: -PI/2 looks at the horizon.
    let pitch = (b ? lerp(a.alpha, b.alpha) : a.alpha) + Math.PI / 2;
    const roll = b ? lerp(a.beta, b.beta) : a.beta;
    const look = a.target >= 0 ? targetPosition(game, a.target) : null;
    if (look) {
      const d = vec3.sub(look, eye);
      yaw = Math.atan2(-d[0], d[1]);
      pitch = Math.atan2(d[2], Math.hypot(d[0], d[1]));
    }
    // FOV is horizontal, 1 = 90 degrees; three.js wants vertical degrees.
    const h = (b ? lerp(a.fov, b.fov) : a.fov) * (Math.PI / 2);
    const v = 2 * Math.atan(Math.tan(h / 2) / game.camera.aspect);
    game.setView(eye, yaw, pitch, (v * 180) / Math.PI, roll);
  }

  function targetPosition(game: Parameters<NonNullable<GameSystem["update"]>>[1], id: number): Vec3 | null {
    const e = game.entities.byTask(id);
    if (e) return [e.position[0], e.position[1], e.position[2] + e.height / 2];
    const n = logic.tree.byId.get(id);
    if (!n) return null;
    const p = n.params["Position"] ?? n.params["Holder Position"] ?? n.params["Position start"];
    return Array.isArray(p) ? [p[0], p[1], p[2]] : null;
  }
}

function lerpAngle(a: number, b: number, f: number) {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + d * f;
}
