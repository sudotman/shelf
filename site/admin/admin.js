import { parseDocument } from "yaml";
import { shelfLabel } from "../lib/catalog.js";
import { formatBytes, slugify } from "../lib/text.js";
import {
  bookPath,
  chooseId,
  commitMessage,
  currentShelf,
  currentValue,
  hasChanges,
  planCommit,
  setField,
  setShelf,
  summarize,
} from "./changes.js";
import { GitHub } from "./github.js";
import { inspectFile, prepareCoverImage } from "./inspect.js";

const TOKEN_KEY = "shelf-admin:token";
const DRAFT_DB = "shelf-admin";
const CHIP_COLORS = ["#5b3a2e", "#2f4a46", "#3e4a63", "#6b5232", "#4f3a52", "#7a3324", "#33473a", "#2c3a4f"];
const $ = (selector, root = document) => root.querySelector(selector);

const elements = {
  boot: $("#boot"),
  connectView: $("#connect-view"),
  consoleView: $("#console-view"),
  repoName: $("#repo-name"),
  repoLink: $("#repo-link"),
  tokenLink: $("#token-link"),
  connectForm: $("#connect-form"),
  token: $("#token"),
  remember: $("#remember"),
  connectButton: $("#connect-button"),
  connectError: $("#connect-error"),
  brandOwner: $("#brand-owner"),
  avatar: $("#avatar"),
  login: $("#login"),
  reloadButton: $("#reload-button"),
  signOut: $("#sign-out"),
  layout: $("#layout"),
  addButton: $("#add-button"),
  fileInput: $("#file-input"),
  filter: $("#filter"),
  bookList: $("#book-list"),
  settingsButton: $("#settings-button"),
  pane: $("#pane"),
  changesBar: $("#changes-bar"),
  changesSummary: $("#changes-summary"),
  discardAll: $("#discard-all"),
  publishButton: $("#publish-button"),
  dropOverlay: $("#drop-overlay"),
  shelfOptions: $("#shelf-options"),
  publishDialog: $("#publish-dialog"),
  publishForm: $("#publish-form"),
  publishTitle: $("#publish-title"),
  publishLines: $("#publish-lines"),
  messageField: $("#message-field"),
  commitMessage: $("#commit-message"),
  publishSteps: $("#publish-steps"),
  publishError: $("#publish-error"),
  publishCancel: $("#publish-cancel"),
  publishConfirm: $("#publish-confirm"),
  toast: $("#toast"),
};

const state = {
  gh: null,
  repository: "",
  branch: "main",
  user: null,
  catalog: null,
  snapshot: null,
  config: {},
  books: [],
  settingsDraft: {},
  selected: null,
  filter: "",
  lastShelf: "",
  nextKey: 1,
  publishing: false,
  // Details of just-published books until the rebuilt catalog includes them.
  recent: new Map(),
  toastTimer: 0,
  persistQueued: false,
  persistChain: null,
};

// ── Small helpers ───────────────────────────────────────────────────────────

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function template(id) {
  const fragment = document.getElementById(id).content.cloneNode(true);
  const refs = {};
  fragment.querySelectorAll("[data-ref]").forEach((node) => { refs[node.dataset.ref] = node; });
  return { root: fragment.firstElementChild, refs };
}

function hash(value) {
  let result = 2166136261;
  for (const character of value) result = Math.imul(result ^ character.codePointAt(0), 16777619);
  return result >>> 0;
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 3200);
}

function formatMinutes(minutes) {
  if (!minutes) return "";
  if (minutes < 60) return `${minutes} min listen`;
  const rest = minutes % 60;
  return `${Math.floor(minutes / 60)} h${rest ? ` ${rest} min` : ""} listen`;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Token ──────────────────────────────────────────────────────────────────

function storedToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

function storeToken(token, remember) {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
    if (remember) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Without storage the token lasts until the page reloads.
  }
}

function forgetToken() {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Nothing stored.
  }
}

function tokenUrl(repository) {
  const [owner] = repository.split("/");
  const params = new URLSearchParams({
    name: "Shelf admin",
    description: `Lets the shelf admin console add and edit books in ${repository}.`,
    target_name: owner || "",
    expires_in: "366",
    contents: "write",
    actions: "read",
  });
  return `https://github.com/settings/personal-access-tokens/new?${params}`;
}

// ── Library data ───────────────────────────────────────────────────────────

