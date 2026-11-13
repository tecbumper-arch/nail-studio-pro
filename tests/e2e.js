/**
 * Teste ponta a ponta no Chromium: login Google (simulado), criação do Studio,
 * conexão da Google Agenda, agendamento pela cliente, reagendamento,
 * cancelamento, relatório. Uso: node tests/e2e.js [--shots pasta]
 */
'use strict';
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { start } = require('./mock-server');

const shotsIdx = process.argv.indexOf('--shots');
const SHOTS = shotsIdx > 0 ? process.argv[shotsIdx + 1] : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const GSI_STUB = `
window.google = { accounts: {
  id: {
    initialize(cfg) { window.__gsiCfg = cfg; },
    renderButton(el) {
      const b = document.createElement('button');
      b.id = 'fakeGoogleBtn'; b.textContent = 'Continuar com Google';
      b.style.cssText = 'height:44px;padding:0 20px;border-radius:22px;border:1px solid #dadce0;background:#fff;font-weight:600';
      b.onclick = async () => {
        const t = await fetch('/__test/idtoken?email=' + encodeURIComponent(window.__testEmail || 'ana@gmail.com') + '&name=Ana%20Souza').then(r => r.text());
        window.__gsiCfg.callback({ credential: t });
      };
      el.appendChild(b);
    },
    disableAutoSelect() {}, prompt() {}
  },
  oauth2: { initCodeClient(cfg) { return { requestCode: async () => {
    const c = await fetch('/__test/code?email=' + encodeURIComponent(window.__testEmail || 'ana@gmail.com')).then(r => r.text());
    cfg.callback({ code: c });
  } }; } }
} };`;

const QR_STUB = `window.QRCode = function (el, o) { const c = document.createElement('canvas'); c.width = o.width || 160; c.height = o.height || 160;
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#111';
  for (let i = 0; i < 400; i++) { const x = (i * 37) % 20, y = Math.floor(i / 20); if ((x * 7 + y * 13 + (o.text || '').length) % 3 === 0) g.fillRect(x * c.width / 20, y * c.height / 20, c.width / 20, c.height / 20); }
  el.appendChild(c); }; window.QRCode.CorrectLevel = { M: 0 };`;

async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: false });
}

