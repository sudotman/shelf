const COVER_WIDTH = 480;
const MAX_RAW_COVER_BYTES = 3 * 1024 * 1024;

function rawCover(cover) {
  const extension = { "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp" }[cover.mediaType];
  if (!extension || cover.bytes.length > MAX_RAW_COVER_BYTES) return null;
  return { bytes: Buffer.from(cover.bytes), extension, width: null, height: null, color: "" };
}

// A spine colour for the shelf: the most common colour on the cover, nudged
// toward saturated ones so a red cover with white type reads as red, not pink.
export function dominantColor(pixels) {
  const buckets = new Map();
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index + 3] < 128) continue;
    const [red, green, blue] = [pixels[index], pixels[index + 1], pixels[index + 2]];
    const key = ((red >> 4) << 8) | ((green >> 4) << 4) | (blue >> 4);
    const bucket = buckets.get(key) || { count: 0, red: 0, green: 0, blue: 0 };
    bucket.count += 1;
    bucket.red += red;
    bucket.green += green;
    bucket.blue += blue;
    buckets.set(key, bucket);
  }
  let best = null;
  let bestScore = -1;
  for (const bucket of buckets.values()) {
    const red = bucket.red / bucket.count;
    const green = bucket.green / bucket.count;
    const blue = bucket.blue / bucket.count;
    const max = Math.max(red, green, blue);
    const saturation = max ? (max - Math.min(red, green, blue)) / max : 0;
    const score = bucket.count * (0.35 + saturation);
    if (score > bestScore) {
      bestScore = score;
      best = [red, green, blue];
    }
  }
  if (!best) return "";
  return `#${best.map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;
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
    const sample = canvasModule.createCanvas(24, 36);
    sample.getContext("2d").drawImage(canvas, 0, 0, 24, 36);
    const color = dominantColor(sample.getContext("2d").getImageData(0, 0, 24, 36).data);
    return { bytes: canvas.toBuffer("image/jpeg", 84), extension: "jpg", width: targetWidth, height: targetHeight, color };
  } catch {
    return rawCover(cover);
  }
}
