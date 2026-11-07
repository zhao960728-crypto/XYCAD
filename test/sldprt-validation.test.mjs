import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSavedPart } from '../src/sldprt-validation.mjs';

const mesh = { instances: 2, unavailable: 0, origin: [0, 0, 50], size: [136, 74, 100] };
test('rejects a saved range containing an omitted final body', () => {
  assert.throws(() => validateSavedPart(mesh, { solidCount: 2, savedBounds: [-68, -37, 0, 68, 37, 102] }), /外形范围不一致/);
});
test('accepts matched ranges with small cached or tessellation margins', () => {
  assert.doesNotThrow(() => validateSavedPart(mesh, { solidCount: 2, savedBounds: [-68, -37, 0, 68, 37, 100.0002] }));
  assert.doesNotThrow(() => validateSavedPart(mesh, { solidCount: 2 }));
});
test('never accepts only a subset of the selected saved solids', () => {
  assert.throws(() => validateSavedPart(mesh, { solidCount: 3 }), /完整显示/);
  assert.throws(() => validateSavedPart({ ...mesh, unavailable: 1 }, { solidCount: 2 }), /完整显示/);
});
