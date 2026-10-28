// World system: IGI's sky (dome + cloud layers), sun, ambient light and fog from the level's EnvironmentalEffects
// tasks, and the static world drawn the way the original lights it (baked .olm lightmaps on buildings, the sun on
// everything else) with model LODs, merged buildings and instanced props.
//
// Game.load() places every static model as its own mesh in Game.staticObjects (other systems raycast them). This system
// keeps those meshes for collision but hides them, gives them their attached sub-models (rooms, lamps) as invisible
// children, and draws the world with StaticRenderer instead.
import * as THREE from "three";
import { decodeTex } from "../../formats/tex.ts";
import { SkyRenderer } from "../../render/sky.ts";
import { createStaticUniforms, StaticMaterials, StaticRenderer } from "../../render/statics.ts";
import { METRE, toThreeDir, type Vec3 } from "../coords.ts";
import type { Game, GameSystem } from "../game.ts";
import type { WorldService } from "./api.ts";
import { readEnvironment, type Rgb } from "./environment.ts";
import { gatesOpen } from "../mission/gates.ts";
import { Splines } from "./splines.ts";
import { clusterParts, collectStatics, loadLodTable, LodChains, type StaticNode } from "./statics.ts";

const hex = (c: Rgb) => (to8(c[0]) << 16) | (to8(c[1]) << 8) | to8(c[2]);
const to8 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
const clamp01 = (c: Rgb): Rgb => c.map((v) => Math.min(1, Math.max(0, v))) as Rgb;

export function worldSystem(): GameSystem {
  let sky: SkyRenderer | null = null;
  let statics: StaticRenderer | null = null;
  let splines: Splines | null = null;
  let collidersAttached = false;
  const gated: { mesh: THREE.Mesh; gates: number[] }[] = [];
  const eye = new THREE.Vector3();

  return {
    name: "world",
    async init(game) {
      const env = readEnvironment(game.level.statements);
      const fog = { color: hex(env.fog.color), near: env.fog.near, far: env.fog.far };
      const raw = (c: Rgb) => new THREE.Color().setRGB(...clamp01(c), THREE.SRGBColorSpace);
      game.scene.background = raw(env.sky.fogColor);
      game.scene.fog = new THREE.Fog(raw(env.fog.color), fog.near, fog.far);

      // three.js-lit materials (characters, pickups): the sun's front colour plus the back colour as ambient.
      const sunDir = toThreeDir(env.sun.direction).normalize();
      for (const light of game.scene.children) {
        if (light instanceof THREE.HemisphereLight) {
          light.color.copy(raw(env.sun.back));
          light.groundColor.copy(raw(env.sun.back)).multiplyScalar(0.6);
          light.intensity = 1;
        } else if (light instanceof THREE.DirectionalLight) {
          light.color.copy(raw(env.sun.front));
          light.intensity = 1;
          light.position.copy(sunDir);
        }
      }

      // Sky.
      const layers = [];
      for (const l of env.sky.layers) {
        const path = l.texture.replaceAll("\\", "/");
        if (!game.vfs.has(path)) continue;
        layers.push({ ...l, texture: decodeTex(await game.vfs.read(path)) });
      }
      sky = new SkyRenderer({ metre: METRE, ...env.sky, layers });
      game.scene.add(sky.group);

      // Static world.
      const uniforms = createStaticUniforms();
      uniforms.fogColor.value.set(...clamp01(env.fog.color));
      uniforms.fogNear.value = fog.near;
      uniforms.fogFar.value = fog.far;
      uniforms.sunDir.value.copy(sunDir);
      uniforms.sunFront.value.set(...env.sun.front);
      uniforms.sunBack.value.set(...env.sun.back);
      const library = game.level.library;
      const chains = new LodChains(library, env, await loadLodTable(game.vfs));
      const scene = await collectStatics(game.vfs, game.level.dir, game.level.statements, game.level.objects.placements, library, game.origin);
      statics = new StaticRenderer(library, new StaticMaterials(uniforms));
      // Models inside ConditionalContainers exist only while those run (SAM sites swapped for their wrecks, props of
      // the intro flyover, C4 that appears once planted): drawn as their own meshes and shown by gatesOpen().
      const gatedNodes = new Map<StaticNode, number[]>();
      for (const [placement, node] of scene.byPlacement) {
        if (!placement.gates?.length) continue;
        const add = (n: StaticNode) => (gatedNodes.set(n, placement.gates!), n.attachments.forEach(add));
        add(node);
      }
      for (const nodes of scene.clusters) {
        const kept = nodes.filter((n) => !gatedNodes.has(n));
        if (kept.length) statics.addCluster(clusterParts(kept, chains));
      }
      for (const n of scene.loose) if (!gatedNodes.has(n)) statics.addInstance(chains.get(n.model), n.matrix);
      for (const n of gatedNodes.keys()) statics.reserve(n.model);
      splines = new Splines(game.level.statements, library, statics, game.origin);
      statics.finish();
      splines.createTrains(library, statics);
      game.world.add(statics.group, splines.group);
      for (const [n, gates] of gatedNodes) {
        const mesh = statics.createMesh(n.model);
        if (!mesh) continue;
        mesh.matrixAutoUpdate = false;
        mesh.matrix.copy(n.matrix);
        mesh.visible = false;
        statics.group.add(mesh);
        gated.push({ mesh, gates });
      }

      // Keep the per-placement meshes for collision only, with their attachments as children.
      for (const obj of game.staticObjects) {
        obj.visible = false;
        const node = scene.byPlacement.get(obj.userData.placement);
        if (node) addCollisionChildren(game, obj, node);
      }

      const renderer = statics;
      const trains = splines;
      const service: WorldService = {
        fog,
        sun: { direction: env.sun.direction as Vec3, front: env.sun.front, back: env.sun.back },
        stats: () => ({ ...renderer.stats(), ...scene.lightMapStats }),
        train: (id) => trains.train(id),
        trainCar: (id, index) => trains.car(id, index),
        resetTrain: (id) => trains.reset(id),
      };
      game.services.world = service;
    },

    update(dt, game) {
      // Train cars collide once the physics system (initialised after this one) is up.
      if (splines && game.services.physics && !collidersAttached) {
        splines.attachColliders(game.services.physics);
        collidersAttached = true;
      }
      splines?.update(dt);
      for (const g of gated) g.mesh.visible = gatesOpen(game, g.gates);
    },

    lateUpdate(dt, game) {
      sky?.update(dt, game.camera.position);
      if (statics) {
        const p = game.fromScene(game.camera.position);
        statics.update(eye.set(p[0] - game.origin[0], p[1] - game.origin[1], p[2] - game.origin[2]));
      }
    },
  };
}

/** Attachments as invisible children of their placement's mesh, so raycasts against staticObjects hit them. */
function addCollisionChildren(game: Game, obj: THREE.Object3D, node: StaticNode) {
  obj.updateMatrix();
  const inverse = obj.matrix.clone().invert();
  const add = (n: StaticNode) => {
    for (const a of n.attachments) {
      const built = game.level.library.build(a.model);
      if (built) {
        const child = new THREE.Mesh(built.geometry, built.materials);
        child.matrixAutoUpdate = false;
        child.matrix.multiplyMatrices(inverse, a.matrix);
        child.userData.attachment = a.model;
        obj.add(child);
      }
      add(a);
    }
  };
  add(node);
  obj.updateMatrixWorld(true);
}
