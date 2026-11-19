// Teste de ponta a ponta: páginas servidas pelo Worker (`wrangler dev`) falando com um Google falso.
// Uso: npm run e2e   (E2E_SHOTS=<pasta> também salva screenshots 390x844 @2x)
// Primeira vez numa máquina nova: `npm run e2e:install-browser` (baixa o Chromium do Playwright). Ver README.md.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { startFakeGoogleServer } from './fakeGoogleServer.js';
import { signToken } from '../../src/session.js';
import { hashPin } from '../../src/util.js';
import { chromium } from 'playwright';

const WORKER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHOTS = process.env.E2E_SHOTS || '';
const SESSION_SECRET = 'e2e-session-secret-0123456789abcdef';
const GCAL_SECRET = 'e2e-gcal-refresh-SECRET';
const MASTER = /MASTER_SPREADSHEET_ID\s*=\s*"([^"]+)"/.exec(fs.readFileSync(path.join(WORKER_DIR, 'wrangler.toml'), 'utf8'))[1];
const SID = 'studio-e2e-1111111111111111';
const LEGACY_SID = 'studio-legacy-2222222222222';
const EMAIL = 'ana@exemplo.com';
const PIN = '2580';
const CLIENTE = 'Larissa Martins';
const CLIENTE_WHATS = '11977776666';

// ---------------------------------------------------------------------------
// Dados iniciais (planilha mestre + studio)
// ---------------------------------------------------------------------------
async function seed() {
  const pinHash = await hashPin(PIN);
  const cfg = (extra) => [
    ['Chave', 'Valor', 'Descricao'],
    ['SETUP_CONCLUIDO', 'SIM', ''],
    ['STUDIO_NOME', 'Studio Bella Nails', ''],
    ['PROFISSIONAL_NOME', 'Ana Souza', ''],
    ['ADMIN_LOGIN_ID', EMAIL, ''],
    ['WHATSAPP_STUDIO', '11999990000', ''],
    ['PIX_CHAVE', '11988887777', ''],
    ['PIX_RECEBEDOR', 'ANA SOUZA', ''],
    ['PIX_CIDADE', 'SAO PAULO', ''],
    ['TEMA_COR', 'pink-gold', ''],
    ['HORARIO_INICIO', '09:00', ''],
    ['HORARIO_FIM', '19:00', ''],
    ['ALMOCO_INICIO', '12:00', ''],
    ['ALMOCO_FIM', '13:00', ''],
    ['DIAS_ATENDIMENTO', '0,1,2,3,4,5,6', ''],
    ['INTERVALO_MINUTOS', '60', ''],
    ...extra,
  ];
  const studioTabs = (extra) => ({
    Configuracoes: cfg(extra),
    Categorias: [['ID', 'Nome', 'Icone', 'Ordem', 'Ativo'], ['CAT-01', 'Alongamentos', '💅', '1', 'SIM']],
    Catalogo: [
      ['ID', 'Nome', 'Descricao', 'Preco', 'DuracaoMin', 'FotoUrl', 'Categoria', 'Ativo'],
      ['SRV-101', 'Alongamento em Gel', 'Alongamento com acabamento natural.', '120', '60', '', 'Alongamentos', 'SIM'],
    ],
    Agendamentos: [['ID', 'Data', 'HoraInicio', 'HoraFim', 'ClienteNome', 'ClienteWhatsApp', 'ServicoID', 'ServicoNome', 'Valor', 'MetodoPagamento', 'StatusPagamento', 'StatusReserva', 'CalendarEventID', 'CriadoEm']],
  });
  return {
    [MASTER]: {
      Contas_Manicures: [
        ['Email', 'Profissional', 'Studio', 'SheetId', 'SheetUrl', 'ClientLink', 'PinHash', 'RecHash', 'CriadoEm'],
        [EMAIL, 'Ana Souza', 'Studio Bella Nails', SID, '', '', pinHash, '', '01/11/2026'],
        ['legado@exemplo.com', 'Bia', 'Studio Legado', LEGACY_SID, '', '', '', '', '01/11/2026'],
      ],
    },
    [SID]: studioTabs([
      ['ADMIN_PIN_HASH', pinHash, ''],
      ['GCAL_REFRESH_TOKEN', GCAL_SECRET, ''],
      ['GCAL_CONNECTED_EMAIL', EMAIL, ''],
    ]),
    // Studio antigo sem PIN próprio (só o 123456 legado).
    [LEGACY_SID]: studioTabs([['ADMIN_PIN_HASH', await hashPin('123456'), '']]),
  };
}

