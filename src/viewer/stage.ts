// Shared three.js setup for the viewers.
import * as THREE from "three";
import type { Vfs } from "../vfs/vfs.ts";

export function createStage(host: HTMLElement) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
  renderer.setPixelRatio(devicePixelRatio);
  host.append(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x30343a);
  scene.add(new THREE.HemisphereLight(0xdde6ff, 0x3a3328, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  sun.position.set(1, 2, 1.5);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(50, 1, 1, 1e6);
  const resize = () => {
    const { clientWidth: w, clientHeight: h } = host;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(host);
  return { scene, camera, renderer };
}

/** Mission levels present in the install ("level1".."level14"), in numeric order. */
export function levelNames(vfs: Vfs): string[] {
  return vfs
    .list()
    .map((p) => p.match(/^missions\/location0\/(level\d+)\/\1\.mtp$/)?.[1])
    .filter((x): x is string => !!x)
    .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
}
