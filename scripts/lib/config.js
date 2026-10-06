import { existsSync, readFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { slugify } from "./text.js";

export const STATUSES = ["want", "reading", "read"];
export const KINDS = ["book", "article"];

const SETTING_KEYS = new Set(["title", "owner", "description", "url", "hear", "shelves", "books"]);
const BOOK_KEYS = new Set([
  "title", "subtitle", "author", "description", "language", "year", "publisher", "series", "series_index",
  "tags", "status", "rating", "note", "kind", "hidden", "listen", "cover", "added",
]);

const DEFAULTS = {
  title: "My shelf",
  owner: "",
  description: "",
  url: "",
  hear: "https://hear.satyam.lol/",
  shelves: {},
  books: {},
};

function asList(value) {
  if (value === undefined || value === null || value === "") return [];
  return (Array.isArray(value) ? value : String(value).split(","))
    .map((item) => String(item).trim())
    .filter(Boolean);
}

function withTrailingSlash(value) {
  const text = String(value || "").trim();
  return text && !text.endsWith("/") ? `${text}/` : text;
}

// Turns one `books:` entry into clean override fields, collecting problems as
// warnings rather than failing the whole build over a typo.
export function normalizeOverride(id, raw, warn = () => {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warn(`books.${id}: expected a map of fields`);
    return {};
  }
  const override = {};
  for (const key of Object.keys(raw)) {
    if (!BOOK_KEYS.has(key)) warn(`books.${id}.${key}: unknown field (ignored)`);
  }
  for (const key of ["title", "subtitle", "description", "publisher", "series", "note", "cover"]) {
    if (raw[key] !== undefined && raw[key] !== null) override[key] = String(raw[key]).trim();
  }
  if (raw.author !== undefined) override.authors = asList(raw.author);
  if (raw.tags !== undefined) override.tags = [...new Set(asList(raw.tags).map((tag) => tag.toLowerCase()))];
  if (raw.language !== undefined) override.language = String(raw.language).trim().toLowerCase().split("-")[0];
  if (raw.year !== undefined) {
    const year = Number(raw.year);
    if (Number.isInteger(year)) override.year = year;
    else warn(`books.${id}.year: expected a year like 1841`);
  }
  if (raw.series_index !== undefined) {
    const index = Number(raw.series_index);
    if (Number.isFinite(index)) override.seriesIndex = index;
    else warn(`books.${id}.series_index: expected a number`);
  }
  if (raw.status !== undefined) {
    const status = String(raw.status).trim().toLowerCase();
    if (STATUSES.includes(status)) override.status = status;
    else warn(`books.${id}.status: use one of ${STATUSES.join(", ")}`);
  }
  if (raw.rating !== undefined) {
    const rating = Number(raw.rating);
    if (Number.isInteger(rating) && rating >= 1 && rating <= 5) override.rating = rating;
    else warn(`books.${id}.rating: use a whole number from 1 to 5`);
  }
  if (raw.kind !== undefined) {
    const kind = String(raw.kind).trim().toLowerCase();
    if (KINDS.includes(kind)) override.kind = kind;
    else warn(`books.${id}.kind: use book or article`);
  }
  if (raw.hidden !== undefined) override.hidden = raw.hidden === true;
  if (raw.listen !== undefined) override.listen = raw.listen !== false;
  if (raw.added !== undefined) {
    const added = new Date(raw.added instanceof Date ? raw.added : String(raw.added));
    if (Number.isNaN(added.getTime())) warn(`books.${id}.added: expected a date like 2026-10-05`);
    else override.addedAt = added.toISOString();
  }
  return override;
}

export function parseConfig(source, warn = () => {}) {
  const document = parseDocument(source || "");
  for (const error of document.errors) throw new Error(`shelf.yml: ${error.message}`);
  const raw = document.toJS() || {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("shelf.yml: expected a map at the top level");
  for (const key of Object.keys(raw)) {
    if (!SETTING_KEYS.has(key)) warn(`${key}: unknown setting (ignored)`);
  }

  const shelves = {};
  for (const [key, label] of Object.entries(raw.shelves || {})) {
    shelves[slugify(key)] = String(label || key).trim();
  }
  const books = {};
  for (const [id, entry] of Object.entries(raw.books || {})) {
    books[id] = normalizeOverride(id, entry, warn);
  }
  return {
    ...DEFAULTS,
    title: String(raw.title || DEFAULTS.title).trim(),
    owner: String(raw.owner || "").trim(),
    description: String(raw.description || "").trim(),
    url: withTrailingSlash(raw.url),
    hear: withTrailingSlash(raw.hear ?? DEFAULTS.hear),
    shelves,
    books,
  };
}

export function loadConfig(path, warn) {
  return parseConfig(existsSync(path) ? readFileSync(path, "utf8") : "", warn);
}
