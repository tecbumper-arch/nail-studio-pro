/**
 * =============================================================================
 * 💅 NAIL STUDIO PRO — API CENTRAL SEGURA (Google Apps Script Web App)  v3.0
 * =============================================================================
 * Este é o "servidor" do app. Ele roda 24h na nuvem do Google, de graça, e é o
 * ÚNICO lugar que guarda segredos (Client Secret, tokens da Google Agenda).
 * Os arquivos HTML públicos (GitHub Pages / APK) NÃO têm mais nenhuma senha.
 *
 * O que ele faz:
 *  - Login REAL com Conta Google (verifica o ID Token assinado pelo Google)
 *  - Login alternativo por e-mail + PIN (com bloqueio após 5 erros)
 *  - Cria automaticamente a planilha de cada Studio no primeiro acesso
 *  - Agendamentos da cliente com trava anti-agendamento-duplo (LockService)
 *  - Google Agenda da manicure: cria / move / apaga eventos automaticamente e
 *    BLOQUEIA na página da cliente os horários ocupados na agenda pessoal dela
 *  - Feed .ics (assinar a agenda no iPhone / Outlook / qualquer app)
 *  - Resumo diário por e-mail às 7h (opcional, por studio)
 *
 * Instalação: veja backend/README.md (passo a passo com prints em texto).
 * =============================================================================
 */

var API_VERSION = '3.0.0';

var TAB_CONFIG = 'Configuracoes';
var TAB_CATS = 'Categorias';
var TAB_CATALOG = 'Catalogo';
var TAB_BOOKINGS = 'Agendamentos';
var TAB_LOGS = 'Logs_Seguranca';
var TAB_DIRECTORY = 'Contas_Manicures';

var BOOKING_HEADER = ['ID_Reserva', 'Data', 'HoraInicio', 'HoraFim', 'ClienteNome', 'ClienteWhatsApp', 'ServicoID', 'ServicoNome', 'Valor', 'MetodoPagamento', 'StatusPagamento', 'StatusReserva', 'CalendarEventID', 'CriadoEm', 'Observacoes'];
var CATALOG_HEADER = ['ID', 'Nome', 'Descricao', 'Preco', 'DuracaoMin', 'FotoURL', 'Categoria', 'Ativo'];
var CATS_HEADER = ['ID_Categoria', 'Nome', 'Icone', 'Ordem', 'Ativo'];
var DIRECTORY_HEADER = ['Email', 'Profissional', 'StudioNome', 'SheetId', 'SheetUrl', 'ClientLink', 'PinHashLegado', 'RecHashLegado', 'CriadoEm'];

// Colunas da aba Agendamentos (índice 0)
var B = { ID: 0, DATA: 1, INI: 2, FIM: 3, NOME: 4, WHATS: 5, SRV_ID: 6, SRV_NOME: 7, VALOR: 8, METODO: 9, PAG: 10, STATUS: 11, GCAL: 12, CRIADO: 13, OBS: 14 };

// Chaves de configuração que NUNCA saem do servidor
var SECRET_CONFIG_KEYS = ['ADMIN_PIN_HASH', 'ADMIN_RECOVERY_HASH', 'GCAL_REFRESH_TOKEN', 'SESSION_VERSION'];

var CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
var SESSION_DAYS = 30;

// =============================================================================
// CONFIGURAÇÃO (Propriedades do Script)
// =============================================================================
function prop_(key, def) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  return (v === null || v === undefined || v === '') ? (def || '') : v;
}

function setProp_(key, value) {
  var p = PropertiesService.getScriptProperties();
  if (value === null || value === undefined || value === '') p.deleteProperty(key);
  else p.setProperty(key, String(value));
}

function allowedClientIds_() {
  return String(prop_('GOOGLE_CLIENT_ID') + ',' + prop_('EXTRA_CLIENT_IDS'))
    .split(',').map(function (s) { return s.trim(); }).filter(String);
}

function publicBaseUrl_() {
  return prop_('PUBLIC_BASE_URL', 'https://tecbumper-arch.github.io/nail-studio-pro').replace(/\/+$/, '');
}

function sessionSecret_() {
  var s = prop_('SESSION_SECRET');
  if (!s) {
    s = Utilities.getUuid() + Utilities.getUuid();
    setProp_('SESSION_SECRET', s);
  }
  return s;
}

/**
 * Rode UMA VEZ pelo editor (botão ▶ Executar) depois de preencher as propriedades.
 * Cria o segredo de sessão, a planilha-diretório (se faltar) e o gatilho diário.
 */
function setup() {
  sessionSecret_();
  var masterId = prop_('MASTER_SPREADSHEET_ID');
  if (!masterId) {
    var ss = SpreadsheetApp.create('Nail Studio Pro - Diretório de Studios (NÃO COMPARTILHE)');
    var sh = ss.getSheets()[0];
    sh.setName(TAB_DIRECTORY);
    sh.getRange(1, 1, 1, DIRECTORY_HEADER.length).setValues([DIRECTORY_HEADER]);
    setProp_('MASTER_SPREADSHEET_ID', ss.getId());
    masterId = ss.getId();
  }
  directorySheet_();

  var triggers = ScriptApp.getProjectTriggers();
  var hasDaily = triggers.some(function (t) { return t.getHandlerFunction() === 'enviarResumosDiarios'; });
  if (!hasDaily) {
    ScriptApp.newTrigger('enviarResumosDiarios').timeBased().everyDays(1).atHour(7).create();
  }
  Logger.log(diagnostico());
}

/** Mostra no log o que está configurado (sem revelar segredos). */
function diagnostico() {
  var lines = [];
  lines.push('API_VERSION: ' + API_VERSION);
  lines.push('GOOGLE_CLIENT_ID: ' + (prop_('GOOGLE_CLIENT_ID') ? 'OK' : '❌ FALTANDO'));
  lines.push('GOOGLE_CLIENT_SECRET: ' + (prop_('GOOGLE_CLIENT_SECRET') ? 'OK' : '❌ FALTANDO (necessário p/ Google Agenda)'));
  lines.push('MASTER_SPREADSHEET_ID: ' + (prop_('MASTER_SPREADSHEET_ID') || '❌ FALTANDO'));
  lines.push('PUBLIC_BASE_URL: ' + publicBaseUrl_());
  lines.push('SESSION_SECRET: ' + (prop_('SESSION_SECRET') ? 'OK' : 'será criado'));
  lines.push('Fuso horário: ' + Session.getScriptTimeZone());
  return lines.join('\n');
}

// =============================================================================
// HTTP
// =============================================================================
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.ics) return icsFeed_(p.ics);
  return json_({ ok: true, service: 'Nail Studio Pro API', version: API_VERSION });
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'Requisição inválida.' });
  }
  return json_(dispatch_(req));
}

function dispatch_(req) {
  var fn = String(req.fn || '');
  var args = req.args || {};
  try {
    var data;
    if (Object.prototype.hasOwnProperty.call(PUBLIC_API, fn)) {
      data = PUBLIC_API[fn](args);
    } else if (Object.prototype.hasOwnProperty.call(ADMIN_API, fn)) {
      var ctx = requireSession_(req.session);
      data = ADMIN_API[fn](ctx, args);
    } else {
      throw new Error('Função desconhecida: ' + fn);
    }
    return { ok: true, data: data };
  } catch (err) {
    var msg = (err && err.message) ? err.message : String(err);
    if (msg.indexOf('SESSAO_') === 0) return { ok: false, error: 'Sua sessão expirou. Entre novamente.', code: msg };
    return { ok: false, error: msg };
  }
}

// =============================================================================
// UTILITÁRIOS
// =============================================================================
function str_(v, max) {
  var s = String(v === null || v === undefined ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim();
  // Evita injeção de fórmulas na planilha
  while (/^[=+\-@]/.test(s)) s = s.substring(1).trim();
  return s.substring(0, max || 200);
}

function normPhone_(v) {
  var d = String(v || '').replace(/\D/g, '').replace(/^0+/, '');
  if (!d) return '';
  if (d.indexOf('55') === 0 && (d.length === 12 || d.length === 13)) return d;
  if (d.length === 10 || d.length === 11) return '55' + d;
  return d;
}

function isValidPhone_(v) {
  var d = normPhone_(v);
  return d.indexOf('55') === 0 && (d.length === 12 || d.length === 13);
}

function samePhone_(a, b) {
  var x = normPhone_(a), y = normPhone_(b);
  return !!x && !!y && x.slice(-8) === y.slice(-8);
}

function normDate_(v) {
  var s = String(v || '').trim();
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
  return s;
}

function normTime_(v) {
  var m = String(v || '').match(/(\d{1,2}):(\d{2})/);
  return m ? ('0' + m[1]).slice(-2) + ':' + m[2] : '';
}

function isIsoDate_(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }

function toMin_(t) {
  var p = String(t || '00:00').split(':');
  return (Number(p[0]) || 0) * 60 + (Number(p[1]) || 0);
}

function fromMin_(m) {
  m = Math.max(0, Math.min(1439, Math.round(m)));
  return ('0' + Math.floor(m / 60)).slice(-2) + ':' + ('0' + (m % 60)).slice(-2);
}

function dayNumber_(iso) {
  var p = iso.split('-').map(Number);
  return Math.floor(Date.UTC(p[0], p[1] - 1, p[2]) / 86400000);
}

function addDays_(iso, n) {
  var p = iso.split('-').map(Number);
  var d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
  return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2);
}

function weekday_(iso) {
  var p = iso.split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
}

function nowInTz_(tz) {
  var d = new Date();
  return { date: Utilities.formatDate(d, tz, 'yyyy-MM-dd'), minutes: toMin_(Utilities.formatDate(d, tz, 'HH:mm')), stamp: Utilities.formatDate(d, tz, 'dd/MM/yyyy HH:mm:ss') };
}

function sha256Hex_(text) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text), Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function randomId_(prefix) {
  return prefix + Utilities.getUuid().replace(/-/g, '').substring(0, 6).toUpperCase();
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) throw new Error('Muitas pessoas agendando ao mesmo tempo. Tente novamente em alguns segundos.');
  try { return fn(); } finally { lock.releaseLock(); }
}

function cache_() { return CacheService.getScriptCache(); }

// =============================================================================
// TOKENS ASSINADOS (sessão, cadastro, feed .ics)
// =============================================================================
function b64uEncode_(s) { return Utilities.base64EncodeWebSafe(s, Utilities.Charset.UTF_8); }
function b64uDecode_(s) { return Utilities.newBlob(Utilities.base64DecodeWebSafe(s, Utilities.Charset.UTF_8)).getDataAsString('UTF-8'); }

function sign_(s) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(s, sessionSecret_())).replace(/=+$/, '');
}

