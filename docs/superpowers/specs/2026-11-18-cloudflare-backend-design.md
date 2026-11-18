# Backend seguro no Cloudflare (Workers) — Design

Data: 2026-11-18 · Status: rascunho para aprovação

## Por quê

Hoje o app fala com o Google Sheets/Drive/Agenda **direto do navegador**. Para isso, o
`App_Manicure.html` e o `Pagina_Cliente.html` carregam uma credencial Google (client ID,
client secret e refresh token, só disfarçados em base64). Como as páginas são públicas
(GitHub Pages, surge.sh e dentro do APK), qualquer pessoa pode extrair a credencial e
ler/alterar as planilhas de **todos** os studios, inclusive a planilha mestre
`Contas_Manicures`.

Outros furos que vêm da mesma raiz:

- O PIN é conferido no navegador; quem tem a credencial pula a checagem.
- O "token de sessão" é `AUTH_TOKEN_` + 16 caracteres do hash do PIN — previsível e
  nunca validado por ninguém.
- O login "Continuar com Conta Google" aceita como "prova" `btoa(email)`: basta saber o
  e-mail de uma manicure para entrar no studio dela.
- O token da Google Agenda de cada manicure (`GCAL_REFRESH_TOKEN`) fica na planilha e é
  lido pelo navegador.

O objetivo é fechar esses furos **sem mudar o produto**: mesmas telas, mesma planilha
Google como banco de dados, hospedagem grátis.

## Metas

1. Nenhuma credencial ou token Google no código das páginas nem no APK.
2. Toda leitura/escrita no Google acontece num servidor (Cloudflare Worker) que guarda as
   credenciais como *secrets*.
3. PIN conferido no servidor; sessão com token assinado (HMAC) e com validade.
4. Funções da manicure só funcionam com sessão válida e só no studio daquela sessão.
5. Página da cliente continua sem login, mas só consegue fazer o que a cliente precisa.
6. Hospedagem grátis (plano Free do Cloudflare Workers, que permite uso comercial).

## Fora do escopo (não-metas)

- Redesenho de telas ou funções novas.
- Trocar a planilha por banco de dados (descartado: a planilha é parte do produto).
- Migração de dados: as planilhas atuais continuam sendo usadas como estão.
- Recompilar/publicar o APK (o código Kotlin é alterado; o build fica com a dona do
  projeto, a menos que o ambiente permita compilar).

## Anti-metas (seria fracasso mesmo "funcionando")

- Qualquer segredo aparecer no HTML, JS, APK ou numa resposta da API.
- Uma manicure conseguir ler/alterar dados de outro studio.
- A cliente conseguir ver dados de outras clientes além do que já é exposto hoje pela
  busca por WhatsApp (ver "Riscos conhecidos").

## Abordagens consideradas

| Abordagem | Prós | Contras | Decisão |
|---|---|---|---|
| **Cloudflare Worker com as 21 funções no servidor** | Grátis com uso comercial, rápido, mantém a planilha, fecha os furos | Reescrita grande da camada de dados | **Escolhida** |
| Vercel com a mesma arquitetura | Ótima ferramenta | Plano grátis é só para uso não comercial | Descartada |
| Google Apps Script como servidor | Grátis, sem credencial | 1–3 s por chamada, cotas diárias, URL ruim | Descartada |
| Supabase (Postgres) no lugar da planilha | Mais robusto a longo prazo | Perde a "planilha da manicure"; maior reescrita | Descartada pela dona |
| Só publicar, sem mexer no código | Rápido | Mantém a credencial exposta | Descartada |

## Arquitetura

```
Navegador / APK (WebView)
   │  POST /api/rpc  { fn, args, token? }
   ▼
Cloudflare Worker (um só, com Static Assets)
   ├─ serve App_Manicure.html, Pagina_Cliente.html, ícones, manifest
   ├─ /api/rpc         → as funções de negócio (portadas do navegador)
   ├─ /api/oauth/*     → login Google (web) e conexão da Google Agenda
   └─ secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN,
               SESSION_SECRET, MASTER_SPREADSHEET_ID
   │
   ▼
Google Sheets / Drive / Calendar APIs
```

- **Um único Worker** serve as páginas (Workers Static Assets) e a API, no mesmo
  domínio (`<nome>.workers.dev` até haver domínio próprio). Mesmo domínio = sem CORS
  para o site; CORS liberado só para a origem do APK se necessário.
- O código de negócio que hoje está dentro de `rpc()` nas duas páginas é **movido** para
  o Worker praticamente como está (é JavaScript com `fetch` e `crypto.subtle`, que existem
  no Worker). As funções duplicadas entre as duas páginas viram uma só.
- No navegador, `rpc(fn, ...args)` passa a ser um `fetch('/api/rpc')`. As telas não
  mudam.

## Autenticação e permissões

- **Login por e-mail + PIN:** `authenticateAdmin` roda no Worker; procura o e-mail em
  `Contas_Manicures`, compara o hash do PIN com `ADMIN_PIN_HASH` da planilha do studio
  e devolve um token `base64url(payload).assinatura`, onde
  `payload = { sid: <spreadsheetId>, email, exp }` e a assinatura é HMAC-SHA256 com
  `SESSION_SECRET`. Validade: 30 dias.
- **Login com Google (web):** o botão abre o fluxo OAuth padrão com redirecionamento
  para `/api/oauth/login/callback`; o Worker troca o código, lê o e-mail verificado pelo
  Google e emite o mesmo token de sessão. Contas novas continuam sendo provisionadas
  como hoje.
