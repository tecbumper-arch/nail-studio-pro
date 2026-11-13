/**
 * Simulador do Google Apps Script para testar backend/Code.gs no Node.
 *
 * Imita o modelo de PERMISSÕES do Google: cada planilha/arquivo tem dono e
 * editores; a conta do servidor (SpreadsheetApp/DriveApp) só abre o que é dela
 * ou foi compartilhado com ela; a API REST (Sheets/Drive) só aceita tokens de
 * quem tem acesso e com os escopos certos; revogar o acesso derruba os tokens.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const SERVER = 'servidor@gmail.com';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const CAL_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const DATA_SCOPES = 'openid email ' + SHEETS_SCOPE + ' ' + DRIVE_FILE_SCOPE;

function pad(n, l = 2) { return String(n).padStart(l, '0'); }

function partsInTz(date, tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const o = {};
  f.formatToParts(date).forEach(p => { o[p.type] = p.value; });
  const asUtc = Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour, +o.minute, +o.second);
  const offMin = Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
  return { y: o.year, M: o.month, d: o.day, H: o.hour, m: o.minute, s: o.second, offMin };
}

function formatDate(date, tz, pattern) {
  const p = partsInTz(date, tz);
  let out = '';
  for (let i = 0; i < pattern.length;) {
    if (pattern[i] === "'") { const j = pattern.indexOf("'", i + 1); out += pattern.slice(i + 1, j); i = j + 1; continue; }
    const rest = pattern.slice(i);
    if (rest.startsWith('yyyy')) { out += p.y; i += 4; }
    else if (rest.startsWith('MM')) { out += p.M; i += 2; }
    else if (rest.startsWith('dd')) { out += p.d; i += 2; }
    else if (rest.startsWith('HH')) { out += p.H; i += 2; }
    else if (rest.startsWith('mm')) { out += p.m; i += 2; }
    else if (rest.startsWith('ss')) { out += p.s; i += 2; }
    else if (rest.startsWith('XXX')) { const o = p.offMin; out += o === 0 ? 'Z' : (o < 0 ? '-' : '+') + pad(Math.floor(Math.abs(o) / 60)) + ':' + pad(Math.abs(o) % 60); i += 3; }
    else { out += pattern[i]; i++; }
  }
  return out;
}

function toBytes(buf) { return Array.from(buf).map(b => (b > 127 ? b - 256 : b)); }
function fromBytes(arr) { return Buffer.from(arr.map(b => b & 0xff)); }
const isDate = v => Object.prototype.toString.call(v) === '[object Date]';

/** Como o Google Sheets EXIBE uma célula (datas no formato pt-BR em que foram digitadas). */
function displayOf(v, tz) {
  if (v === null || v === undefined) return '';
  if (isDate(v)) {
    if (v.getUTCFullYear() < 1901) return formatDate(v, tz, 'HH:mm');
    const hms = formatDate(v, tz, 'HH:mm:ss');
    return hms === '00:00:00' ? formatDate(v, tz, 'dd/MM/yyyy') : formatDate(v, tz, 'dd/MM/yyyy HH:mm:ss');
  }
  return String(v);
}

