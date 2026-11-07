import { decimalPattern } from './mesh-scene.mjs';

export function checkXt(valid, message = 'Parasolid XT 记录损坏或超出读取容量。') {
  if (!valid) throw new Error(message);
}

function dataOffset(bytes) {
  const prefix = bytes.toString('latin1', 0, Math.min(bytes.length, 65536));
  if (/^(?:\u00ef\u00bb\u00bf)?\*\*ABCDEFGHIJKLMNOPQRSTUVWXYZ/.test(prefix)) {
    const end = /\*\*END_OF_HEADER\*+[\r\n]+/.exec(prefix);
    return end ? end.index + end[0].length : -1;
  }
  return prefix.search(/^(?:\u00ef\u00bb\u00bf)?\s*(?=T\d+ : TRANSMIT FILE|PS\0)/) >= 0
    ? prefix.match(/^(?:\u00ef\u00bb\u00bf)?\s*/)[0].length : -1;
}

function bufferOf(bytes) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function xtEncoding(bytes) {
  const data = bufferOf(bytes), start = dataOffset(data);
  if (start < 0) return null;
  if (data[start] === 84) return 'x_t';
  if (data[start] === 80 && data[start + 1] === 83 && data[start + 2] === 0) return 'x_b';
  return null;
}

function textWire(bytes, start) {
  const source = bytes.toString('latin1', start).replace(/[ \t]*(?:\r\n|\r|\n)/g, '');
  const numeric = new RegExp(decimalPattern + '(?: |$)', 'y');
  let offset = 1;
  function char() {
    checkXt(offset < source.length);
    return source[offset++];
  }
  function number(integer = false) {
    if (source[offset] === '?') { offset++; return null; }
    numeric.lastIndex = offset;
    const match = numeric.exec(source);
    if (!match) throw new Error('Parasolid X_T 数值记录无法读取（位置 ' + offset + '）。');
    offset = numeric.lastIndex;
    const result = Number(match[0]);
    checkXt(Number.isFinite(result) && (!integer || Number.isSafeInteger(result)));
    return result;
  }
  function characters(count) {
    checkXt(count >= 0 && offset + count <= source.length);
    const plain = source.slice(offset, offset + count);
    if (!plain.includes('\\')) { offset += count; return plain; }
    let result = '';
    while (result.length < count) {
      let c = char();
      if (c === '\\') {
        c = ({ '0': '\0', n: '\r', r: '\n', '\\': '\\', '9': '         ' })[char()];
        checkXt(c !== undefined);
      }
      result += c;
    }
    checkXt(result.length === count);
    return result;
  }
  const integer = () => number(true);
  const string = () => characters(integer());
  const modeler = string(), schema = string();
  return { modeler, schema, char, string, characters, integer, short: integer, signedShort: integer, byte: integer, binary: false,
    pointer: integer, real: number, end: () => !source.slice(offset).trim(),
    logic() {
      const value = char();
      checkXt(value === 'T' || value === 'F');
      return value === 'T';
    } };
}

function binaryWire(bytes, start) {
  const variant = bytes[start + 3];
  checkXt(variant === 0 || variant === 1, 'Parasolid X_B 二进制编码未适配。');
  let offset = start + 4, little = false;
  if (variant === 1) {
    const order = bytes[offset], floatingPoint = bytes[offset + 1], charset = bytes[offset + 2];
    checkXt((order === 0 || order === 1) && floatingPoint === 0 && charset === 0,
      'Parasolid X_B 只支持 IEEE 浮点和 ASCII 字符。');
    little = order === 1;
    offset += 3;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  function read(method, size) {
    checkXt(offset + size <= view.byteLength, 'Parasolid X_B 二进制记录被截断。');
    const value = view[method](offset, little);
    offset += size;
    return value;
  }
  const byte = () => read('getUint8', 1);
  const short = () => read('getUint16', 2);
  const integer = () => read('getInt32', 4);
  function pointer() {
    const tail = read('getInt16', 2);
    checkXt(tail && tail !== -32768);
    if (tail > 0) return tail - 1;
    const head = read('getInt16', 2);
    checkXt(head > 0);
    return head * 32767 - tail - 1;
  }
  function characters(length) {
    checkXt(length >= 0 && offset + length <= bytes.length, 'Parasolid X_B 字符记录被截断。');
    const value = bytes.toString('latin1', offset, offset + length);
    offset += length;
    return value;
  }
  const modeler = characters(short()), schema = characters(integer());
  return { modeler, schema, byte, short, integer, pointer, characters, binary: true,
    signedShort() {
      const value = read('getInt16', 2);
      return value === -32764 ? null : value;
    },
    char: () => String.fromCharCode(byte()), string: () => characters(byte()),
    end: () => offset === bytes.length,
    real() {
      const value = read('getFloat64', 8);
      checkXt(Number.isFinite(value));
      return value === -3.14158e13 ? null : value;
    },
    logic() {
      const value = byte();
      checkXt(value === 0 || value === 1);
      return value === 1;
    } };
}

export function openXtWire(input, encoding) {
  const bytes = bufferOf(input), start = dataOffset(bytes);
  const actual = start >= 0 ? xtEncoding(input) : null;
  checkXt(actual && (!encoding || actual === encoding), '文件缺少对应的 Parasolid X_T 或 X_B 标识。');
  return actual === 'x_t' ? textWire(bytes, start) : binaryWire(bytes, start);
}
