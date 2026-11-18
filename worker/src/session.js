// Token de sessão assinado: v1.<b64url(json com exp)>.<b64url(HMAC-SHA256)>
const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlEncode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  if (!/^[A-Za-z0-9_-]*$/.test(str)) throw new Error('bad base64url');
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (str.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hmacKey(secret, usage) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

export async function signToken(payload, secret, ttlSeconds, now = Date.now()) {
  const body = { ...payload, exp: Math.floor(now / 1000) + ttlSeconds };
  const data = b64urlEncode(enc.encode(JSON.stringify(body)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), enc.encode('v1.' + data));
  return `v1.${data}.${b64urlEncode(new Uint8Array(sig))}`;
}

export async function verifyToken(token, secret, now = Date.now()) {
  try {
    if (typeof token !== 'string' || !secret) return null;
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') return null;
    const ok = await crypto.subtle.verify(
      'HMAC', await hmacKey(secret, 'verify'), b64urlDecode(parts[2]), enc.encode(`v1.${parts[1]}`));
    if (!ok) return null;
    const payload = JSON.parse(dec.decode(b64urlDecode(parts[1])));
    if (!payload || typeof payload !== 'object' || typeof payload.exp !== 'number') return null;
    if (Math.floor(now / 1000) >= payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}
