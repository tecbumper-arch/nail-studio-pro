import { describe, it, expect, beforeEach } from 'vitest';
import { createFakeGoogle } from './fakeGoogle.js';
import { createGoogle, resetGoogleTokenCache } from '../src/google.js';
import { adminHandlers as h } from '../src/handlers/admin.js';

const A = 'studio-a';
const B = 'studio-b';
const HEAD = ['ID', 'Data', 'HoraInicio', 'HoraFim', 'ClienteNome', 'ClienteWhatsApp', 'ServicoID', 'ServicoNome', 'Valor', 'MetodoPagamento', 'StatusPagamento', 'StatusReserva', 'CalendarEventID', 'CriadoEm'];

function studioSeed(nome) {
  return {
    Configuracoes: [
      ['Chave', 'Valor', 'Descricao'],
      ['STUDIO_NOME', nome, ''], ['ADMIN_PIN_HASH', 'SECRETPINHASH', ''], ['ADMIN_RECOVERY_HASH', 'SECRETREC', ''],
      ['GCAL_REFRESH_TOKEN', 'SECRETREFRESH', ''], ['GCAL_WEBHOOK_URL', 'SECRETHOOK', ''], ['GCAL_CONNECTED_EMAIL', 'c@x.com', ''],
      ['ADMIN_LOGIN_ID', 'a@x.com', ''], ['INSTAGRAM_STUDIO', '@ana', ''], ['ENDERECO_STUDIO', 'Rua 1', ''],
    ],
    Categorias: [['ID', 'Nome', 'Icone', 'Ordem', 'Ativo'], ['CAT-1', 'Alongamentos', '💅', '1', 'SIM']],
    Catalogo: [
      ['ID', 'Nome', 'Descricao', 'Preco', 'DuracaoMin', 'FotoUrl', 'Categoria', 'Ativo'],
      ['S1', 'Gel', 'd', '100', '60', '', 'Alongamentos', 'SIM'],
    ],
    Agendamentos: [
      HEAD,
      ['AG-1', '2030-01-07', '09:00', '10:00', 'Bia', '5511997778888', 'S1', 'Gel', '100', 'NO_LOCAL', 'PAGAR_NO_STUDIO', 'RESERVADO', 'ev1', ''],
      ['AG-2', '2030-01-08', '10:00', '11:00', 'Cla', '5511911112222', 'S1', 'Gel', '100', 'PIX_TOTAL', 'AGUARDANDO_VALIDACAO_PIX', 'RESERVADO', 'ev2', ''],
    ],
  };
}

let fake, ctx, syncs;
beforeEach(() => {
  resetGoogleTokenCache();
  fake = createFakeGoogle({ [A]: studioSeed('Studio A'), [B]: studioSeed('Studio B') });
  const g = createGoogle({ GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'y', GOOGLE_REFRESH_TOKEN: 'z' }, fake.fetch);
  syncs = [];
  ctx = { env: {}, g, origin: 'https://w.example', waitUntil() {}, session: { sid: A, email: 'a@x.com' } };
});

const cfgOf = (sid) => Object.fromEntries(fake.db[sid].Configuracoes.slice(1).map((r) => [r[0], r[1]]));

