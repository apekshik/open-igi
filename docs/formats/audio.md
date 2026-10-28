# Audio: sound library, SoundDefs and level sound tasks

The sample container (ILSF) is in [FORMATS.md](../FORMATS.md#ilsf-sounds) and decoded by `src/formats/ilsf.ts`. This
note covers what sits on top of it, as implemented in `src/game/audio/`.

## Where sounds live

| source | paths after normalisation |
|---|---|
| loose `.wav` | `missions/location0/level<N>/sounds/*.wav` (dialogue, cutscene SFX, per-level ambience) |
| `common/sounds/sounds.res` (333) | `common/sounds/<name>.wav` (weapons, footsteps, impacts, doors, vehicles, alarm...) |
| `menusystem/SOUND/sounds.res` (13) | `menusystem/sound/<name>.wav` (`menu_music` is a 38 s stereo track, plus UI clicks) |

Archive entries are stored as `LOCAL:common/sounds/x.wav`. A game path is normalised by stripping `LOCAL:`,
lowercasing and using `/`. That makes 740 sounds in the retail install.

## sounds.qvm: SoundDefs

`common/sounds/sounds.qvm` and each level's `sounds/sounds.qvm` are declarative scripts of `DefineGroup(name,
DefineSound(...)...)`. Tasks and scripts name a sound by its SoundDef, not by file. Layout (observed; 380 defs in level 1):

```
DefineSound(name, file, x, y, z, volume, minDist, maxDist, -1, -1, -1, -1, loop)
```

- `file` is the sample stem (`"M1_HELIGEN01"` -> `m1_heligen01.wav`, looked up in the level's `sounds/` then
  `common/sounds/`).
- `x y z` is an authored position in IGI units (0,0,0 = none).
- `volume` is a 0..1 gain; `minDist`/`maxDist` are metres (gunshots 0..65, sniper rifle 0..100, the alarm 40..80,
  ambience beds 0..1000). The four `-1` fields are unused in every level except three defs.
- `loop` is `TRUE`/`FALSE`.
- Groups: `VOICE` (cutscene speech), `GUN SHOTS`, `FOOTSTEPS`, `ENVIRONMENT`, `CUTSCENE SFX`, `INGAME SFX`, ...

A few tasks and mission scripts reference defs that do not exist (`cr_1`, `dogs_01`, `hammer_1`, `helicopter_cut`, ...
in levels 3, 6, 10, 11, 12); the original game silently skips them and so do we.

## AmbientArea

`Task_New(id, "AmbientArea", name, x, y, z, a, b, c, sx, sy, sz, minDelay, randomWait, soundDefs)`

A box centred on the position, rotated by `c` about Z, with a size in metres. `soundDefs` is a space-separated list.

- Looping def: audible while the listener is inside; we fade it out over a margin around the box (30 % of the smaller
  horizontal side, 4..30 m) and place it at the nearest point of the box, so walking past a machinery room pans it.
  Overlapping areas with the same def are merged into one voice at the loudest area.
- Non-looping def: one random pick of the list every `minDelay + random(0..randomWait)` seconds while inside.

Box sizes run from 2 m (electricity poles) to 10 km (the outdoor wind beds).

## ConditionalSound

`Task_New(id, "ConditionalSound", name, condition, soundDef, x, y, z, simple, oneShot, relativeToMicrophone)`

Plays `soundDef` while `condition` holds (loops) or once on each rising edge (non-looping). Position 0,0,0 or the
relative-to-microphone flag makes it 2D. Conditions are task variable expressions such as `AlarmControl_98.isAlarm` or
`CutScene_1200.nTick > 11.5*GAME_FREQUENCY`; `src/game/audio/expr.ts` evaluates them. `GAME_FREQUENCY` is taken as 30
ticks per second unless the variable resolver says otherwise.

Both task types sit inside `ConditionalContainer` tasks (`Condition`, `Run at start`, `Run at stop`) which gate everything
beneath them: the ambient areas live in "Main character" containers that run only when the intro/outro cutscene
containers do not, and the cutscene sounds live inside those cutscene containers. We evaluate containers ourselves
(`ConditionalContainer_<id>.isRun`), so by default the ambience runs and cutscene audio waits for the mission system to
report cutscene state through `audio.setVariableResolver`. Unknown variables make an expression unknown, which counts as
not running.

## Music

The retail install has one music track, `menu_music`. In-game there is no score; each level's `m<N>_ambience.wav`
(30..42 s) is the base ambience bed, played by a looping AmbientArea covering the map. Cutscene containers call
`Game_DisableMusic()` / `Game_EnableMusic()` around the cutscene (seen in level 1).

## Playback notes

- Web Audio, one `AudioContext` created on the first user gesture (or immediately if the page already has sticky
  activation). Samples are decoded with an `OfflineAudioContext`'s `createBuffer`, so they can be ready before that.
- Positional sounds use `PannerNode` in metres (IGI units / 4096), `linear` distance model with the SoundDef's
  `minDist`..`maxDist`, `equalpower` panning; the listener follows the camera each frame.
- Buses: master -> compressor -> out, with effects / voice / music / ambience below. Volumes persist in
  `localStorage["igi.audio"]`.
- Voice limit 40, at most 6 copies of one sample; stealing prefers lower priority, then the farthest voice.
