'use strict';

/** Same djb2 helper as index.html `hashStr`. */
function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** Same conservative CSV fingerprint as index.html `txHash`. */
function txHash(t) {
  return hashStr(`${t.date}|${t.amount.toFixed(2)}|${t.desc.toLowerCase().trim()}|${t.account}`);
}

module.exports = { hashStr, txHash };