// ---------------------------------------------------------------------------
// Infra: porta livre, wrangler dev, navegador
// ---------------------------------------------------------------------------
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startWrangler(googleBase) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nsp-e2e-'));
  const envFile = path.join(tmp, '.dev.vars');
  fs.writeFileSync(envFile, [
    'GOOGLE_CLIENT_ID=e2e-client-id.apps.googleusercontent.com',
    'GOOGLE_CLIENT_SECRET=e2e-client-secret',
    'GOOGLE_REFRESH_TOKEN=e2e-server-refresh-token',
    `SESSION_SECRET=${SESSION_SECRET}`,
    `GOOGLE_API_BASE=${googleBase}`,
    '',
  ].join('\n'));
  const port = await freePort();
  const inspector = await freePort();
  const child = spawn('npx', [
    'wrangler', 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(inspector),
    '--env-file', envFile, '--persist-to', path.join(tmp, 'state'),
    '--show-interactive-dev-session=false', '--log-level', 'warn',
  ], {
    cwd: WORKER_DIR,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_CF_FETCH_ENABLED: 'false', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', CI: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });

  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (child.exitCode !== null) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw new Error('wrangler dev saiu:\n' + log);
    }
    try {
      const r = await fetch(origin + '/App_Manicure.html');
      if (r.ok) break;
    } catch (e) {}
    if (Date.now() > deadline) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch (e) {}
      fs.rmSync(tmp, { recursive: true, force: true });
      throw new Error('wrangler dev não respondeu a tempo:\n' + log);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return {
    origin,
    log: () => log,
    stop: () => {
      try { process.kill(-child.pid, 'SIGTERM'); } catch (e) {}
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

// @fortawesome/fontawesome-free e qrcodejs são devDependencies só para o e2e: substituem as CDNs
// (bloqueadas em sandbox/CI) que as páginas carregam em produção.
const FA_DIR = path.join(WORKER_DIR, 'node_modules/@fortawesome/fontawesome-free');
const QR_JS = path.join(WORKER_DIR, 'node_modules/qrcodejs/qrcode.min.js');
const PLACEHOLDER_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#fbcfe8"/></svg>';

// CDNs bloqueados na sandbox: Font Awesome e qrcodejs vêm do node_modules; o resto externo não sai da máquina.
async function newContext(browser, origin, apiLog) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    locale: 'pt-BR', timezoneId: 'America/Sao_Paulo',
  });
  await ctx.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith(origin)) return route.continue();
    if (url.includes('/font-awesome/6.5.1/')) {
      const f = path.join(FA_DIR, url.split('/font-awesome/6.5.1/')[1].split('?')[0]);
      if (fs.existsSync(f)) return route.fulfill({ path: f });
    }
    if (url.includes('qrcodejs/1.0.0/qrcode.min.js')) return route.fulfill({ path: QR_JS });
    apiLog.external.push(url);
    // Imagens externas (fotos, logo do Google) viram um quadro neutro; abortar deixa o `load` preso às vezes.
    if (route.request().resourceType() === 'image') return route.fulfill({ contentType: 'image/svg+xml', body: PLACEHOLDER_SVG });
    return route.abort();
  });
  ctx.on('response', async (res) => {
    if (!res.url().startsWith(origin + '/api/')) return;
    let body = '';
    try { body = await res.text(); } catch (e) {}
    apiLog.responses.push({ url: res.url(), status: res.status(), body, headers: res.headers() });
  });
  return ctx;
}

async function newPage(ctx, errors) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  return page;
}

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, name + '.png') });
}

async function waitToast(page, text) {
  await page.waitForFunction((t) => {
    const el = document.getElementById('toastMsg');
    const box = document.getElementById('toast');
    return el && box && box.style.display !== 'none' && el.textContent.includes(t);
  }, text, { timeout: 15_000 });
}

