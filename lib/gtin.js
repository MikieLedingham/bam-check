// Barcode helpers: validate the check digit and turn whatever the scanner
// produced (UPC-A, UPC-E, EAN-8, EAN-13, GTIN-14) into the forms the food
// databases key on.

export function digitsOnly(s) {
  return String(s ?? '').replace(/\D/g, '');
}

// GTIN check digit (same weights for GTIN-8/12/13/14).
export function checkDigitOk(code) {
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false;
  const d = code.split('').map(Number);
  const check = d.pop();
  let sum = 0;
  for (let i = d.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += d[i] * w;
  return (10 - (sum % 10)) % 10 === check;
}

// Expand an 8-digit UPC-E code to the 12-digit UPC-A it stands for.
export function upcEToUpcA(e8) {
  if (!/^[01]\d{7}$/.test(e8)) return null;
  const [ns, a, b, c, d, e, x, chk] = e8.split('');
  let body;
  if ('012'.includes(x)) body = ns + a + b + x + '0000' + c + d + e;
  else if (x === '3') body = ns + a + b + c + '00000' + d + e;
  else if (x === '4') body = ns + a + b + c + d + '00000' + e;
  else body = ns + a + b + c + d + e + '0000' + x;
  return body + chk;
}

// format is the scanner's hint ('upc_e', 'ean_8', ...) when there is one.
// Returns { ok:true, code, gtin14, ean13, kind, storeLabel } or { ok:false, error }.
export function normalizeBarcode(raw, format = '') {
  const digits = digitsOnly(raw);
  if (!digits) return { ok: false, error: 'Enter the digits printed under the barcode.' };

  let code = digits;
  let kind;
  if (digits.length === 8) {
    const expanded = upcEToUpcA(digits);
    const asUpcE = expanded && checkDigitOk(expanded);
    const asEan8 = checkDigitOk(digits);
    if (format === 'upc_e' && asUpcE) { code = expanded; kind = 'UPC-E'; }
    else if (format === 'ean_8' && asEan8) kind = 'EAN-8';
    else if (asUpcE) { code = expanded; kind = 'UPC-E'; }
    else if (asEan8) kind = 'EAN-8';
    else return { ok: false, error: 'That barcode number has a wrong check digit - it may have been misread.' };
  } else if (digits.length === 12) kind = 'UPC-A';
  else if (digits.length === 13) kind = 'EAN-13';
  else if (digits.length === 14) kind = 'GTIN-14';
  else return { ok: false, error: `A product barcode has 8, 12, 13 or 14 digits (got ${digits.length}).` };

  if (!checkDigitOk(code)) {
    return { ok: false, error: 'That barcode number has a wrong check digit - it may have been misread.' };
  }
  const gtin14 = code.padStart(14, '0');
  // Scanners report a US UPC-A as a 13-digit EAN with a leading 0. Use one
  // canonical spelling (as printed on the pack) so scans and typed numbers
  // are the same product.
  if (kind !== 'EAN-8') {
    if (gtin14.startsWith('00')) { code = gtin14.slice(2); kind = 'UPC-A'; }
    else if (gtin14.startsWith('0')) { code = gtin14.slice(1); kind = 'EAN-13'; }
    else { code = gtin14; kind = 'GTIN-14'; }
  }
  // Variable-weight / in-store labels (deli, butcher, produce stickers) start with 2
  // and carry a price or weight, so no database can know them.
  const storeLabel = (kind === 'EAN-13' && code[0] === '2') || (kind === 'UPC-A' && code[0] === '2');
  // A GTIN-14 with a non-zero indicator digit has no EAN-13 form.
  const ean13 = gtin14[0] === '0' ? gtin14.slice(1) : null;
  return { ok: true, code, gtin14, ean13, kind, storeLabel };
}