// ----------------------------------------------------------------- Planilhas
let sheetSeq = 100;
class Sheet {
  constructor(name, ss) { this.name = name; this.data = []; this.id = sheetSeq++; this.ss = ss; }
  setName(n) { this.name = n; return this; }
  getName() { return this.name; }
  getLastRow() { let n = this.data.length; while (n > 0 && this.data[n - 1].every(v => v === '' || v === undefined)) n--; return n; }
  getLastColumn() { return this.data.reduce((w, r) => Math.max(w, r.length), 0); }
  _ensure(r, c) { while (this.data.length < r) this.data.push([]); const row = this.data[r - 1]; while (row.length < c) row.push(''); }
  getRange(r, c, nr = 1, nc = 1) { return new Range(this, r, c, nr, nc); }
  getDataRange() { const nr = Math.max(1, this.getLastRow()); const nc = Math.max(1, this.getLastColumn()); return new Range(this, 1, 1, nr, nc); }
  clearContents() { this.data = []; return this; }
  deleteRow(r) { this.data.splice(r - 1, 1); }
  deleteRows(r, n) { this.data.splice(r - 1, n); }
}
class Range {
  constructor(sh, r, c, nr, nc) { Object.assign(this, { sh, r, c, nr, nc }); }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const row = [];
      for (let j = 0; j < this.nc; j++) { const v = (this.sh.data[this.r - 1 + i] || [])[this.c - 1 + j]; row.push(v === undefined ? '' : v); }
      out.push(row);
    }
    return out;
  }
  getDisplayValues() { const tz = this.sh.ss ? this.sh.ss.tz : 'America/Sao_Paulo'; return this.getValues().map(r => r.map(v => displayOf(v, tz))); }
  setValues(vals) {
    if (vals.length !== this.nr || vals.some(r => r.length !== this.nc)) throw new Error(`setValues: dimensões erradas ${vals.length}x${vals[0] && vals[0].length} vs ${this.nr}x${this.nc}`);
    vals.forEach((row, i) => row.forEach((v, j) => { this.sh._ensure(this.r + i, this.c + j); this.sh.data[this.r - 1 + i][this.c - 1 + j] = v; }));
    return this;
  }
  setValue(v) { return this.setValues([[v]]); }
  getValue() { return this.getValues()[0][0]; }
  setNumberFormat() { return this; }
}
class Spreadsheet {
  constructor(id, name, owner) { this.id = id; this.name = name; this.sheets = [new Sheet('Página1', this)]; this.tz = 'America/Sao_Paulo'; this.editors = []; this.owner = owner || SERVER; this.trashed = false; this.parent = 'root'; }
  getId() { return this.id; }
  getSheets() { return this.sheets; }
  getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; }
  insertSheet(n) { const s = new Sheet(n, this); this.sheets.push(s); return s; }
  setSpreadsheetTimeZone(tz) { this.tz = tz; }
  getSpreadsheetTimeZone() { return this.tz; }
  addEditor(e) { if (!this.editors.includes(e)) this.editors.push(e); }
  canAccess(email) { return !this.trashed && (this.owner === email || this.editors.includes(email) || (this.readers || []).includes(email)); }
  /** Conteúdo da aba como o Google mostraria (para conferir nos testes). */
  tab(name) { const s = this.getSheetByName(name); return s ? s.getDataRange().getDisplayValues() : null; }
}

function parseA1(range) {
  const m = range.match(/^'((?:[^']|'')*)'(?:!([A-Z]+)(\d+):([A-Z]+)(\d+))?$/) || range.match(/^([^!']+)(?:!([A-Z]+)(\d+):([A-Z]+)(\d+))?$/);
  if (!m) throw new Error('A1 inválido: ' + range);
  const col = s => s.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  return { title: m[1].replace(/''/g, "'"), r1: m[3] ? +m[3] : null, c1: m[2] ? col(m[2]) : null };
}

