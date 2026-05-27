import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Convert integer millicents to a display dollar string. We store money as
 * millicents (1/1000 of a cent) so per-word pricing at ~$0.0002/word
 * doesn't round to zero per transcription. Balances are sums of ledger rows,
 * each of which is a millicents delta, and rendering always happens at the
 * edge via this helper.
 */
export function millicentsToDollars(mc: number | bigint): number {
  const n = typeof mc === "bigint" ? Number(mc) : mc;
  return n / 100_000;
}

export function formatDollars(mc: number | bigint, opts?: { precision?: number }): string {
  const dollars = millicentsToDollars(mc);
  const precision = opts?.precision ?? 2;
  return dollars.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  });
}

/**
 * Convert a millicent balance to a "words remaining" estimate using the
 * current per-word display rate. We round DOWN so the user never sees a
 * larger number than they actually have available — matching what the
 * /api/transcribe debit will allow before insufficient-balance kicks in.
 *
 * Negative balances clamp to 0 in the displayed number; the caller decides
 * whether to render a "negative balance" badge separately.
 */
export function millicentsToWords(
  mc: number | bigint,
  pricePerWordMillicents: number
): number {
  const n = typeof mc === "bigint" ? Number(mc) : mc;
  if (n <= 0 || pricePerWordMillicents <= 0) return 0;
  return Math.floor(n / pricePerWordMillicents);
}

/**
 * Friendly word-count formatter. Rounds to the nearest 100 below ~10K and
 * to nearest 1000 above so the displayed number feels stable as the
 * balance ticks down from per-dictation debits.
 *
 *   1,234   → "1,200 words"
 *   12,345  → "12,000 words"
 *   500_000 → "500,000 words"
 */
export function formatWords(words: number): string {
  if (words <= 0) return "0 words";
  let rounded: number;
  if (words < 10_000) {
    rounded = Math.floor(words / 100) * 100;
  } else {
    rounded = Math.floor(words / 1000) * 1000;
  }
  return `${rounded.toLocaleString("en-US")} words`;
}

/**
 * Truncate a string to at most `max` characters, appending an ellipsis
 * (counted within the budget) when it had to cut. Returns the input
 * unchanged when it already fits. Used for compact previews — admin
 * UIs, MCP listing payloads, Slack message blocks.
 */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/** Generate a short human-typable device auth code like "7F3Q-X2K9". */
export function generateDeviceUserCode(): string {
  // Unambiguous alphabet — no 0/O/1/I/L to avoid misreads on paper.
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += alphabet[bytes[i] % alphabet.length];
    if (i === 3) code += "-";
  }
  return code;
}
