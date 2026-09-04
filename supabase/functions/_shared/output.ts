const EMOJI_PATTERN =
  /[\p{Extended_Pictographic}\p{Emoji_Presentation}\u{1F1E6}-\u{1F1FF}\uFE0F\u200D\u20E3]/gu;

export function sanitizePlainText(value: unknown): string {
  return String(value ?? "")
    .replace(/```(?:[a-z0-9_-]+)?/gi, "")
    .replace(/`/g, "")
    .replace(/\*/g, "")
    .replace(EMOJI_PATTERN, "")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s*[-+•]\s+/gm, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function hasForbiddenFormatting(value: string): boolean {
  EMOJI_PATTERN.lastIndex = 0;
  return value.includes("*") || value.includes("```") || EMOJI_PATTERN.test(value);
}

export function htmlEscape(value: unknown): string {
  return sanitizePlainText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
