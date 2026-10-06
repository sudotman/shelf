const $ = (selector) => document.querySelector(selector);

const elements = {
  ownerLine: $("#owner-line"),
  title: $("#shelf-title"),
  description: $("#shelf-description"),
  stats: $("#shelf-stats"),
  search: $("#search"),
  query: $("#query"),
  shelfFilter: $("#shelf-filter"),
  formatFilter: $("#format-filter"),
  sort: $("#sort"),
  status: $("#status"),
  grid: $("#grid"),
  hearLink: $("#hear-link"),
  copyOpds: $("#copy-opds"),
  updatedLine: $("#updated-line"),
  sheet: $("#book-sheet"),
  closeSheet: $("#close-sheet"),
  bookCover: $("#book-cover"),
  bookEyebrow: $("#book-eyebrow"),
  bookTitle: $("#book-title"),
  bookAuthor: $("#book-author"),
  bookFacts: $("#book-facts"),
  bookListen: $("#book-listen"),
  bookRead: $("#book-read"),
  bookDownload: $("#book-download"),
  bookListenNote: $("#book-listen-note"),
  bookNote: $("#book-note"),
  bookDescription: $("#book-description"),
  bookTags: $("#book-tags"),
  toast: $("#toast"),
};

const STATUS_LABELS = { want: "Want to read", reading: "Reading", read: "Read" };
const COVER_COLORS = ["#4c5663", "#6f4136", "#344e49", "#6a5940", "#4d3d55", "#5b4b43", "#38505a"];
const state = { catalog: null, query: "", shelf: "", format: "", sort: "added", returnFocus: null, toastTimer: 0 };