async function fetchCatalog() {
  const response = await fetch(`../catalog.json?t=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`catalog.json returned ${response.status}`);
  return response.json();
}

// Shelves a typed name can match: saved ones, and new ones other pending books
// introduce (not `except`'s own, so its new label isn't matched to itself).
function knownShelves(except = null) {
  const slugs = new Set([
    ...Object.keys(state.config.shelves || {}),
    ...(state.catalog?.shelves || []).map((shelf) => shelf.id),
    ...state.books.map((book) => (book === except ? book.shelf : currentShelf(book))),
  ].filter(Boolean));
  return [...slugs].map((slug) => ({ slug, label: labelForShelf(slug) }));
}

function labelForShelf(slug) {
  if (!slug) return "";
  return state.config.shelves?.[slug]
    || state.catalog?.shelves?.find((shelf) => shelf.id === slug)?.label
    || state.books.find((book) => book.draft?.shelf === slug && book.draft.shelfLabel)?.draft.shelfLabel
    || shelfLabel(slug);
}

async function loadLibrary() {
  const [snapshot, catalog] = await Promise.all([
    state.gh.snapshot(state.branch),
    fetchCatalog().catch(() => state.catalog),
  ]);
  state.snapshot = snapshot;
  state.catalog = catalog;
  state.config = parseDocument(snapshot.shelfYaml).toJS() || {};
  const entries = new Map((catalog?.books || []).map((entry) => [entry.id, entry]));
  for (const id of entries.keys()) state.recent.delete(id);
  const previous = new Map(state.books.map((book) => [book.key, book]));
  const existing = [];
  for (const [path, file] of snapshot.files) {
    const match = path.match(/^books\/(.+)\.(epub|pdf)$/i);
    if (!match) continue;
    const parts = match[1].split("/");
    if (parts.some((part) => part.startsWith(".") || part.startsWith("_"))) continue;
    const id = slugify(parts.at(-1));
    // Keyed by path: two files can (wrongly) share an id until one is removed.
    const key = `book:${path}`;
    existing.push({
      key,
      id,
      path,
      extension: match[2].toLowerCase(),
      shelf: parts.length > 1 ? slugify(parts[0]) : "",
      blobSha: file.sha,
      size: file.size,
      override: state.config.books?.[id] || {},
      entry: entries.get(id) || state.recent.get(id) || null,
      draft: previous.get(key)?.draft || {},
      removed: previous.get(key)?.removed || false,
    });
  }
  state.books = [...existing, ...state.books.filter((book) => book.isNew)];
  if (state.selected && state.selected !== "settings" && !findBook(state.selected)) state.selected = null;
}

function findBook(key) {
  return state.books.find((book) => book.key === key) || null;
}

function takenIds(except) {
  return new Set(state.books.filter((book) => book !== except && book.id).map((book) => book.id));
}

function pathForGitSha(sha) {
  for (const [path, file] of state.snapshot?.files || []) if (file.sha === sha) return path;
  return "";
}

function displayTitle(book) {
  return currentValue(book, "title") || book.entry?.title || book.id || book.file?.name || "Untitled";
}

function chipColor(book) {
  return book.entry?.color && !/^#f[0-9a-f]f[0-9a-f]f/i.test(book.entry.color) ? book.entry.color : CHIP_COLORS[hash(book.id || book.key) % CHIP_COLORS.length];
}

function coverSource(book) {
  const draft = book.draft?.cover;
  if (draft && draft !== "remove") return draft.url;
  if (draft === "remove") return book.detected?.cover?.url || "";
  if (book.isNew) return book.detected?.cover?.url || "";
  return book.entry?.cover ? new URL(`../${book.entry.cover}`, location.href).href : "";
}

// Problems that must be fixed before publishing.
function problemsFor(book) {
  if (book.removed) return [];
  const problems = [];
  if (book.isNew) {
    if (book.inspecting) problems.push("Still reading this file…");
    if (book.error) problems.push(book.error);
    if (book.duplicateOf) problems.push(`This exact file is already on the shelf as ${book.duplicateOf}.`);
    if (!book.id) problems.push("It needs a file name.");
    else if (takenIds(book).has(book.id)) problems.push(`Another book is already called “${book.id}”. Change the file name under More.`);
  }
  return problems;
}

function allProblems() {
  return state.books.flatMap((book) => problemsFor(book).map((problem) => ({ book, problem })));
}

function changeCount() {
  return summarize(state.books, state.settingsDraft).length;
}

// ── Drafts survive closed tabs (files included) ────────────────────────────

// Two stores: "files" keeps each dropped book once, as it was added; "drafts"
// holds one small record per repository describing the pending changes, which
// is rewritten on every edit.
function openDraftDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DRAFT_DB, 2);
    request.onupgradeneeded = () => {
      for (const name of ["drafts", "files"]) {
        if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function draftStore(name, mode, work) {
  const database = await openDraftDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(name, mode);
      let result;
      Promise.resolve(work(transaction.objectStore(name))).then((value) => { result = value; });
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

const requestValue = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

// Stored as bytes, not Blob/File: some WebKit builds cannot keep blobs in
// IndexedDB, while ArrayBuffers clone everywhere.
async function packBlob(blob) {
  return blob ? { bytes: await blob.arrayBuffer(), type: blob.type, name: blob.name || "", lastModified: blob.lastModified || 0 } : null;
}

function unpackBlob(packed) {
  if (!packed?.bytes) return null;
  return packed.name
    ? new File([packed.bytes], packed.name, { type: packed.type, lastModified: packed.lastModified })
    : new Blob([packed.bytes], { type: packed.type });
}

const saveFile = async (key, file) => {
  const packed = await packBlob(file);
  return draftStore("files", "readwrite", (store) => { store.put(packed, key); });
};
const loadFile = async (key) => unpackBlob(await draftStore("files", "readonly", (store) => requestValue(store.get(key))));
const forgetFiles = (keys) => draftStore("files", "readwrite", (store) => { keys.filter(Boolean).forEach((key) => store.delete(key)); });

function newFileKey() {
  return `${state.repository}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function packCover(cover) {
  if (!cover || typeof cover !== "object") return cover;
  return { packed: await packBlob(cover.blob), width: cover.width, height: cover.height, blobSha: cover.blobSha };
}

function unpackCover(cover) {
  if (!cover || typeof cover !== "object") return cover;
  const blob = unpackBlob(cover.packed);
  return blob ? { blob, url: URL.createObjectURL(blob), width: cover.width, height: cover.height, blobSha: cover.blobSha } : undefined;
}

async function packDraft(draft) {
  const packed = { ...draft };
  if (draft.cover) packed.cover = await packCover(draft.cover);
  return packed;
}

function unpackDraft(draft) {
  const unpacked = { ...draft, cover: unpackCover(draft.cover) };
  if (!unpacked.cover) delete unpacked.cover;
  return unpacked;
}

async function draftRecord() {
  const edits = await Promise.all(state.books
    .filter((book) => !book.isNew && hasChanges(book))
    .map(async (book) => ({ id: book.id, path: book.path, removed: Boolean(book.removed), draft: await packDraft(book.draft) })));
  const adds = await Promise.all(state.books.filter((book) => book.isNew && !book.inspecting).map(async (book) => ({
    fileKey: book.fileKey,
    id: book.id,
    extension: book.extension,
    shelf: book.shelf,
    size: book.size,
    blobSha: book.blobSha || "",
    gitSha: book.gitSha || "",
    error: book.error || "",
    entry: book.entry,
    detected: book.detected ? { ...book.detected, cover: await packCover(book.detected.cover) } : null,
    draft: await packDraft(book.draft),
  })));
  if (!edits.length && !adds.length && !Object.keys(state.settingsDraft).length) return null;
  return { savedAt: Date.now(), edits, adds, settingsDraft: state.settingsDraft };
}

// Saves are queued so they land in order; edits within one task are merged.
function persistDraft() {
  if (state.persistQueued) return;
  state.persistQueued = true;
  queueMicrotask(() => {
    state.persistQueued = false;
    state.persistChain = (state.persistChain || Promise.resolve())
      .then(() => draftRecord())
      .then((record) => draftStore("drafts", "readwrite", (store) => {
        if (record) store.put(record, state.repository);
        else store.delete(state.repository);
      }))
      .catch((error) => console.warn("[shelf admin] could not save the draft", error));
  });
}

async function clearDraft() {
  const record = await draftStore("drafts", "readonly", (store) => requestValue(store.get(state.repository))).catch(() => null);
  state.persistChain = (state.persistChain || Promise.resolve())
    .then(() => draftStore("drafts", "readwrite", (store) => { store.delete(state.repository); }))
    .then(() => forgetFiles((record?.adds || []).map((add) => add.fileKey)))
    .catch(() => {});
  return state.persistChain;
}

// Files kept for a batch that was closed mid-read have no draft entry.
async function forgetOrphanFiles(record) {
  const kept = new Set((record?.adds || []).map((add) => add.fileKey));
  const keys = await draftStore("files", "readonly", (store) => requestValue(store.getAllKeys())).catch(() => []);
  const orphans = keys.filter((key) => String(key).startsWith(`${state.repository}:`) && !kept.has(key));
  if (orphans.length) await forgetFiles(orphans).catch(() => {});
}

async function restoreDraft() {
  const record = await draftStore("drafts", "readonly", (store) => requestValue(store.get(state.repository))).catch(() => null);
  await forgetOrphanFiles(record);
  if (!record) return;
  let restored = 0;
  for (const edit of record.edits || []) {
    const book = state.books.find((candidate) => !candidate.isNew && candidate.path === edit.path)
      || state.books.find((candidate) => !candidate.isNew && candidate.id === edit.id);
    if (!book) continue;
    book.draft = unpackDraft(edit.draft);
    book.removed = edit.removed;
    restored += 1;
  }
  for (const add of record.adds || []) {
    const file = await loadFile(add.fileKey).catch(() => null);
    if (!file) continue;
    const book = {
      ...add,
      file,
      key: `new:${state.nextKey++}`,
      isNew: true,
      override: {},
      duplicateOf: add.gitSha ? pathForGitSha(add.gitSha) : "",
      detected: add.detected ? { ...add.detected, cover: unpackCover(add.detected.cover) } : null,
      draft: unpackDraft(add.draft),
    };
    state.books.push(book);
    restored += 1;
  }
  state.settingsDraft = record.settingsDraft || {};
  if (Object.keys(state.settingsDraft).length) restored += 1;
  if (restored) showToast(`Picked up where you left off: ${restored} unpublished ${restored === 1 ? "change" : "changes"}.`);
}

// ── Rendering ──────────────────────────────────────────────────────────────

function renderAll() {
  renderList();
  renderPane();
  renderChanges();
  renderShelfOptions();
}

function badgeFor(book) {
  if (problemsFor(book).length && !book.inspecting) return ["problem", "Fix"];
  if (book.inspecting) return ["pending", "Reading"];
  if (book.removed) return ["removed", "Removing"];
  if (book.isNew) return ["new", "New"];
  if (hasChanges(book)) return ["edited", "Edited"];
  if (book.override?.hidden) return ["hidden", "Hidden"];
  if (!book.entry) return ["pending", "Building"];
  if (book.override?.status === "reading") return ["reading", "Reading"];
  return null;
}

function listItem(book) {
  const button = element("button", "list-item");
  button.type = "button";
  button.dataset.key = book.key;
  button.classList.toggle("is-removed", Boolean(book.removed));
  if (state.selected === book.key) button.setAttribute("aria-current", "true");
  const chip = element("span", "list-chip");
  chip.style.setProperty("--chip", chipColor(book));
  const title = element("span", "list-title", displayTitle(book));
  const author = element("span", "list-author", currentValue(book, "author") || (book.isNew ? book.file?.name || "" : "No author"));
  button.append(chip, title);
  const badge = badgeFor(book);
  if (badge) button.append(element("span", `badge badge-${badge[0]}`, badge[1]));
  button.append(author);
  button.addEventListener("click", () => select(book.key));
  return button;
}

function renderList() {
  const tokens = state.filter.toLowerCase().split(/\s+/).filter(Boolean);
  const visible = state.books.filter((book) => {
    if (!tokens.length) return true;
    const haystack = [displayTitle(book), currentValue(book, "author"), labelForShelf(currentShelf(book)), ...(currentValue(book, "tags") || []), book.id].join(" ").toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
  const groups = new Map();
  for (const book of visible) {
    const shelf = currentShelf(book);
    if (!groups.has(shelf)) groups.set(shelf, []);
    groups.get(shelf).push(book);
  }
  const ordered = [...groups.entries()].sort(([left], [right]) => (!left) - (!right) || labelForShelf(left).localeCompare(labelForShelf(right)));
  const fragment = document.createDocumentFragment();
  for (const [shelf, books] of ordered) {
    fragment.append(element("p", "list-shelf", shelf ? labelForShelf(shelf) : "Unshelved"));
    books
      .sort((left, right) => Number(Boolean(right.isNew)) - Number(Boolean(left.isNew)) || displayTitle(left).localeCompare(displayTitle(right)))
      .forEach((book) => fragment.append(listItem(book)));
  }
  if (!visible.length) {
    fragment.append(element("p", "list-empty", state.books.length ? "Nothing matches that filter." : "The shelf is empty. Add a book to begin."));
  }
  elements.bookList.replaceChildren(fragment);
  if (state.selected === "settings") elements.settingsButton.setAttribute("aria-current", "true");
  else elements.settingsButton.removeAttribute("aria-current");
}

function refreshListItem(book) {
  const current = elements.bookList.querySelector(`[data-key="${CSS.escape(book.key)}"]`);
  if (current) current.replaceWith(listItem(book));
  else renderList();
}

function renderShelfOptions() {
  const slugs = new Set([
    ...Object.keys(state.config.shelves || {}),
    ...(state.catalog?.shelves || []).map((shelf) => shelf.id),
    ...state.books.map((book) => currentShelf(book)),
  ].filter(Boolean));
  elements.shelfOptions.replaceChildren(...[...slugs].map((slug) => {
    const option = element("option");
    option.value = labelForShelf(slug);
    return option;
  }));
}

function renderChanges() {
  const lines = summarize(state.books, state.settingsDraft);
  const problems = allProblems();
  document.body.classList.toggle("has-changes", lines.length > 0);
  elements.changesBar.hidden = !lines.length;
  const strong = element("strong", "", `${lines.length} unpublished ${lines.length === 1 ? "change" : "changes"}`);
  // Spelled out rather than a disabled button with a tooltip, which touch
  // screens never show; Publish then jumps to the book that needs fixing.
  const fix = problems.length ? `${problems.length} to fix first · ` : "";
  elements.changesSummary.replaceChildren(strong, document.createTextNode(fix + lines.map((line) => line.text).join(" · ")));
  elements.publishButton.disabled = state.publishing;
  elements.publishButton.title = problems.length ? problems[0].problem : "Publish (Ctrl+S)";
}

function renderPane() {
  elements.layout.dataset.mode = state.selected ? "detail" : "list";
  const book = state.selected && state.selected !== "settings" ? findBook(state.selected) : null;
  if (state.selected === "settings") elements.pane.replaceChildren(renderSettings());
  else if (book) elements.pane.replaceChildren(renderEditor(book));
  else elements.pane.replaceChildren(renderWelcome());
}

function renderWelcome() {
  const { root, refs } = template("welcome-template");
  $("[data-action=choose-files]", root).addEventListener("click", () => elements.fileInput.click());
  const count = state.books.filter((book) => !book.isNew).length;
  refs.tally.textContent = `${count} ${count === 1 ? "book" : "books"} on ${state.repository} · ${state.branch}`;
  return root;
}

function select(key) {
  state.selected = key;
  renderList();
  renderPane();
  elements.pane.scrollTop = 0;
  if (window.matchMedia("(max-width: 860px)").matches) window.scrollTo({ top: 0 });
}

// ── Editor ─────────────────────────────────────────────────────────────────

function renderCover(book, frame) {
  frame.replaceChildren();
  if (book.inspecting) {
    frame.append(element("span", "reading", "Reading…"));
    return;
  }
  const source = coverSource(book);
  const typeset = element("div", "typeset");
  typeset.style.setProperty("--chip", chipColor(book));
  typeset.append(element("span", "", displayTitle(book)), element("small", "", currentValue(book, "author")));
  if (!source) {
    frame.append(typeset);
    return;
  }
  const image = new Image();
  image.alt = `Cover of ${displayTitle(book)}`;
  image.addEventListener("error", () => image.replaceWith(typeset), { once: true });
  image.src = source;
  frame.append(image);
}

function noticesFor(book) {
  const notices = problemsFor(book).filter((problem) => !book.inspecting || problem !== "Still reading this file…")
    .map((text) => ({ text, kind: "problem", drop: book.isNew && (book.duplicateOf || book.error) }));
  if (book.removed) notices.push({ text: "This book will be taken off the shelf when you publish.", kind: "problem" });
  if (book.inspecting) return notices;
  if (book.isNew && !book.error) {
    if (!currentValue(book, "title")) notices.push({ text: "The file has no title — add one above.", kind: "warn" });
    if (!currentValue(book, "author")) notices.push({ text: "The file has no author — add one so the shelf can file it.", kind: "warn" });
  }
  const listenable = book.isNew ? book.detected?.listenable : book.entry?.listenable;
  const note = book.isNew ? book.detected?.listenNote : book.entry?.listenNote;
  if (listenable === false && note && currentValue(book, "listen")) notices.push({ text: `Not listenable in Hear: ${note}`, kind: "warn" });
  if (!book.isNew && !book.entry && !book.override?.hidden) notices.push({ text: "Not on the site yet — it appears after the next build.", kind: "ok" });
  const twin = !book.isNew && state.books.find((other) => other !== book && !other.isNew && !other.removed && other.id === book.id);
  if (twin && !book.removed) {
    notices.push({ text: `${twin.path} has the same name, so the site cannot build until one of them is removed.`, kind: "problem" });
  }
  return notices;
}

function factsFor(book) {
  const details = book.isNew ? book.detected : book.entry;
  const path = bookPath(book);
  const moved = !book.isNew && path !== book.path ? `${book.path} → ${path}` : path;
  return [
    book.extension?.toUpperCase(),
    book.size ? formatBytes(book.size) : "",
    details?.pages ? `${details.pages} pages` : "",
    formatMinutes(details?.minutes),
    book.id ? moved : "",
  ].filter(Boolean).join(" · ");
}

function renderEditor(book) {
  const { root, refs } = template("editor-template");
  const form = refs.form;
  const inputs = Object.fromEntries([...form.elements].filter((input) => input.name).map((input) => [input.name, input]));

  const fillFields = () => {
    for (const key of ["title", "author", "year", "note", "description"]) inputs[key].value = currentValue(book, key) ?? "";
    inputs.tags.value = (currentValue(book, "tags") || []).join(", ");
    inputs.shelf.value = labelForShelf(currentShelf(book));
    inputs.id.value = book.id || "";
    inputs.listen.checked = currentValue(book, "listen");
    inputs.hidden.checked = currentValue(book, "hidden");
    inputs.title.placeholder = book.isNew ? "Title" : "Title from the file";
    inputs.author.placeholder = book.isNew ? "Author" : "Author from the file";
    inputs.description.placeholder = "Description from the file";
  };

  const syncChoices = () => {
    const status = currentValue(book, "status");
    refs.status.querySelectorAll("button").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.value === status)));
    const kind = currentValue(book, "kind");
    refs.kind.querySelectorAll("button").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.value === kind)));
    const rating = currentValue(book, "rating") || 0;
    refs.rating.querySelectorAll("button").forEach((button) => {
      const lit = Number(button.dataset.value) <= rating;
      button.classList.toggle("is-lit", lit);
      button.setAttribute("aria-pressed", String(Number(button.dataset.value) === rating));
    });
  };

  const syncChrome = () => {
    refs.state.textContent = book.removed
      ? "Will be removed"
      : book.isNew
        ? book.inspecting ? "Reading the file" : "New · not published yet"
        : hasChanges(book) ? "Edited · not published yet" : book.override?.hidden ? "Hidden from the site" : "On the shelf";
    refs.heading.textContent = displayTitle(book);
    refs.byline.textContent = currentValue(book, "author") || (book.isNew ? "" : "No author");
    refs.facts.textContent = factsFor(book);
    refs.notices.replaceChildren(...noticesFor(book).map((notice) => {
      const item = element("li", `is-${notice.kind}`, notice.text);
      if (notice.drop) {
        const drop = element("button", "text-button", "Leave it out");
        drop.type = "button";
        drop.addEventListener("click", () => dropNewBook(book));
        item.append(drop);
      }
      return item;
    }));
    const changedKeys = new Set(Object.keys(book.draft || {}));
    if (changedKeys.has("shelfLabel")) changedKeys.add("shelf");
    form.querySelectorAll(".field").forEach((field) => {
      const name = field.querySelector("[name]")?.name || (field.contains(refs.status) ? "status" : field.contains(refs.rating) ? "rating" : field.contains(refs.kind) ? "kind" : "");
      field.classList.toggle("is-changed", !book.isNew && changedKeys.has(name));
    });
    refs["id-field"].hidden = !book.isNew;
    $("[data-action=revert]", root).hidden = book.isNew || !hasChanges(book);
    $("[data-action=remove]", root).hidden = Boolean(book.removed);
    $("[data-action=remove]", root).textContent = book.isNew ? "Leave this file out" : "Remove from the shelf";
    $("[data-action=restore]", root).hidden = !book.removed;
    $("[data-action=reset-cover]", root).hidden = !(book.draft?.cover && book.draft.cover !== "remove") && !book.override?.cover;
    refs["view-link"].hidden = book.isNew || !book.entry;
    refs["view-link"].href = `../#${encodeURIComponent(book.id)}`;
    form.querySelectorAll("input, textarea, button").forEach((control) => { control.disabled = Boolean(book.removed || book.inspecting); });
    renderCover(book, refs.cover);
  };

  const changed = () => {
    syncChrome();
    syncChoices();
    refreshListItem(book);
    renderChanges();
    persistDraft();
  };

  form.addEventListener("input", (event) => {
    const { name, value } = event.target;
    if (!name || name === "listen" || name === "hidden") return;
    if (name === "shelf") {
      setShelf(book, value, knownShelves(book));
      if (book.isNew) state.lastShelf = currentShelf(book);
      renderList();
    } else if (name === "id") {
      book.id = slugify(value);
    } else {
      setField(book, name, value);
    }
    changed();
  });
  form.addEventListener("change", (event) => {
    const { name, checked, value } = event.target;
    if (name === "listen" || name === "hidden") {
      setField(book, name, checked);
      changed();
    } else if (name === "id") {
      event.target.value = book.id;
    } else if (name === "shelf") {
      event.target.value = labelForShelf(currentShelf(book));
      renderShelfOptions();
    } else if (name === "tags") {
      event.target.value = (currentValue(book, "tags") || []).join(", ");
    } else if (name === "year") {
      event.target.value = currentValue(book, "year");
    } else if (name) {
      event.target.value = currentValue(book, name) ?? value;
    }
  });
  form.addEventListener("submit", (event) => event.preventDefault());
  refs.status.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    setField(book, "status", button.dataset.value);
    changed();
  });
  refs.kind.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    setField(book, "kind", button.dataset.value);
    changed();
  });
  refs.rating.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    const value = Number(button.dataset.value);
    setField(book, "rating", currentValue(book, "rating") === value ? "" : value);
    changed();
  });

  $("[data-action=back]", root).addEventListener("click", () => select(null));
  $("[data-action=choose-cover]", root).addEventListener("click", () => refs["cover-input"].click());
  refs["cover-input"].addEventListener("change", async () => {
    const file = refs["cover-input"].files?.[0];
    refs["cover-input"].value = "";
    if (!file) return;
    try {
      book.draft.cover = await prepareCoverImage(file);
      changed();
    } catch (error) {
      showToast(error.message);
    }
  });
  $("[data-action=reset-cover]", root).addEventListener("click", () => {
    if (book.override?.cover) book.draft.cover = "remove";
    else delete book.draft.cover;
    changed();
  });
  $("[data-action=remove]", root).addEventListener("click", () => {
    if (book.isNew) {
      dropNewBook(book);
      return;
    }
    book.removed = true;
    changed();
  });
  $("[data-action=restore]", root).addEventListener("click", () => {
    book.removed = false;
    changed();
  });
  $("[data-action=revert]", root).addEventListener("click", () => {
    book.draft = {};
    book.removed = false;
    fillFields();
    changed();
    showToast(`Undid the changes to ${displayTitle(book)}.`);
  });

  fillFields();
  syncChoices();
  syncChrome();
  return root;
}

