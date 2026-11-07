import { binaryDxfGroups, isBinaryDxf } from './dxf-binary.mjs';
import { decodeLegacyEscapes } from './cad-text.mjs';
import { MiB } from '../public/cad-limits.mjs';

export function hasDxfHeader(bytes) {
  if (isBinaryDxf(bytes)) return true;
  const encoding = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le'
    : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : 'utf-8';
  const lines = new TextDecoder(encoding).decode(bytes).split(/\r\n|\n|\r/);
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i].trim();
    if (code === '999') continue;
    return /^0{1,4}$/.test(code) && lines[i + 1].trim().toUpperCase() === 'SECTION';
  }
  // A DXF can start with a long comment that fills the header probe.
  return lines[0]?.trim() === '999';
}

const codePages = new Map([
  ['ANSI_936', 'gbk'], ['ANSI_950', 'big5'], ['ANSI_932', 'shift_jis'], ['ANSI_949', 'euc-kr'],
  ['ANSI_874', 'windows-874'], ['DOS437', 'ibm437'], ['DOS866', 'ibm866'],
  ...Array.from({ length: 9 }, (_, index) => [`ANSI_${1250 + index}`, `windows-${1250 + index}`]),
]);

function decode(bytes, warn) {
  const probe = new TextDecoder('windows-1252').decode(bytes.subarray(0, 65536));
  if (probe.startsWith('AutoCAD Binary DXF')) throw new Error('二进制 DXF 文件头无效。');
  if (/^AC10\d\d/.test(probe)) throw new Error('这是 DWG 文件。请先另存为文本型 DXF。');
  if (bytes[0] === 255 && bytes[1] === 254) return [new TextDecoder('utf-16le').decode(bytes), 'UTF-16 LE'];
  if (bytes[0] === 254 && bytes[1] === 255) return [new TextDecoder('utf-16be').decode(bytes), 'UTF-16 BE'];
  if (probe.includes('\0')) throw new Error('文件包含二进制数据，无法按文本型 DXF 读取。');

  const lineBreak = '(?:\\r\\n|\\n|\\r)';
  const field = (name, code) => probe.match(new RegExp(`(?:^|${lineBreak})[ \\t]*\\$${name}[ \\t]*${lineBreak}[ \\t]*${code}[ \\t]*${lineBreak}([^\\r\\n]+)`))?.[1].trim().toUpperCase();
  const version = field('ACADVER', 1);
  const page = field('DWGCODEPAGE', 3);
  const old = version && Number(version.slice(2)) < 1021;
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  const bom = bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191;

  if (bom || !old || !page) {
    try {
      return [utf8.decode(bytes), 'UTF-8'];
    } catch {
      if (version && !old) warn('新版本 DXF 包含非 UTF-8 字节，已尝试按旧版代码页读取。');
    }
  }
  try {
    const decoder = new TextDecoder(codePages.get(page) ?? (page ? page : 'gbk'), { fatal: true });
    if (!page) warn('文件未声明代码页，按 GBK 读取，请核对中文。');
    return [decoder.decode(bytes), decoder.encoding.toUpperCase()];
  } catch {
    try {
      const text = utf8.decode(bytes);
      if (/[^\u0000-\u007f]/.test(text)) warn(`已按 UTF-8 读取，请核对声明代码页 ${page} 的文字。`);
      return [text, 'UTF-8'];
    } catch {
      warn(`无法可靠解码${page ? ` ${page}` : ''}，部分文字可能缺失。`);
      return [new TextDecoder(codePages.get(page) === 'ibm437' ? 'gbk' : (codePages.get(page) ?? 'gbk')).decode(bytes), '兼容模式'];
    }
  }
}

