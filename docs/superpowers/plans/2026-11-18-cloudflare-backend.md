# Backend seguro no Cloudflare Workers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mover toda a comunicação com Google Sheets/Drive/Agenda do navegador para um Cloudflare Worker que guarda as credenciais, com sessão assinada, mantendo telas e planilhas.

**Architecture:** Um Worker (`worker/`) serve as páginas estáticas (Workers Static Assets, pasta `worker/public/`) e expõe `POST /api/rpc` e `GET /api/oauth/*`. A lógica que hoje está dentro de `rpc()` em `App_Manicure.html` / `Pagina_Cliente.html` é portada para módulos do Worker; no navegador, `rpc()` vira um `fetch`. Google é acessado por um cliente injetável (`createGoogle(env, fetchImpl)`), o que permite testes com um Google falso em memória.

**Tech Stack:** Cloudflare Workers (ES modules, `crypto.subtle`), Wrangler 3, Workers KV, Vitest (Node 22), Playwright (já instalado no ambiente) para o teste de ponta a ponta.

**Spec:** `docs/superpowers/specs/2026-11-18-cloudflare-backend-design.md`

## Global Constraints

- Nenhum segredo no HTML, JS servido, APK ou em resposta da API. Chaves que nunca saem do Worker: `ADMIN_PIN_HASH`, `ADMIN_RECOVERY_HASH`, `ADMIN_LOGIN_ID`, `GCAL_REFRESH_TOKEN`, `GCAL_WEBHOOK_URL`, `GCAL_CONNECTED_EMAIL` (este último só em `adminGetGcalStatus`).
- Secrets do Worker: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `SESSION_SECRET`. Var (não secreta): `MASTER_SPREADSHEET_ID`. Binding KV: `RATE_LIMIT`. Var opcional só para testes locais: `GOOGLE_API_BASE` (padrão: endpoints reais do Google).
- Funções `admin*` usam o `spreadsheetId` **do token**, nunca do corpo da requisição.
- Funções públicas só aceitam `sid` presente na coluna D (índice 3) de `Contas_Manicures` da planilha mestre.
- Sessão de studio: validade 30 dias. Token "pending" (onboarding): 30 min. `state` OAuth: 10 min.
- Limite de PIN: 5 erros em 15 min por e-mail → `Muitas tentativas. Tente novamente em 15 minutos.`
- Login por e-mail+PIN recusa o hash de `123456` (PIN legado padrão) com `Defina um PIN: entre com Google e crie um novo PIN.`
- Recuperar PIN e criar conta só com login Google verificado; recuperação por WhatsApp/palavra é removida.
- Mesmo cliente OAuth (client ID atual); redirect único: `<origem do Worker>/api/oauth/callback`.
- Telas e textos atuais preservados, exceto: tela "Esqueci a senha" (vira "Entrar com Google" + "Novo PIN") e e-mail do onboarding (vem do Google, só leitura).
- Layout das abas (não mudar): `Agendamentos` 14 colunas `[ID, Data, HoraInicio, HoraFim, ClienteNome, ClienteWhatsApp, ServicoID, ServicoNome, Valor, MetodoPagamento, StatusPagamento, StatusReserva, CalendarEventID, CriadoEm]`; `Catalogo` `[ID, Nome, Descricao, Preco, DuracaoMin, FotoUrl, Categoria, Ativo]`; `Categorias` `[ID, Nome, Icone, Ordem, Ativo]`; `Configuracoes` `[Chave, Valor, Descricao]`; `Contas_Manicures` `[Email, Profissional, Studio, SheetId, SheetUrl, ClientLink, PinHash, RecHash, CriadoEm]`.

## Review Focus

- Reserva no mesmo horário por duas clientes quase ao mesmo tempo: a segunda deve receber "Horário indisponível", não duplicar (Task 3, `createCustomerBooking rejects a slot taken after slots were listed`).
- WhatsApp digitado em formatos diferentes (`(11) 99777-8888`, `11997778888`, `5511997778888`) deve achar as mesmas reservas (Task 3, `getClientBookingsByPhone matches any phone format`).
- Google fora do ar / cota estourada (HTTP 429/5xx): a tela mostra "Google indisponível, tente de novo", sem stack trace nem dados internos (Task 2 e Task 8).
- Token adulterado, expirado ou de outro tipo (pending usado em função admin): 401, e a página volta para o login (Task 1 e Task 8).
- Manicure A mandando `sid` do studio B numa função admin: a operação acontece no studio A (do token) e nada muda no B (Task 5).

