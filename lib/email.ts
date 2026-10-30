import nodemailer from 'nodemailer';

// Lazily created and reused across calls within the same server instance —
// nodemailer's transport keeps a small connection pool, no benefit to
// recreating it per send. Provider-agnostic: any SMTP server works (Google
// Workspace, Microsoft 365, Zoho, an in-house relay, …) — it's all SMTP_* env.
let transport: nodemailer.Transporter | null = null;

function getTransport(): nodemailer.Transporter {
  if (!transport) {
    const host = process.env.SMTP_HOST;
    // Without a host nodemailer silently falls back to localhost:587, which
    // fails later with a confusing connection error — fail clearly instead.
    if (!host) throw new Error('SMTP_HOST is not configured');
    const port = Number(process.env.SMTP_PORT ?? 587);
    transport = nodemailer.createTransport({
      pool: true,
      host,
      port,
      // Implicit TLS on 465; STARTTLS (upgraded after connect) on 587/25.
      // SMTP_SECURE overrides for a provider that does something else.
      secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
      // The Supabase Send Email hook (app/api/auth/send-email) gives us ~5s
      // to answer, so fail fast and let Supabase report the error rather
      // than hanging past its deadline.
      connectionTimeout: 3000,
      greetingTimeout: 3000,
      socketTimeout: 4000,
    });
  }
  return transport;
}

async function sendEmail({ to, subject, html }: { to: string | string[]; subject: string; html: string }) {
  const info = await getTransport().sendMail({ from: process.env.EMAIL_FROM_ADDRESS, to, subject, html });
  // Proof of hand-off for "email never arrived" reports: once the SMTP server
  // has accepted a message, anything further is on its side (spam, filters).
  // No subject or recipient here — auth subjects carry the OTP.
  console.log(
    `email: accepted=${info.accepted.length} rejected=${info.rejected.length} id=${info.messageId} smtp="${info.response}"`
  );
}

