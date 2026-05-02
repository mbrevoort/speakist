// Device-platform → user-facing label mapping for the /link page.
//
// The native apps (Mac, iOS) tag their /api/device/start request with a
// `platform` field; the server embeds it in `verification_url_with_code`
// so the /link page knows which device is being authorized. We use that
// to render copy like "Code from your Mac" vs "Code from your iPhone"
// instead of the previously-hardcoded "your Mac" (which read wrong
// when iOS users were the ones authorizing).
//
// Falls back to "device" when the platform is missing or unrecognized —
// older app builds that pre-date the platform field land here, plus any
// case where someone hits /link manually without a `?platform=` param.

export type DevicePlatform = "macos" | "ios";

export function isDevicePlatform(s: unknown): s is DevicePlatform {
  return s === "macos" || s === "ios";
}

/** Short noun for "your <X>" / "this <X>" — e.g., "Mac", "iPhone", "device". */
export function deviceLabel(platform: DevicePlatform | undefined): string {
  switch (platform) {
    case "macos":
      return "Mac";
    case "ios":
      // The iOS app currently targets iPhone only; if/when iPad is
      // supported we'd want a separate platform tag (e.g. "ipados")
      // rather than overloading "ios" with multiple form factors.
      return "iPhone";
    default:
      return "device";
  }
}