function safeEq_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  var r = 0;
  for (var i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function makeToken_(payload) {
  var body = b64uEncode_(JSON.stringify(payload));
  return body + '.' + sign_(body);
}

function readToken_(token, type) {
  var parts = String(token || '').split('.');
  if (parts.length !== 2 || !safeEq_(sign_(parts[0]), parts[1])) return null;
  var p;
  try { p = JSON.parse(b64uDecode_(parts[0])); } catch (e) { return null; }
  if (!p || p.t !== type || !p.x || p.x < Date.now()) return null;
  return p;
}

function icsToken_(sheetId) { return sheetId + '.' + sign_('ics:' + sheetId).substring(0, 20); }

// =============================================================================
// PLANILHAS
// =============================================================================
function cellToString_(v, tz) {
  if (v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    if (isNaN(v.getTime())) return '';
    if (v.getFullYear() < 1901) return Utilities.formatDate(v, tz, 'HH:mm');
    var hms = Utilities.formatDate(v, tz, 'HH:mm:ss');
    return hms === '00:00:00' ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : Utilities.formatDate(v, tz, 'yyyy-MM-dd HH:mm');
  }
  if (typeof v === 'boolean') return v ? 'SIM' : 'NAO';
  return String(v);
}

function readTab_(ctx, name) {
  var sh = ctx.ss.getSheetByName(name);
  if (!sh) return { sheet: null, rows: [] };
  var range = sh.getDataRange();
  var values = range.getValues();
  var rows = values.map(function (r) { return r.map(function (c) { return cellToString_(c, ctx.tz); }); });
  return { sheet: sh, rows: rows };
}

function ensureTab_(ctx, name, header) {
  var sh = ctx.ss.getSheetByName(name);
  if (!sh) {
    sh = ctx.ss.insertSheet(name);
    sh.getRange(1, 1, 1, header.length).setValues([header]);
  } else if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, header.length).setValues([header]);
  } else if (header === BOOKING_HEADER && sh.getLastColumn() < header.length) {
    sh.getRange(1, 1, 1, header.length).setValues([header]);
  }
  return sh;
}

function writeRow_(sheet, rowNumber, values) {
  var range = sheet.getRange(rowNumber, 1, 1, values.length);
  range.setNumberFormat('@');
  range.setValues([values.map(function (v) { return v === null || v === undefined ? '' : String(v); })]);
}

function appendRow_(sheet, values) {
  var row = Math.max(sheet.getLastRow(), 1) + 1;
  writeRow_(sheet, row, values);
  return row;
}

function writeTable_(sheet, rows) {
  sheet.clearContents();
  if (!rows.length) return;
  var width = rows.reduce(function (w, r) { return Math.max(w, r.length); }, 0);
  var padded = rows.map(function (r) {
    var out = r.slice();
    while (out.length < width) out.push('');
    return out.map(function (v) { return v === null || v === undefined ? '' : String(v); });
  });
  var range = sheet.getRange(1, 1, padded.length, width);
  range.setNumberFormat('@');
  range.setValues(padded);
}

// =============================================================================
// DIRETÓRIO DE STUDIOS (planilha mestre privada)
// =============================================================================
function directorySheet_() {
  var id = prop_('MASTER_SPREADSHEET_ID');
  if (!id) throw new Error('Servidor não configurado (MASTER_SPREADSHEET_ID). Rode setup() no Apps Script.');
  var ss = SpreadsheetApp.openById(id);
  var sh = ss.getSheetByName(TAB_DIRECTORY);
  if (!sh) {
    sh = ss.insertSheet(TAB_DIRECTORY);
    sh.getRange(1, 1, 1, DIRECTORY_HEADER.length).setValues([DIRECTORY_HEADER]);
  }
  return sh;
}

function directoryRows_() {
  var sh = directorySheet_();
  return sh.getDataRange().getValues().map(function (r) { return r.map(function (c) { return String(c === null ? '' : c); }); });
}

function findStudioByEmail_(email) {
  var e = String(email || '').trim().toLowerCase();
  if (!e) return null;
  var rows = directoryRows_();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim().toLowerCase() === e && rows[i][3]) {
      return { email: e, sheetId: String(rows[i][3]).trim(), row: i + 1 };
    }
  }
  return null;
}

function isRegisteredSheet_(sheetId) {
  var id = String(sheetId || '').trim();
  if (!/^[A-Za-z0-9_-]{20,}$/.test(id)) return false;
  var c = cache_();
  if (c.get('reg:' + id) === '1') return true;
  var rows = directoryRows_();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][3]).trim() === id) {
      c.put('reg:' + id, '1', 600);
      return true;
    }
  }
  return false;
}

// =============================================================================
// CONTEXTO DO STUDIO
// =============================================================================
function openStudio_(sheetId) {
  var ss = SpreadsheetApp.openById(sheetId);
  var ctx = { ss: ss, sheetId: sheetId, tz: Session.getScriptTimeZone() };
  try { ctx.tz = ss.getSpreadsheetTimeZone() || ctx.tz; } catch (e) {}
  ctx.cfg = readConfig_(ctx);
  if (ctx.cfg.TIMEZONE) ctx.tz = ctx.cfg.TIMEZONE;
  return ctx;
}

function openPublicStudio_(sheetId) {
  if (!isRegisteredSheet_(sheetId)) throw new Error('Studio não encontrado. Peça o link atualizado para sua manicure.');
  return openStudio_(String(sheetId).trim());
}

function readConfig_(ctx) {
  var t = readTab_(ctx, TAB_CONFIG);
  var map = {};
  for (var i = 1; i < t.rows.length; i++) {
    var k = String(t.rows[i][0] || '').trim();
    if (k) map[k] = t.rows[i][1] || '';
  }
  return map;
}

function upsertConfig_(ctx, updates) {
  var sh = ensureTab_(ctx, TAB_CONFIG, ['Chave', 'Valor', 'Descricao']);
  var values = sh.getDataRange().getValues();
  var keys = Object.keys(updates);
  keys.forEach(function (k) {
    var val = updates[k] === null || updates[k] === undefined ? '' : String(updates[k]);
    var found = false;
    for (var i = 1; i < values.length; i++) {
      if (String(values[i][0]).trim() === k) {
        var cell = sh.getRange(i + 1, 2);
        cell.setNumberFormat('@');
        cell.setValue(val);
        found = true;
      }
    }
    if (!found) {
      appendRow_(sh, [k, val, '']);
      values.push([k, val, '']);
    }
    ctx.cfg[k] = val;
  });
}

function studioPublic_(ctx) {
  var c = ctx.cfg;
  return {
    spreadsheetId: ctx.sheetId,
    nome: c.STUDIO_NOME || 'Meu Studio de Unhas',
    profissional: c.PROFISSIONAL_NOME || 'Manicure & Nail Designer',
    whatsapp: c.WHATSAPP_STUDIO || '',
    pixChave: c.PIX_CHAVE || '',
    pixRecebedor: c.PIX_RECEBEDOR || c.PROFISSIONAL_NOME || 'STUDIO NAILS',
    pixCidade: c.PIX_CIDADE || 'SAO PAULO',
    temaCor: c.TEMA_COR || 'pink-gold',
    horarioInicio: normTime_(c.HORARIO_INICIO) || '09:00',
    horarioFim: normTime_(c.HORARIO_FIM) || '19:00',
    almocoInicio: normTime_(c.ALMOCO_INICIO),
    almocoFim: normTime_(c.ALMOCO_FIM),
    diasAtendimento: c.DIAS_ATENDIMENTO || '1,2,3,4,5,6',
    intervaloMinutos: Number(c.INTERVALO_MINUTOS || 60) || 60,
    instagram: c.INSTAGRAM_STUDIO || '',
    endereco: c.ENDERECO_STUDIO || '',
    antecedenciaMinHoras: Number(c.ANTECEDENCIA_MIN_HORAS || 2),
    janelaMaxDias: Number(c.JANELA_MAX_DIAS || 60) || 60,
    cancelamentoMinHoras: Number(c.CANCELAMENTO_MIN_HORAS || 12),
    aceitaPagarNoStudio: String(c.ACEITA_PAGAR_NO_STUDIO || 'SIM').toUpperCase() !== 'NAO',
    mensagemBoasVindas: c.MENSAGEM_BOAS_VINDAS || '',
    politicaCancelamento: c.POLITICA_CANCELAMENTO || ''
  };
}

function studioAdmin_(ctx) {
  var s = studioPublic_(ctx);
  var c = ctx.cfg;
  s.setupConcluido = String(c.SETUP_CONCLUIDO || 'NAO').toUpperCase() === 'SIM';
  s.loginId = c.ADMIN_LOGIN_ID || '';
  s.spreadsheetUrl = 'https://docs.google.com/spreadsheets/d/' + ctx.sheetId + '/edit';
  s.clientLink = publicBaseUrl_() + '/Pagina_Cliente.html?s=' + ctx.sheetId;
  s.sincronizarAgenda = c.SINCRONIZAR_AGENDA || 'SIM';
  s.bloquearComGoogleAgenda = String(c.BLOQUEAR_COM_GOOGLE_AGENDA || 'SIM').toUpperCase() !== 'NAO';
  s.resumoDiario = String(c.RESUMO_DIARIO || 'NAO').toUpperCase() === 'SIM';
  s.linkAvaliacao = c.LINK_AVALIACAO || '';
  s.diasRetorno = Number(c.DIAS_RETORNO || 15) || 15;
  s.temPin = !!c.ADMIN_PIN_HASH;
  return s;
}

function logEvent_(ctx, evento, detalhes) {
  try {
    var sh = ensureTab_(ctx, TAB_LOGS, ['Timestamp', 'Evento', 'Detalhes']);
    if (sh.getLastRow() > 2000) sh.deleteRows(2, 500);
    appendRow_(sh, [nowInTz_(ctx.tz).stamp, evento, str_(detalhes, 300)]);
  } catch (e) {}
}

// =============================================================================
// CATÁLOGO / CATEGORIAS / AGENDAMENTOS (leitura)
// =============================================================================
var DEFAULT_CATS = [
  ['CAT-01', 'Alongamentos', '💅', '1', 'SIM'],
  ['CAT-02', 'Manicure & Pedicure', '✨', '2', 'SIM'],
  ['CAT-03', 'Blindagem & Banho de Gel', '💎', '3', 'SIM'],
  ['CAT-04', 'Nail Art & Decoradas', '🎨', '4', 'SIM'],
  ['CAT-05', 'Spa dos Pés & Mãos', '🌸', '5', 'SIM']
];

// Sem foto: o app mostra a miniatura da categoria (assets/thumbs, desenhadas no Figma)
var DEFAULT_SERVICES = [
  ['SRV-101', 'Alongamento em Fibra de Vidro', 'Alongamento resistente com acabamento natural, curvatura perfeita e esmaltação em gel inclusa.', '160', '120', '', 'Alongamentos', 'SIM'],
  ['SRV-102', 'Manutenção de Alongamento', 'Manutenção completa (até 21 dias), nivelamento, cuticulagem e nova esmaltação.', '110', '90', '', 'Alongamentos', 'SIM'],
  ['SRV-103', 'Banho de Gel / Blindagem', 'Camada protetora de gel sobre a unha natural para maior durabilidade e brilho intenso.', '90', '60', '', 'Blindagem & Banho de Gel', 'SIM'],
  ['SRV-104', 'Pé e Mão Tradicional Completo', 'Cuticulagem funda, hidratação e esmaltação tradicional completa (mãos e pés).', '70', '60', '', 'Manicure & Pedicure', 'SIM']
];

function listCategories_(ctx) {
  var rows = readTab_(ctx, TAB_CATS).rows;
  var list = [];
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    if (r[0]) list.push({ id: r[0], nome: r[1] || 'Geral', icone: r[2] || '💅', ordem: Number(r[3] || i), ativo: String(r[4] || 'SIM').toUpperCase() === 'SIM' });
  }
  if (!list.length) {
    list = DEFAULT_CATS.map(function (r) { return { id: r[0], nome: r[1], icone: r[2], ordem: Number(r[3]), ativo: true }; });
  }
  return list.sort(function (a, b) { return a.ordem - b.ordem; });
}

function listServices_(ctx, onlyActive) {
  var rows = readTab_(ctx, TAB_CATALOG).rows;
  var list = [];
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    if (!r[0]) continue;
    var ativo = String(r[7] || 'SIM').toUpperCase() === 'SIM';
    if (onlyActive && !ativo) continue;
    list.push({ id: r[0], nome: r[1] || '', descricao: r[2] || '', preco: Number(String(r[3] || 0).replace(',', '.')) || 0, duracaoMin: Number(r[4] || 60) || 60, fotoUrl: r[5] || '', categoria: r[6] || 'Alongamentos', ativo: ativo });
  }
  return list;
}