// Sent to every address in ADMIN_EMAILS (comma-separated) the moment someone
// submits the "request access" form — one send with all admins in the "to"
// list, so each sees who else is on the approval team.
export async function sendAdminApprovalEmail(opts: { name: string; email: string; organization: string; approveUrl: string }) {
  const adminAddresses = (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (adminAddresses.length === 0) throw new Error('ADMIN_EMAILS is not configured');

  await sendEmail({
    to: adminAddresses,
    subject: `New access request: ${opts.name}`,
    html: `
      <p>A new access request has come in for the AI Diffusion Studio.</p>
      <p>
        <strong>Name:</strong> ${escapeHtml(opts.name)}<br>
        <strong>Email:</strong> ${escapeHtml(opts.email)}<br>
        <strong>Organization:</strong> ${escapeHtml(opts.organization)}
      </p>
      <p><a href="${opts.approveUrl}">Review this request</a></p>
    `,
  });
}

// Sent once an admin approves a request — the link takes them straight to
// setting a password for the first time (see app/set-password/page.tsx).
export async function sendUserApprovedEmail(opts: { email: string; signInUrl: string }) {
  await sendEmail({
    to: opts.email,
    subject: 'Your access has been approved',
    html: `
      <p>Your registration has been approved! You can now click here to sign in.</p>
      <p><a href="${opts.signInUrl}">Set your password and sign in</a></p>
    `,
  });
}

// ── Supabase Auth emails ─────────────────────────────────────────────────
// Sent by the Send Email hook (app/api/auth/send-email/route.ts). Supabase
// still generates, stores, expires and verifies every code/link; these only
// deliver them.

function authEmailLayout(heading: string, body: string): string {
  return `
    <div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#363538;background:#faf9f6">
      <p style="font-family:monospace;font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#ff6543;margin:0 0 16px">100 Pathways</p>
      <h1 style="font-size:20px;font-weight:600;color:#1b1b42;margin:0 0 16px">${heading}</h1>
      ${body}
      <p style="font-size:12px;color:#6b6a70;margin-top:32px">If you didn't request this, you can safely ignore this email.</p>
    </div>
  `;
}

function codeBlock(code: string): string {
  return `<p style="font-family:monospace;font-size:30px;font-weight:600;letter-spacing:8px;color:#1b1b42;margin:24px 0">${escapeHtml(code)}</p>`;
}

function linkButton(url: string, label: string): string {
  return `<p style="margin:24px 0"><a href="${escapeHtml(url)}" style="background:#1b1b42;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:12px;font-size:14px;font-weight:500;display:inline-block">${label}</a></p>`;
}

// Sign-up confirmation — a code only, no link, matching the two-step form on
// /login (and so a mail scanner pre-fetching links can't consume it).
export async function sendSignupCodeEmail(opts: { to: string; code: string; expiresInMinutes: number }) {
  await sendEmail({
    to: opts.to,
    subject: `${opts.code} is your 100 Pathways verification code`,
    html: authEmailLayout(
      'Verify your email',
      `<p style="font-size:14px;line-height:1.6;margin:0">Enter this code to finish creating your account:</p>
       ${codeBlock(opts.code)}
       <p style="font-size:13px;color:#6b6a70;margin:0">This code expires in ${opts.expiresInMinutes} minutes.</p>`
    ),
  });
}

// Password reset — a code only, entered in the "Forgot password?" flow on
// /login (verifyOtp type 'recovery', then updateUser({ password })).
export async function sendPasswordResetCodeEmail(opts: { to: string; code: string; expiresInMinutes: number }) {
  await sendEmail({
    to: opts.to,
    subject: `${opts.code} is your 100 Pathways password reset code`,
    html: authEmailLayout(
      'Reset your password',
      `<p style="font-size:14px;line-height:1.6;margin:0">Someone asked to reset the password for this account. Enter this code to choose a new one:</p>
       ${codeBlock(opts.code)}
       <p style="font-size:13px;color:#6b6a70;margin:0">This code expires in ${opts.expiresInMinutes} minutes. Your password won't change unless you enter it.</p>`
    ),
  });
}

// Reauthentication (e.g. confirming a sensitive change) — also a bare code.
export async function sendReauthenticationCodeEmail(opts: { to: string; code: string; expiresInMinutes: number }) {
  await sendEmail({
    to: opts.to,
    subject: `${opts.code} is your 100 Pathways confirmation code`,
    html: authEmailLayout(
      'Confirm it’s you',
      `<p style="font-size:14px;line-height:1.6;margin:0">Enter this code to continue:</p>
       ${codeBlock(opts.code)}
       <p style="font-size:13px;color:#6b6a70;margin:0">This code expires in ${opts.expiresInMinutes} minutes.</p>`
    ),
  });
}

// Link-based auth emails (invite, magic link — neither used by the app
// itself, but an admin can send them from the Supabase dashboard). `url` is
// the Supabase /auth/v1/verify link the hook builds — the same one Supabase's
// own {{ .ConfirmationURL }} template would have produced.
export async function sendAuthLinkEmail(opts: {
  to: string;
  kind: 'invite' | 'magiclink';
  url: string;
  code?: string;
}) {
  const copy = {
    invite: {
      subject: 'You’ve been invited to 100 Pathways',
      heading: 'You’re invited',
      intro: 'You’ve been invited to the 100 Pathways Diffusion Cube. Use the button below to accept and set up your account.',
      button: 'Accept invite',
    },
    magiclink: {
      subject: 'Your 100 Pathways sign-in link',
      heading: 'Sign in',
      intro: 'Use the button below to sign in.',
      button: 'Sign in',
    },
  }[opts.kind];

  await sendEmail({
    to: opts.to,
    subject: copy.subject,
    html: authEmailLayout(
      copy.heading,
      `<p style="font-size:14px;line-height:1.6;margin:0">${copy.intro}</p>
       ${linkButton(opts.url, copy.button)}
       ${opts.code ? `<p style="font-size:13px;color:#6b6a70;margin:0">Or enter this code: <strong style="font-family:monospace;color:#1b1b42">${escapeHtml(opts.code)}</strong></p>` : ''}`
    ),
  });
}

// ── Contribution review emails ───────────────────────────────────────────
// Sent to the contributor whose draft an administrator just published
// (app/api/admin/pathways/publish). `paragraphs` are plain text, escaped
// here.

// Links in contribution emails always point at the production app, whatever
// host the admin who triggered the email happened to be on (localhost, a
// Vercel preview URL) — the contributor reads the email later, outside it.
// APP_URL sets it for a deployment on another domain (no trailing slash).
export const CUBE_APP_URL = (process.env.APP_URL || 'https://cube.100pathways.com').replace(/\/+$/, '');

export async function sendContributionEmail(opts: {
  to: string | string[];
  subject: string;
  heading: string;
  paragraphs: string[];
  link?: { url: string; label: string };
}) {
  const paragraphs = opts.paragraphs
    .map((p) => `<p style="font-size:14px;line-height:1.6;margin:0 0 12px">${escapeHtml(p)}</p>`)
    .join('');
  await sendEmail({
    to: opts.to,
    subject: opts.subject,
    html: contributionEmailLayout(opts.heading, `${paragraphs}${opts.link ? linkButton(opts.link.url, escapeHtml(opts.link.label)) : ''}`),
  });
}

function contributionEmailLayout(heading: string, body: string): string {
  return `
    <div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#363538;background:#faf9f6">
      <p style="font-family:monospace;font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#ff6543;margin:0 0 16px">100 Pathways</p>
      <h1 style="font-size:20px;font-weight:600;color:#1b1b42;margin:0 0 16px">${escapeHtml(heading)}</h1>
      ${body}
    </div>
  `;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
