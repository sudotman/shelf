const $ = (selector) => document.querySelector(selector);

const elements = {
  ownerName: $("#owner-name"),
  description: $("#shelf-description"),
  search: $("#search"),
  query: $("#query"),
  views: [...document.querySelectorAll("[data-view]")],
  tally: $("#tally"),
  bookcase: $("#bookcase"),
  indexView: $("#index-view"),
  indexRows: $("#index-rows"),
  sortButtons: [...document.querySelectorAll("[data-sort]")],
  noMatch: $("#no-match"),
  hearLink: $("#hear-link"),
  copyOpds: $("#copy-opds"),
  updatedLine: $("#updated-line"),
  slip: $("#slip"),
  slipClose: $("#slip-close"),
  slipCover: $("#slip-cover"),
  slipTitle: $("#slip-title"),
  slipAuthor: $("#slip-author"),
  slipListen: $("#slip-listen"),
  slipRead: $("#slip-read"),
  slipDownload: $("#slip-download"),
  slipUnlistenable: $("#slip-unlistenable"),
  slipLedger: $("#slip-ledger"),
  slipNote: $("#slip-note"),
  slipDescription: $("#slip-description"),
  toast: $("#toast"),
};

const STATUS = { want: "Want to read", reading: "Reading now", read: "Read" };
// Cloth colours for books without a cover to sample.
const CLOTH = ["#5b3a2e", "#2f4a46", "#3e4a63", "#6b5232", "#4f3a52", "#7a3324", "#33473a", "#2c3a4f"];
const state = { catalog: null, view: "shelves", query: "", sort: "author", returnFocus: null, toastTimer: 0 };

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function hash(value) {
  let result = 2166136261;
  for (const character of value) result = Math.imul(result ^ character.codePointAt(0), 16777619);
  return result >>> 0;
}