function bookingFromRow_(r) {
  return {
    id: r[B.ID], data: normDate_(r[B.DATA]), horaInicio: normTime_(r[B.INI]), horaFim: normTime_(r[B.FIM]),
    clienteNome: r[B.NOME] || '', clienteWhatsApp: normPhone_(r[B.WHATS]) || String(r[B.WHATS] || ''),
    servicoId: r[B.SRV_ID] || '', servicoNome: r[B.SRV_NOME] || '', valor: Number(String(r[B.VALOR] || 0).replace(',', '.')) || 0,
    metodoPagamento: r[B.METODO] || '', statusPagamento: r[B.PAG] || '', statusReserva: String(r[B.STATUS] || 'RESERVADO').toUpperCase(),
    calendarEventId: r[B.GCAL] || '', criadoEm: r[B.CRIADO] || '', observacoes: r[B.OBS] || ''
  };
}

function listBookings_(ctx) {
  var t = readTab_(ctx, TAB_BOOKINGS);
  var list = [];
  for (var i = 1; i < t.rows.length; i++) {
    var r = t.rows[i];
    if (!r[0]) continue;
    var b = bookingFromRow_(r);
    b._row = i + 1;
    list.push(b);
  }
  return list;
}

function findBooking_(ctx, id) {
  var all = listBookings_(ctx);
  for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
  return null;
}

function bookingToRow_(b) {
  var r = [];
  r[B.ID] = b.id; r[B.DATA] = b.data; r[B.INI] = b.horaInicio; r[B.FIM] = b.horaFim;
  r[B.NOME] = b.clienteNome; r[B.WHATS] = b.clienteWhatsApp; r[B.SRV_ID] = b.servicoId; r[B.SRV_NOME] = b.servicoNome;
  r[B.VALOR] = b.valor; r[B.METODO] = b.metodoPagamento; r[B.PAG] = b.statusPagamento; r[B.STATUS] = b.statusReserva;
  r[B.GCAL] = b.calendarEventId || ''; r[B.CRIADO] = b.criadoEm || ''; r[B.OBS] = b.observacoes || '';
  return r;
}

function saveBooking_(ctx, b) {
  var sh = ensureTab_(ctx, TAB_BOOKINGS, BOOKING_HEADER);
  if (b._row) writeRow_(sh, b._row, bookingToRow_(b));
  else b._row = appendRow_(sh, bookingToRow_(b));
  return b;
}

function cleanBooking_(b) {
  var o = {};
  Object.keys(b).forEach(function (k) { if (k.charAt(0) !== '_') o[k] = b[k]; });
  return o;
}

function isActiveStatus_(s) {
  s = String(s || '').toUpperCase();
  return s !== 'CANCELADO' && s !== 'FALTOU';
}

// =============================================================================
// DISPONIBILIDADE (com bloqueio pela Google Agenda pessoal)
// =============================================================================
// -----------------------------------------------------------------------------
// HORÁRIOS POR DIA DA SEMANA + DATAS ESPECIAIS
//  - HORARIOS_SEMANA (config, JSON): {"1":{"ativo":true,"inicio":"09:00","fim":"19:00",
//    "almocoInicio":"12:00","almocoFim":"13:00","horarios":"09:00,11:00"}, ...}
//    "horarios" (opcional) = horários fixos de início; se vazio usa o intervalo.
//  - Aba Horarios_Especiais: uma linha por data (FECHADO ou ESPECIAL).
// -----------------------------------------------------------------------------
var TAB_SPECIAL = 'Horarios_Especiais';
var SPECIAL_HEADER = ['Data', 'Tipo', 'Inicio', 'Fim', 'AlmocoInicio', 'AlmocoFim', 'Horarios', 'Motivo'];
var WEEKDAY_NAMES = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

function parseTimes_(v) {
  var seen = {};
  return String(v || '').split(/[,;\s]+/).map(normTime_).filter(function (t) {
    if (!t || seen[t] || toMin_(t) >= 1440) return false;
    seen[t] = true;
    return true;
  }).sort();
}

function weeklySchedule_(ctx) {
  var st = studioPublic_(ctx);
  var legacyDays = String(st.diasAtendimento).split(',').map(function (x) { return Number(String(x).trim()); });
  var parsed = null;
  try { parsed = ctx.cfg.HORARIOS_SEMANA ? JSON.parse(ctx.cfg.HORARIOS_SEMANA) : null; } catch (e) { parsed = null; }
  var out = {};
  for (var d = 0; d < 7; d++) {
    var r = parsed && parsed[d];
    out[d] = r ? {
      ativo: !!r.ativo,
      inicio: normTime_(r.inicio) || st.horarioInicio,
      fim: normTime_(r.fim) || st.horarioFim,
      almocoInicio: normTime_(r.almocoInicio),
      almocoFim: normTime_(r.almocoFim),
      horarios: parseTimes_(r.horarios).join(', ')
    } : {
      ativo: legacyDays.indexOf(d) >= 0,
      inicio: st.horarioInicio, fim: st.horarioFim,
      almocoInicio: st.almocoInicio, almocoFim: st.almocoFim, horarios: ''
    };
  }
  return out;
}

function specialDays_(ctx) {
  var t = readTab_(ctx, TAB_SPECIAL);
  var map = {};
  for (var i = 1; i < t.rows.length; i++) {
    var r = t.rows[i];
    var data = normDate_(r[0]);
    if (!isIsoDate_(data)) continue;
    map[data] = {
      data: data, tipo: String(r[1] || 'FECHADO').toUpperCase() === 'ESPECIAL' ? 'ESPECIAL' : 'FECHADO',
      inicio: normTime_(r[2]), fim: normTime_(r[3]), almocoInicio: normTime_(r[4]), almocoFim: normTime_(r[5]),
      horarios: parseTimes_(r[6]).join(', '), motivo: r[7] || '', _row: i + 1
    };
  }
  return map;
}

/** Regra efetiva de um dia (data especial vence o padrão da semana). */
function dayRule_(ctx, dateStr, week, specials) {
  week = week || weeklySchedule_(ctx);
  specials = specials || specialDays_(ctx);
  var w = week[weekday_(dateStr)];
  var sp = specials[dateStr];
  if (sp && sp.tipo === 'FECHADO') return { aberto: false, especial: true, motivo: sp.motivo || 'Fechado' };
  var base = sp ? {
    aberto: true, especial: true, motivo: sp.motivo || '',
    inicio: sp.inicio || w.inicio, fim: sp.fim || w.fim,
    almocoInicio: sp.inicio || sp.fim ? sp.almocoInicio : (sp.almocoInicio || w.almocoInicio),
    almocoFim: sp.inicio || sp.fim ? sp.almocoFim : (sp.almocoFim || w.almocoFim),
    horarios: parseTimes_(sp.horarios)
  } : {
    aberto: w.ativo, especial: false, motivo: '',
    inicio: w.inicio, fim: w.fim, almocoInicio: w.almocoInicio, almocoFim: w.almocoFim, horarios: parseTimes_(w.horarios)
  };
  // Com horários fixos a profissional já escolheu cada início: pausa não se aplica
  if (base.horarios && base.horarios.length) { base.almocoInicio = ''; base.almocoFim = ''; }
  return base;
}

function computeSlots_(ctx, dateStr, serviceId, opts) {
  opts = opts || {};
  if (!isIsoDate_(dateStr)) throw new Error('Data inválida.');
  var st = studioPublic_(ctx);
  var rule = opts.rule || dayRule_(ctx, dateStr);
  if (!rule.aberto) return [];

  var now = nowInTz_(ctx.tz);
  var diff = dayNumber_(dateStr) - dayNumber_(now.date);
  if (diff < 0 && !opts.admin) return [];
  if (!opts.admin && diff > st.janelaMaxDias) return [];

  var duracao = st.intervaloMinutos;
  var services = opts.services || listServices_(ctx, false);
  for (var i = 0; i < services.length; i++) if (services[i].id === serviceId) { duracao = services[i].duracaoMin; break; }

  var busy = [];
  var bookings = opts.bookings || listBookings_(ctx);
  bookings.forEach(function (b) {
    if (b.data === dateStr && isActiveStatus_(b.statusReserva) && b.id !== opts.ignoreId) {
      busy.push({ s: toMin_(b.horaInicio), e: toMin_(b.horaFim) || 1440, o: b.statusReserva === 'BLOQUEADO' ? 'BLOQUEIO' : 'RESERVA' });
    }
  });
  if (rule.almocoInicio && rule.almocoFim && toMin_(rule.almocoFim) > toMin_(rule.almocoInicio)) {
    busy.push({ s: toMin_(rule.almocoInicio), e: toMin_(rule.almocoFim), o: 'ALMOCO' });
  }
  if (String(ctx.cfg.BLOQUEAR_COM_GOOGLE_AGENDA || 'SIM').toUpperCase() !== 'NAO') {
    googleBusy_(ctx, dateStr, bookings).forEach(function (x) { busy.push({ s: x.s, e: x.e, o: 'GOOGLE' }); });
  }

  var noticeMin = opts.admin ? 0 : Math.max(0, st.antecedenciaMinHoras * 60);
  var nowAbs = now.minutes + noticeMin;
  var startM = toMin_(rule.inicio), endM = toMin_(rule.fim) || 1440;
  var starts = [];
  if (rule.horarios && rule.horarios.length) {
    // Horários fixos: a profissional escolheu exatamente quando começa cada atendimento
    starts = rule.horarios.map(toMin_).filter(function (t) { return t + duracao <= 1440; });
  } else {
    var step = Math.max(10, st.intervaloMinutos || 60);
    for (var t = startM; t + duracao <= endM; t += step) starts.push(t);
  }
  return starts.map(function (t) {
    var past = (diff * 1440 + t) < nowAbs;
    var hit = busy.filter(function (b) { return t < b.e && (t + duracao) > b.s; })[0];
    return {
      horaInicio: fromMin_(t), horaFim: fromMin_(t + duracao), disponivel: !past && !hit,
      motivo: past ? 'PASSOU' : (hit ? 'OCUPADO' : 'LIVRE'), origem: hit ? hit.o : ''
    };
  });
}

/** Dias abertos (para a página da cliente pintar o calendário). */
function openDates_(ctx, days) {
  var week = weeklySchedule_(ctx), specials = specialDays_(ctx);
  var today = nowInTz_(ctx.tz).date;
  var out = [];
  for (var i = 0; i <= days; i++) {
    var d = addDays_(today, i);
    if (dayRule_(ctx, d, week, specials).aberto) out.push(d);
  }
  return out;
}

// =============================================================================
// GOOGLE AGENDA (OAuth da manicure guardado SÓ no servidor)
// =============================================================================
function rtKey_(sheetId) { return 'GCAL_RT_' + sheetId; }

function migrateLegacyRefreshToken_(ctx) {
  var legacy = ctx.cfg.GCAL_REFRESH_TOKEN;
  if (legacy && !prop_(rtKey_(ctx.sheetId))) {
    setProp_(rtKey_(ctx.sheetId), legacy);
  }
  if (legacy) upsertConfig_(ctx, { GCAL_REFRESH_TOKEN: '' });
}

function gcalConnected_(ctx) { return !!prop_(rtKey_(ctx.sheetId)); }

function oauthPost_(params) {
  var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', { method: 'post', payload: params, muteHttpExceptions: true });
  var data = {};
  try { data = JSON.parse(res.getContentText() || '{}'); } catch (e) {}
  data._status = res.getResponseCode();
  return data;
}

