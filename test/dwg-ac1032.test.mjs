import assert from 'node:assert/strict';
import test from 'node:test';
import { expandDwgPage, readAc1032Sections } from '../src/dwg-ac1032-container.mjs';
import { Bits, objectIndex, readClasses } from '../src/dwg-ac1032-records.mjs';
import { readAc1015 } from '../src/dwg-ac1015.mjs';
import { expandAc1021, readAc1021Sections } from '../src/dwg-ac1021-container.mjs';

test('DWG page expansion supports overlap and rejects out-of-range references', () => {
  const valid = Buffer.from([1, 97, 98, 99, 100, 0x4c, 0, 0x11]);
  assert.equal(expandDwgPage(valid, 7).toString(), 'abcdabc');
  assert.throws(() => expandDwgPage(Buffer.from([0x4c, 0, 0x11]), 7), /回引用越界/);
  assert.throws(() => expandDwgPage(valid, 6), /回引用越界/);
  assert.throws(() => expandDwgPage(valid.subarray(0, -1), 7), /被截断/);
});

test('AC1021 page expansion restores literal ordering and back-references', () => {
  const valid = Buffer.from([0, 97, 98, 99, 100, 101, 102, 103, 104, 0x37, 0]);
  assert.equal(expandAc1021(valid, 11).toString(), 'abcdefghabc');
  assert.equal(expandAc1021(Buffer.from([0x20, 0, 0, 3, 99, 98, 97]), 3).toString(), 'abc');
  assert.throws(() => expandAc1021(valid.subarray(0, -1), 11), /被截断/);
  assert.throws(() => expandAc1021(Buffer.from([...valid.subarray(0, -1), 0xf8]), 11), /回引用越界/);
  assert.throws(() => readAc1021Sections(Buffer.from('AC1021')), /文件头无效/);
});

test('the object map uses unsigned handle deltas and signed location deltas', () => {
  const page = Buffer.from([0, 7, 1, 0x82, 1, 1, 0x45, 0, 0, 0, 2, 0, 0]);
  assert.deepEqual([...objectIndex(page, 200)], [[1, 130], [2, 125]]);
  assert.throws(() => objectIndex(page, 100), /对象索引无效/);
});

test('DWG doubles and short integers are decoded across byte boundaries', () => {
  const reader = new Bits(Buffer.from([0x69, 0x40, 0x00]));
  assert.equal(reader.bits(2), 1);
  assert.equal(reader.bits(2), 2);
  assert.equal(reader.bits(8), 148);
  assert.equal(reader.bits(4), 0);
  assert.throws(() => reader.bits(9), /被截断/);
  assert.throws(() => readAc1032Sections(Buffer.alloc(300)), /只读取 AC1032/);
});

test('AC1015 reads GBK and per-character multibyte escapes in the same string', () => {
  const literal = Buffer.from('\\M+194E1\\M+5BAC5\\\\M+5BAC5', 'ascii');
  const bytes = Buffer.concat([Buffer.from([1, literal.length + 2]), Buffer.from([0xcd, 0xad]), literal]);
  const data = new Bits(bytes, 6, bytes.length * 8, new TextDecoder('gbk'));
  assert.equal(data.text(), '铜批号\\\\M+5BAC5');
  assert.throws(() => readAc1015(Buffer.from('AC1015')), /文件头无效/);
});

test('AC1018 inline classes keep their alignment after a wide maintenance number', () => {
  let bits = '';
  const write = (value, width = 8) => { bits += value.toString(2).padStart(width, '0'); };
  const small = value => { write(1, 2); write(value); };
  const short = value => { write(0, 2); write(value & 255); write(value >>> 8); };
  const zero = () => write(2, 2);
  const string = value => {
    const bytes = Buffer.from(value, 'ascii');
    small(bytes.length);
    for (const byte of bytes) write(byte);
  };
  short(501); write(0); write(0); write(1, 1);
  for (const [id, name, kind, maintenance] of [[500, 'TABLESTYLE', 499, 301], [501, 'ACAD_TABLE', 498, 14]]) {
    short(id); zero(); string('App'); string('Class'); string(name);
    write(0, 1); short(kind); small(1); small(33);
    if (maintenance > 255) {
      write(0, 2);
      for (let shift = 0; shift < 32; shift += 8) write(maintenance >>> shift & 255);
    } else small(maintenance);
    zero(); zero();
  }
  const payload = Buffer.from(bits.padEnd(Math.ceil(bits.length / 8) * 8, '0').match(/.{8}/g).map(byte => parseInt(byte, 2)));
  const section = Buffer.alloc(20 + payload.length + 18);
  Buffer.from('8da1c4b8c4a9f8c5c0dcf45fe7cfb68a', 'hex').copy(section);
  section.writeUInt32LE(payload.length, 16);
  payload.copy(section, 20);
  assert.deepEqual([...readClasses(section, 104, 1018, new TextDecoder('gbk'))], [
    [500, { name: 'TABLESTYLE', entity: false }], [501, { name: 'ACAD_TABLE', entity: true }],
  ]);
});
