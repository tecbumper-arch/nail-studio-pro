import { describe, it, expect, beforeEach } from 'vitest';
import { createFakeGoogle } from './fakeGoogle.js';
import { createGoogle, resetGoogleTokenCache } from '../src/google.js';
import { publicHandlers as h } from '../src/handlers/public.js';
import { normalizeBrPhone } from '../src/util.js';
import { UserError } from '../src/errors.js';

const SID = 'studio-1';
const MASTER = 'master-1';
const HEAD = ['ID', 'Data', 'HoraInicio', 'HoraFim', 'ClienteNome', 'ClienteWhatsApp', 'ServicoID', 'ServicoNome', 'Valor', 'MetodoPagamento', 'StatusPagamento', 'StatusReserva', 'CalendarEventID', 'CriadoEm'];
// 2030-01-07 é segunda-feira; 2030-01-06 é domingo.
const MON = '2030-01-07';
const SUN = '2030-01-06';

function seed() {
  return {
    [MASTER]: { Contas_Manicures: [['Email', 'Profissional', 'Studio', 'SheetId'], ['a@x.com', 'Ana', 'Studio Ana', SID, '', '', '', '', '']] },
    [SID]: {
      Configuracoes: [
        ['Chave', 'Valor', 'Descricao'],
        ['STUDIO_NOME', 'Studio Ana', ''], ['ADMIN_PIN_HASH', 'SECRETPINHASH', ''], ['GCAL_REFRESH_TOKEN', 'SECRETREFRESH', ''],
        ['ADMIN_LOGIN_ID', 'login-secret', ''], ['PIX_CHAVE', '11999998888', ''], ['PIX_RECEBEDOR', 'ANA', ''],
        ['WHATSAPP_STUDIO', '5511988887777', ''], ['HORARIO_INICIO', '09:00', ''], ['HORARIO_FIM', '15:00', ''],
        ['ALMOCO_INICIO', '12:00', ''], ['ALMOCO_FIM', '13:00', ''], ['DIAS_ATENDIMENTO', '1,2,3,4,5', ''], ['INTERVALO_MINUTOS', '60', ''],
      ],
      Categorias: [['ID', 'Nome', 'Icone', 'Ordem', 'Ativo'], ['CAT-1', 'Alongamentos', '💅', '1', 'SIM']],
      Catalogo: [
        ['ID', 'Nome', 'Descricao', 'Preco', 'DuracaoMin', 'FotoUrl', 'Categoria', 'Ativo'],
        ['S1', 'Gel', 'd', '100', '60', '', 'Alongamentos', 'SIM'],
        ['S2', 'Oculto', 'd', '50', '60', '', 'Alongamentos', 'NAO'],
      ],
      Agendamentos: [
        HEAD,
        ['AG-1', MON, '09:00', '10:00', 'Bia', '5511997778888', 'S1', 'Gel', '100', 'NO_LOCAL', 'PAGAR_NO_STUDIO', 'RESERVADO', 'ev1', ''],
        ['AG-2', MON, '10:00', '11:00', 'Cla', '5511911112222', 'S1', 'Gel', '100', 'PIX_SINAL_50', 'AGUARDANDO_VALIDACAO_PIX', 'CANCELADO', 'ev2', ''],
        ['AG-3', '2030-01-08', '09:00', '10:00', 'Bia', '5511997778888', 'S1', 'Gel', '100', 'PIX_TOTAL', 'AGUARDANDO_VALIDACAO_PIX', 'RESERVADO', 'ev3', ''],
      ],
    },
  };
}

let fake, ctx;
beforeEach(() => {
  resetGoogleTokenCache();
  fake = createFakeGoogle(seed());
  const g = createGoogle({ GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'y', GOOGLE_REFRESH_TOKEN: 'z' }, fake.fetch);
  ctx = { env: { MASTER_SPREADSHEET_ID: MASTER }, g, sid: SID, origin: 'https://w.example', waitUntil() {}, now: new Date('2030-01-01T12:00:00Z') };
});

