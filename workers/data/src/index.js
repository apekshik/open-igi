// Serves the open-igi-data R2 bucket (index.json and file/<path>, see scripts/public.mjs) to the hosted sites.
// Stands in for the bucket's r2.dev address, which is rate-limited, without moving freeigi.com's DNS to Cloudflare.

const ORIGINS = new Set([
  "https://freeigi.com",
  "https://www.freeigi.com",
  "https://open-igi-flame.vercel.app",
  "https://open-igi-asterisk-inc.vercel.app",
  "https://apekshik.github.io",
  "http://localhost:5173",
  "http://localhost:4173",
]);

function cors(request, headers) {
  const origin = request.headers.get("Origin");
  if (origin && ORIGINS.has(origin)) headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Vary", "Origin");
  return headers;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      const headers = cors(request, new Headers());
      headers.set("Access-Control-Allow-Methods", "GET, HEAD");
      headers.set("Access-Control-Allow-Headers", "*");
      headers.set("Access-Control-Max-Age", "86400");
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed", { status: 405, headers: cors(request, new Headers({ Allow: "GET, HEAD" })) });
    }

    const key = decodeURIComponent(new URL(request.url).pathname.slice(1));
    if (key !== "index.json" && !key.startsWith("file/")) {
      return new Response("not found", { status: 404, headers: cors(request, new Headers()) });
    }

    const object = await env.BUCKET.get(key, { onlyIf: request.headers, range: request.headers });
    if (!object) return new Response("not found", { status: 404, headers: cors(request, new Headers()) });

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("ETag", object.httpEtag);
    cors(request, headers);
    // A failed precondition (If-None-Match matched) comes back without a body.
    if (!("body" in object)) return new Response(null, { status: 304, headers });
    if (request.method === "HEAD") return new Response(null, { headers });
    if (object.range && request.headers.has("Range")) {
      const { offset = 0, length = object.size - offset } = object.range;
      headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
      return new Response(object.body, { status: 206, headers });
    }
    return new Response(object.body, { headers });
  },
};
