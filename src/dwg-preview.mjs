import { Buffer } from 'node:buffer';

const previewStart = Buffer.from('1f256d07d43628289d57ca3f9d44102b', 'hex');
const previewEnd = Buffer.from('e0da92f82bc9d7d762a835c062bbefd4', 'hex');
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');

export function dwgVersion(bytes) {
  if (bytes.length < 6) return null;
  const header = Buffer.from(bytes.buffer, bytes.byteOffset, 6).toString('ascii');
  return /^AC10\d{2}$/.test(header) ? header : null;
}

function validDimensions(width, height) {
  return width > 0 && height > 0 && width <= 4096 && height <= 4096 && width * height <= 8_000_000;
}

export function readDibBitmap(dib) {
  if (dib.length < 40 || dib.readUInt32LE(0) !== 40 || dib.readUInt16LE(12) !== 1 || dib.readUInt32LE(16) !== 0) return null;
  const width = dib.readInt32LE(4);
  const height = Math.abs(dib.readInt32LE(8));
  const bits = dib.readUInt16LE(14);
  if (!validDimensions(width, height) || ![1, 4, 8, 24, 32].includes(bits)) return null;
  const colors = dib.readUInt32LE(32) || (bits <= 8 ? 2 ** bits : 0);
  if (colors > (bits <= 8 ? 2 ** bits : 256)) return null;
  const pixels = 40 + colors * 4;
  const size = pixels + 4 * Math.ceil(width * bits / 32) * height;
  if (size > dib.length) return null;
  const header = Buffer.alloc(14);
  header.write('BM');
  header.writeUInt32LE(size + 14, 2);
  header.writeUInt32LE(pixels + 14, 10);
  return { width, height, mime: 'image/bmp', data: Buffer.concat([header, dib.subarray(0, size)]) };
}

function png(data) {
  if (data.length < 33 || !data.subarray(0, 8).equals(pngSignature) ||
      data.readUInt32BE(8) !== 13 || data.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  if (!validDimensions(width, height)) return null;
  let offset = 8;
  for (let chunks = 0; chunks < 4096 && offset + 12 <= data.length; chunks++) {
    const size = data.readUInt32BE(offset);
    const end = offset + size + 12;
    if (end > data.length) return null;
    if (size === 0 && data.toString('ascii', offset + 4, offset + 8) === 'IEND') {
      return { width, height, mime: 'image/png', data: data.subarray(0, end) };
    }
    offset = end;
  }
  return null;
}

export function readDwgPreview(bytes) {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (data.length < 38) return null;
  const start = data.readUInt32LE(13);
  if (start < 17 || start + 21 > data.length || !data.subarray(start, start + 16).equals(previewStart)) return null;
  const end = start + 20 + data.readUInt32LE(start + 16);
  const entries = data[start + 20];
  const firstImage = start + 21 + entries * 9;
  if (firstImage > end || end + 16 > data.length || !data.subarray(end, end + 16).equals(previewEnd)) return null;
  let result;
  for (let entry = start + 21; entry < firstImage; entry += 9) {
    const type = data[entry];
    if (type !== 2 && type !== 6) continue;
    const offset = data.readUInt32LE(entry + 1);
    const size = data.readUInt32LE(entry + 5);
    if (offset < firstImage || offset + size > end || size > 8 * 1024 * 1024) continue;
    const image = data.subarray(offset, offset + size);
    const candidate = type === 6 ? png(image) : readDibBitmap(image);
    if (candidate && (!result || candidate.width * candidate.height > result.width * result.height)) result = candidate;
  }
  return result && { width: result.width, height: result.height, mime: result.mime, base64: result.data.toString('base64') };
}
