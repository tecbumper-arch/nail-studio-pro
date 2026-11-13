# 💅 Nail Studio Pro (v3.0 — Login Google real + Google Agenda bidirecional)

App para **manicures e nail designers**: painel da profissional (web, PWA e APK Android),
página pública de agendamento para as clientes, Pix Copia e Cola e integração oficial com
**Google Sheets** (banco de dados) e **Google Agenda** — 24h, sem computador ligado e de graça.

> 👉 **Instalação / configuração:** [`backend/README.md`](backend/README.md)
> 🚀 **Atualizações:** depois da configuração única do [deploy automático](backend/README.md#-deploy-automático-pelo-github), cada mudança na `main` vai sozinha para o servidor e para o site.
> (inclui os passos de segurança urgentes da versão 2.2).

---

## 🔗 Links

- 💅 Painel da manicure: `https://tecbumper-arch.github.io/nail-studio-pro/App_Manicure.html`
- 📅 Página da cliente: `.../Pagina_Cliente.html?s=ID_DO_STUDIO` (o link certo aparece na aba **Meu Link**)
- 📲 APK Android: gerado a partir de `android-app/` (veja o guia)

## 🏗️ Como funciona

```
 Painel (HTML/PWA/APK) ─┐                    ┌─ Planilha do Studio (Google Sheets)
                        ├─► API Apps Script ─┼─ Google Agenda da manicure (OAuth guardado no servidor)
 Página da cliente ─────┘   (backend/Code.gs) └─ Diretório de studios (planilha mestre privada)
```

- Nenhum segredo nos HTMLs. O `config.js` só tem a URL da API e o Client ID (públicos).
- Login: **ID Token do Google** verificado no servidor → sessão assinada (HMAC) de 30 dias.
- Agendamentos passam por **trava (LockService)**: dois clientes nunca pegam o mesmo horário.

## ✨ Funcionalidades

**Primeiro acesso em 3 passos (novo)**
- Tela de login única: **Entrar com Google** (no APK usa as contas do próprio celular). Sem perguntar iOS/Android.
- Assistente: **1. Studio** (nome, WhatsApp, Pix) → **2. Planilha**: criar uma nova no Drive *ou* **vincular uma planilha que ela já tem**
  (mantém os dados e cria só as abas que faltam) → **3. Google Agenda**: conectar com 1 toque (ou "agora não").
- Quem já tem Studio e ainda não ligou a agenda recebe o convite ao entrar (no máximo 1x por semana).
- "Quero ser a dona da planilha": transfere a propriedade da planilha para o Drive da manicure.
- O link para instalar o app fica em **Meu Link**, e já detecta o aparelho (iPhone, Android ou computador).

- Login com a **Conta Google real** (botão oficial no navegador; seletor nativo de contas no Android).
- Primeiro acesso cria o Studio e a planilha automaticamente (compartilhada com a dona).
- PIN opcional de acesso rápido (com bloqueio após 5 erros) e "Desconectar todos os aparelhos".

**Google Agenda (novo motor)**
- **Cliente agendou → entra na hora na Google Agenda. Cliente desmarcou → sai na hora.** Vale também para reservas,
  cancelamentos e reagendamentos feitos pela manicure.
- **Sincronização automática a cada 15 min**: reenvia o que falhou (Google instável) e tira da agenda reservas canceladas
  direto na planilha. No painel, reserva que ainda não chegou à agenda mostra "enviar agora".
- **E-mail na hora** para a manicure a cada nova reserva ou cancelamento (pode desligar).
- Conectar uma vez: reservas entram na agenda com lembrete (1 dia e 1 hora antes).
- **Reagendar move o evento**, cancelar/liberar vaga **apaga o evento**.
- **Compromissos pessoais da agenda bloqueiam horários** na página da cliente.
- Status de conexão com aviso de "Reconectar" se o Google revogar a permissão.
- Assinatura **.ics** para ver a agenda no iPhone/Outlook.

**Horários e agenda do dia (novo)**
- **Horário diferente para cada dia da semana** (ex.: segunda 13h–20h, sábado 8h–14h), com pausa própria.
- **Horários fixos** por dia: a cliente só vê os horários escolhidos (ex.: sábado só 08:00, 10:30 e 13:00).
- **Datas especiais**: fechar feriado/folga, meio período ou **abrir um dia normalmente fechado** (ex.: domingo antes do Natal).
- **Agenda do dia**: tira de dias com quantas clientes há em cada um, linha do tempo mostrando quem está em cada horário,
  pausa, bloqueios e compromissos da Google Agenda; toque em **+ Reservar** num horário livre para encaixar uma cliente
  ou no 🔒 para bloquear; botões "Mudar horário deste dia", "Fechar este dia" e "Abrir este dia".

**Agenda e atendimento**
- Reagendar com sugestão de horários livres + aviso automático no WhatsApp.
- Status **Confirmar**, **Concluir**, **Faltou** (no-show) e anotações por atendimento (cor, formato, alergias).
- **Lembretes de amanhã**: lista pronta para mandar WhatsApp para cada cliente.
- **Pedir avaliação** (Google/Instagram) após concluir.
- Bloqueio de horário, "fechar o resto do dia" e **férias/folga de vários dias**.

**Regras da página da cliente**
- Antecedência mínima, até quantos dias à frente, prazo de cancelamento online,
  aceitar ou não "pagar no Studio", mensagem de boas-vindas e política de cancelamento.
- Cliente: observação no agendamento, "Meus horários", 2ª via do Pix, salvar na agenda (Google e .ics).

**Fotos dos trabalhos (catálogo da manicure)**
- Cada serviço tem até **8 fotos reais** enviadas pela manicure (câmera ou galeria do celular), com escolha da capa.
- As fotos ficam na pasta **"Nail Studio Pro — Fotos — <Studio>"** do Google Drive (compartilhada com a manicure) e não pesam na planilha.
- A cliente toca na foto do serviço e abre a **galeria** (deslizar, setas, "Quero este!").
- O painel avisa quais serviços ainda estão **sem foto**. Enquanto não há foto, aparece a miniatura ilustrada da categoria.

**Gestão**
- **Relatório**: faturamento dos últimos 6 meses, ticket médio, clientes novas, faltas,
  serviços que mais faturam e horário mais procurado.
- CRM: clientes VIP 👑, faltas, próximo horário e lembrete de manutenção (dias configuráveis).
- Exportar agendamentos e clientes em **CSV** (abre no Excel/Sheets).
- **QR Code** do link de agendamento para imprimir.
- **Resumo do dia por e-mail** às 7h (opcional).

## 📂 Estrutura

| Caminho | O que é |
|---|---|
| `App_Manicure.html` | Painel da manicure (arquivo principal) |
| `Pagina_Cliente.html` | Página pública de agendamento |
| `config.js` | URL da API + Client ID (sem segredos) |
| `backend/` | Servidor Apps Script (`Code.gs`, `appsscript.json`) + guia |
| `android-app/` | APK Kotlin (WebView + login Google nativo) |
| `.github/workflows/deploy-backend.yml` | Deploy automático do servidor (testes + clasp) a cada push na `main` |
| `scripts/sync-copies.sh` | Copia os HTMLs para `Index.html`, `200.html`, `NailApp_Sheets/` e assets do APK |
| `design/` | Fonte vetorial dos ícones (`icons.js`), exportações do Figma e gerador de tamanhos (`build_assets.py`) |
| `assets/` | Ícones de categoria (SVG), miniaturas de serviço, favicon e `brand.js` |
| `tests/` | Testes do servidor (Node) e ponta a ponta (Playwright) |
| `NailApp_Sheets/` | Versão antiga (Apps Script por planilha / servidor local) — mantida só por compatibilidade |

## 🎨 Ícones e miniaturas

Desenhados no Figma: **[Nail Studio Pro — Ícones e Miniaturas](https://www.figma.com/design/hU0nj1Xweckn9rY6QUB1eS)**
(componentes `app-icon`, `category/*` e `thumbnail/*`). Para regenerar depois de mudar o desenho:

```bash
# 1. exporte do Figma app-icon (1024 px) e thumbnail/* (600 px) para design/figma-export/
python3 design/build_assets.py   # gera PWA, favicon, Apple, Android (mipmaps + ícone adaptativo) e miniaturas
./scripts/sync-copies.sh
```

## 🧪 Testes

```bash
node --test tests/backend.test.js
node tests/e2e.js
```
