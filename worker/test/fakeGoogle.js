// Google falso em memória: um `fetch` que implementa só os endpoints usados por src/google.js.
// db[sid][tab] = string[][]; calls = [{ method, path, body }].
// Opções: { ownership: 'transfer' | 'pending' | 'none' } controla shareWithOwner;
// { permissions: { [fileId]: [{ emailAddress, role }] } } é o que a listagem de permissões do Drive devolve;
// { serviceEmail } é o e-mail da conta do servidor (Drive about).
// calls[i].query guarda a query string (ex.: '?fields=...').
// fake.fail(status, pathRegex?) faz as próximas chamadas (que casem) devolverem esse status; fail(null) limpa.
// Gravações USER_ENTERED se comportam como no Sheets: um ' no início é removido (a célula fica como texto);
// sem o ', texto começando com = + - @ é interpretado (fórmula). fake.isLive(sid, tab, linha, coluna)
// diz se a célula foi interpretada (índices a partir de 0, como no array de db).
// Leituras e gravações respeitam o intervalo A1 pedido (ex.: 'Agendamentos!K5:L5').
export function createFakeGoogle(seed = {}, opts = {}) {
  const db = JSON.parse(JSON.stringify(seed));
  const calls = [];
  let failure = null;
  let counter = 0;
  const filePerms = JSON.parse(JSON.stringify(opts.permissions || {}));
  const live = new Set();
  const cellKey = (sid, tab, r, c) => [sid, tab, r, c].join('\u0000');

  // 'A1' / 'K5' -> { r, c } (0-based); 'A1:Z500' -> { start, end }.
  function parseCell(a1) {
    const m = /^([A-Z]+)(\d+)$/.exec(a1);
    if (!m) return null;
    let c = 0;
    for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
    return { r: Number(m[2]) - 1, c: c - 1 };
  }
  function parseRange(rng) {
    const part = rng.includes('!') ? rng.split('!')[1] : 'A1:Z1000';
    const [a, b] = part.split(':');
    const start = parseCell(a);
    const end = b ? parseCell(b) : start;
    return { start, end };
  }
  function storeCell(sid, tab, r, c, raw, userEntered) {
    const rows = db[sid][tab];
    while (rows.length <= r) rows.push([]);
    while (rows[r].length < c) rows[r].push('');
    let v = raw === null || raw === undefined ? '' : String(raw);
    let isLive = false;
    if (userEntered) {
      if (v.startsWith("'")) v = v.slice(1);
      else if (/^[=+\-@]/.test(v)) isLive = true;
    }
    rows[r][c] = v;
    if (isLive) live.add(cellKey(sid, tab, r, c)); else live.delete(cellKey(sid, tab, r, c));
  }
  function writeAt(sid, tab, r0, c0, values, userEntered) {
    values.forEach((row, i) => row.forEach((v, j) => storeCell(sid, tab, r0 + i, c0 + j, v, userEntered)));
  }
  function clearTab(sid, tab) {
    db[sid][tab] = [];
    const prefix = cellKey(sid, tab, '', '').slice(0, -1); // 'sid\0tab\0'
    for (const k of [...live]) if (k.startsWith(prefix)) live.delete(k);
  }

  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

  async function fetch(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = (init.method || 'GET').toUpperCase();
    const path = decodeURIComponent(url.pathname);
    let body = init.body;
    if (typeof body === 'string' && body.trim().startsWith('{')) {
      try { body = JSON.parse(body); } catch (e) {}
    }
    calls.push({ method, path, body, query: url.search });

    if (failure && failure.re.test(path)) return json({ error: { message: 'fake failure' } }, failure.status);

    if (method === 'POST' && path === '/token') {
      const p = new URLSearchParams(String(init.body));
      if (p.get('grant_type') === 'authorization_code') {
        return json({ access_token: 'fake-access-' + p.get('code'), refresh_token: 'fake-refresh', id_token: 'fake-id', expires_in: 3600 });
      }
      return json({ access_token: 'fake-access-' + ++counter, expires_in: 3600 });
    }

    if (method === 'GET' && path === '/oauth2/v2/userinfo') {
      return json(opts.userinfo || { email: 'Fake@Example.com', verified_email: true, name: 'Fake User' });
    }

    if (method === 'POST' && path === '/v4/spreadsheets') {
      const id = 'fake-sheet-' + ++counter;
      db[id] = {};
      for (const s of body.sheets || []) db[id][s.properties.title] = [];
      return json({ spreadsheetId: id });
    }

    let m = path.match(/^\/v4\/spreadsheets\/([^/]+)\/values\/(.+)$/);
    if (m) {
      const sid = m[1];
      let rng = m[2];
      let action = null;
      const sm = rng.match(/:(clear|append)$/);
      if (sm) { action = sm[1]; rng = rng.slice(0, -sm[0].length); }
      const tab = rng.split('!')[0];
      if (!db[sid] || !db[sid][tab]) return json({ error: { message: 'Unable to parse range: ' + rng } }, 400);
      const userEntered = url.searchParams.get('valueInputOption') === 'USER_ENTERED';
      const { start, end } = parseRange(rng);
      if (!start) return json({ error: { message: 'Unable to parse range: ' + rng } }, 400);
      if (method === 'GET') {
        const values = db[sid][tab].slice(start.r, end.r + 1).map((r) => r.slice(start.c, end.c + 1));
        while (values.length && values[values.length - 1].every((v) => v === '')) values.pop();
        return json({ range: rng, values });
      }
      if (action === 'clear') { clearTab(sid, tab); return json({}); }
      if (action === 'append') {
        const at = db[sid][tab].length;
        writeAt(sid, tab, at, 0, body.values, userEntered);
        return json({});
      }
      if (method === 'PUT') { writeAt(sid, tab, start.r, start.c, body.values, userEntered); return json({}); }
    }

    m = path.match(/^\/drive\/v3\/files\/([^/]+)\/permissions(?:\/([^/]+))?$/);
    if (m) {
      if (method === 'GET') {
        return filePerms[m[1]] ? json({ permissions: filePerms[m[1]] }) : json({ error: { message: 'File not found' } }, 404);
      }
      if (method === 'POST') {
        const id = 'perm-' + ++counter;
        (filePerms[m[1]] ||= []).push({ id, emailAddress: body.emailAddress, role: body.role });
        return json({ id });
      }
      if (method === 'PATCH') {
        const mode = opts.ownership || 'transfer';
        if (url.searchParams.get('transferOwnership') === 'true') {
          return mode === 'transfer' ? json({}) : json({ error: { message: 'no transfer' } }, 403);
        }
        return mode === 'pending' ? json({}) : json({ error: { message: 'no pending' } }, 403);
      }
    }

    if (method === 'GET' && path === '/drive/v3/about') {
      return json({ user: { emailAddress: opts.serviceEmail || 'motor@nailstudio.example' } });
    }

    if (method === 'POST' && path === '/calendar/v3/calendars/primary/events') return json({ id: 'fake-event-' + ++counter });
    if (method === 'DELETE' && path.startsWith('/calendar/v3/calendars/primary/events/')) return new Response(null, { status: 204 });

    if (method === 'POST' && url.hostname === 'script.google.com') {
      return json({ success: true, eventId: 'hook-event-' + ++counter });
    }

    return json({ error: { message: `fake google: unhandled ${method} ${path}` } }, 404);
  }

  return {
    fetch,
    db,
    calls,
    isLive: (sid, tab, r, c) => live.has(cellKey(sid, tab, r, c)),
    fail(status, pathRegex = /.*/) { failure = status ? { status, re: pathRegex } : null; },
  };
}
