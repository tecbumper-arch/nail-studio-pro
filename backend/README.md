# 💅 Nail Studio Pro v3 — Guia de Instalação do Servidor (Apps Script)

Este guia liga o app ao Google **do jeito oficial e seguro**. Você faz isso **uma vez**
(≈ 30 minutos). Depois, cada manicure só toca em **"Continuar com Google"**.

> Por que mudou? Na versão 2.2 o "login com Google" não era real (qualquer pessoa podia
> forjar a "prova" do Android), a conexão da Google Agenda dependia de `localhost:8080`
> (só funcionava no seu PC) e **o Client Secret + um Refresh Token da sua conta Google
> estavam dentro dos HTMLs públicos**. Agora os segredos ficam só no Apps Script.

---

## 🚨 0. Segurança — faça isto PRIMEIRO

O repositório público (e o site no GitHub Pages / surge.sh) expôs as credenciais da
versão antiga. Qualquer pessoa podia usá-las para ler e alterar as planilhas de todos os studios.

1. **Revogue o token vazado:** entre em <https://myaccount.google.com/permissions>
   com a conta Google dona das planilhas → encontre o app do Nail Studio → **Remover acesso**.
2. **Troque o Client Secret antigo:** [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
   → Credenciais → cliente `1071006060591-tmhssin...` → **Redefinir chave secreta**
   (ou exclua esse cliente, se não usar mais).
3. Se alguma manicure criou a própria planilha e deixou o compartilhamento como
   **"Qualquer pessoa com o link — Editor"**, troque para **Restrito** e compartilhe só com
   o e-mail da conta dona do servidor.

> Apagar os arquivos antigos não resolve sozinho: eles continuam no histórico do Git.
> O que protege de verdade é revogar o token e trocar o segredo (passos 1 e 2).

---

## 1. Google Cloud: tela de consentimento + APIs

Em <https://console.cloud.google.com> (pode usar o projeto que já existe):

1. **APIs e serviços → Biblioteca** → ative **Google Calendar API**.
2. **APIs e serviços → Tela de consentimento OAuth** (Google Auth Platform):
   - Tipo: **Externo**. Nome: *Nail Studio Pro*. E-mail de suporte: o seu.
   - **Escopos (Acesso a dados):** `openid`, `.../auth/userinfo.email` e
     `https://www.googleapis.com/auth/calendar.events`.
   - **Público → Publicar app ("Em produção")**.
     ⚠️ No modo **"Teste"** o Google **apaga a permissão da agenda a cada 7 dias**
     — esse é um motivo comum de "a agenda parou de sincronizar".
   - Enquanto o app não for verificado pelo Google, aparece a tela *"O Google não verificou este app"*.
     A manicure toca em **Avançado → Acessar Nail Studio Pro**. Para tirar o aviso
     (e passar de 100 usuárias), peça a verificação na própria tela de consentimento.

## 2. Google Cloud: criar os clientes OAuth

**APIs e serviços → Credenciais → Criar credenciais → ID do cliente OAuth**

### 2.1 Cliente "Aplicativo da Web" (obrigatório)
- **Origens JavaScript autorizadas:**
  - `https://tecbumper-arch.github.io`
  - `https://nailstudiopro-app.surge.sh` (se ainda usar o surge)
- **URIs de redirecionamento:** não precisa (o login usa pop-up do Google).
- Guarde o **ID do cliente** (`....apps.googleusercontent.com`) e a **Chave secreta**.

### 2.2 Cliente "Android" (para o APK)
- Nome do pacote: `com.nailstudio.pro`
- **SHA-1** da chave que assina o APK:
  ```bash
  # chave de debug (Android Studio)
  keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android -keypass android
  # chave de release
  keytool -list -v -keystore SUA_CHAVE.jks -alias SEU_ALIAS
  ```
  Cadastre um cliente Android para cada SHA-1 (debug e release). Ele não tem segredo.

## 3. Criar o servidor no Apps Script

Use **a mesma conta Google que é dona das planilhas dos studios** (a "conta mestre").

1. Abra <https://script.google.com> → **Novo projeto** → nomeie *Nail Studio Pro API*.
2. Apague o conteúdo de `Código.gs` e cole todo o arquivo [`Code.gs`](Code.gs).
3. ⚙️ **Configurações do projeto** → marque *"Mostrar arquivo de manifesto appsscript.json"*.
   Volte ao editor, abra `appsscript.json` e cole o conteúdo de [`appsscript.json`](appsscript.json).
4. ⚙️ **Configurações do projeto → Propriedades do script → Adicionar**:

   | Propriedade | Valor |
   |---|---|
   | `GOOGLE_CLIENT_ID` | ID do cliente **Web** (passo 2.1) |
   | `GOOGLE_CLIENT_SECRET` | Chave secreta do cliente Web |
   | `MASTER_SPREADSHEET_ID` | `14r4nifHaaQgDMm8OmCgRjCoScY8rOPGLMfdKnRz1a9Q` (planilha que já tem a aba `Contas_Manicures`, para manter os studios existentes). Deixe vazio para criar uma nova. |
   | `PUBLIC_BASE_URL` | `https://tecbumper-arch.github.io/nail-studio-pro` |

5. No editor, escolha a função **`setup`** e clique **▶ Executar** → autorize (o Google pede as permissões uma vez).
   Opcional: depois disso o servidor se auto-configura sozinho; rodar aqui só serve para autorizar e ver o
   *Registro de execução* (função `diagnostico`, que também mostra o espaço usado no Drive).
6. **Implantar → Nova implantação → ⚙️ App da Web**
   - Executar como: **Eu**
   - Quem pode acessar: **Qualquer pessoa**
   - Copie a URL que termina em **`/exec`**.
   - (Opcional) salve essa URL na propriedade `API_URL`.

> **Atualizações futuras:** configure o [deploy automático](#-deploy-automático-pelo-github) (uma vez) e nunca mais
> cole código. Sem ele: *Implantar → Gerenciar implantações → ✏️ → Versão: Nova versão* (a URL `/exec` não muda).

## 🚀 Deploy automático pelo GitHub

Depois desta configuração única (~10 min), **toda mudança aprovada na `main` vai sozinha para o servidor**:
o GitHub roda os testes, envia o `Code.gs`, publica uma nova versão **na mesma implantação** (URL igual) e
"acorda" o servidor, que se auto-configura (gatilhos, segredos, diretório). Ninguém precisa abrir o Apps Script.

Faça com a **conta Google do servidor** (a mesma do passo 3):

1. Abra <https://script.google.com/home/usersettings> e **ative** "API do Google Apps Script".
2. Num computador com [Node.js](https://nodejs.org) instalado, rode no terminal:
   ```bash
   npx @google/clasp@2.4.2 login
   ```
   O navegador abre: entre com a conta do servidor e toque em **Permitir**. Isso cria o arquivo
   `.clasprc.json` na sua pasta de usuário (Windows: `C:\Users\SEU_USUARIO\.clasprc.json`;
   Mac/Linux: `~/.clasprc.json`). Abra com o Bloco de Notas e copie **todo** o conteúdo.
3. No GitHub: repositório → **Settings → Secrets and variables → Actions**:
   - aba **Secrets** → *New repository secret* → nome `CLASPRC_JSON`, valor = conteúdo copiado.
   - aba **Variables** → *New repository variable*:
     | Nome | Onde achar |
     |---|---|
     | `SCRIPT_ID` | Apps Script → ⚙️ Configurações do projeto → **ID do script** |
     | `DEPLOYMENT_ID` | Apps Script → Implantar → **Gerenciar implantações** → ID da implantação (começa com `AKfy…`) |
     | `API_URL` | a URL `/exec` (opcional: usada para conferir a versão no fim) |
4. Teste: GitHub → **Actions → "Deploy do servidor (Apps Script)" → Run workflow**. Deve terminar verde e mostrar
   "Servidor respondeu versão: …".

Pronto. O arquivo `.clasprc.json` é uma chave da conta do servidor: guarde só no Secret do GitHub e apague a cópia
do computador se quiser. Para revogar: <https://myaccount.google.com/permissions> → "clasp" → Remover acesso.

> O front-end (HTMLs no GitHub Pages) já atualiza sozinho a cada push na `main`. O APK Android continua
> precisando ser gerado de novo no Android Studio quando as páginas mudam (elas vão dentro do APK).

## 4. Configurar o app

Edite [`config.js`](../config.js) na raiz do repositório:

```js
window.NAIL_CONFIG = {
  API_URL: 'https://script.google.com/macros/s/XXXXXXXX/exec',
  GOOGLE_CLIENT_ID: '1234-abc.apps.googleusercontent.com',   // cliente WEB
  PUBLIC_BASE_URL: 'https://tecbumper-arch.github.io/nail-studio-pro'
};
```

Depois rode `./scripts/sync-copies.sh` (copia para `Index.html`, `200.html`, `NailApp_Sheets/`
e para os assets do APK) e faça commit/push. O GitHub Pages atualiza sozinho.

## 5. Gerar o APK (Android Studio)

Abra `android-app/`, sincronize o Gradle e gere **Build → Generate Signed Bundle/APK**.
O SHA-1 dessa chave precisa estar no cliente Android (passo 2.2), senão o login nativo
mostra erro *"Verifique o cliente OAuth Android (SHA-1)"*.

---

## ✅ Teste rápido depois de instalar

1. Abra `https://tecbumper-arch.github.io/nail-studio-pro/App_Manicure.html` → **Continuar com Google**.
2. Studio existente: entra direto. Conta nova: preenche 3 campos e o Studio + planilha são criados.
3. **Opções → Conectar Google Agenda** → marque a caixinha da agenda → status 🟢 Conectada → **Testar**.
4. Abra o link das clientes (aba **Meu Link**), agende um horário → o evento aparece na Google Agenda.

## 🔁 Sincronização automática e avisos

- O servidor instala sozinho dois gatilhos: **resumo diário (7h)** e **sincronização da Google Agenda a cada 15 min**
  (`sincronizarAgendas`). Isso acontece na 1ª requisição depois de cada atualização do código (auto-setup):
  não é preciso rodar `setup()` manualmente.
- E-mails de "nova reserva / cancelou" saem pela conta do servidor (limite do Google: ~100 e-mails/dia em conta Gmail).

## 🔗 Vincular uma planilha que a manicure já tem

No primeiro acesso ela pode escolher "Usar uma planilha que já tenho". O app mostra o e-mail da **conta do servidor**
para ela compartilhar a planilha como **Editor** (o servidor só acessa planilhas compartilhadas com ele).
O app confere se a planilha é mesmo da conta Google dela, mantém os dados e cria apenas as abas que faltam.

## 👑 Planilha no nome da manicure

Em Opções → Segurança, Planilha & Backup → "Quero ser a dona da planilha", o Google envia a ela um pedido de
transferência de propriedade. Depois de aceitar, a conta do servidor continua como editora (não remova esse acesso).

## 📸 Fotos dos serviços

As fotos que a manicure envia vão para uma pasta no Google Drive da **conta do servidor**
("Nail Studio Pro — Fotos — <Studio>"), compartilhada com o e-mail dela e com acesso
"qualquer pessoa com o link pode ver" (necessário para aparecerem na página das clientes).
Fotos removidas de um serviço vão para a lixeira do Drive. O espaço usado conta na cota
de 15 GB da conta do servidor (cada foto tem ~150–300 KB → cabem ~50 mil fotos).

**Você não precisa acompanhar isso:** todo dia o servidor confere o espaço e, se passar de **80%**, manda um
e-mail para a conta do servidor (no máximo 1x por semana). Nesse caso: esvazie a lixeira do Drive ou contrate
mais espaço no Google One para essa conta. Se lotar, só o envio de novas fotos para — o resto continua funcionando.

## 🧯 Problemas comuns

| Sintoma | Causa / solução |
|---|---|
| Botão do Google não aparece / erro `origin_mismatch` | A origem do site não está em *Origens JavaScript autorizadas* (2.1). |
| "Este login Google não pertence a este app" | `GOOGLE_CLIENT_ID` do `config.js` ≠ propriedade do script. |
| Agenda 🟠 "Reconectar" | A manicure trocou a senha, removeu o acesso, ou o app está em modo **Teste** (7 dias). |
| "Quase lá! Toque em Conectar mais uma vez" | Normal na 1ª reconexão: o Google só entrega o token permanente após novo consentimento. |
| App Android: "Falha no login Google … SHA-1" | Falta cadastrar o SHA-1 da chave do APK no cliente Android. |
| "Servidor não configurado (MASTER_SPREADSHEET_ID)" | Rode `setup()` uma vez no editor (passo 3.5) para autorizar. |
| Action "Deploy do servidor" com aviso "não configurado" | Faltam os Secrets/Variables do [deploy automático](#-deploy-automático-pelo-github). |
| Action falha em "Enviar código" com "User has not enabled the Apps Script API" | Passo 1 do deploy automático. |

## 🧪 Testes automatizados (desenvolvimento)

```bash
node --test tests/backend.test.js   # 14 testes do servidor (Apps Script simulado)
node tests/e2e.js                   # fluxo completo no Chromium (Playwright)
```
