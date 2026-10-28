import { defineConfig, loadEnv, type Plugin } from "vite";
import { readdirSync, statSync, createReadStream } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// The project folder, so .env.local and a relative IGI_DATA resolve the same wherever Vite is started from.
const here = dirname(fileURLToPath(import.meta.url));

// Dev convenience: with IGI_DATA set to your install's PC folder (env var or .env.local), the dev server exposes it
// at /__igi/ so the page skips the folder picker. Never part of a build.
function igiData(dir: string | undefined): Plugin {
  const root = dir ? resolve(here, dir) : null;
  return {
    name: "igi-data",
    apply: "serve",
    configureServer(server) {
      if (!root) return;
      const index: Record<string, string> = {};
      const walk = (dir: string) => {
        for (const n of readdirSync(dir)) {
          const p = join(dir, n);
          if (statSync(p).isDirectory()) walk(p);
          else index[relative(root, p).split(sep).join("/").toLowerCase()] = p;
        }
      };
      walk(root);
      server.middlewares.use("/__igi/", (req, res) => {
        const url = decodeURIComponent((req.url ?? "").split("?")[0]).replace(/^\/+/, "");
        if (url === "index.json") {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(Object.keys(index)));
          return;
        }
        const file = url.startsWith("file/") ? index[url.slice(5).toLowerCase()] : undefined;
        if (!file) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader("content-type", "application/octet-stream");
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  // Relative asset URLs so the same build works at a domain root and under /open-igi/ on GitHub Pages.
  base: "./",
  plugins: [igiData(loadEnv(mode, here, "").IGI_DATA)],
}));
