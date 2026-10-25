/**
 * Puente n8n <-> Google Sheets + Google Calendar
 * ------------------------------------------------
 * n8n llama SIEMPRE a este Web App por POST (application/json):
 *
 *   { "action": "sheets.read",          "secret": "...", "sheet": "Leads" }
 *   { "action": "sheets.append",        "secret": "...", "sheet": "Citas", "row": { ... } }
 *   { "action": "sheets.appendOrUpdate","secret": "...", "sheet": "Leads", "row": { ... }, "matchingColumns": ["id"] }
 *   { "action": "calendar.freebusy",    "secret": "...", "timeMin": "...", "timeMax": "..." }
 *   { "action": "calendar.createEvent", "secret": "...", "summary": "...", "start": "...", "end": "...", "attendees": ["..."] }
 *   { "action": "calendar.diag",        "secret": "..." }   // que cuenta ejecuta y que calendarios ve
 *   { "action": "calendar.deleteEvent", "secret": "...", "eventId": "...", "calendarId": "..." }
 *   { "action": "sheets.ensureColumns", "secret": "...", "sheet": "Citas", "columns": ["calendar_used"] }
 *   { "action": "sheets.deleteRows",    "secret": "...", "sheet": "Citas", "rows": [ {...} ], "matchingColumns": ["cita_id"] }
 *
 * Respuesta: { "ok": true, "data": ... }  |  { "ok": false, "error": "..." }
 *
 * InstalaciÃ³n:
 * 1. crear un Spreadsheet y copiar su ID en CONFIG.SHEET_ID
 * 2. cambiar CONFIG.SECRET por un token largo y aleatorio
 * 3. ejecutar CREAR_HOJAS() una vez (crea las pestaÃ±as y cabeceras)
 * 4. Implementar > Nueva implementaciÃ³n > AplicaciÃ³n web
 *    - Ejecutar como: Yo
 *    - QuiÃ©n tiene acceso: Cualquier usuario
 * 5. copiar la URL /exec en el nodo Config de los workflows
 */

const CONFIG = {
  SHEET_ID: 'YOUR_GOOGLE_SHEET_ID',
  CALENDAR_ID: 'YOUR_CALENDAR_ID',   // cuenta que ejecuta el script (duena de la agenda)
  SECRET: 'YOUR_SHARED_SECRET',
  TZ: 'Europe/Madrid',
  DEFAULT_DURATION_MIN: 30,
  CODE_VERSION: 'v10'
};

const SHEETS = {
  Leads: ['nombre', 'empresa', 'rubro', 'problema', 'procesos_manuales', 'telefono', 'email',
    'id', 'creado', 'canal', 'campana', 'sector', 'tamano', 'quiere_automatizar', 'urgencia', 'decisor', 'interes', 'score',
    'estado', 'resultado', 'objecion', 'proximo_paso', 'fecha_proximo_intento', 'intentos',
    'ultima_llamada', 'call_id', 'ended_reason', 'duracion_seg', 'grabacion_url', 'cita_id',
    'consentimiento', 'notas'],
  Citas: ['fecha', 'hora', 'nombre', 'apellido', 'telefono', 'lead_id', 'estado', 'event_id', 'meet_link', 'creada_por',
    'recordado_24h', 'recordado_1h', 'calendar_used', 'cita_id'],
  Conversaciones: ['conversacion_id', 'lead_id', 'canal', 'inicio', 'fin', 'duracion_seg', 'resumen',
    'resultado', 'transcripcion_ref'],
  Config: ['clave', 'valor'],
  Logs: ['ts', 'workflow', 'error', 'payload']
};

/* ------------------------------- Entradas ------------------------------- */

function doGet() {
  return json_({ ok: true, service: 'n8n-google-bridge', time: new Date().toISOString() });
}

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!body.secret || body.secret !== CONFIG.SECRET) {
      return json_({ ok: false, error: 'unauthorized' });
    }

    let data;
    switch (body.action) {
      case 'ping':
        data = { pong: true, time: new Date().toISOString(), version: CONFIG.CODE_VERSION };
        break;
      case 'sheets.read':
        data = sheetsRead_(body);
        break;
      case 'sheets.append':
        data = withLock_(function () { return sheetsAppend_(body); });
        break;
      case 'sheets.appendOrUpdate':
        data = withLock_(function () { return sheetsAppendOrUpdate_(body); });
        break;
      case 'sheets.ensureColumns':
        data = withLock_(function () { return sheetsEnsureColumns_(body); });
        break;
      case 'calendar.diag':
        data = calendarDiag_();
        break;
      case 'calendar.freebusy':
        data = calendarFreeBusy_(body);
        break;
      case 'calendar.createEvent':
        data = calendarCreateEvent_(body);
        break;
      case 'calendar.deleteEvent':
        data = calendarDeleteEvent_(body);
        break;
      case 'sheets.deleteRows':
        data = withLock_(function () { return sheetsDeleteRows_(body); });
        break;
      case 'sheets.format':
        data = withLock_(function () { return sheetsFormat_(body); });
        break;
      case 'agenda.huecos':
        data = agendaHuecos_(body);
        break;
      case 'agenda.agendar':
        data = withLock_(function () { return agendaAgendar_(body); });
        break;
      case 'agenda.reagendar':
        data = withLock_(function () { return agendaReagendar_(body); });
        break;
      case 'agenda.cancelar':
        data = withLock_(function () { return agendaCancelar_(body); });
        break;
      default:
        throw new Error('Accion no soportada: ' + body.action);
    }

    return json_({ ok: true, data: data });
  } catch (err) {
    return json_({ ok: false, error: (err && err.message) ? err.message : String(err) });
  }
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    return fn();
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
}

/* -------------------------------- Sheets -------------------------------- */

