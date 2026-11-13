'use strict';
/**
 * Teste de migração de um Studio REAL do app antigo (v2.2) para a versão nova,
 * em que tudo fica na conta Google da manicure e o servidor sai da planilha.
 *
 * Por padrão usa tests/fixtures/legacy-studio.json (cópia anonimizada de uma
 * planilha real). Para rodar com outra planilha exportada:
 *   LEGACY_FIXTURE=/caminho/planilha.json node --test tests/legacy-migration.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const path = require('path');
const { createGas, formatDate, DATA_SCOPES, CAL_SCOPE, Spreadsheet, Sheet } = require('./gas-mock');

const CLIENT_ID = 'web-client.apps.googleusercontent.com';
const FIXTURE = require(process.env.LEGACY_FIXTURE || path.join(__dirname, 'fixtures', 'legacy-studio.json'));
const KNOWN_PIN = process.env.LEGACY_FIXTURE ? null : '2580'; // PIN só é conhecido na cópia anonimizada

function todayIso() { return formatDate(new Date(), 'America/Sao_Paulo', 'yyyy-MM-dd'); }
function addDays(iso, n) { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }
function weekday(iso) { return new Date(iso + 'T12:00:00Z').getUTCDay(); }
function daysBetween(a, b) { return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000); }

/** Monta no "Google" simulado a planilha exatamente como está hoje: dela, com o servidor como editor. */
function legacyWorld({ shiftDays = 0 } = {}) {
  const gas = createGas();
  gas.props.GOOGLE_CLIENT_ID = CLIENT_ID;
  gas.props.GOOGLE_CLIENT_SECRET = 'secret';
  gas.context.setup();
  const ss = new Spreadsheet(FIXTURE.id, 'Studio - App & Agenda (Banco Oficial)', FIXTURE.owner);
  ss.editors = [gas.SERVER];
  ss.sheets = Object.entries(FIXTURE.tabs).map(([name, rows]) => {
    const sh = new Sheet(name, ss);
    sh.data = rows.map((r, i) => r.map((v, j) => {
      if (i > 0 && name === 'Agendamentos' && j === 1 && shiftDays) return addDays(v, shiftDays);
      // o Sheets guarda números como número (telefone, preço, duração)
      return i > 0 && /^\d+(\.\d+)?$/.test(v) && v.length < 16 && !(name === 'Configuracoes' && /^0\d/.test(v)) ? Number(v) : v;
    }));
    return sh;
  });
  gas.spreadsheets[ss.id] = ss;
  gas.context.registerStudio_(FIXTURE.owner, ss.id, {}, '', '');
  return { gas, ss, sid: ss.id, email: FIXTURE.owner };
}

const tabRows = (ss, name) => ss.tab(name);
const bookingRows = () => FIXTURE.tabs.Agendamentos.slice(1).filter(r => r[0]);
const cfgOf = (name) => Object.fromEntries(FIXTURE.tabs.Configuracoes.slice(1).map(r => [r[0], r[1]]));

function login(gas, email) { return gas.ok('authGoogle', { idToken: gas.google.issueIdToken(email, CLIENT_ID) }); }
function authorize(gas, email, session) {
  return gas.ok('adminAuthorizeOwnAccount', { code: gas.google.issueCode(email, { scope: DATA_SCOPES + ' ' + CAL_SCOPE }), redirectUri: 'postmessage' }, session);
}

function sameBookings(list) {
  for (const r of bookingRows()) {
    const b = list.find(x => x.id === r[0]);
    assert.ok(b, 'reserva ' + r[0] + ' presente');
    assert.strictEqual(b.data, r[1], r[0] + ' data');
    assert.strictEqual(b.horaInicio, r[2], r[0] + ' início');
    assert.strictEqual(b.horaFim, r[3], r[0] + ' fim');
    assert.strictEqual(b.statusReserva, r[11], r[0] + ' status');
    assert.strictEqual(b.statusPagamento, r[10], r[0] + ' pagamento');
    assert.strictEqual(String(b.valor), String(Number(r[8])), r[0] + ' valor');
  }
}

