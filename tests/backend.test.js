'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createGas, formatDate, DATA_SCOPES, CAL_SCOPE } = require('./gas-mock');

const CLIENT_ID = 'web-client.apps.googleusercontent.com';

function todayIso() { return formatDate(new Date(), 'America/Sao_Paulo', 'yyyy-MM-dd'); }
function addDays(iso, n) { const [y, m, d] = iso.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return t.toISOString().slice(0, 10); }
/** Próximo dia útil (seg-sáb) a pelo menos 2 dias de hoje. */
function nextWorkday(minAhead = 2) {
  let d = addDays(todayIso(), minAhead);
  while (new Date(d + 'T12:00:00Z').getUTCDay() === 0) d = addDays(d, 1);
  return d;
}

function setupGas() {
  const gas = createGas();
  gas.props.GOOGLE_CLIENT_ID = CLIENT_ID;
  gas.props.GOOGLE_CLIENT_SECRET = 'secret';
  gas.context.setup();
  return gas;
}

/** 1º acesso: login + autorização (planilha e arquivos do app) na conta dela. */
function signUp(gas, email = 'ana@gmail.com', scope = DATA_SCOPES) {
  const idToken = gas.google.issueIdToken(email, CLIENT_ID, 'Ana');
  const first = gas.ok('authGoogle', { idToken });
  assert.strictEqual(first.needsOnboarding, true);
  const code = gas.google.issueCode(email, { scope });
  const created = gas.ok('createStudio', { signupToken: first.signupToken, code, redirectUri: 'postmessage', studioNome: 'Studio Ana', profissionalNome: 'Ana', whatsapp: '11988887777', pixChave: '11988887777' });
  return created;
}

/**
 * Studio do app ANTIGO: planilha criada e acessada pela conta do servidor.
 * owner: 'servidor' (criada pelo app) ou o e-mail dela (ela aceitou a propriedade; servidor ficou como editor).
 */
function legacyStudio(gas, email = 'ana@gmail.com', owner = 'servidor') {
  const c = gas.context;
  const ss = c.SpreadsheetApp.create('Studio Antigo');
  ss.getSheets()[0].setName(c.TAB_CONFIG);
  const ctx = { ss, sheetId: ss.getId(), tz: 'America/Sao_Paulo', cfg: {}, email };
  const now = '2026-01-05 10:00:00';
  c.writeTable_(ss.getSheetByName(c.TAB_CONFIG), [['Chave', 'Valor', 'Descricao']].concat(c.defaultConfigRows_(email, { studioNome: 'Studio Antigo', profissionalNome: 'Ana', whatsapp: '11988887777', pixChave: '11988887777' }, now)));
  c.writeTable_(ss.insertSheet(c.TAB_CATS), [c.CATS_HEADER].concat(c.DEFAULT_CATS));
  c.writeTable_(ss.insertSheet(c.TAB_CATALOG), [c.CATALOG_HEADER].concat(c.DEFAULT_SERVICES));
  c.writeTable_(ss.insertSheet(c.TAB_BOOKINGS), [c.BOOKING_HEADER]);
  c.writeTable_(ss.insertSheet(c.TAB_LOGS), [['Timestamp', 'Evento', 'Detalhes']]);
  if (owner === 'servidor') ss.addEditor(email);
  else { ss.owner = owner; ss.addEditor(gas.SERVER); }
  c.registerStudio_(email, ss.getId(), {}, 'Ana', 'Studio Antigo');
  return ss;
}

function login(gas, email = 'ana@gmail.com') {
  return gas.ok('authGoogle', { idToken: gas.google.issueIdToken(email, CLIENT_ID) });
}

test('nenhum segredo aparece nos HTMLs públicos', () => {
  const fs = require('fs');
  const path = require('path');
  for (const f of ['App_Manicure.html', 'Pagina_Cliente.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(!/clientSecret|refreshToken\s*:|client_secret/.test(html), f + ' ainda contém segredo');
    assert.ok(!html.includes('ZkFEcTZ6NENYczhCTG0x'), f + ' contém client secret ofuscado');
  }
});

test('login Google: 1º acesso cria studio, 2º acesso entra direto', () => {
  const gas = setupGas();
  const created = signUp(gas);
  assert.ok(created.session);
  assert.strictEqual(created.isNew, true);
  const ss = gas.spreadsheets[created.spreadsheetId];
  // A planilha é DELA: dona, sem ninguém mais no compartilhamento, e o servidor não consegue abrir
  assert.strictEqual(ss.owner, 'ana@gmail.com');
  assert.deepStrictEqual(ss.editors, []);
  assert.strictEqual(gas.serverCanOpen(ss.id), false);
  const appFolder = gas.drive.folders[ss.parent];
  assert.strictEqual(appFolder.name, 'Nail Studio Pro');
  assert.strictEqual(appFolder.owner, 'ana@gmail.com');
  assert.ok(Object.values(gas.spreadsheets).every(x => x.owner !== gas.SERVER || x.id === gas.props.MASTER_SPREADSHEET_ID), 'servidor não criou planilha de studio');

  const again = login(gas);
  assert.ok(again.session);
  assert.strictEqual(again.spreadsheetId, created.spreadsheetId);
  assert.strictEqual(again.dadosNaConta, true);

  const dash = gas.ok('getAdminDashboardData', {}, again.session);
  assert.strictEqual(dash.studio.nome, 'Studio Ana');
  assert.strictEqual(dash.catalogo.length, 4);
  assert.ok(!JSON.stringify(dash).includes('ADMIN_PIN_HASH'));
});

test('login Google rejeita token de outro app (aud diferente) e token falso', () => {
  const gas = setupGas();
  const bad = gas.call('authGoogle', { idToken: gas.google.issueIdToken('x@gmail.com', 'outro-app') });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.error, /client ID/);
  const fake = gas.call('authGoogle', { idToken: 'ANDROID_OS_VERIFIED_xyz' });
  assert.strictEqual(fake.ok, false);
});

