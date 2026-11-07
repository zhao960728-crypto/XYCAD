import { Buffer } from 'node:buffer';
import { crc32 } from 'node:zlib';
import { dwgSectionLimit as sectionLimit } from './cad-budget.mjs';

const sectionNames = new Set(['AcDb:AcDbObjects', 'AcDb:Handles', 'AcDb:Classes', 'AcDb:Header']);

function requireRange(valid, message) {
  if (!valid) throw new Error('DWG ' + message);
}

// AC1032 uses the R2004 page compression described in sections 4.7 and 8.
export function expandDwgPage(source, capacity, exact = true) {
  requireRange(capacity > 0 && capacity <= sectionLimit, '解压长度越界。');
  const output = Buffer.alloc(capacity);
  let from = 0;
  let to = 0;
  const byte = () => {
    requireRange(from < source.length, '压缩指令被截断。');
    return source[from++];
  };
  function lengthWithExtension(base, value) {
    while (!value) {
      base += 255;
      value = byte();
    }
    return base + value;
  }
  function literals(count) {
    requireRange(from + count <= source.length && to + count <= capacity, '压缩页的字面数据越界。');
    output.set(source.subarray(from, from + count), to);
    to += count;
    from += count;
  }
  let opcode = byte();
  if (opcode < 16) {
    literals(opcode ? opcode + 3 : lengthWithExtension(18, byte()));
    opcode = byte();
  }
  while (opcode !== 0x11) {
    let count;
    let distance;
    let tail;
    if (opcode >= 0x40) {
      count = (opcode >>> 4) - 1;
      distance = (byte() << 2) + ((opcode >>> 2) & 3) + 1;
      tail = opcode & 3;
    } else {
      requireRange(opcode >= 0x10, '压缩指令无效。');
      const shortDistance = opcode >= 0x20;
      const lowLength = opcode & (shortDistance ? 31 : 7);
      count = lowLength ? lowLength + 2 : lengthWithExtension(shortDistance ? 33 : 9, byte());
      const low = byte();
      distance = (low >>> 2) + (byte() << 6) + (shortDistance ? 1 : 0x4000 + ((opcode & 8) << 11));
      tail = low & 3;
    }
    requireRange(distance <= to && to + count <= capacity, '压缩页的回引用越界。');
    for (let offset = to - distance, end = to + count; to < end; to++, offset++) output[to] = output[offset];
    if (tail) {
      literals(tail);
      opcode = byte();
    } else {
      opcode = byte();
      if (opcode < 16) {
        literals(opcode ? opcode + 3 : lengthWithExtension(18, byte()));
        opcode = byte();
      }
    }
  }
  requireRange(!exact || to === capacity, '解压长度与页头不符。');
  return output.subarray(0, to);
}

function maskedHeader(input, version) {
  requireRange(input.length >= 256 && input.toString('ascii', 0, 6) === version, `当前入口只读取 ${version}。`);
  const data = Buffer.alloc(108);
  let seed = 1;
  for (let index = 0; index < data.length; index++) {
    seed = (Math.imul(seed, 0x343fd) + 0x269ec3) >>> 0;
    data[index] = input[128 + index] ^ (seed >>> 16 & 255);
  }
  requireRange(data.toString('ascii', 0, 11) === 'AcFssFcAJMB', '文件头校验标识无效。');
  const expected = data.readUInt32LE(104);
  data.writeUInt32LE(0, 104);
  requireRange(crc32(data) === expected, '文件头 CRC 不符。');
  return data;
}

function systemPage(input, offset, type) {
  requireRange(offset >= 256 && offset + 20 <= input.length && input.readUInt32LE(offset) === type, '索引页头无效。');
  const size = input.readUInt32LE(offset + 4);
  const packedSize = input.readUInt32LE(offset + 8);
  requireRange(packedSize > 0 && offset + 20 + packedSize <= input.length, '索引页长度越界。');
  requireRange(input.readUInt32LE(offset + 12) === 2, '索引页压缩类型暂不支持。');
  return expandDwgPage(input.subarray(offset + 20, offset + 20 + packedSize), size);
}

