import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "yaml";
import {
  bookPath,
  chooseId,
  currentValue,
  hasChanges,
  planCommit,
  resolveShelf,
  setField,
  setShelf,
} from "../site/admin/changes.js";

const SHELF_YAML = `# Library settings.
title: Satyam’s collection
owner: Satyam

# Per-book overrides.
books:
  meditations:
    tags: [stoicism]
  notes:
    cover: covers/notes.jpg
`;

function snapshot() {
  return {
    shelfYaml: SHELF_YAML,
    files: new Map([
      ["shelf.yml", { sha: "s1" }],
      ["books/philosophy/meditations.epub", { sha: "m1" }],
      ["books/essays/notes.pdf", { sha: "n1" }],
      ["covers/notes.jpg", { sha: "c1" }],
    ]),
  };
}

function existing(id, path, extra = {}) {
  const [, shelf] = path.match(/^books\/(?:([^/]+)\/)?/) || [];
  return {
    id,
    path,
    shelf: shelf || "",
    extension: path.split(".").pop(),
    override: {},
    entry: { title: id, author: "Someone", kind: "book" },
    draft: {},
    ...extra,
  };
}

test("edits only record real changes and emptying an override removes it", () => {
  const book = existing("meditations", "books/philosophy/meditations.epub", {
    override: { tags: ["stoicism"] },
    entry: { title: "Meditations", author: "Marcus Aurelius", kind: "book" },
  });
  setField(book, "title", "  Meditations ");
  assert.equal(hasChanges(book), false);
  setField(book, "tags", "Stoicism, favourites, stoicism");
  assert.deepEqual(book.draft.tags, ["stoicism", "favourites"]);
  setField(book, "tags", "");
  assert.equal(book.draft.tags, null, "clearing an override removes it");
  setField(book, "rating", "6");
  assert.equal(Object.hasOwn(book.draft, "rating"), false, "invalid ratings are ignored");
  setField(book, "listen", false);
  assert.equal(book.draft.listen, false);
  setField(book, "listen", true);
  assert.equal(Object.hasOwn(book.draft, "listen"), false);
  assert.equal(currentValue(book, "title"), "Meditations");
});

