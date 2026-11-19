// Login por PIN (e-mail + PIN), troca de PIN e status de autenticação.
import { signToken } from '../session.js';
import { UserError } from '../errors.js';
import { hashPin } from '../util.js';
import { loadStudio } from '../studio.js';
import { isLocked, recordFailure, clearFailures } from '../rateLimit.js';

const STUDIO_TTL = 30 * 24 * 60 * 60;

export async function findAccountByEmail(g, env, email) {
  const clean = String(email || '').trim().toLowerCase();
  if (!clean) return null;
  const rows = await g.readTab(env.MASTER_SPREADSHEET_ID, 'Contas_Manicures');
  const conta = rows.slice(1).find((r) => r && String(r[0] || '').trim().toLowerCase() === clean);
  if (!conta || !conta[3]) return null;
  return { email: clean, sid: conta[3] };
}

export function issueStudioSession(env, { sid, email }, now) {
  return signToken({ kind: 'studio', sid, email }, env.SESSION_SECRET, STUDIO_TTL, now ? new Date(now).getTime() : undefined);
}

export const authHandlers = {
  async authenticateAdmin(ctx, { loginId, pin } = {}) {
    const { env, g } = ctx;
    const email = String(loginId || '').trim().toLowerCase();
    if (!email) throw new UserError('Informe o e-mail da sua conta Google.');
    const key = `pin:${email}`;

    if (await isLocked(env.RATE_LIMIT, key)) {
      throw new UserError('Muitas tentativas. Tente novamente em 15 minutos.');
    }

    const conta = await findAccountByEmail(g, env, email);
    if (!conta) {
      await recordFailure(env.RATE_LIMIT, key);
      throw new UserError('Conta não encontrada com este e-mail. Se for seu primeiro acesso, clique em "Criar Meu Acesso com Conta Google" abaixo.');
    }

    const { cfgMap } = await loadStudio(g, conta.sid);
    const inputHash = await hashPin(pin);
    const defaultHash = await hashPin('123456');
    const storedHash = cfgMap['ADMIN_PIN_HASH'] || defaultHash;

    if (inputHash !== storedHash) {
      await recordFailure(env.RATE_LIMIT, key);
      throw new UserError('Senha / PIN incorreto!');
    }
    if (storedHash === defaultHash) {
      throw new UserError('Defina um PIN: entre com Google e crie um novo PIN.');
    }

    await clearFailures(env.RATE_LIMIT, key);
    const token = await issueStudioSession(env, conta, ctx.now);
    return { token, spreadsheetId: conta.sid };
  },
};

// Regras de PIN novo (troca de PIN e onboarding). Devolve o PIN limpo.
export function validateNewPin(raw) {
  const pin = String(raw || '').trim();
  if (!/^\d{4,6}$/.test(pin)) throw new UserError('O PIN precisa ter de 4 a 6 números.');
  if (pin === '123456') throw new UserError('Escolha um PIN diferente de 123456.');
  return pin;
}

export const adminAuthHandlers = {
  async adminSetPin(ctx, { novoPin } = {}) {
    const pin = validateNewPin(novoPin);
    const sid = ctx.session.sid;
    const hash = await hashPin(pin);
    const rows = await ctx.g.readTab(sid, 'Configuracoes');
    let found = false;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i] && rows[i][0] === 'ADMIN_PIN_HASH') {
        rows[i][1] = hash;
        found = true;
      }
    }
    if (!found) rows.push(['ADMIN_PIN_HASH', hash, 'Hash SHA-256 da Senha']);
    await ctx.g.writeTab(sid, 'Configuracoes', rows);
    return { success: true };
  },

  async checkAuthStatus(ctx) {
    const sid = ctx.session.sid;
    const { studio, cfgMap } = await loadStudio(ctx.g, sid, ctx.origin);
    const defaultHash = await hashPin('123456');
    const stored = cfgMap['ADMIN_PIN_HASH'];
    return {
      setupConcluido: studio.setupConcluido,
      studioNome: studio.nome,
      profissional: studio.profissional,
      spreadsheetId: sid,
      hasPin: !!stored && stored !== defaultHash,
    };
  },
};