function sheetsRead_(body) {
  const sh = getSheet_(body.sheet);
  const values = sh.getDataRange().getValues();
  if (!values.length) return [];

  const headers = values[0].map(function (h) { return String(h).trim(); });
  const out = [];

  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (row.every(function (c) { return c === '' || c === null; })) continue;

    const obj = {};
    for (let c = 0; c < headers.length; c++) {
      if (headers[c]) obj[keyForHeader_(headers[c])] = normalizeCell_(row[c]);
    }
    out.push(obj);
  }
  return out;
}

function sheetsAppend_(body) {
  const sh = getSheet_(body.sheet);
  const headers = getHeaders_(sh);
  const row = body.row || {};

  const valores = headers.map(function (h) {
    const k = keyForHeader_(h);
    return row[k] === undefined || row[k] === null ? '' : row[k];
  });
  sh.appendRow(valores);
  forceText_(sh, sh.getLastRow(), headers, valores);

  return {
    appended: true,
    row: sh.getLastRow(),
    ignored: Object.keys(row).filter(function (k) {
      return !headers.some(function (h) { return keyForHeader_(h) === k; }) && k.indexOf('_') !== 0;
    })
  };
}

function sheetsAppendOrUpdate_(body) {
  const sh = getSheet_(body.sheet);
  const headers = getHeaders_(sh);
  const row = body.row || {};

  const keys = ((body.matchingColumns && body.matchingColumns.length)
    ? body.matchingColumns
    : ['id']).filter(function (k) {
    return headers.some(function (h) { return keyForHeader_(h) === k; });
  });

  if (!keys.length) {
    throw new Error('matchingColumns no existe en las cabeceras de ' + body.sheet);
  }

  const lastRow = sh.getLastRow();
  let target = -1;

  if (lastRow > 1) {
    const data = sh.getRange(2, 1, lastRow - 1, headers.length).getValues();
    const idx = keys.map(function (k) {
      return headers.findIndex(function (h) { return keyForHeader_(h) === k; });
    });

    for (let i = 0; i < data.length; i++) {
      const match = keys.every(function (k, n) {
        return String(normalizeCell_(data[i][idx[n]])) === String(row[k] === undefined ? '' : row[k]);
      });
      if (match) { target = i + 2; break; }
    }
  }

  if (target > 0) {
    const current = sh.getRange(target, 1, 1, headers.length).getValues()[0];
    const merged = headers.map(function (h, i) {
      const k = keyForHeader_(h);
      return (row[k] === undefined || row[k] === null) ? current[i] : row[k];
    });
    sh.getRange(target, 1, 1, headers.length).setValues([merged]);
    forceText_(sh, target, headers, merged);
    return { updated: true, row: target };
  }

  const valores = headers.map(function (h) {
    const k = keyForHeader_(h);
    return row[k] === undefined || row[k] === null ? '' : row[k];
  });
  sh.appendRow(valores);
  forceText_(sh, sh.getLastRow(), headers, valores);
  return { appended: true, row: sh.getLastRow() };
}

function sheetsEnsureColumns_(body) {
  const sh = getSheet_(body.sheet);
  const headers = getHeaders_(sh);
  const wanted = (body.columns || []).filter(String);
  const added = [];

  wanted.forEach(function (col) {
    const exists = headers.some(function (h) { return keyForHeader_(h) === col; });
    if (!exists) {
      sh.getRange(1, headers.length + 1).setValue(labelFor_(col)).setFontWeight('bold');
      headers.push(labelFor_(col));
      added.push(col);
    }
  });

  return { sheet: body.sheet, columnas: headers, anadidas: added };
}

/* Reordena columnas, pone titulos legibles y aplica formato.
   Con body.rebuild=true y body.rows reconstruye desde cero. */
