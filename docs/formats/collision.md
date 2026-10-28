# Collision: `.mef` collision sets, materials, terrain height

Reader: `src/formats/collision.ts` (`decodeCollision`, `checkCollisionMesh`). Runtime: `src/game/physics/`.
Check every model of every level with `npm run collision -- <PC folder>`.

## Chunks (confirmed)

After the render chunks, a model with collision has `CMSH` followed by two sets of four chunks, always in this order
(714 of 715 such models; one adds a trailing `NAXT`):

```
CMSH  CVTX CFCE CMAT CSPH   CVTX CFCE CMAT CSPH
      \----- set 0 -----/   \----- set 1 -----/
```

Either set may be empty (all four chunks zero-length). All 1,623 distinct models in the 14 levels plus the shared
`location0` archive decode with every count matching its chunk size, every index in range and every sphere tree
well formed. `MESH +0x6C` and `+0x70` equal the faces and vertices of both sets together in all of them.

| chunk | record | layout |
|---|---|---|
| `CMSH` | 2 × 32 bytes | per set: `u32 faces, vertices, groups, spheres`, then 16 bytes the loader overwrites with pointers |
| `CVTX` | 16 bytes | `f32 x, y, z, 0` (model space, like `VRTX`) |
| `CFCE` | 8 bytes | `u16 i0, i1, i2, group` (group indexes `CMAT`) |
| `CMAT` | 12 bytes | `f32 flag, i16 link, i16 part, u16 material, u16 (uninitialised)` |
| `CSPH` | 24 bytes | `f32 x, y, z, radius, u16 face, u16 leaf, u16 firstChild, u16 nextSibling` |

### The two sets

- **Set 0, "hit"**: the model's real shape, matching the render mesh (rays against both agree within 10 cm on
  100% of building and fence hits and 98.6% of rigid-object hits in Mission 1). Faces are grouped by `CMAT` and every
  group carries a game material (Concrete, Wood, Glass, Fence, Flesh, ...). Bullets, sight and surface sounds use it.
- **Set 1, "human"**: an optional coarse hull, every face in one group with material 21 `HumanCollision`. It is the
  real shape grown outwards by about a person's radius (median 808 units ≈ 0.2 m per side over all models with both
  sets), with openings where people walk in. Characters move against it.

| model type | models | with set 0 | with set 1 |
|---|---:|---:|---:|
| 3 static | 1,193 | 569 | 420 |
| 0 rigid | 304 | 114 | 36 |
| 1 skinned | 126 | 26 | 0 |

Models with only set 1 are invisible blockers: `colbox`, `colbox2`..`colbox4`, `colbox66`, `cylinder`.

Type 1 (character) collision is bone-relative like their render vertices; `part` numbers its groups 0..n-1 and the
materials are Flesh (8), BloodyFlesh (9) and Textiles/metal, i.e. per-body-part hit volumes.

### `CMAT` groups (partial)

- `material` is a game material id from `material/material.qvm` (below), or `0xFFFF` for none.
- Numbered groups have `flag` 0, `link` -1 and `part` 0, 1, 2, ... in order.
- One catch-all group per set has `flag` 1, `part` -1 (in set 1 it is the whole hull, material 21).
- Groups with `link` ≥ 0 have no material and fill openings: on building 410_01_1 they are the window panes and
  the garage door of the front wall. We leave them open to rays and sight (doors are separate `Door` objects).
- The last `u16` holds values such as `0xC25B` that look like leftover float halves; treat as garbage.

### `CSPH` sphere tree (confirmed)

`2 * faces - 1` nodes, a binary tree rooted at node 0 using first-child / next-sibling links (0 = none, as node 0
can be no one's child). Leaves have `leaf` = 1 and `face` = their triangle; inner nodes have `face` = 0xFFFF.
Every face appears in exactly one leaf and each leaf sphere contains its triangle. open-igi builds its own BVH over
the placed world instead of using these per-model trees.

## Materials: `material/material.qvm` (confirmed ids)

`SetActiveMaterial(n)` then `DefineQMaterial(transparency, ...)` and `DefineGameMaterial(name, ?, ?, ?, passThrough,
?, 6 footstep sounds, landing sound, rain sound, 6 bullet-impact sounds, ..., decals, impact effect models)` define
24 materials:

```
0 Air        1 Ground      2 Water       3 Wood         4 Carton       5 StrongMetal  6 NormalMetal  7 SoftMetal
8 Flesh      9 BloodyFlesh 10 Textiles   11 Concrete    12 Runway      13 Rug         14 Glass       15 Plastic
16 Porcelain 17 Rubber     18 Fence      19 Gravel      20 Snow        21 HumanCollision 22 MetalLadder 23 MetalFence
```

`transparency` is 1 for Air, Glass and the three invisible collision materials, 0.8 for Fence, else 0; open-igi lets
sight through surfaces above 0.5. `passThrough` (TRUE for Air, Water, Carton, Snow, HumanCollision, MetalLadder,
MetalFence) is read as "not solid for bullets" on model faces (unconfirmed).

Terrain materials map to game materials through `terrain/terrain.qvm`: the second argument of
`CreateTerrainMaterial(index, gameMaterial, ...)` is 1 (Ground) in most levels and 20 (Snow) in levels 7, 8, 11, 12.
The terrain material at a point is the innermost texture modifier whose bitmap is set there (as the renderer).

## Terrain height (ported)

`GetZ`/`RecursiveGetZ` (hjcminus/Project-IGI-Terrain, see THIRD_PARTY.md) walk the octree to the level-16 leaf cube
under (x, y), visiting octants in the order 4, 0, 5, 1, 6, 2, 7, 3 (each x/y quadrant's upper cube first), rebuild
the leaf mesh with its transform and the deepest height patch, and return the plane height of the first triangle
whose edges all have the point on their left (counter-clockwise from above). Cubes above level 16 with no children
have no surface. Mission 1's 26 buildings sit on this surface within 1 cm (25 of 26; the other is an interior
placed 3 km underground).

## How open-igi uses it

| query | geometry |
|---|---|
| `raycast`, bullets | set 0 faces except pass-through materials and openings; terrain leaf triangles |
| `lineOfSight` | as raycast, also ignoring see-through materials (Glass, Fence) |
| `move`, `groundHeight` | set 1 hull with the capsule radius minus 808; set 0 with a thin 0.1 m radius on hulled models and the full radius on models without a hull; terrain |
