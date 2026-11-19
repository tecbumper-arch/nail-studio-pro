// Criação de conta (onboarding) com e-mail verificado pelo Google (token 'pending').
// Porta de App_Manicure.html rpc('completeInitialOnboarding') e provisionNewGoogleSpreadsheetForUser
// (1404-1528), sem palavra de recuperação: RecHash fica vazio.
import { AuthError, UserError, GoogleError } from '../errors.js';
import { normalizeBrPhone, sanitizeCell, hashPin } from '../util.js';
import { findAccountByEmail, issueStudioSession, validateNewPin } from './auth.js';
import { defaultCatalogTabs } from './admin.js';

const s = sanitizeCell;
const TABS = ['Configuracoes', 'Categorias', 'Catalogo', 'Agendamentos', 'Logs_Seguranca'];
const AG_HEAD = ['ID', 'Data', 'HoraInicio', 'HoraFim', 'ClienteNome', 'ClienteWhatsApp', 'ServicoID', 'ServicoNome', 'Valor', 'MetodoPagamento', 'StatusPagamento', 'StatusReserva', 'CalendarEventID', 'CriadoEm'];

const nowBr = () => new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
const sheetUrl = (sid) => `https://docs.google.com/spreadsheets/d/${sid}/edit`;

// Aceita o link completo da planilha ou só o ID.
function parseSheetId(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  const m = raw.match(/\/d\/([a-zA-Z0-9_-]+)/);
  const id = m ? m[1] : raw;
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new UserError('Link ou ID da planilha inválido.');
  return id;
}

function configRows(d) {
  return [
    ['Chave', 'Valor', 'Descricao'],
    ['SETUP_CONCLUIDO', 'SIM', 'Criado automaticamente pelo App'],
    ['STUDIO_NOME', d.studioNome, 'Nome do Studio'],
    ['PROFISSIONAL_NOME', d.profissionalNome, 'Nome da Profissional'],
    ['ADMIN_LOGIN_ID', d.email, 'Conta Google / Login Titular'],
    ['WHATSAPP_STUDIO', d.whatsapp, 'WhatsApp Oficial'],
    ['PIX_CHAVE', d.pixChave, 'Chave Pix'],
    ['PIX_RECEBEDOR', d.profissionalNome, 'Titular Pix'],
    ['PIX_CIDADE', 'SAO PAULO', 'Cidade Pix'],
    ['TEMA_COR', 'pink-gold', 'Tema de Cores'],
    ['HORARIO_INICIO', '09:00', 'Abertura'],
    ['HORARIO_FIM', '19:00', 'Fechamento'],
    ['ALMOCO_INICIO', '12:00', 'Início Almoço'],
    ['ALMOCO_FIM', '13:00', 'Fim Almoço'],
    ['DIAS_ATENDIMENTO', '1,2,3,4,5,6', 'Dias (0=Dom..6=Sab)'],
    ['INTERVALO_MINUTOS', '60', 'Intervalo'],
    ['SINCRONIZAR_AGENDA', 'SIM', 'Agenda'],
    ['INSTAGRAM_STUDIO', '', 'Instagram do Studio'],
    ['ENDERECO_STUDIO', '', 'Endereço do Studio'],
    ['ADMIN_PIN_HASH', d.pinHash, 'Hash SHA-256 da Senha/PIN'],
    ['ADMIN_RECOVERY_HASH', '', 'Hash SHA-256 da Palavra de Recuperação'],
    ['TERMO_ACEITO_EM', d.criadoEm, 'Termo de Responsabilidade Aceito'],
  ];
}

async function provisionNewSheet(g, d) {
  const sid = await g.createSpreadsheet(`${d.rawStudioNome} - App & Agenda (Banco Oficial)`, TABS);
  const cat = defaultCatalogTabs();
  await g.writeTab(sid, 'Configuracoes', configRows(d));
  await g.writeTab(sid, 'Categorias', cat.Categorias);
  await g.writeTab(sid, 'Catalogo', cat.Catalogo);
  await g.writeTab(sid, 'Agendamentos', [AG_HEAD]);
  await g.writeTab(sid, 'Logs_Seguranca', [['Timestamp', 'Evento', 'Detalhes'], [d.criadoEm, 'CONTA_CRIADA', `Planilha criada para ${d.email}`]]);
  const ownershipStatus = await g.shareWithOwner(sid, d.rawEmail);
  return { sid, ownershipStatus };
}

