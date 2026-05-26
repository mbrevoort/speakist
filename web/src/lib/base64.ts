// Shared base64 helpers. Web Crypto primitives + R2 / file streams hand
// us `Uint8Array`; encoders/decoders that work in both Workers and Node
// without a polyfill live here so callers don't roll their own.
//
// Three call sites today:
//   * lib/crypto.ts — AES-GCM IV + ciphertext encoding
//   * lib/service-tokens.ts — random token generation (URL-safe variant)
//   * lib/mcp/tools.ts — MCP audio content base64

/** Standard base64 (with `+/=`). Used by AES-GCM envelope IO. */
export function base64Encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

/** Standard base64 → bytes. */
export function base64Decode(s: string): Uint8Array {
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** URL-safe base64 (`-_`, no padding). Used by service-token plaintext
 *  generation so the token can be pasted into a URL or env var without
 *  escaping. */
export function base64UrlEncode(bytes: Uint8Array): string {
  return base64Encode(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
