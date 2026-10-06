#!/usr/bin/env node
// npm run add -- <file.epub|file.pdf> [...more] [--shelf name] [--tag t]... [--status want|reading|read]
//                [--author "Name"] [--title "Title"] [--id custom-id]
// Copies books into books/<shelf>/<id>.<ext> and records any extra details in shelf.yml.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { FORMATS, scanBooks } from "./lib/catalog.js";
import { STATUSES } from "./lib/config.js";
import { readEpub } from "./lib/epub.js";
import { readPdf } from "./lib/pdf.js";
import { formatBytes, slugify } from "./lib/text.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BOOKS = join(ROOT, "books");
const CONFIG = join(ROOT, "shelf.yml");

function parseArguments(argv) {
  const options = { files: [], tags: [] };
  const valueFlags = new Set(["--shelf", "--tag", "--status", "--author", "--title", "--id"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (valueFlags.has(argument)) {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${argument} needs a value.`);
      if (argument === "--tag") options.tags.push(...value.split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean));
      else options[argument.slice(2)] = value.trim();
    } else if (argument.startsWith("--")) throw new Error(`Unknown option ${argument}.`);
    else options.files.push(argument);
  }
  if (options.status && !STATUSES.includes(options.status)) throw new Error(`--status must be one of ${STATUSES.join(", ")}.`);
  if (options.id && options.files.length > 1) throw new Error("--id can only be used when adding one file.");
  return options;
}

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

function existingHashes() {
  return new Map(scanBooks(BOOKS).map((book) => [sha256(readFileSync(book.path)), book]));
}

function chooseId(options, meta, file, taken) {
  if (options.id) return slugify(options.id);
  const title = slugify(options.title || meta.title);
  const author = slugify((options.author || meta.authors?.[0] || "").split(" ").pop());
  const candidates = [title, title && author ? `${title}-${author}` : "", slugify(basename(file, extname(file)))].filter(Boolean);
  const free = candidates.find((candidate) => !taken.has(candidate));
  if (free) return free;
  for (let suffix = 2; ; suffix += 1) {
    if (!taken.has(`${candidates[0]}-${suffix}`)) return `${candidates[0]}-${suffix}`;
  }
}

function recordDetails(id, details) {
  const fields = Object.entries(details).filter(([, value]) => value !== undefined && !(Array.isArray(value) && !value.length));
  if (!fields.length) return false;
  const document = parseDocument(existsSync(CONFIG) ? readFileSync(CONFIG, "utf8") : "books: {}\n");
  if (!document.has("books") || document.get("books") === null) document.set("books", document.createNode({}));
  for (const [key, value] of fields) {
    const node = document.createNode(value);
    if (Array.isArray(value)) node.flow = true;
    document.setIn(["books", id, key], node);
  }
  writeFileSync(CONFIG, document.toString({ lineWidth: 0, flowCollectionPadding: false }));
  return true;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help || !options.files.length) {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 4).map((line) => line.replace(/^\/\/ ?/, "")).join("\n"));
    process.exit(options.files.length || options.help ? 0 : 1);
  }

  const hashes = existingHashes();
  const taken = new Set(scanBooks(BOOKS).map((book) => book.id));
  const shelf = options.shelf ? slugify(options.shelf) : "";
  let added = 0;

  for (const file of options.files) {
    const extension = extname(file).slice(1).toLowerCase();
    if (!existsSync(file)) {
      console.error(`✗ ${file}: file not found`);
      continue;
    }
    if (!FORMATS[extension]) {
      console.error(`✗ ${file}: only .epub and .pdf files can be added`);
      continue;
    }
    const buffer = readFileSync(file);
    const duplicate = hashes.get(sha256(buffer));
    if (duplicate) {
      console.log(`= ${basename(file)} is already on the shelf as books/${duplicate.rel}`);
      continue;
    }

    let meta;
    try {
      meta = extension === "pdf" ? await readPdf(buffer, { cover: false }) : readEpub(buffer);
    } catch (error) {
      console.error(`✗ ${file}: ${error.message}`);
      continue;
    }
    const id = chooseId(options, meta, file, taken);
    const directory = shelf ? join(BOOKS, shelf) : BOOKS;
    const target = join(directory, `${id}.${extension}`);
    mkdirSync(directory, { recursive: true });
    copyFileSync(file, target);
    taken.add(id);
    added += 1;

    const author = options.author || meta.authors?.join(", ");
    const recorded = recordDetails(id, {
      title: options.title,
      author: options.author,
      tags: options.tags,
      status: options.status,
    });
    console.log(`+ ${meta.title || options.title || id}${author ? ` — ${author}` : ""}`);
    console.log(`  books/${shelf ? `${shelf}/` : ""}${id}.${extension} · ${formatBytes(buffer.length)}${meta.pages ? ` · ${meta.pages} pages` : ""}${recorded ? " · details saved to shelf.yml" : ""}`);
    if (!author) console.log(`  ! No author in the file. Add one: npm run add -- … --author "Name", or under books.${id}.author in shelf.yml`);
    if (!meta.hasText) console.log("  ! No selectable text found (a scanned PDF?) — it will be downloadable but not listenable in Hear.");
  }

  if (added) {
    console.log(`\nNext: npm run build to preview, then commit and push:`);
    console.log(`  git add books shelf.yml && git commit -m "Add ${added} ${added === 1 ? "book" : "books"}" && git push`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
