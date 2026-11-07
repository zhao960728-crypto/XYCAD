import assert from 'node:assert/strict';
import test from 'node:test';
import { readShadedFaces, shadedView } from '../src/slddrw-shaded.mjs';

test('SolidWorks shaded face keeps its saved color and requires matching view extents', () => {
  const triplets = values => {
    const data = Buffer.alloc(16 + values.length * 4);
    Buffer.from('0c0000006400000002000000', 'hex').copy(data);
    data.writeUInt32LE(values.length / 3, 12);
    values.forEach((value, i) => data.writeFloatLE(value, 16 + 4 * i));
    return data;
  };
  const bytes = Buffer.concat([
    Buffer.from('uoTempBodyTessData_c'), Buffer.from('0100ffff01001400', 'hex'),
    Buffer.from('uoTempFaceTessData_c'), Buffer.alloc(8),
    Buffer.from('0400000008000000020000000100000004000000', 'hex'),
    triplets([0, 0, 0, 0.04, 0, 0, 0, 0.03, 0, 0.04, 0.03, 0]),
    triplets([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    Buffer.from('0b80ff4b370000000000c0c0c000fffeff', 'hex'),
  ]);
  const faces = readShadedFaces(bytes);
  assert.equal(faces.length, 1);
  assert.equal(faces[0].color, 0xff4b37);
  const view = { basis: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], move: [0, 0, 0], shift: [0, 0, 0],
    scale: 1, bounds: [0, 0, 0.04, 0.03] };
  const entities = shadedView(faces, view, 'VIEW');
  assert.equal(entities.filter(entity => entity.type === 'LINE').length, 4);
  assert.deepEqual(entities.filter(entity => entity.type === 'SOLID').map(entity => entity.color), [0xff4b37, 0xff4b37]);
  assert.deepEqual(shadedView(faces, { ...view, bounds: [0, 0, 0.08, 0.03] }, 'VIEW'), []);
});
