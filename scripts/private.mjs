// Builds a private copy of the site that ships your own game files, so it opens straight into the game on any
// device. Never deploy the output publicly: it contains the game's data (see docs/RULES.md).
//
//   node scripts/private.mjs [outDir] [--deploy <alias>]
//
// IGI_DATA comes from the environment or .env.local; outDir defaults to ../igi-data/private-site, outside the repo.
// --deploy uploads it as a Vercel *preview* deployment (outDir must be `vercel link`ed to its own project) and points
// <alias>.vercel.app at it. Vercel Authentication covers preview deployments and their aliases on every plan, so only
// the account owner can open it. Never deploy it to production: production domains are public.
//
// The files are served as igi/index.json and igi/file/<lowercased path>, the layout of the dev mount.
import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

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
const alias = args.includes("--deploy") ? args.splice(args.indexOf("--deploy"), 2)[1] : null;
const out = resolve(root, args[0] ?? "../igi-data/private-site");

// Keep the folder's .vercel link between builds; replace everything else.
mkdirSync(out, { recursive: true });
for (const n of readdirSync(out)) if (n !== ".vercel") rmSync(join(out, n), { recursive: true, force: true });

execSync(`npx vite build --outDir "${out}" --emptyOutDir false`, {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, VITE_IGI_DATA_URL: "./igi/" },
});

const index = [];
const walk = (dir) => {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p);
    else {
      const key = relative(resolve(root, data), p).split(sep).join("/").toLowerCase();
      const dest = join(out, "igi", "file", key);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(p, dest);
      index.push(key);
    }
  }
};
walk(resolve(root, data));
writeFileSync(join(out, "igi", "index.json"), JSON.stringify(index));
console.log(`${index.length} game files -> ${out}`);

if (alias) {
  const vercel = (cmd) => execSync(`npx -y vercel@latest ${cmd}`, { cwd: out, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  const deployed = vercel("deploy --yes --target preview");
  const url = deployed.match(/https:\/\/[\w-]+\.vercel\.app/)?.[0];
  if (!url) throw new Error(`unexpected deploy output: ${deployed}`);
  vercel(`alias set ${url} ${alias}.vercel.app`);
  const status = (await fetch(`https://${alias}.vercel.app/igi/index.json`, { redirect: "manual" })).status;
  if (status === 200) throw new Error(`https://${alias}.vercel.app is PUBLIC: remove the alias now`);
  console.log(`https://${alias}.vercel.app (protected, HTTP ${status} without login)`);
}
