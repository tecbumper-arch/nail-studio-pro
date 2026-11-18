// Limite de tentativas de PIN: 5 erros em 15 min por chave (KV com TTL).
const MAX_FAILURES = 5;
const WINDOW_SECONDS = 900;

export async function isLocked(kv, key) {
  const n = Number(await kv.get(key)) || 0;
  return n >= MAX_FAILURES;
}

export async function recordFailure(kv, key) {
  const n = (Number(await kv.get(key)) || 0) + 1;
  await kv.put(key, String(n), { expirationTtl: WINDOW_SECONDS });
}

export async function clearFailures(kv, key) {
  await kv.delete(key);
}
