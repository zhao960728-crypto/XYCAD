import { isStep, readPart21 } from './step-part21.mjs';
import { buildMeshScene, meshLabel } from './mesh-scene.mjs';
import { arcPoints, axes, cross, faceTriangles, localPoint, mul, near, requireBrep, sub, worldPoint } from './brep-mesh.mjs';
import { splineAxis, splineEdge } from './spline-basis.mjs';
import { parametricFace } from './parametric-face.mjs';
import { stepSplineSurface } from './step-surfaces.mjs';
import { torusFace } from './toroidal-face.mjs';
import { MiB } from '../public/cad-limits.mjs';

const shapeTypes = new Set(['SHAPE_REPRESENTATION', 'ADVANCED_BREP_SHAPE_REPRESENTATION', 'FACETED_BREP_SHAPE_REPRESENTATION',
  'MANIFOLD_SURFACE_SHAPE_REPRESENTATION', 'TESSELLATED_SHAPE_REPRESENTATION', 'GEOMETRICALLY_BOUNDED_SURFACE_SHAPE_REPRESENTATION']);
const brepTypes = new Set(['MANIFOLD_SOLID_BREP', 'FACETED_BREP', 'BREP_WITH_VOIDS', 'SHELL_BASED_SURFACE_MODEL', 'FACE_BASED_SURFACE_MODEL']);
const meshTypes = new Set(['TRIANGULATED_FACE', 'TRIANGULATED_SURFACE_SET', 'TESSELLATED_SOLID', 'TESSELLATED_SHELL', 'TESSELLATED_GEOMETRIC_SET']);
const prefixes = new Map([['$', 1], ['.MICRO.', 1e-6], ['.MILLI.', 1e-3], ['.CENTI.', 1e-2], ['.DECI.', 1e-1], ['.KILO.', 1e3]]);
const flag = value => {
  requireBrep(value === '.T.' || value === '.F.');
  return value === '.T.';
};
const refs = value => { requireBrep(Array.isArray(value)); return value; };
const vector = value => {
  requireBrep(Array.isArray(value) && value.length === 3 && value.every(n => typeof n === 'number' && Math.abs(n) <= 1e100));
  return value;
};