test("plans one commit: add, move, edit, remove, cover, and settings", () => {
  const meditations = existing("meditations", "books/philosophy/meditations.epub", {
    override: { tags: ["stoicism"] },
    entry: { title: "Meditations", author: "Marcus Aurelius", kind: "book" },
  });
  setShelf(meditations, "Stoic classics");
  setField(meditations, "status", "reading");
  setField(meditations, "note", "Book four: #1");
  meditations.draft.cover = { blobSha: "cover-sha" };

  const notes = existing("notes", "books/essays/notes.pdf", { override: { cover: "covers/notes.jpg" } });
  notes.removed = true;

  const walden = {
    id: "walden",
    isNew: true,
    extension: "epub",
    shelf: "",
    override: {},
    entry: { title: "Walden", author: "", kind: "book" },
    draft: {},
    blobSha: "walden-sha",
  };
  setShelf(walden, "essays");
  setField(walden, "author", "Henry David Thoreau");
  setField(walden, "title", "Walden");

  const plan = planCommit({ books: [meditations, notes, walden], settingsDraft: { description: "Kept close." }, snapshot: snapshot() });
  assert.deepEqual(plan.problems, []);
  const byPath = Object.fromEntries(plan.entries.map((entry) => [entry.path, entry.sha === undefined ? "content" : entry.sha]));
  assert.deepEqual(byPath, {
    "books/stoic-classics/meditations.epub": "m1",
    "books/philosophy/meditations.epub": null,
    "covers/meditations.jpg": "cover-sha",
    "books/essays/notes.pdf": null,
    "covers/notes.jpg": null,
    "books/essays/walden.epub": "walden-sha",
    "shelf.yml": "content",
  });

  const config = parse(plan.shelfYaml);
  assert.deepEqual(config.books.meditations, { tags: ["stoicism"], status: "reading", note: "Book four: #1", cover: "covers/meditations.jpg" });
  assert.deepEqual(config.books.walden, { author: "Henry David Thoreau" }, "only fields that differ from the file are written");
  assert.equal(config.books.notes, undefined);
  assert.equal(config.shelves["stoic-classics"], "Stoic classics");
  assert.equal(config.description, "Kept close.");
  assert.match(plan.shelfYaml, /^# Library settings\.\ntitle: Satyam’s collection/, "comments survive");
  assert.match(plan.shelfYaml, /tags: \[stoicism\]/);
  assert.match(plan.message, /^Shelf: add 1 book, update 1, remove 1, library details\n\n- Update Meditations\n- Remove notes\n- Add Walden/);
});

test("refuses to plan against a shelf that changed underneath", () => {
  const gone = existing("gone", "books/gone.epub");
  setField(gone, "status", "read");
  const clash = { id: "meditations", isNew: true, extension: "epub", shelf: "philosophy", override: {}, entry: { title: "Meditations" }, draft: {} };
  const plan = planCommit({ books: [gone, clash], snapshot: snapshot() });
  assert.equal(plan.problems.length, 3);
  assert.match(plan.problems.join("\n"), /gone\.epub is no longer on the shelf/);
  assert.match(plan.problems.join("\n"), /not been uploaded/);
  assert.match(plan.problems.join("\n"), /already uses the name “meditations”/);
});

test("new book ids are readable and unique", () => {
  const taken = new Set(["walden"]);
  assert.equal(chooseId({ title: "Walden", author: "Henry David Thoreau", fileName: "x.epub" }, taken), "walden-thoreau");
  assert.equal(chooseId({ title: "", author: "", fileName: "Some Draft (v2).pdf" }, taken), "some-draft-v2");
  taken.add("walden-thoreau");
  taken.add("x");
  assert.equal(chooseId({ title: "Walden", author: "Henry David Thoreau", fileName: "x.epub" }, taken), "walden-2");
});

test("ids YAML reads as numbers keep a single entry", () => {
  const book = existing("1984", "books/1984.epub", { override: { tags: ["dystopia"], status: "read" } });
  setField(book, "rating", 5);
  const yaml = "books:\n  1984:\n    tags: [dystopia]\n    status: read\n";
  const plan = planCommit({ books: [book], snapshot: { shelfYaml: yaml, files: new Map([["books/1984.epub", { sha: "x" }]]) } });
  assert.deepEqual(plan.problems, []);
  assert.equal((plan.shelfYaml.match(/1984/g) || []).length, 1);
  assert.deepEqual(parse(plan.shelfYaml).books["1984"], { tags: ["dystopia"], status: "read", rating: 5 });
});

test("a removal is refused when the file moved elsewhere meanwhile", () => {
  const book = existing("walden", "books/essays/walden.epub", { override: { note: "keep" } });
  book.removed = true;
  const files = new Map([["books/nature/walden.epub", { sha: "w" }]]);
  const plan = planCommit({ books: [book], snapshot: { shelfYaml: "books:\n  walden:\n    note: keep\n", files } });
  assert.match(plan.problems[0], /no longer on the shelf/);
  assert.equal(plan.entries.length, 0);
});

test("editing never renames a file; only a shelf change moves it, keeping its name", () => {
  const book = existing("dune", "books/Science Fiction/Dune.EPUB");
  book.shelf = "science-fiction";
  setField(book, "tags", "classic");
  assert.equal(bookPath(book), "books/Science Fiction/Dune.EPUB");
  setShelf(book, "Favourites");
  assert.equal(bookPath(book), "books/favourites/Dune.EPUB");
});

test("picking an existing shelf by its label reuses its folder", () => {
  const known = [{ slug: "sf", label: "Science fiction & fantasy" }, { slug: "essays", label: "Essays" }];
  assert.deepEqual(resolveShelf("science fiction & fantasy", known), { slug: "sf", label: "" });
  assert.deepEqual(resolveShelf("essays", known), { slug: "essays", label: "" });
  assert.deepEqual(resolveShelf("Poetry", known), { slug: "poetry", label: "" });
  assert.deepEqual(resolveShelf("Stoic classics", known), { slug: "stoic-classics", label: "Stoic classics" });
  const book = existing("dune", "books/sf/dune.epub");
  setShelf(book, "Science fiction & fantasy", known);
  assert.equal(hasChanges(book), false);
});

test("a new book does not inherit a stale entry; empty and flow-style entries are handled", () => {
  const yaml = "books: {walden: {hidden: true, title: Something else}, notes: {status: read}}\n";
  const walden = { id: "walden", isNew: true, extension: "epub", shelf: "", override: {}, entry: { title: "Walden" }, draft: {}, blobSha: "w" };
  setField(walden, "status", "reading");
  const notes = existing("notes", "books/notes.pdf");
  setField(notes, "rating", 3);
  const plan = planCommit({ books: [walden, notes], snapshot: { shelfYaml: yaml, files: new Map([["books/notes.pdf", { sha: "n" }]]) } });
  assert.deepEqual(plan.problems, []);
  const config = parse(plan.shelfYaml);
  assert.deepEqual(config.books.walden, { status: "reading" });
  assert.deepEqual(config.books.notes, { status: "read", rating: 3 });
  assert.match(plan.shelfYaml, /^books:\n {2}\S/m, "books are written one per line");

  const bare = existing("bare", "books/bare.epub");
  setField(bare, "status", "want");
  const fromEmpty = planCommit({ books: [bare], snapshot: { shelfYaml: "books:\n  bare:\n", files: new Map([["books/bare.epub", { sha: "b" }]]) } });
  assert.deepEqual(fromEmpty.problems, []);
  assert.deepEqual(parse(fromEmpty.shelfYaml).books.bare, { status: "want" });
});

test("comments on changed lines survive, and shared covers are kept", () => {
  const yaml = "books:\n  a:\n    status: want # started in May\n    cover: covers/shared.jpg\n  b:\n    cover: covers/shared.jpg\n";
  const a = existing("a", "books/a.epub", { override: { status: "want", cover: "covers/shared.jpg" } });
  setField(a, "status", "Reading");
  const b = existing("b", "books/b.epub", { override: { cover: "covers/shared.jpg" } });
  b.removed = true;
  const files = new Map([["books/a.epub", { sha: "a" }], ["books/b.epub", { sha: "b" }], ["covers/shared.jpg", { sha: "c" }]]);
  const plan = planCommit({ books: [a, b], snapshot: { shelfYaml: yaml, files } });
  assert.match(plan.shelfYaml, /status: reading # started in May/);
  assert.equal(plan.entries.some((entry) => entry.path === "covers/shared.jpg"), false);
});