function calAccessToken_(ctx) {
  var rt = prop_(rtKey_(ctx.sheetId));
  if (!rt) return null;
  var c = cache_();
  var cached = c.get('gat:' + ctx.sheetId);
  if (cached) return cached;
  var data = oauthPost_({ client_id: prop_('GOOGLE_CLIENT_ID'), client_secret: prop_('GOOGLE_CLIENT_SECRET'), refresh_token: rt, grant_type: 'refresh_token' });
  if (!data.access_token) {
    if (data.error === 'invalid_grant') {
      setProp_(rtKey_(ctx.sheetId), '');
      try { upsertConfig_(ctx, { GCAL_STATUS: 'EXPIRADA' }); } catch (e) {}
      logEvent_(ctx, 'GCAL_EXPIRADA', 'Permissão da Google Agenda revogada/expirada. Reconectar.');
    }
    return null;
  }
  c.put('gat:' + ctx.sheetId, data.access_token, Math.max(60, Number(data.expires_in || 3600) - 300));
  return data.access_token;
}

function calApi_(ctx, method, path, body) {
  var token = calAccessToken_(ctx);
  if (!token) throw new Error('Google Agenda não conectada.');
  var opt = { method: method, headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true, contentType: 'application/json' };
  if (body) opt.payload = JSON.stringify(body);
  var res = UrlFetchApp.fetch('https://www.googleapis.com/calendar/v3' + path, opt);
  var code = res.getResponseCode();
  var text = res.getContentText();
  if (code === 204 || code === 410) return {};
  var data = {};
  try { data = JSON.parse(text || '{}'); } catch (e) {}
  if (code >= 300) {
    if (code === 401) cache_().remove('gat:' + ctx.sheetId);
    var err = new Error('Google Agenda: ' + ((data.error && data.error.message) || ('HTTP ' + code)));
    err.httpCode = code;
    throw err;
  }
  return data;
}

function tzOffset_(tz, iso) {
  var p = iso.split('-').map(Number);
  return Utilities.formatDate(new Date(Date.UTC(p[0], p[1] - 1, p[2], 15)), tz, 'XXX');
}

function googleBusy_(ctx, dateStr, bookings) {
  if (!gcalConnected_(ctx)) return [];
  var key = 'gbusy:' + ctx.sheetId + ':' + dateStr;
  var c = cache_();
  var hit = c.get(key);
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  var ownIds = {};
  (bookings || []).forEach(function (b) { if (b.calendarEventId) ownIds[String(b.calendarEventId).replace(/^DELETED_/, '').replace(/@google\.com$/, '')] = true; });
  var off = tzOffset_(ctx.tz, dateStr);
  var busy = [];
  try {
    var q = '/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=100' +
      '&timeMin=' + encodeURIComponent(dateStr + 'T00:00:00' + off) +
      '&timeMax=' + encodeURIComponent(dateStr + 'T23:59:59' + off);
    var data = calApi_(ctx, 'get', q);
    (data.items || []).forEach(function (ev) {
      if (ev.status === 'cancelled' || ev.transparency === 'transparent') return;
      if (ownIds[ev.id]) return;
      var priv = (ev.extendedProperties && ev.extendedProperties.private) || {};
      if (priv.nailBookingId) return;
      if (ev.start && ev.start.date) {
        if (ev.start.date <= dateStr && ev.end.date > dateStr) busy.push({ s: 0, e: 1440, g: 1 });
        return;
      }
      if (!ev.start || !ev.start.dateTime) return;
      var s = Utilities.formatDate(new Date(ev.start.dateTime), ctx.tz, 'yyyy-MM-dd HH:mm');
      var e = Utilities.formatDate(new Date(ev.end.dateTime), ctx.tz, 'yyyy-MM-dd HH:mm');
      var sm = s.substring(0, 10) < dateStr ? 0 : toMin_(s.substring(11));
      var em = e.substring(0, 10) > dateStr ? 1440 : toMin_(e.substring(11));
      if (em > sm) busy.push({ s: sm, e: em, g: 1 });
    });
  } catch (err) {
    return [];
  }
  c.put(key, JSON.stringify(busy), 120);
  return busy;
}

function validEventId_(id) {
  id = String(id || '');
  return !!id && id.indexOf('GCAL-') !== 0 && id.indexOf('DELETED_') !== 0;
}

function eventBody_(ctx, b) {
  var st = studioPublic_(ctx);
  var pag = b.metodoPagamento ? (b.metodoPagamento + ' • ' + (b.statusPagamento || '')) : '';
  var desc = [
    'Cliente: ' + b.clienteNome,
    'WhatsApp: ' + (b.clienteWhatsApp ? '+' + b.clienteWhatsApp + '  https://wa.me/' + b.clienteWhatsApp : '-'),
    'Procedimento: ' + b.servicoNome,
    'Valor: R$ ' + Number(b.valor || 0).toFixed(2).replace('.', ','),
    pag ? 'Pagamento: ' + pag : '',
    b.observacoes ? 'Obs.: ' + b.observacoes : '',
    'Código: ' + b.id,
    '',
    'Criado pelo Nail Studio Pro'
  ].filter(function (x) { return x !== null; }).join('\n');
  return {
    summary: '💅 ' + b.servicoNome + ' — ' + b.clienteNome,
    description: desc,
    location: st.endereco || undefined,
    start: { dateTime: b.data + 'T' + b.horaInicio + ':00', timeZone: ctx.tz },
    end: { dateTime: b.data + 'T' + b.horaFim + ':00', timeZone: ctx.tz },
    colorId: '4',
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 60 }, { method: 'popup', minutes: 1440 }] },
    extendedProperties: { private: { nailBookingId: b.id, nailStudio: ctx.sheetId } }
  };
}

/** Garante que a Google Agenda reflita o estado do agendamento. Nunca derruba a operação principal. */
function syncCalendar_(ctx, b) {
  if (!gcalConnected_(ctx)) return false;
  if (String(ctx.cfg.SINCRONIZAR_AGENDA || 'SIM').toUpperCase() === 'NAO') return false;
  if (String(b.statusReserva).toUpperCase() === 'BLOQUEADO') return false;
  try {
    var evId = String(b.calendarEventId || '').replace(/@google\.com$/, '');
    var active = isActiveStatus_(b.statusReserva);
    if (active) {
      if (validEventId_(evId)) {
        try {
          calApi_(ctx, 'patch', '/calendars/primary/events/' + encodeURIComponent(evId), eventBody_(ctx, b));
          return true;
        } catch (ePatch) {
          if (ePatch.httpCode !== 404) throw ePatch;
        }
      }
      var created = calApi_(ctx, 'post', '/calendars/primary/events', eventBody_(ctx, b));
      b.calendarEventId = created.id;
      saveBooking_(ctx, b);
      return true;
    }
    if (validEventId_(evId)) {
      calApi_(ctx, 'delete', '/calendars/primary/events/' + encodeURIComponent(evId));
      b.calendarEventId = 'DELETED_' + evId;
      saveBooking_(ctx, b);
    }
    return true;
  } catch (err) {
    logEvent_(ctx, 'GCAL_ERRO', err.message);
    return false;
  } finally {
    cache_().remove('gbusy:' + ctx.sheetId + ':' + b.data);
  }
}

function resyncFutureBookings_(ctx) {
  var today = nowInTz_(ctx.tz).date;
  var count = 0;
  listBookings_(ctx).forEach(function (b) {
    if (b.data < today || String(b.statusReserva) === 'BLOQUEADO') return;
    var needs = isActiveStatus_(b.statusReserva) ? !validEventId_(b.calendarEventId) : validEventId_(b.calendarEventId);
    if (needs && count < 60 && syncCalendar_(ctx, b)) count++;
  });
  return count;
}

function decodeJwtPayload_(jwt) {
  try { return JSON.parse(b64uDecode_(String(jwt).split('.')[1])); } catch (e) { return {}; }
}

// =============================================================================
// PIX (BR Code oficial do Banco Central)
// =============================================================================
function cleanPixKey_(key) {
  var k = String(key || '').trim();
  if (!k) return '';
  if (k.indexOf('@') >= 0) return k.toLowerCase();
  if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(k)) return k.toLowerCase();
  var d = k.replace(/\D/g, '');
  if (d.length === 11 && k.indexOf('+55') !== 0 && k.indexOf('55') !== 0) {
    var ddd = parseInt(d.slice(0, 2), 10);
    if (ddd >= 11 && ddd <= 99 && d.charAt(2) === '9') return '+55' + d;
    return d;
  }
  if (d.length === 10) return '+55' + d;
  if ((d.length === 12 || d.length === 13) && d.indexOf('55') === 0) return '+' + d;
  if (d.length === 14) return d;
  return d || k;
}

function emv_(id, val) { var s = String(val); return id + ('0' + s.length).slice(-2) + s; }

function plain_(s, max) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9 ]/g, '').toUpperCase().substring(0, max);
}