function normalize(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function formatMinutes(minutes) {
  if (!minutes) return "";
  if (minutes < 60) return `${minutes} min listen`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours} hr${rest >= 5 ? ` ${rest} min` : ""} listen`;
}

function coverColor(book) {
  const seed = [...`${book.title}${book.author}`].reduce((sum, character) => sum + character.codePointAt(0), 0);
  return COVER_COLORS[seed % COVER_COLORS.length];
}

function renderCover(book, container, { eager = false } = {}) {
  container.replaceChildren();
  container.style.setProperty("--cover-color", coverColor(book));
  container.classList.remove("has-image");
  const fallback = element("span", "cover-fallback");
  fallback.append(element("span", "cover-title", book.title), element("span", "cover-author", book.author));
  container.append(fallback);
  if (!book.cover) return;
  const image = new Image();
  image.alt = "";
  image.decoding = "async";
  image.loading = eager ? "eager" : "lazy";
  if (book.coverWidth && book.coverHeight) {
    image.width = book.coverWidth;
    image.height = book.coverHeight;
  }
  image.addEventListener("load", () => container.classList.add("has-image"), { once: true });
  image.addEventListener("error", () => image.remove(), { once: true });
  image.src = book.cover;
  container.prepend(image);
}

function matchScore(book, tokens) {
  const title = normalize(`${book.title} ${book.subtitle}`);
  const author = normalize(book.author);
  const facets = normalize([book.shelfLabel, book.series, ...book.tags, ...book.subjects].join(" "));
  const description = normalize(`${book.description} ${book.note}`);
  let score = 0;
  for (const token of tokens) {
    let best = 0;
    if (title.split(" ").includes(token)) best = 30;
    else if (title.includes(token)) best = 20;
    if (author.split(" ").includes(token)) best = Math.max(best, 24);
    else if (author.includes(token)) best = Math.max(best, 14);
    if (facets.includes(token)) best = Math.max(best, 12);
    if (description.includes(token)) best = Math.max(best, 4);
    if (!best) return 0;
    score += best;
  }
  return score;
}

const sorters = {
  added: (left, right) => String(right.addedAt).localeCompare(String(left.addedAt)) || left.title.localeCompare(right.title),
  title: (left, right) => left.title.replace(/^(?:the|a|an)\s+/i, "").localeCompare(right.title.replace(/^(?:the|a|an)\s+/i, "")),
  author: (left, right) => (left.authorSort || left.author).localeCompare(right.authorSort || right.author) || left.title.localeCompare(right.title),
  length: (left, right) => (left.minutes || Infinity) - (right.minutes || Infinity) || left.title.localeCompare(right.title),
};

function visibleBooks() {
  const tokens = normalize(state.query).split(" ").filter(Boolean);
  let books = state.catalog.books.filter((book) => (
    (!state.shelf || book.shelf === state.shelf) && (!state.format || book.format === state.format)
  ));
  if (tokens.length) {
    books = books
      .map((book) => ({ book, score: matchScore(book, tokens) }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score || sorters[state.sort](left.book, right.book))
      .map(({ book }) => book);
  } else {
    books = [...books].sort(sorters[state.sort]);
  }
  return books;
}

function renderGrid() {
  const books = visibleBooks();
  const fragment = document.createDocumentFragment();
  for (const book of books) {
    const item = element("li", "book");
    const button = element("button", "book-button");
    button.type = "button";
    button.dataset.id = book.id;
    button.setAttribute("aria-label", `${book.title}${book.author ? ` by ${book.author}` : ""}, ${book.format.toUpperCase()}`);
    const cover = element("span", "cover");
    renderCover(book, cover);
    const badges = element("span", "badges");
    badges.append(element("span", "badge", book.format.toUpperCase()));
    if (book.status) badges.append(element("span", `badge badge-${book.status}`, STATUS_LABELS[book.status]));
    cover.append(badges);
    button.append(cover, element("span", "book-title", book.title), element("span", "book-author", book.author || "Unknown author"));
    button.addEventListener("click", () => openBook(book.id, button));
    item.append(button);
    fragment.append(item);
  }
  elements.grid.replaceChildren(fragment);

  const total = state.catalog.books.length;
  const filtered = Boolean(state.query || state.shelf || state.format);
  if (!books.length) {
    elements.status.textContent = state.query ? `Nothing on the shelf matches “${state.query}”.` : "No books here yet.";
  } else {
    elements.status.textContent = filtered ? `${books.length} of ${total} ${total === 1 ? "book" : "books"}` : "";
  }
}

function renderShelfFilter() {
  const shelves = state.catalog.shelves || [];
  elements.shelfFilter.hidden = shelves.length < 2;
  const options = [{ id: "", label: "All shelves", count: state.catalog.books.length }, ...shelves];
  elements.shelfFilter.replaceChildren(...options.map((shelf) => {
    const button = element("button");
    button.type = "button";
    button.dataset.shelf = shelf.id;
    button.setAttribute("aria-pressed", String(shelf.id === state.shelf));
    button.append(shelf.label, element("span", "chip-count", String(shelf.count)));
    return button;
  }));
}

function setPressed(container, attribute, value) {
  container.querySelectorAll(`[data-${attribute}]`).forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset[attribute] === value));
  });
}

function renderHeader() {
  const { catalog } = state;
  const minutes = catalog.books.reduce((sum, book) => sum + (book.minutes || 0), 0);
  const hours = Math.round(minutes / 60);
  document.title = catalog.title;
  elements.title.textContent = catalog.title;
  elements.description.textContent = catalog.description;
  elements.description.hidden = !catalog.description;
  elements.ownerLine.textContent = catalog.owner ? `Kept by ${catalog.owner}` : "A personal library";
  elements.stats.textContent = [
    `${catalog.count} ${catalog.count === 1 ? "book" : "books"}`,
    hours ? `about ${hours} ${hours === 1 ? "hour" : "hours"} of listening` : "",
  ].filter(Boolean).join(" · ");
  if (catalog.hear) elements.hearLink.href = catalog.hear;
  const feed = new URL("opds.xml", catalog.url || location.href).href;
  elements.copyOpds.dataset.url = feed;
  const updated = new Date(catalog.generatedAt);
  elements.updatedLine.textContent = Number.isNaN(updated.getTime())
    ? ""
    : `Updated ${updated.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}.`;
}

function openBook(id, trigger = null, { updateHash = true } = {}) {
  const book = state.catalog?.books.find((candidate) => candidate.id === id);
  if (!book) return;
  state.returnFocus = trigger || document.activeElement;
  renderCover(book, elements.bookCover, { eager: true });
  elements.bookEyebrow.textContent = [book.shelfLabel, book.format.toUpperCase(), STATUS_LABELS[book.status]].filter(Boolean).join(" · ");
  elements.bookTitle.textContent = book.subtitle ? `${book.title}: ${book.subtitle}` : book.title;
  elements.bookAuthor.textContent = book.author || "Unknown author";
  elements.bookFacts.textContent = [
    book.year,
    book.series ? `${book.series}${book.seriesIndex ? ` #${book.seriesIndex}` : ""}` : "",
    book.pages ? `${book.pages} pages` : "",
    formatMinutes(book.minutes),
    formatBytes(book.size),
    book.rating ? `${"★".repeat(book.rating)}${"☆".repeat(5 - book.rating)}` : "",
  ].filter(Boolean).join(" · ");

  elements.bookListen.hidden = !book.hear;
  if (book.hear) elements.bookListen.href = book.hear;
  elements.bookListenNote.hidden = book.listenable;
  elements.bookListenNote.textContent = book.listenable ? "" : `Not available in Hear: ${book.listenNote}`;
  elements.bookRead.href = book.file;
  elements.bookRead.hidden = book.format !== "pdf";
  elements.bookDownload.href = book.file;
  elements.bookDownload.download = book.fileName;
  elements.bookDownload.textContent = `Download ${book.format.toUpperCase()}`;

  elements.bookNote.hidden = !book.note;
  elements.bookNote.textContent = book.note;
  elements.bookDescription.textContent = book.description;
  elements.bookDescription.hidden = !book.description;
  elements.bookTags.replaceChildren(...book.tags.map((tag) => {
    const item = element("li");
    const button = element("button", "", `#${tag}`);
    button.type = "button";
    button.addEventListener("click", () => {
      elements.sheet.close();
      search(tag);
    });
    item.append(button);
    return item;
  }));
  elements.bookTags.hidden = !book.tags.length;

  if (!elements.sheet.open) elements.sheet.showModal();
  elements.sheet.scrollTop = 0;
  if (updateHash) history.replaceState(null, "", `#${encodeURIComponent(book.id)}`);
}