function dropNewBook(book) {
  state.books = state.books.filter((candidate) => candidate !== book);
  forgetFiles([book.fileKey]).catch(() => {});
  if (state.selected === book.key) state.selected = state.books.find((candidate) => candidate.isNew)?.key || null;
  renderAll();
  persistDraft();
  showToast(`Left out ${displayTitle(book)}.`);
}

// ── Library details ────────────────────────────────────────────────────────

function renderSettings() {
  const { root, refs } = template("settings-template");
  const inputs = Object.fromEntries([...refs.form.elements].filter((input) => input.name).map((input) => [input.name, input]));
  for (const [key, input] of Object.entries(inputs)) input.value = state.settingsDraft[key] ?? state.config[key] ?? "";
  refs.form.addEventListener("input", (event) => {
    const { name, value } = event.target;
    const saved = String(state.config[name] ?? "");
    if (value.trim() === saved.trim() || (name === "title" && !value.trim())) delete state.settingsDraft[name];
    else state.settingsDraft[name] = value.trim();
    event.target.closest(".field").classList.toggle("is-changed", Object.hasOwn(state.settingsDraft, name));
    renderChanges();
    persistDraft();
  });
  refs.form.addEventListener("submit", (event) => event.preventDefault());
  refs.repo.textContent = state.repository;
  refs.repo.href = `https://github.com/${state.repository}`;
  refs.branch.textContent = state.branch;
  refs.login.textContent = state.user?.login || "";
  $("[data-action=back]", root).addEventListener("click", () => select(null));
  return root;
}