---

### Task 1: Esqueleto do Worker + sessão assinada

**Files:**
- Create: `worker/package.json`, `worker/wrangler.toml`, `worker/vitest.config.js`, `worker/.gitignore` (`node_modules`, `.wrangler`, `.dev.vars`)
- Create: `worker/src/session.js`, `worker/src/errors.js`
- Test: `worker/test/session.test.js`

**Interfaces:**
- Produces:
  - `signToken(payload: object, secret: string, ttlSeconds: number, now = Date.now()) -> Promise<string>` — formato `v1.<b64url(json com exp)>.<b64url(HMAC-SHA256)>`
  - `verifyToken(token: string, secret: string, now = Date.now()) -> Promise<object|null>` — `null` se adulterado, malformado ou expirado
  - `class UserError extends Error { status = 400 }`, `class AuthError extends UserError { status = 401 }`, `class GoogleError extends Error { status: number }`
  - Payloads usados nas tasks seguintes: studio `{ kind: 'studio', sid, email }`, pending `{ kind: 'pending', email, name }`, state OAuth `{ kind: 'state', intent: 'login'|'onboard'|'recover'|'calendar', app: boolean, sid?: string }`

- [ ] **Step 1: Write the failing tests** — `signs and verifies a studio token`, `rejects a token with one changed character` (→ `null`), `rejects an expired token` (`now` + 31 dias com ttl de 30 dias → `null`), `rejects a token signed with another secret`, `rejects garbage` (`'abc'`, `''`, `undefined` → `null`).
- [ ] **Step 2:** `cd worker && npm install && npx vitest run test/session.test.js` → FAIL (módulo não existe).
- [ ] **Step 3: Implement** `session.js` e `errors.js`. `wrangler.toml`: `name = "nail-studio-pro"`, `main = "src/index.js"`, `compatibility_date = "2024-11-01"`, `[assets] directory = "./public"`, `binding = "ASSETS"`, `run_worker_first = ["/api/*"]` (se a versão do wrangler não suportar, usar roteamento no `index.js` com `env.ASSETS.fetch`), `[[kv_namespaces]] binding = "RATE_LIMIT"` com id placeholder `REPLACE_WITH_KV_ID`, `[vars] MASTER_SPREADSHEET_ID = "1rfDFh6lQOhq6MOvbqFcEALWOciWoxKxW51J45IYTZ0Q"`. `package.json`: devDeps `wrangler@3`, `vitest@2`; scripts `test`, `dev`, `deploy`.
- [ ] **Step 4:** `npx vitest run` → PASS.
- [ ] **Step 5: Commit** `feat(worker): esqueleto do Worker e sessão HMAC`

### Task 2: Cliente Google + Google falso para testes

**Files:**
- Create: `worker/src/google.js`
- Create: `worker/test/fakeGoogle.js` (planilhas em memória atrás de um `fetch` falso)
- Test: `worker/test/google.test.js`

**Interfaces:**
- Consumes: `GoogleError` (Task 1)
- Produces:
  - `createGoogle(env, fetchImpl = fetch) -> Google`, onde `Google` tem:
    - `readTab(sid, tab) -> Promise<string[][]>` (faixa `A1:Z500`; aba inexistente → `[]`)
    - `writeTab(sid, tab, rows) -> Promise<void>` (clear + update `USER_ENTERED`)
    - `appendRow(sid, tab, row) -> Promise<void>`
    - `createSpreadsheet(title, tabTitles: string[]) -> Promise<string>` (devolve id)
    - `shareWithOwner(sid, email) -> Promise<'PROPRIETARIA'|'AGUARDANDO_ACEITE'|'COMPARTILHADA'>` (mesma sequência de hoje em `App_Manicure.html:1484-1513`)
    - `calendarAccessToken(refreshToken) -> Promise<string>`, `createCalendarEvent(accessToken, event) -> Promise<string>` (id), `deleteCalendarEvent(accessToken, eventId) -> Promise<void>`
    - `exchangeCode(code, redirectUri) -> Promise<{access_token, refresh_token?, id_token?}>`, `userEmail(accessToken) -> Promise<{email, name}>` (só aceita `verified_email`/`email_verified` true)
  - Base URLs saem de `env.GOOGLE_API_BASE` quando definido (um prefixo único que substitui `https://sheets.googleapis.com`, `https://www.googleapis.com`, `https://oauth2.googleapis.com`), senão as reais.
  - `createFakeGoogle(seed: Record<sid, Record<tab, string[][]>>) -> { fetch, db, calls }` — implementa só os endpoints que `google.js` usa.