test('sessão adulterada ou revogada é recusada', () => {
  const gas = setupGas();
  const { session } = signUp(gas);
  const tampered = session.slice(0, -3) + 'abc';
  assert.strictEqual(gas.call('getAdminDashboardData', {}, tampered).ok, false);
  assert.strictEqual(gas.call('getAdminDashboardData', {}, undefined).ok, false);
  gas.ok('adminLogoutAllDevices', {}, session);
  const r = gas.call('getAdminDashboardData', {}, session);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /sessão expirou/i);
});

test('PIN: define, entra, bloqueia após 5 erros', () => {
  const gas = setupGas();
  const { session } = signUp(gas);
  assert.strictEqual(gas.call('authPin', { email: 'ana@gmail.com', pin: '1234' }).ok, false, 'sem PIN definido não entra');
  gas.ok('adminSaveSettings', { novoPin: '4321' }, session);
  assert.ok(gas.ok('authPin', { email: 'ANA@gmail.com', pin: '4321' }).session);
  for (let i = 0; i < 5; i++) assert.strictEqual(gas.call('authPin', { email: 'ana@gmail.com', pin: '0000' }).ok, false);
  const blocked = gas.call('authPin', { email: 'ana@gmail.com', pin: '4321' });
  assert.match(blocked.error, /Muitas tentativas/);
});

test('página pública não lê planilhas que não são studios cadastrados', () => {
  const gas = setupGas();
  signUp(gas);
  const r = gas.call('getPublicBootstrapData', { s: gas.props.MASTER_SPREADSHEET_ID });
  assert.strictEqual(r.ok, false);
});

test('agendamento da cliente + trava contra agendamento duplo + Pix', () => {
  const gas = setupGas();
  const { spreadsheetId: s } = signUp(gas);
  const day = nextWorkday();
  const pub = gas.ok('getPublicBootstrapData', { s });
  assert.ok(!('loginId' in pub.studio));
  const slots = gas.ok('getAvailableSlotsForDate', { s, date: day, serviceId: 'SRV-104' });
  assert.ok(slots.find(x => x.horaInicio === '09:00' && x.disponivel));
  assert.ok(slots.find(x => x.horaInicio === '12:00' && !x.disponivel), 'almoço bloqueado');

  const res = gas.ok('createCustomerBooking', { s, servicoId: 'SRV-104', data: day, horaInicio: '09:00', clienteNome: 'Bia', clienteWhatsApp: '(21) 97777-6666', metodoPagamento: 'PIX_SINAL_50' });
  assert.strictEqual(res.reserva.valorCobradoAgora, 35);
  assert.match(res.reserva.pixCopiaECola, /^000201.*br\.gov\.bcb\.pix.*6304[0-9A-F]{4}$/);

  const dup = gas.call('createCustomerBooking', { s, servicoId: 'SRV-104', data: day, horaInicio: '09:00', clienteNome: 'Carla', clienteWhatsApp: '21966665555', metodoPagamento: 'NO_LOCAL' });
  assert.strictEqual(dup.ok, false);
  assert.match(dup.error, /acabou de ser preenchido/);

  const mine = gas.ok('getClientBookingsByPhone', { s, phone: '21977776666' });
  assert.strictEqual(mine.length, 1);
  gas.ok('notifyPixPaidByCustomer', { s, id: res.reserva.id, phone: '21977776666' });
  assert.strictEqual(gas.call('cancelCustomerBooking', { s, id: res.reserva.id, phone: '21900000000' }).ok, false, 'outro telefone não cancela');
  gas.ok('cancelCustomerBooking', { s, id: res.reserva.id, phone: '21977776666' });
  const after = gas.ok('getAvailableSlotsForDate', { s, date: day, serviceId: 'SRV-104' });
  assert.ok(after.find(x => x.horaInicio === '09:00').disponivel, 'horário liberado após cancelamento');
});

test('regras: janela máxima, dia fechado, data no passado', () => {
  const gas = setupGas();
  const { spreadsheetId: s, session } = signUp(gas);
  gas.ok('adminSaveSettings', { janelaMaxDias: 5 }, session);
  assert.deepStrictEqual(gas.ok('getAvailableSlotsForDate', { s, date: addDays(todayIso(), 20), serviceId: 'SRV-104' }), []);
  assert.deepStrictEqual(gas.ok('getAvailableSlotsForDate', { s, date: addDays(todayIso(), -1), serviceId: 'SRV-104' }), []);
  let sunday = addDays(todayIso(), 1);
  while (new Date(sunday + 'T12:00:00Z').getUTCDay() !== 0) sunday = addDays(sunday, 1);
  assert.deepStrictEqual(gas.ok('getAvailableSlotsForDate', { s, date: sunday, serviceId: 'SRV-104' }), []);
});

