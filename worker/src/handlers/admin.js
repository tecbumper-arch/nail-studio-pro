// Funções do painel da manicure. Portadas de App_Manicure.html rpc() (ramos admin*).
// Sempre usam ctx.session.sid (do token); nenhum sid/token vindo dos argumentos é considerado.
import { UserError } from '../errors.js';
import { normalizeBrPhone, toMin, fromMin, newId, sanitizeCell } from '../util.js';
import {
  loadStudio, publicStudio, readCategorias, readCatalogo, readAgendamentos, syncCalendar,
} from '../studio.js';

const CAT_HEAD = ['ID', 'Nome', 'Icone', 'Ordem', 'Ativo'];
const SRV_HEAD = ['ID', 'Nome', 'Descricao', 'Preco', 'DuracaoMin', 'FotoUrl', 'Categoria', 'Ativo'];
const sidOf = (ctx) => ctx.session.sid;
const s = sanitizeCell;
// Handles como "@ana" são legítimos; só neutraliza fórmulas reais.
const noFormula = (v) => (/^[=+\-]/.test(String(v)) ? "'" + v : v);

async function dashboard(ctx) {
  const sid = sidOf(ctx);
  const { studio } = await loadStudio(ctx.g, sid, ctx.origin);
  const categorias = await readCategorias(ctx.g, sid);
  const catalogo = await readCatalogo(ctx.g, sid);
  const agRows = await readAgendamentos(ctx.g, sid);
  const agendamentos = [];
  for (let i = 1; i < agRows.length; i++) {
    const r = agRows[i];
    if (r && r[0]) {
      agendamentos.push({
        id: r[0], data: r[1] || '', horaInicio: r[2] || '', horaFim: r[3] || '',
        clienteNome: r[4] || '', clienteWhatsApp: r[5] || '',
        servicoId: r[6] || '', servicoNome: r[7] || '', valor: Number(r[8] || 0),
        metodoPagamento: r[9] || '', statusPagamento: r[10] || '', statusReserva: r[11] || '',
        criadoEm: r[13] || '',
      });
    }
  }
  agendamentos.sort((a, b) => (b.data + b.horaInicio).localeCompare(a.data + a.horaInicio));
  return {
    studio: { ...publicStudio(studio), spreadsheetUrl: studio.spreadsheetUrl, loginId: studio.loginId },
    categorias, catalogo, agendamentos,
  };
}

const catRow = (c) => [c.id, c.nome, c.icone, String(c.ordem), c.ativo ? 'SIM' : 'NAO'];

