import assert from 'node:assert/strict';
import test from 'node:test';
import { xtSphericalFace } from '../src/xt-surfaces.mjs';
import { buildPreview, buildProjection } from '../src/dxf-worker.mjs';
import { xtCurveEvaluator } from '../src/xt-curves.mjs';
import { axes, faceTriangles, cross, sub, uvTriangles } from '../src/brep-mesh.mjs';
import { torusFace } from '../src/toroidal-face.mjs';
import { parametricFace } from '../src/parametric-face.mjs';
import { verifiedXtAssemblyLinks } from '../src/xt-records.mjs';
import { buildMeshScene } from '../src/mesh-scene.mjs';

test('a localized Parasolid spherical trim keeps all generated points on the sphere', () => {
  const origin = [2, 3, 4];
  const radius = 0.5;
  const ring = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) =>
    [x, y, 2].map((value, i) => origin[i] + radius * value / Math.sqrt(6)));
  const triangles = [...xtSphericalFace(origin, radius, [ring], 1e-8, 0.001, false)];
  assert.ok(triangles.length > 2);
  for (const triangle of triangles) for (let i = 0; i < 9; i += 3) {
    const point = triangle.slice(i, i + 3);
    assert.ok(point[2] > origin[2]);
    assert.ok(Math.abs(Math.hypot(...point.map((value, axis) => value - origin[axis])) - radius) < 1e-12);
  }
});

const stepFile = data => Buffer.from(
  "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('preview; ''fixture'''),'2;1');\nENDSEC;\nDATA;\n" +
  data + '\nENDSEC;\nEND-ISO-10303-21;\n');
const mm = '#50=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));' +
  "#51=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#50))REPRESENTATION_CONTEXT('',''));";

function area({ positions, size }) {
  const bytes = Buffer.from(positions, 'base64');
  let total = 0;
  for (let i = 0; i < bytes.length; i += 36) {
    const [ax, ay, , bx, by, , cx, cy] = Array.from({ length: 8 }, (_, j) => bytes.readFloatLE(i + 4 * j));
    total += Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2;
  }
  return total * Math.max(...size) ** 2;
}

test('STEP triangulates a planar face with a hole and applies the assembly transform', async () => {
  const points = [[0,0], [10,0], [10,10], [0,10], [3,3], [7,3], [7,7], [3,7], [24,12], [0,0]]
    .map(([x, y], i) => "#"+ (i + 1) + "=CARTESIAN_POINT('',(" + x + "," + y + ",0.));");
  const data = [...points, mm,
    "#11=POLY_LOOP('',(#1,#2,#3,#4));#12=POLY_LOOP('',(#5,#6,#7,#8));",
    "#13=FACE_OUTER_BOUND('',#11,.T.);#14=FACE_BOUND('',#12,.F.);",
    "#15=FACE('',(#13,#14));#16=CLOSED_SHELL('',(#15));#17=FACETED_BREP('',#16);",
    "#18=DIRECTION('',(0.,0.,1.));#19=DIRECTION('',(0.,1.,0.));",
    "#20=AXIS2_PLACEMENT_3D('',#10,$,$);#21=AXIS2_PLACEMENT_3D('',#9,#18,#19);",
    "#22=FACETED_BREP_SHAPE_REPRESENTATION('',(#20,#17),#51);",
    "#23=SHAPE_REPRESENTATION('',(#20,#17,#21),#51);",
    "#24=ITEM_DEFINED_TRANSFORMATION('','',#20,#21);",
    "#25=(REPRESENTATION_RELATIONSHIP('','',#22,#23)REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#24)SHAPE_REPRESENTATION_RELATIONSHIP());",
    "#26=CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#25,#35);",
    "#27=PRODUCT('parent','Assembly','',());#28=PRODUCT_DEFINITION_FORMATION('','',#27);",
    "#29=PRODUCT_DEFINITION('','',#28,$);#30=PRODUCT_DEFINITION_SHAPE('','',#29);",
    "#31=SHAPE_DEFINITION_REPRESENTATION(#30,#23);",
    "#32=PRODUCT('child','Part','',());#33=PRODUCT_DEFINITION_FORMATION('','',#32);",
    "#34=PRODUCT_DEFINITION('','',#33,$);#35=PRODUCT_DEFINITION_SHAPE('','',#38);",
    "#36=PRODUCT_DEFINITION_SHAPE('','',#34);#37=SHAPE_DEFINITION_REPRESENTATION(#36,#22);",
    "#38=NEXT_ASSEMBLY_USAGE_OCCURRENCE('1','','',#29,#34,'Left');",
  ].join('\n');
  const { scene } = await buildPreview({ bytes: stepFile(data) });
  assert.equal(scene.format, 'STEP');
  assert.equal(scene.mesh.unit, 'mm');
  assert.deepEqual(scene.mesh.size, [24, 22, 0]);
  assert.ok(Math.abs(area(scene.mesh) - 168) < 1e-4);
  const [assembly] = scene.mesh.tree;
  const [first, second] = assembly.children;
  assert.equal(assembly.label, 'Assembly');
  assert.equal(second.label, 'Part · Left');
  assert.equal(second.color, first.color);
  assert.equal(second.start, first.count);
});

