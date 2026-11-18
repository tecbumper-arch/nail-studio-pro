// Google falso em memória: um `fetch` que implementa só os endpoints usados por src/google.js.
// db[sid][tab] = string[][]; calls = [{ method, path, body }].
// Opções: { ownership: 'transfer' | 'pending' | 'none' } controla shareWithOwner.
// fake.fail(status, pathRegex?) faz as próximas chamadas (que casem) devolverem esse status; fail(null) limpa.
export function createFakeGoogle(seed = {}, opts = {}) {
  const db = JSON.parse(JSON.stringify(seed));
  const calls = [];
  let failure = null;
  let counter = 0;
  const perms = {};

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
    calls.push({ method, path, body });

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
      if (method === 'GET') return json({ range: rng, values: db[sid][tab] });
      if (action === 'clear') { db[sid][tab] = []; return json({}); }
      if (action === 'append') { db[sid][tab].push(...body.values.map((r) => r.map(String))); return json({}); }
      if (method === 'PUT') { db[sid][tab] = body.values.map((r) => r.map(String)); return json({}); }
    }

    m = path.match(/^\/drive\/v3\/files\/([^/]+)\/permissions(?:\/([^/]+))?$/);
    if (m) {
      if (method === 'POST') { const id = 'perm-' + ++counter; perms[id] = body; return json({ id }); }
      if (method === 'PATCH') {
        const mode = opts.ownership || 'transfer';
        if (url.searchParams.get('transferOwnership') === 'true') {
          return mode === 'transfer' ? json({}) : json({ error: { message: 'no transfer' } }, 403);
        }
        return mode === 'pending' ? json({}) : json({ error: { message: 'no pending' } }, 403);
      }
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
    fail(status, pathRegex = /.*/) { failure = status ? { status, re: pathRegex } : null; },
  };
}
