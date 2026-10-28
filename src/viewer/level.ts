// Level view: every model placed by the level's objects.qvm, with a fly camera starting at the player.
// WASD/QE to move (shift = fast), drag to look.
import * as THREE from "three";
import { decodeQvm } from "../formats/qvm.ts";
import { levelObjects } from "../level/objects.ts";
import { levelLibrary } from "../render/library.ts";
import type { Vfs } from "../vfs/vfs.ts";
import { createStage, levelNames } from "./stage.ts";

/** IGI units per metre (approximate: the army truck is ~30,000 long). */
const METRE = 4000;

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
    renderer.render(scene, camera);
  });

  async function load(level: string) {
    status(`loading ${level}...`);
    world.clear();
    const library = await levelLibrary(vfs, level);
    const objects = levelObjects(decodeQvm(await vfs.read(`missions/location0/${level}/objects.qvm`)));
    const origin = objects.playerStart ?? objects.placements[0]?.position ?? [0, 0, 0];

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

    camera.position.set(0, 2 * METRE, 12 * METRE);
    yaw = 0;
    pitch = -0.15;
    history.replaceState(null, "", `?${new URLSearchParams({ view: "level", level })}`);
    status(
      `${level}: ${placed}/${objects.placements.length} placed` +
        (missing.size ? ` (missing ${[...missing].slice(0, 5).join(", ")})` : "") +
        ` | WASD/QE move, shift fast, drag to look | red post = player start`,
    );
  }

  levelSelect.addEventListener("change", () => load(levelSelect.value));
  if (levels.length) load(levelSelect.value);
}