// ----------------------------------------------------------- Google falso
class FakeGoogle {
  constructor(spreadsheets, drive) {
    this.spreadsheets = spreadsheets; this.drive = drive;
    this.idTokens = {}; this.codes = {}; this.refreshTokens = {}; this.accessTokens = {}; this.grants = {};
    this.events = {}; this.revoked = []; this.seq = 1; this.calls = [];
  }
  issueIdToken(email, aud, name = 'Teste') { const t = 'idtok-' + crypto.randomBytes(6).toString('hex'); this.idTokens[t] = { email, aud, name }; return t; }
  /** Código de autorização (pop-up do Google). Padrão: só agenda. Use { scope: DATA_SCOPES } para planilha/arquivos. */
  issueCode(email, { scope = 'openid email ' + CAL_SCOPE, withRefresh = true } = {}) {
    const c = 'code-' + crypto.randomBytes(6).toString('hex'); this.codes[c] = { email, scope, withRefresh }; return c;
  }
  /** A manicure remove o acesso do app em myaccount.google.com/permissions. */
  revokeAll(email) {
    this.grants[email] = '';
    Object.keys(this.refreshTokens).forEach(k => { if (this.refreshTokens[k].email === email) delete this.refreshTokens[k]; });
    Object.keys(this.accessTokens).forEach(k => { if (this.accessTokens[k].email === email) delete this.accessTokens[k]; });
  }
  addPersonalEvent(email, ev) { (this.events[email] = this.events[email] || []).push(Object.assign({ id: 'p' + (this.seq++), status: 'confirmed' }, ev)); }
  _auth(opts) {
    const t = ((opts.headers || {}).Authorization || '').replace('Bearer ', '');
    if (t === 'server-token') return { email: SERVER, scope: 'ALL' };
    return this.accessTokens[t] || null;
  }
  fetch(url, opts = {}) {
    const method = (opts.method || 'get').toLowerCase();
    this.calls.push(method + ' ' + url);
    const res = (code, obj) => ({ getResponseCode: () => code, getContentText: () => (obj === undefined ? '' : typeof obj === 'string' ? obj : JSON.stringify(obj)) });
    const err = (code, msg) => res(code, { error: { code, message: msg } });
    const body = () => (typeof opts.payload === 'string' ? JSON.parse(opts.payload || '{}') : {});
    const has = (who, scope) => who.scope === 'ALL' || String(who.scope).split(' ').includes(scope);

    if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
      const t = decodeURIComponent(url.split('id_token=')[1]);
      const info = this.idTokens[t];
      if (!info) return res(400, { error: 'invalid_token' });
      return res(200, { aud: info.aud, iss: 'https://accounts.google.com', email: info.email, email_verified: 'true', exp: String(Math.floor(Date.now() / 1000) + 3600), name: info.name });
    }
    if (url === 'https://oauth2.googleapis.com/token') {
      const p = opts.payload;
      if (p.grant_type === 'authorization_code') {
        const c = this.codes[p.code];
        if (!c) return res(400, { error: 'invalid_grant' });
        delete this.codes[p.code];
        // include_granted_scopes: o Google devolve a soma de tudo que ela já autorizou
        const union = new Set(String(this.grants[c.email] || '').split(' ').concat(c.scope.split(' ')).filter(Boolean));
        const scope = [...union].join(' ');
        this.grants[c.email] = scope;
        const at = 'at-' + crypto.randomBytes(6).toString('hex');
        this.accessTokens[at] = { email: c.email, scope };
        const out = { access_token: at, expires_in: 3599, scope, id_token: 'x.' + Buffer.from(JSON.stringify({ email: c.email })).toString('base64url') + '.y' };
        if (c.withRefresh) { const rt = 'rt-' + crypto.randomBytes(6).toString('hex'); this.refreshTokens[rt] = { email: c.email, scope }; out.refresh_token = rt; }
        return res(200, out);
      }
      if (p.grant_type === 'refresh_token') {
        const r = this.refreshTokens[p.refresh_token];
        if (!r) return res(400, { error: 'invalid_grant' });
        const at = 'at-' + crypto.randomBytes(6).toString('hex');
        this.accessTokens[at] = { email: r.email, scope: r.scope };
        return res(200, { access_token: at, expires_in: 3599 });
      }
    }
    if (url.startsWith('https://oauth2.googleapis.com/revoke')) {
      const t = decodeURIComponent(url.split('token=')[1]);
      this.revoked.push(t);
      const who = this.refreshTokens[t] || this.accessTokens[t];
      if (who) this.revokeAll(who.email);
      return res(200, {});
    }

