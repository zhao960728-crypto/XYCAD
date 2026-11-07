import { Buffer } from 'node:buffer';

const signature = Buffer.from('AutoCAD Binary DXF\r\n\x1a\0', 'ascii');

export function isBinaryDxf(bytes) {
  return bytes.length >= signature.length && signature.every((byte, i) => byte === bytes[i]);
}

function valueType(code) {
  if (code < 10 || [100, 101, 102, 105, 999].includes(code) ||
      code >= 300 && code <= 309 || code >= 320 && code <= 369 || code >= 390 && code <= 399 ||
      code >= 410 && code <= 419 || code >= 430 && code <= 439 || code >= 470 && code <= 481 ||
      code >= 1000 && code <= 1009 && code !== 1004) return 'string';
  if (code >= 310 && code <= 319 || code === 1004) return 'chunk';
  if (code <= 59 || code >= 110 && code <= 149 || code >= 210 && code <= 239 ||
      code >= 460 && code <= 469 || code >= 1010 && code <= 1059) return 'double';
  if (code >= 160 && code <= 169) return 'long';
  if (code >= 290 && code <= 299) return 'boolean';
  if (code <= 79 || code >= 170 && code <= 179 || code >= 270 && code <= 289 ||
      code >= 370 && code <= 389 || code >= 400 && code <= 409 || code >= 1060 && code <= 1070) return 'short';
  if (code >= 90 && code <= 99 || code >= 420 && code <= 429 || code >= 440 && code <= 459 || code === 1071) return 'integer';
  throw new Error(`二进制 DXF 的组码 ${code} 不受支持。`);
}

export function binaryDxfGroups(input, codePages, warn) {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  let offset = signature.length;
  const legacyCodes = bytes[offset] === 0 && bytes.toString('ascii', offset + 1, offset + 8) === 'SECTION';
  const take = length => {
    if (offset + length > bytes.length) throw new Error('二进制 DXF 数据被截断。');
    const from = offset;
    offset += length;
    return from;
  };
  const groups = [];
  let ended = false;
  while (offset < bytes.length) {
    let code = legacyCodes ? bytes[take(1)] : bytes.readUInt16LE(take(2));
    if (legacyCodes && code === 255) code = bytes.readUInt16LE(take(2));
    const type = valueType(code);
    let value;
    if (type === 'string') {
      const end = bytes.indexOf(0, offset);
      if (end < offset || end - offset > 65536) throw new Error('二进制 DXF 字符串超限或未终止。');
      value = bytes.subarray(take(end - offset + 1), end);
      if (code === 0 && value.toString('ascii') === 'EOF') { ended = true; break; }
    } else if (type === 'chunk') {
      const size = bytes[take(1)];
      const start = take(size);
      value = bytes.toString('hex', start, start + size);
    } else if (type === 'double') value = String(bytes.readDoubleLE(take(8)));
    else if (type === 'long') value = String(bytes.readBigInt64LE(take(8)));
    else if (type === 'integer') value = String(bytes.readInt32LE(take(4)));
    else if (type === 'short') value = String(bytes.readInt16LE(take(2)));
    else value = String(bytes[take(1)]);
    if (groups.length >= 600000) throw new Error('二进制 DXF 组码数量超出预览容量。');
    if (code !== 999) groups.push([code, value]);
  }
  if (!ended) throw new Error('二进制 DXF 缺少结束标记。');

  const field = name => {
    const i = groups.findIndex(([code, value]) => code === 9 && value.toString('ascii') === name);
    return i < 0 ? '' : groups[i + 1]?.[1].toString('ascii').trim().toUpperCase() ?? '';
  };
  const version = field('$ACADVER');
  const codepage = field('$DWGCODEPAGE');
  const old = legacyCodes || version && Number(version.slice(2)) < 1021;
  const encoding = old ? codePages.get(codepage) : 'utf-8';
  let decoder;
  try { if (encoding) decoder = new TextDecoder(encoding, { fatal: true }); }
  catch { /* Some historical code pages are unavailable in the runtime. */ }
  if (!decoder && codepage) {
    warn(`二进制 DXF 代码页 ${codepage} 暂按 Windows-1252 读取。`);
  }
  decoder ??= new TextDecoder('windows-1252', { fatal: true });
  const fallback = new TextDecoder(decoder.encoding);
  let damaged = false;
  for (const group of groups) {
    if (typeof group[1] === 'string') continue;
    try { group[1] = decoder.decode(group[1]); }
    catch { group[1] = fallback.decode(group[1]); damaged = true; }
  }
  if (damaged) warn('二进制 DXF 文字含无法解码的字节。');
  return [groups, `二进制 · ${decoder.encoding.toUpperCase()}`];
}
