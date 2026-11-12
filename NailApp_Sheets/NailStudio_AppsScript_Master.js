/**
 * =========================================================================
 * 💅 NAIL STUDIO PRO - SINCRONIZADOR NATIVO PARA GOOGLE SHEETS & AGENDA
 * =========================================================================
 * Este script roda diretamente dentro da sua Planilha no Google Drive.
 * Ele permite sincronização 100% automática e nativa com o Google Agenda
 * 24 horas por dia, 7 dias por semana, sem precisar de computador ligado!
 * =========================================================================
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('💅 Nail Studio Pro')
    .addItem('📅 Ativar Minha Google Agenda (1 Clique)', 'ativarMinhaGoogleAgenda')
    .addItem('🧪 Testar Conexão com Agenda', 'testarGoogleAgenda')
    .addSeparator()
    .addItem('🔄 Sincronizar Todas as Reservas Pendentes', 'sincronizarTodasReservas')
    .addItem('ℹ️ Status do Studio', 'exibirStatusStudio')
    .addToUi();
}

function ativarMinhaGoogleAgenda() {
  var ui = SpreadsheetApp.getUi();
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var cal = CalendarApp.getDefaultCalendar();
    var email = cal.getName();

    var triggers = ScriptApp.getUserTriggers(ss);
    for (var i = 0; i < triggers.length; i++) {
      var h = triggers[i].getHandlerFunction();
      if (h === 'onSpreadsheetChange' || h === 'autoSyncGoogleCalendarProcess' || h === 'sincronizarTodasReservasSilencioso') {
        ScriptApp.deleteTrigger(triggers[i]);
      }
    }

    ScriptApp.newTrigger('onSpreadsheetChange')
      .forSpreadsheet(ss)
      .onChange()
      .create();

    var cfgSheet = ss.getSheetByName('Configuracoes');
    if (cfgSheet) {
      var data = cfgSheet.getDataRange().getValues();
      for (var j = 0; j < data.length; j++) {
        if (data[j][0] === 'SINCRONIZAR_AGENDA') {
          cfgSheet.getRange(j + 1, 2).setValue('SIM');
          break;
        }
      }
    }

    var count = sincronizarTodasReservasSilencioso();

    ui.alert(
      '🟢 Google Agenda Conectada com Sucesso!',
      'Sua agenda oficial (' + email + ') agora está conectada 24h na nuvem com o Nail Studio Pro!\n\n' +
      '✅ Gatilho automático instalado com sucesso (' + count + ' reservas sincronizadas agora).\n' +
      '✅ Novos agendamentos entram direto no seu calendário.\n' +
      '✅ Cancelamentos liberam seu horário automaticamente.',
      ui.ButtonSet.OK
    );
  } catch (err) {
    ui.alert('Erro ao ativar agenda', 'Detalhes: ' + err.message, ui.ButtonSet.OK);
  }
}

function testarGoogleAgenda() {
  var ui = SpreadsheetApp.getUi();
  try {
    var cal = CalendarApp.getDefaultCalendar();
    var now = new Date();
    var end = new Date(now.getTime() + (30 * 60 * 1000));
    var ev = cal.createEvent('💅 Teste Nail Studio Pro', now, end, {
      description: 'Validação automática de integração com Google Agenda'
    });
    Utilities.sleep(1500);
    ev.deleteEvent();

    ui.alert('🎉 Teste Concluído!', 'O evento de teste foi criado e validado na sua Google Agenda (' + cal.getName() + ') com 100% de sucesso!', ui.ButtonSet.OK);
  } catch (err) {
    ui.alert('Falha no teste', err.message, ui.ButtonSet.OK);
  }
}

function onSpreadsheetChange(e) {
  sincronizarTodasReservasSilencioso();
}

function onEdit(e) {
  try {
    var sheet = e.range.getSheet();
    if (sheet.getName() !== 'Agendamentos') return;
    var row = e.range.getRow();
    if (row <= 1) return;

    // Coluna 12 (índice 11) = StatusReserva, Coluna 13 (índice 12) = CalendarEventID
    var status = sheet.getRange(row, 12).getValue();
    var gcalId = sheet.getRange(row, 13).getValue();

    if (String(status).toUpperCase() === 'CANCELADO' && gcalId && !String(gcalId).startsWith('DELETED_')) {
      try {
        var cal = CalendarApp.getDefaultCalendar();
        var ev = cal.getEventById(gcalId);
        if (ev) ev.deleteEvent();
        sheet.getRange(row, 13).setValue('DELETED_MANUAL');
      } catch (errDel) {}
    }
  } catch (eGeral) {}
}

/**
 * Estrutura de colunas da aba Agendamentos (14 colunas):
 * 0: ID_Reserva | 1: Data | 2: HoraInicio | 3: HoraFim | 4: ClienteNome | 5: ClienteWhatsApp
 * 6: ServicoID  | 7: ServicoNome | 8: Valor | 9: MetodoPagamento | 10: StatusPagamento
 * 11: StatusReserva | 12: CalendarEventID | 13: CriadoEm
 */
