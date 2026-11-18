// Pix copia-e-cola (BR Code EMV), portado de App_Manicure.html.
function emvField(id, val) {
  const s = String(val);
  return id + String(s.length).padStart(2, '0') + s;
}

function cleanPixKey(key) {
  let k = String(key || '').trim();
  if (!k) return '';
  if (k.includes('@')) return k.toLowerCase();
  const digits = k.replace(/\D/g, '');
  if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(k)) {
    return k.toLowerCase();
  }
  if (digits.length === 11 && !k.startsWith('+55') && !k.startsWith('55')) {
    const ddd = parseInt(digits.slice(0, 2), 10);
    if (ddd >= 11 && ddd <= 99 && digits.charAt(2) === '9') {
      return '+55' + digits; // Celular com DDD
    }
    return digits; // CPF (11 dígitos numéricos)
  }
  if (digits.length === 10) {
    return '+55' + digits; // Fixo com DDD
  }
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) {
    return '+' + digits; // Celular já com 55
  }
  if (digits.length === 14) return digits; // CNPJ
  return digits || k;
}

export     function buildPixBrCode(key, holder, city, amount, txid) {
  const cleanKey = cleanPixKey(key);
  if (!cleanKey) return '';
  const n = String(holder || 'STUDIO NAILS').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().substring(0, 25);
  const c = String(city || 'SAO PAULO').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().substring(0, 15);
  const tid = '***';
  const gui = emvField('00', 'br.gov.bcb.pix') + emvField('01', cleanKey);
  let p = emvField('00', '01') + emvField('26', gui) + emvField('52', '0000') + emvField('53', '986');
  if (amount > 0) p += emvField('54', Number(amount).toFixed(2));
  p += emvField('58', 'BR') + emvField('59', n) + emvField('60', c) + emvField('62', emvField('05', tid)) + '6304';
  let crc = 0xFFFF;
  for (let i = 0; i < p.length; i++) {
    crc ^= (p.charCodeAt(i) << 8);
    for (let b = 0; b < 8; b++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return p + crc.toString(16).toUpperCase().padStart(4, '0');
}