const isOutage = (e) => e instanceof GoogleError && (e.status === 429 || e.status >= 500);

// Sem acesso à planilha: pede para compartilhar só com a conta do app, como Editor.
async function noAccessError(g) {
  let appEmail = 'a conta do Nail Studio Pro';
  try {
    appEmail = await g.serviceAccountEmail();
  } catch (e) {}
  return new UserError(`Não consegui acessar sua planilha. No Google Sheets, clique em Compartilhar e adicione ${appEmail} como Editor.`);
}

// Planilha própria: só aceita se a conta Google verificada for dona ou editora do arquivo.
async function connectCustomSheet(g, sid, d) {
  let perms;
  try {
    perms = await g.driveFilePermissions(sid);
  } catch (e) {
    if (isOutage(e)) throw e;
    throw await noAccessError(g);
  }
  const mine = perms.some((p) => String(p.emailAddress || '').trim().toLowerCase() === d.rawEmail
    && (p.role === 'owner' || p.role === 'writer'));
  if (!mine) throw new UserError('Esta planilha não pertence à sua conta Google.');

  try {
    await g.readTab(sid, 'Configuracoes');
    await g.writeTab(sid, 'Configuracoes', configRows(d));
  } catch (e) {
    if (isOutage(e)) throw e;
    throw await noAccessError(g);
  }
  return { sid, ownershipStatus: 'PROPRIETARIA' };
}

export const onboardingHandlers = {
  async completeInitialOnboarding(ctx, p = {}) {
    const session = ctx.session;
    if (!session || session.kind !== 'pending' || !session.email) {
      throw new AuthError('Sessão expirada. Entre com Google novamente.');
    }
    const { env, g } = ctx;
    const email = String(session.email).trim().toLowerCase();
    p = p || {};

    const studioNome = String(p.studioNome || '').trim();
    const profissionalNome = String(p.profissionalNome || '').trim();
    const whatsappRaw = String(p.whatsapp || '').trim();
    if (!studioNome || !profissionalNome || !whatsappRaw) throw new UserError('Preencha Nome do Studio, Seu Nome e WhatsApp!');
    const whatsapp = normalizeBrPhone(whatsappRaw);
    if (whatsapp.length < 10 || whatsapp.length > 11) throw new UserError('WhatsApp inválido: use DDD + número (11 dígitos).');
    const pin = validateNewPin(p.pin);
    const customId = parseSheetId(p.customSheetId);

    if (await findAccountByEmail(g, env, email)) {
      throw new UserError('Já existe um Studio com este e-mail. Entre com Google.');
    }
    if (customId) {
      const contas = await g.readTab(env.MASTER_SPREADSHEET_ID, 'Contas_Manicures');
      const taken = customId === env.MASTER_SPREADSHEET_ID
        || contas.slice(1).some((r) => r && String(r[3] || '').trim() === customId);
      if (taken) throw new UserError('Esta planilha já pertence a um studio.');
    }

    const d = {
      email: s(email),
      rawEmail: email,
      rawStudioNome: studioNome,
      studioNome: s(studioNome),
      profissionalNome: s(profissionalNome),
      whatsapp,
      pixChave: s(String(p.pixChave || '').trim()),
      pinHash: await hashPin(pin),
      criadoEm: nowBr(),
    };

    const { sid, ownershipStatus } = customId
      ? await connectCustomSheet(g, customId, d)
      : await provisionNewSheet(g, d);

    await g.appendRow(env.MASTER_SPREADSHEET_ID, 'Contas_Manicures', [
      d.email, d.profissionalNome, d.studioNome, sid, sheetUrl(sid),
      `${ctx.origin}/Pagina_Cliente.html?s=${sid}`, d.pinHash, '', d.criadoEm,
    ]);

    const token = await issueStudioSession(env, { sid, email }, ctx.now);
    return { token, spreadsheetId: sid, ownershipStatus };
  },
};