test('STEP AP242 uses one-based mesh indices and validates referenced coordinates', async () => {
  const data = [mm, "#1=COORDINATES_LIST('',4,((0,0,0),(3,0,0),(0,4,0),(100,100,100)));",
    "#2=TRIANGULATED_SURFACE_SET('',#1,3,(),(3,2,1),((3,2,1)));",
    "#3=TESSELLATED_SHAPE_REPRESENTATION('',(#2),#51);"].join('\n');
  const { scene } = await buildPreview({ bytes: stepFile(data), formatHint: 'stp' });
  assert.equal(scene.mesh.count, 1);
  assert.deepEqual(scene.mesh.size, [3, 4, 0]);
  await assert.rejects(buildPreview({ bytes: stepFile(data.replace('((3,2,1))', '((3,2,4))')), formatHint: 'step' }), /几何或引用不一致/);
});

test('STEP evaluates a rational B-spline edge stored inside an intersection curve', async () => {
  const data = [mm,
    "#1=CARTESIAN_POINT('',(10,0,0));#2=CARTESIAN_POINT('',(10,10,0));",
    "#3=CARTESIAN_POINT('',(0,10,0));#4=CARTESIAN_POINT('',(0,0,0));",
    "#5=VERTEX_POINT('',#1);#6=VERTEX_POINT('',#3);#7=VERTEX_POINT('',#4);",
    "#8=(BOUNDED_CURVE()B_SPLINE_CURVE(2,(#1,#2,#3),.UNSPECIFIED.,.F.,.F.)B_SPLINE_CURVE_WITH_KNOTS((3,3),(0.,1.),.UNSPECIFIED.)CURVE()GEOMETRIC_REPRESENTATION_ITEM()RATIONAL_B_SPLINE_CURVE((1.,0.7071067811865476,1.))REPRESENTATION_ITEM(''));",
    "#9=AXIS2_PLACEMENT_3D('',#4,$,$);#10=PLANE('',#9);",
    "#11=INTERSECTION_CURVE('',#8,(#10,#10),.CURVE_3D.);",
    "#12=LINE('',#4,#13);#13=VECTOR('',#14,1.);#14=DIRECTION('',(1,0,0));",
    "#15=EDGE_CURVE('',#5,#6,#11,.T.);#16=EDGE_CURVE('',#6,#7,#12,.T.);#17=EDGE_CURVE('',#7,#5,#12,.T.);",
    "#18=ORIENTED_EDGE('',*,*,#15,.T.);#19=ORIENTED_EDGE('',*,*,#16,.T.);#20=ORIENTED_EDGE('',*,*,#17,.T.);",
    "#21=EDGE_LOOP('',(#18,#19,#20));#22=FACE_OUTER_BOUND('',#21,.T.);#23=ADVANCED_FACE('',(#22),#10,.T.);",
    "#24=OPEN_SHELL('',(#23));#25=SHELL_BASED_SURFACE_MODEL('',(#24));",
    "#26=MANIFOLD_SURFACE_SHAPE_REPRESENTATION('',(#25),#51);",
  ].join('\n');
  const { scene } = await buildPreview({ bytes: stepFile(data), formatHint: 'stp' });
  assert.ok(scene.mesh.count > 12);
  assert.deepEqual(scene.mesh.size, [10, 10, 0]);
  assert.ok(Math.abs(area(scene.mesh) - 25 * Math.PI) < 0.2);
});

test('STEP meshes trimmed polynomial and rational B-spline surfaces', async () => {
  const common = [mm,
    "#1=CARTESIAN_POINT('',(0,0,0));#2=CARTESIAN_POINT('',(0,4,0));",
    "#3=CARTESIAN_POINT('',(4,0,0));#4=CARTESIAN_POINT('',(4,4,4));",
    "#5=POLY_LOOP('',(#1,#3,#4,#2));#6=FACE_OUTER_BOUND('',#5,.T.);",
    "#8=FACE_SURFACE('',(#6),#7,.T.);#9=OPEN_SHELL('',(#8));",
    "#10=SHELL_BASED_SURFACE_MODEL('',(#9));#11=MANIFOLD_SURFACE_SHAPE_REPRESENTATION('',(#10),#51);",
  ].join('\n');
  const basis = '1,1,((#1,#2),(#3,#4)),.UNSPECIFIED.,.F.,.F.,.F.';
  const knots = '(2,2),(2,2),(2.,6.),(-1.,1.),.UNSPECIFIED.';
  const polynomial = `#7=B_SPLINE_SURFACE_WITH_KNOTS('',${basis},${knots});`;
  const rational = `#7=(BOUNDED_SURFACE()B_SPLINE_SURFACE(${basis})B_SPLINE_SURFACE_WITH_KNOTS(${knots})` +
    "GEOMETRIC_REPRESENTATION_ITEM()RATIONAL_B_SPLINE_SURFACE(((1.,1.),(1.,2.)))REPRESENTATION_ITEM('')SURFACE());";
  for (const [surface, center] of [[polynomial, [2, 2, 1]], [rational, [2.4, 2.4, 1.6]]]) {
    const { scene: { mesh } } = await buildPreview({ bytes: stepFile(common + '\n' + surface) });
    assert.ok(mesh.size.every(value => Math.abs(value - 4) < 0.001), `${mesh.size}`);
    assert.ok(Math.abs(area(mesh) - 16) < 0.01);
    const data = Buffer.from(mesh.positions, 'base64');
    let found = false;
    for (let i = 0; i < data.length; i += 12) {
      if (center.every((v, j) => Math.abs(data.readFloatLE(i + 4 * j) * 4 + 2 - v) < 0.001)) found = true;
    }
    assert.ok(found);
  }
});

