import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDxf } from '../src/dxf-parser.mjs';
import { buildScene } from '../src/dxf-scene.mjs';

function encode(pairs) {
  return Buffer.from(pairs.flat().join('\n') + '\n');
}

function section(name, contents) {
  return [[0, 'SECTION'], [2, name], ...contents, [0, 'ENDSEC']];
}

function dxf(entities, { version = 'AC1027', tables = [], blocks = [] } = {}) {
  return encode([
    ...section('HEADER', [[9, '$ACADVER'], [1, version], [9, '$DWGCODEPAGE'], [3, 'ANSI_936']]),
    ...section('TABLES', tables), ...section('BLOCKS', blocks), ...section('ENTITIES', entities), [0, 'EOF'],
  ]);
}

const scene = bytes => buildScene(parseDxf(bytes));

test('the sample keeps model geometry, both languages, and the saved dimension text', () => {
  const result = scene(readFileSync(new URL('../public/sample.dxf', import.meta.url)));
  const text = result.items.filter(item => item.kind === 'text');
  assert.equal(result.items.filter(item => item.kind === 'circle').length, 2);
  assert.ok(text.some(item => item.content === '铜排预览 / COPPER BUSBAR\n示例图 · 单位 mm'));
  assert.ok(text.some(item => item.content.includes('⌀12  通孔')));
  assert.ok(text.some(item => item.content === '180' && item.layerIds.includes('标注_DIM')));
  assert.equal(result.layers.find(layer => layer.id === '参考_GUIDE').visible, false);
  assert.ok(!result.issues.some(([issue]) => issue.includes('近似重建')));
});

test('older ANSI_936 reads GBK bytes, Unicode escapes, and CAD symbols', () => {
  const bytes = dxf([[0, 'TEXT'], [10, 1], [20, 2], [40, 3], [1, 'TOKEN \\u+5b54 %%p0.1 %%d']], { version: 'AC1015' });
  const offset = bytes.indexOf('TOKEN');
  const result = scene(Buffer.concat([bytes.subarray(0, offset), Buffer.from([0xcd, 0xad, 0xc5, 0xc5]), bytes.subarray(offset + 5)]));
  assert.equal(result.encoding, 'GBK');
  assert.equal(result.items[0].content, '铜排 孔 ±0.1 °');
});

test('MTEXT joins continuation groups and preserves paragraphs, escaped braces and nonbreaking spaces', () => {
  const result = scene(dxf([[0, 'MTEXT'], [10, 5], [20, 7], [40, 2], [71, 5], [11, 0], [21, 1],
    [3, '{\\fArial;通孔\\~Hole}\\P\\{M6\\} '], [1, '\\S+0.1^0;']]));
  assert.equal(result.items[0].content, '通孔\u00a0Hole\n{M6} +0.1/0');
  assert.equal(result.items[0].angle, Math.PI / 2);
  assert.equal(result.items[0].anchor, 'middle');
  assert.equal(result.items[0].vertical, 'middle');
  assert.ok(result.issues.some(([issue]) => issue.includes('格式已简化')));
});

test('block base points, transformed inserts and inherited visibility follow both layers', () => {
  const result = scene(dxf([[0, 'INSERT'], [2, 'bolt'], [8, 'Parts'], [10, 5], [20, 9], [41, 2], [42, 3], [50, 90],
    [210, 1.223e-13], [220, -7.823e-13], [230, 1],
    [0, 'INSERT'], [2, 'bolt'], [10, 5], [20, 9], [210, 0.1], [230, 1]], {
    tables: [[0, 'LAYER'], [2, 'Parts'], [62, -3], [0, 'LAYER'], [2, 'Holes'], [70, 1], [62, 4]],
    blocks: [[0, 'BLOCK'], [2, 'BOLT'], [10, 1], [20, 2],
      [0, 'CIRCLE'], [8, '0'], [10, 1], [20, 2], [40, 1],
      [0, 'CIRCLE'], [8, 'Holes'], [10, 1], [20, 2], [40, 1], [0, 'ENDBLK']],
  }));
  const [first, second] = result.items;
  assert.equal(result.items.length, 2);
  assert.ok(result.issues.some(([message, count]) => message.includes('非标准平面的 INSERT') && count === 1));
  assert.deepEqual(first.layerIds, ['PARTS']);
  assert.deepEqual(second.layerIds, ['PARTS', 'HOLES']);
  assert.equal(result.layers.filter(layer => !layer.visible).length, 2);
  const [a, b, c, d, e, f] = first.matrix;
  assert.ok(Math.abs(a + 2 * c + e - 5) < 1e-9);
  assert.ok(Math.abs(b + 2 * d + f - 9) < 1e-9);
});

