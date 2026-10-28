// Model browser: one level's models with textures resolved through the level's .mtp material table.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { poseBones, type Animation } from "../formats/anim.ts";
import { skinMef } from "../formats/mef.ts";
import { levelLibrary, type BuiltModel, type ModelLibrary } from "../render/library.ts";
import type { Vfs } from "../vfs/vfs.ts";
import { createStage, levelNames } from "./stage.ts";

export function modelViewer(vfs: Vfs, toolbar: HTMLElement, host: HTMLElement, status: (s: string) => void) {
  const params = new URLSearchParams(location.search);
  const levelSelect = document.createElement("select");
  const modelSelect = document.createElement("select");
  const wire = Object.assign(document.createElement("input"), { type: "checkbox", title: "wireframe" });
  // Skinned (type 1) models: bind pose, or one of the skeleton's animations, played back in a loop.
  const poseSelect = document.createElement("select");
  poseSelect.title = "pose";
  toolbar.append(levelSelect, modelSelect, wire, poseSelect);

  const { scene, camera, renderer } = createStage(host);
  const controls = new OrbitControls(camera, renderer.domElement);
  let current: THREE.Object3D | null = null;
  let library: ModelLibrary | null = null;
  let built: BuiltModel | null = null;
  let playing: { anim: Animation; start: number } | null = null;

  renderer.setAnimationLoop((now) => {
    if (playing && built?.skin) applyPose(built, playing.anim, now - playing.start);
    controls.update();
    renderer.render(scene, camera);
  });

  /** Re-skin `b` with an animation frame (time in ms; IGI animation time looks like ms at 1x), or the bind pose. */
  function applyPose(b: BuiltModel, anim: Animation | null, timeMs = 0) {
    const skin = b.skin!;
    const posed = skinMef(skin.model, poseBones(skin.anims.skeleton, anim ?? undefined, timeMs, true));
    const pos = b.geometry.getAttribute("position") as THREE.BufferAttribute;
    const nrm = b.geometry.getAttribute("normal") as THREE.BufferAttribute;
    (pos.array as Float32Array).set(posed.positions);
    (nrm.array as Float32Array).set(posed.normals);
    pos.needsUpdate = nrm.needsUpdate = true;
  }

  function choosePose() {
    const url = new URLSearchParams(location.search);
    if (poseSelect.value && !poseSelect.hidden) url.set("pose", poseSelect.value);
    else url.delete("pose");
    history.replaceState(null, "", `?${url}`);
    playing = null;
    if (!built?.skin) return;
    const anim = poseSelect.value === "" ? null : built.skin.anims.animations[Number(poseSelect.value)];
    if (anim) playing = { anim, start: performance.now() };
    else applyPose(built, null);
  }
  poseSelect.addEventListener("change", choosePose);

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
    try {
      built = library.build(name);
    } catch (err) {
      built = null;
      return status(`${name}: ${(err as Error).message}`);
    }
    if (!built) return status(`${name}: not found`);
    const skin = built.skin;
    poseSelect.hidden = !skin;
    poseSelect.replaceChildren(
      new Option("bind pose", ""),
      ...(skin?.anims.animations ?? []).map((a, i) => new Option(`anim ${i} (id ${a.id}, ${a.duration})`, String(i))),
    );
    poseSelect.value = params.get("pose") ?? "";
    if (poseSelect.selectedIndex < 0) poseSelect.value = "";
    params.delete("pose");
    choosePose();
    if (playing) applyPose(built, playing.anim, 0);
    built.geometry.computeBoundingSphere();

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
    // Characters face IGI +Y (three.js -Z), so look at them from the front.
    camera.position.copy(centre).add(new THREE.Vector3(r * 1.2, r * 0.8, skin ? -r * 1.6 : r * 1.6));
    camera.near = r / 100;
    camera.far = r * 100;
    camera.updateProjectionMatrix();

    const q = new URLSearchParams({ view: "models", level: levelSelect.value, model: String(index) });
    if (poseSelect.value && !poseSelect.hidden) q.set("pose", poseSelect.value);
    history.replaceState(null, "", `?${q}`);
    const tris = (built.geometry.index?.count ?? 0) / 3;
    const rig = skin ? ` | skeleton ${String(skin.anims.skeleton.hierarchy).padStart(3, "0")}.iff (fit ${skin.fitError.toFixed(1)})` : "";
    status(`${name} type ${built.type}, ${tris} tris, ${built.materials.length} batches${rig} | ${built.textureNames.join(" ")}`);
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
