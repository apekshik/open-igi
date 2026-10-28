// Level view: the terrain plus every model placed by the level's objects.qvm, with a fly camera starting at the player.
// WASD/QE to move (shift = fast), drag to look.
import * as THREE from "three";
import { loadLevel, METRE } from "../level/load.ts";
import { TerrainRenderer } from "../render/terrain.ts";
import type { Vfs } from "../vfs/vfs.ts";
import { createStage, levelNames } from "./stage.ts";

export function levelViewer(vfs: Vfs, toolbar: HTMLElement, host: HTMLElement, status: (s: string) => void) {
  const params = new URLSearchParams(location.search);
  const levelSelect = document.createElement("select");
  toolbar.append(levelSelect);
  const levels = levelNames(vfs);
  levelSelect.replaceChildren(...levels.map((l) => new Option(l, l)));
  levelSelect.value = params.get("level") ?? levels[0];

  const { scene, camera, renderer } = createStage(host);
  camera.near = 0.1 * METRE;
  camera.far = 20000 * METRE;
  camera.updateProjectionMatrix();
  scene.fog = new THREE.Fog(0x9aa7b4, 300 * METRE, 4000 * METRE);
  scene.background = new THREE.Color(0x9aa7b4);

  // Dev-only handle for debugging from the console.
  if (import.meta.env.DEV) Object.assign(window, { igi: { scene, camera, renderer, terrain: () => terrain } });

  // World is built in IGI space (Z up) relative to `origin` to keep float precision, then turned Y-up.
  const world = new THREE.Group();
  world.rotation.x = -Math.PI / 2;
  scene.add(world);

  const keys = new Set<string>();
  let yaw = 0;
  let pitch = -0.15;
  addEventListener("keydown", (e) => keys.add(e.code));
  addEventListener("keyup", (e) => keys.delete(e.code));
  let dragging = false;
  renderer.domElement.addEventListener("pointerdown", () => (dragging = true));
  addEventListener("pointerup", () => (dragging = false));
  addEventListener("pointermove", (e) => {
    if (!dragging) return;
    yaw -= e.movementX * 0.004;
    pitch = Math.max(-1.5, Math.min(1.5, pitch - e.movementY * 0.004));
  });

  let terrain: TerrainRenderer | null = null;
  let origin: [number, number, number] = [0, 0, 0];
  let last = performance.now();
  renderer.setAnimationLoop((now) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    camera.rotation.set(pitch, yaw, 0, "YXZ");
    const speed = (keys.has("ShiftLeft") ? 60 : 12) * METRE * dt;
    const move = new THREE.Vector3(
      (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0),
      (keys.has("KeyE") ? 1 : 0) - (keys.has("KeyQ") ? 1 : 0),
      (keys.has("KeyS") ? 1 : 0) - (keys.has("KeyW") ? 1 : 0),
    );
    if (move.lengthSq()) camera.position.add(move.normalize().multiplyScalar(speed).applyEuler(camera.rotation));
    // Camera (three.js, Y up) back to IGI world space (Z up).
    terrain?.update([camera.position.x + origin[0], -camera.position.z + origin[1], camera.position.y + origin[2]]);
    renderer.render(scene, camera);
  });

  // ?cam=x,y,z,yaw,pitch: metres east/north/up of the player start, and degrees. Default: just behind the start.
  function placeCamera() {
    const [x, y, z, yawDeg, pitchDeg] = (params.get("cam") ?? "0,-12,2,0,-8").split(",").map(Number);
    camera.position.set(x * METRE, z * METRE, -y * METRE);
    yaw = THREE.MathUtils.degToRad(yawDeg || 0);
    pitch = THREE.MathUtils.degToRad(pitchDeg || 0);
    camera.rotation.set(pitch, yaw, 0, "YXZ");
  }

  async function load(level: string) {
    status(`loading ${level}...`);
    world.clear();
    terrain = null;
    const { library, objects, terrain: terrainInputs } = await loadLevel(vfs, level);
    origin = objects.playerStart ?? objects.placements[0]?.position ?? [0, 0, 0];

    const t0 = performance.now();
    terrain = new TerrainRenderer({
      ...terrainInputs,
      origin,
      radius: 6000 * METRE,
      minLevel: 7,
      detail: Number(new URLSearchParams(location.search).get("detail") ?? 4),
      fog: { color: (scene.fog as THREE.Fog).color, near: (scene.fog as THREE.Fog).near, far: (scene.fog as THREE.Fog).far },
      rebuildDistance: 20 * METRE,
    });
    world.add(terrain.group);
    placeCamera();
    terrain.update([camera.position.x + origin[0], -camera.position.z + origin[1], camera.position.y + origin[2]]);
    const terrainMs = performance.now() - t0;

    let placed = 0;
    const missing = new Set<string>();
    for (const p of objects.placements) {
      const built = library.build(p.model);
      if (!built) {
        missing.add(p.model);
        continue;
      }
      const mesh = new THREE.Mesh(built.geometry, built.materials);
      mesh.position.set(p.position[0] - origin[0], p.position[1] - origin[1], p.position[2] - origin[2]);
      mesh.rotation.set(p.rotation[0], p.rotation[1], p.rotation[2], "ZYX");
      world.add(mesh);
      placed++;
    }

    // Player marker: a 1.8 m post where Jones starts.
    const marker = new THREE.Mesh(new THREE.CylinderGeometry(0.3 * METRE, 0.3 * METRE, 1.8 * METRE), new THREE.MeshBasicMaterial({ color: 0xff3030 }));
    marker.rotation.x = Math.PI / 2;
    marker.position.z = 0.9 * METRE;
    world.add(marker);

    placeCamera();
    const q = new URLSearchParams({ view: "level", level });
    if (params.get("cam")) q.set("cam", params.get("cam")!);
    history.replaceState(null, "", `?${q}`);
    status(
      `${level}: ${placed}/${objects.placements.length} placed, terrain ${terrain.triangles} tris built in ${terrainMs.toFixed(0)} ms` +
        (missing.size ? ` (missing ${[...missing].slice(0, 5).join(", ")})` : "") +
        ` | WASD/QE move, shift fast, drag to look | red post = player start`,
    );
  }

  levelSelect.addEventListener("change", () => load(levelSelect.value));
  if (levels.length) load(levelSelect.value);
}