// Intercepta /api/oauth/start: guarda a URL pedida e o Location devolvido pelo Worker,
// sem seguir para o Google de verdade.
async function captureOAuthStart(ctx, origin) {
  let resolve;
  const done = new Promise((r) => { resolve = r; });
  await ctx.route(origin + '/api/oauth/start**', async (route) => {
    const res = await route.fetch({ maxRedirects: 0 });
    await route.fulfill({ status: 200, contentType: 'text/plain', body: 'google' });
    resolve({ start: new URL(route.request().url()), status: res.status(), location: res.headers()['location'] || '' });
  });
  return done;
}

async function rpcFromNode(origin, fn, args, { token, sid } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(origin + '/api/rpc', { method: 'POST', headers, body: JSON.stringify({ fn, args, sid }) });
  return { status: r.status, json: await r.json() };
}

async function loginWithPin(page, origin, email, pin) {
  await page.goto(origin + '/App_Manicure.html');
  await page.fill('#loginUserInput', email);
  await page.fill('#pinInput', pin);
  await page.click('#btnUnlock');
}

// Amanhã em America/Sao_Paulo (fuso do studio e do navegador do teste).
function tomorrowIso() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(Date.now() + 24 * 3600 * 1000));
}

// ---------------------------------------------------------------------------
// Cenários
// ---------------------------------------------------------------------------
const scenarios = [];
const test = (name, fn) => scenarios.push({ name, fn });

test('cliente agenda e vê o Pix', async ({ browser, origin, apiLog, errors }) => {
  const ctx = await newContext(browser, origin, apiLog);
  const page = await newPage(ctx, errors);
  await page.goto(`${origin}/Pagina_Cliente.html?s=${SID}`);
  await page.waitForSelector('.srv-card');
  assert.equal((await page.textContent('#cStudioName')).trim(), 'Studio Bella Nails');
  await page.click('.srv-card >> nth=0');
  await page.click('.day-pill >> nth=1'); // amanhã (o studio atende todos os dias)
  await page.waitForSelector('.slot:not(.busy)');
  await page.click('.slot:not(.busy) >> nth=0');
  await page.fill('#cNome', CLIENTE);
  await page.fill('#cWhats', CLIENTE_WHATS);
  await page.click('.pay-card:has-text("50%")');
  await page.click('#cBtnSubmit');
  await page.waitForSelector('#cPixModal.open', { timeout: 15_000 });
  assert.equal((await page.textContent('#cPixVal')).trim(), 'R$ 60,00');
  const pix = (await page.textContent('#cPixRaw')).trim();
  assert.match(pix, /^000201/);
  assert.ok(pix.includes('540560.00'), 'BR Code com o valor do sinal (campo 54 = 60.00)');
  assert.ok(await page.locator('#cQrCanvas img, #cQrCanvas canvas').count() > 0, 'QR desenhado');
  await shot(page, '03_cliente_pix');

  // A reserva foi para a planilha do studio, com sinal de 50%.
  const db = await (await fetch(apiLog.googleBase + '/__db')).json();
  const row = db[SID].Agendamentos.find((r) => r[4] === CLIENTE);
  assert.ok(row, 'linha gravada em Agendamentos');
  assert.equal(row[1], tomorrowIso());
  assert.equal(row[9], 'PIX_SINAL_50');
  assert.match(row[12], /^fake-event-/, 'evento criado na Agenda pelo servidor');

  // Meus Horários
  await page.click('#cPixModal button:has-text("Fechar")');
  await page.click('#tabBtnMy');
  await page.fill('#cLookupWhats', CLIENTE_WHATS);
  await page.click('#cMyBookingsView button:has-text("Buscar")');
  await page.waitForFunction((n) => document.getElementById('cMyBookingsList').textContent.includes(n), 'Alongamento em Gel');
  await shot(page, '04_cliente_meus_horarios');
  await ctx.close();
});