test('a missing linear dimension picture uses an explicitly reported fallback and respects override text', () => {
  const result = scene(dxf([[0, 'DIMENSION'], [2, '*D9'], [70, 32], [10, 10], [20, 6],
    [13, 0], [23, 0], [14, 10], [24, 0], [42, 10], [1, 'L=<> mm']]));
  assert.ok(result.issues.some(([issue]) => issue.includes('近似重建')));
  assert.equal(result.items.at(-1).content, 'L=10 mm');
  assert.equal(result.items.filter(item => item.kind === 'fill').length, 2);
});

test('dimensions with a missing angular picture are reported without a generated value', () => {
  const result = scene(dxf([[0, 'DIMENSION'], [2, '*D9'], [70, 34]]));
  assert.equal(result.items.length, 0);
  assert.ok(result.issues.some(([issue]) => issue.includes('无法重建')));
});

test('bulged polylines use arc segments and layout entities are reported', () => {
  const result = scene(dxf([[0, 'LWPOLYLINE'], [70, 1], [10, 0], [20, 0], [42, -1], [10, 10], [20, 0],
    [0, 'LINE'], [410, 'Layout1'], [10, 0], [20, 0], [11, 1], [21, 0]]));
  assert.equal(result.items[0].path, 'M 0 0 A 5 5 0 0 0 10 0 L 0 0 Z');
  assert.equal(result.items.length, 1);
  assert.ok(result.issues.some(([issue]) => issue.includes('图纸布局')));
});

test('constant-width polylines keep model-space width and variable width is reported', () => {
  const result = scene(dxf([[0, 'LWPOLYLINE'], [43, 2], [10, 0], [20, 0], [10, 10], [20, 0],
    [0, 'LWPOLYLINE'], [43, 2], [10, 0], [20, 5], [40, 1], [41, 3], [10, 10], [20, 5]]));
  const [constant, variable] = result.items;
  assert.equal(constant.kind, 'widePath');
  assert.equal(constant.width, 2);
  assert.equal(constant.path, 'M 0 0 L 10 0');
  assert.equal(variable.kind, 'path');
  assert.deepEqual(result.issues, [['带独立顶点宽度或旧式宽度的多段线按中心线显示。', 1]]);
});

test('solid hatches keep both boundary loops and patterned hatches report the outline fallback', () => {
  const loop = (flags, points) => [[92, flags], [72, 0], [73, 1], [93, points.length],
    ...points.flatMap(([x, y]) => [[10, x], [20, y]]), [97, 0]];
  const boundaries = [[91, 2], ...loop(3, [[0, 0], [10, 0], [10, 8], [0, 8]]),
    ...loop(2, [[2, 2], [8, 2], [8, 6], [2, 6]]), [75, 0]];
  const result = scene(dxf([[0, 'HATCH'], [440, 33554559], [70, 1], ...boundaries, [0, 'HATCH'], [70, 0], ...boundaries]));
  const [solid, pattern] = result.items;
  assert.equal(solid.kind, 'filledPath');
  assert.equal(solid.opacity, 127 / 255);
  assert.equal(solid.path, 'M 0 0 L 10 0 L 10 8 L 0 8 L 0 0 Z M 2 2 L 8 2 L 8 6 L 2 6 L 2 2 Z');
  assert.equal(pattern.kind, 'path');
  assert.equal(pattern.path, solid.path);
  assert.deepEqual(result.issues, [['图案或渐变填充暂按边界显示。', 1]]);
});

