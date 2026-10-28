# 2D formats: fonts, sprites, pictures, string tables, menu scripts

Notes for the front end (`src/ui/`), HUD and map computer (`src/game/hud/`). Chunk roles and field offsets of the font
format follow flawme/igi-reverse-engineering (`reverse/docs/10-menus`, MIT); the rest was read from the files.

## Fonts (`.fnt`, ILFF form `FONT`) — `src/formats/font.ts`

Found in `menusystem/menusystem.res`, `menusystem/ingamemenu.res` (font1/3/4), `computer/computer.res` (font1/3/4)
and loose in `screens/intro/`. Chunks, in order:

| chunk | size | content |
|---|---|---|
| `FNTH` | 24 | i32 flag (1), i32 glyph count (152..154), i32 32 (unread), i32 **space advance**, i32 24, i32 **line height** |
| `ANMF` | count × 40 | per glyph: +0x04..+0x10 f32 u0 v0 u1 v1 (atlas UVs), +0x16 i16 width, +0x18 i16 height, +0x1A i16 advance, +0x24 i16 top |
| `TRAN` | 512 | u16[256]: Latin-1 code → glyph number, 1-based; 0 = none (space has no glyph) |
| `TEXH` | 24 | u16[7] atlas width, u16[8] atlas height, u16[11] bits per pixel (32) |
| `BODY` | w×h×4 | ARGB8888 (B,G,R,A in memory). Glyphs are white; alpha is coverage, so text is tinted at draw time |

`top` places the glyph rectangle inside the line box: `.` in font1 has height 1 and top 8, `-` top 6, `,` height 3
top 8 (descender). Drawing each glyph at `(pen, lineTop + top)` reproduces the original baseline. Metrics:
menusystem font1 line 11 / space 4, font3 line 21 / space 6, font4 line 15 / space 4.

## Sprites and pictures (`.spr`, `.pic`)

Both are version 9 LOOP textures (`decodeTexArray`). The header word at +0x1C points to a footer:

```
"LOOP" u32 6, u32 width, u32 height, u32 columns, u32 rows, then per image 16 bytes: u32 ?, u32 x, u32 y, u32 ?
```

- **Pictures** (`mainmenu.pic`, `loading.pic`: 150 images; `logo.pic`: 20) are 64×32 tiles placed at (x, y) to make
  one width × height image (640×480, 295×107). Width/height may be smaller than the tile grid (logo is clipped).
- **Animated sprites** have every image at (0, 0) and are frames: `clip20.spr` (61 frames, a magazine emptying,
  frame = (1 − clip/size) × 60), `barrel6.spr` (61, revolver drum), `shell7.spr` (8, frame = 7 − shells left).
- Single-image sprites have width/height left as garbage (0xCCCCCCCC or stack values); ignore them.
- `computer/computer.res` also has version 7 sprites (`arrow*`, `plus_*`, `sphere_*`); not decoded, the map draws
  without them.

Notable sprites: `status.res` `powerbarbackground` (64×78 health outline, the figure's head at x≈30) with
`powerbar` (23×70 red figure, drawn at +19,+2 and cropped from the feet up by health); `mapsphere`/`mapcircle`
quarter disc and quarter ring with the circle centre at their bottom-right corner (four rotated copies make the
compass dial); `cross` (9×9 crosshair); weapon icons; `a_*`/`action_*` context icons; `progressbar` (240×32).
`menusystem.res` `win1_*`/`win2_*` are 8-piece window frames: 1/3/5/7 corners clockwise from top-left, 2/6 top and
bottom edges, 4/8 right and left edges. `slide_1/2/3` are slider left arrow, right arrow and knob; `slidevert_*` the
vertical versions; `glow.spr` is the highlight behind the selected menu item; `pointer.spr` the mouse pointer.

## String tables

IRES archives of `NAME` (path such as `LOCAL:english/Mission 1 Name`) + `CSTR` (text) pairs:
`menusystem/english.res` (base menu labels), `language/<lang>/menusystem.res` (overrides, e.g. "Single Player" →
"Play Project IGI"), `language/<lang>/missions.res` (`Mission N Name`, `Mission N Desc`),
`language/<lang>/computer.res` (`MAP`, `OBJECTIVES`, `LOG`, `INITIALIZING`, `CONNECTING`, `DOWNLOADING`).

## Menu scripts

`menusystem/mainmenu.qvm` and `ingamemenu.qvm` declare the menus as task trees (`MenuScreen`, `MenuFrame`, `MenuText`,
`SlideBar`, `ToggleBox`, `ListBox`, `ScrollListBox`, `PictureBox`, `DialogWindow`) in 640×480 coordinates. The front
end hand-builds the same screens with those coordinates (screen frame 100,163–540,470; mission select picture at
140,210 172×128, description below it, list at 357,210 175×230; OK/Cancel at 555,400; in-game frame 85,80–555,410;
"Are you sure?" dialogs 197,234 256×133 / 220,180 200×120). MenuText `ColourIndex` 1 = title, 2 = item, 3 = small.
Menu sounds (`menu_music`, `menu_ok`, `menu_cancel`, `menu_high`, `menu_sel`, `menu_k0N`) are in
`menusystem/SOUND/sounds.res`.
