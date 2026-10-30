import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// The proxy only ever talks to Supabase through createServerClient().auth.getUser();
// each test decides who (if anyone) that verifies as, and can make it refresh cookies.
type CookieAdapter = {
  getAll: () => { name: string; value: string }[];
  setAll: (cookies: { name: string; value: string; options?: Record<string, unknown> }[]) => void;
};

let verifiedUser: { id: string; email?: string | null } | null = null;
let cookiesToRefresh: { name: string; value: string; options?: Record<string, unknown> }[] = [];
let lastAdapter: CookieAdapter | null = null;

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn((_url: string, _key: string, opts: { cookies: CookieAdapter }) => {
    lastAdapter = opts.cookies;
    return {
      auth: {
        getUser: vi.fn(async () => {
          if (cookiesToRefresh.length) opts.cookies.setAll(cookiesToRefresh);
          return { data: { user: verifiedUser }, error: null };
        }),
      },
    };
  }),
}));

import { createServerClient } from '@supabase/ssr';
import { config, proxy } from '@/proxy';

const BASE = 'http://localhost:3000';

function req(path: string, headers: Record<string, string> = {}) {
  return new NextRequest(`${BASE}${path}`, { headers });
}

// NextResponse.next({ request: { headers } }) carries the forwarded request
// headers on the response as x-middleware-request-<name>, listed in
// x-middleware-override-headers.
function forwarded(res: Response, name: string) {
  return res.headers.get(`x-middleware-request-${name}`);
}
function overrideList(res: Response) {
  return (res.headers.get('x-middleware-override-headers') ?? '').split(',').filter(Boolean);
}

beforeEach(() => {
  verifiedUser = null;
  cookiesToRefresh = [];
  lastAdapter = null;
});