function sheetsFormat_(body) {
  const sh = getSheet_(body.sheet);
  const order = (body.order || []).filter(String);
  let finalKeys;
  let out;

  if (body.rebuild && Array.isArray(body.rows)) {
    finalKeys = order.slice();
    out = [finalKeys.map(labelFor_)];
    for (let r = 0; r < body.rows.length; r++) {
      const row = body.rows[r] || {};
      out.push(finalKeys.map(function (k) {
        const v = row[k];
        return v === undefined || v === null ? '' : v;
      }));
    }
  } else {
    const values = sh.getDataRange().getValues();
    if (!values.length) throw new Error('Hoja vacia: ' + body.sheet);
    const currentHeaders = values[0].map(function (h) { return String(h).trim(); });
    const currentKeys = currentHeaders.map(function (h) { return keyForHeader_(h); });

    finalKeys = order.filter(function (k) { return currentKeys.indexOf(k) !== -1; });
    currentKeys.forEach(function (k) { if (finalKeys.indexOf(k) === -1) finalKeys.push(k); });

    out = [finalKeys.map(labelFor_)];
    for (let r = 1; r < values.length; r++) {
      out.push(finalKeys.map(function (k) {
        const ci = currentKeys.indexOf(k);
        return ci === -1 ? '' : values[r][ci];
      }));
    }
  }

  if (!finalKeys.length) throw new Error('Sin columnas para ' + body.sheet);
  sh.clear();
  sh.clearConditionalFormatRules();
  if (out.length) sh.getRange(1, 1, out.length, out[0].length).setValues(out);
  if (out.length > 1) {
    for (let r = 1; r < out.length; r++) forceText_(sh, r + 1, finalKeys, out[r]);
  }

  const nCols = out[0].length;
  const nRows = out.length;

  const head = sh.getRange(1, 1, 1, nCols);
  head.setFontWeight('bold')
    .setFontColor('#FFFFFF')
    .setBackground('#7B2D4E')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle')
    .setWrap(true)
    .setFontSize(10);
  sh.setRowHeight(1, 40);
  sh.setFrozenRows(1);
  sh.setFrozenColumns(0);

  if (nRows > 1) {
    const data = sh.getRange(2, 1, nRows - 1, nCols);
    data.setVerticalAlignment('middle').setFontSize(10).setWrap(false);
    data.setBorder(true, true, true, true, true, true, '#D9D9D9', SpreadsheetApp.BorderStyle.SOLID);
    for (let r = 1; r < nRows; r += 2) {
      sh.getRange(r + 1, 1, 1, nCols).setBackground('#F7F3F5');
    }
  }

  const widths = body.widths || {};
  const centerKeys = body.center || [];
  const wrapKeys = body.wrap || [];
  const textKeys = body.textKeys || [];
  finalKeys.forEach(function (k, i) {
    sh.setColumnWidth(i + 1, Number(widths[k] || 130));
    if (nRows > 1) {
      if (centerKeys.indexOf(k) !== -1) {
        sh.getRange(2, i + 1, nRows - 1, 1).setHorizontalAlignment('center');
      }
      if (wrapKeys.indexOf(k) !== -1) {
        sh.getRange(2, i + 1, nRows - 1, 1).setWrap(true);
      }
      if (textKeys.indexOf(k) !== -1) {
        sh.getRange(2, i + 1, Math.max(sh.getMaxRows() - 1, 1), 1).setNumberFormat('@');
      }
    }
  });

  if (body.statusKey) {
    const si = finalKeys.indexOf(body.statusKey);
    if (si !== -1) {
      const reglas = [
        ['cita_agendada', '#C6EFCE', '#006100'],
        ['confirmada', '#C6EFCE', '#006100'],
        ['cancelada', '#FFC7CE', '#9C0006'],
        ['reagendada', '#DDEBF7', '#1F4E78'],
        ['contactado', '#FFEB9C', '#9C6500'],
        ['no_interesado', '#FFC7CE', '#9C0006'],
        ['reintentar', '#DDEBF7', '#1F4E78'],
        ['humano', '#E4DFEC', '#5B2C6F'],
        ['nurture', '#EDEDED', '#595959']
      ];
      const cf = [];
      const rango = sh.getRange(2, si + 1, Math.max(nRows - 1, 1), 1);
      for (let i = 0; i < reglas.length; i++) {
        cf.push(SpreadsheetApp.newConditionalFormatRule()
          .whenTextEqualTo(reglas[i][0])
          .setBackground(reglas[i][1])
          .setFontColor(reglas[i][2])
          .setRanges([rango])
          .build());
      }
      sh.setConditionalFormatRules(cf.concat(sh.getConditionalFormatRules()));
    }
  }

  return { sheet: body.sheet, columnas: finalKeys.map(labelFor_), filas: nRows - 1 };
}

function getSheet_(name) {
  if (!name) throw new Error('Falta el parametro "sheet"');
  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  const sh = ss.getSheetByName(name);
  if (!sh) throw new Error('Hoja no encontrada: ' + name);
  return sh;
}

function getHeaders_(sh) {
  const lastCol = sh.getLastColumn();
  if (!lastCol) throw new Error('La hoja ' + sh.getName() + ' no tiene cabeceras');
  return sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
}

/* ---------------------- Cabeceras legibles ---------------------- */
/* Etiqueta visible -> clave interna que usa n8n. La normalizacion permite
   que "CampaÃ±a" siga casando con la clave "campana" (sin acentos ni mayusculas). */
const HEADER_LABELS = {
  id: 'ID', creado: 'Creado', canal: 'Canal', campana: 'Campana', nombre: 'Nombre', apellido: 'Apellido', rubro: 'Rubro',
  empresa: 'Empresa', sector: 'Sector', tamano: 'Tamano', telefono: 'Telefono',
  email: 'Email', problema: 'Problema', procesos_manuales: 'Procesos manuales',
  quiere_automatizar: 'Quiere automatizar', urgencia: 'Urgencia', decisor: 'Decisor',
  interes: 'Interes', score: 'Score', estado: 'Estado', resultado: 'Resultado',
  objecion: 'Objecion', proximo_paso: 'Proximo paso', fecha_proximo_intento: 'Fecha proximo intento',
  intentos: 'Intentos', ultima_llamada: 'Ultima llamada', call_id: 'Call ID',
  ended_reason: 'Ended reason', duracion_seg: 'Duracion seg', grabacion_url: 'Grabacion URL',
  cita_id: 'Cita ID', fecha: 'Fecha', hora: 'Hora', apellido: 'Apellido', consentimiento: 'Consentimiento', notas: 'Notas',
  lead_id: 'Lead ID', inicio: 'Inicio', fin: 'Fin', event_id: 'Event ID',
  meet_link: 'Meet link', creada_por: 'Creada por', recordado_24h: 'Recordado 24h',
  recordado_1h: 'Recordado 1h', calendar_used: 'Calendar used',
  conversacion_id: 'Conversacion ID', resumen: 'Resumen', transcripcion_ref: 'Transcripcion ref'
};

