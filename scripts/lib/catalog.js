import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { cleanText, escapeXml, listeningMinutes, slugify } from "./text.js";

export const CATALOG_VERSION = 1;
export const FORMATS = {
  epub: { mediaType: "application/epub+zip", label: "EPUB" },
  pdf: { mediaType: "application/pdf", label: "PDF" },
};
// Hear's own import limits; larger files stay downloadable but not listenable.
const HEAR_LIMITS = { epubBytes: 100 * 1024 * 1024, pdfBytes: 50 * 1024 * 1024, pdfPages: 500 };

export function shelfLabel(slug, labels = {}) {
  if (!slug) return "";
  if (labels[slug]) return labels[slug];
  return slug.split("-").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

// Every .epub/.pdf under books/. The first folder is the book's shelf.
export function scanBooks(booksDir) {
  const found = [];
  const walk = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      const extension = entry.name.split(".").pop().toLowerCase();
      if (!FORMATS[extension] || !entry.isFile()) continue;
      const rel = relative(booksDir, path).split(sep).join("/");
      const parts = rel.split("/");
      found.push({
        path,
        rel,
        extension,
        id: slugify(entry.name.slice(0, -(extension.length + 1))),
        shelf: parts.length > 1 ? slugify(parts[0]) : "",
        size: statSync(path).size,
      });
    }
  };
  walk(booksDir);
  return found.sort((left, right) => left.rel.localeCompare(right.rel));
}

// When each file was first committed, so "recently added" survives fresh CI
// checkouts. Needs full history (fetch-depth: 0); falls back to mtime.
export function gitAddedDates(repoRoot, booksPath = "books") {
  const dates = new Map();
  try {
    const output = execFileSync(
      "git",
      ["-c", "core.quotepath=off", "log", "--diff-filter=A", "--name-only", "--format=%x00%aI", "--", booksPath],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 },
    );
    for (const block of output.split("\0").filter(Boolean)) {
      const [date, ...files] = block.split("\n").map((line) => line.trim()).filter(Boolean);
      for (const file of files) {
        const rel = file.startsWith(`${booksPath}/`) ? file.slice(booksPath.length + 1) : file;
        // git log runs newest first, so the last write wins: the first commit.
        dates.set(rel, new Date(date).toISOString());
      }
    }
  } catch {
    // Not a git checkout, or git is unavailable.
  }
  return dates;
}

function downloadName(title, authors, extension) {
  const base = [title, authors[0]].filter(Boolean).join(" - ")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return `${base || "book"}.${extension}`;
}

function listenability(file, meta, override) {
  if (override.listen === false) return { listenable: false, listenNote: "Turned off for Hear in shelf.yml." };
  if (!meta.hasText) {
    return {
      listenable: false,
      listenNote: file.extension === "pdf" ? "Scanned PDF — needs OCR before it can be narrated." : "No readable text found.",
    };
  }
  if (file.extension === "pdf" && meta.pages > HEAR_LIMITS.pdfPages) {
    return { listenable: false, listenNote: `Over Hear's ${HEAR_LIMITS.pdfPages}-page PDF limit.` };
  }
  const limit = file.extension === "pdf" ? HEAR_LIMITS.pdfBytes : HEAR_LIMITS.epubBytes;
  if (file.size > limit) return { listenable: false, listenNote: `Over Hear's ${Math.round(limit / 1024 / 1024)} MB import limit.` };
  return { listenable: true, listenNote: "" };
}

// Combines what was read from the file with the owner's shelf.yml overrides.
export function buildEntry({ file, meta, override = {}, sha256, cover, addedAt, settings }) {
  const title = cleanText(override.title || meta.title) || file.id.replace(/-/g, " ");
  const authors = override.authors?.length ? override.authors : meta.authors;
  const kind = override.kind || (file.extension === "epub" || (meta.pages || 0) >= 48 ? "book" : "article");
  const shelf = file.shelf;
  const entry = {
    id: file.id,
    title,
    subtitle: override.subtitle || "",
    authors,
    author: authors.join(", "),
    authorSort: meta.authorSort || "",
    description: cleanText(override.description ?? meta.description),
    language: override.language || meta.language || "en",
    year: override.year ?? null,
    published: meta.published || "",
    publisher: override.publisher ?? meta.publisher ?? "",
    series: override.series ?? meta.series ?? "",
    seriesIndex: override.seriesIndex ?? meta.seriesIndex ?? null,
    shelf,
    shelfLabel: shelfLabel(shelf, settings.shelves),
    tags: override.tags || [],
    subjects: meta.subjects || [],
    status: override.status || "",
    rating: override.rating ?? null,
    note: override.note || "",
    format: file.extension,
    mediaType: FORMATS[file.extension].mediaType,
    kind,
    file: `files/${file.id}.${file.extension}`,
    fileName: downloadName(title, authors, file.extension),
    size: file.size,
    sha256,
    cover: cover ? `covers/${file.id}.${sha256.slice(0, 8)}.${cover.extension}` : "",
    coverWidth: cover?.width ?? null,
    coverHeight: cover?.height ?? null,
    pages: meta.pages ?? null,
    words: meta.words || 0,
    minutes: listeningMinutes(meta.words || 0),
    ...listenability(file, meta, override),
    addedAt: override.addedAt || addedAt,
    hear: "",
  };
  if (entry.listenable && settings.hear) {
    entry.hear = `${settings.hear}?${new URLSearchParams({ source: "collection", book: entry.id })}`;
  }
  return entry;
}

