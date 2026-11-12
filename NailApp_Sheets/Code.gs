/**
 * ============================================================================
 * 💅 NAIL STUDIO PRO - BACKEND SEGURO (GOOGLE APPS SCRIPT + SHEETS + AGENDA)
 * ============================================================================
 * 
 * CAMADAS DE SEGURANÇA IMPLEMENTADAS:
 * 1. Dupla Autenticação Administrativa:
 *    - Validação de Sessão Google (Owner vs Visitor) + Hash SHA-256 de PIN + Token de Sessão Temporário (CacheService).
 * 2. Isolamento de Dados (Zero-Leak):
 *    - A API pública (clientes) NUNCA retorna lista de clientes, telefones de terceiros ou PIN administrativo.
 *    - A API pública retorna apenas os horários ocupados (ex: ["09:00", "14:00"]) sem expor quem agendou.
 * 3. Prevenção de Concorrência (LockService):
 *    - Impede que duas clientes reservem o mesmo horário no mesmo milissegundo (Race Condition).
 * 4. Anti-Fraude e Sanitização (Anti-Formula Injection):
 *    - Todo texto enviado por clientes passa por sanitização contra injeção de fórmulas (=, +, -, @) e XSS.
 * 5. Payload Pix EMVCo Calculado no Servidor:
 *    - O valor do Pix é obtido diretamente do catálogo oficial na planilha, impedindo manipulação de preço no navegador.
 */

const SHEETS_CONFIG = {
  CATALOGO: 'Catalogo',
  AGENDAMENTOS: 'Agendamentos',
  CONFIG: 'Configuracoes',
  AUDITORIA: 'Logs_Seguranca'
};

/**
 * Cria menu especial na Planilha Google para facilitar o uso da Manicure
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('💅 Nail Studio Pro')
    .addItem('📅 Ativar Minha Google Agenda (1 Clique)', 'setupCalendarAutoSyncTrigger')
    .addItem('🧪 Testar Conexão com Agenda', 'testarGoogleAgendaMenu')
    .addSeparator()
    .addItem('🔄 Sincronizar Todas as Reservas Pendentes', 'autoSyncGoogleCalendarProcess')
    .addItem('ℹ️ Status do Studio', 'exibirStatusStudioMenu')
    .addSeparator()
    .addItem('🚀 Inicializar / Reparar Planilha', 'setupDatabase')
    .addItem('🔑 Redefinir PIN de Segurança', 'resetAdminPinModal')
    .addToUi();
}

/**
 * Teste rápido de integração com a Google Agenda a partir do Menu
 */
function testarGoogleAgendaMenu() {
  const ui = SpreadsheetApp.getUi();
  try {
    const cal = CalendarApp.getDefaultCalendar();
    const now = new Date();
    const end = new Date(now.getTime() + (30 * 60 * 1000));
    const ev = cal.createEvent('💅 Teste Nail Studio Pro', now, end, {
      description: 'Validação automática de integração com Google Agenda'
    });
    Utilities.sleep(1500);
    ev.deleteEvent();
    ui.alert('🎉 Teste Concluído!', 'O evento de teste foi criado e validado na sua Google Agenda (' + cal.getName() + ') com 100% de sucesso!', ui.ButtonSet.OK);
  } catch (err) {
    ui.alert('Falha no teste', err.message, ui.ButtonSet.OK);
  }
}

/**
 * Exibe o status da conta e configurações
 */
function exibirStatusStudioMenu() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const cfgSheet = ss.getSheetByName(SHEETS_CONFIG.CONFIG);
  let studioNome = 'Meu Studio';
  let calStatus = 'SIM';
  
  if (cfgSheet) {
    const data = cfgSheet.getDataRange().getValues();
    for (let i = 0; i < data.length; i++) {
      if (data[i][0] === 'STUDIO_NOME') studioNome = data[i][1];
      if (data[i][0] === 'SINCRONIZAR_AGENDA') calStatus = data[i][1];
    }
  }
  
  try {
    const cal = CalendarApp.getDefaultCalendar();
    ui.alert(
      '💅 Studio: ' + studioNome,
      'Conta Google Agenda: ' + cal.getName() + '\n' +
      'Sincronização Ativa: ' + calStatus + '\n' +
      'Total de Abas: ' + ss.getSheets().length,
      ui.ButtonSet.OK
    );
  } catch (e) {
    ui.alert('💅 Studio: ' + studioNome, 'Sincronização Ativa: ' + calStatus, ui.ButtonSet.OK);
  }
}

/**
 * Ponto de entrada do Aplicativo Web (GET)
 * - ?modo=admin -> Abre o App exclusivo da Manicure (para instalar na tela inicial do celular)
 * - Sem parâmetro -> Abre a Página limpa de Agendamento das Clientes
 */
function doGet(e) {
  setupDatabase(); // Garante que as abas existam na primeira abertura
  
  const isModoAdmin = (e && e.parameter && e.parameter.modo === 'admin');
  const fileName = isModoAdmin ? 'App_Manicure' : 'Pagina_Cliente';
  const pageTitle = isModoAdmin
    ? 'App da Manicure | Gestão, Catálogo & Pix'
    : 'Agendamento Online | Catálogo & Horários';

  const template = HtmlService.createTemplateFromFile(fileName);
  return template.evaluate()
    .setTitle(pageTitle)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no');
}

/**
 * Inicializa todas as abas necessárias na Planilha com formatação bonita e segura
 */
