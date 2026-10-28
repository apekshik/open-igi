// Builds terrain meshes off the main thread for TerrainRenderer: receives the terrain data once, then a viewpoint per
// rebuild, and posts back the three layers' typed arrays (transferred, not copied).
import { buildTerrain, type BuildOptions, type TerrainData, type TerrainLayer } from "../level/terrain.ts";

export type TerrainWorkerRequest = { type: "data"; data: TerrainData } | { type: "build"; id: number; options: BuildOptions };
export interface TerrainWorkerResult {
  id: number;
  base: TerrainLayer;
  blend: TerrainLayer;
  light: TerrainLayer;
}

let data: TerrainData | null = null;
const scope = self as unknown as { onmessage: ((e: MessageEvent<TerrainWorkerRequest>) => void) | null; postMessage(m: unknown, t: Transferable[]): void };

scope.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === "data") {
    data = msg.data;
    return;
  }
  if (!data) return;
  const mesh = buildTerrain(data, msg.options);
  const layers = [mesh.base, mesh.blend, mesh.light];
  const transfer = layers.flatMap((l) => [l.positions.buffer, l.uvs.buffer, l.alpha.buffer, l.texture.buffer, l.indices.buffer]);
  scope.postMessage({ id: msg.id, base: mesh.base, blend: mesh.blend, light: mesh.light } satisfies TerrainWorkerResult, transfer);
};
