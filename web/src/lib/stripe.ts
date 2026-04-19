// Stripe client configured for Cloudflare Workers.
//
// The Stripe SDK defaults to Node's http module, which isn't in Workers.
// We pass a fetch-based http client so API calls go through global fetch,
// and we use the SubtleCrypto-based webhook signature verifier (the default
// uses Node's crypto, unavailable here).
//
// Instantiated lazily — there's no process-wide Stripe singleton — because
// env secrets on OpenNext arrive per-request. See getStripe() below.

import Stripe from "stripe";

/** Throws if STRIPE_SECRET_KEY is missing. */
export function getStripe(): Stripe {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    throw new Error("STRIPE_SECRET_KEY is not set");
  }
  // Omit `apiVersion` and let the SDK use the version it was built against —
  // saves us from keeping a string literal in sync with the package bump.
  return new Stripe(secret, {
    // Edge-compatible http client. Without this, the SDK tries to require
    // Node's `http` at runtime → "Dynamic require of http is not supported".
    httpClient: Stripe.createFetchHttpClient(),
  });
}

/** Edge-safe webhook signature verifier. */
export function getWebhookCryptoProvider() {
  return Stripe.createSubtleCryptoProvider();
}
