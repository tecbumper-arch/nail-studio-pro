// Google Agenda no servidor (porta de syncGoogleCalendarCloudDirect e das ações gcal do painel).
// Credenciais ficam na aba Configuracoes do studio: GCAL_REFRESH_TOKEN (OAuth) ou GCAL_WEBHOOK_URL.
// Assinatura: syncCalendar(ctx, action, booking?, eventId?) — o studio vem de ctx.session.sid (painel)
// ou ctx.sid (página da cliente).
import { UserError } from './errors.js';
import { loadStudio } from './studio.js';
import { saoPauloNow, fromMin } from './util.js';

const TZ = 'America/Sao_Paulo';
const HOOK_PREFIX = 'https://script.google.com/';
const sidOf = (ctx) => (ctx.session && ctx.session.sid) || ctx.sid;
const isHook = (u) => String(u || '').startsWith(HOOK_PREFIX);

// Placeholders (GCAL-...) e ids já apagados (DELETED_...) não existem na Agenda.
export function isRealEventId(id) {
  const s = String(id || '');
  return !!s && !s.startsWith('GCAL-') && !s.startsWith('DELETED_');
}

async function readConfig(ctx, sid) {
  const { cfgMap } = await loadStudio(ctx.g, sid, ctx.origin);
  const v = (k) => String(cfgMap[k] || '').trim();
  return {
    refreshToken: v('GCAL_REFRESH_TOKEN'),
    webhookUrl: v('GCAL_WEBHOOK_URL'),
    connectedEmail: v('GCAL_CONNECTED_EMAIL') || v('ADMIN_LOGIN_ID'),
  };
}

async function upsertConfig(ctx, sid, updates) {
  const rows = await ctx.g.readTab(sid, 'Configuracoes');
  const out = rows.length ? rows.map((r) => [...r]) : [['Chave', 'Valor', 'Descricao']];
  for (const [k, val] of Object.entries(updates)) {
    const row = out.slice(1).find((r) => r && String(r[0]).trim() === k);
    if (row) row[1] = val;
    else out.push([k, val, 'Configuração Cloud Direct']);
  }
  await ctx.g.writeTab(sid, 'Configuracoes', out);
}

function buildEvent(b) {
  const date = String(b.data || '').includes('/') ? b.data.split('/').reverse().join('-') : b.data;
  const at = (t) => `${date}T${t}:00`;
  const nome = b.servicoNome || 'Procedimento';
  const cli = b.clienteNome || 'Cliente';
  return {
    summary: `💅 ${nome} - ${cli}`,
    description: [
      'Reserva confirmada via Nail Studio Pro',
      'Cliente: ' + (b.clienteNome || ''),
      'WhatsApp: ' + (b.clienteWhatsApp || ''),
      'Procedimento: ' + (b.servicoNome || ''),
      'Valor: R$ ' + Number(b.valor || 0).toFixed(2),
      'Código: ' + (b.id || ''),
    ].join('\n'),
    start: { dateTime: at(b.horaInicio || '09:00'), timeZone: TZ },
    end: { dateTime: at(b.horaFim || '10:00'), timeZone: TZ },
  };
}

// CREATE -> { eventId }; DELETE -> {}; qualquer falha ou studio sem agenda -> null. Nunca lança.
export async function syncCalendar(ctx, action, booking = null, eventId = null) {
  try {
    const cfg = await readConfig(ctx, sidOf(ctx));
    const wantsDelete = action === 'DELETE' && isRealEventId(eventId);
    if (action === 'CREATE' ? !booking : !wantsDelete) return null;

    if (cfg.refreshToken) {
      try {
        const token = await ctx.g.calendarAccessToken(cfg.refreshToken);
        if (action === 'CREATE') return { eventId: await ctx.g.createCalendarEvent(token, buildEvent(booking)) };
        await ctx.g.deleteCalendarEvent(token, eventId);
        return {};
      } catch (e) {
        console.warn('Agenda (OAuth) falhou:', e && e.name, e && e.status);
        // como no app original, tenta o webhook se houver
      }
    }
    if (isHook(cfg.webhookUrl)) {
      const data = await ctx.g.postWebhook(cfg.webhookUrl, { action, eventData: booking, eventId });
      if (data && data.success) {
        if (action === 'CREATE') return data.eventId ? { eventId: String(data.eventId) } : null;
        return {};
      }
    }
  } catch (e) {
    console.warn('Agenda falhou:', e && e.name, e && e.status);
  }
  return null;
}

export const calendarHandlers = {
  async adminGetGcalStatus(ctx) {
    const cfg = await readConfig(ctx, ctx.session.sid);
    const mode = cfg.refreshToken ? 'oauth' : isHook(cfg.webhookUrl) ? 'webhook' : '';
    return { connected: !!mode, mode, connectedEmail: mode ? cfg.connectedEmail : '' };
  },

  async adminTestGcal(ctx) {
    const now = saoPauloNow(ctx.now ? new Date(ctx.now) : new Date());
    const res = await syncCalendar(ctx, 'CREATE', {
      id: 'TESTE-' + Math.floor(1000 + Math.random() * 9000),
      data: now.isoDate,
      horaInicio: fromMin(now.minutes),
      horaFim: fromMin(Math.min(now.minutes + 30, 1439)),
      clienteNome: 'Teste de Conexão (Nail Studio Pro)',
      clienteWhatsApp: '5511999999999',
      servicoNome: 'Validação Automática de Agenda',
      valor: 0,
    });
    if (!res || !res.eventId) return { success: false };
    const del = await syncCalendar(ctx, 'DELETE', null, res.eventId);
    return { success: !!del };
  },

  async adminDisconnectGcal(ctx) {
    await upsertConfig(ctx, ctx.session.sid, { GCAL_REFRESH_TOKEN: '', GCAL_CONNECTED_EMAIL: '', GCAL_WEBHOOK_URL: '' });
    return { success: true };
  },

  async adminSaveGcalWebhook(ctx, p) {
    const webhookUrl = String((p && p.webhookUrl) || '').trim();
    if (!isHook(webhookUrl)) {
      throw new UserError('Informe uma URL válida do Web App do Google Apps Script (iniciando com https://script.google.com/)');
    }
    await upsertConfig(ctx, ctx.session.sid, { GCAL_WEBHOOK_URL: webhookUrl });
    return { success: true };
  },
};
