// Draws EAN-13 / UPC-A barcodes on a canvas so the scanner can be tested
// without a physical product. Browser-only helper (used by the self-test).

const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
const R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

export function ean13Modules(code13) {
  const d = code13.split('').map(Number);
  const par = PARITY[d[0]];
  let bits = '101';
  for (let i = 0; i < 6; i++) bits += (par[i] === 'L' ? L : G)[d[i + 1]];
  bits += '01010';
  for (let i = 0; i < 6; i++) bits += R[d[i + 7]];
  return bits + '101';
}

// code: 13 digits, or 12 (UPC-A, gets a leading 0)
export function drawBarcode(canvas, code, { module = 3, height = 160, quiet = 12, label = true } = {}) {
  const code13 = code.length === 12 ? `0${code}` : code;
  const bits = ean13Modules(code13);
  const w = (bits.length + quiet * 2) * module;
  const h = height + (label ? 30 : 0) + 20;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#000';
  for (let i = 0; i < bits.length; i++) {
    if (bits[i] === '1') ctx.fillRect((quiet + i) * module, 10, module, height);
  }
  if (label) {
    ctx.font = `${Math.round(module * 6)}px monospace`;
    ctx.textAlign = 'center';
    ctx.fillText(code, w / 2, height + 34);
  }
  return canvas;
}