function normalize(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// Shelved by author surname, as on a real bookcase.
function authorKey(book) {
  if (book.authorSort) return book.authorSort.toLowerCase();
  const first = (book.authors?.[0] || book.author || "").trim();
  const parts = first.split(/\s+/);
  return `${parts.at(-1) || ""} ${parts.slice(0, -1).join(" ")}`.toLowerCase();
}

function titleKey(book) {
  return book.title.replace(/^(?:the|a|an)\s+/i, "").toLowerCase();
}

function surnameFirst(book) {
  if (book.authorSort) return book.authorSort;
  const name = book.authors?.[0] || book.author || "";
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? `${parts.at(-1)}, ${parts.slice(0, -1).join(" ")}` : name || "Anonymous";
}

function luminance(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  const channel = (shift) => {
    const c = ((value >> shift) & 255) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
}

function bookColors(book) {
  let spine = /^#[0-9a-f]{6}$/i.test(book.color) ? book.color : CLOTH[hash(book.id) % CLOTH.length];
  // A plain white page (most PDFs) becomes an off-white paperback.
  if (luminance(spine) > 0.82) spine = "#ece5d6";
  return { spine, ink: luminance(spine) > 0.42 ? "#1f1b16" : "#f4ede1" };
}

function formatMinutes(minutes) {
  if (!minutes) return "";
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return `${Math.floor(minutes / 60)} h${rest ? ` ${rest} min` : ""}`;
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function formatDate(value, options = { day: "numeric", month: "long", year: "numeric" }) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("en-GB", options);
}

function matches(book, tokens) {
  if (!tokens.length) return true;
  const haystack = normalize([
    book.title, book.subtitle, book.author, book.shelfLabel, book.series, book.note,
    ...(book.tags || []), ...(book.subjects || []),
  ].join(" "));
  return tokens.every((token) => haystack.includes(token));
}

function queryTokens() {
  return normalize(state.query).split(" ").filter(Boolean);
}

// ── Shelves ──────────────────────────────────────────────────────────────

function shelfHeight() {
  return Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--shelf-height")) || 236;
}

function spineFor(book) {
  const { spine, ink } = bookColors(book);
  const minutes = book.minutes || Math.round((book.pages || 30) * 1.4);
  const width = Math.round(Math.min(76, Math.max(34, 20 + Math.sqrt(minutes) * 2.4)));
  const seed = hash(`${book.id}:height`) / 2 ** 32;
  const height = book.kind === "article" ? 0.72 + seed * 0.1 : 0.82 + seed * 0.18;
  const titleSize = width < 40 || book.title.length > 30 ? 13 : 15;
  // The file's sort name knows "Sun Tzu" is not "Tzu"; otherwise the last word.
  const surname = book.authorSort?.split(",")[0].trim() || book.authors?.[0]?.split(/\s+/).at(-1) || "";
  // Room along the spine, minus the bands; vertical type runs ~0.55em a letter.
  const room = shelfHeight() * height - 44;
  const showAuthor = surname && book.title.length * titleSize * 0.55 + surname.length * 7.5 + 10 <= room;
  const slot = element("div", "slot");
  const button = element("button", "spine");
  button.type = "button";
  button.dataset.id = book.id;
  if (book.status) button.dataset.status = book.status;
  button.style.setProperty("--spine", spine);
  button.style.setProperty("--spine-ink", ink);
  button.style.setProperty("--width", `${width}px`);
  button.style.setProperty("--height", `calc(var(--shelf-height) * ${height.toFixed(3)})`);
  button.style.setProperty("--title-size", `${titleSize}px`);
  button.setAttribute("aria-label", [
    book.title,
    book.author ? `by ${book.author}` : "",
    book.format.toUpperCase(),
    book.minutes ? `${formatMinutes(book.minutes)} listen` : "",
    STATUS[book.status] || "",
  ].filter(Boolean).join(", "));
  button.title = book.author ? `${book.title} — ${book.author}` : book.title;
  if (book.status === "reading") button.append(element("span", "ribbon"));
  button.append(element("span", "spine-title", book.title));
  if (showAuthor) button.append(element("span", "spine-author", surname));
  button.addEventListener("click", () => openBook(book.id, button));
  slot.append(button);
  return slot;
}

// One continuous bookcase: shelves follow each other along the planks,
// separated by bookends, and wrap onto the next plank as the library grows.
function renderShelves() {
  const groups = new Map();
  for (const book of state.catalog.books) {
    const key = book.shelf || "";
    if (!groups.has(key)) groups.set(key, { label: book.shelfLabel || "Unshelved", books: [] });
    groups.get(key).books.push(book);
  }
  const ordered = [...groups.entries()].sort(([left, a], [right, b]) => (!left) - (!right) || a.label.localeCompare(b.label));
  const named = ordered.some(([key]) => key);
  const fragment = document.createDocumentFragment();
  for (const [, group] of ordered) {
    if (named) {
      const bookend = element("div", "slot slot-bookend");
      const label = element("h2", "bookend");
      label.append(element("span", "bookend-name", group.label), element("span", "bookend-count", String(group.books.length)));
      label.setAttribute("aria-label", `${group.label}, ${group.books.length} ${group.books.length === 1 ? "book" : "books"}`);
      bookend.append(label);
      fragment.append(bookend);
    }
    group.books
      .sort((left, right) => authorKey(left).localeCompare(authorKey(right)) || titleKey(left).localeCompare(titleKey(right)))
      .forEach((book) => fragment.append(spineFor(book)));
  }
  if (!state.catalog.books.length) {
    const slot = element("div", "slot slot-empty");
    slot.append(element("p", "empty-shelf", "Nothing on the shelves yet."));
    fragment.append(slot);
  }
  elements.bookcase.replaceChildren(fragment);
}

// ── Index ────────────────────────────────────────────────────────────────

const sorters = {
  author: (left, right) => authorKey(left).localeCompare(authorKey(right)) || titleKey(left).localeCompare(titleKey(right)),
  title: (left, right) => titleKey(left).localeCompare(titleKey(right)),
  shelf: (left, right) => (left.shelfLabel || "~").localeCompare(right.shelfLabel || "~") || sorters.author(left, right),
  length: (left, right) => (left.minutes || Infinity) - (right.minutes || Infinity),
  added: (left, right) => String(right.addedAt).localeCompare(String(left.addedAt)),
};

function renderIndex() {
  const tokens = queryTokens();
  const books = state.catalog.books.filter((book) => matches(book, tokens)).sort(sorters[state.sort]);
  elements.indexRows.replaceChildren(...books.map((book) => {
    const row = element("tr");
    row.dataset.id = book.id;
    const titleCell = element("td", "cell-title");
    const titleButton = element("button", "", book.title);
    titleButton.type = "button";
    titleButton.addEventListener("click", (event) => {
      event.stopPropagation();
      openBook(book.id, titleButton);
    });
    titleCell.append(titleButton, element("span", "format", book.format.toUpperCase()));
    row.append(
      element("td", "cell-author", surnameFirst(book)),
      titleCell,
      element("td", "cell-shelf cell-meta", book.shelfLabel || "—"),
      element("td", "cell-length cell-meta", formatMinutes(book.minutes) || (book.pages ? `${book.pages} pp` : "—")),
      element("td", "cell-added cell-meta", formatDate(book.addedAt, { day: "numeric", month: "short", year: "numeric" })),
    );
    row.addEventListener("click", () => openBook(book.id, titleButton));
    return row;
  }));
  elements.sortButtons.forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.sort === state.sort)));
}

