// Front-end sounds: the menu music and click/hover effects from menusystem/SOUND/sounds.res, played with Web Audio.
// (In-game sound goes through the audio system; the menus run before and between games, so they play their own.)
import { readRes } from "../formats/ilff.ts";
import { decodeIlsf } from "../formats/ilsf.ts";
import type { Vfs } from "../vfs/vfs.ts";

const ARCHIVE = "menusystem/sound/sounds.res";

export type MenuSound = "menu_ok" | "menu_cancel" | "menu_high" | "menu_sel" | "menu_sel2" | `menu_k0${1 | 2 | 3 | 4 | 5 | 6 | 7}`;

export class MenuAudio {
  private vfs: Vfs;
  private ctx: AudioContext | null = null;
  private music: GainNode | null = null;
  private fx: GainNode | null = null;
  private data: Promise<Map<string, Uint8Array>> | null = null;
  private buffers = new Map<string, AudioBuffer | null>();
  private musicSource: AudioBufferSourceNode | null = null;
  private musicVolume = 0.7;
  private fxVolume = 0.9;
  private wantMusic = false;

  constructor(vfs: Vfs) {
    this.vfs = vfs;
  }

  /** Call from a user gesture: browsers only start audio after one. */
  unlock() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.music = this.ctx.createGain();
      this.fx = this.ctx.createGain();
      this.music.connect(this.ctx.destination);
      this.fx.connect(this.ctx.destination);
      this.setVolumes(this.musicVolume, this.fxVolume);
      if (this.wantMusic) void this.startMusic();
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  setVolumes(music: number, fx: number) {
    this.musicVolume = music;
    this.fxVolume = fx;
    if (this.music) this.music.gain.value = music * 0.6;
    if (this.fx) this.fx.gain.value = fx;
  }

  play(name: MenuSound) {
    if (!this.ctx || !this.fx) return;
    const ctx = this.ctx;
    const out = this.fx;
    void this.buffer(name).then((b) => {
      if (!b) return;
      const src = ctx.createBufferSource();
      src.buffer = b;
      src.connect(out);
      src.start();
    });
  }

  /** Loop the menu music (starts once audio is unlocked). */
  musicOn() {
    this.wantMusic = true;
    if (this.ctx) void this.startMusic();
  }

  musicOff() {
    this.wantMusic = false;
    if (this.musicSource && this.music && this.ctx) {
      const src = this.musicSource;
      this.music.gain.setTargetAtTime(0, this.ctx.currentTime, 0.2);
      setTimeout(() => {
        src.stop();
        this.music?.gain.setValueAtTime(this.musicVolume * 0.6, this.ctx!.currentTime);
      }, 800);
    }
    this.musicSource = null;
  }

  private async startMusic() {
    if (this.musicSource || !this.ctx || !this.music) return;
    const b = await this.buffer("menu_music");
    if (!b || !this.wantMusic || this.musicSource) return;
    const src = this.ctx.createBufferSource();
    src.buffer = b;
    src.loop = true;
    src.connect(this.music);
    src.start();
    this.musicSource = src;
  }

  private async buffer(name: string): Promise<AudioBuffer | null> {
    if (this.buffers.has(name)) return this.buffers.get(name)!;
    this.data ??= (async () => {
      const map = new Map<string, Uint8Array>();
      if (this.vfs.has(ARCHIVE)) {
        for (const e of readRes(await this.vfs.read(ARCHIVE))) map.set(e.name.slice(e.name.lastIndexOf("/") + 1).replace(/\.wav$/i, "").toLowerCase(), e.data);
      }
      return map;
    })();
    const bytes = (await this.data).get(name);
    if (this.buffers.has(name)) return this.buffers.get(name)!;
    let buffer: AudioBuffer | null = null;
    if (bytes && this.ctx) {
      try {
        const s = decodeIlsf(bytes);
        buffer = this.ctx.createBuffer(s.channels.length, s.channels[0].length, s.sampleRate);
        s.channels.forEach((c, i) => buffer!.copyToChannel(c as Float32Array<ArrayBuffer>, i));
      } catch (err) {
        console.warn(`menu sound ${name}:`, err);
      }
    }
    this.buffers.set(name, buffer);
    return buffer;
  }

  dispose() {
    this.musicOff();
    void this.ctx?.close();
    this.ctx = null;
  }
}
