export function parseVCard(text) {
  const unfolded = String(text || '').replace(/=\r?\n/g, '').replace(/\r?\n[ \t]/g, '');
  const blocks = unfolded.match(/BEGIN:VCARD[\s\S]*?END:VCARD/giu) || [];
  const contacts = [];
  for (const block of blocks) {
    let formattedName = '';
    let structuredName = '';
    const phones = [];
    for (const line of block.split(/\r?\n/u)) {
      const separator = line.indexOf(':');
      if (separator < 0) continue;
      const descriptor = line.slice(0, separator);
      const field = descriptor.split(';')[0].split('.').pop().toUpperCase();
      const rawValue = line.slice(separator + 1);
      const value = decodeValue(rawValue, /ENCODING=QUOTED-PRINTABLE/iu.test(descriptor));
      if (field === 'FN') formattedName = value;
      if (field === 'N') structuredName = value.split(';').filter(Boolean).reverse().join(' ');
      if (field === 'TEL') {
        const digits = value.replace(/^tel:/iu, '').replace(/\D/g, '');
        if (digits.length >= 8 && digits.length <= 15) phones.push(digits);
      }
    }
    const name = formattedName || structuredName || '';
    for (const phoneNumber of [...new Set(phones)]) contacts.push({ name, phoneNumber });
  }
  return contacts;
}

function decodeValue(value, quotedPrintable) {
  let decoded = value;
  if (quotedPrintable) {
    const bytes = [];
    for (let index = 0; index < value.length; index += 1) {
      const hex = value.slice(index + 1, index + 3);
      if (value[index] === '=' && /^[0-9A-F]{2}$/iu.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        index += 2;
      } else {
        bytes.push(...new TextEncoder().encode(value[index]));
      }
    }
    decoded = new TextDecoder().decode(new Uint8Array(bytes));
  }
  return decoded.replace(/\\n/giu, ' ').replace(/\\([,;\\])/gu, '$1').trim();
}
