import { Buffer } from 'node:buffer';
import { decodeLegacyEscapes } from './cad-text.mjs';
import { dwgIndexLimit } from './cad-budget.mjs';

function check(ok, detail) {
  if (!ok) throw new Error(detail);
}

function modular(bytes, cursor, limit, signed = false) {
  let value = 0;
  let unit = 1;
  for (let count = 0; count < 7 && cursor.offset < limit; count++, unit *= 128) {
    const part = bytes[cursor.offset++];
    if (part < 128) {
      if (signed && part & 64) return -(value + (part & 63) * unit);
      return value + part * unit;
    }
    value += (part & 127) * unit;
  }
  throw new Error('DWG 变长整数越界。');
}

export function objectIndex(bytes, length, maxObjects = dwgIndexLimit) {
  const index = new Map();
  for (let page = 0; page + 4 <= bytes.length;) {
    const size = bytes.readUInt16BE(page);
    if (size === 2) return index;
    const end = page + size;
    check(size > 2 && size <= 2040 && end + 2 <= bytes.length, 'DWG 句柄索引页无效。');
    const cursor = { offset: page + 2 };
    let offset = 0;
    let handle = 0;
    while (cursor.offset < end) {
      handle += modular(bytes, cursor, end);
      offset += modular(bytes, cursor, end, true);
      check(handle > 0 && offset >= 0 && offset + 3 <= length && !index.has(handle), 'DWG 对象索引无效。');
      check(index.size < maxObjects, 'DWG 对象数超过本版预览容量。');
      index.set(handle, offset);
    }
    page = end + 2;
  }
  throw new Error('DWG 句柄索引没有终止记录。');
}

export class Bits {
  constructor(bytes, pos = 0, end = bytes.length * 8, decoder = null) {
    this.bytes = bytes;
    this.pos = pos;
    this.end = end;
    this.decoder = decoder;
    this.double = Buffer.alloc(8);
  }

  bits(count) {
    check(this.pos + count <= this.end, '对象位流被截断。');
    let value = 0;
    for (let left = count; left > 0;) {
      const within = this.pos & 7;
      const width = Math.min(left, 8 - within);
      value = (value << width) | ((this.bytes[this.pos >>> 3] >>> (8 - within - width)) & ((1 << width) - 1));
      this.pos += width;
      left -= width;
    }
    return value >>> 0;
  }

  skip(count) {
    check(Number.isInteger(count) && count >= 0 && this.pos + count <= this.end, '对象位流范围无效。');
    this.pos += count;
  }

  b() { return this.bits(1); }
  rc() { return this.bits(8); }
  rs() { return this.rc() | this.rc() << 8; }
  rl() { return (this.rs() | this.rs() << 16) >>> 0; }

  rd() {
    for (let index = 0; index < 8; index++) this.double[index] = this.rc();
    return this.double.readDoubleLE();
  }

  bs() {
    const mode = this.bits(2);
    if (mode === 0) return this.rs();
    if (mode === 1) return this.rc();
    return mode === 3 ? 256 : 0;
  }

  bl() {
    const mode = this.bits(2);
    if (mode === 0) return this.rl();
    if (mode === 1) return this.rc();
    check(mode === 2, '无效的 DWG 压缩长整数。');
    return 0;
  }

  bll() {
    const count = this.bits(3);
    let value = 0;
    for (let index = 0; index < count; index++) value += this.rc() * 256 ** index;
    check(Number.isSafeInteger(value), 'DWG 长度超出整数范围。');
    return value;
  }

  bd() {
    const mode = this.bits(2);
    if (mode === 0) return this.rd();
    check(mode < 3, '无效的 DWG 压缩双精度数。');
    return mode === 1 ? 1 : 0;
  }

  dd(fallback) {
    const mode = this.bits(2);
    if (mode === 0) return fallback;
    if (mode === 3) return this.rd();
    this.double.writeDoubleLE(fallback);
    if (mode === 2) {
      this.double[4] = this.rc();
      this.double[5] = this.rc();
    }
    for (let index = 0; index < 4; index++) this.double[index] = this.rc();
    return this.double.readDoubleLE();
  }