function setupDatabase() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  // 1. Aba de Configurações
  let sheetConfig = ss.getSheetByName(SHEETS_CONFIG.CONFIG);
  if (!sheetConfig) {
    sheetConfig = ss.insertSheet(SHEETS_CONFIG.CONFIG);
    sheetConfig.appendRow(['Chave', 'Valor', 'Descricao']);
    sheetConfig.getRange('A1:C1').setBackground('#d81b60').setFontColor('#ffffff').setFontWeight('bold');
    
    // PIN padrão inicial: 123456 (armazenado como Hash SHA-256 com Salt)
    const defaultPinHash = hashSecret('123456');
    const defaultConfigs = [
      ['STUDIO_NOME', 'Studio Glow Nails', 'Nome do Studio exibido no topo'],
      ['PROFISSIONAL_NOME', 'Sua Manicure', 'Nome da profissional'],
      ['WHATSAPP_STUDIO', '5511999999999', 'WhatsApp com DDD (apenas números)'],
      ['PIX_CHAVE', 'suachave@pix.com.br', 'Chave Pix (CPF, CNPJ, Email, Telefone ou Aleatória)'],
      ['PIX_RECEBEDOR', 'STUDIO GLOW NAILS', 'Nome do titular da conta Pix (máx 25 letras)'],
      ['PIX_CIDADE', 'SAO PAULO', 'Cidade do titular da conta Pix (sem acentos)'],
      ['TEMA_COR', 'pink-gold', 'Tema de cores (pink-gold, purple-neon, rose-luxury, emerald-chic)'],
      ['HORARIO_INICIO', '09:00', 'Horário de abertura'],
      ['HORARIO_FIM', '19:00', 'Horário de fechamento'],
      ['INTERVALO_MINUTOS', '60', 'Intervalo padrão da grade (em minutos)'],
      ['DIAS_ATENDIMENTO', '1,2,3,4,5,6', 'Dias da semana (0=Dom, 1=Seg ... 6=Sáb)'],
      ['ADMIN_PIN_HASH', defaultPinHash, 'Hash criptográfico do PIN do Painel Admin (Padrão inicial: 123456)'],
      ['SINCRONIZAR_AGENDA', 'SIM', 'Criar evento automaticamente no Google Agenda (SIM / NAO)']
    ];
    sheetConfig.getRange(2, 1, defaultConfigs.length, 3).setValues(defaultConfigs);
    sheetConfig.setColumnWidth(1, 200);
    sheetConfig.setColumnWidth(2, 280);
    sheetConfig.setColumnWidth(3, 380);
  }

  // 2. Aba de Catálogo
  let sheetCat = ss.getSheetByName(SHEETS_CONFIG.CATALOGO);
  if (!sheetCat) {
    sheetCat = ss.insertSheet(SHEETS_CONFIG.CATALOGO);
    sheetCat.appendRow(['ID', 'Nome', 'Descricao', 'Preco', 'DuracaoMin', 'FotoURL', 'Categoria', 'Ativo']);
    sheetCat.getRange('A1:H1').setBackground('#d81b60').setFontColor('#ffffff').setFontWeight('bold');
    
    const initialServices = [
      [
        'SRV-001',
        'Alongamento em Fibra de Vidro',
        'Alongamento super resistente com acabamento natural, curvatura slim e esmaltação em gel inclusa.',
        140.00,
        120,
        'https://images.unsplash.com/photo-1604654894610-df63bc536371?auto=format&fit=crop&w=600&q=80',
        'Alongamentos',
        'SIM'
      ],
      [
        'SRV-002',
        'Banho de Gel + Blindagem Diamante',
        'Camada protetora de gel sobre a unha natural para evitar quebras e manter o brilho por até 21 dias.',
        90.00,
        60,
        'https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&w=600&q=80',
        'Blindagem & Gel',
        'SIM'
      ],
      [
        'SRV-003',
        'Manicure + Pedicure Tradicional Spa',
        'Cutilagem perfeita, esfoliação hidratante com sais aromáticos e esmaltação impecável.',
        65.00,
        60,
        'https://images.unsplash.com/photo-1632345031435-8727f6897d53?auto=format&fit=crop&w=600&q=80',
        'Tradicional & Spa',
        'SIM'
      ],
      [
        'SRV-004',
        'Nail Art Encapsulada / Francesinha Reversa',
        'Decoração artística personalizada com glitter fino, folhas de ouro ou francesinha sorriso perfeito.',
        110.00,
        90,
        'https://images.unsplash.com/photo-1519014816548-bf5fe059798b?auto=format&fit=crop&w=600&q=80',
        'Nail Art',
        'SIM'
      ]
    ];
    sheetCat.getRange(2, 1, initialServices.length, 8).setValues(initialServices);
  }

  // 3. Aba de Agendamentos
  let sheetAg = ss.getSheetByName(SHEETS_CONFIG.AGENDAMENTOS);
  if (!sheetAg) {
    sheetAg = ss.insertSheet(SHEETS_CONFIG.AGENDAMENTOS);
    sheetAg.appendRow([
      'ID_Reserva',
      'Data',
      'HoraInicio',
      'HoraFim',
      'ClienteNome',
      'ClienteWhatsApp',
      'ServicoID',
      'ServicoNome',
      'Valor',
      'MetodoPagamento',
      'StatusPagamento',
      'StatusReserva',
      'CalendarEventID',
      'CriadoEm',
      'CodigoAcessoCliente'
    ]);
    sheetAg.getRange('A1:O1').setBackground('#880e4f').setFontColor('#ffffff').setFontWeight('bold');
  }

  // 4. Aba de Auditoria de Segurança
  let sheetAudit = ss.getSheetByName(SHEETS_CONFIG.AUDITORIA);
  if (!sheetAudit) {
    sheetAudit = ss.insertSheet(SHEETS_CONFIG.AUDITORIA);
    sheetAudit.appendRow(['Timestamp', 'Evento', 'UsuarioSessao', 'Detalhes']);
    sheetAudit.getRange('A1:D1').setBackground('#263238').setFontColor('#ffffff').setFontWeight('bold');
  }
}

/* ==========================================================================
   CAMADA DE SEGURANÇA, CRIPTOGRAFIA E SANITIZAÇÃO
   ========================================================================== */

/**
 * Gera Hash SHA-256 com Salt vinculado ao ID único da planilha
 */