test('Google Agenda: conectar, evento criado/movido/apagado, compromisso pessoal bloqueia horário', () => {
  const gas = setupGas();
  const { spreadsheetId: s, session } = signUp(gas);
  const day = nextWorkday();

  // reserva antes de conectar -> é sincronizada ao conectar
  const r1 = gas.ok('createCustomerBooking', { s, servicoId: 'SRV-104', data: day, horaInicio: '09:00', clienteNome: 'Bia', clienteWhatsApp: '21977776666', metodoPagamento: 'NO_LOCAL' });
  const dash = gas.ok('gcalConnect', { code: gas.google.issueCode('ana@gmail.com'), redirectUri: 'postmessage' }, session);
  assert.strictEqual(dash.gcal.connected, true);
  assert.strictEqual(dash.gcal.email, 'ana@gmail.com');
  assert.strictEqual(dash.synced, 1);
  assert.strictEqual(gas.google.events['ana@gmail.com'].length, 1);
  assert.ok(!JSON.stringify(dash).includes('rt-'), 'refresh token nunca vai para o app');

  // nova reserva entra na agenda
  gas.ok('createCustomerBooking', { s, servicoId: 'SRV-103', data: day, horaInicio: '15:00', clienteNome: 'Carla', clienteWhatsApp: '21966665555', metodoPagamento: 'NO_LOCAL' });
  assert.strictEqual(gas.google.events['ana@gmail.com'].length, 2);

  // reagendar move o evento
  gas.ok('adminRescheduleBooking', { id: r1.reserva.id, data: day, horaInicio: '10:00' }, session);
  const moved = gas.google.events['ana@gmail.com'].find(e => e.extendedProperties.private.nailBookingId === r1.reserva.id);
  assert.strictEqual(moved.start.dateTime, day + 'T10:00:00');

  // cancelar apaga o evento
  gas.ok('adminUpdateBookingStatus', { id: r1.reserva.id, action: 'CANCELAR_RESERVA' }, session);
  assert.strictEqual(gas.google.events['ana@gmail.com'].length, 1);

  // compromisso pessoal (dentista 16h-17h) bloqueia horário na página da cliente
  gas.google.addPersonalEvent('ana@gmail.com', { summary: 'Dentista', start: { dateTime: day + 'T16:00:00-03:00' }, end: { dateTime: day + 'T17:00:00-03:00' } });
  gas.clearCache();
  const slots = gas.ok('getAvailableSlotsForDate', { s, date: day, serviceId: 'SRV-104' });
  assert.strictEqual(slots.find(x => x.horaInicio === '16:00').disponivel, false);
  assert.strictEqual(slots.find(x => x.horaInicio === '17:00').disponivel, true);
  assert.strictEqual(slots.find(x => x.horaInicio === '15:00').disponivel, false, 'reserva própria continua ocupando');

  // a permissão nova SOMOU a agenda à de planilha/arquivos (não perdeu acesso aos dados)
  assert.match(gas.props['UTOK_' + s], /spreadsheets/);
  assert.match(gas.props['UTOK_' + s], /calendar\.events/);

  // teste e desconexão: só desliga a agenda (a mesma permissão guarda os dados dela)
  gas.ok('gcalTest', {}, session);
  const off = gas.ok('gcalDisconnect', {}, session);
  assert.strictEqual(off.gcal.connected, false);
  assert.strictEqual(gas.google.revoked.length, 0);
  const n = gas.google.events['ana@gmail.com'].length;
  gas.ok('createCustomerBooking', { s, servicoId: 'SRV-104', data: day, horaInicio: '17:00', clienteNome: 'Eva', clienteWhatsApp: '21944443333', metodoPagamento: 'NO_LOCAL' });
  assert.strictEqual(gas.google.events['ana@gmail.com'].length, n, 'agenda desligada não recebe eventos');
  assert.ok(gas.ok('getAdminDashboardData', {}, session).agendamentos.some(b => b.clienteNome === 'Eva'), 'dados continuam acessíveis');
});

test('Google Agenda: sem refresh_token pede para tocar de novo; sem permissão marcada dá erro claro', () => {
  const gas = setupGas();
  const { session } = signUp(gas);
  const noScope = gas.call('gcalConnect', { code: gas.google.issueCode('ana@gmail.com', { scope: 'openid email' }), redirectUri: 'postmessage' }, session);
  assert.match(noScope.error, /permissão/);
  const noRt = gas.call('gcalConnect', { code: gas.google.issueCode('ana@gmail.com', { withRefresh: false }), redirectUri: 'postmessage' }, session);
  assert.strictEqual(noRt.ok, false);
  assert.match(noRt.error, /mais uma vez/);
  assert.strictEqual(gas.google.revoked.length, 0, 'não revoga: ela continuaria sem acesso aos próprios dados');
  assert.ok(gas.ok('getAdminDashboardData', {}, session).catalogo.length, 'dados continuam acessíveis');
  // 2ª tentativa (o app pede com prompt=consent) → vem o refresh_token
  const ok = gas.ok('gcalConnect', { code: gas.google.issueCode('ana@gmail.com'), redirectUri: 'postmessage' }, session);
  assert.strictEqual(ok.gcal.connected, true);
});

test('ela remove o acesso do app no Google: nada se perde e ela reconecta de onde parou', () => {
  const gas = setupGas();
  const { spreadsheetId: s, session } = signUp(gas, 'ana@gmail.com', DATA_SCOPES + ' ' + CAL_SCOPE);
  const day = nextWorkday();
  const r = gas.ok('createCustomerBooking', { s, servicoId: 'SRV-104', data: day, horaInicio: '11:00', clienteNome: 'Bia', clienteWhatsApp: '21977776666', metodoPagamento: 'NO_LOCAL' });

  gas.google.revokeAll('ana@gmail.com'); // myaccount.google.com/permissions → remover acesso
  gas.clearCache();

  // página da cliente avisa (sem expor nada) em vez de quebrar
  const pub = gas.call('getPublicBootstrapData', { s });
  assert.strictEqual(pub.ok, false);
  assert.match(pub.error, /temporariamente indisponível/);
  // sessão aberta no celular dela pede para reconectar
  const dash = gas.call('getAdminDashboardData', {}, session);
  assert.strictEqual(dash.code, 'CONTA_DESCONECTADA');
  assert.ok(dash.info.reauthToken);
  // login de novo também leva à reconexão
  const li = login(gas);
  assert.strictEqual(li.needsReauth, true);
  // outra conta não pode reconectar o Studio dela
  const wrong = gas.call('reconnectAccount', { reauthToken: li.reauthToken, code: gas.google.issueCode('intrusa@gmail.com', { scope: DATA_SCOPES }), redirectUri: 'postmessage' });
  assert.strictEqual(wrong.ok, false);

  const back = gas.ok('reconnectAccount', { reauthToken: li.reauthToken, code: gas.google.issueCode('ana@gmail.com', { scope: DATA_SCOPES + ' ' + CAL_SCOPE }), redirectUri: 'postmessage' });
  assert.strictEqual(back.spreadsheetId, s);
  const d2 = gas.ok('getAdminDashboardData', {}, back.session);
  assert.ok(d2.agendamentos.some(b => b.id === r.reserva.id), 'reservas preservadas');
  assert.strictEqual(d2.gcal.connected, true);
  assert.ok(gas.ok('getPublicBootstrapData', { s }).catalogo.length > 0);
});

