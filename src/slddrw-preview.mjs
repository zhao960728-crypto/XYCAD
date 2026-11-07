import { Buffer } from 'node:buffer';
import { crc32, inflateRawSync } from 'node:zlib';
import { MiB } from '../public/cad-limits.mjs';

const recordMarker = Buffer.from('140006000800', 'hex');
const pngMagic = Buffer.from('89504e470d0a1a0a', 'hex');
const namesKey = 'SheetPreviews/SheetNames';
const metadataKey = 'docProps/ISolidWorksInformation.xml';
const pageKey = /^Images\/Sheet_(0|[1-9][0-9]{0,3})$/;
const maxSheets = 64;
const maxImageBytes = 8 * MiB;
export const displayListKey = 'Contents/DisplayLists';
export const viewListKey = 'Contents/VBLists';
export const definitionKey = 'Contents/Definition';
export const unicodeMarker = Buffer.from([255, 254, 255]);

export function textAt(bytes, offset) {
  if (offset < 0 || offset + 4 > bytes.length || !bytes.subarray(offset, offset + 3).equals(unicodeMarker)) return null;
  let length = bytes[offset + 3];
  let start = offset + 4;
  if (length === 255) {
    if (start + 2 > bytes.length) return null;
    length = bytes.readUInt16LE(start);
    start += 2;
  }
  const end = start + length * 2;
  if (length > 8192 || end > bytes.length) return null;
  return { length, end, value: bytes.toString('utf16le', start, end) };
}

export function readSheetPng(data) {
  if (!data.subarray(0, 8).equals(pngMagic)) return null;
  let width, height, channels, endOfIdat = false;
  const idat = [];
  let offset = 8;
  for (let chunks = 0; chunks < 1024 && offset + 12 <= data.length; chunks++) {
    const size = data.readUInt32BE(offset);
    const end = offset + 12 + size;
    if (end > data.length || crc32(data.subarray(offset + 4, end - 4)) !== data.readUInt32BE(end - 4)) return null;
    const type = data.toString('ascii', offset + 4, offset + 8);
    const body = data.subarray(offset + 8, end - 4);
    if (!chunks) {
      if (type !== 'IHDR' || size !== 13 || body[8] !== 8 || ![2, 6].includes(body[9]) ||
          body[10] || body[11] || body[12]) return null;
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (!width || !height || width > 4096 || height > 4096 || width * height > 8_000_000) return null;
      channels = body[9] === 2 ? 3 : 4;
    } else if (type === 'IDAT') {
      if (endOfIdat) return null;
      idat.push(body);
    } else if (type === 'IEND') {
      if (size || end !== data.length || !idat.some(part => part.length)) return null;
      return { width, height, channels, idat, data };
    } else {
      if (!/^[A-Za-z]{4}$/.test(type) || /^[A-Z]/.test(type) && type !== 'PLTE') return null;
      endOfIdat = idat.length > 0;
    }
    offset = end;
  }
  return null;
}

function readNames(data) {
  if (!data || data.length < 2) return null;
  const count = data.readUInt16LE(0);
  if (count > maxSheets) throw new Error('SolidWorks 工程图超过 64 页预览上限。');
  const names = [];
  let offset = 2;
  for (let i = 0; i < count; i++) {
    if (offset + 4 > data.length || data.readUIntLE(offset, 3) !== 0xfffeff) return null;
    let length = data[offset + 3];
    offset += 4;
    if (length === 255) {
      if (offset + 2 > data.length) return null;
      length = data.readUInt16LE(offset);
      offset += 2;
    }
    const end = offset + 2 * length;
    if (end > data.length || length > 1024) return null;
    names.push(data.toString('utf16le', offset, end).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, 160));
    offset = end;
  }
  return names;
}

