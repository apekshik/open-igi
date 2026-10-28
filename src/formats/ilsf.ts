// ILSF: IGI's sound sample container (loose .wav files and the BODY payloads of sound .res archives). Not RIFF.
//
//   "ILSF" u16 version  u16 bits (16)  u16 channels  u16 flags  u32 sampleRate  u32 frames  data
//
// version bit0 = lives in a .res archive, bit1 = compressed. Uncompressed is 16-bit little-endian PCM,
// interleaved. Compressed is 4-bit IMA ADPCM, one nibble per sample, high nibble first, channels interleaved
// nibble by nibble, with decoder state starting at predictor 0 / step index 0 and no block headers.
// Layout and codec per flawme/igi-reverse-engineering (reverse/docs/09-audio, MIT); see THIRD_PARTY.md and
// docs/FORMATS.md.

export interface IlsfHeader {
  version: number;
  bits: number;
  channels: number;
  flags: number;
  sampleRate: number;
  /** Samples per channel. */
  frames: number;
  compressed: boolean;
  inArchive: boolean;
}

export interface IlsfSound {
  header: IlsfHeader;
  sampleRate: number;
  /** One Float32Array per channel, samples in [-1, 1). */
  channels: Float32Array[];
}

const HEADER = 20;

const STEP = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
  130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060,
  1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484,
  7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];
const INDEX_ADJUST = [-1, -1, -1, -1, 2, 4, 6, 8];

export function isIlsf(bytes: Uint8Array): boolean {
  return bytes.length >= HEADER && bytes[0] === 0x49 && bytes[1] === 0x4c && bytes[2] === 0x53 && bytes[3] === 0x46;
}

export function parseIlsfHeader(bytes: Uint8Array): IlsfHeader {
  if (!isIlsf(bytes)) throw new Error("not an ILSF file");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = v.getUint16(4, true);
  return {
    version,
    bits: v.getUint16(6, true),
    channels: v.getUint16(8, true),
    flags: v.getUint16(10, true),
    sampleRate: v.getUint32(12, true),
    frames: v.getUint32(16, true),
    compressed: (version & 2) !== 0,
    inArchive: (version & 1) !== 0,
  };
}

/** Bytes of sample data the header promises (a trailing pad byte may follow). */
export function ilsfDataSize(h: IlsfHeader): number {
  return h.compressed ? Math.ceil((h.frames * h.channels) / 2) : h.frames * h.channels * (h.bits >> 3);
}

export function decodeIlsf(bytes: Uint8Array): IlsfSound {
  const header = parseIlsfHeader(bytes);
  const { channels: nch, frames } = header;
  if (header.bits !== 16) throw new Error(`unsupported ILSF bit depth ${header.bits}`);
  if (nch < 1 || nch > 2) throw new Error(`unsupported ILSF channel count ${nch}`);
  const need = ilsfDataSize(header);
  if (bytes.length - HEADER < need) throw new Error(`ILSF data truncated: ${bytes.length - HEADER} < ${need}`);
  const data = bytes.subarray(HEADER);
  const out = Array.from({ length: nch }, () => new Float32Array(frames));

  if (!header.compressed) {
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let i = 0; i < frames; i++)
      for (let c = 0; c < nch; c++) out[c][i] = v.getInt16((i * nch + c) * 2, true) / 32768;
  } else {
    const pred = new Int32Array(nch);
    const idx = new Int32Array(nch);
    let n = 0;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < nch; c++, n++) {
        const b = data[n >> 1];
        const nib = n & 1 ? b & 15 : b >> 4;
        const step = STEP[idx[c]];
        let diff = step >> 3;
        if (nib & 4) diff += step;
        if (nib & 2) diff += step >> 1;
        if (nib & 1) diff += step >> 2;
        let p = nib & 8 ? pred[c] - diff : pred[c] + diff;
        p = p < -32768 ? -32768 : p > 32767 ? 32767 : p;
        pred[c] = p;
        idx[c] = Math.min(88, Math.max(0, idx[c] + INDEX_ADJUST[nib & 7]));
        out[c][i] = p / 32768;
      }
    }
  }
  return { header, sampleRate: header.sampleRate, channels: out };
}