test('admin: catálogo, categorias, bloqueio de férias, faltou, encaixe e feed ICS', () => {
  const gas = setupGas();
  const { spreadsheetId: s, session } = signUp(gas);
  let d = gas.ok('adminSaveService', { nome: 'Esmaltação em Gel', preco: 55, duracaoMin: 45, categoria: 'Manicure & Pedicure', descricao: '=HACK()' }, session);
  const srv = d.catalogo.find(x => x.nome === 'Esmaltação em Gel');
  assert.ok(srv);
  assert.strictEqual(srv.descricao, 'HACK()', 'remove fórmula');
  d = gas.ok('adminToggleServiceActive', { id: srv.id }, session);
  assert.strictEqual(d.catalogo.find(x => x.id === srv.id).ativo, false);
  d = gas.ok('adminDeleteService', { id: srv.id }, session);
  assert.ok(!d.catalogo.find(x => x.id === srv.id));

  d = gas.ok('adminSaveCategory', { nome: 'Pés', icone: '🦶' }, session);
  const cat = d.categorias.find(c => c.nome === 'Pés');
  d = gas.ok('adminDeleteCategory', { id: cat.id }, session);
  assert.ok(!d.categorias.find(c => c.nome === 'Pés'));

  const day = nextWorkday(3);
  gas.ok('adminBlockDateRange', { de: day, ate: addDays(day, 2), motivo: 'Férias' }, session);
  assert.ok(gas.ok('getAvailableSlotsForDate', { s, date: day, serviceId: 'SRV-104' }).every(x => !x.disponivel));

  const day2 = nextWorkday(8);
  d = gas.ok('adminCreateManualBookingOrBlock', { tipo: 'ENCAIXE', data: day2, horaInicio: '14:00', clienteNome: 'Duda', clienteWhatsApp: '11955554444', servicoId: 'SRV-101' }, session);
  const enc = d.agendamentos.find(b => b.clienteNome === 'Duda');
  assert.strictEqual(enc.horaFim, '16:00');
  d = gas.ok('adminUpdateBookingStatus', { id: enc.id, action: 'FALTOU' }, session);
  assert.strictEqual(d.agendamentos.find(b => b.id === enc.id).statusReserva, 'FALTOU');

  const token = d.icsUrl.split('?ics=')[1];
  const ics = gas.context.doGet({ parameter: { ics: token } }).getContent();
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /Férias/);
  const bad = gas.context.doGet({ parameter: { ics: s + '.forjado' } }).getContent();
  assert.match(bad, /inválido/);
});

test('resumo diário por e-mail só para quem ativou', () => {
  const gas = setupGas();
  const { session } = signUp(gas);
  gas.context.enviarResumosDiarios();
  assert.strictEqual(gas.mails.length, 0);
  gas.ok('adminSaveSettings', { resumoDiario: true }, session);
  gas.context.enviarResumosDiarios();
  assert.strictEqual(gas.mails.length, 1);
  assert.strictEqual(gas.mails[0].to, 'ana@gmail.com');
});

test('planilha antiga (datas/horas convertidas pelo Sheets) continua funcionando', () => {
  const gas = setupGas();
  const { spreadsheetId: s, session } = signUp(gas);
  const ss = gas.spreadsheets[s];
  const sh = ss.getSheetByName('Agendamentos');
  const day = nextWorkday();
  const [y, m, dd] = day.split('-').map(Number);
  // Como o Sheets guarda quando grava com USER_ENTERED: Date para a data, Date 1899 para a hora, número para o telefone
  sh.data.push(['AG-OLD1', new Date(Date.UTC(y, m - 1, dd, 3)), new Date(Date.UTC(1899, 11, 30, 12, 6, 28)), new Date(Date.UTC(1899, 11, 30, 13, 6, 28)), 'Legada', 5511944443333, 'SRV-104', 'Pé e Mão', 70, 'NO_LOCAL', 'PAGAR_NO_STUDIO', 'RESERVADO', 'GCAL-AG-OLD1', '01/01/2026']);
  const slots = gas.ok('getAvailableSlotsForDate', { s, date: day, serviceId: 'SRV-104' });
  assert.strictEqual(slots.find(x => x.horaInicio === '09:00').disponivel, false);
  const dash = gas.ok('getAdminDashboardData', {}, session);
  const old = dash.agendamentos.find(b => b.id === 'AG-OLD1');
  assert.strictEqual(old.data, day);
  assert.strictEqual(old.clienteWhatsApp, '5511944443333');
});

function nextWeekday(wd, minAhead = 2) {
  let d = addDays(todayIso(), minAhead);
  while (new Date(d + 'T12:00:00Z').getUTCDay() !== wd) d = addDays(d, 1);
  return d;
}

function weekWith(overrides) {
  const base = {};
  for (let d = 0; d < 7; d++) base[d] = { ativo: d >= 1 && d <= 6, inicio: '09:00', fim: '19:00', almocoInicio: '12:00', almocoFim: '13:00', horarios: '' };
  return Object.assign(base, overrides);
}

