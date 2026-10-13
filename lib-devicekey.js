// Ключ устройства. Создаётся один раз и хранится в IndexedDB этого браузера.
// Основной режим — неизвлекаемый ключ WebCrypto. Если браузер не умеет хранить такой ключ
// (в Safari бывали ошибки с отдельными типами ключей), включается запасной режим:
// ключ хранится в виде JWK. Подписи в обоих режимах одинаковые.

import { openDb } from './lib-idb.js';
import {
  exportPrivateJwk, exportPublicRaw, generateKeyPair, importPrivateJwk, importPublicRaw,
  kidOf, signBytes, verifyBytes,
} from './lib-keys.js';

const PROBE = new TextEncoder().encode('zdes/key-probe');

let dbPromise = null;
function db(name) {
  if (!dbPromise) dbPromise = openDb(name, 1, { kv: {} });
  return dbPromise;
}

// То же хранилище доступно приложению для профиля и кеша: db.get('kv', ключ), db.put('kv', значение, ключ).
export function deviceDb(dbName = 'zdes-device') {
  return db(dbName);
}

async function usable(record) {
  if (!record || !record.pub) return null;
  try {
    const privateKey = record.mode === 'jwk' ? await importPrivateJwk(record.jwk) : record.privateKey;
    if (!privateKey) return null;
    const sig = await signBytes(privateKey, PROBE);
    const publicKey = await importPublicRaw(record.pub);
    if (!(await verifyBytes(publicKey, sig, PROBE))) return null;
    return privateKey;
  } catch (e) {
    return null;
  }
}

async function createRecord(store, forceJwk) {
  if (!forceJwk) {
    try {
      const pair = await generateKeyPair(false);
      const record = { mode: 'native', privateKey: pair.privateKey, pub: await exportPublicRaw(pair.publicKey), createdAt: Date.now() };
      await store.put('kv', record, 'device-key');
      // Читаем обратно: проверяем не запись, а то, что ключ пережил хранение и подписывает.
      const back = await store.get('kv', 'device-key');
      if (await usable(back)) return back;
    } catch (e) { /* переходим к запасному режиму */ }
  }
  const pair = await generateKeyPair(true);
  const record = { mode: 'jwk', jwk: await exportPrivateJwk(pair.privateKey), pub: await exportPublicRaw(pair.publicKey), createdAt: Date.now() };
  await store.put('kv', record, 'device-key');
  return record;
}

// Возвращает { sign, pub, kid, mode, existed, createdAt }.
// existed = true, если ключ найден с прошлого запуска.
export async function loadDeviceKey({ dbName = 'zdes-device', create = true } = {}) {
  const store = await db(dbName);
  let record = await store.get('kv', 'device-key');
  let privateKey = await usable(record);
  const existed = Boolean(privateKey);
  if (!privateKey) {
    if (!create) return null;
    record = await createRecord(store, false);
    privateKey = await usable(record);
    if (!privateKey) {
      record = await createRecord(store, true);
      privateKey = await usable(record);
    }
    if (!privateKey) throw new Error('Браузер не смог создать ключ устройства');
  }
  const pub = new Uint8Array(record.pub);
  return {
    sign: (bytes) => signBytes(privateKey, bytes),
    pub,
    kid: await kidOf(pub),
    mode: record.mode,
    existed,
    createdAt: record.createdAt,
  };
}

export async function forgetDeviceKey({ dbName = 'zdes-device' } = {}) {
  const store = await db(dbName);
  await store.delete('kv', 'device-key');
}

// Просит браузер не удалять данные сайта при нехватке места.
export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch (e) { /* не поддерживается */ }
  return false;
}

export function isStandalone() {
  return Boolean(window.navigator.standalone) ||
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
}

export function isIos() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
