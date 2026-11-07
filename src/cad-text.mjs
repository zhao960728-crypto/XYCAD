import { Buffer } from 'node:buffer';

const legacyEscapes = new Map([[1, 'shift_jis'], [2, 'big5'], [3, 'euc-kr'], [5, 'gbk']]
  .map(([page, encoding]) => [page, new TextDecoder(encoding, { fatal: true })]));

export function decodeLegacyEscapes(value) {
  return value.replace(/\\\\|\\M\+([1235])([\da-f]{4})/gi, (match, page, pair) => {
    if (!page) return match;
    try { return legacyEscapes.get(Number(page)).decode(Buffer.from(pair, 'hex')); }
    catch { return match; }
  });
}