function normKey_(s) {
  return String(s == null ? '' : s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function keyForHeader_(h) {
  const n = normKey_(h);
  for (const k in HEADER_LABELS) {
    if (normKey_(HEADER_LABELS[k]) === n) return k;
  }
  return n;
}

function labelFor_(key) {
  return HEADER_LABELS[key] || key;
}

/* Fuerza a texto las columnas que no deben convertirse a numero (telefono, ids).
   Se hace celda a celda DESPUES de escribir, porque appendRow re-interpreta el valor. */
const TEXT_COLUMNS = ['telefono', 'id', 'lead_id', 'cita_id', 'call_id', 'event_id', 'conversacion_id', 'fecha', 'hora'];

function forceText_(sh, fila, headers, valores) {
  for (let i = 0; i < headers.length; i++) {
    if (TEXT_COLUMNS.indexOf(keyForHeader_(headers[i])) === -1) continue;
    const v = valores[i];
    if (v === '' || v === null || v === undefined) continue;
    const celda = sh.getRange(fila, i + 1);
    celda.setNumberFormat('@');
    celda.setValue(String(v));
  }
}

function normalizeCell_(v) {
  if (v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') return v.toISOString();
  return v;
}

/* ------------------------------- Calendar ------------------------------- */

function calendarFreeBusy_(body) {
  const timeMin = body.timeMin || new Date().toISOString();
  const timeMax = body.timeMax || new Date(Date.now() + 14 * 86400000).toISOString();
  const calId = body.calendarId || CONFIG.CALENDAR_ID;

  // Servicio avanzado Calendar.Freebusy (si esta anadido en el editor: Servicios > Calendar API)
  if (typeof Calendar !== 'undefined' && Calendar.Freebusy) {
    try {
      const res = Calendar.Freebusy.query({
        timeMin: timeMin,
        timeMax: timeMax,
        timeZone: CONFIG.TZ,
        items: [{ id: calId }]
      });
      const key = Object.keys(res.calendars || {})[0];
      return (res.calendars && res.calendars[key] && res.calendars[key].busy) || [];
    } catch (e) {
      Logger.log('Calendar.Freebusy no disponible: ' + e.message);
    }
  }

  try {
    const res = UrlFetchApp.fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      payload: JSON.stringify({
        timeMin: timeMin,
        timeMax: timeMax,
        timeZone: CONFIG.TZ,
        items: [{ id: calId }]
      }),
      muteHttpExceptions: true
    });

    const txt = res.getContentText();
    if (res.getResponseCode() >= 300) {
      throw new Error('freeBusy ' + res.getResponseCode() + ': ' + txt);
    }

    const parsed = JSON.parse(txt);
    const key = Object.keys(parsed.calendars || {})[0];
    return (parsed.calendars && parsed.calendars[key] && parsed.calendars[key].busy) || [];
  } catch (err) {
    Logger.log('freeBusy REST no disponible, usando CalendarApp: ' + err.message);
    return calendarBusyFallback_(timeMin, timeMax, calId);
  }
}

/**
 * Resuelve el calendario de trabajo.
 * Orden: calendarId explicito -> CONFIG.CALENDAR_ID -> calendario por defecto.
 * Devuelve SIEMPRE el id que se ha usado, para no crear eventos en un calendario
 * equivocado sin darse cuenta.
 */
function resolverCalendario_(calId, permitirDefecto) {
  const objetivo = String(calId || CONFIG.CALENDAR_ID || '').trim();

  if (objetivo) {
    let cal = null;
    try { cal = CalendarApp.getCalendarById(objetivo); } catch (e) { cal = null; }

    if (!cal) {
      const todos = CalendarApp.getAllCalendars();
      for (let i = 0; i < todos.length; i++) {
        if (String(todos[i].getId()) === objetivo || String(todos[i].getName()) === objetivo) {
          cal = todos[i];
          break;
        }
      }
    }

    if (cal) return { cal: cal, id: String(cal.getId()), exacto: true, pedido: objetivo };
  }

  if (permitirDefecto === false) {
    throw new Error('No puedo acceder al calendario "' + objetivo +
      '". Ejecuta {action:"calendar.diag"} para ver que calendarios ve el script.');
  }

  const def = CalendarApp.getDefaultCalendar();
  return {
    cal: def,
    id: def ? String(def.getId()) : '',
    exacto: false,
    pedido: objetivo,
    aviso: objetivo ? 'No tengo acceso a "' + objetivo + '". He usado el calendario por defecto.' : ''
  };
}

function calendarDiag_() {
  const def = CalendarApp.getDefaultCalendar();
  const target = CONFIG.CALENDAR_ID;

  let targetCal = null;
  try { targetCal = CalendarApp.getCalendarById(target); } catch (e) { targetCal = null; }

  let ejecutaComo = '', usuarioActivo = '';
  try { ejecutaComo = Session.getEffectiveUser().getEmail(); } catch (e) { ejecutaComo = 'error: ' + e.message; }
  try { usuarioActivo = Session.getActiveUser().getEmail(); } catch (e) { usuarioActivo = 'error: ' + e.message; }

  return {
    ejecuta_como: ejecutaComo,
    usuario_activo: usuarioActivo,
    calendar_id_configurado: target,
    calendar_configurado_accesible: !!targetCal,
    calendar_por_defecto: def ? String(def.getId()) : null,
    calendar_por_defecto_nombre: def ? def.getName() : null,
    calendarios_visibles: CalendarApp.getAllCalendars().map(function (c) {
      let propio = null;
      try { propio = c.isOwnedByMe(); } catch (e) {}
      return { id: String(c.getId()), nombre: c.getName(), propio: propio };
    })
  };
}

function calendarBusyFallback_(timeMin, timeMax, calId) {
  const r = resolverCalendario_(calId, true);
  const cal = r.cal;
  if (!cal) throw new Error('No se puede acceder al calendario ' + calId);
  Logger.log('freeBusy fallback usando calendario: ' + r.id + (r.exacto ? '' : ' (NO pedido)'));

  return cal.getEvents(new Date(timeMin), new Date(timeMax)).map(function (ev) {
    return {
      start: ev.getStartTime().toISOString(),
      end: ev.getEndTime().toISOString()
    };
  });
}

function calendarCreateEvent_(body) {
  if (!body.start || !body.end) throw new Error('Faltan start/end');

  const calId = body.calendarId || CONFIG.CALENDAR_ID;
  const attendees = (body.attendees || []).filter(String);

  const event = {
    summary: body.summary || 'Reunion',
    description: body.description || '',
    start: { dateTime: toIso_(body.start), timeZone: body.timeZone || CONFIG.TZ },
    end: { dateTime: toIso_(body.end), timeZone: body.timeZone || CONFIG.TZ },
    attendees: attendees.map(function (email) { return { email: email }; }),
    conferenceData: {
      createRequest: {
        requestId: 'n8n-' + Utilities.getUuid(),
        conferenceSolutionKey: { type: 'hangoutsMeet' }
      }
    }
  };

  let apiError = '';

  // 1) Servicio avanzado Calendar (unico camino fiable para generar el enlace de Meet)
  if (typeof Calendar !== 'undefined' && Calendar.Events) {
    try {
      const ev = Calendar.Events.insert(event, calId, {
        conferenceDataVersion: 1,
        sendUpdates: body.sendUpdates || 'all'
      });
      return {
        id: ev.id,
        htmlLink: ev.htmlLink || '',
        hangoutLink: ev.hangoutLink || '',
        start: ev.start,
        end: ev.end,
        meet: !!ev.hangoutLink,
        calendarUsed: calId,
        via: 'calendar-advanced-service'
      };
    } catch (e) {
      apiError = 'Calendar.Events: ' + e.message;
    }
  } else {
    apiError = 'servicio avanzado Calendar no anadido en el editor';
  }

  // 2) REST con el token del script
  try {
    const url = 'https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(calId) +
      '/events?conferenceDataVersion=1&sendUpdates=' + encodeURIComponent(body.sendUpdates || 'all');

    const res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      payload: JSON.stringify(event),
      muteHttpExceptions: true
    });

    const txt = res.getContentText();
    if (res.getResponseCode() < 300) {
      const ev = JSON.parse(txt);
      return {
        id: ev.id,
        htmlLink: ev.htmlLink || '',
        hangoutLink: ev.hangoutLink || '',
        start: ev.start,
        end: ev.end,
        meet: !!ev.hangoutLink,
        calendarUsed: calId,
        via: 'calendar-rest'
      };
    }
    apiError += ' | REST ' + res.getResponseCode() + ': ' + txt.slice(0, 200);
  } catch (e) {
    apiError += ' | REST: ' + e.message;
  }

  // 3) CalendarApp (funciona siempre, pero SIN Meet)
  const out = createWithCalendarApp_(body, calId, apiError);
  out.apiError = apiError;
  return out;
}

