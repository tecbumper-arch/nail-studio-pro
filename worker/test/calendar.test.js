import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeGoogle } from './fakeGoogle.js';
import { createGoogle, resetGoogleTokenCache } from '../src/google.js';
import { publicHandlers as pub } from '../src/handlers/public.js';
import { adminHandlers as adm } from '../src/handlers/admin.js';
import { calendarHandlers as cal, syncCalendar } from '../src/calendar.js';

const SID = 'studio-1';
const MASTER = 'master-1';
const MON = '2030-01-07';
const HEAD = ['ID', 'Data', 'HoraInicio', 'HoraFim', 'ClienteNome', 'ClienteWhatsApp', 'ServicoID', 'ServicoNome', 'Valor', 'MetodoPagamento', 'StatusPagamento', 'StatusReserva', 'CalendarEventID', 'CriadoEm'];

function seed(cfg) {
  return {
    [MASTER]: { Contas_Manicures: [['Email', 'Profissional', 'Studio', 'SheetId'], ['a@x.com', 'Ana', 'Studio Ana', SID]] },
    [SID]: {
      Configuracoes: [
        ['Chave', 'Valor', 'Descricao'],
        ['STUDIO_NOME', 'Studio Ana', ''], ['ADMIN_LOGIN_ID', 'login@x.com', ''],
        ['HORARIO_INICIO', '09:00', ''], ['HORARIO_FIM', '15:00', ''], ['DIAS_ATENDIMENTO', '1,2,3,4,5', ''],
        ...cfg,
      ],
      Categorias: [['ID', 'Nome', 'Icone', 'Ordem', 'Ativo'], ['CAT-1', 'Alongamentos', '💅', '1', 'SIM']],
      Catalogo: [
        ['ID', 'Nome', 'Descricao', 'Preco', 'DuracaoMin', 'FotoUrl', 'Categoria', 'Ativo'],
        ['S1', 'Gel', 'd', '100', '60', '', 'Alongamentos', 'SIM'],
      ],
      Agendamentos: [HEAD],
    },
  };
}

const OAUTH = [['GCAL_REFRESH_TOKEN', 'SECRETREFRESH', ''], ['GCAL_CONNECTED_EMAIL', 'c@x.com', '']];
let fake, g;
function setup(cfg) {
  resetGoogleTokenCache();
  fake = createFakeGoogle(seed(cfg));
  g = createGoogle({ GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'y', GOOGLE_REFRESH_TOKEN: 'z' }, fake.fetch);
}
const pubCtx = () => ({ env: { MASTER_SPREADSHEET_ID: MASTER }, g, sid: SID, origin: 'https://w', waitUntil() {}, now: new Date('2030-01-01T12:00:00Z') });
const admCtx = () => ({ env: {}, g, origin: 'https://w', waitUntil() {}, session: { sid: SID, email: 'a@x.com' } });
const book = (ctx) => pub.createCustomerBooking(ctx, { data: MON, horaInicio: '09:00', servicoId: 'S1', metodoPagamento: 'NO_LOCAL', clienteNome: 'Bia', clienteWhatsApp: '11997778888' });
const eventCalls = (method) => fake.calls.filter((c) => c.method === method && c.path.startsWith('/calendar/v3/calendars/primary/events'));
const cfgOf = () => Object.fromEntries(fake.db[SID].Configuracoes.slice(1).map((r) => [r[0], r[1]]));

