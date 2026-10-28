# Project rules

open-igi exists so people can play Project I.G.I. again on modern machines. The game no longer runs reliably on
current Windows and is not sold anywhere. open-igi is free and non-commercial.

1. **No game data in the repo.** No archives, models, textures, sounds, scripts, levels or the executable, and no
   excerpts large enough to reconstruct them. Small byte-level examples to explain a format are fine.
2. **Players bring their own copy.** The web build ships nothing from the game. Players point it at their own install.
3. **No copy-protection work.** We never patch, bypass or document disc checks or other DRM. The engine only reads data
   files.
4. **Reverse-engineering references are allowed, with credit.** We may use community research on the original game,
   including code derived from decompiling `IGI.exe`, when its license permits. Every such source is credited in
   [THIRD_PARTY.md](../THIRD_PARTY.md) and linked from the code that relies on it.
5. **Write it in our own engine's terms.** Port behaviour and formats into open-igi's TypeScript and three.js design
   rather than transliterating another codebase line by line, so the engine stays coherent and maintainable.
