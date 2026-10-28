// STUB player: a free-flying spectator camera that starts at Jones's spawn point. The player system replaces it with
// Jones: walking on the ground, stances, leaning, health and the first-person view.
import { direction, METRE, vec3, type Vec3 } from "../coords.ts";
import type { GameSystem } from "../game.ts";
import type { PlayerService, Stance } from "./api.ts";

export function playerSystem(): GameSystem {
  let player: PlayerService;
  return {
    name: "player",
    init(game) {
      const start = game.level.objects.playerStart ?? game.origin;
      const entity = game.entities.create({
        kind: "player",
        position: [...start] as Vec3,
        yaw: 0,
        health: 100,
        maxHealth: 100,
        team: 0,
        alive: true,
        radius: 0.35 * METRE,
        height: 1.8 * METRE,
      });
      player = {
        entity,
        yaw: 0,
        pitch: 0,
        stance: "stand" as Stance,
        fov: 70,
        frozen: false,
        eye: () => [entity.position[0], entity.position[1], entity.position[2] + 1.65 * METRE],
      };
      game.services.player = player;
    },
    update(dt, game) {
      if (player.frozen) return;
      const look = game.input.look();
      player.yaw += look.yaw;
      player.pitch = Math.max(-1.5, Math.min(1.5, player.pitch + look.pitch));
      const i = game.input;
      const speed = (i.isDown("walk") ? 40 : 8) * METRE * dt;
      const fwd = direction(player.yaw, player.pitch);
      const right = direction(player.yaw - Math.PI / 2);
      let move: Vec3 = [0, 0, 0];
      if (i.isDown("forward")) move = vec3.add(move, fwd);
      if (i.isDown("back")) move = vec3.sub(move, fwd);
      if (i.isDown("right")) move = vec3.add(move, right);
      if (i.isDown("left")) move = vec3.sub(move, right);
      if (i.isDown("jump")) move[2] += 1;
      if (i.isDown("crouch")) move[2] -= 1;
      if (vec3.length(move) > 0) player.entity.position = vec3.add(player.entity.position, vec3.scale(vec3.normalize(move), speed));
      player.entity.yaw = player.yaw;
      game.setView(player.eye(), player.yaw, player.pitch, player.fov);
    },
  };
}