function sincronizarTodasReservasSilencioso() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var agSheet = ss.getSheetByName('Agendamentos');
    if (!agSheet) return 0;

    var rows = agSheet.getDataRange().getValues();
    if (rows.length <= 1) return 0;

    var cal = CalendarApp.getDefaultCalendar();
    if (!cal) return 0;

    var syncCount = 0;

    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      var rowNum = i + 1;
      var statusReserva = String(r[11] || '').toUpperCase();
      var gcalId = String(r[12] || '');

      if ((statusReserva === 'RESERVADO' || statusReserva === 'CONFIRMADO') && (!gcalId || gcalId.indexOf('GCAL-') === 0 || gcalId === '')) {
        try {
          var dataStr = String(r[1]);
          var horaIni = String(r[2]);
          var horaFim = String(r[3]);
          var cliente = String(r[4]);
          var whats = String(r[5]);
          var servico = String(r[7] || r[6]);
          var valor = r[8];

          var dParts = dataStr.indexOf('/') !== -1 ? dataStr.split('/') : dataStr.split('-');
          var y = dParts.length === 3 ? (String(dParts[0]).length === 4 ? dParts[0] : dParts[2]) : new Date().getFullYear();
          var m = dParts.length === 3 ? dParts[1] : 1;
          var d = dParts.length === 3 ? (String(dParts[0]).length === 4 ? dParts[2] : dParts[0]) : 1;

          var start = new Date(Number(y), Number(m) - 1, Number(d), Number(horaIni.split(':')[0] || 9), Number(horaIni.split(':')[1] || 0));
          var end = new Date(Number(y), Number(m) - 1, Number(d), Number(horaFim.split(':')[0] || 10), Number(horaFim.split(':')[1] || 0));

          var title = '💅 ' + servico + ' - ' + cliente;
          var desc = 'Cliente: ' + cliente + '\nWhatsApp: ' + whats + '\nProcedimento: ' + servico + '\nValor: R$ ' + Number(valor || 0).toFixed(2);

          var ev = cal.createEvent(title, start, end, { description: desc });
          agSheet.getRange(rowNum, 13).setValue(ev.getId());
          syncCount++;
        } catch (errSync) {}
      }

      if (statusReserva === 'CANCELADO' && gcalId && gcalId.indexOf('DELETED_') !== 0 && gcalId.indexOf('GCAL-') !== 0) {
        try {
          var evOld = cal.getEventById(gcalId);
          if (evOld) evOld.deleteEvent();
          agSheet.getRange(rowNum, 13).setValue('DELETED_AUTO');
        } catch (errDel) {}
      }
    }
    return syncCount;
  } catch (eGeral) {
    return 0;
  }
}

function sincronizarTodasReservas() {
  var ui = SpreadsheetApp.getUi();
  var count = sincronizarTodasReservasSilencioso();
  ui.alert('Sincronização Concluída', count + ' reserva(s) adicionada(s)/atualizada(s) na sua Google Agenda!', ui.ButtonSet.OK);
}

function exibirStatusStudio() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var cfgSheet = ss.getSheetByName('Configuracoes');
  var studioNome = 'Meu Studio';
  var calStatus = 'SIM';

  if (cfgSheet) {
    var data = cfgSheet.getDataRange().getValues();
    for (var i = 0; i < data.length; i++) {
      if (data[i][0] === 'STUDIO_NOME') studioNome = data[i][1];
      if (data[i][0] === 'SINCRONIZAR_AGENDA') calStatus = data[i][1];
    }
  }

  var cal = CalendarApp.getDefaultCalendar();
  ui.alert(
    '💅 Studio: ' + studioNome,
    'Conta Google Agenda: ' + cal.getName() + '\n' +
    'Sincronização Ativa: ' + calStatus + '\n' +
    'Total de Abas: ' + ss.getSheets().length,
    ui.ButtonSet.OK
  );
}

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var action = data.action;
    var eventData = data.eventData;
    var eventId = data.eventId;
    var cal = CalendarApp.getDefaultCalendar();

    if (action === 'CREATE' && eventData) {
      var title = '💅 ' + eventData.servicoNome + ' - ' + eventData.clienteNome;
      var cleanD = eventData.data.indexOf('/') !== -1 ? eventData.data.split('/').reverse().join('-') : eventData.data;
      var start = new Date(cleanD + 'T' + eventData.horaInicio + ':00');
      var end = new Date(cleanD + 'T' + eventData.horaFim + ':00');
      var desc = 'Cliente: ' + eventData.clienteNome + '\nWhatsApp: ' + eventData.clienteWhatsApp + '\nValor: R$ ' + eventData.valor;
      var ev = cal.createEvent(title, start, end, { description: desc });
      return ContentService.createTextOutput(JSON.stringify({ success: true, eventId: ev.getId() })).setMimeType(ContentService.MimeType.JSON);
    }

    if (action === 'DELETE' && eventId) {
      try {
        var ev = cal.getEventById(eventId);
        if (ev) ev.deleteEvent();
      } catch (errDel) {}
      return ContentService.createTextOutput(JSON.stringify({ success: true, deleted: true })).setMimeType(ContentService.MimeType.JSON);
    }

    return ContentService.createTextOutput(JSON.stringify({ success: true, message: 'Operação concluída' })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ success: false, error: err.message })).setMimeType(ContentService.MimeType.JSON);
  }
}