  xyz() { return [this.bd(), this.bd(), this.bd()]; }
  extrusion() { return this.b() ? [0, 0, 1] : this.xyz(); }
  thickness() { return this.b() ? 0 : this.bd(); }

  handle(relative = 0) {
    const head = this.rc();
    const count = head & 15;
    const type = head >>> 4;
    check(count <= 6, '对象句柄超出支持范围。');
    let value = 0;
    for (let index = 0; index < count; index++) value = value * 256 + this.rc();
    if (type <= 5) return value;
    if (type === 6) return relative + 1;
    if (type === 8) return relative - 1;
    if (type === 10) return relative + value;
    if (type === 12) return relative - value;
    throw new Error('未识别的相对句柄。');
  }

  text() {
    const length = this.bs();
    const byteLength = length * (this.decoder ? 1 : 2);
    check(length <= 32768 && this.pos + byteLength * 8 <= this.end, '对象字符串越界。');
    const bytes = Buffer.alloc(byteLength);
    for (let index = 0; index < bytes.length; index++) bytes[index] = this.rc();
    return (this.decoder ? decodeLegacyEscapes(this.decoder.decode(bytes)) : bytes.toString('utf16le')).replace(/\0+$/, '');
  }
}

export function readDrawingUnits(bytes, version = 1032, maintenance = 0) {
  check(bytes && bytes.length >= 28, 'DWG 图纸变量段缺失。');
  const offset = version >= 1032 || (version >= 1024 && maintenance > 3) ? 24 : 20;
  const start = (offset + 4) * 8;
  const limit = offset * 8 + bytes.readUInt32LE(offset);
  check(limit > start && limit <= bytes.length * 8, 'DWG 图纸变量段长度无效。');
  const { dataEnd } = splitStrings(bytes, limit);
  const data = new Bits(bytes, start, dataEnd);
  const read = (method, amount) => {
    for (let index = 0; index < amount; index++) data[method]();
  };
  const color = () => { data.bs(); data.bl(); data.rc(); };
  if (version >= 1027) data.bll(); // Required DWG feature versions.
  read('bd', 4);
  read('bl', 2);
  data.skip(21); // Drawing-mode flags through PELLIPSE.
  read('bs', 8);
  read('bl', 3);
  read('bs', 19); // Integer drafting variables through TEXTQLTY.
  read('bd', 21); // LTSCALE through CELTSCALE.
  read('bl', 11); // Drawing and timer dates.
  color();
  data.handle(); // HANDSEED is stored in the data stream.
  data.bd(); // PSVPSCALE.
  for (let space = 0; space < 2; space++) {
    read('bd', 9); // Insertion base and extents.
    read('rd', 4); // Drawing limits.
    read('bd', 10); // Elevation and UCS origin and axes.
    data.bs();
    read('bd', 18); // Orthographic UCS origins.
  }
  read('bd', 11); // DIMSCALE through DIMJOGANG.
  data.bs();
  color();
  data.skip(6);
  read('bs', 4);
  read('bd', 9);
  data.skip(1);
  data.bs();
  data.skip(4);
  color(); color(); color();
  read('bs', 11);
  data.skip(2);
  read('bs', 4);
  data.skip(1);
  data.bs();
  if (version >= 1024) {
    data.skip(2);
    read('bd', 2);
  } else {
    data.skip(1); // DIMFXLON.
  }
  read('bs', 4); // Dimension lineweights and stacked-text variables.
  data.bl(); // Flags before INSUNITS.
  const units = data.bs();
  check(units <= 24, 'DWG INSUNITS 值超出支持范围。');
  return units;
}

function splitStrings(bytes, end) {
  const flag = new Bits(bytes, end - 1, end);
  let dataEnd = end - 1;
  if (!flag.b()) return { dataEnd };
  const sizeReader = new Bits(bytes, dataEnd - 16, dataEnd);
  let textBits = sizeReader.rs();
  dataEnd -= 16;
  if (textBits & 0x8000) {
    dataEnd -= 16;
    textBits = (textBits & 0x7fff) + new Bits(bytes, dataEnd, dataEnd + 16).rs() * 32768;
  }
  check(textBits <= dataEnd, '对象字符串流指针无效。');
  return { dataEnd: dataEnd - textBits, strings: new Bits(bytes, dataEnd - textBits, dataEnd) };
}