test('a concave clockwise hatch edge connects to its adjacent lines', () => {
  const result = scene(dxf([[0, 'HATCH'], [70, 1], [91, 1], [92, 1], [93, 5],
    [72, 1], [10, 0], [20, 0], [11, 10], [21, 0],
    [72, 1], [10, 10], [20, 0], [11, 10], [21, 8],
    [72, 2], [10, 10], [20, 10], [40, 2], [50, 90], [51, 180], [73, 0],
    [72, 1], [10, 8], [20, 10], [11, 0], [21, 10],
    [72, 1], [10, 0], [20, 10], [11, 0], [21, 0], [97, 0], [75, 1]]));
  assert.equal(result.items[0].path, 'M 0 0 L 10 0 L 10 8 A 2 2 0 0 0 8 10 L 0 10 L 0 0 Z');
  assert.deepEqual(result.issues, []);
});

test('an elliptical hatch edge uses polar angles at its line connections', () => {
  const x = 10 * Math.SQRT2, y = 5 * Math.SQRT2;
  const angle = Math.atan(0.5) * 180 / Math.PI;
  const result = scene(dxf([[0, 'HATCH'], [70, 1], [91, 1], [92, 1], [93, 3],
    [72, 1], [10, 0], [20, 0], [11, x], [21, y],
    [72, 3], [10, 0], [20, 0], [11, 20], [21, 0], [40, 0.5], [50, angle], [51, 90], [73, 1],
    [72, 1], [10, 0], [20, 10], [11, 0], [21, 0], [97, 0], [75, 1]]));
  assert.equal(result.items[0].kind, 'filledPath');
  assert.match(result.items[0].path, / A 20 10 0 0 1 \S+ 10 L 0 0 Z$/);
  assert.deepEqual(result.issues, []);
});

test('a cubic spline hatch edge joins the rest of the boundary', () => {
  const result = scene(dxf([[0, 'HATCH'], [70, 1], [91, 1], [92, 1], [93, 2],
    [72, 4], [94, 3], [73, 0], [74, 0], [95, 8], [96, 4],
    ...[0, 0, 0, 0, 1, 1, 1, 1].map(knot => [40, knot]),
    [10, 0], [20, 0], [10, 1], [20, 2], [10, 2], [20, 2], [10, 3], [20, 0], [97, 0],
    [72, 1], [10, 3], [20, 0], [11, 0], [21, 0], [97, 0], [75, 0]]));
  assert.equal(result.items[0].kind, 'filledPath');
  assert.match(result.items[0].path, /^M 0 0 C .* 3 0 L 0 0 Z$/);
  assert.deepEqual(result.issues, []);
});

test('DXF caret escapes preserve literal carets and paragraph breaks', () => {
  const result = scene(dxf([[0, 'MTEXT'], [10, 0], [20, 0], [40, 2], [1, 'A^ 机箱^J铜排']]));
  assert.equal(result.items[0].content, 'A^机箱\n铜排');
});

test('rejects malformed binary DXF, DWG and truncated input', () => {
  assert.throws(() => scene(Buffer.from('AutoCAD Binary DXF\r\n\x1a\0')), /二进制 DXF/);
  assert.throws(() => scene(Buffer.from('AC1032\0')), /DWG/);
  assert.throws(() => scene(dxf([]).subarray(0, -6)), /结束标记|组码/);
});