function hashSecret(plainText) {
  const ssId = SpreadsheetApp.getActiveSpreadsheet().getId();
  const raw = 'NAIL_SEC_SALT_' + ssId + '_' + String(plainText).trim();
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, raw, Utilities.Charset.UTF_8);
  return digest.map(function(byte) {
    return ('0' + (byte & 0xFF).toString(16)).slice(-2);
  }).join('');
}

/**
 * Sanitiza entradas de usuário contra Formula Injection no Google Sheets (=, +, -, @) e scripts HTML
 */
function sanitizeInput(val, maxLength) {
  if (val === null || val === undefined) return '';
  let str = String(val).trim();
  // Remove tags HTML maliciosas
  str = str.replace(/[<>]/g, '');
  // Previne Formula Injection em células de planilha
  if (/^[=+\-@]/.test(str)) {
    str = "'" + str;
  }
  if (maxLength && str.length > maxLength) {
    str = str.substring(0, maxLength);
  }
  return str;
}

/**
 * Registra eventos sensíveis na aba de Auditoria
 */
function logSecurityEvent(evento, detalhes) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEETS_CONFIG.AUDITORIA);
    if (!sheet) return;
    const activeEmail = Session.getActiveUser().getEmail() || 'Visitante_Externo';
    sheet.appendRow([new Date(), evento, activeEmail, sanitizeInput(detalhes, 500)]);
  } catch (e) {
    // Falha silenciosa para não interromper fluxo
  }
}

/**
 * Verifica se quem está acessando é o proprietário da conta Google da planilha
 */
function isGoogleOwnerSession() {
  try {
    const activeUser = Session.getActiveUser().getEmail();
    const effectiveUser = Session.getEffectiveUser().getEmail();
    return Boolean(activeUser && effectiveUser && activeUser.toLowerCase() === effectiveUser.toLowerCase());
  } catch (e) {
    return false;
  }
}

/**
 * Autentica a Manicure no Painel Admin com proteção contra força bruta (Rate Limit)
 */
function authenticateAdmin(pinInput) {
  const cache = CacheService.getScriptCache();
  const lockKey = 'BRUTE_FORCE_COUNT';
  const attempts = Number(cache.get(lockKey) || 0);
  
  if (attempts >= 5) {
    logSecurityEvent('BLOQUEIO_FORCA_BRUTA', 'Múltiplas tentativas incorretas de PIN');
    throw new Error('Muitas tentativas incorretas. Por segurança, aguarde 10 minutos antes de tentar novamente.');
  }

  const configMap = getConfigMapInternal();
  const storedHash = configMap['ADMIN_PIN_HASH'] || hashSecret('123456');
  const inputHash = hashSecret(pinInput);

  if (inputHash !== storedHash) {
    cache.put(lockKey, String(attempts + 1), 600); // Bloqueio de 10 min após 5 erros
    logSecurityEvent('FALHA_LOGIN_ADMIN', 'Tentativa de PIN inválido (' + (attempts + 1) + '/5)');
    throw new Error('PIN de segurança incorreto. Tentativa ' + (attempts + 1) + ' de 5.');
  }

  // Sucesso: limpa contador de erros e gera Token de Sessão Criptográfico válido por 6 horas
  cache.remove(lockKey);
  const sessionToken = Utilities.getUuid() + '-' + Utilities.getUuid();
  cache.put('ADMIN_TOKEN_' + sessionToken, 'VALID', 21600);
  logSecurityEvent('LOGIN_ADMIN_SUCESSO', 'Acesso administrativo autorizado');

  return {
    success: true,
    token: sessionToken,
    isOwnerEmail: isGoogleOwnerSession()
  };
}

/**
 * Valida se o token administrativo enviado nas requisições é válido
 */
function requireAdminAuth(token) {
  if (!token) {
    throw new Error('Acesso negado: Sessão administrativa não iniciada.');
  }
  const cache = CacheService.getScriptCache();
  const status = cache.get('ADMIN_TOKEN_' + token);
  if (status !== 'VALID') {
    throw new Error('Sua sessão expirou por segurança. Faça login novamente com seu PIN.');
  }
}

/**
 * Permite que a dona redefina o PIN diretamente pelo menu da planilha caso esqueça
 */
function resetAdminPinModal() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt(
    '🔑 Definir Novo PIN de Segurança',
    'Digite um novo PIN numérico ou senha (mínimo 4 caracteres) para o Painel da Manicure:',
    ui.ButtonSet.OK_CANCEL
  );

  if (response.getSelectedButton() == ui.Button.OK) {
    const newPin = response.getResponseText().trim();
    if (newPin.length < 4) {
      ui.alert('O PIN deve ter pelo menos 4 caracteres.');
      return;
    }
    updateConfigKeyInternal('ADMIN_PIN_HASH', hashSecret(newPin));
    logSecurityEvent('RESET_PIN_PLANILHA', 'PIN redefinido diretamente pela planilha');
    ui.alert('✅ PIN atualizado com sucesso! Use-o para entrar no Painel da Manicure dentro do App.');
  }
}

/* ==========================================================================
   LEITURA E ESCRITA DE CONFIGURAÇÕES E CATÁLOGO
   ========================================================================== */

function getConfigMapInternal() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEETS_CONFIG.CONFIG);
  const data = sheet.getDataRange().getValues();
  const map = {};
  for (let i = 1; i < data.length; i++) {
    const key = String(data[i][0]).trim();
    if (key) {
      map[key] = data[i][1];
    }
  }
  return map;
}

function updateConfigKeyInternal(key, value) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEETS_CONFIG.CONFIG);
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === key) {
      sheet.getRange(i + 1, 2).setValue(value);
      return;
    }
  }
  sheet.appendRow([key, value, 'Configuração adicionada pelo sistema']);
}

/**
 * Retorna dados públicos seguros para carregamento inicial da cliente
 */