function scanTextGroups(text, visit, { start = 0, end = text.length, requireEof = true } = {}) {
  const breaks = /\r\n|\n|\r/g;
  breaks.lastIndex = start;
  let offset = start;
  for (let line = 1; offset < end; line += 2) {
    const codeBreak = breaks.exec(text);
    const code = codeBreak && text.slice(offset, codeBreak.index).trim();
    if (!codeBreak || codeBreak.index >= end || !/^-?\d{1,4}$/.test(code)) {
      throw new Error(`第 ${line} 行的 DXF 组码或值无效。`);
    }
    const valueStart = breaks.lastIndex;
    const valueBreak = breaks.exec(text);
    const value = text.slice(valueStart, Math.min(valueBreak?.index ?? end, end));
    const groupCode = Number(code);
    if (groupCode === 0 && value.trim().toUpperCase() === 'EOF') return;
    if (groupCode !== 999) visit(groupCode, value, offset);
    if (!valueBreak) break;
    offset = breaks.lastIndex;
  }
  if (requireEof) throw new Error('文件缺少 DXF 结束标记，可能已截断。');
}

function groupsFromText(text, range) {
  const groups = [];
  scanTextGroups(text, (code, value) => groups.push([code, value]), range);
  return groups;
}

// Store block headers and text offsets instead of allocating group arrays for
// every block. Geometry is decoded only when the scene expands a reference.
function indexLargeTextDxf(text) {
  const sections = new Map(), blocks = new Map();
  const retained = new Set(['HEADER', 'TABLES', 'ENTITIES', 'OBJECTS']);
  let section, awaitingName = false, block, keepObject = false;
  scanTextGroups(text, (code, value, offset) => {
    const type = code === 0 ? value.trim().toUpperCase() : '';
    if (awaitingName) {
      if (code !== 2) throw new Error('DXF 段缺少名称。');
      awaitingName = false;
      section = value.trim().toUpperCase();
      if (section === 'BLOCKS') blocks.clear();
      else if (retained.has(section)) sections.set(section, []);
      return;
    }
    if (!section) {
      awaitingName = type === 'SECTION';
      return;
    }
    if (type === 'ENDSEC') {
      section = undefined;
      block = undefined;
      keepObject = false;
      return;
    }
    if (section === 'BLOCKS') {
      if (type === 'BLOCK') block = { record: { type, groups: [] }, start: null };
      else if (type === 'ENDBLK' && block) {
        const { record, start } = block;
        let entities;
        blocks.set(key(name(record, 2, name(record, 3))), { record, get entities() {
          if (entities) return entities;
          return entities = start === null ? []
            : linkChildren(records(groupsFromText(text, { start, end: offset, requireEof: false })));
        } });
        block = undefined;
      } else if (block && block.start === null) {
        if (code === 0) block.start = offset;
        else block.record.groups.push([code, value]);
      }
      return;
    }
    if (section === 'OBJECTS' && code === 0) keepObject = type === 'WIPEOUTVARIABLES' || type === 'MLEADERSTYLE';
    if (retained.has(section) && (section !== 'OBJECTS' || keepObject)) sections.get(section).push([code, value]);
  });
  if (awaitingName) throw new Error('DXF 段缺少名称。');
  if (section) throw new Error(`DXF 段 ${section} 缺少结束标记。`);
  if (!sections.has('ENTITIES')) throw new Error('文件缺少 DXF 的 ENTITIES 段。');
  return { sections, blocks };
}

function sectionsFromGroups(groups) {
  const sections = new Map();
  for (let index = 0; index < groups.length; index++) {
    const [code, value] = groups[index];
    if (code !== 0 || value.trim().toUpperCase() !== 'SECTION') continue;
    const name = groups[++index];
    if (name?.[0] !== 2) throw new Error('DXF 段缺少名称。');
    const start = ++index;
    while (index < groups.length && !(groups[index][0] === 0 && groups[index][1].trim().toUpperCase() === 'ENDSEC')) index++;
    if (index === groups.length) throw new Error(`DXF 段 ${name[1].trim()} 缺少结束标记。`);
    sections.set(name[1].trim().toUpperCase(), groups.slice(start, index));
  }
  if (!sections.has('ENTITIES')) throw new Error('文件缺少 DXF 的 ENTITIES 段。');
  return sections;
}

function records(groups = []) {
  const result = [];
  let current;
  for (const group of groups) {
    if (group[0] === 0) {
      current = { type: group[1].trim().toUpperCase(), groups: [] };
      result.push(current);
    } else if (current) {
      current.groups.push(group);
    }
  }
  return result;
}

