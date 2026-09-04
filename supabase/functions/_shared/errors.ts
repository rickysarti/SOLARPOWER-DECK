export function errorMessage(error: unknown, maxLength = 1200): string {
  if (error instanceof Error) return error.message.slice(0, maxLength);
  if (typeof error === "string") return error.slice(0, maxLength);
  if (error && typeof error === "object") {
    const source = error as Record<string, unknown>;
    const useful = Object.fromEntries(
      ["name", "message", "code", "details", "hint", "status", "statusCode"]
        .filter((key) => source[key] !== undefined)
        .map((key) => [key, source[key]]),
    );
    try {
      return JSON.stringify(Object.keys(useful).length ? useful : source).slice(0, maxLength);
    } catch {
      return "Unknown non-serializable error";
    }
  }
  return String(error).slice(0, maxLength);
}
