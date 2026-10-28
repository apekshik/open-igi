// Model browser: one level's models with textures resolved through the level's .mtp material table.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { levelLibrary, type ModelLibrary } from "../render/library.ts";
import type { Vfs } from "../vfs/vfs.ts";
import { createStage, levelNames } from "./stage.ts";

export function modelViewer(vfs: Vfs, toolbar: HTMLElement, host: HTMLElement, status: (s: string) => void) {
  const params = new URLSearchParams(location.search);
  const levelSelect = document.createElement("select");
  const modelSelect = document.createElement("select");
  const wire = Object.assign(document.createElement("input"), { type: "checkbox", title: "wireframe" });
  toolbar.append(levelSelect, modelSelect, wire);

  const { scene, camera, renderer } = createStage(host);
  const controls = new OrbitControls(camera, renderer.domElement);
  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });
  let current: THREE.Object3D | null = null;
  let library: ModelLibrary | null = null;

  const levels = levelNames(vfs);
  levelSelect.replaceChildren(...levels.map((l) => new Option(l, l)));
  levelSelect.value = params.get("level") ?? levels[0];

  async function loadLevel(name: string) {
    status(`loading ${name}...`);
    library = await levelLibrary(vfs, name);
    library.wireframe = wire.checked;
    modelSelect.replaceChildren(...library.levelModels.map((m, i) => new Option(`${i} ${m}`, String(i))));
    modelSelect.value = params.get("model") ?? "0";
    showModel(Number(modelSelect.value));
  }

  function showModel(index: number) {
    if (!library) return;
    const name = library.levelModels[index];
    let built;
    try {
      built = library.build(name);
    } catch (err) {
      return status(`${name}: ${(err as Error).message}`);
    }
    if (!built) return status(`${name}: not found`);

    if (current) scene.remove(current);
    // IGI is Z-up; three.js is Y-up.
    const mesh = new THREE.Mesh(built.geometry, built.materials);
    mesh.rotation.x = -Math.PI / 2;
    current = mesh;
    scene.add(mesh);

    const sphere = built.geometry.boundingSphere!;
    const centre = new THREE.Vector3(sphere.center.x, sphere.center.z, -sphere.center.y);
    const r = Math.max(sphere.radius, 1);
    controls.target.copy(centre);
    camera.position.copy(centre).add(new THREE.Vector3(r * 1.2, r * 0.8, r * 1.6));
    camera.near = r / 100;
    camera.far = r * 100;
    camera.updateProjectionMatrix();

    const q = new URLSearchParams({ view: "models", level: levelSelect.value, model: String(index) });
    history.replaceState(null, "", `?${q}`);
    const tris = (built.geometry.index?.count ?? 0) / 3;
    status(`${name} type ${built.type}, ${tris} tris, ${built.materials.length} batches | ${built.textureNames.join(" ")}`);
  }

  levelSelect.addEventListener("change", () => loadLevel(levelSelect.value));
  modelSelect.addEventListener("change", () => showModel(Number(modelSelect.value)));
  wire.addEventListener("change", () => {
    if (!library) return;
    library.wireframe = wire.checked;
    library.clear();
    showModel(Number(modelSelect.value));
  });
  addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLSelectElement || !library) return;
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    const count = library.levelModels.length;
    const next = (Number(modelSelect.value) + step + count) % count;
    modelSelect.value = String(next);
    showModel(next);
  });

  if (levels.length) loadLevel(levelSelect.value);
}