function buildPix_(key, holder, city, amount, txid) {
  var k = cleanPixKey_(key);
  if (!k) return '';
  var p = emv_('00', '01') + emv_('26', emv_('00', 'br.gov.bcb.pix') + emv_('01', k)) + emv_('52', '0000') + emv_('53', '986');
  if (amount > 0) p += emv_('54', Number(amount).toFixed(2));
  // Pix estático: TXID '***' é o formato aceito por todos os bancos (Nubank incluso)
  var tx = '***';
  void txid;
  p += emv_('58', 'BR') + emv_('59', plain_(holder, 25) || 'STUDIO NAILS') + emv_('60', plain_(city, 15) || 'SAO PAULO') + emv_('62', emv_('05', tx)) + '6304';
  var crc = 0xFFFF;
  for (var i = 0; i < p.length; i++) {
    crc ^= (p.charCodeAt(i) << 8);
    for (var j = 0; j < 8; j++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return p + ('000' + crc.toString(16).toUpperCase()).slice(-4);
}

function pixFor_(ctx, b) {
  if (String(b.metodoPagamento || '').indexOf('PIX') < 0) return { valorCobradoAgora: b.valor, pixCopiaECola: '' };
  var st = studioPublic_(ctx);
  var valor = b.metodoPagamento === 'PIX_SINAL_50' ? Math.round(b.valor * 50) / 100 : b.valor;
  return { valorCobradoAgora: valor, pixCopiaECola: st.pixChave ? buildPix_(st.pixChave, st.pixRecebedor, st.pixCidade, valor, b.id) : '' };
}

// =============================================================================
// CRIAÇÃO DE STUDIO
// =============================================================================
function provisionStudio_(email, p) {
  var studioNome = str_(p.studioNome, 60) || 'Meu Studio';
  var profissional = str_(p.profissionalNome, 60) || 'Manicure';
  var ss = SpreadsheetApp.create(studioNome + ' - Nail Studio Pro (Banco de Dados)');
  try { ss.setSpreadsheetTimeZone(Session.getScriptTimeZone()); } catch (e) {}
  var first = ss.getSheets()[0];
  first.setName(TAB_CONFIG);
  var ctx = { ss: ss, sheetId: ss.getId(), tz: Session.getScriptTimeZone(), cfg: {} };
  var now = nowInTz_(ctx.tz).stamp;
  writeTable_(first, [
    ['Chave', 'Valor', 'Descricao'],
    ['SETUP_CONCLUIDO', 'SIM', 'Criado pelo App'],
    ['STUDIO_NOME', studioNome, 'Nome do Studio'],
    ['PROFISSIONAL_NOME', profissional, 'Nome da Profissional'],
    ['ADMIN_LOGIN_ID', email, 'Conta Google titular'],
    ['WHATSAPP_STUDIO', normPhone_(p.whatsapp), 'WhatsApp'],
    ['PIX_CHAVE', cleanPixKey_(p.pixChave), 'Chave Pix'],
    ['PIX_RECEBEDOR', plain_(p.pixRecebedor || profissional, 25), 'Titular Pix'],
    ['PIX_CIDADE', plain_(p.pixCidade || 'SAO PAULO', 15), 'Cidade Pix'],
    ['TEMA_COR', 'pink-gold', 'Tema'],
    ['HORARIO_INICIO', '09:00', 'Abertura'],
    ['HORARIO_FIM', '19:00', 'Fechamento'],
    ['ALMOCO_INICIO', '12:00', 'Início almoço'],
    ['ALMOCO_FIM', '13:00', 'Fim almoço'],
    ['DIAS_ATENDIMENTO', '1,2,3,4,5,6', 'Dias (0=Dom..6=Sáb)'],
    ['INTERVALO_MINUTOS', '60', 'Intervalo entre horários'],
    ['ANTECEDENCIA_MIN_HORAS', '2', 'Antecedência mínima p/ agendar'],
    ['JANELA_MAX_DIAS', '60', 'Até quantos dias à frente'],
    ['CANCELAMENTO_MIN_HORAS', '12', 'Cliente cancela até X horas antes'],
    ['SINCRONIZAR_AGENDA', 'SIM', 'Google Agenda'],
    ['BLOQUEAR_COM_GOOGLE_AGENDA', 'SIM', 'Compromissos pessoais bloqueiam horários'],
    ['RESUMO_DIARIO', 'NAO', 'Resumo do dia por e-mail às 7h'],
    ['TERMO_ACEITO_EM', now, 'Termo aceito']
  ]);
  writeTable_(ss.insertSheet(TAB_CATS), [CATS_HEADER].concat(DEFAULT_CATS));
  writeTable_(ss.insertSheet(TAB_CATALOG), [CATALOG_HEADER].concat(DEFAULT_SERVICES));
  writeTable_(ss.insertSheet(TAB_BOOKINGS), [BOOKING_HEADER]);
  writeTable_(ss.insertSheet(TAB_LOGS), [['Timestamp', 'Evento', 'Detalhes'], [now, 'CONTA_CRIADA', 'Studio criado para ' + email]]);
  try { ss.addEditor(email); } catch (e) {}

  var sid = ss.getId();
  appendRow_(directorySheet_(), [email, profissional, studioNome, sid, 'https://docs.google.com/spreadsheets/d/' + sid + '/edit', publicBaseUrl_() + '/Pagina_Cliente.html?s=' + sid, '', '', now]);
  cache_().put('reg:' + sid, '1', 600);
  return sid;
}

function sessionFor_(email, sheetId, ctx) {
  ctx = ctx || openStudio_(sheetId);
  return makeToken_({ t: 's', e: email, sid: sheetId, v: String(ctx.cfg.SESSION_VERSION || '1'), x: Date.now() + SESSION_DAYS * 86400000 });
}

function requireSession_(token) {
  var p = readToken_(token, 's');
  if (!p) throw new Error('SESSAO_INVALIDA');
  var ctx = openStudio_(p.sid);
  if (String(ctx.cfg.SESSION_VERSION || '1') !== String(p.v)) throw new Error('SESSAO_REVOGADA');
  ctx.email = p.e;
  migrateLegacyRefreshToken_(ctx);
  return ctx;
}

// =============================================================================
// API PÚBLICA (sem login)
// =============================================================================
var PUBLIC_API = {
  ping: function () {
    return { version: API_VERSION, googleClientConfigured: allowedClientIds_().length > 0 };
  },

  /** Login real: recebe o ID Token do botão "Fazer login com o Google" (web) ou do Android. */
  authGoogle: function (a) {
    var user = verifyGoogleIdToken_(a.idToken);
    var found = findStudioByEmail_(user.email);
    if (!found) {
      return { needsOnboarding: true, email: user.email, name: user.name, picture: user.picture, signupToken: makeToken_({ t: 'su', e: user.email, n: user.name, x: Date.now() + 30 * 60000 }) };
    }
    var ctx = openStudio_(found.sheetId);
    logEvent_(ctx, 'LOGIN_GOOGLE', user.email);
    return { session: sessionFor_(user.email, found.sheetId, ctx), email: user.email, name: user.name, picture: user.picture, spreadsheetId: found.sheetId };
  },

  /** Cria o Studio da conta Google verificada (1º acesso). */
  createStudio: function (a) {
    var su = readToken_(a.signupToken, 'su');
    if (!su) throw new Error('Cadastro expirado. Toque em "Entrar com Google" novamente.');
    if (!str_(a.studioNome)) throw new Error('Informe o nome do seu Studio.');
    if (a.whatsapp && !isValidPhone_(a.whatsapp)) throw new Error('WhatsApp inválido: use DDD + número.');
    return withLock_(function () {
      var existing = findStudioByEmail_(su.e);
      var sid = existing ? existing.sheetId : provisionStudio_(su.e, a);
      return { session: sessionFor_(su.e, sid), email: su.e, spreadsheetId: sid, isNew: !existing };
    });
  },

  /** Login alternativo: e-mail + PIN (para quem ainda não usa o botão Google). */
  authPin: function (a) {
    var email = String(a.email || '').trim().toLowerCase();
    var pin = String(a.pin || '').trim();
    if (!email || !pin) throw new Error('Informe e-mail e PIN.');
    var c = cache_();
    var failKey = 'pinfail:' + email;
    var fails = Number(c.get(failKey) || 0);
    if (fails >= 5) throw new Error('Muitas tentativas. Aguarde 15 minutos ou entre com o botão do Google.');
    var found = findStudioByEmail_(email);
    var ctx = found ? openStudio_(found.sheetId) : null;
    var stored = ctx ? ctx.cfg.ADMIN_PIN_HASH : '';
    if (!ctx || !stored || !safeEq_(sha256Hex_(pin), stored)) {
      c.put(failKey, String(fails + 1), 900);
      if (ctx) logEvent_(ctx, 'LOGIN_PIN_FALHOU', 'Tentativa ' + (fails + 1));
      if (ctx && !stored) throw new Error('Este Studio ainda não tem PIN. Use "Entrar com Google".');
      throw new Error('E-mail ou PIN incorretos.');
    }
    c.remove(failKey);
    logEvent_(ctx, 'LOGIN_PIN', email);
    return { session: sessionFor_(email, found.sheetId, ctx), email: email, spreadsheetId: found.sheetId };
  },

  getPublicBootstrapData: function (a) {
    var ctx = openPublicStudio_(a.s);
    var st = studioPublic_(ctx);
    return { studio: st, categorias: listCategories_(ctx).filter(function (c) { return c.ativo; }), catalogo: listServices_(ctx, true), diasAbertos: openDates_(ctx, Math.min(90, st.janelaMaxDias)) };
  },

  getAvailableSlotsForDate: function (a) {
    var ctx = openPublicStudio_(a.s);
    return computeSlots_(ctx, String(a.date || ''), String(a.serviceId || ''));
  },

  createCustomerBooking: function (a) {
    var ctx = openPublicStudio_(a.s);
    var nome = str_(a.clienteNome, 60);
    var phone = normPhone_(a.clienteWhatsApp);
    if (nome.length < 2) throw new Error('Informe seu nome.');
    if (!isValidPhone_(phone)) throw new Error('WhatsApp inválido: use DDD + número.');
    var metodo = ['PIX_TOTAL', 'PIX_SINAL_50', 'NO_LOCAL'].indexOf(a.metodoPagamento) >= 0 ? a.metodoPagamento : 'PIX_TOTAL';
    var st = studioPublic_(ctx);
    if (metodo === 'NO_LOCAL' && !st.aceitaPagarNoStudio) metodo = 'PIX_TOTAL';
    if (metodo !== 'NO_LOCAL' && !st.pixChave) metodo = 'NO_LOCAL';

    var booking = withLock_(function () {
      var services = listServices_(ctx, true);
      var srv = services.filter(function (s) { return s.id === a.servicoId; })[0];
      if (!srv) throw new Error('Procedimento não encontrado.');
      var bookings = listBookings_(ctx);
      var today = nowInTz_(ctx.tz).date;
      var ativas = bookings.filter(function (b) { return b.data >= today && isActiveStatus_(b.statusReserva) && samePhone_(b.clienteWhatsApp, phone); });
      if (ativas.length >= 3) throw new Error('Você já tem 3 reservas ativas. Fale com o Studio pelo WhatsApp.');
      var slots = computeSlots_(ctx, String(a.data || ''), srv.id, { services: services, bookings: bookings });
      var slot = slots.filter(function (s) { return s.horaInicio === normTime_(a.horaInicio); })[0];
      if (!slot || !slot.disponivel) throw new Error('Este horário acabou de ser preenchido! Escolha outro horário.');
      var b = {
        id: randomId_('AG-'), data: a.data, horaInicio: slot.horaInicio, horaFim: slot.horaFim,
        clienteNome: nome, clienteWhatsApp: phone, servicoId: srv.id, servicoNome: srv.nome, valor: srv.preco,
        metodoPagamento: metodo, statusPagamento: metodo === 'NO_LOCAL' ? 'PAGAR_NO_STUDIO' : 'AGUARDANDO_VALIDACAO_PIX',
        statusReserva: 'RESERVADO', calendarEventId: '', criadoEm: nowInTz_(ctx.tz).stamp, observacoes: str_(a.observacoes, 200)
      };
      return saveBooking_(ctx, b);
    });
    syncCalendar_(ctx, booking);
    logEvent_(ctx, 'RESERVA_CLIENTE', booking.id + ' ' + booking.data + ' ' + booking.horaInicio);
    var pix = pixFor_(ctx, booking);
    return {
      success: true,
      reserva: {
        id: booking.id, data: booking.data, horaInicio: booking.horaInicio, horaFim: booking.horaFim,
        clienteNome: booking.clienteNome, servicoNome: booking.servicoNome, valorTotal: booking.valor,
        valorCobradoAgora: pix.valorCobradoAgora, metodoPagamento: booking.metodoPagamento, statusPagamento: booking.statusPagamento,
        pixCopiaECola: pix.pixCopiaECola, whatsappStudio: st.whatsapp, endereco: st.endereco
      }
    };
  },

  getClientBookingsByPhone: function (a) {
    var ctx = openPublicStudio_(a.s);
    var phone = normPhone_(a.phone);
    if (!isValidPhone_(phone)) return [];
    var st = studioPublic_(ctx);
    var since = addDays_(nowInTz_(ctx.tz).date, -60);
    return listBookings_(ctx).filter(function (b) {
      return b.statusReserva !== 'BLOQUEADO' && b.data >= since && samePhone_(b.clienteWhatsApp, phone);
    }).map(function (b) {
      var pix = pixFor_(ctx, b);
      return {
        id: b.id, data: b.data, horaInicio: b.horaInicio, horaFim: b.horaFim, clienteNome: b.clienteNome, servicoNome: b.servicoNome,
        valorTotal: b.valor, valorCobradoAgora: pix.valorCobradoAgora, metodoPagamento: b.metodoPagamento,
        statusPagamento: b.statusPagamento, statusReserva: b.statusReserva, pixCopiaECola: pix.pixCopiaECola, whatsappStudio: st.whatsapp
      };
    }).sort(function (x, y) { return (y.data + y.horaInicio).localeCompare(x.data + x.horaInicio); });
  },

  cancelCustomerBooking: function (a) {
    var ctx = openPublicStudio_(a.s);
    var st = studioPublic_(ctx);
    var b = withLock_(function () {
      var bk = findBooking_(ctx, String(a.id || ''));
      if (!bk || !samePhone_(bk.clienteWhatsApp, a.phone)) throw new Error('Reserva não localizada.');
      if (!isActiveStatus_(bk.statusReserva) || bk.statusReserva === 'CONCLUIDO') throw new Error('Esta reserva não pode mais ser cancelada.');
      var now = nowInTz_(ctx.tz);
      var minutesUntil = (dayNumber_(bk.data) - dayNumber_(now.date)) * 1440 + toMin_(bk.horaInicio) - now.minutes;
      if (minutesUntil < st.cancelamentoMinHoras * 60) {
        throw new Error('Cancelamento online só até ' + st.cancelamentoMinHoras + 'h antes. Fale com o Studio pelo WhatsApp.');
      }
      bk.statusReserva = 'CANCELADO';
      return saveBooking_(ctx, bk);
    });
    syncCalendar_(ctx, b);
    logEvent_(ctx, 'CANCELADO_CLIENTE', b.id);
    return { success: true };
  },

  notifyPixPaidByCustomer: function (a) {
    var ctx = openPublicStudio_(a.s);
    withLock_(function () {
      var b = findBooking_(ctx, String(a.id || ''));
      if (!b || (a.phone && !samePhone_(b.clienteWhatsApp, a.phone))) throw new Error('Reserva não localizada.');
      if (b.statusPagamento === 'AGUARDANDO_VALIDACAO_PIX') {
        b.statusPagamento = 'CLIENTE_INFORMOU_PIX';
        saveBooking_(ctx, b);
        syncCalendar_(ctx, b);
      }
    });
    return { success: true };
  }
};

function verifyGoogleIdToken_(idToken) {
  if (!idToken) throw new Error('Login Google não recebido.');
  var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('Login Google inválido ou expirado. Tente novamente.');
  var p = JSON.parse(res.getContentText());
  if (allowedClientIds_().indexOf(p.aud) < 0) throw new Error('Este login Google não pertence a este app (client ID diferente). Verifique o GOOGLE_CLIENT_ID.');
  if (['accounts.google.com', 'https://accounts.google.com'].indexOf(p.iss) < 0) throw new Error('Emissor do login inválido.');
  if (String(p.email_verified) !== 'true') throw new Error('Seu e-mail Google ainda não foi verificado.');
  if (Number(p.exp) * 1000 < Date.now()) throw new Error('Login Google expirado. Tente novamente.');
  return { email: String(p.email).toLowerCase(), name: p.name || p.given_name || '', picture: p.picture || '' };
}

// =============================================================================
// API ADMINISTRATIVA (exige sessão válida)
// =============================================================================
function dashboard_(ctx) {
  var bookings = listBookings_(ctx).map(cleanBooking_);
  bookings.sort(function (a, b) { return (b.data + b.horaInicio).localeCompare(a.data + a.horaInicio); });
  var studio = studioAdmin_(ctx);
  return {
    studio: studio,
    categorias: listCategories_(ctx),
    catalogo: listServices_(ctx, false),
    agendamentos: bookings,
    gcal: {
      connected: gcalConnected_(ctx),
      email: ctx.cfg.GCAL_CONNECTED_EMAIL || '',
      status: ctx.cfg.GCAL_STATUS || '',
      configured: !!prop_('GOOGLE_CLIENT_SECRET')
    },
    agenda: {
      semana: weeklySchedule_(ctx),
      especiais: (function () {
        var since = addDays_(nowInTz_(ctx.tz).date, -7);
        var sp = specialDays_(ctx);
        return Object.keys(sp).filter(function (d) { return d >= since; }).sort().map(function (d) { var o = cleanBooking_(sp[d]); o.diaSemana = WEEKDAY_NAMES[weekday_(d)]; return o; });
      })()
    },
    icsUrl: (prop_('API_URL') || ScriptApp.getService().getUrl()) + '?ics=' + icsToken_(ctx.sheetId),
    account: { email: ctx.email }
  };
}

function writeAndReturn_(ctx, fn) {
  withLock_(function () { fn(); });
  ctx.cfg = readConfig_(ctx);
  return dashboard_(ctx);
}

var ADMIN_API = {
  getAdminDashboardData: function (ctx) { return dashboard_(ctx); },

  adminSaveCategory: function (ctx, a) {
    return writeAndReturn_(ctx, function () {
      var nome = str_(a.nome, 50);
      if (!nome) throw new Error('Informe o nome da categoria.');
      var current = listCategories_(ctx);
      var rows = [CATS_HEADER];
      var oldName = null, updated = false;
      current.forEach(function (c) {
        if (a.id && c.id === a.id) {
          oldName = c.nome; updated = true;
          rows.push([c.id, nome, str_(a.icone, 8) || '💅', String(a.ordem || c.ordem), a.ativo === false ? 'NAO' : 'SIM']);
        } else rows.push([c.id, c.nome, c.icone, String(c.ordem), c.ativo ? 'SIM' : 'NAO']);
      });
      if (!updated) rows.push([randomId_('CAT-'), nome, str_(a.icone, 8) || '💅', String(a.ordem || rows.length), 'SIM']);
      writeTable_(ensureTab_(ctx, TAB_CATS, CATS_HEADER), rows);
      if (oldName && oldName !== nome) {
        var t = readTab_(ctx, TAB_CATALOG);
        for (var i = 1; i < t.rows.length; i++) {
          if (t.rows[i][6] === oldName) { t.rows[i][6] = nome; writeRow_(t.sheet, i + 1, t.rows[i]); }
        }
      }
    });
  },

  adminDeleteCategory: function (ctx, a) {
    return writeAndReturn_(ctx, function () {
      var rows = [CATS_HEADER];
      listCategories_(ctx).forEach(function (c) { if (c.id !== a.id) rows.push([c.id, c.nome, c.icone, String(c.ordem), c.ativo ? 'SIM' : 'NAO']); });
      writeTable_(ensureTab_(ctx, TAB_CATS, CATS_HEADER), rows);
    });
  },

  adminSeedDefaultCatalog: function (ctx) {
    return writeAndReturn_(ctx, function () {
      var existing = listServices_(ctx, false);
      var rows = [CATALOG_HEADER];
      existing.forEach(function (s) { rows.push([s.id, s.nome, s.descricao, s.preco, s.duracaoMin, s.fotoUrl, s.categoria, s.ativo ? 'SIM' : 'NAO']); });
      DEFAULT_SERVICES.forEach(function (d) { if (!existing.some(function (s) { return s.id === d[0]; })) rows.push(d); });
      writeTable_(ensureTab_(ctx, TAB_CATALOG, CATALOG_HEADER), rows);
      if (!readTab_(ctx, TAB_CATS).rows.length) writeTable_(ensureTab_(ctx, TAB_CATS, CATS_HEADER), [CATS_HEADER].concat(DEFAULT_CATS));
    });
  },

  adminSaveService: function (ctx, a) {
    return writeAndReturn_(ctx, function () {
      var nome = str_(a.nome, 80);
      if (!nome) throw new Error('Informe o nome do procedimento.');
      var foto = String(a.fotoUrl || '');
      if (foto.length > 45000) throw new Error('Foto muito grande. Use uma foto menor ou um link.');
      var row = [a.id || randomId_('SRV-'), nome, str_(a.descricao, 400), Number(a.preco || 0), Math.max(10, Number(a.duracaoMin || 60)), foto, str_(a.categoria, 50) || 'Geral', a.ativo === false ? 'NAO' : 'SIM'];
      var t = readTab_(ctx, TAB_CATALOG);
      var sh = t.sheet || ensureTab_(ctx, TAB_CATALOG, CATALOG_HEADER);
      for (var i = 1; i < t.rows.length; i++) {
        if (a.id && t.rows[i][0] === a.id) { writeRow_(sh, i + 1, row); return; }
      }
      appendRow_(sh, row);
    });
  },

  adminToggleServiceActive: function (ctx, a) {
    return writeAndReturn_(ctx, function () {
      var t = readTab_(ctx, TAB_CATALOG);
      for (var i = 1; i < t.rows.length; i++) {
        if (t.rows[i][0] === a.id) {
          t.rows[i][7] = String(t.rows[i][7] || 'SIM').toUpperCase() === 'SIM' ? 'NAO' : 'SIM';
          writeRow_(t.sheet, i + 1, t.rows[i]);
        }
      }
    });
  },

  adminDeleteService: function (ctx, a) {
    return writeAndReturn_(ctx, function () {
      var t = readTab_(ctx, TAB_CATALOG);
      for (var i = t.rows.length - 1; i >= 1; i--) if (t.rows[i][0] === a.id) t.sheet.deleteRow(i + 1);
    });
  },

  adminUpdateBookingStatus: function (ctx, a) {
    var b;
    var res = writeAndReturn_(ctx, function () {
      b = findBooking_(ctx, String(a.id || ''));
      if (!b) throw new Error('Reserva não encontrada.');
      switch (a.action) {
        case 'VALIDAR_PIX': b.statusPagamento = 'PIX_CONFIRMADO'; b.statusReserva = 'CONFIRMADO'; break;
        case 'CONFIRMAR': b.statusReserva = 'CONFIRMADO'; break;
        case 'CONCLUIR_ATENDIMENTO':
          b.statusPagamento = /PIX/.test(b.statusPagamento) ? 'PIX_CONFIRMADO' : 'PAGO_NO_STUDIO';
          b.statusReserva = 'CONCLUIDO'; break;
        case 'FALTOU': b.statusReserva = 'FALTOU'; break;
        case 'CANCELAR_RESERVA': b.statusReserva = b.statusReserva === 'BLOQUEADO' ? 'CANCELADO' : 'CANCELADO'; break;
        default: throw new Error('Ação inválida.');
      }
      saveBooking_(ctx, b);
    });
    if (b && syncCalendar_(ctx, b)) res = dashboard_(ctx);
    logEvent_(ctx, 'STATUS_' + a.action, a.id);
    return res;
  },

  adminRescheduleBooking: function (ctx, a) {
    var b;
    var res = writeAndReturn_(ctx, function () {
      b = findBooking_(ctx, String(a.id || ''));
      if (!b) throw new Error('Reserva não encontrada.');
      if (!isIsoDate_(a.data) || !normTime_(a.horaInicio)) throw new Error('Informe nova data e horário.');
      var dur = Math.max(10, toMin_(b.horaFim) - toMin_(b.horaInicio));
      var ini = toMin_(normTime_(a.horaInicio));
      var fim = ini + dur;
      if (!a.force) {
        var conflict = listBookings_(ctx).some(function (x) {
          return x.id !== b.id && x.data === a.data && isActiveStatus_(x.statusReserva) && ini < (toMin_(x.horaFim) || 1440) && fim > toMin_(x.horaInicio);
        });
        if (conflict) throw new Error('CONFLITO: já existe atendimento nesse horário.');
      }
      b.data = a.data; b.horaInicio = fromMin_(ini); b.horaFim = fromMin_(fim);
      if (b.statusReserva === 'CANCELADO' || b.statusReserva === 'FALTOU') b.statusReserva = 'RESERVADO';
      saveBooking_(ctx, b);
    });
    if (b && syncCalendar_(ctx, b)) res = dashboard_(ctx);
    logEvent_(ctx, 'REAGENDADO', a.id + ' -> ' + a.data + ' ' + a.horaInicio);
    return res;
  },

  adminSaveBookingNote: function (ctx, a) {
    return writeAndReturn_(ctx, function () {
      var b = findBooking_(ctx, String(a.id || ''));
      if (!b) throw new Error('Reserva não encontrada.');
      b.observacoes = str_(a.observacoes, 300);
      saveBooking_(ctx, b);
    });
  },

  adminCreateManualBookingOrBlock: function (ctx, a) {
    var created;
    var res = writeAndReturn_(ctx, function () {
      if (!isIsoDate_(a.data) || !normTime_(a.horaInicio)) throw new Error('Informe data e hora.');
      var now = nowInTz_(ctx.tz).stamp;
      if (a.tipo === 'BLOQUEIO') {
        var ini = normTime_(a.horaInicio), fim = normTime_(a.horaFim) || '23:59';
        if (toMin_(fim) <= toMin_(ini)) throw new Error('A hora final precisa ser depois da inicial.');
        created = saveBooking_(ctx, {
          id: randomId_('BLQ-'), data: a.data, horaInicio: ini, horaFim: fim, clienteNome: '🔒 BLOQUEIO DE AGENDA / FOLGA', clienteWhatsApp: '',
          servicoId: 'BLOQUEIO', servicoNome: str_(a.motivo, 80) || 'Horário bloqueado', valor: 0, metodoPagamento: 'BLOQUEIO',
          statusPagamento: 'BLOQUEADO', statusReserva: 'BLOQUEADO', calendarEventId: '', criadoEm: now, observacoes: ''
        });
        return;
      }
      var nome = str_(a.clienteNome, 60);
      if (!nome) throw new Error('Informe o nome da cliente.');
      var srv = listServices_(ctx, false).filter(function (s) { return s.id === a.servicoId; })[0];
      var dur = Number(a.duracaoMin || (srv && srv.duracaoMin) || 60);
      var iniM = toMin_(normTime_(a.horaInicio));
      created = saveBooking_(ctx, {
        id: randomId_('AG-'), data: a.data, horaInicio: fromMin_(iniM), horaFim: fromMin_(iniM + dur), clienteNome: nome,
        clienteWhatsApp: normPhone_(a.clienteWhatsApp), servicoId: srv ? srv.id : 'MANUAL', servicoNome: srv ? srv.nome : (str_(a.servicoNome, 80) || 'Atendimento'),
        valor: Number(a.valor || (srv && srv.preco) || 0), metodoPagamento: a.metodoPagamento || 'NO_LOCAL', statusPagamento: a.statusPagamento || 'PAGAR_NO_STUDIO',
        statusReserva: 'CONFIRMADO', calendarEventId: '', criadoEm: now, observacoes: str_(a.observacoes, 200)
      });
    });
    if (created && syncCalendar_(ctx, created)) res = dashboard_(ctx);
    return res;
  },

  /** Férias / folga longa: bloqueia vários dias de uma vez. */
  adminBlockDateRange: function (ctx, a) {
    return writeAndReturn_(ctx, function () {
      if (!isIsoDate_(a.de) || !isIsoDate_(a.ate)) throw new Error('Informe as datas de início e fim.');
      var n = dayNumber_(a.ate) - dayNumber_(a.de);
      if (n < 0) throw new Error('A data final precisa ser depois da inicial.');
      if (n > 90) throw new Error('Bloqueie no máximo 90 dias de uma vez.');
      var sh = ensureTab_(ctx, TAB_BOOKINGS, BOOKING_HEADER);
      var now = nowInTz_(ctx.tz).stamp;
      var rows = [];
      for (var i = 0; i <= n; i++) {
        rows.push(bookingToRow_({ id: randomId_('BLQ-'), data: addDays_(a.de, i), horaInicio: '00:00', horaFim: '23:59', clienteNome: '🔒 BLOQUEIO DE AGENDA / FOLGA', clienteWhatsApp: '', servicoId: 'BLOQUEIO', servicoNome: str_(a.motivo, 80) || 'Folga / Férias', valor: 0, metodoPagamento: 'BLOQUEIO', statusPagamento: 'BLOQUEADO', statusReserva: 'BLOQUEADO', calendarEventId: '', criadoEm: now, observacoes: '' }));
      }
      var start = Math.max(sh.getLastRow(), 1) + 1;
      var range = sh.getRange(start, 1, rows.length, BOOKING_HEADER.length);
      range.setNumberFormat('@');
      range.setValues(rows.map(function (r) { var o = []; for (var k = 0; k < BOOKING_HEADER.length; k++) o.push(r[k] === undefined || r[k] === null ? '' : String(r[k])); return o; }));
    });
  },

  adminSaveSettings: function (ctx, a) {
    var res = writeAndReturn_(ctx, function () {
      var up = {};
      function set(key, val) { if (val !== undefined) up[key] = val; }
      set('STUDIO_NOME', a.nome !== undefined ? str_(a.nome, 60) : undefined);
      set('PROFISSIONAL_NOME', a.profissional !== undefined ? str_(a.profissional, 60) : undefined);
      if (a.whatsapp !== undefined) {
        if (a.whatsapp && !isValidPhone_(a.whatsapp)) throw new Error('WhatsApp inválido: use DDD + número.');
        up.WHATSAPP_STUDIO = normPhone_(a.whatsapp);
      }
      set('PIX_CHAVE', a.pixChave !== undefined ? cleanPixKey_(a.pixChave) : undefined);
      set('PIX_RECEBEDOR', a.pixRecebedor !== undefined ? plain_(a.pixRecebedor, 25) : undefined);
      set('PIX_CIDADE', a.pixCidade !== undefined ? plain_(a.pixCidade, 15) : undefined);
      set('TEMA_COR', a.temaCor !== undefined ? str_(a.temaCor, 30) : undefined);
      ['horarioInicio:HORARIO_INICIO', 'horarioFim:HORARIO_FIM', 'almocoInicio:ALMOCO_INICIO', 'almocoFim:ALMOCO_FIM'].forEach(function (pair) {
        var p = pair.split(':');
        if (a[p[0]] !== undefined) up[p[1]] = normTime_(a[p[0]]);
      });
      if (a.diasAtendimento !== undefined) up.DIAS_ATENDIMENTO = String(a.diasAtendimento).replace(/[^0-6,]/g, '');
      if (a.intervaloMinutos !== undefined) up.INTERVALO_MINUTOS = String(Math.max(10, Number(a.intervaloMinutos) || 60));
      if (a.antecedenciaMinHoras !== undefined) up.ANTECEDENCIA_MIN_HORAS = String(Math.max(0, Number(a.antecedenciaMinHoras) || 0));
      if (a.janelaMaxDias !== undefined) up.JANELA_MAX_DIAS = String(Math.min(365, Math.max(1, Number(a.janelaMaxDias) || 60)));
      if (a.cancelamentoMinHoras !== undefined) up.CANCELAMENTO_MIN_HORAS = String(Math.max(0, Number(a.cancelamentoMinHoras) || 0));
      if (a.diasRetorno !== undefined) up.DIAS_RETORNO = String(Math.max(5, Number(a.diasRetorno) || 15));
      if (a.aceitaPagarNoStudio !== undefined) up.ACEITA_PAGAR_NO_STUDIO = a.aceitaPagarNoStudio ? 'SIM' : 'NAO';
      if (a.bloquearComGoogleAgenda !== undefined) up.BLOQUEAR_COM_GOOGLE_AGENDA = a.bloquearComGoogleAgenda ? 'SIM' : 'NAO';
      if (a.resumoDiario !== undefined) up.RESUMO_DIARIO = a.resumoDiario ? 'SIM' : 'NAO';
      set('INSTAGRAM_STUDIO', a.instagram !== undefined ? str_(a.instagram, 60) : undefined);
      set('ENDERECO_STUDIO', a.endereco !== undefined ? str_(a.endereco, 150) : undefined);
      set('LINK_AVALIACAO', a.linkAvaliacao !== undefined ? str_(a.linkAvaliacao, 300) : undefined);
      set('MENSAGEM_BOAS_VINDAS', a.mensagemBoasVindas !== undefined ? str_(a.mensagemBoasVindas, 300) : undefined);
      set('POLITICA_CANCELAMENTO', a.politicaCancelamento !== undefined ? str_(a.politicaCancelamento, 400) : undefined);
      if (a.novoPin) {
        if (!/^\d{4,8}$/.test(String(a.novoPin))) throw new Error('O PIN deve ter de 4 a 8 números.');
        up.ADMIN_PIN_HASH = sha256Hex_(String(a.novoPin));
      }
      up.SETUP_CONCLUIDO = 'SIM';
      upsertConfig_(ctx, up);
      try {
        var t = readTab_(ctx, TAB_CONFIG);
        var dir = directorySheet_();
        var rows = dir.getDataRange().getValues();
        for (var i = 1; i < rows.length; i++) {
          if (String(rows[i][3]) === ctx.sheetId) {
            if (up.STUDIO_NOME) dir.getRange(i + 1, 3).setValue(up.STUDIO_NOME);
            if (up.PROFISSIONAL_NOME) dir.getRange(i + 1, 2).setValue(up.PROFISSIONAL_NOME);
          }
        }
        void t;
      } catch (e) {}
    });
    logEvent_(ctx, 'CONFIG_SALVA', ctx.email || '');
    return res;
  },

  /** Desconecta todos os aparelhos (invalida todas as sessões). */
  adminLogoutAllDevices: function (ctx) {
    withLock_(function () { upsertConfig_(ctx, { SESSION_VERSION: String(Number(ctx.cfg.SESSION_VERSION || 1) + 1) }); });
    logEvent_(ctx, 'LOGOUT_TODOS', ctx.email || '');
    return { success: true };
  },

  // ----------------------------- GOOGLE AGENDA ------------------------------
  gcalConnect: function (ctx, a) {
    if (!prop_('GOOGLE_CLIENT_SECRET')) throw new Error('Servidor sem GOOGLE_CLIENT_SECRET configurado. Avise o suporte.');
    var redirect = a.redirectUri === '' ? '' : 'postmessage';
    var data = oauthPost_({ code: String(a.code || ''), client_id: prop_('GOOGLE_CLIENT_ID'), client_secret: prop_('GOOGLE_CLIENT_SECRET'), redirect_uri: redirect, grant_type: 'authorization_code' });
    if (!data.access_token) throw new Error('Google recusou a autorização (' + (data.error_description || data.error || 'erro') + '). Tente novamente.');
    if (String(data.scope || '').indexOf(CALENDAR_SCOPE) < 0) {
      throw new Error('Você não marcou a permissão "Ver e editar eventos" da Google Agenda. Toque em Conectar e marque a caixinha.');
    }
    var email = String(decodeJwtPayload_(data.id_token).email || ctx.email || '').toLowerCase();
    if (!data.refresh_token && !prop_(rtKey_(ctx.sheetId))) {
      // O Google só entrega refresh_token no 1º consentimento: revoga e pede de novo.
      UrlFetchApp.fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(data.access_token), { method: 'post', muteHttpExceptions: true });
      throw new Error('Quase lá! Toque em "Conectar Google Agenda" mais uma vez para concluir.');
    }
    if (data.refresh_token) setProp_(rtKey_(ctx.sheetId), data.refresh_token);
    cache_().put('gat:' + ctx.sheetId, data.access_token, Math.max(60, Number(data.expires_in || 3600) - 300));
    upsertConfig_(ctx, { GCAL_CONNECTED_EMAIL: email, GCAL_STATUS: 'CONECTADA', SINCRONIZAR_AGENDA: 'SIM', GCAL_REFRESH_TOKEN: '' });
    logEvent_(ctx, 'GCAL_CONECTADA', email);
    var synced = resyncFutureBookings_(ctx);
    var dash = dashboard_(ctx);
    dash.synced = synced;
    return dash;
  },

  gcalDisconnect: function (ctx) {
    var rt = prop_(rtKey_(ctx.sheetId));
    if (rt) UrlFetchApp.fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(rt), { method: 'post', muteHttpExceptions: true });
    setProp_(rtKey_(ctx.sheetId), '');
    cache_().remove('gat:' + ctx.sheetId);
    upsertConfig_(ctx, { GCAL_CONNECTED_EMAIL: '', GCAL_STATUS: 'DESCONECTADA', GCAL_REFRESH_TOKEN: '' });
    logEvent_(ctx, 'GCAL_DESCONECTADA', ctx.email || '');
    return dashboard_(ctx);
  },

  gcalTest: function (ctx) {
    if (!gcalConnected_(ctx)) throw new Error('Google Agenda não conectada.');
    var now = new Date();
    var start = Utilities.formatDate(new Date(now.getTime() + 5 * 60000), ctx.tz, "yyyy-MM-dd'T'HH:mm:ss");
    var end = Utilities.formatDate(new Date(now.getTime() + 35 * 60000), ctx.tz, "yyyy-MM-dd'T'HH:mm:ss");
    var ev = calApi_(ctx, 'post', '/calendars/primary/events', { summary: '💅 Teste Nail Studio Pro', start: { dateTime: start, timeZone: ctx.tz }, end: { dateTime: end, timeZone: ctx.tz } });
    calApi_(ctx, 'delete', '/calendars/primary/events/' + encodeURIComponent(ev.id));
    return { success: true, email: ctx.cfg.GCAL_CONNECTED_EMAIL || '' };
  },

  gcalResync: function (ctx) {
    if (!gcalConnected_(ctx)) throw new Error('Google Agenda não conectada.');
    var n = resyncFutureBookings_(ctx);
    var dash = dashboard_(ctx);
    dash.synced = n;
    return dash;
  },

  /** Salva o horário padrão de cada dia da semana. */
  adminSaveWeeklySchedule: function (ctx, a) {
    return writeAndReturn_(ctx, function () {
      var semana = a.semana || {};
      var out = {}, dias = [], minIni = 1440, maxFim = 0;
      for (var d = 0; d < 7; d++) {
        var r = semana[d] || semana[String(d)] || {};
        var ativo = !!r.ativo;
        var ini = normTime_(r.inicio) || '09:00', fim = normTime_(r.fim) || '19:00';
        var aIni = normTime_(r.almocoInicio), aFim = normTime_(r.almocoFim);
        var fixos = parseTimes_(r.horarios);
        if (ativo && !fixos.length && toMin_(fim) <= toMin_(ini)) throw new Error(WEEKDAY_NAMES[d] + ': o fechamento precisa ser depois da abertura.');
        if (ativo && (aIni || aFim) && (!aIni || !aFim || toMin_(aFim) <= toMin_(aIni))) throw new Error(WEEKDAY_NAMES[d] + ': confira o horário de almoço/pausa.');
        out[d] = { ativo: ativo, inicio: ini, fim: fim, almocoInicio: aIni, almocoFim: aFim, horarios: fixos.join(',') };
        if (ativo) {
          dias.push(d);
          minIni = Math.min(minIni, fixos.length ? toMin_(fixos[0]) : toMin_(ini));
          maxFim = Math.max(maxFim, toMin_(fim));
        }
      }
      if (!dias.length) throw new Error('Deixe pelo menos um dia da semana aberto.');
      upsertConfig_(ctx, {
        HORARIOS_SEMANA: JSON.stringify(out),
        // chaves antigas mantidas para compatibilidade
        DIAS_ATENDIMENTO: dias.join(','),
        HORARIO_INICIO: fromMin_(minIni),
        HORARIO_FIM: fromMin_(maxFim || 1140)
      });
    });
  },

  /** Cria/edita uma data especial: FECHADO (folga/feriado) ou ESPECIAL (horário diferente, inclusive abrir num dia fechado). */
  adminSaveSpecialDay: function (ctx, a) {
    return writeAndReturn_(ctx, function () {
      var data = normDate_(a.data);
      if (!isIsoDate_(data)) throw new Error('Escolha a data.');
      var tipo = a.tipo === 'ESPECIAL' ? 'ESPECIAL' : 'FECHADO';
      var ini = normTime_(a.inicio), fim = normTime_(a.fim);
      var aIni = normTime_(a.almocoInicio), aFim = normTime_(a.almocoFim);
      var fixos = parseTimes_(a.horarios);
      if (tipo === 'ESPECIAL') {
        if (!fixos.length && (!ini || !fim)) throw new Error('Informe abertura e fechamento ou os horários fixos.');
        if (!fixos.length && toMin_(fim) <= toMin_(ini)) throw new Error('O fechamento precisa ser depois da abertura.');
        if ((aIni || aFim) && (!aIni || !aFim || toMin_(aFim) <= toMin_(aIni))) throw new Error('Confira o horário de pausa.');
      }
      var row = [data, tipo, tipo === 'ESPECIAL' ? ini : '', tipo === 'ESPECIAL' ? fim : '', tipo === 'ESPECIAL' ? aIni : '', tipo === 'ESPECIAL' ? aFim : '', tipo === 'ESPECIAL' ? fixos.join(',') : '', str_(a.motivo, 80)];
      var sh = ensureTab_(ctx, TAB_SPECIAL, SPECIAL_HEADER);
      var existing = specialDays_(ctx)[data];
      if (existing) writeRow_(sh, existing._row, row);
      else appendRow_(sh, row);
      cache_().remove('gbusy:' + ctx.sheetId + ':' + data);
    });
  },

  adminDeleteSpecialDay: function (ctx, a) {
    return writeAndReturn_(ctx, function () {
      var sp = specialDays_(ctx)[normDate_(a.data)];
      if (sp) ctx.ss.getSheetByName(TAB_SPECIAL).deleteRow(sp._row);
    });
  },

  /** Agenda de um dia: regra do dia + grade de horários com o que ocupa cada um. */
  adminGetDayAgenda: function (ctx, a) {
    var date = String(a.date || '');
    if (!isIsoDate_(date)) throw new Error('Data inválida.');
    var rule = dayRule_(ctx, date);
    var slots = computeSlots_(ctx, date, '', { admin: true, rule: rule });
    var cleanRule = {};
    Object.keys(rule).forEach(function (k) { cleanRule[k] = rule[k]; });
    return { date: date, diaSemana: WEEKDAY_NAMES[weekday_(date)], rule: cleanRule, slots: slots };
  },

  /** Horários livres (visão da manicure — ignora antecedência mínima). */
  adminGetSlots: function (ctx, a) {
    return computeSlots_(ctx, String(a.date || ''), String(a.serviceId || ''), { admin: true, ignoreId: a.ignoreId });
  }
};