// ── Adding files ───────────────────────────────────────────────────────────

async function addFiles(fileList) {
  const files = [...fileList];
  const accepted = files.filter((file) => /\.(?:epub|pdf)$/i.test(file.name));
  const skipped = files.length - accepted.length;
  if (skipped) showToast(`${skipped} ${skipped === 1 ? "file was" : "files were"} skipped — only EPUBs and PDFs go on the shelf.`);
  if (!accepted.length) return;
  const added = accepted.map((file) => {
    const book = {
      key: `new:${state.nextKey++}`,
      isNew: true,
      id: "",
      extension: file.name.split(".").pop().toLowerCase(),
      shelf: state.lastShelf,
      file,
      fileKey: newFileKey(),
      size: file.size,
      override: {},
      entry: { title: "", author: "" },
      draft: {},
      inspecting: true,
    };
    state.books.push(book);
    saveFile(book.fileKey, file).catch((error) => console.warn("[shelf admin] could not keep a copy of the file", error));
    return book;
  });
  state.selected = added[0].key;
  renderAll();
  for (const book of added) {
    try {
      const details = await inspectFile(book.file);
      book.detected = details;
      book.gitSha = details.gitSha;
      book.duplicateOf = pathForGitSha(details.gitSha);
      book.entry = { title: details.title, author: details.author, description: details.description, kind: details.kind, pages: details.pages };
      book.id = chooseId({ title: details.title, author: details.author, fileName: book.file.name }, takenIds(book));
    } catch (error) {
      book.error = error.message || "This file could not be read.";
      book.id = chooseId({ fileName: book.file.name }, takenIds(book));
    } finally {
      book.inspecting = false;
    }
    if (!state.books.includes(book)) continue; // left out while it was being read
    refreshListItem(book);
    if (state.selected === book.key) renderPane();
    renderChanges();
    persistDraft(); // after each file, so closing mid-batch keeps those already read
  }
}