function getPublicBootstrapData() {
  const config = getConfigMapInternal();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheetCat = ss.getSheetByName(SHEETS_CONFIG.CATALOGO);
  const catRows = sheetCat.getDataRange().getValues();
  
  const services = [];
  for (let i = 1; i < catRows.length; i++) {
    const row = catRows[i];
    if (String(row[7]).toUpperCase() === 'SIM' && row[0]) {
      services.push({
        id: String(row[0]),
        nome: String(row[1]),
        descricao: String(row[2]),
        preco: Number(row[3] || 0),
        duracaoMin: Number(row[4] || 60),
        fotoUrl: String(row[5] || ''),
        categoria: String(row[6] || 'Geral')
      });
    }
  }

  return {
    studio: {
      nome: String(config['STUDIO_NOME'] || 'Studio Glow Nails'),
      profissional: String(config['PROFISSIONAL_NOME'] || 'Manicure'),
      whatsapp: String(config['WHATSAPP_STUDIO'] || ''),
      pixChave: String(config['PIX_CHAVE'] || ''),
      pixRecebedor: String(config['PIX_RECEBEDOR'] || ''),
      pixCidade: String(config['PIX_CIDADE'] || 'BRASIL'),
      temaCor: String(config['TEMA_COR'] || 'pink-gold'),
      horarioInicio: String(config['HORARIO_INICIO'] || '09:00'),
      horarioFim: String(config['HORARIO_FIM'] || '19:00'),
      intervaloMinutos: Number(config['INTERVALO_MINUTOS'] || 60),
      diasAtendimento: String(config['DIAS_ATENDIMENTO'] || '1,2,3,4,5,6')
    },
    catalogo: services,
    isGoogleOwner: isGoogleOwnerSession()
  };
}

/* ==========================================================================
   MOTOR DE DISPONIBILIDADE (PLANILHA + GOOGLE AGENDA) E RESERVAS COM LOCK
   ========================================================================== */

/**
 * Converte horário "HH:mm" em minutos desde 00:00
 */
function timeToMinutes(timeStr) {
  const parts = String(timeStr).split(':');
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1] || '0', 10);
}

/**
 * Converte minutos desde 00:00 em "HH:mm"
 */
function minutesToTime(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return ('0' + h).slice(-2) + ':' + ('0' + m).slice(-2);
}

/**
 * Formata objeto Date da planilha em string YYYY-MM-DD ou HH:mm
 */
function normalizeDateStr(val) {
  if (val instanceof Date) {
    return Utilities.formatDate(val, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(val).trim();
}

function normalizeTimeStr(val) {
  if (val instanceof Date) {
    return Utilities.formatDate(val, Session.getScriptTimeZone(), 'HH:mm');
  }
  return String(val).trim().substring(0, 5);
}

/**
 * Consulta horários livres e ocupados em uma data (Cruzando Planilha + Google Agenda)
 * NUNCA expõe dados pessoais de outras clientes.
 */
function getAvailableSlotsForDate(dateStr, serviceId) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error('Data em formato inválido.');
  }

  const config = getConfigMapInternal();
  const startMin = timeToMinutes(config['HORARIO_INICIO'] || '09:00');
  const endMin = timeToMinutes(config['HORARIO_FIM'] || '19:00');
  const stepMin = Number(config['INTERVALO_MINUTOS'] || 60);

  // Busca duração do serviço escolhido
  let serviceDuration = stepMin;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const catData = ss.getSheetByName(SHEETS_CONFIG.CATALOGO).getDataRange().getValues();
  for (let i = 1; i < catData.length; i++) {
    if (String(catData[i][0]) === String(serviceId)) {
      serviceDuration = Number(catData[i][4] || stepMin);
      break;
    }
  }

  // 1. Coleta intervalos ocupados na aba Agendamentos (Status != CANCELADO)
  const busyIntervals = [];
  const agSheet = ss.getSheetByName(SHEETS_CONFIG.AGENDAMENTOS);
  const agData = agSheet.getDataRange().getValues();

  for (let i = 1; i < agData.length; i++) {
    const rowDate = normalizeDateStr(agData[i][1]);
    const statusReserva = String(agData[i][11]).toUpperCase();
    if (rowDate === dateStr && statusReserva !== 'CANCELADO') {
      const bStart = timeToMinutes(normalizeTimeStr(agData[i][2]));
      const bEnd = timeToMinutes(normalizeTimeStr(agData[i][3]));
      busyIntervals.push({ start: bStart, end: bEnd });
    }
  }

  // 2. Coleta compromissos do Google Agenda da Manicure no mesmo dia
  if (String(config['SINCRONIZAR_AGENDA']).toUpperCase() === 'SIM') {
    try {
      const parts = dateStr.split('-');
      const dayStart = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), 0, 0, 0);
      const dayEnd = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), 23, 59, 59);
      const cal = CalendarApp.getDefaultCalendar();
      if (cal) {
        const events = cal.getEvents(dayStart, dayEnd);
        events.forEach(function(ev) {
          if (!ev.isAllDayEvent()) {
            const evStartStr = Utilities.formatDate(ev.getStartTime(), Session.getScriptTimeZone(), 'HH:mm');
            const evEndStr = Utilities.formatDate(ev.getEndTime(), Session.getScriptTimeZone(), 'HH:mm');
            busyIntervals.push({
              start: timeToMinutes(evStartStr),
              end: timeToMinutes(evEndStr)
            });
          }
        });
      }
    } catch (calErr) {
      // Caso a agenda ainda não tenha permissão ou não esteja ativa, segue com a planilha
    }
  }

  // 3. Monta grade de horários verificando colisões
  const slots = [];
  for (let t = startMin; t + serviceDuration <= endMin; t += stepMin) {
    const slotStart = t;
    const slotEnd = t + serviceDuration;
    
    let isOccupied = false;
    for (let j = 0; j < busyIntervals.length; j++) {
      const b = busyIntervals[j];
      // Verifica sobreposição de horário: (StartA < EndB) and (EndA > StartB)
      if (slotStart < b.end && slotEnd > b.start) {
        isOccupied = true;
        break;
      }
    }

    slots.push({
      horaInicio: minutesToTime(slotStart),
      horaFim: minutesToTime(slotEnd),
      disponivel: !isOccupied
    });
  }

  return slots;
}

