import { Buffer } from 'node:buffer';
import { dwgSectionLimit } from './cad-budget.mjs';

const pageBase = 0x480;
const required = new Set(['AcDb:Header', 'AcDb:Classes', 'AcDb:Handles', 'AcDb:AcDbObjects']);

function check(ok, problem) {
  if (!ok) throw new Error(`AC1021 ${problem}`);
}

// Each row lists consecutive source sub-blocks in destination order (section 5.10).
const subBlocks = [[], [1], [1, 1], [1, 1, 1], [4], [1, 4], [1, 4, 1], [2, 4, 1], [8],
  [1, 8], [1, 8, 1], [2, 8, 1], [4, 8], [1, 4, 8], [1, 4, 8, 1], [2, 4, 8, 1],
  [16], [8, 1, 8], [1, 16, 1], [3, 16], [4, 16], [1, 4, 16], [2, 4, 16], [3, 4, 16],
  [8, 16], [8, 1, 16], [1, 8, 1, 16], [2, 8, 1, 16], [4, 8, 16], [1, 4, 8, 16], [2, 4, 8, 16], [1, 4, 8, 16, 2], [16, 16]];
const literalOrders = subBlocks.map((parts, length) => {
  if (length === 4 || length === 8) return Array.from({ length }, (_, i) => i);
  let end = length;
  return parts.flatMap(size => {
    end -= size;
    if (size === 16) return Array.from({ length: 16 }, (_, i) => end + (i + 8) % 16);
    if (size === 4 || size === 8) return Array.from({ length: size }, (_, i) => end + i);
    return Array.from({ length: size }, (_, i) => end + size - 1 - i);
  });
});

export function expandAc1021(source, size) {
  check(size > 0 && size <= dwgSectionLimit, '解压长度越界。');
  const output = Buffer.alloc(size);
  let from = 0;
  let to = 0;
  const byte = () => {
    check(from < source.length, '压缩指令被截断。');
    return source[from++];
  };
  const word = () => byte() | byte() << 8;
  let opcode = byte();
  let literalCount = 0;
  if ((opcode >>> 4) === 2) {
    byte(); byte();
    literalCount = byte() & 7;
    check(literalCount > 0, '压缩起始指令无效。');
  }
  while (to < size) {
    if (!literalCount) {
      literalCount = opcode + 8;
      if (literalCount === 23) {
        let extra = byte();
        literalCount += extra;
        if (extra === 255) {
          do { extra = word(); literalCount += extra; } while (extra === 65535);
        }
      }
    }
    check(from + literalCount <= source.length && to + literalCount <= size, '压缩页的字面数据越界。');
    while (literalCount) {
      const chunk = Math.min(literalCount, 32);
      for (const offset of literalOrders[chunk]) output[to++] = source[from + offset];
      from += chunk;
      literalCount -= chunk;
    }
    if (to === size) break;
    opcode = byte();
    for (;;) {
      let length, distance;
      const mode = opcode >>> 4;
      if (mode <= 1) {
        length = (opcode & 15) + (mode ? 3 : 19);
        distance = byte();
        opcode = byte();
        if (!mode) length += (opcode >>> 3) & 16;
        distance += ((opcode & (mode ? 248 : 120)) << 5) + 1;
      } else if (mode === 2) {
        distance = word();
        length = opcode & 7;
        if (opcode & 8) {
          distance++;
          length += byte() << 3;
          opcode = byte();
          length += ((opcode & 248) << 8) + 256;
        } else {
          opcode = byte();
          length += opcode & 248;
        }
      } else {
        length = mode;
        distance = opcode & 15;
        opcode = byte();
        distance += ((opcode & 248) << 1) + 1;
      }
      check(distance > 0 && distance <= to && length > 0 && to + length <= size, '压缩页的回引用越界。');
      for (let end = to + length; to < end; to++) output[to] = output[to - distance];
      literalCount = opcode & 7;
      if (literalCount || to === size) break;
      opcode = byte();
      if ((opcode >>> 4) === 0) break;
      if ((opcode >>> 4) === 15) opcode &= 15;
    }
  }
  check(from === source.length && !literalCount, '解压长度与页索引不符。');
  return output;
}

function payload(input, offset, blocks, blockSize) {
  check(blocks > 0 && offset >= 0 && offset + blocks * 255 <= input.length, '交错页超出文件范围。');
  const data = Buffer.alloc(blocks * blockSize);
  for (let block = 0; block < blocks; block++) {
    for (let i = 0; i < blockSize; i++) data[block * blockSize + i] = input[offset + i * blocks + block];
  }
  return data;
}