test('large text DXF loads a referenced block even after an unused block', () => {
  const bytes = Buffer.concat([
    encode([[0,'SECTION'], [2,'BLOCKS'], [0,'BLOCK'], [2,'Unused'], [0,'TEXT'], [1,'']]).subarray(0, -1),
    Buffer.alloc(49 * 1024 * 1024, 65),
    Buffer.from('\n'),
    encode([[0,'ENDBLK'], [0,'BLOCK'], [2,'Used'], [10,0], [20,0],
      [0,'LINE'], [10,0], [20,0], [11,15], [21,2], [0,'ENDBLK'], [0,'ENDSEC'],
      ...section('ENTITIES', [[0,'INSERT'], [2,'Used'], [10,20], [20,30]]), [0,'EOF']]),
  ]);
  const result = scene(bytes);
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0].end, [15, 2]);
  assert.deepEqual(result.items[0].matrix.slice(4), [20, 30]);
});

test('binary DXF decodes little-endian numeric groups and Chinese text', () => {
  const data = [Buffer.from('AutoCAD Binary DXF\r\n\x1a\0', 'ascii')];
  function pair(code, value) {
    const tag = Buffer.alloc(2);
    tag.writeUInt16LE(code);
    data.push(tag);
    if (typeof value === 'string') data.push(Buffer.from(value + '\0', 'utf8'));
    else {
      const number = Buffer.alloc(8);
      number.writeDoubleLE(value);
      data.push(number);
    }
  }
  for (const [code, value] of [[0, 'SECTION'], [2, 'HEADER'], [9, '$ACADVER'], [1, 'AC1032'], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'ENTITIES'], [0, 'TEXT'], [10, 12.5], [20, -7], [40, 2], [1, '铜排 CAD'],
    [0, 'ENDSEC'], [0, 'EOF']]) pair(code, value);
  const bytes = Buffer.concat(data);
  const parsed = scene(bytes);
  assert.equal(parsed.encoding, '二进制 · UTF-8');
  assert.equal(parsed.items[0].content, '铜排 CAD');
  assert.deepEqual(parsed.items[0].origin, [12.5, -7]);
  assert.throws(() => scene(bytes.subarray(0, -1)), /未终止/);
});

test('a cubic spline knot span preserves its Bézier control points', () => {
  const result = scene(dxf([[0, 'SPLINE'], [71, 3],
    ...[0, 0, 0, 0, 1, 1, 1, 1].map(knot => [40, knot]),
    [10, 0], [20, 0], [10, 1], [20, 2], [10, 2], [20, 2], [10, 3], [20, 0]]));
  const numbers = result.items[0].path.split(' ').filter(token => token !== 'M' && token !== 'C').map(Number);
  assert.deepEqual(numbers.map(Math.round), [0, 0, 1, 2, 2, 2, 3, 0]);
  assert.ok(numbers.every(value => Math.abs(value - Math.round(value)) < 1e-10));
});

test('fit-only and weighted splines keep their curved geometry', () => {
  const result = scene(dxf([
    [0, 'SPLINE'], [71, 3], [11, 0], [21, 0], [11, 1], [21, 1], [11, 2], [21, 0],
    [0, 'SPLINE'], [71, 2], ...[0, 0, 0, 1, 1, 1].map(knot => [40, knot]),
    [10, 1], [20, 0], [41, 1], [10, 1], [20, 1], [41, Math.SQRT1_2], [10, 0], [20, 1], [41, 1],
  ]));
  const fit = result.items[0].path.split(' ');
  assert.equal(fit[3], 'C');
  assert.ok(Math.abs(Number(fit[5]) - 0.5) < 1e-12);
  assert.deepEqual(fit.slice(8, 10).map(Number), [1, 1]);
  const weighted = result.items[1].path.split(' ');
  assert.ok(weighted.length > 9);
  for (let i = 0; i < weighted.length; i += 3) {
    assert.ok(Math.abs(Math.hypot(Number(weighted[i + 1]), Number(weighted[i + 2])) - 1) < 1e-12);
  }
});