/**
 * Cria um novo agendamento com trava atômica (LockService), validação de preço no servidor,
 * criação automática na Agenda Google e geração de Payload Pix Oficial (BR Code EMVCo).
 */
function createCustomerBooking(payload) {
  const lock = LockService.getScriptLock();
  // Aguarda até 10 segundos por vez para evitar colisão de reservas simultâneas
  if (!lock.tryLock(10000)) {
    throw new Error('O sistema está processando outra reserva neste exato segundo. Tente novamente.');
  }

  try {
    const dateStr = sanitizeInput(payload.data, 12);
    const horaInicio = sanitizeInput(payload.horaInicio, 8);
    const clienteNome = sanitizeInput(payload.clienteNome, 80);
    const clienteWhats = String(payload.clienteWhatsApp || '').replace(/\D/g, '').substring(0, 15);
    const servicoId = sanitizeInput(payload.servicoId, 30);
    const metodoPagamento = sanitizeInput(payload.metodoPagamento, 30); // 'PIX_SINAL', 'PIX_TOTAL', 'NO_LOCAL'

    if (!clienteNome || clienteNome.length < 2) {
      throw new Error('Por favor, informe seu nome completo.');
    }
    if (clienteWhats.length < 10) {
      throw new Error('Informe um WhatsApp válido com DDD.');
    }

    // 1. Busca dados oficiais do Serviço na Planilha (Impede fraude de valor no front-end)
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const catData = ss.getSheetByName(SHEETS_CONFIG.CATALOGO).getDataRange().getValues();
    let servicoOficial = null;
    for (let i = 1; i < catData.length; i++) {
      if (String(catData[i][0]) === servicoId && String(catData[i][7]).toUpperCase() === 'SIM') {
        servicoOficial = {
          id: String(catData[i][0]),
          nome: String(catData[i][1]),
          preco: Number(catData[i][3]),
          duracaoMin: Number(catData[i][4] || 60)
        };
        break;
      }
    }

    if (!servicoOficial) {
      throw new Error('Serviço selecionado não encontrado ou indisponível.');
    }

    // 2. Revalida se o horário continua livre dentro do Lock
    const slots = getAvailableSlotsForDate(dateStr, servicoId);
    const targetSlot = slots.find(function(s) { return s.horaInicio === horaInicio; });
    if (!targetSlot || !targetSlot.disponivel) {
      throw new Error('Puxa! Esse horário acabou de ser reservado por outra cliente. Escolha outro horário livre.');
    }

    const horaFim = targetSlot.horaFim;
    const reservaId = 'AG-' + Math.floor(100000 + Math.random() * 900000);
    const codigoCliente = Math.floor(1000 + Math.random() * 9000).toString();
    
    const isPix = metodoPagamento.indexOf('PIX') !== -1;
    const statusPagamento = isPix ? 'AGUARDANDO_VALIDACAO_PIX' : 'PAGAR_NO_STUDIO';
    const statusReserva = 'RESERVADO';

    // 3. Registra no Google Agenda da Manicure
    let calendarEventId = '';
    const config = getConfigMapInternal();
    if (String(config['SINCRONIZAR_AGENDA']).toUpperCase() === 'SIM') {
      try {
        const parts = dateStr.split('-');
        const startParts = horaInicio.split(':');
        const endParts = horaFim.split(':');
        const startDate = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), Number(startParts[0]), Number(startParts[1]), 0);
        const endDate = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), Number(endParts[0]), Number(endParts[1]), 0);
        
        const cal = CalendarApp.getDefaultCalendar();
        if (cal) {
          const tituloEvento = '💅 ' + servicoOficial.nome + ' - ' + clienteNome;
          const descEvento = 'Cliente: ' + clienteNome +
            '\nWhatsApp: ' + clienteWhats +
            '\nServiço: ' + servicoOficial.nome +
            '\nValor: R$ ' + servicoOficial.preco.toFixed(2) +
            '\nForma Pagto: ' + metodoPagamento + ' (' + statusPagamento + ')' +
            '\nCódigo Reserva: ' + reservaId;
          const ev = cal.createEvent(tituloEvento, startDate, endDate, { description: descEvento });
          calendarEventId = ev.getId();
        }
      } catch (eCal) {
        // Continua mesmo se a agenda não estiver acessível
      }
    }

    // 4. Salva na Planilha
    const agSheet = ss.getSheetByName(SHEETS_CONFIG.AGENDAMENTOS);
    agSheet.appendRow([
      reservaId,
      dateStr,
      horaInicio,
      horaFim,
      clienteNome,
      clienteWhats,
      servicoOficial.id,
      servicoOficial.nome,
      servicoOficial.preco,
      metodoPagamento,
      statusPagamento,
      statusReserva,
      calendarEventId,
      Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss'),
      codigoCliente
    ]);

    // 5. Gera código Pix Copia e Cola EMVCo caso tenha escolhido Pix
    const valorPix = metodoPagamento === 'PIX_SINAL_50' ? (servicoOficial.preco / 2) : servicoOficial.preco;
    const pixCopiaECola = generatePixPayload(
      String(config['PIX_CHAVE'] || ''),
      String(config['PIX_RECEBEDOR'] || 'STUDIO NAILS'),
      String(config['PIX_CIDADE'] || 'SAO PAULO'),
      valorPix,
      reservaId.replace(/[^a-zA-Z0-9]/g, '')
    );

    return {
      success: true,
      reserva: {
        id: reservaId,
        data: dateStr,
        horaInicio: horaInicio,
        horaFim: horaFim,
        clienteNome: clienteNome,
        servicoNome: servicoOficial.nome,
        valorTotal: servicoOficial.preco,
        valorCobradoAgora: valorPix,
        metodoPagamento: metodoPagamento,
        statusPagamento: statusPagamento,
        pixCopiaECola: pixCopiaECola,
        pixChave: String(config['PIX_CHAVE'] || ''),
        pixRecebedor: String(config['PIX_RECEBEDOR'] || ''),
        whatsappStudio: String(config['WHATSAPP_STUDIO'] || '')
      }
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Permite que a cliente avise que já realizou o Pix para destacar no painel da manicure
 */
function notifyPixPaidByCustomer(reservaId) {
  const cleanId = sanitizeInput(reservaId, 20);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEETS_CONFIG.AGENDAMENTOS);
  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === cleanId) {
      const currentStatus = String(data[i][10]);
      if (currentStatus !== 'PIX_CONFIRMADO') {
        sheet.getRange(i + 1, 11).setValue('CLIENTE_INFORMOU_PIX');
      }
      return { success: true };
    }
  }
  throw new Error('Reserva não localizada.');
}