test('manicure entra com e-mail e PIN e vê a reserva nova na Agenda', async ({ browser, origin, apiLog, errors }) => {
  const ctx = await newContext(browser, origin, apiLog);
  const page = await newPage(ctx, errors);
  await page.goto(origin + '/App_Manicure.html');
  await page.waitForSelector('#btnUnlock');
  await shot(page, '01_login');
  await loginWithPin(page, origin, EMAIL, PIN);
  await page.waitForSelector('#lockScreen.hidden', { state: 'attached', timeout: 15_000 });
  await page.waitForFunction((n) => document.getElementById('bookingsList').textContent.includes(n), CLIENTE, { timeout: 15_000 });
  assert.equal((await page.textContent('#hdrStudioName')).trim(), 'Studio Bella Nails');
  assert.equal(await page.inputValue('#clientPageUrlInput'), `${origin}/Pagina_Cliente.html?s=${SID}`);
  if (SHOTS) await page.waitForFunction(() => document.getElementById('toast').style.display === 'none');
  await shot(page, '02_agenda');

  // Opções: status da Agenda vem do servidor (adminGetGcalStatus), sem segredos.
  await page.click('.nav-btn:has-text("Opções")');
  await page.waitForFunction(() => document.getElementById('gcalStatusBadge').textContent.includes('Conectada & Ativa'));
  assert.ok(await page.evaluate(() => sessionStorage.getItem('NAIL_ADM_TOKEN')), 'token de sessão guardado');
  await ctx.close();
});

test('PIN errado mostra "Senha / PIN incorreto!"', async ({ browser, origin, apiLog, errors }) => {
  const ctx = await newContext(browser, origin, apiLog);
  const page = await newPage(ctx, errors);
  await loginWithPin(page, origin, EMAIL, '1111');
  await waitToast(page, 'Senha / PIN incorreto!');
  assert.ok(!(await page.locator('#lockScreen').getAttribute('class')).includes('hidden'));
  await ctx.close();
});

test('PIN legado 123456 pede para entrar com Google e criar um PIN', async ({ browser, origin, apiLog, errors }) => {
  const ctx = await newContext(browser, origin, apiLog);
  const page = await newPage(ctx, errors);
  await loginWithPin(page, origin, 'legado@exemplo.com', '123456');
  await waitToast(page, 'Defina um PIN: entre com Google e crie um novo PIN.');
  await ctx.close();
});