// ── Publishing ─────────────────────────────────────────────────────────────

function openPublishDialog() {
  const lines = summarize(state.books, state.settingsDraft);
  if (!lines.length || state.publishing) return;
  const problems = allProblems();
  if (problems.length) {
    select(problems[0].book.key);
    showToast(problems[0].problem);
    return;
  }
  elements.publishTitle.textContent = "Publish to the shelf";
  elements.publishLines.replaceChildren(...lines.map((line) => {
    const item = element("li", "", line.text);
    item.dataset.kind = line.kind;
    return item;
  }));
  elements.publishLines.hidden = false;
  elements.commitMessage.value = commitMessage(lines);
  elements.messageField.hidden = false;
  elements.publishSteps.hidden = true;
  elements.publishSteps.replaceChildren();
  elements.publishError.hidden = true;
  elements.publishConfirm.hidden = false;
  elements.publishConfirm.disabled = false;
  elements.publishConfirm.textContent = "Publish";
  elements.publishCancel.textContent = "Not yet";
  elements.publishCancel.disabled = false;
  elements.publishDialog.showModal();
}

function makeSteps(definitions) {
  elements.publishSteps.replaceChildren();
  const steps = {};
  for (const [key, label] of definitions) {
    const item = element("li", "step");
    item.dataset.state = "pending";
    const mark = element("span", "step-mark");
    const text = element("span", "step-label", label);
    const detail = element("span", "step-detail");
    item.append(mark, text, detail);
    elements.publishSteps.append(item);
    steps[key] = {
      set(stateName, message = "") {
        item.dataset.state = stateName;
        mark.textContent = stateName === "done" ? "✓" : stateName === "failed" ? "!" : "";
        if (message !== null) detail.replaceChildren(message instanceof Node ? message : document.createTextNode(message));
      },
      progress(value) {
        let bar = item.querySelector("progress");
        if (!bar) {
          bar = element("progress");
          bar.max = 1;
          item.append(bar);
        }
        bar.value = value;
      },
      get state() {
        return item.dataset.state;
      },
    };
  }
  elements.publishSteps.hidden = false;
  return steps;
}