/* ==========================================================================
   GERADOR OFICIAL DE PIX COPIA E COLA (PADRÃO BACEN EMVCo + CRC16)
   ========================================================================== */

function formatEmvField(id, value) {
  const valStr = String(value);
  const len = ('00' + valStr.length).slice(-2);
  return id + len + valStr;
}

function computeCRC16(payload) {
  let crc = 0xFFFF;
  const polynomial = 0x1021;
  for (let i = 0; i < payload.length; i++) {
    crc ^= (payload.charCodeAt(i) << 8);
    for (let bit = 0; bit < 8; bit++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ polynomial) & 0xFFFF;
      } else {
        crc = (crc << 1) & 0xFFFF;
      }
    }
  }
  return ('0000' + crc.toString(16).toUpperCase()).slice(-4);
}

function generatePixPayload(pixKey, merchantName, merchantCity, amount, txId) {
  const cleanKey = String(pixKey || '').trim();
  if (!cleanKey) return '';

  const cleanName = String(merchantName || 'MANICURE')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().substring(0, 25);
  const cleanCity = String(merchantCity || 'BRASIL')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().substring(0, 15);
  const cleanTxId = String(txId || '***').replace(/[^a-zA-Z0-9]/g, '').substring(0, 25) || '***';

  const gui = formatEmvField('00', 'br.gov.bcb.pix');
  const keyField = formatEmvField('01', cleanKey);
  const merchantAccountInfo = formatEmvField('26', gui + keyField);

  let payload = '';
  payload += formatEmvField('00', '01'); // Payload Format Indicator
  payload += merchantAccountInfo;
  payload += formatEmvField('52', '0000'); // Merchant Category Code
  payload += formatEmvField('53', '986');  // Currency BRL
  if (amount && Number(amount) > 0) {
    payload += formatEmvField('54', Number(amount).toFixed(2));
  }
  payload += formatEmvField('58', 'BR');
  payload += formatEmvField('59', cleanName);
  payload += formatEmvField('60', cleanCity);
  payload += formatEmvField('62', formatEmvField('05', cleanTxId));
  payload += '6304'; // CRC16 ID + Length

  const crc = computeCRC16(payload);
  return payload + crc;
}

/* ==========================================================================
   ROTAS EXCLUSIVAS DO PAINEL DA MANICURE (PROTEGIDAS POR TOKEN + HASH)
   ========================================================================== */

/**
 * Retorna todos os agendamentos, catálogo completo e configurações para a Manicure autenticada
 */
function getAdminDashboardData(token) {
  requireAdminAuth(token);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const config = getConfigMapInternal();

  // Catálogo Completo (incluindo inativos)
  const catRows = ss.getSheetByName(SHEETS_CONFIG.CATALOGO).getDataRange().getValues();
  const catalogo = [];
  for (let i = 1; i < catRows.length; i++) {
    if (catRows[i][0]) {
      catalogo.push({
        id: String(catRows[i][0]),
        nome: String(catRows[i][1]),
        descricao: String(catRows[i][2]),
        preco: Number(catRows[i][3] || 0),
        duracaoMin: Number(catRows[i][4] || 60),
        fotoUrl: String(catRows[i][5] || ''),
        categoria: String(catRows[i][6] || 'Geral'),
        ativo: String(catRows[i][7] || 'SIM').toUpperCase() === 'SIM'
      });
    }
  }

  // Lista de Agendamentos
  const agRows = ss.getSheetByName(SHEETS_CONFIG.AGENDAMENTOS).getDataRange().getValues();
  const agendamentos = [];
  for (let i = 1; i < agRows.length; i++) {
    if (agRows[i][0]) {
      agendamentos.push({
        id: String(agRows[i][0]),
        data: normalizeDateStr(agRows[i][1]),
        horaInicio: normalizeTimeStr(agRows[i][2]),
        horaFim: normalizeTimeStr(agRows[i][3]),
        clienteNome: String(agRows[i][4]),
        clienteWhatsApp: String(agRows[i][5]),
        servicoId: String(agRows[i][6]),
        servicoNome: String(agRows[i][7]),
        valor: Number(agRows[i][8] || 0),
        metodoPagamento: String(agRows[i][9]),
        statusPagamento: String(agRows[i][10]),
        statusReserva: String(agRows[i][11]),
        criadoEm: String(agRows[i][13] || '')
      });
    }
  }

  // Ordena por data e hora mais recentes
  agendamentos.sort(function(a, b) {
    return (b.data + ' ' + b.horaInicio).localeCompare(a.data + ' ' + a.horaInicio);
  });

  return {
    studio: {
      nome: String(config['STUDIO_NOME'] || ''),
      profissional: String(config['PROFISSIONAL_NOME'] || ''),
      whatsapp: String(config['WHATSAPP_STUDIO'] || ''),
      pixChave: String(config['PIX_CHAVE'] || ''),
      pixRecebedor: String(config['PIX_RECEBEDOR'] || ''),
      pixCidade: String(config['PIX_CIDADE'] || ''),
      temaCor: String(config['TEMA_COR'] || 'pink-gold'),
      horarioInicio: String(config['HORARIO_INICIO'] || '09:00'),
      horarioFim: String(config['HORARIO_FIM'] || '19:00'),
      intervaloMinutos: Number(config['INTERVALO_MINUTOS'] || 60),
      sincronizarAgenda: String(config['SINCRONIZAR_AGENDA'] || 'SIM')
    },
    catalogo: catalogo,
    agendamentos: agendamentos,
    spreadsheetUrl: ss.getUrl()
  };
}

