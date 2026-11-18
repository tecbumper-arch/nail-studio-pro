import { describe, it, expect, beforeEach } from 'vitest';
import { createFakeGoogle } from './fakeGoogle.js';
import { createGoogle, resetGoogleTokenCache } from '../src/google.js';
import { authHandlers, adminAuthHandlers } from '../src/handlers/auth.js';
import { verifyToken } from '../src/session.js';
import { sha256Hex } from '../src/util.js';

const SID = 'studio-1';
const MASTER = 'master-1';
const SECRET = 'test-secret';

function fakeKv() {
  const m = new Map();
  return { m, get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); } };
}

async function seed(pinHash) {
  const cfg = [['Chave', 'Valor', 'Descricao'], ['STUDIO_NOME', 'Studio Ana', ''], ['SETUP_CONCLUIDO', 'SIM', '']];
  if (pinHash) cfg.push(['ADMIN_PIN_HASH', pinHash, '']);
  return {
    [MASTER]: { Contas_Manicures: [['Email', 'Profissional', 'Studio', 'SheetId'], ['Ana@X.com', 'Ana', 'Studio Ana', SID]] },
    [SID]: { Configuracoes: cfg },
  };
}

let fake, ctx;
async function setup(pinHash) {
  resetGoogleTokenCache();
  fake = createFakeGoogle(await seed(pinHash));
  const g = createGoogle({ GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'y', GOOGLE_REFRESH_TOKEN: 'z' }, fake.fetch);
  ctx = { env: { MASTER_SPREADSHEET_ID: MASTER, SESSION_SECRET: SECRET, RATE_LIMIT: fakeKv() }, g, sid: null, origin: 'https://w.example', waitUntil() {}, session: { sid: SID, email: 'ana@x.com' } };
}

describe('authenticateAdmin', () => {
  beforeEach(async () => setup(await sha256Hex('4321')));

  it('correct email and PIN returns a verifiable studio token with the studio sid', async () => {
    const r = await authHandlers.authenticateAdmin(ctx, { loginId: ' ANA@x.com ', pin: '4321' });
    expect(r.spreadsheetId).toBe(SID);
    const p = await verifyToken(r.token, SECRET);
    expect(p).toMatchObject({ kind: 'studio', sid: SID, email: 'ana@x.com' });
    expect(p.exp - Math.floor(Date.now() / 1000)).toBeGreaterThan(2592000 - 60);
  });

  it('wrong PIN fails with "Senha / PIN incorreto!"', async () => {
    await expect(authHandlers.authenticateAdmin(ctx, { loginId: 'ana@x.com', pin: '0000' })).rejects.toThrow('Senha / PIN incorreto!');
  });

  it('unknown email fails with the current "Conta não encontrada..." message', async () => {
    await expect(authHandlers.authenticateAdmin(ctx, { loginId: 'no@x.com', pin: '4321' })).rejects.toThrow(/^Conta não encontrada com este e-mail\./);
    expect(ctx.env.RATE_LIMIT.m.get('pin:no@x.com')).toBe('1');
  });

  it('sixth attempt within 15 min is locked even with the right PIN', async () => {
    for (let i = 0; i < 5; i++) {
      await expect(authHandlers.authenticateAdmin(ctx, { loginId: 'ana@x.com', pin: '0000' })).rejects.toThrow('Senha / PIN incorreto!');
    }
    const reads = fake.calls.length;
    await expect(authHandlers.authenticateAdmin(ctx, { loginId: 'ana@x.com', pin: '4321' })).rejects.toThrow('Muitas tentativas. Tente novamente em 15 minutos.');
    expect(fake.calls.length).toBe(reads);
  });

  it('accepts ctx.now as a Date or a number and signs relative to it', async () => {
    const t = Date.parse('2030-01-01T00:00:00Z');
    for (const now of [new Date(t), t]) {
      const r = await authHandlers.authenticateAdmin({ ...ctx, now }, { loginId: 'ana@x.com', pin: '4321' });
      const p = await verifyToken(r.token, SECRET, t);
      expect(p.exp).toBe(Math.floor(t / 1000) + 2592000);
    }
  });

  it('email casing and spaces share one lock counter', async () => {
    await expect(authHandlers.authenticateAdmin(ctx, { loginId: ' ANA@x.com ', pin: '0' })).rejects.toThrow();
    await expect(authHandlers.authenticateAdmin(ctx, { loginId: 'ana@X.COM', pin: '0' })).rejects.toThrow();
    expect([...ctx.env.RATE_LIMIT.m.keys()]).toEqual(['pin:ana@x.com']);
    expect(ctx.env.RATE_LIMIT.m.get('pin:ana@x.com')).toBe('2');
  });

  it('success clears the failure counter', async () => {
    await expect(authHandlers.authenticateAdmin(ctx, { loginId: 'ana@x.com', pin: '0000' })).rejects.toThrow();
    await authHandlers.authenticateAdmin(ctx, { loginId: 'ana@x.com', pin: '4321' });
    expect(ctx.env.RATE_LIMIT.m.has('pin:ana@x.com')).toBe(false);
  });

  it('legacy default PIN 123456 is refused', async () => {
    await setup(await sha256Hex('123456'));
    await expect(authHandlers.authenticateAdmin(ctx, { loginId: 'ana@x.com', pin: '123456' })).rejects.toThrow('Defina um PIN: entre com Google e crie um novo PIN.');
    await setup(null);
    await expect(authHandlers.authenticateAdmin(ctx, { loginId: 'ana@x.com', pin: '123456' })).rejects.toThrow('Defina um PIN');
  });
});

