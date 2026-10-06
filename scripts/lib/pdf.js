import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { cleanText, countWords, displayName } from "./text.js";

const require = createRequire(import.meta.url);
const PDFJS_ROOT = dirname(require.resolve("pdfjs-dist/package.json"));
const STANDARD_FONTS = `${pathToFileURL(join(PDFJS_ROOT, "standard_fonts")).href}/`;
const CMAPS = `${pathToFileURL(join(PDFJS_ROOT, "cmaps")).href}/`;
const MAX_TEXT_PAGES = 1500;
const COVER_WIDTH = 480;

let pdfjsPromise;
function loadPdfjs() {
  pdfjsPromise ||= import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsPromise;
}

// PDF dates look like "D:20240131120000+05'30'".
function pdfDate(value) {
  const match = String(value || "").match(/^D?:?(\d{4})(\d{2})?(\d{2})?/);
  if (!match) return "";
  return [match[1], match[2], match[3]].filter(Boolean).join("-");
}

// Producers often leave junk like "Microsoft Word - draft3.docx" in the title.
function usefulTitle(value) {
  const title = cleanText(value);
  if (!title || /^(?:untitled|microsoft word|document\d*|title)\b/i.test(title)) return "";
  if (/\.(?:docx?|pdf|tex|indd|odt|pages)$/i.test(title)) return "";
  return title;
}

async function renderCover(pdf) {
  let canvasModule;
  try {
    canvasModule = await import("@napi-rs/canvas");
  } catch {
    return null;
  }
  const page = await pdf.getPage(1);
  try {
    const unscaled = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(4, COVER_WIDTH / unscaled.width) });
    const canvas = canvasModule.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    return { bytes: canvas.toBuffer("image/jpeg", 84), mediaType: "image/jpeg" };
  } finally {
    page.cleanup();
  }
}

export async function readPdf(buffer, { cover = true } = {}) {
  const { getDocument } = await loadPdfjs();
  const task = getDocument({
    data: new Uint8Array(buffer),
    standardFontDataUrl: STANDARD_FONTS,
    cMapUrl: CMAPS,
    cMapPacked: true,
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: 0,
  });
  let pdf;
  try {
    pdf = await task.promise;
  } catch (error) {
    if (error?.name === "PasswordException") throw new Error("The PDF is password-protected.");
    throw new Error(`Not a readable PDF: ${error?.message || error}`);
  }

  try {
    const { info = {}, metadata } = await pdf.getMetadata().catch(() => ({}));
    const fromXmp = (key) => cleanText(metadata?.get?.(key) || "");
    const author = fromXmp("dc:creator") || cleanText(info.Author);
    const keywords = cleanText(info.Keywords);

    let words = 0;
    let characters = 0;
    const pagesToRead = Math.min(pdf.numPages, MAX_TEXT_PAGES);
    for (let pageNumber = 1; pageNumber <= pagesToRead; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const pageText = content.items.map((item) => item.str || "").join(" ");
        characters += pageText.replace(/\s+/g, "").length;
        words += countWords(pageText);
      } finally {
        page.cleanup();
      }
    }
    if (pagesToRead < pdf.numPages) words = Math.round((words / pagesToRead) * pdf.numPages);

    const outline = await pdf.getOutline().catch(() => null);
    return {
      format: "pdf",
      title: usefulTitle(fromXmp("dc:title") || info.Title),
      authors: author ? author.split(/\s*(?:;|&|\band\b)\s*/).map(displayName).filter(Boolean) : [],
      authorSort: "",
      language: cleanText(fromXmp("dc:language") || info.Lang || "").split("-")[0].toLowerCase(),
      description: fromXmp("dc:description") || cleanText(info.Subject),
      publisher: "",
      published: pdfDate(info.CreationDate),
      subjects: keywords ? keywords.split(/\s*[;,]\s*/).filter(Boolean) : [],
      isbn: "",
      series: "",
      seriesIndex: null,
      pages: pdf.numPages,
      words,
      // Scanned PDFs have images but (almost) no selectable text; Hear cannot
      // narrate them until they have been through OCR.
      hasText: characters >= Math.max(240, pdf.numPages * 40),
      hasOutline: Array.isArray(outline) && outline.length > 0,
      cover: cover ? await renderCover(pdf).catch(() => null) : null,
    };
  } finally {
    await task.destroy().catch(() => {});
  }
}
