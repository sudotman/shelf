# shelf

Satyam’s personal library of EPUBs and PDFs, published at <https://satyam.lol/shelf/>:

- **the bookcase** — books stand as spines (coloured from their covers, sized by length) on shelves you name; an index view, search, and a page per book with Read / Download / Listen
- **the admin** — <https://satyam.lol/shelf/admin/> — add, edit, move, and remove books from any browser, phone included
- **`catalog.json`** — read by [Hear](https://hear.satyam.lol) for its “Satyam’s collection” section
- **`opds.xml`** — an OPDS feed for reading apps (KOReader, Thorium, Panels, Marvin, …)

Titles, authors, descriptions, series, lengths, and covers are read from the files themselves; PDF covers are rendered from the first page.

## The admin

Open <https://satyam.lol/shelf/admin/>. The first time, it asks for a GitHub token:

1. Follow the admin’s *Create a fine-grained token* link. It pre-fills the token’s name, expiry, and permissions (Contents — Read and write; Actions — Read, to follow builds).
2. GitHub does not let links choose repositories, so under **Repository access** pick **Only select repositories → shelf** yourself.
3. Generate the token and paste it in. Tick “Remember on this device” on your own devices; otherwise it is forgotten when the tab closes. It is only ever sent to api.github.com.

Then:

- **Add books** — drop EPUBs or PDFs anywhere on the page (or tap *Add books*). Each file is read in the browser with the same code the build uses: title, author, cover, length. Files already on the shelf are caught by their git hash, and scanned PDFs or files over Hear’s limits are flagged.
- **Edit** — title, author, shelf (type a new name to make a new shelf), year, status, rating, tags, a note, the description, a custom cover, whether Hear offers it, or hide it. Changing a field back undoes the change; emptying a title or author returns to what the file says.
- **Remove** — marks the book; nothing happens until you publish.
- **Publish** (or Ctrl/⌘ S) — everything goes to GitHub as one commit, with upload progress. The admin then follows the GitHub Actions build until the change is live, usually about a minute later.

Unpublished changes — dropped files included — are kept in the browser, so closing the tab loses nothing. If the shelf changes elsewhere while you edit, publishing replays your changes on top of the latest version, and refuses (asking you to reload) if a book you touched was moved or removed meanwhile.

Good to know: use one admin tab at a time (tabs share the saved draft). Safari clears a site’s stored data after about a week without a visit, which includes unpublished drafts and a remembered token — publish what you start. Very large files are read into memory a few times while uploading, so add 50 MB+ PDFs from a computer rather than an older phone.

## From this folder

```bash
npm install
npm run add -- ~/Downloads/walden.epub --shelf essays --tag nature --status reading
git add books shelf.yml && git commit -m "Add Walden" && git push
```

| Command | What it does |
| --- | --- |
| `npm run add -- <files…>` | Copy books in with clean names; options `--shelf`, `--tag`, `--status`, `--author`, `--title`, `--id` |
| `npm run list` | Every book with its id, shelf, length, and whether Hear can narrate it |
| `npm run build` | Write the site to `dist/` (metadata is cached in `.cache/` by file hash) |
| `npm run dev` | Build, then serve `dist/` at <http://localhost:4321> (admin at `/admin/`) |
| `npm test` | Unit tests |
| `npm run test:browser` | Admin console tests in Chromium and iPhone WebKit, against a fake GitHub |

GitHub’s own web interface works too: upload files into `books/<shelf>/` and edit `shelf.yml`.

## How it is organised

- `books/<shelf>/<id>.epub|pdf` — the files. A book’s **id** is its file name; Hear uses it in links and to remember listening progress, so the admin only lets you choose it when adding. The first folder is the **shelf**.
- `shelf.yml` — the library’s title, owner, and description, shelf names, and per-book overrides (`title`, `author`, `year`, `status`, `rating`, `tags`, `note`, `description`, `kind`, `cover`, `listen`, `hidden`, …). The comments at the top list every field. The admin edits this file without disturbing its comments.
- `covers/` — custom covers chosen in the admin.
- `site/` — the bookcase (`index.html`, `app.js`, `styles.css`), the admin (`admin/`), and `lib/`, the metadata and catalogue rules shared by the build (Node) and the admin (browser).
- `scripts/` — the build, `add`, and the local server.

## Hear

Every listenable book links to `https://hear.satyam.lol/?source=collection&book=<id>`. Hear reads `catalog.json` (GitHub Pages serves it with `Access-Control-Allow-Origin: *`), downloads the EPUB or PDF into the browser, and prepares it for narration on the device — the text is never sent to a speech service.

A book is not listenable when it is a scanned PDF without selectable text (run OCR first), a PDF over 500 pages or 50 MB, an EPUB over 100 MB, or set to `listen: false`. Those stay readable and downloadable here.

To try Hear against a local build, run `npm run dev` here and start Hear with `VITE_COLLECTION_URL=http://localhost:4321/catalog.json npm run dev`.

## Publishing

`.github/workflows/pages.yml` builds and deploys to GitHub Pages on every push to `main`. Because `satyam.lol` is the custom domain of `sudotman.github.io`, the site is served at `https://satyam.lol/shelf/`. If it moves, update `url` in `shelf.yml` and Hear’s `VITE_COLLECTION_URL`.

GitHub rejects files over 100 MB outside [Git LFS](https://git-lfs.com) (the admin refuses them; the workflow checks LFS files out), and a Pages site should stay under 1 GB.

**This site is public.** `robots.txt` and a `noindex` tag keep it out of search engines, but anyone with a link can download what is here. Only add books you have the right to share — public-domain and openly licensed works, or your own writing.

## Credits

The three starter books are public domain: *Meditations* and *The Art of War* are [Standard Ebooks](https://standardebooks.org) editions (CC0), and *Self-Reliance* was typeset from the [Project Gutenberg](https://www.gutenberg.org/ebooks/16643) text. Remove them whenever you like. The site uses Newsreader and DM Sans under the SIL Open Font License (`site/fonts/`), and bundles [pdf.js](https://mozilla.github.io/pdf.js/), [fflate](https://github.com/101arrowz/fflate), and [yaml](https://eemeli.org/yaml/) for the admin.
