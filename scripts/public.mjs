// Stages the game data for the public build and, with --upload, puts it in a Cloudflare R2 bucket.
// Only for a build whose game data is distributed with the rights holder's permission (see NOTICE.md).
//
//   node scripts/public.mjs [outDir] [--upload <bucket>]
//
// IGI_DATA comes from the environment or .env.local; outDir defaults to ../igi-data/public-data, outside the repo.
// --upload needs `npx wrangler login` first. The engine itself is built and hosted by .github/workflows/pages.yml,
// which points at the bucket through the IGI_DATA_URL repository variable (see docs/DEPLOY.md).
import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stageGameData } from "./stage-data.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = (() => {
  try {
    return readFileSync(join(root, ".env.local"), "utf8");
  } catch {
    return "";
  }
})();
const data = process.env.IGI_DATA ?? envFile.match(/^IGI_DATA=(.*)$/m)?.[1]?.trim();
if (!data) throw new Error("set IGI_DATA to your install's PC folder");
const args = process.argv.slice(2);
const bucket = args.includes("--upload") ? args.splice(args.indexOf("--upload"), 2)[1] : null;
const out = resolve(root, args[0] ?? "../igi-data/public-data");

rmSync(out, { recursive: true, force: true });
const index = stageGameData(resolve(root, data), out);
console.log(`${index.length} game files -> ${out}`);

if (bucket) {
  // index.json goes last, so a half-finished upload never advertises files that are not there yet.
  const jobs = index.map((key) => ({
    key: `file/${key}`,
    path: join(out, "file", key),
    type: "application/octet-stream",
    cache: "public, max-age=86400",
  }));
  const put = ({ key, path, type, cache }) =>
    new Promise((ok, fail) => {
      // One command line through the shell, which finds npx.cmd on Windows. The arguments are quoted (none hold
      // quotes); npx itself is not, since a quoted npx.cmd cannot find its own folder.
      const argv = ["-y", "wrangler@4", "r2", "object", "put", `${bucket}/${key}`, "--file", path, "--remote",
        "--content-type", type, "--cache-control", cache];
      const p = spawn(`npx ${argv.map((a) => `"${a}"`).join(" ")}`, { shell: true, stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      p.stderr.on("data", (d) => (err += d));
      p.on("close", (code) => (code === 0 ? ok() : fail(new Error(`${key}: ${err.trim()}`))));
    });
  let done = 0;
  const worker = async () => {
    for (let job; (job = jobs.shift()); ) {
      for (let attempt = 1; ; attempt++) {
        try {
          await put(job);
          break;
        } catch (e) {
          if (attempt === 3) throw e;
        }
      }
      if (++done % 100 === 0) console.log(`${done}/${index.length} uploaded`);
    }
  };
  await Promise.all(Array.from({ length: 12 }, worker));
  await put({ key: "index.json", path: join(out, "index.json"), type: "application/json", cache: "public, max-age=300" });
  console.log(`${index.length} files and index.json uploaded to ${bucket}`);
}