test('STEP follows the product occurrence for an assembly listed before its component', async () => {
  const data = [mm,
    "#1=CARTESIAN_POINT('',(0,0,0));#2=CARTESIAN_POINT('',(4,0,0));#3=CARTESIAN_POINT('',(0,2,0));",
    "#4=POLY_LOOP('',(#1,#2,#3));#5=FACE_OUTER_BOUND('',#4,.T.);#6=FACE('',(#5));",
    "#7=CLOSED_SHELL('',(#6));#8=FACETED_BREP('',#7);",
    "#9=AXIS2_PLACEMENT_3D('',#1,$,$);#10=DIRECTION('',(0,0,1));#11=DIRECTION('',(0,1,0));",
    "#12=CARTESIAN_POINT('',(20,30,0));#13=AXIS2_PLACEMENT_3D('',#12,#10,#11);",
    "#14=SHAPE_REPRESENTATION('',(#9,#13),#51);#15=FACETED_BREP_SHAPE_REPRESENTATION('',(#9,#8),#51);",
    "#16=PRODUCT_DEFINITION('','',$,$);#17=PRODUCT_DEFINITION('','',$,$);",
    "#18=PRODUCT_DEFINITION_SHAPE('','',#16);#19=PRODUCT_DEFINITION_SHAPE('','',#17);",
    "#20=SHAPE_DEFINITION_REPRESENTATION(#18,#14);#21=SHAPE_DEFINITION_REPRESENTATION(#19,#15);",
    "#22=NEXT_ASSEMBLY_USAGE_OCCURRENCE('','','',#16,#17,$);#23=PRODUCT_DEFINITION_SHAPE('','',#22);",
    "#24=ITEM_DEFINED_TRANSFORMATION('','',#13,#9);",
    "#25=(REPRESENTATION_RELATIONSHIP('','',#14,#15)REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#24)SHAPE_REPRESENTATION_RELATIONSHIP());",
    "#26=CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#25,#23);",
  ].join('\n');
  const { scene: { mesh } } = await buildPreview({ bytes: stepFile(data) });
  assert.deepEqual(mesh.size, [2, 4, 0]);
  assert.ok(Math.abs(area(mesh) - 4) < 1e-5);
});

test('STEP unwraps a trimmed toroidal face across the angular seam', async () => {
  const n = 12;
  const angles = Array.from({ length: n }, (_, i) => i / n);
  const uv = [...angles.map(t => [t, 0]), ...angles.map(t => [1, t]),
    ...angles.map(t => [1 - t, 1]), ...angles.map(t => [0, 1 - t])];
  const points = uv.map(([s, t], i) => {
    const u = (0.75 + s / 2) * Math.PI, v = (t - 0.5) * Math.PI;
    const r = 4 + Math.cos(v);
    return `#${100 + i}=CARTESIAN_POINT('',(${r * Math.cos(u)},${r * Math.sin(u)},${Math.sin(v)}));`;
  });
  const data = [mm, ...points,
    "#1=CARTESIAN_POINT('',(0,0,0));#2=AXIS2_PLACEMENT_3D('',#1,$,$);#3=TOROIDAL_SURFACE('',#2,4.,1.);",
    `#4=POLY_LOOP('',(${uv.map((_, i) => '#' + (100 + i)).join(',')}));`,
    "#5=FACE_OUTER_BOUND('',#4,.T.);#6=FACE_SURFACE('',(#5),#3,.T.);#7=OPEN_SHELL('',(#6));",
    "#8=SHELL_BASED_SURFACE_MODEL('',(#7));#9=MANIFOLD_SURFACE_SHAPE_REPRESENTATION('',(#8),#51);",
  ].join('\n');
  const { scene: { mesh } } = await buildPreview({ bytes: stepFile(data) });
  const expected = [5 - 2 * Math.SQRT2, 5 * Math.SQRT2, 2];
  assert.ok(mesh.size.every((value, i) => Math.abs(value - expected[i]) < 1e-6));
});