function createWithCalendarApp_(body, calId, apiError) {
  const r = resolverCalendario_(calId, true);
  const cal = r.cal;
  if (!cal) throw new Error('No puedo acceder a ningun calendario para crear el evento');

  const ev = cal.createEvent(
    body.summary || 'Reunion',
    new Date(body.start),
    new Date(body.end),
    {
      description: (body.description || '') + '\n(Meet no disponible: ' + String(apiError).slice(0, 180) + ')',
      guests: (body.attendees || []).filter(String).join(','),
      sendInvites: true
    }
  );

  return {
    id: ev.getId(),
    htmlLink: '',
    hangoutLink: '',
    start: ev.getStartTime().toISOString(),
    end: ev.getEndTime().toISOString(),
    meet: false,
    calendarUsed: r.id,
    calendarRequested: r.pedido,
    via: 'calendar-app',
    warning: (r.aviso ? r.aviso + ' ' : '') + 'Evento creado con CalendarApp (sin Meet)'
  };
}

function calendarDeleteEvent_(body) {
  if (!body.eventId) throw new Error('Falta eventId');
  const r = resolverCalendario_(body.calendarId, true);
  if (!r.cal) throw new Error('No puedo acceder a ningun calendario');

  let borrado = false;
  let error = '';

  try {
    const url = 'https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(r.id) +
      '/events/' + encodeURIComponent(body.eventId) + '?sendUpdates=all';
    const res = UrlFetchApp.fetch(url, {
      method: 'delete',
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() < 300) borrado = true;
    else error = 'REST ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 150);
  } catch (e) {
    error = e.message;
  }

  if (!borrado) {
    try {
      const ev = r.cal.getEventById(body.eventId);
      if (ev) { ev.deleteEvent(); borrado = true; error = ''; }
      else error += ' | getEventById devolvio null';
    } catch (e) {
      error += ' | ' + e.message;
    }
  }

  return { borrado: borrado, eventId: body.eventId, calendarUsed: r.id, error: borrado ? '' : error };
}

function sheetsDeleteRows_(body) {
  const sh = getSheet_(body.sheet);
  const headers = getHeaders_(sh);
  const keys = ((body.matchingColumns && body.matchingColumns.length)
    ? body.matchingColumns
    : ['id']).filter(function (k) {
    return headers.some(function (h) { return keyForHeader_(h) === k; });
  });

  if (!keys.length) throw new Error('matchingColumns no existe en las cabeceras de ' + body.sheet);

  const targets = body.rows || [];
  const lastRow = sh.getLastRow();
  if (lastRow < 2 || !targets.length) return { borradas: 0 };

  const data = sh.getRange(2, 1, lastRow - 1, headers.length).getValues();
  const idx = keys.map(function (k) {
    return headers.findIndex(function (h) { return keyForHeader_(h) === k; });
  });
  const filas = [];

  for (let i = data.length - 1; i >= 0; i--) {
    const coincide = targets.some(function (t) {
      return keys.every(function (k, n) {
        return String(normalizeCell_(data[i][idx[n]])) === String(t[k] === undefined ? '' : t[k]);
      });
    });
    if (coincide) filas.push(i + 2);
  }

  filas.sort(function (a, b) { return b - a; }).forEach(function (fila) { sh.deleteRow(fila); });
  return { sheet: body.sheet, borradas: filas.length, filas: filas };
}

function toIso_(value) {
  if (!value) throw new Error('Fecha vacia');
  return new Date(value).toISOString();
}

/* ------------------------------- Utilidades ----------------------------- */

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* --------------------------- Setup (ejecutar 1 vez) ---------------------- */

function CREAR_HOJAS() {
  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);

  Object.keys(SHEETS).forEach(function (name) {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);

    const headers = SHEETS[name];
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  });

  const prueba = ss.getSheetByName('Leads');
  if (prueba && prueba.getLastRow() === 1) {
    prueba.appendRow([
      'L-0001', new Date().toISOString(), 'voz', 'demo', 'Laura', 'Talleres Ruiz', 'automocion', '12',
      '+34600111222', 'laura@talleresruiz.es', 'presupuestos manuales', 'presupuestos y facturas',
      'presupuestos', 'alta', 'si', 'alto', 75, 'nuevo', '', '', 'reunion de diagnostico', '', 0, '',
      '', '', 0, '', '', 'si', 'fila de ejemplo, puedes borrarla'
    ]);
  }

  return 'Hojas creadas/actualizadas: ' + Object.keys(SHEETS).join(', ');
}