// =============================================================================
// FEED .ICS (assinar a agenda em qualquer app de calendário)
// =============================================================================
function escHtml_(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function icsEscape_(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }

function icsFeed_(token) {
  var sid = String(token || '').split('.')[0];
  if (!sid || !safeEq_(icsToken_(sid), token) || !isRegisteredSheet_(sid)) {
    return ContentService.createTextOutput('Link de agenda inválido.').setMimeType(ContentService.MimeType.TEXT);
  }
  var ctx = openStudio_(sid);
  var st = studioPublic_(ctx);
  var today = nowInTz_(ctx.tz).date;
  var from = addDays_(today, -30);
  var lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Nail Studio Pro//PT-BR', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:' + icsEscape_('💅 ' + st.nome), 'X-WR-TIMEZONE:' + ctx.tz, 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'];
  var stamp = Utilities.formatDate(new Date(), 'UTC', "yyyyMMdd'T'HHmmss'Z'");
  listBookings_(ctx).forEach(function (b) {
    if (b.data < from || !isActiveStatus_(b.statusReserva)) return;
    var d = b.data.replace(/-/g, '');
    var blocked = b.statusReserva === 'BLOQUEADO';
    lines.push('BEGIN:VEVENT', 'UID:' + b.id + '@nailstudiopro', 'DTSTAMP:' + stamp,
      'DTSTART;TZID=' + ctx.tz + ':' + d + 'T' + b.horaInicio.replace(':', '') + '00',
      'DTEND;TZID=' + ctx.tz + ':' + d + 'T' + (b.horaFim || b.horaInicio).replace(':', '') + '00',
      'SUMMARY:' + icsEscape_(blocked ? '🔒 ' + b.servicoNome : '💅 ' + b.servicoNome + ' — ' + b.clienteNome),
      'DESCRIPTION:' + icsEscape_(blocked ? 'Bloqueio' : 'WhatsApp: +' + b.clienteWhatsApp + '\nValor: R$ ' + b.valor + '\nStatus: ' + b.statusReserva + '\nCódigo: ' + b.id),
      'END:VEVENT');
  });
  lines.push('END:VCALENDAR');
  return ContentService.createTextOutput(lines.join('\r\n')).setMimeType(ContentService.MimeType.ICAL);
}

// =============================================================================
// RESUMO DIÁRIO POR E-MAIL (gatilho das 7h criado pelo setup())
// =============================================================================
function enviarResumosDiarios() {
  var rows = directoryRows_();
  for (var i = 1; i < rows.length; i++) {
    var email = String(rows[i][0] || '').trim();
    var sid = String(rows[i][3] || '').trim();
    if (!email || !sid) continue;
    try {
      var ctx = openStudio_(sid);
      if (String(ctx.cfg.RESUMO_DIARIO || 'NAO').toUpperCase() !== 'SIM') continue;
      var today = nowInTz_(ctx.tz).date;
      var list = listBookings_(ctx).filter(function (b) { return b.data === today && isActiveStatus_(b.statusReserva) && b.statusReserva !== 'BLOQUEADO'; })
        .sort(function (a, b) { return a.horaInicio.localeCompare(b.horaInicio); });
      var total = list.reduce(function (s, b) { return s + b.valor; }, 0);
      var pix = list.filter(function (b) { return /AGUARDANDO_VALIDACAO_PIX|CLIENTE_INFORMOU_PIX/.test(b.statusPagamento); }).length;
      var html = '<div style="font-family:Arial,sans-serif;max-width:520px">' +
        '<h2 style="color:#ff1675">💅 Seu dia no ' + escHtml_(studioPublic_(ctx).nome) + '</h2>' +
        (list.length ? '<p><b>' + list.length + '</b> atendimento(s) hoje • previsão <b>R$ ' + total.toFixed(2).replace('.', ',') + '</b>' + (pix ? ' • ⚠️ ' + pix + ' Pix para validar' : '') + '</p>' : '<p>Nenhum atendimento marcado para hoje. Aproveite para divulgar seu link! ✨</p>') +
        '<table style="border-collapse:collapse;width:100%">' + list.map(function (b) {
          return '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>' + b.horaInicio + '</b></td><td style="padding:6px;border-bottom:1px solid #eee">' +
            escHtml_(b.clienteNome) + '<br><small>' + escHtml_(b.servicoNome) + '</small></td>' +
            '<td style="padding:6px;border-bottom:1px solid #eee"><a href="https://wa.me/' + b.clienteWhatsApp + '">WhatsApp</a></td></tr>';
        }).join('') + '</table>' +
        '<p style="font-size:12px;color:#888">Desative em Opções → Notificações no app.</p></div>';
      MailApp.sendEmail({ to: email, subject: '💅 Agenda de hoje: ' + list.length + ' atendimento(s)', htmlBody: html, name: 'Nail Studio Pro' });
    } catch (e) {
      Logger.log('Resumo falhou para ' + email + ': ' + e.message);
    }
  }
}