    // ------------------------------------------------------------ Sheets API
    const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
    if (url.startsWith(SHEETS)) {
      const who = this._auth(opts);
      if (!who) return err(401, 'Request had invalid authentication credentials.');
      if (!has(who, SHEETS_SCOPE)) return err(403, 'Request had insufficient authentication scopes.');
      if (url === SHEETS && method === 'post') {
        const b = body();
        const id = 'OWN' + crypto.randomBytes(14).toString('hex');
        const ss = new Spreadsheet(id, b.properties.title, who.email);
        ss.tz = b.properties.timeZone || ss.tz;
        ss.sheets = (b.sheets || [{ properties: { title: 'Sheet1' } }]).map(s => new Sheet(s.properties.title, ss));
        ss.createdByApp = true;
        this.spreadsheets[id] = ss;
        return res(200, { spreadsheetId: id });
      }
      const m = url.slice(SHEETS.length + 1).match(/^([^/?:]+)(.*)$/);
      const ss = this.spreadsheets[m[1]];
      if (!ss || ss.trashed) return err(404, 'Requested entity was not found.');
      if (!ss.canAccess(who.email)) return err(403, 'The caller does not have permission');
      if (ss.owner !== who.email && !ss.editors.includes(who.email) && method !== 'get') return err(403, 'The caller does not have permission');
      const rest = m[2];
      if ((rest === '' || rest.startsWith('?')) && method === 'get') {
        return res(200, { properties: { title: ss.name, timeZone: ss.tz }, sheets: ss.sheets.map((s, i) => ({ properties: { sheetId: s.id, title: s.name, index: i } })) });
      }
      if (rest.startsWith(':batchUpdate')) {
        const replies = body().requests.map(r => {
          if (r.addSheet) { const s = ss.insertSheet(r.addSheet.properties.title); return { addSheet: { properties: { sheetId: s.id, title: s.name, index: ss.sheets.length - 1 } } }; }
          if (r.updateSheetProperties) { const s = ss.sheets.find(x => x.id === r.updateSheetProperties.properties.sheetId); s.name = r.updateSheetProperties.properties.title; return {}; }
          if (r.deleteDimension) { const g = r.deleteDimension.range; const s = ss.sheets.find(x => x.id === g.sheetId); s.data.splice(g.startIndex, g.endIndex - g.startIndex); return {}; }
          if (r.updateSpreadsheetProperties) { ss.tz = r.updateSpreadsheetProperties.properties.timeZone; return {}; }
          throw new Error('batchUpdate não simulado: ' + JSON.stringify(r));
        });
        return res(200, { replies });
      }
      const vm2 = rest.match(/^\/values\/([^?:]+)(:clear)?(\?.*)?$/);
      if (vm2) {
        const a = parseA1(decodeURIComponent(vm2[1]));
        const sh = ss.getSheetByName(a.title);
        if (!sh) return err(400, 'Unable to parse range: ' + a.title);
        if (vm2[2] === ':clear') { sh.data = []; return res(200, {}); }
        if (method === 'get') {
          const values = sh.data.slice(0, sh.getLastRow()).map(r => { const row = r.map(v => displayOf(v, ss.tz)); while (row.length && row[row.length - 1] === '') row.pop(); return row; });
          return res(200, values.length ? { range: a.title, values } : { range: a.title });
        }
        if (method === 'put') {
          const vals = body().values;
          vals.forEach((row, i) => row.forEach((v, j) => { sh._ensure(a.r1 + i, a.c1 + j); sh.data[a.r1 - 1 + i][a.c1 - 1 + j] = v; }));
          return res(200, { updatedRows: vals.length });
        }
      }
      return err(400, 'Sheets não simulado: ' + method + ' ' + rest);
    }

