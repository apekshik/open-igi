# Clean-room rules

open-igi is an original engine. It reads IGI's data files and recreates the game's behaviour. It does not contain the game.

1. **No game data in the repo.** No archives, models, textures, sounds, scripts, levels or the executable, and no
   excerpts large enough to reconstruct them (hex dumps, extracted strings tables, screenshots of decoded assets in docs).
   Small byte-level examples to explain a format (a header, a chunk tag) are fine.
2. **No code derived from the executable.** We may study the exe in a disassembler to answer specific questions about
   behaviour or formats ("what does chunk X mean", "how fast does a guard turn"). Findings go into `docs/` as prose,
   tables and numbers. Code is then written from those notes, not translated from disassembly.
3. **No copy-protection work.** We never patch, bypass or document disc checks or other DRM. The engine only reads data files.
4. **Player-supplied data only.** The web build ships nothing from the game. Players point it at their own install.
5. **Credit community research.** When a format note comes from published research (e.g. the IGI modding community), link it.