export function sortEntries(entries) {
  return [...entries].sort((left, right) => (
    String(right.addedAt).localeCompare(String(left.addedAt)) || left.title.localeCompare(right.title)
  ));
}

export function buildCatalog(entries, settings, generatedAt = new Date().toISOString()) {
  const shelves = new Map();
  for (const entry of entries) {
    if (!entry.shelf) continue;
    const shelf = shelves.get(entry.shelf) || { id: entry.shelf, label: entry.shelfLabel, count: 0 };
    shelf.count += 1;
    shelves.set(entry.shelf, shelf);
  }
  return {
    version: CATALOG_VERSION,
    title: settings.title,
    owner: settings.owner,
    description: settings.description,
    url: settings.url,
    hear: settings.hear,
    generatedAt,
    count: entries.length,
    shelves: [...shelves.values()].sort((left, right) => left.label.localeCompare(right.label)),
    books: sortEntries(entries),
  };
}

const OPDS_TYPE = "application/atom+xml;profile=opds-catalog;kind=acquisition";

// An OPDS 1.2 acquisition feed, so the shelf can be added to reading apps
// such as KOReader, Thorium, Panels, or Marvin as a catalog.
export function buildOpds(catalog) {
  const base = catalog.url || "";
  const link = (path) => (base ? new URL(path, base).href : path);
  const updated = catalog.generatedAt;
  const entries = catalog.books.map((book) => {
    const categories = [book.shelfLabel, ...book.tags].filter(Boolean)
      .map((term) => `    <category term="${escapeXml(term)}" label="${escapeXml(term)}"/>`);
    const coverLinks = book.cover ? [
      `    <link rel="http://opds-spec.org/image" href="${escapeXml(link(book.cover))}" type="image/jpeg"/>`,
      `    <link rel="http://opds-spec.org/image/thumbnail" href="${escapeXml(link(book.cover))}" type="image/jpeg"/>`,
    ] : [];
    return [
      "  <entry>",
      `    <title>${escapeXml(book.title)}</title>`,
      `    <id>urn:shelf:${escapeXml(book.id)}</id>`,
      `    <updated>${escapeXml(book.addedAt || updated)}</updated>`,
      ...book.authors.map((name) => `    <author><name>${escapeXml(name)}</name></author>`),
      `    <dc:language>${escapeXml(book.language)}</dc:language>`,
      book.year ? `    <dc:issued>${book.year}</dc:issued>` : "",
      book.publisher ? `    <dc:publisher>${escapeXml(book.publisher)}</dc:publisher>` : "",
      ...categories,
      book.description ? `    <summary type="text">${escapeXml(book.description)}</summary>` : "",
      ...coverLinks,
      `    <link rel="http://opds-spec.org/acquisition/open-access" href="${escapeXml(link(book.file))}" type="${book.mediaType}" length="${book.size}"/>`,
      book.hear ? `    <link rel="alternate" href="${escapeXml(book.hear)}" type="text/html" title="Listen in Hear"/>` : "",
      "  </entry>",
    ].filter(Boolean).join("\n");
  });
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/terms/" xmlns:opds="http://opds-spec.org/2010/catalog">',
    `  <id>urn:shelf:${escapeXml(base || catalog.title)}</id>`,
    `  <title>${escapeXml(catalog.title)}</title>`,
    `  <updated>${escapeXml(updated)}</updated>`,
    catalog.owner ? `  <author><name>${escapeXml(catalog.owner)}</name></author>` : "",
    catalog.description ? `  <subtitle>${escapeXml(catalog.description)}</subtitle>` : "",
    `  <link rel="self" href="${escapeXml(link("opds.xml"))}" type="${OPDS_TYPE}"/>`,
    `  <link rel="start" href="${escapeXml(link("opds.xml"))}" type="${OPDS_TYPE}"/>`,
    ...entries,
    "</feed>",
    "",
  ].filter(Boolean).join("\n");
}
