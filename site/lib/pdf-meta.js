// PDF metadata rules shared by the build (Node) and the admin console (browser),
// so both detect the same title and author for a file.
import { cleanText, displayName } from "./text.js";

// PDF dates look like "D:20240131120000+05'30'".
export function pdfDate(value) {
  const match = String(value || "").match(/^D?:?(\d{4})(\d{2})?(\d{2})?/);
  if (!match) return "";
  return [match[1], match[2], match[3]].filter(Boolean).join("-");
}

// Producers often leave junk like "Microsoft Word - draft3.docx" in the title.
export function usefulTitle(value) {
  const title = cleanText(value);
  if (!title || /^(?:untitled|microsoft word|document\d*|title)\b/i.test(title)) return "";
  if (/\.(?:docx?|pdf|tex|indd|odt|pages)$/i.test(title)) return "";
  return title;
}

// Scanned PDFs have images but (almost) no selectable text; Hear cannot
// narrate them until they have been through OCR.
export function hasSelectableText(characters, pages) {
  return characters >= Math.max(240, pages * 40);
}

// `info` is the PDF Info dictionary; `xmp(key)` reads the XMP metadata stream.
export function pdfMetadata(info = {}, xmp = () => "") {
  const read = (key) => cleanText(xmp(key) || "");
  const author = read("dc:creator") || cleanText(info.Author);
  const keywords = cleanText(info.Keywords);
  return {
    title: usefulTitle(read("dc:title") || info.Title),
    authors: author ? author.split(/\s*(?:;|&|\band\b)\s*/).map(displayName).filter(Boolean) : [],
    language: (read("dc:language") || cleanText(info.Lang)).split("-")[0].toLowerCase(),
    description: read("dc:description") || cleanText(info.Subject),
    published: pdfDate(info.CreationDate),
    subjects: keywords ? keywords.split(/\s*[;,]\s*/).filter(Boolean) : [],
  };
}
