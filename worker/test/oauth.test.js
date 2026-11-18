import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeGoogle } from './fakeGoogle.js';
import { createGoogle, resetGoogleTokenCache } from '../src/google.js';
import { handleOAuthStart, handleOAuthCallback } from '../src/oauth.js';
import { signToken, verifyToken } from '../src/session.js';

const SID = 'studio-1';
const SID2 = 'studio-2';
const MASTER = 'master-1';
const SECRET = 'test-secret';
const ORIGIN = 'https://w.example';
const env = {
  GOOGLE_CLIENT_ID: 'cid-123', GOOGLE_CLIENT_SECRET: 'csecret', GOOGLE_REFRESH_TOKEN: 'z',
  SESSION_SECRET: SECRET, MASTER_SPREADSHEET_ID: MASTER,
};

function seed() {
  return {
    [MASTER]: {
      Contas_Manicures: [
        ['Email', 'Profissional', 'Studio', 'SheetId', 'SheetUrl', 'ClientLink', 'PinHash', 'RecHash', 'CriadoEm'],
        ['Ana@X.com', 'Ana', 'Studio Ana', SID, '', '', '', '', ''],
        ['bia@x.com', 'Bia', 'Studio Bia', SID2, '', '', '', '', ''],
      ],
    },
    [SID]: {
      Configuracoes: [
        ['Chave', 'Valor', 'Descricao'],
        ['STUDIO_NOME', 'Studio Ana', ''],
        ['ADMIN_PIN_HASH', 'abc', ''],
        ['SINCRONIZAR_AGENDA', 'NAO', ''],
      ],
    },
    [SID2]: { Configuracoes: [['Chave', 'Valor', 'Descricao'], ['STUDIO_NOME', 'Studio Bia', '']] },
  };
}

let fake, g;
function setup(opts = {}, fetchWrap) {
  resetGoogleTokenCache();
  fake = createFakeGoogle(seed(), opts);
  g = createGoogle(env, fetchWrap ? fetchWrap(fake.fetch) : fake.fetch);
}

const studioToken = (sid = SID, email = 'ana@x.com') => signToken({ kind: 'studio', sid, email }, SECRET, 3600);
// Token curto (60 s) de adminGetCalendarConnectToken: o único aceito em ?t= do start da Agenda.
const calToken = (sid = SID, now) => signToken({ kind: 'calstart', sid }, SECRET, 60, now);
const start = (qs) => handleOAuthStart(new Request(`${ORIGIN}/api/oauth/start?${qs}`), env);
const cookieOf = (res) => (res.headers.get('Set-Cookie') || '').split(';')[0];

// Faz o fluxo completo: start -> (Google) -> callback com o state e o cookie do start.
async function flow(qs, { code = 'abc', cookie, state: forcedState } = {}) {
  const s = await start(qs);
  const state = forcedState ?? new URL(s.headers.get('Location')).searchParams.get('state');
  const headers = { Cookie: cookie ?? cookieOf(s) };
  const req = new Request(`${ORIGIN}/api/oauth/callback?code=${code}&state=${encodeURIComponent(state)}`, { headers });
  return handleOAuthCallback(req, env, g);
}

// Web: resultado no fragmento (#...), nunca na query. App: nailstudiopro://auth?...
function dest(res) {
  expect(res.status).toBe(302);
  const loc = res.headers.get('Location');
  const u = new URL(loc);
  if (loc.startsWith('nailstudiopro:')) return { loc, u, p: Object.fromEntries(u.searchParams) };
  expect(u.search).toBe('');
  return { loc, u, p: Object.fromEntries(new URLSearchParams(u.hash.slice(1))) };
}