- [ ] **Step 1: Write the failing tests** — `caches the access token until 60s before expiry` (2 leituras → 1 chamada a `/token`), `readTab returns [] for a missing tab`, `writeTab replaces all rows`, `appendRow adds one row`, `non-2xx from Sheets throws GoogleError with status` (fake devolve 429 → `GoogleError.status === 429`), `userEmail rejects an unverified email`.
- [ ] **Step 2:** `npx vitest run test/google.test.js` → FAIL.
- [ ] **Step 3: Implement** `google.js` portando `getGoogleAccessToken`, `readSheetTab`, `writeSheetTab`, `appendSheetRow`, criação de planilha e compartilhamento de `App_Manicure.html:1334-1530`, e `getCalendarAccessTokenFromRefresh` / chamadas de Calendar de `App_Manicure.html:1746-1819`. Cache do access token em variável de módulo com expiração.
- [ ] **Step 4:** `npx vitest run` → PASS.
- [ ] **Step 5: Commit** `feat(worker): cliente Google injetável e Google falso para testes`

### Task 3: Studio, Pix e funções públicas (página da cliente)

**Files:**
- Create: `worker/src/studio.js`, `worker/src/pix.js`, `worker/src/util.js`, `worker/src/handlers/public.js`
- Test: `worker/test/public.test.js`

**Interfaces:**
- Consumes: `Google` (Task 2), `UserError` (Task 1)
- Produces:
  - `util.js`: `normalizeBrPhone(s) -> string` (11 dígitos, remove `55` inicial), `toMin`, `fromMin`, `sha256Hex(s) -> Promise<string>`, `newId(prefix) -> string`
  - `studio.js`: `loadStudio(g, sid) -> Promise<{ studio: Studio, cfgMap: Record<string,string> }>` (mesmos campos e padrões de `App_Manicure.html:2887-2910`), `publicStudio(studio) -> object` (o `Studio` sem `loginId`, `spreadsheetUrl` e `sincronizarAgenda`; mantém `pixChave`/`pixRecebedor`, que o modal Pix mostra à cliente), `assertKnownStudio(g, env, sid) -> Promise<void>` (lança `UserError('Studio não encontrado.')`), `readCategorias(g, sid)` (com a lista padrão de `App_Manicure.html:2726-2733` quando vazia), `readCatalogo(g, sid)`, `readAgendamentos(g, sid)`
  - `pix.js`: `buildPixBrCode(chave, recebedor, cidade, valor, txid) -> string` (cópia de `App_Manicure.html:2612-2710`)
  - `handlers/public.js`: `publicHandlers: Record<fnName, (ctx, ...args) => Promise<any>>` com `getPublicBootstrapData`, `getAvailableSlotsForDate`, `createCustomerBooking`, `notifyPixPaidByCustomer`, `getClientBookingsByPhone`, `cancelCustomerBooking`. `ctx = { env, g, sid, origin, waitUntil }`. Retornos idênticos aos de hoje em `Pagina_Cliente.html` (mesmos nomes de campo).

- [ ] **Step 1: Write the failing tests** (seed no estilo do roteiro de screenshots: Configuracoes, Categorias, Catalogo com 2 serviços, Agendamentos com 3 reservas, Contas_Manicures com o studio):
  - `bootstrap returns studio, categorias, catalogo` e `bootstrap never contains ADMIN_PIN_HASH, GCAL_REFRESH_TOKEN, ADMIN_LOGIN_ID or loginId` (procura as strings em `JSON.stringify`)
  - `rejects an unknown sid` (`UserError` "Studio não encontrado.")
  - `slots skip lunch, non-working days and booked times`
  - `createCustomerBooking appends a 14-column row and returns pixCopiaECola for PIX_SINAL_50 with half price`
  - `createCustomerBooking rejects a slot taken after slots were listed` (reserva inserida no fake entre `getAvailableSlotsForDate` e `createCustomerBooking` → `UserError` contendo "indisponível")
  - `getClientBookingsByPhone matches any phone format` (3 formatos → mesmas reservas)
  - `cancelCustomerBooking only cancels a booking whose phone matches`
