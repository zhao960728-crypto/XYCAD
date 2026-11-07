import { Bits, objectIndex } from './dwg-ac1032-records.mjs';

const classSentinel = '8da1c4b8c4a9f8c5c0dcf45fe7cfb68a';
const headerSentinel = 'cf7b1f23fdde38a95f7c68b84e6d335f';
const encodings = new Map([[30, 'windows-1252'], [38, 'shift_jis'], [39, 'gbk'], [40, 'euc-kr'], [41, 'big5']]);

export function readDwgCodepage(bytes) {
  const codepage = bytes.readUInt16LE(19);
  const encoding = encodings.get(codepage);
  return { decoder: new TextDecoder(encoding ?? 'windows-1252'), unknownCodepage: encoding ? null : codepage };
}

function requireValid(condition, message) {
  if (!condition) throw new Error(message);
}

function sectionData(section, sentinel) {
  requireValid(section?.length >= 38 && section.subarray(0, 16).toString('hex') === sentinel, 'DWG 数据段标记无效。');
  const size = section.readUInt32LE(16);
  requireValid(size <= section.length - 38, 'DWG 数据段越界。');
  return section.subarray(20, 20 + size);
}

function readClasses(section, decoder) {
  const payload = sectionData(section, classSentinel);
  const data = new Bits(payload, 0, payload.length * 8, decoder);
  const classes = new Map();
  while (data.end - data.pos > 7) {
    const type = data.bs();
    data.bs();
    data.text(); // Application name.
    data.text(); // C++ class name.
    const name = data.text();
    data.b();
    const kind = data.bs();
    requireValid(type >= 500 && !classes.has(type) && classes.size < 4096, 'AC1015 类索引无效。');
    classes.set(type, { name, entity: kind === 0x1f2 });
  }
  return classes;
}

export function readAc1015Units(payload, decoder) {
  return readInlineUnits(payload, decoder, false);
}

export function readAc1018Units(section, decoder) {
  return readInlineUnits(sectionData(section, headerSentinel), decoder, true);
}

function readInlineUnits(payload, decoder, paged) {
  const data = new Bits(payload, 0, payload.length * 8, decoder);
  const read = (method, count) => {
    for (let i = 0; i < count; i++) data[method]();
  };
  const color = () => {
    data.bs();
    if (!paged) return;
    data.bl();
    const flags = data.rc();
    if (flags & 1) data.text();
    if (flags & 2) data.text();
  };
  read('bd', 4);
  read('text', 4);
  read('bl', 2);
  if (!paged) data.handle(); // Current viewport.
  data.skip(paged ? 21 : 20);
  read('bs', 8);
  if (paged) read('bl', 3);
  read('bs', 19); // Drafting flags and integer variables through TEXTQLTY.
  read('bd', 21);
  data.text(); // Menu name.
  read('bl', paged ? 11 : 8); // Drawing dates and timers.
  color();
  read('handle', 6); // HANDSEED and current style handles.
  data.bd(); // Paper space viewport scale.
  for (let space = 0; space < 2; space++) {
    read('bd', 9);
    read('rd', 4);
    read('bd', 10);
    read('handle', 2);
    data.bs();
    data.handle();
    read('bd', 18);
  }
  read('text', 2); // Dimension prefixes.
  read('bd', 9);
  data.skip(6);
  read('bs', 3);
  read('bd', 9);
  data.b();
  data.bs();
  data.skip(4);
  color(); color(); color();
  read('bs', 11);
  data.skip(2);
  read('bs', 4);
  data.b();
  data.bs();
  read('handle', 5); // Dimension text style and arrowhead blocks.
  read('bs', 2);
  read('handle', paged ? 12 : 13); // Symbol tables and root dictionaries.
  read('bs', 2);
  read('text', 2);
  read('handle', paged ? 5 : 3);
  data.bl();
  const units = data.bs();
  requireValid(units <= 24, 'DWG 插入单位超出支持范围。');
  return units;
}

export function readAc1015(bytes) {
  requireValid(bytes.length >= 25 && bytes.toString('ascii', 0, 6) === 'AC1015', 'AC1015 文件头无效。');
  const count = bytes.readUInt32LE(21);
  requireValid(count >= 3 && count <= 32 && 25 + count * 9 + 18 <= bytes.length, 'AC1015 段目录无效。');
  const sections = new Map();
  for (let i = 0; i < count; i++) {
    const offset = 25 + i * 9;
    const id = bytes[offset];
    const start = bytes.readUInt32LE(offset + 1);
    const size = bytes.readUInt32LE(offset + 5);
    requireValid(!sections.has(id) && start <= bytes.length && size <= bytes.length - start, 'AC1015 段目录有无效范围。');
    sections.set(id, bytes.subarray(start, start + size));
  }
  requireValid(sections.has(2), 'AC1015 对象索引缺失。');
  const { decoder, unknownCodepage } = readDwgCodepage(bytes);
  return {
    index: objectIndex(sections.get(2), bytes.length), decoder,
    classes: readClasses(sections.get(1), decoder),
    variables: sectionData(sections.get(0), headerSentinel),
    unknownCodepage,
  };
}