    // ------------------------------------------------------------- Drive API
    const DRIVE = 'https://www.googleapis.com/drive/v3/files';
    const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
    if (url.startsWith(UPLOAD)) {
      const who = this._auth(opts);
      if (!who) return err(401, 'unauthorized');
      if (!has(who, DRIVE_FILE_SCOPE)) return err(403, 'insufficient scopes');
      const buf = fromBytes(opts.payload);
      const txt = buf.toString('latin1');
      const p1 = txt.indexOf('\r\n\r\n') + 4;
      const sep = txt.indexOf('\r\n--', p1);
      const meta = JSON.parse(txt.slice(p1, sep));
      const p2 = txt.indexOf('\r\n\r\n', sep) + 4;
      const end = txt.lastIndexOf('\r\n--');
      const parent = this.drive.folders[(meta.parents || [])[0]];
      if (parent && parent.owner !== who.email) return err(404, 'Parent folder not found');
      const fid = 'FILE' + crypto.randomBytes(12).toString('hex');
      this.drive.files[fid] = { id: fid, name: meta.name, mime: meta.mimeType, bytes: toBytes(buf.slice(p2, end)), owner: who.email, editors: [], parent: (meta.parents || [])[0], trashed: false, sharing: null };
      return res(200, { id: fid });
    }
    if (url.startsWith(DRIVE)) {
      const who = this._auth(opts);
      if (!who) return err(401, 'unauthorized');
      const m = url.slice(DRIVE.length).match(/^(?:\/([^/?]+))?(\/permissions(?:\/([^?]+))?)?(\?.*)?$/);
      const id = m[1], isPerm = !!m[2], pid = m[3];
      const q = new URLSearchParams((m[4] || '').slice(1));
      if (!id && method === 'post') {
        if (!has(who, DRIVE_FILE_SCOPE)) return err(403, 'insufficient scopes');
        const b = body();
        const fid = 'FOLDER' + crypto.randomBytes(12).toString('hex');
        this.drive.folders[fid] = { id: fid, name: b.name, owner: who.email, parent: (b.parents || [])[0] || 'root', trashed: false, editors: [] };
        return res(200, { id: fid });
      }
      const target = this.spreadsheets[id] || this.drive.files[id] || this.drive.folders[id];
      if (!target) return err(404, 'File not found: ' + id);
      const owner = target.owner || SERVER;
      const editors = target.editors || [];
      if (!(who.email === owner || editors.includes(who.email))) return err(404, 'File not found: ' + id);
      if (isPerm) {
        const perms = () => [{ id: 'p-owner', emailAddress: owner, role: 'owner' }].concat(editors.map(e => ({ id: 'p-' + e, emailAddress: e, role: 'writer' })));
        if (method === 'get') return res(200, { permissions: perms() });
        if (method === 'post') {
          const b = body();
          if (b.type === 'anyone') { target.sharing = 'ANYONE_WITH_LINK'; return res(200, { id: 'anyoneWithLink' }); }
          editors.push(b.emailAddress); target.editors = editors; return res(200, { id: 'p-' + b.emailAddress });
        }
        if (method === 'delete') {
          if (pid === 'p-owner') return err(403, 'The owner cannot be removed');
          const email = decodeURIComponent(String(pid)).replace(/^p-/, '');
          target.editors = editors.filter(e => e !== email);
          return res(204);
        }
      }
      if (method === 'get') return res(200, { id, trashed: !!target.trashed, parents: [target.parent || 'root'] });
      if (method === 'patch') {
        const b = body();
        if (b.trashed !== undefined) target.trashed = b.trashed;
        if (q.get('addParents')) target.parent = q.get('addParents');
        return res(200, { id });
      }
    }