const aligned8 = length => Math.ceil(length / 8) * 8;
function smallInt(bytes, offset, signed = false) {
  check(offset + 8 <= bytes.length, '索引记录被截断。');
  const value = Number(signed ? bytes.readBigInt64LE(offset) : bytes.readBigUInt64LE(offset));
  check(Number.isSafeInteger(value), '索引数值超限。');
  return value;
}

function systemPage(input, offset, packedSize, size, copies) {
  check(packedSize > 0 && packedSize <= size && size <= dwgSectionLimit && copies > 0 && copies <= 256 && offset >= pageBase,
    '系统页长度无效。');
  const data = payload(input, offset, Math.ceil(aligned8(packedSize) * copies / 239), 239).subarray(0, packedSize);
  return packedSize === size ? data : expandAc1021(data, size);
}

export function readAc1021Sections(input, byteLimit = dwgSectionLimit) {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  check(bytes.length >= pageBase && bytes.toString('ascii', 0, 6) === 'AC1021', '文件头无效。');
  check(!(bytes.readUInt32LE(24) & 1), '加密对象暂不支持。');
  const rawHeader = payload(bytes, 0x80, 3, 239);
  const packedHeader = rawHeader.readInt32LE(24);
  check(packedHeader === -272 || (packedHeader > 0 && packedHeader <= 272), '页目录头长度无效。');
  const headerData = rawHeader.subarray(32, 32 + Math.abs(packedHeader));
  const header = packedHeader < 0 ? headerData : expandAc1021(headerData, 272);
  const field = offset => smallInt(header, offset);
  const pageMapSize = field(0x58);
  check(pageMapSize <= 32768 * 16 && pageMapSize % 16 === 0, '物理页目录长度无效。');
  const pagesData = systemPage(bytes, pageBase + field(0x38), field(0x50), pageMapSize, field(0x18));
  const pages = new Map();
  for (let i = 0, offset = pageBase; i < pagesData.length; i += 16) {
    const size = smallInt(pagesData, i);
    const id = smallInt(pagesData, i + 8, true);
    check(size > 0 && offset + size <= bytes.length && !pages.has(id), '物理页位置无效。');
    pages.set(id, { offset, size });
    offset += size;
  }
  const sectionPage = pages.get(field(0xc0));
  check(sectionPage, '缺少数据段目录。');
  const map = systemPage(bytes, sectionPage.offset, field(0xb0), field(0xc8), field(0xd8));
  const sections = new Map();
  let reserved = 0;
  for (let i = 0; i + 64 <= map.length;) {
    const size = smallInt(map, i);
    const encryption = smallInt(map, i + 16);
    const nameBytes = smallInt(map, i + 32);
    const encoding = smallInt(map, i + 48);
    const count = smallInt(map, i + 56);
    i += 64;
    check(nameBytes <= 1024 && !(nameBytes % 2) && count <= 8192 && i + nameBytes + count * 56 <= map.length, '数据段目录越界。');
    const name = map.toString('utf16le', i, i + nameBytes).replace(/\0+$/, '');
    i += nameBytes;
    if (required.has(name)) {
      check(!sections.has(name) && !encryption && [1, 4].includes(encoding) && size > 0,
        '数据段属性超出支持范围。');
      check((reserved += size) <= byteLimit, `数据段解压总量超过 ${byteLimit / (1024 * 1024)} MiB。`);
      const data = Buffer.alloc(size);
      let end = 0;
      for (let at = i; at < i + count * 56; at += 56) {
        const target = smallInt(map, at);
        const record = pages.get(smallInt(map, at + 16));
        const unpacked = smallInt(map, at + 24);
        const packed = smallInt(map, at + 32);
        check(record && target >= end && target + unpacked <= size && packed > 0 && packed <= unpacked && packed <= record.size,
          '数据页位置无效。');
        let decoded = bytes.subarray(record.offset, record.offset + packed);
        if (encoding === 4 && packed < unpacked) {
          const blocks = Math.ceil(aligned8(packed) / 251);
          check(blocks * 255 <= record.size, '数据页的交错块超出范围。');
          decoded = payload(bytes, record.offset, blocks, 251).subarray(0, packed);
        }
        if (packed < unpacked) decoded = expandAc1021(decoded, unpacked);
        data.set(decoded, target);
        end = target + unpacked;
      }
      sections.set(name, data);
    }
    i += count * 56;
  }
  check(sections.has('AcDb:AcDbObjects') && sections.has('AcDb:Handles'), '缺少对象段或句柄索引。');
  return sections;
}
