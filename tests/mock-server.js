/**
 * Servidor local para testes E2E: roda backend/Code.gs (simulado) em /exec,
 * serve os HTMLs do repositório e expõe /__test/* para emitir logins falsos.
 * Uso: node tests/mock-server.js [porta]
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createGas } = require('./gas-mock');

const ROOT = path.join(__dirname, '..');
const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css' };

function start(port = 0) {
  return new Promise((resolve) => {
    let gas;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const cors = { 'Access-Control-Allow-Origin': '*' };
      if (url.pathname === '/exec' && req.method === 'POST') {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
          const out = gas.context.doPost({ postData: { contents: body } });
          res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors));
          res.end(out.getContent());
        });
        return;
      }
      if (url.pathname === '/exec' && req.method === 'GET') {
        const out = gas.context.doGet({ parameter: Object.fromEntries(url.searchParams) });
        res.writeHead(200, Object.assign({ 'Content-Type': out.mime }, cors));
        res.end(out.getContent());
        return;
      }
      if (url.pathname === '/__test/idtoken') {
        res.end(gas.google.issueIdToken(url.searchParams.get('email'), CLIENT_ID, url.searchParams.get('name') || 'Ana Teste'));
        return;
      }
      if (url.pathname === '/__test/code') {
        res.end(gas.google.issueCode(url.searchParams.get('email')));
        return;
      }
      if (url.pathname === '/__test/events') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(gas.google.events));
        return;
      }
      if (url.pathname === '/config.js') {
        res.writeHead(200, { 'Content-Type': MIME['.js'] });
        res.end(`window.NAIL_CONFIG = { API_URL: 'http://localhost:${server.address().port}/exec', GOOGLE_CLIENT_ID: '${CLIENT_ID}', PUBLIC_BASE_URL: 'http://localhost:${server.address().port}' };`);
        return;
      }
      const file = path.join(ROOT, decodeURIComponent(url.pathname === '/' ? '/App_Manicure.html' : url.pathname));
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('404'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(port, () => {
      const base = `http://localhost:${server.address().port}`;
      gas = createGas({ apiUrl: base + '/exec' });
      gas.props.GOOGLE_CLIENT_ID = CLIENT_ID;
      gas.props.GOOGLE_CLIENT_SECRET = 'segredo-de-teste';
      gas.props.PUBLIC_BASE_URL = base;
      gas.context.setup();
      resolve({ server, base, gas, CLIENT_ID });
    });
  });
}

module.exports = { start };

if (require.main === module) {
  start(Number(process.argv[2] || 8787)).then(({ base }) => console.log('Mock em ' + base));
}
