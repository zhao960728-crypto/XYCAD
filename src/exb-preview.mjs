import { Buffer } from 'node:buffer';
import { readDibBitmap } from './dwg-preview.mjs';

const magic = Buffer.from('d0cf11e0a1b11ae1', 'hex');
const endOfChain = 0xfffffffe;
const free = 0xffffffff;

function requireValid(condition) {
  if (!condition) throw new Error('复合文档目录或数据流无效。');
}

function compoundStreams(bytes) {
  const version = bytes.readUInt16LE(26);
  const shift = bytes.readUInt16LE(30);
  requireValid(bytes.readUInt16LE(28) === 0xfffe && ((version === 3 && shift === 9) || (version === 4 && shift === 12)));
  const size = 2 ** shift;
  const sectors = bytes.length / size - 1;
  requireValid(Number.isInteger(sectors) && sectors >= 2 && bytes.readUInt32LE(56) === 4096 && bytes.readUInt16LE(32) === 6);
  const sector = id => {
    requireValid(id < sectors);
    return bytes.subarray((id + 1) * size, (id + 2) * size);
  };

  const fatCount = bytes.readUInt32LE(44);
  const difatCount = bytes.readUInt32LE(72);
  requireValid(fatCount > 0 && fatCount <= sectors && difatCount <= sectors);
  const fatIds = [];
  const addFatIds = (part, from, to) => {
    for (let i = from; i < to; i += 4) {
      const id = part.readUInt32LE(i);
      if (id !== free) {
        requireValid(fatIds.length < fatCount);
        fatIds.push(id);
      }
    }
  };
  addFatIds(bytes, 76, 512);
  let next = bytes.readUInt32LE(68);
  const difatIds = new Set();
  for (let i = 0; i < difatCount; i++) {
    requireValid(!difatIds.has(next));
    difatIds.add(next);
    const part = sector(next);
    addFatIds(part, 0, size - 4);
    next = part.readUInt32LE(size - 4);
  }
  requireValid(fatIds.length === fatCount && new Set(fatIds).size === fatCount && (!difatCount || next === endOfChain));
  const fat = Buffer.concat(fatIds.map(sector));
  requireValid(fat.length >= sectors * 4);

  function readChain(id, max, length, table = fat, get = sector) {
    const visited = new Set();
    const parts = [];
    while (id !== endOfChain) {
      requireValid(parts.length < max && id < table.length / 4 && !visited.has(id));
      visited.add(id);
      parts.push(get(id));
      id = table.readUInt32LE(id * 4);
    }
    if (length !== undefined) requireValid(parts.length === max);
    return Buffer.concat(parts).subarray(0, length);
  }

  const directory = readChain(bytes.readUInt32LE(48), Math.min(2 ** 20 / size, sectors));
  requireValid(directory.length >= 128 && directory[66] === 5);
  const streams = new Map();
  const root = directory.subarray(0, 128);
  const children = [[root.readUInt32LE(76), '']];
  const visited = new Set();
  while (children.length) {
    const [id, parent] = children.pop();
    if (id === free) continue;
    requireValid(id > 0 && id < directory.length / 128 && !visited.has(id));
    visited.add(id);
    const entry = directory.subarray(id * 128, id * 128 + 128);
    children.push([entry.readUInt32LE(68), parent], [entry.readUInt32LE(72), parent]);
    requireValid(entry[66] === 1 || entry[66] === 2);
    const nameLength = entry.readUInt16LE(64);
    requireValid(nameLength >= 2 && nameLength <= 64 && nameLength % 2 === 0);
    const name = entry.toString('utf16le', 0, nameLength - 2);
    requireValid(!name.includes('/'));
    const path = parent + name;
    requireValid(path.length <= 1024);
    if (entry[66] === 1) children.push([entry.readUInt32LE(76), path + '/']);
    else {
      requireValid(!streams.has(path));
      streams.set(path, entry);
    }
  }

  let mini, miniFat;
  return { streams, read: (entry, limit = 2 ** 20) => {
    const length = entry.readUInt32LE(120);
    const start = entry.readUInt32LE(116);
    requireValid(!entry.readUInt32LE(124) && length <= limit && length <= bytes.length);
    if (!length) return Buffer.alloc(0);
    if (length >= 4096) return readChain(start, Math.ceil(length / size), length);
    if (!mini) {
      const length = root.readUInt32LE(120);
      const count = bytes.readUInt32LE(64);
      requireValid(!root.readUInt32LE(124) && length > 0 && length <= bytes.length && count > 0 && count <= sectors);
      mini = readChain(root.readUInt32LE(116), Math.ceil(length / size), length);
      miniFat = readChain(bytes.readUInt32LE(60), count, count * size);
    }
    return readChain(start, Math.ceil(length / 64), length, miniFat, id => {
      requireValid((id + 1) * 64 <= mini.length);
      return mini.subarray(id * 64, (id + 1) * 64);
    });
  } };
}

export function openExb(input) {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length < 512 || !bytes.subarray(0, 8).equals(magic)) return null;
  const { streams, read } = compoundStreams(bytes);
  if (!streams.has('*FileInfoStream') || !streams.has('*SpaceStream')) return null;
  return { streams, read };
}

export function readExbPreview(input, container = openExb(input)) {
  if (!container) return null;
  const { streams, read } = container;
  const entry = streams.get('*PreviewStream');
  if (!entry) throw new Error('此 CAXA EXB 未保存内嵌预览。');
  const preview = read(entry);
  for (let offset = 0; offset < 4096;) {
    offset = preview.indexOf('BM', offset);
    if (offset < 0 || offset >= 4096 || offset + 54 > preview.length) break;
    if (preview.readUInt32LE(offset + 2) === preview.length - offset && preview.readUInt32LE(offset + 6) === 0) {
      const image = readDibBitmap(preview.subarray(offset + 14));
      if (image && image.data.length === preview.length - offset &&
          image.data.readUInt32LE(10) === preview.readUInt32LE(offset + 10)) {
        return { width: image.width, height: image.height, mime: image.mime, base64: image.data.toString('base64') };
      }
    }
    offset += 2;
  }
  throw new Error('此 CAXA EXB 的内嵌预览编码暂不支持。');
}