describe('public handlers', () => {
  it('bootstrap returns studio, categorias, catalogo', async () => {
    const r = await h.getPublicBootstrapData(ctx);
    expect(r.studio.nome).toBe('Studio Ana');
    expect(r.studio.pixChave).toBe('11999998888');
    expect(r.categorias).toHaveLength(1);
    expect(r.catalogo.map((s) => s.id)).toEqual(['S1']);
  });

  it('bootstrap never contains ADMIN_PIN_HASH, GCAL_REFRESH_TOKEN, ADMIN_LOGIN_ID or loginId', async () => {
    const s = JSON.stringify(await h.getPublicBootstrapData(ctx));
    for (const bad of ['ADMIN_PIN_HASH', 'SECRETPINHASH', 'GCAL_REFRESH_TOKEN', 'SECRETREFRESH', 'ADMIN_LOGIN_ID', 'login-secret', 'loginId', 'spreadsheetUrl', 'sincronizarAgenda']) {
      expect(s).not.toContain(bad);
    }
  });

  it('rejects an unknown sid', async () => {
    await expect(h.getPublicBootstrapData({ ...ctx, sid: 'nope' })).rejects.toThrow(UserError);
    await expect(h.getPublicBootstrapData({ ...ctx, sid: 'nope' })).rejects.toThrow('Studio não encontrado.');
  });

  it('slots skip lunch, non-working days and booked times', async () => {
    const slots = await h.getAvailableSlotsForDate(ctx, MON, 'S1');
    const free = slots.filter((s) => s.disponivel).map((s) => s.horaInicio);
    expect(free).toEqual(['10:00', '11:00', '13:00', '14:00']); // 09:00 ocupado, 12:00 almoço, 10:00 cancelado volta
    expect(slots.find((s) => s.horaInicio === '12:00').disponivel).toBe(false);
    expect(await h.getAvailableSlotsForDate(ctx, SUN, 'S1')).toEqual([]);
  });

  it('slots hide past times today using America/Sao_Paulo clock', async () => {
    // 2030-01-07 14:00 UTC = 11:00 em São Paulo (UTC-3) -> corte 11:15
    const c = { ...ctx, now: new Date('2030-01-07T14:00:00Z') };
    const slots = await h.getAvailableSlotsForDate(c, MON, 'S1');
    expect(slots.find((s) => s.horaInicio === '10:00')).toMatchObject({ disponivel: false, motivo: 'PASSOU' });
    expect(slots.find((s) => s.horaInicio === '11:00')).toMatchObject({ disponivel: false, motivo: 'PASSOU' });
    expect(slots.find((s) => s.horaInicio === '13:00').disponivel).toBe(true);
    // 2030-01-08 01:00 UTC ainda é 07/01 22:00 em SP: hoje = 07/01
    const late = { ...ctx, now: new Date('2030-01-08T01:00:00Z') };
    const s2 = await h.getAvailableSlotsForDate(late, MON, 'S1');
    expect(s2.every((s) => !s.disponivel)).toBe(true);
  });

  it('createCustomerBooking appends a 14-column row and returns pixCopiaECola for PIX_SINAL_50 with half price', async () => {
    const r = await h.createCustomerBooking(ctx, {
      data: MON, horaInicio: '13:00', servicoId: 'S1', clienteNome: 'Dani', clienteWhatsApp: '(11) 95555-4444', metodoPagamento: 'PIX_SINAL_50',
    });
    expect(r.success).toBe(true);
    expect(r.reserva.valorTotal).toBe(100);
    expect(r.reserva.valorCobradoAgora).toBe(50);
    expect(r.reserva.statusPagamento).toBe('AGUARDANDO_VALIDACAO_PIX');
    expect(r.reserva.pixCopiaECola).toContain('540550.00');
    expect(r.reserva.whatsappStudio).toBe('5511988887777');
    const rows = fake.db[SID].Agendamentos;
    const row = rows[rows.length - 1];
    expect(row).toHaveLength(14);
    expect(row[0]).toBe(r.reserva.id);
    expect(row[5]).toBe('5511955554444');
    expect(row[11]).toBe('RESERVADO');
  });

  it('createCustomerBooking rejects a slot taken after slots were listed', async () => {
    const slots = await h.getAvailableSlotsForDate(ctx, MON, 'S1');
    expect(slots.find((s) => s.horaInicio === '13:00').disponivel).toBe(true);
    fake.db[SID].Agendamentos.push(['AG-9', MON, '13:00', '14:00', 'Eva', '5511900000000', 'S1', 'Gel', '100', 'NO_LOCAL', 'PAGAR_NO_STUDIO', 'RESERVADO', 'e', '']);
    const before = fake.db[SID].Agendamentos.length;
    await expect(h.createCustomerBooking(ctx, {
      data: MON, horaInicio: '13:00', servicoId: 'S1', clienteNome: 'Dani', clienteWhatsApp: '11955554444', metodoPagamento: 'NO_LOCAL',
    })).rejects.toThrow(/indisponível/);
    expect(fake.db[SID].Agendamentos.length).toBe(before);
  });

  it('getClientBookingsByPhone matches any phone format', async () => {
    const ids = async (p) => (await h.getClientBookingsByPhone(ctx, p)).map((b) => b.id);
    const a = await ids('(11) 99777-8888');
    expect(a).toEqual(['AG-3', 'AG-1']);
    expect(await ids('11997778888')).toEqual(a);
    expect(await ids('5511997778888')).toEqual(a);
    expect(await ids('123')).toEqual([]);
    const withPix = (await h.getClientBookingsByPhone(ctx, '11997778888'))[0];
    expect(withPix.pixCopiaECola).toMatch(/^000201/);
  });

  it('cancelCustomerBooking only cancels a booking whose phone matches', async () => {
    await expect(h.cancelCustomerBooking(ctx, 'AG-1', '11 90000-1111')).rejects.toThrow('Reserva não localizada.');
    await expect(h.cancelCustomerBooking(ctx, 'AG-1', '')).rejects.toThrow(UserError);
    expect(fake.db[SID].Agendamentos[1][11]).toBe('RESERVADO');
    expect(await h.cancelCustomerBooking(ctx, 'AG-1', '(11) 99777-8888')).toEqual({ success: true });
    expect(fake.db[SID].Agendamentos[1][11]).toBe('CANCELADO');
  });

  it('notifyPixPaidByCustomer marks the booking', async () => {
    expect(await h.notifyPixPaidByCustomer(ctx, 'AG-3')).toEqual({ success: true });
    expect(fake.db[SID].Agendamentos[3][10]).toBe('CLIENTE_INFORMOU_PIX');
  });
});

describe('normalizeBrPhone', () => {
  it('returns local digits without country code', () => {
    expect(normalizeBrPhone('+55 (11) 99777-8888')).toBe('11997778888');
    expect(normalizeBrPhone('11997778888')).toBe('11997778888');
  });
});
