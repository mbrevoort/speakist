// Device-platform → user-facing label mapping for the /link page.
//
// The Mac app tags its /api/device/start request with a
// `platform` field; the server embeds it in `verification_url_with_code`
// so the /link page knows which device is being authorized. We use that
// to render "Code from your Mac" while retaining a safe fallback for old
// or manually constructed links.
//
// Falls back to "device" when the platform is missing or unrecognized —
// older app builds that pre-date the platform field land here, plus any
// case where someone hits /link manually without a `?platform=` param.

export type DevicePlatform = "macos";

export function isDevicePlatform(s: unknown): s is DevicePlatform {
  return s === "macos";
}

/** Short noun for "your <X>" / "this <X>" — e.g., "Mac" or "device". */
export function deviceLabel(platform: DevicePlatform | undefined): string {
  switch (platform) {
    case "macos":
      return "Mac";
    default:
      return "device";
  }
}