describe('proxy — anonymous visitors', () => {
  const publicPaths = [
    '/login',
    '/explore',
    '/explore/some-pathway',
    '/analyse',
    '/navigate',
    '/contribute',
    '/terms',
    '/privacy',
    '/api/chat',
    '/api/wiki-pathways',
    '/api/toolkit-assets/abc/download',
    '/api/auth/send-email',
    '/api/errors/client',
    '/api/brain/webhook',
  ];

  it.each(publicPaths)('lets an anonymous request through to %s', async (path) => {
    const res = await proxy(req(path));
    expect(res.headers.get('x-middleware-next')).toBe('1');
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('builds the Supabase client from the public env vars', async () => {
    await proxy(req('/explore'));
    expect(createServerClient).toHaveBeenCalledWith(
      'http://supabase.test',
      'test-anon-key',
      expect.objectContaining({ cookies: expect.any(Object) })
    );
  });

  it.each(['/account', '/admin', '/strengthen', '/some/deep/page'])(
    'redirects a protected page %s to /login with next=<path>',
    async (path) => {
      const res = await proxy(req(path));
      expect(res.status).toBe(307);
      const loc = new URL(res.headers.get('location')!);
      expect(loc.pathname).toBe('/login');
      expect(loc.searchParams.get('next')).toBe(path);
    }
  );

  it('sends an anonymous "/" to the Library rather than a login wall', async () => {
    const res = await proxy(req('/'));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/explore');
  });

  it('401s a protected API route instead of redirecting', async () => {
    const res = await proxy(req('/api/admin/roles'));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(res.headers.get('location')).toBeNull();
  });

  it.each(['/api/admin/brain/resync', '/api/brain/other', '/api/brain'])(
    'keeps %s protected: only the brain webhook itself is public',
    async (path) => {
      expect((await proxy(req(path))).status).toBe(401);
    }
  );

  it('does not treat a path that merely shares a public prefix as public', async () => {
    // '/explorer' is not '/explore' nor under '/explore/'.
    const res = await proxy(req('/explorer'));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/login');

    const api = await proxy(req('/api/chatty'));
    expect(api.status).toBe(401);
  });

  it('strips a client-sent x-user-email on public paths (spoofing)', async () => {
    const res = await proxy(req('/explore', { 'x-user-email': 'env-admin@example.com' }));
    expect(forwarded(res, 'x-user-email')).toBeNull();
    expect(overrideList(res)).not.toContain('x-user-email');
  });

  it('keeps other client headers when forwarding', async () => {
    const res = await proxy(req('/explore', { 'x-custom': 'kept' }));
    expect(forwarded(res, 'x-custom')).toBe('kept');
  });
});

describe('proxy — signed-in users', () => {
  beforeEach(() => {
    verifiedUser = { id: 'u1', email: 'real@example.com' };
  });

  it('forwards a protected request with x-user-email set to the verified email', async () => {
    const res = await proxy(req('/account'));
    expect(res.headers.get('x-middleware-next')).toBe('1');
    expect(forwarded(res, 'x-user-email')).toBe('real@example.com');
    expect(overrideList(res)).toContain('x-user-email');
  });

  it('overwrites a spoofed x-user-email with the verified one', async () => {
    const res = await proxy(req('/admin', { 'x-user-email': 'env-admin@example.com' }));
    expect(forwarded(res, 'x-user-email')).toBe('real@example.com');
  });

  it('sets x-user-email on public paths too', async () => {
    const res = await proxy(req('/explore', { 'x-user-email': 'spoof@example.com' }));
    expect(forwarded(res, 'x-user-email')).toBe('real@example.com');
  });

  it('forwards an empty x-user-email when the verified user has no email', async () => {
    verifiedUser = { id: 'u2', email: null };
    const res = await proxy(req('/account', { 'x-user-email': 'spoof@example.com' }));
    expect(forwarded(res, 'x-user-email')).toBe('');
  });

  it('redirects a signed-in user away from /login to /', async () => {
    const res = await proxy(req('/login'));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/');
  });

  it('allows "/" itself for a signed-in user', async () => {
    const res = await proxy(req('/'));
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it('allows a protected API route through for a signed-in user', async () => {
    const res = await proxy(req('/api/admin/roles'));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it('carries cookies refreshed by Supabase onto the final response', async () => {
    cookiesToRefresh = [{ name: 'sb-access', value: 'new-token', options: { path: '/' } }];
    const res = await proxy(req('/account', { cookie: 'sb-access=old-token' }));
    expect(forwarded(res, 'x-user-email')).toBe('real@example.com');
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('sb-access=new-token');
  });

  it('gives the Supabase client the request cookies', async () => {
    await proxy(req('/account', { cookie: 'a=1; b=2' }));
    expect(lastAdapter!.getAll()).toEqual([
      { name: 'a', value: '1' },
      { name: 'b', value: '2' },
    ]);
  });
});

describe('proxy — anonymous cookie refresh', () => {
  it('still strips a spoofed x-user-email after Supabase rewrites the response', async () => {
    cookiesToRefresh = [{ name: 'sb-access', value: '', options: { maxAge: 0 } }];
    const res = await proxy(req('/explore', { 'x-user-email': 'env-admin@example.com' }));
    expect(forwarded(res, 'x-user-email')).toBeNull();
    expect(res.headers.get('set-cookie') ?? '').toContain('sb-access=');
  });
});

describe('proxy matcher config', () => {
  const pattern = new RegExp(`^${config.matcher[0]}$`);

  it('has exactly one matcher pattern', () => {
    expect(config.matcher).toHaveLength(1);
  });

  it.each(['/', '/explore', '/api/chat', '/admin', '/login', '/some/page.html'])('matches %s', (p) => {
    expect(pattern.test(p)).toBe(true);
  });

  it.each([
    '/_next/static/chunks/main.js',
    '/_next/image',
    '/favicon.ico',
    '/logo.svg',
    '/img/photo.png',
    '/a.jpg',
    '/a.jpeg',
    '/a.gif',
    '/a.webp',
  ])('excludes static asset %s', (p) => {
    expect(pattern.test(p)).toBe(false);
  });
});