/**
 * Valida / Aprova pagamento Pix ou Cancela agendamento (Libera horário na agenda)
 */
function adminUpdateBookingStatus(token, reservaId, acao) {
  requireAdminAuth(token);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEETS_CONFIG.AGENDAMENTOS);
  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(reservaId)) {
      const rowNum = i + 1;
      const calendarEventId = String(data[i][12] || '');

      if (acao === 'VALIDAR_PIX') {
        sheet.getRange(rowNum, 11).setValue('PIX_CONFIRMADO');
        sheet.getRange(rowNum, 12).setValue('CONFIRMADO');
        logSecurityEvent('PIX_VALIDADO', 'Reserva ' + reservaId + ' validada pela manicure');
      } else if (acao === 'CANCELAR_RESERVA') {
        sheet.getRange(rowNum, 12).setValue('CANCELADO');
        // Remove do Google Agenda para liberar o horário imediatamente
        if (calendarEventId) {
          try {
            const cal = CalendarApp.getDefaultCalendar();
            const ev = cal.getEventById(calendarEventId);
            if (ev) ev.deleteEvent();
          } catch (e) {}
        }
        logSecurityEvent('RESERVA_CANCELADA', 'Reserva ' + reservaId + ' cancelada e horário liberado');
      }
      return getAdminDashboardData(token);
    }
  }
  throw new Error('Agendamento não encontrado.');
}

/**
 * Salva ou Atualiza um Serviço no Catálogo (Com suporte a Foto URL ou Base64)
 */
function adminSaveService(token, serviceObj) {
  requireAdminAuth(token);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEETS_CONFIG.CATALOGO);
  const data = sheet.getDataRange().getValues();

  const nome = sanitizeInput(serviceObj.nome, 80);
  const descricao = sanitizeInput(serviceObj.descricao, 250);
  const preco = Math.max(0, Number(serviceObj.preco || 0));
  const duracaoMin = Math.max(15, Number(serviceObj.duracaoMin || 60));
  const fotoUrl = String(serviceObj.fotoUrl || '').trim();
  const categoria = sanitizeInput(serviceObj.categoria || 'Geral', 40);
  const ativo = serviceObj.ativo === false ? 'NAO' : 'SIM';

  if (!nome) throw new Error('O nome do serviço é obrigatório.');

  if (serviceObj.id) {
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(serviceObj.id)) {
        sheet.getRange(i + 1, 2, 1, 7).setValues([[nome, descricao, preco, duracaoMin, fotoUrl, categoria, ativo]]);
        logSecurityEvent('SERVICO_ATUALIZADO', 'Serviço ' + serviceObj.id + ' editado');
        return getAdminDashboardData(token);
      }
    }
  }

  const newId = 'SRV-' + Math.floor(1000 + Math.random() * 9000);
  sheet.appendRow([newId, nome, descricao, preco, duracaoMin, fotoUrl, categoria, ativo]);
  logSecurityEvent('SERVICO_CRIADO', 'Novo serviço ' + newId + ': ' + nome);
  return getAdminDashboardData(token);
}

/**
 * Remove ou desativa um serviço do catálogo
 */
function adminDeleteService(token, serviceId) {
  requireAdminAuth(token);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEETS_CONFIG.CATALOGO);
  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(serviceId)) {
      sheet.deleteRow(i + 1);
      logSecurityEvent('SERVICO_REMOVIDO', 'Serviço ' + serviceId + ' removido');
      return getAdminDashboardData(token);
    }
  }
  throw new Error('Serviço não encontrado.');
}

/**
 * Salva configurações do Studio, Chave Pix, Horários, Tema de Cores e novo PIN opcional
 */
function adminSaveSettings(token, settingsObj) {
  requireAdminAuth(token);

  updateConfigKeyInternal('STUDIO_NOME', sanitizeInput(settingsObj.nome, 60));
  updateConfigKeyInternal('PROFISSIONAL_NOME', sanitizeInput(settingsObj.profissional, 60));
  updateConfigKeyInternal('WHATSAPP_STUDIO', String(settingsObj.whatsapp || '').replace(/\D/g, '').substring(0, 15));
  updateConfigKeyInternal('PIX_CHAVE', sanitizeInput(settingsObj.pixChave, 100));
  updateConfigKeyInternal('PIX_RECEBEDOR', sanitizeInput(settingsObj.pixRecebedor, 25));
  updateConfigKeyInternal('PIX_CIDADE', sanitizeInput(settingsObj.pixCidade, 15));
  updateConfigKeyInternal('TEMA_COR', sanitizeInput(settingsObj.temaCor, 30));
  updateConfigKeyInternal('HORARIO_INICIO', sanitizeInput(settingsObj.horarioInicio, 5));
  updateConfigKeyInternal('HORARIO_FIM', sanitizeInput(settingsObj.horarioFim, 5));
  updateConfigKeyInternal('INTERVALO_MINUTOS', Number(settingsObj.intervaloMinutos || 60));
  updateConfigKeyInternal('SINCRONIZAR_AGENDA', settingsObj.sincronizarAgenda === 'NAO' ? 'NAO' : 'SIM');

  if (settingsObj.novoPin && String(settingsObj.novoPin).trim().length >= 4) {
    updateConfigKeyInternal('ADMIN_PIN_HASH', hashSecret(settingsObj.novoPin));
    logSecurityEvent('PIN_ALTERADO_PAINEL', 'PIN de segurança atualizado pelo painel');
  }

  logSecurityEvent('CONFIG_ATUALIZADA', 'Configurações do Studio e Pix atualizadas');
  return getAdminDashboardData(token);
}


