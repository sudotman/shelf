// Reads a dropped EPUB or PDF in the browser with the same rules the build
// uses (../lib/), so what the admin previews is what the shelf will show.
import { defaultKind, listenability, MAX_FILE_BYTES } from "../lib/catalog.js";
import { readEpub } from "../lib/epub.js";
import { hasSelectableText, pdfMetadata } from "../lib/pdf-meta.js";
import { countWords, listeningMinutes } from "../lib/text.js";

const COVER_WIDTH = 480;
const PDF_SAMPLE_PAGES = 24;
const vendor = (path) => new URL(`../vendor/${path}`, import.meta.url).href;

function hex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Git's blob id, so a file already in the repository is recognised exactly.
async function gitBlobSha(bytes) {
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const joined = new Uint8Array(header.length + bytes.byteLength);
  joined.set(header);
  joined.set(bytes, header.length);
  return hex(await crypto.subtle.digest("SHA-1", joined));
}

function canvasToJpeg(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.86));
}

async function imageToCover(source) {
  const bitmap = await createImageBitmap(source);
  const scale = Math.min(1, COVER_WIDTH / bitmap.width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const blob = await canvasToJpeg(canvas);
  return { blob, url: URL.createObjectURL(blob), width: canvas.width, height: canvas.height };
}

// A cover the owner picks: resized to the same light JPEG the build makes.
export function prepareCoverImage(file) {
  if (!/^image\/(?:jpeg|png|webp|gif|avif)$/.test(file.type)) throw new Error("Choose a JPEG, PNG, or WebP image.");
  return imageToCover(file);
}

let pdfjsPromise;
async function loadPdfjs() {
  pdfjsPromise ||= import("pdfjs").then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = vendor("pdfjs/pdf.worker.min.mjs");
    return pdfjs;
  });
  return pdfjsPromise;
}

async function readPdfInBrowser(bytes) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data: bytes,
    standardFontDataUrl: vendor("pdfjs/standard_fonts/"),
    cMapUrl: vendor("pdfjs/cmaps/"),
    cMapPacked: true,
    isEvalSupported: false,
  });
  let pdf;
  try {
    pdf = await task.promise;
  } catch (error) {
    if (error?.name === "PasswordException") throw new Error("This PDF is password-protected. Remove the password first.");
    throw new Error("This file is not a readable PDF.");
  }
  try {
    const { info = {}, metadata } = await pdf.getMetadata().catch(() => ({}));
    const sampled = Math.min(pdf.numPages, PDF_SAMPLE_PAGES);
    let characters = 0;
    let words = 0;
    for (let number = 1; number <= sampled; number += 1) {
      const page = await pdf.getPage(number);
      const text = (await page.getTextContent()).items.map((item) => item.str || "").join(" ");
      characters += text.replace(/\s+/g, "").length;
      words += countWords(text);
      page.cleanup();
    }
    const scale = pdf.numPages / sampled;
    const page = await pdf.getPage(1);
    const unscaled = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(4, COVER_WIDTH / unscaled.width) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    const coverBlob = await canvasToJpeg(canvas);
    return {
      ...pdfMetadata(info, (key) => metadata?.get?.(key)),
      pages: pdf.numPages,
      words: Math.round(words * scale),
      hasText: hasSelectableText(characters * scale, pdf.numPages),
      cover: { blob: coverBlob, url: URL.createObjectURL(coverBlob), width: canvas.width, height: canvas.height },
    };
  } finally {
    await task.destroy().catch(() => {});
  }
}

async function readEpubInBrowser(bytes) {
  const meta = readEpub(bytes);
  let cover = null;
  if (meta.cover) {
    cover = await imageToCover(new Blob([meta.cover.bytes], { type: meta.cover.mediaType })).catch(() => null);
  }
  return { ...meta, cover };
}

// Everything the admin needs to show and file a new book.
export async function inspectFile(file) {
  const extension = file.name.split(".").pop().toLowerCase();
  if (extension !== "epub" && extension !== "pdf") throw new Error("Only EPUB and PDF files can go on the shelf.");
  if (file.size > MAX_FILE_BYTES) throw new Error("GitHub only accepts files up to 100 MB without Git LFS.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const gitSha = await gitBlobSha(bytes);
  const meta = extension === "pdf" ? await readPdfInBrowser(bytes.slice()) : await readEpubInBrowser(bytes);
  return {
    extension,
    size: file.size,
    gitSha,
    title: meta.title || "",
    author: (meta.authors || []).join(", "),
    authorSort: meta.authorSort || "",
    description: meta.description || "",
    language: meta.language || "",
    pages: meta.pages ?? null,
    words: meta.words || 0,
    minutes: listeningMinutes(meta.words || 0),
    kind: defaultKind(extension, meta.pages),
    hasText: meta.hasText,
    cover: meta.cover,
    ...listenability({ format: extension, size: file.size, pages: meta.pages, hasText: meta.hasText }),
  };
}
