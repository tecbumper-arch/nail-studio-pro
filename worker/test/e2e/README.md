# Teste de ponta a ponta (`npm run e2e`)

Sobe um Google falso (`fakeGoogleServer.js`, em memória), o Worker com `wrangler dev --local`
apontando para ele (`GOOGLE_API_BASE`) e abre as páginas no Chromium do Playwright (390×844).

Primeira vez numa máquina nova (ou depois de mudar a versão do `playwright` no package.json):

```sh
npm install
npm run e2e:install-browser   # = npx playwright install chromium
npm run e2e
```

`E2E_SHOTS=<pasta> npm run e2e` também salva screenshots.

- Os segredos usados são de teste e ficam num `.dev.vars` temporário fora do repositório.
- `@fortawesome/fontawesome-free` e `qrcodejs` são devDependencies só para o e2e: o teste serve
  esses arquivos no lugar das CDNs (que podem estar bloqueadas). As páginas em produção continuam
  usando as CDNs.
