import { add, axes, cross, localPoint, mul, requireBrep, sub, worldPoint } from './brep-mesh.mjs';
import { parametricSurface, parametricTriangles } from './parametric-face.mjs';
import { splineAxis } from './spline-basis.mjs';

export function xtSplineSurface(surface, node, offset = 0, evaluationLimit = 12_000_000) {
  const { uDegree, vDegree, uCount, vCount, uPeriodic, vPeriodic, dimensions, rational, points,
    uMultiples, vMultiples, uKnots, vKnots } = node(surface.nurbs, 126);
  const values = node(points, 45).values;
  requireBrep(dimensions === (rational ? 4 : 3) && uCount * vCount <= 16_384 &&
    values.length === uCount * vCount * dimensions, 'Parasolid 样条面控制点数量不符。');
  const uAxis = splineAxis(uDegree, uCount, node(uKnots, 128).values, node(uMultiples, 127).values);
  const vAxis = splineAxis(vDegree, vCount, node(vKnots, 128).values, node(vMultiples, 127).values);
  const rows = Array.from({ length: uCount }, (_, i) => Array.from({ length: vCount }, (_, j) => {
    const index = (i * vCount + j) * dimensions;
    const value = values.slice(index, index + dimensions);
    requireBrep(value.every(Number.isFinite) && (!rational || value[3] > 0), 'Parasolid 样条面权重无效。');
    return value;
  }));
  function parameter(value, axis, periodic) {
    const span = axis.high - axis.low;
    requireBrep(Number.isFinite(value), 'Parasolid 样条面参数无效。');
    if (value >= axis.low && value <= axis.high) return value;
    if (periodic) return axis.low + ((value - axis.low) % span + span) % span;
    requireBrep(value >= axis.low - span * 1e-7 && value <= axis.high + span * 1e-7, 'Parasolid 修剪参数超出样条面的定义域。');
    return Math.max(axis.low, Math.min(axis.high, value));
  }
  let operations = 0;
  function raw(u, v) {
    operations += (uDegree + 1) * (vDegree + 1);
    requireBrep(operations <= evaluationLimit, '单张 Parasolid 样条面超过求值预算。');
    const t = parameter(v, vAxis, vPeriodic);
    const vertex = uAxis.evaluateWith(i => vAxis.evaluate(rows[i], t), parameter(u, uAxis, uPeriodic));
    return rational ? mul(vertex.slice(0, 3), 1 / vertex[3]) : vertex;
  }
  const uSpan = uAxis.high - uAxis.low, vSpan = vAxis.high - vAxis.low;
  const normalized = (u, v) => raw(uAxis.low + uSpan * u, vAxis.low + vSpan * v);
  if (!offset) return { ...parametricSurface(normalized), raw, periodic: [uPeriodic, vPeriodic] };
  function evaluate(u, v) {
    const step = 1e-5;
    const a = sub(normalized(Math.min(1, u + step), v), normalized(Math.max(0, u - step), v));
    const b = sub(normalized(u, Math.min(1, v + step)), normalized(u, Math.max(0, v - step)));
    const normal = cross(a, b);
    const length = Math.hypot(...normal);
    requireBrep(length > Math.hypot(...a) * Math.hypot(...b) * 1e-8, 'Parasolid 偏移面法向不确定。');
    return add(normalized(u, v), mul(normal, offset / length));
  }
  return { ...parametricSurface(evaluate),
    raw: (u, v) => evaluate((parameter(u, uAxis, uPeriodic) - uAxis.low) / uSpan,
      (parameter(v, vAxis, vPeriodic) - vAxis.low) / vSpan) };
}

export function* xtSphericalFace(origin, radius, rings, tolerance, chord, reverse) {
  requireBrep(rings[0]?.length >= 3, 'Parasolid 球面没有可读取的修剪边界。');
  const normal = rings[0].reduce((sum, point) => add(sum, sub(point, origin)), [0, 0, 0]);
  requireBrep(Math.hypot(...normal) > radius * 1e-6, 'Parasolid 球面修剪范围超过单个投影区。');
  const frame = axes(origin, normal);
  const loops = rings.map(ring => ring.map(point => {
    const [x, y, z] = localPoint(frame, point);
    requireBrep(Math.abs(Math.hypot(x, y, z) - radius) <= tolerance, 'Parasolid 球面边界超出几何容差。');
    requireBrep(z > radius * 0.025, 'Parasolid 球面修剪范围超过单个投影区。');
    return [x / z, y / z];
  }));
  yield* parametricTriangles((u, v) => {
    const length = radius / Math.hypot(u, v, 1);
    return worldPoint(frame, u * length, v * length, length);
  }, loops, chord, reverse);
}
