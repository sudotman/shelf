#!/usr/bin/env node
// Serves dist/ locally with the same open CORS policy as GitHub Pages, so a
// local Hear (VITE_COLLECTION_URL=http://localhost:4321/catalog.json) can read it.
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const PORT = Number(process.env.PORT) || 4321;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/atom+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".epub": "application/epub+zip",
  ".pdf": "application/pdf",
};

createServer((request, response) => {
  const url = new URL(request.url, `http://localhost:${PORT}`);
  let path = normalize(join(DIST, decodeURIComponent(url.pathname)));
  if (!path.startsWith(DIST.replace(/[\\/]$/, "") + sep) && path !== DIST.replace(/[\\/]$/, "")) {
    response.writeHead(403).end();
    return;
  }
  if (existsSync(path) && statSync(path).isDirectory()) path = join(path, "index.html");
  if (!existsSync(path)) {
    response.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
    return;
  }

  const size = statSync(path).size;
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-cache",
    "Content-Type": TYPES[extname(path).toLowerCase()] || "application/octet-stream",
    "Accept-Ranges": "bytes",
  };
  const range = request.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      response.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
      return;
    }
    response.writeHead(206, { ...headers, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${size}` });
    createReadStream(path, { start, end }).pipe(response);
    return;
  }
  response.writeHead(200, { ...headers, "Content-Length": size });
  if (request.method === "HEAD") response.end();
  else createReadStream(path).pipe(response);
}).listen(PORT, () => {
  console.log(`Shelf running at http://localhost:${PORT}/`);
  console.log(`Catalog for Hear: http://localhost:${PORT}/catalog.json`);
});