test('horário diferente por dia da semana e horários fixos', () => {
  const gas = setupGas();
  const { spreadsheetId: s, session } = signUp(gas);
  const d = gas.ok('adminSaveWeeklySchedule', { semana: weekWith({
    1: { ativo: true, inicio: '13:00', fim: '20:00', almocoInicio: '', almocoFim: '', horarios: '' },   // segunda à tarde
    6: { ativo: true, inicio: '08:00', fim: '14:00', almocoInicio: '', almocoFim: '', horarios: '08:00, 10:30, 13:00' }, // sábado fixo
    0: { ativo: false }
  }) }, session);
  assert.strictEqual(d.agenda.semana[1].inicio, '13:00');
  const seg = gas.ok('getAvailableSlotsForDate', { s, date: nextWeekday(1), serviceId: 'SRV-104' });
  assert.strictEqual(seg[0].horaInicio, '13:00');
  assert.strictEqual(seg[seg.length - 1].horaInicio, '19:00');
  const sab = gas.ok('getAvailableSlotsForDate', { s, date: nextWeekday(6), serviceId: 'SRV-104' });
  assert.deepStrictEqual(sab.map(x => x.horaInicio), ['08:00', '10:30', '13:00']);
  // dias abertos para a cliente refletem a semana
  const pub = gas.ok('getPublicBootstrapData', { s });
  assert.ok(pub.diasAbertos.every(dd => new Date(dd + 'T12:00:00Z').getUTCDay() !== 0));
  // validação
  const bad = gas.call('adminSaveWeeklySchedule', { semana: weekWith({ 2: { ativo: true, inicio: '18:00', fim: '10:00' } }) }, session);
  assert.match(bad.error, /Terça/);
});

test('datas especiais: fechar feriado, abrir domingo e horário reduzido', () => {
  const gas = setupGas();
  const { spreadsheetId: s, session } = signUp(gas);
  const feriado = nextWeekday(3);
  const domingo = nextWeekday(0);
  const reduzido = nextWeekday(5);
  gas.ok('adminSaveSpecialDay', { data: feriado, tipo: 'FECHADO', motivo: 'Feriado' }, session);
  gas.ok('adminSaveSpecialDay', { data: domingo, tipo: 'ESPECIAL', horarios: '10:00,14:00', motivo: 'Domingo especial' }, session);
  let d = gas.ok('adminSaveSpecialDay', { data: reduzido, tipo: 'ESPECIAL', inicio: '09:00', fim: '12:00', motivo: 'Meio período' }, session);
  assert.strictEqual(d.agenda.especiais.length, 3);

  assert.deepStrictEqual(gas.ok('getAvailableSlotsForDate', { s, date: feriado, serviceId: 'SRV-104' }), []);
  assert.deepStrictEqual(gas.ok('getAvailableSlotsForDate', { s, date: domingo, serviceId: 'SRV-104' }).map(x => x.horaInicio), ['10:00', '14:00']);
  assert.deepStrictEqual(gas.ok('getAvailableSlotsForDate', { s, date: reduzido, serviceId: 'SRV-104' }).map(x => x.horaInicio), ['09:00', '10:00', '11:00']);

  const pub = gas.ok('getPublicBootstrapData', { s });
  assert.ok(pub.diasAbertos.includes(domingo));
  assert.ok(!pub.diasAbertos.includes(feriado));

  // cliente consegue reservar no domingo especial
  const r = gas.ok('createCustomerBooking', { s, servicoId: 'SRV-104', data: domingo, horaInicio: '14:00', clienteNome: 'Bia', clienteWhatsApp: '21977776666', metodoPagamento: 'NO_LOCAL' });
  assert.ok(r.reserva.id);

  // agenda do dia mostra o que ocupa cada horário
  const day = gas.ok('adminGetDayAgenda', { date: domingo }, session);
  assert.strictEqual(day.rule.especial, true);
  assert.strictEqual(day.slots.find(x => x.horaInicio === '14:00').origem, 'RESERVA');

  // editar a mesma data substitui; remover volta ao padrão
  d = gas.ok('adminSaveSpecialDay', { data: feriado, tipo: 'ESPECIAL', inicio: '15:00', fim: '17:00' }, session);
  assert.strictEqual(d.agenda.especiais.length, 3);
  d = gas.ok('adminDeleteSpecialDay', { data: feriado }, session);
  assert.strictEqual(d.agenda.especiais.length, 2);
  assert.strictEqual(gas.ok('getAvailableSlotsForDate', { s, date: feriado, serviceId: 'SRV-104' })[0].horaInicio, '09:00');
});

test('com horários fixos a pausa do almoço não bloqueia o horário escolhido', () => {
  const gas = setupGas();
  const { spreadsheetId: s, session } = signUp(gas);
  gas.ok('adminSaveWeeklySchedule', { semana: weekWith({ 6: { ativo: true, inicio: '09:00', fim: '19:00', almocoInicio: '12:00', almocoFim: '13:00', horarios: '10:30' } }) }, session);
  const sab = gas.ok('getAvailableSlotsForDate', { s, date: nextWeekday(6), serviceId: 'SRV-101' }); // 2h: 10:30–12:30
  assert.deepStrictEqual(sab.map(x => [x.horaInicio, x.disponivel]), [['10:30', true]]);
});