function sheetStreams(bytes, vector) {
  const streams = new Map();
  let attempts = 0, expanded = 0, candidates = 0;
  for (let offset = bytes.indexOf(recordMarker); offset >= 0; offset = bytes.indexOf(recordMarker, offset + 6)) {
    if (++candidates > 100_000) throw new Error('SolidWorks 文件的记录数量超过读取预算。');
    if (offset + 26 > bytes.length) break;
    const nameLength = bytes.readUInt32LE(offset + 22);
    const start = offset + 26 + nameLength;
    if (nameLength < 7 || nameLength > 40 || start > bytes.length) continue;
    let name = '';
    for (let i = offset + 26; i < start; i++) {
      const byte = bytes[i];
      name += String.fromCharCode((byte >>> 4) | (byte << 4 & 255));
    }
    const geometry = name === displayListKey || name === viewListKey || name === definitionKey;
    const metadata = name === namesKey || name === metadataKey;
    const selected = vector === 'definition' ? name === definitionKey :
      metadata || (vector ? name === displayListKey || name === viewListKey : name === 'PreviewPNG' || pageKey.test(name));
    if (!selected) continue;
    const compressed = bytes.readUInt32LE(offset + 14);
    const length = bytes.readUInt32LE(offset + 18);
    const limit = geometry ? 64 * MiB : maxImageBytes;
    if (!compressed || compressed > limit || !length || length > limit || start + compressed > bytes.length) continue;
    if (++attempts > 512 || (expanded += length) > 96 * MiB) throw new Error('SolidWorks 图纸画面超过读取预算。');
    let data;
    try {
      const result = inflateRawSync(bytes.subarray(start, start + compressed), { maxOutputLength: length, info: true });
      if (result.engine.bytesWritten !== compressed || result.buffer.length !== length) continue;
      data = result.buffer;
    } catch { continue; }
    if (crc32(data) !== bytes.readUInt32LE(offset + 10)) continue;
    streams.set(name, data);
    // Skip the verified compressed payload. Directory entries and stale markers fail validation above.
    offset = start + compressed - recordMarker.length;
  }
  return streams;
}

export function openSolidWorksDrawing(input, expected = false, vector = false) {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (!hasSolidWorksRecords(bytes)) {
    if (!expected) return null;
    throw new Error('此 SLDDRW 的文件容器无法读取或暂未适配。');
  }
  return sheetStreams(bytes, vector);
}

export function hasSolidWorksRecords(bytes) {
  return bytes.subarray(0, 512).includes(recordMarker);
}

export function solidWorksSheetInfo(streams) {
  const names = readNames(streams.get(namesKey));
  const metadata = streams.get(metadataKey)?.toString('utf8') ?? '';
  const number = key => Number(new RegExp('<property name="SW-' + key + '" pid="[0-9]+"><vt:lpstr>([0-9]+)</vt:lpstr>').exec(metadata)?.[1]);
  return { names, metadata, declared: Math.max(number('Total Sheets') || 0, names?.length ?? 0), active: number('Current Sheet') };
}

export function readSolidWorksSheets(input, expected = false) {
  const streams = openSolidWorksDrawing(input, expected);
  if (!streams) return null;
  const { names, declared, active: activeSheet } = solidWorksSheetInfo(streams);
  const savedPages = [...streams.keys()].flatMap(name => {
    const match = pageKey.exec(name);
    return match ? [Number(match[1]) + 1] : [];
  });
  const count = Math.max(declared, ...savedPages);
  if (!count) {
    if (!expected) return null;
    throw new Error('此 SLDDRW 没有可识别的图纸页。');
  }
  if (count > maxSheets) throw new Error('SolidWorks 工程图超过 64 页预览上限。');
  const active = count === 1 ? 1 : activeSheet;
  const preview = streams.get('PreviewPNG');
  const activeImage = preview && readSheetPng(preview);
  const sheets = Array.from({ length: count }, (_, i) => {
    const data = streams.get('Images/Sheet_' + i);
    const indexed = data && readSheetPng(data);
    const image = count > 1 && indexed || i + 1 === active && activeImage || indexed || null;
    return { name: names?.[i] || '图纸 ' + (i + 1), image };
  });
  if (!sheets.some(sheet => sheet.image)) throw new Error('此 SLDDRW 未保存可读取的图纸画面。');
  const pixels = sheets.reduce((total, { image }) => total + (image ? image.width * image.height : 0), 0);
  if (pixels > 64_000_000) throw new Error('SolidWorks 工程图的画面总像素超过预览预算。');
  return sheets;
}
