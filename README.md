# shelf

Satyam’s personal library of EPUBs and PDFs. Drop a book into `books/`, push, and GitHub Actions publishes:

- **the library site** — <https://satyam.lol/shelf/> — search, shelves, and a page per book with Read / Download / Listen
- **`catalog.json`** — the machine-readable catalog that [Hear](https://hear.satyam.lol) shows as “Satyam’s collection”
- **`opds.xml`** — an OPDS feed, so the library can be added to reading apps (KOReader, Thorium, Panels, Marvin, …)

Titles, authors, descriptions, series, word counts, and covers are read from the files themselves. PDF covers are rendered from the first page.

## Adding books

**From GitHub (works on a phone):** open `books/` on github.com → *Add file* → *Upload files*. Put the file in a folder to place it on a shelf (`books/philosophy/…`). Commit, and the site updates in about a minute.

**From this folder:**

```bash
npm install
npm run add -- ~/Downloads/walden.epub --shelf essays --tag nature --status reading
```

`add` names the file after the book’s title (`books/essays/walden.epub`), skips files that are already on the shelf, and writes any `--tag`, `--status`, `--author`, or `--title` you pass into `shelf.yml`. Then commit and push.

A book’s **id** is its file name without the extension. Hear uses it in links and to remember listening progress, so rename files sparingly. The **shelf** is the first folder under `books/`; moving a file between shelves keeps its id.

## Editing details

`shelf.yml` holds the library’s title and per-book overrides — fix a title, add an author a PDF forgot, tag things, mark what you are reading, leave a note:

```yaml
books:
  walden:
    author: Henry David Thoreau
    year: 1854
    tags: [nature, essays]
    status: reading      # want | reading | read
    rating: 5
    note: Read “Where I Lived, and What I Lived For” first.
```

The comments at the top of `shelf.yml` list every field, including `kind` (book or article in Hear), `cover`, `listen: false`, and `hidden: true`.

## Commands

| Command | What it does |
| --- | --- |
| `npm run add -- <files…>` | Copy books in with clean names; options `--shelf`, `--tag`, `--status`, `--author`, `--title`, `--id` |
| `npm run list` | Print every book with its id, shelf, length, and whether Hear can narrate it |
| `npm run build` | Write the site to `dist/` (metadata is cached in `.cache/` by file hash) |
| `npm run dev` | Build, then serve `dist/` at <http://localhost:4321> |
| `npm test` | Run the tests |

## Hear

Every listenable book links to `https://hear.satyam.lol/?source=collection&book=<id>`. Hear reads `catalog.json` (which GitHub Pages serves with `Access-Control-Allow-Origin: *`), downloads the EPUB or PDF into the browser, and prepares it for narration on the device — the text is never sent to a speech service.

A book is marked not listenable when it is a scanned PDF without selectable text (run OCR first), a PDF over 500 pages or 50 MB, an EPUB over 100 MB, or has `listen: false`. Those stay readable and downloadable here.

To try Hear against a local build, run `npm run dev` here and start Hear with `VITE_COLLECTION_URL=http://localhost:4321/catalog.json npm run dev`.

## Publishing

`.github/workflows/pages.yml` builds and deploys to GitHub Pages on every push to `main` (repository *Settings → Pages → Source: GitHub Actions*). Because `satyam.lol` is the custom domain of `sudotman.github.io`, the site is served at `https://satyam.lol/shelf/`. If you move it, update `url` in `shelf.yml` and Hear’s `VITE_COLLECTION_URL`.

Limits to keep in mind: GitHub rejects files over 100 MB (use [Git LFS](https://git-lfs.com) for those — the workflow checks LFS files out), and a Pages site should stay under 1 GB.

**This site is public.** `robots.txt` and a `noindex` tag keep it out of search engines, but anyone with a link can download what is here. Only add books you have the right to share — public-domain and openly licensed works, or your own writing. DRM-protected purchases cannot be read here anyway.

## Credits

The three starter books are public domain: *Meditations* and *The Art of War* are [Standard Ebooks](https://standardebooks.org) editions (CC0), and *Self-Reliance* was typeset from the [Project Gutenberg](https://www.gutenberg.org/ebooks/16643) text. Remove them whenever you like. The site uses Newsreader and DM Sans under the SIL Open Font License (`site/fonts/`).