- [ ] **Step 2:** `npx vitest run test/public.test.js` → FAIL.
- [ ] **Step 3: Implement** portando os ramos correspondentes de `rpc()` em `Pagina_Cliente.html:1378-1575` (e helpers usados por eles). A sincronização com a Agenda dentro de `createCustomerBooking`/`cancelCustomerBooking` chama `syncCalendar` da Task 6; até lá, um no-op exportado de `studio.js` (`syncCalendar = async () => {}`) que a Task 6 substitui.
- [ ] **Step 4:** `npx vitest run` → PASS.
- [ ] **Step 5: Commit** `feat(worker): funções públicas da página da cliente`

### Task 4: Login por PIN, limite de tentativas, troca de PIN

**Files:**
- Create: `worker/src/rateLimit.js`, `worker/src/handlers/auth.js`
- Test: `worker/test/auth.test.js`

**Interfaces:**
- Consumes: `signToken` (Task 1), `Google` (Task 2), `loadStudio`, `sha256Hex`, `normalizeBrPhone` (Task 3)
- Produces:
  - `rateLimit.js`: `isLocked(kv, key) -> Promise<boolean>`, `recordFailure(kv, key) -> Promise<void>` (contador com TTL 900 s), `clearFailures(kv, key)`
  - `findAccountByEmail(g, env, email) -> Promise<{ email, sid } | null>` (planilha mestre, aba `Contas_Manicures`)
  - `issueStudioSession(env, { sid, email }) -> Promise<string>`
  - `authHandlers.authenticateAdmin(ctx, { loginId, pin }) -> { token, spreadsheetId }`
  - `adminAuthHandlers.adminSetPin(ctx, { novoPin }) -> { success: true }` (grava `ADMIN_PIN_HASH`; PIN 4–6 dígitos), `adminAuthHandlers.checkAuthStatus(ctx) -> { setupConcluido, studioNome, profissional, spreadsheetId, hasPin }`
- [ ] **Step 1: Write the failing tests** — `correct email and PIN returns a verifiable studio token with the studio sid`, `wrong PIN fails with "Senha / PIN incorreto!"`, `unknown email fails with the current "Conta não encontrada..." message`, `sixth attempt within 15 min is locked even with the right PIN` (KV falso = `Map` com `get/put/delete`), `legacy default PIN 123456 is refused`, `adminSetPin rejects 3 digits and stores the hash of a valid PIN`.
- [ ] **Step 2:** `npx vitest run test/auth.test.js` → FAIL.
- [ ] **Step 3: Implement** a partir de `App_Manicure.html:2853-2878` e `2958-2971`.
- [ ] **Step 4:** `npx vitest run` → PASS.
- [ ] **Step 5: Commit** `feat(worker): login por PIN no servidor com limite de tentativas`

### Task 5: Funções da manicure (painel)

**Files:**
- Create: `worker/src/handlers/admin.js`
- Test: `worker/test/admin.test.js`

