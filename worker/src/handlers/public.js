// Funções públicas da página da cliente (sem login). Portadas de Pagina_Cliente.html rpc().
import { UserError } from '../errors.js';
import { normalizeBrPhone, toMin, fromMin, newId, saoPauloNow, sanitizeCell } from '../util.js';
import { buildPixBrCode } from '../pix.js';
import {
  loadStudio, publicStudio, assertKnownStudio, readCategorias, readCatalogo, readAgendamentos,
} from '../studio.js';
import { syncCalendar, isRealEventId } from '../calendar.js';

const PAYMENT_METHODS = ['NO_LOCAL', 'PIX_TOTAL', 'PIX_SINAL_50'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function currentNow(ctx) {
  const n = ctx.now ? new Date(ctx.now) : new Date();
  return saoPauloNow(n);
}

function waPhone(p) { return '55' + normalizeBrPhone(p); }

function computeSlots(studio, agRows, dateStr, duracaoSrv, nowInfo) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dayOfWeek = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const allowedDays = String(studio.diasAtendimento || '1,2,3,4,5,6').split(',').map((x) => Number(x.trim()));
  if (!allowedDays.includes(dayOfWeek)) return [];
  const duracao = duracaoSrv || studio.intervaloMinutos;

  const busy = [];
  for (let i = 1; i < agRows.length; i++) {
    const r = agRows[i];
    if (r && r[1] === dateStr && String(r[11] || '').toUpperCase() !== 'CANCELADO') {
      busy.push({ s: toMin(r[2]), e: toMin(r[3]) });
    }
  }
  if (studio.almocoInicio && studio.almocoFim) {
    const almS = toMin(studio.almocoInicio);
    const almE = toMin(studio.almocoFim);
    if (almE > almS) busy.push({ s: almS, e: almE });
  }

  const nowMinutes = nowInfo.minutes + 15;
  const startM = toMin(studio.horarioInicio);
  const endM = toMin(studio.horarioFim);
  const step = studio.intervaloMinutos || 60;
  const slots = [];
  for (let t = startM; t + duracao <= endM; t += step) {
    const isPastToday = dateStr === nowInfo.isoDate && t < nowMinutes;
    const col = isPastToday || busy.some((b) => t < b.e && t + duracao > b.s);
    slots.push({
      horaInicio: fromMin(t),
      horaFim: fromMin(t + duracao),
      disponivel: !col,
      motivo: isPastToday ? 'PASSOU' : (col ? 'OCUPADO' : 'LIVRE'),
    });
  }
  return slots;
}

async function slotsFor(ctx, studio, dateStr, srvId) {
  if (!DATE_RE.test(String(dateStr))) throw new UserError('Data inválida.');
  const catalogo = await readCatalogo(ctx.g, ctx.sid);
  const srv = catalogo.find((s) => s.id === srvId);
  const agRows = await readAgendamentos(ctx.g, ctx.sid);
  return computeSlots(studio, agRows, dateStr, srv ? srv.duracaoMin : 0, currentNow(ctx));
}

async function known(ctx) {
  await assertKnownStudio(ctx.g, ctx.env, ctx.sid);
  return (await loadStudio(ctx.g, ctx.sid, ctx.origin)).studio;
}

const pixFor = (studio, valor, id) =>
  buildPixBrCode(studio.pixChave || '00000000000', studio.pixRecebedor, studio.pixCidade, valor, id);