describe('calendar sync', () => {
  beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}));

  it('booking creates an event and stores its id in column 13', async () => {
    setup(OAUTH);
    await book(pubCtx());
    const posts = eventCalls('POST');
    expect(posts).toHaveLength(1);
    expect(posts[0].body.start).toEqual({ dateTime: `${MON}T09:00:00`, timeZone: 'America/Sao_Paulo' });
    expect(posts[0].body.end).toEqual({ dateTime: `${MON}T10:00:00`, timeZone: 'America/Sao_Paulo' });
    expect(posts[0].body.summary).toContain('Gel');
    expect(fake.db[SID].Agendamentos[1][12]).toMatch(/^fake-event-/);
  });

  it('cancel deletes the stored event', async () => {
    setup(OAUTH);
    await book(pubCtx());
    const evId = fake.db[SID].Agendamentos[1][12];
    const id = fake.db[SID].Agendamentos[1][0];
    await pub.cancelCustomerBooking(pubCtx(), id, '11997778888');
    expect(eventCalls('DELETE').map((c) => c.path)).toEqual([`/calendar/v3/calendars/primary/events/${evId}`]);
    expect(fake.db[SID].Agendamentos[1][11]).toBe('CANCELADO');
    expect(fake.db[SID].Agendamentos[1][12]).toBe('DELETED_' + evId);
  });

  it('no calendar configured → booking still succeeds', async () => {
    setup([]);
    const r = await book(pubCtx());
    expect(r.success).toBe(true);
    expect(eventCalls('POST')).toHaveLength(0);
    expect(fake.db[SID].Agendamentos[1][12]).toMatch(/^GCAL-/);
  });

  it('calendar API 500 → booking still succeeds', async () => {
    setup(OAUTH);
    fake.fail(500, /\/calendar\//);
    const r = await book(pubCtx());
    expect(r.success).toBe(true);
    expect(fake.db[SID].Agendamentos[1][12]).toMatch(/^GCAL-/);
    await expect(syncCalendar(pubCtx(), 'CREATE', { id: 'x', data: MON, horaInicio: '09:00', horaFim: '10:00' })).resolves.toBeNull();
  });

  it('token refresh failure never throws and warns without secrets', async () => {
    setup(OAUTH);
    fake.fail(401, /^\/token$/);
    const r = await syncCalendar(pubCtx(), 'CREATE', { id: 'x', data: MON, horaInicio: '09:00', horaFim: '10:00' });
    expect(r).toBeNull();
    expect(JSON.stringify(console.warn.mock.calls)).not.toContain('SECRETREFRESH');
  });

  it('webhook mode posts to script.google.com and returns its event id', async () => {
    setup([['GCAL_WEBHOOK_URL', 'https://script.google.com/macros/s/abc/exec', '']]);
    const r = await syncCalendar(pubCtx(), 'CREATE', { id: 'x', data: MON, horaInicio: '09:00', horaFim: '10:00' });
    expect(r.eventId).toMatch(/^hook-event-/);
    expect(fake.calls.some((c) => c.path === '/macros/s/abc/exec')).toBe(true);
    expect(eventCalls('POST')).toHaveLength(0);
  });

  it('webhook not on script.google.com is ignored', async () => {
    setup([['GCAL_WEBHOOK_URL', 'https://evil.example/hook', '']]);
    const r = await syncCalendar(pubCtx(), 'CREATE', { id: 'x', data: MON, horaInicio: '09:00', horaFim: '10:00' });
    expect(r).toBeNull();
    expect(fake.calls.some((c) => c.path === '/hook')).toBe(false);
  });
});

describe('calendar handlers', () => {
  it('status never returns the refresh token', async () => {
    setup([...OAUTH, ['GCAL_WEBHOOK_URL', 'https://script.google.com/macros/s/abc/exec', '']]);
    const st = await cal.adminGetGcalStatus(admCtx());
    expect(st).toEqual({ connected: true, mode: 'oauth', connectedEmail: 'c@x.com' });
    const s = JSON.stringify(st);
    expect(s).not.toContain('SECRETREFRESH');
    expect(s).not.toContain('script.google.com');
  });

  it('status: webhook, none, and email falls back to login id', async () => {
    setup([['GCAL_WEBHOOK_URL', 'https://script.google.com/macros/s/abc/exec', '']]);
    expect(await cal.adminGetGcalStatus(admCtx())).toEqual({ connected: true, mode: 'webhook', connectedEmail: 'login@x.com' });
    setup([]);
    expect(await cal.adminGetGcalStatus(admCtx())).toMatchObject({ connected: false, mode: '' });
  });

  it('saveGcalWebhook rejects a non script.google.com URL', async () => {
    setup([]);
    const before = JSON.stringify(fake.db[SID].Configuracoes);
    await expect(cal.adminSaveGcalWebhook(admCtx(), { webhookUrl: 'https://evil.example/x' })).rejects.toThrow(/script\.google\.com/);
    expect(JSON.stringify(fake.db[SID].Configuracoes)).toBe(before);
  });

  it('saveGcalWebhook stores a valid URL and disconnect clears everything', async () => {
    setup(OAUTH);
    const url = 'https://script.google.com/macros/s/abc/exec';
    expect(await cal.adminSaveGcalWebhook(admCtx(), { webhookUrl: url })).toEqual({ success: true });
    expect(cfgOf().GCAL_WEBHOOK_URL).toBe(url);
    expect(cfgOf().GCAL_REFRESH_TOKEN).toBe('SECRETREFRESH');
    expect(await cal.adminDisconnectGcal(admCtx())).toEqual({ success: true });
    const c = cfgOf();
    expect([c.GCAL_REFRESH_TOKEN, c.GCAL_CONNECTED_EMAIL, c.GCAL_WEBHOOK_URL]).toEqual(['', '', '']);
    expect(c.STUDIO_NOME).toBe('Studio Ana');
  });

  it('testGcal creates then deletes an event; fails when not connected', async () => {
    setup(OAUTH);
    expect(await cal.adminTestGcal(admCtx())).toEqual({ success: true });
    expect(eventCalls('POST')).toHaveLength(1);
    expect(eventCalls('DELETE')).toHaveLength(1);
    setup([]);
    expect(await cal.adminTestGcal(admCtx())).toEqual({ success: false });
  });
});