test('antes de autorizar: a versão nova abre o Studio antigo como estava', () => {
  const { gas, sid, email } = legacyWorld();
  const li = login(gas, email);
  assert.strictEqual(li.spreadsheetId, sid);
  assert.strictEqual(li.dadosNaConta, false, 'app pede para ela autorizar a própria conta');
  const dash = gas.ok('getAdminDashboardData', {}, li.session);
  assert.strictEqual(dash.studio.nome, cfgOf().STUDIO_NOME);
  sameBookings(dash.agendamentos);
  assert.strictEqual(dash.agendamentos.length, bookingRows().length);
  // horário: só os dias que ela atendia, sem "almoço" 00:00–00:00
  const dias = String(cfgOf().DIAS_ATENDIMENTO).split(',').map(Number);
  for (const [dia, d] of Object.entries(dash.agenda.semana)) {
    assert.strictEqual(d.ativo, dias.includes(Number(dia)), 'dia ' + dia);
    if (d.ativo) { assert.strictEqual(d.inicio, cfgOf().HORARIO_INICIO); assert.strictEqual(d.fim, cfgOf().HORARIO_FIM); assert.ok(!d.almocoInicio || d.almocoInicio === d.almocoFim || d.almocoInicio === ''); }
  }
  // link antigo das clientes
  const pub = gas.ok('getPublicBootstrapData', { s: sid });
  const ativos = FIXTURE.tabs.Catalogo.slice(1).filter(r => r[7] === 'SIM');
  assert.strictEqual(pub.catalogo.length, ativos.length);
  for (const r of ativos) {
    const s = pub.catalogo.find(x => x.id === r[0]);
    assert.ok(s, r[0]);
    if (r[5]) assert.strictEqual(s.fotoUrl, r[5], r[0] + ' foto mantida');
  }
});

test('migração real: ela autoriza → mesmo ID, servidor sai, nada se perde e ela segue de onde parou', () => {
  const { gas, ss, sid, email } = legacyWorld();
  const before = {};
  for (const name of Object.keys(FIXTURE.tabs)) before[name] = tabRows(ss, name);
  const li = login(gas, email);

  const res = authorize(gas, email, li.session);
  assert.deepStrictEqual(res.migracao, { sheetId: sid, copied: false, serverRemoved: true });
  assert.strictEqual(ss.owner, email, 'continua dona');
  assert.ok(!ss.editors.includes(gas.SERVER), 'servidor removido do compartilhamento');
  assert.strictEqual(gas.serverCanOpen(sid), false, 'servidor não consegue mais abrir a planilha');
  assert.strictEqual(ss.trashed, false);
  assert.strictEqual(res.studio.dadosNaConta, true);
  assert.strictEqual(res.gcal.connected, true);

  // Célula por célula: tudo que existia continua igual
  const allowedCfgChanges = /^(GCAL_|SINCRONIZAR_AGENDA$|SESSION_VERSION$)/;
  for (const [name, rows] of Object.entries(before)) {
    const now = tabRows(ss, name);
    rows.forEach((r, i) => r.forEach((v, j) => {
      if (name === 'Configuracoes' && j === 1 && allowedCfgChanges.test(r[0])) return;
      assert.strictEqual(now[i][j], v, `${name}!${String.fromCharCode(65 + j)}${i + 1} mudou`);
    }));
  }
  // nada foi parar no Drive do servidor
  assert.ok(Object.values(gas.drive.files).every(f => f.owner !== gas.SERVER));

  // sessão aberta no celular dela continua valendo, agora lendo pela conta dela
  const dash = gas.ok('getAdminDashboardData', {}, li.session);
  sameBookings(dash.agendamentos);
  assert.strictEqual(dash.studio.nome, cfgOf().STUDIO_NOME);
  assert.strictEqual(login(gas, email).spreadsheetId, sid);

  // PIN antigo (SHA-256 do app antigo) continua igual e válido
  assert.strictEqual(tabRows(ss, 'Configuracoes').find(r => r[0] === 'ADMIN_PIN_HASH')[1], cfgOf().ADMIN_PIN_HASH);
  assert.strictEqual(gas.call('authPin', { email, pin: '000000' }).ok, false);
  if (KNOWN_PIN) assert.ok(gas.ok('authPin', { email, pin: KNOWN_PIN }).session);

  // segue de onde parou: nova reserva pelo link antigo → planilha DELA + agenda DELA
  const dias = String(cfgOf().DIAS_ATENDIMENTO).split(',').map(Number);
  let day = addDays(todayIso(), 2);
  while (!dias.includes(weekday(day))) day = addDays(day, 1);
  const srv = FIXTURE.tabs.Catalogo.slice(1).find(r => r[7] === 'SIM' && Number(r[4]) <= 60);
  const slots = gas.ok('getAvailableSlotsForDate', { s: sid, date: day, serviceId: srv[0] });
  assert.strictEqual(slots[0].horaInicio, cfgOf().HORARIO_INICIO);
  const livre = slots.find(x => x.disponivel);
  const nova = gas.ok('createCustomerBooking', { s: sid, servicoId: srv[0], data: day, horaInicio: livre.horaInicio, clienteNome: 'Teste Migração', clienteWhatsApp: '11912345678', metodoPagamento: 'NO_LOCAL' });
  const after = tabRows(ss, 'Agendamentos');
  assert.strictEqual(after.length, before.Agendamentos.length + 1);
  assert.strictEqual(after[after.length - 1][0], nova.reserva.id);
  assert.ok(gas.google.events[email].some(e => e.extendedProperties.private.nailBookingId === nova.reserva.id), 'entrou na Google Agenda dela');
  // cancelamento sai da agenda
  gas.ok('cancelCustomerBooking', { s: sid, id: nova.reserva.id, phone: '11912345678' });
  assert.ok(!gas.google.events[email].some(e => e.extendedProperties.private.nailBookingId === nova.reserva.id));
});

