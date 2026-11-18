import { describe, it, expect, beforeEach } from 'vitest';
import { createFakeGoogle } from './fakeGoogle.js';
import { createGoogle, resetGoogleTokenCache } from '../src/google.js';
import { onboardingHandlers } from '../src/handlers/onboarding.js';
import { verifyToken } from '../src/session.js';
import { sha256Hex } from '../src/util.js';
import { AuthError, UserError, GoogleError } from '../src/errors.js';

const SID = 'studio-1';
const MASTER = 'master-1';
const CUSTOM = '1AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789-abcd';
const SECRET = 'test-secret';
const ORIGIN = 'https://w.example';
const CONTAS_HEAD = ['Email', 'Profissional', 'Studio', 'SheetId', 'SheetUrl', 'ClientLink', 'PinHash', 'RecHash', 'CriadoEm'];

function seed() {
  return {
    [MASTER]: { Contas_Manicures: [CONTAS_HEAD, ['ana@x.com', 'Ana', 'Studio Ana', SID, '', '', '', '', '']] },
    [SID]: { Configuracoes: [['Chave', 'Valor', 'Descricao'], ['STUDIO_NOME', 'Studio Ana', '']] },
    [CUSTOM]: { Configuracoes: [] },
  };
}

let fake, ctx;
function setup(opts) {
  resetGoogleTokenCache();
  fake = createFakeGoogle(seed(), opts);
  const env = { GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'y', GOOGLE_REFRESH_TOKEN: 'z', SESSION_SECRET: SECRET, MASTER_SPREADSHEET_ID: MASTER };
  const g = createGoogle(env, fake.fetch);
  ctx = { env, g, origin: ORIGIN, waitUntil() {}, session: { kind: 'pending', email: 'nova@x.com', name: 'Nova', exp: 9999999999 } };
}

const P = () => ({ studioNome: 'Studio Nova', profissionalNome: 'Nova Silva', whatsapp: '(11) 99777-8888', pixChave: 'nova@x.com', pin: '4321' });
const run = (p) => onboardingHandlers.completeInitialOnboarding(ctx, p);
const cfgMap = (sid) => Object.fromEntries(fake.db[sid].Configuracoes.slice(1).map((r) => [r[0], r[1]]));
const contas = () => fake.db[MASTER].Contas_Manicures;
// Chamadas que alteram algo no Google (a renovação do access token do servidor não conta).
const writes = () => fake.calls.filter((c) => c.method !== 'GET' && c.path !== '/token');

async function expectReject(promise, Cls, msg) {
  const err = await promise.then(() => null, (e) => e);
  expect(err).toBeInstanceOf(Cls);
  if (msg) expect(err.message).toBe(msg);
  return err;
}

