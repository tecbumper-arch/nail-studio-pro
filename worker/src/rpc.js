// Tabela de acesso e despacho das funções RPC.
import { publicHandlers } from './handlers/public.js';
import { authHandlers, adminAuthHandlers } from './handlers/auth.js';
import { adminHandlers } from './handlers/admin.js';
import { calendarHandlers } from './calendar.js';
import { onboardingHandlers } from './handlers/onboarding.js';
import { verifyToken } from './session.js';
import { UserError, AuthError, GoogleError } from './errors.js';

const pick = (obj, names) => Object.fromEntries(names.map((n) => [n, obj[n]]));

// open: sem token. public: exige sid (o handler valida contra a planilha mestre).
// studio: token kind 'studio'. pending: token kind 'pending'.
const TABLE = new Map();
const add = (access, handlers) => {
  for (const [name, fn] of Object.entries(handlers)) {
    if (typeof fn === 'function') TABLE.set(name, { access, fn });
  }
};
add('open', pick(authHandlers, ['authenticateAdmin']));
add('public', publicHandlers);
add('studio', pick(adminAuthHandlers, ['adminSetPin', 'checkAuthStatus']));
add('studio', adminHandlers);
add('studio', pick(calendarHandlers, [
  'adminGetGcalStatus', 'adminTestGcal', 'adminDisconnectGcal', 'adminSaveGcalWebhook', 'adminGetCalendarConnectToken',
]));
add('pending', pick(onboardingHandlers, ['completeInitialOnboarding']));

const SECURITY_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

function reply(status, body) {
  return new Response(JSON.stringify(body), { status, headers: SECURITY_HEADERS });
}
const fail = (status, error) => reply(status, { ok: false, error });

export async function handleRpc(request, env, g, execCtx) {
  if (request.method !== 'POST') return fail(405, 'Método não permitido.');

  let body;
  try {
    body = await request.json();
  } catch {
    return fail(400, 'Requisição inválida.');
  }
  if (!body || typeof body !== 'object' || typeof body.fn !== 'string' || !body.fn) {
    return fail(400, 'Requisição inválida.');
  }
  const args = body.args === undefined ? [] : body.args;
  if (!Array.isArray(args)) return fail(400, 'Requisição inválida.');

  const entry = TABLE.get(body.fn);
  if (!entry) return fail(404, 'Função desconhecida.');

  try {
    const ctx = {
      env, g,
      origin: new URL(request.url).origin,
      waitUntil: (p) => execCtx.waitUntil(p),
    };

    if (entry.access === 'public') {
      if (typeof body.sid !== 'string' || !body.sid) throw new UserError('Studio não encontrado.');
      ctx.sid = body.sid; // o handler valida com assertKnownStudio; nunca recebe ctx.session
    } else if (entry.access === 'studio' || entry.access === 'pending') {
      const m = /^Bearer (.+)$/.exec(request.headers.get('Authorization') || '');
      const session = m ? await verifyToken(m[1], env.SESSION_SECRET) : null;
      const kind = entry.access;
      if (!session || session.kind !== kind) throw new AuthError('Sessão expirada. Entre novamente.');
      ctx.session = session;
      if (kind === 'studio') ctx.sid = session.sid;
    }

    const data = await entry.fn(ctx, ...args);
    return reply(200, { ok: true, data: data === undefined ? null : data });
  } catch (e) {
    if (e instanceof UserError) return fail(e.status, e.message); // inclui AuthError (401)
    if (e instanceof GoogleError) {
      console.error('rpc error', { fn: body.fn, name: e.name, status: e.status });
      return fail(502, 'Google indisponível, tente de novo em instantes.');
    }
    console.error('rpc error', { fn: body.fn, name: e && e.name });
    return fail(500, 'Erro interno. Tente novamente.');
  }
}
