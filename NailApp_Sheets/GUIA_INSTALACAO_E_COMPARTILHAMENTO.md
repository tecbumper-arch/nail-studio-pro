# 💅 Guia Passo a Passo: Como Colocar o App no Google Sheets (E Compartilhar com Manicures)

Este aplicativo foi projetado com arquitetura **Mobile-First** (inspirado nos melhores apps de agendamento como *Fresha*, *Trinks* e *iFood*) e conta com **5 camadas de segurança** para rodar 100% gratuito dentro do **Google Sheets + Google Agenda**.

---

## 📱 1. Como Testar Agora Mesmo no Seu Computador (Em 1 Clique)

Você não precisa configurar nada para ver e testar o aplicativo funcionando agora:
1. Abra a pasta [NailApp_Sheets](file:///c:/Users/posve/OneDrive/Documentos/Antigravity/NailApp_Sheets) e dê dois cliques no arquivo [Index.html](file:///c:/Users/posve/OneDrive/Documentos/Antigravity/NailApp_Sheets/Index.html).
2. Para ver no formato de **Celular**, aperte `F12` no navegador e clique no ícone de celular/tablet no topo esquerdo (ou diminua a largura da janela).
3. **Teste como Cliente:**
   * Troque as cores vibrantes nas bolinhas do topo.
   * Toque em um serviço do catálogo, escolha o dia e o horário livre.
   * Escolha **"Pix Valor Total"** ou **"Sinal 50% via Pix"** e clique em Confirmar para ver o **QR Code Pix Oficial** subir na gaveta inferior (*Bottom Sheet*) e o horário ficar bloqueado na hora!
4. **Teste como Manicure (Dona):**
   * Na barra inferior do app, toque em **Manicure** (ícone de escudo).
   * Digite o PIN padrão de teste: **`123456`**.
   * Veja o alerta amarelo piscando mostrando que a cliente optou por Pix e clique em **"Validar Pix"**.
   * Na aba **Cadastrar Catálogo**, envie uma foto do seu computador/celular, coloque o preço e salve.

---

## 🚀 2. Como Colocar na Planilha do Google (Leva 3 Minutos)

1. Acesse [sheets.new](https://sheets.new) logado na sua conta Google para criar uma nova Planilha em branco.
2. Dê um nome para a planilha, por exemplo: **`Modelo App Nail Studio Pro`**.
3. No menu superior da planilha, clique em **Extensões** ➔ **Apps Script**.
4. **Arquivo 1 (`Código.gs`):**
   * Apague todo o texto que estiver lá dentro.
   * Copie todo o conteúdo do arquivo [Code.gs](file:///c:/Users/posve/OneDrive/Documentos/Antigravity/NailApp_Sheets/Code.gs) e cole lá.
5. **Arquivo 2 (`Index.html`):**
   * No menu esquerdo do Apps Script, clique no botão **`+`** ao lado de *Arquivos* e escolha **HTML**.
   * Digite exatamente o nome **`Index`** (com "I" maiúsculo, sem escrever `.html`, pois o Google já coloca sozinho) e aperte Enter.
   * Apague o código que vier nele, copie todo o conteúdo do arquivo [Index.html](file:///c:/Users/posve/OneDrive/Documentos/Antigravity/NailApp_Sheets/Index.html) e cole lá.
6. Clique no ícone de **Disquete (Salvar)** no topo.
7. **Publicar o Link do Aplicativo:**
   * No canto superior direito, clique no botão azul **Implantar** ➔ **Nova implantação**.
   * Clique na engrenagem ao lado de *Selecione o tipo* e escolha **App da Web**.
   * Em **Executar como**, deixe: **`Eu (seu e-mail)`** *(Isso garante que o app use a Planilha e a Agenda da dona!)*.
   * Em **Quem pode acessar**, escolha: **`Qualquer pessoa`** *(Para que as clientes consigam abrir o link e agendar sem erro)*.
   * Clique em **Implantar**, autorize o acesso à sua Planilha e Agenda clicando em *Avançado ➔ Acessar projeto*, e pronto! O Google vai te dar o **Link do Aplicativo**.

---

## 🤝 3. Como Compartilhar com Outras Manicures

Quando você quiser entregar o aplicativo para uma manicure usar na conta Google dela:
1. Na sua planilha modelo, clique no botão **Compartilhar** (canto superior direito) e mude para **"Qualquer pessoa com o link pode ser Leitor"**.
2. Copie o link da sua planilha. Ele será parecido com isto:
   `https://docs.google.com/spreadsheets/d/CODIGO_DA_PLANILHA/edit`
3. Troque a palavra `/edit` no final por **`/copy`**:
   `https://docs.google.com/spreadsheets/d/CODIGO_DA_PLANILHA/copy`
4. Quando a manicure clicar nesse link e logar na conta Google dela, aparecerá um botão **"Fazer uma cópia"**.
5. Assim que ela clicar, a planilha **e todo o código do aplicativo** já estarão salvos no Google Drive dela! Ela só precisará ir em *Extensões ➔ Apps Script ➔ Implantar* para ativar o link exclusivo dela conectado ao **Google Agenda** dela.

---

## 🛡️ 4. Camadas de Segurança Fortes Implementadas

* **Criptografia SHA-256 com Salt Único (`hashSecret`):** O PIN da manicure nunca fica visível em texto puro; ele é transformado em um código criptográfico atrelado ao ID da planilha.
* **Proteção Anti-Força Bruta (`CacheService`):** Se alguém tentar adivinhar o PIN da manicure e errar 5 vezes, o painel bloqueia novas tentativas automaticamente por 10 minutos e grava o alerta na aba `Logs_Seguranca`.
* **Isolamento Total de Dados (`Zero-Leak`):** As clientes que acessam o link veem apenas o catálogo e se um horário está `Livre` ou `Ocupado`. Nenhum nome ou telefone de outras clientes jamais é enviado para o navegador.
* **Trava Atômica Contra Horário Duplo (`LockService`):** Se duas clientes clicarem no horário das `14:00` no mesmo milissegundo, o servidor processa a primeira e avisa a segunda que o horário acabou de ser ocupado.
* **Anti-Fraude no Valor do Pix:** O QR Code Pix (padrão oficial Banco Central EMVCo com verificação CRC16) é calculado dentro do servidor da planilha buscando o preço oficial do serviço, impedindo qualquer alteração de valor pelo navegador.