describe('admin handlers', () => {
  it('dashboard returns agendamentos sorted newest first', async () => {
    const r = await h.getAdminDashboardData(ctx);
    expect(r.agendamentos.map((x) => x.id)).toEqual(['AG-2', 'AG-1']);
    expect(r.studio.spreadsheetUrl).toContain(A);
    expect(r.studio.loginId).toBe('a@x.com');
    expect(r.categorias).toHaveLength(1);
    expect(r.catalogo).toHaveLength(1);
  });

  it('dashboard never contains ADMIN_PIN_HASH or GCAL_REFRESH_TOKEN', async () => {
    const s = JSON.stringify(await h.getAdminDashboardData(ctx));
    for (const k of ['SECRETPINHASH', 'SECRETREFRESH', 'SECRETREC', 'SECRETHOOK', 'ADMIN_PIN_HASH', 'GCAL_REFRESH_TOKEN']) expect(s).not.toContain(k);
  });

  it('saveSettings keeps ADMIN_PIN_HASH and GCAL_REFRESH_TOKEN untouched', async () => {
    const r = await h.adminSaveSettings(ctx, { nome: 'Novo', profissional: 'P', whatsapp: '(11) 99777-8888', novoPin: '9999', novaPalavraRecuperacao: 'abc', loginId: 'evil@x.com' });
    const c = cfgOf(A);
    expect(c.ADMIN_PIN_HASH).toBe('SECRETPINHASH');
    expect(c.ADMIN_RECOVERY_HASH).toBe('SECRETREC');
    expect(c.GCAL_REFRESH_TOKEN).toBe('SECRETREFRESH');
    expect(c.GCAL_WEBHOOK_URL).toBe('SECRETHOOK');
    expect(c.GCAL_CONNECTED_EMAIL).toBe('c@x.com');
    expect(c.ADMIN_LOGIN_ID).toBe('a@x.com');
    expect(c.INSTAGRAM_STUDIO).toBe('@ana');
    expect(c.STUDIO_NOME).toBe('Novo');
    expect(c.WHATSAPP_STUDIO).toBe('11997778888');
    expect(r.studio.nome).toBe('Novo');
  });

  it('adminSaveService with sid of studio B in args changes only studio A', async () => {
    const before = JSON.stringify(fake.db[B]);
    await h.adminSaveService(ctx, { sid: B, spreadsheetId: B, nome: 'Novo', descricao: '', preco: 50, duracaoMin: 30, fotoUrl: '', categoria: 'Alongamentos' }, B);
    expect(JSON.stringify(fake.db[B])).toBe(before);
    expect(fake.db[A].Catalogo.map((r) => r[1])).toContain('Novo');
  });

  it('adminUpdateBookingStatus CANCELAR_RESERVA sets CANCELADO', async () => {
    const r = await h.adminUpdateBookingStatus(ctx, 'AG-1', 'CANCELAR_RESERVA');
    expect(fake.db[A].Agendamentos[1][11]).toBe('CANCELADO');
    expect(r.agendamentos.find((x) => x.id === 'AG-1').statusReserva).toBe('CANCELADO');
  });

  it('adminUpdateBookingStatus VALIDAR_PIX and CONCLUIR_ATENDIMENTO', async () => {
    await h.adminUpdateBookingStatus(ctx, 'AG-2', 'VALIDAR_PIX');
    expect(fake.db[A].Agendamentos[2].slice(10, 12)).toEqual(['PIX_CONFIRMADO', 'CONFIRMADO']);
    await h.adminUpdateBookingStatus(ctx, 'AG-1', 'CONCLUIR_ATENDIMENTO');
    expect(fake.db[A].Agendamentos[1].slice(10, 12)).toEqual(['PAGO_NO_STUDIO', 'CONCLUIDO']);
  });

  it('category save renames services, delete removes', async () => {
    await h.adminSaveCategory(ctx, { id: 'CAT-1', nome: 'Unhas', icone: '💅', ordem: 1 });
    expect(fake.db[A].Catalogo[1][6]).toBe('Unhas');
    const r = await h.adminSaveCategory(ctx, { nome: 'Spa', icone: '🌸' });
    expect(r.categorias).toHaveLength(2);
    const r2 = await h.adminDeleteCategory(ctx, 'CAT-1');
    expect(r2.categorias.map((c) => c.nome)).toEqual(['Spa']);
  });

  it('toggle and delete service', async () => {
    let r = await h.adminToggleServiceActive(ctx, 'S1');
    expect(r.catalogo[0].ativo).toBe(false);
    r = await h.adminDeleteService(ctx, 'S1');
    expect(r.catalogo).toHaveLength(0);
  });

  it('seed default catalog writes 4 services', async () => {
    const r = await h.adminSeedDefaultCatalog(ctx);
    expect(r.catalogo).toHaveLength(4);
  });

  it('manual booking and block append rows', async () => {
    await h.adminCreateManualBookingOrBlock(ctx, { tipo: 'RESERVA', data: '2030-02-01', horaInicio: '10:00', duracaoMin: 90, clienteNome: 'Zé', clienteWhatsApp: '5511999990000', servicoNome: 'Gel', valor: 80 });
    await h.adminCreateManualBookingOrBlock(ctx, { tipo: 'BLOQUEIO', data: '2030-02-02', horaInicio: '10:00', horaFim: '12:00', motivo: 'Folga' });
    const rows = fake.db[A].Agendamentos;
    expect(rows[3][0]).toMatch(/^AG-/);
    expect(rows[3][3]).toBe('11:30');
    expect(rows[3][5]).toBe('11999990000');
    expect(rows[4][0]).toMatch(/^BLQ-/);
    expect(rows[4][11]).toBe('BLOQUEADO');
  });
});
