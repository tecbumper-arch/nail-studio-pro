import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeGoogle } from './fakeGoogle.js';
import { resetGoogleTokenCache } from '../src/google.js';
import { createWorker } from '../src/index.js';
import { signToken } from '../src/session.js';

const SID = 'studio-1';
const MASTER = 'master-1';
const SECRET = 'test-secret';
const ORIGIN = 'https://w.example';
const env = {
  GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'cs', GOOGLE_REFRESH_TOKEN: 'z',
  SESSION_SECRET: SECRET, MASTER_SPREADSHEET_ID: MASTER,
  ASSETS: { fetch: async (req) => new Response('asset:' + new URL(req.url).pathname, { status: 200 }) },
};
const execCtx = { waitUntil: () => {} };

const seed = () => ({
  [MASTER]: { Contas_Manicures: [['Email', 'P', 'S', 'SheetId'], ['ana@x.com', 'Ana', 'S', SID]] },
  [SID]: {
    Configuracoes: [['Chave', 'Valor'], ['STUDIO_NOME', 'Studio Ana']],
    Categorias: [['id']], Catalogo: [['id']], Agendamentos: [['id']],
  },
});

let fake, worker;
beforeEach(() => {
  resetGoogleTokenCache();
  fake = createFakeGoogle(seed());
  worker = createWorker({ fetchImpl: fake.fetch });
});

const rpc = (body, token, raw) => worker.fetch(new Request(`${ORIGIN}/api/rpc`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: raw ?? JSON.stringify(body),
}), env, execCtx);
const tok = (payload, ttl = 3600, now) => signToken(payload, SECRET, ttl, now);