function search(query) {
  state.query = query;
  elements.query.value = query;
  renderGrid();
  elements.grid.scrollIntoView({ behavior: "smooth", block: "start" });
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
  else if (elements.sheet.open) elements.sheet.close();
}

elements.search.addEventListener("submit", (event) => event.preventDefault());
elements.query.addEventListener("input", () => {
  state.query = elements.query.value;
  renderGrid();
});
elements.shelfFilter.addEventListener("click", (event) => {
  const button = event.target.closest("[data-shelf]");
  if (!button) return;
  state.shelf = button.dataset.shelf;
  setPressed(elements.shelfFilter, "shelf", state.shelf);
  renderGrid();
});
elements.formatFilter.addEventListener("click", (event) => {
  const button = event.target.closest("[data-format]");
  if (!button) return;
  state.format = button.dataset.format;
  setPressed(elements.formatFilter, "format", state.format);
  renderGrid();
});
elements.sort.addEventListener("change", () => {
  state.sort = elements.sort.value;
  renderGrid();
});
elements.closeSheet.addEventListener("click", () => elements.sheet.close());
elements.sheet.addEventListener("click", (event) => {
  if (event.target === elements.sheet) elements.sheet.close();
});
elements.sheet.addEventListener("close", () => {
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  state.returnFocus?.focus?.({ preventScroll: true });
});
elements.copyOpds.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(elements.copyOpds.dataset.url);
    showToast("OPDS feed link copied");
  } catch {
    showToast(elements.copyOpds.dataset.url);
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "/" || elements.sheet.open) return;
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
    elements.stats.textContent = "The catalog could not be loaded.";
    elements.status.textContent = error.message;
    return;
  }
  renderHeader();
  renderShelfFilter();
  renderGrid();
  openFromHash();
}

start();
