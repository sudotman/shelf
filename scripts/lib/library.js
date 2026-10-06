import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildEntry, gitAddedDates, scanBooks } from "./catalog.js";
import { loadConfig } from "./config.js";
import { normalizeCover } from "./cover.js";
import { readEpub } from "./epub.js";
import { readPdf } from "./pdf.js";

// Bump when extraction changes so cached metadata is re-read.
const EXTRACTOR_VERSION = 2;

export async function extractMetadata(buffer, extension) {
  const meta = extension === "pdf" ? await readPdf(buffer) : readEpub(buffer);
  const { cover, ...rest } = meta;
  return { meta: rest, cover: await normalizeCover(cover) };
}

function cachePaths(cacheDir, sha256) {
  return { meta: join(cacheDir, `${sha256}.json`), cover: (extension) => join(cacheDir, `${sha256}.cover.${extension}`) };
}

function readCache(cacheDir, sha256) {
  const paths = cachePaths(cacheDir, sha256);
  if (!existsSync(paths.meta)) return null;
  try {
    const record = JSON.parse(readFileSync(paths.meta, "utf8"));
    if (record.version !== EXTRACTOR_VERSION) return null;
    const cover = record.cover ? { ...record.cover, bytes: readFileSync(paths.cover(record.cover.extension)) } : null;
    return { meta: record.meta, cover };
  } catch {
    return null;
  }
}

function writeCache(cacheDir, sha256, { meta, cover }) {
  mkdirSync(cacheDir, { recursive: true });
  const paths = cachePaths(cacheDir, sha256);
  if (cover) writeFileSync(paths.cover(cover.extension), cover.bytes);
  const coverInfo = cover ? { extension: cover.extension, width: cover.width, height: cover.height } : null;
  writeFileSync(paths.meta, JSON.stringify({ version: EXTRACTOR_VERSION, meta, cover: coverInfo }));
}

export async function readLibrary({ root, warn = () => {}, onBook = () => {} }) {
  const settings = loadConfig(join(root, "shelf.yml"), warn);
  const files = scanBooks(join(root, "books"));
  const addedDates = gitAddedDates(root);
  const cacheDir = join(root, ".cache");

  const seen = new Map();
  for (const file of files) {
    if (!file.id) throw new Error(`books/${file.rel}: the file name has no letters or digits to make an id from.`);
    if (seen.has(file.id)) {
      throw new Error(`Two books share the id "${file.id}":\n  books/${seen.get(file.id)}\n  books/${file.rel}\nRename one of the files.`);
    }
    seen.set(file.id, file.rel);
  }
  for (const id of Object.keys(settings.books)) {
    if (!seen.has(id)) warn(`shelf.yml mentions "${id}", but there is no book with that file name.`);
  }

  const books = [];
  for (const file of files) {
    const override = settings.books[file.id] || {};
    if (override.hidden) {
      onBook({ file, skipped: "hidden" });
      continue;
    }
    const buffer = readFileSync(file.path);
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    let extracted = readCache(cacheDir, sha256);
    const cached = Boolean(extracted);
    if (!extracted) {
      try {
        extracted = await extractMetadata(buffer, file.extension);
      } catch (error) {
        warn(`books/${file.rel}: ${error.message} — published without metadata.`);
        extracted = { meta: { format: file.extension, title: "", authors: [], words: 0, hasText: false }, cover: null };
      }
      writeCache(cacheDir, sha256, extracted);
    }

    let { cover } = extracted;
    if (override.cover) {
      const coverPath = resolve(root, override.cover);
      if (!coverPath.startsWith(resolve(root)) || !existsSync(coverPath)) {
        warn(`books.${file.id}.cover: ${override.cover} was not found.`);
      } else {
        const extension = coverPath.split(".").pop().toLowerCase();
        const mediaType = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" }[extension];
        cover = (await normalizeCover({ bytes: readFileSync(coverPath), mediaType })) || cover;
      }
    }

    const addedAt = addedDates.get(file.rel) || statSync(file.path).mtime.toISOString();
    const entry = buildEntry({ file, meta: extracted.meta, override, sha256, cover, addedAt, settings });
    if (!entry.authors.length) warn(`books/${file.rel}: no author found — add one under books.${file.id}.author in shelf.yml.`);
    if (!entry.listenable && override.listen !== false) warn(`books/${file.rel}: ${entry.listenNote}`);
    books.push({ entry, file, cover });
    onBook({ file, entry, cached });
  }
  return { settings, books };
}
