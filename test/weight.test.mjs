import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAssemblyScene } from '../src/assembly-scene.mjs';
import { buildMeshScene } from '../src/mesh-scene.mjs';
import { meshVolume } from '../src/mesh-volume.mjs';
import { weightKg } from '../public/weight-tools.mjs';

const points = [[0,0,0],[10,0,0],[0,10,0],[0,0,10]];
const faces = [[0,2,1],[0,1,3],[0,3,2],[1,2,3]];
const tetrahedron = (translation = 0, reverse = false) => faces.map(face =>
  (reverse ? [...face].reverse() : face).flatMap(index => points[index].map(value => value + translation)));
const volume = 1000 / 6;

test('weight uses actual geometry and rejects open or inconsistently oriented meshes', () => {
  for (const reverse of [false, true]) {
    const { mesh } = buildMeshScene('STL', null, tetrahedron(1e9, reverse));
    assert.deepEqual(mesh.volume, { method: 'mesh', value: volume });
    assert.equal(mesh.unit, null);
  }
  const open = tetrahedron().slice(1);
  assert.deepEqual(meshVolume(open.flat(), 0, open.length), { reason: 'open' });
  const mixed = [...tetrahedron(), ...tetrahedron(30, true)];
  assert.deepEqual(meshVolume(mixed.flat(), 0, mixed.length), { reason: 'orientation' });
  assert.ok(Math.abs(weightKg(20_000, 8.96) - 0.1792) < 1e-12);
  assert.equal(weightKg(20_000, 0), undefined);
  assert.equal(weightKg(Infinity, 2.7), undefined);
});

test('shared assembly volume counts each placement and rejects missing geometry', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xycad-weight-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const geometry = () => tetrahedron();
  const marker = { label: 'Part', definition: 'shared', geometry };
  const placements = [
    { ...marker, placement: p => p }, null,
    { ...marker, placement: ([x,y,z]) => [25 - 2*x, y, z] }, null,
  ];
  const scene = buildAssemblyScene(placements, directory, 'STEP', 'test');
  assert.equal(scene.mesh.meshes.length, 1);
  assert.deepEqual(scene.mesh.volume, { method: 'mesh', value: volume * 3 });
  const incomplete = await mkdtemp(join(tmpdir(), 'xycad-weight-'));
  t.after(() => rm(incomplete, { recursive: true, force: true }));
  placements.push({ ...marker, definition: 'missing', geometry: () => [] }, null);
  assert.deepEqual(buildAssemblyScene(placements, incomplete, 'STEP', 'test').mesh.volume, { reason: 'incomplete' });
});