function link(text, href) {
  const anchor = element("a", "", text);
  anchor.href = href;
  anchor.target = "_blank";
  anchor.rel = "noopener";
  return anchor;
}

async function uploadPending(step) {
  const uploads = [];
  for (const book of state.books) {
    if (book.removed) continue;
    if (book.isNew && !book.blobSha) uploads.push({ book, blob: book.file, name: book.file.name, done: (sha) => { book.blobSha = sha; } });
    const cover = book.draft?.cover;
    if (cover && cover !== "remove" && !cover.blobSha) {
      uploads.push({ book, blob: cover.blob, name: `cover for ${displayTitle(book)}`, done: (sha) => { cover.blobSha = sha; } });
    }
  }
  if (!uploads.length) {
    step.set("done", "Nothing new to upload.");
    return;
  }
  const total = uploads.reduce((sum, upload) => sum + upload.blob.size, 0) || 1;
  let sent = 0;
  for (const [index, upload] of uploads.entries()) {
    step.set("active", `${upload.name} (${index + 1} of ${uploads.length}, ${formatBytes(upload.blob.size)})`);
    const sha = await state.gh.uploadBlob(upload.blob, (fraction) => step.progress((sent + upload.blob.size * fraction) / total));
    upload.done(sha);
    sent += upload.blob.size;
    persistDraft();
  }
  step.set("done", `${uploads.length} ${uploads.length === 1 ? "file" : "files"} uploaded.`);
}