describe('adminSetPin isolation', () => {
  it('leaves another studio and the master sheet unchanged', async () => {
    await setup(null);
    fake.db['studio-2'] = { Configuracoes: [['Chave', 'Valor', 'Descricao'], ['ADMIN_PIN_HASH', 'OTHER', '']] };
    const before = JSON.stringify({ o: fake.db['studio-2'], m: fake.db[MASTER] });
    await adminAuthHandlers.adminSetPin(ctx, { novoPin: '9876' });
    expect(JSON.stringify({ o: fake.db['studio-2'], m: fake.db[MASTER] })).toBe(before);
  });
});

describe('adminSetPin / checkAuthStatus', () => {
  beforeEach(async () => setup(null));

  it('adminSetPin rejects 3 digits and stores the hash of a valid PIN', async () => {
    await expect(adminAuthHandlers.adminSetPin(ctx, { novoPin: '123' })).rejects.toThrow('O PIN precisa ter de 4 a 6 números.');
    await expect(adminAuthHandlers.adminSetPin(ctx, { novoPin: 'abcd' })).rejects.toThrow('O PIN precisa ter de 4 a 6 números.');
    await expect(adminAuthHandlers.adminSetPin(ctx, { novoPin: '123456' })).rejects.toThrow('Escolha um PIN diferente de 123456.');
    expect((await adminAuthHandlers.checkAuthStatus(ctx)).hasPin).toBe(false);
    expect(await adminAuthHandlers.adminSetPin(ctx, { novoPin: '9876' })).toEqual({ success: true });
    const row = fake.db[SID].Configuracoes.find((r) => r[0] === 'ADMIN_PIN_HASH');
    expect(row[1]).toBe(await sha256Hex('9876'));
    // atualiza a linha existente, sem duplicar
    await adminAuthHandlers.adminSetPin(ctx, { novoPin: '5555' });
    expect(fake.db[SID].Configuracoes.filter((r) => r[0] === 'ADMIN_PIN_HASH')).toHaveLength(1);
    const st = await adminAuthHandlers.checkAuthStatus(ctx);
    expect(st).toEqual({ setupConcluido: true, studioNome: 'Studio Ana', profissional: 'Manicure & Nail Designer', spreadsheetId: SID, hasPin: true });
  });
});
