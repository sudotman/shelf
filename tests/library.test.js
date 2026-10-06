import assert from "node:assert/strict";
import { test } from "node:test";
import { DOMParser } from "@xmldom/xmldom";
import { strToU8, zipSync } from "fflate";
import { buildCatalog, buildEntry, buildOpds, shelfLabel } from "../site/lib/catalog.js";
import { parseConfig } from "../site/lib/config.js";
import { readEpub } from "../site/lib/epub.js";
import { displayName, escapeXml, listeningMinutes, slugify, stripHtml } from "../site/lib/text.js";

const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));

function makeEpub({ epub3 = true } = {}) {
  const metadata = epub3
    ? `<dc:title id="t">Walden</dc:title>
       <dc:creator id="c1">Henry David Thoreau</dc:creator>
       <meta refines="#c1" property="file-as">Thoreau, Henry David</meta>
       <meta refines="#c1" property="role">aut</meta>
       <dc:creator id="c2">Some Editor</dc:creator>
       <meta refines="#c2" property="role">edt</meta>
       <meta property="belongs-to-collection" id="s">Essays</meta>
       <meta refines="#s" property="group-position">2</meta>`
    : `<dc:title>Walden</dc:title>
       <dc:creator opf:role="aut" opf:file-as="Thoreau, Henry David">Thoreau, Henry David</dc:creator>
       <meta name="cover" content="cover-img"/>
       <meta name="calibre:series" content="Essays"/>
       <meta name="calibre:series_index" content="2"/>`;
  const opf = `<?xml version="1.0"?>
    <package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf" version="${epub3 ? "3.0" : "2.0"}">
      <metadata>${metadata}
        <dc:language>en-US</dc:language>
        <dc:description>&lt;p&gt;Life in the &lt;i&gt;woods&lt;/i&gt;.&lt;/p&gt;</dc:description>
        <dc:identifier opf:scheme="ISBN">978-0-14-039044-5</dc:identifier>
      </metadata>
      <manifest>
        <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
        <item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
        <item id="cover-img" href="images/cover.png" media-type="image/png"${epub3 ? ' properties="cover-image"' : ""}/>
      </manifest>
      <spine><itemref idref="nav"/><itemref idref="ch1"/></spine>
    </package>`;
  return zipSync({
    mimetype: strToU8("application/epub+zip"),
    "META-INF/container.xml": strToU8('<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    "OEBPS/content.opf": strToU8(opf),
    "OEBPS/nav.xhtml": strToU8("<html><body><nav><a href='text/ch1.xhtml'>One two three</a></nav></body></html>"),
    "OEBPS/text/ch1.xhtml": strToU8("<html><head><style>p{}</style></head><body><h1>Economy</h1><p>When I wrote the following pages, I lived alone.</p></body></html>"),
    "OEBPS/images/cover.png": PNG,
  });
}

const settings = parseConfig("title: Test shelf\nhear: https://hear.example/\nurl: https://example.com/shelf");

function entryFor({ extension = "epub", meta = {}, override = {}, size = 1000 } = {}) {
  return buildEntry({
    file: { id: "walden", extension, shelf: "essays", size },
    meta: { title: "Walden", authors: ["Henry David Thoreau"], words: 3700, hasText: true, pages: null, ...meta },
    override,
    sha256: "abcdef0123456789",
    cover: { extension: "jpg", width: 480, height: 720 },
    addedAt: "2026-01-01T00:00:00.000Z",
    settings,
  });
}

test("text helpers", () => {
  assert.equal(slugify("Marcus Aurelius — Méditations (George Long tr.)"), "marcus-aurelius-meditations-george-long-tr");
  assert.equal(slugify("Rock & Roll's Story"), "rock-and-rolls-story");
  assert.equal(displayName("Thoreau, Henry David, 1817-1862"), "Henry David Thoreau");
  assert.equal(displayName("Sun Tzu"), "Sun Tzu");
  assert.equal(stripHtml("<p>One&nbsp;<b>two</b></p><script>x()</script>"), "One two");
  assert.equal(escapeXml(`a<b>&"c'\u0001`), "a&lt;b&gt;&amp;&quot;c&apos;");
  assert.equal(listeningMinutes(0), 0);
  assert.equal(listeningMinutes(370), 2);
});

for (const epub3 of [true, false]) {
  test(`reads EPUB ${epub3 ? "3" : "2"} metadata and cover`, () => {
    const book = readEpub(makeEpub({ epub3 }));
    assert.equal(book.title, "Walden");
    assert.deepEqual(book.authors, ["Henry David Thoreau"]);
    assert.equal(book.authorSort, "Thoreau, Henry David");
    assert.equal(book.language, "en");
    assert.equal(book.description, "Life in the woods.");
    assert.equal(book.isbn, "9780140390445");
    assert.equal(book.series, "Essays");
    assert.equal(book.seriesIndex, 2);
    assert.equal(book.words, 10); // the nav document is not counted
    assert.equal(book.cover?.mediaType, "image/png");
  });
}

test("rejects files that are not EPUBs", () => {
  assert.throws(() => readEpub(strToU8("not a zip")), /Not a readable EPUB/);
});

test("config overrides are normalized and typos become warnings", () => {
  const warnings = [];
  const config = parseConfig(`
title: Mine
shelves: { sci-fi: Science fiction }
books:
  walden:
    author: [Henry David Thoreau]
    tags: Nature, Essays
    status: Reading
    rating: 7
    colour: green
    added: 2025-02-03
`, (message) => warnings.push(message));
  assert.equal(config.title, "Mine");
  assert.equal(config.hear, "https://hear.satyam.lol/");
  assert.equal(config.shelves["sci-fi"], "Science fiction");
  assert.deepEqual(config.books.walden.tags, ["nature", "essays"]);
  assert.equal(config.books.walden.status, "reading");
  assert.equal(config.books.walden.rating, undefined);
  assert.equal(config.books.walden.addedAt, "2025-02-03T00:00:00.000Z");
  assert.equal(warnings.length, 2);
  assert.match(warnings.join("\n"), /rating/);
  assert.match(warnings.join("\n"), /colour/);
});

test("catalog entries merge overrides and link to Hear", () => {
  const entry = entryFor({ override: { title: "Walden; or, Life in the Woods", tags: ["nature"], status: "read" } });
  assert.equal(entry.title, "Walden; or, Life in the Woods");
  assert.equal(entry.kind, "book");
  assert.equal(entry.file, "files/walden.epub");
  assert.equal(entry.cover, "covers/walden.abcdef01.jpg");
  assert.equal(entry.fileName, "Walden; or, Life in the Woods - Henry David Thoreau.epub");
  assert.equal(entry.minutes, 20);
  assert.equal(entry.listenable, true);
  assert.equal(entry.hear, "https://hear.example/?source=collection&book=walden");
  assert.equal(shelfLabel("science-fiction"), "Science Fiction");
});

test("listenability follows Hear's limits", () => {
  assert.equal(entryFor({ extension: "pdf", meta: { pages: 12 } }).kind, "article");
  assert.equal(entryFor({ extension: "pdf", meta: { pages: 200 } }).kind, "book");
  const scanned = entryFor({ extension: "pdf", meta: { pages: 30, hasText: false } });
  assert.equal(scanned.listenable, false);
  assert.equal(scanned.hear, "");
  assert.match(scanned.listenNote, /OCR/);
  assert.equal(entryFor({ extension: "pdf", meta: { pages: 900 } }).listenable, false);
  assert.equal(entryFor({ extension: "pdf", meta: { pages: 10 }, size: 60 * 1024 * 1024 }).listenable, false);
  assert.equal(entryFor({ override: { listen: false } }).listenable, false);
});

test("OPDS feed is well-formed with absolute links", () => {
  const catalog = buildCatalog([entryFor({ override: { description: "Ponds & <woods>" } })], settings, { generatedAt: "2026-10-05T00:00:00.000Z" });
  assert.deepEqual(catalog.shelves, [{ id: "essays", label: "Essays", count: 1 }]);
  const xml = buildOpds(catalog);
  let fatal = null;
  const document = new DOMParser({ onError: (level, message) => { if (level === "fatalError") fatal = message; } })
    .parseFromString(xml, "application/xml");
  assert.equal(fatal, null);
  const links = Array.from(document.getElementsByTagName("link")).map((link) => link.getAttribute("href"));
  assert.ok(links.includes("https://example.com/shelf/files/walden.epub"));
  assert.ok(links.includes("https://example.com/shelf/covers/walden.abcdef01.jpg"));
  assert.equal(document.getElementsByTagName("summary")[0].textContent, "Ponds & <woods>");
});
