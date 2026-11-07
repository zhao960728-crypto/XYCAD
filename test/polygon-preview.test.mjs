import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPreview } from '../src/dxf-worker.mjs';

test('OBJ resolves relative face indices and triangulates a concave polygon', async () => {
  const bytes = Buffer.from([
    'mtllib ignored.mtl', 'v 0 0 0', 'v 4 0 0', 'v 4 3 0', 'v 2 1 0', 'v 0 3 0',
    'o 折弯件', 'g 主体 另一组', 'f -5//1 -4//1 -3//1 -2//1 -1//1',
  ].join('\n'));
  const { scene } = await buildPreview({ bytes, formatHint: 'obj' });
  assert.deepEqual(scene.mesh.size, [4, 3, 0]);
  const positions = Buffer.from(scene.mesh.positions, 'base64');
  let area = 0;
  for (let offset = 0; offset < positions.length; offset += 36) {
    const [ax, ay, bx, by, cx, cy] = [0, 4, 12, 16, 24, 28].map(i => positions.readFloatLE(offset + i) * 4);
    area += Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
  }
  assert.ok(Math.abs(area - 8) < 1e-6);
  assert.match(scene.issues[0][0], /按对象和分组/);
  const [object] = scene.mesh.tree;
  assert.equal(object.label, '折弯件');
  assert.deepEqual(object.children.map(({ label, start, count }) => [label, start, count]), [['主体', 0, scene.mesh.count]]);
});

const points = [[0, 0, 0], [3, 0, 0], [0, 4, 0]];

function ply(mode) {
  const header = Buffer.from(['ply', 'format ' + mode + ' 1.0', 'element vertex 3',
    'property float x', 'property float y', 'property float z', 'property uchar red',
    'element face 1', 'property list uchar int vertex_indices', 'end_header', ''].join('\n'));
  if (mode === 'ascii') return Buffer.concat([header, Buffer.from('0 0 0 255\n3 0 0 255\n0 4 0 255\n3 0 1 2\n')]);
  const binary = Buffer.alloc(3 * 13 + 13);
  const view = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);
  const little = mode === 'binary_little_endian';
  points.forEach((point, i) => point.forEach((value, j) => view.setFloat32(13 * i + j * 4, value, little)));
  binary[39] = 3;
  for (let i = 0; i < 3; i++) view.setInt32(40 + 4 * i, i, little);
  return Buffer.concat([header, binary]);
}

test('PLY reads text, little-endian and big-endian with the same positions', async () => {
  let previous;
  for (const mode of ['ascii', 'binary_little_endian', 'binary_big_endian']) {
    const { scene } = await buildPreview({ bytes: ply(mode) });
    assert.equal(scene.format, 'PLY');
    assert.equal(scene.mesh.count, 1);
    assert.deepEqual(scene.mesh.size, [3, 4, 0]);
    if (previous) assert.deepEqual(previous, scene.mesh);
    previous = scene.mesh;
  }
  await assert.rejects(buildPreview({ bytes: ply('binary_little_endian').subarray(0, -1), formatHint: 'ply' }), /截断/);
});

test('OFF reads text and big-endian polygons and rejects invalid face references', async () => {
  const text = '# Geomview\nOFF 3 1 0\n0 0 0 3 0 0\n0 4 0\n3 0 1 2 255 0 0 # color\n';
  const binary = Buffer.alloc(12 + 36 + 20);
  binary.writeUInt32BE(3, 0);
  binary.writeUInt32BE(1, 4);
  points.flat().forEach((value, i) => binary.writeFloatBE(value, 12 + i * 4));
  [3, 0, 1, 2, 0].forEach((value, i) => binary.writeUInt32BE(value, 48 + i * 4));
  const bytes = Buffer.concat([Buffer.from('OFF BINARY # big endian\r\n'), binary]);
  const { scene } = await buildPreview({ bytes: Buffer.from(text) });
  assert.equal(scene.format, 'OFF（文本）');
  assert.equal(scene.issues[0][1], 1);
  assert.deepEqual(scene.mesh.size, [3, 4, 0]);
  assert.deepEqual((await buildPreview({ bytes })).scene.mesh, scene.mesh);
  assert.deepEqual((await buildPreview({ bytes: Buffer.from(text.replace('OFF ', '')), formatHint: 'off' })).scene.mesh, scene.mesh);
  await assert.rejects(buildPreview({ bytes: bytes.subarray(0, -1), formatHint: 'off' }), /不完整/);
  await assert.rejects(buildPreview({ bytes: Buffer.from(text.replace('3 0 1 2', '3 0 1 3')), formatHint: 'off' }), /不存在的顶点/);
});