// ── Search, tally, view ──────────────────────────────────────────────────

function applySearch() {
  const tokens = queryTokens();
  let count = 0;
  for (const spine of elements.bookcase.querySelectorAll(".spine")) {
    const book = state.catalog.books.find((candidate) => candidate.id === spine.dataset.id);
    const hit = matches(book, tokens);
    count += hit ? 1 : 0;
    spine.classList.toggle("is-dimmed", !hit);
    spine.tabIndex = hit ? 0 : -1;
    spine.setAttribute("aria-hidden", String(!hit));
  }
  if (state.view === "index") renderIndex();
  if (!state.catalog.books.length) count = 0;
  renderTally(tokens.length ? count : null);
  elements.noMatch.hidden = !tokens.length || count > 0;
  elements.noMatch.textContent = `Nothing on the shelves matches “${state.query.trim()}”.`;
}

function renderTally(matching = null) {
  const { catalog } = state;
  const total = catalog.books.length;
  const hours = Math.round(catalog.books.reduce((sum, book) => sum + (book.minutes || 0), 0) / 60);
  const latest = catalog.books.map((book) => book.addedAt).sort().at(-1);
  elements.tally.textContent = matching === null
    ? [
      `${total} ${total === 1 ? "volume" : "volumes"}`,
      hours ? `about ${hours} ${hours === 1 ? "hour" : "hours"} of listening` : "",
      latest ? `last shelved ${formatDate(latest)}` : "",
    ].filter(Boolean).join(" · ")
    : `${matching} of ${total} ${total === 1 ? "volume" : "volumes"} match “${state.query.trim()}”`;
}

function setView(view) {
  state.view = view === "index" ? "index" : "shelves";
  elements.views.forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.view === state.view)));
  elements.bookcase.hidden = state.view !== "shelves";
  elements.indexView.hidden = state.view !== "index";
  if (state.view === "index") renderIndex();
  try {
    localStorage.setItem("shelf:view", state.view);
  } catch {
    // Storage can be unavailable (private windows); the view still works.
  }
}

// ── Slip ─────────────────────────────────────────────────────────────────

function ledgerRow(label, value) {
  if (!value || (Array.isArray(value) && !value.length)) return [];
  const term = element("dt", "", label);
  const detail = element("dd");
  if (value instanceof Node) detail.append(value);
  else detail.textContent = value;
  return [term, detail];
}

function renderSlipCover(book) {
  const { spine, ink } = bookColors(book);
  elements.slipCover.replaceChildren();
  const typeset = element("div", "typeset-cover");
  typeset.style.setProperty("--spine", spine);
  typeset.style.setProperty("--spine-ink", ink);
  typeset.append(element("span", "", book.title), element("small", "", book.author || ""));
  if (!book.cover) {
    elements.slipCover.append(typeset);
    return;
  }
  const image = new Image();
  image.alt = `Cover of ${book.title}`;
  image.decoding = "async";
  if (book.coverWidth && book.coverHeight) {
    image.width = book.coverWidth;
    image.height = book.coverHeight;
  }
  image.addEventListener("error", () => image.replaceWith(typeset), { once: true });
  image.src = book.cover;
  elements.slipCover.append(image);
}

