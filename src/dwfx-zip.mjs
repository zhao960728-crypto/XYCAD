import { Buffer } from 'node:buffer';
import { crc32, inflateRawSync } from 'node:zlib';
import { dwfxLimits } from './cad-budget.mjs';

function check(valid) {
  if (!valid) throw new Error('CAD 压缩包目录无效、文件损坏或超出读取容量。');
}

export function openCadPackage(input) {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) return null;
  let end = bytes.length - 22;
  const earliest = Math.max(0, end - 65535);
  while (end >= earliest && (bytes.readUInt32LE(end) !== 0x06054b50 ||
      end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length)) end--;
  check(end >= earliest && bytes.readUInt32LE(end + 4) === 0);
  const count = bytes.readUInt16LE(end + 10);
  const start = bytes.readUInt32LE(end + 16);
  check(count > 0 && count <= 4096 && bytes.readUInt16LE(end + 8) === count && start + bytes.readUInt32LE(end + 12) === end);
  const directory = new Map();
  let cursor = start;
  for (let i = 0; i < count; i++) {
    check(cursor + 46 <= end && bytes.readUInt32LE(cursor) === 0x02014b50);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const next = cursor + 46 + nameLength + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
    check(nameLength > 0 && nameLength <= 1024 && next <= end && bytes.readUInt16LE(cursor + 34) === 0);
    const name = bytes.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    check(!directory.has(name) && !/[\\\0]/.test(name) && !name.startsWith('/') && !name.split('/').includes('..'));
    directory.set(name, cursor);
    cursor = next;
  }
  check(cursor === end);

  let expanded = 0;
  return {
    has: name => directory.has(name),
    read(name) {
      const entry = directory.get(name);
      check(entry !== undefined);
      const flags = bytes.readUInt16LE(entry + 8);
      const method = bytes.readUInt16LE(entry + 10);
      const packed = bytes.readUInt32LE(entry + 20);
      const size = bytes.readUInt32LE(entry + 24);
      const offset = bytes.readUInt32LE(entry + 42);
      check(!(flags & 0x2041) && [0, 8].includes(method) && size > 0 &&
        (expanded += size) <= dwfxLimits.expandedBytes && offset + 30 <= start && bytes.readUInt32LE(offset) === 0x04034b50);
      const nameLength = bytes.readUInt16LE(offset + 26);
      const dataStart = offset + 30 + nameLength + bytes.readUInt16LE(offset + 28);
      check(dataStart + packed <= start && bytes.readUInt16LE(offset + 8) === method &&
        bytes.toString('utf8', offset + 30, offset + 30 + nameLength) === name);
      const source = bytes.subarray(dataStart, dataStart + packed);
      let data;
      try { data = method === 8 ? inflateRawSync(source, { maxOutputLength: size }) : source; }
      catch { throw new Error('CAD 压缩包数据流无法解压。'); }
      check(data.length === size && crc32(data) === bytes.readUInt32LE(entry + 16));
      return data;
    },
  };
}
