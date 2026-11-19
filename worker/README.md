# Nail Studio Pro: Worker (guia de deploy)

Servidor (Cloudflare Worker) que guarda as credenciais Google e serve as páginas. Passo a passo para a dona do app. Requer Node 22.

## 1. Preparar

1. Crie uma conta gratuita em https://dash.cloudflare.com.
2. `cd worker && npm install`
3. `npx wrangler login`
4. `npx wrangler kv namespace create RATE_LIMIT` e cole o `id` impresso em `wrangler.toml` (no lugar de `REPLACE_WITH_KV_ID`).

## 2. Google Cloud Console

1. Em "Tela de consentimento OAuth", confira que o status é **Em produção**. Se estiver "Em teste", o acesso à Agenda expira em 7 dias.
2. Em Credenciais, no cliente OAuth, adicione aos URIs de redirecionamento autorizados: `https://<worker>/api/oauth/callback` (o `<worker>` é o endereço que o deploy mostrar; faça o deploy uma vez e volte aqui).
3. Gere um **novo client secret** e um **novo refresh token** da conta dona das planilhas.

## 3. Secrets e deploy

```
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_REFRESH_TOKEN
npx wrangler secret put SESSION_SECRET     # valor: saída de `openssl rand -base64 32`
npx wrangler deploy
```

Teste abrindo `https://<worker>/App_Manicure.html` e a página da cliente.

## 4. Revogar o que vazou

Depois de testar, **revogue o refresh token e o client secret antigos** (Google Cloud Console e https://myaccount.google.com/permissions). Enquanto isso não for feito, a credencial antiga continua valendo.

## 5. Trocar o endereço placeholder

Os arquivos usam o placeholder `https://nail-studio-pro.SEU-SUBDOMINIO.workers.dev`. Substitua pelo endereço real (na raiz do repositório):

```
sed -i 's#nail-studio-pro\.SEU-SUBDOMINIO\.workers\.dev#SEU-WORKER.SUBDOMINIO.workers.dev#g' \
  App_Manicure.html Pagina_Cliente.html Index.html 200.html \
  NailApp_Sheets/App_Manicure.html NailApp_Sheets/Pagina_Cliente.html NailApp_Sheets/Index.html NailApp_Sheets/200.html \
  android-app/app/src/main/java/com/example/nailstudiopro/MainActivity.kt
```

(os 8 redirecionamentos e `MainActivity.kt`, constante `BASE_URL`). Depois gere o APK novo (`cd android-app && ./gradlew assembleDebug`) e envie à manicure o APK e o link novo.

## Avisos para a manicure

- A manicure atual **mantém o PIN** (mesmo esquema de hash de antes). Se ela ainda usa o PIN padrão antigo `123456`, deve usar **"Esqueci a senha"** (Google) uma vez para criar um PIN novo.
- Os links de cliente existentes no surge.sh **param de funcionar** depois que a credencial antiga for revogada. Envie o link novo: `https://<worker>/Pagina_Cliente.html?s=<id>`.

## Limitações conhecidas

- O contador de falhas de PIN no Workers KV **não é atômico**: rajadas paralelas podem ultrapassar 5 tentativas / 15 min. Melhoria futura: contador em Durable Object.

## Desenvolvimento

`npx vitest run` (testes) e `npm run e2e` (ponta a ponta).
