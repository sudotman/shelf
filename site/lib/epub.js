import { DOMParser } from "@xmldom/xmldom";
import { unzipSync } from "fflate";
import { cleanText, countWords, displayName, stripHtml } from "./text.js";

const MAX_EXPANDED_BYTES = 400 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const SKIPPED_MEDIA = /\.(?:mp3|m4a|m4b|aac|ogg|oga|opus|wav|mp4|m4v|webm|mov|ttf|otf|woff2?)$/i;
const decoder = new TextDecoder();

function parseXml(text) {
  let fatal = null;
  const document = new DOMParser({
    onError(level, message) {
      if (level === "fatalError") fatal = message;
    },
  }).parseFromString(text, "application/xml");
  if (fatal || !document?.documentElement) throw new Error(`Malformed XML: ${fatal || "no document element"}`);
  return document;
}

const byName = (root, name) => (root ? Array.from(root.getElementsByTagNameNS("*", name)) : []);
const first = (root, name) => byName(root, name)[0] || null;
const elementChildren = (root, name) => Array.from(root?.childNodes || [])
  .filter((node) => node.nodeType === 1 && (!name || node.localName === name));
const text = (node) => cleanText(node?.textContent || "");

function normalizePath(path) {
  const parts = [];
  for (const part of String(path || "").replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function resolvePath(fromFile, href) {
  let target = String(href || "").split("#")[0];
  try {
    target = decodeURIComponent(target);
  } catch {
    // Keep undecodable hrefs as written.
  }
  const base = String(fromFile || "").split("/").slice(0, -1).join("/");
  return normalizePath(base ? `${base}/${target}` : target);
}

function unzipEpub(buffer) {
  let entries = 0;
  let expanded = 0;
  const files = unzipSync(new Uint8Array(buffer), {
    filter(file) {
      entries += 1;
      if (entries > MAX_ENTRIES) throw new Error("The EPUB contains too many files to read safely.");
      if (SKIPPED_MEDIA.test(file.name)) return false;
      expanded += file.originalSize || 0;
      if (expanded > MAX_EXPANDED_BYTES) throw new Error("The EPUB expands beyond the 400 MB safety limit.");
      return true;
    },
  });
  // Zip paths are case-sensitive but some EPUBs reference files with the wrong
  // case. Keep a lower-case index as a fallback.
  const lowerCase = new Map(Object.keys(files).map((name) => [name.toLowerCase(), name]));
  return {
    get(path) {
      const normalized = normalizePath(path);
      return files[normalized] || files[lowerCase.get(normalized.toLowerCase())] || null;
    },
    text(path) {
      const bytes = this.get(path);
      return bytes ? decoder.decode(bytes) : "";
    },
  };
}

// EPUB 3 attaches roles and sort names with <meta refines="#id">.
function refinements(metadata) {
  const result = new Map();
  for (const meta of byName(metadata, "meta")) {
    const target = meta.getAttribute("refines");
    const property = meta.getAttribute("property");
    if (!target?.startsWith("#") || !property) continue;
    const id = target.slice(1);
    if (!result.has(id)) result.set(id, {});
    result.get(id)[property] = text(meta);
  }
  return result;
}

function attributeLocal(node, localName) {
  for (const attribute of Array.from(node.attributes || [])) {
    if (attribute.localName === localName || attribute.name === localName) return attribute.value;
  }
  return "";
}

function readCreators(metadata, refined) {
  const creators = byName(metadata, "creator").map((node) => {
    const extra = refined.get(node.getAttribute("id")) || {};
    return {
      name: displayName(text(node)),
      sortAs: cleanText(attributeLocal(node, "file-as") || extra["file-as"] || ""),
      role: cleanText(attributeLocal(node, "role") || extra.role || "").toLowerCase(),
    };
  }).filter((creator) => creator.name);
  const authors = creators.filter((creator) => !creator.role || creator.role === "aut");
  return authors.length ? authors : creators;
}

function readTitle(metadata, refined) {
  const titles = byName(metadata, "title");
  const main = titles.find((node) => refined.get(node.getAttribute("id"))?.["title-type"] === "main");
  return text(main || titles[0]);
}

function readSeries(metadata, refined) {
  const metas = byName(metadata, "meta");
  const calibre = metas.find((meta) => meta.getAttribute("name") === "calibre:series");
  if (calibre) {
    const index = metas.find((meta) => meta.getAttribute("name") === "calibre:series_index");
    return { series: cleanText(calibre.getAttribute("content")), seriesIndex: Number(index?.getAttribute("content")) || null };
  }
  const collection = metas.find((meta) => meta.getAttribute("property") === "belongs-to-collection");
  if (collection) {
    const extra = refined.get(collection.getAttribute("id")) || {};
    if (!extra["collection-type"] || extra["collection-type"] === "series") {
      return { series: text(collection), seriesIndex: Number(extra["group-position"]) || null };
    }
  }
  return { series: "", seriesIndex: null };
}

function readIsbn(metadata) {
  for (const node of byName(metadata, "identifier")) {
    const value = text(node);
    const scheme = attributeLocal(node, "scheme").toLowerCase();
    if (scheme !== "isbn" && !/isbn/i.test(value)) continue;
    const digits = value.replace(/[^0-9X]/gi, "");
    if (digits.length === 13 || digits.length === 10) return digits.toUpperCase();
  }
  return "";
}

function readPublished(metadata) {
  const dates = byName(metadata, "date");
  const publication = dates.find((node) => /publication/i.test(attributeLocal(node, "event"))) || dates[0];
  return text(publication);
}

function firstImageHref(xhtml) {
  const match = xhtml.match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i)
    || xhtml.match(/<image\b[^>]*\b(?:xlink:)?href\s*=\s*["']([^"']+)["']/i);
  return match?.[1] || "";
}

function findCover(zip, packagePath, metadata, manifest, packageDocument, spine) {
  const items = [...manifest.values()];
  const isImage = (item) => item?.mediaType.startsWith("image/");
  const fromItem = (item) => {
    const bytes = isImage(item) ? zip.get(item.path) : null;
    return bytes ? { bytes, mediaType: item.mediaType } : null;
  };

  const epub3 = items.find((item) => item.properties.split(/\s+/).includes("cover-image"));
  if (fromItem(epub3)) return fromItem(epub3);

  const coverMeta = byName(metadata, "meta").find((meta) => meta.getAttribute("name") === "cover");
  const coverRef = coverMeta?.getAttribute("content");
  const epub2 = coverRef && (manifest.get(coverRef) || items.find((item) => item.href === coverRef));
  if (fromItem(epub2)) return fromItem(epub2);

  // A cover page referenced from the guide, or the first page in reading order.
  const guideCover = byName(packageDocument, "reference").find((node) => node.getAttribute("type") === "cover");
  const pages = [
    guideCover && resolvePath(packagePath, guideCover.getAttribute("href")),
    spine[0]?.path,
  ].filter(Boolean);
  for (const page of pages) {
    const href = firstImageHref(zip.text(page));
    if (!href) continue;
    const path = resolvePath(page, href);
    const item = items.find((candidate) => candidate.path === path) || { path, mediaType: /\.png$/i.test(path) ? "image/png" : "image/jpeg" };
    const cover = fromItem(item);
    if (cover) return cover;
  }

  const named = items.find((item) => isImage(item) && /cover/i.test(`${item.id} ${item.href}`));
  return fromItem(named);
}

export function readEpub(buffer) {
  let zip;
  try {
    zip = unzipEpub(buffer);
  } catch (error) {
    throw new Error(error.message?.startsWith("The EPUB") ? error.message : "Not a readable EPUB (zip) file.");
  }
  const container = zip.text("META-INF/container.xml");
  if (!container) throw new Error("The EPUB is missing META-INF/container.xml.");
  const packagePath = normalizePath(first(parseXml(container), "rootfile")?.getAttribute("full-path"));
  if (!packagePath) throw new Error("The EPUB does not point to its package document.");
  const packageDocument = parseXml(zip.text(packagePath));
  const metadata = first(packageDocument, "metadata");
  const manifestNode = first(packageDocument, "manifest");
  const spineNode = first(packageDocument, "spine");
  if (!metadata || !manifestNode || !spineNode) throw new Error("The EPUB package has no metadata, manifest, or spine.");

  const manifest = new Map();
  for (const node of elementChildren(manifestNode, "item")) {
    const id = node.getAttribute("id");
    if (!id) continue;
    const href = node.getAttribute("href") || "";
    manifest.set(id, {
      id,
      href,
      path: resolvePath(packagePath, href),
      mediaType: (node.getAttribute("media-type") || "").toLowerCase(),
      properties: node.getAttribute("properties") || "",
    });
  }
  const spine = elementChildren(spineNode, "itemref")
    .map((node) => manifest.get(node.getAttribute("idref")))
    .filter((item) => item && /html/.test(item.mediaType) && !item.properties.split(/\s+/).includes("nav"));

  const refined = refinements(metadata);
  const creators = readCreators(metadata, refined);
  const words = spine.reduce((total, item) => total + countWords(stripHtml(zip.text(item.path))), 0);

  return {
    format: "epub",
    title: readTitle(metadata, refined),
    authors: creators.map((creator) => creator.name),
    authorSort: creators[0]?.sortAs || "",
    language: text(first(metadata, "language")).split("-")[0].toLowerCase(),
    description: stripHtml(first(metadata, "description")?.textContent || ""),
    publisher: text(first(metadata, "publisher")),
    published: readPublished(metadata),
    subjects: [...new Set(byName(metadata, "subject").map(text).filter(Boolean))],
    isbn: readIsbn(metadata),
    ...readSeries(metadata, refined),
    pages: null,
    words,
    hasText: words > 0,
    cover: findCover(zip, packagePath, metadata, manifest, packageDocument, spine),
  };
}
