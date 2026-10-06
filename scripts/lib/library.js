// Node-side library reading: scans books/, extracts metadata (cached by file
// hash), and merges shelf.yml. The pure rules live in catalog.js/config.js.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { FORMATS, buildEntry } from "../../site/lib/catalog.js";
import { parseConfig } from "../../site/lib/config.js";
import { normalizeCover } from "./cover.js";
import { readEpub } from "../../site/lib/epub.js";
import { readPdf } from "./pdf.js";
import { slugify } from "../../site/lib/text.js";

// Bump when extraction changes so cached metadata is re-read.
const EXTRACTOR_VERSION = 3;

export function loadConfig(path, warn) {
  return parseConfig(existsSync(path) ? readFileSync(path, "utf8") : "", warn);
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

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
}

// When each file was first committed, so "recently added" survives fresh CI
// checkouts and moves between shelves (renames carry the date along). Needs
// full history (fetch-depth: 0); falls back to mtime.
export function gitAddedDates(repoRoot, booksPath = "books") {
  const dates = new Map();
  const relative = (file) => (file.startsWith(`${booksPath}/`) ? file.slice(booksPath.length + 1) : file);
  try {
    const output = git(repoRoot, [
      "-c", "core.quotepath=off", "log", "--reverse", "-M", "--diff-filter=AR", "--name-status", "--format=%x00%aI", "--", booksPath,
    ]);
    for (const block of output.split("\0").filter(Boolean)) {
      const [date, ...changes] = block.split("\n").map((line) => line.trim()).filter(Boolean);
      const when = new Date(date).toISOString();
      for (const change of changes) {
        const [status, first, second] = change.split("\t");
        if (status.startsWith("R") && second) {
          dates.set(relative(second), dates.get(relative(first)) || when);
          dates.delete(relative(first));
        } else if (status === "A" && first) {
          dates.set(relative(first), when);
        }
      }
    }
  } catch {
    // Not a git checkout, or git is unavailable.
  }
  return dates;
}

// "owner/name" of the GitHub repository, which the admin console commits to.
export function repositoryName(repoRoot) {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  try {
    const remote = git(repoRoot, ["remote", "get-url", "origin"]).trim();
    return remote.match(/github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?$/)?.[1] || "";
  } catch {
    return "";
  }
}

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
  const coverInfo = cover ? { extension: cover.extension, width: cover.width, height: cover.height, color: cover.color } : null;
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
  return { settings, books, repository: repositoryName(root) };
}
