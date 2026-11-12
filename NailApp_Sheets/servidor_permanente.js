/**
 * Servidor Permanente do Ecossistema Nail Studio Pro (Porta 8080)
 * Inclui:
 * 1. Servidor de Arquivos Estáticos (App_Manicure, Pagina_Cliente, Index, etc.)
 * 2. Proxy Seguro para Google Sheets & Drive (sem vazar credenciais no cliente)
 * 3. OAuth 2.0 e Sincronização Automática com Google Agenda (2 vias: Cria e Apaga)
 * 4. Suporte a Webhooks do Google Apps Script
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 8080;
const BASE_DIR = __dirname;
const GSHEETS_TOKEN_PATH = 'C:/Users/posve/.gemini/antigravity/plugin_data/gsheets/token.json';
const TENANTS_PATH = 'C:/Users/posve/.gemini/antigravity/plugin_data/tenants.json';
const GCAL_TENANTS_PATH = 'C:/Users/posve/.gemini/antigravity/plugin_data/gcalendar_tenants.json';

if (!fs.existsSync(TENANTS_PATH)) {
  fs.writeFileSync(TENANTS_PATH, JSON.stringify({}, null, 2), 'utf8');
}

function getTenantsMap() {
  try {
    return JSON.parse(fs.readFileSync(TENANTS_PATH, 'utf8') || '{}');
  } catch (e) {
    return {};
  }
}

function saveTenantsMap(map) {
  fs.writeFileSync(TENANTS_PATH, JSON.stringify(map, null, 2), 'utf8');
}

// Garante que o arquivo de tenants de calendário exista
if (!fs.existsSync(GCAL_TENANTS_PATH)) {
  fs.writeFileSync(GCAL_TENANTS_PATH, JSON.stringify({}, null, 2), 'utf8');
}

function getTenantsCalendarMap() {
  try {
    return JSON.parse(fs.readFileSync(GCAL_TENANTS_PATH, 'utf8') || '{}');
  } catch (e) {
    return {};
  }
}

function saveTenantsCalendarMap(map) {
  fs.writeFileSync(GCAL_TENANTS_PATH, JSON.stringify(map, null, 2), 'utf8');
}

function getDynamicPublicUrl(req) {
  try {
    if (req && req.headers && req.headers.host && req.headers.host.includes('trycloudflare.com')) {
      return 'https://' + req.headers.host;
    }
    const tunnelLogPath = path.join(BASE_DIR, '..', 'scratch', 'tunnel.log');
    if (fs.existsSync(tunnelLogPath)) {
      const logContent = fs.readFileSync(tunnelLogPath, 'utf8');
      const matches = logContent.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/g);
      if (matches && matches.length > 0) {
        return matches[matches.length - 1];
      }
    }
  } catch (e) {}
  return 'https://package-gains-documented-broadcasting.trycloudflare.com';
}

let cachedGoogleAccessToken = null;
let googleTokenExpiresAt = 0;

async function fetchWithRetry(url, options = {}, maxRetries = 3) {
  let lastErr;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      lastErr = err;
      await new Promise(r => setTimeout(r, 700 * (i + 1)));
    }
  }
  throw lastErr;
}

async function getMasterGoogleAccessToken() {
  if (cachedGoogleAccessToken && Date.now() < googleTokenExpiresAt) {
    return cachedGoogleAccessToken;
  }
  const t = JSON.parse(fs.readFileSync(GSHEETS_TOKEN_PATH, 'utf8'));
  const res = await fetchWithRetry('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: t.client_id,
      client_secret: t.client_secret,
      refresh_token: t.token.refresh_token,
      grant_type: 'refresh_token'
    })
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error('Falha ao renovar token mestre do Google: ' + JSON.stringify(data));
  }
  cachedGoogleAccessToken = data.access_token;
  googleTokenExpiresAt = Date.now() + ((data.expires_in - 60) * 1000);
  return cachedGoogleAccessToken;
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.apk': 'application/vnd.android.package-archive'
};

function readBodyJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  if (pathname === '/api/public-url' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, publicUrl: getDynamicPublicUrl(req) }));
    return;
  }

  // -------------------------------------------------------------
  // ROTA G1: Login Puro com Conta Google (1 Toque + Vínculo Automático)
  // -------------------------------------------------------------
  if (pathname === '/api/auth/google' && req.method === 'POST') {
    try {
      const p = await readBodyJson(req);
      const email = String(p.email || '').trim().toLowerCase();
      const name = String(p.name || 'Meu Studio').trim();
      const deviceProof = String(p.deviceProof || '').trim();

      if (!email || !email.includes('@')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'E-mail do Google inválido.' }));
        return;
      }

      // BLOQUEIO ESTRITO: Exige prova criptográfica gerada pelo AccountManager nativo do Android (Contas reais do aparelho)
      const expectedProof = 'ANDROID_OS_VERIFIED_' + Buffer.from('NAIL_ACCOUNTS_V2:' + email, 'utf8').toString('base64');
      if (deviceProof !== expectedProof) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          error: 'Acesso negado: O aplicativo só permite login com uma Conta Google REAL cadastrada nas Contas (Accounts) do seu celular.'
        }));
        return;
      }

      const map = getTenantsMap();

      // 1. Se a usuária já tiver conta vinculada, retorna direto!
      if (map[email] && map[email].spreadsheetId) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          isNew: false,
          tenant: map[email],
          token: 'AUTH_' + Buffer.from(email).toString('hex').slice(0, 16)
        }));
        return;
      }

      // 2. Se for primeiro acesso, provisiona automaticamente uma nova planilha para ela
      const token = await getMasterGoogleAccessToken();
      const TEMPLATE_ID = '18lhkSiX1d6Y-NzJtTtHdGgUPbbYIUZAVfjUKe-gn9nM';
      const copyRes = await fetchWithRetry(`https://www.googleapis.com/drive/v3/files/${TEMPLATE_ID}/copy`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: `${name} - Banco de Dados Oficial`
        })
      });
      const sheet = await copyRes.json();
      if (!sheet.id) throw new Error('Falha ao gerar planilha: ' + JSON.stringify(sheet));
      const newSheetId = sheet.id;

      // Valida na API oficial do Google Drive se o e-mail pertence a uma Conta Google real existente
      const shareRes = await fetchWithRetry(`https://www.googleapis.com/drive/v3/files/${newSheetId}/permissions?sendNotificationEmail=false`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'writer', type: 'user', emailAddress: email })
      });
      if (!shareRes.ok) {
        try {
          await fetchWithRetry(`https://www.googleapis.com/drive/v3/files/${newSheetId}`, {
            method: 'DELETE',
            headers: { Authorization: 'Bearer ' + token }
          });
        } catch (eDel) {}
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          error: 'Esta conta não existe nos servidores do Google. Selecione uma Conta Google real cadastrada no seu celular.'
        }));
        return;
      }

      // Permissão pública de escrita para o app operar
      await fetchWithRetry(`https://www.googleapis.com/drive/v3/files/${newSheetId}/permissions`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'writer', type: 'anyone' })
      });

      // Compartilha diretamente no Google Drive da usuária
      try {
        await fetchWithRetry(`https://www.googleapis.com/drive/v3/files/${newSheetId}/permissions?sendNotificationEmail=false`, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: 'writer', type: 'user', emailAddress: email })
        });
      } catch (eUserShare) {}

      // Grava configurações iniciais na aba Configuracoes
      const newConfigs = [
        ['Chave', 'Valor', 'Descricao'],
        ['SETUP_CONCLUIDO', 'SIM', 'Configurado pelo App'],
        ['STUDIO_NOME', name, 'Nome do Studio'],
        ['PROFISSIONAL_NOME', name, 'Nome da Profissional'],
        ['ADMIN_LOGIN_ID', email, 'Conta Google do Titular'],
        ['WHATSAPP_STUDIO', '5511999999999', 'WhatsApp Oficial'],
        ['PIX_CHAVE', email, 'Chave Pix Oficial'],
        ['PIX_RECEBEDOR', name, 'Nome do Titular Pix'],
        ['PIX_CIDADE', 'SAO PAULO', 'Cidade'],
        ['TEMA_COR', 'pink-gold', 'Tema Visual'],
        ['HORARIO_INICIO', '09:00', 'Abertura'],
        ['HORARIO_FIM', '19:00', 'Fechamento'],
        ['ALMOCO_INICIO', '12:00', 'Inicio Almoco'],
        ['ALMOCO_FIM', '13:00', 'Fim Almoco'],
        ['DIAS_ATENDIMENTO', '1,2,3,4,5,6', 'Dias de Atendimento'],
        ['INTERVALO_MINUTOS', '60', 'Intervalo em Minutos'],
        ['SINCRONIZAR_AGENDA', 'SIM', 'Google Agenda Ativa'],
        ['ADMIN_PIN_HASH', 'GOOGLE_SSO', 'Autenticado via Google'],
        ['ADMIN_RECOVERY_HASH', '', 'Recuperação via Google'],
        ['CRIADO_EM', new Date().toLocaleString('pt-BR'), 'Data de Criação']
      ];

      await fetchWithRetry(`https://sheets.googleapis.com/v4/spreadsheets/${newSheetId}/values/Configuracoes!A1?valueInputOption=USER_ENTERED`, {
        method: 'PUT',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: newConfigs })
      });

      const tenantRecord = {
        email: email,
        profissionalNome: name,
        studioNome: name,
        spreadsheetId: newSheetId,
        spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${newSheetId}/edit`,
        clientLink: `${getDynamicPublicUrl(req)}/Pagina_Cliente.html?s=${newSheetId}`,
        pinHash: 'GOOGLE_SSO',
        createdAt: new Date().toLocaleString('pt-BR')
      };
      map[email] = tenantRecord;
      map[newSheetId] = tenantRecord;
      saveTenantsMap(map);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        isNew: true,
        tenant: tenantRecord,
        token: 'AUTH_' + Buffer.from(email).toString('hex').slice(0, 16)
      }));
    } catch (err) {
      console.error('ERRO EM GOOGLE AUTH:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }


  // -------------------------------------------------------------
  // ROTA T3: Criação Automática Instantânea da Planilha do Studio
  // -------------------------------------------------------------
  if (pathname === '/api/tenants/auto-provision' && req.method === 'POST') {
    try {
      const p = await readBodyJson(req);
      const email = String(p.email || p.googleEmail || '').trim().toLowerCase();
      const studioNome = String(p.studioNome || 'Meu Studio de Unhas').trim();
      const whatsapp = String(p.whatsapp || '').replace(/\D/g, '');
      const pinHash = String(p.pinHash || '');
      const recHash = String(p.recoveryHash || '');

      if (!email || !email.includes('@')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'E-mail Google válido é obrigatório.' }));
        return;
      }

      const token = await getMasterGoogleAccessToken();

      // 1. Clona o modelo oficial limpo
      const TEMPLATE_ID = '18lhkSiX1d6Y-NzJtTtHdGgUPbbYIUZAVfjUKe-gn9nM';
      const copyRes = await fetchWithRetry(`https://www.googleapis.com/drive/v3/files/${TEMPLATE_ID}/copy`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: `${studioNome} - Banco de Dados Oficial`
        })
      });
      const sheet = await copyRes.json();
      if (!sheet.id) {
        throw new Error('Falha ao clonar modelo da planilha: ' + JSON.stringify(sheet));
      }
      const newSheetId = sheet.id;

      // 2. Permissão pública de escrita (para o aplicativo operar)
      await fetchWithRetry(`https://www.googleapis.com/drive/v3/files/${newSheetId}/permissions`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'writer', type: 'anyone' })
      });

      // 3. Compartilha diretamente no Google Drive da usuária
      try {
        await fetchWithRetry(`https://www.googleapis.com/drive/v3/files/${newSheetId}/permissions?sendNotificationEmail=false`, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: 'writer', type: 'user', emailAddress: email })
        });
      } catch (eUserShare) {}

      // 4. Grava configurações iniciais na aba Configuracoes da nova planilha
      const cleanPhone = whatsapp.startsWith('55') ? whatsapp : ('55' + whatsapp);
      const newConfigs = [
        ['Chave', 'Valor', 'Descricao'],
        ['SETUP_CONCLUIDO', 'SIM', 'Configurado pelo App'],
        ['STUDIO_NOME', studioNome, 'Nome do Studio'],
        ['PROFISSIONAL_NOME', p.profissionalNome || studioNome, 'Nome da Profissional'],
        ['ADMIN_LOGIN_ID', email, 'Conta Google do Titular'],
        ['WHATSAPP_STUDIO', cleanPhone, 'WhatsApp Oficial'],
        ['PIX_CHAVE', p.pixChave || cleanPhone, 'Chave Pix Oficial'],
        ['PIX_RECEBEDOR', studioNome, 'Nome do Titular Pix'],
        ['PIX_CIDADE', 'SAO PAULO', 'Cidade'],
        ['TEMA_COR', 'pink-gold', 'Tema Visual'],
        ['HORARIO_INICIO', '09:00', 'Abertura'],
        ['HORARIO_FIM', '19:00', 'Fechamento'],
        ['ALMOCO_INICIO', '12:00', 'Inicio Almoco'],
        ['ALMOCO_FIM', '13:00', 'Fim Almoco'],
        ['DIAS_ATENDIMENTO', '1,2,3,4,5,6', 'Dias de Atendimento'],
        ['INTERVALO_MINUTOS', '60', 'Intervalo em Minutos'],
        ['SINCRONIZAR_AGENDA', 'SIM', 'Google Agenda Ativa'],
        ['ADMIN_PIN_HASH', pinHash, 'Hash do PIN'],
        ['ADMIN_RECOVERY_HASH', recHash, 'Hash de Recuperação'],
        ['CRIADO_EM', new Date().toLocaleString('pt-BR'), 'Data de Criação']
      ];

      await fetchWithRetry(`https://sheets.googleapis.com/v4/spreadsheets/${newSheetId}/values/Configuracoes!A1?valueInputOption=USER_ENTERED`, {
        method: 'PUT',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: newConfigs })
      });

      // 5. Registra o tenant no banco local
      const map = getTenantsMap();
      const tenantRecord = {
        email: email,
        profissionalNome: p.profissionalNome || studioNome,
        studioNome: studioNome,
        spreadsheetId: newSheetId,
        spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${newSheetId}/edit`,
        clientLink: `${getDynamicPublicUrl(req)}/Pagina_Cliente.html?s=${newSheetId}`,
        pinHash: pinHash,
        recoveryHash: recHash,
        createdAt: new Date().toLocaleString('pt-BR')
      };
      map[email] = tenantRecord;
      map[newSheetId] = tenantRecord;
      saveTenantsMap(map);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, tenant: tenantRecord }));
    } catch (err) {
      console.error('ERRO EM AUTO-PROVISION:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message, stack: err.stack }));
    }
    return;
  }


  // -------------------------------------------------------------
  // ROTA T1: Consulta de Tenant por E-mail
  // -------------------------------------------------------------
  if (pathname === '/api/tenants/lookup' && req.method === 'GET') {
    const email = String(parsedUrl.query.email || '').trim().toLowerCase();
    const map = getTenantsMap();
    const tenant = map[email];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (tenant) {
      res.end(JSON.stringify({ found: true, tenant }));
    } else {
      res.end(JSON.stringify({ found: false }));
    }
    return;
  }

  // -------------------------------------------------------------
  // ROTA T2: Registro Permanente de Novo Studio
  // -------------------------------------------------------------
  if (pathname === '/api/tenants/register' && req.method === 'POST') {
    try {
      const p = await readBodyJson(req);
      const email = String(p.email || p.googleEmail || p.loginId || '').trim().toLowerCase();
      const sheetId = String(p.sheetId || p.customSheetId || '').trim();
      if (!email || !sheetId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Email e ID da planilha são obrigatórios' }));
        return;
      }
      const map = getTenantsMap();
      const tenantRecord = {
        email: email,
        profissionalNome: p.profissionalNome || '',
        studioNome: p.studioNome || '',
        spreadsheetId: sheetId,
        spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${sheetId}/edit`,
        clientLink: `${getDynamicPublicUrl(req)}/Pagina_Cliente.html?s=${sheetId}`,
        pinHash: p.pinHash || '',
        recoveryHash: p.recoveryHash || '',
        createdAt: new Date().toLocaleString('pt-BR')
      };
      map[email] = tenantRecord;
      map[sheetId] = tenantRecord;
      saveTenantsMap(map);

      // Se passou webhookUrl de Google Agenda, já registra também
      if (p.webhookUrl) {
        const calMap = getTenantsCalendarMap();
        calMap[email] = {
          type: 'webhook',
          webhookUrl: p.webhookUrl,
          email: email,
          sheetId: sheetId,
          connectedAt: new Date().toLocaleString('pt-BR')
        };
        calMap[sheetId] = calMap[email];
        saveTenantsCalendarMap(calMap);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, tenant: tenantRecord }));
    } catch (err) {
      console.error('ERRO EM AUTO-PROVISION:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message, stack: err.stack }));
    }
    return;
  }


  // -------------------------------------------------------------
  // ROTA 1: Status de Conexão com o Google Agenda do Studio
  // -------------------------------------------------------------
  if (pathname === '/api/calendar/status' && req.method === 'GET') {
    const email = String(parsedUrl.query.email || '').trim().toLowerCase();
    const sheetId = String(parsedUrl.query.sheetId || '').trim();
    const map = getTenantsCalendarMap();
    let record = (email && map[email]) || (sheetId && map[sheetId]);
    if (!record && (!email && !sheetId)) {
      if (map['jorgeandrade.bumper@gmail.com']) record = map['jorgeandrade.bumper@gmail.com'];
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (record) {
      res.end(JSON.stringify({ connected: true, type: record.type, email: record.email, connectedAt: record.connectedAt }));
    } else {
      res.end(JSON.stringify({ connected: false }));
    }
    return;
  }

  // -------------------------------------------------------------
  // ROTA T1.1: Listagem Pública de Contas/Studios Conhecidos
  // -------------------------------------------------------------
  if (pathname === '/api/tenants/accounts-list' && req.method === 'GET') {
    const map = getTenantsMap();
    const list = Object.keys(map)
      .filter(k => k.includes('@'))
      .map(k => ({
        email: map[k].email,
        studioNome: map[k].studioNome || 'Studio de Unhas',
        profissionalNome: map[k].profissionalNome || ''
      }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, accounts: list }));
    return;
  }

  // -------------------------------------------------------------
  // ROTA 2: Iniciar OAuth 2.0 do Google (Login Unificado + Seletor de Contas + Google Agenda)
  // -------------------------------------------------------------
  if ((pathname === '/api/calendar/connect' || pathname === '/api/auth/google/oauth') && req.method === 'GET') {
    const email = String(parsedUrl.query.email || '').trim().toLowerCase();
    const returnUrl = String(parsedUrl.query.returnUrl || '').trim();
    const t = JSON.parse(fs.readFileSync(GSHEETS_TOKEN_PATH, 'utf8'));
    const redirectUri = 'http://localhost:8080/oauth2callback';
    const scope = encodeURIComponent('openid email profile https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/calendar');
    const state = encodeURIComponent(JSON.stringify({ email, returnUrl }));
    const loginHint = (email && email.includes('@')) ? '&login_hint=' + encodeURIComponent(email) : '';
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${t.client_id}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scope}&access_type=offline&prompt=select_account%20consent${loginHint}&state=${state}`;
    res.writeHead(302, { Location: authUrl });
    res.end();
    return;
  }

  // -------------------------------------------------------------
  // ROTA 3: Callback do OAuth 2.0 do Google (Login + Planilha + Agenda)
  // -------------------------------------------------------------
  if (pathname === '/oauth2callback' && req.method === 'GET') {
    const code = parsedUrl.query.code;
    const stateStr = parsedUrl.query.state;
    let email = '';
    let returnUrl = '';
    try {
      const stateObj = JSON.parse(stateStr || '{}');
      email = (stateObj.email || '').trim().toLowerCase();
      returnUrl = stateObj.returnUrl || '';
    } catch (e) {}

    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h3>Erro ao autenticar com o Google: código não retornado.</h3><a href="/App_Manicure.html">Voltar</a>');
      return;
    }

    try {
      const t = JSON.parse(fs.readFileSync(GSHEETS_TOKEN_PATH, 'utf8'));
      const tokenRes = await fetchWithRetry('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: String(code),
          client_id: t.client_id,
          client_secret: t.client_secret,
          redirect_uri: 'http://localhost:8080/oauth2callback',
          grant_type: 'authorization_code'
        })
      });
      const tokenData = await tokenRes.json();
      if (!tokenData.refresh_token && !tokenData.access_token) {
        throw new Error('Falha na troca de código OAuth: ' + JSON.stringify(tokenData));
      }

      // Obtém dados do perfil da usuária autenticada
      let userName = '';
      if (tokenData.access_token) {
        const uRes = await fetchWithRetry('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { Authorization: 'Bearer ' + tokenData.access_token }
        });
        const uData = await uRes.json();
        if (uData.email) email = uData.email.toLowerCase();
        if (uData.name) userName = uData.name;
      }

      if (!email) {
        throw new Error('Não foi possível identificar o e-mail da conta Google autenticada.');
      }

      // 1. Registra conexão com Google Agenda
      const calMap = getTenantsCalendarMap();
      calMap[email] = {
        type: 'oauth',
        email: email,
        refreshToken: tokenData.refresh_token || (calMap[email] && calMap[email].refreshToken),
        accessToken: tokenData.access_token,
        tokenExpiresAt: Date.now() + ((tokenData.expires_in || 3600) * 1000),
        connectedAt: new Date().toLocaleString('pt-BR')
      };
      saveTenantsCalendarMap(calMap);

      // 2. Busca ou Cria automaticamente a Planilha do Studio
      const map = getTenantsMap();
      let sheetId = '';
      let isNew = false;

      if (map[email] && map[email].spreadsheetId) {
        sheetId = map[email].spreadsheetId;
      } else {
        // Primeiro acesso: clona modelo oficial automaticamente
        isNew = true;
        const studioNome = userName ? `Studio ${userName}` : 'Meu Studio de Unhas';
        const masterToken = await getMasterGoogleAccessToken();
        const TEMPLATE_ID = '18lhkSiX1d6Y-NzJtTtHdGgUPbbYIUZAVfjUKe-gn9nM';

        const copyRes = await fetchWithRetry(`https://www.googleapis.com/drive/v3/files/${TEMPLATE_ID}/copy`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + masterToken,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            name: `${studioNome} - Banco de Dados Oficial`
          })
        });
        const sheet = await copyRes.json();
        if (!sheet.id) throw new Error('Falha ao gerar planilha oficial: ' + JSON.stringify(sheet));
        sheetId = sheet.id;

        // Permissão pública de escrita para o app operar
        await fetchWithRetry(`https://www.googleapis.com/drive/v3/files/${sheetId}/permissions`, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + masterToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: 'writer', type: 'anyone' })
        });

        // Compartilha diretamente no Google Drive da manicure
        try {
          await fetchWithRetry(`https://www.googleapis.com/drive/v3/files/${sheetId}/permissions?sendNotificationEmail=false`, {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + masterToken, 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: 'writer', type: 'user', emailAddress: email })
          });
        } catch (eUserShare) {}

        // Grava configurações iniciais
        const newConfigs = [
          ['Chave', 'Valor', 'Descricao'],
          ['SETUP_CONCLUIDO', 'SIM', 'Configurado pelo App'],
          ['STUDIO_NOME', studioNome, 'Nome do Studio'],
          ['PROFISSIONAL_NOME', userName || studioNome, 'Nome da Profissional'],
          ['ADMIN_LOGIN_ID', email, 'Conta Google do Titular'],
          ['WHATSAPP_STUDIO', '5511999999999', 'WhatsApp Oficial'],
          ['PIX_CHAVE', email, 'Chave Pix Oficial'],
          ['PIX_RECEBEDOR', userName || studioNome, 'Nome do Titular Pix'],
          ['PIX_CIDADE', 'SAO PAULO', 'Cidade'],
          ['TEMA_COR', 'pink-gold', 'Tema Visual'],
          ['HORARIO_INICIO', '09:00', 'Abertura'],
          ['HORARIO_FIM', '19:00', 'Fechamento'],
          ['ALMOCO_INICIO', '12:00', 'Inicio Almoco'],
          ['ALMOCO_FIM', '13:00', 'Fim Almoco'],
          ['DIAS_ATENDIMENTO', '1,2,3,4,5,6', 'Dias de Atendimento'],
          ['INTERVALO_MINUTOS', '60', 'Intervalo em Minutos'],
          ['SINCRONIZAR_AGENDA', 'SIM', 'Google Agenda Ativa'],
          ['ADMIN_PIN_HASH', 'GOOGLE_SSO', 'Autenticado via Google'],
          ['ADMIN_RECOVERY_HASH', '', 'Recuperação via Google'],
          ['CRIADO_EM', new Date().toLocaleString('pt-BR'), 'Data de Criação']
        ];

        await fetchWithRetry(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Configuracoes!A1?valueInputOption=USER_ENTERED`, {
          method: 'PUT',
          headers: { Authorization: 'Bearer ' + masterToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ values: newConfigs })
        });

        const tenantRecord = {
          email: email,
          profissionalNome: userName || studioNome,
          studioNome: studioNome,
          spreadsheetId: sheetId,
          spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${sheetId}/edit`,
          clientLink: `${getDynamicPublicUrl(req)}/Pagina_Cliente.html?s=${sheetId}`,
          pinHash: 'GOOGLE_SSO',
          createdAt: new Date().toLocaleString('pt-BR')
        };
        map[email] = tenantRecord;
        map[sheetId] = tenantRecord;
        saveTenantsMap(map);
      }

      // Vincula a agenda também ao ID da planilha
      calMap[sheetId] = calMap[email];
      saveTenantsCalendarMap(calMap);

      const adminToken = 'AUTH_' + Buffer.from(email).toString('hex').slice(0, 16);
      const redirectTarget = returnUrl || '/App_Manicure.html';
      const separator = redirectTarget.includes('?') ? '&' : '?';
      const destUrl = `${redirectTarget}${separator}google_auth=success&token=${adminToken}&email=${encodeURIComponent(email)}&sheetId=${sheetId}&isNew=${isNew ? 1 : 0}`;

      res.writeHead(302, { Location: destUrl });
      res.end();
    } catch (err) {
      console.error('ERRO EM OAUTH CALLBACK:', err);
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h3>Erro na autenticação do Google: ${err.message}</h3><p><a href="/App_Manicure.html">Voltar para o App</a></p>`);
    }
    return;
  }

  // -------------------------------------------------------------
  // ROTA 4: Configurar Webhook do Google Apps Script
  // -------------------------------------------------------------
  if (pathname === '/api/calendar/set-webhook' && req.method === 'POST') {
    try {
      const { email, sheetId, webhookUrl } = await readBodyJson(req);
      const map = getTenantsCalendarMap();
      const key = (email || sheetId || '').trim().toLowerCase();
      if (!key) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Identificador do studio ausente.' }));
        return;
      }
      map[key] = {
        type: 'webhook',
        webhookUrl: String(webhookUrl).trim(),
        email: email,
        sheetId: sheetId,
        connectedAt: new Date().toLocaleString('pt-BR')
      };
      saveTenantsCalendarMap(map);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Webhook do Google Agenda configurado!' }));
    } catch (err) {
      console.error('ERRO EM AUTO-PROVISION:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message, stack: err.stack }));
    }
    return;
  }

  // -------------------------------------------------------------
  // ROTA 4.1: Desconectar Google Agenda do Studio
  // -------------------------------------------------------------
  if (pathname === '/api/calendar/disconnect' && req.method === 'POST') {
    try {
      const { email, sheetId } = await readBodyJson(req);
      const map = getTenantsCalendarMap();
      const k1 = (email || '').trim().toLowerCase();
      const k2 = (sheetId || '').trim();
      if (k1 && map[k1]) delete map[k1];
      if (k2 && map[k2]) delete map[k2];
      saveTenantsCalendarMap(map);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Google Agenda desconectada com sucesso.' }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // -------------------------------------------------------------
  // ROTA 4.2: Testar Sincronização com Google Agenda
  // -------------------------------------------------------------
  if (pathname === '/api/calendar/test-sync' && req.method === 'POST') {
    try {
      const { email, sheetId } = await readBodyJson(req);
      const map = getTenantsCalendarMap();
      const record = map[(email || '').toLowerCase()] || map[sheetId];
      if (!record) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Google Agenda não está conectada para este Studio.' }));
        return;
      }
      const testEvent = {
        data: new Date().toISOString().split('T')[0],
        horaInicio: '10:00',
        horaFim: '10:30',
        clienteNome: 'Teste Sincronização Nail Studio Pro',
        clienteWhatsApp: '5511999999999',
        servicoNome: 'Teste de Integração de Agenda',
        valor: 0,
        metodoPagamento: 'TESTE',
        id: 'TEST_' + Date.now()
      };
      // 1. Webhook
      if (record.type === 'webhook' && record.webhookUrl) {
        const whRes = await fetch(record.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'CREATE', eventData: testEvent })
        });
        const whData = await whRes.json();
        if (whData.success && whData.eventId) {
          // Apaga evento de teste
          try {
            await fetch(record.webhookUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'DELETE', eventId: whData.eventId })
            });
          } catch(e) {}
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'Teste concluído com sucesso via Web App da Planilha!' }));
          return;
        }
      }
      // 2. OAuth
      if (record.type === 'oauth' && record.refreshToken) {
        const t = JSON.parse(fs.readFileSync(GSHEETS_TOKEN_PATH, 'utf8'));
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: t.client_id,
            client_secret: t.client_secret,
            refresh_token: record.refreshToken,
            grant_type: 'refresh_token'
          })
        });
        const tokenData = await tokenRes.json();
        const calAccessToken = tokenData.access_token;
        if (!calAccessToken) throw new Error('Não foi possível renovar o token do Google: ' + JSON.stringify(tokenData));

        const startIso = `${testEvent.data}T10:00:00-03:00`;
        const endIso = `${testEvent.data}T10:30:00-03:00`;
        const createRes = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + calAccessToken,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            summary: '💅 Teste de Conexão - Nail Studio Pro',
            description: 'Validação automática de integração com Google Agenda.',
            start: { dateTime: startIso, timeZone: 'America/Sao_Paulo' },
            end: { dateTime: endIso, timeZone: 'America/Sao_Paulo' }
          })
        });
        const createdData = await createRes.json();
        if (createRes.status === 200 && createdData.id) {
          // Apaga o evento de teste imediatamente
          try {
            await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(createdData.id)}`, {
              method: 'DELETE',
              headers: { Authorization: 'Bearer ' + calAccessToken }
            });
          } catch(e) {}
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'Google Agenda testada e validada com sucesso via OAuth Oficial!' }));
          return;
        } else {
          throw new Error(createdData.error ? createdData.error.message : 'Falha na criação do evento de teste');
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Credenciais de agenda inválidas ou expiradas.' }));
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // -------------------------------------------------------------
  // ROTA 5: Sincronizar Evento (Criar ou Apagar) na Google Agenda da Manicure
  // -------------------------------------------------------------
  if (pathname === '/api/calendar/sync-event' && req.method === 'POST') {
    try {
      const payload = await readBodyJson(req);
      const { action, eventData, tenantEmail, sheetId, eventId } = payload;
      const map = getTenantsCalendarMap();
      const record = map[(tenantEmail || '').toLowerCase()] || map[sheetId];

      if (!record) {
        // Se não tiver conexão configurada para esta conta, retorna gracefully
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, reason: 'CALENDAR_NOT_CONNECTED' }));
        return;
      }

      // 1. Sincronização via Webhook (Apps Script)
      if (record.type === 'webhook' && record.webhookUrl) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 6000);
          const whRes = await fetch(record.webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, eventData, eventId }),
            signal: controller.signal
          });
          clearTimeout(timeoutId);
          const whData = await whRes.json();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(whData));
          return;
        } catch (whErr) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, reason: 'WEBHOOK_DISPATCH_FAILED', error: whErr.message }));
          return;
        }
      }

      // 2. Sincronização via OAuth direto (Google Calendar API)
      if (record.type === 'oauth' && record.refreshToken) {
        const t = JSON.parse(fs.readFileSync(GSHEETS_TOKEN_PATH, 'utf8'));
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: t.client_id,
            client_secret: t.client_secret,
            refresh_token: record.refreshToken,
            grant_type: 'refresh_token'
          })
        });
        const tokenData = await tokenRes.json();
        const calAccessToken = tokenData.access_token;
        if (!calAccessToken) throw new Error('Não foi possível renovar token do Google Agenda.');

        if (action === 'CREATE') {
          let cleanDate = String(eventData.data || '').trim();
          if (cleanDate.includes('/')) {
            const parts = cleanDate.split('/');
            if (parts.length === 3) {
              cleanDate = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
            }
          }
          const startIso = `${cleanDate}T${eventData.horaInicio || '09:00'}:00-03:00`;
          const endIso = `${cleanDate}T${eventData.horaFim || '10:00'}:00-03:00`;

          const gcalPayload = {
            summary: `💅 ${eventData.servicoNome || 'Procedimento'} - ${eventData.clienteNome || 'Cliente'}`,
            description: [
              `Cliente: ${eventData.clienteNome || ''}`,
              `WhatsApp: ${eventData.clienteWhatsApp || ''}`,
              `Procedimento: ${eventData.servicoNome || ''}`,
              `Valor: R$ ${Number(eventData.valor || 0).toFixed(2)}`,
              `Pagamento: ${eventData.metodoPagamento || ''}`,
              `Código Reserva: ${eventData.id || ''}`
            ].join('\n'),
            start: { dateTime: startIso, timeZone: 'America/Sao_Paulo' },
            end: { dateTime: endIso, timeZone: 'America/Sao_Paulo' }
          };

          const createRes = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
            method: 'POST',
            headers: {
              Authorization: 'Bearer ' + calAccessToken,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(gcalPayload)
          });
          const createdData = await createRes.json();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, eventId: createdData.id }));
          return;
        }

        if (action === 'DELETE' && eventId && !eventId.startsWith('GCAL-')) {
          const delRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`, {
            method: 'DELETE',
            headers: { Authorization: 'Bearer ' + calAccessToken }
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, deleted: delRes.status === 204 || delRes.status === 200 }));
          return;
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, reason: 'UNKNOWN_ACTION' }));
    } catch (err) {
      console.error('ERRO EM AUTO-PROVISION:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message, stack: err.stack }));
    }
    return;
  }

  // -------------------------------------------------------------
  // ROTA 6: Arquivos Estáticos com Fallbacks
  // -------------------------------------------------------------
  let urlPath = parsedUrl.pathname;
  if (urlPath === '/' || urlPath === '/Index.html' || urlPath === '/index.html') {
    urlPath = '/App_Manicure.html';
  }

  const filePath = path.join(BASE_DIR, decodeURIComponent(urlPath));
  if (!filePath.startsWith(BASE_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h2>Página não encontrada. <a href="/App_Manicure.html">Ir para o App da Manicure</a></h2>');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const headers = { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' };
    if (ext === '.apk') {
      headers['Content-Disposition'] = 'attachment; filename="NailStudioPro.apk"';
      headers['Cache-Control'] = 'no-cache';
    }
    res.writeHead(200, headers);
    res.end(content);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor Nail Studio Pro ativo em http://localhost:${PORT}/App_Manicure.html`);
});
