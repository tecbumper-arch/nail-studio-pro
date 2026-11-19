// Servidor HTTP local que responde como o Google (Sheets, Drive, Calendar, OAuth) usando
// createFakeGoogle. O Worker em `wrangler dev` aponta para ele via GOOGLE_API_BASE.
// GET /__db devolve o estado em memória (só para as asserções do teste).
import http from 'node:http';
import { createFakeGoogle } from '../fakeGoogle.js';

export async function startFakeGoogleServer(seed = {}, opts = {}) {
  const fake = createFakeGoogle(seed, opts);

  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined;
      const url = `http://${req.headers.host}${req.url}`;

      if (req.method === 'GET' && req.url === '/__db') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(fake.db));
        return;
      }

      const out = await fake.fetch(url, { method: req.method, headers: req.headers, body });
      const text = await out.text();
      res.writeHead(out.status, { 'Content-Type': out.headers.get('Content-Type') || 'application/json' });
      res.end(text);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'fake server error: ' + (e && e.message) } }));
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    fake,
    port,
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