export const adminHandlers = {
  getAdminDashboardData: (ctx) => dashboard(ctx),

  async adminSaveCategory(ctx, catObj) {
    const sid = sidOf(ctx);
    const nome = String((catObj && catObj.nome) || '').trim();
    if (!nome) throw new UserError('Informe o nome da categoria.');
    const current = await readCategorias(ctx.g, sid);
    const rows = [CAT_HEAD];
    let updated = false;
    let oldName = null;
    for (const c of current) {
      if (catObj.id && c.id === catObj.id) {
        oldName = c.nome;
        rows.push([c.id, s(nome), s(catObj.icone || '💅'), String(catObj.ordem || c.ordem || rows.length), catObj.ativo === false ? 'NAO' : 'SIM']);
        updated = true;
      } else {
        rows.push(catRow(c));
      }
    }
    if (!updated) {
      rows.push([newId('CAT'), s(nome), s(catObj.icone || '💅'), String(catObj.ordem || rows.length), 'SIM']);
    }
    await ctx.g.writeTab(sid, 'Categorias', rows);
    if (oldName && oldName !== nome) {
      const sRows = await ctx.g.readTab(sid, 'Catalogo');
      let changed = false;
      for (let i = 1; i < sRows.length; i++) {
        if (sRows[i] && sRows[i][6] === oldName) { sRows[i][6] = s(nome); changed = true; }
      }
      if (changed) await ctx.g.writeTab(sid, 'Catalogo', sRows);
    }
    return dashboard(ctx);
  },

  async adminDeleteCategory(ctx, catId) {
    const sid = sidOf(ctx);
    const current = await readCategorias(ctx.g, sid);
    const rows = [CAT_HEAD, ...current.filter((c) => c.id !== catId).map(catRow)];
    await ctx.g.writeTab(sid, 'Categorias', rows);
    return dashboard(ctx);
  },

  async adminSeedDefaultCatalog(ctx) {
    const photo = (id) => `https://images.unsplash.com/${id}?auto=format&fit=crop&w=400&q=80`;
    const rows = [
      SRV_HEAD,
      ['SRV-101', 'Alongamento em Fibra de Vidro', 'Alongamento resistente com acabamento natural, curvatura perfeita e esmaltação em gel inclusa.', '160', '120', photo('photo-1604654894610-df63bc536371'), 'Alongamentos', 'SIM'],
      ['SRV-102', 'Manutenção de Alongamento', 'Manutenção completa (até 21 dias), nivelamento, cuticulagem e nova esmaltação.', '110', '90', photo('photo-1519014816548-bf5fe059798b'), 'Alongamentos', 'SIM'],
      ['SRV-103', 'Banho de Gel / Blindagem', 'Camada protetora de gel sobre a unha natural para maior durabilidade e brilho intenso.', '90', '60', photo('photo-1632345031435-8727f6897d53'), 'Blindagem & Banho de Gel', 'SIM'],
      ['SRV-104', 'Pé e Mão Tradicional Completo', 'Cuticulagem funda, hidratação e esmaltação tradicional completa (mãos e pés).', '70', '60', photo('photo-1522337360788-8b13dee7a37e'), 'Manicure & Pedicure', 'SIM'],
    ];
    await ctx.g.writeTab(sidOf(ctx), 'Catalogo', rows);
    return dashboard(ctx);
  },

  async adminSaveService(ctx, obj) {
    const sid = sidOf(ctx);
    if (!obj || !String(obj.nome || '').trim()) throw new UserError('Informe o nome do serviço.');
    const rows = await ctx.g.readTab(sid, 'Catalogo');
    const out = [SRV_HEAD];
    const ativo = obj.ativo === false ? 'NAO' : 'SIM';
    const fields = (id) => [id, s(obj.nome), s(obj.descricao ?? ''), obj.preco, obj.duracaoMin, s(obj.fotoUrl ?? ''), s(obj.categoria ?? ''), ativo];
    let updated = false;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (r && r[0]) {
        if (obj.id && r[0] === obj.id) { out.push(fields(obj.id)); updated = true; } else out.push(r);
      }
    }
    if (!updated) out.push(fields(newId('SRV')));
    await ctx.g.writeTab(sid, 'Catalogo', out);
    return dashboard(ctx);
  },

  async adminToggleServiceActive(ctx, srvId) {
    const sid = sidOf(ctx);
    const rows = await ctx.g.readTab(sid, 'Catalogo');
    for (let i = 1; i < rows.length; i++) {
      if (rows[i] && rows[i][0] === srvId) {
        rows[i][7] = String(rows[i][7] || 'SIM').toUpperCase() === 'SIM' ? 'NAO' : 'SIM';
        break;
      }
    }
    await ctx.g.writeTab(sid, 'Catalogo', rows);
    return dashboard(ctx);
  },

  async adminDeleteService(ctx, id) {
    const sid = sidOf(ctx);
    const rows = await ctx.g.readTab(sid, 'Catalogo');
    const out = [SRV_HEAD];
    for (let i = 1; i < rows.length; i++) {
      if (rows[i] && rows[i][0] && rows[i][0] !== id) out.push(rows[i]);
    }
    await ctx.g.writeTab(sid, 'Catalogo', out);
    return dashboard(ctx);
  },

  async adminUpdateBookingStatus(ctx, id, action) {
    const sid = sidOf(ctx);
    const rows = await readAgendamentos(ctx.g, sid);
    for (let i = 1; i < rows.length; i++) {
      if (rows[i] && rows[i][0] === id) {
        if (action === 'VALIDAR_PIX') {
          rows[i][10] = 'PIX_CONFIRMADO';
          rows[i][11] = 'CONFIRMADO';
        } else if (action === 'CONCLUIR_ATENDIMENTO') {
          rows[i][10] = rows[i][10] === 'AGUARDANDO_VALIDACAO_PIX' ? 'PIX_CONFIRMADO' : 'PAGO_NO_STUDIO';
          rows[i][11] = 'CONCLUIDO';
        } else if (action === 'CANCELAR_RESERVA') {
          rows[i][11] = 'CANCELADO';
          const calId = rows[i][12];
          if (calId && !String(calId).startsWith('DELETED_')) {
            try {
              await syncCalendar(ctx, 'DELETE', null, calId);
              rows[i][12] = 'DELETED_' + calId;
            } catch (e) {}
          }
        }
        await ctx.g.writeTab(sid, 'Agendamentos', rows);
        break;
      }
    }
    return dashboard(ctx);
  },

  async adminCreateManualBookingOrBlock(ctx, p) {
    const sid = sidOf(ctx);
    const isBlock = p && p.tipo === 'BLOQUEIO';
    const id = newId(isBlock ? 'BLQ' : 'AG');
    const nowStr = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    if (isBlock) {
      await ctx.g.appendRow(sid, 'Agendamentos', [
        id, p.data, p.horaInicio, p.horaFim,
        '🔒 BLOQUEIO DE AGENDA / FOLGA', '',
        'BLOQUEIO', s(p.motivo || 'Horário Bloqueado pela Profissional'), 0, 'BLOQUEIO',
        'BLOQUEADO', 'BLOQUEADO', 'GCAL-' + id, nowStr,
      ]);
    } else {
      const fimMin = toMin(p.horaInicio) + Number(p.duracaoMin || 60);
      await ctx.g.appendRow(sid, 'Agendamentos', [
        id, p.data, p.horaInicio, fromMin(fimMin),
        s(p.clienteNome), normalizeBrPhone(p.clienteWhatsApp),
        p.servicoId || 'MANUAL', s(p.servicoNome), Number(p.valor || 0), p.metodoPagamento || 'NO_LOCAL',
        p.statusPagamento || 'PAGAR_NO_STUDIO', 'CONFIRMADO', 'GCAL-' + id, nowStr,
      ]);
    }
    return dashboard(ctx);
  },

  async adminSaveSettings(ctx, cfg = {}) {
    const sid = sidOf(ctx);
    const { cfgMap } = await loadStudio(ctx.g, sid, ctx.origin);
    // novoPin / novaPalavraRecuperacao são ignorados; chaves secretas vêm sempre do cfgMap atual.
    const keep = (k) => cfgMap[k] || '';
    const ig = cfg.instagram !== undefined ? cfg.instagram : keep('INSTAGRAM_STUDIO');
    const end = cfg.endereco !== undefined ? cfg.endereco : keep('ENDERECO_STUDIO');
    const rows = [
      ['Chave', 'Valor', 'Descricao'],
      ['SETUP_CONCLUIDO', 'SIM', 'Configurado pelo App'],
      ['STUDIO_NOME', s(cfg.nome || 'Meu Studio'), 'Nome do Studio'],
      ['PROFISSIONAL_NOME', s(cfg.profissional || 'Manicure'), 'Profissional'],
      ['ADMIN_LOGIN_ID', keep('ADMIN_LOGIN_ID'), 'E-mail ou WhatsApp de Login'],
      ['WHATSAPP_STUDIO', normalizeBrPhone(cfg.whatsapp), 'WhatsApp'],
      ['PIX_CHAVE', s(cfg.pixChave || ''), 'Chave Pix'],
      ['PIX_RECEBEDOR', s(cfg.pixRecebedor || ''), 'Titular Pix'],
      ['PIX_CIDADE', s(cfg.pixCidade || 'SAO PAULO'), 'Cidade Pix'],
      ['TEMA_COR', s(cfg.temaCor || 'pink-gold'), 'Tema de Cores'],
      ['HORARIO_INICIO', cfg.horarioInicio || '09:00', 'Abertura'],
      ['HORARIO_FIM', cfg.horarioFim || '19:00', 'Fechamento'],
      ['ALMOCO_INICIO', cfg.almocoInicio || '', 'Início Almoço'],
      ['ALMOCO_FIM', cfg.almocoFim || '', 'Fim Almoço'],
      ['DIAS_ATENDIMENTO', cfg.diasAtendimento || '1,2,3,4,5,6', 'Dias de Funcionamento'],
      ['INTERVALO_MINUTOS', String(cfg.intervaloMinutos || 60), 'Intervalo'],
      ['SINCRONIZAR_AGENDA', 'SIM', 'Agenda'],
      ['ADMIN_PIN_HASH', keep('ADMIN_PIN_HASH'), 'Hash SHA-256 do PIN'],
      ['ADMIN_RECOVERY_HASH', keep('ADMIN_RECOVERY_HASH'), 'Hash SHA-256 de Recuperação'],
      ['INSTAGRAM_STUDIO', noFormula(ig), 'Instagram do Studio'],
      ['ENDERECO_STUDIO', noFormula(end), 'Endereço do Studio'],
      ['GCAL_REFRESH_TOKEN', keep('GCAL_REFRESH_TOKEN'), 'Token OAuth Google Calendar Cloud Direct'],
      ['GCAL_CONNECTED_EMAIL', keep('GCAL_CONNECTED_EMAIL'), 'E-mail conectado ao Google Calendar'],
      ['GCAL_WEBHOOK_URL', keep('GCAL_WEBHOOK_URL'), 'Webhook Apps Script Google Calendar'],
      ['TERMO_ACEITO_EM', cfgMap['TERMO_ACEITO_EM'] || new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }), 'Termo Aceito'],
    ];
    await ctx.g.writeTab(sid, 'Configuracoes', rows);
    return dashboard(ctx);
  },
};
