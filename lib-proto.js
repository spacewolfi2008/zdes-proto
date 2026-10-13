// Формат QR-сообщений между станцией преподавателя и телефоном студента.
// Модуль общий для браузера и Node (тесты, сервер).
//
//   ZC… — код станции (challenge): sess(4) nonce(8) ctr(1) flags(1) acks(4·n)
//   ZR… — ответ телефона (response): kid(4) ctr(1) sig(64)
//   ZE… — визитка устройства: pub(65) diag(1) label(utf8), только для прототипа и тестов
//
// После двухбуквенного префикса идёт Base45: он целиком ложится в алфавитно-цифровой
// режим QR, поэтому коды получаются мелкими по версии и крупными по модулю.

const B45 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
const B45_INDEX = new Map([...B45].map((ch, i) => [ch, i]));

export const SESS_LEN = 4;
export const NONCE_LEN = 8;
export const KID_LEN = 4;
export const SIG_LEN = 64;
export const ACK_LEN = 4;
export const MAX_ACKS = 4;

export const FLAG_REHEARSAL = 1;
export const FLAG_LONG_WINDOW = 2;

const MARK_DOMAIN = new TextEncoder().encode('zdes/mark/v1\0');

export function b45encode(bytes) {
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const n = bytes[i] * 256 + bytes[i + 1];
    out += B45[n % 45] + B45[Math.floor(n / 45) % 45] + B45[Math.floor(n / 2025)];
  }
  if (bytes.length % 2 === 1) {
    const n = bytes[bytes.length - 1];
    out += B45[n % 45] + B45[Math.floor(n / 45)];
  }
  return out;
}

export function b45decode(str) {
  const len = str.length;
  if (len % 3 === 1) throw new Error('base45: неверная длина');
  const out = new Uint8Array(Math.floor(len / 3) * 2 + (len % 3 === 2 ? 1 : 0));
  let o = 0;
  for (let i = 0; i < len; i += 3) {
    const rest = len - i;
    const a = B45_INDEX.get(str[i]);
    const b = B45_INDEX.get(str[i + 1]);
    if (a === undefined || b === undefined) throw new Error('base45: недопустимый символ');
    if (rest >= 3) {
      const c = B45_INDEX.get(str[i + 2]);
      if (c === undefined) throw new Error('base45: недопустимый символ');
      const n = a + b * 45 + c * 2025;
      if (n > 0xffff) throw new Error('base45: переполнение');
      out[o++] = n >> 8;
      out[o++] = n & 0xff;
    } else {
      const n = a + b * 45;
      if (n > 0xff) throw new Error('base45: переполнение');
      out[o++] = n;
    }
  }
  return out;
}

export function concatBytes(...parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function toHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  return s;
}

export function fromHex(hex) {
  if (typeof hex !== 'string' || hex.length % 2 || /[^0-9a-f]/i.test(hex)) throw new Error('hex: неверная строка');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function fromBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomBytes(n) {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

// --- Код станции -------------------------------------------------------------

export function encodeChallenge({ sess, nonce, ctr, flags = 0, acks = [] }) {
  if (sess.length !== SESS_LEN || nonce.length !== NONCE_LEN) throw new Error('challenge: неверные длины');
  const list = acks.slice(0, MAX_ACKS);
  return 'ZC' + b45encode(concatBytes(sess, nonce, Uint8Array.of(ctr & 0xff, flags & 0xff), ...list));
}

export function decodeChallenge(text) {
  if (typeof text !== 'string' || text.length > 120 || !text.startsWith('ZC')) throw new Error('не код станции');
  const b = b45decode(text.slice(2));
  const head = SESS_LEN + NONCE_LEN + 2;
  if (b.length < head || (b.length - head) % ACK_LEN !== 0 || (b.length - head) / ACK_LEN > MAX_ACKS) {
    throw new Error('challenge: неверная длина');
  }
  const acks = [];
  for (let o = head; o < b.length; o += ACK_LEN) acks.push(b.slice(o, o + ACK_LEN));
  return {
    sess: b.slice(0, SESS_LEN),
    nonce: b.slice(SESS_LEN, SESS_LEN + NONCE_LEN),
    ctr: b[SESS_LEN + NONCE_LEN],
    flags: b[SESS_LEN + NONCE_LEN + 1],
    acks,
  };
}

// --- Ответ телефона ----------------------------------------------------------

export function encodeResponse({ kid, ctr, sig }) {
  if (kid.length !== KID_LEN || sig.length !== SIG_LEN) throw new Error('response: неверные длины');
  return 'ZR' + b45encode(concatBytes(kid, Uint8Array.of(ctr & 0xff), sig));
}

export function decodeResponse(text) {
  if (typeof text !== 'string' || text.length > 120 || !text.startsWith('ZR')) throw new Error('не ответ телефона');
  const b = b45decode(text.slice(2));
  if (b.length !== KID_LEN + 1 + SIG_LEN) throw new Error('response: неверная длина');
  return { kid: b.slice(0, KID_LEN), ctr: b[KID_LEN], sig: b.slice(KID_LEN + 1) };
}

// Что именно подписывает телефон: привязка к сеансу станции, одноразовому коду и ключу.
export function markMessage(sess, nonce, kid) {
  return concatBytes(MARK_DOMAIN, sess, nonce, kid);
}

// Что подписывает устройство при входе на сервер: одноразовое число сервера и свой идентификатор.
export function loginMessage(nonceHex, deviceId) {
  return concatBytes(new TextEncoder().encode('zdes/login/v1\0'), fromHex(nonceHex), new TextEncoder().encode(deviceId));
}

// --- Визитка устройства (прототип и тесты) -------------------------------------

export function encodeEnroll({ pub, label = '', diag = 0 }) {
  if (pub.length !== 65) throw new Error('enroll: ожидается несжатый ключ P-256');
  // Обрезаем по символам, а не по байтам, чтобы не разорвать букву кириллицы.
  let text = label;
  let name = new TextEncoder().encode(text);
  while (name.length > 28) {
    text = text.slice(0, -1);
    name = new TextEncoder().encode(text);
  }
  return 'ZE' + b45encode(concatBytes(pub, Uint8Array.of(diag & 0xff), name));
}

export function decodeEnroll(text) {
  if (typeof text !== 'string' || text.length > 200 || !text.startsWith('ZE')) throw new Error('не визитка устройства');
  const b = b45decode(text.slice(2));
  if (b.length < 66 || b[0] !== 4) throw new Error('enroll: неверный ключ');
  let label = '';
  try { label = new TextDecoder('utf-8', { fatal: false }).decode(b.slice(66)); } catch (e) { label = ''; }
  return { pub: b.slice(0, 65), diag: b[65], label: label.replace(/[\u0000-\u001f�]/g, '').trim() };
}

export function kindOf(text) {
  if (typeof text !== 'string' || text.length < 3 || text[0] !== 'Z') return null;
  if (text[1] === 'C') return 'challenge';
  if (text[1] === 'R') return 'response';
  if (text[1] === 'E') return 'enroll';
  return null;
}