(async () => {
  const { server, base } = await start(0);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: SHOTS ? 2 : 1, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  // Sem internet no teste: Google e CDNs são simulados/bloqueados
  await ctx.route(url => !url.href.startsWith(base), r => {
    const u = r.request().url();
    if (u.startsWith('https://accounts.google.com/gsi/client')) return r.fulfill({ contentType: 'application/javascript', body: GSI_STUB });
    if (u.includes('qrcode.min.js')) return r.fulfill({ contentType: 'application/javascript', body: QR_STUB });
    return r.abort();
  });
  const errors = [];
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('admin: ' + e.message));
  page.on('dialog', d => d.accept());

  try {
    // 1. Login Google + criação do Studio
    await page.goto(base + '/App_Manicure.html');
    await page.waitForSelector('#fakeGoogleBtn');
    await shot(page, '01-login');
    await page.click('#fakeGoogleBtn');
    await page.waitForSelector('#authModeOnboarding:not(.hidden)');
    assert.strictEqual(await page.textContent('#obEmailLabel'), 'ana@gmail.com');
    assert.strictEqual(await page.inputValue('#obProNome'), 'Ana');
    await page.fill('#obStudioNome', 'Studio Ana Nails');
    await page.fill('#obWhatsapp', '(11) 98888-7777');
    await page.fill('#obPixChave', '11988887777');
    await page.check('#obTermo');
    await shot(page, '02-onboarding');
    await page.click('#btnOnboarding');
    await page.waitForFunction(() => document.getElementById('hdrStudioName').textContent === 'Studio Ana Nails');
    assert.ok(await page.isHidden('#lockScreen'));

    // 2. Conectar Google Agenda
    await page.waitForSelector('#tabConfig:not(.hidden)');
    await page.click('#btnConnectGCal');
    await page.waitForFunction(() => document.getElementById('gcalStatusBadge').textContent.includes('Conectada'));
    assert.match(await page.textContent('#gcalAccountLine'), /ana@gmail.com/);
    await shot(page, '03-agenda-conectada');

    // regras: antecedência 0 para conseguir testar horários de hoje/amanhã
    await page.selectOption('#cfgAntecedencia', '0');
    await page.click('#btnSaveCfg');
    await page.waitForFunction(() => document.getElementById('toastMsg').textContent.includes('salvas'));

    // 3. Página da cliente
    const clientLink = await page.inputValue('#clientPageUrlInput');
    assert.match(clientLink, /Pagina_Cliente\.html\?s=/);
    const cpage = await ctx.newPage();
    cpage.on('pageerror', e => errors.push('cliente: ' + e.message));
    cpage.on('dialog', d => d.accept());
    await cpage.goto(clientLink);
    await cpage.waitForFunction(() => document.getElementById('cStudioName').textContent === 'Studio Ana Nails');
    await shot(cpage, '04-cliente-catalogo');
    await cpage.click('.srv-card >> nth=0');
    await cpage.waitForSelector('#cScheduleArea:not(.hidden) .day-pill');
    await cpage.waitForSelector('#cSlots .slot, #cSlots div');
    // escolhe um dia que não seja hoje para ter horários livres
    const pills = await cpage.$$('.day-pill');
    await pills[Math.min(2, pills.length - 1)].click();
    await cpage.waitForSelector('.slot:not(.busy)');
    await cpage.click('.slot:not(.busy) >> nth=0');
    await cpage.fill('#cNome', 'Bianca Lima');
    await cpage.fill('#cWhats', '21977776666');
    await cpage.fill('#cObs', 'Cor nude');
    await shot(cpage, '05-cliente-horario');
    await cpage.click('#cBtnSubmit');
    await cpage.waitForSelector('#cPixModal.open');
    const pix = await cpage.textContent('#cPixRaw');
    assert.match(pix, /^000201/);
    await shot(cpage, '06-cliente-pix');
    await cpage.click('#cBtnPaid');
    await cpage.waitForFunction(() => document.getElementById('cBtnPaid').textContent.includes('avisado'));

    // a cliente vê o agendamento em "Meus Horários"
    await cpage.evaluate(() => document.getElementById('cPixModal').classList.remove('open'));
    await cpage.click('#tabBtnMy');
    await cpage.waitForFunction(() => document.getElementById('cMyBookingsList').textContent.includes('Bianca') || document.getElementById('cMyBookingsList').textContent.includes('💅'));

    // 4. Painel: reserva aparece, evento na Google Agenda
    await page.click('.nav-btn >> nth=0');
    await page.click('#tabAgenda button[onclick="refreshAdminData()"]');
    await page.waitForFunction(() => document.getElementById('bookingsList').textContent.includes('Bianca Lima'));
    assert.match(await page.textContent('#bookingsList'), /Cliente avisou Pix/);
    assert.match(await page.textContent('#bookingsList'), /Cor nude/);
    let events = await (await fetch(base + '/__test/events')).json();
    assert.strictEqual(events['ana@gmail.com'].length, 1, 'evento criado na Google Agenda');
    await shot(page, '07-painel-agenda');

    // 5. Validar Pix e reagendar
    await page.click('#bookingsList button:has-text("Validar Pix")');
    await page.waitForFunction(() => document.getElementById('bookingsList').textContent.includes('Pix validado'));
    await page.click('#bookingsList button:has-text("Reagendar")');
    await page.waitForSelector('#modalReschedule:not(.hidden)');
    await page.waitForSelector('#rsSlots .f-pill');
    await page.click('#rsSlots .f-pill >> nth=-1');
    await page.uncheck('#rsAvisar');
    await shot(page, '08-reagendar');
    const newHour = await page.inputValue('#rsHora');
    await page.click('#btnRsSave');
    await page.waitForSelector('#modalReschedule', { state: 'hidden' });
    events = await (await fetch(base + '/__test/events')).json();
    assert.ok(events['ana@gmail.com'][0].start.dateTime.endsWith(newHour + ':00'), 'evento movido na agenda');

    // 6. Relatório e clientes
    await page.click('button:has-text("Relatório")');
    await page.waitForSelector('#modalReport:not(.hidden)');
    assert.match(await page.textContent('#reportBody'), /Faturamento do mês/);
    await shot(page, '09-relatorio');
    await page.click('#modalReport button:has-text("×")');
    await page.click('.nav-btn >> nth=2');
    await page.waitForFunction(() => document.getElementById('crmClientsList').textContent.includes('Bianca'));

    // 7. Liberar vaga apaga o evento
    await page.click('.nav-btn >> nth=0');
    await page.click('#bookingsList button:has-text("Liberar vaga")');
    await page.waitForFunction(() => document.getElementById('bookingsList').textContent.includes('Cancelado'));
    events = await (await fetch(base + '/__test/events')).json();
    assert.strictEqual(events['ana@gmail.com'].length, 0, 'evento removido da agenda');

    // 8. Sessão persiste ao recarregar; sair volta para o login
    await page.reload();
    await page.waitForFunction(() => document.getElementById('hdrStudioName').textContent === 'Studio Ana Nails');
    await page.click('.nav-btn >> nth=4');
    await page.click('#advOptionsDetails summary');
    await page.fill('#cfgNovoPin', '2468');
    await page.click('#advOptionsDetails button:has-text("Salvar PIN")');
    await page.waitForFunction(() => document.getElementById('cfgPinStatus').textContent.includes('cadastrado'));
    await page.click('#advOptionsDetails button:has-text("Sair")');
    await page.waitForSelector('#lockScreen:not(.hidden)');
    // login por PIN
    await page.click('text=Entrar com e-mail e PIN');
    await page.fill('#loginUserInput', 'ana@gmail.com');
    await page.fill('#pinInput', '2468');
    await page.click('#btnUnlock');
    await page.waitForSelector('#lockScreen', { state: 'hidden' });

    // 9. Horários por dia da semana + data especial + agenda do dia
    const { formatDate } = require('./gas-mock');
    const iso = (offset) => formatDate(new Date(Date.now() + offset * 86400000), 'America/Sao_Paulo', 'yyyy-MM-dd');
    let sunday = null;
    for (let i = 2; i < 10 && !sunday; i++) if (new Date(iso(i) + 'T12:00:00Z').getUTCDay() === 0) sunday = iso(i);
    let saturday = null;
    for (let i = 2; i < 10 && !saturday; i++) if (new Date(iso(i) + 'T12:00:00Z').getUTCDay() === 6) saturday = iso(i);

    await page.click('.nav-btn >> nth=4');
    const satRow = '#weekEditor .wk-row[data-d="6"]';
    await page.waitForSelector(satRow);
    await page.$eval(satRow + ' details', d => { d.open = true; });
    await page.fill(satRow + ' .wk-fixos', '08:00, 10:30');
    assert.match(await page.textContent(satRow + ' .wk-summary'), /Fixos: 08:00 · 10:30/);
    await shot(page, '10-horarios-semana');
    await page.click('#btnSaveWeek');
    await page.waitForFunction(() => document.getElementById('toastMsg').textContent.includes('Horários da semana salvos'));

    await page.fill('#spData', sunday);
    await page.selectOption('#spTipo', 'ESPECIAL');
    await page.fill('#spHorarios', '10:00, 15:00');
    await page.fill('#spMotivo', 'Domingo especial');
    await page.click('#btnSaveSpecial');
    await page.waitForFunction(() => document.getElementById('specialDaysList').textContent.includes('Domingo especial'));
    await page.locator('#specialDaysCard').scrollIntoViewIfNeeded();
    await shot(page, '11-datas-especiais');

    // agenda do dia: reservar tocando no horário livre do domingo
    await page.click('.nav-btn >> nth=0');
    await page.click('#agendaModeBar button:has-text("Agenda do dia")');
    await page.waitForSelector('#dayStrip input[type=date]');
    await page.fill('#dayStrip input[type=date]', sunday);
    await page.dispatchEvent('#dayStrip input[type=date]', 'change');
    await page.waitForFunction(() => document.getElementById('dayHeader').textContent.includes('Data especial'));
    const times = await page.$$eval('#dayTimeline .tl-time', els => els.map(e => e.textContent));
    assert.deepStrictEqual(times, ['10:00', '15:00']);
    await page.click('#dayTimeline .tl-row.free >> nth=0 >> button:has-text("Reservar")');
    await page.waitForSelector('#boxManualBooking:not(.hidden)');
    assert.strictEqual(await page.inputValue('#manHoraInicio'), '10:00');
    await page.fill('#manClienteNome', 'Carla Dias');
    await page.click('#btnSaveManual');
    await page.waitForFunction(() => document.getElementById('dayTimeline').textContent.includes('Carla Dias'));
    await page.locator('#agendaModeBar').scrollIntoViewIfNeeded();
    await shot(page, '12-agenda-do-dia');

    // sábado com horários fixos na agenda do dia
    await page.fill('#dayStrip input[type=date]', saturday);
    await page.dispatchEvent('#dayStrip input[type=date]', 'change');
    await page.waitForFunction(() => document.getElementById('dayHeader').textContent.includes('Horários fixos: 08:00 · 10:30'));

    // cliente vê o domingo especial
    const c2 = await ctx.newPage();
    c2.on('pageerror', e => errors.push('cliente2: ' + e.message));
    await c2.goto(clientLink);
    await c2.waitForFunction(() => document.getElementById('cStudioName').textContent === 'Studio Ana Nails');
    await c2.click('.srv-card >> nth=0');
    const sundayDay = String(Number(sunday.slice(8)));
    const pillTexts = await c2.$$eval('.day-pill', els => els.map(e => e.textContent));
    assert.ok(pillTexts.some(t => t.startsWith('Dom') && t.endsWith(sundayDay.padStart(2, '0'))), 'domingo especial aparece para a cliente: ' + pillTexts.join(','));

    // 10. Link de studio inválido mostra mensagem amigável
    const bad = await ctx.newPage();
    await bad.goto(base + '/Pagina_Cliente.html?s=abcdefghijklmnopqrstuvwxyz123');
    await bad.waitForFunction(() => document.getElementById('cStudioName').textContent.includes('indisponível'));

    assert.deepStrictEqual(errors, [], 'erros de JavaScript: ' + errors.join(' | '));
    console.log('E2E OK ✅');
  } catch (e) {
    console.error('E2E FALHOU ❌', e);
    if (errors.length) console.error('Erros JS:', errors);
    await page.screenshot({ path: path.join(SHOTS || '/tmp', 'falha-admin.png') }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
  }
})();
