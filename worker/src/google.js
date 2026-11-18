// Cliente Google injetável (Sheets, Drive, Calendar, OAuth). Todo acesso ao Google passa por aqui.
import { GoogleError, AuthError, UserError } from './errors.js';

const REAL = {
  sheets: 'https://sheets.googleapis.com',
  api: 'https://www.googleapis.com',
  oauth: 'https://oauth2.googleapis.com',
};

// Cache do access token por (base, client, refresh token): instâncias com credenciais
// diferentes não vazam estado entre si. Testes podem chamar resetGoogleTokenCache().
const tokenCache = new Map();
export function resetGoogleTokenCache() {
  tokenCache.clear();
}

export function createGoogle(env, fetchImpl = fetch) {
  const base = env.GOOGLE_API_BASE ? String(env.GOOGLE_API_BASE).replace(/\/+$/, '') : null;
  const sheetsHost = base || REAL.sheets;
  const apiHost = base || REAL.api;
  const oauthHost = base || REAL.oauth;

  async function call(url, init) {
    let res;
    try {
      res = await fetchImpl(url, init);
    } catch (e) {
      throw new GoogleError('Falha de rede ao falar com o Google: ' + (e && e.message), 502);
    }
    return res;
  }

  async function ok(res, what) {
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 200); } catch (e) {}
      throw new GoogleError(`${what} falhou (HTTP ${res.status}) ${detail}`, res.status);
    }
    return res;
  }

  async function refreshAccessToken(refreshToken) {
    const body = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    const res = await call(`${oauthHost}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    await ok(res, 'Renovar token do Google');
    const data = await res.json();
    if (!data.access_token) throw new GoogleError('Resposta do Google sem access_token', 502);
    return data;
  }

  async function accessToken() {
    const key = `${base || ''}|${env.GOOGLE_CLIENT_ID}|${env.GOOGLE_REFRESH_TOKEN}`;
    const hit = tokenCache.get(key);
    if (hit && Date.now() < hit.expiresAt) return hit.token;
    const data = await refreshAccessToken(env.GOOGLE_REFRESH_TOKEN);
    tokenCache.set(key, {
      token: data.access_token,
      expiresAt: Date.now() + ((data.expires_in || 3600) - 60) * 1000,
    });
    return data.access_token;
  }

  async function authed(url, method, body) {
    const token = await accessToken();
    const headers = { Authorization: `Bearer ${token}` };
    const init = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return call(url, init);
  }

  const valuesUrl = (sid, tab, suffix) =>
    `${sheetsHost}/v4/spreadsheets/${encodeURIComponent(sid)}/values/${encodeURIComponent(tab)}${suffix}`;

  return {
    async readTab(sid, tab) {
      const res = await authed(valuesUrl(sid, tab, '!A1:Z500'), 'GET');
      // O Google responde 400 quando a aba não existe.
      if (res.status === 400) return [];
      await ok(res, 'Ler aba');
      const data = await res.json();
      return data.values || [];
    },

    async writeTab(sid, tab, rows) {
      await ok(await authed(valuesUrl(sid, tab, '!A1:Z500:clear'), 'POST'), 'Limpar aba');
      await ok(
        await authed(valuesUrl(sid, tab, '!A1?valueInputOption=USER_ENTERED'), 'PUT', { values: rows }),
        'Gravar aba'
      );
    },

    async appendRow(sid, tab, row) {
      await ok(
        await authed(
          valuesUrl(sid, tab, '!A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS'),
          'POST',
          { values: [row] }
        ),
        'Acrescentar linha'
      );
    },

    async createSpreadsheet(title, tabTitles) {
      const res = await ok(
        await authed(`${sheetsHost}/v4/spreadsheets`, 'POST', {
          properties: { title, locale: 'pt_BR' },
          sheets: tabTitles.map((t) => ({ properties: { title: t } })),
        }),
        'Criar planilha'
      );
      const data = await res.json();
      if (!data.spreadsheetId) throw new GoogleError('Planilha criada sem spreadsheetId', 502);
      return data.spreadsheetId;
    },

    // Mesma sequência do app atual: writer -> transferir propriedade -> proprietária pendente.
    async shareWithOwner(sid, email) {
      let status = 'COMPARTILHADA';
      const clean = String(email || '').trim().toLowerCase();
      if (!clean.includes('@')) return status;
      try {
        const msg = encodeURIComponent('Sua planilha do Studio foi criada! Ela é sua: aceite a propriedade quando o Google pedir.');
        const permRes = await authed(
          `${apiHost}/drive/v3/files/${encodeURIComponent(sid)}/permissions?sendNotificationEmail=true&emailMessage=${msg}`,
          'POST',
          { role: 'writer', type: 'user', emailAddress: clean }
        );
        const perm = permRes.ok ? await permRes.json() : null;
        if (perm && perm.id) {
          const permUrl = `${apiHost}/drive/v3/files/${encodeURIComponent(sid)}/permissions/${encodeURIComponent(perm.id)}`;
          const tr = await authed(`${permUrl}?transferOwnership=true`, 'PATCH', { role: 'owner' });
          if (tr.ok) {
            status = 'PROPRIETARIA';
          } else {
            const pend = await authed(permUrl, 'PATCH', { role: 'writer', pendingOwner: true });
            if (pend.ok) status = 'AGUARDANDO_ACEITE';
          }
        }
      } catch (e) {}
      return status;
    },

    async calendarAccessToken(refreshToken) {
      const data = await refreshAccessToken(refreshToken);
      return data.access_token;
    },

    async createCalendarEvent(token, event) {
      const res = await ok(
        await call(`${apiHost}/calendar/v3/calendars/primary/events`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(event),
        }),
        'Criar evento'
      );
      const data = await res.json();
      if (!data.id) throw new GoogleError('Evento criado sem id', 502);
      return data.id;
    },

    async deleteCalendarEvent(token, eventId) {
      const res = await call(`${apiHost}/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 404 || res.status === 410) return; // já removido
      await ok(res, 'Apagar evento');
    },

    // Web App do Apps Script do studio (só script.google.com; quem chama valida a URL).
    async postWebhook(url, payload) {
      const res = await ok(
        await call(url, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(payload),
        }),
        'Webhook da Agenda'
      );
      return res.json();
    },

    async exchangeCode(code, redirectUri) {
      const body = new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      });
      const res = await call(`${oauthHost}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      if (res.status === 400 || res.status === 401) throw new AuthError('Não foi possível entrar com o Google. Tente de novo.');
      await ok(res, 'Trocar código OAuth');
      return res.json();
    },

    async userEmail(token) {
      const res = await call(`${apiHost}/oauth2/v2/userinfo`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      await ok(res, 'Ler perfil do Google');
      const d = await res.json();
      const verified = d.verified_email === true || d.email_verified === true;
      if (!d.email || !verified) throw new UserError('O e-mail da conta Google não está verificado.');
      return { email: String(d.email).toLowerCase(), name: d.name || '' };
    },
  };
}
