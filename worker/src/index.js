// Entrada do Worker: /api/rpc, /api/oauth/*, redirecionamento de / e assets estáticos.
import { createGoogle } from './google.js';
import { handleRpc } from './rpc.js';
import { handleOAuthStart, handleOAuthCallback } from './oauth.js';

export function createWorker({ fetchImpl = fetch } = {}) {
  return {
    async fetch(request, env, execCtx) {
      const url = new URL(request.url);
      const { pathname } = url;
      try {
        if (pathname === '/api/rpc') {
          return await handleRpc(request, env, createGoogle(env, fetchImpl), execCtx);
        }
        if (pathname === '/api/oauth/start') return await handleOAuthStart(request, env);
        if (pathname === '/api/oauth/callback') {
          return await handleOAuthCallback(request, env, createGoogle(env, fetchImpl));
        }
      } catch (e) {
        console.error('worker error', { path: pathname, name: e && e.name });
        return new Response('Erro interno. Tente novamente.', {
          status: 500, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
        });
      }
      if (pathname === '/' && (request.method === 'GET' || request.method === 'HEAD')) {
        return new Response(null, { status: 302, headers: { Location: '/App_Manicure.html' } });
      }
      return env.ASSETS.fetch(request);
    },
  };
}

export default createWorker();
