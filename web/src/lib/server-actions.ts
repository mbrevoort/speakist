// Shared shape every Next.js server action returns, so client
// components can render success / error states without each feature
// inventing its own type. Keep it minimal — anything richer (counts,
// IDs, etc.) belongs in `message` or on a feature-specific extension.
//
// Convention:
//   * ok:true + optional message    — operation succeeded; message is
//                                     a human-friendly confirmation.
//   * ok:false + required error     — operation failed; error is a
//                                     human-friendly explanation
//                                     suitable for display.

export type ActionResult =
  | { ok: true; message?: string }
  | { ok: false; error: string };