export function readAc1032Sections(bytes, version = 'AC1032') {
  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = maskedHeader(input, version);
  requireRange(!(input.readUInt32LE(24) & 1), '加密对象暂不支持。');
  const index = systemPage(input, Number(header.readBigUInt64LE(84)) + 256, 0x41630e3b);
  const pages = new Map();
  for (let record = 0, offset = 256; record < index.length;) {
    requireRange(record + 8 <= index.length, '物理页索引被截断。');
    const id = index.readInt32LE(record);
    const size = index.readUInt32LE(record + 4);
    // The final system page can have an allocated extent beyond the saved bytes.
    requireRange(size > 0 && offset <= input.length && size <= sectionLimit && !pages.has(id), '物理页索引越界或重复。');
    pages.set(id, { offset, size });
    offset += size;
    record += id < 0 ? 24 : 8;
    requireRange(record <= index.length, '物理页间隙记录被截断。');
  }
  const sectionIndex = systemPage(input, pages.get(header.readInt32LE(92))?.offset, 0x4163003b);
  const count = sectionIndex.readUInt32LE(0);
  requireRange(count <= 256, '数据段数量超限。');
  const sections = new Map();
  let cursor = 20;
  let reserved = 0;
  for (let section = 0; section < count; section++) {
    requireRange(cursor + 96 <= sectionIndex.length, '数据段描述被截断。');
    const size = Number(sectionIndex.readBigUInt64LE(cursor));
    const pageCount = sectionIndex.readUInt32LE(cursor + 8);
    const pageSize = sectionIndex.readUInt32LE(cursor + 12);
    const compression = sectionIndex.readUInt32LE(cursor + 20);
    const id = sectionIndex.readUInt32LE(cursor + 24);
    const encryption = sectionIndex.readUInt32LE(cursor + 28);
    const name = sectionIndex.toString('ascii', cursor + 32, cursor + 96).split('\0')[0];
    cursor += 96;
    requireRange(cursor + pageCount * 16 <= sectionIndex.length, '数据段的页索引被截断。');
    if (sectionNames.has(name)) {
      requireRange(size > 0 && pageSize > 0 && pageSize <= sectionLimit && (reserved += size) <= sectionLimit &&
        !encryption && [1, 2].includes(compression) && !sections.has(name), '数据段属性超出支持范围。');
      const decoded = Buffer.alloc(size);
      let previous = -pageSize;
      for (let page = cursor; page < cursor + pageCount * 16; page += 16) {
        const record = pages.get(sectionIndex.readInt32LE(page));
        const target = Number(sectionIndex.readBigUInt64LE(page + 8));
        requireRange(record && target >= previous + pageSize && target < size && record.offset + 32 <= input.length, '数据页位置无效。');
        previous = target;
        const offset = record.offset;
        const field = fieldOffset => (input.readUInt32LE(offset + fieldOffset) ^ 0x4164536b ^ offset) >>> 0;
        const length = field(8);
        requireRange(field(0) === 0x4163043b && field(4) === id && length + 32 <= record.size &&
          offset + length + 32 <= input.length, '数据页头不符。');
        const stored = input.subarray(offset + 32, offset + 32 + length);
        const unpacked = compression === 2 ? expandDwgPage(stored, pageSize, false) : stored;
        const needed = Math.min(pageSize, size - target);
        requireRange(unpacked.length >= needed, '数据页解压结果过短。');
        decoded.set(unpacked.subarray(0, needed), target);
      }
      sections.set(name, decoded);
    }
    cursor += pageCount * 16;
  }
  requireRange(sections.has('AcDb:AcDbObjects') && sections.has('AcDb:Handles'), '缺少对象段或句柄索引。');
  return sections;
}