test('wipeouts preserve paint order and arc dimensions render their saved picture', () => {
  const result = scene(dxf([
    [0, 'LINE'], [10, 0], [20, 0], [11, 3], [21, 0],
    [0, 'WIPEOUT'], [8, 'Mask'], [10, 10], [20, 20], [11, 8], [21, 0], [12, 0], [22, 4],
    [13, 1], [23, 1], [70, 7], [280, 1], [71, 2], [91, 3],
    [14, -0.5], [24, -0.5], [14, 0.5], [24, -0.5], [14, -0.5], [24, 0],
    [0, 'ARC_DIMENSION'], [2, '*D12'],
  ], { blocks: [[0, 'BLOCK'], [2, '*D12'], [0, 'TEXT'], [10, 4], [20, 5], [40, 1], [1, '⌒12.6'], [0, 'ENDBLK']] }));
  assert.deepEqual(result.items.map(item => item.kind), ['line', 'wipeout', 'text']);
  assert.equal(result.items[1].path, 'M 10 24 L 18 24 L 10 22 Z');
  assert.deepEqual(result.items[1].layerIds, ['MASK']);
  assert.equal(result.items[2].content, '⌒12.6');
  assert.deepEqual(result.issues, []);
});

test('a leader uses all WCS vertices and rotates its saved arrow block', () => {
  const result = scene(dxf([[0, 'LEADER'], [3, 'Standard'], [8, '引线'],
    [10, 4], [20, 3], [10, 4], [20, 13], [10, 12], [20, 13]], {
    tables: [[0, 'DIMSTYLE'], [2, 'Standard'], [41, 2], [341, '15']],
    blocks: [[0, 'BLOCK'], [2, '_ARROW'], [330, '15'], [10, 0], [20, 0], [0, 'SOLID'],
      [10, 0], [20, 0], [11, -1], [21, 0.17], [12, -1], [22, -0.17], [0, 'ENDBLK']],
  }));
  assert.equal(result.items[0].path, 'M 4 3 L 4 13 L 12 13');
  const arrow = result.items[1];
  assert.deepEqual(arrow.layerIds, ['引线']);
  assert.equal(arrow.kind, 'fill');
  assert.ok(Math.abs(arrow.matrix[1] + 2) < 1e-9);
  assert.deepEqual(arrow.matrix.slice(4), [4, 3]);
});

test('table geometry uses its saved block, rotation, insertion point and layer', () => {
  const result = scene(dxf([[0, 'ACAD_TABLE'], [8, '表格'], [2, '*T2'], [10, 100], [20, 30], [11, 0], [21, 1]], {
    blocks: [[0, 'BLOCK'], [2, '*T2'], [10, 1], [20, 2],
      [0, 'LINE'], [10, 1], [20, 2], [11, 41], [21, 2],
      [0, 'TEXT'], [10, 4], [20, 0], [40, 2], [1, '孔距 Pitch'], [0, 'ENDBLK']],
  }));
  assert.equal(result.items[1].content, '孔距 Pitch');
  assert.deepEqual(result.items[1].layerIds, ['表格']);
  const [a, b, c, d, e, f] = result.items[0].matrix;
  assert.ok(Math.abs(a + 2 * c + e - 100) < 1e-9);
  assert.ok(Math.abs(b + 2 * d + f - 30) < 1e-9);
});

test('table fallback draws a grid and reads cells without confusing proxy metadata with column count', () => {
  const result = scene(dxf([[0, 'ACAD_TABLE'], [10, 0], [20, 0], [92, 4800], [100, 'AcDbTable'],
    [91, 1], [92, 2], [141, 5], [142, 12], [142, 30], [171, 1], [1, '数量'],
    [171, 1], [301, 'CELL_VALUE'], [1, '18 pcs'], [302, '']]));
  assert.equal(result.items[0].kind, 'path');
  assert.deepEqual(result.items.slice(1).map(item => item.content), ['数量', '18 pcs']);
  assert.ok(result.issues.some(([message]) => message.includes('已简化显示网格')));
});