function PROBAR() {
  const res = calendarFreeBusy_({
    timeMin: new Date().toISOString(),
    timeMax: new Date(Date.now() + 7 * 86400000).toISOString()
  });
  Logger.log('freeBusy OK: ' + JSON.stringify(res));
}

/* ------------------------- Agenda compartida (voz y chat) ------------------------- */
/* Las usan los dos agentes. La validacion de horario y de hueco libre va aqui,
   no en el modelo, para que nunca se reserve una hora que no este libre. */

const AGENDA = {
  MANANA: [[9, 0], [11, 0]],
  TARDE: [[14, 0], [17, 0]],
  PASO_MIN: 30,
  ANTICIPO_MIN: 180,
  BUFFER_MIN: 15,
  DIAS_MAX: 3,
  DIAS_SEMANA: { lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6 }
};

const DIAS_ES = ['domingo', 'lunes', 'martes', 'mi\u00e9rcoles', 'jueves', 'viernes', 's\u00e1bado'];
const MESES_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function normTxt_(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function pad2_(n) {
  return (n < 10 ? '0' : '') + n;
}

function weekdayNum_(d) {
  return Number(Utilities.formatDate(d, CONFIG.TZ, 'u'));
}

function offsetMin_(d) {
  const z = Utilities.formatDate(d, CONFIG.TZ, 'Z');
  const sign = z.charAt(0) === '-' ? -1 : 1;
  return sign * (parseInt(z.substr(1, 2), 10) * 60 + parseInt(z.substr(3, 2), 10));
}

function localToDate_(fechaStr, hh, mm) {
  const t0 = Date.parse(fechaStr + 'T' + pad2_(hh) + ':' + pad2_(mm) + ':00Z');
  const off1 = offsetMin_(new Date(t0));
  let inst = t0 - off1 * 60000;
  const off2 = offsetMin_(new Date(inst));
  if (off2 !== off1) inst = t0 - off2 * 60000;
  return new Date(inst);
}

function etiquetaEs_(d) {
  const dia = DIAS_ES[weekdayNum_(d) % 7];
  const diaMes = Number(Utilities.formatDate(d, CONFIG.TZ, 'd'));
  const mes = MESES_ES[Number(Utilities.formatDate(d, CONFIG.TZ, 'M')) - 1];
  return dia + ' ' + diaMes + ' de ' + mes + ' a las ' + Utilities.formatDate(d, CONFIG.TZ, 'HH:mm');
}

function isoTz_(d) {
  return Utilities.formatDate(d, CONFIG.TZ, "yyyy-MM-dd'T'HH:mm:ss.SSSXXX");
}

function agendaHuecos_(body) {
  const calId = body.calendarId || CONFIG.CALENDAR_ID;
  const ahora = Date.now();
  const minStart = ahora + AGENDA.ANTICIPO_MIN * 60000;
  const desdeMs = body.desde ? new Date(body.desde).getTime() : ahora;
  const hastaMs = body.hasta ? new Date(body.hasta).getTime() : ahora + 14 * 86400000;
  const pref = normTxt_(body.preferencia);
  const diaPedido = Object.keys(AGENDA.DIAS_SEMANA).filter(function (k) { return pref.indexOf(k) !== -1; })[0];

  const busy = calendarFreeBusy_({
    calendarId: calId,
    timeMin: new Date(Math.max(desdeMs, ahora)).toISOString(),
    timeMax: new Date(hastaMs + 86400000).toISOString()
  }) || [];
  const busyIv = busy.map(function (b) { return [new Date(b.start).getTime(), new Date(b.end).getTime()]; });

  const slots = [];
  let dias = 0;
  for (let d = 0; d < 21 && dias < AGENDA.DIAS_MAX; d++) {
    const fecha = Utilities.formatDate(new Date(ahora + d * 86400000), CONFIG.TZ, 'yyyy-MM-dd');
    const wd = weekdayNum_(localToDate_(fecha, 12, 0));
    if (wd === 7) continue;
    if (diaPedido && wd !== AGENDA.DIAS_SEMANA[diaPedido]) continue;
    const libres = [];
    [AGENDA.MANANA, AGENDA.TARDE].forEach(function (f) {
      const fin0 = f[1][0] * 60 + f[1][1];
      for (let min = f[0][0] * 60 + f[0][1]; min + AGENDA.PASO_MIN <= fin0; min += AGENDA.PASO_MIN) {
        const ini = localToDate_(fecha, Math.floor(min / 60), min % 60);
        const fin = ini.getTime() + AGENDA.PASO_MIN * 60000;
        if (ini.getTime() < minStart || ini.getTime() < desdeMs || ini.getTime() > hastaMs) continue;
        const choca = busyIv.some(function (b) {
          return ini.getTime() < b[1] + AGENDA.BUFFER_MIN * 60000 && fin > b[0] - AGENDA.BUFFER_MIN * 60000;
        });
        if (!choca) libres.push(ini);
      }
    });
    if (!libres.length) continue;
    dias++;
    libres.forEach(function (ini) {
      slots.push({ inicio: isoTz_(ini), texto: etiquetaEs_(ini) });
    });
  }
  return { slots: slots, total: slots.length, preferencia: diaPedido || '' };
}


/* ================= AVISO TELEGRAM ================= */

function telegramSend_(text) {
  const props = PropertiesService.getScriptProperties();

  const token = props.getProperty('TELEGRAM_BOT_TOKEN');
  const chatId = props.getProperty('TELEGRAM_CHAT_ID');

  if (!token || !chatId) {
    throw new Error(
      'Faltan TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID'
    );
  }

  const response = UrlFetchApp.fetch(
    'https://api.telegram.org/bot' + token + '/sendMessage',
    {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        chat_id: chatId,
        text: text,
        disable_web_page_preview: true
      }),
      muteHttpExceptions: true
    }
  );

  const code = response.getResponseCode();
  const result = response.getContentText();

  if (code >= 300) {
    throw new Error('Telegram ' + code + ': ' + result);
  }

  return JSON.parse(result);
}


