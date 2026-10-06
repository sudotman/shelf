// The admin's model of pending changes, and how they become one git commit.
// Pure functions (no DOM), shared by the console and its Node tests.
import { isMap, isScalar, parseDocument } from "yaml";
import { defaultKind, shelfLabel } from "../lib/catalog.js";
import { STATUSES } from "../lib/config.js";
import { slugify } from "../lib/text.js";

// Fields an owner can set per book, and how each is stored in shelf.yml.
export const FIELDS = {
  title: "text",
  author: "text",
  year: "year",
  status: "status",
  rating: "rating",
  tags: "list",
  note: "text",
  description: "text",
  kind: "kind",
  listen: "listen",
  hidden: "hidden",
};

const asList = (value) => (Array.isArray(value) ? value : String(value ?? "").split(","))
  .map((item) => String(item).trim().toLowerCase())
  .filter(Boolean);

// The value a field normalizes to, so "no change" is detected reliably.
export function normalizeValue(key, value) {
  switch (FIELDS[key]) {
    case "list": return [...new Set(asList(value))];
    case "year": {
      const year = Number.parseInt(value, 10);
      return Number.isInteger(year) && year > -3000 && year < 3000 ? year : "";
    }
    case "rating": {
      const rating = Number(value);
      return Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : "";
    }
    case "status": {
      const status = String(value ?? "").trim().toLowerCase();
      return STATUSES.includes(status) ? status : "";
    }
    case "kind": {
      const kind = String(value ?? "").trim().toLowerCase();
      return kind === "article" || kind === "book" ? kind : "";
    }
    case "listen": return value !== false;
    case "hidden": return value === true;
    default: return String(value ?? "").replace(/\s+/g, " ").trim();
  }
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isEmpty(key, value) {
  if (FIELDS[key] === "listen") return value === true;
  if (FIELDS[key] === "hidden") return value === false;
  return value === "" || (Array.isArray(value) && !value.length);
}

// What the shelf shows for a field today: the shelf.yml override if there is
// one, otherwise what was read from the file.
export function effectiveValue(book, key) {
  const override = book.override || {};
  const entry = book.entry || {};
  switch (key) {
    case "author":
      if (override.author !== undefined) return normalizeValue(key, [].concat(override.author).join(", "));
      return normalizeValue(key, entry.author || (entry.authors || []).join(", "));
    case "kind":
      return normalizeValue(key, override.kind || entry.kind || defaultKind(book.extension, entry.pages));
    case "listen":
      return override.listen !== false;
    case "hidden":
      return override.hidden === true;
    case "title":
    case "description":
      return normalizeValue(key, override[key] ?? entry[key] ?? "");
    default:
      return normalizeValue(key, override[key] ?? "");
  }
}

// The value shown in the editor: a pending change if there is one.
export function currentValue(book, key) {
  if (book.draft && Object.hasOwn(book.draft, key)) {
    return book.draft[key] === null ? normalizeValue(key, FIELDS[key] === "listen" ? true : "") : book.draft[key];
  }
  return effectiveValue(book, key);
}

// Records an edit. Setting a field back to what the shelf shows drops the
// change; emptying an overridden field removes the override, so the value
// read from the file applies again.
export function setField(book, key, rawValue) {
  book.draft ||= {};
  const value = normalizeValue(key, rawValue);
  const overridden = Object.hasOwn(book.override || {}, key);
  if (same(value, effectiveValue(book, key))) delete book.draft[key];
  else if (isEmpty(key, value)) {
    if (overridden) book.draft[key] = null;
    else delete book.draft[key];
  } else book.draft[key] = value;
}

export function currentShelf(book) {
  return book.draft?.shelf ?? book.shelf ?? "";
}

// `known` lists existing shelves as { slug, label }. A typed name that matches
// one (by label or folder, ignoring case) files the book there, so picking
// “Science fiction & fantasy” from the list reuses books/sf/ rather than
// making books/science-fiction-and-fantasy/.
export function resolveShelf(label, known = []) {
  const typed = String(label || "").trim();
  if (!typed) return { slug: "", label: "" };
  const lower = typed.toLowerCase();
  const slug = slugify(typed);
  const match = known.find((shelf) => shelf.label.toLowerCase() === lower || shelf.slug === lower || shelf.slug === slug);
  if (match) return { slug: match.slug, label: "" };
  return { slug, label: typed !== shelfLabel(slug) ? typed : "" };
}

export function setShelf(book, label, known = []) {
  book.draft ||= {};
  const resolved = resolveShelf(label, known);
  const moving = resolved.slug !== (book.shelf || "");
  if (moving) book.draft.shelf = resolved.slug;
  else delete book.draft.shelf;
  if (moving && resolved.label) book.draft.shelfLabel = resolved.label;
  else delete book.draft.shelfLabel;
}

// Existing files keep their path (and file name) unless the shelf changes.
export function bookPath(book) {
  if (book.isNew) {
    const shelf = currentShelf(book);
    return `books/${shelf ? `${shelf}/` : ""}${book.id}.${book.extension}`;
  }
  if (book.draft?.shelf === undefined) return book.path;
  const shelf = book.draft.shelf;
  return `books/${shelf ? `${shelf}/` : ""}${book.path.split("/").pop()}`;
}

export function hasChanges(book) {
  return Boolean(book.isNew || book.removed || Object.keys(book.draft || {}).length);
}

function changedFields(book) {
  return Object.keys(book.draft || {}).filter((key) => Object.hasOwn(FIELDS, key));
}

function describe(book) {
  const title = currentValue(book, "title") || book.entry?.title || book.id;
  if (book.isNew) return { kind: "add", text: `Add ${title}` };
  if (book.removed) return { kind: "remove", text: `Remove ${title}` };
  const moved = book.draft?.shelf !== undefined;
  const edited = changedFields(book).length || book.draft?.cover;
  if (moved && !edited) return { kind: "move", text: `Move ${title} to ${shelfLabel(book.draft.shelf) || "the top shelf"}` };
  return { kind: "edit", text: `Update ${title}` };
}

export function summarize(books, settingsDraft) {
  const lines = books.filter(hasChanges).map(describe);
  if (settingsDraft && Object.keys(settingsDraft).length) lines.push({ kind: "settings", text: "Update the library details" });
  return lines;
}

export function commitMessage(lines) {
  if (!lines.length) return "";
  if (lines.length === 1) return lines[0].text;
  const count = (kind) => lines.filter((line) => line.kind === kind).length;
  const parts = [
    count("add") && `add ${count("add")} ${count("add") === 1 ? "book" : "books"}`,
    count("edit") && `update ${count("edit")}`,
    count("move") && `move ${count("move")}`,
    count("remove") && `remove ${count("remove")}`,
    count("settings") && "library details",
  ].filter(Boolean);
  const subject = `Shelf: ${parts.join(", ")}`;
  return `${subject}\n\n${lines.map((line) => `- ${line.text}`).join("\n")}`;
}

// ── shelf.yml editing ───────────────────────────────────────────────────────
// Book ids are matched as strings, so an id YAML reads as a number (1984)
// finds its existing entry instead of gaining a duplicate.

const keyOf = (pair) => String(isScalar(pair.key) ? pair.key.value : pair.key);

function booksMap(document) {
  let books = document.get("books", true);
  if (!isMap(books)) {
    books = document.createNode({});
    document.set("books", books);
  }
  books.flow = false; // `books: {}` would otherwise grow on a single line
  return books;
}

function bookEntry(document, id) {
  const books = booksMap(document);
  let pair = books.items.find((candidate) => keyOf(candidate) === id);
  if (!pair) {
    pair = document.createPair(id, document.createNode({}));
    books.items.push(pair);
  }
  if (!isMap(pair.value)) pair.value = document.createNode({}); // `meditations:` with no fields
  pair.value.flow = false;
  return pair.value;
}

function deleteBook(document, id) {
  const books = booksMap(document);
  books.items = books.items.filter((pair) => keyOf(pair) !== id);
}

// Scalars are updated in place so a trailing comment on the line survives.
function setValue(document, entry, key, value) {
  const existing = entry.get(key, true);
  if (isScalar(existing) && !Array.isArray(value)) {
    existing.value = value;
    return;
  }
  const node = document.createNode(value);
  if (Array.isArray(value)) node.flow = true;
  entry.set(key, node);
}

function coverUsedElsewhere(document, path, id) {
  const books = document.get("books", true);
  return isMap(books) && books.items.some((pair) => keyOf(pair) !== id && isMap(pair.value) && pair.value.get("cover") === path);
}

function idsOnShelf(snapshot) {
  const ids = new Map();
  for (const path of snapshot.files.keys()) {
    const match = path.match(/^books\/(.+)\.(?:epub|pdf)$/i);
    if (match) ids.set(slugify(match[1].split("/").pop()), path);
  }
  return ids;
}

// Turns pending changes into the tree entries and shelf.yml text of a single
// commit against `snapshot` (the branch's current files and shelf.yml).
// New files and covers must already be uploaded: `blobSha` / `cover.blobSha`.
export function planCommit({ books, settingsDraft = null, snapshot }) {
  const document = parseDocument(snapshot.shelfYaml || "");
  const entries = [];
  const problems = [];
  const shelfIds = idsOnShelf(snapshot);
  const gone = (path) => `${path} is no longer on the shelf — reload to see the latest.`;
  const deleteCover = (path, id) => {
    if (typeof path === "string" && path.startsWith("covers/") && snapshot.files.has(path) && !coverUsedElsewhere(document, path, id)) {
      entries.push({ path, mode: "100644", type: "blob", sha: null });
    }
  };

  for (const book of books.filter(hasChanges)) {
    const id = book.id;
    if (book.removed) {
      if (book.isNew) continue;
      if (!snapshot.files.has(book.path)) {
        problems.push(gone(book.path));
        continue;
      }
      entries.push({ path: book.path, mode: "100644", type: "blob", sha: null });
      deleteBook(document, id);
      deleteCover(book.override?.cover, id);
      continue;
    }

    const path = bookPath(book);
    if (book.isNew) {
      if (!book.blobSha) problems.push(`${id} has not been uploaded yet.`);
      if (shelfIds.has(id)) problems.push(`Another file on the shelf (${shelfIds.get(id)}) already uses the name “${id}”.`);
      entries.push({ path, mode: "100644", type: "blob", sha: book.blobSha });
      // A leftover entry for a file that was deleted by hand must not
      // attach itself to this new book.
      deleteBook(document, id);
    } else if (!snapshot.files.has(book.path)) {
      problems.push(gone(book.path));
      continue;
    } else if (path !== book.path) {
      if (snapshot.files.has(path)) problems.push(`${path} already exists on the shelf.`);
      else {
        entries.push({ path, mode: "100644", type: "blob", sha: snapshot.files.get(book.path).sha });
        entries.push({ path: book.path, mode: "100644", type: "blob", sha: null });
      }
    }

    const fields = changedFields(book);
    const cover = book.draft?.cover;
    if (fields.length || cover) {
      const entry = bookEntry(document, id);
      for (const key of fields) {
        if (book.draft[key] === null) entry.delete(key);
        else setValue(document, entry, key, book.draft[key]);
      }
      if (cover === "remove") {
        entry.delete("cover");
        deleteCover(book.override?.cover, id);
      } else if (cover) {
        if (!cover.blobSha) problems.push(`The new cover for ${id} has not been uploaded yet.`);
        const coverPath = `covers/${id}.jpg`;
        entries.push({ path: coverPath, mode: "100644", type: "blob", sha: cover.blobSha });
        setValue(document, entry, "cover", coverPath);
      }
      if (!entry.items.length) deleteBook(document, id);
    }

    const shelf = currentShelf(book);
    if (book.draft?.shelfLabel && shelf && document.getIn(["shelves", shelf]) === undefined) {
      if (!isMap(document.get("shelves", true))) document.set("shelves", document.createNode({}));
      document.get("shelves", true).flow = false;
      document.setIn(["shelves", shelf], book.draft.shelfLabel);
    }
  }

  for (const [key, value] of Object.entries(settingsDraft || {})) {
    if (value) document.set(key, value);
    else document.delete(key);
  }

  const shelfYaml = document.toString({ lineWidth: 0, flowCollectionPadding: false });
  if (shelfYaml !== snapshot.shelfYaml) entries.push({ path: "shelf.yml", mode: "100644", type: "blob", content: shelfYaml });
  const lines = summarize(books, settingsDraft);
  return { entries, shelfYaml, lines, message: commitMessage(lines), problems };
}

// A unique, readable id for a new book: its title, then title and author
// surname, then the file name, then a number.
export function chooseId({ title, author, fileName }, taken) {
  const titleSlug = slugify(title);
  const surname = slugify(String(author || "").split(",")[0].trim().split(/\s+/).pop());
  const candidates = [
    titleSlug,
    titleSlug && surname ? `${titleSlug}-${surname}` : "",
    slugify(String(fileName || "").replace(/\.[^.]+$/, "")),
  ].filter(Boolean);
  const free = candidates.find((candidate) => !taken.has(candidate));
  if (free) return free;
  const base = candidates[0] || "book";
  for (let suffix = 2; ; suffix += 1) if (!taken.has(`${base}-${suffix}`)) return `${base}-${suffix}`;
}
