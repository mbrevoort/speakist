// Application-layer symmetric encryption for secrets stored in D1.
//
// Scope: exactly one thing — encrypting Deepgram API keys (system-wide in
// app_settings, per-org override in organizations). SQLite + Cloudflare
// storage is plausibly secure at rest, but (a) anyone with DB access shouldn't
// have our Deepgram project keys, and (b) D1 backups get pushed around.
// Cheap belt-and-suspenders.
//
// Primitive: AES-GCM via Web Crypto. 256-bit key from APP_ENCRYPTION_KEY
// (base64, 32 raw bytes). 12-byte random IV per message. Auth tag included
// in ciphertext output (GCM standard).
//
// Envelope format:  <base64-iv>:<base64-ciphertext-with-tag>
//   * Single colon separator; we defensively reject envelopes with multiple
//   * Both halves are standard base64 (not URL-safe) — survives a round-trip
//     through text tools without escaping
//
// Not for: Stripe secrets (those live in env only), session tokens (Auth.js
// owns those), user passwords (we don't have any).

const ALGORITHM = "AES-GCM";
const IV_BYTES = 12;

export interface CryptoError {
  kind: "missing_key" | "bad_envelope" | "decrypt_failed";
  message: string;
}

function requireKey(): Uint8Array {
  const b64 = process.env.APP_ENCRYPTION_KEY;
  if (!b64) {
    throw new Error("APP_ENCRYPTION_KEY is not set");
  }
  const raw = base64Decode(b64);
  if (raw.length !== 32) {
    // We require exactly 256 bits. Generate with: openssl rand -base64 32
    throw new Error(`APP_ENCRYPTION_KEY must decode to 32 bytes; got ${raw.length}`);
  }
  return raw;
}

async function importKey(usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    requireKey() as BufferSource,
    { name: ALGORITHM },
    false,
    [usage]
  );
}

/**
 * Encrypt `plaintext` for storage. Output is a self-contained string safe to
 * write into a `text` column; decryption needs only this string + the same
 * APP_ENCRYPTION_KEY.
 */
export async function encryptSecret(plaintext: string): Promise<string> {
  const key = await importKey("encrypt");
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return `${base64Encode(iv)}:${base64Encode(new Uint8Array(ciphertext))}`;
}

/**
 * Decrypt a value produced by encryptSecret. Throws on malformed envelope,
 * wrong key, or tamper.
 */
export async function decryptSecret(envelope: string): Promise<string> {
  const parts = envelope.split(":");
  if (parts.length !== 2) {
    throw new Error("envelope malformed (expected '<iv>:<ciphertext>')");
  }
  const [ivB64, ctB64] = parts;
  const iv = base64Decode(ivB64);
  const ciphertext = base64Decode(ctB64);
  if (iv.length !== IV_BYTES) {
    throw new Error(`iv wrong size (${iv.length} bytes)`);
  }
  const key = await importKey("decrypt");
  const plaintext = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv: iv as BufferSource },
    key,
    ciphertext as BufferSource
  );
  return new TextDecoder().decode(plaintext);
}

/**
 * Last-4-chars preview for displaying in admin UI — e.g. "ending in 9f3e".
 * Never render the full key.
 */
export function secretPreview(plaintext: string): string {
  const s = plaintext.trim();
  if (s.length <= 4) return "•".repeat(s.length);
  return `…${s.slice(-4)}`;
}

// --- base64 helpers (Web Crypto primitives want Uint8Array) ----------------

function base64Encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function base64Decode(s: string): Uint8Array {
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