/* ================= AGENDA AGENDAR ================= */

function agendaAgendar_(body) {
  const calId = body.calendarId || CONFIG.CALENDAR_ID;
  const ini = new Date(body.inicio);

  if (isNaN(ini.getTime())) {
    throw new Error('inicio no es una fecha valida');
  }

  const fin = new Date(
    ini.getTime() + AGENDA.PASO_MIN * 60000
  );

  const hh = Number(
    Utilities.formatDate(ini, CONFIG.TZ, 'H')
  );

  const mm = Number(
    Utilities.formatDate(ini, CONFIG.TZ, 'm')
  );

  const min = hh * 60 + mm;
  const wd = weekdayNum_(ini);

  const enFranja =
    wd !== 7 &&
    (
      (min >= 540 && min + 30 <= 660) ||
      (min >= 840 && min + 30 <= 1020)
    );

  if (!enFranja) {
    return {
      ok: false,
      motivo: 'fuera_de_horario',
      alternativas: agendaHuecos_({
        calendarId: calId,
        desde: ini.toISOString()
      }).slots.slice(0, 6)
    };
  }

  if (
    ini.getTime() <
    Date.now() + AGENDA.ANTICIPO_MIN * 60000
  ) {
    return {
      ok: false,
      motivo: 'demasiado_pronto',
      alternativas: agendaHuecos_({
        calendarId: calId
      }).slots.slice(0, 6)
    };
  }

  const busy = calendarFreeBusy_({
    calendarId: calId,
    timeMin: ini.toISOString(),
    timeMax: fin.toISOString()
  }) || [];

  if (busy.length) {
    return {
      ok: false,
      motivo: 'ocupado',
      alternativas: agendaHuecos_({
        calendarId: calId,
        desde: ini.toISOString()
      }).slots.slice(0, 6)
    };
  }

  const partes = [
    body.nombre,
    body.empresa,
    body.problema,
    body.telefono ? 'Tel ' + body.telefono : '',
    body.canal ? 'Canal ' + body.canal : ''
  ];

  const ev = calendarCreateEvent_({
    calendarId: calId,
    summary:
      'Diagnostico Rose Holding IA - ' +
      (body.empresa || body.nombre || 'prospecto'),
    description: partes.filter(Boolean).join(' | '),
    start: ini.toISOString(),
    end: fin.toISOString(),
    timeZone: CONFIG.TZ,
    attendees: []
  });

  const citaId =
    body.cita_id ||
    ('CIT-' + Utilities.getUuid().slice(0, 8));

  const meet = ev.hangoutLink || body.meet_link || '';

  sheetsAppend_({
    sheet: 'Citas',
    row: {
      cita_id: citaId,
      lead_id: body.lead_id || '',
      fecha: Utilities.formatDate(
        ini,
        CONFIG.TZ,
        'dd/MM/yyyy'
      ),
      hora: Utilities.formatDate(
        ini,
        CONFIG.TZ,
        'HH:mm'
      ),
      estado: 'cita_agendada',
      event_id: ev.id || '',
      meet_link: meet,
      creada_por: body.creada_por || 'agente',
      nombre: body.nombre || '',
      apellido: body.apellido || '',
      telefono: body.telefono || '',
      calendar_used: ev.calendarUsed || calId
    }
  });

  if (body.notificar === true && ev.id) {
    try {
      telegramSend_(
        'CITA NUEVA (WhatsApp)\n' +
        (body.nombre || 'Sin nombre') +
        ' - ' +
        (body.empresa || 'Sin empresa') +
        '\nProblema: ' +
        (body.problema || 'No indicado') +
        '\n' +
        etiquetaEs_(ini) +
        ' (hora de Madrid, 30 min)\n' +
        'Tel: ' +
        (body.telefono || 'No disponible') +
        '\nLead: ' +
        (body.lead_id || '-') +
        '\n' +
        (meet ? 'Enlace: ' + meet + '\n' : '') +
        '\nEnvÃ­ale el enlace por WhatsApp.'
      );
    } catch (error) {
      Logger.log(
        'Error enviando aviso a Telegram: ' +
        error.message
      );
    }
  }

  return {
    ok: true,
    cita_id: citaId,
    event_id: ev.id || '',
    meet_link: meet,
    texto: etiquetaEs_(ini)
  };
}

/* ----------------------- Cancelar y reagendar ----------------------- */