export const publicHandlers = {
  async getPublicBootstrapData(ctx) {
    const studio = await known(ctx);
    const categorias = (await readCategorias(ctx.g, ctx.sid)).filter((c) => c.ativo);
    const catalogo = (await readCatalogo(ctx.g, ctx.sid)).filter((s) => s.ativo);
    return { studio: publicStudio(studio), categorias, catalogo };
  },

  async getAvailableSlotsForDate(ctx, dateStr, srvId) {
    const studio = await known(ctx);
    return slotsFor(ctx, studio, dateStr, srvId);
  },

  async createCustomerBooking(ctx, p) {
    const studio = await known(ctx);
    p = p || {};
    const metodo = String(p.metodoPagamento || '');
    if (!p.data || !p.horaInicio || !p.servicoId) throw new UserError('Dados da reserva incompletos.');
    if (!PAYMENT_METHODS.includes(metodo)) throw new UserError('Forma de pagamento inválida.');
    const nome = String(p.clienteNome || '').trim();
    if (nome.length < 2 || nome.length > 80) throw new UserError('Informe seu nome (2 a 80 caracteres).');
    const phoneLocal = normalizeBrPhone(p.clienteWhatsApp);
    if (phoneLocal.length < 10 || phoneLocal.length > 11) throw new UserError('Informe um WhatsApp válido com DDD.');

    const catalogo = await readCatalogo(ctx.g, ctx.sid);
    const srv = catalogo.find((s) => s.id === p.servicoId);
    if (!srv) throw new UserError('Procedimento não encontrado.');

    // Releitura fresca da agenda imediatamente antes de gravar.
    const slots = await slotsFor(ctx, studio, p.data, p.servicoId);
    const slot = slots.find((s) => s.horaInicio === p.horaInicio);
    if (!slot || !slot.disponivel) throw new UserError('Horário indisponível: este horário acabou de ser preenchido! Escolha outro horário.');

    const id = newId('AG');
    const isPix = metodo.includes('PIX');
    const statusPag = isPix ? 'AGUARDANDO_VALIDACAO_PIX' : 'PAGAR_NO_STUDIO';
    const nowStr = new Date(ctx.now || Date.now()).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const phone = waPhone(p.clienteWhatsApp);

    // O id do evento vai para a planilha, então esperamos a Agenda; falha nunca bloqueia a reserva.
    const sync = await syncCalendar(ctx, 'CREATE', {
      id, data: p.data, horaInicio: p.horaInicio, horaFim: slot.horaFim,
      clienteNome: nome, clienteWhatsApp: phone,
      servicoNome: srv.nome, valor: srv.preco, metodoPagamento: metodo,
    });
    const calendarEventId = (sync && sync.eventId) || 'GCAL-' + id;

    await ctx.g.appendRow(ctx.sid, 'Agendamentos', [
      id, p.data, p.horaInicio, slot.horaFim, sanitizeCell(nome), phone,
      srv.id, srv.nome, srv.preco, metodo, statusPag, 'RESERVADO', calendarEventId, nowStr,
    ]);

    const valorCobradoAgora = metodo === 'PIX_SINAL_50' ? srv.preco / 2 : srv.preco;
    return {
      success: true,
      reserva: {
        id, data: p.data, horaInicio: p.horaInicio, horaFim: slot.horaFim,
        clienteNome: nome, servicoNome: srv.nome,
        valorTotal: srv.preco, valorCobradoAgora,
        metodoPagamento: metodo, statusPagamento: statusPag,
        pixCopiaECola: pixFor(studio, valorCobradoAgora, id), whatsappStudio: studio.whatsapp,
      },
    };
  },

  async getClientBookingsByPhone(ctx, rawPhone) {
    const studio = await known(ctx);
    const phone = normalizeBrPhone(rawPhone);
    if (!phone || phone.length < 10) return [];
    const last8 = phone.slice(-8);
    const agRows = await readAgendamentos(ctx.g, ctx.sid);
    const found = [];
    for (let i = 1; i < agRows.length; i++) {
      const r = agRows[i];
      if (!r || !r[0] || String(r[11] || '').toUpperCase() === 'BLOQUEADO') continue;
      const rowPhone = normalizeBrPhone(r[5] || '');
      if (!rowPhone || rowPhone.slice(-8) !== last8) continue;
      const valorTotal = Number(r[8] || 0);
      const metodo = r[9] || 'NO_LOCAL';
      const valorCobradoAgora = metodo === 'PIX_SINAL_50' ? valorTotal / 2 : valorTotal;
      found.push({
        id: r[0], data: r[1] || '', horaInicio: r[2] || '', horaFim: r[3] || '',
        clienteNome: r[4] || '', clienteWhatsApp: r[5] || '',
        servicoId: r[6] || '', servicoNome: r[7] || '',
        valorTotal, valorCobradoAgora,
        metodoPagamento: metodo, statusPagamento: r[10] || '', statusReserva: r[11] || 'RESERVADO',
        pixCopiaECola: metodo.includes('PIX') ? pixFor(studio, valorCobradoAgora, r[0]) : '',
        whatsappStudio: studio.whatsapp,
      });
    }
    return found.sort((a, b) => (b.data + b.horaInicio).localeCompare(a.data + a.horaInicio));
  },

  async cancelCustomerBooking(ctx, reservaId, phone) {
    await known(ctx);
    const clean = normalizeBrPhone(phone);
    // Telefone obrigatório: sem ele qualquer um cancelaria qualquer reserva.
    if (clean.length < 10) throw new UserError('Informe o WhatsApp usado na reserva.');
    const last8 = clean.slice(-8);
    const agRows = await readAgendamentos(ctx.g, ctx.sid);
    for (let i = 1; i < agRows.length; i++) {
      const row = agRows[i];
      if (row && row[0] === reservaId && normalizeBrPhone(row[5] || '').slice(-8) === last8) {
        row[11] = 'CANCELADO';
        const calId = row[12];
        // Só marca depois de a Agenda confirmar; se falhar, o id fica para nova tentativa.
        if (isRealEventId(calId) && (await syncCalendar(ctx, 'DELETE', null, calId))) row[12] = 'DELETED_' + calId;
        await ctx.g.writeTab(ctx.sid, 'Agendamentos', agRows);
        return { success: true };
      }
    }
    throw new UserError('Reserva não localizada.');
  },

  async notifyPixPaidByCustomer(ctx, reservaId) {
    await known(ctx);
    const agRows = await readAgendamentos(ctx.g, ctx.sid);
    for (let i = 1; i < agRows.length; i++) {
      if (agRows[i] && agRows[i][0] === reservaId) {
        agRows[i][10] = 'CLIENTE_INFORMOU_PIX';
        await ctx.g.writeTab(ctx.sid, 'Agendamentos', agRows);
        break;
      }
    }
    return { success: true };
  },
};
