import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { openExb, readExbPreview } from '../src/exb-preview.mjs';
import { readExbVector } from '../src/exb-vector.mjs';

function compoundPreview() {
  const end = 0xfffffffe;
  const bytes = Buffer.alloc(11 * 512);
  Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(bytes);
  bytes.writeUInt16LE(3, 26);
  bytes.writeUInt16LE(0xfffe, 28);
  bytes.writeUInt16LE(9, 30);
  bytes.writeUInt16LE(6, 32);
  bytes.writeUInt32LE(1, 44);
  bytes.writeUInt32LE(1, 48);
  bytes.writeUInt32LE(4096, 56);
  bytes.fill(0xff, 76, 512);
  bytes.writeUInt32LE(0, 76);
  bytes.fill(0xff, 512, 1024);
  bytes.writeUInt32LE(0xfffffffd, 512);
  bytes.writeUInt32LE(end, 516);
  for (let id = 2; id < 10; id++) bytes.writeUInt32LE(id === 9 ? end : id + 1, 512 + id * 4);

  function entry(id, name, type, right, child) {
    const offset = 1024 + 128 * id;
    bytes.write(name, offset, 'utf16le');
    bytes.writeUInt16LE((name.length + 1) * 2, offset + 64);
    bytes[offset + 66] = type;
    bytes.writeUInt32LE(0xffffffff, offset + 68);
    bytes.writeUInt32LE(right, offset + 72);
    bytes.writeUInt32LE(child, offset + 76);
    return offset;
  }
  entry(0, 'Root Entry', 5, 0xffffffff, 1);
  entry(1, '*FileInfoStream', 2, 2, 0xffffffff);
  entry(2, '*SpaceStream', 2, 3, 0xffffffff);
  const stream = entry(3, '*PreviewStream', 2, 0xffffffff, 0xffffffff);
  bytes.writeUInt32LE(2, stream + 116);
  bytes.writeUInt32LE(4096, stream + 120);
  const bmp = bytes.subarray(bytes.length - 66);
  bmp.write('BM');
  bmp.writeUInt32LE(66, 2);
  bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(4, 18);
  bmp.writeInt32LE(1, 22);
  bmp.writeUInt16LE(1, 26);
  bmp.writeUInt16LE(24, 28);
  return bytes;
}

test('CAXA EXB reads the named preview across sectors and rejects a cyclic chain', () => {
  const bytes = compoundPreview();
  const preview = readExbPreview(bytes);
  assert.deepEqual([preview.width, preview.height, preview.mime], [4, 1, 'image/bmp']);
  assert.deepEqual(Buffer.from(preview.base64, 'base64'), bytes.subarray(bytes.length - 66));
  bytes.writeUInt32LE(2, 512 + 3 * 4);
  assert.throws(() => readExbPreview(bytes), /数据流无效/);
});

function vectorFixture() {
  const eoc = 0xfffffffe, free = 0xffffffff;
  const bytes = Buffer.alloc(6 * 512);
  Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(bytes);
  bytes.writeUInt16LE(3, 26);
  bytes.writeUInt16LE(0xfffe, 28);
  bytes.writeUInt16LE(9, 30);
  bytes.writeUInt16LE(6, 32);
  for (const [offset, value] of [[44,1],[48,1],[56,4096],[60,3],[64,1],[68,eoc]]) bytes.writeUInt32LE(value,offset);
  bytes.fill(0xff,76,512);
  bytes.writeUInt32LE(0,76);
  bytes.fill(0xff,512,1024);
  [0xfffffffd,2,eoc,eoc,eoc].forEach((value,i) => bytes.writeUInt32LE(value,512+i*4));
  function entry(id, name, kind, sibling, child, start = eoc, size = 0) {
    const p = 1024 + 128 * id;
    bytes.write(name,p,'utf16le');
    bytes.writeUInt16LE((name.length+1)*2,p+64);
    bytes[p+66] = kind;
    for (const [offset,value] of [[68,free],[72,sibling],[76,child],[116,start],[120,size]]) bytes.writeUInt32LE(value,p+offset);
  }
  function rec(guid, id, owner, body) {
    const head = Buffer.alloc(30);
    Buffer.from(guid,'hex').copy(head);
    head.writeInt32LE(id,16);
    head.writeInt32LE(owner,20);
    head[24] = 1;
    head.writeUInt32LE(body.length,26);
    return Buffer.concat([head,body]);
  }
  const header = Buffer.alloc(172);
  header.writeUInt32LE(8);
  header.write('0.0',4,'utf16le');
  const model = rec('81305fb60e5c004d97b40c5231051af1',-5,-4,Buffer.alloc(62));
  const line = Buffer.alloc(81);
  line.writeUInt32LE(0x800000);
  [2,3,0,42,3,0].forEach((v,i) => line.writeDoubleLE(v,33+i*8));
  const solid = Buffer.alloc(269);
  solid.writeUInt32LE(0x800000);
  [1,1,1019,4].forEach((v,i) => solid.writeUInt32LE(v,57+i*4));
  [[2,3],[6,4],[6,2],[2,3]].forEach(([x,y],i) => {
    solid.writeDoubleLE(x,73+i*48);
    solid.writeDoubleLE(y,81+i*48);
  });
  const drawing = Buffer.concat([header,model,rec('2df7ec1746c09a4e8416fd8220fd33b5',100,-5,line),
    rec('4e6d67d7e0b9c346894de9ef7fb66fb2',101,-5,solid)]);
  const payload = deflateSync(drawing);
  const stream = Buffer.alloc(20);
  stream.writeUInt32LE(0x3de3de00);
  stream.writeUInt32LE(0x40000,4);
  stream.writeBigUInt64LE(BigInt(drawing.length),8);
  stream.writeUInt32LE(payload.length,16);
  const length = payload.length + stream.length;
  const sectors = Math.ceil(length/64);
  bytes.fill(0xff,2048,2560);
  for (let i=0;i<sectors;i++) bytes.writeUInt32LE(i===sectors-1 ? eoc : i+1,2048+i*4);
  stream.copy(bytes,2560);
  payload.copy(bytes,2580);
  entry(0,'Root Entry',5,free,1,4,512);
  entry(1,'*FileInfoStream',2,2,free);
  entry(2,'*SpaceStream',2,3,free);
  entry(3,'*BlockStg',1,free,4);
  entry(4,'*Blk_fffffffb',2,free,free,0,length);
  return bytes;
}

test('EXB reads compressed model records in the mini stream and preserves legacy arrow bounds', () => {
  const bytes = vectorFixture();
  const scene = readExbVector(openExb(bytes));
  assert.equal(scene.image, undefined);
  assert.deepEqual(scene.items.map(item => item.kind), ['line','filledPath']);
  assert.deepEqual(scene.items[0].end, [42,3]);
  assert.match(scene.items[1].path, /^M 2 3 L 6 4 L 6 2 L 2 3 Z$/);
  bytes.writeUInt32LE(0,2048);
  assert.throws(() => readExbVector(openExb(bytes)), /数据流无效/);
});