describe('handleOAuthStart', () => {
  beforeEach(() => setup());

  it('start builds a Google URL with signed state and the callback redirect_uri', async () => {
    const res = await start('intent=login&app=0');
    expect(res.status).toBe(302);
    const u = new URL(res.headers.get('Location'));
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('client_id')).toBe('cid-123');
    expect(u.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/oauth/callback`);
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('scope')).toBe('openid email profile');
    expect(u.searchParams.get('access_type')).toBeNull();
    const state = await verifyToken(u.searchParams.get('state'), SECRET);
    expect(state).toMatchObject({ kind: 'state', intent: 'login', app: false });
    expect(state.sid).toBeUndefined();
    expect(state.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(600);
    expect(state.exp - Math.floor(Date.now() / 1000)).toBeGreaterThan(590);
    // nonce do state também vai num cookie HttpOnly (amarra o callback a este navegador)
    const cookie = res.headers.get('Set-Cookie');
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\/api\/oauth(;|$)/);
    expect(cookie).toMatch(/Max-Age=600(;|$)/);
    expect(cookieOf(res).split('=')[1]).toBe(state.n);
    expect(res.headers.get('Location')).not.toContain('csecret');
  });

  it('app is true only for the literal 1', async () => {
    for (const [qs, app] of [['app=1', true], ['app=0', false], ['app=true', false], ['', false]]) {
      const res = await start(`intent=onboard&${qs}`);
      const state = await verifyToken(new URL(res.headers.get('Location')).searchParams.get('state'), SECRET);
      expect(state.app).toBe(app);
      expect(state.intent).toBe('onboard');
    }
  });

  it('unknown intent is 400', async () => {
    expect((await start('intent=admin')).status).toBe(400);
    expect((await start('')).status).toBe(400);
  });

  it('calendar start with a calstart token asks for offline calendar access and puts the sid in the state', async () => {
    const res = await start(`intent=calendar&app=0&t=${await calToken()}`);
    expect(res.status).toBe(302);
    const u = new URL(res.headers.get('Location'));
    expect(u.searchParams.get('scope')).toBe('openid email https://www.googleapis.com/auth/calendar.events');
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('prompt')).toBe('consent');
    const state = await verifyToken(u.searchParams.get('state'), SECRET);
    expect(state).toMatchObject({ kind: 'state', intent: 'calendar', app: false, sid: SID });
  });

  it('calendar start without a valid calstart token is 401 (studio token is refused)', async () => {
    const studio = await studioToken();
    const pending = await signToken({ kind: 'pending', email: 'n@x.com', name: 'N', sid: SID }, SECRET, 600);
    const st = await signToken({ kind: 'state', intent: 'calendar', app: false, sid: SID }, SECRET, 600);
    const expired = await calToken(SID, Date.now() - 61 * 1000);
    const noSid = await signToken({ kind: 'calstart' }, SECRET, 60);
    const tampered = (await calToken()).slice(0, -2) + 'xx';
    for (const t of ['', `&t=${studio}`, `&t=${pending}`, `&t=${st}`, `&t=${expired}`, `&t=${noSid}`, `&t=${tampered}`, '&t=garbage']) {
      const res = await start(`intent=calendar${t}`);
      expect(res.status).toBe(401);
      expect(res.headers.get('Location')).toBeNull();
    }
  });
});

describe('handleOAuthCallback', () => {
  beforeEach(() => setup());

  it('callback for an existing account redirects with a studio token', async () => {
    setup({ userinfo: { email: 'ANA@x.com', verified_email: true, name: 'Ana' } });
    const { loc, u, p } = dest(await flow('intent=login&app=0'));
    expect(u.origin + u.pathname).toBe(`${ORIGIN}/App_Manicure.html`);
    expect(p.google_auth).toBe('success');
    expect(p.email).toBe('ana@x.com');
    expect(p.intent).toBe('login');
    const s = await verifyToken(p.token, SECRET);
    expect(s).toMatchObject({ kind: 'studio', sid: SID, email: 'ana@x.com' });
    // o código foi trocado com o redirect_uri do callback
    const tokenCall = fake.calls.find((c) => c.path === '/token');
    expect(new URLSearchParams(tokenCall.body).get('redirect_uri')).toBe(`${ORIGIN}/api/oauth/callback`);
    expect(loc).not.toContain('fake-access');
    expect(loc).not.toContain('fake-refresh');
  });

  it('recover and onboard intents also sign in an existing account', async () => {
    setup({ userinfo: { email: 'bia@x.com', verified_email: true } });
    for (const intent of ['recover', 'onboard']) {
      const { p } = dest(await flow(`intent=${intent}`));
      expect(p.google_auth).toBe('success');
      expect(p.intent).toBe(intent);
      expect(await verifyToken(p.token, SECRET)).toMatchObject({ kind: 'studio', sid: SID2 });
    }
  });

  it('callback for a new account redirects with a pending token', async () => {
    setup({ userinfo: { email: 'Nova@X.com', verified_email: true, name: 'Nova Silva' } });
    for (const intent of ['login', 'onboard']) {
      const { p } = dest(await flow(`intent=${intent}`));
      expect(p.google_auth).toBe('pending');
      expect(p.email).toBe('nova@x.com');
      const s = await verifyToken(p.token, SECRET);
      expect(s).toMatchObject({ kind: 'pending', email: 'nova@x.com', name: 'Nova Silva' });
      expect(s.sid).toBeUndefined();
      expect(s.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(1800);
      expect(s.exp - Math.floor(Date.now() / 1000)).toBeGreaterThan(1790);
    }
  });

  it('recover for an unknown account is an error, not a pending token', async () => {
    setup({ userinfo: { email: 'nova@x.com', verified_email: true } });
    const { loc, p } = dest(await flow('intent=recover'));
    expect(loc).toBe(`${ORIGIN}/App_Manicure.html#google_auth=error&msg=Conta%20n%C3%A3o%20encontrada`);
    expect(p.token).toBeUndefined();
  });

  it('callback with app=1 redirects to nailstudiopro://auth', async () => {
    const { loc, p } = dest(await flow('intent=login&app=1'));
    expect(loc.startsWith('nailstudiopro://auth?google_auth=pending&')).toBe(true);
    expect(p.email).toBe('fake@example.com');
    expect(await verifyToken(p.token, SECRET)).toMatchObject({ kind: 'pending' });
  });

  it('tampered state → google_auth=error', async () => {
    const s = await start('intent=login');
    const state = new URL(s.headers.get('Location')).searchParams.get('state');
    const [v, , sig] = state.split('.');
    const forged = Buffer.from(JSON.stringify({ kind: 'state', intent: 'calendar', app: false, sid: SID2, exp: 9999999999 })).toString('base64url');
    for (const bad of [`${v}.${forged}.${sig}`, state.slice(0, -2) + 'xx', 'garbage', '']) {
      const { u, p } = dest(await flow('intent=login', { state: bad }));
      expect(u.origin + u.pathname).toBe(`${ORIGIN}/App_Manicure.html`);
      expect(p.google_auth).toBe('error');
      expect(p.msg).toBeTruthy();
      expect(p.token).toBeUndefined();
    }
    expect(fake.calls.filter((c) => c.path === '/token')).toHaveLength(0);
  });

  it('state that is expired or of another kind → google_auth=error', async () => {
    const old = await signToken({ kind: 'state', intent: 'login', app: false, n: 'n1' }, SECRET, 600, Date.now() - 601 * 1000);
    const studio = await signToken({ kind: 'studio', sid: SID, email: 'ana@x.com', intent: 'login', n: 'n1' }, SECRET, 600);
    const pending = await signToken({ kind: 'pending', email: 'a@x.com', intent: 'login', n: 'n1' }, SECRET, 600);
    for (const st of [old, studio, pending]) {
      const { p } = dest(await flow('intent=login', { state: st, cookie: 'nsp_oauth=n1' }));
      expect(p.google_auth).toBe('error');
      expect(p.token).toBeUndefined();
    }
    expect(fake.calls.filter((c) => c.path === '/token')).toHaveLength(0);
  });

  it('callback from another browser (no or wrong nonce cookie) → google_auth=error', async () => {
    for (const cookie of ['', 'nsp_oauth=other', 'x=1']) {
      const { p } = dest(await flow('intent=login', { cookie }));
      expect(p.google_auth).toBe('error');
      expect(p.token).toBeUndefined();
    }
    expect(fake.calls.filter((c) => c.path === '/token')).toHaveLength(0);
  });

  it('Google error or failed code exchange → google_auth=error, with app destination when state is valid', async () => {
    const s = await start('intent=login&app=1');
    const state = new URL(s.headers.get('Location')).searchParams.get('state');
    const denied = await handleOAuthCallback(
      new Request(`${ORIGIN}/api/oauth/callback?error=access_denied&state=${encodeURIComponent(state)}`, { headers: { Cookie: cookieOf(s) } }),
      env, g);
    const d = dest(denied);
    expect(d.loc.startsWith('nailstudiopro://auth?google_auth=error&msg=')).toBe(true);

    fake.fail(400, /^\/token$/);
    const { p } = dest(await flow('intent=login'));
    expect(p.google_auth).toBe('error');
    expect(p.msg).toBe('Não foi possível entrar com o Google. Tente de novo.');

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fake.fail(503, /^\/token$/);
    const r = dest(await flow('intent=login'));
    expect(r.p.msg).toBe('Google indisponível, tente de novo.');
    expect(r.loc).not.toContain('fake failure');
  });

  it('unverified Google e-mail → google_auth=error', async () => {
    setup({ userinfo: { email: 'ana@x.com', verified_email: false } });
    const { p } = dest(await flow('intent=login'));
    expect(p.google_auth).toBe('error');
    expect(p.msg).toBe('O e-mail da conta Google não está verificado.');
  });

  it('calendar callback stores the refresh token in the studio sheet only', async () => {
    setup({ userinfo: { email: 'Agenda@X.com', verified_email: true } });
    const masterBefore = JSON.stringify(fake.db[MASTER]);
    const otherBefore = JSON.stringify(fake.db[SID2]);
    const { loc, p } = dest(await flow(`intent=calendar&t=${await calToken()}`));
    expect(loc).toBe(`${ORIGIN}/App_Manicure.html#gcal=connected`);
    expect(p.token).toBeUndefined();
    const cfg = fake.db[SID].Configuracoes;
    const map = Object.fromEntries(cfg.slice(1).map((r) => [r[0], r[1]]));
    expect(map).toMatchObject({
      GCAL_REFRESH_TOKEN: 'fake-refresh', GCAL_CONNECTED_EMAIL: 'agenda@x.com', SINCRONIZAR_AGENDA: 'SIM',
      STUDIO_NOME: 'Studio Ana', ADMIN_PIN_HASH: 'abc',
    });
    expect(cfg[0]).toEqual(['Chave', 'Valor', 'Descricao']);
    expect(JSON.stringify(fake.db[MASTER])).toBe(masterBefore);
    expect(JSON.stringify(fake.db[SID2])).toBe(otherBefore);
  });

  it('calendar callback with app=1 goes back to the app', async () => {
    const { loc } = dest(await flow(`intent=calendar&app=1&t=${await calToken()}`));
    expect(loc).toBe('nailstudiopro://auth?gcal=connected');
  });

  it('calendar callback without a refresh_token keeps the stored token and reports an error', async () => {
    setup({}, (f) => async (input, init) => {
      const res = await f(input, init);
      if (new URL(input).pathname === '/token') {
        const { refresh_token, ...rest } = await res.json();
        return new Response(JSON.stringify(rest), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return res;
    });
    fake.db[SID].Configuracoes.push(['GCAL_REFRESH_TOKEN', 'OLDTOKEN', '']);
    const before = JSON.stringify(fake.db[SID]);
    const { p } = dest(await flow(`intent=calendar&t=${await calToken()}`));
    expect(p.google_auth).toBe('error');
    expect(p.msg).toMatch(/Agenda/);
    expect(JSON.stringify(fake.db[SID])).toBe(before);
  });

  it('the nonce cookie is cleared on the callback response', async () => {
    const res = await flow('intent=login');
    const cleared = res.headers.get('Set-Cookie');
    expect(cleared).toMatch(/^nsp_oauth=;.*Max-Age=0/);
    for (const attr of [/HttpOnly/, /Secure/, /SameSite=Lax/, /Path=\/api\/oauth(;|$)/]) expect(cleared).toMatch(attr);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});
