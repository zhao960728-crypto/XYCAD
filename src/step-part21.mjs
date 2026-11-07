import { decimalPattern } from './mesh-scene.mjs';

const opening = /^\s*ISO-10303-21\s*;/i;

function label(token) {
  return token.slice(1, 2049).replace(/'$/, '').replace(/''/g, "'")
    .replace(/\\X([24])\\([0-9A-F]+)\\X0\\/gi, (original, size, digits) => {
      const width = Number(size) * 2;
      if (digits.length % width) return original;
      return (digits.match(new RegExp('.{' + width + '}', 'g')) ?? []).map(hex => {
        const code = parseInt(hex, 16);
        return code <= 0x10ffff ? String.fromCodePoint(code) : '�';
      }).join('');
    });
}

export function isStep(bytes) {
  return opening.test(new TextDecoder().decode(bytes.subarray(0, 512)));
}

export function readPart21(bytes, { records: recordLimit = 1_000_000, values: valueLimit = 12_000_000 } = {}) {
  const source = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1').replace(/^\xef\xbb\xbf/, '');
  const header = opening.exec(source);
  const fail = (message = 'STEP 文件的 Part 21 记录损坏或不完整。') => { throw new Error(message); };
  if (!header) fail('文件缺少 STEP Part 21 标识。');
  const space = /\s*/y;
  const lex = new RegExp(/#[0-9]+|[A-Z_][A-Z_0-9]*|\.[A-Z_][A-Z_0-9]*\./.source + '|' + decimalPattern +
    /|'(?:[^']|'')*'|"[0-9A-F]*"|[=(),;*$]/.source, 'iy');
  let offset = header[0].length;
  let values = 0;
  function whitespace() {
    while (true) {
      space.lastIndex = offset;
      space.exec(source);
      offset = space.lastIndex;
      if (!source.startsWith('/*', offset)) return;
      const end = source.indexOf('*/', offset + 2);
      if (end < 0) fail();
      offset = end + 2;
    }
  }
  function token() {
    whitespace();
    lex.lastIndex = offset;
    const match = lex.exec(source);
    if (!match) fail();
    offset = lex.lastIndex;
    return match[0];
  }
  function expect(expected) { if (token().toUpperCase() !== expected) fail(); }
  function call(type, depth = 0) {
    if (!/^[A-Z_][A-Z_0-9]*$/i.test(type)) fail();
    expect('(');
    return { type: type.toUpperCase(), args: list(depth + 1) };
  }
  function list(depth) {
    if (depth > 32) fail('STEP 参数嵌套超过预览容量。');
    const result = [];
    let value = token();
    if (value === ')') return result;
    while (true) {
      if (++values > valueLimit) fail('STEP 参数数量超过预览容量。');
      if (value === '(') result.push(list(depth + 1));
      else if (/^[A-Z_]/i.test(value)) result.push(call(value, depth + 1));
      else if (value[0] === "'") result.push(value.length > 2 ? { text: label(value) } : null);
      else if (value[0] === '"') result.push(null);
      else if (value === '$' || value === '*' || /^(?:#|\.[A-Z_])/i.test(value)) result.push(value.toUpperCase());
      else {
        const number = Number(value);
        if (!Number.isFinite(number)) fail();
        result.push(number);
      }
      const delimiter = token();
      if (delimiter === ')') return result;
      if (delimiter !== ',') fail();
      value = token();
    }
  }
  expect('HEADER');
  expect(';');
  let record;
  while ((record = token().toUpperCase()) !== 'ENDSEC') { call(record); expect(';'); }
  expect(';');
  expect('DATA');
  expect(';');
  const records = new Map();
  while ((record = token().toUpperCase()) !== 'ENDSEC') {
    if (!/^#[1-9][0-9]{0,14}$/.test(record) || records.has(record)) fail();
    if (records.size >= recordLimit) fail('STEP 实体数量超过 ' + recordLimit / 10_000 + ' 万。');
    expect('=');
    const type = token();
    if (type === '(') {
      const components = new Map();
      let name;
      while ((name = token()) !== ')') {
        const component = call(name);
        if (components.has(component.type) || components.size >= 64) fail();
        components.set(component.type, component.args);
      }
      records.set(record, { type: '', components });
    } else records.set(record, call(type));
    expect(';');
  }
  expect(';');
  whitespace();
  if (!/^END-ISO-10303-21\s*;\s*$/i.test(source.slice(offset))) fail();
  return records;
}