    // ---------------------------------------------------------- Calendar API
    const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
    if (url.startsWith(CAL)) {
      const who = this._auth(opts);
      if (!who || who.email === SERVER) return err(401, 'unauthorized');
      if (!has(who, CAL_SCOPE)) return err(403, 'insufficient scopes');
      const list = (this.events[who.email] = this.events[who.email] || []);
      const rest = url.slice(CAL.length);
      if (method === 'get') {
        const qq = new URLSearchParams(rest.split('?')[1] || '');
        const tMin = new Date(qq.get('timeMin')).getTime(), tMax = new Date(qq.get('timeMax')).getTime();
        const items = list.filter(ev => {
          if (ev.start.date) return true;
          const s = new Date(ev.start.dateTime.length === 19 ? ev.start.dateTime + '-03:00' : ev.start.dateTime).getTime();
          const e = new Date(ev.end.dateTime.length === 19 ? ev.end.dateTime + '-03:00' : ev.end.dateTime).getTime();
          return s < tMax && e > tMin;
        });
        return res(200, { items });
      }
      if (method === 'post') { const ev = Object.assign(JSON.parse(opts.payload), { id: 'ev' + (this.seq++), status: 'confirmed' }); list.push(ev); return res(200, ev); }
      const id = decodeURIComponent(rest.slice(1).split('?')[0]);
      const idx = list.findIndex(e => e.id === id);
      if (idx < 0) return err(404, 'Not Found');
      if (method === 'patch') { Object.assign(list[idx], JSON.parse(opts.payload)); return res(200, list[idx]); }
      if (method === 'delete') { list.splice(idx, 1); return res(204); }
    }
    return res(404, { error: 'unmocked ' + url });
  }
}