test('fotos dos trabalhos: envio para o Drive, várias por serviço, capa e remoção', () => {
  const gas = setupGas();
  const { spreadsheetId: s, session } = signUp(gas);
  const png = 'data:image/png;base64,' + Buffer.from('fake-png-bytes').toString('base64');
  const up1 = gas.ok('adminUploadPhoto', { dataUrl: png, nome: 'Fibra' }, session);
  const up2 = gas.ok('adminUploadPhoto', { dataUrl: png, nome: 'Fibra' }, session);
  assert.match(up1.url, /^https:\/\/drive\.google\.com\/thumbnail\?id=FILE/);
  const file = gas.drive.files[up1.id];
  const folder = gas.drive.folders[file.parent];
  assert.strictEqual(folder.name, 'Fotos dos trabalhos');
  assert.strictEqual(folder.owner, 'ana@gmail.com', 'pasta no Drive dela');
  assert.strictEqual(gas.drive.folders[folder.parent].name, 'Nail Studio Pro');
  assert.strictEqual(file.owner, 'ana@gmail.com', 'foto no Drive dela (usa o espaço dela, não do servidor)');
  assert.strictEqual(gas.serverCanOpen(up1.id), false);
  assert.ok(Object.values(gas.drive.files).every(f => f.owner !== gas.SERVER), 'nada no Drive do servidor');
  assert.strictEqual(file.sharing, 'ANYONE_WITH_LINK', 'foto pública para a página da cliente');
  assert.strictEqual(gas.call('adminUploadPhoto', { dataUrl: 'data:text/html;base64,PHNjcmlwdD4=' }, session).ok, false);

  let d = gas.ok('adminSaveService', { id: 'SRV-101', nome: 'Alongamento em Fibra de Vidro', preco: 160, duracaoMin: 120, categoria: 'Alongamentos', fotos: [up2.url, up1.url, 'javascript:alert(1)'] }, session);
  let srv = d.catalogo.find(x => x.id === 'SRV-101');
  assert.deepStrictEqual(srv.fotos, [up2.url, up1.url], 'ignora link inválido e mantém a ordem (capa = 1ª)');
  assert.strictEqual(srv.fotoUrl, up2.url);

  const pub = gas.ok('getPublicBootstrapData', { s });
  assert.deepStrictEqual(pub.catalogo.find(x => x.id === 'SRV-101').fotos, [up2.url, up1.url]);

  // remover uma foto manda o arquivo para a lixeira do Drive
  d = gas.ok('adminSaveService', { id: 'SRV-101', nome: 'Alongamento em Fibra de Vidro', preco: 160, duracaoMin: 120, categoria: 'Alongamentos', fotos: [up1.url] }, session);
  assert.deepStrictEqual(d.catalogo.find(x => x.id === 'SRV-101').fotos, [up1.url]);
  assert.strictEqual(gas.drive.files[up2.id].trashed, true);
  assert.strictEqual(gas.drive.files[up1.id].trashed, false);

  // limite de 8 fotos
  const many = Array.from({ length: 9 }, (_, i) => 'https://exemplo.com/f' + i + '.jpg');
  assert.match(gas.call('adminSaveService', { nome: 'X', preco: 10, duracaoMin: 30, categoria: 'Geral', fotos: many }, session).error, /máximo 8/);

  // catálogo inicial não traz fotos genéricas
  assert.ok(d.catalogo.filter(x => x.id !== 'SRV-101').every(x => x.fotos.length === 0));
});

test('reserva da cliente entra na agenda e avisa por e-mail; cancelamento sai da agenda e avisa', () => {
  const gas = setupGas();
  const { spreadsheetId: s, session } = signUp(gas);
  gas.ok('gcalConnect', { code: gas.google.issueCode('ana@gmail.com'), redirectUri: 'postmessage' }, session);
  assert.ok(gas.triggers.some(t => t.fn === 'sincronizarAgendas' && t.minutes === 15), 'sincronização automática instalada');
  const day = nextWorkday();
  const r = gas.ok('createCustomerBooking', { s, servicoId: 'SRV-104', data: day, horaInicio: '10:00', clienteNome: 'Bia', clienteWhatsApp: '21977776666', metodoPagamento: 'NO_LOCAL' });
  assert.strictEqual(gas.google.events['ana@gmail.com'].length, 1, 'evento criado na hora');
  assert.match(gas.mails[0].subject, /Nova reserva: Bia/);
  assert.match(gas.mails[0].htmlBody, /Já está na sua Google Agenda/);
  gas.ok('cancelCustomerBooking', { s, id: r.reserva.id, phone: '21977776666' });
  assert.strictEqual(gas.google.events['ana@gmail.com'].length, 0, 'evento removido na hora');
  assert.match(gas.mails[1].subject, /Cancelou: Bia/);
  // desligar o e-mail
  gas.ok('adminSaveSettings', { notificarEmail: false }, session);
  gas.ok('createCustomerBooking', { s, servicoId: 'SRV-104', data: day, horaInicio: '15:00', clienteNome: 'Carla', clienteWhatsApp: '21966665555', metodoPagamento: 'NO_LOCAL' });
  assert.strictEqual(gas.mails.length, 2);
});

test('sincronização automática: refaz envio que falhou e tira da agenda o que foi cancelado na planilha', () => {
  const gas = setupGas();
  const { spreadsheetId: s, session } = signUp(gas);
  gas.ok('gcalConnect', { code: gas.google.issueCode('ana@gmail.com'), redirectUri: 'postmessage' }, session);
  const day = nextWorkday();
  // Google instável no momento da reserva
  const realFetch = gas.google.fetch.bind(gas.google);
  gas.google.fetch = (u, o) => (u.includes('/calendar/v3/') && (o.method || '').toLowerCase() === 'post') ? { getResponseCode: () => 503, getContentText: () => '{"error":{"message":"backend error"}}' } : realFetch(u, o);
  const r = gas.ok('createCustomerBooking', { s, servicoId: 'SRV-104', data: day, horaInicio: '11:00', clienteNome: 'Duda', clienteWhatsApp: '21955554444', metodoPagamento: 'NO_LOCAL' });
  assert.ok(r.reserva.id, 'reserva não falha por causa da agenda');
  assert.strictEqual((gas.google.events['ana@gmail.com'] || []).length, 0);
  gas.google.fetch = realFetch;
  assert.strictEqual(gas.context.sincronizarAgendas(), 1);
  assert.strictEqual(gas.google.events['ana@gmail.com'].length, 1, 'evento criado pela sincronização');
  // a manicure cancela direto na planilha
  const sh = gas.spreadsheets[s].getSheetByName('Agendamentos');
  sh.data[1][11] = 'CANCELADO';
  gas.context.sincronizarAgendas();
  assert.strictEqual(gas.google.events['ana@gmail.com'].length, 0, 'evento removido pela sincronização');
});

