// Utilitários compartilhados do Worker.

// Telefone BR local: só dígitos, sem zeros à esquerda e sem o 55 do país (10 ou 11 dígitos).
export function normalizeBrPhone(s) {
  let d = String(s || '').replace(/\D/g, '').replace(/^0+/, '');
  if (!d) return '';
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) d = d.slice(2);
  return d;
}

export function toMin(t) {
  const [h, m] = String(t || '09:00').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

export function fromMin(m) {
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}

export async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Ex.: newId('AG') -> 'AG-483920'
export function newId(prefix) {
  const n = 100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000);
  return `${prefix}-${n}`;
}

// Data (YYYY-MM-DD) e minutos desde 00:00 em America/Sao_Paulo; `now` é um Date (injetável).
export function saoPauloNow(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(now);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { isoDate: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}