test('botões Google abrem /api/oauth/start (Esqueci a senha → recover)', async ({ browser, origin, apiLog, errors }) => {
  const ctx = await newContext(browser, origin, apiLog);
  const oauth = captureOAuthStart(ctx, origin);
  const page = await newPage(ctx, errors);
  await page.goto(origin + '/App_Manicure.html');
  await page.click('#btnForgotPin');
  assert.ok(await page.isVisible('#btnRecoverGoogle'));
  assert.ok(!(await page.isVisible('#recNewPinInput')), 'Novo PIN só depois do Google');
  await page.click('#btnRecoverGoogle');
  const { start, status, location } = await oauth;
  assert.equal(start.searchParams.get('intent'), 'recover');
  assert.equal(start.searchParams.get('app'), '0');
  assert.equal(status, 302);
  const g = new URL(location);
  assert.equal(g.origin + g.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(g.searchParams.get('redirect_uri'), origin + '/api/oauth/callback');
  await ctx.close();
});

test('recuperar PIN: retorno do Google (intent=recover) → Novo PIN → entra com o PIN novo', async ({ browser, origin, apiLog, errors }) => {
  const login = await rpcFromNode(origin, 'authenticateAdmin', [{ loginId: EMAIL, pin: PIN }]);
  assert.equal(login.status, 200);
  const ctx = await newContext(browser, origin, apiLog);
  const page = await newPage(ctx, errors);
  await page.goto(`${origin}/App_Manicure.html#google_auth=success&token=${encodeURIComponent(login.json.data.token)}&email=${encodeURIComponent(EMAIL)}&intent=recover`);
  await page.waitForSelector('#recNewPinInput', { state: 'visible' });
  assert.equal(await page.evaluate(() => location.hash), '', 'fragmento limpo');
  assert.ok(!(await page.isVisible('#btnRecoverGoogle')));
  await page.fill('#recNewPinInput', '4321');
  await page.click('#btnRecover');
  await page.waitForSelector('#lockScreen.hidden', { state: 'attached', timeout: 15_000 });
  await ctx.close();

  // PIN antigo deixou de valer; o novo entra.
  const old = await rpcFromNode(origin, 'authenticateAdmin', [{ loginId: EMAIL, pin: PIN }]);
  assert.equal(old.json.error, 'Senha / PIN incorreto!');
  const ctx2 = await newContext(browser, origin, apiLog);
  const page2 = await newPage(ctx2, errors);
  await loginWithPin(page2, origin, EMAIL, '4321');
  await page2.waitForSelector('#lockScreen.hidden', { state: 'attached', timeout: 15_000 });
  await ctx2.close();
});

test('Opções: novo PIN chama adminSetPin e mostra o erro do servidor', async ({ browser, origin, apiLog, errors }) => {
  const ctx = await newContext(browser, origin, apiLog);
  const page = await newPage(ctx, errors);
  await loginWithPin(page, origin, EMAIL, '4321');
  await page.waitForSelector('#lockScreen.hidden', { state: 'attached', timeout: 15_000 });
  await page.click('.nav-btn:has-text("Opções")');
  await page.evaluate(() => { document.getElementById('advOptionsDetails').open = true; });
  await page.fill('#cfgNovoPin', '123456');
  await page.click('#btnSaveCfg');
  await waitToast(page, 'Escolha um PIN diferente de 123456.');
  await page.fill('#cfgNovoPin', PIN);
  await page.click('#btnSaveCfg');
  await waitToast(page, 'Configurações gravadas');
  assert.equal(await page.inputValue('#cfgNovoPin'), '');
  await ctx.close();
  const back = await rpcFromNode(origin, 'authenticateAdmin', [{ loginId: EMAIL, pin: PIN }]);
  assert.equal(back.status, 200, 'PIN trocado pelas Opções');
});

test('Conectar Google Agenda usa token curto (calstart), nunca o de sessão', async ({ browser, origin, apiLog, errors }) => {
  const ctx = await newContext(browser, origin, apiLog);
  const oauth = captureOAuthStart(ctx, origin);
  const page = await newPage(ctx, errors);
  await loginWithPin(page, origin, EMAIL, PIN);
  await page.waitForSelector('#lockScreen.hidden', { state: 'attached', timeout: 15_000 });
  const session = await page.evaluate(() => sessionStorage.getItem('NAIL_ADM_TOKEN'));
  // Desconecta (servidor) para o botão de conexão aparecer.
  await page.click('.nav-btn:has-text("Opções")');
  await page.waitForSelector('#gcalConnectedActions:not(.hidden)');
  await page.click('#gcalConnectedActions button:has-text("Desconectar")');
  await page.waitForSelector('#btnConnectGCal', { state: 'visible' });
  await page.click('#btnConnectGCal');
  const { start, status, location } = await oauth;
  await page.waitForURL(/\/api\/oauth\/start/);
  assert.equal(start.searchParams.get('intent'), 'calendar');
  const t = start.searchParams.get('t');
  assert.ok(t && t !== session, 'token na URL não é o de sessão');
  const payload = JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());
  assert.equal(payload.kind, 'calstart');
  assert.equal(status, 302, 'Worker aceitou o token calstart');
  assert.match(location, /^https:\/\/accounts\.google\.com\/.*calendar\.events/);

  // Volta do Google: #gcal=connected mostra toast e recarrega o status.
  await page.goto(origin + '/App_Manicure.html#gcal=connected');
  await waitToast(page, 'Google Agenda conectada');
  assert.equal(await page.evaluate(() => location.hash), '');
  await ctx.close();
});

test('criar acesso: retorno pending abre o cadastro com e-mail do Google (só leitura)', async ({ browser, origin, apiLog, errors }) => {
  const pending = await signToken({ kind: 'pending', email: 'nova@exemplo.com', name: 'Nova' }, SESSION_SECRET, 1800);
  const ctx = await newContext(browser, origin, apiLog);
  const page = await newPage(ctx, errors);
  await page.goto(`${origin}/App_Manicure.html#google_auth=pending&token=${encodeURIComponent(pending)}&email=nova%40exemplo.com`);
  await page.waitForSelector('#authModeOnboarding:not(.hidden)');
  assert.equal(await page.evaluate(() => location.hash), '');
  assert.equal(await page.inputValue('#autoEmail'), 'nova@exemplo.com');
  assert.ok(await page.locator('#autoEmail').getAttribute('readonly') !== null);
  await page.fill('#autoStudioNome', 'Studio Nova');
  await page.fill('#autoWhatsapp', '11955554444');
  await page.fill('#autoPin', '9753');
  await page.click('#btnAutoCreate');
  await page.waitForSelector('#lockScreen.hidden', { state: 'attached', timeout: 20_000 });
  await page.waitForFunction(() => document.getElementById('hdrStudioName').textContent.includes('Studio Nova'));
  await ctx.close();
  const db = await (await fetch(apiLog.googleBase + '/__db')).json();
  assert.ok(db[MASTER].Contas_Manicures.some((r) => r[0] === 'nova@exemplo.com'), 'conta registrada na mestre');
});

