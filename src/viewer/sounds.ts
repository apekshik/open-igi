// Sound browser: ILSF samples from loose .wav files and from sound .res archives, played with Web Audio.
import { readRes } from "../formats/ilff.ts";
import { decodeIlsf, isIlsf, parseIlsfHeader } from "../formats/ilsf.ts";
import type { Vfs } from "../vfs/vfs.ts";

interface Item {
  name: string;
  data: Uint8Array;
}

export function soundViewer(vfs: Vfs, toolbar: HTMLElement, stage: HTMLElement, status: (s: string) => void) {
  const select = document.createElement("select");
  const filter = document.createElement("input");
  filter.placeholder = "filter";
  const stop = document.createElement("button");
  stop.textContent = "Stop";
  toolbar.append(select, filter, stop);
  const table = document.createElement("table");
  stage.append(table);

  // One source per sound archive, plus one per directory of loose .wav files.
  const paths = vfs.list().sort();
  const sources = new Map<string, string[]>();
  for (const p of paths) {
    if (p.endsWith(".res") && p.includes("sound")) sources.set(p, [p]);
    else if (p.endsWith(".wav")) {
      const dir = p.slice(0, p.lastIndexOf("/")) + "/*.wav";
      (sources.get(dir) ?? sources.set(dir, []).get(dir)!).push(p);
    }
  }
  select.replaceChildren(...[...sources.keys()].map((k) => new Option(k, k)));

  let ctx: AudioContext | null = null;
  let playing: AudioBufferSourceNode | null = null;
  const halt = () => {
    playing?.stop();
    playing = null;
  };
  stop.addEventListener("click", halt);

  let items: Item[] = [];
  const render = () => {
    const q = filter.value.toLowerCase();
    const rows: HTMLTableRowElement[] = [];
    for (const it of items) {
      if (q && !it.name.toLowerCase().includes(q)) continue;
      const h = parseIlsfHeader(it.data);
      const tr = document.createElement("tr");
      const play = document.createElement("button");
      play.textContent = "Play";
      play.addEventListener("click", () => {
        halt();
        ctx ??= new AudioContext();
        void ctx.resume();
        const s = decodeIlsf(it.data);
        const buf = ctx.createBuffer(s.channels.length, h.frames, s.sampleRate);
        s.channels.forEach((c, i) => buf.copyToChannel(c as Float32Array<ArrayBuffer>, i));
        const node = ctx.createBufferSource();
        node.buffer = buf;
        node.connect(ctx.destination);
        node.start();
        playing = node;
        status(`${it.name}: ${(h.frames / h.sampleRate).toFixed(2)}s`);
      });
      const cells = [
        it.name.split("/").pop()!,
        h.compressed ? "IMA ADPCM" : "PCM16",
        `${h.sampleRate} Hz`,
        h.channels === 1 ? "mono" : "stereo",
        `${(h.frames / h.sampleRate).toFixed(2)} s`,
      ];
      const first = document.createElement("td");
      first.append(play);
      tr.append(first, ...cells.map((c) => Object.assign(document.createElement("td"), { textContent: c })));
      rows.push(tr);
    }
    table.replaceChildren(...rows);
  };
  filter.addEventListener("input", render);

  async function show(key: string) {
    halt();
    items = [];
    for (const p of sources.get(key) ?? []) {
      const bytes = await vfs.read(p);
      if (p.endsWith(".res")) {
        for (const e of readRes(bytes)) if (isIlsf(e.data)) items.push({ name: e.name, data: e.data });
      } else if (isIlsf(bytes)) {
        items.push({ name: p, data: bytes });
      }
    }
    render();
    status(`${key}: ${items.length} sounds`);
  }
  select.addEventListener("change", () => void show(select.value));
  if (sources.size) void show(select.value);
}