**Interfaces:**
- Consumes: Tasks 2–4 (`ctx.session = { sid, email }` já validado pelo roteador da Task 8)
- Produces: `adminHandlers` com `getAdminDashboardData`, `adminSaveCategory`, `adminDeleteCategory`, `adminSeedDefaultCatalog`, `adminSaveService`, `adminToggleServiceActive`, `adminDeleteService`, `adminUpdateBookingStatus`, `adminCreateManualBookingOrBlock`, `adminSaveSettings`. Assinaturas = as de hoje **sem** o primeiro argumento de token (o roteador já tira o token do header). Retornos idênticos aos de hoje; `getAdminDashboardData().studio` usa `publicStudio` + `spreadsheetUrl`, `loginId`.
- [ ] **Step 1: Write the failing tests** — `dashboard returns agendamentos sorted newest first`, `dashboard never contains ADMIN_PIN_HASH or GCAL_REFRESH_TOKEN`, `saveSettings keeps ADMIN_PIN_HASH and GCAL_REFRESH_TOKEN untouched` (antes eram reescritos a partir do navegador), `adminSaveService with sid of studio B in args changes only studio A` (sessão do A; db do B idêntico antes/depois), `adminUpdateBookingStatus CANCELAR_RESERVA sets CANCELADO`.
- [ ] **Step 2:** `npx vitest run test/admin.test.js` → FAIL.
- [ ] **Step 3: Implement** portando `App_Manicure.html:3127-3408` (ramos `admin*` e `getAdminDashboardData`). Em `adminSaveSettings`, ignorar `novoPin` / `novaPalavraRecuperacao` vindos do navegador (troca de PIN só via `adminSetPin`) e preservar do `cfgMap` atual as chaves secretas listadas nas Global Constraints.
- [ ] **Step 4:** `npx vitest run` → PASS.
- [ ] **Step 5: Commit** `feat(worker): funções do painel da manicure`

### Task 6: Google Agenda no servidor

**Files:**
- Create: `worker/src/calendar.js`
- Modify: `worker/src/studio.js` (remover o no-op `syncCalendar`), `worker/src/handlers/public.js`, `worker/src/handlers/admin.js`
- Test: `worker/test/calendar.test.js`

**Interfaces:**
- Consumes: `Google` (Task 2), `loadStudio` (Task 3)
- Produces:
  - `syncCalendar(g, sid, action: 'CREATE'|'DELETE', booking?, eventId?) -> Promise<{ eventId?: string } | null>` — usa `GCAL_REFRESH_TOKEN` (OAuth) ou `GCAL_WEBHOOK_URL` (só `https://script.google.com/`), como em `App_Manicure.html:1763-1819`; nunca lança (falha vira `null` e log)
  - Ao criar, grava o id do evento na coluna 13 (`CalendarEventID`) da reserva.
  - `calendarHandlers`: `adminGetGcalStatus() -> { connected, mode: 'oauth'|'webhook'|'', connectedEmail }`, `adminTestGcal() -> { success }`, `adminDisconnectGcal() -> { success }`, `adminSaveGcalWebhook({ webhookUrl }) -> { success }`
- [ ] **Step 1: Write the failing tests** — `booking creates an event and stores its id in column 13`, `cancel deletes the stored event`, `no calendar configured → booking still succeeds`, `calendar API 500 → booking still succeeds`, `status never returns the refresh token`, `saveGcalWebhook rejects a non script.google.com URL`.
- [ ] **Step 2:** `npx vitest run test/calendar.test.js` → FAIL.
- [ ] **Step 3: Implement**; chamadas de Agenda dentro de reservas via `ctx.waitUntil` quando a resposta não depende do id do evento.
- [ ] **Step 4:** `npx vitest run` → PASS.
- [ ] **Step 5: Commit** `feat(worker): sincronização da Google Agenda no servidor`

### Task 7: OAuth (login, criar conta, recuperar PIN, conectar Agenda) e onboarding

**Files:**
- Create: `worker/src/oauth.js`, `worker/src/handlers/onboarding.js`
- Test: `worker/test/oauth.test.js`, `worker/test/onboarding.test.js`

