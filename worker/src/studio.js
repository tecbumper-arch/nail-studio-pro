// Leitura do studio (Configuracoes, Categorias, Catalogo, Agendamentos) e validação de sid.
import { UserError } from './errors.js';

// Substituído pela Task 6 (sincronização com Google Calendar).
export const syncCalendar = async () => {};

const DEFAULT_CATEGORIAS = [
  { id: 'CAT-01', nome: 'Alongamentos', icone: '💅', ordem: 1, ativo: true },
  { id: 'CAT-02', nome: 'Manicure & Pedicure', icone: '✨', ordem: 2, ativo: true },
  { id: 'CAT-03', nome: 'Blindagem & Banho de Gel', icone: '💎', ordem: 3, ativo: true },
  { id: 'CAT-04', nome: 'Nail Art & Decoradas', icone: '🎨', ordem: 4, ativo: true },
  { id: 'CAT-05', nome: 'Spa dos Pés & Mãos', icone: '🌸', ordem: 5, ativo: true },
];

export async function loadStudio(g, sid, origin = '') {
  const cfgRows = await g.readTab(sid, 'Configuracoes');
  const cfgMap = {};
  for (let i = 1; i < cfgRows.length; i++) {
    if (cfgRows[i] && cfgRows[i][0]) cfgMap[String(cfgRows[i][0]).trim()] = cfgRows[i][1] || '';
  }
  const studio = {
    spreadsheetId: sid,
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${sid}/edit`,
    clientLink: `${origin}/Pagina_Cliente.html?s=${sid}`,
    setupConcluido: String(cfgMap['SETUP_CONCLUIDO'] || 'NAO').toUpperCase() === 'SIM',
    nome: cfgMap['STUDIO_NOME'] || 'Meu Studio de Unhas',
    profissional: cfgMap['PROFISSIONAL_NOME'] || 'Manicure & Nail Designer',
    loginId: cfgMap['ADMIN_LOGIN_ID'] || '',
    whatsapp: cfgMap['WHATSAPP_STUDIO'] || '',
    pixChave: cfgMap['PIX_CHAVE'] || '',
    pixRecebedor: cfgMap['PIX_RECEBEDOR'] || 'STUDIO NAILS',
    pixCidade: cfgMap['PIX_CIDADE'] || 'SAO PAULO',
    temaCor: cfgMap['TEMA_COR'] || 'pink-gold',
    horarioInicio: cfgMap['HORARIO_INICIO'] || '09:00',
    horarioFim: cfgMap['HORARIO_FIM'] || '19:00',
    almocoInicio: cfgMap['ALMOCO_INICIO'] || '12:00',
    almocoFim: cfgMap['ALMOCO_FIM'] || '13:00',
    diasAtendimento: cfgMap['DIAS_ATENDIMENTO'] || '1,2,3,4,5,6',
    intervaloMinutos: Number(cfgMap['INTERVALO_MINUTOS'] || 60),
    sincronizarAgenda: cfgMap['SINCRONIZAR_AGENDA'] || 'SIM',
    instagram: cfgMap['INSTAGRAM_STUDIO'] || '',
    endereco: cfgMap['ENDERECO_STUDIO'] || '',
  };
  return { studio, cfgMap };
}

// Versão segura para a cliente: sem loginId, link da planilha e flag interna de agenda.
export function publicStudio(studio) {
  const { loginId, spreadsheetUrl, sincronizarAgenda, ...rest } = studio;
  return rest;
}

export async function assertKnownStudio(g, env, sid) {
  const rows = await g.readTab(env.MASTER_SPREADSHEET_ID, 'Contas_Manicures');
  const ok = sid && rows.slice(1).some((r) => r && r[3] === sid);
  if (!ok) throw new UserError('Studio não encontrado.');
}

export async function readCategorias(g, sid) {
  const rows = await g.readTab(sid, 'Categorias');
  const list = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r && r[0]) {
      list.push({
        id: r[0],
        nome: r[1] || 'Geral',
        icone: r[2] || '💅',
        ordem: Number(r[3] || i),
        ativo: String(r[4] || 'SIM').toUpperCase() === 'SIM',
      });
    }
  }
  if (list.length === 0) return DEFAULT_CATEGORIAS.map((c) => ({ ...c }));
  return list.sort((a, b) => a.ordem - b.ordem);
}

// Todos os serviços (ativos ou não), com `ativo` booleano.
export async function readCatalogo(g, sid) {
  const rows = await g.readTab(sid, 'Catalogo');
  const list = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r && r[0]) {
      list.push({
        id: r[0], nome: r[1] || '', descricao: r[2] || '',
        preco: Number(r[3] || 0), duracaoMin: Number(r[4] || 60),
        fotoUrl: r[5] || '', categoria: r[6] || 'Alongamentos',
        ativo: String(r[7] || 'SIM').toUpperCase() === 'SIM',
      });
    }
  }
  return list;
}

// Linhas cruas (inclui cabeçalho na posição 0), como a planilha guarda.
export async function readAgendamentos(g, sid) {
  return g.readTab(sid, 'Agendamentos');
}
