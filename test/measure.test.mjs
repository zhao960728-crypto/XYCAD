import assert from 'node:assert/strict';
import test from 'node:test';
import { angleBetween, distanceBetween, drawingUnits, nearestOnSegment, parallelPlaneSpacing, pickDrawingPoint, pickMeshPoint, polygonMetrics,
  projectMeshPoint, rimDiameter, triangleArea } from '../public/cad-measure.mjs';
import { buildMeshScene } from '../src/mesh-scene.mjs';

test('measurement math preserves axis differences, angles and concave polygon area', () => {
  assert.deepEqual(distanceBetween([0, 0, 0], [0.3, 0.4, 0], 10), { distance: 5, delta: [3, 4, 0] });
  assert.equal(angleBetween([4, 1], [1, 1], [1, 5]), 90);
  assert.equal(angleBetween([1, 1], [1, 1], [1, 5]), null);
  assert.ok(angleBetween([1, 0], [0, 0], [1, 1e-10]) > 0);
  assert.equal(triangleArea([0, 0, 0], [0.3, 0, 0], [0, 0, 0.4], 10), 6);
  const result = polygonMetrics([[100000, 200000], [100003, 200000], [100003, 200001],
    [100001, 200001], [100001, 200003], [100000, 200003]]);
  assert.ok(Math.abs(result.area - 5) < 1e-12);
  assert.ok(Math.abs(result.perimeter - 12) < 1e-12);
  assert.equal(polygonMetrics([[0, 0], [3, 4], [1, 4], [4, 0]]), null);
  assert.equal(drawingUnits[4], 'mm');
  assert.equal(drawingUnits[0], null);
});

test('drawing picks honor block transforms, circle trims, bulges and layer visibility', () => {
  const matrix = [0, 2, -2, 0, 10, 20];
  const line = { item: { kind: 'line', matrix, start: [0, 0], end: [4, 0] } };
  assert.deepEqual(pickDrawingPoint([line], [10.02, 24.1], 0.2).point, [10, 24]);
  const hidden = { ...line, element: { classList: { contains: value => value === 'layer-off' } } };
  assert.equal(pickDrawingPoint([hidden], [10, 24], 0.2), undefined);
  const arc = { item: { kind: 'path', matrix, arc: { center: [0, 0], radius: 3, start: 0, sweep: Math.PI / 2 } } };
  const circle = pickDrawingPoint([arc], [10, 26], 0.2, 'radius');
  assert.equal(circle.radius, 6);
  assert.deepEqual(circle.center, [10, 20]);
  assert.equal(pickDrawingPoint([arc], [10, 14], 0.2, 'radius'), undefined);
  assert.equal(pickDrawingPoint([{ item: { ...arc.item, matrix: [1, 0, 0, 2, 0, 0] } }], [3, 0], 0.2, 'radius'), undefined);
  const polyline = { item: { kind: 'path', matrix: [1, 0, 0, 1, 0, 0],
    polyline: { vertices: [[[-1, 0], 1], [[1, 0], 0]], closed: false } } };
  assert.equal(pickDrawingPoint([polyline], [0, -1], 0.2, 'radius').radius, 1);
  assert.equal(pickDrawingPoint([polyline], [0, -1], 0.2, 'segment'), undefined);
  const { segment } = pickDrawingPoint([line], [10.02, 24.1], 0.2, 'segment');
  assert.deepEqual(segment, [[10, 20], [10, 28]]);
  assert.deepEqual(nearestOnSegment([3, 23], ...segment), [10, 23]);
  assert.deepEqual(nearestOnSegment([3, 30], ...segment), [10, 28]);
});

test('mesh picking selects frontmost visible triangles and keeps assembled coordinates when exploded', () => {
  const positions = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0,
    -0.5, -0.5, 0.25, 0.5, -0.5, 0.25, 0, 0.5, 0.25]);
  const bytes = new Uint8Array(60);
  const words = new Int16Array(bytes.buffer);
  for (const i of [15, 20, 25]) words[i] = 8192;
  const mesh = { positions, appearance: { bytes, stride: 10 } };
  const camera = { right: [1, 0, 0], up: [0, 1, 0], eye: [0, 0, 1], width: 200, height: 200,
    scale: [1, 1], offset: [0, 0], depthScale: 1, spread: 0.5 };
  const target = [100 + 50 * 8192 / 32767, 100];
  const hit = pickMeshPoint(mesh, [[0, 2]], camera, target);
  assert.equal(hit.point[2], 0.25);
  assert.deepEqual(hit.normal, [0, 0, 1]);
  assert.ok(Math.abs(hit.point[0]) < 1e-12);
  assert.deepEqual(projectMeshPoint({ ...camera, spread: 0 }, hit), [100, 100]);
  assert.equal(pickMeshPoint(mesh, [[0, 1]], camera, target).point[2], 0);
  assert.equal(pickMeshPoint(mesh, [[0, 2]], camera, [199, 2]), null);
  const { mesh: scene } = buildMeshScene('fixture', 'mm', [[100, 200, 300, 110, 200, 300, 100, 220, 300]]);
  assert.deepEqual(scene.origin, [105, 210, 300]);
});

test('mesh dimensions require a distributed circular rim and measure perpendicular plane spacing', () => {
  const rim = [[3, 7, 13], [3, 10, 10], [3, 7, 7], [3, 4, 10]];
  assert.equal(rimDiameter(rim), 6);
  assert.equal(rimDiameter([...rim.slice(0, 3), [4, 4, 10]]), null);
  assert.equal(rimDiameter([...rim.slice(0, 3), rim[0]]), null);
  const narrow = [0, 0.3, 0.6, 0.9].map(angle => [Math.cos(angle), Math.sin(angle), 0]);
  assert.equal(rimDiameter(narrow), null);
  const a = { point: [0, 0, 0], normal: [0, 0, 1] };
  const b = { point: [3, 4, 0.25], normal: [0, 0, -1] };
  assert.equal(parallelPlaneSpacing(a, b, 8), 2);
  assert.equal(parallelPlaneSpacing(a, { ...b, normal: [1, 0, 0] }), null);
});

test('picking a shared mesh uses the occurrence transform and reports its assembled position', () => {
  const mesh = {
    positions: new Float32Array([0, 0, 0, 0.5, 0, 0, 0, 0.5, 0]),
    basis: [0, 1, 0, -1, 0, 0, 0, 0, 1],
    translation: [0.25, 0, 0.125],
    partOffset: [0.25, 0, 0],
  };
  const camera = { right: [1, 0, 0], up: [0, 1, 0], eye: [0, 0, 1], width: 200, height: 200,
    scale: [1, 1], offset: [0, 0], depthScale: 1, spread: 0.5 };
  const hit = pickMeshPoint(mesh, [[0, 1]], camera, [125, 87.5]);
  assert.deepEqual(hit.point, [0.125, 0.125, 0.125]);
  assert.deepEqual(hit.normal.map(value => value || 0), [0, 0, 1]);
  assert.deepEqual(projectMeshPoint(camera, hit), [125, 87.5]);
});