**Interfaces:**
- Consumes: Tasks 1–6
- Produces:
  - `handleOAuthStart(request, env) -> Response` — `GET /api/oauth/start?intent=login|onboard|recover|calendar&app=0|1`; `calendar` exige `Authorization`-equivalente via `?t=<studio token>` (o navegador não envia header num redirect). Redireciona para `accounts.google.com` com `state` assinado, `redirect_uri=<origin>/api/oauth/callback`. Escopos: login/onboard/recover `openid email profile`; calendar `openid email https://www.googleapis.com/auth/calendar.events`, `access_type=offline`, `prompt=consent`.
  - `handleOAuthCallback(request, env, g) -> Response` — resultados (destino web = `/App_Manicure.html?...`, app = `nailstudiopro://auth?...`):
    - conta existe (intent login/onboard/recover) → `google_auth=success&token=<studio>&email=<e>&intent=<i>`
    - conta não existe e intent login/onboard → `google_auth=pending&token=<pending>&email=<e>`
    - conta não existe e intent recover → `google_auth=error&msg=Conta%20n%C3%A3o%20encontrada`
    - calendar → grava `GCAL_REFRESH_TOKEN`, `GCAL_CONNECTED_EMAIL`, `SINCRONIZAR_AGENDA=SIM` no studio do `state.sid`; destino `gcal=connected`
    - `state` inválido/expirado ou erro do Google → `google_auth=error&msg=...`
  - `onboardingHandlers.completeInitialOnboarding(ctx, { customSheetId?, studioNome, profissionalNome, whatsapp, pixChave, pin }) -> { token, spreadsheetId, ownershipStatus }` — exige token `pending`; e-mail vem do token; recusa `customSheetId` igual a `MASTER_SPREADSHEET_ID` ou presente em `Contas_Manicures` (`UserError('Esta planilha já pertence a um studio.')`); sem `customSheetId` provisiona como `App_Manicure.html:1404-1528` (sem `recHash`: coluna fica vazia). Validações e mensagens atuais de `App_Manicure.html:3438-3456` (sem a palavra de recuperação).
- [ ] **Step 1: Write the failing tests** — `start builds a Google URL with signed state and the callback redirect_uri`, `calendar start without a valid studio token is 401`, `callback for an existing account redirects with a studio token`, `callback for a new account redirects with a pending token`, `callback with app=1 redirects to nailstudiopro://auth`, `tampered state → google_auth=error`, `calendar callback stores the refresh token in the studio sheet only`, `onboarding with pending token provisions a sheet and registers it in Contas_Manicures`, `onboarding refuses another studio's sheet and the master sheet`, `onboarding with a studio token is 401`.
- [ ] **Step 2:** `npx vitest run test/oauth.test.js test/onboarding.test.js` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `npx vitest run` → PASS.
- [ ] **Step 5: Commit** `feat(worker): OAuth Google no servidor e onboarding verificado`

### Task 8: Roteador `/api/rpc` e entrada do Worker

**Files:**
- Create: `worker/src/index.js`, `worker/src/rpc.js`
- Test: `worker/test/router.test.js`

**Interfaces:**
- Consumes: todos os handlers (Tasks 3–7)
- Produces:
  - `POST /api/rpc` com corpo `{ fn: string, args: any[], sid?: string }` e header opcional `Authorization: Bearer <token>`. Resposta `200 { ok: true, data }` ou `{ ok: false, error: string }` com status 400 (`UserError`), 401 (`AuthError` / token inválido), 404 (`fn` desconhecida), 502 (`GoogleError`: mensagem `Google indisponível, tente de novo em instantes.`), 500 (outros: `Erro interno. Tente novamente.`; detalhes só em `console.error`).
  - Tabela de acesso em `rpc.js`: `open` = `authenticateAdmin`; `public` (exige `sid` + `assertKnownStudio`) = Task 3; `studio` (token `kind:'studio'`) = Tasks 4 (`adminSetPin`, `checkAuthStatus`), 5, 6; `pending` (token `kind:'pending'`) = `completeInitialOnboarding`.
  - `GET /api/oauth/start`, `GET /api/oauth/callback` → Task 7. Qualquer outra rota → `env.ASSETS.fetch(request)`. `GET /` → redireciona para `/App_Manicure.html`.
  - Cabeçalhos de segurança em respostas da API: `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`.
- [ ] **Step 1: Write the failing tests** (chamando `createWorker({ fetchImpl: fake.fetch }).fetch(new Request(...), env, ctx)`; `index.js` exporta `createWorker({ fetchImpl = fetch })` e `export default createWorker()`): `unknown fn → 404`, `admin fn without token → 401`, `admin fn with pending token → 401`, `expired token → 401`, `public fn with unknown sid → 400`, `Google 429 → 502 with friendly message and no stack`, `GET / redirects to /App_Manicure.html`, `API responses have Cache-Control no-store`.
- [ ] **Step 2:** `npx vitest run test/router.test.js` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `npx vitest run` → todos PASS.
- [ ] **Step 5: Commit** `feat(worker): roteador da API`

### Task 9: Páginas servidas pelo Worker + teste de ponta a ponta