test('a cone face can close through its apex between two generator angles', () => {
  const rim = Array.from({ length: 49 }, (_, i) => {
    const angle = i * Math.PI / 48;
    return [Math.cos(angle), Math.sin(angle), 1];
  });
  const surface = { frame: axes([0, 0, 0], [0, 0, 1]), radius: 0, slope: 1 };
  let area = 0;
  for (const triangle of faceTriangles(surface, [[[0, 0, 0], ...rim]], 1e-5)) {
    const a = triangle.slice(0, 3), b = triangle.slice(3, 6), c = triangle.slice(6);
    area += Math.hypot(...cross(sub(b, a), sub(c, a))) / 2;
  }
  assert.ok(Math.abs(area - Math.PI / Math.SQRT2) < 0.001);
  const fullRim = Array.from({ length: 96 }, (_, i) => [Math.cos(i * Math.PI / 48), Math.sin(i * Math.PI / 48), 1]);
  let closedArea = 0;
  for (const triangle of faceTriangles(surface, [fullRim, [[0, 0, 0]]], 1e-5)) {
    const [a, b, c] = [0, 3, 6].map(i => triangle.slice(i, i + 3));
    closedArea += Math.hypot(...cross(sub(b, a), sub(c, a))) / 2;
  }
  assert.ok(Math.abs(closedArea - Math.PI * Math.SQRT2) < 0.002);
  assert.throws(() => Array.from(faceTriangles(surface, [fullRim, [[0, 0, 0.1]]], 1e-5)), /圆锥尖点/);
});

const xtRecord = (...values) => values.flat(Infinity).map(value => typeof value === 'number' ? value + ' ' : value).join('');
const xtString = value => value.length + ' ' + value;

test('Parasolid text follows the face and fin references of a circular boundary', async () => {
  const start = 'T' + xtString(': TRANSMIT FILE created by modeller version 3101290');
  const schema = xtString('SCH_1000000_10004');
  const shape = '0 ' +
    xtRecord(12, 1, Array(23).fill(0)) +
    xtRecord(13, 2, 1, 0, 1, 0, 4, 0, 0, 0, 0) +
    xtRecord(14, 4, 1, 0, '?', 0, 0, 5, 2, 9, '+', 0, 0, 0, 0, 0) +
    xtRecord(15, 5, 1, 0, 6, 4, 0) +
    xtRecord(17, 6, 5, 6, 6, 0, 0, 7, 0, 0, '+') +
    xtRecord(16, 7, 1, 0, '?', 6, 0, 0, 8, 0, 0, 0) +
    xtRecord(31, 8, 1, 0, 7, 0, 0, 0, '+', [0, 0, 0], [0, 0, 1], [1, 0, 0], 0.01) +
    xtRecord(50, 9, 1, 0, 4, 0, 0, 0, '+', [0, 0, 0], [0, 0, 1], [1, 0, 0]) + '1 0';
  const file = Buffer.from(start + schema + shape);
  const { scene } = await buildPreview({ bytes: file });
  assert.equal(scene.format, 'Parasolid X_T');
  assert.deepEqual(scene.mesh.size, [20, 20, 0]);
  assert.ok(Math.abs(area(scene.mesh) - 100 * Math.PI) < 0.3);
  await assert.rejects(buildPreview({ bytes: Buffer.from(start + xtString('SCH_1000000_99999') + shape), formatHint: 'x_t' }), /未适配/);
});

test('Parasolid expands sibling instances and gates projection on each node’s geometry', async () => {
  const header = 'T' + xtString(': TRANSMIT FILE created by modeller version 3101290') +
    xtString('SCH_1000000_20000') + '0 ';
  const circle = part => {
    const shell = part + 1, face = part + 2, loop = part + 3;
    const fin = part + 4, edge = part + 5, curve = part + 6, surface = part + 7;
    return xtRecord(12, part, Array(27).fill(0)) +
      xtRecord(13, shell, 1, 0, part, 0, face, 0, 0, 0, 0) +
      xtRecord(14, face, 1, 0, '?', 0, 0, loop, shell, surface, '+', 0, 0, 0, 0, 0) +
      xtRecord(15, loop, 1, 0, fin, face, 0) +
      xtRecord(17, fin, 0, loop, fin, fin, 0, 0, edge, 0, 0, '+') +
      xtRecord(16, edge, 1, 0, '?', fin, 0, 0, curve, 0, 0, 0) +
      xtRecord(31, curve, 1, 0, edge, 0, 0, 0, '+', [0, 0, 0], [0, 0, 1], [1, 0, 0], 0.01) +
      xtRecord(50, surface, 1, 0, face, 0, 0, 0, '+', [0, 0, 0], [0, 0, 1], [1, 0, 0]);
  };
  const assembly = header + xtRecord(10, 1, Array(16).fill(0), 2) +
    xtRecord(11, 2, 1, 0, 0, 10, 0, 1, 3, 0, 0, 0) +
    xtRecord(11, 3, 1, 0, 0, 20, 0, 1, 0, 2, 0, 0) + circle(10);
  const complete = Buffer.from(assembly + circle(20) + '1 0');
  const { scene } = await buildPreview({ bytes: complete, formatHint: 'x_t' });
  assert.deepEqual(scene.mesh.tree[0].children.map(node => node.label), ['零件 10 · 实例 2', '零件 20 · 实例 3']);
  const partial = Buffer.from(assembly + xtRecord(12, 20, Array(27).fill(0)) + '1 0');
  const preview = await buildPreview({ bytes: partial, formatHint: 'x_t' });
  assert.equal(preview.scene.projectionAvailable, false);
  assert.equal(preview.scene.mesh.tree[0].children[1].count, 0);
  assert.match(preview.scene.mesh.tree[0].children[1].label, /几何未读取/);
  assert.match((await buildProjection(partial, 'x_t', 'dxf')).error, /未完整读取/);
  assert.ok((await buildProjection(partial, 'x_t', 'dxf', '0.0')).dxf);
});