test('retorno google_auth=error mostra a mensagem', async ({ browser, origin, apiLog, errors }) => {
  const ctx = await newContext(browser, origin, apiLog);
  const page = await newPage(ctx, errors);
  await page.goto(`${origin}/App_Manicure.html#google_auth=error&msg=${encodeURIComponent('Login com Google cancelado.')}`);
  await waitToast(page, 'Login com Google cancelado.');
  assert.equal(await page.evaluate(() => location.hash), '');
  await ctx.close();
});

test('retorno do Google com a página já aberta (hashchange) mostra a mensagem', async ({ browser, origin, apiLog, errors }) => {
  const ctx = await newContext(browser, origin, apiLog);
  const page = await newPage(ctx, errors);
  await page.goto(`${origin}/App_Manicure.html?r=123`);
  await page.waitForSelector('#lockScreen');
  await page.evaluate((m) => { location.hash = `google_auth=error&msg=${encodeURIComponent(m)}`; }, 'Aviso aquecido.');
  await waitToast(page, 'Aviso aquecido.');
  await ctx.close();
});

test('nenhuma resposta de /api/* contém "GCAL_REFRESH_TOKEN" nem "ADMIN_PIN_HASH"', async ({ apiLog }) => {
  assert.ok(apiLog.responses.length > 10, 'respostas da API capturadas');
  const pinHash = await hashPin(PIN);
  for (const r of apiLog.responses) {
    for (const bad of ['GCAL_REFRESH_TOKEN', 'ADMIN_PIN_HASH', GCAL_SECRET, pinHash]) {
      assert.ok(!r.body.includes(bad), `${r.url} contém ${bad}`);
    }
  }
});

test('HTML servido não contém "clientSecret" nem "refreshToken"', async ({ origin, apiLog }) => {
  for (const p of ['/App_Manicure.html', '/Pagina_Cliente.html']) {
    const html = await (await fetch(origin + p)).text();
    for (const bad of ['clientSecret', 'refreshToken', 'client_secret', 'GSHEET_CONFIG', 'googleapis.com/v4', 'oauth2.googleapis.com']) {
      assert.ok(!html.includes(bad), `${p} contém ${bad}`);
    }
  }
  const google = apiLog.external.filter((u) => /(sheets|www|oauth2)\.googleapis\.com/.test(u));
  assert.deepEqual(google, [], 'o navegador nunca fala com as APIs do Google');
});

// ---------------------------------------------------------------------------
async function main() {
  const google = await startFakeGoogleServer(await seed());
  let wrangler;
  let browser;
  let failed = 0;
  try {
    wrangler = await startWrangler(google.base);
    browser = await chromium.launch();
    const apiLog = { responses: [], external: [], googleBase: google.base };
    const errors = [];
    for (const s of scenarios) {
      const before = errors.length;
      try {
        await s.fn({ browser, origin: wrangler.origin, apiLog, errors });
        if (errors.length > before) throw new Error('erro de JavaScript na página: ' + errors.slice(before).join(' | '));
        console.log('  ✓ ' + s.name);
      } catch (e) {
        failed++;
        console.log('  ✗ ' + s.name + '\n      ' + String(e && e.stack || e).split('\n').slice(0, 4).join('\n      '));
      }
    }
  } finally {
    if (browser) await browser.close();
    if (wrangler) {
      if (failed) console.log('--- wrangler log ---\n' + wrangler.log().slice(-3000));
      wrangler.stop();
    }
    await google.close();
  }
  console.log(`\n${scenarios.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