**Files:**
- Create (git mv): `worker/public/App_Manicure.html`, `worker/public/Pagina_Cliente.html`, `worker/public/manifest.json`, `worker/public/icon-192.png`, `worker/public/icon-512.png` (a partir da raiz)
- Modify: as duas páginas em `worker/public/`
- Create: `worker/test/e2e/fakeGoogleServer.js` (servidor HTTP local que usa `createFakeGoogle`), `worker/test/e2e/e2e.mjs`, script `npm run e2e`

**Interfaces:**
- Consumes: API da Task 8.
- Mudanças nas páginas:
  - Remover `GSHEET_CONFIG` (client id/secret/refresh token), `getGoogleAccessToken`, `readSheetTab`, `writeSheetTab`, `appendSheetRow`, `logSecurityEvent`, `provisionNewGoogleSpreadsheetForUser`, `getGcalConfigFromSheet`, `upsertSheetConfigKeys`, `getCalendarAccessTokenFromRefresh`, `syncGoogleCalendarCloudDirect` (as duas cópias), `readCategoriasList`, o corpo de `rpc()`, `pureJsSha256`/`sha256Hex`, `buildPixBrCode` **só** se nenhuma tela usar (`testMyPixModal` usa: manter `buildPixBrCode`/`emvField`/`cleanPixKey` no navegador, sem segredo).
  - Novo `rpc(fn, ...args)`: `fetch('/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(adminToken && { Authorization: 'Bearer ' + adminToken }) }, body: JSON.stringify({ fn, args, sid }) })`; `sid` = `?s=` na página da cliente. Em 401 no painel: `logoutApp()`. Erro → `throw new Error(json.error)` (as telas já mostram `e.message`).
  - Chamadas que hoje passam `adminToken` como 1º argumento deixam de passar.
  - `NAIL_ACTIVE_SHEET_ID` deixa de ser necessário para autenticar (o `sid` vem do token); manter só se alguma tela usar para montar links.
  - Botões "Continuar com Conta Google", "Criar acesso" e "Esqueci a senha" → `location.href = '/api/oauth/start?intent=login|onboard|recover&app=' + (window.AndroidNativeBridge ? 1 : 0)`. No APK, abrir pelo `AndroidNativeBridge` no navegador do sistema (Task 10).
  - Tratar retorno: `google_auth=success` (já existe em `App_Manicure.html:2563-2589`; se `intent=recover`, abrir o modo recover mostrando só "Novo PIN" → `adminSetPin`), `google_auth=pending` (abrir onboarding com e-mail preenchido e só leitura, guardar o token pending em `sessionStorage`, enviar no `Authorization`), `google_auth=error` (toast com `msg`), `gcal=connected` (toast + `checkGcalStatus()`).
  - Remover do onboarding o campo "palavra de recuperação" e do recover os campos e-mail/palavra.
  - Agenda: `checkGcalStatus` → `rpc('adminGetGcalStatus')`; `testGcalSync` → `adminTestGcal`; `disconnectGcal` → `adminDisconnectGcal`; `saveGcalWebhook` → `adminSaveGcalWebhook`; `connectGoogleCalendarOAuth`/`getGcalConnectUrl` → `/api/oauth/start?intent=calendar&t=<adminToken>&app=...`. Remover o listener de `google_oauth_code` e `loginWithGoogleAccount`/`onAndroidDeviceGoogleAccountSelected` com "prova" (no APK, a conta escolhida só preenche o campo de e-mail).
  - `clientPageUrlInput` / links de compartilhamento: `location.origin + '/Pagina_Cliente.html?s=' + sid`.
- [ ] **Step 1: Write the e2e script** (Playwright, viewport 390×844): sobe `fakeGoogleServer` e `npx wrangler dev --var GOOGLE_API_BASE:http://127.0.0.1:<porta>` com `.dev.vars` de teste; cenários: `cliente agenda e vê o Pix` (página da cliente → serviço → dia → horário → Sinal 50% → modal com QR e valor pela metade), `manicure entra com e-mail e PIN e vê a reserva nova na Agenda`, `PIN errado mostra "Senha / PIN incorreto!"`, `nenhuma resposta de /api/* contém "GCAL_REFRESH_TOKEN" nem "ADMIN_PIN_HASH"`, `HTML servido não contém "clientSecret" nem "refreshToken"`.
- [ ] **Step 2:** `npm run e2e` → FAIL (páginas ainda chamam Google direto).
- [ ] **Step 3: Implement** as mudanças nas páginas.
- [ ] **Step 4:** `npm run e2e` → PASS; `grep -rn "clientSecret\|refreshToken: atob\|client_secret" worker/public` → nada.
- [ ] **Step 5: Commit** `feat: páginas usam a API do Worker; credenciais removidas do navegador`

