// Построение QR-матрицы. Сообщения протокола состоят из символов алфавитно-цифрового режима QR
// и получаются компактными; ссылки (приглашения) кодируются обычным байтовым режимом.

import qrcode from './lib-qrcode.js';

const ALPHANUMERIC = /^[0-9A-Z $%*+\-./:]*$/;

export function qrMatrix(text, ecc = 'M') {
  const qr = qrcode(0, ecc);
  qr.addData(text, ALPHANUMERIC.test(text) ? 'Alphanumeric' : 'Byte');
  qr.make();
  const size = qr.getModuleCount();
  return { size, dark: (row, col) => qr.isDark(row, col) };
}

// Растровая картинка RGBA — для тестов без браузера и для отрисовки на canvas.
export function qrToRgba(text, { ecc = 'M', scale = 6, quiet = 4 } = {}) {
  const m = qrMatrix(text, ecc);
  const side = (m.size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let r = 0; r < m.size; r++) {
    for (let c = 0; c < m.size; c++) {
      if (!m.dark(r, c)) continue;
      for (let y = 0; y < scale; y++) {
        let o = (((r + quiet) * scale + y) * side + (c + quiet) * scale) * 4;
        for (let x = 0; x < scale; x++) {
          data[o] = 0; data[o + 1] = 0; data[o + 2] = 0;
          o += 4;
        }
      }
    }
  }
  return { data, width: side, height: side, modules: m.size };
}