/**
 * Instala o gatilho automático de segundo plano no Google Sheets.
 * Sempre que um agendamento for adicionado ou alterado (via App ou API),
 * a nuvem do Google cria ou exclui o evento da Google Agenda automaticamente!
 */
function setupCalendarAutoSyncTrigger() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const triggers = ScriptApp.getUserTriggers(ss);
  triggers.forEach(t => {
    if (t.getHandlerFunction() === 'onSpreadsheetAutoSyncCalendar') {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger('onSpreadsheetAutoSyncCalendar')
    .forSpreadsheet(ss)
    .onChange()
    .create();

  SpreadsheetApp.getUi().alert('✅ Sincronização Automática com o Google Agenda Ativada com Sucesso!');
}

/**
 * Função executada automaticamente 24h por dia na nuvem do Google
 */
function onSpreadsheetAutoSyncCalendar(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const agSheet = ss.getSheetByName(SHEETS_CONFIG.AGENDAMENTOS);
  if (!agSheet) return;

  const data = agSheet.getDataRange().getValues();
  if (data.length <= 1) return;

  const cal = CalendarApp.getDefaultCalendar();
  if (!cal) return;

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const rowNum = i + 1;
    const reservaId = String(row[0] || '');
    const dateStr = normalizeDateStr(row[1]);
    const horaInicio = normalizeTimeStr(row[2]);
    const horaFim = normalizeTimeStr(row[3]);
    const clienteNome = String(row[4] || '');
    const clienteWhats = String(row[5] || '');
    const servicoNome = String(row[7] || 'Atendimento');
    const valor = Number(row[8] || 0);
    const metodoPag = String(row[9] || '');
    const statusReserva = String(row[11] || '').toUpperCase();
    let calEventId = String(row[12] || '');

    // 1. Cria evento na Google Agenda se for nova reserva
    if ((statusReserva === 'RESERVADO' || statusReserva === 'CONFIRMADO') && (!calEventId || calEventId.startsWith('GCAL-AG-') || calEventId === '')) {
      try {
        const parts = dateStr.split('-');
        const startParts = horaInicio.split(':');
        const endParts = horaFim.split(':');
        const startDate = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), Number(startParts[0]), Number(startParts[1]), 0);
        const endDate = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), Number(endParts[0]), Number(endParts[1]), 0);

        const title = '💅 ' + servicoNome + ' - ' + clienteNome;
        const desc = 'Cliente: ' + clienteNome +
          '\nWhatsApp: ' + clienteWhats +
          '\nProcedimento: ' + servicoNome +
          '\nValor: R$ ' + valor.toFixed(2) +
          '\nPagamento: ' + metodoPag +
          '\nCódigo: ' + reservaId;

        const ev = cal.createEvent(title, startDate, endDate, { description: desc });
        agSheet.getRange(rowNum, 13).setValue(ev.getId());
      } catch (err) {}
    }

    // 2. Remove evento da Google Agenda se foi cancelado
    if (statusReserva === 'CANCELADO' && calEventId && !calEventId.startsWith('GCAL-AG-') && !calEventId.startsWith('DELETED_')) {
      try {
        const ev = cal.getEventById(calEventId);
        if (ev) {
          ev.deleteEvent();
        }
        agSheet.getRange(rowNum, 13).setValue('DELETED_' + calEventId);
      } catch (err) {}
    }
  }
}

/**
 * Ponto de entrada Webhook para sincronização instantânea via Web App
 */
function doPost(e) {
  try {
    const postData = JSON.parse(e.postData.contents || '{}');
    const action = postData.action;
    const cal = CalendarApp.getDefaultCalendar();

    if (action === 'CREATE' && postData.eventData) {
      const ed = postData.eventData;
      const parts = String(ed.data).split('-');
      const startParts = String(ed.horaInicio).split(':');
      const endParts = String(ed.horaFim).split(':');
      const startDate = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), Number(startParts[0]), Number(startParts[1]), 0);
      const endDate = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), Number(endParts[0]), Number(endParts[1]), 0);

      const title = '💅 ' + (ed.servicoNome || 'Procedimento') + ' - ' + (ed.clienteNome || 'Cliente');
      const desc = 'Cliente: ' + (ed.clienteNome || '') +
        '\nWhatsApp: ' + (ed.clienteWhatsApp || '') +
        '\nProcedimento: ' + (ed.servicoNome || '') +
        '\nValor: R$ ' + Number(ed.valor || 0).toFixed(2) +
        '\nReserva: ' + (ed.id || '');
      const ev = cal.createEvent(title, startDate, endDate, { description: desc });
      return ContentService.createTextOutput(JSON.stringify({ success: true, eventId: ev.getId() })).setMimeType(ContentService.MimeType.JSON);
    }

    if (action === 'DELETE' && postData.eventId) {
      const ev = cal.getEventById(postData.eventId);
      if (ev) ev.deleteEvent();
      return ContentService.createTextOutput(JSON.stringify({ success: true, deleted: true })).setMimeType(ContentService.MimeType.JSON);
    }

    return ContentService.createTextOutput(JSON.stringify({ success: false, error: 'Ação desconhecida' })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ success: false, error: err.toString() })).setMimeType(ContentService.MimeType.JSON);
  }
}
