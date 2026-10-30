import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sendMail, createTransport } = vi.hoisted(() => {
  const sendMail = vi.fn();
  return { sendMail, createTransport: vi.fn(() => ({ sendMail })) };
});

vi.mock('nodemailer', () => ({ default: { createTransport } }));

type EmailModule = typeof import('@/lib/email');

// lib/email.ts keeps its transport at module level, so each test gets a fresh
// module (and so a fresh createTransport call) after setting SMTP_* env.
async function load(env: Record<string, string | undefined> = {}): Promise<EmailModule> {
  vi.resetModules();
  vi.stubEnv('SMTP_HOST', 'smtp.test');
  vi.stubEnv('SMTP_PORT', undefined);
  vi.stubEnv('SMTP_SECURE', undefined);
  vi.stubEnv('SMTP_USER', 'mailer');
  vi.stubEnv('SMTP_PASS', 'pw');
  vi.stubEnv('EMAIL_FROM_ADDRESS', 'noreply@100pathways.test');
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return import('@/lib/email');
}

const lastMail = () => sendMail.mock.calls.at(-1)?.[0] as { from: string; to: string | string[]; subject: string; html: string };
const transportOptions = () => (createTransport.mock.calls.at(-1) as unknown as [Record<string, unknown>])[0];

beforeEach(() => {
  sendMail.mockReset();
  sendMail.mockResolvedValue({ accepted: ['x'], rejected: [], messageId: 'id-1', response: '250 OK' });
  createTransport.mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('SMTP transport', () => {
  it('fails clearly when SMTP_HOST is not configured', async () => {
    const email = await load({ SMTP_HOST: undefined });
    await expect(email.sendUserApprovedEmail({ email: 'a@b.c', signInUrl: 'https://x' })).rejects.toThrow(
      'SMTP_HOST is not configured'
    );
    expect(createTransport).not.toHaveBeenCalled();
  });

  it('defaults to port 587 with STARTTLS (secure false), pooled, with short timeouts', async () => {
    const email = await load();
    await email.sendUserApprovedEmail({ email: 'a@b.c', signInUrl: 'https://x' });
    expect(transportOptions()).toMatchObject({
      pool: true,
      host: 'smtp.test',
      port: 587,
      secure: false,
      auth: { user: 'mailer', pass: 'pw' },
      connectionTimeout: 3000,
      greetingTimeout: 3000,
      socketTimeout: 4000,
    });
  });

  it('uses implicit TLS on port 465', async () => {
    const email = await load({ SMTP_PORT: '465' });
    await email.sendUserApprovedEmail({ email: 'a@b.c', signInUrl: 'https://x' });
    expect(transportOptions()).toMatchObject({ port: 465, secure: true });
  });

  it('SMTP_SECURE overrides the port-based default either way', async () => {
    let email = await load({ SMTP_PORT: '465', SMTP_SECURE: 'false' });
    await email.sendUserApprovedEmail({ email: 'a@b.c', signInUrl: 'https://x' });
    expect(transportOptions().secure).toBe(false);

    email = await load({ SMTP_PORT: '587', SMTP_SECURE: 'true' });
    await email.sendUserApprovedEmail({ email: 'a@b.c', signInUrl: 'https://x' });
    expect(transportOptions().secure).toBe(true);
  });

  it('creates the transport once and reuses it', async () => {
    const email = await load();
    await email.sendUserApprovedEmail({ email: 'a@b.c', signInUrl: 'https://x' });
    await email.sendUserApprovedEmail({ email: 'd@e.f', signInUrl: 'https://x' });
    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledTimes(2);
  });

  it('sends from EMAIL_FROM_ADDRESS', async () => {
    const email = await load();
    await email.sendUserApprovedEmail({ email: 'a@b.c', signInUrl: 'https://x' });
    expect(lastMail().from).toBe('noreply@100pathways.test');
  });

  it('propagates an SMTP failure to the caller', async () => {
    const email = await load();
    sendMail.mockRejectedValue(new Error('ETIMEDOUT'));
    await expect(email.sendSignupCodeEmail({ to: 'a@b.c', code: '123456', expiresInMinutes: 10 })).rejects.toThrow(
      'ETIMEDOUT'
    );
  });

  it('logs the hand-off without the subject or recipient (subjects carry OTPs)', async () => {
    const email = await load();
    await email.sendSignupCodeEmail({ to: 'person@example.com', code: '987654', expiresInMinutes: 10 });
    const logged = vi.mocked(console.log).mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toContain('accepted=1 rejected=0 id=id-1');
    expect(logged).not.toContain('987654');
    expect(logged).not.toContain('person@example.com');
  });
});

describe('sendAdminApprovalEmail', () => {
  it('sends one email to every ADMIN_EMAILS address', async () => {
    const email = await load({ ADMIN_EMAILS: ' a@x.test , b@x.test ,' });
    await email.sendAdminApprovalEmail({ name: 'Ann', email: 'ann@org.test', organization: 'Org', approveUrl: 'https://app/admin' });
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(lastMail().to).toEqual(['a@x.test', 'b@x.test']);
    expect(lastMail().subject).toBe('New access request: Ann');
    expect(lastMail().html).toContain('href="https://app/admin"');
  });

  it('throws when ADMIN_EMAILS is empty and sends nothing', async () => {
    const email = await load({ ADMIN_EMAILS: ' , ' });
    await expect(
      email.sendAdminApprovalEmail({ name: 'A', email: 'a@b.c', organization: 'O', approveUrl: 'u' })
    ).rejects.toThrow('ADMIN_EMAILS is not configured');
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('HTML-escapes the applicant-supplied name, email and organization', async () => {
    const email = await load();
    await email.sendAdminApprovalEmail({
      name: '<script>alert(1)</script>',
      email: '"x"@evil.test',
      organization: "O'Brien & <b>Co</b>",
      approveUrl: 'https://app/admin',
    });
    const { html } = lastMail();
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot;x&quot;@evil.test');
    expect(html).toContain('O&#39;Brien &amp; &lt;b&gt;Co&lt;/b&gt;');
  });
});

describe('sendUserApprovedEmail', () => {
  it('sends the sign-in link to the user', async () => {
    const email = await load();
    await email.sendUserApprovedEmail({ email: 'u@x.test', signInUrl: 'https://app/set-password?t=1' });
    expect(lastMail()).toMatchObject({ to: 'u@x.test', subject: 'Your access has been approved' });
    expect(lastMail().html).toContain('https://app/set-password?t=1');
  });
});

describe('auth code emails', () => {
  it.each([
    ['sendSignupCodeEmail', 'is your 100 Pathways verification code', 'Verify your email'],
    ['sendPasswordResetCodeEmail', 'is your 100 Pathways password reset code', 'Reset your password'],
    ['sendReauthenticationCodeEmail', 'is your 100 Pathways confirmation code', 'Confirm it’s you'],
  ] as const)('%s puts the code in subject and body with the expiry', async (fn, subjectSuffix, heading) => {
    const email = await load();
    await email[fn]({ to: 'u@x.test', code: '424242', expiresInMinutes: 15 });
    const mail = lastMail();
    expect(mail.to).toBe('u@x.test');
    expect(mail.subject).toBe(`424242 ${subjectSuffix}`);
    expect(mail.html).toContain(heading);
    expect(mail.html).toContain('424242');
    expect(mail.html).toContain('15 minutes');
    // Code-only — no link a mail scanner could pre-fetch.
    expect(mail.html).not.toContain('<a ');
  });

  it('escapes a code containing markup', async () => {
    const email = await load();
    await email.sendSignupCodeEmail({ to: 'u@x.test', code: '<img>', expiresInMinutes: 5 });
    expect(lastMail().html).toContain('&lt;img&gt;');
    expect(lastMail().html).not.toContain('<img>');
  });
});

describe('sendAuthLinkEmail', () => {
  it('sends an invite with an escaped link button', async () => {
    const email = await load();
    await email.sendAuthLinkEmail({ to: 'u@x.test', kind: 'invite', url: 'https://sb.test/verify?a=1&b="2"' });
    const mail = lastMail();
    expect(mail.subject).toBe('You’ve been invited to 100 Pathways');
    expect(mail.html).toContain('Accept invite');
    expect(mail.html).toContain('href="https://sb.test/verify?a=1&amp;b=&quot;2&quot;"');
    expect(mail.html).not.toContain('Or enter this code');
  });

  it('sends a magic link with the optional code', async () => {
    const email = await load();
    await email.sendAuthLinkEmail({ to: 'u@x.test', kind: 'magiclink', url: 'https://sb.test/v', code: '<99>' });
    const mail = lastMail();
    expect(mail.subject).toBe('Your 100 Pathways sign-in link');
    expect(mail.html).toContain('Sign in');
    expect(mail.html).toContain('Or enter this code');
    expect(mail.html).toContain('&lt;99&gt;');
  });
});

describe('sendContributionEmail', () => {
  it('escapes heading, paragraphs and link label/url', async () => {
    const email = await load();
    await email.sendContributionEmail({
      to: ['a@x.test', 'b@x.test'],
      subject: 'Your pathway is live',
      heading: 'Published <now>',
      paragraphs: ['First & foremost', '<script>x</script>'],
      link: { url: 'https://cube.test/p?a=1&b=2', label: 'Open <it>' },
    });
    const mail = lastMail();
    expect(mail.to).toEqual(['a@x.test', 'b@x.test']);
    expect(mail.subject).toBe('Your pathway is live');
    expect(mail.html).toContain('Published &lt;now&gt;');
    expect(mail.html).toContain('First &amp; foremost');
    expect(mail.html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('href="https://cube.test/p?a=1&amp;b=2"');
    expect(mail.html).toContain('Open &lt;it&gt;');
  });

  it('omits the button when no link is given', async () => {
    const email = await load();
    await email.sendContributionEmail({ to: 'a@x.test', subject: 's', heading: 'h', paragraphs: [] });
    expect(lastMail().html).not.toContain('<a ');
  });

  it('exports the production app URL used in contribution emails', async () => {
    const email = await load();
    expect(email.CUBE_APP_URL).toBe('https://cube.100pathways.com');
  });

  it('takes the app URL from APP_URL when a deployment sets it, without a trailing slash', async () => {
    vi.stubEnv('APP_URL', 'https://cube-new.vercel.app/');
    const email = await load();
    expect(email.CUBE_APP_URL).toBe('https://cube-new.vercel.app');
    vi.unstubAllEnvs();
  });
});