function citaBuscar_(body) {
  const citas = sheetsRead_({ sheet: 'Citas' });
  const telefono = normalizarTelefono_(body.telefono || '');

  let candidatos = citas.filter(function (c) {
    return String(c.estado || '') !== 'cancelada' &&
      String(c.estado || '') !== 'reagendada';
  });

  if (body.cita_id) {
    candidatos = candidatos.filter(function (c) {
      return String(c.cita_id || '') === String(body.cita_id);
    });
  } else if (body.event_id) {
    candidatos = candidatos.filter(function (c) {
      return String(c.event_id || '') === String(body.event_id);
    });
  } else if (telefono) {
    candidatos = candidatos.filter(function (c) {
      return normalizarTelefono_(c.telefono || '') === telefono;
    });

    // Compatibilidad con citas antiguas sin telÃ©fono: busca el lead por telÃ©fono.
    if (!candidatos.length) {
      const leads = sheetsRead_({ sheet: 'Leads' });
      const leadIds = leads.filter(function (lead) {
        return normalizarTelefono_(lead.telefono || '') === telefono;
      }).map(function (lead) { return String(lead.id || ''); });

      candidatos = citas.filter(function (c) {
        return leadIds.indexOf(String(c.lead_id || '')) !== -1 &&
          String(c.estado || '') !== 'cancelada' &&
          String(c.estado || '') !== 'reagendada';
      });
    }
  }

  if (!candidatos.length) {
    throw new Error('No encuentro una cita activa para ese cliente');
  }

  // Si hay varias, se toma la prÃ³xima por fecha de inicio.
  candidatos.sort(function (a, b) {
    return new Date(a.inicio || a.fecha || 0).getTime() -
      new Date(b.inicio || b.fecha || 0).getTime();
  });

  return candidatos[0];
}

function normalizarTelefono_(value) {
  return String(value || '').replace(/[^0-9]/g, '').replace(/^34(?=\d{9}$)/, '');
}

function actualizarEstadoCita_(cita, estado) {
  const sh = getSheet_('Citas');
  const headers = getHeaders_(sh);
  const eventIndex = headers.findIndex(function (h) { return keyForHeader_(h) === 'event_id'; });
  const citaIndex = headers.findIndex(function (h) { return keyForHeader_(h) === 'cita_id'; });
  const estadoIndex = headers.findIndex(function (h) { return keyForHeader_(h) === 'estado'; });

  if (estadoIndex < 0) throw new Error('Falta la columna estado en Citas');

  const lastRow = sh.getLastRow();
  if (lastRow < 2) throw new Error('No hay citas registradas');

  const values = sh.getRange(2, 1, lastRow - 1, headers.length).getValues();
  let rowNumber = -1;

  for (let i = 0; i < values.length; i++) {
    const sameEvent = eventIndex >= 0 && cita.event_id &&
      String(values[i][eventIndex]) === String(cita.event_id);
    const sameCita = citaIndex >= 0 && cita.cita_id &&
      String(values[i][citaIndex]) === String(cita.cita_id);
    if (sameEvent || sameCita) {
      rowNumber = i + 2;
      break;
    }
  }

  if (rowNumber < 0) throw new Error('No encuentro la fila de la cita');
  sh.getRange(rowNumber, estadoIndex + 1).setValue(estado);
  return rowNumber;
}

function agendaCancelar_(body) {
  const cita = citaBuscar_(body);
  const eliminado = calendarDeleteEvent_({
    eventId: cita.event_id,
    calendarId: body.calendarId || cita.calendar_used || CONFIG.CALENDAR_ID
  });

  if (eliminado.borrado) {
    actualizarEstadoCita_(cita, 'cancelada');
  }

  return {
    ok: eliminado.borrado,
    evento_borrado: eliminado.borrado,
    cita_id: cita.cita_id || '',
    event_id: cita.event_id || '',
    error: eliminado.error || ''
  };
}

function agendaReagendar_(body) {
  if (!body.inicio) throw new Error('Falta el nuevo inicio');

  const anterior = citaBuscar_(body);
  const nuevoBody = Object.assign({}, body, {
    cita_id: '',
    nombre: body.nombre || anterior.nombre || '',
    apellido: body.apellido || anterior.apellido || '',
    telefono: body.telefono || anterior.telefono || '',
    lead_id: body.lead_id || anterior.lead_id || '',
    empresa: body.empresa || '',
    creada_por: body.creada_por || 'agente_reagendado'
  });

  // Primero crea y valida la nueva cita. AsÃ­ no se pierde la reserva anterior
  // si la nueva hora estÃ¡ ocupada o es invÃ¡lida.
  const nueva = agendaAgendar_(nuevoBody);

  if (!nueva.ok || !nueva.event_id) {
    throw new Error('No se pudo crear la nueva cita');
  }

  const eliminado = calendarDeleteEvent_({
    eventId: anterior.event_id,
    calendarId: body.calendarId || anterior.calendar_used || CONFIG.CALENDAR_ID
  });

  if (!eliminado.borrado) {
    return {
      ok: false,
      nueva_cita_creada: true,
      nueva_cita: nueva,
      aviso: 'La nueva cita fue creada, pero no pude eliminar la anterior',
      error: eliminado.error || ''
    };
  }

  actualizarEstadoCita_(anterior, 'reagendada');

  return {
    ok: true,
    anterior_event_id: anterior.event_id || '',
    anterior_cita_id: anterior.cita_id || '',
    nueva_cita_id: nueva.cita_id || '',
    nueva_event_id: nueva.event_id || '',
    meet_link: nueva.meet_link || '',
    texto: nueva.texto || ''
  };
}


/* ================= PRUEBA ================= */

function PROBAR_TELEGRAM() {
  telegramSend_(
    'Prueba de Telegram desde Apps Script âœ…'
  );
}
