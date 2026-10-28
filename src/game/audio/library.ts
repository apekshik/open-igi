// The game's sound library: every ILSF sample in the install (loose .wav files and the BODY entries of the sound
// archives), addressed by a normalised game path, plus the SoundDef table from sounds.qvm. Decoding is lazy and cached.
// Format notes: docs/formats/audio.md.

import { readRes } from "../../formats/ilff.ts";
import { decodeIlsf, isIlsf } from "../../formats/ilsf.ts";
import { decodeQvm, type QvmCall, type QvmValue } from "../../formats/qvm.ts";
import type { Vfs } from "../../vfs/vfs.ts";
import type { Vec3 } from "../coords.ts";

/** Normalise a game path: strip "LOCAL:", lowercase, forward slashes, no leading slash. */
export function normSoundPath(p: string): string {
  return p.replace(/^local:/i, "").replaceAll("\\", "/").replace(/^\/+/, "").toLowerCase();
}

/** One DefineSound() entry of a sounds.qvm: how the game plays a named sound. */
export interface SoundDef {
  name: string;
  /** Sample file stem (no folder, no extension), lowercase. */
  file: string;
  /** Authored default position (IGI units), null when 0,0,0. */
  position: Vec3 | null;
  volume: number;
  /** Full-volume radius and inaudible radius, in metres. */
  min: number;
  max: number;
  loop: boolean;
  /** DefineGroup name it was declared under ("VOICE", "ENVIRONMENT", ...). */
  group: string;
}

const SOUND_RES = ["common/sounds/sounds.res", "menusystem/sound/sounds.res"];
const stemOf = (path: string) => path.slice(path.lastIndexOf("/") + 1).replace(/\.wav$/, "");
const num = (v: QvmValue | undefined, d = 0) => (typeof v === "number" ? v : d);
const bool = (v: QvmValue | undefined) => v === 1 || (typeof v === "object" && "ident" in v && v.ident === "TRUE");

export interface ResolvedSound {
  path: string;
  def: SoundDef | null;
}

/** Budget for decoded sample memory; the least recently used buffers are dropped beyond it. */
const CACHE_BYTES = 192 * 1024 * 1024;

export class SoundLibrary {
  private files = new Map<string, Uint8Array | null>(); // path -> bytes (archive members, prefetched) or null (loose, not read)
  private stems = new Map<string, string[]>();
  private defsByName = new Map<string, SoundDef>();
  private defsByFile = new Map<string, SoundDef>();
  private resolved = new Map<string, ResolvedSound | null>();
  private reads = new Map<string, Promise<AudioBuffer | null>>();
  private buffers = new Map<string, AudioBuffer>();
  private bufferBytes = 0;
  private levelDir = "";
  private sorted: string[] | null = null;

  private vfs: Vfs;

  constructor(vfs: Vfs) {
    this.vfs = vfs;
  }

  /** Index every sound in the install and read the SoundDef tables for the given level folder. */
  async init(levelDir: string) {
    this.levelDir = levelDir.toLowerCase();
    for (const p of this.vfs.list()) {
      const n = normSoundPath(p);
      if (n.endsWith(".wav")) this.addPath(n, null);
    }
    await Promise.all(
      SOUND_RES.filter((p) => this.vfs.has(p)).map(async (p) => {
        try {
          for (const e of readRes(await this.vfs.read(p))) if (isIlsf(e.data)) this.addPath(normSoundPath(e.name), e.data);
        } catch (err) {
          console.warn(`audio: could not read ${p}`, err);
        }
      }),
    );
    for (const q of ["common/sounds/sounds.qvm", `${this.levelDir}/sounds/sounds.qvm`]) await this.loadDefs(q);
    this.resolved.clear();
  }

  private addPath(path: string, data: Uint8Array | null) {
    if (this.files.has(path) && !data) return;
    this.files.set(path, data);
    const stem = stemOf(path);
    const list = this.stems.get(stem) ?? this.stems.set(stem, []).get(stem)!;
    if (!list.includes(path)) list.push(path);
    this.sorted = null;
  }

  private async loadDefs(qvm: string) {
    if (!this.vfs.has(qvm)) return;
    let statements: QvmCall[];
    try {
      statements = decodeQvm(await this.vfs.read(qvm));
    } catch (err) {
      console.warn(`audio: could not read ${qvm}`, err);
      return;
    }
    const define = (c: QvmCall, group: string) => {
      const a = c.args;
      if (typeof a[0] !== "string" || typeof a[1] !== "string") return;
      const pos: Vec3 = [num(a[2]), num(a[3]), num(a[4])];
      const def: SoundDef = {
        name: a[0].toLowerCase(),
        file: a[1].toLowerCase(),
        position: pos[0] || pos[1] || pos[2] ? pos : null,
        volume: num(a[5], 1),
        min: num(a[6]),
        max: Math.max(num(a[7], 100), num(a[6]) + 1),
        loop: bool(a[12]),
        group,
      };
      this.defsByName.set(def.name, def);
      if (!this.defsByFile.has(def.file)) this.defsByFile.set(def.file, def);
    };
    for (const s of statements) {
      if (s.fn === "DefineSound") define(s, "");
      else if (s.fn === "DefineGroup") {
        const group = String(s.args[0]);
        for (const c of s.args) if (typeof c === "object" && "fn" in c && c.fn === "DefineSound") define(c, group);
      }
    }
  }