function openBook(id, trigger = null, { updateHash = true } = {}) {
  const book = state.catalog?.books.find((candidate) => candidate.id === id);
  if (!book) return;
  state.returnFocus = trigger || document.activeElement;
  renderSlipCover(book);
  elements.slipTitle.textContent = book.subtitle ? `${book.title}: ${book.subtitle}` : book.title;
  elements.slipAuthor.textContent = book.author || "Anonymous";

  elements.slipListen.hidden = !book.hear;
  if (book.hear) elements.slipListen.href = book.hear;
  elements.slipUnlistenable.hidden = book.listenable;
  elements.slipUnlistenable.textContent = book.listenable ? "" : `Not available in Hear: ${book.listenNote}`;
  elements.slipRead.href = book.file;
  elements.slipRead.hidden = book.format !== "pdf";
  elements.slipDownload.href = book.file;
  elements.slipDownload.download = book.fileName;
  elements.slipDownload.textContent = `Download ${book.format.toUpperCase()}`;

  const tags = document.createDocumentFragment();
  for (const tag of book.tags || []) {
    const button = element("button", "tag", tag);
    button.type = "button";
    button.addEventListener("click", () => {
      elements.slip.close();
      search(tag);
    });
    tags.append(button);
  }
  elements.slipLedger.replaceChildren(
    ...ledgerRow("Shelf", book.shelfLabel),
    ...ledgerRow("Status", STATUS[book.status]),
    ...ledgerRow("Length", [formatMinutes(book.minutes) && `${formatMinutes(book.minutes)} listen`, book.pages && `${book.pages} pages`].filter(Boolean).join(" · ")),
    ...ledgerRow("Edition", [book.format.toUpperCase(), formatBytes(book.size), book.year, book.publisher].filter(Boolean).join(" · ")),
    ...ledgerRow("Series", book.series ? `${book.series}${book.seriesIndex ? `, no. ${book.seriesIndex}` : ""}` : ""),
    ...ledgerRow("Rating", book.rating ? `${"★".repeat(book.rating)}${"☆".repeat(5 - book.rating)}` : ""),
    ...ledgerRow("Shelved", formatDate(book.addedAt)),
    ...ledgerRow("Tags", book.tags?.length ? tags : ""),
  );
  elements.slipNote.hidden = !book.note;
  elements.slipNote.textContent = book.note;
  elements.slipDescription.hidden = !book.description;
  elements.slipDescription.textContent = book.description;

  if (!elements.slip.open) elements.slip.showModal();
  elements.slip.scrollTop = 0;
  if (updateHash) history.replaceState(null, "", `#${encodeURIComponent(book.id)}`);
}

function search(query) {
  state.query = query;
  elements.query.value = query;
  applySearch();
  elements.query.scrollIntoView({ behavior: "smooth", block: "center" });
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 2600);
}

function openFromHash() {
  const id = decodeURIComponent(location.hash.slice(1));
  if (id) openBook(id, null, { updateHash: false });
  else if (elements.slip.open) elements.slip.close();
}

// ── Events ───────────────────────────────────────────────────────────────

elements.search.addEventListener("submit", (event) => event.preventDefault());
elements.query.addEventListener("input", () => {
  state.query = elements.query.value;
  applySearch();
});
elements.views.forEach((button) => button.addEventListener("click", () => {
  setView(button.dataset.view);
  applySearch();
}));
elements.sortButtons.forEach((button) => button.addEventListener("click", () => {
  state.sort = button.dataset.sort;
  renderIndex();
}));
elements.slipClose.addEventListener("click", () => elements.slip.close());
elements.slip.addEventListener("click", (event) => {
  if (event.target === elements.slip) elements.slip.close();
});
elements.slip.addEventListener("close", () => {
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  state.returnFocus?.focus?.({ preventScroll: true });
});
elements.copyOpds.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(elements.copyOpds.dataset.url);
    showToast("OPDS feed link copied — add it to your reading app");
  } catch {
    showToast(elements.copyOpds.dataset.url);
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "/" || elements.slip.open) return;
  if (/^(?:INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
  event.preventDefault();
  elements.query.focus();
});
window.addEventListener("hashchange", openFromHash);

async function start() {
  try {
    const response = await fetch("catalog.json", { cache: "no-cache" });
    if (!response.ok) throw new Error(`catalog.json returned ${response.status}`);
    state.catalog = await response.json();
  } catch (error) {
    elements.tally.textContent = `The catalogue could not be opened (${error.message}).`;
    return;
  }
  const { catalog } = state;
  document.title = catalog.title;
  elements.ownerName.textContent = catalog.owner || catalog.title;
  elements.description.textContent = catalog.description;
  elements.description.hidden = !catalog.description;
  if (catalog.hear) elements.hearLink.href = catalog.hear;
  elements.copyOpds.dataset.url = new URL("opds.xml", catalog.url || location.href).href;
  elements.updatedLine.textContent = `Catalogue rebuilt ${formatDate(catalog.generatedAt)}.`;

  renderShelves();
  let savedView = "shelves";
  try {
    savedView = localStorage.getItem("shelf:view") || "shelves";
  } catch {
    // Default to the shelves.
  }
  setView(savedView);
  applySearch();
  openFromHash();
}

start();
