/** Environment rendering: sky, lighting, fog and level-of-detail for the static world. */
export interface WorldService {
  /** Fog colour/distances in effect (world units), for systems that draw their own materials. */
  fog: { color: number; near: number; far: number };
}