function* triangles(records, stats, shared = false) {
  function record(id, expected) {
    const entity = records.get(id);
    requireBrep(entity && (!expected || entity.type === expected), 'STEP 实体引用缺失或类型不符。');
    return entity;
  }
  const point = id => vector(record(id, 'CARTESIAN_POINT').args[1]);
  const direction = id => vector(record(id, 'DIRECTION').args[1]);
  const vertex = id => point(record(id, 'VERTEX_POINT').args[1]);
  const optional = value => value === '$' || value === undefined;
  function frame(id, scale = 1) {
    const [, origin, axis, x] = record(id, 'AXIS2_PLACEMENT_3D').args;
    return axes(mul(point(origin), scale), optional(axis) ? [0, 0, 1] : direction(axis), optional(x) ? undefined : direction(x));
  }
  function factor(id, dimension, depth = 0) {
    requireBrep(depth < 8, 'STEP 单位定义循环。');
    const unit = record(id);
    const si = unit.components?.get('SI_UNIT');
    const conversion = unit.components?.get('CONVERSION_BASED_UNIT');
    if (si) {
      const base = dimension === 'LENGTH_UNIT' && si[1] === '.METRE.' ? 1000
        : dimension === 'PLANE_ANGLE_UNIT' && si[1] === '.RADIAN.' ? 1 : undefined;
      const scale = base * prefixes.get(si[0]);
      requireBrep(scale > 0, 'STEP 使用暂未适配的单位。');
      return scale;
    }
    if (conversion) {
      const [measure, baseUnit] = record(conversion[1]).args ?? [];
      const scale = measure?.args?.[0] * factor(baseUnit, dimension, depth + 1);
      requireBrep(scale > 0 && Number.isFinite(scale), 'STEP 的换算单位无效。');
      return scale;
    }
    throw new Error('STEP 使用暂未适配的单位。');
  }
  function context(id) {
    const components = record(id).components;
    const units = components?.get('GLOBAL_UNIT_ASSIGNED_CONTEXT')?.[0] ?? [];
    const lengthId = refs(units).find(unit => record(unit).components?.has('LENGTH_UNIT'));
    const angleId = refs(units).find(unit => record(unit).components?.has('PLANE_ANGLE_UNIT'));
    requireBrep(lengthId, 'STEP 模型没有可读取的长度单位。');
    const length = factor(lengthId, 'LENGTH_UNIT');
    const angle = angleId ? factor(angleId, 'PLANE_ANGLE_UNIT') : 1;
    const uncertaintyId = components?.get('GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT')?.[0]?.[0];
    const [measure, uncertaintyUnit] = uncertaintyId ? record(uncertaintyId).args ?? [] : [];
    const tolerance = measure?.type === 'LENGTH_MEASURE' ? measure.args[0] * factor(uncertaintyUnit, 'LENGTH_UNIT') : 0;
    const boundaryTolerance = Math.max(1e-5, Math.min(0.05, tolerance * 2));
    return { length, angle, tolerance: boundaryTolerance / length,
      chord: Math.max(0.008, Math.min(0.05, boundaryTolerance * 2)) / length };
  }
  const splines = new Map();
  function spline(curve) {
    if (splines.has(curve)) return splines.get(curve);
    const [degree, controls] = curve.components?.get('B_SPLINE_CURVE') ?? curve.args.slice(1);
    const [multiplicities, knots] = curve.components?.get('B_SPLINE_CURVE_WITH_KNOTS') ?? curve.args.slice(6);
    const weights = curve.components?.get('RATIONAL_B_SPLINE_CURVE')?.[0];
    const points = refs(controls).map(point);
    const axis = splineAxis(degree, points.length, knots, multiplicities);
    requireBrep(!weights || Array.isArray(weights) && weights.length === points.length &&
      weights.every(w => Number.isFinite(w) && w > 0), 'STEP 有无效的有理样条权重。');
    const values = weights ? points.map((p, i) => [...mul(p, weights[i]), weights[i]]) : points;
    const evaluate = t => {
      const p = axis.evaluate(values, t);
      return weights ? mul(p.slice(0, 3), 1 / p[3]) : p;
    };
    const result = { axis, evaluate };
    splines.set(curve, result);
    return result;
  }
  function edgePoints(id, units) {
    const { tolerance } = units;
    const [, , , edgeId, sense] = record(id, 'ORIENTED_EDGE').args;
    const [, start, end, curveId, forward] = record(edgeId, 'EDGE_CURVE').args;
    let curve = record(curveId);
    if (['SURFACE_CURVE', 'SEAM_CURVE', 'INTERSECTION_CURVE'].includes(curve.type)) curve = record(curve.args[1]);
    const direct = flag(sense);
    const from = vertex(direct ? start : end), to = vertex(direct ? end : start);
    if (curve.type === 'LINE') return [from, to];
    if (curve.type === 'CIRCLE' || curve.type === 'ELLIPSE') {
      const [, basis, major, minor] = curve.args;
      return arcPoints(frame(basis), major, curve.type === 'CIRCLE' ? major : minor, from, to, direct === flag(forward), tolerance, start === end);
    }
    if (curve.type === 'B_SPLINE_CURVE_WITH_KNOTS' || curve.components?.has('B_SPLINE_CURVE_WITH_KNOTS')) {
      const { axis, evaluate } = spline(curve);
      return splineEdge(axis, evaluate, from, to, direct === flag(forward), tolerance, units.chord);
    }
    throw new Error('STEP 包含暂未适配的边曲线 ' + (curve.type || '复杂曲线') + '。');
  }
  function boundary(id, units) {
    const { tolerance } = units;
    const bound = record(id);
    requireBrep(['FACE_BOUND', 'FACE_OUTER_BOUND'].includes(bound.type));
    const [, loopId, orientation] = bound.args;
    const loop = record(loopId);
    let ring;
    if (loop.type === 'POLY_LOOP') ring = refs(loop.args[1]).map(point);
    else {
      requireBrep(loop.type === 'EDGE_LOOP', 'STEP 包含暂未适配的面边界。');
      ring = [];
      for (const edge of refs(loop.args[1])) {
        const points = edgePoints(edge, units);
        if (ring.length) requireBrep(near(ring.at(-1), points[0], tolerance), 'STEP 边界的相邻边未连接。');
        ring.push(...(ring.length ? points.slice(1) : points));
        requireBrep(ring.length <= 16_384, 'STEP 单个环超过预览容量。');
      }
      requireBrep(ring.length && near(ring[0], ring.at(-1), tolerance), 'STEP 面边界未闭合。');
      ring.pop();
    }
    return flag(orientation) ? ring : ring.reverse();
  }
  function* face(id, units) {
    const entity = record(id);
    requireBrep(['FACE', 'FACE_SURFACE', 'ADVANCED_FACE'].includes(entity.type), 'STEP 包含暂未适配的面类型。');
    const [, bounds, surfaceId, sense] = entity.args;
    const rings = refs(bounds).map(bound => boundary(bound, units));
    requireBrep(rings[0]?.length >= 3);
    if (entity.type === 'FACE') {
      const [origin, second, ...rest] = rings[0];
      const x = sub(second, origin);
      const normal = rest.map(p => cross(x, sub(p, origin))).find(v => Math.hypot(...v) > units.tolerance ** 2);
      requireBrep(normal);
      yield* faceTriangles({ frame: axes(origin, normal, x) }, rings, units.tolerance);
      return;
    }
    const surface = record(surfaceId);
    const [, basis, radius, semiAngle] = surface.args ?? [];
    const reverse = !flag(sense);
    const { chord, tolerance } = units;
    if (surface.type === 'B_SPLINE_SURFACE_WITH_KNOTS' || surface.components?.has('B_SPLINE_SURFACE_WITH_KNOTS')) {
      // The exported edge and surface can be separate approximations of the same boundary.
      yield* parametricFace(stepSplineSurface(surface, point), rings, Math.max(tolerance, chord), chord, reverse);
      return;
    }
    if (surface.type === 'TOROIDAL_SURFACE') {
      yield* torusFace(frame(basis), radius, semiAngle, rings, tolerance, chord, reverse);
      return;
    }
    requireBrep(['PLANE', 'CYLINDRICAL_SURFACE', 'CONICAL_SURFACE'].includes(surface.type),
      'STEP 包含暂未适配的曲面 ' + (surface.type || '复杂曲面') + '。');
    const slope = surface.type === 'CONICAL_SURFACE' ? Math.tan(semiAngle * units.angle) : 0;
    requireBrep(Number.isFinite(slope) && (surface.type === 'PLANE' || typeof radius === 'number' && radius >= 0));
    const properties = surface.type === 'PLANE' ? { frame: frame(basis) } : { frame: frame(basis), radius, slope };
    yield* faceTriangles(properties, rings, tolerance, reverse);
  }
  function* shell(id, units) {
    const entity = record(id);
    requireBrep(['CLOSED_SHELL', 'OPEN_SHELL', 'CONNECTED_FACE_SET'].includes(entity.type), 'STEP 包含暂未适配的壳类型。');
    for (const item of refs(entity.args[1])) yield* face(item, units);
  }
  function* item(id, units, depth = 0) {
    requireBrep(depth < 24, 'STEP 网格容器嵌套超过容量。');
    const { type, args } = record(id);
    if (type === 'TRIANGULATED_FACE' || type === 'TRIANGULATED_SURFACE_SET') {
      const coords = record(args[1], 'COORDINATES_LIST').args;
      const points = refs(coords[2]);
      const [indices, faces] = args.slice(type === 'TRIANGULATED_FACE' ? 5 : 4);
      requireBrep(coords[1] === points.length && points.length <= 750_000 && refs(indices) && refs(faces));
      for (const tri of faces) {
        requireBrep(Array.isArray(tri) && tri.length === 3);
        yield tri.flatMap(index => {
          requireBrep(Number.isInteger(index) && index > 0 && index <= args[2]);
          const coordinate = indices.length ? indices[index - 1] : index;
          requireBrep(Number.isInteger(coordinate) && coordinate > 0 && coordinate <= points.length);
          return vector(points[coordinate - 1]);
        });
      }
    } else if (meshTypes.has(type)) {
      for (const child of refs(args[1])) yield* item(child, units, depth + 1);
    } else if (type === 'SHELL_BASED_SURFACE_MODEL' || type === 'FACE_BASED_SURFACE_MODEL') {
      for (const child of refs(args[1])) yield* shell(child, units);
    } else {
      yield* shell(args[1], units);
      if (type === 'BREP_WITH_VOIDS') for (const child of refs(args[2])) {
        const [, , inner] = record(child, 'ORIENTED_CLOSED_SHELL').args;
        yield* shell(inner, units);
      }
    }
  }

  const shapes = new Map(), parents = new Set(), children = new Map();
  for (const [id, { type, args }] of records) {
    if (!shapeTypes.has(type)) continue;
    const ids = refs(args[1]);
    const solids = ids.filter(child => brepTypes.has(record(child).type));
    const meshes = ids.filter(child => meshTypes.has(record(child).type));
    const unsupported = ids.map(child => record(child).type).find(item =>
      !brepTypes.has(item) && !meshTypes.has(item) && item !== 'AXIS2_PLACEMENT_3D');
    if (unsupported !== undefined) throw new Error('STEP 包含暂未适配的形状表示项 ' + (unsupported || '复杂表示项') + '。');
    shapes.set(id, { ids: meshes.length && !solids.length ? meshes : solids, contextId: args[2],
      tessellated: meshes.length && !solids.length, name: meshLabel(args[0]?.text) });
  }
  function link(parent, child, transform, occurrence) {
    requireBrep(shapes.has(parent) && shapes.has(child), 'STEP 装配引用了暂未适配的形状表示。');
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push({ child, transform, occurrence });
    parents.add(child);
  }
  let assembly = 0;
  const productNames = new Map();
  const products = new Map();
  for (const { type, args } of records.values()) {
    if (type === 'SHAPE_DEFINITION_REPRESENTATION' && shapes.has(args[1])) {
      const definition = records.get(args[0]);
      const product = records.get(definition?.args?.[2]);
      if (product?.type === 'PRODUCT_DEFINITION') products.set(args[1], definition.args[2]);
      const formation = records.get(product?.args?.[2]);
      const info = records.get(formation?.args?.[2]);
      if (info?.type === 'PRODUCT') {
        const name = meshLabel(info.args[1]?.text) || meshLabel(info.args[0]?.text);
        if (name) productNames.set(args[1], name);
      }
    }
  }
  for (const { type, args } of records.values()) {
    if (type === 'SHAPE_REPRESENTATION_RELATIONSHIP' && shapes.has(args[2]) && shapes.has(args[3])) {
      const [, , a, b] = args;
      if (shapes.get(a).ids.length && !shapes.get(b).ids.length) link(b, a);
      else if (shapes.get(b).ids.length && !shapes.get(a).ids.length) link(a, b);
    }
    if (type !== 'CONTEXT_DEPENDENT_SHAPE_REPRESENTATION') continue;
    const relation = record(args[0]).components;
    const [, , first, second] = relation?.get('REPRESENTATION_RELATIONSHIP') ?? [];
    const [transformId] = relation?.get('REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION') ?? [];
    const [, , from, to] = record(transformId, 'ITEM_DEFINED_TRANSFORMATION').args;
    const usage = records.get(records.get(args[1])?.args?.[2]);
    const instanceId = meshLabel(usage?.args[0]?.text);
    const occurrence = usage?.type === 'NEXT_ASSEMBLY_USAGE_OCCURRENCE'
      ? meshLabel(usage.args[5]?.text) || (instanceId && '实例 ' + instanceId) : '';
    const [, , , parentProduct, childProduct] = usage?.type === 'NEXT_ASSEMBLY_USAGE_OCCURRENCE' ? usage.args : [];
    // The occurrence identifies the assembly even when the exporter lists its representation first.
    const parentFirst = parentProduct && (products.get(first) === parentProduct || products.get(second) === childProduct);
    if (parentFirst) link(first, second, [to, from], occurrence);
    else link(second, first, [from, to], occurrence);
    assembly++;
  }
  if (!assembly && [...records.values()].some(record => record.type === 'NEXT_ASSEMBLY_USAGE_OCCURRENCE')) {
    throw new Error('STEP 文件缺少可读取的装配变换。');
  }
  const active = new Set(), reached = new Set();
  const unitsFor = new Map();
  function units(id) {
    const contextId = shapes.get(id).contextId;
    if (!unitsFor.has(contextId)) unitsFor.set(contextId, context(contextId));
    return unitsFor.get(contextId);
  }
  let visits = 0;
  function* traverse(id, mapPoint, inherited = '', occurrence = '') {
    requireBrep(!active.has(id) && active.size < 48 && ++visits <= 100_000, 'STEP 形状实例循环或展开超过容量。');
    active.add(id);
    reached.add(id);
    const shape = shapes.get(id);
    const links = children.get(id) ?? [];
    const name = productNames.get(id) || inherited || shape.name;
    const label = occurrence ? [name, occurrence].filter(Boolean).join(' · ') : name;
    const isAssembly = links.some(link => link.transform);
    const group = isAssembly || shape.ids.length + links.length > 1;
    if (group) yield { label: label || (isAssembly ? '装配体 ' : '零件 ') + id };
    for (const child of shape.ids) {
      stats[shape.tessellated ? 'mesh' : 'brep']++;
      const settings = units(id);
      const bodyName = meshLabel(record(child).args?.[0]?.text);
      const marker = { label: (group ? bodyName : label || bodyName) || (group ? '实体 ' : '零件 ') + child, key: child };
      const geometry = function* () {
        for (const triangle of item(child, settings)) yield triangle.map(value => value * settings.length);
      };
      if (shared) {
        yield { ...marker, definition: child + ':' + shape.contextId, geometry, placement: mapPoint, keepEmpty: true };
      } else {
        yield marker;
        for (const triangle of geometry()) yield [0, 3, 6].flatMap(start => mapPoint(triangle.slice(start, start + 3)));
      }
      yield null;
    }
    for (const { child, transform, occurrence: reference } of links) {
      if (!transform) yield* traverse(child, mapPoint, group ? '' : name, group ? '' : occurrence);
      else {
        const from = frame(transform[0], units(child).length), to = frame(transform[1], units(id).length);
        yield* traverse(child, p => mapPoint(worldPoint(to, ...localPoint(from, p))), '', reference);
      }
    }
    if (group) yield null;
    active.delete(id);
  }
  for (const [id, shape] of shapes) {
    if (!parents.has(id) && (shape.ids.length || children.has(id))) yield* traverse(id, p => p);
  }
  requireBrep([...shapes].every(([id, shape]) => reached.has(id) || !shape.ids.length && !children.has(id)),
    'STEP 形状关系存在循环或缺少根模型。');
  requireBrep(stats.mesh || stats.brep, 'STEP 文件没有可读取的实体或三角网格表示。');
}

export function readStepPreview(bytes, expected = false, partPath) {
  if (!isStep(bytes) && !expected) return null;
  const records = readPart21(bytes);
  const stats = { brep: 0, mesh: 0 };
  const scene = buildMeshScene('STEP', 'mm', triangles(records, stats), undefined, partPath);
  if (stats.brep) scene.issues.push(['STEP 实体曲面离散为三角网格，外包尺寸用于预览。', 1]);
  return scene;
}

export function readStepAssembly(bytes) {
  const limits = bytes.length >= 64 * MiB ? { records: 3_000_000, values: 32_000_000 } : undefined;
  return triangles(readPart21(bytes, limits), { brep: 0, mesh: 0 }, true);
}