function binaryXt(little) {
  const parts = [Buffer.from(little ? [80, 83, 0, 1, 1, 0, 0] : [80, 83, 0, 0])];
  function write(kind, value) {
    const sizes = { s: 2, p: 2, d: 4, u: 1, f: 8 };
    const bytes = Buffer.alloc(sizes[kind]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (kind === 's') view.setUint16(0, value, little);
    else if (kind === 'p') view.setUint16(0, value + 1, little);
    else if (kind === 'd') view.setInt32(0, value, little);
    else if (kind === 'u') bytes[0] = value;
    else view.setFloat64(0, value, little);
    parts.push(bytes);
  }
  function row(type, id, fields, values) {
    write('s', type);
    write('p', id);
    assert.equal(fields.length, values.length);
    [...fields].forEach((kind, i) => write(kind, values[i]));
  }
  for (const [kind, label] of [['s', ': TRANSMIT FILE created by modeller version 3101290'], ['d', 'SCH_1000000_10004']]) {
    write(kind, label.length);
    parts.push(Buffer.from(label));
  }
  write('d', 0);
  row(12, 1, 'dppppppffpppupuuppppppp', Array(23).fill(0));
  row(13, 2, 'dpppppppp', [1, 0, 1, 0, 4, 0, 0, 0, 0]);
  row(14, 4, 'dpfpppppuppppp', [1, 0, -3.14158e13, 0, 0, 5, 2, 9, 43, 0, 0, 0, 0, 0]);
  row(15, 5, 'dpppp', [1, 0, 6, 4, 0]);
  row(17, 6, 'ppppppppu', [5, 6, 6, 0, 0, 7, 0, 0, 43]);
  row(16, 7, 'dpfppppppp', [1, 0, -3.14158e13, 6, 0, 0, 8, 0, 0, 0]);
  row(31, 8, 'dpppppuffffffffff', [1, 0, 7, 0, 0, 0, 43, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0.01]);
  row(50, 9, 'dpppppufffffffff', [1, 0, 4, 0, 0, 0, 43, 0, 0, 0, 0, 0, 1, 1, 0, 0]);
  row(1, 0, '', []);
  return Buffer.concat(parts);
}

test('neutral and typed IEEE X_B preserve the same topology and reject a truncated node', async () => {
  const bytes = binaryXt(false);
  const { scene } = await buildPreview({ bytes, formatHint: 'x_b' });
  assert.equal(scene.format, 'Parasolid X_B');
  assert.deepEqual(scene.mesh.size, [20, 20, 0]);
  assert.ok(Math.abs(area(scene.mesh) - 100 * Math.PI) < 0.3);
  const typed = await buildPreview({ bytes: binaryXt(true) });
  assert.deepEqual(typed.scene.mesh, scene.mesh);
  await assert.rejects(buildPreview({ bytes: bytes.subarray(0, -3), formatHint: 'x_b' }), /截断/);
});

test('Parasolid evaluates a parameter-space spline and projects intersection chart points to both surfaces', () => {
  const cylinderZ = { type: 51, position: [0, 0, 0], axis: [0, 0, 1], x: [1, 0, 0], radius: 0.02 };
  const cylinderX = { type: 51, position: [0, 0, 0], axis: [1, 0, 0], x: [0, 1, 0], radius: 0.025 };
  const expected = y => [Math.sqrt(0.02 ** 2 - y ** 2), y, Math.sqrt(0.025 ** 2 - y ** 2)];
  const chart = [expected(-0.012), expected(0), expected(0.012)];
  const nodes = new Map([
    [1, cylinderZ], [2, cylinderX],
    [3, { type: 40, count: 3, error: 0.001, samples: chart }],
    [4, { type: 134, nurbs: 5 }],
    [5, { type: 136, degree: 1, count: 2, dimensions: 2, knotCount: 2, rational: false, points: 6, multiples: 7, knots: 8 }],
    [6, { type: 45, values: [0, 0.01, Math.PI / 2, 0.01] }],
    [7, { type: 127, values: [2, 2, 0, 0] }],
    [8, { type: 128, values: [0, 1, null, null] }],
  ]);
  const evaluator = xtCurveEvaluator((id, type) => {
    const value = nodes.get(id);
    assert.ok(value && (type === undefined || value.type === type));
    return value;
  });
  const ring = evaluator.splinePoints({ type: 137, parameterCurve: 4, surface: 1 },
    [0.02, 0, 0.01], [0, 0.02, 0.01], true, 1e-8, [0, 1]);
  assert.ok(ring.length > 8);
  assert.ok(ring.every(([x, y, z]) => Math.abs(Math.hypot(x, y) - 0.02) < 1e-10 && Math.abs(z - 0.01) < 1e-10));
  const points = evaluator.intersectionPoints({ surfaces: [1, 2], chart: 3 }, chart[0], chart[2], true, 1e-8);
  assert.ok(points.length > chart.length);
  assert.ok(points.every(([x, y, z]) =>
    Math.abs(Math.hypot(x, y) - 0.02) < 1e-9 && Math.abs(Math.hypot(y, z) - 0.025) < 1e-9));

  // The first and last points of this circle are absent from the chart itself.
  const circle = angle => [0.02 * Math.cos(angle), 0.02 * Math.sin(angle), 0];
  const start = circle(0);
  const samples = Array.from({ length: 11 }, (_, i) => circle((i + 1) * Math.PI / 6));
  nodes.set(9, { type: 50, position: [0, 0, 0], axis: [0, 0, 1], x: [1, 0, 0] });
  nodes.set(10, { type: 40, count: samples.length, samples });
  nodes.set(11, { type: 41, samples: [start] });
  const closed = evaluator.intersectionPoints({ surfaces: [1, 9], chart: 10, limitStart: 11, limitEnd: 11 },
    start, start, true, 1e-8);
  assert.ok(closed.length > samples.length);
  assert.deepEqual(closed[0], start);
  assert.deepEqual(closed.at(-1), start);
  assert.ok(closed.every(([x, y, z]) => Math.abs(Math.hypot(x, y) - 0.02) < 1e-9 && z === 0));

  nodes.set(12, { type: 124, sense: '+', nurbs: 13 });
  nodes.set(13, { type: 126, uDegree: 1, vDegree: 1, uCount: 2, vCount: 2, dimensions: 3, points: 14,
    uMultiples: 15, vMultiples: 15, uKnots: 16, vKnots: 16 });
  nodes.set(14, { type: 45, values: [0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0] });
  nodes.set(15, { type: 127, values: [2, 2] });
  nodes.set(16, { type: 128, values: [0, 1] });
  nodes.set(17, { type: 60, basis: 12, offsetDistance: -0.002 });
  const offset = evaluator.surface(17);
  assert.deepEqual(offset.raw(0.25, 0.75), [0.25, 0.75, -0.002]);
  assert.ok(offset.inverse([0.25, 0.75, -0.002], 1e-10).error < 1e-10);

  nodes.set(18, { type: 31, position: [0.04, 0, 0], axis: [0, 1, 0], x: [1, 0, 0], major: 0.002 });
  nodes.set(19, { type: 68, basis: 18, position: [0, 0, 0], axis: [0, 0, 1], x: [1, 0, 0] });
  const revolved = evaluator.surface(19);
  const rotated = revolved.raw(Math.PI / 2, -Math.PI / 2);
  assert.ok(Math.hypot(rotated[0], rotated[1] + 0.04, rotated[2] + 0.002) < 1e-12);
  assert.ok(Math.abs(revolved.constraint(rotated)[0]) < 1e-12);

  nodes.set(20, { type: 134, nurbs: 21 });
  nodes.set(21, { type: 136, degree: 1, count: 2, dimensions: 3, knotCount: 2, rational: false,
    points: 22, multiples: 15, knots: 16 });
  nodes.set(22, { type: 45, values: [0, 0, 0, 1, 0, 1] });
  nodes.set(23, { type: 67, basis: 20, axis: [0, 0, 1] });
  const extruded = evaluator.surface(23);
  assert.deepEqual(extruded.raw(0.25, 0.5), [0.25, 0, 0.75]);
  const projected = extruded.inverse([0.25, 0, 0.75], 1e-10);
  assert.ok(projected.error < 1e-10);
  assert.ok(Math.abs(projected.uv[1] - 0.5) < 1e-10);
});

test('torus trimming supports a complete wrap along either parameter axis', () => {
  const major = 4, minor = 1;
  const frame = axes([0, 0, 0], [0, 0, 1], [1, 0, 0]);
  const point = (u, v) => [(major + minor * Math.cos(v)) * Math.cos(u),
    (major + minor * Math.cos(v)) * Math.sin(u), minor * Math.sin(v)];
  const angles = Array.from({ length: 64 }, (_, i) => i * Math.PI / 32);
  for (const rings of [
    [angles.map(u => point(u, 0)), angles.map(u => point(u, Math.PI / 2))],
    [angles.map(v => point(0, v)), angles.map(v => point(Math.PI / 2, v))],
  ]) {
    const triangles = [...torusFace(frame, major, minor, rings, 1e-8, 0.01, false)];
    assert.ok(triangles.length > angles.length);
    for (const triangle of triangles) for (let i = 0; i < 9; i += 3) {
      const [x, y, z] = triangle.slice(i, i + 3);
      assert.ok(Math.abs(Math.hypot(Math.hypot(x, y) - major, z) - minor) < 1e-10);
    }
  }
});

test('a seamless cylinder keeps a stepped height on the winding trim boundary', () => {
  const ring = (angle, z) => [Math.cos(angle), Math.sin(angle), z];
  const angles = Array.from({ length: 96 }, (_, i) => 2 * Math.PI * i / 96);
  const bottom = angles.map(a => ring(a, 0));
  const top = [...angles.slice(0, 49).map(a => ring(a, 2)),
    ...angles.slice(48).map(a => ring(a, 1)), ring(0, 1)];
  const frame = axes([0, 0, 0], [0, 0, 1], [1, 0, 0]);
  let total = 0;
  for (const triangle of faceTriangles({ frame, radius: 1 }, [bottom, top], 1e-7)) {
    const [a, b, c] = [0, 3, 6].map(i => triangle.slice(i, i + 3));
    total += Math.hypot(...cross(sub(b, a), sub(c, a))) / 2;
  }
  assert.ok(Math.abs(total - 3 * Math.PI) < 0.003);
});

test('a winding cylinder can cut its seam away from an angular reversal', () => {
  const frame = axes([0, 0, 0], [0, 0, 1], [1, 0, 0]);
  const angles = Array.from({ length: 96 }, (_, i) => 2 * Math.PI * i / 96);
  const point = (angle, z) => [Math.cos(angle), Math.sin(angle), z];
  const top = [[0, 2], [0.12, 2], [0.02, 1.8], [0.2, 1.6], ...angles.slice(4).map(angle => [angle, 1.6])];
  const rings = [angles.map(angle => point(angle, 0)), top.map(([angle, z]) => point(angle, z))];
  const triangles = [...faceTriangles({ frame, radius: 1 }, rings, 1e-7)];
  assert.ok(triangles.length > angles.length);
  assert.equal(Math.max(...triangles.map(triangle => Math.max(triangle[2], triangle[5], triangle[8]))), 2);
});

test('a clipped spindle torus retains its outer trim', () => {
  const major = 2, minor = 3;
  const frame = axes([0, 0, 0], [0, 0, 1], [1, 0, 0]);
  const ring = v => Array.from({ length: 64 }, (_, i) => {
    const u = i * Math.PI / 32;
    const radius = major + minor * Math.cos(v);
    return [radius * Math.cos(u), radius * Math.sin(u), minor * Math.sin(v)];
  });
  const triangles = [...torusFace(frame, major, minor, [ring(-0.5), ring(0.5)], 1e-8, 0.01, false)];
  assert.ok(triangles.length > 64);
  for (const triangle of triangles) for (let i = 0; i < 9; i += 3) {
    const [x, y, z] = triangle.slice(i, i + 3);
    assert.ok(Math.abs(Math.hypot(Math.hypot(x, y) - major, z) - minor) < 1e-10);
  }
});

test('a periodic spline face can close between two complete iso-parametric trims', () => {
  const turn = 2 * Math.PI;
  const evaluate = (u, v) => [Math.cos(u * turn), Math.sin(u * turn), v];
  const surface = {
    evaluate,
    periodic: [true, false],
    inverse: ([x, y, v]) => ({ uv: [(Math.atan2(y, x) / turn + 1) % 1, v], error: 0 }),
  };
  const parameters = Array.from({ length: 48 }, (_, i) => i / 48);
  const rings = [parameters.map(u => evaluate(u, 0)), parameters.slice().reverse().map(u => evaluate(u, 1))];
  let area = 0;
  for (const triangle of parametricFace(surface, rings, 1e-7, 0.001, false)) {
    const [a, b, c] = [0, 3, 6].map(i => triangle.slice(i, i + 3));
    area += Math.hypot(...cross(sub(b, a), sub(c, a))) / 2;
  }
  assert.ok(Math.abs(area - turn) < 0.006);
});

test('a closed Parasolid parameter curve can trim through its saved seam', () => {
  const nodes = new Map([
    [1, { type: 52, position: [0, 0, 0], axis: [0, 0, 1], x: [1, 0, 0], radius: 1, sine: 0.6, cosine: 0.8 }],
    [2, { type: 134, nurbs: 3 }],
    [3, { type: 136, degree: 1, count: 2, dimensions: 2, knotCount: 2, rational: false, points: 4, multiples: 5, knots: 6 }],
    [4, { type: 45, values: [0, 0.1, 2 * Math.PI, 0.1] }],
    [5, { type: 127, values: [2, 2] }],
    [6, { type: 128, values: [0, 1] }],
  ]);
  const curve = { type: 137, surface: 1, parameterCurve: 2 };
  const radius = 1.075;
  const points = xtCurveEvaluator(id => nodes.get(id), 0.002).splinePoints(
    curve, [0, -radius, 0.1], [0, radius, 0.1], true, 1e-7, [0.75, 1.25]);
  assert.ok(points.every(([x, y, z]) => x >= 0 && Math.abs(Math.hypot(x, y) - radius) < 1e-12 && z === 0.1));
  assert.ok(points.some(([x]) => Math.abs(x - radius) < 1e-12));
});

test('a constant Parasolid blend keeps its circular section between both supports', () => {
  const nodes = new Map([
    [1, { type: 50, sense: '+', position: [0, 0, 0], axis: [1, 0, 0], x: [0, 1, 0] }],
    [2, { type: 50, sense: '+', position: [0, 0, 0], axis: [0, 0, 1], x: [1, 0, 0] }],
    [3, { type: 56, blendKind: 'R', supports: [1, 2], offsets: [1, 1], rates: [1, 1], spine: 4 }],
    [4, { type: 38, chart: 5 }],
    [5, { type: 40, count: 2, firstParameter: 0, samples: [[1, 0, 1], [1, 1, 1]] }],
    [6, { type: 59, blend: 3, side: 1 }],
  ]);
  const curves = xtCurveEvaluator(id => nodes.get(id));
  const surface = curves.surface(3);
  assert.deepEqual(surface.raw(0.5, 0), [0, 0.5, 1]);
  assert.deepEqual(surface.raw(0.5, 1), [1, 0.5, 0]);
  const middle = surface.raw(0.5, 0.5);
  assert.ok(Math.abs(Math.hypot(middle[0] - 1, middle[2] - 1) - 1) < 1e-12);
  assert.equal(curves.surface(6).contactSupport, 1);
  assert.equal(curves.surface(6).constraint([0, 0.5, 1], 0.001)[0], 0);
});

test('an assembly owner chain accounts for every instance and preserves a saved empty node', () => {
  const source = new Map([
    [1, { type: 10, instance: 2 }],
    [2, { type: 11, owner: 1, backward: 0, forward: 3, part: 4 }],
    [3, { type: 11, owner: 1, backward: 2, forward: 0, part: 5 }],
    [4, { type: 10, instance: 0 }],
    [5, { type: 12 }],
  ]);
  const links = verifiedXtAssemblyLinks(source);
  assert.deepEqual(links.get(1).map(([id]) => id), [2, 3]);
  assert.deepEqual(links.get(4), []);
  source.get(3).backward = 0;
  assert.equal(verifiedXtAssemblyLinks(source), null);
  const markers = [{ label: 'root' }, { label: 'empty', keepEmpty: true }, null,
    { label: 'solid', key: 1 }, [0, 0, 0, 1, 0, 0, 0, 1, 0], null, null];
  const { mesh } = buildMeshScene('test', 'mm', markers);
  assert.deepEqual(mesh.tree[0].children.map(({ label, count }) => [label, count]), [['empty', 0], ['solid', 1]]);
  assert.throws(() => buildMeshScene('test', 'mm', markers, [], [0, 0]), /没有可生成三视图的几何/);
});

test('crossing trim edges split at the intersection before even-odd filling', () => {
  const loop = [[0, 0], [2, 2], [0, 2], [2, 0]];
  const faces = [...uvTriangles([loop], 1e-8, 1e-7, true)];
  const area = faces.reduce((sum, [[ax, ay], [bx, by], [cx, cy]]) =>
    sum + Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2, 0);
  assert.equal(area, 2);
  assert.ok(faces.every(face => face.some(([x, y]) => x === 1 && y === 1)));
});

test('a densely perforated face keeps every hole without a levels-times-edges rejection', () => {
  const holes=1800,height=holes*3+2;
  const loops=[[[0,0],[5,0],[5,height],[0,height]]];
  for(let i=0;i<holes;i++){const y=i*3+1;loops.push([[1,y],[2,y],[2,y+.25],[1,y+.25]]);}
  let area=0;
  for(const [[ax,ay],[bx,by],[cx,cy]] of uvTriangles(loops,1e-8))
    area+=Math.abs((bx-ax)*(cy-ay)-(by-ay)*(cx-ax))/2;
  assert.equal(area,5*height-holes*.25);
});

test('a periodic cylinder wire with equally directed full rims keeps its finite band',()=>{
  const frame=axes([0,0,0],[0,0,1]);
  const circle=z=>Array.from({length:97},(_,i)=>[2*Math.cos(i*Math.PI/48),2*Math.sin(i*Math.PI/48),z]);
  const ring=[...circle(0),...circle(5)];
  const triangles=[...faceTriangles({frame,radius:2,slope:0},[ring],1e-8)];
  const area=triangles.reduce((s,t)=>s+Math.hypot(...cross(sub(t.slice(3,6),t.slice(0,3)),sub(t.slice(6,9),t.slice(0,3))))/2,0);
  assert(Math.abs(area-20*Math.PI)<.02);assert(triangles.every(t=>[0,3,6].every(i=>Math.abs(Math.hypot(t[i],t[i+1])-2)<1e-10)));
});
