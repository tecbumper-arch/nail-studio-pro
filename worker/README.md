# Nail Studio Pro: Worker (guia de deploy)

Servidor (Cloudflare Worker) que guarda as credenciais Google e serve as páginas. Passo a passo para a dona do app. Requer Node 22.

## Ordem obrigatória (leia antes de tudo)

As páginas antigas (GitHub Pages / surge.sh) viram só redirecionamentos para o Worker. Se esses
redirecionamentos forem publicados **antes** de o Worker existir, o link de agendamento que as
clientes usam hoje **para de funcionar**. Siga esta ordem, sem pular:

1. **Publique o Worker** (seções 1 a 3 abaixo) e teste as duas páginas no endereço novo.
2. **Anote o endereço** que o `npx wrangler deploy` mostrou (ex.: `https://nail-studio-pro.maria.workers.dev`).
3. **Troque o endereço provisório** pelo real com o comando `sed` da seção 5.
4. **Faça commit e push** dessa troca neste mesmo branch.
5. **Só então** junte (merge) este branch no `main` (o que publica o GitHub Pages).
6. Gere e envie o APK novo (seção 5) e, por último, troque as credenciais antigas (seção 4).

## 1. Preparar

1. Crie uma conta gratuita em https://dash.cloudflare.com.
2. `cd worker && npm install`
3. `npx wrangler login`
4. `npx wrangler kv namespace create RATE_LIMIT` e cole o `id` impresso em `wrangler.toml` (no lugar de `REPLACE_WITH_KV_ID`).

## 2. Google Cloud Console

Tudo em https://console.cloud.google.com, no projeto do app, menu **APIs e serviços**.

1. Em **Tela de consentimento OAuth**, confira que o status é **Em produção**. Se estiver "Em teste", o acesso à Agenda expira em 7 dias.
2. Em **Credenciais**, abra o cliente OAuth do app (tipo "Aplicativo da Web"). Em **URIs de redirecionamento autorizados**, adicione:
   - `https://<worker>/api/oauth/callback` (o `<worker>` é o endereço que o deploy mostrar; faça o deploy uma vez e volte aqui);
   - `https://developers.google.com/oauthplayground` (só para gerar o refresh token do passo 4; pode tirar depois).

   Clique em **Salvar**.
3. Ainda no cliente OAuth, clique em **Adicionar secret** (ou "Add secret"). Copie o secret novo na hora e guarde: o Google pode não mostrá-lo de novo. **Não apague o secret antigo ainda** (isso é a seção 4).
4. **Gere um novo refresh token** da conta Google dona das planilhas (a conta "motor" do app), pelo OAuth Playground:
   1. Abra https://developers.google.com/oauthplayground.
   2. Clique na **engrenagem** (⚙, canto superior direito) e marque **Use your own OAuth credentials**.
   3. Cole o **Client ID** do cliente OAuth e o **secret novo** do passo 3.
   4. Na mesma janela, deixe **Access type: Offline** e em **Force prompt** escolha **Consent Screen**. Feche a engrenagem.
   5. À esquerda, no campo **Input your own scopes**, cole exatamente (separados por espaço):

      ```
      https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive
      ```

      (São só esses dois: o Worker usa este token para ler/gravar planilhas e compartilhá-las. A Agenda de cada manicure usa a conexão própria dela, feita pelo botão "Conectar Google Agenda".)
   6. Clique em **Authorize APIs**, entre com a **conta dona das planilhas** e aceite.
   7. Clique em **Exchange authorization code for tokens**.
   8. Copie o valor de **Refresh token** (começa com `1//`). É ele que vai no `GOOGLE_REFRESH_TOKEN` da seção 3.

## 3. Secrets e deploy

Cada comando pede o valor; cole e aperte Enter.

```
npx wrangler secret put GOOGLE_CLIENT_ID       # Client ID do cliente OAuth
npx wrangler secret put GOOGLE_CLIENT_SECRET   # o secret NOVO (seção 2, passo 3)
npx wrangler secret put GOOGLE_REFRESH_TOKEN   # o refresh token NOVO (seção 2, passo 4)
npx wrangler secret put SESSION_SECRET         # valor: saída de `openssl rand -base64 32`
npx wrangler deploy
```

Teste abrindo `https://<worker>/App_Manicure.html` (entrar com e-mail e PIN) e a página da cliente (fazer uma reserva de teste e cancelar).

## 4. Desligar a credencial que vazou

Faça isto **depois** que o Worker estiver funcionando com o secret e o refresh token novos.

1. No Google Cloud Console, **Credenciais**, abra o mesmo cliente OAuth.
2. Na lista de secrets, **desative e depois exclua o secret ANTIGO** (o que estava no código antigo). Confira pela data de criação: fique só com o novo.
3. Pronto: sem o secret antigo, o refresh token que vazou não serve mais para nada.

**Não** use "Remover acesso" em https://myaccount.google.com/permissions para este app depois de gerar o token novo: como é o mesmo cliente OAuth, isso **também derruba o refresh token novo** (e o Worker para de acessar as planilhas). Se fizer por engano, repita a seção 2, passo 4, e o `secret put GOOGLE_REFRESH_TOKEN`.

Se quiser, tire também `https://developers.google.com/oauthplayground` dos URIs de redirecionamento.

## 5. Trocar o endereço provisório

Os arquivos usam o endereço provisório `https://nail-studio-pro.SEU-SUBDOMINIO.workers.dev`. Na raiz do repositório, troque pelo endereço real anotado (troque `SEU-WORKER.SUBDOMINIO` abaixo):

```
sed -i 's#nail-studio-pro\.SEU-SUBDOMINIO\.workers\.dev#SEU-WORKER.SUBDOMINIO.workers.dev#g' \
  App_Manicure.html Pagina_Cliente.html Index.html 200.html \
  NailApp_Sheets/App_Manicure.html NailApp_Sheets/Pagina_Cliente.html NailApp_Sheets/Index.html NailApp_Sheets/200.html \
  android-app/app/src/main/java/com/example/nailstudiopro/MainActivity.kt
```

(os 8 redirecionamentos e `MainActivity.kt`, constante `BASE_URL`). Confira com `grep -rln SEU-SUBDOMINIO *.html NailApp_Sheets android-app` (não pode aparecer nenhum arquivo), faça commit e push, e só então o merge no `main` (veja "Ordem obrigatória").

Depois gere o APK novo (`cd android-app && ./gradlew assembleDebug`) e envie à manicure o APK e o link novo.

## Avisos para a manicure

- A manicure atual **mantém o PIN** (mesmo esquema de hash de antes). Se ela ainda usa o PIN padrão antigo `123456`, deve usar **"Esqueci a senha"** (Google) uma vez para criar um PIN novo.
- Os links de cliente existentes no surge.sh **param de funcionar** depois que a credencial antiga for desligada. Envie o link novo: `https://<worker>/Pagina_Cliente.html?s=<id>`.

## Limitações conhecidas

- O contador de falhas de PIN no Workers KV **não é atômico**: rajadas paralelas podem ultrapassar 5 tentativas / 15 min. Melhoria futura: contador em Durable Object.
- O plano grátis do KV permite 1.000 gravações por dia. O Worker só grava em erro de PIN de conta existente. Se o KV falhar ou a cota acabar, o login continua funcionando, mas **sem** o limite de tentativas até o dia seguinte (fica registrado no log do Worker: `rate limit indisponível`).

## Desenvolvimento

`npx vitest run` (testes) e `npm run e2e` (ponta a ponta).