- **Login no APK:** o seletor de contas do Android deixa de valer como "prova" (não é
  verificável no servidor). No APK, a conta escolhida apenas **preenche o e-mail** e a
  manicure digita o PIN. (O Google bloqueia OAuth dentro de WebView.)
- **Funções `admin*`, `getAdminDashboardData`, `adminSaveSettings`:** exigem token
  válido; o `spreadsheetId` usado vem **do token**, nunca do navegador.
- **Funções públicas** (`getPublicBootstrapData`, `getAvailableSlotsForDate`,
  `createCustomerBooking`, `notifyPixPaidByCustomer`, `getClientBookingsByPhone`,
  `cancelCustomerBooking`): recebem o `spreadsheetId` do link (`?s=`), mas o Worker só
  aceita IDs que existem em `Contas_Manicures`. As respostas públicas nunca incluem
  chaves de configuração internas (hashes, tokens, login).
- **Recuperação de PIN e onboarding:** rodam no Worker, mesma lógica de hoje.
- **Google Agenda:** o fluxo de conexão usa redirecionamento para
  `/api/oauth/calendar/callback` (hoje aponta para `localhost:8080`, que não funciona
  em produção). O `GCAL_REFRESH_TOKEN` continua salvo na planilha do studio, mas só o
  Worker lê; nunca volta para o navegador. A sincronização (criar/apagar evento) roda no
  Worker dentro de `createCustomerBooking` / `adminUpdateBookingStatus` etc.

## Mudanças no repositório

- `worker/` (novo): `src/index.js` (roteamento), `src/google.js` (token, Sheets,
  Drive, Calendar), `src/rpc.js` (as funções), `src/session.js` (HMAC),
  `wrangler.toml`, `package.json`, testes.
- `public/` (novo): cópias servidas das páginas, ícones e manifest. As cópias
  duplicadas na raiz e em `NailApp_Sheets/` (`Index.html`, `200.html`) passam a ser
  geradas ou removidas — o builder decide, desde que o GitHub Pages siga funcionando
  ou seja desativado de forma explícita.
- `App_Manicure.html` e `Pagina_Cliente.html`: remover `GSHEET_CONFIG` com segredos, os
  helpers de Google e o corpo de `rpc()`; manter a UI.
- `android-app/.../MainActivity.kt`: `BASE_URL` → URL do Worker; remover a geração da
  "prova" falsa.
- `README.md`: novos links e o passo a passo de deploy.

## O que só a dona pode fazer (fora do código)

1. Criar conta grátis no Cloudflare.
2. No Google Cloud Console: gerar um **novo client secret** e um **novo refresh token**
   para a conta que é dona das planilhas; cadastrar as URIs de redirecionamento do
   Worker.
3. Cadastrar os secrets no Worker (`wrangler secret put` ou painel do Cloudflare).
   Os valores nunca passam pelo chat.
4. Depois que o Worker estiver no ar: **revogar** o refresh token e o client secret
   antigos (vazados no histórico do Git).

## Decisões fechadas após revisão (2026-11-18)

Respondidas pela dona:

- **Recuperar PIN e criar conta exigem login Google verificado.** A recuperação por
  WhatsApp ou "palavra de segurança" é removida (ambas são públicas ou adivinháveis).
  No APK, esses fluxos abrem o navegador do sistema (Google bloqueia OAuth em WebView)
  e voltam ao app com a sessão.
- **Só uma manicure usa o app hoje.** Os links antigos do GitHub Pages viram
  redirecionamento para o Worker; o surge.sh fica como está (ninguém sabe publicar lá) e
  a manicure recebe o link novo diretamente. O APK v2.2 instalado pode quebrar após a
  revogação; ela instala o novo.
- **Status da tela de consentimento OAuth é desconhecido.** O README de deploy inclui
  o passo de conferir e publicar como "Em produção"; enquanto estiver "Em teste", a
  conexão da Agenda expira a cada 7 dias.

Chamadas do construtor (a dona pode corrigir):

- O APK passa a carregar as páginas do Worker (sem cópias nos assets); sem CORS.
- Limite de tentativas de PIN com Workers KV (grátis): bloqueio temporário após 5
  erros em 15 min por e-mail.
- "Usar planilha existente" recusa IDs já presentes em `Contas_Manicures` e a planilha
  mestre.
- Conta criada via Google não recebe PIN padrão; até definir um PIN, só entra por
  Google. Login por e-mail+PIN recusa o PIN `123456` legado.
- Mesmo cliente OAuth; só o secret e o refresh token são trocados, preservando os
  `GCAL_REFRESH_TOKEN` já salvos.

## Riscos conhecidos (aceitos por ora)

- A busca "Meus Horários" por número de WhatsApp continua mostrando e permitindo
  cancelar reservas de quem souber o número — comportamento atual, mantido.
- As planilhas de studio criadas com "qualquer pessoa com o link pode editar" continuam
  assim; restringir o compartilhamento é um passo seguinte.
- O plano Free do Workers tem 100 mil requisições/dia e limite de CPU por requisição;
  folgado para o volume esperado.

## Deixado para quem for construir

- Estrutura interna dos módulos, nomes de arquivos dentro de `worker/src`.
- Estratégia de cache do access token Google dentro do Worker.
- Forma dos testes (recomendado: testes das funções com Google simulado, como no
  roteiro de screenshots já usado).