export function readClasses(bytes, maintenance, version = 1032, decoder = null) {
  if (!bytes) return new Map();
  check(bytes.length >= 28, '类索引头被截断。');
  if (version === 1018) {
    check(bytes.subarray(0, 16).toString('hex') === '8da1c4b8c4a9f8c5c0dcf45fe7cfb68a', 'AC1018 类索引标记无效。');
    const end = 20 + bytes.readUInt32LE(16);
    check(end <= bytes.length - 18, 'AC1018 类索引长度无效。');
    const data = new Bits(bytes, 160, end * 8, decoder);
    const maxType = data.bs();
    check(maxType >= 499 && maxType <= 4096, '类索引编号超限。');
    data.skip(17);
    const classes = new Map();
    while (data.end - data.pos > 7) {
      const type = data.bs();
      check(type >= 500 && type <= maxType && !classes.has(type), 'AC1018 类索引编号无效。');
      data.bs(); // Proxy flags.
      data.text(); // Application name.
      data.text(); // C++ class name.
      const name = data.text();
      check(/^[A-Za-z0-9_-]+$/.test(name), '类索引的 DXF 名称无效。');
      data.b(); // Proxy state.
      const kind = data.bs();
      check(kind === 0x1f2 || kind === 0x1f3, 'AC1018 类索引类型无效。');
      data.bl(); // Instance count.
      data.bl(); data.bl(); // DWG revision and maintenance level can exceed one byte.
      data.bl(); data.bl();
      classes.set(type, { name, entity: kind === 0x1f2 });
    }
    return classes;
  }
  const offset = version > 1021 && (maintenance > 3 || bytes.readUInt32LE(20) === 0) ? 24 : 20;
  const end = offset * 8 + bytes.readUInt32LE(offset);
  check(end > (offset + 4) * 8 && end <= bytes.length * 8, '类索引长度无效。');
  const { dataEnd, strings } = splitStrings(bytes, end);
  check(strings, '类索引没有字符串流。');
  const data = new Bits(bytes, (offset + 4) * 8, dataEnd);
  const maxType = data.bs();
  data.skip(17);
  check(maxType >= 499 && maxType <= 4096, '类索引编号超限。');
  const classes = new Map();
  for (let type = 500; type <= maxType; type++) {
    strings.text();
    strings.text();
    const name = strings.text();
    check(/^[A-Za-z0-9_-]+$/.test(name), '类索引的 DXF 名称无效。');
    classes.set(type, { name });
  }
  check(strings.end === strings.pos, '类索引字符串数与编号范围不符。');
  // The string stream is ordered by class index. The numeric stream also
  // supplies the object/entity distinction where its metadata can be read.
  for (const [type, record] of classes) {
    try {
      if (data.bs() !== type) break;
      data.bs();
      data.b();
      const kind = data.bs();
      if (kind !== 0x1f2 && kind !== 0x1f3) break;
      record.entity = kind === 0x1f2;
      data.bl();
      data.bs();
      data.bs();
      data.bl();
      data.bl();
    } catch {
      break;
    }
  }
  return classes;
}