async function commitChanges(step, message) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    step.set("active", attempt === 1 ? "Writing one commit to GitHub…" : "The shelf changed meanwhile — replaying on top of it…");
    const snapshot = await state.gh.snapshot(state.branch);
    const plan = planCommit({ books: state.books, settingsDraft: state.settingsDraft, snapshot });
    if (plan.problems.length) throw new Error(plan.problems.join(" "));
    if (!plan.entries.length) throw new Error("Nothing to publish — the shelf already looks like this.");
    try {
      const sha = await state.gh.commit({
        branch: state.branch,
        parentSha: snapshot.headSha,
        baseTreeSha: snapshot.treeSha,
        entries: plan.entries,
        message,
      });
      step.set("done", link(`Saved as ${sha.slice(0, 7)}`, `https://github.com/${state.repository}/commit/${sha}`));
      return sha;
    } catch (error) {
      if ((error.status === 409 || error.status === 422) && attempt < 3) continue;
      throw error;
    }
  }
  throw new Error("The shelf kept changing while publishing. Reload and try again.");
}

function settleLocalState() {
  for (const book of state.books.filter((candidate) => candidate.isNew && !candidate.removed)) {
    state.recent.set(book.id, {
      id: book.id,
      title: displayTitle(book),
      author: currentValue(book, "author"),
      pages: book.detected?.pages,
      minutes: book.detected?.minutes,
      listenable: book.detected?.listenable,
      listenNote: book.detected?.listenNote,
    });
  }
  state.books = state.books.filter((book) => !book.isNew).map((book) => ({ ...book, draft: {}, removed: false }));
  state.settingsDraft = {};
  state.selected = null;
  clearDraft();
}

async function followBuild(step, sha, publishedAt) {
  step.set("active", "Waiting for GitHub Actions to pick it up…");
  const deadline = Date.now() + 15 * 60 * 1000;
  let run = null;
  while (Date.now() < deadline) {
    try {
      run = await state.gh.workflowRun(sha);
    } catch (error) {
      if (error.status === 403 || error.status === 404) {
        step.set("done", "Build progress isn’t visible with this token (it needs Actions: Read). Watching the site instead.");
        return true;
      }
      throw error;
    }
    if (run?.status === "completed") break;
    if (run) {
      const jobs = await state.gh.runJobs(run.id).catch(() => []);
      const active = jobs.flatMap((job) => job.steps || []).find((jobStep) => jobStep.status === "in_progress");
      const detail = element("span");
      detail.append(`${active?.name || (run.status === "queued" ? "Queued" : "Building")} · `, link("watch on GitHub", run.html_url));
      step.set("active", detail);
    }
    await wait(4000);
  }
  if (!run || run.status !== "completed") {
    step.set("failed", "The build is taking unusually long. It may still finish — check GitHub Actions.");
    return false;
  }
  if (run.conclusion !== "success") {
    const detail = element("span");
    detail.append(`The build ${run.conclusion}. `, link("See what went wrong", run.html_url));
    step.set("failed", detail);
    return false;
  }
  step.set("done", `Built in ${Math.max(1, Math.round((new Date(run.updated_at) - new Date(run.run_started_at || publishedAt)) / 1000))} s.`);
  return true;
}

async function waitUntilLive(step, publishedAt) {
  step.set("active", "Waiting for the new catalogue to reach the site…");
  const deadline = Date.now() + 3 * 60 * 1000;
  while (Date.now() < deadline) {
    const catalog = await fetchCatalog().catch(() => null);
    if (catalog && new Date(catalog.generatedAt).getTime() >= publishedAt - 5000) {
      state.catalog = catalog;
      step.set("done", link("Live — view the shelf", "../"));
      return;
    }
    await wait(5000);
  }
  step.set("done", "Published. GitHub Pages can take a few more minutes to show it everywhere.");
}

async function publish() {
  if (state.publishing) return;
  const message = elements.commitMessage.value.trim() || commitMessage(summarize(state.books, state.settingsDraft));
  state.publishing = true;
  elements.publishTitle.textContent = "Publishing";
  elements.publishLines.hidden = true;
  elements.messageField.hidden = true;
  elements.publishError.hidden = true;
  elements.publishConfirm.hidden = true;
  elements.publishCancel.disabled = true;
  elements.publishCancel.textContent = "Close";
  renderChanges();
  const steps = makeSteps([
    ["upload", "Uploading files"],
    ["commit", "Saving to GitHub"],
    ["build", "Rebuilding the shelf"],
    ["live", "Going live"],
  ]);
  let current = steps.upload;
  const publishedAt = Date.now();
  // Until the commit lands, the page behind the dialog is locked: anything
  // edited meanwhile would be cleared with the published draft.
  state.locked = true;
  elements.consoleView.inert = true;
  let sha;
  try {
    await uploadPending(steps.upload);
    current = steps.commit;
    sha = await commitChanges(steps.commit, message);
    settleLocalState();
  } catch (error) {
    current.set("failed", null);
    elements.publishError.textContent = error.message || "Publishing failed.";
    elements.publishError.hidden = false;
    elements.publishConfirm.hidden = false;
    elements.publishConfirm.textContent = "Try again";
    elements.publishTitle.textContent = "Publishing stopped";
    return;
  } finally {
    state.locked = false;
    state.publishing = false;
    elements.consoleView.inert = false;
    elements.publishCancel.disabled = false;
    renderChanges();
  }

  // The change is saved. From here on only progress reporting can fail.
  loadLibrary().then(renderAll).catch(() => renderAll());
  renderAll();
  try {
    current = steps.build;
    const built = await followBuild(steps.build, sha, publishedAt);
    if (built) {
      current = steps.live;
      await waitUntilLive(steps.live, publishedAt);
      await loadLibrary().catch(() => {});
      renderAll();
    }
    elements.publishTitle.textContent = built ? "Published" : "Saved, but not live yet";
  } catch (error) {
    current.set("failed", `${error.message || "Lost track of the build."} Your change is saved on GitHub and will go live on its own.`);
    elements.publishTitle.textContent = "Saved — couldn’t follow the build";
  }
}

