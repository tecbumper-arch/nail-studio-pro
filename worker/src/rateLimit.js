// Limite de tentativas de PIN: 5 erros em 15 min por chave (KV com TTL).
// O plano grátis do KV tem 1.000 gravações por dia: só gravamos quando há erro de PIN de uma
// conta que existe, e só apagamos um contador que existe. Se o KV falhar (fora do ar ou cota
// estourada), o login segue sem limite em vez de dar erro 500; o problema fica no log.
const MAX_FAILURES = 5;
const WINDOW_SECONDS = 900;

function warn(op, e) {
  console.warn('rate limit indisponível', { op, error: e && e.message });
}

// Número de erros na janela atual (0 se o KV falhar).
export async function getFailures(kv, key) {
  try {
    return Number(await kv.get(key)) || 0;
  } catch (e) {
    warn('get', e);
    return 0;
  }
}

export function isOverLimit(failures) {
  return failures >= MAX_FAILURES;
}

export async function recordFailure(kv, key, current) {
  try {
    const n = (current ?? (Number(await kv.get(key)) || 0)) + 1;
    await kv.put(key, String(n), { expirationTtl: WINDOW_SECONDS });
  } catch (e) {
    warn('put', e);
  }
}

// Só apaga quando havia contador (cada delete conta como gravação).
export async function clearFailures(kv, key, current) {
  if (!current) return;
  try {
    await kv.delete(key);
  } catch (e) {
    warn('delete', e);
  }
}
