// Логика станции и телефона без интерфейса и камеры.
// Станция выдаёт одноразовые коды и проверяет подписанные ответы; телефон подписывает
// последний увиденный код. Часы телефона не участвуют нигде.

import {
  ACK_LEN, FLAG_LONG_WINDOW, MAX_ACKS, NONCE_LEN, SESS_LEN,
  bytesEqual, decodeChallenge, decodeResponse, encodeChallenge, encodeResponse,
  markMessage, randomBytes, toHex,
} from './lib-proto.js';
import { importPublicRaw, sha256, signBytes, verifyBytes } from './lib-keys.js';

export const DEFAULT_WINDOW_MS = 12000;
export const LONG_WINDOW_MS = 90000;
export const DEFAULT_ROTATE_MS = 1200;
const ACK_SHOW_MS = 4500;

function monotonicNow() {
  return globalThis.performance ? globalThis.performance.now() : Date.now();
}

export class StationCore {
  constructor(opts = {}) {
    this.windowMs = opts.windowMs || DEFAULT_WINDOW_MS;
    this.rotateMs = opts.rotateMs || DEFAULT_ROTATE_MS;
    // Счётчик кода занимает один байт: окно не должно пережить его оборот.
    if (this.windowMs > this.rotateMs * 200) this.rotateMs = Math.ceil(this.windowMs / 200);
    this.now = opts.now || monotonicNow;
    this.flags = (opts.flags || 0) | (this.windowMs > 30000 ? FLAG_LONG_WINDOW : 0);
    this.sess = opts.sess || randomBytes(SESS_LEN);
    // Подтверждать ли на экране ответы неизвестных устройств (в рабочем режиме да: запись сохраняется).
    this.ackUnknown = opts.ackUnknown !== false;
    this.devices = new Map();      // kid (hex) → { key, ref }
    this.challenges = new Map();   // ctr → { nonce, t }
    this.acks = [];                // { tag, until }
    this.seen = new Map();         // текст ответа → { result, t }
    this.ctr = randomBytes(1)[0];
    this.lastRotate = -Infinity;
    this.dirty = true;
    this.rotate();
  }

  // Добавляет устройство в список известных. ref — что угодно: студент, запись реестра.
  async addDevice(kid, rawPublicKey, ref) {
    const key = await importPublicRaw(rawPublicKey);
    this.devices.set(toHex(kid), { key, ref });
  }

  removeDevice(kid) {
    this.devices.delete(toHex(kid));
  }

  rotate() {
    const now = this.now();
    this.ctr = (this.ctr + 1) & 0xff;
    this.challenges.set(this.ctr, { nonce: randomBytes(NONCE_LEN), t: now });
    for (const [ctr, ch] of this.challenges) {
      if (now - ch.t > this.windowMs + this.rotateMs) this.challenges.delete(ctr);
    }
    this.lastRotate = now;
    this.dirty = true;
  }

  // Вызывать несколько раз в секунду. Возвращает true, если QR нужно перерисовать.
  tick() {
    const now = this.now();
    if (now - this.lastRotate >= this.rotateMs) this.rotate();
    const before = this.acks.length;
    this.acks = this.acks.filter((a) => a.until > now);
    if (this.acks.length !== before) this.dirty = true;
    for (const [text, entry] of this.seen) {
      if (now - entry.t > this.windowMs * 2 + 5000) this.seen.delete(text);
    }
    const dirty = this.dirty;
    this.dirty = false;
    return dirty;
  }

  challengeText() {
    const ch = this.challenges.get(this.ctr);
    return encodeChallenge({
      sess: this.sess,
      nonce: ch.nonce,
      ctr: this.ctr,
      flags: this.flags,
      acks: this.acks.slice(-MAX_ACKS).map((a) => a.tag),
    });
  }