// ── Views and wiring ───────────────────────────────────────────────────────

function showConnect(message = "") {
  elements.boot.hidden = true;
  elements.consoleView.hidden = true;
  elements.connectView.hidden = false;
  elements.connectError.hidden = !message;
  elements.connectError.textContent = message;
  elements.token.focus();
}

function showConsole() {
  elements.boot.hidden = true;
  elements.connectView.hidden = true;
  elements.consoleView.hidden = false;
  elements.login.textContent = state.user.login;
  elements.avatar.src = state.user.avatar;
  renderAll();
}

async function connect(token, remember = null) {
  const gh = new GitHub({ token, repository: state.repository });
  const info = await gh.verify();
  if (!info.canWrite) {
    throw new Error(`This token can read ${state.repository} but not change it. Edit the token and give it “Contents: Read and write”.`);
  }
  state.gh = gh;
  state.user = info;
  state.branch = info.branch;
  if (remember !== null) storeToken(token, remember);
  await loadLibrary();
  await restoreDraft();
  showConsole();
}

elements.connectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const token = elements.token.value.trim();
  if (!token) {
    showConnect("Paste a GitHub token first.");
    return;
  }
  elements.connectButton.disabled = true;
  elements.connectButton.textContent = "Checking…";
  try {
    await connect(token, elements.remember.checked);
    elements.token.value = "";
  } catch (error) {
    showConnect(error.message);
  } finally {
    elements.connectButton.disabled = false;
    elements.connectButton.textContent = "Connect";
  }
});

elements.signOut.addEventListener("click", () => {
  if (changeCount() && !confirm("Sign out? Unpublished changes stay saved in this browser for next time.")) return;
  forgetToken();
  state.gh = null;
  state.books = [];
  state.selected = null;
  showConnect();
});

elements.reloadButton.addEventListener("click", async () => {
  try {
    await loadLibrary();
    renderAll();
    showToast("Up to date with GitHub.");
  } catch (error) {
    showToast(error.message);
  }
});

elements.addButton.addEventListener("click", () => elements.fileInput.click());
elements.fileInput.addEventListener("change", () => {
  addFiles(elements.fileInput.files || []);
  elements.fileInput.value = "";
});
elements.filter.addEventListener("input", () => {
  state.filter = elements.filter.value;
  renderList();
});
elements.settingsButton.addEventListener("click", () => select("settings"));
elements.publishButton.addEventListener("click", openPublishDialog);
elements.discardAll.addEventListener("click", () => {
  const count = changeCount();
  if (!count || !confirm(`Discard ${count} unpublished ${count === 1 ? "change" : "changes"}? New files you added will be left out.`)) return;
  state.books = state.books.filter((book) => !book.isNew).map((book) => ({ ...book, draft: {}, removed: false }));
  state.settingsDraft = {};
  state.selected = null;
  clearDraft();
  renderAll();
});
elements.publishForm.addEventListener("submit", (event) => {
  event.preventDefault();
  publish();
});
elements.publishCancel.addEventListener("click", () => elements.publishDialog.close());
elements.publishDialog.addEventListener("cancel", (event) => {
  if (state.locked) event.preventDefault();
});
// Browsers let a second Escape close the dialog anyway; reopen it while the
// commit is still being written.
elements.publishDialog.addEventListener("close", () => {
  if (state.locked) elements.publishDialog.showModal();
});

// Drop files anywhere once connected.
let dragDepth = 0;
const carriesFiles = (event) => [...(event.dataTransfer?.types || [])].includes("Files");
window.addEventListener("dragenter", (event) => {
  if (elements.consoleView.hidden || !carriesFiles(event)) return;
  dragDepth += 1;
  elements.dropOverlay.hidden = false;
});
window.addEventListener("dragover", (event) => {
  if (elements.consoleView.hidden || !carriesFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
});
window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) elements.dropOverlay.hidden = true;
});
window.addEventListener("drop", (event) => {
  if (elements.consoleView.hidden || !carriesFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  elements.dropOverlay.hidden = true;
  addFiles(event.dataTransfer.files);
});

document.addEventListener("keydown", (event) => {
  if (elements.consoleView.hidden) return;
  const typing = /^(?:INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    if (!elements.publishDialog.open) openPublishDialog();
  } else if (event.key === "/" && !typing && !elements.publishDialog.open) {
    event.preventDefault();
    elements.filter.focus();
  }
});

// Drafts (files included) are kept in IndexedDB, so only an upload in flight
// is worth a warning.
window.addEventListener("beforeunload", (event) => {
  if (state.publishing) {
    event.preventDefault();
    event.returnValue = "";
  }
});

async function boot() {
  state.catalog = await fetchCatalog().catch(() => null);
  const requested = new URLSearchParams(location.search).get("repo") || state.catalog?.repository || "";
  // owner/name only, so a crafted link cannot aim the token at other API paths.
  state.repository = /^[\w-]+\/[\w.-]+$/.test(requested) && !requested.includes("..") ? requested : "";
  elements.brandOwner.textContent = state.catalog?.owner || "Shelf";
  elements.repoName.textContent = state.repository || "this shelf’s repository";
  document.querySelectorAll(".repo-inline").forEach((node) => { node.textContent = state.repository.split("/")[1] || "the repository"; });
  elements.repoLink.href = state.repository ? `https://github.com/${state.repository}` : "https://github.com/";
  elements.tokenLink.href = tokenUrl(state.repository);
  if (!state.repository) {
    showConnect("This shelf’s catalog does not say which GitHub repository it comes from. Open the admin with ?repo=owner/name.");
    return;
  }
  const token = storedToken();
  if (!token) {
    showConnect();
    return;
  }
  try {
    await connect(token);
  } catch (error) {
    if (error.status === 401) forgetToken();
    showConnect(error.status === 401 ? "The saved token no longer works. Paste a new one." : error.message);
  }
}

boot();
