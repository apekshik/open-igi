// Model browser: one level's models with textures resolved through the level's .mtp material table.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { readRes } from "../formats/ilff.ts";
import { decodeMef, type MefModel } from "../formats/mef.ts";
import { parseMtp, type MaterialTable } from "../formats/mtp.ts";
import { decodeTex } from "../formats/tex.ts";
import type { Vfs } from "../vfs/vfs.ts";

const NO_MATERIAL = 0xffff;

interface Level {
  models: Map<string, Uint8Array>;
  textures: Map<string, Uint8Array>;
  mtp: MaterialTable;
}

export function modelViewer(vfs: Vfs, toolbar: HTMLElement, stage: HTMLElement, status: (s: string) => void) {
  const params = new URLSearchParams(location.search);
  const levelSelect = document.createElement("select");
  const modelSelect = document.createElement("select");
  const wire = Object.assign(document.createElement("input"), { type: "checkbox", title: "wireframe" });
  toolbar.append(levelSelect, modelSelect, wire);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(devicePixelRatio);
  stage.append(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x30343a);
  scene.add(new THREE.HemisphereLight(0xdde6ff, 0x3a3328, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  sun.position.set(1, 2, 1.5);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(45, 1, 1, 1e6);
  const controls = new OrbitControls(camera, renderer.domElement);
  let current: THREE.Object3D | null = null;

  const resize = () => {
    const { clientWidth: w, clientHeight: h } = stage;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(stage);
  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });

  const levels = vfs
    .list()
    .map((p) => p.match(/^missions\/location0\/(level\d+)\/\1\.mtp$/)?.[1])
    .filter((x): x is string => !!x)
    .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
  levelSelect.replaceChildren(...levels.map((l) => new Option(l, l)));
  levelSelect.value = params.get("level") ?? levels[0];

  let level: Level | null = null;
  const texCache = new Map<string, THREE.Texture | null>();

  async function loadLevel(name: string) {
    status(`loading ${name}...`);
    const base = `missions/location0/${name}`;
    const archive = async (path: string) =>
      new Map(readRes(await vfs.read(path)).map((e) => [e.name.split("/").pop()!.replace(/\.\w+$/, ""), e.data]));
    level = {
      models: await archive(`${base}/models/${name}.res`),
      textures: await archive(`${base}/textures/${name}.res`),
      mtp: parseMtp(await vfs.read(`${base}/${name}.mtp`)),
    };
    texCache.clear();
    modelSelect.replaceChildren(...level.mtp.models.map((m, i) => new Option(`${i} ${m}`, String(i))));
    modelSelect.value = params.get("model") ?? "0";
    showModel(Number(modelSelect.value));
  }

  function texture(name: string): THREE.Texture | null {
    if (texCache.has(name)) return texCache.get(name)!;
    const bytes = level!.textures.get(name) ?? level!.textures.get(`${name}_argb8888`);
    let t: THREE.Texture | null = null;
    if (bytes) {
      const tex = decodeTex(bytes);
      t = new THREE.DataTexture(tex.rgba, tex.width, tex.height);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.magFilter = THREE.LinearFilter;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.generateMipmaps = true;
      t.colorSpace = THREE.SRGBColorSpace;
      t.needsUpdate = true;
    }
    texCache.set(name, t);
    return t;
  }

  function showModel(index: number) {
    if (!level) return;
    const name = level.mtp.models[index];
    const bytes = level.models.get(name);
    if (!bytes) return status(`${name}: not in models archive`);
    let model: MefModel;
    try {
      model = decodeMef(bytes);
    } catch (err) {
      return status(`${name}: ${(err as Error).message}`);
    }
    const run = level.mtp.modelTextures[index] ?? [];

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(model.positions, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(model.normals, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(model.uvs, 2));
    const all = new Uint32Array(model.batches.reduce((n, b) => n + b.indices.length, 0));
    const materials: THREE.Material[] = [];
    const used: string[] = [];
    let at = 0;
    model.batches.forEach((b, i) => {
      all.set(b.indices, at);
      geo.addGroup(at, b.indices.length, i);
      at += b.indices.length;
      const texName = b.material === NO_MATERIAL ? undefined : level!.mtp.textures[run[b.material]];
      const map = texName ? texture(texName) : null;
      used.push(`${b.material}→${texName ?? "-"}`);
      materials.push(
        new THREE.MeshLambertMaterial({
          map,
          color: map ? 0xffffff : 0x999999,
          side: THREE.DoubleSide,
          alphaTest: 0.5,
          wireframe: wire.checked,
        }),
      );
    });
    geo.setIndex(new THREE.BufferAttribute(all, 1));
    geo.computeBoundingSphere();

    if (current) scene.remove(current);
    // IGI is Z-up; three.js is Y-up.
    const mesh = new THREE.Mesh(geo, materials);
    mesh.rotation.x = -Math.PI / 2;
    current = mesh;
    scene.add(mesh);

    const sphere = geo.boundingSphere!;
    const centre = new THREE.Vector3(sphere.center.x, sphere.center.z, -sphere.center.y);
    const r = Math.max(sphere.radius, 1);
    controls.target.copy(centre);
    camera.position.copy(centre).add(new THREE.Vector3(r * 1.2, r * 0.8, r * 1.6));
    camera.near = r / 100;
    camera.far = r * 100;
    camera.updateProjectionMatrix();

    const q = new URLSearchParams({ view: "models", level: levelSelect.value, model: String(index) });
    history.replaceState(null, "", `?${q}`);
    status(
      `${name} type ${model.type}, ${model.vertexCount} verts, ${all.length / 3} tris, ${model.batches.length} batches | ${used.join(" ")}`,
    );
  }

  levelSelect.addEventListener("change", () => loadLevel(levelSelect.value));
  modelSelect.addEventListener("change", () => showModel(Number(modelSelect.value)));
  wire.addEventListener("change", () => showModel(Number(modelSelect.value)));
  addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLSelectElement) return;
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step || !level) return;
    const next = (Number(modelSelect.value) + step + level.mtp.models.length) % level.mtp.models.length;
    modelSelect.value = String(next);
    showModel(next);
  });

  if (levels.length) loadLevel(levelSelect.value);
}
