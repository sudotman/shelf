// Small text helpers shared by the build, the add command, and the tests.

export const WORDS_PER_MINUTE = 185; // Matches Hear's listening estimate.

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

export function decodeEntities(value) {
  return String(value || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === "#") {
      const code = entity[1].toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

export function cleanText(value) {
  return decodeEntities(value)
    .replace(/­/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Plain text from an HTML or XHTML fragment. Good enough for descriptions and
// word counts; it is never used to render markup.
export function stripHtml(value) {
  return cleanText(
    String(value || "")
      .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, " ")
      // Block boundaries become spaces; inline tags like <i> vanish so
      // "<i>woods</i>." stays "woods.".
      .replace(/<\/?(?:p|div|li|ul|ol|h[1-6]|blockquote|tr|td|th|section|article|header|footer|dd|dt)\b[^>]*>/gi, " ")
      .replace(/<[^>]+>/g, ""),
  );
}

export function countWords(text) {
  return String(text || "").match(/[\p{L}\p{N}]+(?:[’'-][\p{L}\p{N}]+)*/gu)?.length || 0;
}

export function listeningMinutes(words) {
  return words > 0 ? Math.max(1, Math.round(words / WORDS_PER_MINUTE)) : 0;
}

// Book ids come from file names, so they stay stable when a file moves between
// shelves. Hear uses them in links and to remember listening progress.
export function slugify(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
}

export function escapeXml(value) {
  return String(value ?? "")
    // Characters XML 1.0 cannot carry at all.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// "Aurelius, Marcus" → "Marcus Aurelius"; leaves "Marcus Aurelius" alone.
export function displayName(value) {
  const text = cleanText(value).replace(/,?\s+\d{4}\s*[-–]\s*(?:\d{4})?\.?$/, "");
  const match = text.match(/^([^,]+),\s*([^,]+)$/);
  return match ? `${match[2]} ${match[1]}` : text;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