  // Итог проверки:
  //   ok             — подпись верна, код свежий; ref — владелец ключа
  //   unknown-device — ключа нет в списке станции; запись можно сохранить, сервер проверит позже
  //   stale          — код, на который отвечали, уже не действует (в том числе повтор старого ответа)
  //   bad-signature  — ключ известен, подпись не сошлась
  //   malformed      — не разобрать
  //   foreign        — посторонний QR
  async handleScan(text) {
    if (typeof text !== 'string' || !text.startsWith('ZR')) return { type: 'foreign' };
    const now = this.now();
    const cached = this.seen.get(text);
    if (cached) {
      // Тот же ответ в соседних кадрах — одно предъявление. Но принятый ответ не живёт дольше
      // своего кода: показанный позже (фото, снимок экрана) он уже устаревший.
      if (cached.freshUntil === undefined || now <= cached.freshUntil) return Object.assign({ repeat: true }, cached.result);
      const expired = { type: 'stale', kid: cached.result.kid };
      this.seen.set(text, { result: expired, t: now });
      return expired;
    }

    let parsed;
    try {
      parsed = decodeResponse(text);
    } catch (e) {
      return { type: 'malformed' };
    }
    const kidHex = toHex(parsed.kid);
    const ch = this.challenges.get(parsed.ctr);
    let result;
    if (!ch || now - ch.t > this.windowMs) {
      result = { type: 'stale', kid: kidHex };
    } else {
      const ageMs = now - ch.t;
      const device = this.devices.get(kidHex);
      const base = { kid: kidHex, sess: this.sess, nonce: ch.nonce, sig: parsed.sig, ageMs };
      if (!device) {
        result = Object.assign({ type: 'unknown-device' }, base);
      } else if (await verifyBytes(device.key, parsed.sig, markMessage(this.sess, ch.nonce, parsed.kid))) {
        result = Object.assign({ type: 'ok', ref: device.ref }, base);
      } else {
        result = { type: 'bad-signature', kid: kidHex, ref: device.ref };
      }
    }
    if (result.type === 'ok' || (result.type === 'unknown-device' && this.ackUnknown)) {
      const tag = (await sha256(parsed.sig)).slice(0, ACK_LEN);
      this.acks.push({ tag, until: this.now() + ACK_SHOW_MS });
      this.dirty = true;
    }
    const fresh = result.type === 'ok' || result.type === 'unknown-device';
    this.seen.set(text, { result, t: now, freshUntil: fresh ? ch.t + this.windowMs : undefined });
    return result;
  }
}

export class PhoneCore {
  // sign(bytes) → Promise<Uint8Array(64)>; kid — идентификатор ключа устройства.
  constructor({ sign, kid }) {
    this.sign = sign;
    this.kid = kid;
    this.lastKey = '';
    this.responseText = '';
    this.tags = [];        // подписи, на которые ждём подтверждения: { tag, sessHex }
    this.ackedSess = '';   // сеанс станции, подтвердивший отметку
  }

  static withPrivateKey(privateKey, kid) {
    return new PhoneCore({ sign: (bytes) => signBytes(privateKey, bytes), kid });
  }

  // Возвращает null для постороннего QR, иначе:
  //   { changed, responseText, flags, acked, sess }
  async handleScan(text) {
    if (typeof text !== 'string' || !text.startsWith('ZC')) return null;
    let ch;
    try {
      ch = decodeChallenge(text);
    } catch (e) {
      return null;
    }
    const sessHex = toHex(ch.sess);
    const key = sessHex + toHex(ch.nonce);
    let changed = false;
    if (key !== this.lastKey) {
      this.lastKey = key;
      const sig = await this.sign(markMessage(ch.sess, ch.nonce, this.kid));
      const tag = (await sha256(sig)).slice(0, ACK_LEN);
      this.tags.push({ tag, sessHex });
      if (this.tags.length > 12) this.tags.shift();
      this.responseText = encodeResponse({ kid: this.kid, ctr: ch.ctr, sig });
      changed = true;
    }
    let acked = false;
    for (const ack of ch.acks) {
      if (this.tags.some((t) => t.sessHex === sessHex && bytesEqual(t.tag, ack))) acked = true;
    }
    if (acked) this.ackedSess = sessHex;
    return { changed, responseText: this.responseText, flags: ch.flags, acked, sess: sessHex };
  }

  reset() {
    this.lastKey = '';
    this.responseText = '';
    this.tags = [];
    this.ackedSess = '';
  }
}