export function openObject(bytes, offset, expectedHandle, decoder = null, version = 1032) {
  let size = bytes.readUInt16LE(offset);
  const cursor = { offset: offset + 2 };
  if (size & 0x8000) {
    check(cursor.offset + 2 <= bytes.length, '对象长度被截断。');
    size = (size & 0x7fff) + bytes.readUInt16LE(cursor.offset) * 32768;
    cursor.offset += 2;
  }
  const legacy = Boolean(decoder) && version !== 1018;
  const bitSizeInBody = legacy || version === 1018 || version === 1021;
  const handleBits = bitSizeInBody ? 0 : modular(bytes, cursor, bytes.length);
  check(size > 0 && cursor.offset + size + 2 <= bytes.length && handleBits < size * 8, '对象记录越界。');
  const body = bytes.subarray(cursor.offset, cursor.offset + size);
  const data = new Bits(body, 0, body.length * 8, decoder);
  let type, handleStart, strings;
  if (bitSizeInBody) {
    type = data.bs();
    handleStart = data.rl();
    check(handleStart >= data.pos && handleStart <= data.end, 'DWG 对象数据长度无效。');
    if (decoder) {
      data.end = handleStart;
      strings = data;
    } else {
      const split = splitStrings(body, handleStart);
      data.end = split.dataEnd;
      strings = split.strings;
    }
  } else {
    handleStart = size * 8 - handleBits;
    const split = splitStrings(body, handleStart);
    data.end = split.dataEnd;
    strings = split.strings;
    const typeBits = data.bits(2);
    type = typeBits === 0 ? data.rc() : typeBits === 1 ? data.rc() + 0x1f0 : data.rs();
  }
  const handle = data.handle();
  check(handle === expectedHandle, '对象自身句柄与索引不符。');
  for (let extra = data.bs(); extra; extra = data.bs()) {
    data.handle(handle);
    data.skip(extra * 8);
  }
  return { type, handle, data, strings, refs: new Bits(body, handleStart), legacy, version };
}

export function entityHeader(object) {
  const { data, refs, handle, legacy, version } = object;
  if (legacy) {
    if (data.b()) data.skip(data.rl() * 8);
    const mode = data.bits(2);
    const reactors = data.bl();
    const noLinks = data.b();
    const color = data.bs();
    const lineScale = data.bd();
    const lineType = data.bits(2);
    const plot = data.bits(2);
    const invisible = Boolean(data.bs() & 1);
    data.rc(); // Lineweight.
    const owner = mode === 0 ? refs.handle(handle) : 0;
    check(reactors <= 8192, '实体关联数量超限。');
    for (let index = 0; index < reactors; index++) refs.handle(handle);
    refs.handle(handle); // Extension dictionary.
    const previous = noLinks ? handle - 1 : refs.handle(handle);
    const next = noLinks ? handle + 1 : refs.handle(handle);
    const layer = refs.handle(handle);
    const lineTypeHandle = lineType === 3 ? refs.handle(handle) : 0;
    if (plot === 3) refs.handle(handle);
    return { mode, owner, layer, color, lineScale, lineType, lineTypeHandle, invisible, previous, next };
  }
  if (data.b()) data.skip((version <= 1021 ? data.rl() : data.bll()) * 8);
  const mode = data.bits(2);
  const reactors = data.bl();
  const noDictionary = data.b();
  if (version >= 1027) data.b(); // Data-store flag.
  const color = data.bs();
  const hasColorBook = Boolean(color & 0x4000);
  const rgb = color & 0x8000 && !hasColorBook ? data.bl() & 0xffffff : undefined;
  const transparency = color & 0x2000 ? data.bl() : undefined;
  const lineScale = data.bd();
  const lineType = data.bits(2);
  const material = version >= 1021 ? data.bits(2) : 0;
  if (version >= 1021) data.rc(); // Shadow mode.
  const plot = data.bits(2);
  const styles = version >= 1024 ? data.bits(3) : 0;
  const invisible = Boolean(data.bs() & 1);
  data.rc(); // Lineweight.
  const owner = mode === 0 ? refs.handle(handle) : 0;
  check(reactors <= 8192, '实体关联数量超限。');
  for (let index = 0; index < reactors; index++) refs.handle(handle);
  if (!noDictionary) refs.handle(handle);
  if (hasColorBook) refs.handle(handle);
  const layer = refs.handle(handle);
  const lineTypeHandle = lineType === 3 ? refs.handle(handle) : 0;
  if (material === 3) refs.handle(handle);
  if (plot === 3) refs.handle(handle);
  for (const bit of [4, 2, 1]) if (styles & bit) refs.handle(handle);
  return { mode, owner, layer, color: color & 0x1ff, rgb, transparency, lineScale, lineType, lineTypeHandle, invisible };
}
