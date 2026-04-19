import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Convert integer millicents to a display dollar string. We store money as
 * millicents (1/1000 of a cent) so per-word pricing at ~$0.0000574/word
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
