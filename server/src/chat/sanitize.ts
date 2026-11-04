export const MAX_CHAT_CHARS = 140;

// C0/C1 controls (tab/newline/CR handled as whitespace below), DEL, zero-width + bidi
// override/isolate chars, BOM, line/paragraph separators. Ranges are code points (inclusive).
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x08], [0x0b, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e],
  [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff, 0xfeff],
];
const isInvisible = (cp: number): boolean => INVISIBLE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
const stripInvisible = (s: string): string => {
  let out = "";
  for (const ch of s) if (!isInvisible(ch.codePointAt(0) as number)) out += ch;
  return out;
};
const WHITESPACE_RUN = /[\t\n\r ]+/g;

export type SanitizeResult = { ok: true; text: string } | { ok: false; reason: "empty" | "too_long" | "not_string" };

/** Strip control chars, collapse whitespace, trim, enforce 1..140 code points. Output is plain text. */
export function sanitizeChat(input: unknown): SanitizeResult {
  if (typeof input !== "string") return { ok: false, reason: "not_string" };
  const text = stripInvisible(input.replace(WHITESPACE_RUN, " ")).replace(WHITESPACE_RUN, " ").trim();
  if (text.length === 0) return { ok: false, reason: "empty" };
  if ([...text].length > MAX_CHAT_CHARS) return { ok: false, reason: "too_long" };
  return { ok: true, text };
}

/** HTML-escape so a client that (wrongly) uses innerHTML cannot be XSS'd by chat text. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