describe('completeInitialOnboarding', () => {
  beforeEach(() => setup());

  it('onboarding with pending token provisions a sheet and registers it in Contas_Manicures', async () => {
    const r = await run(P());
    const sid = r.spreadsheetId;
    expect(sid).toMatch(/^fake-sheet-/);
    expect(Object.keys(fake.db[sid]).sort()).toEqual(['Agendamentos', 'Catalogo', 'Categorias', 'Configuracoes', 'Logs_Seguranca']);
    const create = fake.calls.find((c) => c.method === 'POST' && c.path === '/v4/spreadsheets');
    expect(create.body.properties.title).toBe('Studio Nova - App & Agenda (Banco Oficial)');

    const cfg = cfgMap(sid);
    expect(cfg).toMatchObject({
      SETUP_CONCLUIDO: 'SIM', STUDIO_NOME: 'Studio Nova', PROFISSIONAL_NOME: 'Nova Silva',
      ADMIN_LOGIN_ID: 'nova@x.com', WHATSAPP_STUDIO: '11997778888', PIX_CHAVE: 'nova@x.com',
      PIX_RECEBEDOR: 'Nova Silva', SINCRONIZAR_AGENDA: 'SIM', ADMIN_PIN_HASH: await sha256Hex('4321'),
      ADMIN_RECOVERY_HASH: '', HORARIO_INICIO: '09:00', DIAS_ATENDIMENTO: '1,2,3,4,5,6',
    });
    expect(fake.db[sid].Configuracoes[0]).toEqual(['Chave', 'Valor', 'Descricao']);
    expect(fake.db[sid].Categorias).toHaveLength(6);
    expect(fake.db[sid].Categorias[0]).toEqual(['ID', 'Nome', 'Icone', 'Ordem', 'Ativo']);
    expect(fake.db[sid].Categorias[1]).toEqual(['CAT-01', 'Alongamentos', '💅', '1', 'SIM']);
    expect(fake.db[sid].Catalogo).toHaveLength(5);
    expect(fake.db[sid].Catalogo[1][0]).toBe('SRV-101');
    expect(fake.db[sid].Agendamentos).toEqual([['ID', 'Data', 'HoraInicio', 'HoraFim', 'ClienteNome', 'ClienteWhatsApp', 'ServicoID', 'ServicoNome', 'Valor', 'MetodoPagamento', 'StatusPagamento', 'StatusReserva', 'CalendarEventID', 'CriadoEm']]);
    expect(fake.db[sid].Logs_Seguranca[1][1]).toBe('CONTA_CRIADA');

    // Compartilhada com o e-mail do token
    const perm = fake.calls.find((c) => c.method === 'POST' && c.path === `/drive/v3/files/${sid}/permissions`);
    expect(perm.body).toEqual({ role: 'writer', type: 'user', emailAddress: 'nova@x.com' });
    expect(r.ownershipStatus).toBe('PROPRIETARIA');

    const rows = contas();
    expect(rows).toHaveLength(3);
    const row = rows[2];
    expect(row.slice(0, 8)).toEqual([
      'nova@x.com', 'Nova Silva', 'Studio Nova', sid,
      `https://docs.google.com/spreadsheets/d/${sid}/edit`, `${ORIGIN}/Pagina_Cliente.html?s=${sid}`,
      await sha256Hex('4321'), '',
    ]);
    expect(row[8]).toBeTruthy();

    const s = await verifyToken(r.token, SECRET);
    expect(s).toMatchObject({ kind: 'studio', sid, email: 'nova@x.com' });
    expect(Object.keys(r).sort()).toEqual(['ownershipStatus', 'spreadsheetId', 'token']);
  });

  it('e-mail comes from the token, never from the request body', async () => {
    const r = await run({ ...P(), googleEmail: 'ana@x.com', loginId: 'evil@x.com', email: 'evil@x.com' });
    expect(contas()[2][0]).toBe('nova@x.com');
    expect(cfgMap(r.spreadsheetId).ADMIN_LOGIN_ID).toBe('nova@x.com');
  });

  it('reports pending ownership when Google only allows a pending owner', async () => {
    setup({ ownership: 'pending' });
    expect((await run(P())).ownershipStatus).toBe('AGUARDANDO_ACEITE');
  });

  it('user text is stored without formula injection', async () => {
    const r = await run({ ...P(), studioNome: '=HYPERLINK("http://x")', profissionalNome: '+Nova', pixChave: '-1' });
    const cfg = cfgMap(r.spreadsheetId);
    expect(cfg.STUDIO_NOME).toBe('\'=HYPERLINK("http://x")');
    expect(cfg.PROFISSIONAL_NOME).toBe("'+Nova");
    expect(cfg.PIX_CHAVE).toBe("'-1");
    expect(contas()[2][1]).toBe("'+Nova");
    expect(contas()[2][2]).toBe('\'=HYPERLINK("http://x")');
  });

  it('connects a custom sheet given as a full URL or a bare id', async () => {
    for (const input of [`https://docs.google.com/spreadsheets/d/${CUSTOM}/edit#gid=0`, CUSTOM]) {
      setup();
      const r = await run({ ...P(), customSheetId: input });
      expect(r.spreadsheetId).toBe(CUSTOM);
      expect(r.ownershipStatus).toBe('PROPRIETARIA');
      expect(fake.calls.some((c) => c.method === 'POST' && c.path === '/v4/spreadsheets')).toBe(false);
      expect(cfgMap(CUSTOM)).toMatchObject({ STUDIO_NOME: 'Studio Nova', ADMIN_LOGIN_ID: 'nova@x.com', ADMIN_PIN_HASH: await sha256Hex('4321') });
      expect(contas()[2].slice(0, 6)).toEqual([
        'nova@x.com', 'Nova Silva', 'Studio Nova', CUSTOM,
        `https://docs.google.com/spreadsheets/d/${CUSTOM}/edit`, `${ORIGIN}/Pagina_Cliente.html?s=${CUSTOM}`,
      ]);
      expect(await verifyToken(r.token, SECRET)).toMatchObject({ kind: 'studio', sid: CUSTOM });
    }
  });

  it('custom sheet without access explains how to share it and registers nothing', async () => {
    fake.fail(403, new RegExp(CUSTOM));
    await expectReject(run({ ...P(), customSheetId: CUSTOM }), UserError,
      'Não foi possível acessar sua planilha. Verifique se clicou no botão Compartilhar na sua planilha e definiu o Acesso Geral para: Qualquer pessoa com o link (Editor)!');
    expect(contas()).toHaveLength(2);
    fake.fail(503, new RegExp(CUSTOM));
    await expectReject(run({ ...P(), customSheetId: CUSTOM }), GoogleError);
    expect(contas()).toHaveLength(2);
  });

  it('onboarding refuses another studio\'s sheet and the master sheet', async () => {
    const msg = 'Esta planilha já pertence a um studio.';
    for (const id of [SID, MASTER, `https://docs.google.com/spreadsheets/d/${SID}/edit`, `https://docs.google.com/spreadsheets/d/${MASTER}/edit#gid=1`]) {
      await expectReject(run({ ...P(), customSheetId: id }), UserError, msg);
    }
    expect(contas()).toHaveLength(2);
    expect(writes()).toHaveLength(0);
    expect(fake.db[SID].Configuracoes).toEqual([['Chave', 'Valor', 'Descricao'], ['STUDIO_NOME', 'Studio Ana', '']]);
  });

  it('invalid custom sheet id is refused', async () => {
    await expectReject(run({ ...P(), customSheetId: 'abc/../../x?y' }), UserError, 'Link ou ID da planilha inválido.');
    expect(writes()).toHaveLength(0);
  });

  it('onboarding with a studio token is 401', async () => {
    for (const session of [{ kind: 'studio', sid: SID, email: 'nova@x.com' }, { kind: 'state', intent: 'onboard' }, { email: 'nova@x.com' }, null, undefined]) {
      ctx.session = session;
      const err = await expectReject(run(P()), AuthError);
      expect(err.status).toBe(401);
    }
    expect(contas()).toHaveLength(2);
    expect(writes()).toHaveLength(0);
  });

  it('refuses an e-mail that already has a studio', async () => {
    ctx.session = { kind: 'pending', email: 'ANA@x.com', name: 'Ana' };
    await expectReject(run(P()), UserError, 'Já existe um Studio com este e-mail. Entre com Google.');
    expect(writes()).toHaveLength(0);
  });

  it('validates fields with the current messages', async () => {
    const cases = [
      [{ studioNome: '' }, 'Preencha Nome do Studio, Seu Nome e WhatsApp!'],
      [{ profissionalNome: '  ' }, 'Preencha Nome do Studio, Seu Nome e WhatsApp!'],
      [{ whatsapp: '' }, 'Preencha Nome do Studio, Seu Nome e WhatsApp!'],
      [{ whatsapp: '99777-888' }, 'WhatsApp inválido: use DDD + número (11 dígitos).'],
      [{ whatsapp: '119977788889' }, 'WhatsApp inválido: use DDD + número (11 dígitos).'],
      [{ pin: '12' }, 'O PIN precisa ter de 4 a 6 números.'],
      [{ pin: 'abcd' }, 'O PIN precisa ter de 4 a 6 números.'],
      [{ pin: '1234567' }, 'O PIN precisa ter de 4 a 6 números.'],
      [{ pin: '123456' }, 'Escolha um PIN diferente de 123456.'],
    ];
    for (const [over, msg] of cases) {
      await expectReject(run({ ...P(), ...over }), UserError, msg);
    }
    expect(writes()).toHaveLength(0);
    // 10 dígitos (fixo) e +55 são aceitos
    setup();
    expect((await run({ ...P(), whatsapp: '1133334444' })).spreadsheetId).toBeTruthy();
    setup();
    const r = await run({ ...P(), whatsapp: '+55 11 99777-8888' });
    expect(cfgMap(r.spreadsheetId).WHATSAPP_STUDIO).toBe('11997778888');
  });
});
