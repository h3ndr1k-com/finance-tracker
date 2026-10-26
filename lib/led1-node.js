'use strict';
/* Node LED1 encrypt/decrypt — same wire format as sync.js (browser). */

const crypto = require('crypto');

const PBKDF2_ITER = 600000;
const MAGIC = Buffer.from('LED1');

function b64(buf) {
  return Buffer.from(buf).toString('base64');
}

function unb64(s) {
  return Buffer.from(String(s || ''), 'base64');
}

function isLed1Buffer(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 34 && buf.subarray(0, 4).equals(MAGIC) && buf[4] === 1;
}

function saltFromLed1(buf) {
  if (!isLed1Buffer(buf)) throw new Error('NOT_LEDGER_FILE');
  return buf.subarray(5, 21);
}

function deriveKey(passphrase, salt) {
  return crypto.pbkdf2Sync(String(passphrase), salt, PBKDF2_ITER, 32, 'sha256');
}

function encryptJson(passphrase, salt, obj) {
  const key = deriveKey(passphrase, salt);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const pt = Buffer.from(JSON.stringify(obj), 'utf8');
  const ct = Buffer.concat([cipher.update(pt), cipher.final(), cipher.getAuthTag()]);
  const out = Buffer.alloc(4 + 1 + 16 + 12 + ct.length);
  MAGIC.copy(out, 0);
  out[4] = 1;
  salt.copy(out, 5);
  iv.copy(out, 21);
  ct.copy(out, 33);
  return out;
}

function decryptJson(passphrase, buf) {
  const u8 = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (!isLed1Buffer(u8)) throw new Error('NOT_LEDGER_FILE');
  const salt = u8.subarray(5, 21);
  const iv = u8.subarray(21, 33);
  const ct = u8.subarray(33);
  const key = deriveKey(passphrase, salt);
  const tag = ct.subarray(ct.length - 16);
  const data = ct.subarray(0, ct.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  let pt;
  try {
    pt = Buffer.concat([decipher.update(data), decipher.final()]);
  } catch {
    throw new Error('WRONG_PASSPHRASE');
  }
  return { json: JSON.parse(pt.toString('utf8')), saltB64: b64(salt) };
}

module.exports = {
  PBKDF2_ITER,
  b64,
  unb64,
  isLed1Buffer,
  saltFromLed1,
  encryptJson,
  decryptJson,
};
