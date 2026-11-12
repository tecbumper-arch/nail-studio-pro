# 💅 Nail Studio Pro (v2.2 Cloud-Direct 24/7)

Aplicativo Mobile Android (`.APK`) e Plataforma Web SaaS Multi-Contas para **Manicures & Nail Designers**, 100% integrado em tempo real ao **Google Sheets** (banco de dados na nuvem) e ao **Google Agenda** (sincronização automática 24h), sem depender de computador ligado.

---

## 🚀 Links Oficiais em Produção (24/7)

- 📲 **Download Direto do Aplicativo Android (`NailStudioPro.apk`):**
  - 👉 **[Baixar pela Release Oficial do GitHub (v2.2.0)](https://github.com/tecbumper-arch/nail-studio-pro/releases/latest/download/NailStudioPro.apk)**
  - 👉 **[Baixar pelo Servidor Cloud 24h](https://nailstudiopro-app.surge.sh/NailStudioPro.apk)**
- 💅 **Painel da Manicure (Web / Mobile 24h):**
  - 👉 **[Abrir via GitHub Pages](https://tecbumper-arch.github.io/nail-studio-pro/App_Manicure.html)**
  - 👉 **[Abrir via Servidor Cloud 24h](https://nailstudiopro-app.surge.sh/App_Manicure.html)**
- 📅 **Página Pública de Agendamento da Cliente (24h):**
  - 👉 **[Abrir via GitHub Pages](https://tecbumper-arch.github.io/nail-studio-pro/Pagina_Cliente.html)**
  - 👉 **[Abrir via Servidor Cloud 24h](https://nailstudiopro-app.surge.sh/Pagina_Cliente.html)**

---

## ✨ Principais Funcionalidades

1. **Autenticação Real com Contas Google do Aparelho (`AccountManager`):**
   - No Android, utiliza o seletor nativo oficial do sistema (`AccountManager.newChooseAccountIntent` para `"com.google"`), permitindo login exclusivo com contas Google reais cadastradas no aparelho.
   - Criação e provisionamento automático da planilha individual do Studio no Google Drive no primeiro acesso.
2. **100% Independente de Computador (Arquitetura Cloud-Direct):**
   - O APK carrega instantaneamente a partir dos assets internos (`file:///android_asset/App_Manicure.html`) e comunica-se diretamente com as APIs do Google Cloud (`sheets.googleapis.com` e `googleapis.com/calendar/v3`).
3. **Sincronização em Tempo Real com Google Agenda:**
   - Novos agendamentos feitos pela cliente ou pela profissional entram automaticamente na Google Agenda.
   - Cancelamentos removem o evento da Google Agenda e liberam o horário na hora.
4. **Pagamento Pix Copia e Cola (Padrão Oficial Banco Central) + Comprovante WhatsApp:**
   - Geração de código BRCode EMV válido (Sinal 50%, Pix Total ou Pagamento no Studio).
5. **CRM de Clientes & Alerta de Manutenção (15+ dias):**
   - Identifica automaticamente clientes que precisam de manutenção de alongamento/blindagem e envia lembrete com 1 toque no WhatsApp.

---

## 📂 Estrutura do Repositório

- `NailApp_Sheets/`: Aplicação Web Mobile-First (`App_Manicure.html`, `Pagina_Cliente.html`), script Google Apps Script (`Code.gs`) e utilitários.
- `android-app/`: Código-fonte nativo do aplicativo Android em Kotlin (`MainActivity.kt`, WebView imersivo, ponte nativa `AndroidNativeBridge` e integração com `AccountManager`).