  paths(): string[] {
    return (this.sorted ??= [...this.files.keys()].sort());
  }

  find(pattern: string | RegExp): string[] {
    const q = typeof pattern === "string" ? pattern.toLowerCase() : null;
    return this.paths().filter((p) => (q !== null ? p.includes(q) : (pattern as RegExp).test(p)));
  }

  defNames(): string[] {
    return [...this.defsByName.keys()].sort();
  }

  def(name: string): SoundDef | undefined {
    return this.defsByName.get(name.toLowerCase());
  }

  /** Map a path, SoundDef name or bare file name to a sample path (and the SoundDef that named it, if any). */
  resolve(sound: string): ResolvedSound | null {
    const cached = this.resolved.get(sound);
    if (cached !== undefined) return cached;
    const r = this.resolveUncached(sound);
    this.resolved.set(sound, r);
    return r;
  }

  private resolveUncached(sound: string): ResolvedSound | null {
    const n = normSoundPath(sound);
    if (this.files.has(n)) return { path: n, def: null };
    const key = n.replace(/\.wav$/, "");
    const def = this.defsByName.get(key);
    if (def) {
      const path = this.pathForStem(def.file);
      if (path) return { path, def };
    }
    const path = this.pathForStem(key);
    if (!path) return null;
    // A bare file name inherits the volume and range of its SoundDef (but not its loop flag).
    const byFile = this.defsByFile.get(key);
    return { path, def: byFile ? { ...byFile, loop: false } : null };
  }

  private pathForStem(stem: string): string | null {
    const list = this.stems.get(stem);
    if (!list) return null;
    const rank = (p: string) => (p.startsWith(this.levelDir + "/") ? 0 : p.startsWith("common/") ? 1 : p.startsWith("menusystem/") ? 2 : 3);
    return list.length === 1 ? list[0] : [...list].sort((a, b) => rank(a) - rank(b))[0];
  }

  /** The decoded buffer if already in memory. */
  peek(path: string): AudioBuffer | null {
    const b = this.buffers.get(path);
    if (b) {
      this.buffers.delete(path);
      this.buffers.set(path, b); // most recently used last
    }
    return b ?? null;
  }

  /** Decode (reading the file first if it is loose) into an AudioBuffer of `ctx`. */
  load(path: string, ctx: BaseAudioContext): Promise<AudioBuffer | null> {
    const hit = this.peek(path);
    if (hit) return Promise.resolve(hit);
    let p = this.reads.get(path);
    if (!p) {
      p = this.read(path, ctx).finally(() => this.reads.delete(path));
      this.reads.set(path, p);
    }
    return p;
  }

  private async read(path: string, ctx: BaseAudioContext): Promise<AudioBuffer | null> {
    try {
      let bytes = this.files.get(path) ?? null;
      if (!bytes) {
        bytes = await this.vfs.read(path);
        if (!isIlsf(bytes)) throw new Error("not an ILSF sound");
      }
      const s = decodeIlsf(bytes);
      const buf = ctx.createBuffer(s.channels.length, s.header.frames, s.sampleRate);
      s.channels.forEach((c, i) => buf.copyToChannel(c as Float32Array<ArrayBuffer>, i));
      this.buffers.set(path, buf);
      this.bufferBytes += buf.length * buf.numberOfChannels * 4;
      for (const [k, b] of this.buffers) {
        if (this.bufferBytes <= CACHE_BYTES || k === path) break;
        this.buffers.delete(k);
        this.bufferBytes -= b.length * b.numberOfChannels * 4;
      }
      return buf;
    } catch (err) {
      console.warn(`audio: cannot load ${path}`, err);
      return null;
    }
  }

  /** Read loose files into memory without decoding (so a later play does not wait on the network). */
  async prefetch(paths: string[]) {
    await Promise.all(
      paths.map(async (p) => {
        if (this.files.get(p) !== null) return;
        try {
          const b = await this.vfs.read(p);
          if (isIlsf(b)) this.files.set(p, b);
        } catch {
          /* decoded on demand instead */
        }
      }),
    );
  }

  /** Sound paths inside the current level's folder. */
  levelPaths(): string[] {
    return this.paths().filter((p) => p.startsWith(this.levelDir + "/"));
  }

  get cachedBuffers() {
    return { count: this.buffers.size, bytes: this.bufferBytes };
  }
}