test('reservas confirmadas que ainda vão acontecer continuam ocupando o horário e seguem na agenda dela', () => {
  // Desloca as datas reais em semanas inteiras para que as reservas CONFIRMADAS fiquem no futuro
  const confirmed = bookingRows().filter(r => r[11] === 'CONFIRMADO' || r[11] === 'RESERVADO');
  if (!confirmed.length) return;
  const first = confirmed.map(r => r[1]).sort()[0];
  const shift = Math.ceil((daysBetween(first, todayIso()) + 3) / 7) * 7;
  const { gas, sid, email } = legacyWorld({ shiftDays: shift });
  // Os eventos que o app antigo já tinha criado na Google Agenda dela (ID terminado em @google.com)
  for (const r of confirmed.filter(r => /@google\.com$/.test(r[12]))) {
    const day = addDays(r[1], shift);
    gas.google.addPersonalEvent(email, { id: r[12].replace(/@google\.com$/, ''), summary: 'Evento do app antigo ' + r[0], start: { dateTime: day + 'T' + r[2] + ':00-03:00' }, end: { dateTime: day + 'T' + r[3] + ':00-03:00' } });
  }
  const n0 = (gas.google.events[email] || []).length;
  const li = login(gas, email);
  authorize(gas, email, li.session);
  const events = gas.google.events[email] || [];
  assert.strictEqual(events.length, n0 + confirmed.filter(r => !/@google\.com$/.test(r[12])).length, 'não duplica eventos que já estavam na agenda');
  const svc = FIXTURE.tabs.Catalogo.slice(1).find(x => x[7] === 'SIM');
  for (const r of confirmed) {
    const day = addDays(r[1], shift);
    const slots = gas.ok('getAvailableSlotsForDate', { s: sid, date: day, serviceId: svc[0] });
    const clash = slots.filter(x => x.horaInicio >= r[2] && x.horaInicio < r[3]);
    assert.ok(clash.every(x => !x.disponivel), r[0] + ' continua bloqueando ' + r[2] + '–' + r[3]);
  }
  // a versão nova consegue mexer nos eventos criados pelo app antigo: cancelar tira da agenda dela
  const alvo = confirmed.find(r => /@google\.com$/.test(r[12]));
  if (alvo) {
    gas.ok('adminUpdateBookingStatus', { id: alvo[0], action: 'CANCELAR_RESERVA' }, li.session);
    assert.ok(!gas.google.events[email].some(e => e.id === alvo[12].replace(/@google\.com$/, '')), 'evento antigo removido');
  }
  // canceladas/concluídas não voltam para a agenda
  const others = bookingRows().filter(r => !confirmed.includes(r));
  assert.ok(others.every(r => !gas.google.events[email].some(e => (e.extendedProperties || { private: {} }).private.nailBookingId === r[0])));
});

test('o hash do PIN do app antigo é o mesmo SHA-256 do servidor novo', () => {
  const { gas } = legacyWorld();
  for (const pin of ['2580', '123456', 'ação']) {
    assert.strictEqual(gas.context.sha256Hex_(pin), crypto.createHash('sha256').update(pin, 'utf8').digest('hex'));
  }
});
