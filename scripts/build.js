#!/usr/bin/env node
// Reads books/ and shelf.yml, then writes the publishable site to dist/:
//   catalog.json   the machine-readable catalog Hear and other apps read
//   opds.xml       an OPDS feed for reading apps
//   files/, covers/ the books and their resized covers
//   index.html …   the browsing site from site/
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCatalog, buildOpds } from "./lib/catalog.js";
import { readLibrary } from "./lib/library.js";
import { escapeXml, formatBytes } from "./lib/text.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "dist");
const listOnly = process.argv.includes("--list");

const warnings = [];
const warn = (message) => warnings.push(message);

function printTable(entries) {
  const rows = entries.map((book) => [
    book.id,
    book.format.toUpperCase(),
    book.shelfLabel || "—",
    book.title.length > 38 ? `${book.title.slice(0, 37)}…` : book.title,
    book.author || "—",
    book.pages ? `${book.pages} pp` : book.minutes ? `${book.minutes} min` : "—",
    book.listenable ? "yes" : "no",
  ]);
  const header = ["id", "format", "shelf", "title", "author", "length", "hear"];
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => String(row[column]).length)));
  const line = (row) => row.map((cell, column) => String(cell).padEnd(widths[column])).join("  ");
  console.log(line(header));
  console.log(widths.map((width) => "─".repeat(width)).join("  "));
  rows.forEach((row) => console.log(line(row)));
}

function renderSiteIndex(catalog) {
  const description = catalog.description || `${catalog.count} books from ${catalog.title}.`;
  return readFileSync(join(ROOT, "site", "index.html"), "utf8")
    .replaceAll("{{title}}", escapeXml(catalog.title))
    .replaceAll("{{description}}", escapeXml(description));
}

const started = Date.now();
let extracted = 0;
const { settings, books } = await readLibrary({
  root: ROOT,
  warn,
  onBook({ file, cached, skipped }) {
    if (skipped) console.log(`  skip  books/${file.rel} (${skipped})`);
    else if (!cached) {
      extracted += 1;
      console.log(`  read  books/${file.rel}`);
    }
  },
});
const catalog = buildCatalog(books.map((book) => book.entry), settings);

if (listOnly) {
  printTable(catalog.books);
} else {
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(join(DIST, "files"), { recursive: true });
  mkdirSync(join(DIST, "covers"), { recursive: true });
  cpSync(join(ROOT, "site"), DIST, { recursive: true });
  writeFileSync(join(DIST, "index.html"), renderSiteIndex(catalog));

  let totalBytes = 0;
  for (const { entry, file, cover } of books) {
    copyFileSync(file.path, join(DIST, entry.file));
    if (cover) writeFileSync(join(DIST, entry.cover), cover.bytes);
    totalBytes += entry.size;
  }
  writeFileSync(join(DIST, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
  writeFileSync(join(DIST, "opds.xml"), buildOpds(catalog));
  // A personal library: keep it out of search engines. Links still work.
  writeFileSync(join(DIST, "robots.txt"), "User-agent: *\nDisallow: /\n");
  writeFileSync(join(DIST, ".nojekyll"), "");

  console.log(`\n${catalog.title}: ${catalog.count} ${catalog.count === 1 ? "book" : "books"} · ${formatBytes(totalBytes)} · ${extracted} read, ${books.length - extracted} from cache · ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`Wrote dist/ (catalog.json, opds.xml, ${books.length} files)`);
}

if (warnings.length) {
  console.log(`\n${warnings.length} ${warnings.length === 1 ? "note" : "notes"}:`);
  warnings.forEach((message) => console.log(`  • ${message}`));
}
