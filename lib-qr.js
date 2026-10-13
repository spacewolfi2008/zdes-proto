// Отрисовка QR на canvas: целое число пикселей на модуль, белые поля вокруг.

import { qrMatrix } from './lib-qrmatrix.js';

export function drawQr(canvas, text, { ecc = 'M', quiet = 4 } = {}) {
  const matrix = qrMatrix(text, ecc);
  const total = matrix.size + quiet * 2;
  const cssSize = canvas.clientWidth || canvas.width || 300;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const scale = Math.max(2, Math.floor((cssSize * dpr) / total));
  const side = total * scale;
  if (canvas.width !== side || canvas.height !== side) {
    canvas.width = side;
    canvas.height = side;
  }
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, side, side);
  ctx.fillStyle = '#000000';
  for (let r = 0; r < matrix.size; r++) {
    for (let c = 0; c < matrix.size; c++) {
      if (matrix.dark(r, c)) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
    }
  }
  return matrix.size;
}

export function clearQr(canvas) {
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}