describe('router', () => {
  it('unknown fn -> 404', async () => {
    const res = await rpc({ fn: 'nope', args: [] });
    expect(res.status).toBe(404);
    expect((await res.json()).ok).toBe(false);
  });

  it('inherited property names are not functions', async () => {
    expect((await rpc({ fn: 'constructor' })).status).toBe(404);
    expect((await rpc({ fn: '__proto__' })).status).toBe(404);
  });

  it('bad body -> 400', async () => {
    for (const r of [rpc(null, null, 'not json'), rpc({ args: [] }), rpc({ fn: 'x', args: 'no' })]) {
      const res = await r;
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: 'Requisição inválida.' });
    }
  });

  it('admin fn without token -> 401', async () => {
    expect((await rpc({ fn: 'getAdminDashboardData' })).status).toBe(401);
  });

  it('admin fn with pending token -> 401', async () => {
    const t = await tok({ kind: 'pending', email: 'ana@x.com' });
    expect((await rpc({ fn: 'getAdminDashboardData' }, t)).status).toBe(401);
  });

  it('admin fn with state/calstart tokens (carry sid) -> 401', async () => {
    for (const kind of ['state', 'calstart']) {
      const t = await tok({ kind, sid: SID, email: 'ana@x.com' });
      expect((await rpc({ fn: 'adminGetGcalStatus' }, t)).status).toBe(401);
    }
  });

  it('expired token -> 401', async () => {
    const t = await tok({ kind: 'studio', sid: SID, email: 'ana@x.com' }, 60, Date.now() - 3600_000);
    expect((await rpc({ fn: 'getAdminDashboardData' }, t)).status).toBe(401);
  });

  it('pending fn requires pending token', async () => {
    const t = await tok({ kind: 'studio', sid: SID, email: 'ana@x.com' });
    expect((await rpc({ fn: 'completeInitialOnboarding', args: [{}] }, t)).status).toBe(401);
    expect((await rpc({ fn: 'completeInitialOnboarding', args: [{}] })).status).toBe(401);
  });

  it('studio fn with studio token gets ctx.session and ctx.sid', async () => {
    const t = await tok({ kind: 'studio', sid: SID, email: 'ana@x.com' });
    const res = await rpc({ fn: 'adminGetCalendarConnectToken' }, t);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(typeof j.data.token).toBe('string');
  });

  it('public fn with unknown sid -> 400, missing sid -> 400', async () => {
    const r1 = await rpc({ fn: 'getPublicBootstrapData', sid: 'other' });
    expect(r1.status).toBe(400);
    expect((await r1.json()).error).toBe('Studio não encontrado.');
    expect((await rpc({ fn: 'getPublicBootstrapData' })).status).toBe(400);
  });

  it('public fn with known sid -> 200', async () => {
    const res = await rpc({ fn: 'getPublicBootstrapData', sid: SID });
    expect(res.status).toBe(200);
    expect((await res.json()).data.studio.nome).toBe('Studio Ana');
  });

  it('public fn ignores a studio token (no ctx.session)', async () => {
    const t = await tok({ kind: 'studio', sid: 'other', email: 'x@x.com' });
    const res = await rpc({ fn: 'getPublicBootstrapData', sid: SID }, t);
    expect(res.status).toBe(200);
  });

  it('open fn authenticateAdmin needs no token', async () => {
    const res = await rpc({ fn: 'authenticateAdmin', args: [{ loginId: '' }] });
    expect(res.status).toBe(400);
  });

  it('Google 429 -> 502 with friendly message and no leak', async () => {
    fake.fail(429);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await rpc({ fn: 'getPublicBootstrapData', sid: SID });
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: false, error: 'Google indisponível, tente de novo em instantes.' });
    expect(text).not.toMatch(/fake failure|stack|at /);
    const logged = JSON.stringify(err.mock.calls);
    expect(logged).not.toMatch(/fake failure/);
    err.mockRestore();
  });

  it('unexpected error -> 500 generic', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = createWorker({
      fetchImpl: async (u) => (String(u).endsWith('/token')
        ? new Response(JSON.stringify({ access_token: 'a', expires_in: 3600 }))
        : new Response(JSON.stringify({ values: 'secret detail' }))),
    });
    const res = await bad.fetch(new Request(`${ORIGIN}/api/rpc`, {
      method: 'POST', body: JSON.stringify({ fn: 'getPublicBootstrapData', sid: SID }),
    }), env, execCtx);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: 'Erro interno. Tente novamente.' });
    expect(JSON.stringify(err.mock.calls)).not.toMatch(/secret detail/);
    err.mockRestore();
  });

  it('API responses have security headers', async () => {
    for (const res of [await rpc({ fn: 'nope' }), await rpc({ fn: 'getPublicBootstrapData', sid: SID }), await rpc(null, null, 'x')]) {
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.get('Content-Type')).toMatch(/application\/json/);
    }
  });

  it('GET /api/rpc -> 405', async () => {
    const res = await worker.fetch(new Request(`${ORIGIN}/api/rpc`), env, execCtx);
    expect(res.status).toBe(405);
  });

  it('GET / redirects to /App_Manicure.html', async () => {
    const res = await worker.fetch(new Request(`${ORIGIN}/`), env, execCtx);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/App_Manicure.html');
  });

  it('other routes fall through to ASSETS', async () => {
    const res = await worker.fetch(new Request(`${ORIGIN}/Pagina_Cliente.html`), env, execCtx);
    expect(await res.text()).toBe('asset:/Pagina_Cliente.html');
  });

  it('oauth start passes through 302 and Set-Cookie unchanged', async () => {
    const res = await worker.fetch(new Request(`${ORIGIN}/api/oauth/start?intent=login`), env, execCtx);
    expect(res.status).toBe(302);
    expect(res.headers.get('Set-Cookie')).toBeTruthy();
    expect(res.headers.get('Location')).toMatch(/^https:\/\/accounts\.google\.com/);
  });

  it('oauth callback with bad state is handled (not 500)', async () => {
    const res = await worker.fetch(new Request(`${ORIGIN}/api/oauth/callback?code=a&state=b`), env, execCtx);
    expect(res.status).toBeLessThan(500);
  });
});