### Task 10: Limpeza das cópias com credencial, APK e documentação

**Files:**
- Modify: `App_Manicure.html`, `Pagina_Cliente.html`, `Index.html`, `200.html` (raiz) e `NailApp_Sheets/{App_Manicure,Pagina_Cliente,Index,200}.html` → páginas mínimas de redirecionamento para `https://nail-studio-pro.<subdomínio>.workers.dev/<mesmo arquivo><mesma query>` (via `<meta http-equiv="refresh">` + `location.replace` preservando `location.search`). URL base definida numa única constante por arquivo; valor final preenchido no deploy.
- Delete: `android-app/app/src/main/assets/{App_Manicure,Pagina_Cliente}.html` (manter ícones/manifest se o build referenciar)
- Modify: `android-app/app/src/main/java/com/example/nailstudiopro/MainActivity.kt`, `android-app/app/src/main/AndroidManifest.xml`
- Modify: `README.md`
- Create: `worker/README.md` (deploy)

**Interfaces / mudanças:**
- `MainActivity.kt`: `BASE_URL` = URL do Worker; carregar `"$BASE_URL/App_Manicure.html"` na abertura; rotas internas (`App_Manicure.html`, `Pagina_Cliente.html`) ficam no WebView com a URL do Worker; remover `LOCAL_ASSET_*`, `interceptLocalOAuthRedirect`, a geração de `deviceProof` e o fallback OAuth com client ID; o seletor de contas chama `window.onAndroidDeviceGoogleAccountSelected(email)` só para preencher o e-mail; nova função `openInSystemBrowser(url)` na ponte `AndroidNativeBridge` (usada pelos botões de OAuth); `onNewIntent`/`onCreate` tratam `nailstudiopro://auth?<query>` carregando `"$BASE_URL/App_Manicure.html?<query>"`.
- `AndroidManifest.xml`: `intent-filter` com `VIEW`, `DEFAULT`, `BROWSABLE`, `data android:scheme="nailstudiopro" android:host="auth"`; `launchMode="singleTask"`.
- `worker/README.md` (passo a passo para a dona): criar conta Cloudflare; `npx wrangler login`; `npx wrangler kv namespace create RATE_LIMIT` e colar o id; no Google Cloud Console: conferir que a tela de consentimento está "Em produção" (se "Em teste", a Agenda expira em 7 dias), adicionar `https://<worker>/api/oauth/callback` aos URIs de redirecionamento, gerar novo client secret e novo refresh token da conta dona das planilhas; `npx wrangler secret put` para os 4 secrets (`SESSION_SECRET`: `openssl rand -base64 32`); `npx wrangler deploy`; testar; **revogar** o refresh token e o client secret antigos; atualizar a URL nos redirecionamentos e no `MainActivity.kt`; gerar APK novo e enviar o link novo à manicure.
- `README.md`: links novos, arquitetura em 3 linhas, aviso de que as versões ≤ v2.2 devem ser substituídas.

- [ ] **Step 1:** `grep -rln "clientSecret\|<prefixo-do-refresh-token>" --exclude-dir=.git --exclude-dir=node_modules .` → lista as 10 cópias (estado inicial).
- [ ] **Step 2: Implement** redirecionamentos, remoções, Kotlin, manifest e READMEs.
- [ ] **Step 3:** repetir o grep do Step 1 → nenhuma saída. `cd worker && npx vitest run && npm run e2e` → PASS. Se houver Android SDK no ambiente: `cd android-app && ./gradlew assembleDebug` → BUILD SUCCESSFUL; se não houver, registrar no relatório final que o APK não foi compilado aqui.
- [ ] **Step 4: Commit** `chore: remove cópias com credencial, APK aponta para o Worker, guia de deploy`
