/**
 * Simulador mínimo do Google Apps Script para testar backend/Code.gs no Node.
 * Inclui planilhas em memória, Propriedades, Cache, Lock, UrlFetch com um
 * "Google" falso (tokeninfo, OAuth e Calendar API).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

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

// ----------------------------------------------------------------- Planilhas
class Sheet {
  constructor(name) { this.name = name; this.data = []; this.formats = {}; }
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
  setValues(vals) {
    if (vals.length !== this.nr || vals.some(r => r.length !== this.nc)) throw new Error(`setValues: dimensões erradas ${vals.length}x${vals[0] && vals[0].length} vs ${this.nr}x${this.nc}`);
    vals.forEach((row, i) => row.forEach((v, j) => { this.sh._ensure(this.r + i, this.c + j); this.sh.data[this.r - 1 + i][this.c - 1 + j] = v; }));
    return this;
  }
  setValue(v) { return this.setValues([[v]]); }
  setNumberFormat() { return this; }
}
class Spreadsheet {
  constructor(id, name) { this.id = id; this.name = name; this.sheets = [new Sheet('Página1')]; this.tz = 'America/Sao_Paulo'; this.editors = []; }
  getId() { return this.id; }
  getSheets() { return this.sheets; }
  getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; }
  insertSheet(n) { const s = new Sheet(n); this.sheets.push(s); return s; }
  setSpreadsheetTimeZone(tz) { this.tz = tz; }
  getSpreadsheetTimeZone() { return this.tz; }
  addEditor(e) { this.editors.push(e); }
}

// ----------------------------------------------------------- Google falso
class FakeGoogle {
  constructor() { this.idTokens = {}; this.codes = {}; this.refreshTokens = {}; this.accessTokens = {}; this.events = {}; this.revoked = []; this.seq = 1; this.calls = []; }
  issueIdToken(email, aud, name = 'Teste') { const t = 'idtok-' + crypto.randomBytes(6).toString('hex'); this.idTokens[t] = { email, aud, name }; return t; }
  issueCode(email, { scope = 'openid email https://www.googleapis.com/auth/calendar.events', withRefresh = true } = {}) {
    const c = 'code-' + crypto.randomBytes(6).toString('hex'); this.codes[c] = { email, scope, withRefresh }; return c;
  }
  addPersonalEvent(email, ev) { (this.events[email] = this.events[email] || []).push(Object.assign({ id: 'p' + (this.seq++), status: 'confirmed' }, ev)); }
  fetch(url, opts = {}) {
    const method = (opts.method || 'get').toLowerCase();
    this.calls.push(method + ' ' + url);
    const res = (code, obj) => ({ getResponseCode: () => code, getContentText: () => (typeof obj === 'string' ? obj : JSON.stringify(obj)) });
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
        const at = 'at-' + crypto.randomBytes(6).toString('hex');
        this.accessTokens[at] = c.email;
        const out = { access_token: at, expires_in: 3599, scope: c.scope, id_token: 'x.' + Buffer.from(JSON.stringify({ email: c.email })).toString('base64url') + '.y' };
        if (c.withRefresh) { const rt = 'rt-' + crypto.randomBytes(6).toString('hex'); this.refreshTokens[rt] = c.email; out.refresh_token = rt; }
        return res(200, out);
      }
      if (p.grant_type === 'refresh_token') {
        const email = this.refreshTokens[p.refresh_token];
        if (!email) return res(400, { error: 'invalid_grant' });
        const at = 'at-' + crypto.randomBytes(6).toString('hex');
        this.accessTokens[at] = email;
        return res(200, { access_token: at, expires_in: 3599 });
      }
    }
    if (url.startsWith('https://oauth2.googleapis.com/revoke')) {
      const t = decodeURIComponent(url.split('token=')[1]);
      this.revoked.push(t); delete this.refreshTokens[t];
      return res(200, {});
    }
    if (url.startsWith('https://www.googleapis.com/calendar/v3/calendars/primary/events')) {
      const auth = (opts.headers || {}).Authorization || '';
      const email = this.accessTokens[auth.replace('Bearer ', '')];
      if (!email) return res(401, { error: { message: 'unauthorized' } });
      const list = (this.events[email] = this.events[email] || []);
      const rest = url.slice('https://www.googleapis.com/calendar/v3/calendars/primary/events'.length);
      if (method === 'get') {
        const q = new URLSearchParams(rest.split('?')[1] || '');
        const tMin = new Date(q.get('timeMin')).getTime(), tMax = new Date(q.get('timeMax')).getTime();
        const items = list.filter(ev => {
          if (ev.start.date) return true;
          const s = new Date(ev.start.dateTime.length === 19 ? ev.start.dateTime + '-03:00' : ev.start.dateTime).getTime();
          const e = new Date(ev.end.dateTime.length === 19 ? ev.end.dateTime + '-03:00' : ev.end.dateTime).getTime();
          return s < tMax && e > tMin;
        });
        return res(200, { items });
      }
      if (method === 'post') { const ev = Object.assign(JSON.parse(opts.payload), { id: 'ev' + (this.seq++), status: 'confirmed' }); list.push(ev); return res(200, ev); }
      const id = decodeURIComponent(rest.slice(1));
      const idx = list.findIndex(e => e.id === id);
      if (idx < 0) return res(404, { error: { message: 'Not Found' } });
      if (method === 'patch') { Object.assign(list[idx], JSON.parse(opts.payload)); return res(200, list[idx]); }
      if (method === 'delete') { list.splice(idx, 1); return { getResponseCode: () => 204, getContentText: () => '' }; }
    }
    return res(404, { error: 'unmocked ' + url });
  }
}

// ------------------------------------------------------------- Ambiente GAS
function createGas({ apiUrl = 'http://localhost/exec' } = {}) {
  const props = {};
  const cache = {};
  const spreadsheets = {};
  const google = new FakeGoogle();
  const mails = [];
  const logs = [];
  let idSeq = 1;
  const newId = () => 'SHEET' + String(idSeq++).padStart(4, '0') + crypto.randomBytes(10).toString('hex');

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
    Session: { getScriptTimeZone: () => 'America/Sao_Paulo' },
    Utilities: {
      formatDate,
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, s) => toBytes(crypto.createHash('sha256').update(String(s), 'utf8').digest()),
      computeHmacSha256Signature: (v, k) => toBytes(crypto.createHmac('sha256', k).update(String(v), 'utf8').digest()),
      base64EncodeWebSafe: (v) => (Array.isArray(v) ? fromBytes(v) : Buffer.from(String(v), 'utf8')).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
      base64DecodeWebSafe: (s) => toBytes(Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64')),
      newBlob: (bytes) => ({ getDataAsString: () => fromBytes(bytes).toString('utf8') }),
      getUuid: () => crypto.randomUUID()
    },
    SpreadsheetApp: {
      create: (name) => { const id = newId(); return (spreadsheets[id] = new Spreadsheet(id, name)); },
      openById: (id) => { const s = spreadsheets[id]; if (!s) throw new Error('Planilha inexistente: ' + id); return s; }
    },
    UrlFetchApp: { fetch: (u, o) => google.fetch(u, o) },
    ContentService: {
      MimeType: { JSON: 'application/json', TEXT: 'text/plain', ICAL: 'text/calendar' },
      createTextOutput: (t) => { const o = { text: t, mime: 'text/plain', setMimeType(m) { o.mime = m; return o; }, getContent: () => o.text }; return o; }
    },
    ScriptApp: {
      getService: () => ({ getUrl: () => apiUrl }),
      getProjectTriggers: () => [],
      newTrigger: () => { const ch = { timeBased: () => ch, everyDays: () => ch, atHour: () => ch, create: () => ({}) }; return ch; }
    },
    MailApp: { sendEmail: (m) => mails.push(m) }
  };
  const context = vm.createContext(env);
  const code = fs.readFileSync(path.join(__dirname, '..', 'backend', 'Code.gs'), 'utf8');
  vm.runInContext(code, context, { filename: 'Code.gs' });

  const api = {
    context, props, cache, spreadsheets, google, mails, logs,
    call(fn, args, session) { return JSON.parse(JSON.stringify(context.dispatch_({ fn, args, session }))); },
    ok(fn, args, session) { const r = api.call(fn, args, session); if (!r.ok) throw new Error(fn + ' falhou: ' + r.error); return r.data; },
    clearCache() { Object.keys(cache).forEach(k => delete cache[k]); }
  };
  return api;
}

module.exports = { createGas, formatDate };
