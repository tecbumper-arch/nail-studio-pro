# 💅 Nail Studio Pro (v2.2 Cloud-Direct 24/7)

Aplicativo Mobile Android (`.APK`) e Plataforma Web SaaS Multi-Contas para **Manicures & Nail Designers**, 100% integrado em tempo real ao **Google Sheets** (banco de dados na nuvem) e ao **Google Agenda** (sincronização automática 24h), sem depender de computador ligado.

---

## 🚀 Links (Cloudflare Worker)

> **Atenção:** as versões ≤ v2.2 (APK antigo, páginas no GitHub Pages / surge.sh) usavam uma credencial Google embutida no código e **devem ser substituídas** pela versão v3 abaixo. Os endereços antigos agora só redirecionam para o Worker.

Substitua `<worker>` pelo endereço do seu Worker (ex.: `https://nail-studio-pro.SEU-SUBDOMINIO.workers.dev`; veja `worker/README.md`).

- 💅 **Painel da Manicure:** `https://<worker>/App_Manicure.html`
- 📅 **Página pública da cliente:** `https://<worker>/Pagina_Cliente.html?s=<id-do-studio>`
- 📲 **APK:** gerar um novo (`android-app/`) apontando para o Worker e distribuir o novo arquivo.

**Arquitetura em 3 linhas:** o navegador/APK só fala com o Cloudflare Worker (`/api/*`); o Worker guarda as credenciais Google como secrets e é o único que acessa Google Sheets e Agenda; as páginas (`worker/public`) não contêm nenhuma credencial.

Guia de deploy: [`worker/README.md`](worker/README.md).

> **Ordem de publicação (não pule):** os redirecionamentos deste repositório ainda apontam para um endereço provisório. Se forem para o `main` (GitHub Pages) antes do Worker, o link de agendamento das clientes quebra.
>
> 1. Publicar o Worker (`worker/README.md`, seções 1 a 3) e testar.
> 2. Anotar o endereço do Worker que o deploy mostrou.
> 3. Rodar o `sed` da seção 5 do `worker/README.md` (troca o endereço provisório pelo real).
> 4. Commit e push dessa troca.
> 5. Só então fazer o merge no `main` / Pages.
> 6. Gerar o APK novo e, por último, desligar a credencial antiga (seção 4).

---

## ✨ Principais Funcionalidades

1. **Autenticação Real com Contas Google do Aparelho (`AccountManager`):**
   - No Android, utiliza o seletor nativo oficial do sistema (`AccountManager.newChooseAccountIntent` para `"com.google"`), permitindo login exclusivo com contas Google reais cadastradas no aparelho.
   - Criação e provisionamento automático da planilha individual do Studio no Google Drive no primeiro acesso.
2. **100% Independente de Computador (Cloudflare Worker):**
   - O APK abre o Worker no WebView; o Worker conversa com as APIs do Google (Sheets e Agenda) usando secrets guardados no servidor.
3. **Sincronização em Tempo Real com Google Agenda:**
   - Novos agendamentos feitos pela cliente ou pela profissional entram automaticamente na Google Agenda.
   - Cancelamentos removem o evento da Google Agenda e liberam o horário na hora.
4. **Pagamento Pix Copia e Cola (Padrão Oficial Banco Central) + Comprovante WhatsApp:**
   - Geração de código BRCode EMV válido (Sinal 50%, Pix Total ou Pagamento no Studio).
5. **CRM de Clientes & Alerta de Manutenção (15+ dias):**
   - Identifica automaticamente clientes que precisam de manutenção de alongamento/blindagem e envia lembrete com 1 toque no WhatsApp.

---

## 📂 Estrutura do Repositório

- `worker/`: Cloudflare Worker (API em `src/`, páginas em `public/`, testes) e guia de deploy.
- `NailApp_Sheets/`: páginas de redirecionamento para o Worker, script Google Apps Script (`Code.gs`) e utilitários legados.
- `android-app/`: Código-fonte nativo do aplicativo Android em Kotlin (`MainActivity.kt`, WebView imersivo, ponte nativa `AndroidNativeBridge` e integração com `AccountManager`).