// ------------------------------------------------------------- Ambiente GAS
function createGas({ apiUrl = 'http://localhost/exec' } = {}) {
  const props = {};
  const cache = {};
  const spreadsheets = {};
  const drive = { folders: {}, files: {} };
  const google = new FakeGoogle(spreadsheets, drive);
  const triggers = [];
  const mails = [];
  const logs = [];
  let idSeq = 1;
  const newId = () => 'SHEET' + String(idSeq++).padStart(4, '0') + crypto.randomBytes(10).toString('hex');

  const serverMayAccess = (o) => !!o && !o.trashed && ((o.owner || SERVER) === SERVER || (o.editors || []).includes(SERVER));
  const fileApi = (f) => ({
    getId: () => f.id, getName: () => f.name,
    setSharing(a) { f.sharing = a; }, setTrashed(t) { f.trashed = t; },
    getOwner: () => ({ getEmail: () => f.owner || SERVER }),
    getEditors: () => (f.editors || []).map(e => ({ getEmail: () => e })),
    getBlob: () => ({ getContentType: () => f.mime, getBytes: () => f.bytes.slice() })
  });
  const folderApi = (folder) => Object.assign(fileApi(folder), {
    addEditor(e) { folder.editors.push(e); },
    createFile(blob) {
      const fid = 'FILE' + crypto.randomBytes(12).toString('hex');
      drive.files[fid] = { id: fid, name: blob.name, mime: blob.mime, bytes: blob.bytes, parent: folder.id, owner: SERVER, editors: [], trashed: false, sharing: null };
      return fileApi(drive.files[fid]);
    }
  });

  const env = {
    console,
    Logger: { log: (m) => logs.push(String(m)) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); }, deleteProperty: k => { delete props[k]; } }) },
    CacheService: { getScriptCache: () => ({
      get: k => { const e = cache[k]; return e && e.exp > Date.now() ? e.v : null; },
      put: (k, v, s = 600) => { cache[k] = { v: String(v), exp: Date.now() + s * 1000 }; },
      remove: k => { delete cache[k]; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) },
    Session: { getScriptTimeZone: () => 'America/Sao_Paulo', getEffectiveUser: () => ({ getEmail: () => SERVER }) },
    Utilities: {
      formatDate,
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, s) => toBytes(crypto.createHash('sha256').update(String(s), 'utf8').digest()),
      computeHmacSha256Signature: (v, k) => toBytes(crypto.createHmac('sha256', k).update(String(v), 'utf8').digest()),
      base64EncodeWebSafe: (v) => (Array.isArray(v) ? fromBytes(v) : Buffer.from(String(v), 'utf8')).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
      base64DecodeWebSafe: (s) => toBytes(Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64')),
      newBlob: (data, mime, name) => {
        const bytes = typeof data === 'string' ? toBytes(Buffer.from(data, 'utf8')) : data;
        return { bytes, mime, name, getBytes: () => bytes.slice(), getDataAsString: () => fromBytes(bytes).toString('utf8') };
      },
      base64Decode: (s) => toBytes(Buffer.from(String(s), 'base64')),
      getUuid: () => crypto.randomUUID()
    },
    SpreadsheetApp: {
      create: (name) => { const id = newId(); return (spreadsheets[id] = new Spreadsheet(id, name, SERVER)); },
      openById: (id) => {
        const s = spreadsheets[id];
        if (!s || s.trashed) throw new Error('Planilha inexistente: ' + id);
        if (!serverMayAccess(s)) throw new Error('Você não tem permissão para acessar o documento solicitado.');
        return s;
      }
    },
    UrlFetchApp: { fetch: (u, o) => google.fetch(u, o) },
    ContentService: {
      MimeType: { JSON: 'application/json', TEXT: 'text/plain', ICAL: 'text/calendar' },
      createTextOutput: (t) => { const o = { text: t, mime: 'text/plain', setMimeType(m) { o.mime = m; return o; }, getContent: () => o.text }; return o; }
    },
    ScriptApp: {
      getService: () => ({ getUrl: () => apiUrl }),
      getOAuthToken: () => 'server-token',
      getProjectTriggers: () => triggers.map(t => ({ getHandlerFunction: () => t.fn })),
      newTrigger: (fn) => { const t = { fn }; const ch = { timeBased: () => ch, everyDays: (n) => { t.days = n; return ch; }, everyMinutes: (n) => { t.minutes = n; return ch; }, everyHours: (n) => { t.hours = n; return ch; }, atHour: (h) => { t.hour = h; return ch; }, create: () => { triggers.push(t); return {}; } }; return ch; }
    },
    MailApp: { sendEmail: (m) => mails.push(m) },
    DriveApp: {
      Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK' }, Permission: { VIEW: 'VIEW' },
      createFolder: (name) => {
        const id = 'FOLDER' + crypto.randomBytes(12).toString('hex');
        drive.folders[id] = { id, name, owner: SERVER, editors: [], sharing: null, trashed: false, parent: 'root' };
        return folderApi(drive.folders[id]);
      },
      getStorageUsed: () => drive.storageUsed || 0,
      getStorageLimit: () => 15 * 1024 * 1024 * 1024,
      getFolderById: (id) => { const f = drive.folders[id]; if (!serverMayAccess(f)) throw new Error('pasta inexistente'); return folderApi(f); },
      getFileById: (id) => {
        const f = drive.files[id] || spreadsheets[id] || drive.folders[id];
        if (!serverMayAccess(f)) throw new Error('Arquivo inexistente ou sem permissão: ' + id);
        return fileApi(f);
      }
    }
  };
  const context = vm.createContext(env);
  const code = fs.readFileSync(path.join(__dirname, '..', 'backend', 'Code.gs'), 'utf8');
  vm.runInContext(code, context, { filename: 'Code.gs' });

  const api = {
    context, props, cache, spreadsheets, google, mails, logs, drive, triggers, SERVER, DATA_SCOPES, CAL_SCOPE,
    /** Planilha que já existe no Drive de alguém (o servidor não tem acesso). */
    createUserSheet(owner, name) { const id = 'USERSHEET' + crypto.randomBytes(10).toString('hex'); spreadsheets[id] = new Spreadsheet(id, name || 'Minha planilha', owner); return spreadsheets[id]; },
    /** O servidor consegue abrir esta planilha/arquivo pela conta dele? */
    serverCanOpen(id) { return serverMayAccess(spreadsheets[id] || drive.files[id] || drive.folders[id]); },
    call(fn, args, session) { return JSON.parse(JSON.stringify(context.dispatch_({ fn, args, session }))); },
    ok(fn, args, session) { const r = api.call(fn, args, session); if (!r.ok) throw new Error(fn + ' falhou: ' + r.error); return r.data; },
    clearCache() { Object.keys(cache).forEach(k => delete cache[k]); }
  };
  return api;
}

module.exports = { createGas, formatDate, displayOf, DATA_SCOPES, CAL_SCOPE, SERVER, Spreadsheet, Sheet };