export function raw(record, code) {
  return record?.groups.find(([key]) => key === code)?.[1];
}

export function name(record, code, fallback = '') {
  const value = raw(record, code)?.trim();
  return value ? decodeLegacyEscapes(value) : fallback;
}

export function number(record, code, fallback) {
  const value = name(record, code);
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && Math.abs(parsed) <= 1e12 ? parsed : fallback;
}

export function point(record, code = 10) {
  const x = number(record, code);
  const y = number(record, code + 10);
  return x !== undefined && y !== undefined ? [x, y] : null;
}

export function key(value) {
  return value.toUpperCase();
}

function linkChildren(entities) {
  const linked = [];
  for (let index = 0; index < entities.length; index++) {
    const entity = entities[index];
    const childType = entity.type === 'POLYLINE' ? 'VERTEX' : entity.type === 'INSERT' ? 'ATTRIB' : null;
    if (childType) {
      entity.children = [];
      while (entities[index + 1]?.type === childType) entity.children.push(entities[++index]);
      if (entities[index + 1]?.type === 'SEQEND') index++;
    }
    linked.push(entity);
  }
  return linked;
}

export function parseDxf(bytes) {
  if (!bytes.length) throw new Error('请选择非空 DXF。');
  const warnings = [];
  const warn = message => warnings.push(message);
  let sections, encoding, indexedBlocks;
  if (isBinaryDxf(bytes)) {
    let groups;
    [groups, encoding] = binaryDxfGroups(bytes, codePages, warn);
    sections = sectionsFromGroups(groups);
  } else {
    const [text, detectedEncoding] = decode(bytes, warn);
    if (bytes.length > 48 * MiB) ({ sections, blocks: indexedBlocks } = indexLargeTextDxf(text));
    else sections = sectionsFromGroups(groupsFromText(text));
    encoding = detectedEncoding;
  }
  const header = new Map();
  let variable;
  for (const [code, value] of sections.get('HEADER') ?? []) {
    if (code === 9) {
      variable = { groups: [] };
      header.set(value.trim().toUpperCase(), variable);
    } else {
      variable?.groups.push([code, value]);
    }
  }
  const tables = new Map();
  for (const record of records(sections.get('TABLES'))) {
    const entryName = name(record, 2);
    if (!entryName || !['LAYER', 'LTYPE', 'STYLE', 'DIMSTYLE'].includes(record.type)) continue;
    if (!tables.has(record.type)) tables.set(record.type, new Map());
    tables.get(record.type).set(key(entryName), record);
  }
  const blocks = indexedBlocks ?? new Map();
  let block;
  for (const record of records(sections.get('BLOCKS'))) {
    if (record.type === 'BLOCK') {
      block = { record, entities: [] };
    } else if (record.type === 'ENDBLK' && block) {
      block.entities = linkChildren(block.entities);
      blocks.set(key(name(block.record, 2, name(block.record, 3))), block);
      block = undefined;
    } else if (block) {
      block.entities.push(record);
    }
  }
  const objects = sections.get('OBJECTS') ?? [];
  const wipeout = objects.findIndex(([code, value]) => code === 0 && value.trim().toUpperCase() === 'WIPEOUTVARIABLES');
  let wipeoutFrame = 1;
  if (wipeout >= 0) {
    for (let i = wipeout + 1; i < objects.length && objects[i][0] !== 0; i++) {
      if (objects[i][0] === 70) {
        wipeoutFrame = Number(objects[i][1]);
        break;
      }
    }
  }
  const mleaderStyles = new Map();
  for (let i = 0; i < objects.length; i++) {
    if (objects[i][0] !== 0 || objects[i][1].trim().toUpperCase() !== 'MLEADERSTYLE') continue;
    const start = ++i;
    while (i < objects.length && objects[i][0] !== 0) i++;
    const record = { groups: objects.slice(start, i) };
    i--;
    mleaderStyles.set(key(name(record, 5)), record);
  }
  return { encoding, warnings, header, tables, blocks, wipeoutFrame, mleaderStyles, entities: linkChildren(records(sections.get('ENTITIES'))) };
}