test('primeiro acesso vinculando uma planilha que a manicure já tem', () => {
  const gas = setupGas();
  const mine = gas.createUserSheet('bia@gmail.com', 'Agenda da Bia');
  mine.getSheets()[0].setName('Agendamentos');
  mine.getSheets()[0].data = [['ID_Reserva', 'Data'], ['AG-ANTIGA', '2026-01-10']];
  const first = gas.ok('authGoogle', { idToken: gas.google.issueIdToken('bia@gmail.com', CLIENT_ID, 'Bia') });
  const args = () => ({ signupToken: first.signupToken, code: gas.google.issueCode('bia@gmail.com', { scope: DATA_SCOPES }), redirectUri: 'postmessage', studioNome: 'Bia Nails', profissionalNome: 'Bia', whatsapp: '11977776666', planilha: 'https://docs.google.com/spreadsheets/d/' + mine.id + '/edit#gid=0' });
  // sem compartilhar nada com o servidor: o app usa a permissão DELA
  const ok = gas.ok('createStudio', args());
  assert.strictEqual(ok.spreadsheetId, mine.id);
  assert.strictEqual(ok.vinculada, true);
  assert.deepStrictEqual(mine.editors, [], 'servidor não entra no compartilhamento');
  assert.strictEqual(gas.serverCanOpen(mine.id), false);
  const dash = gas.ok('getAdminDashboardData', {}, ok.session);
  assert.strictEqual(dash.studio.nome, 'Bia Nails');
  assert.strictEqual(dash.studio.planilhaDona, 'MANICURE');
  assert.ok(dash.agendamentos.some(b => b.id === 'AG-ANTIGA'), 'dados existentes mantidos');
  assert.ok(mine.getSheetByName('Catalogo') && mine.getSheetByName('Configuracoes'), 'abas que faltavam foram criadas');

  // planilha de outra pessoa (sem acesso dela) não pode ser usada
  const other = gas.createUserSheet('outra@gmail.com');
  const f2 = gas.ok('authGoogle', { idToken: gas.google.issueIdToken('carla@gmail.com', CLIENT_ID) });
  const bad = gas.call('createStudio', { signupToken: f2.signupToken, code: gas.google.issueCode('carla@gmail.com', { scope: DATA_SCOPES }), redirectUri: 'postmessage', studioNome: 'X', planilha: other.id });
  assert.match(bad.error, /não tem acesso/);
  // só leitura também não
  other.readers = ['carla@gmail.com'];
  const ro = gas.call('createStudio', { signupToken: f2.signupToken, code: gas.google.issueCode('carla@gmail.com', { scope: DATA_SCOPES }), redirectUri: 'postmessage', studioNome: 'X', planilha: other.id });
  assert.match(ro.error, /leitura/);
});

test('1º acesso exige autorizar planilha/arquivos com a MESMA conta do login', () => {
  const gas = setupGas();
  const first = gas.ok('authGoogle', { idToken: gas.google.issueIdToken('ana@gmail.com', CLIENT_ID) });
  const base = { signupToken: first.signupToken, redirectUri: 'postmessage', studioNome: 'Studio Ana' };
  assert.match(gas.call('createStudio', base).error, /Autorize/);
  assert.match(gas.call('createStudio', Object.assign({ code: gas.google.issueCode('ana@gmail.com', { scope: 'openid email' }) }, base)).error, /Planilhas/);
  assert.match(gas.call('createStudio', Object.assign({ code: gas.google.issueCode('outra@gmail.com', { scope: DATA_SCOPES }) }, base)).error, /outra conta/);
  const noRt = gas.call('createStudio', Object.assign({ code: gas.google.issueCode('ana@gmail.com', { scope: DATA_SCOPES, withRefresh: false }) }, base));
  assert.strictEqual(noRt.code, 'SEM_REFRESH');
  assert.strictEqual(Object.keys(gas.spreadsheets).length, 1, 'nenhuma planilha criada nas tentativas que falharam (só o diretório)');
});

