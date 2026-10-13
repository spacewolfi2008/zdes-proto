// Ключи устройств: ECDSA P-256 через WebCrypto (одинаково в браузере и в Node).

import { KID_LEN } from './lib-proto.js';

const subtle = globalThis.crypto.subtle;
const CURVE = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN = { name: 'ECDSA', hash: 'SHA-256' };

export function generateKeyPair(extractable = false) {
  return subtle.generateKey(CURVE, extractable, ['sign', 'verify']);
}

export async function exportPublicRaw(publicKey) {
  return new Uint8Array(await subtle.exportKey('raw', publicKey));
}

export function importPublicRaw(raw) {
  return subtle.importKey('raw', raw, CURVE, true, ['verify']);
}

export function exportPrivateJwk(privateKey) {
  return subtle.exportKey('jwk', privateKey);
}

export function importPrivateJwk(jwk) {
  return subtle.importKey('jwk', jwk, CURVE, true, ['sign']);
}

export async function signBytes(privateKey, bytes) {
  return new Uint8Array(await subtle.sign(SIGN, privateKey, bytes));
}

export async function verifyBytes(publicKey, sig, bytes) {
  try {
    return await subtle.verify(SIGN, publicKey, sig, bytes);
  } catch (e) {
    return false;
  }
}

export async function sha256(bytes) {
  return new Uint8Array(await subtle.digest('SHA-256', bytes));
}

// Короткий идентификатор ключа: первые байты SHA-256 от открытого ключа.
export async function kidOf(rawPublicKey) {
  return (await sha256(rawPublicKey)).slice(0, KID_LEN);
}
