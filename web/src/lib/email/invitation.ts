// Transactional email via Resend for invitations.
//
// Dev behavior: if RESEND_API_KEY is unset, log the accept URL to the dev
// console instead of sending a real email. Mirrors how the magic-link
// provider in auth.ts behaves — signup works offline, no Resend account
// required until you want real delivery.

interface InvitationEmailParams {
  to: string;
  orgName: string;
  inviterEmail: string;
  acceptUrl: string;
  expiresAt: Date;
}

export async function sendInvitationEmail(params: InvitationEmailParams): Promise<void> {
  const { to, orgName, inviterEmail, acceptUrl, expiresAt } = params;

  // Dev fallback.
  if (!process.env.RESEND_API_KEY) {
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`✉  Invitation for ${to} from ${inviterEmail}:`);
    console.log(`   Org: ${orgName}`);
    console.log(`   Accept: ${acceptUrl}`);
    console.log(`   Expires: ${expiresAt.toISOString()}`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    return;
  }

  const from = process.env.RESEND_FROM_EMAIL ?? "noreply@speakist.ai";

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:0 auto;padding:40px 24px;color:#1B1322">
      <h1 style="color:#4A2C5A;font-size:22px;margin:0 0 8px">You're invited to ${escape(orgName)}</h1>
      <p style="color:#4A2C5A;font-size:15px;line-height:1.6">
        ${escape(inviterEmail)} invited you to join <strong>${escape(orgName)}</strong> on Speakist — push-to-talk dictation for macOS.
      </p>
      <div style="margin:32px 0">
        <a href="${acceptUrl}" style="background:#FF8A65;color:#fff;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:600;font-size:15px;display:inline-block">Accept invitation</a>
      </div>
      <p style="color:#666;font-size:13px;line-height:1.5">
        This invitation expires on ${expiresAt.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}.
        If you weren't expecting this, you can safely ignore it.
      </p>
    </div>
  `;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to,
      subject: `You're invited to ${orgName} on Speakist`,
      html,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend invitation send failed: ${res.status} ${body}`);
  }
}

/** Minimal HTML entity escape for values rendered into the email body. */
function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
