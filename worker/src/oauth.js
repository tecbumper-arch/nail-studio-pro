// OAuth Google no servidor: login, criar conta, recuperar PIN e conectar a Agenda.
// GET /api/oauth/start?intent=login|onboard|recover|calendar&app=0|1[&t=<token studio>]
// GET /api/oauth/callback?code=...&state=...
// O `state` é assinado (kind 'state', 10 min) e carrega um nonce que também vai num cookie
// HttpOnly: o callback só é aceito no mesmo navegador que iniciou o fluxo.
import { signToken, verifyToken } from './session.js';
import { UserError } from './errors.js';
import { findAccountByEmail, issueStudioSession } from './handlers/auth.js';
import { upsertConfig } from './calendar.js';
import { sanitizeCell } from './util.js';

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const INTENTS = ['login', 'onboard', 'recover', 'calendar'];
const STATE_TTL = 10 * 60;
const PENDING_TTL = 30 * 60;
const COOKIE = 'nsp_oauth';
const COOKIE_ATTRS = 'Path=/api/oauth; HttpOnly; Secure; SameSite=Lax';
const SCOPES = {
  basic: 'openid email profile',
  calendar: 'openid email https://www.googleapis.com/auth/calendar.events',
};
const MSG = {
  state: 'Login com Google expirou ou é inválido. Tente de novo.',
  denied: 'Login com Google cancelado.',
  notFound: 'Conta não encontrada',
  noRefresh: 'A Google Agenda não foi conectada: o Google não enviou a autorização. Tente de novo.',
  google: 'Google indisponível, tente de novo.',
};

const callbackUri = (origin) => `${origin}/api/oauth/callback`;

function randomNonce() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

function redirect(location, cookie) {
  const headers = { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
  if (cookie) headers['Set-Cookie'] = cookie;
  return new Response(null, { status: 302, headers });
}

function plain(status, text) {
  return new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}

// Volta para a página (web) ou para o app; todos os valores são codificados.
function finish(origin, app, params) {
  const qs = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const base = app ? 'nailstudiopro://auth' : `${origin}/App_Manicure.html`;
  return redirect(`${base}?${qs}`, `${COOKIE}=; ${COOKIE_ATTRS}; Max-Age=0`);
}

const fail = (origin, app, msg) => finish(origin, app, { google_auth: 'error', msg });

export async function handleOAuthStart(request, env) {
  const url = new URL(request.url);
  const intent = url.searchParams.get('intent');
  if (!INTENTS.includes(intent)) return plain(400, 'Pedido inválido.');
  const app = url.searchParams.get('app') === '1';
  const nonce = randomNonce();
  const state = { kind: 'state', intent, app, n: nonce };

  const auth = new URL(GOOGLE_AUTH);
  auth.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  auth.searchParams.set('redirect_uri', callbackUri(url.origin));
  auth.searchParams.set('response_type', 'code');

  if (intent === 'calendar') {
    // O navegador não manda Authorization num redirecionamento: o token de studio vem em ?t=.
    const session = await verifyToken(url.searchParams.get('t'), env.SESSION_SECRET);
    if (!session || session.kind !== 'studio' || !session.sid) return plain(401, 'Sessão expirada. Entre novamente.');
    state.sid = session.sid;
    auth.searchParams.set('scope', SCOPES.calendar);
    auth.searchParams.set('access_type', 'offline');
    auth.searchParams.set('prompt', 'consent');
    if (session.email) auth.searchParams.set('login_hint', session.email);
  } else {
    auth.searchParams.set('scope', SCOPES.basic);
    auth.searchParams.set('prompt', 'select_account');
  }
  auth.searchParams.set('state', await signToken(state, env.SESSION_SECRET, STATE_TTL));
  return redirect(auth.toString(), `${COOKIE}=${nonce}; ${COOKIE_ATTRS}; Max-Age=${STATE_TTL}`);
}

async function readState(request, env, raw) {
  const s = await verifyToken(raw, env.SESSION_SECRET);
  if (!s || s.kind !== 'state' || !INTENTS.includes(s.intent) || typeof s.n !== 'string' || !s.n) return null;
  if (s.intent === 'calendar' && (typeof s.sid !== 'string' || !s.sid)) return null;
  if (readCookie(request, COOKIE) !== s.n) return null;
  return s;
}

export async function handleOAuthCallback(request, env, g) {
  const url = new URL(request.url);
  const origin = url.origin;
  const state = await readState(request, env, url.searchParams.get('state'));
  if (!state) return fail(origin, false, MSG.state);
  const app = state.app === true;
  const code = url.searchParams.get('code');
  if (url.searchParams.get('error') || !code) return fail(origin, app, MSG.denied);

  try {
    const tokens = await g.exchangeCode(code, callbackUri(origin));

    if (state.intent === 'calendar') {
      // Sem refresh_token a Agenda não funcionaria: não sobrescreve o que já está salvo.
      if (!tokens || !tokens.refresh_token) return fail(origin, app, MSG.noRefresh);
      const { email } = await g.userEmail(tokens.access_token);
      await upsertConfig({ g }, state.sid, {
        GCAL_REFRESH_TOKEN: tokens.refresh_token,
        GCAL_CONNECTED_EMAIL: sanitizeCell(email),
        SINCRONIZAR_AGENDA: 'SIM',
      });
      return finish(origin, app, { gcal: 'connected' });
    }

    const { email, name } = await g.userEmail(tokens && tokens.access_token);
    const conta = await findAccountByEmail(g, env, email);
    if (conta) {
      const token = await issueStudioSession(env, conta);
      return finish(origin, app, { google_auth: 'success', token, email, intent: state.intent });
    }
    if (state.intent === 'recover') return fail(origin, app, MSG.notFound);
    const token = await signToken({ kind: 'pending', email, name: name || '' }, env.SESSION_SECRET, PENDING_TTL);
    return finish(origin, app, { google_auth: 'pending', token, email });
  } catch (e) {
    // UserError/AuthError têm mensagem segura; o resto (GoogleError etc.) nunca vai ao navegador.
    if (e instanceof UserError) return fail(origin, app, e.message);
    console.warn('OAuth callback falhou:', e && e.name, e && e.status);
    return fail(origin, app, MSG.google);
  }
}
