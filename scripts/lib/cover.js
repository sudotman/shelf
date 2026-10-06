const COVER_WIDTH = 480;
const MAX_RAW_COVER_BYTES = 3 * 1024 * 1024;

function rawCover(cover) {
  const extension = { "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp" }[cover.mediaType];
  if (!extension || cover.bytes.length > MAX_RAW_COVER_BYTES) return null;
  return { bytes: Buffer.from(cover.bytes), extension, width: null, height: null };
}

// Resize covers to a consistent, light JPEG so the catalog stays quick on a
// phone. Falls back to the original image if the canvas module is missing.
export async function normalizeCover(cover, { width = COVER_WIDTH } = {}) {
  if (!cover?.bytes?.length) return null;
  let canvasModule;
  try {
    canvasModule = await import("@napi-rs/canvas");
  } catch {
    return rawCover(cover);
  }
  try {
    const image = await canvasModule.loadImage(Buffer.from(cover.bytes));
    if (!image.width || !image.height) return rawCover(cover);
    const scale = Math.min(1, width / image.width);
    const targetWidth = Math.max(1, Math.round(image.width * scale));
    const targetHeight = Math.max(1, Math.round(image.height * scale));
    const canvas = canvasModule.createCanvas(targetWidth, targetHeight);
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, targetWidth, targetHeight);
    context.drawImage(image, 0, 0, targetWidth, targetHeight);
    return { bytes: canvas.toBuffer("image/jpeg", 84), extension: "jpg", width: targetWidth, height: targetHeight };
  } catch {
    return rawCover(cover);
  }
}