test('migração: studio antigo criado pelo servidor vai para a conta dela sem perder nada', () => {
  const gas = setupGas();
  const old = legacyStudio(gas, 'ana@gmail.com', 'servidor');
  const oldSid = old.id;
  gas.props['GCAL_RT_' + oldSid] = 'rt-legado'; // token antigo da agenda (será descartado)
  // reservas e fotos antigas (no Drive do servidor)
  const day = nextWorkday();
  const li = login(gas);
  assert.strictEqual(li.dadosNaConta, false, 'antes de migrar: ainda no modo antigo');
  const r1 = gas.ok('createCustomerBooking', { s: oldSid, servicoId: 'SRV-104', data: day, horaInicio: '09:00', clienteNome: 'Bia', clienteWhatsApp: '21977776666', metodoPagamento: 'NO_LOCAL' });
  gas.ok('adminSaveSettings', { novoPin: '2468' }, li.session);
  const legacyFolder = gas.context.DriveApp.createFolder('Fotos antigas');
  const legacyFile = legacyFolder.createFile(gas.context.Utilities.newBlob(Buffer.from('jpeg-antigo').toString('latin1'), 'image/jpeg', 'unha.jpg'));
  const oldUrl = 'https://drive.google.com/thumbnail?id=' + legacyFile.getId() + '&sz=w800';
  gas.ok('adminSaveService', { id: 'SRV-101', nome: 'Alongamento em Fibra de Vidro', preco: 160, duracaoMin: 120, categoria: 'Alongamentos', fotos: [oldUrl] }, li.session);
  gas.context.upsertConfig_(gas.context.openStudio_(oldSid), { FOTOS_PASTA_ID: legacyFolder.getId() });
  const before = gas.ok('getAdminDashboardData', {}, li.session);
  assert.strictEqual(before.studio.dadosNaConta, false);

  // ela autoriza a conta dela → tudo passa para a conta dela
  const res = gas.ok('adminAuthorizeOwnAccount', { code: gas.google.issueCode('ana@gmail.com', { scope: DATA_SCOPES }), redirectUri: 'postmessage' }, li.session);
  assert.strictEqual(res.migracao.copied, true);
  const newSid = res.migracao.sheetId;
  assert.notStrictEqual(newSid, oldSid);
  const nss = gas.spreadsheets[newSid];
  assert.strictEqual(nss.owner, 'ana@gmail.com');
  assert.deepStrictEqual(nss.editors, []);
  assert.strictEqual(gas.serverCanOpen(newSid), false, 'servidor sem acesso à planilha nova');
  assert.strictEqual(old.trashed, true, 'planilha antiga do servidor foi para a lixeira');
  assert.ok(!gas.props['GCAL_RT_' + oldSid], 'token legado descartado');
  assert.strictEqual(res.studio.dadosNaConta, true);

  // tudo preservado
  const after = gas.ok('getAdminDashboardData', {}, res.session);
  assert.deepStrictEqual(after.agendamentos.map(b => [b.id, b.data, b.horaInicio, b.statusReserva]), before.agendamentos.map(b => [b.id, b.data, b.horaInicio, b.statusReserva]));
  assert.strictEqual(after.catalogo.length, before.catalogo.length);
  assert.strictEqual(after.studio.nome, 'Studio Antigo');
  // foto antiga saiu do Drive do servidor e foi para o dela
  const foto = after.catalogo.find(x => x.id === 'SRV-101').fotos[0];
  const newFileId = foto.match(/id=([^&]+)/)[1];
  assert.notStrictEqual(newFileId, legacyFile.getId());
  assert.strictEqual(gas.drive.files[newFileId].owner, 'ana@gmail.com');
  assert.deepStrictEqual(gas.drive.files[newFileId].bytes, gas.drive.files[legacyFile.getId()].bytes);
  assert.strictEqual(gas.drive.files[legacyFile.getId()].trashed, true);
  assert.strictEqual(gas.drive.folders[legacyFolder.getId()].trashed, true);

  // link antigo das clientes continua funcionando e a reserva antiga continua ocupando o horário
  const pub = gas.ok('getPublicBootstrapData', { s: oldSid });
  assert.strictEqual(pub.studio.nome, 'Studio Antigo');
  const slots = gas.ok('getAvailableSlotsForDate', { s: oldSid, date: day, serviceId: 'SRV-104' });
  assert.strictEqual(slots.find(x => x.horaInicio === '09:00').disponivel, false);
  gas.ok('cancelCustomerBooking', { s: oldSid, id: r1.reserva.id, phone: '21977776666' });
  assert.ok(nss.tab('Agendamentos').some(r => r[0] === r1.reserva.id && r[11] === 'CANCELADO'), 'gravou na planilha nova (dela)');
  // sessão antiga e PIN continuam valendo; login vai para a planilha nova
  assert.ok(gas.ok('getAdminDashboardData', {}, li.session));
  assert.ok(gas.ok('authPin', { email: 'ana@gmail.com', pin: '2468' }).session);
  assert.strictEqual(login(gas).spreadsheetId, newSid);
});

test('migração: planilha que já é dela (servidor era editor) — mesmo ID, servidor sai do compartilhamento', () => {
  const gas = setupGas();
  const ss = legacyStudio(gas, 'ana@gmail.com', 'ana@gmail.com');
  const sid = ss.id;
  const li = login(gas);
  const day = nextWorkday();
  const r = gas.ok('createCustomerBooking', { s: sid, servicoId: 'SRV-104', data: day, horaInicio: '10:00', clienteNome: 'Bia', clienteWhatsApp: '21977776666', metodoPagamento: 'NO_LOCAL' });
  assert.deepStrictEqual(ss.editors, [gas.SERVER]);

  const res = gas.ok('adminAuthorizeOwnAccount', { code: gas.google.issueCode('ana@gmail.com', { scope: DATA_SCOPES + ' ' + CAL_SCOPE }), redirectUri: 'postmessage' }, li.session);
  assert.deepStrictEqual(res.migracao, { sheetId: sid, copied: false, serverRemoved: true });
  assert.deepStrictEqual(ss.editors, [], 'servidor removido do compartilhamento');
  assert.strictEqual(gas.serverCanOpen(sid), false);
  assert.strictEqual(ss.trashed, false);
  assert.strictEqual(res.gcal.connected, true);
  assert.strictEqual(gas.google.events['ana@gmail.com'].length, 1, 'reserva já existente foi para a agenda dela');
  const d = gas.ok('getAdminDashboardData', {}, li.session);
  assert.ok(d.agendamentos.some(b => b.id === r.reserva.id));
  assert.strictEqual(d.studio.dadosNaConta, true);
  assert.ok(gas.ok('getPublicBootstrapData', { s: sid }).catalogo.length);
});

test('auto-setup depois de atualização do código e alerta de espaço no Drive', () => {
  const gas = createGas();
  gas.props.GOOGLE_CLIENT_ID = CLIENT_ID;
  gas.props.GOOGLE_CLIENT_SECRET = 'secret';
  // nunca rodaram setup(): a 1ª requisição configura sozinha
  const out = JSON.parse(gas.context.doGet({ parameter: {} }).getContent());
  assert.strictEqual(out.ok, true);
  assert.ok(gas.props.MASTER_SPREADSHEET_ID, 'diretório criado');
  assert.ok(gas.props.SESSION_SECRET);
  assert.strictEqual(gas.props.SETUP_VERSION, gas.context.API_VERSION);
  assert.ok(gas.triggers.some(t => t.fn === 'enviarResumosDiarios'));
  assert.ok(gas.triggers.some(t => t.fn === 'sincronizarAgendas'));
  // nova versão do código → refaz setup sem duplicar gatilhos
  gas.props.SETUP_VERSION = '0.0.1';
  gas.context.doGet({ parameter: {} });
  assert.strictEqual(gas.triggers.filter(t => t.fn === 'sincronizarAgendas').length, 1);
  // Drive em 85% → avisa a conta do servidor uma vez por semana
  gas.drive.storageUsed = 0.85 * 15 * 1024 * 1024 * 1024;
  gas.context.enviarResumosDiarios();
  gas.context.enviarResumosDiarios();
  const alerts = gas.mails.filter(m => /Google Drive do servidor/.test(m.subject));
  assert.strictEqual(alerts.length, 1);
  assert.strictEqual(alerts[0].to, 'servidor@gmail.com');
});
